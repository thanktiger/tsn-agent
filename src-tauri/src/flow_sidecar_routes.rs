//! 流量规划写库 sidecar route（`/db/flow/*`）。镜像 `timesync_sidecar_routes`：
//! 复用同一 `RouteState` / Bearer / session middleware。
//! - `add_stream`：`verify_flow` 校验闸 → 单一 `insert_stream` 落 `flow_streams`。
//! - `inspect`：读 streams + flow_plans 给 agent（talker/listener→mid 解析用）。
//! - `remove_stream`：删某 `stream_seq`。
//!
//! 写 handler 范式：`require_session` → begin tx → `snapshot_pre_image(FLOW_DOMAIN)`
//! （为后续单步撤销留 pre-image，撤销触发本期 defer）→ insert/delete → commit →
//! `push_and_summary`(domain="flow")。**单一写入路径 `insert_stream`（KTD6）**：
//! 任何写库都过它 + 先过 `verify_flow`；测试断言结构列本身。

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::sync::Arc;

use crate::flow_verify::{StreamInput, VerifyError, derive_rc_paths, verify_flow};
use crate::topology_sidecar_routes::{RouteState, ok_summary, require_session, structured_error};

/// push mutation(domain="flow") + emit，组装成功信封（镜像 timesync push_and_summary）。
fn push_and_summary(state: &Arc<RouteState>, session_id: &str, mut extra: Value) -> Response {
    let record = state
        .mutation_buffer
        .push(session_id.to_string(), "flow".to_string());
    (state.emit)(record.clone());
    if let Value::Object(ref mut map) = extra {
        map.insert(
            "sessionId".to_string(),
            Value::String(session_id.to_string()),
        );
        map.insert("mutationId".to_string(), json!(record.mutation_id));
    }
    ok_summary(extra)
}

/// 校验闸拒绝：200 + `{ok:false, errors[], code, message}`（镜像 topology fail_with_errors——
/// agent 拿到 ok:false 即处理、指出违规字段，非传输层错误）。
fn fail_with_flow_errors(errors: &[VerifyError]) -> Response {
    let payload = json!({
        "ok": false,
        "errors": errors,
        "code": errors
            .first()
            .map(|e| e.code.clone())
            .unwrap_or_else(|| "FLOW_VALIDATION".into()),
        "message": errors.first().map(|e| e.message_zh.clone()).unwrap_or_default(),
        "retryable": false,
    });
    (StatusCode::OK, Json(payload)).into_response()
}

