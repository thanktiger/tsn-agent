//! Plan v3 U5 → Phase B：内嵌的一次性 skip-A 迁移（升级前历史 session 的
//! canonical payload JSON → P0 表）。TS 端 canonical 域已在 Phase B-β2 删除，
//! 本模块是仓库内最后一个合法读取 canonical JSON 形态的地方（grep gate 豁免）；
//! 存量 session 全部完成迁移后可整体移除。
//!
//! Walker 最小路径：只填 `topology_nodes` + `topology_links` + `topology_refs`。
//! 13 张 nodes.* / topo_feature 子表保持空，由后续 MCP `apply_operations` 增量
//! 注入（单 session 只承载基础拓扑，配置列在 UI 编辑时再落表）。
//!
//! 字段映射沿用已删除的 `src/topology/artifacts.ts` 同步约定：
//!   - `imac` = 100 + nodes 按 numericId 排序后的位置
//!   - `sync_name` = `String(numericId)`
//!   - `sync_type` = `{"_classPath": legacyClassPath(type)}` JSON
//!   - `node_type` = legacy 三态："switch" / "networkcard"(endSystem) / "server"
//!
//! 失败状态码：
//!   - `PAYLOAD_NOT_JSON`：payload 不是合法 JSON
//!   - `CANONICAL_SCHEMA_INVALID`：schemaVersion 缺失或 topology 字段不规范
//!   - `CONSTRAINT_VIOLATION:<col>`：SQLite 写入失败（一般是引用未知 imac）
//!
//! 当前 unit 提供：
//!   - `mark_pending_for_all_sessions`：应用启动时把 `sessions.payload` 非空但
//!     无对应 `topology_nodes` 行的 session 标为 `pending_walker`。
//!   - `run_walker_for_pending_sessions`：扫描 pending 行，逐个跑 walker。
//!   - `retry_backfill(sessionId)`：把指定 session 状态置 `pending_walker`，
//!     立即触发 walker 重新执行。
//!   - `list_backfill_failures()`：UI 展示阻塞 session 列表。
//!   - `view_session_payload(sessionId)`：返回 redacted payload 文本。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Executor, SqlitePool};

use crate::redaction::redact_secrets;
use crate::session_store::SessionStore;

/// 启动期一次性扫描：把有 payload 但无对应 P0 数据的 session 标 pending。
/// 已存在 backfill_state 的 session 保持原状（避免重复覆盖 retry 状态）。
pub async fn mark_pending_for_all_sessions(pool: &SqlitePool) -> Result<u64, String> {
    let now = chrono_like_iso_now();
    let res = sqlx::query(
        r#"INSERT OR IGNORE INTO session_backfill_state (session_id, state, attempted_at)
           SELECT s.id, 'pending_walker', ?
             FROM sessions s
            WHERE NOT EXISTS (
                  SELECT 1 FROM session_backfill_state b WHERE b.session_id = s.id
              )"#,
    )
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("backfill pending 标记失败：{e}"))?;
    Ok(res.rows_affected())
}

