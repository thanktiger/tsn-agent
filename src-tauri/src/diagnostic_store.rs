//! Plan v3 U_R5 实施后：诊断日志由 `log_file_writer` 落到文件，
//! 不再使用 sqlite `diagnostic_logs` 表。本模块仅维护 Tauri command 表面
//! （`append_diagnostic_log` / `list_diagnostic_logs` / `clear_session_diagnostic_logs`），
//! 行为委托给 `log_file_writer::LogFileWriter`，UI 端 `diagnostic-log-repository.ts`
//! 调用契约不变。

use serde::Deserialize;

pub use crate::log_file_writer::DiagnosticLogEntry;
use crate::log_file_writer::LogFileWriter;

const DEFAULT_LOG_LIMIT: i64 = 300;

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
    writer: LogFileWriter,
}

impl DiagnosticStore {
    pub fn writer(&self) -> &LogFileWriter {
        &self.writer
    }
}

#[tauri::command]
pub async fn append_diagnostic_log(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: AppendDiagnosticLogRequest,
) -> Result<(), String> {
    store.writer.append(&app, request.entry).await
}

#[tauri::command]
pub async fn list_diagnostic_logs(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: ListDiagnosticLogsRequest,
) -> Result<Vec<DiagnosticLogEntry>, String> {
    let limit = request
        .limit
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, DEFAULT_LOG_LIMIT) as usize;
    store.writer.list(&app, &request.session_id, limit).await
}

#[tauri::command]
pub async fn clear_session_diagnostic_logs(
    app: tauri::AppHandle,
    store: tauri::State<'_, DiagnosticStore>,
    request: SessionDiagnosticLogsRequest,
) -> Result<(), String> {
    store.writer.clear_session(&app, &request.session_id).await
}

/// `session_store::remove_session` 调用：删除该 session 的整个日志目录。
pub async fn clear_logs_for_session_fs(
    app: &tauri::AppHandle,
    store: &DiagnosticStore,
    session_id: &str,
) -> Result<(), String> {
    store.writer.clear_session(app, session_id).await
}
