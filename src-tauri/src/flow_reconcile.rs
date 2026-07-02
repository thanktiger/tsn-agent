//! GCL 对账等价谓词（R9，**辅助信号不作通过闸**）。判断 Z3 综合出的 GCL 与 docx 期望门窗
//! 是否「整体循环相移一个常量 Δ 后每端口每门开区间集合相同」——等价即对账绿，真正不同的
//! 合法解判 mismatch→需排查（不阻断、U7 只记录）。
//!
//! 关键简化：全局相移 Δ = 给每个门的 offset 同加 Δ（offset 就是门循环相位）；而
//! `open_intervals_ns` 把 (offset,durations,initiallyOpen) 归一成 [0,cycle) 内实际开区间集合
//! （跨界 wrap-split、按起点排序），是「开区间集合」的规范函数——同一开区间集合无论怎么表示都得
//! 同一输出。故 shift(a,Δ)≡b 等价于 open_intervals_ns(a offset+Δ)==open_intervals_ns(b)。

use crate::inet_sim_bundle::GclEntry;
use std::collections::BTreeMap;

/// 对账结论。`equivalent` 为真时 `delta_ns` 是使二者相同的全局相移；否则 `notes` 说明分歧。
#[derive(Debug, Clone, PartialEq)]
pub struct ReconcileVerdict {
    pub equivalent: bool,
    pub delta_ns: Option<u64>,
    pub notes: Vec<String>,
}

type GateKey = (String, usize, usize);

fn key(e: &GclEntry) -> GateKey {
    (e.node.clone(), e.eth_n, e.gate_index)
}

/// 把一个门在 [0,cycle) 内的开区间归一：从 offset 起按 durations 交替 open/close，开区间跨
/// cycle 边界则拆两段，最后按起点排序。durations 空 → 全开(initiallyOpen)或全闭。
fn open_intervals_ns(
    offset_ns: u64,
    durations_ns: &[u64],
    initially_open: bool,
    cycle: u64,
) -> Vec<(u64, u64)> {
    if cycle == 0 {
        return vec![];
    }
    if durations_ns.is_empty() {
        return if initially_open {
            vec![(0, cycle)]
        } else {
            vec![]
        };
    }
    let mut intervals: Vec<(u64, u64)> = Vec::new();
    let mut t = offset_ns % cycle;
    let mut open = initially_open;
    for &d in durations_ns {
        if open && d > 0 {
            let start = t % cycle;
            if start + d <= cycle {
                intervals.push((start, d));
            } else {
                intervals.push((start, cycle - start));
                intervals.push((0, d - (cycle - start)));
            }
        }
        t = (t + d) % cycle;
        open = !open;
    }
    intervals.sort_unstable();
    intervals
}

/// 每个开区间的起点（mod cycle，wrap-split 之前），用于生成候选 Δ（起点是相移协变的，
/// 不受 wrap-split 把一段拆两段的影响）。
fn raw_open_starts(
    offset_ns: u64,
    durations_ns: &[u64],
    initially_open: bool,
    cycle: u64,
) -> Vec<u64> {
    if cycle == 0 {
        return vec![];
    }
    if durations_ns.is_empty() {
        return if initially_open { vec![0] } else { vec![] };
    }
    let mut starts = Vec::new();
    let mut t = offset_ns % cycle;
    let mut open = initially_open;
    for &d in durations_ns {
        if open && d > 0 {
            starts.push(t % cycle);
        }
        t = (t + d) % cycle;
        open = !open;
    }
    starts.sort_unstable();
    starts
}

