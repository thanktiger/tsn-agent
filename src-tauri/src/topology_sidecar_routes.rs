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

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::topology_backfill::legacy_node_type;
use crate::topology_compute::{
    InitializeIntent, build_topology_artifacts, describe_topology_artifacts,
    initialize_topology as compute_initialize, validate_intermediate_topology,
    validate_topology_artifacts,
};
use crate::topology_intermediate::{IntermediateNodeType, IntermediateTopology};
use crate::topology_mutation_buffer::{MutationRecord, TopologyMutationBuffer};
use crate::topology_ops::{TopologyOp, apply_op};
use crate::topology_query_command::{TopologyLinkRow, TopologyNodeRow};

/// 闭包形式的 mutation 发射器：生产用 Tauri AppHandle wrap，测试用 no-op。
/// 通过 trait object 解耦 runtime 泛型，避免 `RouteState` 被 `MockRuntime` 污染。
pub type MutationEmitFn = Arc<dyn Fn(MutationRecord) + Send + Sync>;

#[derive(Clone)]
pub struct RouteState {
    pub pool: sqlx::Pool<sqlx::Sqlite>,
    pub mutation_buffer: Arc<TopologyMutationBuffer>,
    pub emit: MutationEmitFn,
    /// U7：validate 廉价返回缓存——per-session「上次校验通过」的 mutationId。只在此路由层；
    /// 确认闸（verify_topology 命令走 load_and_verify_topology）够不着它、永远全量重算。
    pub last_validated_ok: Arc<Mutex<HashMap<String, u64>>>,
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
pub struct DescribeTemplatesRequest {
    session_id: String,
    /// R7：可选场景过滤——只返回该场景适用模板；省略返回全量。
    scenario: Option<String>,
}

pub async fn describe_templates(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<DescribeTemplatesRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    ok_summary(
        crate::topology_compute::describe_templates_catalog_filtered(req.scenario.as_deref()),
    )
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
    if let Err(message) =
        persist_initialized_topology(&state.pool, &req.session_id, &topology).await
    {
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
/// 节点键 sync_name = numericId；连线两端引用 sync_name。Qunee 专有的 imac/sync_type
/// 不再落库，需要时由 build_artifacts 从节点+node_type 现导。
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

    // 写前快照：在同事务、三表 DELETE 之前留 pre-image（整图重置可撤）。
    crate::topology_undo::snapshot_pre_image(&mut *conn, session_id)
        .await
        .map_err(|e| format!("undo snapshot failed: {e}"))?;

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

    let mut sync_name_by_node_id: std::collections::HashMap<&str, String> =
        std::collections::HashMap::new();
    for (index, node) in sorted_nodes.iter().enumerate() {
        let sync_name = node.numeric_id.to_string();
        let type_str = match node.node_type {
            IntermediateNodeType::Switch => "switch",
            IntermediateNodeType::EndSystem => "endSystem",
            IntermediateNodeType::Server => "server",
        };
        sqlx::query(
            r#"INSERT INTO topology_nodes
               (session_id, sync_name, name, x, y, node_type, insert_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(&sync_name)
        .bind(&node.name)
        .bind(node.position.x)
        .bind(node.position.y)
        .bind(legacy_node_type(type_str))
        .bind(index as i64)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("topology_nodes insert failed: {e}"))?;
        sync_name_by_node_id.insert(node.id.as_str(), sync_name);
    }

    let mut sorted_links: Vec<&crate::topology_intermediate::IntermediateLink> =
        topology.links.iter().collect();
    sorted_links.sort_by_key(|link| link.numeric_id);

    for (index, link) in sorted_links.iter().enumerate() {
        let src_sync_name = sync_name_by_node_id
            .get(link.source.node_id.as_str())
            .ok_or_else(|| format!("link {} references unknown source node", link.id))?
            .clone();
        let dst_sync_name = sync_name_by_node_id
            .get(link.target.node_id.as_str())
            .ok_or_else(|| format!("link {} references unknown target node", link.id))?
            .clone();
        let mut styles = json!({
            "leftLabel": link.source.port_id,
            "rightLabel": link.target.port_id,
            "speed": link.data_rate_mbps,
        });
        // R6：仅 Some 时写键——generic/存量链路不得出现 null 值键。
        if let Some(plane) = &link.plane {
            styles["plane"] = json!(plane);
        }
        if let Some(role) = &link.role {
            styles["role"] = json!(role);
        }
        let styles_json = styles.to_string();
        sqlx::query(
            r#"INSERT INTO topology_links
               (session_id, link_seq, name, src_sync_name, dst_sync_name, styles_json)
               VALUES (?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(index as i64)
        .bind(&link.id)
        .bind(&src_sync_name)
        .bind(&dst_sync_name)
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
/// （syncName/linkSeq/stylesJson 原文）。无 selector —— 模型直接在 rows 里按 syncName，
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
            );
        }
    };
    let node_rows = sqlx::query(
        r#"SELECT sync_name, name, x, y, node_type, insert_order
           FROM topology_nodes
           WHERE session_id = ?
           ORDER BY insert_order, sync_name"#,
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
            );
        }
    };
    let link_rows = sqlx::query(
        r#"SELECT link_seq, name, src_sync_name, dst_sync_name, styles_json
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
            );
        }
    };
    // 只读事务，commit 仅释放快照。
    let _ = tx.commit().await;

    let nodes: Vec<TopologyNodeRow> = node_rows
        .into_iter()
        .map(|r| TopologyNodeRow {
            sync_name: r.get("sync_name"),
            name: r.get("name"),
            x: r.get("x"),
            y: r.get("y"),
            node_type: r.get("node_type"),
            insert_order: r.get("insert_order"),
        })
        .collect();
    let links: Vec<TopologyLinkRow> = link_rows
        .into_iter()
        .map(|r| TopologyLinkRow {
            link_seq: r.get("link_seq"),
            name: r.get("name"),
            src_sync_name: r.get("src_sync_name"),
            dst_sync_name: r.get("dst_sync_name"),
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

// U7：validate 廉价返回的缓存判定（纯函数，便于单测）。缓存只在 sidecar validate 路由层、
// 只存「上次校验通过」的 mutationId。⚠️ 确认闸（verify_topology 命令）走 load_and_verify_topology、
// 够不着此缓存，永远全量重算——本判定不影响它。
fn validate_cache_hit(
    cache: &HashMap<String, u64>,
    session_id: &str,
    current: Option<u64>,
) -> bool {
    matches!(current, Some(c) if cache.get(session_id) == Some(&c))
}

fn validate_cache_record(
    cache: &mut HashMap<String, u64>,
    session_id: &str,
    valid: bool,
    current: Option<u64>,
) {
    match (valid, current) {
        // 仅「通过 + 当前 mutationId 可取」时记缓存；失败/变更/buffer 淘汰都清，绝不留 stale。
        (true, Some(c)) => {
            cache.insert(session_id.to_string(), c);
        }
        _ => {
            cache.remove(session_id);
        }
    }
}

pub async fn validate(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ValidateRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    // 未传 topology = 验**库内已落库**拓扑：跑与确认过关闸（verify_topology 命令）同一套完整
    // 结构校验（连通/端口配对/孤立/可达/角色/编号重复），让 agent 每次操作拓扑后调它就拿到
    // 与确认闸一致的中文结论、当场反馈给用户。带 topology 草稿则走下面的 schema 级校验。
    let Some(topology) = req.topology else {
        // U7：当前 mutationId（buffer 派生，淘汰/重启 → None → 全量）与「上次校验通过」相等且可取
        // 时，跳过全量重算直接回 valid。缓存只在路由层；确认闸走 load_and_verify_topology、永远全量。
        let current_mutation_id = state
            .mutation_buffer
            .latest_mutation_id_for_session(&req.session_id);
        if let Ok(cache) = state.last_validated_ok.lock()
            && validate_cache_hit(&cache, &req.session_id, current_mutation_id)
        {
            let summary = json!({
                "valid": true,
                "errors": [],
                "caliber": crate::topology_verify::CALIBER_STRUCTURAL_ONLY,
                "source": "p0_structural",
                "cached": true,
            });
            return (
                StatusCode::OK,
                Json(json!({ "ok": true, "summary": summary })),
            )
                .into_response();
        }
        let summary = match crate::topology_query_command::load_and_verify_topology(
            &state.pool,
            &req.session_id,
        )
        .await
        {
            Ok(result) => {
                if let Ok(mut cache) = state.last_validated_ok.lock() {
                    validate_cache_record(
                        &mut cache,
                        &req.session_id,
                        result.ok,
                        current_mutation_id,
                    );
                }
                json!({
                    "valid": result.ok,
                    "errors": result.errors.iter().map(|e| e.message_zh.clone()).collect::<Vec<_>>(),
                    "caliber": result.caliber,
                    "source": "p0_structural",
                })
            }
            Err(e) => {
                if let Ok(mut cache) = state.last_validated_ok.lock() {
                    validate_cache_record(&mut cache, &req.session_id, false, current_mutation_id);
                }
                json!({ "valid": false, "errors": [e], "source": "p0_structural" })
            }
        };
        let ok = summary
            .get("valid")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return (
            StatusCode::OK,
            Json(json!({ "ok": ok, "summary": summary })),
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
            );
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
            );
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
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "BEGIN_FAILED",
                &e.to_string(),
                true,
            );
        }
    };

    // 写前快照：在同事务、首个 apply_op 之前留 pre-image。dry-run 分支
    // rollback 时此快照随事务一并丢弃，无需额外清理（R4）。
    if let Err(e) = crate::topology_undo::snapshot_pre_image(&mut tx, &req.session_id).await {
        let _ = tx.rollback().await;
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATABASE_ERROR",
            &e.to_string(),
            true,
        );
    }

    let mut applied = Vec::with_capacity(req.operations.len());
    for op in &req.operations {
        match apply_op(&mut tx, &req.session_id, op).await {
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

// ---------- undo ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRequest {
    session_id: String,
}

/// 单步撤销：调撤销核心 `restore_pre_image`，有快照则盖回三表 + push + emit；
/// 无快照回结构化「无可撤销」（ok=true, undone=false）。两入口共用核心，
/// push/emit 留在调用点（KTD2/KTD4）；前端经 emit 信号全量 refetch（KTD5）。
pub async fn undo(State(state): State<Arc<RouteState>>, Json(req): Json<UndoRequest>) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    match crate::topology_undo::restore_pre_image(&state.pool, &req.session_id).await {
        Ok(true) => {
            let record = state
                .mutation_buffer
                .push(req.session_id.clone(), "topology".to_string());
            (state.emit)(record.clone());
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "undone": true,
                    "summary": {
                        "sessionId": req.session_id,
                        "mutationId": record.mutation_id,
                    },
                })),
            )
                .into_response()
        }
        Ok(false) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "undone": false,
                "summary": { "sessionId": req.session_id },
            })),
        )
            .into_response(),
        Err(e) => structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATABASE_ERROR",
            &e.to_string(),
            true,
        ),
    }
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
            ));
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