/// 单一插入助手（KTD6）：分配 `stream_seq = max+1`，落 `flow_streams` 全部结构列。
/// 所有写入路径共用——校验闸 `verify_flow` 由调用方在此之前跑。返回分配的 stream_seq。
/// 设备级流标识默认值在此落库（boss 定录入即落库）：请求未带的字段按 mid 推导
/// MAC/IP、常量默认端口/协议/VLAN/偏移/抖动、名称 `{class}流{seq}`。
pub async fn insert_stream(
    conn: &mut SqliteConnection,
    session_id: &str,
    s: &StreamInput,
) -> Result<i64, String> {
    let next_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(stream_seq), -1) + 1 FROM flow_streams WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| format!("compute next stream_seq failed: {e}"))?;

    use crate::flow_query_command as fq;
    let src_ip = s
        .src_ip
        .clone()
        .or_else(|| fq::default_ip_for_mid(&s.talker));
    let dst_ip = s
        .dst_ip
        .clone()
        .or_else(|| fq::default_ip_for_mid(&s.listener));
    let src_l4_port = s.src_l4_port.unwrap_or(fq::DEFAULT_SRC_L4_PORT);
    let dst_l4_port = s.dst_l4_port.unwrap_or(fq::DEFAULT_DST_L4_PORT);
    let l4_protocol = s
        .l4_protocol
        .clone()
        .unwrap_or_else(|| fq::DEFAULT_L4_PROTOCOL.to_string());

    sqlx::query(
        r#"INSERT INTO flow_streams
           (session_id, stream_seq, class, pcp, period_us, frame_bytes, count,
            talker, listener, src_ip, dst_ip, src_l4_port, dst_l4_port, l4_protocol,
            max_latency_us, redundant, paths,
            src_mac, dst_mac, vlan_id, earliest_send_offset_ns, latest_send_offset_ns,
            name, jitter_ns)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(session_id)
    .bind(next_seq)
    .bind(&s.class)
    .bind(s.pcp)
    .bind(s.period_us)
    .bind(s.frame_bytes)
    .bind(s.count)
    .bind(&s.talker)
    .bind(&s.listener)
    .bind(&src_ip)
    .bind(&dst_ip)
    .bind(src_l4_port)
    .bind(dst_l4_port)
    .bind(&l4_protocol)
    .bind(s.max_latency_us)
    .bind(s.redundant)
    .bind(&s.paths)
    .bind(fq::default_mac_for_mid(&s.talker))
    .bind(fq::default_mac_for_mid(&s.listener))
    .bind(fq::DEFAULT_VLAN_ID)
    .bind(fq::DEFAULT_EARLIEST_SEND_OFFSET_NS)
    .bind(fq::DEFAULT_LATEST_SEND_OFFSET_NS)
    .bind(fq::default_stream_name(&s.class, next_seq))
    .bind(fq::DEFAULT_JITTER_NS)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("insert flow_streams failed: {e}"))?;

    Ok(next_seq)
}

// ---------- add_stream ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddStreamRequest {
    session_id: String,
    class: String,
    pcp: i64,
    period_us: i64,
    frame_bytes: i64,
    count: i64,
    talker: String,
    listener: String,
    #[serde(default)]
    src_ip: Option<String>,
    #[serde(default)]
    dst_ip: Option<String>,
    #[serde(default)]
    src_l4_port: Option<i64>,
    #[serde(default)]
    dst_l4_port: Option<i64>,
    #[serde(default)]
    l4_protocol: Option<String>,
    #[serde(default)]
    max_latency_us: Option<i64>,
    /// R16：ST/BE 显式路径（节点引用序列，mid 或唯一 name，含首尾节点）。
    /// RC 请求带此字段报错（FRER 双路径由系统推导保证不相交）。
    /// redundant 仍不设请求字段（系统推导：RC 落库前 derive_rc_paths 覆盖）。
    #[serde(default)]
    path: Option<Vec<String>>,
}

impl AddStreamRequest {
    fn into_input(self) -> (String, Option<Vec<String>>, StreamInput) {
        (
            self.session_id,
            self.path,
            StreamInput {
                class: self.class,
                pcp: self.pcp,
                period_us: self.period_us,
                frame_bytes: self.frame_bytes,
                count: self.count,
                talker: self.talker,
                listener: self.listener,
                src_ip: self.src_ip,
                dst_ip: self.dst_ip,
                src_l4_port: self.src_l4_port,
                dst_l4_port: self.dst_l4_port,
                l4_protocol: self.l4_protocol,
                max_latency_us: self.max_latency_us,
                // redundant 不透传请求值（系统推导：RC 由落库前 derive_rc_paths 覆盖）。
                // paths 由 handler 解析 path 节点引用后填（R16 显式指定），未指定 NULL。
                redundant: 0,
                paths: None,
            },
        )
    }
}

