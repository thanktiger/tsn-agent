//! GCL 综合结果解析 + 位图合成 + 流关联匹配（KTD3/KTD5 纯函数群，自 `flow_plan_command`
//! 拆出；写库编排仍在彼处）。
//!
//! - `.sca` 解析：`parse_all_gates_from_sca`（含恒态门）/ `parse_gcl_from_sca`（仅被调度门，
//!   verify pin 重放同源）/ `parse_production_offsets_from_sca`（每流发送偏移行）；
//! - 位图合成（KTD3 切分点法）：`synthesize_gate_windows`；
//! - 流关联匹配（KTD5 首跳锚定 + 窗长指纹）：`match_flows_to_st_windows`；
//! - 相邻结构：`FlowRef` / `FlowMatchStream` / `GclWindowRow`（`gcl_windows` 行内存形态）。

use std::collections::BTreeMap;

use crate::inet_sim_bundle::GclEntry;

/// 时间字面量（带单位）→ ns。支持科学计数（`2.947e-05s`）；无单位视为 ns。
fn parse_time_ns(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix("ns") {
        (n, 1.0)
    } else if let Some(n) = s.strip_suffix("us") {
        (n, 1_000.0)
    } else if let Some(n) = s.strip_suffix("ms") {
        (n, 1_000_000.0)
    } else if let Some(n) = s.strip_suffix('s') {
        (n, 1_000_000_000.0)
    } else {
        (s, 1.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    if v < 0.0 || !v.is_finite() {
        return None;
    }
    Some((v * mult).round() as u64)
}

/// 从 `name[N]` 段取 N。
fn extract_bracket(s: &str, name: &str) -> Option<usize> {
    let start = s.find(&format!("{name}["))? + name.len() + 1;
    let end = s[start..].find(']')? + start;
    s[start..end].trim().parse().ok()
}

/// 从 `.sca` module 路径 `<net>.<node>.eth[N].macLayer.queue.transmissionGate[G]` 抽 (node ned, ethN, gateIndex)。
fn parse_module(module: &str) -> Option<(String, usize, usize)> {
    let gate_index = extract_bracket(module, "transmissionGate")?;
    let prefix = module.split(".transmissionGate").next()?;
    let parts: Vec<&str> = prefix.split('.').collect();
    let eth_pos = parts.iter().position(|p| p.starts_with("eth["))?;
    let eth_n = extract_bracket(parts[eth_pos], "eth")?;
    let node = parts.get(eth_pos.checked_sub(1)?)?.to_string();
    Some((node, eth_n, gate_index))
}

/// 解析 durations 值 `"[205.36us, 84.64us]"` / `[]` → Vec<u64> ns。
fn parse_durations(val: &str) -> Vec<u64> {
    let v = val.trim().trim_matches('"');
    let inner = v.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.trim().is_empty() {
        return vec![];
    }
    inner.split(',').filter_map(parse_time_ns).collect()
}

/// 解析 param-recording `.sca` 里的 transmissionGate 门参数 → Vec<GclEntry>（node=mid），
/// **含空 durations 门**（未调度门，恒态 = initiallyOpen——位图合成 q0-q6 恒态位的唯一
/// 来源，R2）。ned→mid 用 bundle 的 node_ned_names 反向表。
pub(crate) fn parse_all_gates_from_sca(
    sca: &str,
    ned_to_mid: &BTreeMap<String, String>,
    solver: &str,
) -> Vec<GclEntry> {
    #[derive(Default)]
    struct Acc {
        initially_open: bool,
        offset_ns: u64,
        durations_ns: Vec<u64>,
    }
    let mut acc: BTreeMap<(String, usize, usize), Acc> = BTreeMap::new();
    for line in sca.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("par ") else {
            continue;
        };
        if !rest.contains(".transmissionGate[") {
            continue;
        }
        let mut parts = rest.splitn(3, ' ');
        let (Some(module), Some(key), Some(val)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Some(k) = parse_module(module) else {
            continue;
        };
        let entry = acc.entry(k).or_default();
        match key {
            "initiallyOpen" => entry.initially_open = val.trim() == "true",
            "offset" => entry.offset_ns = parse_time_ns(val).unwrap_or(0),
            "durations" => entry.durations_ns = parse_durations(val),
            _ => {}
        }
    }
    acc.into_iter()
        .map(|((ned, eth_n, gate_index), a)| {
            let node = ned_to_mid.get(&ned).cloned().unwrap_or(ned);
            GclEntry {
                node,
                eth_n,
                gate_index,
                initially_open: a.initially_open,
                offset_ns: a.offset_ns,
                durations_ns: a.durations_ns,
                solver: solver.to_string(),
            }
        })
        .collect()
}

/// 只保留被调度门（非空 durations）——verify pin 重放（KTD4，`flow_verify_command::load_gcl`
/// 消费）与 `PlanResult.gate_count` 的口径不变；恒态门另走位图合成。
pub fn parse_gcl_from_sca(
    sca: &str,
    ned_to_mid: &BTreeMap<String, String>,
    solver: &str,
) -> Vec<GclEntry> {
    parse_all_gates_from_sca(sca, ned_to_mid, solver)
        .into_iter()
        .filter(|g| !g.durations_ns.is_empty())
        .collect()
}

/// 解析每流发送偏移行 `par <Net>.<ned>.app[N].source initialProductionOffset <值>`
/// → Vec<(ned 名, app 下标, offset_ns)>。值是裸浮点**秒**（真机 dump 形态，如 `4.2e-05`）
/// 或带单位字面量（`10us`）。app 下标经 `plan_flow_traffic` 同源放置关联到流。
pub(crate) fn parse_production_offsets_from_sca(sca: &str) -> Vec<(String, usize, u64)> {
    let mut out = Vec::new();
    for line in sca.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("par ") else {
            continue;
        };
        let mut parts = rest.splitn(3, ' ');
        let (Some(module), Some(key), Some(val)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if key != "initialProductionOffset" {
            continue;
        }
        let Some(app_idx) = extract_bracket(module, "app") else {
            continue;
        };
        // module 形如 `<Net>.<ned>.app[N].source`：取 `.app[` 前最后一段为 ned 名。
        let Some(prefix) = module.split(".app[").next() else {
            continue;
        };
        let Some(ned) = prefix.rsplit('.').next() else {
            continue;
        };
        let Some(offset_ns) = parse_offset_value_ns(val) else {
            continue;
        };
        out.push((ned.to_string(), app_idx, offset_ns));
    }
    out
}

/// 偏移值 → ns：带字母单位后缀走 parse_time_ns；纯数字/科学计数视为**秒**
/// （.sca 参数记录的裸浮点是秒，与门参数 offset 的 `0s` 带单位形式不同）。
fn parse_offset_value_ns(val: &str) -> Option<u64> {
    let v = val.trim().trim_matches('"');
    if v.chars().last()?.is_ascii_alphabetic() {
        parse_time_ns(v)
    } else {
        let secs: f64 = v.parse().ok()?;
        if secs < 0.0 || !secs.is_finite() {
            return None;
        }
        Some((secs * 1e9).round() as u64)
    }
}

/// KTD3 位图合成（纯函数）：per-gate 开窗区间（恒开门 = `[(0, cycle)]`、恒关/缺席门 =
/// 无区间）→ 逐窗行 `(start_ns, duration_ns, gate_states 位图)`。切分点法：全部门的
/// 翻转时刻（区间端点）∪ {0, cycle} 为切分点集合，排序去重后相邻切分点间为一窗，
/// 逐门判该窗内开/关拼位图（bit g = gate g 开）。gate ≥ 8 超出位图域，忽略。
pub(crate) fn synthesize_gate_windows(
    per_gate_open: &BTreeMap<usize, Vec<(u64, u64)>>,
    cycle_ns: u64,
) -> Vec<(u64, u64, u8)> {
    let mut cuts: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    cuts.insert(0);
    cuts.insert(cycle_ns);
    for (&gate, ivs) in per_gate_open {
        if gate >= 8 {
            continue;
        }
        for &(s, e) in ivs {
            if s < cycle_ns {
                cuts.insert(s);
            }
            if e <= cycle_ns {
                cuts.insert(e);
            }
        }
    }
    let pts: Vec<u64> = cuts.into_iter().collect();
    let mut out = Vec::new();
    for w in pts.windows(2) {
        let (s, e) = (w[0], w[1]);
        if s >= e {
            continue;
        }
        let mut bits = 0u8;
        for (&gate, ivs) in per_gate_open {
            if gate >= 8 {
                continue;
            }
            if ivs.iter().any(|&(a, b)| a <= s && e <= b) {
                bits |= 1 << gate;
            }
        }
        out.push((s, e - s, bits));
    }
    out
}

/// 流引用（`gcl_windows.flow_refs` JSON 元素）：source=derived（实例锚定/窗长指纹命中）
/// | class（类级降级，KTD5 ③⑤）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct FlowRef {
    pub(crate) seq: i64,
    pub(crate) source: String,
}

/// KTD5 匹配输入：单条 ST 流的锚定要素。egress 来自 `resolve_flow_path`
/// （`(mid, ethN)` 逐转发节点，含 talker、不含 listener）。
pub(crate) struct FlowMatchStream {
    pub(crate) stream_seq: i64,
    pub(crate) period_ns: u64,
    /// 帧传输时长（帧 + 开销 @ 链路速率）。
    pub(crate) tx_ns: u64,
    /// initialProductionOffset（ns）；None = 偏移缺失 → 类级降级（KTD5 ⑤）。
    pub(crate) offset_ns: Option<u64>,
    pub(crate) egress: Vec<(String, usize)>,
}

/// `[t0, t1)`（t1 可越过 cycle 边界）与 `[a, b)`（界内）在 mod cycle 意义下是否重叠。
fn overlaps_mod(t0: u64, t1: u64, a: u64, b: u64, cycle_ns: u64) -> bool {
    if t1 <= cycle_ns {
        t0 < b && a < t1
    } else {
        // 回绕拆两段：[t0, cycle) 与 [0, t1-cycle)。
        t0 < b || a < t1 - cycle_ns
    }
}

fn push_flow_ref(
    out: &mut BTreeMap<(String, usize, usize), Vec<FlowRef>>,
    key: (String, usize, usize),
    seq: i64,
    source: &str,
) {
    let refs = out.entry(key).or_default();
    if !refs.iter().any(|r| r.seq == seq) {
        refs.push(FlowRef {
            seq,
            source: source.to_string(),
        });
    }
}

/// KTD5 流关联匹配（纯函数）：输出 `(node, eth_n, ST 开窗区间下标) → 命中流引用集`。
/// ① 首跳：实例 k 发送时段 `[offset + k·period, +tx_ns)` 与首跳端口 ST 窗**有重叠**即命中
/// （source=derived）；② 下游跳：窗长指纹——`|窗长 − tx_ns| ≤ 窗长/10` 且时序晚于上一跳
/// 命中窗，取最早候选；③ 某跳零命中 → 该流全部已命中窗降级 source=class 并停止推进；
/// ④ 同窗多流都记；⑤ 偏移缺失（offset_ns=None）→ 路径各端口全部 ST 窗记类级引用
/// （无法锚定实例，落库不失败）。`st_open` 各端口区间须按 start 升序（下标即窗身份）。
pub(crate) fn match_flows_to_st_windows(
    streams: &[FlowMatchStream],
    st_open: &BTreeMap<(String, usize), Vec<(u64, u64)>>,
    cycle_ns: u64,
) -> BTreeMap<(String, usize, usize), Vec<FlowRef>> {
    let mut out: BTreeMap<(String, usize, usize), Vec<FlowRef>> = BTreeMap::new();
    for s in streams {
        if s.egress.is_empty() || s.period_ns == 0 || cycle_ns == 0 {
            continue;
        }
        let Some(offset) = s.offset_ns else {
            // ⑤ 偏移行缺失（旧服务/格式变化）：路径各端口全部 ST 窗记 class。
            for (node, eth) in &s.egress {
                if let Some(ivs) = st_open.get(&(node.clone(), *eth)) {
                    for idx in 0..ivs.len() {
                        push_flow_ref(&mut out, (node.clone(), *eth, idx), s.stream_seq, "class");
                    }
                }
            }
            continue;
        };
        let mut hits: std::collections::BTreeSet<(usize, usize)> = Default::default();
        let mut degraded = false;
        let instances = (cycle_ns / s.period_ns).max(1);
        'instances: for k in 0..instances {
            let t0 = (offset + k * s.period_ns) % cycle_ns;
            let t1 = t0 + s.tx_ns;
            // ① 首跳：发送时段与 ST 窗有重叠即命中。
            let first = &s.egress[0];
            let ivs0 = st_open
                .get(&(first.0.clone(), first.1))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let Some(h0) = ivs0
                .iter()
                .position(|&(a, b)| overlaps_mod(t0, t1, a, b, cycle_ns))
            else {
                degraded = true;
                break 'instances;
            };
            hits.insert((0, h0));
            let mut prev_start = ivs0[h0].0;
            // ② 下游跳：窗长指纹 + 时序晚于上一跳命中窗，取最早候选。
            for (hop, (node, eth)) in s.egress.iter().enumerate().skip(1) {
                let ivs = st_open
                    .get(&(node.clone(), *eth))
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let cand = ivs
                    .iter()
                    .enumerate()
                    .filter(|&(_, &(a, b))| {
                        let len = b.saturating_sub(a);
                        len > 0 && len.abs_diff(s.tx_ns) * 10 <= len && a > prev_start
                    })
                    .min_by_key(|&(_, &(a, _))| a);
                let Some((idx, &(a, _))) = cand else {
                    // ③ 某跳零命中 → 整链降级 class、停止推进。
                    degraded = true;
                    break 'instances;
                };
                hits.insert((hop, idx));
                prev_start = a;
            }
        }
        let source = if degraded { "class" } else { "derived" };
        for (hop, idx) in hits {
            let (node, eth) = &s.egress[hop];
            push_flow_ref(&mut out, (node.clone(), *eth, idx), s.stream_seq, source);
        }
    }
    out
}

