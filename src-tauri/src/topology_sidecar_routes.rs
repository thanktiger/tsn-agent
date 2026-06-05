//! Plan v3 U4a：拓扑 sidecar 8 个领域 route 的实际实现。
//!
//! U4a-1 已接：apply_operations / inspect (counts) / validate (基础结构)。
//! U4a-2 接：describe_templates / initialize / inspect (含 selector) /
//!          validate (含完整结构校验) / build_artifacts / describe_artifacts /
//!          validate_artifacts。计算实现 1:1 镜像 `src/topology/*.ts`，落于
//!          `topology_compute` + `topology_intermediate`。
//!
//! 所有路由都先做 `require_session(sessionId)`，再进 compute 模块，保证 sidecar
//! 仍是单写者 + per-session 隔离的事实源边界（即便算法本身是 pure compute）。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::sync::Arc;

use crate::topology_backfill::{legacy_class_path, legacy_node_type};
use crate::topology_compute::{
    build_topology_artifacts, describe_templates_catalog, describe_topology_artifacts,
    initialize_topology as compute_initialize, validate_intermediate_topology,
    validate_topology_artifacts, InitializeIntent,
};
use crate::topology_intermediate::{IntermediateNodeType, IntermediateTopology};
use crate::topology_mutation_buffer::{MutationRecord, TopologyMutationBuffer};
use crate::topology_ops::{apply_op, TopologyOp};
use crate::topology_query_command::{TopologyLinkRow, TopologyNodeRow};

/// 闭包形式的 mutation 发射器：生产用 Tauri AppHandle wrap，测试用 no-op。
/// 通过 trait object 解耦 runtime 泛型，避免 `RouteState` 被 `MockRuntime` 污染。
pub type MutationEmitFn = Arc<dyn Fn(MutationRecord) + Send + Sync>;

#[derive(Clone)]
pub struct RouteState {
    pub pool: sqlx::Pool<sqlx::Sqlite>,
    pub mutation_buffer: Arc<TopologyMutationBuffer>,
    pub emit: MutationEmitFn,
}

fn structured_error(status: StatusCode, code: &str, message: &str, retryable: bool) -> Response {
    let body = serde_json::json!({
        "ok": false,
        "code": code,
        "message": message,
        "retryable": retryable,
    });
    (status, Json(body)).into_response()
}

fn ok_summary(summary: Value) -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "summary": summary })),
    )
        .into_response()
}

fn ok_summary_with_full(summary: Value, full: Value) -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "summary": summary, "full": full })),
    )
        .into_response()
}

fn fail_with_errors(errors: Vec<crate::topology_compute::TopologyErrorOut>) -> Response {
    let payload = json!({
        "ok": false,
        "errors": errors,
        "code": errors.first().map(|e| e.code.clone()).unwrap_or_else(|| "TOPOLOGY_ERROR".into()),
        "message": errors.first().map(|e| e.message.clone()).unwrap_or_default(),
        "retryable": false,
    });
    // 200 表示 compute 层结构化错误（agent 拿到 ok:false 即处理）；
    // sidecar 层错误才用 4xx/5xx。
    (StatusCode::OK, Json(payload)).into_response()
}

pub async fn healthz() -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"status":"ok","service":"tsn_topology_sidecar"}"#,
    )
        .into_response()
}

// ---------- describe_templates ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOnlyRequest {
    session_id: String,
}

pub async fn describe_templates(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<SessionOnlyRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    ok_summary(describe_templates_catalog())
}

// ---------- describe_artifacts ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeArtifactsRequest {
    session_id: String,
    artifacts: Value,
}

pub async fn describe_artifacts(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<DescribeArtifactsRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    ok_summary(describe_topology_artifacts(&req.artifacts))
}

// ---------- build_artifacts ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildArtifactsRequest {
    session_id: String,
    topology: Value,
}

pub async fn build_artifacts(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<BuildArtifactsRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    match build_topology_artifacts(&req.topology) {
        Ok(result) => ok_summary_with_full(
            serde_json::to_value(&result.summary).unwrap_or(Value::Null),
            json!({ "artifacts": result.artifacts }),
        ),
        Err(errors) => fail_with_errors(errors),
    }
}

// ---------- validate_artifacts ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateArtifactsRequest {
    session_id: String,
    artifacts: Value,
}

