//! `verify_tas` 判决簇：CSV-R 解析、逐流分级判决、gPTP 收敛诊断
//! （自 `flow_verify_command` 拆出；消费方：`flow_verify_command`）。
//!
//! 向量名（U1 spike 钉死）：时延 `packetLifeTime:vector`、抖动 `packetJitter:vector`（均落
//! `.vec`、现 scavetool 路径可取）。**丢包判据（U10 收口 plan Open Question）**：INET
//! ActivePacketSource 无「产 N 个就停」参数、按 productionInterval 持续产到 sim 结束，故
//! sim 时长按 `count×period` 推导（`flow_sim_time_s`），「实发」由 `floor(sim/period)+1`
//! 确定性反推（`flow_expected_sent`，无需服务回传发送数）。判 `实发 - 收 ≤ 在途容差`
//! （容差=⌈实测max时延/period⌉+1）——自由产包源 sim 结束时总有在途尾巴，故不能要求精确相等。
//!
//! **U7 分级判据（R11–R13）+ gPTP 收敛诊断行（R15）**：classify 按类分叉——ST 三项仅健康轮判
//! （FAIL reason 附「重新规划」提示，KTD4）；RC 每轮判去重后收=实发±在途容差（容差逐轮自计），
//! 收>实发即重复帧 FAIL，故障轮只判被断链覆盖的流；BE 仅健康轮判 received>0，送达率随行报告。
//! 故障轮 ST/BE 与未覆盖 RC 只报告不判（judged=false + note）。每轮 CSV 另过
//! `parse_timechanged_csv` 生成 gPTP 收敛诊断（只报告不参与任何 verdict）。

use std::collections::{BTreeMap, HashSet};

use crate::flow_verify_types::{GptpDiag, JITTER_LIMIT_NS, StreamVerdict};
use crate::inet_sim_bundle::{FlowStreamSpec, SimNodeTiming, flow_expected_sent};
use crate::inet_sim_command::{
    CONVERGENCE_THRESHOLD_NS, parse_timechanged_csv, series_ned_name, steady_state_offset,
};

/// CSV-R 一行向量（module + name + 数值样本）。
pub(crate) struct VecRow {
    module: String,
    name: String,
    values: Vec<f64>,
}

/// 解析 scavetool CSV-R 长表（列 module/name/vectime/vecvalue；vecvalue 空格分隔）。
/// 跳过 opp_env 环境横幅，定位真表头（对齐 parse_timechanged_csv）。
pub(crate) fn parse_vec_csv(csv: &str) -> Vec<VecRow> {
    let split =
        |line: &str| -> Vec<String> { line.split(',').map(|s| s.trim().to_string()).collect() };
    let mut lines = csv.lines();
    let mut cols: Option<Vec<String>> = None;
    for line in lines.by_ref() {
        let c = split(line);
        if ["module", "name", "vectime", "vecvalue"]
            .iter()
            .all(|w| c.iter().any(|x| x == w))
        {
            cols = Some(c);
            break;
        }
    }
    let Some(cols) = cols else {
        return vec![];
    };
    let idx = |n: &str| cols.iter().position(|c| c == n).unwrap();
    let (mi, ni, vi) = (idx("module"), idx("name"), idx("vecvalue"));
    let mut out = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let f = split(line);
        let need = mi.max(ni).max(vi);
        if f.len() <= need {
            continue;
        }
        let values: Vec<f64> = f[vi]
            .split_whitespace()
            .filter_map(|x| x.parse::<f64>().ok())
            .collect();
        out.push(VecRow {
            module: f[mi].clone(),
            name: f[ni].clone(),
            values,
        });
    }
    out
}