pub async fn add_stream(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<AddStreamRequest>,
) -> Response {
    let (session_id, path_refs, mut input) = req.into_input();

    // R16：显式路径解析（节点引用 → link_seqs → paths JSON）。RC 不接受手选路径。
    if let Some(refs) = path_refs {
        if input.class == "RC" {
            return structured_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "RC_PATH_NOT_SELECTABLE",
                "RC 流的双冗余路径由系统推导（保证不相交），不支持手动指定。",
                false,
            );
        }
        let (nodes, links) =
            match crate::flow_verify::load_route_topology(&state.pool, &session_id).await {
                Ok(t) => t,
                Err(e) => {
                    return structured_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "DATABASE_ERROR",
                        &e.to_string(),
                        true,
                    );
                }
            };
        match crate::flow_route::route_from_node_refs(
            &refs,
            &input.talker,
            &input.listener,
            &nodes,
            &links,
        ) {
            Ok(route) => input.paths = Some(crate::flow_route::explicit_paths_json(&route)),
            Err(errors) => {
                // 路由层错误 → 录入闸用户语言（与 verify_flow 同映射）。
                let mapped: Vec<crate::flow_verify::VerifyError> = errors
                    .into_iter()
                    .map(|e| {
                        crate::flow_verify::VerifyError::new(&e.code, e.message_zh, e.node_ref)
                    })
                    .collect();
                return fail_with_flow_errors(&mapped);
            }
        }
    }
    if let Err(resp) = require_session(&state.pool, &session_id).await {
        return resp;
    }

    // 校验闸（KTD6）：在 pool 上只读校验，有违规即拒、指出字段，不落表。
    let errors = match verify_flow(&state.pool, &session_id, &input).await {
        Ok(e) => e,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            );
        }
    };
    if !errors.is_empty() {
        return fail_with_flow_errors(&errors);
    }

    // RC 流：录入时推导 A/B 双平面路径落预留槽（R2；预存值仅凭证，规划/验证期重推导，KTD6）。
    // redundant/paths 由系统推导，覆盖请求侧任何传入值；ST/BE 不变（redundant=0 / paths NULL）。
    // 校验闸已跑过同一推导，此处 Err 分支纯防御。
    if input.class == "RC" {
        match derive_rc_paths(&state.pool, &session_id, &input.talker, &input.listener).await {
            Ok(Ok(paths)) => {
                input.redundant = 1;
                input.paths = Some(paths);
            }
            Ok(Err(errors)) => return fail_with_flow_errors(&errors),
            Err(e) => {
                return structured_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATABASE_ERROR",
                    &e.to_string(),
                    true,
                );
            }
        }
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "BEGIN_FAILED",
                &e.to_string(),
                true,
            );
        }
    };
    // 写前快照（单步撤销 domain="flow"；撤销触发本期 defer，pre-image 先留）。
    if let Err(e) = crate::topology_undo::snapshot_pre_image(
        &mut tx,
        &session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SNAPSHOT_FAILED",
            &e.to_string(),
            true,
        );
    }

    let stream_seq = match insert_stream(&mut tx, &session_id, &input).await {
        Ok(seq) => seq,
        Err(e) => {
            return structured_error(StatusCode::UNPROCESSABLE_ENTITY, "INSERT_FAILED", &e, true);
        }
    };

    if let Err(e) = tx.commit().await {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "COMMIT_FAILED",
            &e.to_string(),
            true,
        );
    }

    push_and_summary(&state, &session_id, json!({ "streamSeq": stream_seq }))
}

// ---------- remove_stream ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStreamRequest {
    session_id: String,
    stream_seq: i64,
}

pub async fn remove_stream(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<RemoveStreamRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "BEGIN_FAILED",
                &e.to_string(),
                true,
            );
        }
    };
    if let Err(e) = crate::topology_undo::snapshot_pre_image(
        &mut tx,
        &req.session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SNAPSHOT_FAILED",
            &e.to_string(),
            true,
        );
    }

    // 一并清该流已综合的 GCL（flow_plans 归 flow domain，pre-image 已快照可撤）。
    let removed =
        match sqlx::query("DELETE FROM flow_streams WHERE session_id = ? AND stream_seq = ?")
            .bind(&req.session_id)
            .bind(req.stream_seq)
            .execute(&mut *tx)
            .await
        {
            Ok(r) => r.rows_affected(),
            Err(e) => {
                return structured_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DELETE_FAILED",
                    &e.to_string(),
                    true,
                );
            }
        };
    if let Err(e) = sqlx::query("DELETE FROM flow_plans WHERE session_id = ? AND stream_seq = ?")
        .bind(&req.session_id)
        .bind(req.stream_seq)
        .execute(&mut *tx)
        .await
    {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DELETE_FAILED",
            &e.to_string(),
            true,
        );
    }

    if let Err(e) = tx.commit().await {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "COMMIT_FAILED",
            &e.to_string(),
            true,
        );
    }

    push_and_summary(
        &state,
        &req.session_id,
        json!({ "streamSeq": req.stream_seq, "removed": removed }),
    )
}

