//! `plan_tas`（U7）：让 INET Z3 配置器真算 802.1Qbv 门控表（GCL），app 读回落 `flow_plans`。
//!
//! 流程（KTD1 可测内核 + 注入式 client）：读流集 → 逐流推导路径（U5，喂 pathFragments）→
//! 组 synth flow+TAS bundle（U6）→ `InetSimPlanClient::plan_gcl` 跑配置器 + dump `.sca`
//! （U1/U6 spike）→ 解析 GCL（ned→mid）→ **不可行/空则判 FAIL 不落空表（R10）** → 全量覆盖
//! 写 `flow_plans`。求解器出处（Z3 带保证 / Eager 无保证，R8）随结果 + 落库记录。
//!
//! 对账（R9）是**辅助信号、测试/验收期**行为：docx 期望门窗是夹具（U10），运行期库里没有，
//! 故 `plan_tas` 不内联对账；`flow_reconcile` 供 U10 用综合结果对比冻结期望。
//!
//! `flow_plans.stream_seq` 恒 0：GCL 是 per-(port,gate) 全网一份、非 per-stream，用 0 作
//! 「当前规划」标记 + 每次 plan 全量覆盖（列保留以满足 KTD2b 指定的 PK / 将来 per-stream 规划）。

use serde::Serialize;
use sqlx::Row;
use std::collections::BTreeMap;

use crate::flow_route::{RouteRequest, derive_route};
use crate::inet_sim_bundle::{
    FlowStreamSpec, FlowTasSchedule, GclEntry, SimOverrides, build_flow_tas_sim_bundle,
};
use crate::inet_sim_command::{load_timing, load_topology};
use crate::inet_sim_http::InetSimPlanClient;

pub const CALIBER_FLOW_TAS_PLANNED: &str = "flow_tas_planned";

/// 规划结果（前端/agent 消费）。status 区分各态；solver 记出处（R8/KTD7 诚实边界）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    pub caliber: String,
    /// ok | no_streams | no_gm | route_error | bundle_error | unreachable | solver_failed
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver: Option<String>,
    pub gate_count: usize,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PlanResult {
    fn simple(status: &str, overall: &str, message: Option<String>) -> Self {
        Self {
            caliber: CALIBER_FLOW_TAS_PLANNED.to_string(),
            status: status.to_string(),
            solver: None,
            gate_count: 0,
            overall: overall.to_string(),
            message,
        }
    }
}

/// 库内流行（topology_streams 子集，plan/verify 共用）。
pub(crate) struct DbStream {
    pub(crate) stream_seq: i64,
    pub(crate) class: String,
    pub(crate) pcp: i64,
    pub(crate) period_us: i64,
    pub(crate) frame_bytes: i64,
    pub(crate) count: i64,
    pub(crate) talker: String,
    pub(crate) listener: String,
    pub(crate) max_latency_us: Option<i64>,
}

pub(crate) async fn load_streams(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<Vec<DbStream>, String> {
    let rows = sqlx::query(
        "SELECT stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us \
         FROM topology_streams WHERE session_id = ? ORDER BY stream_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 topology_streams 失败：{e}"))?;
    Ok(rows
        .iter()
        .map(|r| DbStream {
            stream_seq: r.get("stream_seq"),
            class: r.get("class"),
            pcp: r.get("pcp"),
            period_us: r.get("period_us"),
            frame_bytes: r.get("frame_bytes"),
            count: r.get("count"),
            talker: r.get("talker"),
            listener: r.get("listener"),
            max_latency_us: r.get("max_latency_us"),
        })
        .collect())
}

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

/// 解析 param-recording `.sca` 里的 transmissionGate 门参数 → Vec<GclEntry>（node=mid）。
/// 空 durations 的门（未调度）跳过。ned→mid 用 bundle 的 node_ned_names 反向表。
pub fn parse_gcl_from_sca(
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
        .filter_map(|((ned, eth_n, gate_index), a)| {
            if a.durations_ns.is_empty() {
                return None; // 未调度门（空 durations）——不入 GCL。
            }
            let node = ned_to_mid.get(&ned).cloned().unwrap_or(ned);
            Some(GclEntry {
                node,
                eth_n,
                gate_index,
                initially_open: a.initially_open,
                offset_ns: a.offset_ns,
                durations_ns: a.durations_ns,
                solver: solver.to_string(),
            })
        })
        .collect()
}