pub async fn validate_artifacts(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ValidateArtifactsRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let report = validate_topology_artifacts(&req.artifacts);
    if !report.ok {
        return fail_with_errors(report.errors);
    }
    ok_summary(json!({
        "valid": true,
        "errorCount": 0,
        "artifactNames": report.artifact_names,
    }))
}

// ---------- initialize ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    session_id: String,
    template_id: String,
    #[serde(default)]
    params: Value,
}

pub async fn initialize(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<InitializeRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let intent = InitializeIntent {
        template_id: req.template_id,
        params: req.params,
    };
    let (topology, summary) = match compute_initialize(&intent) {
        Ok(result) => result,
        Err(errors) => return fail_with_errors(errors),
    };

    // 计算 + 落库一步完成：替换该 session 的 P0 拓扑行并 mint mutationId。
    // initialize 不再返回 full topology（agent 用 inspect 查询切片），
    // 也不再依赖模型「记得」追加调用 apply_operations 才能落图。
    if let Err(message) = persist_initialized_topology(&state.pool, &req.session_id, &topology).await {
        return structured_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "PERSIST_FAILED",
            &message,
            true,
        );
    }

    let record = state
        .mutation_buffer
        .push(req.session_id.clone(), "topology".to_string());
    (state.emit)(record.clone());

    let mut summary_value = serde_json::to_value(&summary).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = summary_value {
        map.insert("sessionId".to_string(), Value::String(req.session_id));
        map.insert("mutationId".to_string(), json!(record.mutation_id));
        map.insert("persisted".to_string(), Value::Bool(true));
    }
    ok_summary(summary_value)
}

/// 把 initialize 计算出的 IntermediateTopology 重建到该 session 的 P0 表。
/// 映射规则与 backfill walker 对齐：imac = 100 + insert_order（按 numericId 升序），
/// sync_name = numericId，sync_type = {"_classPath": legacy_class_path}。
async fn persist_initialized_topology(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    topology: &IntermediateTopology,
) -> Result<(), String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    let conn: &mut sqlx::SqliteConnection = &mut tx;

    for table in ["topology_nodes", "topology_links", "topology_refs"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?"))
            .bind(session_id)
            .execute(&mut *conn)
            .await
            .map_err(|e| format!("{table} delete failed: {e}"))?;
    }

    let mut sorted_nodes: Vec<&crate::topology_intermediate::IntermediateNode> =
        topology.nodes.iter().collect();
    sorted_nodes.sort_by_key(|node| node.numeric_id);

    let mut imac_by_node_id: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (index, node) in sorted_nodes.iter().enumerate() {
        let imac = 100 + index as i64;
        let type_str = match node.node_type {
            IntermediateNodeType::Switch => "switch",
            IntermediateNodeType::EndSystem => "endSystem",
            IntermediateNodeType::Server => "server",
        };
        let sync_type = json!({ "_classPath": legacy_class_path(type_str) }).to_string();
        sqlx::query(
            r#"INSERT INTO topology_nodes
               (session_id, imac, sync_name, x, y, sync_type, node_type, insert_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(imac)
        .bind(node.numeric_id.to_string())
        .bind(node.position.x)
        .bind(node.position.y)
        .bind(&sync_type)
        .bind(legacy_node_type(type_str))
        .bind(index as i64)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("topology_nodes insert failed: {e}"))?;
        imac_by_node_id.insert(node.id.as_str(), imac);
    }

    let mut sorted_links: Vec<&crate::topology_intermediate::IntermediateLink> =
        topology.links.iter().collect();
    sorted_links.sort_by_key(|link| link.numeric_id);

    for (index, link) in sorted_links.iter().enumerate() {
        let src_imac = *imac_by_node_id
            .get(link.source.node_id.as_str())
            .ok_or_else(|| format!("link {} references unknown source node", link.id))?;
        let dst_imac = *imac_by_node_id
            .get(link.target.node_id.as_str())
            .ok_or_else(|| format!("link {} references unknown target node", link.id))?;
        let styles_json = json!({
            "leftLabel": link.source.port_id,
            "rightLabel": link.target.port_id,
            "speed": link.data_rate_mbps,
        })
        .to_string();
        sqlx::query(
            r#"INSERT INTO topology_links
               (session_id, link_seq, name, src_imac, dst_imac, styles_json)
               VALUES (?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(index as i64)
        .bind(&link.id)
        .bind(src_imac)
        .bind(dst_imac)
        .bind(&styles_json)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("topology_links insert failed: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("commit failed: {e}"))
}

// ---------- inspect ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    session_id: String,
}

/// DB-backed 全量 rows：agent 一次 inspect 拿到构造 ops batch 所需的全部细节
/// （imac/linkSeq/syncType/stylesJson 原文）。无 selector —— P0 表没有 string id，
/// 模型直接在 rows 里定位目标。出向规模有界：数据只能经 initialize（compute 校验
/// ≤200 节点）与 apply_operations（单批 ≤32 op）进入。
/// SQL 与排序镜像 `topology_query_command.rs`（UI 读路径），行 shape 直接复用其
/// serde camelCase struct，保证两条读路径零命名漂移。
pub async fn inspect(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<InspectRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    // nodes/links 两条 SELECT 包在同一只读事务里：并发 apply_operations commit
    // 落在两条查询之间时，响应不会出现「新节点已可见但链路还是旧的」撕裂快照。
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            )
        }
    };
    let node_rows = sqlx::query(
        r#"SELECT imac, sync_name, x, y, sync_type, node_type, insert_order
           FROM topology_nodes
           WHERE session_id = ?
           ORDER BY insert_order, imac"#,
    )
    .bind(&req.session_id)
    .fetch_all(&mut *tx)
    .await;
    let node_rows = match node_rows {
        Ok(rows) => rows,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            )
        }
    };
    let link_rows = sqlx::query(
        r#"SELECT link_seq, name, src_imac, dst_imac, styles_json
           FROM topology_links
           WHERE session_id = ?
           ORDER BY link_seq"#,
    )
    .bind(&req.session_id)
    .fetch_all(&mut *tx)
    .await;
    let link_rows = match link_rows {
        Ok(rows) => rows,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            )
        }
    };
    // 只读事务，commit 仅释放快照。
    let _ = tx.commit().await;

    let nodes: Vec<TopologyNodeRow> = node_rows
        .into_iter()
        .map(|r| TopologyNodeRow {
            imac: r.get("imac"),
            sync_name: r.get("sync_name"),
            x: r.get("x"),
            y: r.get("y"),
            sync_type: r.get("sync_type"),
            node_type: r.get("node_type"),
            insert_order: r.get("insert_order"),
        })
        .collect();
    let links: Vec<TopologyLinkRow> = link_rows
        .into_iter()
        .map(|r| TopologyLinkRow {
            link_seq: r.get("link_seq"),
            name: r.get("name"),
            src_imac: r.get("src_imac"),
            dst_imac: r.get("dst_imac"),
            styles_json: r.get("styles_json"),
        })
        .collect();

    ok_summary(json!({
        "sessionId": req.session_id,
        "nodeCount": nodes.len(),
        "linkCount": links.len(),
        "nodes": nodes,
        "links": links,
    }))
}