// ---------- inspect ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    session_id: String,
}

pub async fn inspect(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<InspectRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    let stream_rows = match sqlx::query(
        r#"SELECT stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener,
                  max_latency_us, redundant, paths,
                  src_mac, dst_mac, vlan_id, earliest_send_offset_ns, latest_send_offset_ns,
                  name, jitter_ns, src_ip, dst_ip, src_l4_port, dst_l4_port, l4_protocol
           FROM flow_streams WHERE session_id = ? ORDER BY stream_seq"#,
    )
    .bind(&req.session_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            );
        }
    };
    let streams: Vec<Value> = stream_rows
        .iter()
        .map(|r| {
            json!({
                "streamSeq": r.get::<i64, _>("stream_seq"),
                "class": r.get::<String, _>("class"),
                "pcp": r.get::<i64, _>("pcp"),
                "periodUs": r.get::<i64, _>("period_us"),
                "frameBytes": r.get::<i64, _>("frame_bytes"),
                "count": r.get::<i64, _>("count"),
                "talker": r.get::<String, _>("talker"),
                "listener": r.get::<String, _>("listener"),
                "maxLatencyUs": r.get::<Option<i64>, _>("max_latency_us"),
                "redundant": r.get::<i64, _>("redundant"),
                "paths": r.get::<Option<String>, _>("paths"),
                "srcMac": r.get::<Option<String>, _>("src_mac"),
                "dstMac": r.get::<Option<String>, _>("dst_mac"),
                "vlanId": r.get::<Option<i64>, _>("vlan_id"),
                "earliestSendOffsetNs": r.get::<Option<i64>, _>("earliest_send_offset_ns"),
                "latestSendOffsetNs": r.get::<Option<i64>, _>("latest_send_offset_ns"),
                "name": r.get::<Option<String>, _>("name"),
                "jitterNs": r.get::<Option<i64>, _>("jitter_ns"),
                "srcIp": r.get::<Option<String>, _>("src_ip"),
                "dstIp": r.get::<Option<String>, _>("dst_ip"),
                "srcL4Port": r.get::<Option<i64>, _>("src_l4_port"),
                "dstL4Port": r.get::<Option<i64>, _>("dst_l4_port"),
                "l4Protocol": r.get::<Option<String>, _>("l4_protocol"),
            })
        })
        .collect();

    let plan_rows = match sqlx::query(
        r#"SELECT stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver
           FROM flow_plans WHERE session_id = ? ORDER BY stream_seq, node, eth_n, gate_index"#,
    )
    .bind(&req.session_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            );
        }
    };
    let plans: Vec<Value> = plan_rows
        .iter()
        .map(|r| {
            json!({
                "streamSeq": r.get::<i64, _>("stream_seq"),
                "node": r.get::<String, _>("node"),
                "ethN": r.get::<i64, _>("eth_n"),
                "gateIndex": r.get::<i64, _>("gate_index"),
                "initiallyOpen": r.get::<i64, _>("initially_open") != 0,
                "offsetNs": r.get::<i64, _>("offset_ns"),
                // durations_ns 本读面回原始 JSON 字符串（agent inspect 只读透传，不解析）；另一读面
                // flow_query_command::get_flow_plan_inner 解析成 Vec<u64>（时序图/占空比要算）——
                // 两面类型分叉，消费端不同，勿强行统一。
                "durationsNs": r.get::<String, _>("durations_ns"),
                "solver": r.get::<String, _>("solver"),
            })
        })
        .collect();

    ok_summary(json!({ "streams": streams, "plans": plans }))
}

