//! Plan 2026-06-24-001 U7：timesync 写库 sidecar route（每次写都重算整树落库）。
//!
//! 4 个 `/db/timesync/*` route，复用 topology sidecar 同一 `RouteState`、同一
//! Bearer/session middleware：
//! - `set_gm`：设 `timesync_domain.gm_mid`（+ one_step_mode/fre_switch 可选）→ 调
//!   `timesync_tree::compute_clock_tree` 重算 → 全量覆盖写 `timesync_nodes`（端口角色
//!   + 同步参数，参数缺省补默认值）→ upsert `timesync_domain`。
//! - `set_params`：改某节点或全局同步参数，不重算端口角色。
//! - `toggle_link`：增删 `disabled_link_seqs` 某 link_seq → 重算 → 全量覆盖写。
//! - `inspect`：读当前 domain + nodes 给 agent。
//!
//! 写 handler 范式：先在 pool 上重算（compute_clock_tree 是只读纯函数），再开事务做
//! 「upsert domain + 全量覆盖 timesync_nodes」一气呵成 commit，最后 push mutation
//! （domain="timesync"）+ emit（仿 topology_position_command）。三态写入幂等——同输入
//! 重放产生同一落库行、不报错（全量覆盖天然幂等；upsert 用 ON CONFLICT DO UPDATE）。
//!
//! SQL 全在 Rust（MCP 只发领域 JSON，U10 做）；undo 写前 snapshot 留给 U8。

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

use crate::timesync_tree::{NodePortRoles, compute_clock_tree};
use crate::topology_sidecar_routes::{RouteState, ok_summary, require_session, structured_error};

/// 同步参数默认值（用户只给 GM 不给参数时补全；R10）。取合理 2^n：
/// sync_period=128ms (2^7)、measure_period=1024ms (2^10)；report_enable 默认开；
/// mean_link_delay_thresh=64 (2^6，落在取值域 2^n、n=0..7、max 128 内)；
/// offset_threshold 给经验默认（整数阈值，取值域 0..4095）。
const DEFAULT_SYNC_PERIOD: i64 = 128;
const DEFAULT_MEASURE_PERIOD: i64 = 1024;
const DEFAULT_REPORT_ENABLE: i64 = 1;
const DEFAULT_MEAN_LINK_DELAY_THRESH: i64 = 64;
const DEFAULT_OFFSET_THRESHOLD: i64 = 1000;

/// timesync_nodes 一行的同步参数（落库时缺省补默认）。
#[derive(Debug, Clone)]
struct SyncParams {
    sync_period: i64,
    measure_period: i64,
    report_enable: i64,
    mean_link_delay_thresh: i64,
    offset_threshold: i64,
}

impl Default for SyncParams {
    fn default() -> Self {
        Self {
            sync_period: DEFAULT_SYNC_PERIOD,
            measure_period: DEFAULT_MEASURE_PERIOD,
            report_enable: DEFAULT_REPORT_ENABLE,
            mean_link_delay_thresh: DEFAULT_MEAN_LINK_DELAY_THRESH,
            offset_threshold: DEFAULT_OFFSET_THRESHOLD,
        }
    }
}

/// 读该 session 当前 domain 行（无则给默认空 domain）。
struct DomainState {
    gm_mid: Option<String>,
    one_step_mode: i64,
    fre_switch: i64,
    disabled_link_seqs: Vec<i64>,
}