/// 逐窗行（`gcl_windows` 表一行的内存形态；provider 由写入方统一填
/// `flow_plan_command::GCL_PROVIDER`）。
pub(crate) struct GclWindowRow {
    pub(crate) node: String,
    pub(crate) eth_n: usize,
    pub(crate) entry_idx: usize,
    pub(crate) start_ns: u64,
    pub(crate) duration_ns: u64,
    pub(crate) gate_states: u8,
    /// flow_refs JSON 数组串；无关联流 = None（落 NULL）。
    pub(crate) flow_refs: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机 dump 形态的一段 .sca（含被调度门 + 未调度门）。
    const SAMPLE_SCA: &str = r#"
par TsnAgentFlowTasNetwork.sw1.eth[0].macLayer.queue.transmissionGate[0] initiallyOpen false
par TsnAgentFlowTasNetwork.sw1.eth[0].macLayer.queue.transmissionGate[0] offset 0s
par TsnAgentFlowTasNetwork.sw1.eth[0].macLayer.queue.transmissionGate[0] durations []
par TsnAgentFlowTasNetwork.sw1.eth[1].macLayer.queue.transmissionGate[1] initiallyOpen true
par TsnAgentFlowTasNetwork.sw1.eth[1].macLayer.queue.transmissionGate[1] offset 2.947e-05s
par TsnAgentFlowTasNetwork.sw1.eth[1].macLayer.queue.transmissionGate[1] durations "[205.36us, 84.64us]"
"#;