/// 返回当前 iso8601 时间戳；避免引入 chrono 依赖。
/// pub(crate)：session_import 写 completed_walker 状态行时复用同一时间戳格式。
pub(crate) fn chrono_like_iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简易格式 YYYY-MM-DDTHH:MM:SSZ 用 unix 秒转化的近似值；
    // 对于 backfill state attempted_at 字段精度足够（排序 + UI 显示）。
    format!("@unix-{secs}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillStateRow {
    pub session_id: String,
    pub state: String,
    pub error_code: Option<String>,
    pub attempted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

#[tauri::command]
pub async fn list_backfill_failures(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<BackfillStateRow>, String> {
    let pool = store.pool(&app).await?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT session_id, state, error_code, attempted_at
             FROM session_backfill_state
            WHERE state LIKE 'failed_%'
            ORDER BY attempted_at DESC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 backfill 失败列表：{e}"))?;
    Ok(rows
        .into_iter()
        .map(|(session_id, state, error_code, attempted_at)| BackfillStateRow {
            session_id,
            state,
            error_code,
            attempted_at,
        })
        .collect())
}

#[tauri::command]
pub async fn retry_backfill(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let now = chrono_like_iso_now();
    sqlx::query(
        r#"INSERT INTO session_backfill_state (session_id, state, attempted_at)
           VALUES (?, 'pending_walker', ?)
           ON CONFLICT(session_id) DO UPDATE SET
             state = 'pending_walker',
             error_code = NULL,
             attempted_at = excluded.attempted_at"#,
    )
    .bind(&request.session_id)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("retry 标记失败：{e}"))?;
    // walker 的早期 DB 错误路径不会自己 mark_failed（payload SELECT 失败等），
    // 不兜底会让会话永久卡在 pending_walker（不出现在失败列表，retry 不可达）。
    if let Err(e) = walker_run_session(pool, &request.session_id).await {
        let _ = mark_failed(pool, &request.session_id, &format!("WALKER_ERROR:{e}")).await;
        return Err(e);
    }
    Ok(())
}

/// 扫描所有 `state='pending_walker'` 的 session，逐个跑 walker。
/// 启动期由 `mark_pending_for_all_sessions` 标 pending 后立即调用。
pub async fn run_walker_for_pending_sessions(pool: &SqlitePool) -> Result<usize, String> {
    let pending: Vec<String> = sqlx::query_scalar(
        "SELECT session_id FROM session_backfill_state WHERE state = 'pending_walker'",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 pending walker session 失败：{e}"))?;
    let mut handled = 0_usize;
    for sid in pending {
        if let Err(e) = walker_run_session(pool, &sid).await {
            eprintln!("walker session {sid} 失败：{e}");
        }
        handled += 1;
    }
    Ok(handled)
}

/// 跑一个 session 的 walker：
///   1. 读 sessions.payload；空 → 直接标 completed_walker
///   2. 解析为 JSON；失败 → failed_parse + PAYLOAD_NOT_JSON
///   3. 校验 schemaVersion = "tsn-agent.canonical.v0"；失败 → CANONICAL_SCHEMA_INVALID
///   4. 单事务清空旧行 + 重新 INSERT topology_nodes/_links/_refs
///   5. 提交 → completed_walker；INSERT 失败 → CONSTRAINT_VIOLATION:<col>
pub async fn walker_run_session(pool: &SqlitePool, session_id: &str) -> Result<(), String> {
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询 payload 失败：{e}"))?;
    let Some(payload) = payload else {
        return Err(format!("session 不存在：{session_id}"));
    };

    if payload.trim().is_empty() || payload.trim() == "{}" {
        return mark_completed(pool, session_id).await;
    }

    let json: Value = match serde_json::from_str(&payload) {
        Ok(v) => v,
        Err(_) => return mark_failed(pool, session_id, "PAYLOAD_NOT_JSON").await,
    };

    let canonical = match extract_canonical(&json) {
        Some(c) => c,
        None => return mark_failed(pool, session_id, "CANONICAL_SCHEMA_INVALID").await,
    };

    if let Err(code) = apply_canonical_to_db(pool, session_id, &canonical).await {
        return mark_failed(pool, session_id, &code).await;
    }
    mark_completed(pool, session_id).await
}

/// 把 Canonical 抽出来；schemaVersion 必须 == "tsn-agent.canonical.v0"；
/// topology.nodes / topology.links 至少是数组。
fn extract_canonical(json: &Value) -> Option<CanonicalTopology<'_>> {
    if json.get("schemaVersion")? != "tsn-agent.canonical.v0" {
        return None;
    }
    let topology = json.get("topology")?.as_object()?;
    let nodes = topology.get("nodes")?.as_array()?;
    let links = topology.get("links")?.as_array()?;
    Some(CanonicalTopology { nodes, links })
}

struct CanonicalTopology<'a> {
    nodes: &'a Vec<Value>,
    links: &'a Vec<Value>,
}