async fn load_domain(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<DomainState, String> {
    let row = sqlx::query(
        "SELECT gm_mid, one_step_mode, fre_switch, disabled_link_seqs \
         FROM timesync_domain WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("load timesync_domain failed: {e}"))?;

    Ok(match row {
        Some(r) => {
            let raw: String = r.get("disabled_link_seqs");
            DomainState {
                gm_mid: r.get("gm_mid"),
                one_step_mode: r.get("one_step_mode"),
                fre_switch: r.get("fre_switch"),
                disabled_link_seqs: serde_json::from_str(&raw).unwrap_or_default(),
            }
        }
        None => DomainState {
            gm_mid: None,
            one_step_mode: 0,
            fre_switch: 0,
            disabled_link_seqs: Vec::new(),
        },
    })
}

/// 读该 session 现有 timesync_nodes 的同步参数（mid → SyncParams），供重算覆盖写时
/// 保留用户已设的参数（端口角色重算覆盖，但参数不丢）。缺列（NULL）按默认。
async fn load_existing_params(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<std::collections::HashMap<String, SyncParams>, String> {
    let rows = sqlx::query(
        "SELECT mid, sync_period, measure_period, report_enable, \
         mean_link_delay_thresh, offset_threshold FROM timesync_nodes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("load timesync_nodes failed: {e}"))?;

    let def = SyncParams::default();
    Ok(rows
        .into_iter()
        .map(|r| {
            let mid: String = r.get("mid");
            let params = SyncParams {
                sync_period: r
                    .get::<Option<i64>, _>("sync_period")
                    .unwrap_or(def.sync_period),
                measure_period: r
                    .get::<Option<i64>, _>("measure_period")
                    .unwrap_or(def.measure_period),
                report_enable: r
                    .get::<Option<i64>, _>("report_enable")
                    .unwrap_or(def.report_enable),
                mean_link_delay_thresh: r
                    .get::<Option<i64>, _>("mean_link_delay_thresh")
                    .unwrap_or(def.mean_link_delay_thresh),
                offset_threshold: r
                    .get::<Option<i64>, _>("offset_threshold")
                    .unwrap_or(def.offset_threshold),
            };
            (mid, params)
        })
        .collect())
}

/// 在事务内：upsert timesync_domain + 全量覆盖 timesync_nodes（端口角色来自重算的
/// `per_node`，同步参数取 existing[mid] 否则默认）。全量覆盖天然幂等。
#[allow(clippy::too_many_arguments)]
async fn persist_domain_and_nodes(
    conn: &mut sqlx::SqliteConnection,
    session_id: &str,
    domain: &DomainState,
    per_node: &[NodePortRoles],
    existing_params: &std::collections::HashMap<String, SyncParams>,
) -> Result<(), String> {
    let disabled_json =
        serde_json::to_string(&domain.disabled_link_seqs).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        r#"INSERT INTO timesync_domain
           (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             gm_mid = excluded.gm_mid,
             one_step_mode = excluded.one_step_mode,
             fre_switch = excluded.fre_switch,
             disabled_link_seqs = excluded.disabled_link_seqs"#,
    )
    .bind(session_id)
    .bind(&domain.gm_mid)
    .bind(domain.one_step_mode)
    .bind(domain.fre_switch)
    .bind(&disabled_json)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("upsert timesync_domain failed: {e}"))?;

    // 全量覆盖：先清旧 timesync_nodes，再按重算结果逐节点写入。
    sqlx::query("DELETE FROM timesync_nodes WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("delete timesync_nodes failed: {e}"))?;

    for node in per_node {
        let params = existing_params.get(&node.mid).cloned().unwrap_or_default();
        let master_json = serde_json::to_string(&node.master_port).unwrap_or_else(|_| "[]".into());
        let slave_json = serde_json::to_string(&node.slave_port).unwrap_or_else(|_| "[]".into());
        let ptp_json =
            serde_json::to_string(&node.port_ptp_enabled).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            r#"INSERT INTO timesync_nodes
               (session_id, mid, master_port, slave_port, port_ptp_enabled,
                sync_period, measure_period, report_enable,
                mean_link_delay_thresh, offset_threshold)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(&node.mid)
        .bind(&master_json)
        .bind(&slave_json)
        .bind(&ptp_json)
        .bind(params.sync_period)
        .bind(params.measure_period)
        .bind(params.report_enable)
        .bind(params.mean_link_delay_thresh)
        .bind(params.offset_threshold)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("insert timesync_nodes failed: {e}"))?;
    }
    Ok(())
}

/// 重算整树 + 全量覆盖落库 + push/emit 的公共收口（set_gm / toggle_link 共用）。
/// gm_mid 为 None/空时不重算（无 GM 无树）：仅 upsert domain、清空 timesync_nodes。
async fn recompute_and_persist(
    state: &Arc<RouteState>,
    session_id: &str,
    domain: DomainState,
) -> Response {
    let per_node: Vec<NodePortRoles> = match domain.gm_mid.as_deref() {
        Some(gm) if !gm.is_empty() => {
            match compute_clock_tree(&state.pool, session_id, gm, &domain.disabled_link_seqs).await
            {
                Ok(tree) => tree.per_node,
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
        _ => Vec::new(),
    };

    let existing_params = match load_existing_params(&state.pool, session_id).await {
        Ok(m) => m,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e,
                true,
            );
        }
    };

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
    // 写前快照：在同事务、全量覆盖两表之前留 pre-image（单步撤销 domain="timesync"）。
    if let Err(e) = crate::topology_undo::snapshot_pre_image(
        &mut tx,
        session_id,
        crate::topology_undo::TIMESYNC_DOMAIN,
    )
    .await
    {
        let _ = tx.rollback().await;
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATABASE_ERROR",
            &e.to_string(),
            true,
        );
    }
    if let Err(e) =
        persist_domain_and_nodes(&mut tx, session_id, &domain, &per_node, &existing_params).await
    {
        let _ = tx.rollback().await;
        return structured_error(StatusCode::UNPROCESSABLE_ENTITY, "PERSIST_FAILED", &e, true);
    }
    if let Err(e) = tx.commit().await {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "COMMIT_FAILED",
            &e.to_string(),
            true,
        );
    }

    push_and_summary(state, session_id, json!({ "nodeCount": per_node.len() }))
}

/// push mutation(domain="timesync") + emit，组装成功信封。
fn push_and_summary(state: &Arc<RouteState>, session_id: &str, mut extra: Value) -> Response {
    let record = state
        .mutation_buffer
        .push(session_id.to_string(), "timesync".to_string());
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

// ---------- set_gm ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGmRequest {
    session_id: String,
    gm_mid: String,
    #[serde(default)]
    one_step_mode: Option<i64>,
    #[serde(default)]
    fre_switch: Option<i64>,
}

pub async fn set_gm(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<SetGmRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let mut domain = match load_domain(&state.pool, &req.session_id).await {
        Ok(d) => d,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e,
                true,
            );
        }
    };
    domain.gm_mid = Some(req.gm_mid);
    if let Some(v) = req.one_step_mode {
        domain.one_step_mode = v;
    }
    if let Some(v) = req.fre_switch {
        domain.fre_switch = v;
    }
    recompute_and_persist(&state, &req.session_id, domain).await
}

