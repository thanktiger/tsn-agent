//! `verify_tas`（U8）：pin 住规划出的 GCL 软仿，逐流实测 jitter/丢包/时延判通过。
//! GCL 空：有 ST 流 → `no_plan` 硬拦；无 ST 流 → 放行门全恒开跑（R5/KTD4）。
//! pin 只认 ST-pcp（gate 7）门条目，存量旧全类条目忽略（G2.4 防互补关窗双写同门）。
//!
//! 镜像 `run_timesync_sim_inner`（KTD1 可测内核 + 注入 `RemoteRunner`）：读 `flow_plans` 的 pin
//! GCL → 喂 U6 pin 模式 bundle（写死 transmissionGate、禁配置器）→ 现有 `run_sim_fetch_csv`
//! **零改**（KTD1）跑 + 取 per-packet 向量 CSV → flow `classify`。诚实边界（KTD7）：空/短结果
//! 绝不渲染绿（R16）。**pin 校验的是 plan 落库那张 GCL**——不 pin 则 verify 可能得另一组合法解。
//!
//! 向量名（U1 spike 钉死）：时延 `packetLifeTime:vector`、抖动 `packetJitter:vector`（均落
//! `.vec`、现 scavetool 路径可取）。**丢包判据（U10 收口 plan Open Question）**：INET
//! ActivePacketSource 无「产 N 个就停」参数、按 productionInterval 持续产到 sim 结束，故
//! sim 时长按 `count×period` 推导（`flow_sim_time_s`），「实发」由 `floor(sim/period)+1`
//! 确定性反推（`flow_expected_sent`，无需服务回传发送数）。判 `实发 - 收 ≤ 在途容差`
//! （容差=⌈实测max时延/period⌉+1）——自由产包源 sim 结束时总有在途尾巴，故不能要求精确相等。
//!
//! **U6 断链故障轮（R9/AE2）**：有 RC 流 → 健康+断A+断B 三轮顺序独立提交（KTD3，服务零改动）。
//! 断点=各平面上覆盖最多 RC 流的**有向**链路占用（KTD8，平手优先避开 ST 路由、再取最小
//! link_seq；时钟树边/ST 路由重叠响亮标注不改选，KTD2）；`t_break = max(0.4×最小 RC 活跃窗,
//! 200ms 收敛下限)`，断后被覆盖流应发帧数 <20 整体响亮报错（KTD7）。单轮失败（load_failed/
//! unreachable/busy）继续余轮拿全量信息；顶层 status/per_stream 恒为健康轮结果（前端向后
//! 兼容），`rounds` 携带全轮。
//!
//! **U7 分级判据（R11–R13）+ gPTP 收敛诊断行（R15）**：classify 按类分叉——ST 三项仅健康轮判
//! （FAIL reason 附「重新规划」提示，KTD4）；RC 每轮判去重后收=实发±在途容差（容差逐轮自计），
//! 收>实发即重复帧 FAIL，故障轮只判被断链覆盖的流；BE 仅健康轮判 received>0，送达率随行报告。
//! 故障轮 ST/BE 与未覆盖 RC 只报告不判（judged=false + note）。每轮 CSV 另过
//! `parse_timechanged_csv` 生成 gPTP 收敛诊断（只报告不参与任何 verdict）。

use serde::Serialize;
use sqlx::Row;
use std::collections::{BTreeMap, HashSet};

use crate::inet_remote::{RemoteError, RemoteRunner, SimRunOutcome};
use crate::inet_sim_bundle::{
    FaultSpec, FlowStreamSpec, FlowTasSchedule, GclEntry, SimNodeTiming, SimOverrides,
    build_flow_tas_sim_bundle, flow_expected_sent, flow_sim_time_s, plan_flow_traffic,
};
use crate::inet_sim_command::{
    CONVERGENCE_THRESHOLD_NS, load_timing, load_topology, parse_timechanged_csv, series_ned_name,
    steady_state_offset,
};

pub const CALIBER_FLOW_TAS_VERIFIED: &str = "flow_tas_verified";
/// 抖动上限 1us（R15）。
const JITTER_LIMIT_NS: f64 = 1_000.0;
/// per-packet 时延 + 抖动向量 + clock timeChanged 向量 filter（U1 spike 钉死流量向量名；
/// 时钟子句与 timesync 的 TIMECHANGED_FILTER 同形，R15 诊断行取数——同一份 CSV 流量向量走
/// `parse_vec_csv`、时钟向量走 `parse_timechanged_csv`）。
const FLOW_VERIFY_FILTER: &str = "name=~\"packetLifeTime:vector\" OR name=~\"packetJitter:vector\" OR (module=~\"**.clock\" AND name=~\"timeChanged:vector\")";
/// 断链时刻的 gPTP 收敛下限（KTD7；spike 在 400ms 断链验证过 gPTP 存活，200ms 为收敛底线）。
const FAULT_T_BREAK_FLOOR_NS: u64 = 200_000_000;
/// 断后被覆盖 RC 流的最小应发帧数（KTD7 绝对帧量尾量守卫）。
const FAULT_MIN_FRAMES_AFTER_BREAK: i64 = 20;

/// 单流实测判决。U7 additive 新增：class（分级判据）、judged（该轮是否下判——故障轮 ST/BE
/// 与未被断链覆盖的 RC 只报告不判，judged=false 时 pass 恒 true 不阻塞轮次聚合、note 说明
/// 报告态）、delivery_ratio（BE 送达率=收/实发，只展示不判，R13）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamVerdict {
    pub stream_seq: i64,
    /// 流类别（ST/RC/BE）。
    pub class: String,
    pub talker: String,
    pub listener: String,
    pub received: usize,
    pub expected: i64,
    pub jitter_max_ns: f64,
    pub latency_max_ns: f64,
    pub window_ns: f64,
    pub pass: bool,
    /// 该轮是否对此流下判（U7 分级）。
    pub judged: bool,
    /// BE 送达率（收/实发）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_ratio: Option<f64>,
    /// 报告态备注（「仅健康轮判」/「未测容错」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 每轮 gPTP 收敛诊断（R15，只报告、不参与任何 verdict）：复用 timesync 判据三件套
/// （parse_timechanged_csv / steady_state_offset / 逐节点 offset_threshold，缺省回退
/// 1000ns 全局兜底）。故障轮断链下游时钟劣化属预期，照实报告（断链标注在 annotations）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GptpDiag {
    pub converged_nodes: usize,
    pub total_nodes: usize,
    /// 阈值概览：各节点生效阈值全相同 → 「1000ns」；逐节点混合 → 「200–1000ns」。
    pub threshold_summary: String,
    /// 稳态 offset 最大的节点（ned 名）。
    pub worst_node: String,
    pub worst_offset_ns: f64,
}

/// 单轮验证结果（U6 断链故障轮编排，R9/AE2）。healthy 轮无断链；fault_a/fault_b 各断该平面
/// 覆盖最多 RC 流的一条链路（KTD8）。U7：per_stream 按类分级判决 + gPTP 诊断行。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRound {
    /// healthy | fault_a | fault_b
    pub round: String,
    /// ok | fail | empty | load_failed | unreachable | busy | bundle_error。
    /// busy = 服务端 409 单运行锁（环境冲突，不判验证 FAIL）；顶层 status 仍归 unreachable
    /// 保持既有前端词表。ok/fail 只看该轮**下判**的流（judged=false 的报告态不计）。
    pub status: String,
    pub per_stream: Vec<StreamVerdict>,
    /// 响亮标注（KTD2）：断点描述 / 时钟树边重叠 / ST 路由重叠 / 运行错误详情。
    pub annotations: Vec<String>,
    /// 该轮未被断链途经的 RC 流（「未测容错」字符串；KTD8。per_stream 行同时带 note）。
    pub untested_streams: Vec<String>,
    /// gPTP 收敛诊断行（R15，只报告不判）。取不到时钟向量（旧结果/该轮失败）→ None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gptp_diag: Option<GptpDiag>,
}

/// 验证结果（前端/agent 消费）。KTD7 诚实边界：caliber 恒 flow_tas_verified（仿真实测·非 T10）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTasResult {
    pub caliber: String,
    /// ok | no_plan | no_streams | pcp_mismatch | no_gm | route_error | bundle_error | unreachable | load_failed | empty | fail | fault_window_too_short
    pub status: String,
    pub per_stream: Vec<StreamVerdict>,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// U6 多轮结果：有 RC 流 → [healthy, fault_a, fault_b]；无 RC → None（序列化零变化，
    /// 现状回归）。顶层 status/per_stream 恒为健康轮结果（向后兼容），overall 串联各轮摘要
    /// （最差轮可见，KTD3）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounds: Option<Vec<VerifyRound>>,
    /// 顶层 gPTP 收敛诊断（R15 收尾，U8）：恒为健康轮诊断——有 rounds 时与健康轮的
    /// gptpDiag 同值；无 rounds（纯 ST / ST+BE / 纯 BE 会话）时从该次运行 CSV 算，
    /// 使无 RC 会话也有诊断行。取不到时钟向量 → None（缺席，不臆造）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gptp_diag: Option<GptpDiag>,
}

impl VerifyTasResult {
    fn simple(status: &str, overall: &str, message: Option<String>) -> Self {
        Self {
            caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
            status: status.to_string(),
            per_stream: vec![],
            overall: overall.to_string(),
            message,
            rounds: None,
            gptp_diag: None,
        }
    }
}