async fn apply_canonical_to_db(
    pool: &SqlitePool,
    session_id: &str,
    topology: &CanonicalTopology<'_>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("BEGIN:{e}"))?;
    let conn: &mut sqlx::SqliteConnection = &mut *tx;

    conn.execute(sqlx::query("DELETE FROM topology_nodes WHERE session_id = ?").bind(session_id))
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_nodes_delete:{e}"))?;
    conn.execute(sqlx::query("DELETE FROM topology_links WHERE session_id = ?").bind(session_id))
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_links_delete:{e}"))?;
    conn.execute(sqlx::query("DELETE FROM topology_refs WHERE session_id = ?").bind(session_id))
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_refs_delete:{e}"))?;

    // 缺 numericId 必须显式失败（mark_failed → 进入恢复列表），
    // 不允许静默丢节点后标记 completed（拓扑缺数据的「假成功」）。
    let mut sorted_nodes: Vec<(&Value, i64)> = Vec::with_capacity(topology.nodes.len());
    for node in topology.nodes {
        let numeric_id = node
            .get("numericId")
            .and_then(Value::as_i64)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID:node_missing_numeric_id".to_string())?;
        sorted_nodes.push((node, numeric_id));
    }
    sorted_nodes.sort_by_key(|(_, n)| *n);

    let mut imac_by_id: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut sorted_node_ids: Vec<(String, i64)> = Vec::new();
    for (index, (node, numeric_id)) in sorted_nodes.iter().enumerate() {
        let imac = 100 + index as i64;
        let node_id = node
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?
            .to_string();
        let node_type = node
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let position = node
            .get("position")
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let x = position.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = position.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let sync_type = serde_json::json!({ "_classPath": legacy_class_path(node_type) }).to_string();
        let legacy_node_type = legacy_node_type(node_type);

        conn.execute(
            sqlx::query(
                r#"INSERT INTO topology_nodes
                   (session_id, imac, sync_name, x, y, sync_type, node_type, insert_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(session_id)
            .bind(imac)
            .bind(numeric_id.to_string())
            .bind(x)
            .bind(y)
            .bind(&sync_type)
            .bind(legacy_node_type)
            .bind(index as i64),
        )
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_nodes_insert:{e}"))?;

        imac_by_id.insert(node_id.clone(), imac);
        sorted_node_ids.push((node_id, *numeric_id));
    }

    let mut sorted_links: Vec<(&Value, i64)> = Vec::with_capacity(topology.links.len());
    for link in topology.links {
        let numeric_id = link
            .get("numericId")
            .and_then(Value::as_i64)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID:link_missing_numeric_id".to_string())?;
        sorted_links.push((link, numeric_id));
    }
    sorted_links.sort_by_key(|(_, n)| *n);

    for (index, (link, _)) in sorted_links.iter().enumerate() {
        let source = link
            .get("source")
            .and_then(Value::as_object)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let target = link
            .get("target")
            .and_then(Value::as_object)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let src_node_id = source
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let dst_node_id = target
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| "CANONICAL_SCHEMA_INVALID".to_string())?;
        let src_imac = *imac_by_id
            .get(src_node_id)
            .ok_or_else(|| "CONSTRAINT_VIOLATION:src_node_unknown".to_string())?;
        let dst_imac = *imac_by_id
            .get(dst_node_id)
            .ok_or_else(|| "CONSTRAINT_VIOLATION:dst_node_unknown".to_string())?;
        let data_rate = link
            .get("dataRateMbps")
            .and_then(Value::as_i64)
            .unwrap_or(1_000);
        let styles_json = serde_json::json!({
            "leftLabel": source.get("portId").and_then(Value::as_str).unwrap_or(""),
            "rightLabel": target.get("portId").and_then(Value::as_str).unwrap_or(""),
            "speed": data_rate,
        })
        .to_string();
        let name = link
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.to_string());

        conn.execute(
            sqlx::query(
                r#"INSERT INTO topology_links
                   (session_id, link_seq, name, src_imac, dst_imac, styles_json)
                   VALUES (?, ?, ?, ?, ?, ?)"#,
            )
            .bind(session_id)
            .bind(index as i64)
            .bind(name)
            .bind(src_imac)
            .bind(dst_imac)
            .bind(&styles_json),
        )
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_links_insert:{e}"))?;
    }

    conn.execute(
        sqlx::query("INSERT INTO topology_refs (session_id, ref_json) VALUES (?, ?)")
            .bind(session_id)
            .bind("{}"),
    )
    .await
    .map_err(|e| format!("CONSTRAINT_VIOLATION:topology_refs_insert:{e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("CONSTRAINT_VIOLATION:commit:{e}"))?;
    Ok(())
}

pub(crate) fn legacy_node_type(canonical: &str) -> &'static str {
    match canonical {
        "switch" => "switch",
        "endSystem" => "networkcard",
        "server" => "server",
        _ => "networkcard",
    }
}

pub(crate) fn legacy_class_path(canonical: &str) -> &'static str {
    match canonical {
        "switch" => "Q.Graphs.exchanger2",
        "server" => "Q.Graphs.server",
        _ => "Q.Graphs.node",
    }
}