/// 全量覆盖写 flow_plans（stream_seq=0 当前规划标记）。
async fn write_flow_plans(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    gcl: &[GclEntry],
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("开事务失败：{e}"))?;
    // 写前快照（flow domain，撤销留位）。
    crate::topology_undo::snapshot_pre_image(
        &mut tx,
        session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    .map_err(|e| format!("快照失败：{e}"))?;
    sqlx::query("DELETE FROM flow_plans WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清 flow_plans 失败：{e}"))?;
    for g in gcl {
        let durs = serde_json::to_string(&g.durations_ns).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) \
             VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(&g.node)
        .bind(g.eth_n as i64)
        .bind(g.gate_index as i64)
        .bind(g.initially_open as i64)
        .bind(g.offset_ns as i64)
        .bind(&durs)
        .bind(&g.solver)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写 flow_plans 失败：{e}"))?;
    }
    tx.commit().await.map_err(|e| format!("提交失败：{e}"))?;
    Ok(())
}

/// 可测内核：注入 `InetSimPlanClient`，编排 流集 → 路径 → synth bundle → 跑配置器 → 解析 → 落库。
pub async fn plan_tas_inner<P: InetSimPlanClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    plan_client: &P,
    base_url: &str,
) -> Result<PlanResult, String> {
    let streams = load_streams(pool, session_id).await?;
    if streams.is_empty() {
        return Ok(PlanResult::simple(
            "no_streams",
            "还没有录入任何流，先录流再规划。",
            None,
        ));
    }

    let (nodes, links) = load_topology(pool, session_id).await?;
    let gm_mid: Option<String> =
        sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读 GM 失败：{e}"))?
            .flatten();
    let Some(gm_mid) = gm_mid.filter(|g| !g.is_empty()) else {
        return Ok(PlanResult::simple(
            "no_gm",
            "未设 GM，请先在时间同步阶段设定 GM（流量软仿需非理想时钟同步）。",
            None,
        ));
    };
    let timing = load_timing(pool, session_id).await?;

    // 逐流推导路径（plane 缺省=全链路；歧义/不可达响亮失败，surfaced）。喂 pathFragments。
    let mut specs: Vec<FlowStreamSpec> = Vec::new();
    for s in &streams {
        let route = derive_route(
            &RouteRequest {
                talker: &s.talker,
                listener: &s.listener,
                plane: None,
            },
            &nodes,
            &links,
        );
        let path_fragments = match route {
            Ok(r) => Some(r.node_path),
            Err(errs) => {
                let msg = errs
                    .iter()
                    .map(|e| e.message_zh.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                return Ok(PlanResult::simple(
                    "route_error",
                    "流路径推导失败（不可达或路径歧义），请检查拓扑/消歧。",
                    Some(format!("流 {}：{msg}", s.stream_seq)),
                ));
            }
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
            path_fragments,
        });
    }

    let sim_bundle = match build_flow_tas_sim_bundle(
        &nodes,
        &links,
        &gm_mid,
        &timing,
        &SimOverrides::default(),
        &specs,
        FlowTasSchedule::Synth,
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
            return Ok(PlanResult::simple(
                "bundle_error",
                "规划工程生成失败。",
                Some(msg),
            ));
        }
    };

    let plan = match plan_client.plan_gcl(base_url, &sim_bundle.bundle) {
        Ok(p) => p,
        Err(m) => {
            return Ok(PlanResult::simple(
                "unreachable",
                "规划暂时无法运行（软仿服务不可达），工程保持原状。",
                Some(m),
            ));
        }
    };

    // 不可行 / 求解器失败 / 无 GCL → FAIL，绝不落空/半截表（R10）。
    if plan.exit_code != 0 {
        return Ok(PlanResult::simple(
            "solver_failed",
            "门控综合失败：约束不可行或配置器出错，未产出门控表。",
            Some(plan.output_tail),
        ));
    }
    let solver = plan.solver.clone().unwrap_or_else(|| "Z3".to_string());
    let ned_to_mid: BTreeMap<String, String> = sim_bundle
        .node_ned_names
        .iter()
        .map(|(mid, ned)| (ned.clone(), mid.clone()))
        .collect();
    let gcl = plan
        .sca_gcl
        .as_deref()
        .map(|sca| parse_gcl_from_sca(sca, &ned_to_mid, &solver))
        .unwrap_or_default();
    if gcl.is_empty() {
        return Ok(PlanResult::simple(
            "solver_failed",
            "门控综合未产出可解析的门控表（约束可能不可行），未落库。",
            Some(plan.output_tail),
        ));
    }

    write_flow_plans(pool, session_id, &gcl).await?;

    let guarantee = if solver == "Z3" {
        "带可调度性保证"
    } else {
        "兜底解、无保证"
    };
    Ok(PlanResult {
        caliber: CALIBER_FLOW_TAS_PLANNED.to_string(),
        status: "ok".to_string(),
        solver: Some(solver),
        gate_count: gcl.len(),
        overall: format!("已综合 {} 个门控条目（{guarantee}）。", gcl.len()),
        message: None,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTasRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn plan_tas(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: PlanTasRequest,
) -> Result<PlanResult, String> {
    let pool = store.pool(&app).await?;
    let Some(base_url) = crate::inet_sim_http_config::resolve_inet_sim_http_url(pool).await? else {
        return Ok(PlanResult::simple(
            "no_service",
            "未配置软仿 HTTP 服务地址，请在设置里填写。",
            Some("InetSimHttpConfig.base_url 为空。".to_string()),
        ));
    };
    plan_tas_inner(
        pool,
        &request.session_id,
        &crate::inet_sim_http::ReqwestInetSimClient,
        &base_url,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inet_sim_http::HttpPlanResult;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

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

    // ---------- plan_tas_inner（MockPlanClient 注入）----------

    struct MockPlanClient {
        result: Result<HttpPlanResult, String>,
    }
    impl InetSimPlanClient for MockPlanClient {
        fn plan_gcl(
            &self,
            _base_url: &str,
            _bundle: &crate::inet_remote::InetBundle,
        ) -> Result<HttpPlanResult, String> {
            self.result.clone()
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

    async fn seed_linear(pool: &sqlx::Pool<sqlx::Sqlite>) {
        // es1(1) — sw1(0) — es2(2)。GM=1。
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
    }

    async fn add_stream(pool: &sqlx::Pool<sqlx::Sqlite>, seq: i64, class: &str, pcp: i64) {
        sqlx::query("INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', ?, ?, ?, 500, 512, 10000, '1', '2')")
            .bind(seq).bind(class).bind(pcp).execute(pool).await.unwrap();
    }

    /// AE2：约束可满足 → Z3 出 GCL，出处记 Z3，落 flow_plans。
    #[test]
    fn plan_tas_synthesizes_and_persists() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // mock 服务回 sw1 gate 的 .sca（node ned sw1 → mid 0）。
            let sca = "par N.sw1.eth[1].macLayer.queue.transmissionGate[0] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] durations \"[300us, 700us]\"\n";
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                    solver: Some("Z3".into()),
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(r.solver.as_deref(), Some("Z3"));
            assert_eq!(r.gate_count, 1);
            // 落库校验：flow_plans 有 1 行、node=0(mid)、stream_seq=0。
            let (node, durs): (String, String) = sqlx::query_as(
                "SELECT node, durations_ns FROM flow_plans WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(node, "0");
            assert_eq!(durs, "[300000,700000]");
        });
    }

    /// AE2/R10：约束不可行（exit≠0）→ FAIL，不落空表。
    #[test]
    fn plan_tas_infeasible_fails_without_empty_table() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "UNSAT".into(),
                    sca_gcl: None,
                    solver: None,
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_plans WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "不可行不得落空/半截表（R10）");
        });
    }

    /// exit=0 但 .sca 无可解析门（空 GCL）→ FAIL，不落表（R10）。
    #[test]
    fn plan_tas_empty_gcl_fails() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(
                        "par N.sw1.eth[0].macLayer.queue.transmissionGate[0] durations []\n".into(),
                    ),
                    solver: Some("Z3".into()),
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
        });
    }

    /// 无流 → no_streams。
    #[test]
    fn plan_tas_no_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: String::new(),
                    sca_gcl: None,
                    solver: None,
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "no_streams");
        });
    }
}
