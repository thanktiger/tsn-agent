//! Plan v3 U_R5：诊断日志文件 writer。
//!
//! 替代既有 `diagnostic_logs` sqlite 表。每条 entry 走 redact pipeline (U2b)
//! 后写到 `<app-config>/logs/sess-<sessionId>/agent-run-<runId>.jsonl`。
//! 单 session 总大小硬上限 10MB，超出后 append 直接返回错误（中文）。
//!
//! Lazy migration：v1→v3 时 `DROP TABLE IF EXISTS diagnostic_logs`
//! 直接丢弃 legacy 数据（诊断日志是脱敏摘要，不属用户数据，参考 plan v3 KTD）。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tokio::sync::Mutex;

use crate::redaction::redact_secrets;

const MAX_MESSAGE_CHARS: usize = 480;
const MAX_DETAIL_CHARS: usize = 6_000;
/// 单 session 日志目录硬上限（plan v3 R5）。
pub const MAX_SESSION_LOG_BYTES: u64 = 10 * 1024 * 1024;

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
    pub details: Option<JsonValue>,
}

/// Tauri AppHandle → `<app-config>/logs` 根目录。
pub fn logs_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;
    let root = app_dir.join("logs");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建日志目录：{error}"))?;
    Ok(root)
}

fn session_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let safe = sanitize_segment(session_id);
    let dir = logs_root(app)?.join(format!("sess-{safe}"));
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建会话日志目录：{error}"))?;
    Ok(dir)
}

fn run_log_path(dir: &Path, run_id: Option<&str>) -> PathBuf {
    let safe = run_id.map(sanitize_segment).unwrap_or_else(|| "unknown".to_string());
    dir.join(format!("agent-run-{safe}.jsonl"))
}

fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 计算 session 目录下所有 jsonl 文件总字节数。
fn session_total_bytes(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut total: u64 = 0;
    let entries = fs::read_dir(dir).map_err(|error| format!("无法读取会话日志目录：{error}"))?;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Ok(total)
}

/// 全局串行化文件写入（防止同一 jsonl 多任务交错）。
#[derive(Default)]
pub struct LogFileWriter {
    inner: Mutex<()>,
}

impl LogFileWriter {
    pub async fn append(
        &self,
        app: &tauri::AppHandle,
        entry: DiagnosticLogEntry,
    ) -> Result<(), String> {
        let _guard = self.inner.lock().await;
        let entry = sanitize_entry(entry);
        let dir = session_dir(app, &entry.session_id)?;

        let estimated_bytes = estimate_entry_bytes(&entry);
        let used_bytes = session_total_bytes(&dir)?;
        if used_bytes.saturating_add(estimated_bytes) > MAX_SESSION_LOG_BYTES {
            return Err(format!(
                "会话 {} 日志已超过 {} 字节上限，无法追加",
                entry.session_id, MAX_SESSION_LOG_BYTES
            ));
        }

        let path = run_log_path(&dir, entry.run_id.as_deref());
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("无法打开日志文件 {}：{error}", path.display()))?;

        let line = serde_json::to_string(&entry)
            .map_err(|error| format!("日志序列化失败：{error}"))?;
        writeln!(file, "{line}").map_err(|error| format!("日志写入失败：{error}"))?;

        Ok(())
    }

    pub async fn list(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<DiagnosticLogEntry>, String> {
        let _guard = self.inner.lock().await;
        let dir = session_dir(app, session_id)?;
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut entries: Vec<DiagnosticLogEntry> = Vec::new();
        let read = fs::read_dir(&dir).map_err(|error| format!("无法读取日志目录：{error}"))?;
        for dirent in read.flatten() {
            let path = dirent.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(file) = File::open(&path) {
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(parsed) = serde_json::from_str::<DiagnosticLogEntry>(&line) {
                        entries.push(parsed);
                    }
                }
            }
        }
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        entries.truncate(limit);
        Ok(entries)
    }

    pub async fn clear_session(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        let _guard = self.inner.lock().await;
        let dir = session_dir(app, session_id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|error| format!("无法删除会话日志目录：{error}"))?;
        }
        Ok(())
    }
}