    #[test]
    fn parse_time_ns_units_and_scientific() {
        assert_eq!(parse_time_ns("100ns"), Some(100));
        assert_eq!(parse_time_ns("205.36us"), Some(205_360));
        assert_eq!(parse_time_ns("1ms"), Some(1_000_000));
        assert_eq!(parse_time_ns("2.947e-05s"), Some(29_470));
        assert_eq!(parse_time_ns("0s"), Some(0));
    }

    #[test]
    fn parse_module_extracts_node_eth_gate() {
        let m = "TsnAgentFlowTasNetwork.sw1.eth[2].macLayer.queue.transmissionGate[3]";
        assert_eq!(parse_module(m), Some(("sw1".to_string(), 2, 3)));
    }

    #[test]
    fn parse_gcl_skips_unscheduled_and_maps_ned_to_mid() {
        let mut ned_to_mid = BTreeMap::new();
        ned_to_mid.insert("sw1".to_string(), "0".to_string());
        let gcl = parse_gcl_from_sca(SAMPLE_SCA, &ned_to_mid, "Z3");
        // 只 1 个被调度门（eth[1] gate[1]）；eth[0] gate[0] durations [] 跳过。
        assert_eq!(gcl.len(), 1);
        let g = &gcl[0];
        assert_eq!(g.node, "0"); // ned sw1 → mid 0
        assert_eq!(g.eth_n, 1);
        assert_eq!(g.gate_index, 1);
        assert!(g.initially_open);
        assert_eq!(g.offset_ns, 29_470);
        assert_eq!(g.durations_ns, vec![205_360, 84_640]);
        assert_eq!(g.solver, "Z3");
    }