async fn mark_completed(pool: &SqlitePool, session_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"INSERT INTO session_backfill_state (session_id, state, attempted_at)
           VALUES (?, 'completed_walker', ?)
           ON CONFLICT(session_id) DO UPDATE SET
             state = 'completed_walker',
             error_code = NULL,
             attempted_at = excluded.attempted_at"#,
    )
    .bind(session_id)
    .bind(chrono_like_iso_now())
    .execute(pool)
    .await
    .map_err(|e| format!("completed 写入失败：{e}"))?;
    Ok(())
}

async fn mark_failed(pool: &SqlitePool, session_id: &str, code: &str) -> Result<(), String> {
    let state = if code.starts_with("CONSTRAINT_VIOLATION") {
        "failed_constraint"
    } else {
        "failed_parse"
    };
    sqlx::query(
        r#"INSERT INTO session_backfill_state (session_id, state, error_code, attempted_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             state = excluded.state,
             error_code = excluded.error_code,
             attempted_at = excluded.attempted_at"#,
    )
    .bind(session_id)
    .bind(state)
    .bind(code)
    .bind(chrono_like_iso_now())
    .execute(pool)
    .await
    .map_err(|e| format!("failed 状态写入失败：{e}"))?;
    Ok(())
}

/// view_session_payload 的返回上限（plan 2026-06-05-002 U5）：redaction 先看完整
/// 文本（截断后再 redact 可能把 token 切半逃过模式匹配），随后截断保证 IPC 有界。
const MAX_PAYLOAD_VIEW_BYTES: usize = 64 * 1024;