/// 读 pin 的 GCL（flow_plans，KTD2b 共用 GclEntry）。
async fn load_gcl(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<Vec<GclEntry>, String> {
    let rows = sqlx::query(
        "SELECT node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver \
         FROM flow_plans WHERE session_id = ? ORDER BY node, eth_n, gate_index",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_plans 失败：{e}"))?;
    Ok(rows
        .iter()
        .map(|r| GclEntry {
            node: r.get("node"),
            eth_n: r.get::<i64, _>("eth_n") as usize,
            gate_index: r.get::<i64, _>("gate_index") as usize,
            initially_open: r.get::<i64, _>("initially_open") != 0,
            offset_ns: r.get::<i64, _>("offset_ns") as u64,
            durations_ns: serde_json::from_str(&r.get::<String, _>("durations_ns"))
                .unwrap_or_default(),
            solver: r.get("solver"),
        })
        .collect())
}

/// CSV-R 一行向量（module + name + 数值样本）。
struct VecRow {
    module: String,
    name: String,
    values: Vec<f64>,
}

/// 解析 scavetool CSV-R 长表（列 module/name/vectime/vecvalue；vecvalue 空格分隔）。
/// 跳过 opp_env 环境横幅，定位真表头（对齐 parse_timechanged_csv）。
fn parse_vec_csv(csv: &str) -> Vec<VecRow> {
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
fn classify(
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
fn gptp_diag_from_csv(
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

/// 断链时刻（ns）：max(0.4 × 最小 RC 活跃窗, 200ms gPTP 收敛下限)（KTD7）。
fn fault_t_break_ns(min_rc_window_ns: u64) -> u64 {
    (min_rc_window_ns * 2 / 5).max(FAULT_T_BREAK_FLOOR_NS)
}

/// 断后某流在给定发送窗内还应发的帧数（KTD7 尾量守卫）。守卫的分母窗是**真实发送窗**
/// （sim 时长——源固定间隔产包到 sim 结束，与 expected_sent 同模型），非 count×period 意图窗
/// （长 ST 流拉长 sim 时短意图窗 RC 断后照样有帧，不得假拒验）。窗已过断点 → 0。
fn frames_after_break(window_ns: u64, t_break_ns: u64, period_ns: u64) -> i64 {
    if window_ns <= t_break_ns || period_ns == 0 {
        0
    } else {
        ((window_ns - t_break_ns) / period_ns) as i64
    }
}

/// 某平面故障轮的断点（KTD8）：断链上游端点（朝 talker 一侧）+ 覆盖/未覆盖流 + 重叠标注位。
struct BreakPoint {
    link_seq: i64,
    upstream_mid: String,
    upstream_db_port: i64,
    covered: Vec<i64>,
    untested: Vec<i64>,
    on_st_route: bool,
    on_clock_tree: bool,
}

/// 故障轮计划：(t_break_ns, [(轮名, 断点)])——有 RC 流才 Some。
type FaultPlan = (u64, Vec<(&'static str, Option<BreakPoint>)>);

/// 断点选择（KTD8）：候选=各 RC 流该平面路径的**有向**链路占用（(link_seq, 上游节点)——
/// 单向 TX 断开只杀同向副本，反向途经不算覆盖）。取覆盖流数最多者；覆盖数平手优先避开
/// ST 流路由（verify 期平面 A link_seqs）；再平手取最小 (link_seq, mid)（BTreeMap 升序，
/// 确定性）。所有最高覆盖候选都撞 ST 路由时不降覆盖去避让——取覆盖最高者并由
/// `on_st_route` 响亮标注（KTD2）；时钟树边同款只标注不改选（结构性避不开）。
fn select_break_point(
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

/// 单轮机器词 → overall 串联用的摘要（ok/fail 给达标计数，其余给状态词本身）。
/// U7：只计该轮**下判**的流；报告态（judged=false）单列尾注，不混进达标/未达标。
fn round_summary(status: &str, per_stream: &[StreamVerdict]) -> String {
    match status {
        "ok" | "fail" => {
            let judged = per_stream.iter().filter(|v| v.judged).count();
            let passed = per_stream.iter().filter(|v| v.judged && v.pass).count();
            let mut s = format!("{passed} 个达标 / {} 个未达标", judged - passed);
            let reported = per_stream.len() - judged;
            if reported > 0 {
                s.push_str(&format!("（另 {reported} 个仅报告）"));
            }
            s
        }
        s => s.to_string(),
    }
}

fn round_label(round: &str) -> &'static str {
    match round {
        "healthy" => "健康轮",
        "fault_a" => "断A轮",
        _ => "断B轮",
    }
}

/// 可测内核：注入 RemoteRunner，pin GCL → bundle → 跑 → 逐流实测判决。
pub async fn verify_tas_inner<R: RemoteRunner>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    runner: &R,
) -> Result<VerifyTasResult, String> {
    let db_streams = crate::flow_plan_command::load_streams(pool, session_id).await?;
    if db_streams.is_empty() {
        return Ok(VerifyTasResult::simple(
            "no_streams",
            "还没有录入任何流。",
            None,
        ));
    }
    // G1.3：入口重校验 class↔pcp 固定映射（ST=7/RC=6/BE=0，U2 录入闸同源）——存量不合规流
    // （录入闸收紧前的旧库）响亮拒绝，防按错门号装配。
    for s in &db_streams {
        if let Some(expected) = crate::flow_verify::expected_pcp(&s.class)
            && s.pcp != expected
        {
            return Ok(VerifyTasResult::simple(
                "pcp_mismatch",
                &format!(
                    "流 {} 的 class/pcp（{}/{}）不符合固定映射（ST=7 / RC=6 / BE=0），请删除重录。",
                    s.stream_seq, s.class, s.pcp
                ),
                None,
            ));
        }
    }

    // R5/KTD4：GCL 空只在存在 ST 流时硬拦（ST 要求先规划）；无 ST 流放行——门全恒开跑。
    // 无 ST 流时存量 flow_plans（删光 ST 后的残留 GCL）一律不消费：pin 零门条目、
    // 补集不生成，与「门全恒开」口径一致。
    let has_st = db_streams.iter().any(|s| s.class == "ST");
    let gcl = if has_st {
        load_gcl(pool, session_id).await?
    } else {
        vec![]
    };
    if gcl.is_empty() && has_st {
        return Ok(VerifyTasResult::simple(
            "no_plan",
            "还没有规划出门控表，请先在流量规划里规划再验证。",
            None,
        ));
    }
    // G2.4/KTD4：pin 只认 ST-pcp 门条目——存量 flow_plans 里旧全类条目（gate0/gate6 等）
    // 忽略，防与后续互补关窗双写同门。ST pcp 单一源：flow_verify::ST_PCP。
    let gcl: Vec<GclEntry> = gcl
        .into_iter()
        .filter(|g| g.gate_index == crate::flow_verify::ST_PCP as usize)
        .collect();

    let (nodes, links) = load_topology(pool, session_id).await?;

    // 路径推导（KTD6）：预存 paths 仅凭证——RC 一律重跑 derive_redundant_routes + 不相交断言
    // （拓扑在录流后被改动时以重推导为准；断言失败响亮报错不装配）。ST/BE 双平面锁平面 A、
    // 单平面 None：有 RC 时 ST 单树进 FRER configurator；无 RC 双平面时 link_seqs 供转发钉死。
    let dual_plane = links
        .iter()
        .any(|l| crate::flow_route::link_plane(l).is_some());
    let has_rc = db_streams.iter().any(|s| s.class == "RC");
    let route_fail = |seq: i64, errs: Vec<crate::topology_verify::VerifyError>| {
        let msg = errs
            .iter()
            .map(|e| e.message_zh.clone())
            .collect::<Vec<_>>()
            .join("；");
        VerifyTasResult::simple(
            "route_error",
            "流路径推导失败（不可达/歧义/冗余不相交断言失败），未装配验证工程。",
            Some(format!("流 {seq}：{msg}")),
        )
    };
    let mut specs: Vec<FlowStreamSpec> = Vec::new();
    // U6：RC 各流的 A/B 重推导路径与 ST 平面 A link 集顺手收集——断点选择（KTD8）与
    // ST 路由避让/标注（KTD2）的输入，与装配同一份推导、绝不二算。
    let mut rc_routes: Vec<(i64, crate::flow_route::Route, crate::flow_route::Route)> = Vec::new();
    let mut st_links: HashSet<i64> = HashSet::new();
    for s in &db_streams {
        let (frer_trees, pin_links) = if s.class == "RC" {
            match crate::flow_route::derive_redundant_routes(&s.talker, &s.listener, &nodes, &links)
            {
                Ok((a, b)) => {
                    let trees = Some(vec![a.node_path.clone(), b.node_path.clone()]);
                    rc_routes.push((s.stream_seq, a, b));
                    (trees, None)
                }
                Err(errs) => return Ok(route_fail(s.stream_seq, errs)),
            }
        } else if dual_plane && (!has_rc || s.class == "ST") {
            match crate::flow_route::derive_route(
                &crate::flow_route::RouteRequest {
                    talker: &s.talker,
                    listener: &s.listener,
                    plane: Some("A"),
                },
                &nodes,
                &links,
            ) {
                Ok(r) if has_rc => {
                    // 该分支在 has_rc 下只有 ST 流进得来（BE 落 else 分支）。
                    st_links.extend(r.link_seqs.iter().copied());
                    (Some(vec![r.node_path]), None)
                }
                Ok(r) => (None, Some(r.link_seqs)),
                Err(errs) => return Ok(route_fail(s.stream_seq, errs)),
            }
        } else {
            (None, None) // 单平面沿现状；RC 会话的 BE 留在 FRER 之外（untagged pcp0）。
        };
        specs.push(FlowStreamSpec {
            stream_seq: s.stream_seq,
            class: s.class.clone(),
            pcp: s.pcp,
            talker: s.talker.clone(),
            listener: s.listener.clone(),
            period_us: s.period_us,
            frame_bytes: s.frame_bytes,
            count: s.count,
            max_latency_us: s.max_latency_us,
            path_fragments: None, // pin 模式不需 pathFragments（门已写死、配置器禁）。
            frer_trees,
            pin_links,
        });
    }
    let gm_mid: Option<String> =
        sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读 GM 失败：{e}"))?
            .flatten();
    let Some(gm_mid) = gm_mid.filter(|g| !g.is_empty()) else {
        return Ok(VerifyTasResult::simple(
            "no_gm",
            "未设 GM，请先在时间同步阶段设定 GM。",
            None,
        ));
    };
    let timing = load_timing(pool, session_id).await?;

    // 与 bundle 用同一公式（SimOverrides::default 未覆盖 sim_time）——反推实发数、尾量守卫
    // 的真实发送窗共用；三轮同一时长。
    let sim_time_s = flow_sim_time_s(&specs);

    // ---- U6：断链故障轮编排准备（有 RC 才有；KTD2/KTD3/KTD7/KTD8）----
    // 断点与断链时刻在跑任何软仿前定死；尾量不足整体响亮报错（不烧三轮墙钟）。
    let fault_plan: Option<FaultPlan> = if has_rc {
        let min_rc_window_ns = db_streams
            .iter()
            .filter(|s| s.class == "RC")
            .map(|s| s.count.max(1) as u64 * s.period_us.max(1) as u64 * 1_000)
            .min()
            .unwrap_or(0);
        let t_break_ns = fault_t_break_ns(min_rc_window_ns);
        // 时钟树只读消费（KTD2）：判断断点是否树边——重叠只标注不改选（双平面单跳拓扑上
        // 结构性避不开）。
        let clock_tree = crate::timesync_tree::compute_clock_tree(pool, session_id, &gm_mid, &[])
            .await
            .map_err(|e| format!("读时钟树失败：{e}"))?;
        let plane_a: Vec<(i64, &crate::flow_route::Route)> =
            rc_routes.iter().map(|(s, a, _)| (*s, a)).collect();
        let plane_b: Vec<(i64, &crate::flow_route::Route)> =
            rc_routes.iter().map(|(s, _, b)| (*s, b)).collect();
        let planned = vec![
            (
                "fault_a",
                select_break_point(&plane_a, &st_links, &links, &clock_tree),
            ),
            (
                "fault_b",
                select_break_point(&plane_b, &st_links, &links, &clock_tree),
            ),
        ];
        // KTD7 尾量守卫：断后每条被覆盖 RC 流在真实发送窗（sim 时长，源产包到 sim 结束）内
        // 应发帧数 ≥ 20。t_break 仍按最小 RC 意图窗计（上方 fault_t_break_ns），只有分母改窗。
        let sim_window_ns = (sim_time_s * 1e9) as u64;
        let mut violations: Vec<String> = Vec::new();
        for (_, bp) in &planned {
            let Some(bp) = bp else { continue };
            for seq in &bp.covered {
                let Some(s) = db_streams.iter().find(|d| d.stream_seq == *seq) else {
                    continue;
                };
                let period_ns = s.period_us.max(1) as u64 * 1_000;
                let frames = frames_after_break(sim_window_ns, t_break_ns, period_ns);
                if frames < FAULT_MIN_FRAMES_AFTER_BREAK {
                    violations.push(format!(
                        "流 {seq} 断链（t={}ms）后发送窗内仅应发 {frames} 帧（<{FAULT_MIN_FRAMES_AFTER_BREAK}）",
                        t_break_ns / 1_000_000
                    ));
                }
            }
        }
        violations.sort();
        violations.dedup();
        if !violations.is_empty() {
            return Ok(VerifyTasResult::simple(
                "fault_window_too_short",
                "断链容错窗口不足，无法有效评估 RC 容错，请调大 RC 流的 count。",
                Some(violations.join("；")),
            ));
        }
        Some((t_break_ns, planned))
    } else {
        None
    };

    let (_classes, placements, _node_apps) = plan_flow_traffic(&specs);

    // 单轮执行（KTD3：三轮=三次独立 bundle + 顺序提交共用此路径）：装 bundle（fault=None 即
    // 健康轮，产物与 U5 后现状位级一致）→ 跑 → classify（U7 分级：故障轮带被断链覆盖的 RC
    // 流集，只判它们）→ gPTP 诊断（R15，只报告）。返回 (round status, per_stream, 详情, 诊断)。
    // busy=服务端 409 单运行锁（凭 BUSY_MESSAGE 文案判别，环境冲突不与验证 FAIL 混淆；
    // 其余 Unreachable 归 unreachable 兜底）。
    type RoundOutput = (String, Vec<StreamVerdict>, Option<String>, Option<GptpDiag>);
    let run_round = |fault: Option<(FaultSpec, &HashSet<i64>)>| -> RoundOutput {
        let (fault_spec, fault_covered) = match &fault {
            Some((f, covered)) => (Some(f.clone()), Some(*covered)),
            None => (None, None),
        };
        let sim_bundle = match build_flow_tas_sim_bundle(
            &nodes,
            &links,
            &gm_mid,
            &timing,
            &SimOverrides {
                has_rc,
                fault: fault_spec,
                ..Default::default()
            },
            &specs,
            FlowTasSchedule::Pin(&gcl),
            session_id,
            0,
        ) {
            Ok(b) => b,
            Err(errs) => {
                let msg = errs
                    .iter()
                    .map(|e| e.message_zh.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                return ("bundle_error".to_string(), vec![], Some(msg), None);
            }
        };
        let outcome: SimRunOutcome =
            match runner.run_sim_fetch_csv(&sim_bundle.bundle, FLOW_VERIFY_FILTER) {
                Ok(o) => o,
                Err(RemoteError::Unreachable(m)) => {
                    let status = if m.contains(crate::inet_sim_http::BUSY_MESSAGE) {
                        "busy"
                    } else {
                        "unreachable"
                    };
                    return (status.to_string(), vec![], Some(m), None);
                }
            };
        if outcome.exit_code != Some(0) {
            return (
                "load_failed".to_string(),
                vec![],
                Some(outcome.output_tail),
                None,
            );
        }
        let Some(csv) = outcome.csv else {
            // 空=FAIL，绝不渲染绿（R16）。
            return ("empty".to_string(), vec![], None, None);
        };
        let rows = parse_vec_csv(&csv);
        let per_stream = classify(
            &rows,
            &specs,
            &placements,
            &sim_bundle.node_ned_names,
            sim_time_s,
            fault_covered,
        );
        // gPTP 收敛诊断（R15）：同一份 CSV 取 clock 向量，只报告不参与轮判。
        let diag = gptp_diag_from_csv(
            &csv,
            &sim_bundle.gm_ned_name,
            &sim_bundle.node_ned_names,
            &timing,
        );
        // 轮判只看下判的流（报告态不阻塞也不放行）；下判流为零不该发生（健康轮全判、
        // 故障轮 covered 非空），防御性归 fail 不染绿。
        let judged = per_stream.iter().filter(|v| v.judged).count();
        let passed = per_stream.iter().filter(|v| v.judged && v.pass).count();
        let all_pass = judged > 0 && passed == judged;
        (
            (if all_pass { "ok" } else { "fail" }).to_string(),
            per_stream,
            None,
            diag,
        )
    };

    // 健康轮（无 RC 时即唯一轮，现状回归）。
    let (h_status, h_per, h_detail, h_diag) = run_round(None);

    // 顶层结果 = 健康轮（向后兼容：status/per_stream/文案词表与单轮现状一致；round 级
    // busy 顶层归 unreachable，前端本单元零改动）。
    let mut result = match h_status.as_str() {
        "bundle_error" => {
            VerifyTasResult::simple("bundle_error", "验证工程生成失败。", h_detail.clone())
        }
        "unreachable" | "busy" => VerifyTasResult::simple(
            "unreachable",
            "验证暂时无法运行（软仿服务不可达），工程保持原状。",
            h_detail.clone(),
        ),
        "load_failed" => VerifyTasResult::simple(
            "load_failed",
            "INET 没跑起来（pin 工程装配失败）。",
            h_detail.clone(),
        ),
        "empty" => VerifyTasResult::simple(
            "empty",
            "结果为空：未取到 per-packet 向量（检查 recording/模块路径）。",
            Some("空结果不渲染成通过。".to_string()),
        ),
        _ => {
            let passed = h_per.iter().filter(|v| v.pass).count();
            VerifyTasResult {
                caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
                status: h_status.clone(),
                overall: format!("{passed} 个达标 / {} 个未达标", h_per.len() - passed),
                per_stream: h_per.clone(),
                message: None,
                rounds: None,
                gptp_diag: None,
            }
        }
    };
    // R15 收尾（U8）：顶层诊断恒取健康轮——无 rounds 会话（纯 ST/ST+BE/纯 BE）由此也有
    // 诊断行；有 rounds 时与下方健康轮 gptpDiag 同值。错误轮 h_diag 本就是 None。
    result.gptp_diag = h_diag.clone();

    let Some((t_break_ns, planned)) = fault_plan else {
        return Ok(result); // 无 RC：单轮零变化（rounds=None，序列化与现状逐字一致）。
    };

    // ---- 故障轮执行（KTD3 顺序独立提交；单轮失败继续余轮拿全量信息）----
    let mut rounds: Vec<VerifyRound> = vec![VerifyRound {
        round: "healthy".to_string(),
        status: h_status,
        per_stream: h_per,
        annotations: h_detail.into_iter().collect(),
        untested_streams: vec![],
        gptp_diag: h_diag,
    }];
    for (name, bp) in planned {
        let round = match bp {
            None => VerifyRound {
                // 防御分支：RC 路径非空时选不出断点不该发生。
                round: name.to_string(),
                status: "bundle_error".to_string(),
                per_stream: vec![],
                annotations: vec!["该平面无可断链路（RC 路径为空）。".to_string()],
                untested_streams: vec![],
                gptp_diag: None,
            },
            Some(bp) => {
                let covered_set: HashSet<i64> = bp.covered.iter().copied().collect();
                let (status, per_stream, detail, diag) = run_round(Some((
                    FaultSpec {
                        src_mid: bp.upstream_mid.clone(),
                        src_db_port: bp.upstream_db_port,
                        t_break_ns,
                    },
                    &covered_set,
                )));
                let mut annotations = vec![format!(
                    "断链：t={}ms 单向断开链路 {}（上游节点 {} 出向）",
                    t_break_ns / 1_000_000,
                    bp.link_seq,
                    bp.upstream_mid
                )];
                if bp.on_clock_tree {
                    annotations.push(format!(
                        "断点链路 {} 是时钟树边：断后下游时钟自由运行，时钟劣化属预期（结构性避不开，KTD2）。",
                        bp.link_seq
                    ));
                }
                if bp.on_st_route {
                    annotations.push(format!(
                        "断点链路 {} 与 ST 流路由重叠（无法避开）：该轮 ST 判读仅供参考。",
                        bp.link_seq
                    ));
                }
                annotations.extend(detail);
                VerifyRound {
                    round: name.to_string(),
                    status,
                    per_stream,
                    annotations,
                    untested_streams: bp
                        .untested
                        .iter()
                        .map(|s| format!("流 {s}：未测容错（断点不在其该平面路径上）"))
                        .collect(),
                    gptp_diag: diag,
                }
            }
        };
        rounds.push(round);
    }
    // overall 取最差可见（KTD3）：逐轮摘要串联，最差轮的状态词一定在串里；
    // 顶层 status/per_stream 保持健康轮（向后兼容）。
    result.overall = rounds
        .iter()
        .map(|r| {
            format!(
                "{}：{}",
                round_label(&r.round),
                round_summary(&r.status, &r.per_stream)
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    result.rounds = Some(rounds);
    Ok(result)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTasRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn verify_tas(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: VerifyTasRequest,
) -> Result<VerifyTasResult, String> {
    let pool = store.pool(&app).await?;
    let Some(base_url) = crate::inet_sim_http_config::resolve_inet_sim_http_url(pool).await? else {
        return Ok(VerifyTasResult::simple(
            "no_service",
            "未配置软仿 HTTP 服务地址，请在设置里填写。",
            Some("InetSimHttpConfig.base_url 为空。".to_string()),
        ));
    };
    let runner =
        crate::inet_sim_http::HttpRunner::new(crate::inet_sim_http::ReqwestInetSimClient, base_url);
    verify_tas_inner(pool, &request.session_id, &runner).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// Mock RemoteRunner：回冻结的 outcome，捕获 filter。
    struct MockRunner {
        outcome: SimRunOutcome,
    }
    impl RemoteRunner for MockRunner {
        fn run_sim_fetch_csv(
            &self,
            _bundle: &crate::inet_remote::InetBundle,
            _filter: &str,
        ) -> Result<SimRunOutcome, RemoteError> {
            Ok(SimRunOutcome {
                exit_code: self.outcome.exit_code,
                output_tail: self.outcome.output_tail.clone(),
                csv: self.outcome.csv.clone(),
                scavetool_failed: self.outcome.scavetool_failed,
            })
        }
    }

    /// 捕获送去软仿的 ini（断言 pin 段形态）。
    struct CapturingRunner {
        outcome: SimRunOutcome,
        ini: std::sync::Mutex<Option<String>>,
    }
    impl RemoteRunner for CapturingRunner {
        fn run_sim_fetch_csv(
            &self,
            bundle: &crate::inet_remote::InetBundle,
            _filter: &str,
        ) -> Result<SimRunOutcome, RemoteError> {
            *self.ini.lock().unwrap() = Some(bundle.omnetpp_ini.clone());
            Ok(SimRunOutcome {
                exit_code: self.outcome.exit_code,
                output_tail: self.outcome.output_tail.clone(),
                csv: self.outcome.csv.clone(),
                scavetool_failed: self.outcome.scavetool_failed,
            })
        }
    }

    fn outcome(csv: Option<&str>) -> SimRunOutcome {
        SimRunOutcome {
            exit_code: Some(0),
            output_tail: "ok".into(),
            csv: csv.map(|c| c.to_string()),
            scavetool_failed: false,
        }
    }

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','n','n','{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    async fn seed(pool: &sqlx::Pool<sqlx::Sqlite>) {
        // es1(1) — sw1(0) — es2(2)。GM=1。一条 ST 流 es1→es2，count=3。
        for (mid, ty, ord) in [
            ("0", "switch", 0),
            ("1", "endSystem", 1),
            ("2", "endSystem", 2),
        ] {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                .bind(mid).bind(ty).bind(ord).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '1', '0', 0, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 1, NULL, '0', '2', 1, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '1')")
            .execute(pool)
            .await
            .unwrap();
        for mid in ["0", "1", "2"] {
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', ?, '[]', '[]')")
                .bind(mid).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 0, 'ST', 7, 500, 512, 3, '1', '2', 400)")
            .execute(pool).await.unwrap();
        // pin GCL 一条（sw1=mid0, eth1, gate7=ST 门）。
        sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
            .execute(pool).await.unwrap();
    }

    fn header() -> String {
        "module,name,vectime,vecvalue\n".to_string()
    }

    /// es2 是 listener(mid2)，其 sink app[0]。流 count=3，窗口 400us。
    /// AE4：收=发=3、抖动<1us、时延在窗口 → PASS。
    #[test]
    fn verify_pass_when_received_equals_sent_low_jitter() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 时延 3 样本（秒）都 < 400us；抖动 3 样本 < 1us。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let runner = MockRunner {
                outcome: outcome(Some(&csv)),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(r.per_stream.len(), 1);
            assert!(r.per_stream[0].pass);
            assert_eq!(r.per_stream[0].received, 3);
            // 实发按 sim 时长反推（count×period=1500us → floor(1500/500)+1=4），非用户 count=3；
            // 收 3 差 1 属在途尾巴（≤容差）→ 仍判通过。
            assert_eq!(r.per_stream[0].expected, 4);
        });
    }

    /// 抖动 > 1us → 该流 FAIL、整体 fail。
    #[test]
    fn verify_fail_on_high_jitter() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 高抖动样本放在**非首位**（首样本被 skip_first 跳过——那是定义性启动瞬态）。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000001 0.000002 0.0000003\n",
                header()
            );
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert!(!r.per_stream[0].pass);
            assert!(r.per_stream[0].reason.as_deref().unwrap().contains("抖动"));
        });
    }

    /// 首样本高抖动是定义性启动瞬态（INET packetJitter 首值≈首包时延），应被跳过→不判失败。
    #[test]
    fn verify_ignores_first_sample_jitter_spike() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 首抖动样本 2us（>1us）但其余 <1us；跳首后不该触发抖动失败。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.000002 0.0000003 0.0000001\n",
                header()
            );
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert!(r.per_stream[0].pass, "首样本抖动尖不该判失败：{r:?}");
        });
    }

    /// AE4/AE7：收 < 发（丢包，坏 GCL 致碰撞的表现）→ FAIL。
    #[test]
    fn verify_fail_on_packet_loss() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 只收到 1 个（实发≈4：sim=count×period=1500us→floor+1=4）——丢 3 个远超在途容差 → FAIL。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0,0.0001\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0,0.0000002\n",
                header()
            );
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert!(r.per_stream[0].reason.as_deref().unwrap().contains("丢包"));
        });
    }

    /// 空 CSV（无向量）→ empty，绝不渲染绿（R16）。
    #[test]
    fn verify_empty_csv_is_not_green() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(None),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "empty");
            assert!(r.per_stream.is_empty());
        });
    }

    /// 未规划（flow_plans 空）且存在 ST 流 → no_plan（U3④：ST 才要求 GCL）。
    #[test]
    fn verify_without_plan_is_no_plan() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 只 seed 拓扑 + 流，不写 flow_plans。
            for (mid, ty, ord) in [
                ("0", "switch", 0),
                ("1", "endSystem", 1),
                ("2", "endSystem", 2),
            ] {
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                    .bind(mid).bind(ty).bind(ord).execute(&pool).await.unwrap();
            }
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'ST', 7, 500, 512, 3, '1', '2')")
                .execute(&pool).await.unwrap();
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(None),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "no_plan");
        });
    }

    /// Covers AE5（U3③，R5/R13 前半）：纯 BE 流集、flow_plans 空 → 不再 no_plan，
    /// 放行跑软仿（门全恒开）。
    #[test]
    fn verify_pure_be_without_gcl_runs() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 换成纯 BE 流集 + 清掉 GCL。
            sqlx::query("DELETE FROM topology_streams WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM flow_plans WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 0, 'BE', 0, 500, 512, 3, '1', '2', 400)")
                .execute(&pool).await.unwrap();
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_ne!(r.status, "no_plan", "无 ST 流不得因空 GCL 硬拦：{r:?}");
            assert_eq!(r.status, "ok", "{r:?}");
        });
    }

    /// 删光 ST 后存量 GCL 不消费：seed 的 gate7 flow_plans 残留 + 纯 BE 流集 → 提交的
    /// pin ini 无任何 transmissionGate 行（零门条目、补集不接管存量），验证正常跑。
    #[test]
    fn stale_gcl_ignored_when_no_st_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // 带 gate7 flow_plans 存量。
            // 删光 ST，只留 BE（不清 flow_plans——模拟删流后残留）。
            sqlx::query("DELETE FROM topology_streams WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'BE', 0, 500, 512, 3, '1', '2')")
                .execute(&pool).await.unwrap();
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let runner = CapturingRunner {
                outcome: outcome(Some(&csv)),
                ini: std::sync::Mutex::new(None),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = runner.ini.lock().unwrap().clone().unwrap();
            assert!(
                !ini.contains("transmissionGate["),
                "纯 BE 不得 pin 存量门条目、不得生成补集：{ini}"
            );
        });
    }

    /// Covers G2.4（U3⑤）：存量 flow_plans 混有 gate0（旧全类条目）→ pin 段只出 gate7，
    /// gate0 的 transmissionGate 行不得出现（互补关窗接管前提）。
    #[test]
    fn verify_pin_filters_non_st_gate_entries() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // 已含 gate7 条目。
            sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 0, 1, 0, '[500000,500000]', 'Z3')")
                .execute(&pool).await.unwrap();
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let runner = CapturingRunner {
                outcome: outcome(Some(&csv)),
                ini: std::sync::Mutex::new(None),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = runner.ini.lock().unwrap().clone().unwrap();
            assert!(ini.contains("transmissionGate[7]"), "{ini}");
            assert!(
                !ini.contains("transmissionGate[0]"),
                "gate0 存量条目应被 pin 过滤：{ini}"
            );
        });
    }

    /// Covers R8/AE4（U5 接线）：混流会话（ST+BE）→ verify 提交的 pin ini 带补集门
    /// （从全流集判 BE 存在性，经 build_flow_tas_sim_bundle 推导）：非 ST 门有补集参数但
    /// **不带** enableImplicitGuardBand 行；ST 门维持显式 false。纯 ST 会话由
    /// verify_pin_filters_non_st_gate_entries 反向锁定（无 transmissionGate[0]）。
    #[test]
    fn verify_mixed_session_emits_complement_gates() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // ST 流 + gate7 GCL（sw1 eth1 开 [0,300us)）。
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'BE', 0, 500, 512, 3, '1', '2', 400)")
                .execute(&pool).await.unwrap();
            // 两个 sink（es2.app[0]=ST、app[1]=BE）都给健康向量。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\nTsnAgentFlowTasNetwork.es2.app[1].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[1].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let runner = CapturingRunner {
                outcome: outcome(Some(&csv)),
                ini: std::sync::Mutex::new(None),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = runner.ini.lock().unwrap().clone().unwrap();
            // ST 门：显式关隐式保护带（真机验证关键行）。
            assert!(
                ini.contains("*.sw1.eth[1].macLayer.queue.transmissionGate[7].enableImplicitGuardBand = false"),
                "{ini}"
            );
            // 补集门：gate0（BE/gPTP）带补集窗参数、无 guard band 行（保持 INET 默认 true）。
            assert!(
                ini.contains("*.sw1.eth[1].macLayer.queue.transmissionGate[0].durations = [700000ns, 300000ns]"),
                "{ini}"
            );
            assert!(
                ini.contains("*.sw1.eth[1].macLayer.queue.transmissionGate[0].offset = 700000ns"),
                "{ini}"
            );
            assert!(
                !ini.contains("transmissionGate[0].enableImplicitGuardBand"),
                "补集门不得写 enableImplicitGuardBand：{ini}"
            );
        });
    }

    /// Covers G1.3（U3⑥）：存量 ST@pcp3 流（录入闸收紧前旧库）→ verify 入口响亮拒绝。
    #[test]
    fn verify_rejects_stale_stream_with_wrong_pcp() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            sqlx::query("UPDATE topology_streams SET pcp=3 WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(None),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "pcp_mismatch", "{r:?}");
            assert!(r.overall.contains("流 0"), "{r:?}");
            assert!(r.overall.contains("删除重录"), "{r:?}");
        });
    }

    // ---------- U4：RC 重推导（凭证不作输入）/ 断言失败响亮不装配 ----------

    /// 双平面 seed：es1(1) —A— sw1(0) —A— es2(2)；—B— sw2(3) —B—。GM=sw1(0)。
    /// 一条 RC 流 es1→es2（count=2000×500us → 活跃窗 1s：t_break=0.4×1s=400ms、断后
    /// 1200 帧过 KTD7 尾量守卫），paths 凭证由调用方传（模拟录入时预存）。
    async fn seed_dual_plane_rc(pool: &sqlx::Pool<sqlx::Sqlite>, paths: &str) {
        for (mid, ty, ord) in [
            ("0", "switch", 0),
            ("1", "endSystem", 1),
            ("2", "endSystem", 2),
            ("3", "switch", 3),
        ] {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                .bind(mid).bind(ty).bind(ord).execute(pool).await.unwrap();
        }
        for (seq, src, sp, dst, dp, plane) in [
            (0, "1", 0, "0", 0, "A"),
            (1, "0", 1, "2", 0, "A"),
            (2, "1", 1, "3", 0, "B"),
            (3, "3", 1, "2", 1, "B"),
        ] {
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, ?)")
                .bind(seq).bind(src).bind(dst).bind(sp).bind(dp)
                .bind(format!(r#"{{"plane":"{plane}"}}"#))
                .execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '0')")
            .execute(pool)
            .await
            .unwrap();
        for mid in ["0", "1", "2", "3"] {
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', ?, '[]', '[]')")
                .bind(mid).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us, redundant, paths) VALUES ('s1', 0, 'RC', 6, 500, 512, 2000, '1', '2', 400, 1, ?)")
            .bind(paths).execute(pool).await.unwrap();
    }

    /// n 个健康样本（时延 100us / 抖动 0.2ns）的 sink 向量对（RC seed 的 sim=1s、
    /// 实发 2001 时按 n=2001 造收=发）。
    fn healthy_csv(module: &str, n: usize) -> String {
        let t = vec!["0"; n].join(" ");
        let lat = vec!["0.0001"; n].join(" ");
        let jit = vec!["0.0000002"; n].join(" ");
        format!(
            "{}{module},packetLifeTime:vector,{t},{lat}\n{module},packetJitter:vector,{t},{jit}\n",
            header()
        )
    }

    /// Covers G1.2（U4④/KTD6）：paths 凭证与重推导不一致（凭证是拓扑改动前的过期快照）→
    /// 以重推导为准可跑——装配 trees 用重推导结果，凭证不作输入；且 RC 会话 ini 带 FRER 段。
    #[test]
    fn verify_rc_rederives_paths_ignoring_stale_credential() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 过期凭证：node_path 指向已不存在的节点 9（拓扑录流后被改过）。
            let stale = r#"{"a":{"node_path":["1","9","2"],"link_seqs":[9]},"b":{"node_path":["1","8","2"],"link_seqs":[8]}}"#;
            seed_dual_plane_rc(&pool, stale).await;
            // 收=实发（sim=1s、500us → 2001）。
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = CapturingRunner {
                outcome: outcome(Some(&csv)),
                ini: std::sync::Mutex::new(None),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_ne!(r.status, "route_error", "重推导可行不得报错：{r:?}");
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = runner.ini.lock().unwrap().clone().unwrap();
            // FRER 段在，trees 是重推导的真路径（含拆分内嵌桥），不是过期凭证里的节点 9/8。
            assert!(ini.contains("*.*.hasStreamRedundancy = true"), "{ini}");
            assert!(
                ini.contains("trees: [[[\"es1\",\"esb1\",\"sw1\",\"esb2\",\"es2\"]],[[\"es1\",\"esb1\",\"sw2\",\"esb2\",\"es2\"]]]"),
                "{ini}"
            );
            assert!(!ini.contains("\"9\""), "过期凭证不得进装配：{ini}");
        });
    }

    /// Covers U4⑤：拓扑改成 A/B 相交（两平面共用中间节点）→ 重推导断言失败，响亮报错
    /// route_error、不装配（runner 不被调用）——预存凭证再合法也救不了。
    #[test]
    fn verify_rc_rederivation_failure_is_loud_and_blocks_assembly() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 合法形状的旧凭证（录入时曾不相交）。
            let old = r#"{"a":{"node_path":["1","0","2"],"link_seqs":[0,1]},"b":{"node_path":["1","3","2"],"link_seqs":[2,3]}}"#;
            seed_dual_plane_rc(&pool, old).await;
            // 拓扑已改：平面 B 改为也经 sw1(0)（并行链路）→ A/B 共用中间节点。
            sqlx::query("UPDATE topology_links SET src_node='1', dst_node='0', src_port=2, dst_port=2 WHERE session_id='s1' AND link_seq=2")
                .execute(&pool).await.unwrap();
            sqlx::query("UPDATE topology_links SET src_node='0', dst_node='2', src_port=3, dst_port=2 WHERE session_id='s1' AND link_seq=3")
                .execute(&pool).await.unwrap();
            let runner = CapturingRunner {
                outcome: outcome(None),
                ini: std::sync::Mutex::new(None),
            };
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "route_error", "{r:?}");
            assert!(
                r.message.as_deref().unwrap().contains("流 0"),
                "响亮指认流：{r:?}"
            );
            assert!(
                runner.ini.lock().unwrap().is_none(),
                "断言失败不得装配/提交软仿"
            );
        });
    }

    // ---------- U10 端到端接缝：录流 → plan_tas → verify_tas（mock 双端）----------

    struct MockPlan {
        sca: String,
    }
    impl crate::inet_sim_http::InetSimPlanClient for MockPlan {
        fn plan_gcl(
            &self,
            _base: &str,
            _b: &crate::inet_remote::InetBundle,
        ) -> Result<crate::inet_sim_http::HttpPlanResult, String> {
            Ok(crate::inet_sim_http::HttpPlanResult {
                exit_code: 0,
                output_tail: "ok".into(),
                sca_gcl: Some(self.sca.clone()),
                solver: Some("Z3".into()),
            })
        }
    }

    /// R18/R19 CI 接缝：一条 ST 流 record → plan_tas_inner 写 flow_plans → verify_tas_inner 读回
    /// pin 判决。证 plan→verify 经 flow_plans 的接缝（durations JSON 往返、node=mid、stream_seq=0）。
    #[test]
    fn e2e_plan_then_verify_pipeline() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await;
            // 清掉 seed 写的 flow_plans——让 plan_tas 自己综合落库（真接缝）。
            sqlx::query("DELETE FROM flow_plans WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();

            // plan：mock 服务回 sw1 gate7（ST 门）的 .sca（ned sw1 → mid 0）。
            let plan_client = MockPlan {
                sca: "par N.sw1.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] durations \"[300us, 700us]\"\n".into(),
            };
            let pr =
                crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan_client, "http://x")
                    .await
                    .unwrap();
            assert_eq!(pr.status, "ok", "{pr:?}");
            assert_eq!(pr.gate_count, 1);

            // flow_plans 落库（plan 写的）→ verify 读回 pin。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let vr = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(vr.status, "ok", "{vr:?}");
            assert!(vr.per_stream[0].pass);
        });
    }

    /// R24 对照：故意坏 GCL（碰撞致丢包）软仿判 FAIL——证闸能区分好坏排程。
    #[test]
    fn e2e_bad_gcl_fails_verification() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // seed 已写一条 GCL（视作坏排程占位）。
            // 坏排程的软仿表现：收 < 发（碰撞丢包）。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0,0.0001\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0,0.0000002\n",
                header()
            );
            let vr = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(vr.status, "fail", "坏 GCL 应判 FAIL：{vr:?}");
        });
    }

    // ---------- U6：断链故障轮编排（KTD2/KTD3/KTD7/KTD8）----------

    /// U6 多轮 runner：脚本化逐轮 outcome + 捕获每轮 bundle（ini/ned），断言三轮编排。
    struct ScriptedRunner {
        script: std::sync::Mutex<std::collections::VecDeque<Result<SimRunOutcome, RemoteError>>>,
        bundles: std::sync::Mutex<Vec<(String, String)>>,
    }
    impl ScriptedRunner {
        fn new(script: Vec<Result<SimRunOutcome, RemoteError>>) -> Self {
            Self {
                script: std::sync::Mutex::new(script.into()),
                bundles: std::sync::Mutex::new(vec![]),
            }
        }
        fn inis(&self) -> Vec<String> {
            self.bundles
                .lock()
                .unwrap()
                .iter()
                .map(|(i, _)| i.clone())
                .collect()
        }
        fn neds(&self) -> Vec<String> {
            self.bundles
                .lock()
                .unwrap()
                .iter()
                .map(|(_, n)| n.clone())
                .collect()
        }
    }
    impl RemoteRunner for ScriptedRunner {
        fn run_sim_fetch_csv(
            &self,
            bundle: &crate::inet_remote::InetBundle,
            _filter: &str,
        ) -> Result<SimRunOutcome, RemoteError> {
            self.bundles
                .lock()
                .unwrap()
                .push((bundle.omnetpp_ini.clone(), bundle.network_ned.clone()));
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .expect("脚本外的多余轮次调用")
        }
    }

    const RC_PATHS: &str = r#"{"a":{"node_path":["1","0","2"],"link_seqs":[0,1]},"b":{"node_path":["1","3","2"],"link_seqs":[2,3]}}"#;

    /// Covers AE2（U6①⑦）：有 RC → 健康+断A+断B 三轮顺序提交（KTD3）。健康轮 ini/NED 无
    /// scenarioManager（零变化）；断A轮带 disconnect（t 手算=0.4×RC 活跃窗 1s=400ms、
    /// src-module 经 SplitEs 映射→esb1、平面 A 端口 0→ethg$o[0]）；断B轮断平面 B（端口 1）。
    #[test]
    fn fault_rounds_three_runs_with_disconnect_script() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let rounds = r.rounds.as_ref().expect("有 RC 应有 rounds");
            assert_eq!(
                rounds.iter().map(|x| x.round.as_str()).collect::<Vec<_>>(),
                vec!["healthy", "fault_a", "fault_b"]
            );
            assert!(rounds.iter().all(|x| x.status == "ok"), "{rounds:?}");
            let inis = runner.inis();
            let neds = runner.neds();
            assert_eq!(inis.len(), 3, "三次独立提交（KTD3）");
            // 健康轮零变化。
            assert!(!inis[0].contains("scenarioManager"), "{}", inis[0]);
            assert!(!neds[0].contains("ScenarioManager"), "{}", neds[0]);
            // 断A轮：t=0.4×(2000×500us)=400ms；断点=链路 0（es1→sw1 有向），上游 es1 拆分
            // → esb1，库端口 0 → ethg$o[0]。
            assert!(
                inis[1].contains(
                    "*.scenarioManager.script = xml(\"<script><at t='400000000ns'><disconnect src-module='esb1' src-gate='ethg$o[0]'/></at></script>\")"
                ),
                "{}",
                inis[1]
            );
            assert!(
                neds[1].contains("scenarioManager: ScenarioManager;"),
                "{}",
                neds[1]
            );
            // 断B轮：链路 2（es1→sw2），es1 平面 B 端口 1 → ethg$o[1]。
            assert!(
                inis[2].contains("<disconnect src-module='esb1' src-gate='ethg$o[1]'/>"),
                "{}",
                inis[2]
            );
        });
    }

    /// 双平面 5 节点 seed：sw1(0)=平面A、sw2(3)=平面B；es1(1)/es2(2)/es3(4) 全双宿。
    /// 两条 RC：seq0 es1→es2 固定；seq1 由调用方指定 talker/listener（共享/平手两形态）。
    async fn seed_dual_plane_two_rc(pool: &sqlx::Pool<sqlx::Sqlite>, rc1: (&str, &str)) {
        for (mid, ty, ord) in [
            ("0", "switch", 0),
            ("1", "endSystem", 1),
            ("2", "endSystem", 2),
            ("3", "switch", 3),
            ("4", "endSystem", 4),
        ] {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                .bind(mid).bind(ty).bind(ord).execute(pool).await.unwrap();
        }
        for (seq, src, sp, dst, dp, plane) in [
            (0, "1", 0, "0", 0, "A"),
            (1, "0", 1, "2", 0, "A"),
            (2, "1", 1, "3", 0, "B"),
            (3, "3", 1, "2", 1, "B"),
            (4, "4", 0, "0", 2, "A"),
            (5, "4", 1, "3", 2, "B"),
        ] {
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, ?)")
                .bind(seq).bind(src).bind(dst).bind(sp).bind(dp)
                .bind(format!(r#"{{"plane":"{plane}"}}"#))
                .execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '0')")
            .execute(pool)
            .await
            .unwrap();
        for mid in ["0", "1", "2", "3", "4"] {
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', ?, '[]', '[]')")
                .bind(mid).execute(pool).await.unwrap();
        }
        for (seq, talker, listener) in [(0, "1", "2"), (1, rc1.0, rc1.1)] {
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us, redundant, paths) VALUES ('s1', ?, 'RC', 6, 500, 512, 2000, ?, ?, 400, 1, NULL)")
                .bind(seq).bind(talker).bind(listener).execute(pool).await.unwrap();
        }
    }

    /// Covers KTD8（U6②前半/⑦非拆分 case）：两条 RC（es1→es2、es3→es2）平面 A 共享
    /// sw1→es2 链路（覆盖数 2）→ 选中共享链路，上游是交换机（非拆分）→ src-module=sw1、
    /// 库端口 1→ethg$o[1]；无未覆盖流。
    #[test]
    fn fault_break_point_picks_max_coverage_shared_link() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_two_rc(&pool, ("4", "2")).await;
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(None)),
                Ok(outcome(None)),
                Ok(outcome(None)),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            let rounds = r.rounds.expect("rounds");
            assert!(
                runner.inis()[1].contains("<disconnect src-module='sw1' src-gate='ethg$o[1]'/>"),
                "{}",
                runner.inis()[1]
            );
            assert!(
                rounds[1].untested_streams.is_empty(),
                "共享链路两流全覆盖：{rounds:?}"
            );
            assert!(
                rounds[1].annotations.iter().any(|s| s.contains("链路 1")),
                "{rounds:?}"
            );
        });
    }

    /// Covers KTD8（U6②后半）：两条 RC 不共向（es1→es2、es3→es1）→ 覆盖数全平手，
    /// 取最小 (link_seq, 上游) 有向占用（链路 0 的 sw1→es1 向，属流 1）→ 确定性选择；
    /// 未被该有向断点覆盖的流 0 标「未测容错」。
    #[test]
    fn fault_break_point_tie_is_deterministic_and_marks_untested() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_two_rc(&pool, ("4", "1")).await;
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(None)),
                Ok(outcome(None)),
                Ok(outcome(None)),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            let rounds = r.rounds.expect("rounds");
            // 平手确定性：BTreeMap 升序首个 = (link 0, 上游 sw1(mid0))，sw1 库端口 0 → eth0。
            assert!(
                runner.inis()[1].contains("<disconnect src-module='sw1' src-gate='ethg$o[0]'/>"),
                "{}",
                runner.inis()[1]
            );
            assert_eq!(rounds[1].untested_streams.len(), 1, "{rounds:?}");
            assert!(
                rounds[1].untested_streams[0].contains("流 0")
                    && rounds[1].untested_streams[0].contains("未测容错"),
                "{rounds:?}"
            );
        });
    }

    /// Covers KTD7（U6③）：纯 RC 短流集——sim 时长=RC 窗（100×500us=50ms）≤ t_break 下限
    /// 200ms → 断后真实发送窗内应发 0 帧 <20，整体响亮报错提示调大 count，且一轮软仿都
    /// 不跑（不烧墙钟）。真不足时守卫仍响亮（分母改真实发送窗后语义保住）。
    #[test]
    fn fault_tail_guard_errors_loudly_without_running() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            sqlx::query("UPDATE topology_streams SET count=100 WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            let runner = ScriptedRunner::new(vec![]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "fault_window_too_short", "{r:?}");
            assert!(r.overall.contains("调大"), "{r:?}");
            assert!(
                r.message.as_deref().unwrap().contains("流 0"),
                "响亮指认流：{r:?}"
            );
            assert!(r.rounds.is_none(), "{r:?}");
            assert!(runner.inis().is_empty(), "尾量不足不得烧软仿墙钟");
        });
    }

    /// 尾量守卫分母=真实发送窗（sim 时长），非 RC 意图窗：短意图窗 RC（100×1000us=100ms）
    /// 加长 ST（10000×1000us=10s）→ sim=10s，t_break=200ms 后仍有 9800 帧——不得
    /// fault_window_too_short 假拒验，三轮照跑。
    #[test]
    fn fault_tail_guard_uses_real_send_window_not_intent_window() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            // RC 意图窗缩到 100ms（旧分母下断后 0 帧必拒）；ST 长流把 sim 拉到 10s。
            sqlx::query(
                "UPDATE topology_streams SET count=100, period_us=1000 WHERE session_id='s1'",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'ST', 7, 1000, 512, 10000, '1', '2', 800)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 1, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
                .execute(&pool).await.unwrap();
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(None)),
                Ok(outcome(None)),
                Ok(outcome(None)),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_ne!(
                r.status, "fault_window_too_short",
                "真实发送窗充足不得假拒验：{r:?}"
            );
            let rounds = r.rounds.as_ref().expect("三轮照跑");
            assert_eq!(
                rounds.iter().map(|x| x.round.as_str()).collect::<Vec<_>>(),
                vec!["healthy", "fault_a", "fault_b"]
            );
            assert_eq!(runner.inis().len(), 3, "三轮都提交");
        });
    }

    /// Covers KTD2（U6④）：断A断点（es1→sw1）既是时钟树边（GM=sw1 的树含全部平面 A/B 边
    /// 0/1/2）又撞 ST 平面 A 路由 → 两类响亮标注都在；断B断点（es1→sw2，链路 2）是树边但
    /// 不撞 ST 路由 → 只有时钟树标注。
    #[test]
    fn fault_annotations_mark_clock_tree_and_st_route_overlap() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            // 加 ST 流（平面 A：es1→es2）+ 其 GCL（有 ST 无 GCL 会 no_plan 早退）。
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'ST', 7, 500, 512, 2000, '1', '2', 400)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
                .execute(&pool).await.unwrap();
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(None)),
                Ok(outcome(None)),
                Ok(outcome(None)),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            let rounds = r.rounds.expect("rounds");
            let a = &rounds[1];
            assert!(a.annotations.iter().any(|s| s.contains("时钟树")), "{a:?}");
            assert!(
                a.annotations.iter().any(|s| s.contains("ST 流路由")),
                "{a:?}"
            );
            let b = &rounds[2];
            assert!(b.annotations.iter().any(|s| s.contains("时钟树")), "{b:?}");
            assert!(
                !b.annotations.iter().any(|s| s.contains("ST 流路由")),
                "断B（平面 B）不撞 ST 平面 A 路由：{b:?}"
            );
        });
    }

    /// Covers KTD3（U6⑤）：断A轮 load_failed（exit≠0）→ 断B轮仍执行；顶层 status/per_stream
    /// 保持健康轮结果；overall 串联含最差轮状态词。
    #[test]
    fn fault_round_failure_continues_and_overall_shows_worst() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(SimRunOutcome {
                    exit_code: Some(1),
                    output_tail: "boom".into(),
                    csv: None,
                    scavetool_failed: false,
                }),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "顶层保持健康轮：{r:?}");
            assert_eq!(r.per_stream.len(), 1, "顶层保持健康轮 per_stream：{r:?}");
            assert!(r.per_stream[0].pass);
            let rounds = r.rounds.as_ref().unwrap();
            assert_eq!(rounds[1].status, "load_failed", "{rounds:?}");
            assert!(
                rounds[1].annotations.iter().any(|s| s.contains("boom")),
                "错误详情进标注：{rounds:?}"
            );
            assert_eq!(rounds[2].status, "ok", "断B轮仍执行：{rounds:?}");
            assert_eq!(runner.inis().len(), 3, "三轮都提交");
            assert!(
                r.overall.contains("load_failed"),
                "最差轮可见：{}",
                r.overall
            );
        });
    }

    /// KTD3 反方向：健康轮 unreachable → 断A/断B 轮仍执行拿全量信息；健康轮 status 记录在
    /// rounds[0]（错误详情进标注），顶层归 unreachable 既有词表。
    #[test]
    fn healthy_round_failure_still_runs_fault_rounds() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Err(RemoteError::Unreachable("connection refused".into())),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "unreachable", "顶层=健康轮词表：{r:?}");
            assert_eq!(runner.inis().len(), 3, "健康轮失败不阻断故障轮");
            let rounds = r.rounds.as_ref().expect("rounds 应携带全轮");
            assert_eq!(rounds[0].status, "unreachable", "{rounds:?}");
            assert!(
                rounds[0]
                    .annotations
                    .iter()
                    .any(|s| s.contains("connection refused")),
                "错误详情进标注：{rounds:?}"
            );
            assert_eq!(rounds[1].status, "ok", "断A轮仍执行：{rounds:?}");
            assert_eq!(rounds[2].status, "ok", "断B轮仍执行：{rounds:?}");
        });
    }

    /// Covers plan U6⑧：断A轮 409（BUSY_MESSAGE）→ 该轮标 busy（环境冲突，非验证 FAIL），
    /// 余轮继续，顶层保持健康轮 ok。
    #[test]
    fn fault_round_busy_from_409_is_not_fail() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Err(RemoteError::Unreachable(
                    crate::inet_sim_http::BUSY_MESSAGE.to_string(),
                )),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let rounds = r.rounds.as_ref().unwrap();
            assert_eq!(rounds[1].status, "busy", "{rounds:?}");
            assert_ne!(rounds[1].status, "fail");
            assert_eq!(rounds[2].status, "ok", "余轮继续：{rounds:?}");
            assert!(r.overall.contains("busy"), "{}", r.overall);
        });
    }

    /// Covers U6⑥：无 RC 流 → 单轮现状回归——runner 只被调 1 次、rounds=None（口径选定：
    /// None 而非单元素），序列化里无 rounds 键（前端零感知）。
    #[test]
    fn no_rc_single_round_and_rounds_absent() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // 纯 ST。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            let runner = ScriptedRunner::new(vec![Ok(outcome(Some(&csv)))]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert!(r.rounds.is_none(), "{r:?}");
            assert_eq!(runner.inis().len(), 1, "无 RC 只跑一轮");
            let json = serde_json::to_string(&r).unwrap();
            assert!(!json.contains("rounds"), "{json}");
            // U7 形状契约（R15 收尾更新，U8）：无 rounds 老结果 additive 多 class/judged 恒有键；
            // deliveryRatio/note 在纯 ST 判定结果里缺席。gptpDiag 现为**顶层可选键**（R15）：
            // 该次运行 CSV 无时钟向量 → 缺席（不臆造）；有向量时恒填充（下个 case + 矩阵测试锁定）。
            assert!(json.contains("\"class\":\"ST\""), "{json}");
            assert!(json.contains("\"judged\":true"), "{json}");
            assert!(!json.contains("deliveryRatio"), "{json}");
            assert!(!json.contains("\"note\""), "{json}");
            assert!(!json.contains("gptpDiag"), "{json}");
        });
    }

    /// Covers R15 收尾（U8）：无 rounds 会话（纯 ST）CSV 带时钟向量 → 顶层 gptpDiag 恒填充
    /// （纯 ST/纯 BE 会话由此也有诊断行）；rounds 仍缺席。
    #[test]
    fn no_rounds_result_carries_top_level_gptp_diag() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed(&pool).await; // 纯 ST，GM=es1(mid1)。
            let mut csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
            csv.push_str(clock_csv_rows_gm_es1());
            let runner = ScriptedRunner::new(vec![Ok(outcome(Some(&csv)))]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert!(r.rounds.is_none(), "{r:?}");
            let d = r
                .gptp_diag
                .as_ref()
                .expect("R15：无 rounds 也应有顶层诊断行");
            assert_eq!(d.total_nodes, 2, "{d:?}");
            assert_eq!(d.converged_nodes, 1, "es2 1500ns > 缺省 1000ns：{d:?}");
            assert_eq!(d.worst_node, "es2", "{d:?}");
            let json = serde_json::to_string(&r).unwrap();
            assert!(json.contains("\"gptpDiag\""), "{json}");
            assert!(!json.contains("rounds"), "{json}");
        });
    }

    /// Covers U6⑧ + U7⑦：rounds serde 契约——camelCase（rounds/round/perStream/annotations/
    /// untestedStreams/gptpDiag 及 StreamVerdict 新字段 class/judged/deliveryRatio/note），
    /// 无 snake_case 泄漏。
    #[test]
    fn rounds_serde_camel_case() {
        let r = VerifyTasResult {
            caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
            status: "ok".into(),
            per_stream: vec![],
            overall: "x".into(),
            message: None,
            rounds: Some(vec![VerifyRound {
                round: "fault_a".into(),
                status: "busy".into(),
                per_stream: vec![StreamVerdict {
                    stream_seq: 0,
                    class: "BE".into(),
                    talker: "1".into(),
                    listener: "2".into(),
                    received: 2,
                    expected: 4,
                    jitter_max_ns: 1.0,
                    latency_max_ns: 2.0,
                    window_ns: 3.0,
                    pass: true,
                    judged: false,
                    delivery_ratio: Some(0.5),
                    note: Some("仅健康轮判（故障轮不判）".into()),
                    reason: None,
                }],
                annotations: vec!["a".into()],
                untested_streams: vec!["流 1：未测容错".into()],
                gptp_diag: Some(GptpDiag {
                    converged_nodes: 3,
                    total_nodes: 4,
                    threshold_summary: "1000ns".into(),
                    worst_node: "sw2".into(),
                    worst_offset_ns: 1500.0,
                }),
            }]),
            // R15 收尾：顶层诊断键与轮内同名（camelCase gptpDiag），serde 断言共用下方检查。
            gptp_diag: Some(GptpDiag {
                converged_nodes: 3,
                total_nodes: 4,
                threshold_summary: "1000ns".into(),
                worst_node: "sw2".into(),
                worst_offset_ns: 1500.0,
            }),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"rounds\""), "{json}");
        assert!(json.contains("\"round\":\"fault_a\""), "{json}");
        assert!(json.contains("\"untestedStreams\""), "{json}");
        assert!(json.contains("\"perStream\""), "{json}");
        assert!(json.contains("\"annotations\""), "{json}");
        assert!(json.contains("\"class\":\"BE\""), "{json}");
        assert!(json.contains("\"judged\":false"), "{json}");
        assert!(json.contains("\"deliveryRatio\":0.5"), "{json}");
        assert!(json.contains("\"note\""), "{json}");
        assert!(json.contains("\"gptpDiag\""), "{json}");
        assert!(json.contains("\"convergedNodes\":3"), "{json}");
        assert!(json.contains("\"totalNodes\":4"), "{json}");
        assert!(json.contains("\"thresholdSummary\":\"1000ns\""), "{json}");
        assert!(json.contains("\"worstNode\":\"sw2\""), "{json}");
        assert!(json.contains("\"worstOffsetNs\":1500.0"), "{json}");
        assert!(!json.contains("untested_streams"), "{json}");
        assert!(!json.contains("per_stream"), "{json}");
        assert!(!json.contains("delivery_ratio"), "{json}");
        assert!(!json.contains("gptp_diag"), "{json}");
    }

    /// Covers KTD7（U6⑨）：t_break 手算——RC 窗 1s → 0.4×=400ms（>200ms 下限，取 0.4×窗）；
    /// RC 窗 100ms → 0.4×=40ms < 200ms → 取 200ms 收敛下限。
    #[test]
    fn t_break_forty_percent_with_200ms_floor() {
        assert_eq!(fault_t_break_ns(1_000_000_000), 400_000_000);
        assert_eq!(fault_t_break_ns(100_000_000), 200_000_000);
    }

    // ---------- U7：分级判据（R11–R13）+ gPTP 收敛诊断行（R15）----------

    /// R15：filter 拼了 clock timeChanged 子句（与 timesync TIMECHANGED_FILTER 同形），
    /// 流量向量子句不动。
    #[test]
    fn flow_verify_filter_includes_clock_clause() {
        assert!(FLOW_VERIFY_FILTER.contains("name=~\"packetLifeTime:vector\""));
        assert!(FLOW_VERIFY_FILTER.contains("name=~\"packetJitter:vector\""));
        assert!(
            FLOW_VERIFY_FILTER
                .contains("OR (module=~\"**.clock\" AND name=~\"timeChanged:vector\")"),
            "{FLOW_VERIFY_FILTER}"
        );
    }

    /// Covers AE1（U7①，R12）：RC 健康轮收 > 实发（2002 > 2001）→ FAIL「重复帧未消除」
    /// （消除点失效不得染绿）。
    #[test]
    fn rc_duplicate_frames_fail_loudly() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2002);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert_eq!(r.per_stream[0].class, "RC");
            assert!(r.per_stream[0].judged);
            assert!(
                r.per_stream[0]
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("重复帧未消除"),
                "{r:?}"
            );
        });
    }

    /// Covers AE1（U7①②，R12）：RC 缺口在在途容差内（2000/2001，容差 2）→ PASS；
    /// 缺口超容差（1000/2001）→ FAIL 丢包。容差逐轮自计（实测 100us 时延 / 500us 周期
    /// → ⌈0.2⌉+1=2）。
    #[test]
    fn rc_gap_within_tolerance_passes_beyond_fails() {
        tauri::async_runtime::block_on(async {
            // 容差内：收 2000、实发 2001。
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2000);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "缺口 1 ≤ 容差 2 应通过：{r:?}");
            assert!(r.per_stream[0].pass);

            // 超容差：收 1000。
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 1000);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert!(
                r.per_stream[0].reason.as_deref().unwrap().contains("丢包"),
                "{r:?}"
            );
        });
    }

    /// 混合三类 seed：dual-plane RC（seq0）+ ST（seq1，带 gate7 GCL）+ BE（seq2），
    /// 全部 es1→es2、count=2000×500us（sim=1s、每流实发 2001）。
    async fn seed_mixed_three_classes(pool: &sqlx::Pool<sqlx::Sqlite>) {
        seed_dual_plane_rc(pool, RC_PATHS).await;
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'ST', 7, 500, 512, 2000, '1', '2', 400)")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 2, 'BE', 0, 500, 512, 2000, '1', '2')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 1, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
            .execute(pool).await.unwrap();
    }

    /// 三个 sink（es2.app[0]=RC、app[1]=ST、app[2]=BE）全健康的 CSV；ST sink 抖动可注坏样本。
    fn mixed_csv(st_jitter_breach: bool) -> String {
        let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
        let st = healthy_csv("TsnAgentFlowTasNetwork.es2.app[1].sink", 2001);
        // healthy_csv 自带表头，拼接时剥掉后两份的表头行。
        csv.push_str(st.strip_prefix(&header()).unwrap());
        if st_jitter_breach {
            // 追加一行非首位 2us 抖动样本（首样本被 skip_first 跳过，须放后位才生效）。
            csv.push_str(
                "TsnAgentFlowTasNetwork.es2.app[1].sink,packetJitter:vector,0 0,0.0000001 0.000002\n",
            );
        }
        let be = healthy_csv("TsnAgentFlowTasNetwork.es2.app[2].sink", 2001);
        csv.push_str(be.strip_prefix(&header()).unwrap());
        csv
    }

    /// Covers AE4（U7③，R11–R13）：混合三类三轮全绿——三类各按各判据（健康轮全判、
    /// 故障轮只判 RC），overall PASS；BE 行带送达率 1.0；故障轮 ST/BE 报告态。
    #[test]
    fn mixed_three_classes_judged_per_class_all_green() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_mixed_three_classes(&pool).await;
            let csv = mixed_csv(false);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(
                r.per_stream
                    .iter()
                    .map(|v| v.class.as_str())
                    .collect::<Vec<_>>(),
                vec!["RC", "ST", "BE"]
            );
            assert!(r.per_stream.iter().all(|v| v.pass && v.judged), "{r:?}");
            assert_eq!(r.per_stream[2].delivery_ratio, Some(1.0), "{r:?}");
            let rounds = r.rounds.as_ref().expect("有 RC 应有 rounds");
            assert_eq!(rounds.len(), 3);
            assert!(rounds.iter().all(|x| x.status == "ok"), "{rounds:?}");
            // 故障轮：只有 RC 下判，ST/BE 报告态（仅健康轮判）。
            let fa = &rounds[1];
            let st = fa.per_stream.iter().find(|v| v.class == "ST").unwrap();
            assert!(!st.judged && st.pass, "{fa:?}");
            assert!(st.note.as_deref().unwrap().contains("仅健康轮判"), "{fa:?}");
            let be = fa.per_stream.iter().find(|v| v.class == "BE").unwrap();
            assert!(!be.judged, "{fa:?}");
            let rc = fa.per_stream.iter().find(|v| v.class == "RC").unwrap();
            assert!(rc.judged && rc.pass, "{fa:?}");
            assert!(r.overall.contains("另 2 个仅报告"), "{}", r.overall);
        });
    }

    /// Covers AE4（U7③，R11/KTD4）：ST 抖动超标 → ST FAIL 不被 RC/BE 绿灯掩盖（整体 fail），
    /// reason 带「重新规划」提示（plan 过期文案替代指纹）。
    #[test]
    fn mixed_st_jitter_breach_not_masked_by_rc_be() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_mixed_three_classes(&pool).await;
            let csv = mixed_csv(true);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "fail", "ST FAIL 不得被 RC/BE 绿灯掩盖：{r:?}");
            let st = r.per_stream.iter().find(|v| v.class == "ST").unwrap();
            assert!(!st.pass, "{r:?}");
            let reason = st.reason.as_deref().unwrap();
            assert!(reason.contains("抖动"), "{reason}");
            assert!(reason.contains("若近期改过 ST 流请重新规划"), "{reason}");
            // RC/BE 各自达标，不因 ST 连坐。
            assert!(
                r.per_stream
                    .iter()
                    .filter(|v| v.class != "ST")
                    .all(|v| v.pass),
                "{r:?}"
            );
        });
    }

    /// Covers U7④（R13）：BE 零收包 → FAIL；收一半（2/4）→ PASS 且送达率 0.5——
    /// 丢包/抖动不判（夹具带 2us 抖动样本仍过），只报告。
    #[test]
    fn be_zero_receive_fails_half_receive_passes_with_ratio() {
        tauri::async_runtime::block_on(async {
            // 零收包：CSV 只有表头（该流无向量行）→ FAIL。
            let pool = fresh_pool().await;
            seed(&pool).await;
            sqlx::query("DELETE FROM topology_streams WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM flow_plans WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'BE', 0, 500, 512, 3, '1', '2')")
                .execute(&pool).await.unwrap();
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&header())),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert_eq!(r.per_stream[0].class, "BE");
            assert!(
                r.per_stream[0]
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("无收包"),
                "{r:?}"
            );
            assert_eq!(r.per_stream[0].delivery_ratio, Some(0.0), "{r:?}");

            // 收一半：sim=1500us → 实发 4，收 2 → 送达率 0.5；带 2us 抖动样本仍 PASS（不判）。
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0,0.0001 0.00012\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0,0.0000001 0.000002\n",
                header()
            );
            let r = verify_tas_inner(
                &pool,
                "s1",
                &MockRunner {
                    outcome: outcome(Some(&csv)),
                },
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "BE 只判有收包（丢包/抖动不判）：{r:?}");
            assert!(r.per_stream[0].pass);
            assert_eq!(r.per_stream[0].received, 2);
            assert_eq!(r.per_stream[0].expected, 4);
            assert_eq!(r.per_stream[0].delivery_ratio, Some(0.5), "{r:?}");
        });
    }

    /// Covers U7⑤（R11 分级面）：故障轮 ST 时延/抖动劣化 → 该轮 ST 不判（judged=false、
    /// note「仅健康轮判」、不拉低轮判）；RC 照判；轮摘要带「仅报告」尾注。
    #[test]
    fn fault_round_st_degradation_reported_not_judged() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'ST', 7, 500, 512, 2000, '1', '2', 400)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 1, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
                .execute(&pool).await.unwrap();
            let mut healthy = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let st = healthy_csv("TsnAgentFlowTasNetwork.es2.app[1].sink", 2001);
            healthy.push_str(st.strip_prefix(&header()).unwrap());
            // 断A轮：RC 健康、ST 劣化（时延 1ms 超窗 + 丢到只剩 3 帧——若被判必挂）。
            let mut fault = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            fault.push_str(
                "TsnAgentFlowTasNetwork.es2.app[1].sink,packetLifeTime:vector,0 0 0,0.001 0.001 0.001\nTsnAgentFlowTasNetwork.es2.app[1].sink,packetJitter:vector,0 0 0,0.0000001 0.000005 0.000004\n",
            );
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&healthy))),
                Ok(outcome(Some(&fault))),
                Ok(outcome(Some(&healthy))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let rounds = r.rounds.as_ref().unwrap();
            let fa = &rounds[1];
            assert_eq!(fa.status, "ok", "ST 劣化不拉低故障轮判决：{fa:?}");
            let st = fa.per_stream.iter().find(|v| v.class == "ST").unwrap();
            assert!(!st.judged && st.pass && st.reason.is_none(), "{fa:?}");
            assert!(st.note.as_deref().unwrap().contains("仅健康轮判"), "{fa:?}");
            let rc = fa.per_stream.iter().find(|v| v.class == "RC").unwrap();
            assert!(rc.judged && rc.pass, "{fa:?}");
            assert!(r.overall.contains("仅报告"), "{}", r.overall);
        });
    }

    /// Covers U7⑧（KTD8）：故障轮未被断链覆盖的 RC 流——per-stream 行 judged=false +
    /// note「未测容错」（round 级 untested_streams 由 U6 既有测试锁定）；被覆盖流照判。
    #[test]
    fn fault_round_untested_rc_reported_not_judged() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 两条 RC 不共向（es1→es2、es3→es1）：断A断点只覆盖流 1，流 0 未测。
            seed_dual_plane_two_rc(&pool, ("4", "1")).await;
            let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let second = healthy_csv("TsnAgentFlowTasNetwork.es1.app[1].sink", 2001);
            csv.push_str(second.strip_prefix(&header()).unwrap());
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            let rounds = r.rounds.as_ref().unwrap();
            let fa = &rounds[1];
            let s0 = fa.per_stream.iter().find(|v| v.stream_seq == 0).unwrap();
            assert!(!s0.judged && s0.pass, "{fa:?}");
            assert!(s0.note.as_deref().unwrap().contains("未测容错"), "{fa:?}");
            let s1 = fa.per_stream.iter().find(|v| v.stream_seq == 1).unwrap();
            assert!(s1.judged, "被覆盖流照判：{fa:?}");
            // 健康轮两条 RC 都判。
            assert!(rounds[0].per_stream.iter().all(|v| v.judged), "{rounds:?}");
        });
    }

    /// Covers U7⑨（R16 沿袭）：空/短向量该流该轮 FAIL 不染绿——健康轮（CSV 有表头无该流
    /// 向量行）与故障轮（健康轮正常、断A轮向量缺失）各一 case，故障轮被覆盖 RC 同判。
    #[test]
    fn empty_vectors_fail_stream_in_healthy_and_fault_rounds() {
        tauri::async_runtime::block_on(async {
            // 健康轮空向量 → 该流 FAIL、整体 fail。
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let bare = header();
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&bare))),
                Ok(outcome(Some(&bare))),
                Ok(outcome(Some(&bare))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "fail", "{r:?}");
            assert!(!r.per_stream[0].pass);
            assert!(
                r.per_stream[0]
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("无收包"),
                "{r:?}"
            );

            // 故障轮空向量 → 该轮被覆盖 RC FAIL（健康轮不受影响）。
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let full = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&full))),
                Ok(outcome(Some(&bare))),
                Ok(outcome(Some(&full))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "顶层=健康轮：{r:?}");
            let rounds = r.rounds.as_ref().unwrap();
            assert_eq!(rounds[1].status, "fail", "{rounds:?}");
            let rc = &rounds[1].per_stream[0];
            assert!(rc.judged && !rc.pass, "故障轮空向量不染绿：{rounds:?}");
        });
    }

    /// 线性 seed（GM=es1）版 clock 序列：sw1=500ns 收敛、es2=1500ns 未收敛（缺省阈值 1000ns）。
    /// R15 顶层诊断行（无 rounds 会话）夹具用。
    fn clock_csv_rows_gm_es1() -> &'static str {
        "TsnAgentFlowTasNetwork.es1.clock,timeChanged:vector,0 1,0 1\n\
         TsnAgentFlowTasNetwork.sw1.clock,timeChanged:vector,0 0.6 1,0 0.6000005 1.0000005\n\
         TsnAgentFlowTasNetwork.es2.clock,timeChanged:vector,0 0.6 1,0 0.6000015 1.0000015\n"
    }

    /// GM sw1 + 三个 clock 序列（sw2=500ns、es2=1500ns、esb1=100ns，稳态窗为 sim 后半程）。
    /// esb1 是双宿拆分内嵌桥——不在 node_ned_names，单列计数、阈值走缺省（最小惊讶口径）。
    fn clock_csv_rows() -> &'static str {
        "TsnAgentFlowTasNetwork.sw1.clock,timeChanged:vector,0 1,0 1\n\
         TsnAgentFlowTasNetwork.sw2.clock,timeChanged:vector,0 0.6 1,0 0.6000005 1.0000005\n\
         TsnAgentFlowTasNetwork.es2.clock,timeChanged:vector,0 0.6 1,0 0.6000015 1.0000015\n\
         TsnAgentFlowTasNetwork.esb1.clock,timeChanged:vector,0 0.6 1,0 0.6000001 1.0000001\n"
    }

    /// Covers U7⑥（R15）：夹具 CSV 带 clock 向量 → 每轮 gPTP 诊断行——缺省阈值 1000ns 回退、
    /// converged N/M 与最差节点正确、拆分桥（esb1）单列计数；故障轮照实报告（诊断行仍在）；
    /// 诊断不参与 verdict（流全绿不受 es2 时钟未收敛影响）。
    #[test]
    fn gptp_diag_default_threshold_counts_and_worst_node() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            csv.push_str(clock_csv_rows());
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
                Ok(outcome(Some(&csv))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            assert_eq!(r.status, "ok", "诊断只报告不判：{r:?}");
            let rounds = r.rounds.as_ref().unwrap();
            let d = rounds[0].gptp_diag.as_ref().expect("健康轮应有诊断行");
            assert_eq!(d.total_nodes, 3, "{d:?}");
            assert_eq!(d.converged_nodes, 2, "es2 1500ns > 缺省 1000ns：{d:?}");
            assert_eq!(d.threshold_summary, "1000ns", "{d:?}");
            assert_eq!(d.worst_node, "es2", "{d:?}");
            assert!((d.worst_offset_ns - 1500.0).abs() < 0.5, "{d:?}");
            // 故障轮照实报告（KTD2：断链下游劣化属预期，诊断行不缺席）。
            assert!(rounds[1].gptp_diag.is_some(), "{rounds:?}");
            assert!(rounds[2].gptp_diag.is_some(), "{rounds:?}");
            // R15 收尾（U8）：有 rounds 时顶层诊断与健康轮同值。
            assert_eq!(r.gptp_diag, rounds[0].gptp_diag, "{r:?}");
        });
    }

    /// Covers U7⑥（R15）：timesync_nodes.offset_threshold 配置后逐节点阈值生效——es2 阈值
    /// 放宽到 2000ns → 3/3 收敛，阈值概览显示逐节点区间；无 clock 向量的轮 → 诊断行缺席。
    #[test]
    fn gptp_diag_per_node_threshold_applies_and_absent_without_clock_rows() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_rc(&pool, RC_PATHS).await;
            sqlx::query(
                "UPDATE timesync_nodes SET offset_threshold=2000 WHERE session_id='s1' AND mid='2'",
            )
            .execute(&pool)
            .await
            .unwrap();
            let mut with_clock = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            with_clock.push_str(clock_csv_rows());
            let without_clock = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
            let runner = ScriptedRunner::new(vec![
                Ok(outcome(Some(&with_clock))),
                Ok(outcome(Some(&without_clock))),
                Ok(outcome(Some(&with_clock))),
            ]);
            let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
            let rounds = r.rounds.as_ref().unwrap();
            let d = rounds[0].gptp_diag.as_ref().unwrap();
            assert_eq!(
                d.converged_nodes, 3,
                "es2 1500ns ≤ 逐节点阈值 2000ns：{d:?}"
            );
            assert_eq!(d.total_nodes, 3, "{d:?}");
            assert_eq!(d.threshold_summary, "1000–2000ns", "{d:?}");
            assert!(
                rounds[1].gptp_diag.is_none(),
                "无 clock 向量不臆造诊断行：{rounds:?}"
            );
        });
    }

    // ---------- U8：六种流组合矩阵夹具（plan→verify 管线，HTD 矩阵表逐行冻结回归基线）----------
    //
    // 每行一个锚点测试，锁四面：①进 Z3 的流集合（CapturingPlan 捕获 synth ini）②plan 产物
    // （GCL 落库 或 no_gating 清表 + 求解器不被调）③verify 轮次数与轮名 ④各类判据生效面
    // （judged 标志按类分叉）。近似覆盖的既有测试不重复造——矩阵行测试是显式命名的锚点，
    // 细粒度形态（互补关窗参数/FRER trees 字面/断点选择）仍由上方各单元测试锁定。
    mod matrix {
        use super::*;

        /// 捕获 synth ini 的 plan 客户端（断言「进 Z3 的流集合」）。ini 为 None = 求解器
        /// 未被调用（无 ST 行的 no_gating 早退面）。
        struct CapturingPlan {
            sca: String,
            ini: std::sync::Mutex<Option<String>>,
        }
        impl crate::inet_sim_http::InetSimPlanClient for CapturingPlan {
            fn plan_gcl(
                &self,
                _base: &str,
                bundle: &crate::inet_remote::InetBundle,
            ) -> Result<crate::inet_sim_http::HttpPlanResult, String> {
                *self.ini.lock().unwrap() = Some(bundle.omnetpp_ini.clone());
                Ok(crate::inet_sim_http::HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(self.sca.clone()),
                    solver: Some("Z3".into()),
                })
            }
        }

        /// 回 sw1 eth[1] gate7（ST 门）.sca 的捕获客户端——线性与双平面 seed 里 sw1 都是
        /// ST 平面 A 路径上的交换机（ned sw1 → mid 0）。
        fn plan_gate7() -> CapturingPlan {
            CapturingPlan {
                sca: "par N.sw1.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] durations \"[300us, 700us]\"\n".into(),
                ini: std::sync::Mutex::new(None),
            }
        }

        async fn flow_plans_count(pool: &sqlx::Pool<sqlx::Sqlite>) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM flow_plans WHERE session_id='s1'")
                .fetch_one(pool)
                .await
                .unwrap()
        }

        async fn clear_flow_plans(pool: &sqlx::Pool<sqlx::Sqlite>) {
            sqlx::query("DELETE FROM flow_plans WHERE session_id='s1'")
                .execute(pool)
                .await
                .unwrap();
        }

        /// 矩阵行 1「纯 ST」：进 Z3=ST；plan 产物=GCL 落库；verify=单轮健康（无 rounds）；
        /// 判据=ST 三项（judged）。pin ini 无 FRER / 无互补关窗（纯 ST 位级基线面）。
        #[test]
        fn matrix_pure_st_single_round_st_criteria() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed(&pool).await;
                clear_flow_plans(&pool).await; // 真管线：GCL 由 plan 落库。
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "ok", "{pr:?}");
                let synth = plan.ini.lock().unwrap().clone().expect("ST 应进 Z3");
                assert_eq!(synth.matches("UdpSourceApp").count(), 1, "{synth}");
                assert!(synth.contains("pcp: 7"), "{synth}");
                assert_eq!(flow_plans_count(&pool).await, 1, "plan 产物=GCL 落库");

                let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 3);
                csv.push_str(clock_csv_rows_gm_es1());
                let runner = ScriptedRunner::new(vec![Ok(outcome(Some(&csv)))]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                assert!(r.rounds.is_none(), "纯 ST：单轮健康、无 rounds：{r:?}");
                assert_eq!(runner.inis().len(), 1, "只提交一轮");
                assert_eq!(r.per_stream.len(), 1);
                assert_eq!(r.per_stream[0].class, "ST");
                assert!(r.per_stream[0].judged && r.per_stream[0].pass, "{r:?}");
                assert!(
                    r.gptp_diag.is_some(),
                    "R15：纯 ST 会话也有顶层诊断行：{r:?}"
                );
                let pin = &runner.inis()[0];
                assert!(pin.contains("transmissionGate[7]"), "{pin}");
                assert!(!pin.contains("hasStreamRedundancy"), "纯 ST 无 FRER：{pin}");
                assert!(
                    !pin.contains("transmissionGate[0]"),
                    "纯 ST 不生成互补关窗（KTD5 基线）：{pin}"
                );
            });
        }

        /// 矩阵行 2「ST+BE」：进 Z3=仅 ST（BE 的 app/端口不进 synth）；plan 产物=GCL；
        /// verify=单轮健康；判据=ST 三项 + BE 连通（都 judged，BE 带送达率）。pin ini
        /// 带互补关窗（BE 保护面）。
        #[test]
        fn matrix_st_be_single_round_complement_and_be_connectivity() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed(&pool).await;
                sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 1, 'BE', 0, 500, 512, 3, '1', '2')")
                    .execute(&pool).await.unwrap();
                clear_flow_plans(&pool).await;
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "ok", "{pr:?}");
                let synth = plan.ini.lock().unwrap().clone().expect("ST 应进 Z3");
                assert_eq!(
                    synth.matches("UdpSourceApp").count(),
                    1,
                    "只有 ST 进 Z3：{synth}"
                );
                assert!(!synth.contains("pcp: 0"), "BE 不得进 synth bundle：{synth}");
                assert_eq!(flow_plans_count(&pool).await, 1);

                // ST=app[0]、BE=app[1]（specs 按 stream_seq 序）。
                let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 3);
                let be = healthy_csv("TsnAgentFlowTasNetwork.es2.app[1].sink", 3);
                csv.push_str(be.strip_prefix(&header()).unwrap());
                let runner = ScriptedRunner::new(vec![Ok(outcome(Some(&csv)))]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                assert!(r.rounds.is_none(), "无 RC：单轮：{r:?}");
                assert!(r.per_stream.iter().all(|v| v.judged && v.pass), "{r:?}");
                let be = r.per_stream.iter().find(|v| v.class == "BE").unwrap();
                assert_eq!(be.delivery_ratio, Some(0.75), "收 3/实发 4：{r:?}");
                let pin = &runner.inis()[0];
                assert!(
                    pin.contains("transmissionGate[0].durations"),
                    "混流生成互补关窗（R8）：{pin}"
                );
                assert!(!pin.contains("hasStreamRedundancy"), "无 RC 无 FRER：{pin}");
            });
        }

        /// 矩阵行 3「ST+RC」：进 Z3=仅 ST；plan 产物=GCL；verify=健康+断A+断B 三轮；
        /// 判据=ST 三项（仅健康轮判）+ RC 两态（健康与故障轮都判）。
        #[test]
        fn matrix_st_rc_three_rounds_st_healthy_only() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed_dual_plane_rc(&pool, RC_PATHS).await; // RC seq0。
                sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us) VALUES ('s1', 1, 'ST', 7, 500, 512, 2000, '1', '2', 400)")
                    .execute(&pool).await.unwrap();
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "ok", "{pr:?}");
                let synth = plan.ini.lock().unwrap().clone().expect("ST 应进 Z3");
                assert_eq!(
                    synth.matches("UdpSourceApp").count(),
                    1,
                    "只有 ST 进 Z3：{synth}"
                );
                assert!(!synth.contains("pcp: 6"), "RC 不得进 synth bundle：{synth}");
                assert_eq!(flow_plans_count(&pool).await, 1);

                // RC=app[0]、ST=app[1]。
                let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
                let st = healthy_csv("TsnAgentFlowTasNetwork.es2.app[1].sink", 2001);
                csv.push_str(st.strip_prefix(&header()).unwrap());
                let runner = ScriptedRunner::new(vec![
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                ]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                let rounds = r.rounds.as_ref().expect("有 RC 应三轮");
                assert_eq!(
                    rounds.iter().map(|x| x.round.as_str()).collect::<Vec<_>>(),
                    vec!["healthy", "fault_a", "fault_b"]
                );
                // 健康轮：ST+RC 都判；故障轮：只判 RC，ST 报告态。
                assert!(rounds[0].per_stream.iter().all(|v| v.judged), "{rounds:?}");
                for fault in &rounds[1..] {
                    let st = fault.per_stream.iter().find(|v| v.class == "ST").unwrap();
                    assert!(!st.judged, "{fault:?}");
                    assert!(
                        st.note.as_deref().unwrap().contains("仅健康轮判"),
                        "{fault:?}"
                    );
                    let rc = fault.per_stream.iter().find(|v| v.class == "RC").unwrap();
                    assert!(rc.judged && rc.pass, "{fault:?}");
                }
                let pin = &runner.inis()[0];
                assert!(pin.contains("hasStreamRedundancy"), "RC FRER 装配：{pin}");
                assert!(pin.contains("transmissionGate[7]"), "ST 门 pin：{pin}");
            });
        }

        /// 矩阵行 4「三类全有」：进 Z3=仅 ST；plan 产物=GCL；verify=三轮；判据=全部
        /// （ST 三项 + RC 两态 + BE 连通；故障轮 ST/BE 报告态）。
        #[test]
        fn matrix_all_three_classes_full_criteria() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed_mixed_three_classes(&pool).await; // RC0+ST1+BE2 + 手工 GCL。
                clear_flow_plans(&pool).await; // 真管线：GCL 由 plan 落库。
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "ok", "{pr:?}");
                let synth = plan.ini.lock().unwrap().clone().expect("ST 应进 Z3");
                assert_eq!(
                    synth.matches("UdpSourceApp").count(),
                    1,
                    "只有 ST 进 Z3：{synth}"
                );
                assert!(!synth.contains("pcp: 6"), "{synth}");
                assert!(!synth.contains("pcp: 0"), "{synth}");
                assert_eq!(flow_plans_count(&pool).await, 1);

                let csv = mixed_csv(false);
                let runner = ScriptedRunner::new(vec![
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                ]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                let rounds = r.rounds.as_ref().expect("有 RC 应三轮");
                assert_eq!(
                    rounds.iter().map(|x| x.round.as_str()).collect::<Vec<_>>(),
                    vec!["healthy", "fault_a", "fault_b"]
                );
                // 健康轮：三类都判、全绿（BE 带送达率）。
                assert!(
                    rounds[0].per_stream.iter().all(|v| v.judged && v.pass),
                    "{rounds:?}"
                );
                let be = rounds[0]
                    .per_stream
                    .iter()
                    .find(|v| v.class == "BE")
                    .unwrap();
                assert_eq!(be.delivery_ratio, Some(1.0), "{rounds:?}");
                // 故障轮：只判 RC；ST/BE 报告态。
                for fault in &rounds[1..] {
                    for v in &fault.per_stream {
                        assert_eq!(v.judged, v.class == "RC", "{fault:?}");
                    }
                }
                assert!(r.overall.contains("另 2 个仅报告"), "{}", r.overall);
            });
        }

        /// 矩阵行 5「纯 RC」：进 Z3=无（求解器不被调）；plan 产物=no_gating + 清表；
        /// verify=三轮照跑；判据=RC 两态；pin ini **门全开**（无任何 transmissionGate 行、
        /// 无互补关窗）但带 FRER。R15：顶层诊断行=健康轮同值。
        #[test]
        fn matrix_pure_rc_three_rounds_all_gates_open() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed_dual_plane_rc(&pool, RC_PATHS).await;
                // 存量旧 GCL（上一轮 ST 规划残留）——no_gating 应清掉，verify 不得 pin 它。
                sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
                    .execute(&pool).await.unwrap();
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "no_gating", "{pr:?}");
                assert!(plan.ini.lock().unwrap().is_none(), "无 ST 不进 Z3");
                assert_eq!(flow_plans_count(&pool).await, 0, "no_gating 清表");

                let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 2001);
                csv.push_str(clock_csv_rows());
                let runner = ScriptedRunner::new(vec![
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                    Ok(outcome(Some(&csv))),
                ]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                let rounds = r.rounds.as_ref().expect("纯 RC 三轮照跑");
                assert_eq!(
                    rounds.iter().map(|x| x.round.as_str()).collect::<Vec<_>>(),
                    vec!["healthy", "fault_a", "fault_b"]
                );
                // RC 两态：每轮都判（单 RC 流覆盖两平面断点）。
                for round in rounds {
                    assert!(
                        round
                            .per_stream
                            .iter()
                            .all(|v| v.class == "RC" && v.judged && v.pass),
                        "{round:?}"
                    );
                }
                for pin in &runner.inis() {
                    assert!(
                        !pin.contains("transmissionGate["),
                        "纯 RC 门全开：无 pin 门、无互补关窗：{pin}"
                    );
                    assert!(pin.contains("hasStreamRedundancy"), "{pin}");
                }
                // R15：顶层诊断=健康轮同值。
                assert!(r.gptp_diag.is_some(), "{r:?}");
                assert_eq!(r.gptp_diag, rounds[0].gptp_diag, "{r:?}");
            });
        }

        /// 矩阵行 6「纯 BE」：进 Z3=无；plan 产物=no_gating + 清表；verify=单轮；判据=BE
        /// 连通（送达率随行）。R15/R10：顶层诊断行在（pcp0 争用下时钟收敛可见的机器面）。
        #[test]
        fn matrix_pure_be_single_round_connectivity_and_diag_line() {
            tauri::async_runtime::block_on(async {
                let pool = fresh_pool().await;
                seed(&pool).await; // 带存量 ST GCL——no_gating 应清掉。
                sqlx::query("DELETE FROM topology_streams WHERE session_id='s1'")
                    .execute(&pool)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'BE', 0, 500, 512, 3, '1', '2')")
                    .execute(&pool).await.unwrap();
                let plan = plan_gate7();
                let pr = crate::flow_plan_command::plan_tas_inner(&pool, "s1", &plan, "http://x")
                    .await
                    .unwrap();
                assert_eq!(pr.status, "no_gating", "{pr:?}");
                assert!(plan.ini.lock().unwrap().is_none(), "无 ST 不进 Z3");
                assert_eq!(flow_plans_count(&pool).await, 0, "no_gating 清掉存量 GCL");

                let mut csv = healthy_csv("TsnAgentFlowTasNetwork.es2.app[0].sink", 3);
                csv.push_str(clock_csv_rows_gm_es1());
                let runner = ScriptedRunner::new(vec![Ok(outcome(Some(&csv)))]);
                let r = verify_tas_inner(&pool, "s1", &runner).await.unwrap();
                assert_eq!(r.status, "ok", "{r:?}");
                assert!(r.rounds.is_none(), "纯 BE：单轮：{r:?}");
                assert_eq!(runner.inis().len(), 1);
                assert_eq!(r.per_stream[0].class, "BE");
                assert!(
                    r.per_stream[0].judged && r.per_stream[0].pass,
                    "BE 连通判：{r:?}"
                );
                assert_eq!(
                    r.per_stream[0].delivery_ratio,
                    Some(0.75),
                    "收 3/实发 4：{r:?}"
                );
                assert!(
                    r.gptp_diag.is_some(),
                    "R15/R10：纯 BE 会话顶层诊断行在：{r:?}"
                );
                let pin = &runner.inis()[0];
                assert!(!pin.contains("transmissionGate["), "门全开：{pin}");
                assert!(!pin.contains("hasStreamRedundancy"), "{pin}");
            });
        }
    }
}
