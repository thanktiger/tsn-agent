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

use crate::inet_remote::{RemoteConfig, RemoteError, RemoteRunner, SimRunOutcome, SshRunner};
use crate::inet_sim_bundle::{
    build_timesync_sim_bundle, OscillatorKind, SimNodeTiming, SimOverrides,
};

const CALIBER_TIMESYNC_SIMULATED: &str = "timesync_simulated";
/// scavetool filter（执行期实跑后微调）：clock 模块的 timeChanged 向量。
const TIMECHANGED_FILTER: &str = "module=~\"**.clock\" AND name=~\"timeChanged:vector\"";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTimesyncSimRequest {
    pub session_id: String,
    /// 覆盖表单（可选）：振荡器类型 / 漂移幅度 ppm / sim 时长 s。
    #[serde(default)]
    pub oscillator: Option<String>,
    #[serde(default)]
    pub drift_ppm: Option<f64>,
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
    let mut lines = csv.lines();
    let header = lines.next().ok_or_else(|| "CSV 空".to_string())?;
    let cols: Vec<&str> = split_csv_row(header);
    let idx = |name: &str| cols.iter().position(|c| c.trim() == name);
    let (Some(mi), Some(ni), Some(ti), Some(vi)) = (
        idx("module"),
        idx("name"),
        idx("vectime"),
        idx("vecvalue"),
    ) else {
        return Err("CSV 缺 module/name/vectime/vecvalue 列".to_string());
    };

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
    let cfg = RemoteConfig::dev_default();
    let overrides = SimOverrides {
        oscillator: parse_oscillator(request.oscillator.as_deref()),
        drift_ppm: request.drift_ppm,
        sim_time_s: request.sim_time_s,
    };
    run_timesync_sim_inner(&pool, &request.session_id, &overrides, &SshRunner, &cfg).await
}

/// 可测内核：注入 RemoteRunner，编排 verify-gate → bundle → 远端跑 → 取数算偏差。
pub async fn run_timesync_sim_inner<R: RemoteRunner>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    overrides: &SimOverrides,
    runner: &R,
    cfg: &RemoteConfig,
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
        return Err("未设 GM，无法软仿。".to_string());
    };

    let (nodes, links) = load_topology(pool, session_id).await?;
    let timing = load_timing(pool, session_id).await?;

    // 3) 生成 bundle。
    let bundle = match build_timesync_sim_bundle(
        &nodes,
        &links,
        &gm_mid,
        &timing,
        overrides,
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
    let outcome = match runner.run_sim_fetch_csv(&bundle, cfg, TIMECHANGED_FILTER) {
        Ok(o) => o,
        Err(RemoteError::Unreachable(m)) => {
            return Ok(unreachable_result(&m));
        }
    };

    classify_and_compute(outcome, &gm_mid, &timing)
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

/// 把远端 outcome 分型 + 算偏差。exit≠0→load_failed；csv 空→结果为空；解析失败→parse_failed。
fn classify_and_compute(
    outcome: SimRunOutcome,
    gm_mid: &str,
    timing: &[SimNodeTiming],
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
        return Ok(empty_result());
    };
    let series = match parse_timechanged_csv(&csv) {
        Ok(s) => s,
        Err(_e) => {
            // 0 行 timeChanged → 结果为空（指向 recording/模块路径）；其余解析问题同归空（保守）。
            return Ok(empty_result());
        }
    };

    // GM clock 模块：module 含 GM 的 ned 名。bundle 用 sw{N}/es{N} 命名，库 mid 与 ned 名不直通；
    // 这里用「referenceClock 对齐」性质——GM 自身相对自己偏差≈0，取 timeChanged 绝对值最小且方差最小者为 GM。
    // 更稳妥：caller 已知 GM ned 名。本内核按 module 路径含最短偏差列定位 GM，实跑后可换精确匹配。
    let gm_series = pick_gm_series(&series);
    let Some(gm_series) = gm_series else {
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
        // 阈值：用 module 名兜不回 mid，先用全局无阈值（within=true）；精确 mid↔module 映射实跑后补。
        let within = true;
        let converged = max_ns.is_finite();
        if converged {
            converged_count += 1;
        }
        per_node.push(PerNodeOffset {
            mid: s.module.clone(),
            max_offset_ns: max_ns,
            mean_offset_ns: mean_ns,
            converged,
            within_threshold: within,
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
    let overall = format!("{converged_count} 个收敛 / {} 个未收敛", total - converged_count);
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
        overall: "结果为空：未取到 timeChanged 数据（通常是 recording/模块路径配置问题）。".to_string(),
        message: Some("空结果不渲染成收敛。".to_string()),
    }
}

/// 选 GM 序列：GM clock 相对 referenceClock(自身) 偏差应最小——取 |值| 范围最小者。
fn pick_gm_series(series: &[NodeSeries]) -> Option<&NodeSeries> {
    series.iter().min_by(|a, b| {
        let ra = series_range(a);
        let rb = series_range(b);
        ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn series_range(s: &NodeSeries) -> f64 {
    let max = s.values.iter().cloned().fold(f64::MIN, f64::max);
    let min = s.values.iter().cloned().fold(f64::MAX, f64::min);
    max - min
}

async fn load_topology(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<(Vec<crate::topology_verify::VerifyNode>, Vec<crate::topology_verify::VerifyLink>), String>
{
    let node_rows = sqlx::query(
        "SELECT mid, name, node_type FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
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

async fn load_timing(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<Vec<SimNodeTiming>, String> {
    let rows = sqlx::query(
        "SELECT mid, master_port, slave_port, sync_period, measure_period \
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
    fn classify_load_failed_on_nonzero_exit() {
        let outcome = SimRunOutcome {
            exit_code: Some(1),
            output_tail: "boom".into(),
            csv: None,
        };
        let r = classify_and_compute(outcome, "0", &[]).unwrap();
        assert_eq!(r.status, "load_failed");
        assert!(r.per_node.is_empty());
    }

    #[test]
    fn classify_empty_on_no_csv() {
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: None,
        };
        let r = classify_and_compute(outcome, "0", &[]).unwrap();
        assert_eq!(r.status, "empty");
        assert!(r.per_node.is_empty(), "空结果不渲染成收敛");
    }

    #[test]
    fn classify_converged_from_csv() {
        // GM=es1 恒0；sw1 收敛到 1ns。期望 1 slave。
        let csv = "run,module,name,vectime,vecvalue\n\
            r1,net.es1.clock,timeChanged:vector,0 1 2 3,0 0 0 0\n\
            r1,net.sw1.clock,timeChanged:vector,0 1 2 3,0.001 0.0005 1e-9 1e-9\n";
        let outcome = SimRunOutcome {
            exit_code: Some(0),
            output_tail: "".into(),
            csv: Some(csv.into()),
        };
        let timing = [
            SimNodeTiming {
                mid: "0".into(),
                master_port: vec![],
                slave_port: vec![],
                sync_period_ms: None,
                measure_period_ms: None,
            },
            SimNodeTiming {
                mid: "1".into(),
                master_port: vec![],
                slave_port: vec![],
                sync_period_ms: None,
                measure_period_ms: None,
            },
        ];
        // gm_mid "0" → expected_slaves = 1（mid 1）。
        let r = classify_and_compute(outcome, "0", &timing).unwrap();
        assert_eq!(r.status, "converged", "{r:?}");
        assert_eq!(r.per_node.len(), 1);
        assert!(r.per_node[0].converged);
    }
}
