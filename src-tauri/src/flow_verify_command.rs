//! `verify_tas`（U8）：pin 住规划出的 GCL 软仿，逐流实测 jitter/丢包/时延判通过；空=FAIL。
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
    /// ok | no_plan | no_streams | no_gm | bundle_error | unreachable | load_failed | empty | fail
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
    let gcl = load_gcl(pool, session_id).await?;
    if gcl.is_empty() {
        return Ok(VerifyTasResult::simple(
            "no_plan",
            "还没有规划出门控表，请先在流量规划里规划再验证。",
            None,
        ));
    }
    let db_streams = crate::flow_plan_command::load_streams(pool, session_id).await?;
    if db_streams.is_empty() {
        return Ok(VerifyTasResult::simple(
            "no_streams",
            "还没有录入任何流。",
            None,
        ));
    }
    let specs: Vec<FlowStreamSpec> = db_streams
        .iter()
        .map(|s| FlowStreamSpec {
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
        })
        .collect();

    let (nodes, links) = load_topology(pool, session_id).await?;
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
        &SimOverrides::default(),
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
        // pin GCL 一条（sw1=mid0, eth1, gate0）。
        sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 0, 1, 0, '[300000,700000]', 'Z3')")
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

    /// 未规划（flow_plans 空）→ no_plan。
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

            // plan：mock 服务回 sw1 gate 的 .sca（ned sw1 → mid 0）。
            let plan_client = MockPlan {
                sca: "par N.sw1.eth[1].macLayer.queue.transmissionGate[0] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] durations \"[300us, 700us]\"\n".into(),
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