/// 逐流分型（U7 分级判据，R11–R13）：按 sink app module 后缀匹配 per-stream 时延/抖动向量。
/// - ST：三项判据不动（收=实发±在途容差 / 稳态抖动<1us 跳首样本 / 时延≤窗口），仅健康轮判；
///   FAIL reason 末尾附「若近期改过 ST 流请重新规划」（KTD4，plan 过期指纹的文案替代）。
/// - RC：每轮判「去重后收=实发±在途容差」——容差逐轮自计（该轮该流 sink 实测 max 时延套
///   现行公式：健康轮自然是首达路、故障轮自然是存活路，R12「按较长一路计」由此实现）；
///   收>实发 → FAIL 重复帧未消除。时延/抖动只报告不判（展示层标「首达路实测」）。
///   故障轮只判被断链覆盖的流（`fault_covered`），未覆盖只报告（KTD8）。
/// - BE：received>0 即 PASS（仅健康轮判）；送达率（收/实发）随行报告（R13）。
///
/// 空/短向量 → 下判的流该轮 FAIL（R16，含故障轮被覆盖 RC）；不判的流 judged=false + note，
/// pass 恒 true（报告态不阻塞轮次聚合）。
pub(crate) fn classify(
    rows: &[VecRow],
    specs: &[FlowStreamSpec],
    placements: &[crate::inet_sim_bundle::FlowPlacement],
    node_ned: &std::collections::BTreeMap<String, String>,
    sim_time_s: f64,
    fault_covered: Option<&HashSet<i64>>,
) -> Vec<StreamVerdict> {
    // skip_first：抖动 max 跳过每条向量的首样本。INET packetJitter 首样本是第一个包对隐含 0
    // 参考的差值（≈该包时延，非真实包间抖动），是定义性启动瞬态；跳过后取的是稳态抖动。
    // 时延/收包数不跳（received 须全量）。
    let max_of = |name_needle: &str, suffix: &str, skip_first: bool| -> (usize, f64) {
        let mut count = 0usize;
        let mut max_ns = 0.0f64;
        for r in rows {
            if r.name.contains(name_needle) && r.module.contains(suffix) {
                let vals: &[f64] = if skip_first && !r.values.is_empty() {
                    &r.values[1..]
                } else {
                    &r.values
                };
                count += vals.len();
                for &v in vals {
                    let ns = v * 1e9; // 秒 → ns
                    if ns > max_ns {
                        max_ns = ns;
                    }
                }
            }
        }
        (count, max_ns)
    };

    specs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let sink_ned = node_ned
                .get(&s.listener)
                .cloned()
                .unwrap_or_else(|| s.listener.clone());
            let suffix = format!("{sink_ned}.app[{}]", placements[i].listener_app);
            let (received, latency_max_ns) = max_of("packetLifeTime", &suffix, false);
            let (_jn, jitter_max_ns) = max_of("packetJitter", &suffix, true);
            let window_ns = (s.max_latency_us.unwrap_or(s.period_us) as f64) * 1_000.0;

            // 实发按 sim 时长确定性反推（源固定间隔产到 sim 结束，无产包上限）：floor(sim/period)+1。
            // 丢包判据：实发 - 收 ≤ 在途容差。容差 = ⌈实测max时延/period⌉+1，界定 sim 结束时仍在途、
            // 未及送达的尾巴（非真丢）——自由产包源无法做到「产完全部送达」，故不能要求收==实发精确相等。
            // 容差对 RC 亦逐轮自计（该轮实测时延即该轮实际生效路径的时延，R12）。
            let expected_sent = flow_expected_sent(sim_time_s, s.period_us);
            let period_ns = (s.period_us.max(1) as f64) * 1_000.0;
            let in_flight_tol = (latency_max_ns / period_ns).ceil() as i64 + 1;

            // 该轮是否下判（U7 分级）：健康轮全类判；故障轮只判被断链覆盖的 RC 流。
            let judged = match fault_covered {
                None => true,
                Some(covered) => s.class == "RC" && covered.contains(&s.stream_seq),
            };
            let note = if judged {
                None
            } else if s.class == "RC" {
                Some("未测容错（断点不在其该平面路径上）".to_string())
            } else {
                Some("仅健康轮判（故障轮不判）".to_string())
            };
            // BE 送达率（收/实发）：只展示不判（R13）；故障轮照实报告。
            let delivery_ratio =
                (s.class == "BE").then(|| received as f64 / expected_sent.max(1) as f64);

            let mut reasons = Vec::new();
            if judged {
                match s.class.as_str() {
                    "RC" => {
                        // 去重后收=实发±在途容差（R12）；收>实发 = 消除点没吞掉重复帧。
                        if received == 0 {
                            reasons.push("无收包（空结果）".to_string());
                        } else if (received as i64) > expected_sent {
                            reasons.push(format!(
                                "收 {received} > 实发 {expected_sent}（重复帧未消除）"
                            ));
                        } else if expected_sent - (received as i64) > in_flight_tol {
                            reasons.push(format!(
                                "收 {received} ＜ 实发 {expected_sent}（丢包 {}，超在途容差 {in_flight_tol}）",
                                expected_sent - received as i64
                            ));
                        }
                    }
                    "BE" => {
                        // 有收包即过（R13）；时延/抖动/丢包只报告。
                        if received == 0 {
                            reasons.push("无收包（BE 要求有收包）".to_string());
                        }
                    }
                    _ => {
                        // ST 三项（R11 现行不动；未知类兜底同 ST——录入闸/入口校验后不该出现）。
                        if received == 0 {
                            reasons.push("无收包（空结果）".to_string());
                        } else if (received as i64) > expected_sent {
                            reasons.push(format!("收 {received} > 实发 {expected_sent}（重复/异常）"));
                        } else if expected_sent - (received as i64) > in_flight_tol {
                            reasons.push(format!(
                                "收 {received} ＜ 实发 {expected_sent}（丢包 {}，超在途容差 {in_flight_tol}）",
                                expected_sent - received as i64
                            ));
                        }
                        if jitter_max_ns >= JITTER_LIMIT_NS {
                            reasons.push(format!("抖动 {jitter_max_ns:.0}ns ≥ 1us"));
                        }
                        if received > 0 && latency_max_ns > window_ns {
                            reasons.push(format!(
                                "时延 {latency_max_ns:.0}ns > 窗口 {window_ns:.0}ns"
                            ));
                        }
                        // KTD4：plan 过期指纹本期以文案替代——ST FAIL 附重新规划提示。
                        if s.class == "ST" && !reasons.is_empty() {
                            reasons.push("若近期改过 ST 流请重新规划".to_string());
                        }
                    }
                }
            }
            let pass = reasons.is_empty();
            StreamVerdict {
                stream_seq: s.stream_seq,
                class: s.class.clone(),
                talker: s.talker.clone(),
                listener: s.listener.clone(),
                received,
                expected: expected_sent,
                jitter_max_ns,
                latency_max_ns,
                window_ns,
                pass,
                judged,
                delivery_ratio,
                note,
                reason: if pass {
                    None
                } else {
                    Some(reasons.join("；"))
                },
            }
        })
        .collect()
}

