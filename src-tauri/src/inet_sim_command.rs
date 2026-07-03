//! U3（时钟同步软仿命令）：新 Tauri 命令 `run_timesync_sim`。
//! 触发时重跑 `verify_time_sync`（防陈旧树）→ 读拓扑 + timesync_nodes → U1 生成 bundle →
//! `inet_remote` 跑 + scavetool 抽 timeChanged → 对齐 GM 算稳态偏差 → 结构化结果 + caliber。
//!
//! 错误分型（复用 + 扩）：unreachable / load_failed（exit≠0）/ 结果为空（0 行 timeChanged）/
//! 解析失败。**空结果绝不渲染成收敛**（R10）。
//!
//! 执行注记（plan U1/U3）：scavetool filter 的确切 module/name 待远端 showcase 实跑确认；
//! 本模块 filter 用文档默认（`module=~"**.clock" AND name=~"timeChanged:vector"`），CSV 解析按
//! opp_scavetool CSV-R 长表（含 vectime/vecvalue 列）写，实跑后按真实列名微调。

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::inet_remote::{RemoteError, RemoteRunner, SimRunOutcome};
use crate::inet_sim_bundle::{
    DEFAULT_CHANGE_INTERVAL_MS, DEFAULT_DRIFT_PPM, DEFAULT_DRIFT_RATE_CHANGE_PPM,
    DEFAULT_SIM_TIME_S, OscillatorKind, SimNodeTiming, SimOverrides, build_timesync_sim_bundle,
};

const CALIBER_TIMESYNC_SIMULATED: &str = "timesync_simulated";
/// scavetool filter（执行期实跑后微调）：clock 模块的 timeChanged 向量。
const TIMECHANGED_FILTER: &str = "module=~\"**.clock\" AND name=~\"timeChanged:vector\"";
/// 收敛默认阈值（纳秒）：稳态 max|offset| 在此内算收敛（参考线、非设计质量判定，R8）。
/// 逐节点 offset_threshold 的精确 mid↔module 映射 deferred（实跑确认 module 路径后接入）。
const CONVERGENCE_THRESHOLD_NS: f64 = 1000.0; // 1µs

// ---------- U5/U6：软仿覆盖参数默认值（单一事实源在后端，前端读用于摘要/预填）----------

/// 软仿覆盖参数的生效默认值（前端折叠摘要 + 展开预填读此源，不在前端另写常量）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimDefaults {
    /// 振荡器默认类型字符串（"Constant" / "Random"），与前端 SimOverrideForm.oscillator 对齐。
    pub oscillator: String,
    /// Constant 用作恒定 driftRate；Random 不用（边界固定）。
    pub drift_ppm: f64,
    /// Random 用：漂移率随机游走步长（ppm，晶振稳定度代理）。
    pub drift_rate_change_ppm: f64,
    /// Random 用：漂移率更新间隔（ms）。
    pub change_interval_ms: f64,
    pub sim_time_s: f64,
}

/// 软仿默认值取自 inet_sim_bundle 的固定常量，与软仿生成时的兜底同源（U6 KTD2）。
pub fn sim_defaults() -> SimDefaults {
    let oscillator = match OscillatorKind::default() {
        OscillatorKind::Constant => "Constant",
        OscillatorKind::Random => "Random",
    };
    SimDefaults {
        oscillator: oscillator.to_string(),
        drift_ppm: DEFAULT_DRIFT_PPM,
        drift_rate_change_ppm: DEFAULT_DRIFT_RATE_CHANGE_PPM,
        change_interval_ms: DEFAULT_CHANGE_INTERVAL_MS,
        sim_time_s: DEFAULT_SIM_TIME_S,
    }
}