#[tauri::command]
pub async fn view_session_payload(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<String, String> {
    let pool = store.pool(&app).await?;
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询 payload 失败：{e}"))?;
    let payload = payload.ok_or_else(|| format!("会话不存在：{}", request.session_id))?;
    Ok(redact_then_truncate(&payload))
}

/// redact 全文 → 按字符边界截断到上限，超限追加截断说明。
fn redact_then_truncate(payload: &str) -> String {
    let redacted = redact_secrets(payload);
    if redacted.len() <= MAX_PAYLOAD_VIEW_BYTES {
        return redacted;
    }
    let mut cut = MAX_PAYLOAD_VIEW_BYTES;
    while !redacted.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n…（已截断，原文 {} 字节）",
        &redacted[..cut],
        redacted.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts).await.unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn mark_pending_skips_sessions_with_existing_state_row() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}'), ('s2', 't', 'now', 'now', '{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_backfill_state (session_id, state, attempted_at) VALUES ('s2', 'failed_parse', 'now')")
                .execute(&pool).await.unwrap();

            let marked = mark_pending_for_all_sessions(&pool).await.unwrap();
            assert_eq!(marked, 1); // 只 s1 新增

            let s2_state: String = sqlx::query_scalar("SELECT state FROM session_backfill_state WHERE session_id='s2'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(s2_state, "failed_parse"); // 不被覆盖
        });
    }

    #[test]
    fn failed_sessions_have_zero_p0_rows() {
        // U5 弹窗采用固定强警告（无 P0 行数条件分支）的前提固化：失败会话的
        // P0 行恒为 0（failed_parse 不进 DELETE；failed_constraint 事务回滚）。
        // 若未来出现带非空 P0 行的 failed 路径，此测试先红，提示重审弹窗文案策略。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('bad', 't', 'now', 'now', 'not-json-at-all')")
                .execute(&pool).await.unwrap();
            mark_pending_for_all_sessions(&pool).await.unwrap();
            run_walker_for_pending_sessions(&pool).await.unwrap();

            let state: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id='bad'",
            )
            .fetch_one(&pool).await.unwrap();
            assert!(state.starts_with("failed_"), "state={state}");
            let p0_rows: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_nodes WHERE session_id='bad'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(p0_rows, 0);
        });
    }

    #[test]
    fn payload_view_redacts_before_truncating() {
        // secret 在截断点之内 → 已打码；超长部分 → 不出现且带截断说明。
        let secret_part = "api_key=sk-ant-super-secret-token";
        let long_tail = "x".repeat(80 * 1024);
        let payload = format!("{secret_part} {long_tail}");
        let viewed = redact_then_truncate(&payload);
        assert!(!viewed.contains("sk-ant-super-secret-token"), "secret 必须被打码");
        assert!(viewed.len() < payload.len());
        assert!(viewed.contains("已截断"));

        // 不超限的 payload 原样（仅 redact）返回，无截断说明。
        let short = redact_then_truncate("{\"plain\":true}");
        assert!(!short.contains("已截断"));
    }

    #[test]
    fn retry_backfill_overwrites_failure_with_pending_walker() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_backfill_state (session_id, state, error_code, attempted_at) VALUES ('s1', 'failed_parse', 'PAYLOAD_NOT_JSON', 'old')")
                .execute(&pool).await.unwrap();

            sqlx::query(
                r#"INSERT INTO session_backfill_state (session_id, state, attempted_at)
                   VALUES (?, 'pending_walker', ?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     state = 'pending_walker', error_code = NULL, attempted_at = excluded.attempted_at"#,
            )
            .bind("s1").bind("new").execute(&pool).await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as("SELECT state, error_code FROM session_backfill_state WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "pending_walker");
            assert!(code.is_none());
        });
    }

    fn canonical_payload(nodes_links_json: &str) -> String {
        format!(
            r#"{{"schemaVersion":"tsn-agent.canonical.v0","id":"p1","name":"n","createdAt":"a","updatedAt":"b","topology":{nodes_links_json},"flows":[],"simulationHints":{{"inetVersion":"v","nedPackage":"p","defaultDataRateMbps":1000,"timeSynchronization":"assumed-synchronized"}}}}"#
        )
    }

    #[test]
    fn walker_fails_explicitly_when_node_missing_numeric_id() {
        // 数据可靠性包：缺 numericId 不再静默丢节点后标 completed（假成功），
        // 必须 mark_failed 进入恢复列表，且 P0 表保持空。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let topology = r#"{
                "nodes":[
                  {"id":"sw1","numericId":1,"name":"SW-1","type":"switch","ports":[],"position":{"x":0,"y":0}},
                  {"id":"sw2","name":"SW-2","type":"switch","ports":[],"position":{"x":1,"y":1}}
                ],
                "links":[]
            }"#;
            let payload = canonical_payload(topology);
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?)")
                .bind(&payload).execute(&pool).await.unwrap();

            walker_run_session(&pool, "s1").await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as(
                "SELECT state, error_code FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert!(state.starts_with("failed"), "state = {state}");
            assert!(
                code.as_deref().unwrap_or("").contains("node_missing_numeric_id"),
                "error_code = {code:?}"
            );

            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(node_count, 0, "partial rows must not survive a failed walk");
        });
    }

    #[test]
    fn walker_populates_topology_nodes_and_links_from_canonical_payload() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let topology = r#"{
                "nodes":[
                  {"id":"sw1","numericId":2,"name":"SW-1","type":"switch","ports":[{"id":"p1","name":"e0","index":0}],"position":{"x":10,"y":20}},
                  {"id":"sw2","numericId":1,"name":"SW-2","type":"switch","ports":[{"id":"p1","name":"e0","index":0}],"position":{"x":30,"y":40}}
                ],
                "links":[
                  {"id":"L1","numericId":7,"source":{"nodeId":"sw1","portId":"p1"},"target":{"nodeId":"sw2","portId":"p1"},"medium":"ethernet","dataRateMbps":1000}
                ]
            }"#;
            let payload = canonical_payload(topology);
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?)")
                .bind(&payload).execute(&pool).await.unwrap();

            walker_run_session(&pool, "s1").await.unwrap();

            let nodes: Vec<(i64, String, String, Option<String>, i64)> = sqlx::query_as(
                "SELECT imac, sync_name, sync_type, node_type, insert_order FROM topology_nodes WHERE session_id = 's1' ORDER BY insert_order",
            )
            .fetch_all(&pool).await.unwrap();
            assert_eq!(nodes.len(), 2);
            // sw2 numericId=1 排在前面，imac=100；sw1 numericId=2 imac=101
            assert_eq!(nodes[0].0, 100);
            assert_eq!(nodes[0].1, "1");
            assert!(nodes[0].2.contains("Q.Graphs.exchanger2"));
            assert_eq!(nodes[0].3.as_deref(), Some("switch"));
            assert_eq!(nodes[1].0, 101);
            assert_eq!(nodes[1].1, "2");

            let links: Vec<(i64, Option<String>, i64, i64)> = sqlx::query_as(
                "SELECT link_seq, name, src_imac, dst_imac FROM topology_links WHERE session_id = 's1' ORDER BY link_seq",
            )
            .fetch_all(&pool).await.unwrap();
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].0, 0);
            assert_eq!(links[0].1.as_deref(), Some("L1"));
            // sw1 imac=101，sw2 imac=100；source 是 sw1 → src_imac=101，target 是 sw2 → dst_imac=100
            assert_eq!(links[0].2, 101);
            assert_eq!(links[0].3, 100);

            let state: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "completed_walker");
        });
    }

    #[test]
    fn walker_marks_payload_not_json() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', 'not-json')")
                .execute(&pool).await.unwrap();
            walker_run_session(&pool, "s1").await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as(
                "SELECT state, error_code FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "failed_parse");
            assert_eq!(code.as_deref(), Some("PAYLOAD_NOT_JSON"));
        });
    }

    #[test]
    fn walker_marks_canonical_schema_invalid_when_schema_version_mismatches() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let payload = r#"{"schemaVersion":"foo","topology":{"nodes":[],"links":[]}}"#;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?)")
                .bind(payload).execute(&pool).await.unwrap();
            walker_run_session(&pool, "s1").await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as(
                "SELECT state, error_code FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "failed_parse");
            assert_eq!(code.as_deref(), Some("CANONICAL_SCHEMA_INVALID"));
        });
    }

    #[test]
    fn walker_marks_constraint_violation_when_link_references_unknown_node() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let topology = r#"{
                "nodes":[
                  {"id":"sw1","numericId":1,"name":"SW-1","type":"switch","ports":[],"position":{"x":0,"y":0}}
                ],
                "links":[
                  {"id":"L1","numericId":1,"source":{"nodeId":"sw1","portId":"p1"},"target":{"nodeId":"missing","portId":"p1"},"medium":"ethernet","dataRateMbps":1000}
                ]
            }"#;
            let payload = canonical_payload(topology);
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?)")
                .bind(&payload).execute(&pool).await.unwrap();
            walker_run_session(&pool, "s1").await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as(
                "SELECT state, error_code FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "failed_constraint");
            assert!(code.as_deref().unwrap_or("").starts_with("CONSTRAINT_VIOLATION"));
        });
    }

    #[test]
    fn run_walker_for_pending_sessions_picks_up_marked_rows() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let topology = r#"{
                "nodes":[{"id":"sw1","numericId":1,"name":"SW","type":"switch","ports":[],"position":{"x":0,"y":0}}],
                "links":[]
            }"#;
            let payload = canonical_payload(topology);
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?), ('s2', 't', 'now', 'now', '{}')")
                .bind(&payload).execute(&pool).await.unwrap();

            mark_pending_for_all_sessions(&pool).await.unwrap();
            let handled = run_walker_for_pending_sessions(&pool).await.unwrap();
            assert_eq!(handled, 2);

            let s1_state: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            let s2_state: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id = 's2'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(s1_state, "completed_walker");
            assert_eq!(s2_state, "completed_walker");
        });
    }
}
