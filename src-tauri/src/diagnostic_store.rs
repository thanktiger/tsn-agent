use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite};
use tokio::sync::OnceCell;

const MAX_DETAIL_CHARS: usize = 6_000;
const DEFAULT_LOG_LIMIT: i64 = 300;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogEntry {
    pub id: String,
    pub session_id: String,
    pub category: String,
    pub level: String,
    pub message: String,
    pub created_at: String,
    pub run_id: Option<String>,
    pub duration_ms: Option<i64>,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendDiagnosticLogRequest {
    entry: DiagnosticLogEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDiagnosticLogsRequest {
    session_id: String,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnosticLogsRequest {
    session_id: String,
}

#[derive(Default)]
pub struct DiagnosticStore {
    pool: OnceCell<Pool<Sqlite>>,
}

#[tauri::command]
pub async fn append_diagnostic_log(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: AppendDiagnosticLogRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    append_diagnostic_log_entry(pool, request.entry).await
}

#[tauri::command]
pub async fn list_diagnostic_logs(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: ListDiagnosticLogsRequest,
) -> Result<Vec<DiagnosticLogEntry>, String> {
    let pool = store.pool(&app).await?;
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, DEFAULT_LOG_LIMIT);
    let rows = sqlx::query(
        r#"
        SELECT id, session_id, category, level, message, created_at, run_id, duration_ms, details
        FROM diagnostic_logs
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        "#,
    )
    .bind(&request.session_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_error)?;

    Ok(rows.iter().map(row_to_entry).collect())
}

#[tauri::command]
pub async fn clear_session_diagnostic_logs(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: SessionDiagnosticLogsRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    clear_logs_for_session(pool, &request.session_id).await
}

pub async fn append_diagnostic_log_entry(
    pool: &Pool<Sqlite>,
    entry: DiagnosticLogEntry,
) -> Result<(), String> {
    let entry = sanitize_entry(entry);
    let details = entry.details.as_ref().map(|details| details.to_string());

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO diagnostic_logs (
            id, session_id, category, level, message, created_at, run_id, duration_ms, details
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&entry.id)
    .bind(&entry.session_id)
    .bind(&entry.category)
    .bind(&entry.level)
    .bind(&entry.message)
    .bind(&entry.created_at)
    .bind(&entry.run_id)
    .bind(entry.duration_ms)
    .bind(&details)
    .execute(pool)
    .await
    .map_err(db_error)?;

    Ok(())
}

pub async fn clear_logs_for_session(pool: &Pool<Sqlite>, session_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM diagnostic_logs WHERE session_id = ?")
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(db_error)?;

    Ok(())
}

impl DiagnosticStore {
    async fn pool(&self, app: &tauri::AppHandle) -> Result<&Pool<Sqlite>, String> {
        self.pool
            .get_or_try_init(|| async {
                let pool = crate::session_store::connect_app_database(app).await?;

                Ok(pool)
            })
            .await
    }
}

fn row_to_entry(row: &sqlx::sqlite::SqliteRow) -> DiagnosticLogEntry {
    let details: Option<String> = row.get("details");

    DiagnosticLogEntry {
        id: row.get("id"),
        session_id: row.get("session_id"),
        category: row.get("category"),
        level: row.get("level"),
        message: row.get("message"),
        created_at: row.get("created_at"),
        run_id: row.get("run_id"),
        duration_ms: row.get("duration_ms"),
        details: details
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok()),
    }
}

fn sanitize_entry(entry: DiagnosticLogEntry) -> DiagnosticLogEntry {
    let message = redact_and_truncate(&entry.message, 480);
    let details = entry.details.clone().map(sanitize_details);

    DiagnosticLogEntry {
        message,
        details,
        ..entry
    }
}

fn sanitize_details(details: serde_json::Value) -> serde_json::Value {
    let value = redact_and_truncate(&details.to_string(), MAX_DETAIL_CHARS);
    serde_json::from_str(&value).unwrap_or_else(|_| serde_json::Value::String(value))
}

pub fn redact_and_truncate(value: &str, max_chars: usize) -> String {
    let redacted = redact_secrets(value);

    if redacted.chars().count() <= max_chars {
        return redacted;
    }

    format!(
        "{}...",
        redacted.chars().take(max_chars).collect::<String>()
    )
}

// `redact_secrets` 与底层 `redact_token_like_word` 实现 plan v3 U2b 已统一到
// `crate::redaction`；此处 re-export 保留既有 import path 兼容。
pub use crate::redaction::redact_secrets;

fn db_error(error: sqlx::Error) -> String {
    format!("diagnostic database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn memory_pool() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory sqlite");

        sqlx::query(crate::db::SESSION_SCHEMA_SQL)
            .execute(&pool)
            .await
            .expect("schema");

        pool
    }

    #[test]
    fn appends_and_lists_session_logs() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;

            append_diagnostic_log_entry(
                &pool,
                DiagnosticLogEntry {
                    id: "log-1".to_string(),
                    session_id: "session-1".to_string(),
                    category: "agent".to_string(),
                    level: "info".to_string(),
                    message: "智能助手请求开始".to_string(),
                    created_at: "2026-05-20T00:00:00.000Z".to_string(),
                    run_id: Some("run-1".to_string()),
                    duration_ms: Some(12),
                    details: Some(serde_json::json!({ "mode": "claude" })),
                },
            )
            .await
            .expect("append log");

            let rows = sqlx::query(
                "SELECT id, session_id, category, level, message, created_at, run_id, duration_ms, details FROM diagnostic_logs WHERE session_id = ?",
            )
            .bind("session-1")
            .fetch_all(&pool)
            .await
            .expect("rows");

            let entry = row_to_entry(&rows[0]);
            assert_eq!(entry.id, "log-1");
            assert_eq!(entry.run_id.as_deref(), Some("run-1"));
            assert_eq!(entry.details, Some(serde_json::json!({ "mode": "claude" })));
        });
    }

    #[test]
    fn clears_only_selected_session_logs() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;

            for session_id in ["session-a", "session-b"] {
                append_diagnostic_log_entry(
                    &pool,
                    DiagnosticLogEntry {
                        id: format!("log-{session_id}"),
                        session_id: session_id.to_string(),
                        category: "session".to_string(),
                        level: "info".to_string(),
                        message: session_id.to_string(),
                        created_at: "2026-05-20T00:00:00.000Z".to_string(),
                        run_id: None,
                        duration_ms: None,
                        details: None,
                    },
                )
                .await
                .expect("append log");
            }

            clear_logs_for_session(&pool, "session-a")
                .await
                .expect("clear logs");

            let count_a: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM diagnostic_logs WHERE session_id = ?")
                    .bind("session-a")
                    .fetch_one(&pool)
                    .await
                    .expect("count a");
            let count_b: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM diagnostic_logs WHERE session_id = ?")
                    .bind("session-b")
                    .fetch_one(&pool)
                    .await
                    .expect("count b");

            assert_eq!(count_a, 0);
            assert_eq!(count_b, 1);
        });
    }

    #[test]
    fn redacts_sensitive_values() {
        let redacted = redact_secrets("api_key=secret Authorization: Bearer sk-ant-secret");

        assert!(!redacted.contains("secret"));
        assert!(redacted.contains("[redacted]"));
    }
}