#[cfg(test)]
mod tests {
    use sqlx::Row;
    use sqlx::sqlite::SqlitePoolOptions;

    /// 逻辑节点名（agent 传入的 SW-1/ES-1）必须随 initialize 落库——丢弃会导致
    /// 聊天命名与画布派生名（前缀+全局序号）错位（ce-debug 2026-06-10）。
    #[test]
    fn persist_writes_logical_node_name_for_display() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
                .execute(&pool)
                .await
                .unwrap();

            let topology: crate::topology_intermediate::IntermediateTopology =
                serde_json::from_value(serde_json::json!({
                    "schemaVersion": "tsn-agent.topology.intermediate.v0",
                    "metadata": { "templateId": "dual-plane-redundant", "layout": "dual-plane", "source": "template" },
                    "nodes": [
                        { "id": "SW-1", "numericId": 0, "name": "SW-1", "type": "switch",
                          "ports": [], "position": { "x": 0.0, "y": 0.0 } },
                        { "id": "ES-1", "numericId": 1, "name": "ES-1", "type": "endSystem",
                          "ports": [], "position": { "x": 1.0, "y": 1.0 } }
                    ],
                    "links": [],
                    "diagnostics": []
                }))
                .unwrap();

            super::persist_initialized_topology(&pool, "s1", &topology)
                .await
                .unwrap();

