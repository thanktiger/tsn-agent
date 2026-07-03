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

use serde::Serialize;
use sqlx::Row;

use crate::inet_remote::{RemoteError, RemoteRunner, SimRunOutcome};
use crate::inet_sim_bundle::{
    FlowStreamSpec, FlowTasSchedule, GclEntry, SimOverrides, build_flow_tas_sim_bundle,
    flow_expected_sent, flow_sim_time_s, plan_flow_traffic,
};
use crate::inet_sim_command::{load_timing, load_topology};

pub const CALIBER_FLOW_TAS_VERIFIED: &str = "flow_tas_verified";
/// 抖动上限 1us（R15）。
const JITTER_LIMIT_NS: f64 = 1_000.0;
/// per-packet 时延 + 抖动向量 filter（U1 spike 钉死向量名）。
const FLOW_VERIFY_FILTER: &str = "name=~\"packetLifeTime:vector\" OR name=~\"packetJitter:vector\"";

/// 单流实测判决。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamVerdict {
    pub stream_seq: i64,
    pub talker: String,
    pub listener: String,
    pub received: usize,
    pub expected: i64,
    pub jitter_max_ns: f64,
    pub latency_max_ns: f64,
    pub window_ns: f64,
    pub pass: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 验证结果（前端/agent 消费）。KTD7 诚实边界：caliber 恒 flow_tas_verified（仿真实测·非 T10）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTasResult {
    pub caliber: String,
    /// ok | no_plan | no_streams | pcp_mismatch | no_gm | route_error | bundle_error | unreachable | load_failed | empty | fail
    pub status: String,
    pub per_stream: Vec<StreamVerdict>,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl VerifyTasResult {
    fn simple(status: &str, overall: &str, message: Option<String>) -> Self {
        Self {
            caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
            status: status.to_string(),
            per_stream: vec![],
            overall: overall.to_string(),
            message,
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

/// 逐流分型：按 sink app module 后缀匹配 per-stream 时延/抖动向量，判 收=发 / jitter<1us /
/// 时延≤窗口。空/短 → 该流 FAIL（R16）。
fn classify(
    rows: &[VecRow],
    specs: &[FlowStreamSpec],
    placements: &[crate::inet_sim_bundle::FlowPlacement],
    node_ned: &std::collections::BTreeMap<String, String>,
    sim_time_s: f64,
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
            let expected_sent = flow_expected_sent(sim_time_s, s.period_us);
            let period_ns = (s.period_us.max(1) as f64) * 1_000.0;
            let in_flight_tol = (latency_max_ns / period_ns).ceil() as i64 + 1;

            let mut reasons = Vec::new();
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
            let pass = reasons.is_empty();
            StreamVerdict {
                stream_seq: s.stream_seq,
                talker: s.talker.clone(),
                listener: s.listener.clone(),
                received,
                expected: expected_sent,
                jitter_max_ns,
                latency_max_ns,
                window_ns,
                pass,
                reason: if pass {
                    None
                } else {
                    Some(reasons.join("；"))
                },
            }
        })
        .collect()
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
    let has_st = db_streams.iter().any(|s| s.class == "ST");
    let gcl = load_gcl(pool, session_id).await?;
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
    for s in &db_streams {
        let (frer_trees, pin_links) = if s.class == "RC" {
            match crate::flow_route::derive_redundant_routes(&s.talker, &s.listener, &nodes, &links)
            {
                Ok((a, b)) => (Some(vec![a.node_path, b.node_path]), None),
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
                Ok(r) if has_rc => (Some(vec![r.node_path]), None),
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

    let sim_bundle = match build_flow_tas_sim_bundle(
        &nodes,
        &links,
        &gm_mid,
        &timing,
        &SimOverrides {
            has_rc,
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
            return Ok(VerifyTasResult::simple(
                "bundle_error",
                "验证工程生成失败。",
                Some(msg),
            ));
        }
    };

    let outcome: SimRunOutcome =
        match runner.run_sim_fetch_csv(&sim_bundle.bundle, FLOW_VERIFY_FILTER) {
            Ok(o) => o,
            Err(RemoteError::Unreachable(m)) => {
                return Ok(VerifyTasResult::simple(
                    "unreachable",
                    "验证暂时无法运行（软仿服务不可达），工程保持原状。",
                    Some(m),
                ));
            }
        };
    if outcome.exit_code != Some(0) {
        return Ok(VerifyTasResult::simple(
            "load_failed",
            "INET 没跑起来（pin 工程装配失败）。",
            Some(outcome.output_tail),
        ));
    }
    let Some(csv) = outcome.csv else {
        // 空=FAIL，绝不渲染绿（R16）。
        return Ok(VerifyTasResult::simple(
            "empty",
            "结果为空：未取到 per-packet 向量（检查 recording/模块路径）。",
            Some("空结果不渲染成通过。".to_string()),
        ));
    };

    let (_classes, placements, _node_apps) = plan_flow_traffic(&specs);
    let rows = parse_vec_csv(&csv);
    // 与 bundle 用同一公式（SimOverrides::default 未覆盖 sim_time）反推实发数。
    let sim_time_s = flow_sim_time_s(&specs);
    let per_stream = classify(
        &rows,
        &specs,
        &placements,
        &sim_bundle.node_ned_names,
        sim_time_s,
    );

    let passed = per_stream.iter().filter(|v| v.pass).count();
    let all_pass = passed == per_stream.len() && !per_stream.is_empty();
    Ok(VerifyTasResult {
        caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
        status: if all_pass { "ok" } else { "fail" }.to_string(),
        overall: format!("{passed} 个达标 / {} 个未达标", per_stream.len() - passed),
        per_stream,
        message: None,
    })
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
    /// 一条 RC 流 es1→es2，paths 凭证由调用方传（模拟录入时预存）。
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
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us, redundant, paths) VALUES ('s1', 0, 'RC', 6, 500, 512, 3, '1', '2', 400, 1, ?)")
            .bind(paths).execute(pool).await.unwrap();
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
            let csv = format!(
                "{}TsnAgentFlowTasNetwork.es2.app[0].sink,packetLifeTime:vector,0 0 0,0.0001 0.00012 0.00011\nTsnAgentFlowTasNetwork.es2.app[0].sink,packetJitter:vector,0 0 0,0.0000002 0.0000003 0.0000001\n",
                header()
            );
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
}
