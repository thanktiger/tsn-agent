//! 后端全链路 e2e（不经前端/浏览器）：通过真 sidecar HTTP 路由 + 内存 SQLite，把 agent
//! 等价的整条流水线串起来跑——拓扑 initialize → inspect → validate（真路由），再跨域到
//! 时钟同步 set_gm（真路由）→ 软仿 run_timesync_sim_inner（注入 MockRunner、canned CSV）。
//!
//! GM 的 ned 名从「实际 inspect 出的节点」按 build_timesync_sim_bundle 同序派生，故对
//! initialize 内部的 mid/排序方案不敏感（CSV 按真实节点动态生成）。
//!
//! 覆盖的 Rust 接口：/db/topology/{initialize,inspect,validate}、/db/timesync/set_gm、
//! inet_sim_command::run_timesync_sim_inner（含 verify_time_sync 闸 + bundle 生成 + 取数算偏差）。
//! apply_operations 的增量编辑由 topology_sidecar::insert_switch_via_inspect_then_apply_round_trip
//! 覆盖；本 e2e 聚焦「一条龙跨域」这个之前没有的缝。

#![cfg(test)]

use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::http::Request;
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;

use crate::inet_remote::{InetBundle, RemoteConfig, RemoteError, RemoteRunner, SimRunOutcome};
use crate::inet_sim_bundle::{OscillatorKind, SimOverrides};
use crate::inet_sim_command::run_timesync_sim_inner;
use crate::topology_mutation_buffer::TopologyMutationBuffer;
use crate::topology_sidecar::{SecretToken, build_test_router_with_pool};

/// 注入式 runner：返回 canned CSV，捕获 bundle ini 供断言覆盖参数。
struct MockRunner {
    csv: String,
    captured_ini: Mutex<Option<String>>,
}
impl RemoteRunner for MockRunner {
    fn run_sim_fetch_csv(
        &self,
        bundle: &InetBundle,
        _cfg: &RemoteConfig,
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

async fn e2e_pool() -> (sqlx::Pool<sqlx::Sqlite>, Arc<TopologyMutationBuffer>) {
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
    (pool, Arc::new(TopologyMutationBuffer::default()))
}

async fn post(router: axum::Router, token: &SecretToken, uri: &str, body: Value) -> Value {
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
    let bytes = to_bytes(resp.into_body(), 131_072).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// 按 build_timesync_sim_bundle 同序派生 ned 名：switch→sw{n}、其余可映射类型→es{n}。
fn ned_name_for(nodes: &[Value], target_mid: &str) -> Option<String> {
    let (mut sw, mut es) = (0u32, 0u32);
    for n in nodes {
        let mid = n["mid"].as_str().unwrap_or("");
        let ty = n["nodeType"].as_str();
        let ned = match ty {
            Some("switch") => {
                sw += 1;
                format!("sw{sw}")
            }
            Some("endSystem") | Some("server") => {
                es += 1;
                format!("es{es}")
            }
            _ => continue,
        };
        if mid == target_mid {
            return Some(ned);
        }
    }
    None
}

#[tokio::test]
async fn backend_full_flow_initialize_to_soft_sim() {
    let (pool, buf) = e2e_pool().await;
    let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

    // 1) 真 initialize：hop-linear 2 交换机 → 2 交换机 + 2 端系统（4 节点）、3 链路、mutationId 1。
    let init = post(
        router.clone(),
        &token,
        "/db/topology/initialize",
        json!({ "sessionId": "s1", "templateId": "hop-linear", "params": { "switchCount": 2, "dataRateMbps": 1000 } }),
    )
    .await;
    assert_eq!(init["ok"], true, "initialize: {init}");
    assert_eq!(init["summary"]["mutationId"], 1);

    // 2) 真 inspect：拿节点/链路切片（agent 据此构造操作）。
    let inspected = post(
        router.clone(),
        &token,
        "/db/topology/inspect",
        json!({ "sessionId": "s1" }),
    )
    .await;
    let nodes = inspected["summary"]["nodes"].as_array().unwrap().clone();
    assert_eq!(nodes.len(), 4, "inspect nodes: {inspected}");
    assert_eq!(inspected["summary"]["links"].as_array().unwrap().len(), 3);

    // 3) 真 validate（无参验库内）：initialize 产物结构合法。
    let validated = post(
        router.clone(),
        &token,
        "/db/topology/validate",
        json!({ "sessionId": "s1" }),
    )
    .await;
    assert_eq!(validated["ok"], true, "validate: {validated}");

    // 取第一个交换机当 GM；其 ned 名（用于匹配 CSV 里的 GM 时间序列）。
    let gm_mid = nodes
        .iter()
        .find(|n| n["nodeType"] == "switch")
        .and_then(|n| n["mid"].as_str())
        .expect("至少一个交换机")
        .to_string();
    let gm_ned = ned_name_for(&nodes, &gm_mid).expect("GM ned");

    // 4) 真 set_gm：写时钟树落库（timesync_domain + timesync_nodes 端口角色）。
    let set_gm = post(
        router.clone(),
        &token,
        "/db/timesync/set_gm",
        json!({ "sessionId": "s1", "gmMid": gm_mid }),
    )
    .await;
    assert_eq!(set_gm["ok"], true, "set_gm: {set_gm}");
    // 落库核对：domain.gm_mid 写对。
    let persisted_gm: Option<String> =
        sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id='s1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(persisted_gm.as_deref(), Some(gm_mid.as_str()));
    let ts_node_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM timesync_nodes WHERE session_id='s1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ts_node_count, 4, "时钟树应覆盖全部 4 节点");

    // 5) 按真实节点动态生成 canned timeChanged CSV：GM 恒 0，其余收敛到 1ns。
    let mut csv = String::from("run,module,name,vectime,vecvalue\n");
    for n in &nodes {
        let mid = n["mid"].as_str().unwrap();
        let Some(ned) = ned_name_for(&nodes, mid) else {
            continue;
        };
        let vals = if mid == gm_mid {
            "0 0 0 0"
        } else {
            "0.001 0.0005 1e-9 1e-9"
        };
        csv.push_str(&format!(
            "r1,net.{ned}.clock,timeChanged:vector,0 1 2 3,{vals}\n"
        ));
    }
    let mock = MockRunner {
        csv,
        captured_ini: Mutex::new(None),
    };
    let overrides = SimOverrides {
        oscillator: OscillatorKind::Constant,
        drift_ppm: Some(50.0),
        sim_time_s: Some(2.5),
    };

    // 6) 真软仿命令内核：verify 闸（不漂移）→ bundle → mock runner → 取数算偏差。
    let result =
        run_timesync_sim_inner(&pool, "s1", &overrides, &mock, &RemoteConfig::dev_default())
            .await
            .unwrap();

    assert_eq!(result.status, "converged", "{result:?}");
    assert_eq!(result.caliber, "timesync_simulated");
    assert_eq!(result.per_node.len(), 3, "GM 外 3 个 slave");
    assert!(result.per_node.iter().all(|n| n.converged));

    // 覆盖参数确实进了生成的 ini（端到端：覆盖表单 → bundle → 远端工程）。
    let ini = mock.captured_ini.lock().unwrap().clone().unwrap();
    assert!(ini.contains("ConstantDriftOscillator"), "{ini}");
    assert!(ini.contains("driftRate = 50ppm"));
    assert!(ini.contains("sim-time-limit = 2.5s"));
    assert!(ini.contains(&format!("**.referenceClock = \"{gm_ned}.clock\"")));
}