// ---------- toggle_link ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleLinkRequest {
    session_id: String,
    link_seq: i64,
    /// true=禁用（加入 disabled 集），false=启用（移除）。
    disabled: bool,
}

pub async fn toggle_link(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ToggleLinkRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let mut domain = match load_domain(&state.pool, &req.session_id).await {
        Ok(d) => d,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e,
                true,
            );
        }
    };
    // 幂等：禁用已禁用 / 启用未禁用都是 no-op（集合语义）。维持升序去重。
    let mut set: std::collections::BTreeSet<i64> =
        domain.disabled_link_seqs.iter().copied().collect();
    if req.disabled {
        set.insert(req.link_seq);
    } else {
        set.remove(&req.link_seq);
    }
    domain.disabled_link_seqs = set.into_iter().collect();
    recompute_and_persist(&state, &req.session_id, domain).await
}

// ---------- set_params ----------

/// 同步参数补丁（仅提供字段更新；不重算端口角色）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetParamsRequest {
    session_id: String,
    /// 目标节点 mid；省略则对全部 timesync_nodes 应用（全局改参数）。
    #[serde(default)]
    mid: Option<String>,
    #[serde(default)]
    sync_period: Option<i64>,
    #[serde(default)]
    measure_period: Option<i64>,
    #[serde(default)]
    report_enable: Option<i64>,
    #[serde(default)]
    mean_link_delay_thresh: Option<i64>,
    #[serde(default)]
    offset_threshold: Option<i64>,
}