            let names: Vec<Option<String>> = sqlx::query(
                "SELECT name FROM topology_nodes WHERE session_id = 's1' ORDER BY insert_order",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("name"))
            .collect();

            assert_eq!(
                names,
                vec![Some("SW-1".to_string()), Some("ES-1".to_string())]
            );
        });
    }

    #[test]
    fn persist_merges_plane_role_into_styles_json_only_when_present() {
        // R6/AE4：带 plane/role 的链路合并写入 styles_json；None 路径不得写键（null 也不行）。
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
                .execute(&pool)
                .await
                .unwrap();

            let topology: crate::topology_intermediate::IntermediateTopology =
                serde_json::from_value(serde_json::json!({
                    "schemaVersion": "tsn-agent.topology.intermediate.v0",
                    "metadata": { "templateId": "dual-plane-redundant", "layout": "dual-plane", "source": "template" },
                    "nodes": [
                        { "id": "sw1", "numericId": 0, "name": "SW-1", "type": "switch",
                          "ports": [{ "id": "P0", "name": "eth0", "index": 0 }, { "id": "P1", "name": "eth1", "index": 1 }],
                          "position": { "x": 0.0, "y": 0.0 } },
                        { "id": "es1", "numericId": 1, "name": "ES-1", "type": "endSystem",
                          "ports": [{ "id": "P0", "name": "eth0", "index": 0 }, { "id": "P1", "name": "eth1", "index": 1 }],
                          "position": { "x": 1.0, "y": 1.0 } }
                    ],
                    "links": [
                        { "id": "link-0", "numericId": 0,
                          "source": { "nodeId": "es1", "portId": "P0" },
                          "target": { "nodeId": "sw1", "portId": "P0" },
                          "medium": "ethernet", "dataRateMbps": 1000,
                          "plane": "A", "role": "access" },
                        { "id": "link-1", "numericId": 1,
                          "source": { "nodeId": "es1", "portId": "P1" },
                          "target": { "nodeId": "sw1", "portId": "P1" },
                          "medium": "ethernet", "dataRateMbps": 1000 }
                    ],
                    "diagnostics": []
                }))
                .unwrap();

            super::persist_initialized_topology(&pool, "s1", &topology)
                .await
                .unwrap();

            let styles: Vec<String> = sqlx::query(
                "SELECT styles_json FROM topology_links WHERE session_id = 's1' ORDER BY link_seq",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("styles_json"))
            .collect();
            let with_plane: serde_json::Value = serde_json::from_str(&styles[0]).unwrap();
            assert_eq!(with_plane["plane"], "A");
            assert_eq!(with_plane["role"], "access");
            assert_eq!(with_plane["leftLabel"], "P0");
            assert_eq!(with_plane["speed"], 1000);
            let without_plane: serde_json::Value = serde_json::from_str(&styles[1]).unwrap();
            assert!(
                without_plane.get("plane").is_none(),
                "None 路径不得写 plane 键"
            );
            assert!(
                without_plane.get("role").is_none(),
                "None 路径不得写 role 键"
            );
        });
    }

    // U7：廉价返回缓存判定（纯函数）。
    #[test]
    fn validate_cache_hit_only_when_current_matches_recorded() {
        let mut cache = std::collections::HashMap::new();
        // 边界：buffer 淘汰/重启 → current None → 永远 miss（保守全量）。
        assert!(!super::validate_cache_hit(&cache, "s1", None));
        // 未记录 → miss。
        assert!(!super::validate_cache_hit(&cache, "s1", Some(5)));
        cache.insert("s1".to_string(), 5u64);
        // 正例：稳定态、current == 已记 → hit（走廉价）。
        assert!(super::validate_cache_hit(&cache, "s1", Some(5)));
        // 负例：一次 mutation 后 current 变 6 → miss（全量重算、不误用旧结论）。
        assert!(!super::validate_cache_hit(&cache, "s1", Some(6)));
        // 有记录但 current None（淘汰）→ miss。
        assert!(!super::validate_cache_hit(&cache, "s1", None));
    }

    #[test]
    fn validate_cache_record_caches_only_valid_with_known_mutation() {
        let mut cache = std::collections::HashMap::new();
        // 通过 + 已知 mutationId → 记。
        super::validate_cache_record(&mut cache, "s1", true, Some(7));
        assert_eq!(cache.get("s1"), Some(&7));
        // 失败 → 清（不把失败态缓存成「通过」）。
        super::validate_cache_record(&mut cache, "s1", false, Some(8));
        assert_eq!(cache.get("s1"), None);
        // 通过但 mutationId 不可取（淘汰）→ 不记（避免无版本戳的 stale 命中）。
        super::validate_cache_record(&mut cache, "s1", true, None);
        assert_eq!(cache.get("s1"), None);
        // 变更后重新通过 → 更新到新 mutationId。
        super::validate_cache_record(&mut cache, "s1", true, Some(9));
        assert_eq!(cache.get("s1"), Some(&9));
    }
}