    /// R2：全门解析**保留**空 durations 门（恒态 = initiallyOpen，位图恒态位来源）。
    #[test]
    fn parse_all_gates_keeps_unscheduled_constant_gates() {
        let mut ned_to_mid = BTreeMap::new();
        ned_to_mid.insert("sw1".to_string(), "0".to_string());
        let all = parse_all_gates_from_sca(SAMPLE_SCA, &ned_to_mid, "Z3");
        assert_eq!(all.len(), 2);
        let constant = all
            .iter()
            .find(|g| g.durations_ns.is_empty())
            .expect("恒态门须保留");
        assert_eq!(
            (constant.node.as_str(), constant.eth_n, constant.gate_index),
            ("0", 0, 0)
        );
        assert!(!constant.initially_open);
    }

    /// 偏移行解析：裸浮点=秒（真机 dump 形态）、带单位字面量、按 (ned, app 下标) 关联。
    #[test]
    fn parse_production_offsets_bare_seconds_and_units() {
        let sca = "par N.es0.app[0].source initialProductionOffset 4.2e-05\n\
                   par N.es1.app[2].source initialProductionOffset 10us\n\
                   par N.sw1.eth[1].macLayer.queue.transmissionGate[7] offset 0s\n";
        let offs = parse_production_offsets_from_sca(sca);
        assert_eq!(
            offs,
            vec![
                ("es0".to_string(), 0, 42_000),
                ("es1".to_string(), 2, 10_000)
            ]
        );
    }

