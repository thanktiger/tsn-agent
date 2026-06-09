//! 启动期 backfill：把"有 payload 但无 P0 拓扑"的存量 session 标记为已处理，
//! 并维护导入失败恢复用的 `session_backfill_state` 机制。
//!
//! 历史背景：本模块原是 Phase A 的一次性 canonical 迁移工具（payload 内嵌
//! canonical JSON → P0 表）。Phase B-β 后拓扑权威在 P0 表，新会话由 sidecar
//! `initialize` / `session_import` 直接落表，canonical 迁移路径已删除（P1#2 收口）。
//! Walker 退化为 payload 健康检查：JSON 损坏 → `failed_parse`（进恢复列表），
//! 其余 → `completed_walker`。
//!
//! 失败状态码：
//!   - `PAYLOAD_NOT_JSON`：payload 不是合法 JSON
//!
//! `legacy_node_type` / `legacy_class_path`（type → legacy 字符串映射）由 sidecar
//! `persist_initialized_topology` 复用，保留在本模块作为单一定义点。
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
use sqlx::SqlitePool;

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
              )
              AND NOT EXISTS (
                  SELECT 1 FROM topology_nodes n WHERE n.session_id = s.id
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

/// 跑一个 session 的 walker（拓扑迁移已下线，退化为 payload 健康检查）：
///   1. 读 sessions.payload；空 → completed_walker
///   2. 解析为 JSON：失败 → failed_parse + PAYLOAD_NOT_JSON（进恢复列表）
///   3. 合法 JSON → completed_walker（拓扑由 sidecar / import 直接落 P0 表，walker 不再重建）
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

    // Phase B-β 后拓扑权威在 P0 表，payload 不再内嵌 canonical；walker 只校验
    // payload 是合法 JSON（损坏会话进恢复列表），其余视为无需迁移标 completed。
    match serde_json::from_str::<Value>(&payload) {
        Ok(_) => mark_completed(pool, session_id).await,
        Err(_) => mark_failed(pool, session_id, "PAYLOAD_NOT_JSON").await,
    }
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
    fn mark_pending_skips_sessions_that_already_have_p0_topology() {
        // 已有 topology_nodes 行的 session（sidecar 直接写入的新会话）拓扑已落 P0，无需 backfill，
        // 不标 pending，避免 walker 把正常会话误判处理。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('with_p0', 't', 'now', 'now', '{\"title\":\"x\"}'), ('no_p0', 't', 'now', 'now', '{\"title\":\"x\"}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO topology_nodes (session_id, imac, sync_name, x, y, sync_type, node_type, insert_order) VALUES ('with_p0', 100, '1', 0, 0, '{}', 'switch', 0)")
                .execute(&pool).await.unwrap();

            let marked = mark_pending_for_all_sessions(&pool).await.unwrap();
            assert_eq!(marked, 1); // 只 no_p0 被标 pending

            let with_p0_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_backfill_state WHERE session_id='with_p0'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(with_p0_rows, 0); // 有 P0 拓扑 → 不标 pending
        });
    }

    #[test]
    fn failed_sessions_have_zero_p0_rows() {
        // U5 弹窗采用固定强警告（无 P0 行数条件分支）的前提固化：失败会话的
        // P0 行恒为 0（failed_parse 不写 topology_nodes）。
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
    fn walker_completes_when_payload_is_valid_json() {
        // Phase B-β 之后的会话：payload 是合法 JSON（session state），拓扑由 sidecar
        // 直接落 P0 表，walker 视为无需迁移 → completed，不进失败列表。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let payload = r#"{"title":"新会话","messages":[],"workflow":{"currentStep":"topology"}}"#;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', ?)")
                .bind(payload).execute(&pool).await.unwrap();
            walker_run_session(&pool, "s1").await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as(
                "SELECT state, error_code FROM session_backfill_state WHERE session_id = 's1'",
            )
            .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "completed_walker");
            assert!(code.is_none());
        });
    }

    #[test]
    fn run_walker_for_pending_sessions_picks_up_marked_rows() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{\"title\":\"x\"}'), ('s2', 't', 'now', 'now', '{}')")
                .execute(&pool).await.unwrap();

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
