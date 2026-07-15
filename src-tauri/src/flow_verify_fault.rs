//! `verify_tas` 断链故障计划簇：断点选择与守卫小函数
//! （自 `flow_verify_command` 拆出；消费方：`flow_verify_command`）。
//!
//! 断点=各平面上覆盖最多 RC 流的**有向**链路占用（KTD8，平手优先避开 ST 路由、再取最小
//! link_seq；时钟树边/ST 路由重叠响亮标注不改选，KTD2）；`t_break = max(0.4×最小 RC 活跃窗,
//! 200ms 收敛下限)`，断后被覆盖流应发帧数 <20 整体响亮报错（KTD7）。

use std::collections::{BTreeMap, HashSet};

/// 断链时刻的 gPTP 收敛下限（KTD7；spike 在 400ms 断链验证过 gPTP 存活，200ms 为收敛底线）。
const FAULT_T_BREAK_FLOOR_NS: u64 = 200_000_000;

/// 断链时刻（ns）：max(0.4 × 最小 RC 活跃窗, 200ms gPTP 收敛下限)（KTD7）。
pub(crate) fn fault_t_break_ns(min_rc_window_ns: u64) -> u64 {
    (min_rc_window_ns * 2 / 5).max(FAULT_T_BREAK_FLOOR_NS)
}

/// 断后某流在给定发送窗内还应发的帧数（KTD7 尾量守卫）。守卫的分母窗是**真实发送窗**
/// （sim 时长——源固定间隔产包到 sim 结束，与 expected_sent 同模型），非 count×period 意图窗
/// （长 ST 流拉长 sim 时短意图窗 RC 断后照样有帧，不得假拒验）。窗已过断点 → 0。
pub(crate) fn frames_after_break(window_ns: u64, t_break_ns: u64, period_ns: u64) -> i64 {
    if window_ns <= t_break_ns || period_ns == 0 {
        0
    } else {
        ((window_ns - t_break_ns) / period_ns) as i64
    }
}

/// 某平面故障轮的断点（KTD8）：断链上游端点（朝 talker 一侧）+ 覆盖/未覆盖流 + 重叠标注位。
pub(crate) struct BreakPoint {
    pub(crate) link_seq: i64,
    pub(crate) upstream_mid: String,
    pub(crate) upstream_db_port: i64,
    pub(crate) covered: Vec<i64>,
    pub(crate) untested: Vec<i64>,
    pub(crate) on_st_route: bool,
    pub(crate) on_clock_tree: bool,
}

/// 故障轮计划：(t_break_ns, [(轮名, 断点)])——有 RC 流才 Some。
pub(crate) type FaultPlan = (u64, Vec<(&'static str, Option<BreakPoint>)>);

/// 断点选择（KTD8）：候选=各 RC 流该平面路径的**有向**链路占用（(link_seq, 上游节点)——
/// 单向 TX 断开只杀同向副本，反向途经不算覆盖）。取覆盖流数最多者；覆盖数平手优先避开
/// ST 流路由（verify 期平面 A link_seqs）；再平手取最小 (link_seq, mid)（BTreeMap 升序，
/// 确定性）。所有最高覆盖候选都撞 ST 路由时不降覆盖去避让——取覆盖最高者并由
/// `on_st_route` 响亮标注（KTD2）；时钟树边同款只标注不改选（结构性避不开）。
pub(crate) fn select_break_point(
    routes: &[(i64, &crate::flow_route::Route)],
    st_links: &HashSet<i64>,
    links: &[crate::topology_verify::VerifyLink],
    clock_tree: &crate::timesync_tree::ClockTree,
) -> Option<BreakPoint> {
    let mut cover: BTreeMap<(i64, String), Vec<i64>> = BTreeMap::new();
    for (seq, r) in routes {
        for (i, ls) in r.link_seqs.iter().enumerate() {
            cover
                .entry((*ls, r.node_path[i].clone()))
                .or_default()
                .push(*seq);
        }
    }
    let mut best: Option<(&(i64, String), &Vec<i64>)> = None;
    for (key, streams) in &cover {
        let better = match &best {
            None => true,
            Some((bk, bs)) => {
                if streams.len() != bs.len() {
                    streams.len() > bs.len()
                } else {
                    // 覆盖数平手：优先不撞 ST 路由；再平手保留更小 key（升序先到者）。
                    !st_links.contains(&key.0) && st_links.contains(&bk.0)
                }
            }
        };
        if better {
            best = Some((key, streams));
        }
    }
    let ((link_seq, upstream_mid), covered) = best?;
    let link = links.iter().find(|l| l.link_seq == *link_seq)?;
    let upstream_db_port = if &link.src_node == upstream_mid {
        link.src_port
    } else {
        link.dst_port
    }?;
    let covered_set: HashSet<i64> = covered.iter().copied().collect();
    let untested: Vec<i64> = routes
        .iter()
        .map(|(s, _)| *s)
        .filter(|s| !covered_set.contains(s))
        .collect();
    let ptp_on = |mid: &str, port: Option<i64>| {
        port.is_some_and(|p| {
            clock_tree
                .per_node
                .iter()
                .find(|n| n.mid == mid)
                .is_some_and(|n| n.port_ptp_enabled.contains(&p))
        })
    };
    Some(BreakPoint {
        link_seq: *link_seq,
        upstream_mid: upstream_mid.clone(),
        upstream_db_port,
        covered: covered.clone(),
        untested,
        on_st_route: st_links.contains(link_seq),
        // 时钟树边=两端端口都在树上（master/slave 各一端）；非树边两端 passive 不入树。
        on_clock_tree: ptp_on(&link.src_node, link.src_port)
            && ptp_on(&link.dst_node, link.dst_port),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Covers KTD7（U6⑨）：t_break 手算——RC 窗 1s → 0.4×=400ms（>200ms 下限，取 0.4×窗）；
    /// RC 窗 100ms → 0.4×=40ms < 200ms → 取 200ms 收敛下限。
    #[test]
    fn t_break_forty_percent_with_200ms_floor() {
        assert_eq!(fault_t_break_ns(1_000_000_000), 400_000_000);
        assert_eq!(fault_t_break_ns(100_000_000), 200_000_000);
    }
}