// ---------- validate ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRequest {
    session_id: String,
    #[serde(default)]
    topology: Option<Value>,
}

pub async fn validate(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ValidateRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    // 兼容：未传 topology 时，沿用 U4a-1 行为做 P0 表层 dangling link 检测。
    let Some(topology) = req.topology else {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let node_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = ?")
                .bind(&req.session_id)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(0);
        if node_count == 0 {
            warnings.push("topology has no nodes yet".to_string());
        }
        let dangling: Vec<(i64, i64)> = sqlx::query(
            r#"SELECT l.src_imac, l.dst_imac FROM topology_links l
               WHERE l.session_id = ?
                 AND (
                   NOT EXISTS (SELECT 1 FROM topology_nodes n
                               WHERE n.session_id = l.session_id AND n.imac = l.src_imac)
                   OR
                   NOT EXISTS (SELECT 1 FROM topology_nodes n
                               WHERE n.session_id = l.session_id AND n.imac = l.dst_imac)
                 )"#,
        )
        .bind(&req.session_id)
        .fetch_all(&state.pool)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|r| (r.get::<i64, _>("src_imac"), r.get::<i64, _>("dst_imac")))
                .collect()
        })
        .unwrap_or_default();
        for (src, dst) in dangling {
            errors.push(format!("link references missing node(s): {src}->{dst}"));
        }
        let ok = errors.is_empty();
        return (
            StatusCode::OK,
            Json(json!({
                "ok": ok,
                "summary": {
                    "valid": ok,
                    "errors": errors,
                    "warnings": warnings,
                    "source": "p0_tables",
                }
            })),
        )
            .into_response();
    };

    let report = validate_intermediate_topology(&topology);
    if !report.ok {
        return fail_with_errors(report.errors);
    }
    ok_summary(serde_json::to_value(&report.summary).unwrap_or(Value::Null))
}

