//! 流量规划写库 sidecar route（`/db/flow/*`）。镜像 `timesync_sidecar_routes`：
//! 复用同一 `RouteState` / Bearer / session middleware。
//! - `add_stream`：`verify_flow` 校验闸 → 单一 `insert_stream` 落 `topology_streams`。
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

use crate::flow_verify::{StreamInput, VerifyError, verify_flow};
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

/// 单一插入助手（KTD6）：分配 `stream_seq = max+1`，落 `topology_streams` 全部结构列。
/// 所有写入路径共用——校验闸 `verify_flow` 由调用方在此之前跑。返回分配的 stream_seq。
pub async fn insert_stream(
    conn: &mut SqliteConnection,
    session_id: &str,
    s: &StreamInput,
) -> Result<i64, String> {
    let next_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(stream_seq), -1) + 1 FROM topology_streams WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| format!("compute next stream_seq failed: {e}"))?;

    sqlx::query(
        r#"INSERT INTO topology_streams
           (session_id, stream_seq, class, pcp, period_us, frame_bytes, count,
            talker, listener, src_ip, dst_ip, src_l4_port, dst_l4_port, l4_protocol,
            max_latency_us, redundant, paths)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
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
    .bind(&s.src_ip)
    .bind(&s.dst_ip)
    .bind(s.src_l4_port)
    .bind(s.dst_l4_port)
    .bind(&s.l4_protocol)
    .bind(s.max_latency_us)
    .bind(s.redundant)
    .bind(&s.paths)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("insert topology_streams failed: {e}"))?;

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
    #[serde(default)]
    redundant: Option<i64>,
    #[serde(default)]
    paths: Option<String>,
}

impl AddStreamRequest {
    fn into_input(self) -> (String, StreamInput) {
        (
            self.session_id,
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
                redundant: self.redundant.unwrap_or(0),
                paths: self.paths,
            },
        )
    }
}

pub async fn add_stream(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<AddStreamRequest>,
) -> Response {
    let (session_id, input) = req.into_input();
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
        match sqlx::query("DELETE FROM topology_streams WHERE session_id = ? AND stream_seq = ?")
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
                  max_latency_us, redundant, paths
           FROM topology_streams WHERE session_id = ? ORDER BY stream_seq"#,
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
                "durationsNs": r.get::<String, _>("durations_ns"),
                "solver": r.get::<String, _>("solver"),
            })
        })
        .collect();

    ok_summary(json!({ "streams": streams, "plans": plans }))
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

    /// add_stream 过校验闸 → 落 topology_streams，SELECT 断言**结构列本身**有值。
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
                    "SELECT class, pcp, period_us, talker, listener FROM topology_streams \
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
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_streams WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "被拒的流不落表");
        });
    }

    /// RC 流带 redundant=1 + paths JSON 可落可读；ST/BE 流 redundant=0/paths=NULL。
    #[test]
    fn rc_stream_redundant_and_paths_round_trip() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            add_node(&pool, "0").await;
            add_node(&pool, "1").await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let body = json!({
                "sessionId": "s1", "class": "RC", "pcp": 6, "periodUs": 500,
                "frameBytes": 512, "count": 100, "talker": "0", "listener": "1",
                "redundant": 1, "paths": "{\"A\":[\"0\",\"1\"],\"B\":[\"0\",\"1\"]}"
            });
            let (status, parsed) = post(router, &token, "/db/flow/add_stream", body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true, "{parsed:?}");

            let (redundant, paths): (i64, Option<String>) = sqlx::query_as(
                "SELECT redundant, paths FROM topology_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(redundant, 1);
            assert!(paths.unwrap().contains("\"A\""));
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
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_streams WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }
}