/// gPTP 收敛诊断（R15，只报告不判）：同一份 CSV 过 `parse_timechanged_csv` 取 clock 向量，
/// `steady_state_offset` 对 GM 插值算逐节点稳态 offset，与逐节点 offset_threshold（mid 经
/// node_ned_names 桥接到 ned；缺省回退 1000ns 全局兜底，与 timesync 软仿同口径）比对。
/// 双宿拆分的内嵌桥（esb*）不在 node_ned_names——其 clock **单列**为独立节点计数、阈值走
/// 缺省（最小惊讶：报告仿真里真实存在的时钟，不并入宿主端系统）。取不到时钟向量 / 无 GM
/// 序列 / 无稳态样本 → None（诊断行缺席，不臆造）。
pub(crate) fn gptp_diag_from_csv(
    csv: &str,
    gm_ned: &str,
    node_ned_names: &BTreeMap<String, String>,
    timing: &[SimNodeTiming],
) -> Option<GptpDiag> {
    let series = parse_timechanged_csv(csv).ok()?;
    let gm_marker = format!("{gm_ned}.clock");
    let gm_series = series.iter().find(|s| s.module.ends_with(&gm_marker))?;
    // ned 名 → 逐节点阈值（ns）：timesync_nodes.offset_threshold 按 mid keyed，经 bundle 的
    // mid→ned 映射桥接（与 run_timesync_sim_inner 同法）。
    let thresholds: BTreeMap<String, f64> = timing
        .iter()
        .filter_map(|t| {
            let ned = node_ned_names.get(&t.mid)?;
            let threshold = t.offset_threshold_ns?;
            Some((ned.clone(), threshold as f64))
        })
        .collect();
    let mut total = 0usize;
    let mut converged = 0usize;
    let mut th_lo = f64::INFINITY;
    let mut th_hi = f64::NEG_INFINITY;
    let mut worst: Option<(String, f64)> = None;
    for s in &series {
        if std::ptr::eq(s, gm_series) {
            continue;
        }
        let Some((max_ns, _mean_ns)) = steady_state_offset(s, gm_series) else {
            continue;
        };
        let ned = series_ned_name(&s.module).unwrap_or(&s.module).to_string();
        let threshold = thresholds
            .get(&ned)
            .copied()
            .unwrap_or(CONVERGENCE_THRESHOLD_NS);
        total += 1;
        if max_ns <= threshold {
            converged += 1;
        }
        th_lo = th_lo.min(threshold);
        th_hi = th_hi.max(threshold);
        if worst.as_ref().is_none_or(|(_, w)| max_ns > *w) {
            worst = Some((ned, max_ns));
        }
    }
    let (worst_node, worst_offset_ns) = worst?;
    let threshold_summary = if (th_hi - th_lo).abs() < f64::EPSILON {
        format!("{th_lo:.0}ns")
    } else {
        format!("{th_lo:.0}–{th_hi:.0}ns")
    };
    Some(GptpDiag {
        converged_nodes: converged,
        total_nodes: total,
        threshold_summary,
        worst_node,
        worst_offset_ns,
    })
}