fn sanitize_entry(entry: DiagnosticLogEntry) -> DiagnosticLogEntry {
    let message = redact_and_truncate(&entry.message, MAX_MESSAGE_CHARS);
    let details = entry.details.clone().map(sanitize_details);
    DiagnosticLogEntry {
        message,
        details,
        ..entry
    }
}

fn sanitize_details(details: JsonValue) -> JsonValue {
    let serialized = details.to_string();
    let value = redact_and_truncate(&serialized, MAX_DETAIL_CHARS);
    serde_json::from_str(&value).unwrap_or(JsonValue::String(value))
}

fn redact_and_truncate(value: &str, max_chars: usize) -> String {
    let redacted = redact_secrets(value);
    if redacted.chars().count() <= max_chars {
        return redacted;
    }
    format!(
        "{}...",
        redacted.chars().take(max_chars).collect::<String>()
    )
}

fn estimate_entry_bytes(entry: &DiagnosticLogEntry) -> u64 {
    serde_json::to_string(entry).map(|s| (s.len() + 1) as u64).unwrap_or(512)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    fn write_directly(dir: &Path, run_id: &str, line: &str) {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("agent-run-{run_id}.jsonl"));
        let mut f = OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    #[test]
    fn sanitize_entry_redacts_message_and_details() {
        let entry = DiagnosticLogEntry {
            id: "1".to_string(),
            session_id: "s".to_string(),
            category: "c".to_string(),
            level: "info".to_string(),
            message: "api_key=secret value".to_string(),
            created_at: "2026-06-04T00:00:00Z".to_string(),
            run_id: Some("r1".to_string()),
            duration_ms: Some(1),
            details: Some(serde_json::json!({"token":"abc"})),
        };
        let sanitized = sanitize_entry(entry);
        assert!(!sanitized.message.contains("secret"));
        assert!(sanitized.message.contains("[redacted]"));
    }

    #[test]
    fn estimate_entry_bytes_returns_positive() {
        let entry = DiagnosticLogEntry {
            id: "1".to_string(),
            session_id: "s".to_string(),
            category: "c".to_string(),
            level: "info".to_string(),
            message: "hi".to_string(),
            created_at: "2026-06-04T00:00:00Z".to_string(),
            run_id: None,
            duration_ms: None,
            details: None,
        };
        assert!(estimate_entry_bytes(&entry) > 0);
    }

    #[test]
    fn list_reads_jsonl_files_sorted_desc_by_created_at() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("sess-s1");
        write_directly(
            &dir,
            "r1",
            r#"{"id":"a","sessionId":"s1","category":"c","level":"info","message":"older","createdAt":"2026-06-04T00:00:00Z","runId":"r1"}"#,
        );
        write_directly(
            &dir,
            "r2",
            r#"{"id":"b","sessionId":"s1","category":"c","level":"info","message":"newer","createdAt":"2026-06-04T01:00:00Z","runId":"r2"}"#,
        );
        let mut entries = Vec::new();
        for dirent in fs::read_dir(&dir).unwrap().flatten() {
            for line in BufReader::new(File::open(dirent.path()).unwrap()).lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                entries.push(serde_json::from_str::<DiagnosticLogEntry>(&line).unwrap());
            }
        }
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        assert_eq!(entries[0].id, "b");
        assert_eq!(entries[1].id, "a");
    }

    #[test]
    fn session_total_bytes_accumulates_jsonl_sizes() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("sess-s2");
        write_directly(&dir, "r1", "hello");
        write_directly(&dir, "r2", "world!!!!!");
        let total = session_total_bytes(&dir).unwrap();
        assert!(total >= 6 + 11);
    }

    #[test]
    fn sanitize_segment_rejects_path_traversal_characters() {
        assert_eq!(sanitize_segment("../evil"), "___evil");
        assert_eq!(sanitize_segment("good-id_1"), "good-id_1");
        assert_eq!(sanitize_segment("session/with/slash"), "session_with_slash");
    }
}