    // ---------- 位图合成（KTD3，纯函数）----------

    const CYCLE: u64 = 1_000_000;

    /// 单 ST 门（gate7 开窗 [100us,200us]）+ 7 个恒开门 → 三窗 0x7F / 0xFF / 0x7F。
    #[test]
    fn synthesize_single_st_gate_with_constant_gates() {
        let mut gates: BTreeMap<usize, Vec<(u64, u64)>> = BTreeMap::new();
        for g in 0..7usize {
            gates.insert(g, vec![(0, CYCLE)]);
        }
        gates.insert(7, vec![(100_000, 200_000)]);
        assert_eq!(
            synthesize_gate_windows(&gates, CYCLE),
            vec![
                (0, 100_000, 0x7F),
                (100_000, 100_000, 0xFF),
                (200_000, 800_000, 0x7F),
            ]
        );
    }

    /// 两门交错翻转：gate0 [0,500us)、gate1 [250us,750us) → 四窗 0b01/0b11/0b10/0b00。
    #[test]
    fn synthesize_staggered_gates_cut_correctly() {
        let mut gates: BTreeMap<usize, Vec<(u64, u64)>> = BTreeMap::new();
        gates.insert(0, vec![(0, 500_000)]);
        gates.insert(1, vec![(250_000, 750_000)]);
        assert_eq!(
            synthesize_gate_windows(&gates, CYCLE),
            vec![
                (0, 250_000, 0b01),
                (250_000, 250_000, 0b11),
                (500_000, 250_000, 0b10),
                (750_000, 250_000, 0b00),
            ]
        );
    }

    /// 全恒态（八门恒开）→ 单窗 0xFF。
    #[test]
    fn synthesize_all_constant_single_window() {
        let mut gates: BTreeMap<usize, Vec<(u64, u64)>> = BTreeMap::new();
        for g in 0..8usize {
            gates.insert(g, vec![(0, CYCLE)]);
        }
        assert_eq!(
            synthesize_gate_windows(&gates, CYCLE),
            vec![(0, CYCLE, 0xFF)]
        );
    }

    // ---------- 流关联匹配（KTD5，纯函数）----------

    fn port(node: &str, eth: usize) -> (String, usize) {
        (node.to_string(), eth)
    }