/// 纯读命令：把软仿覆盖参数默认值暴露给前端（无副作用、不碰库、不触发重算）。
#[tauri::command]
pub fn get_sim_defaults() -> SimDefaults {
    sim_defaults()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTimesyncSimRequest {
    pub session_id: String,
    /// 覆盖表单（可选）：振荡器类型 / 漂移幅度 ppm（Constant）/ 随机游走步长 + 间隔（Random）/ sim 时长 s。
    #[serde(default)]
    pub oscillator: Option<String>,
    #[serde(default)]
    pub drift_ppm: Option<f64>,
    #[serde(default)]
    pub drift_rate_change_ppm: Option<f64>,
    #[serde(default)]
    pub change_interval_ms: Option<f64>,
    #[serde(default)]
    pub sim_time_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerNodeOffset {
    pub mid: String,
    /// 稳态 max|offset|（纳秒）。
    pub max_offset_ns: f64,
    /// 稳态 mean|offset|（纳秒）。
    pub mean_offset_ns: f64,
    pub converged: bool,
    /// 是否在该节点 offset_threshold 参考线内（无阈值则 true，仅作参考非质量判定）。
    pub within_threshold: bool,
    /// 该节点生效的收敛阈值（纳秒）——逐节点 offset_threshold，缺省回退全局兜底。前端图表带/表格按此显示。
    pub threshold_ns: f64,
    /// 完整 offset(t) 抖动轨迹（相对 GM，降采样封顶），供前端画收敛曲线。
    pub samples: Vec<OffsetSample>,
}

/// offset(t) 轨迹的单个采样点：仿真时间（ms）+ 相对 GM 偏差（ns，带符号）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OffsetSample {
    pub t_ms: f64,
    pub offset_ns: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimResult {
    pub caliber: String,
    /// converged | empty | load_failed | unreachable | parse_failed
    pub status: String,
    pub per_node: Vec<PerNodeOffset>,
    /// 顶部总判定文案（如「3 个收敛 / 1 个未收敛」）。
    pub overall: String,
    /// 错误/诊断文案（非 converged 时给用户）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 一个 clock 模块的 timeChanged 时间序列。
#[derive(Debug, Clone, PartialEq)]
pub struct NodeSeries {
    pub module: String,
    pub times: Vec<f64>,
    pub values: Vec<f64>,
}

// ---------- 纯函数：CSV 解析 + 偏差计算（可单测，不碰库/网络）----------

/// 解析 opp_scavetool CSV-R 长表的 timeChanged 向量行。
/// 期望列：`module`、`name`、`vectime`、`vecvalue`（vectime/vecvalue 是空格分隔的数值串）。
/// 解析不到任何向量行 → Err（caller 判「结果为空/解析失败」）。
pub fn parse_timechanged_csv(csv: &str) -> Result<Vec<NodeSeries>, String> {
    // 定位真正的 CSV-R 表头行：opp_env 会在 stdout 前置环境横幅（`Environment for ... is
    // ready.`、构建时还有 `INFO`/`building` 行），行数不固定，须扫描跳过而非假定第一行。
    let mut lines = csv.lines();
    let mut header_cols: Option<Vec<&str>> = None;
    for line in lines.by_ref() {
        let cols: Vec<&str> = split_csv_row(line);
        let has_all = ["module", "name", "vectime", "vecvalue"]
            .iter()
            .all(|want| cols.iter().any(|c| c.trim() == *want));
        if has_all {
            header_cols = Some(cols);
            break;
        }
    }
    let cols = header_cols.ok_or_else(|| "CSV 缺 module/name/vectime/vecvalue 列".to_string())?;
    let idx = |name: &str| cols.iter().position(|c| c.trim() == name).unwrap();
    let (mi, ni, ti, vi) = (idx("module"), idx("name"), idx("vectime"), idx("vecvalue"));

    let mut out = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let fields = split_csv_row(line);
        let max_needed = mi.max(ni).max(ti).max(vi);
        if fields.len() <= max_needed {
            continue;
        }
        if !fields[ni].contains("timeChanged") {
            continue;
        }
        let times = parse_num_array(fields[ti]);
        let values = parse_num_array(fields[vi]);
        if times.is_empty() || values.is_empty() || times.len() != values.len() {
            continue;
        }
        out.push(NodeSeries {
            module: fields[mi].trim().to_string(),
            times,
            values,
        });
    }
    if out.is_empty() {
        return Err("无 timeChanged 向量行".to_string());
    }
    Ok(out)
}

/// 拆一行 CSV（支持双引号包裹、引号内逗号）。简化版，够 opp_scavetool 输出用。
fn split_csv_row(line: &str) -> Vec<&str> {
    // opp_scavetool CSV 用逗号分隔；vectime/vecvalue 数值串内无逗号（空格分隔），故按逗号切即可。
    line.split(',').collect()
}

fn parse_num_array(s: &str) -> Vec<f64> {
    s.trim()
        .trim_matches('"')
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .filter(|v| v.is_finite()) // 丢弃 inf/nan，防污染 GM 对齐与收敛判定
        .collect()
}

/// 在 GM 序列上按线性插值取 t 时刻的值（times 升序）。超出范围则取端点值。
fn interp(times: &[f64], values: &[f64], t: f64) -> Option<f64> {
    if times.is_empty() {
        return None;
    }
    if t <= times[0] {
        return Some(values[0]);
    }
    if t >= times[times.len() - 1] {
        return Some(values[values.len() - 1]);
    }
    // 二分找区间。
    let mut lo = 0usize;
    let mut hi = times.len() - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if times[mid] <= t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (t0, t1) = (times[lo], times[hi]);
    let (v0, v1) = (values[lo], values[hi]);
    if (t1 - t0).abs() < f64::EPSILON {
        return Some(v0);
    }
    Some(v0 + (v1 - v0) * (t - t0) / (t1 - t0))
}

/// 单节点稳态偏差：相对 GM 序列、取 sim 后半程窗口、算 max/mean |offset|。
/// 返回 (max_ns, mean_ns)。无稳态样本 → None。
pub fn steady_state_offset(node: &NodeSeries, gm: &NodeSeries) -> Option<(f64, f64)> {
    let t_max = *node.times.last()?;
    let window_start = t_max / 2.0; // 后半程（plan U3：首发取 sim 后半程）。
    let mut abs_offsets: Vec<f64> = Vec::new();
    for (i, &t) in node.times.iter().enumerate() {
        if t < window_start {
            continue;
        }
        let Some(gm_v) = interp(&gm.times, &gm.values, t) else {
            continue;
        };
        // 偏差单位：INET timeChanged 是秒，转纳秒展示。
        let offset_ns = (node.values[i] - gm_v).abs() * 1e9;
        abs_offsets.push(offset_ns);
    }
    if abs_offsets.is_empty() {
        return None;
    }
    let max = abs_offsets.iter().cloned().fold(0.0_f64, f64::max);
    let mean = abs_offsets.iter().sum::<f64>() / abs_offsets.len() as f64;
    Some((max, mean))
}

/// 轨迹封顶点数：长仿真每节点动辄上千采样点，降采样防 payload 爆量（前端画图够用）。
const MAX_TRAJECTORY_SAMPLES: usize = 240;

/// 单节点完整 offset(t) 抖动轨迹（带符号，相对 GM）：每采样点 offset = node − GM(插值)。
/// 点数超 MAX_TRAJECTORY_SAMPLES 时按等步长降采样（始终含末点）。
pub fn offset_trajectory(node: &NodeSeries, gm: &NodeSeries) -> Vec<OffsetSample> {
    let n = node.times.len();
    if n == 0 {
        return Vec::new();
    }
    let stride = n.div_ceil(MAX_TRAJECTORY_SAMPLES).max(1);
    let mut out: Vec<OffsetSample> = Vec::new();
    let mut i = 0usize;
    while i < n {
        if let Some(gm_v) = interp(&gm.times, &gm.values, node.times[i]) {
            out.push(OffsetSample {
                t_ms: node.times[i] * 1e3,
                offset_ns: (node.values[i] - gm_v) * 1e9,
            });
        }
        i += stride;
    }
    // 始终保留末点（收敛末态），降采样可能漏掉。
    if let Some(gm_v) = interp(&gm.times, &gm.values, node.times[n - 1])
        && out.last().map(|s| s.t_ms) != Some(node.times[n - 1] * 1e3)
    {
        out.push(OffsetSample {
            t_ms: node.times[n - 1] * 1e3,
            offset_ns: (node.values[n - 1] - gm_v) * 1e9,
        });
    }
    out
}

// ---------- 命令编排 ----------

fn parse_oscillator(s: Option<&str>) -> OscillatorKind {
    match s {
        Some("Constant") | Some("constant") => OscillatorKind::Constant,
        _ => OscillatorKind::Random,
    }
}

#[tauri::command]
pub async fn run_timesync_sim(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: RunTimesyncSimRequest,
) -> Result<SimResult, String> {
    let pool = store.pool(&app).await?;
    let overrides = SimOverrides {
        oscillator: parse_oscillator(request.oscillator.as_deref()),
        drift_ppm: request.drift_ppm,
        drift_rate_change_ppm: request.drift_rate_change_ppm,
        change_interval_ms: request.change_interval_ms,
        sim_time_s: request.sim_time_s,
    };
    // 软仿走宿主机薄 HTTP 服务（单路径）。未配置地址 → 结构化提示，不弹 IPC 错。
    let Some(base_url) = crate::inet_sim_http_config::resolve_inet_sim_http_url(pool).await? else {
        return Ok(SimResult {
            caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
            status: "no_service".to_string(),
            per_node: vec![],
            overall: "未配置软仿 HTTP 服务地址，请在设置里填写。".to_string(),
            message: Some("InetSimHttpConfig.base_url 为空。".to_string()),
        });
    };
    let runner =
        crate::inet_sim_http::HttpRunner::new(crate::inet_sim_http::ReqwestInetSimClient, base_url);
    run_timesync_sim_inner(pool, &request.session_id, &overrides, &runner).await
}

/// 可测内核：注入 RemoteRunner，编排 verify-gate → bundle → 远端跑 → 取数算偏差。
pub async fn run_timesync_sim_inner<R: RemoteRunner>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    overrides: &SimOverrides,
    runner: &R,
) -> Result<SimResult, String> {
    // 1) 触发时重跑 verify_time_sync（防确认后改拓扑/GM 拿陈旧树跑）。
    let verify = crate::timesync_verify::verify_time_sync(pool, session_id)
        .await
        .map_err(|e| format!("时钟树校验失败：{e}"))?;
    if !verify.ok {
        return Ok(SimResult {
            caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
            status: "stale_tree".to_string(),
            per_node: vec![],
            overall: "时钟树已变更，请回时钟同步阶段重新确认后再软仿。".to_string(),
            message: Some("verify_time_sync 未通过，已拒绝软仿。".to_string()),
        });
    }

    // 2) 读 GM + 拓扑 + timesync_nodes。
    let gm_mid: Option<String> =
        sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读 GM 失败：{e}"))?
            .flatten();
    let Some(gm_mid) = gm_mid else {
        // 结构化返回（非 Err）：让前端走结果区文案、不弹 IPC 错误（reliability review）。
        return Ok(SimResult {
            caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
            status: "no_gm".to_string(),
            per_node: vec![],
            overall: "未设 GM，请先在时钟同步阶段设定 GM 并确认时钟树。".to_string(),
            message: Some("timesync_domain.gm_mid 为空。".to_string()),
        });
    };

    let (nodes, links) = load_topology(pool, session_id).await?;
    let timing = load_timing(pool, session_id).await?;

    // 3) 生成 bundle。
    let sim_bundle =
        match build_timesync_sim_bundle(&nodes, &links, &gm_mid, &timing, overrides, session_id, 0)
        {
            Ok(b) => b,
            Err(errs) => {
                let msg = errs
                    .iter()
                    .map(|e| e.message_zh.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                return Ok(SimResult {
                    caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
                    status: "bundle_error".to_string(),
                    per_node: vec![],
                    overall: "软仿工程生成失败。".to_string(),
                    message: Some(msg),
                });
            }
        };

    // 4) 远端跑 + 取数。
    let outcome = match runner.run_sim_fetch_csv(&sim_bundle.bundle, TIMECHANGED_FILTER) {
        Ok(o) => o,
        Err(RemoteError::Unreachable(m)) => {
            return Ok(unreachable_result(&m));
        }
    };

    // U7：构造 ned 名 → 阈值(ns) 映射——把逐节点 offset_threshold（按 mid keyed）经 bundle 的
    // mid→ned 映射桥接到 series（按 ned 名 keyed）。缺省节点不入表，classify 回退全局兜底。
    let thresholds: std::collections::BTreeMap<String, f64> = timing
        .iter()
        .filter_map(|t| {
            let ned = sim_bundle.node_ned_names.get(&t.mid)?;
            let threshold = t.offset_threshold_ns?;
            Some((ned.clone(), threshold as f64))
        })
        .collect();

    classify_and_compute(
        outcome,
        &sim_bundle.gm_ned_name,
        &gm_mid,
        &timing,
        &thresholds,
    )
}

/// 从 timeChanged series 的 module 路径提取 ned 名：`...Network.sw1.clock` → `sw1`（取 .clock 前一段）。
fn series_ned_name(module: &str) -> Option<&str> {
    let mut parts = module.rsplit('.');
    let last = parts.next()?;
    if last != "clock" {
        return None;
    }
    parts.next()
}

fn unreachable_result(msg: &str) -> SimResult {
    SimResult {
        caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
        status: "unreachable".to_string(),
        per_node: vec![],
        overall: "校验暂时无法运行，工程保持原状。".to_string(),
        message: Some(msg.to_string()),
    }
}

/// 把远端 outcome 分型 + 算偏差。exit≠0→load_failed；scavetool 失败→scavetool_failed；
/// csv 空→结果为空；CSV 解析失败→parse_failed；否则按 GM 对齐算稳态偏差。
fn classify_and_compute(
    outcome: SimRunOutcome,
    gm_ned: &str,
    gm_mid: &str,
    timing: &[SimNodeTiming],
    thresholds: &std::collections::BTreeMap<String, f64>,
) -> Result<SimResult, String> {
    if outcome.exit_code != Some(0) {
        return Ok(SimResult {
            caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
            status: "load_failed".to_string(),
            per_node: vec![],
            overall: "INET 没跑起来（配置/拓扑装配失败）。".to_string(),
            message: Some(outcome.output_tail),
        });
    }
    let Some(csv) = outcome.csv else {
        // 区分 scavetool 命令失败（多半是远端没装 opp_scavetool）与跑成功但 0 行。
        if outcome.scavetool_failed {
            return Ok(SimResult {
                caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
                status: "scavetool_failed".to_string(),
                per_node: vec![],
                overall: "取数失败：远端 opp_scavetool 执行失败（检查是否已安装、是否在 PATH）。"
                    .to_string(),
                message: Some("scavetool 命令非零退出，未取到 CSV。".to_string()),
            });
        }
        return Ok(empty_result());
    };
    let series = match parse_timechanged_csv(&csv) {
        Ok(s) => s,
        Err(e) => {
            // CSV 解析失败（列缺失/格式异常）单独分型，区别于 0 行的「结果为空」。
            return Ok(SimResult {
                caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
                status: "parse_failed".to_string(),
                per_node: vec![],
                overall: "结果解析失败：scavetool CSV 格式不符预期。".to_string(),
                message: Some(e),
            });
        }
    };

    // GM 序列：按 caller 给的 GM ned 名（bundle 生成时确定的 sw{N}/es{N}）精确匹配 module 路径，
    // 取代「值域最小=GM」启发式（启发式会把稀疏 slave 误当 GM，全部偏差失真仍渲染收敛）。
    let gm_marker = format!("{gm_ned}.clock");
    let Some(gm_series) = series.iter().find(|s| s.module.ends_with(&gm_marker)) else {
        // 取不到 GM 序列（filter/录制路径与预期不符）→ 结果为空，不臆造参考系。
        return Ok(empty_result());
    };

    // 期望 slave 数 = 非 GM 的 timing 节点数；行数不足判失败（R10）。
    let expected_slaves = timing.iter().filter(|t| t.mid != gm_mid).count();

    let mut per_node: Vec<PerNodeOffset> = Vec::new();
    let mut converged_count = 0usize;
    for s in &series {
        if std::ptr::eq(s, gm_series) {
            continue;
        }
        let Some((max_ns, mean_ns)) = steady_state_offset(s, gm_series) else {
            continue;
        };
        // 该节点生效阈值（ns，U7）：按 series 的 ned 名查 offset_threshold，缺省回退全局兜底。
        let threshold_ns = series_ned_name(&s.module)
            .and_then(|ned| thresholds.get(ned).copied())
            .unwrap_or(CONVERGENCE_THRESHOLD_NS);
        // 收敛判定：稳态 max|offset| 在该节点阈值内才算收敛（参考线，非设计质量判定）。
        let within = max_ns.is_finite() && max_ns <= threshold_ns;
        let converged = within;
        if converged {
            converged_count += 1;
        }
        per_node.push(PerNodeOffset {
            mid: s.module.clone(),
            max_offset_ns: max_ns,
            mean_offset_ns: mean_ns,
            converged,
            within_threshold: within,
            threshold_ns,
            samples: offset_trajectory(s, gm_series),
        });
    }

    // slave 行数 < 预期 → 判失败（不渲染全绿）。
    if per_node.len() < expected_slaves {
        let got = per_node.len();
        return Ok(SimResult {
            caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
            status: "empty".to_string(),
            per_node,
            overall: format!(
                "结果不完整：取到 {got} 个 slave 偏差，少于预期 {expected_slaves} 个（检查 recording/模块路径配置）。"
            ),
            message: Some("slave 行数少于预期，未判为收敛。".to_string()),
        });
    }

    let total = per_node.len();
    let overall = format!(
        "{converged_count} 个收敛 / {} 个未收敛",
        total - converged_count
    );
    Ok(SimResult {
        caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
        status: "converged".to_string(),
        per_node,
        overall,
        message: None,
    })
}

fn empty_result() -> SimResult {
    SimResult {
        caliber: CALIBER_TIMESYNC_SIMULATED.to_string(),
        status: "empty".to_string(),
        per_node: vec![],
        overall: "结果为空：未取到 timeChanged 数据（通常是 recording/模块路径配置问题）。"
            .to_string(),
        message: Some("空结果不渲染成收敛。".to_string()),
    }
}

pub(crate) async fn load_topology(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<
    (
        Vec<crate::topology_verify::VerifyNode>,
        Vec<crate::topology_verify::VerifyLink>,
    ),
    String,
> {
    let node_rows = sqlx::query(
        "SELECT mid, name, node_type, queue_count FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读节点失败：{e}"))?;
    let link_rows = sqlx::query(
        "SELECT link_seq, src_node, dst_node, src_port, dst_port, speed, styles_json FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读链路失败：{e}"))?;
    let nodes = node_rows
        .into_iter()
        .map(|r| crate::topology_verify::VerifyNode {
            mid: r.get("mid"),
            name: r.get("name"),
            node_type: r.get("node_type"),
            queue_count: r.get("queue_count"),
        })
        .collect();
    let links = link_rows
        .into_iter()
        .map(|r| crate::topology_verify::VerifyLink {
            link_seq: r.get("link_seq"),
            src_node: r.get("src_node"),
            dst_node: r.get("dst_node"),
            src_port: r.get("src_port"),
            dst_port: r.get("dst_port"),
            speed: r.get("speed"),
            styles_json: r.get("styles_json"),
        })
        .collect();
    Ok((nodes, links))
}

pub(crate) async fn load_timing(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<Vec<SimNodeTiming>, String> {
    let rows = sqlx::query(
        "SELECT mid, master_port, slave_port, sync_period, measure_period, offset_threshold \
         FROM timesync_nodes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 timesync_nodes 失败：{e}"))?;

    let mut timing = Vec::new();
    for r in &rows {
        timing.push(SimNodeTiming {
            mid: r.get("mid"),
            master_port: parse_i64_array(&r.get::<String, _>("master_port")),
            slave_port: parse_i64_array(&r.get::<String, _>("slave_port")),
            sync_period_ms: r.get("sync_period"),
            measure_period_ms: r.get("measure_period"),
            offset_threshold_ns: r.get("offset_threshold"),
        });
    }
    Ok(timing)
}

fn parse_i64_array(json: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(json).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    // ---------- serde 契约：命令外壳的请求/响应字段名（camelCase）↔ 前端 TS ----------

    #[test]
    fn run_timesync_sim_request_deserializes_camelcase() {
        // 前端 invoke("run_timesync_sim", { request: {...} }) 的内层形态。
        let req: RunTimesyncSimRequest = serde_json::from_str(
            r#"{"sessionId":"s1","oscillator":"Random","driftRateChangePpm":0.3,"changeIntervalMs":25,"simTimeS":2.5}"#,
        )
        .unwrap();
        assert_eq!(req.session_id, "s1");
        assert_eq!(req.oscillator.as_deref(), Some("Random"));
        assert_eq!(req.drift_rate_change_ppm, Some(0.3));
        assert_eq!(req.change_interval_ms, Some(25.0));
        assert_eq!(req.sim_time_s, Some(2.5));
        // 覆盖参数全省略仍合法（走后端默认）。
        let bare: RunTimesyncSimRequest = serde_json::from_str(r#"{"sessionId":"s2"}"#).unwrap();
        assert_eq!(bare.session_id, "s2");
        assert!(
            bare.oscillator.is_none()
                && bare.drift_ppm.is_none()
                && bare.drift_rate_change_ppm.is_none()
                && bare.change_interval_ms.is_none()
                && bare.sim_time_s.is_none()
        );
    }

    #[test]
    fn sim_defaults_match_constants_and_serialize_camelcase() {
        let d = sim_defaults();
        assert_eq!(d.oscillator, "Random"); // OscillatorKind::default()
        assert_eq!(d.drift_ppm, DEFAULT_DRIFT_PPM);
        assert_eq!(d.drift_rate_change_ppm, DEFAULT_DRIFT_RATE_CHANGE_PPM);
        assert_eq!(d.change_interval_ms, DEFAULT_CHANGE_INTERVAL_MS);
        assert_eq!(d.sim_time_s, DEFAULT_SIM_TIME_S);
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("oscillator").is_some());
        assert!(v.get("driftPpm").is_some(), "driftPpm camelCase");
        assert!(
            v.get("driftRateChangePpm").is_some(),
            "driftRateChangePpm camelCase"
        );
        assert!(
            v.get("changeIntervalMs").is_some(),
            "changeIntervalMs camelCase"
        );
        assert!(v.get("simTimeS").is_some(), "simTimeS camelCase");
        assert!(v.get("drift_ppm").is_none());
    }

    #[test]
    fn sim_result_serializes_camelcase_for_frontend() {
        let result = SimResult {
            caliber: "timesync_simulated".into(),
            status: "converged".into(),
            per_node: vec![PerNodeOffset {
                mid: "sw2".into(),
                max_offset_ns: 1.0,
                mean_offset_ns: 0.5,
                converged: true,
                within_threshold: true,
                threshold_ns: 1000.0,
                samples: vec![OffsetSample {
                    t_ms: 500.0,
                    offset_ns: 0.8,
                }],
            }],
            overall: "1 个收敛 / 0 个未收敛".into(),
            message: None,
        };
        let v: serde_json::Value = serde_json::to_value(&result).unwrap();
        // 顶层 + 逐节点字段名必须是前端读的 camelCase。
        assert!(v.get("caliber").is_some() && v.get("status").is_some());
        assert!(v.get("perNode").is_some(), "perNode camelCase");
        assert!(v.get("per_node").is_none(), "不应是 snake_case");
        let node = &v["perNode"][0];
        for key in [
            "mid",
            "maxOffsetNs",
            "meanOffsetNs",
            "converged",
            "withinThreshold",
            "thresholdNs",
            "samples",
        ] {
            assert!(node.get(key).is_some(), "缺 perNode.{key}: {node}");
        }
        // 轨迹采样点也走 camelCase。
        assert!(node["samples"][0].get("tMs").is_some(), "tMs camelCase");
        assert!(
            node["samples"][0].get("offsetNs").is_some(),
            "offsetNs camelCase"
        );
        // message=None → skip_serializing_if 省略该键。
        assert!(v.get("message").is_none(), "None message 应省略");
    }

    #[test]
    fn parse_csv_extracts_timechanged_series() {
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,TsnAgentTimesyncNetwork.es1.clock,timeChanged:vector,0 1 2,0.0 0.0 0.0\n\
            r1,TsnAgentTimesyncNetwork.sw1.clock,timeChanged:vector,0 1 2,0.0 0.001 0.002\n\
            r1,TsnAgentTimesyncNetwork.es1.app,packetSent:vector,0 1,5 6\n";
        let series = parse_timechanged_csv(csv).unwrap();
        assert_eq!(series.len(), 2, "只取 timeChanged 行");
        assert_eq!(series[0].times, vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn parse_csv_skips_opp_env_banner_and_reads_real_csvr_header() {
        // 真机：opp_env 在 stdout 前置环境横幅，且真 CSV-R 头含 type/attrname/attrvalue 列。
        let csv = "Environment for 'omnetpp-6.4.0' in directory '/x' is ready.\n\
            Environment for INET 4.6.0 in directory '/y' is ready.\n\
            run,type,module,name,attrname,attrvalue,vectime,vecvalue\n\
            G-0,runattr,,,configname,General,,\n\
            G-0,vector,TsnAgentTimesyncNetwork.es1.clock,timeChanged:vector,,,0 1 2,0.0 0.0 0.0\n\
            G-0,vector,TsnAgentTimesyncNetwork.sw1.clock,timeChanged:vector,,,0 1 2,0.0 0.001 0.002\n";
        let series = parse_timechanged_csv(csv).unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(series[1].values, vec![0.0, 0.001, 0.002]);
    }

    #[test]
    fn parse_csv_empty_timechanged_errs() {
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,x.app,packetSent:vector,0 1,5 6\n";
        assert!(parse_timechanged_csv(csv).is_err());
    }

    #[test]
    fn steady_state_takes_second_half_and_aligns_gm() {
        // GM 恒 0；node 前半瞬态大、后半稳定在 1ns(=1e-9s)。
        let gm = NodeSeries {
            module: "es1.clock".into(),
            times: vec![0.0, 1.0, 2.0, 3.0, 4.0],
            values: vec![0.0, 0.0, 0.0, 0.0, 0.0],
        };
        let node = NodeSeries {
            module: "sw1.clock".into(),
            times: vec![0.0, 1.0, 2.0, 3.0, 4.0],
            values: vec![1e-3, 5e-4, 1e-9, 1e-9, 1e-9], // 后半程(t>=2) 偏差 1e-9s=1ns
        };
        let (max_ns, mean_ns) = steady_state_offset(&node, &gm).unwrap();
        assert!((max_ns - 1.0).abs() < 1e-6, "max≈1ns, got {max_ns}");
        assert!((mean_ns - 1.0).abs() < 1e-6, "瞬态不计入稳态");
    }

    #[test]
    fn offset_trajectory_signed_full_and_downsampled() {
        let gm = NodeSeries {
            module: "es1.clock".into(),
            times: vec![0.0, 1.0, 2.0],
            values: vec![0.0, 0.0, 0.0],
        };
        // 短序列：全保留、带符号（node 落后 GM → 负）。
        let node = NodeSeries {
            module: "sw1.clock".into(),
            times: vec![0.0, 1.0, 2.0],
            values: vec![1e-9, -2e-9, 0.0],
        };
        let traj = offset_trajectory(&node, &gm);
        assert_eq!(traj.len(), 3);
        assert!((traj[0].t_ms - 0.0).abs() < 1e-9 && (traj[0].offset_ns - 1.0).abs() < 1e-6);
        assert!((traj[1].offset_ns + 2.0).abs() < 1e-6, "带符号: 负偏差");
        assert!((traj[2].t_ms - 2000.0).abs() < 1e-6, "t 转 ms");

        // 长序列：降采样封顶、且必含末点。
        let n = 1000usize;
        let times: Vec<f64> = (0..n).map(|i| i as f64 * 1e-3).collect();
        let big = NodeSeries {
            module: "sw1.clock".into(),
            times: times.clone(),
            values: vec![0.0; n],
        };
        let gm_big = NodeSeries {
            module: "es1.clock".into(),
            times: times.clone(),
            values: vec![0.0; n],
        };
        let traj = offset_trajectory(&big, &gm_big);
        assert!(
            traj.len() <= MAX_TRAJECTORY_SAMPLES + 1,
            "降采样封顶: {}",
            traj.len()
        );
        assert!(
            (traj.last().unwrap().t_ms - times[n - 1] * 1e3).abs() < 1e-6,
            "含末点"
        );
    }

    fn timing2() -> [SimNodeTiming; 2] {
        [
            SimNodeTiming {
                mid: "0".into(),
                master_port: vec![],
                slave_port: vec![],
                sync_period_ms: None,
                measure_period_ms: None,
                offset_threshold_ns: None,
            },
            SimNodeTiming {
                mid: "1".into(),
                master_port: vec![],
                slave_port: vec![],
                sync_period_ms: None,
                measure_period_ms: None,
                offset_threshold_ns: None,
            },
        ]
    }

    fn no_thresholds() -> std::collections::BTreeMap<String, f64> {
        std::collections::BTreeMap::new()
    }

    #[test]
    fn classify_load_failed_on_nonzero_exit() {
        let outcome = SimRunOutcome {
            exit_code: Some(1),
            output_tail: "boom".into(),
            csv: None,
            scavetool_failed: false,
        };
        let r = classify_and_compute(outcome, "es1", "0", &[], &no_thresholds()).unwrap();
        assert_eq!(r.status, "load_failed");
        assert!(r.per_node.is_empty());
    }

    #[test]
    fn classify_empty_vs_scavetool_failed() {
        // 跑成功但 0 行 → empty。
        let empty = classify_and_compute(
            SimRunOutcome {
                exit_code: Some(0),
                output_tail: "".into(),
                csv: None,
                scavetool_failed: false,
            },
            "es1",
            "0",
            &[],
            &no_thresholds(),
        )
        .unwrap();
        assert_eq!(empty.status, "empty");
        // scavetool 命令失败 → scavetool_failed（区别于结果为空）。
        let tool = classify_and_compute(
            SimRunOutcome {
                exit_code: Some(0),
                output_tail: "".into(),
                csv: None,
                scavetool_failed: true,
            },
            "es1",
            "0",
            &[],
            &no_thresholds(),
        )
        .unwrap();
        assert_eq!(tool.status, "scavetool_failed");
    }

    #[test]
    fn classify_parse_failed_on_bad_csv() {
        // exit 0、csv 有内容但缺列 → parse_failed（区别于 empty）。
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some("not,a,valid,header\n1,2,3,4\n".into()),
            scavetool_failed: false,
        };
        let r = classify_and_compute(outcome, "es1", "0", &[], &no_thresholds()).unwrap();
        assert_eq!(r.status, "parse_failed");
    }

    #[test]
    fn classify_converged_from_csv() {
        // GM=es1 恒0；sw1 收敛到 1ns。期望 1 slave。gm_ned=es1 精确匹配 module。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0.001 0.0005 1e-9 1e-9\n";
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv.into()),
            scavetool_failed: false,
        };
        let r = classify_and_compute(outcome, "es1", "0", &timing2(), &no_thresholds()).unwrap();
        assert_eq!(r.status, "converged", "{r:?}");
        assert_eq!(r.per_node.len(), 1);
        assert!(r.per_node[0].converged);
    }

    #[test]
    fn classify_marks_large_offset_not_converged() {
        // sw1 稳态偏差 1ms = 1e6 ns >> 1µs 阈值 → 未收敛（不渲染全绿）。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0.001 0.001 0.001 0.001\n";
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv.into()),
            scavetool_failed: false,
        };
        let r = classify_and_compute(outcome, "es1", "0", &timing2(), &no_thresholds()).unwrap();
        assert_eq!(r.status, "converged"); // status=有结果；逐节点判收敛
        assert_eq!(r.per_node.len(), 1);
        assert!(!r.per_node[0].converged, "1ms 偏差不应判收敛");
        assert!(r.overall.contains("未收敛"));
    }

    #[test]
    fn series_ned_name_extracts_node() {
        assert_eq!(
            series_ned_name("TsnAgentTimesyncNetwork.sw1.clock"),
            Some("sw1")
        );
        assert_eq!(series_ned_name("net.es3.clock"), Some("es3"));
        assert_eq!(series_ned_name("net.sw1.clock.oscillator"), None); // 非 .clock 结尾
    }

    #[test]
    fn classify_uses_per_node_offset_threshold_ns() {
        // sw1 稳态 max=400ns；节点阈值=500ns → within（证明用 500 不是全局 1000，也证明 <500 收敛）。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0.001 0.001 4e-7 4e-7\n";
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv.into()),
            scavetool_failed: false,
        };
        let th: std::collections::BTreeMap<String, f64> =
            [("sw1".to_string(), 500.0)].into_iter().collect();
        let r = classify_and_compute(outcome, "es1", "0", &timing2(), &th).unwrap();
        assert_eq!(r.per_node.len(), 1);
        assert!(r.per_node[0].converged, "400ns 在 500ns 阈值内应收敛");
        assert_eq!(r.per_node[0].threshold_ns, 500.0);

        // 同节点稳态 max=600ns > 500ns 阈值 → 不收敛（若仍用全局 1000 则会误判收敛）。
        let csv2 = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0.001 0.001 6e-7 6e-7\n";
        let outcome2 = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv2.into()),
            scavetool_failed: false,
        };
        let r2 = classify_and_compute(outcome2, "es1", "0", &timing2(), &th).unwrap();
        assert!(!r2.per_node[0].converged, "600ns 超 500ns 阈值不应收敛");
    }

    #[test]
    fn classify_wrong_gm_name_yields_empty() {
        // gm_ned 与 CSV 里任何 module 都不匹配 → 不臆造参考系，判 empty。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1,0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1,1e-9 1e-9\n";
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv.into()),
            scavetool_failed: false,
        };
        let r = classify_and_compute(outcome, "es99", "0", &timing2(), &no_thresholds()).unwrap();
        assert_eq!(r.status, "empty");
    }

    // ---------- 全链路集成：seed 拓扑 → 真 set_gm 写库 → run_timesync_sim_inner(mock runner) ----------

    use crate::topology_mutation_buffer::TopologyMutationBuffer;
    use crate::topology_sidecar::{SecretToken, build_test_router_with_pool};
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use std::sync::Mutex;
    use tower::ServiceExt;

    /// 注入式 RemoteRunner：返回 canned CSV，并捕获收到的 bundle ini（断言覆盖参数确实进了工程）。
    struct MockRunner {
        csv: String,
        captured_ini: Mutex<Option<String>>,
    }
    impl RemoteRunner for MockRunner {
        fn run_sim_fetch_csv(
            &self,
            bundle: &crate::inet_remote::InetBundle,
            _filter: &str,
        ) -> Result<SimRunOutcome, RemoteError> {
            *self.captured_ini.lock().unwrap() = Some(bundle.omnetpp_ini.clone());
            Ok(SimRunOutcome {
                exit_code: Some(0),
                output_tail: String::new(),
                csv: Some(self.csv.clone()),
                scavetool_failed: false,
            })
        }
    }

    async fn integ_pool() -> (
        sqlx::Pool<sqlx::Sqlite>,
        std::sync::Arc<TopologyMutationBuffer>,
    ) {
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
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
            .execute(&pool).await.unwrap();
        (pool, std::sync::Arc::new(TopologyMutationBuffer::default()))
    }

    async fn post_json(
        router: axum::Router,
        token: &SecretToken,
        uri: &str,
        body: serde_json::Value,
    ) -> serde_json::Value {
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(resp.into_body(), 65_536).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// 全链路（覆盖 wish 2+3）：线性 0—1—2 拓扑 → 真 set_gm 写时钟树落库 → 软仿命令
    /// 注入 MockRunner(canned timeChanged CSV) → 断言 SimResult 收敛 + 逐节点偏差，
    /// 且覆盖参数（振荡器/漂移/时长）确实进了生成的 omnetpp.ini。
    #[tokio::test]
    async fn soft_sim_full_chain_seed_setgm_mockrun() {
        let (pool, buf) = integ_pool().await;
        // 线性 0—1—2，全 switch；端口 0.p0—1.p0、1.p1—2.p0（与 timesync 路由 seed_linear 同形）。
        for (i, m) in ["0", "1", "2"].iter().enumerate() {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, ?)")
                .bind(m).bind(i as i64).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '0', '1', 0, 0, 1000, '{}')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 1, NULL, '1', '2', 1, 0, 1000, '{}')")
            .execute(&pool).await.unwrap();

        // 真 set_gm 路由写时钟树落库（GM=0），确保 verify_time_sync 不漂移。
        let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;
        let parsed = post_json(
            router,
            &token,
            "/db/timesync/set_gm",
            serde_json::json!({ "sessionId": "s1", "gmMid": "0" }),
        )
        .await;
        assert_eq!(parsed["ok"], true, "set_gm 应成功：{parsed}");

        // GM=0→ned 名 sw1；1→sw2；2→sw3。canned CSV：GM 恒 0，sw2/sw3 收敛到 1ns。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw2.clock,timeChanged:vector,0 1 2 3,0.001 0.0005 1e-9 1e-9\n\
            r1,net.sw3.clock,timeChanged:vector,0 1 2 3,0.001 0.0005 1e-9 1e-9\n"
            .to_string();
        let mock = MockRunner {
            csv,
            captured_ini: Mutex::new(None),
        };
        // 预定义覆盖参数：Constant 振荡器 / 50ppm / 2.5s。
        let overrides = SimOverrides {
            oscillator: OscillatorKind::Constant,
            drift_ppm: Some(50.0),
            drift_rate_change_ppm: None,
            change_interval_ms: None,
            sim_time_s: Some(2.5),
        };
        let result = run_timesync_sim_inner(&pool, "s1", &overrides, &mock)
            .await
            .unwrap();

        // 软仿结果：2 个 slave（sw2/sw3）全收敛。
        assert_eq!(result.status, "converged", "{result:?}");
        assert_eq!(result.caliber, "timesync_simulated");
        assert_eq!(result.per_node.len(), 2);
        assert!(result.per_node.iter().all(|n| n.converged));
        assert!(result.overall.contains("2 个收敛"));
        // U7 端到端：set_gm 写入的 offset_threshold(默认 200) 经 load_timing 读出、对到各节点 series，
        // 作为 threshold_ns 带回（证明 DB 读路径 + mid→ned 桥接通，非静默回退）。
        assert!(
            result.per_node.iter().all(|n| n.threshold_ns == 200.0),
            "per_node threshold_ns 应来自库内 offset_threshold(默认200): {:?}",
            result.per_node
        );

        // 预定义参数确实进了生成的 ini（端到端：覆盖表单 → bundle → 远端工程）。
        let ini = mock.captured_ini.lock().unwrap().clone().unwrap();
        assert!(ini.contains("ConstantDriftOscillator"), "{ini}");
        assert!(ini.contains("driftRate = 50ppm"));
        assert!(ini.contains("sim-time-limit = 2.5s"));
        assert!(ini.contains("simtime-resolution = fs"));
        assert!(ini.contains("**.referenceClock = \"sw1.clock\""));
    }

    /// stale-tree 闸：set_gm 后改拓扑（加链路使时钟树漂移）→ 软仿触发时 verify 重跑 fail → 拒绝。
    #[tokio::test]
    async fn soft_sim_rejects_stale_tree() {
        let (pool, buf) = integ_pool().await;
        for (i, m) in ["0", "1", "2"].iter().enumerate() {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, ?)")
                .bind(m).bind(i as i64).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '0', '1', 0, 0, 1000, '{}')")
            .execute(&pool).await.unwrap();
        let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;
        post_json(
            router,
            &token,
            "/db/timesync/set_gm",
            serde_json::json!({ "sessionId": "s1", "gmMid": "0" }),
        )
        .await;
        // 确认树后改拓扑：加一条新链路 + 节点，使 timesync_nodes 快照对不上重算。
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 1, NULL, '1', '2', 1, 0, 1000, '{}')")
            .execute(&pool).await.unwrap();

        let mock = MockRunner {
            csv: String::new(),
            captured_ini: Mutex::new(None),
        };
        let result = run_timesync_sim_inner(&pool, "s1", &SimOverrides::default(), &mock)
            .await
            .unwrap();
        assert_eq!(result.status, "stale_tree", "{result:?}");
        assert!(
            mock.captured_ini.lock().unwrap().is_none(),
            "陈旧树不应跑远端"
        );
    }
}