pub async fn set_params(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<SetParamsRequest>,
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

    // 写前快照：在同事务、UPDATE 之前留 pre-image（单步撤销 domain="timesync"）。
    if let Err(e) = crate::topology_undo::snapshot_pre_image(
        &mut tx,
        &req.session_id,
        crate::topology_undo::TIMESYNC_DOMAIN,
    )
    .await
    {
        let _ = tx.rollback().await;
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATABASE_ERROR",
            &e.to_string(),
            true,
        );
    }

    // COALESCE 只在提供字段时更新，端口角色列不动。mid 省略 → 作用全部节点。
    let result = sqlx::query(
        r#"UPDATE timesync_nodes SET
             sync_period = COALESCE(?, sync_period),
             measure_period = COALESCE(?, measure_period),
             report_enable = COALESCE(?, report_enable),
             mean_link_delay_thresh = COALESCE(?, mean_link_delay_thresh),
             offset_threshold = COALESCE(?, offset_threshold)
           WHERE session_id = ? AND (? IS NULL OR mid = ?)"#,
    )
    .bind(req.sync_period)
    .bind(req.measure_period)
    .bind(req.report_enable)
    .bind(req.mean_link_delay_thresh)
    .bind(req.offset_threshold)
    .bind(&req.session_id)
    .bind(&req.mid)
    .bind(&req.mid)
    .execute(&mut *tx)
    .await;

    let rows_affected = match result {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            let _ = tx.rollback().await;
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            );
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

    push_and_summary(
        &state,
        &req.session_id,
        json!({ "rowsAffected": rows_affected }),
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
    let domain = match load_domain(&state.pool, &req.session_id).await {
        Ok(d) => d,
        Err(e) => {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e,
                true,
            );
        }
    };

    let node_rows = sqlx::query(
        r#"SELECT mid, master_port, slave_port, port_ptp_enabled,
                  sync_period, measure_period, report_enable,
                  mean_link_delay_thresh, offset_threshold
           FROM timesync_nodes WHERE session_id = ? ORDER BY mid"#,
    )
    .bind(&req.session_id)
    .fetch_all(&state.pool)
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

    let parse_arr = |s: String| -> Value {
        serde_json::from_str::<Vec<i64>>(&s)
            .map(|v| json!(v))
            .unwrap_or_else(|_| json!([]))
    };
    let nodes: Vec<Value> = node_rows
        .into_iter()
        .map(|r| {
            json!({
                "mid": r.get::<String, _>("mid"),
                "masterPort": parse_arr(r.get::<String, _>("master_port")),
                "slavePort": parse_arr(r.get::<String, _>("slave_port")),
                "portPtpEnabled": parse_arr(r.get::<String, _>("port_ptp_enabled")),
                "syncPeriod": r.get::<Option<i64>, _>("sync_period"),
                "measurePeriod": r.get::<Option<i64>, _>("measure_period"),
                "reportEnable": r.get::<Option<i64>, _>("report_enable"),
                "meanLinkDelayThresh": r.get::<Option<i64>, _>("mean_link_delay_thresh"),
                "offsetThreshold": r.get::<Option<i64>, _>("offset_threshold"),
            })
        })
        .collect();

    ok_summary(json!({
        "sessionId": req.session_id,
        "domain": {
            "gmMid": domain.gm_mid,
            "oneStepMode": domain.one_step_mode,
            "freSwitch": domain.fre_switch,
            "disabledLinkSeqs": domain.disabled_link_seqs,
        },
        "nodeCount": nodes.len(),
        "nodes": nodes,
    }))
}

// ---------- undo ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRequest {
    session_id: String,
}

/// 单步撤销 timesync 写：复用撤销核心 `restore_pre_image` 传 domain="timesync"，
/// 有快照则盖回 timesync 两表 + push(domain="timesync") + emit；无快照回
/// 「无可撤销」（ok=true, undone=false）。盖回严格只碰 timesync 表，不动 topology。
pub async fn undo(State(state): State<Arc<RouteState>>, Json(req): Json<UndoRequest>) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    match crate::topology_undo::restore_pre_image(
        &state.pool,
        &req.session_id,
        crate::topology_undo::TIMESYNC_DOMAIN,
    )
    .await
    {
        Ok(true) => push_and_summary(&state, &req.session_id, json!({ "undone": true })),
        Ok(false) => ok_summary(json!({
            "sessionId": req.session_id,
            "undone": false,
        })),
        Err(e) => structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DATABASE_ERROR",
            &e.to_string(),
            true,
        ),
    }
}

#[cfg(test)]
mod tests {
    use crate::topology_mutation_buffer::TopologyMutationBuffer;
    use crate::topology_sidecar::SecretToken;
    use crate::topology_sidecar::build_test_router_with_pool;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use serde_json::json;
    use sqlx::Row;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;
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

    /// 线性 0—1—2，GM=0：seed 拓扑。0.p0—1.p0；1.p1—2.p0。
    async fn seed_linear(pool: &sqlx::Pool<sqlx::Sqlite>) {
        for (i, m) in ["0", "1", "2"].iter().enumerate() {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, ?)")
                .bind(m).bind(i as i64).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '0', '1', 0, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 1, NULL, '1', '2', 1, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
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

    /// set_gm → timesync_nodes 端口角色按新 GM 重算落库（线性 0—1—2，GM=0）。
    #[test]
    fn set_gm_recomputes_and_persists_port_roles() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["nodeCount"], 3);
            assert_eq!(parsed["summary"]["mutationId"], 1);