/// 对账两组 GCL（synth 综合 vs expected docx 门窗），门循环 cycle_ns。空输入任一方 → 不等价。
///
/// `#[allow(dead_code)]`：R9 对账谓词是**测试/验收期**工具（U10 用综合结果对比冻结的 docx
/// 期望门窗），运行期 `plan_tas` 不内联对账（库里无 docx 靶）。故非测试构建里无生产调用方；
/// 本 allow 连带把本模块 API（open_intervals_ns 等）标 live。U10 接入后（`#[cfg(test)]` 消费）
/// 仍需保留（clippy --lib 不含 test cfg）。
#[allow(dead_code)]
pub fn reconcile(synth: &[GclEntry], expected: &[GclEntry], cycle_ns: u64) -> ReconcileVerdict {
    let mut notes = Vec::new();

    let a: BTreeMap<GateKey, &GclEntry> = synth.iter().map(|e| (key(e), e)).collect();
    let b: BTreeMap<GateKey, &GclEntry> = expected.iter().map(|e| (key(e), e)).collect();

    // 键集必须一致（缺门/多门 = 结构不同）。
    for k in a.keys() {
        if !b.contains_key(k) {
            notes.push(format!("综合结果多出门 {k:?}（期望里没有）。"));
        }
    }
    for k in b.keys() {
        if !a.contains_key(k) {
            notes.push(format!("期望门 {k:?} 在综合结果里缺失。"));
        }
    }
    if !notes.is_empty() {
        return ReconcileVerdict {
            equivalent: false,
            delta_ns: None,
            notes,
        };
    }
    if a.is_empty() {
        return ReconcileVerdict {
            equivalent: false,
            delta_ns: None,
            notes: vec!["两侧都无门控表，无可对账。".to_string()],
        };
    }

    // 预计算 b 各门的规范开区间集合。
    let b_intervals: BTreeMap<&GateKey, Vec<(u64, u64)>> = b
        .iter()
        .map(|(k, e)| {
            (
                k,
                open_intervals_ns(e.offset_ns, &e.durations_ns, e.initially_open, cycle_ns),
            )
        })
        .collect();

    // 候选 Δ：取第一个「有开区间」的门，用它 a 首个开区间起点与 b 各开区间起点之差生成候选
    // （起点用 wrap-split 前的原始起点、相移协变，含 Δ=0）。
    let mut candidates: Vec<u64> = vec![0];
    for (k, ea) in &a {
        let a_starts = raw_open_starts(ea.offset_ns, &ea.durations_ns, ea.initially_open, cycle_ns);
        if a_starts.is_empty() {
            continue;
        }
        let eb = b[k];
        let b_starts = raw_open_starts(eb.offset_ns, &eb.durations_ns, eb.initially_open, cycle_ns);
        let a0 = a_starts[0];
        for &bs in &b_starts {
            candidates.push((bs + cycle_ns - a0) % cycle_ns);
        }
        break;
    }
    candidates.sort_unstable();
    candidates.dedup();

    // 逐候选 Δ 全门比对：shift(a,Δ) 的开区间集合 == b。
    for delta in candidates {
        let all_match = a.iter().all(|(k, ea)| {
            let shifted = open_intervals_ns(
                ea.offset_ns + delta,
                &ea.durations_ns,
                ea.initially_open,
                cycle_ns,
            );
            shifted == b_intervals[k]
        });
        if all_match {
            return ReconcileVerdict {
                equivalent: true,
                delta_ns: Some(delta),
                notes: vec![],
            };
        }
    }

    ReconcileVerdict {
        equivalent: false,
        delta_ns: None,
        notes: vec![
            "综合 GCL 与 docx 门窗不是同一全局相移下的等价解，建议排查（辅助信号，不阻断验证）。"
                .to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(
        node: &str,
        eth_n: usize,
        gate_index: usize,
        offset: u64,
        durs: Vec<u64>,
        io: bool,
    ) -> GclEntry {
        GclEntry {
            node: node.into(),
            eth_n,
            gate_index,
            initially_open: io,
            offset_ns: offset,
            durations_ns: durs,
            solver: "Z3".into(),
        }
    }

    const CYCLE: u64 = 1_000_000; // 1ms

    /// 完全一致 → 等价，Δ=0。
    #[test]
    fn identical_is_equivalent_delta_zero() {
        let a = vec![gate("0", 0, 1, 0, vec![300_000, 700_000], true)];
        let b = a.clone();
        let v = reconcile(&a, &b, CYCLE);
        assert!(v.equivalent, "{:?}", v.notes);
        assert_eq!(v.delta_ns, Some(0));
    }

    /// AE3：整体相移一个常量（所有门 offset 同加 Δ）→ 判等价。
    #[test]
    fn global_phase_shift_is_equivalent() {
        let a = vec![
            gate("0", 0, 1, 0, vec![200_000, 800_000], true),
            gate("0", 1, 1, 100_000, vec![200_000, 800_000], true),
        ];
        // b = a 全体 offset +50_000（同一 Δ）。
        let b = vec![
            gate("0", 0, 1, 50_000, vec![200_000, 800_000], true),
            gate("0", 1, 1, 150_000, vec![200_000, 800_000], true),
        ];
        let v = reconcile(&a, &b, CYCLE);
        assert!(v.equivalent, "全局相移应等价：{:?}", v.notes);
        assert_eq!(v.delta_ns, Some(50_000));
    }

    /// 真正不同的合法解（各门相移不一致）→ 判 mismatch（不误判等价）。
    #[test]
    fn different_per_gate_shift_is_mismatch() {
        let a = vec![
            gate("0", 0, 1, 0, vec![200_000, 800_000], true),
            gate("0", 1, 1, 0, vec![200_000, 800_000], true),
        ];
        // 门0 移 50k、门1 移 300k（非同一 Δ）。
        let b = vec![
            gate("0", 0, 1, 50_000, vec![200_000, 800_000], true),
            gate("0", 1, 1, 300_000, vec![200_000, 800_000], true),
        ];
        let v = reconcile(&a, &b, CYCLE);
        assert!(!v.equivalent, "各门相移不一致不应判等价");
    }

    /// 门窗时长不同（不同排程）→ mismatch。
    #[test]
    fn different_durations_is_mismatch() {
        let a = vec![gate("0", 0, 1, 0, vec![300_000, 700_000], true)];
        let b = vec![gate("0", 0, 1, 0, vec![400_000, 600_000], true)];
        let v = reconcile(&a, &b, CYCLE);
        assert!(!v.equivalent);
    }

    /// 键集不同（综合缺了期望里的门）→ mismatch 且 notes 指出「缺失」。
    #[test]
    fn missing_gate_is_mismatch() {
        let synth = vec![gate("0", 0, 1, 0, vec![300_000, 700_000], true)];
        let expected = vec![
            gate("0", 0, 1, 0, vec![300_000, 700_000], true),
            gate("0", 1, 1, 0, vec![300_000, 700_000], true),
        ];
        let v = reconcile(&synth, &expected, CYCLE);
        assert!(!v.equivalent);
        assert!(v.notes.iter().any(|n| n.contains("缺失")), "{:?}", v.notes);
    }

    /// 相移致开区间跨门循环边界（wrap）后仍等价。
    #[test]
    fn wrap_around_shift_still_equivalent() {
        // a：开区间 [0, 200k)。移 Δ=900k → 开区间 [900k, 1.1M) 跨界 = [900k,1M)+[0,100k)。
        let a = vec![gate("0", 0, 1, 0, vec![200_000, 800_000], true)];
        let b = vec![gate("0", 0, 1, 900_000, vec![200_000, 800_000], true)];
        let v = reconcile(&a, &b, CYCLE);
        assert!(v.equivalent, "跨界相移应等价：{:?}", v.notes);
        assert_eq!(v.delta_ns, Some(900_000));
    }

    /// U10/R18/R9：docx 案例 4.1.2（双平面单跳 Qbv）真实门窗对账。
    /// E6 门开 [32us,64us]、SW1 门开 [64us,96us]，1ms 周期。同解等价、真机可能整体相移仍等价、
    /// 门窗不同判 mismatch。门窗 → GclEntry：offset=开始、durations=[开时长, 闭时长]、io=true。
    fn docx_case1_expected() -> Vec<GclEntry> {
        vec![
            // E6 egress ST 门：开 [32us,64us)。
            gate("E6", 0, 1, 32_000, vec![32_000, 968_000], true),
            // SW1 egress ST 门：开 [64us,96us)。
            gate("SW1", 0, 1, 64_000, vec![32_000, 968_000], true),
        ]
    }

    #[test]
    fn docx_case1_gate_windows_reconcile() {
        let expected = docx_case1_expected();
        // 同一组解 → 等价 Δ=0。
        let same = reconcile(&expected, &expected, CYCLE);
        assert!(same.equivalent, "docx 门窗同解应等价：{:?}", same.notes);
        assert_eq!(same.delta_ns, Some(0));

        // 真机综合可能整体相移一常量（如 +10us）→ 仍判等价（R9）。
        let shifted = vec![
            gate("E6", 0, 1, 42_000, vec![32_000, 968_000], true),
            gate("SW1", 0, 1, 74_000, vec![32_000, 968_000], true),
        ];
        let v = reconcile(&shifted, &expected, CYCLE);
        assert!(v.equivalent, "整体相移 +10us 应等价：{:?}", v.notes);
        assert_eq!(v.delta_ns, Some(990_000)); // shift(expected, 990us) == shifted，即 expected 早 10us

        // 门窗时长不同（E6 开 40us 而非 32us）→ mismatch。
        let wrong = vec![
            gate("E6", 0, 1, 32_000, vec![40_000, 960_000], true),
            gate("SW1", 0, 1, 64_000, vec![32_000, 968_000], true),
        ];
        assert!(
            !reconcile(&wrong, &expected, CYCLE).equivalent,
            "门窗不同应判 mismatch"
        );
    }
}