// ---------- update_stream ----------

pub async fn update_stream(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<crate::flow_query_command::UpdateFlowStreamRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    match crate::flow_query_command::update_flow_stream_inner(&state.pool, &req).await {
        Ok(()) => push_and_summary(
            &state,
            &req.session_id,
            json!({ "streamSeq": req.stream_seq }),
        ),
        Err(e) => structured_error(StatusCode::UNPROCESSABLE_ENTITY, "UPDATE_FAILED", &e, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::topology_mutation_buffer::TopologyMutationBuffer;
    use crate::topology_sidecar::SecretToken;
    use crate::topology_sidecar::build_test_router_with_pool;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tower::ServiceExt;

    async fn test_state() -> (sqlx::Pool<sqlx::Sqlite>, Arc<TopologyMutationBuffer>) {
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

    async fn add_node(pool: &sqlx::Pool<sqlx::Sqlite>, mid: &str) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, 0)",
        )
        .bind(mid)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 插入链路（plane=None 为单平面链路；Some 写 styles_json.plane，双平面 fixture 用）。
    async fn add_link(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        seq: i64,
        src: &str,
        sp: i64,
        dst: &str,
        dp: i64,
        plane: Option<&str>,
    ) {
        let styles = match plane {
            Some(p) => format!(r#"{{"plane":"{p}"}}"#),
            None => "{}".to_string(),
        };
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, ?)",
        )
        .bind(seq)
        .bind(src)
        .bind(dst)
        .bind(sp)
        .bind(dp)
        .bind(styles)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 双平面 fixture：0→1 经平面 A（0-2-1，seq 0/1）与平面 B（0-3-1，seq 2/3）。
    async fn seed_dual_plane(pool: &sqlx::Pool<sqlx::Sqlite>) {
        for mid in ["0", "1", "2", "3"] {
            add_node(pool, mid).await;
        }
        add_link(pool, 0, "0", 0, "2", 0, Some("A")).await;
        add_link(pool, 1, "2", 1, "1", 0, Some("A")).await;
        add_link(pool, 2, "0", 1, "3", 0, Some("B")).await;
        add_link(pool, 3, "3", 1, "1", 1, Some("B")).await;
    }

    async fn post(
        router: axum::Router,
        token: &SecretToken,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
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
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 65_536).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn valid_st_body() -> serde_json::Value {
        json!({
            "sessionId": "s1",
            "class": "ST",
            "pcp": 7,
            "periodUs": 500,
            "frameBytes": 512,
            "count": 10000,
            "talker": "0",
            "listener": "1"
        })
    }

    /// add_stream 过校验闸 → 落 flow_streams，SELECT 断言**结构列本身**有值。
    #[test]
    fn add_stream_persists_structural_columns() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let (status, parsed) =
                post(router, &token, "/db/flow/add_stream", valid_st_body()).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true, "{parsed:?}");
            assert_eq!(parsed["summary"]["streamSeq"], 0);
            assert_eq!(parsed["summary"]["mutationId"], 1);

            // 断言结构列本身（非 JSON blob）。
            let (class, pcp, period, talker, listener): (String, i64, i64, String, String) =
                sqlx::query_as(
                    "SELECT class, pcp, period_us, talker, listener FROM flow_streams \
                     WHERE session_id='s1' AND stream_seq=0",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(class, "ST");
            assert_eq!(pcp, 7);
            assert_eq!(period, 500);
            assert_eq!(talker, "0");
            assert_eq!(listener, "1");
        });
    }

    /// 校验闸拒绝（周期 700∤1000）→ ok:false + errors，不落表。
    #[test]
    fn add_stream_rejected_by_gate_does_not_persist() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let mut body = valid_st_body();
            body["periodUs"] = json!(700);
            let (status, parsed) = post(router, &token, "/db/flow/add_stream", body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], false, "{parsed:?}");
            assert_eq!(parsed["code"], "PERIOD_NOT_DIVISOR");

            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_streams WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "被拒的流不落表");
        });
    }

    /// R1/R2/R3/①：双平面拓扑上 ST@pcp7 / RC@pcp6 / BE@pcp0 各录入成功；
    /// 断言 redundant/paths **列值本身**——ST/BE redundant=0、paths NULL，
    /// RC redundant=1、paths JSON 的 a/b node_path 与 link_seqs 逐项匹配（非 blob 整体比对）。
    #[test]
    fn three_classes_persist_redundant_and_paths_columns() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_dual_plane(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            for (class, pcp) in [("ST", 7), ("RC", 6), ("BE", 0)] {
                let mut body = valid_st_body();
                body["class"] = json!(class);
                body["pcp"] = json!(pcp);
                let (status, parsed) =
                    post(router.clone(), &token, "/db/flow/add_stream", body).await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(parsed["ok"], true, "{class}: {parsed:?}");
            }

            let rows: Vec<(i64, String, i64, Option<String>)> = sqlx::query_as(
                "SELECT stream_seq, class, redundant, paths FROM flow_streams \
                 WHERE session_id='s1' ORDER BY stream_seq",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            assert_eq!(rows.len(), 3);
            assert_eq!((rows[0].1.as_str(), rows[0].2), ("ST", 0));
            assert!(rows[0].3.is_none(), "ST paths 应为 NULL");
            assert_eq!((rows[2].1.as_str(), rows[2].2), ("BE", 0));
            assert!(rows[2].3.is_none(), "BE paths 应为 NULL");

            assert_eq!((rows[1].1.as_str(), rows[1].2), ("RC", 1));
            let paths: serde_json::Value =
                serde_json::from_str(rows[1].3.as_deref().unwrap()).unwrap();
            // KTD12 统一形状：routes[0]=A 平面、routes[1]=B 平面，origin=system。
            assert_eq!(paths["version"], json!(1));
            assert_eq!(paths["origin"], json!("system"));
            assert_eq!(paths["routes"][0]["node_path"], json!(["0", "2", "1"]));
            assert_eq!(paths["routes"][0]["link_seqs"], json!([0, 1]));
            assert_eq!(paths["routes"][1]["node_path"], json!(["0", "3", "1"]));
            assert_eq!(paths["routes"][1]["link_seqs"], json!([2, 3]));
        });
    }

    /// 非 RC 类强制 redundant=0/paths NULL：ST 请求带 redundant=1 + 垃圾 paths →
    /// 落库列值仍 0/NULL（请求侧传入值不透传，与推导注释承诺一致）。
    #[test]
    fn non_rc_request_redundant_paths_not_passed_through() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let mut body = valid_st_body();
            body["redundant"] = json!(1);
            body["paths"] = json!(r#"{"a":"garbage"}"#);
            let (status, parsed) = post(router, &token, "/db/flow/add_stream", body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true, "{parsed:?}");

            let (redundant, paths): (i64, Option<String>) = sqlx::query_as(
                "SELECT redundant, paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(redundant, 0, "ST 落库恒 redundant=0");
            assert!(paths.is_none(), "ST 落库恒 paths NULL: {paths:?}");
        });
    }

    /// Covers AE3. 线性拓扑（链路无 plane 键）录 RC → NOT_DUAL_PLANE 拒绝、不落表。
    #[test]
    fn rc_on_linear_topology_rejected_not_dual_plane() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            // 5 跳线性 0-1-2-3-4-5，无 plane 键。
            for mid in ["0", "1", "2", "3", "4", "5"] {
                add_node(&pool, mid).await;
            }
            for (seq, (src, dst)) in [("0", "1"), ("1", "2"), ("2", "3"), ("3", "4"), ("4", "5")]
                .iter()
                .enumerate()
            {
                add_link(&pool, seq as i64, src, 1, dst, 0, None).await;
            }
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let mut body = valid_st_body();
            body["class"] = json!("RC");
            body["pcp"] = json!(6);
            body["listener"] = json!("5");
            let (status, parsed) = post(router, &token, "/db/flow/add_stream", body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], false, "{parsed:?}");
            assert_eq!(parsed["code"], "NOT_DUAL_PLANE");

            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_streams WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "被拒的流不落表");
        });
    }

    /// R2/④：双平面（每平面两跳）RC 录入 → paths 两平面路径节点/链路互不相交、列非 NULL。
    #[test]
    fn rc_paths_disjoint_across_planes() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            // 平面 A：0-2-3-1；平面 B：0-4-5-1。
            for mid in ["0", "1", "2", "3", "4", "5"] {
                add_node(&pool, mid).await;
            }
            add_link(&pool, 0, "0", 0, "2", 0, Some("A")).await;
            add_link(&pool, 1, "2", 1, "3", 0, Some("A")).await;
            add_link(&pool, 2, "3", 1, "1", 0, Some("A")).await;
            add_link(&pool, 3, "0", 1, "4", 0, Some("B")).await;
            add_link(&pool, 4, "4", 1, "5", 0, Some("B")).await;
            add_link(&pool, 5, "5", 1, "1", 1, Some("B")).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let mut body = valid_st_body();
            body["class"] = json!("RC");
            body["pcp"] = json!(6);
            let (status, parsed) = post(router, &token, "/db/flow/add_stream", body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true, "{parsed:?}");

            let paths_col: Option<String> = sqlx::query_scalar(
                "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let paths: serde_json::Value =
                serde_json::from_str(paths_col.as_deref().expect("paths 列非 NULL")).unwrap();

            let node_set = |idx: usize| -> std::collections::HashSet<String> {
                paths["routes"][idx]["node_path"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect()
            };
            let a_nodes = node_set(0);
            let b_nodes = node_set(1);
            let shared: Vec<_> = a_nodes.intersection(&b_nodes).collect();
            let endpoints: std::collections::HashSet<String> =
                ["0".to_string(), "1".to_string()].into();
            assert!(
                shared.iter().all(|n| endpoints.contains(*n)),
                "中间节点不得相交: {shared:?}"
            );

            let link_set = |idx: usize| -> std::collections::HashSet<i64> {
                paths["routes"][idx]["link_seqs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_i64().unwrap())
                    .collect()
            };
            assert!(
                link_set(0).is_disjoint(&link_set(1)),
                "链路不得相交: {paths}"
            );
        });
    }

    /// 两次 add_stream → stream_seq 递增 0,1；inspect 回读两条 + 空 plans。
    #[test]
    fn add_two_streams_then_inspect() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let (_, p0) = post(
                router.clone(),
                &token,
                "/db/flow/add_stream",
                valid_st_body(),
            )
            .await;
            assert_eq!(p0["summary"]["streamSeq"], 0);
            let mut be = valid_st_body();
            be["class"] = json!("BE");
            be["pcp"] = json!(0);
            let (_, p1) = post(router.clone(), &token, "/db/flow/add_stream", be).await;
            assert_eq!(p1["summary"]["streamSeq"], 1, "seq 递增");

            let (status, parsed) = post(
                router,
                &token,
                "/db/flow/inspect",
                json!({ "sessionId": "s1" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["summary"]["streams"].as_array().unwrap().len(), 2);
            assert_eq!(parsed["summary"]["plans"].as_array().unwrap().len(), 0);
        });
    }

    /// remove_stream 删该流；再 inspect 为空。
    #[test]
    fn remove_stream_deletes_row() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            post(
                router.clone(),
                &token,
                "/db/flow/add_stream",
                valid_st_body(),
            )
            .await;
            let (status, parsed) = post(
                router,
                &token,
                "/db/flow/remove_stream",
                json!({ "sessionId": "s1", "streamSeq": 0 }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["removed"], 1);

            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_streams WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }
}