            // domain 落库 gm_mid=0。
            let gm: Option<String> =
                sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(gm.as_deref(), Some("0"));

            // 节点 1：slave 朝父(0)=端口0、master 朝子(2)=端口1。
            let row = sqlx::query(
                "SELECT master_port, slave_port, sync_period FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<String, _>("master_port"), "[1]");
            assert_eq!(row.get::<String, _>("slave_port"), "[0]");
            // 缺省补默认 sync_period。
            assert_eq!(
                row.get::<Option<i64>, _>("sync_period"),
                Some(super::DEFAULT_SYNC_PERIOD)
            );

            // GM(0)：master=[0]、slave=[]。
            let row0 = sqlx::query(
                "SELECT master_port, slave_port FROM timesync_nodes WHERE session_id='s1' AND mid='0'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row0.get::<String, _>("master_port"), "[0]");
            assert_eq!(row0.get::<String, _>("slave_port"), "[]");

            // mutation 推进（domain=timesync）。
            assert_eq!(buf.since("s1", 0).latest, 1);
        });
    }

    /// 重试同 set_gm 幂等：第二次产生同一落库行，不报错。
    #[test]
    fn set_gm_replay_is_idempotent() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            for _ in 0..2 {
                let (status, parsed) = post(
                    router.clone(),
                    &token,
                    "/db/timesync/set_gm",
                    json!({ "sessionId": "s1", "gmMid": "0" }),
                )
                .await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(parsed["ok"], true);
            }

            // 不累积行：全量覆盖 → 仍是 3 节点。
            let n: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM timesync_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(n, 3);
            let d: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM timesync_domain WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(d, 1);
        });
    }

    /// toggle_link 禁用一条 → 端口角色变化、disabled_link_seqs 含该 seq；再 toggle 取消 → 恢复。
    #[test]
    fn toggle_link_disables_and_re_enables() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            // 先设 GM。
            post(
                router.clone(),
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;

            // 禁用 1—2(seq=1)：2 失去唯一路径 → uncovered；1.port1 passive、master 丢失。
            let (status, _) = post(
                router.clone(),
                &token,
                "/db/timesync/toggle_link",
                json!({ "sessionId": "s1", "linkSeq": 1, "disabled": true }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);

            let disabled: String = sqlx::query_scalar(
                "SELECT disabled_link_seqs FROM timesync_domain WHERE session_id='s1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(disabled, "[1]");
            // 节点 1 禁用后 master 丢失（子树重算）。
            let m1: String = sqlx::query_scalar(
                "SELECT master_port FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(m1, "[]", "禁用 1—2 后节点1 不再有 master");

            // 取消禁用 → 恢复 master=[1]、disabled 集空。
            let (status, _) = post(
                router.clone(),
                &token,
                "/db/timesync/toggle_link",
                json!({ "sessionId": "s1", "linkSeq": 1, "disabled": false }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let disabled2: String = sqlx::query_scalar(
                "SELECT disabled_link_seqs FROM timesync_domain WHERE session_id='s1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(disabled2, "[]");
            let m1b: String = sqlx::query_scalar(
                "SELECT master_port FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(m1b, "[1]", "取消禁用后节点1 恢复 master");
        });
    }

    /// set_params → 参数列更新、端口角色不变。
    #[test]
    fn set_params_updates_params_keeps_roles() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            post(
                router.clone(),
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;
            let roles_before: String = sqlx::query_scalar(
                "SELECT master_port FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();

            // 全局改 sync_period=256（mid 省略 → 全部节点）。
            let (status, _) = post(
                router.clone(),
                &token,
                "/db/timesync/set_params",
                json!({ "sessionId": "s1", "syncPeriod": 256 }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);

            let rows = sqlx::query(
                "SELECT master_port, sync_period FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(rows.get::<Option<i64>, _>("sync_period"), Some(256));
            assert_eq!(
                rows.get::<String, _>("master_port"),
                roles_before,
                "set_params 不动端口角色"
            );

            // 单节点改 offset_threshold。
            post(
                router.clone(),
                &token,
                "/db/timesync/set_params",
                json!({ "sessionId": "s1", "mid": "2", "offsetThreshold": 500 }),
            )
            .await;
            let ot2: Option<i64> = sqlx::query_scalar(
                "SELECT offset_threshold FROM timesync_nodes WHERE session_id='s1' AND mid='2'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(ot2, Some(500));
            // 节点 0/1 的 offset_threshold 不受单节点更新影响（仍为默认）。
            let ot0: Option<i64> = sqlx::query_scalar(
                "SELECT offset_threshold FROM timesync_nodes WHERE session_id='s1' AND mid='0'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(ot0, Some(super::DEFAULT_OFFSET_THRESHOLD));
        });
    }

    /// set_params 改的参数在后续 set_gm 重算覆盖端口角色时不丢失。
    #[test]
    fn set_params_preserved_across_recompute() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            post(
                router.clone(),
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;
            post(
                router.clone(),
                &token,
                "/db/timesync/set_params",
                json!({ "sessionId": "s1", "syncPeriod": 256 }),
            )
            .await;
            // 换 GM 触发重算覆盖端口角色；参数应保留。
            post(
                router.clone(),
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "2" }),
            )
            .await;

            let sp: Option<i64> = sqlx::query_scalar(
                "SELECT sync_period FROM timesync_nodes WHERE session_id='s1' AND mid='1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(sp, Some(256), "重算覆盖端口角色但保留用户参数");
        });
    }

    /// inspect 返回当前 domain + nodes 配置。
    #[test]
    fn inspect_returns_current_config() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            post(
                router.clone(),
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;

            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/inspect",
                json!({ "sessionId": "s1" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            let summary = &parsed["summary"];
            assert_eq!(summary["domain"]["gmMid"], "0");
            assert_eq!(summary["nodeCount"], 3);
            let nodes = summary["nodes"].as_array().unwrap();
            // 按 mid 排序，节点1 端口角色。
            let n1 = nodes.iter().find(|n| n["mid"] == "1").unwrap();
            assert_eq!(n1["masterPort"], json!([1]));
            assert_eq!(n1["slavePort"], json!([0]));
            assert_eq!(n1["syncPeriod"], super::DEFAULT_SYNC_PERIOD);
        });
    }

    /// inspect 无 timesync 配置时返回空 domain + 空 nodes。
    #[test]
    fn inspect_empty_when_no_config() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            // 需要先建 session。
            // test_state 已插 s1。
            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/inspect",
                json!({ "sessionId": "s1" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert!(parsed["summary"]["domain"]["gmMid"].is_null());
            assert_eq!(parsed["summary"]["nodeCount"], 0);
        });
    }

    /// 未知 session → FORBIDDEN_OPERATION。
    #[test]
    fn set_gm_rejects_unknown_session() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "ghost", "gmMid": "0" }),
            )
            .await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(parsed["code"], "FORBIDDEN_OPERATION");
        });
    }

    /// set_gm(写前快照) → 再 set_gm 改 GM → undo 盖回前一态、topology 两表不动。
    #[test]
    fn undo_restores_prior_timesync_state_without_touching_topology() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            seed_linear(&pool).await;

            // 拓扑两表的当前态（撤销后必须一行不动）。
            let topo_nodes: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let topo_links: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            // 第一次 set_gm=0（建立 timesync 落库）。
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;
            let (status, _) = post(
                router,
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "0" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);

            // 第二次 set_gm=2（pre-image 留 GM=0 态）→ 落库变 GM=2。
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;
            let (status, _) = post(
                router,
                &token,
                "/db/timesync/set_gm",
                json!({ "sessionId": "s1", "gmMid": "2" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let gm: Option<String> =
                sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(gm.as_deref(), Some("2"), "第二次写后 GM=2");

            // undo → 盖回 GM=0 态。
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;
            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/undo",
                json!({ "sessionId": "s1" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["undone"], true);
            let gm: Option<String> =
                sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(gm.as_deref(), Some("0"), "undo 盖回 GM=0 前态");

            // topology 两表一行不动。
            let topo_nodes_after: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let topo_links_after: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(topo_nodes_after, topo_nodes, "undo 不碰 topology_nodes");
            assert_eq!(topo_links_after, topo_links, "undo 不碰 topology_links");

            // 再 undo 返 undone=false（R11）。
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;
            let (status, parsed) = post(
                router,
                &token,
                "/db/timesync/undo",
                json!({ "sessionId": "s1" }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["summary"]["undone"], false, "再撤无可撤");
        });
    }
}