    fn refs_of<'a>(
        out: &'a BTreeMap<(String, usize, usize), Vec<FlowRef>>,
        node: &str,
        eth: usize,
        idx: usize,
    ) -> &'a [FlowRef] {
        out.get(&(node.to_string(), eth, idx))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// ① 单流单跳：发送时段与 ST 窗重叠即命中（derived）。
    #[test]
    fn match_single_stream_single_hop_hit() {
        let streams = [FlowMatchStream {
            stream_seq: 3,
            period_ns: CYCLE,
            tx_ns: 4_560,
            offset_ns: Some(150_000),
            egress: vec![port("a", 1)],
        }];
        let mut st = BTreeMap::new();
        st.insert(port("a", 1), vec![(100_000, 200_000)]);
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        assert_eq!(
            refs_of(&out, "a", 1, 0),
            &[FlowRef {
                seq: 3,
                source: "derived".into()
            }]
        );
    }

    /// Covers AE1：多实例流（250us in 1ms）4 实例各命中一窗，全部标 derived。
    #[test]
    fn match_multi_instance_marks_all_windows() {
        let streams = [FlowMatchStream {
            stream_seq: 0,
            period_ns: 250_000,
            tx_ns: 4_560,
            offset_ns: Some(0),
            egress: vec![port("a", 1)],
        }];
        let mut st = BTreeMap::new();
        st.insert(
            port("a", 1),
            vec![
                (0, 10_000),
                (250_000, 260_000),
                (500_000, 510_000),
                (750_000, 760_000),
            ],
        );
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        for idx in 0..4 {
            assert_eq!(
                refs_of(&out, "a", 1, idx),
                &[FlowRef {
                    seq: 0,
                    source: "derived".into()
                }],
                "实例 {idx} 应命中"
            );
        }
    }

    /// ④ 同窗双流都记。
    #[test]
    fn match_same_window_records_both_streams() {
        let mk = |seq: i64, offset: u64| FlowMatchStream {
            stream_seq: seq,
            period_ns: CYCLE,
            tx_ns: 4_560,
            offset_ns: Some(offset),
            egress: vec![port("a", 1)],
        };
        let streams = [mk(0, 0), mk(1, 5_000)];
        let mut st = BTreeMap::new();
        st.insert(port("a", 1), vec![(0, 20_000)]);
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        let refs = refs_of(&out, "a", 1, 0);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().all(|r| r.source == "derived"));
    }

    /// ② 下游跳窗长指纹命中（窗长≈tx、时序晚于上一跳）。
    #[test]
    fn match_downstream_fingerprint_hit() {
        let streams = [FlowMatchStream {
            stream_seq: 0,
            period_ns: CYCLE,
            tx_ns: 4_560,
            offset_ns: Some(0),
            egress: vec![port("a", 0), port("b", 1)],
        }];
        let mut st = BTreeMap::new();
        st.insert(port("a", 0), vec![(0, 4_560)]);
        // 一个指纹匹配窗（len=4560，晚于上一跳）+ 一个宽窗（len 100us 不匹配）。
        st.insert(port("b", 1), vec![(10_000, 14_560), (500_000, 600_000)]);
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        assert_eq!(
            refs_of(&out, "a", 0, 0),
            &[FlowRef {
                seq: 0,
                source: "derived".into()
            }]
        );
        assert_eq!(
            refs_of(&out, "b", 1, 0),
            &[FlowRef {
                seq: 0,
                source: "derived".into()
            }]
        );
        assert!(refs_of(&out, "b", 1, 1).is_empty(), "宽窗不该命中");
    }

    /// Covers AE3 数据面 / ③：某跳零命中 → 该流全部已命中窗降级 class、停止推进。
    #[test]
    fn match_zero_hit_downgrades_whole_chain_to_class() {
        let streams = [FlowMatchStream {
            stream_seq: 0,
            period_ns: CYCLE,
            tx_ns: 4_560,
            offset_ns: Some(0),
            egress: vec![port("a", 0), port("b", 1)],
        }];
        let mut st = BTreeMap::new();
        st.insert(port("a", 0), vec![(0, 4_560)]);
        // 下游只有宽窗（指纹不匹配）→ 零命中。
        st.insert(port("b", 1), vec![(10_000, 310_000)]);
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        assert_eq!(
            refs_of(&out, "a", 0, 0),
            &[FlowRef {
                seq: 0,
                source: "class".into()
            }],
            "已命中窗降级 class"
        );
        assert!(refs_of(&out, "b", 1, 0).is_empty(), "零命中跳不得有引用");
    }

    /// ⑤ 偏移整体缺失 → 路径各端口全部 ST 窗记 class，不失败。
    #[test]
    fn match_missing_offset_all_class() {
        let streams = [FlowMatchStream {
            stream_seq: 0,
            period_ns: 500_000,
            tx_ns: 4_560,
            offset_ns: None,
            egress: vec![port("a", 0), port("b", 1)],
        }];
        let mut st = BTreeMap::new();
        st.insert(port("a", 0), vec![(0, 4_560), (500_000, 504_560)]);
        st.insert(port("b", 1), vec![(10_000, 14_560)]);
        let out = match_flows_to_st_windows(&streams, &st, CYCLE);
        for (node, eth, idx) in [("a", 0, 0), ("a", 0, 1), ("b", 1, 0)] {
            assert_eq!(
                refs_of(&out, node, eth, idx),
                &[FlowRef {
                    seq: 0,
                    source: "class".into()
                }],
                "{node} eth{eth} 窗 {idx}"
            );
        }
    }
}