// ---------- apply_operations ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsRequest {
    session_id: String,
    operations: Vec<TopologyOp>,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsResponse {
    ok: bool,
    summary: ApplyOpsSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsSummary {
    session_id: String,
    dry_run: bool,
    applied: Vec<crate::topology_ops::OpResultSummary>,
    /// 仅 commit 成功且非 dryRun 时有值；UI 用此 mutation_id 查 catch-up。
    mutation_id: Option<u64>,
}

/// 唯一的 operations 数量 enforcement 点（上限值沿用 MCP 层
/// `src/topology/limits.ts` 的 `maxOperations` 常量语义；MCP ingress 只校验
/// 字节数/深度），防止本机调用方提交超大批次占住写事务。
const MAX_OPERATIONS_PER_REQUEST: usize = 32;

pub async fn apply_operations(
    State(state): State<Arc<RouteState>>,
    raw: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    // 两段式解析（纵深防御）：语法级非法 JSON（extractor rejection）与形状级
    // 非法 op（serde 失败）都返回带合法 op 列表的结构化信封，而不是裸 422
    // "Unprocessable Entity"。正常路径模型在 MCP zod 层已被拦截，这里兜底
    // 直连 sidecar 的非法 payload。
    let raw = match raw {
        Ok(Json(value)) => value,
        Err(rejection) => {
            return structured_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_OPERATION",
                &format!(
                    "{} | 请求体必须是合法 JSON 对象，合法 op: node_add/node_update/node_delete/link_add/link_delete",
                    rejection.body_text()
                ),
                false,
            )
        }
    };
    let req: ApplyOpsRequest = match serde_json::from_value(raw) {
        Ok(req) => req,
        Err(e) => {
            return structured_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_OPERATION",
                &format!(
                    "{e} | 合法 op: node_add/node_update/node_delete/link_add/link_delete，字段见 apply_operations 工具 schema"
                ),
                false,
            )
        }
    };
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    // 空批次拒绝：空事务也会 mint mutationId 并触发 UI 无谓刷新（幽灵 mutation）。
    if req.operations.is_empty() {
        return structured_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LIMIT_EXCEEDED",
            "operations must not be empty; 先 inspect 再构造 batch",
            false,
        );
    }
    if req.operations.len() > MAX_OPERATIONS_PER_REQUEST {
        return structured_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LIMIT_EXCEEDED",
            &format!(
                "operations count {} exceeds the per-request maximum {}",
                req.operations.len(),
                MAX_OPERATIONS_PER_REQUEST
            ),
            false,
        );
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "BEGIN_FAILED",
            &e.to_string(),
            true,
        ),
    };

    let mut applied = Vec::with_capacity(req.operations.len());
    for op in &req.operations {
        match apply_op(&mut *tx, &req.session_id, op).await {
            Ok(s) => applied.push(s),
            Err(err) => {
                let _ = tx.rollback().await;
                return structured_error(
                    err.http_status(),
                    err.code(),
                    &err.message(),
                    // DATABASE_ERROR（SQLite 瞬时错误）可重试；业务错误不可。
                    err.is_retryable(),
                );
            }
        }
    }

    if req.dry_run {
        if let Err(e) = tx.rollback().await {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ROLLBACK_FAILED",
                &e.to_string(),
                true,
            );
        }
        return (
            StatusCode::OK,
            Json(ApplyOpsResponse {
                ok: true,
                summary: ApplyOpsSummary {
                    session_id: req.session_id,
                    dry_run: true,
                    applied,
                    mutation_id: None,
                },
            }),
        )
            .into_response();
    }

    if let Err(e) = tx.commit().await {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "COMMIT_FAILED",
            &e.to_string(),
            true,
        );
    }

    let record = state
        .mutation_buffer
        .push(req.session_id.clone(), "topology".to_string());
    (state.emit)(record.clone());
    (
        StatusCode::OK,
        Json(ApplyOpsResponse {
            ok: true,
            summary: ApplyOpsSummary {
                session_id: req.session_id,
                dry_run: false,
                applied,
                mutation_id: Some(record.mutation_id),
            },
        }),
    )
        .into_response()
}

// ---------- helpers ----------

async fn require_session(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<(), Response> {
    let count: i64 = match sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(pool)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            return Err(structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            ))
        }
    };
    if count == 0 {
        return Err(structured_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "FORBIDDEN_OPERATION",
            "session does not exist or not authorized",
            false,
        ));
    }
    Ok(())
}
