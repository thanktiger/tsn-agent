//! Plan 2026-06-25-002 U6：eval store 的取用/清除入口（Tauri 命令）。
//! 磁盘格式即数据集（JSONL），"导出≈定位文件"——open_eval_dir 打开目录、
//! export_eval_dataset 拷到用户选定路径；clear_* 做隐私兜底清除（U7 告知配套）。
//! eval store 含未脱敏原文，故导出文件设 0600。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri_plugin_opener::OpenerExt;

const EVAL_FILE_NAME: &str = "eval.jsonl";

fn eval_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::commands::eval_store_dir(app).ok_or_else(|| "无法定位 eval 目录".to_string())
}

fn eval_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(eval_dir(app)?.join(EVAL_FILE_NAME))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearEvalForSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEvalRequest {
    pub target_path: String,
}

/// 打开 eval 目录（系统文件管理器）。目录不存在则先建（空目录也能打开）。
#[tauri::command]
pub fn open_eval_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = eval_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 eval 目录失败：{e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("打开 eval 目录失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 把 eval.jsonl 拷到用户选定路径（前端经 save 对话框给出 targetPath）。
/// 含未脱敏原文 → 目标设 0600。无 store 时返回错误（前端提示"暂无数据"）。
#[tauri::command]
pub fn export_eval_dataset(
    app: tauri::AppHandle,
    request: ExportEvalRequest,
) -> Result<(), String> {
    let src = eval_file(&app)?;
    if !src.exists() {
        return Err("暂无 eval 数据可导出".to_string());
    }
    let target = Path::new(&request.target_path);
    if target.is_symlink() {
        return Err("目标是符号链接，拒绝写入".to_string());
    }
    std::fs::copy(&src, target).map_err(|e| format!("导出失败：{e}"))?;
    apply_owner_only_permissions(target)?;
    Ok(())
}

/// 清空整个 eval store（删 eval.jsonl）。隐私兜底。文件不存在视作已清空。
#[tauri::command]
pub fn clear_eval_store(app: tauri::AppHandle) -> Result<(), String> {
    let file = eval_file(&app)?;
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清空 eval store 失败：{e}")),
    }
}

/// 只删某会话的 eval 样本：逐行读、滤掉 sessionId 匹配的行、原文重写。
/// 非法/无法解析的行保留（不误删）。文件不存在视作无操作。
#[tauri::command]
pub fn clear_eval_for_session(
    app: tauri::AppHandle,
    request: ClearEvalForSessionRequest,
) -> Result<(), String> {
    let file = eval_file(&app)?;
    let content = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取 eval store 失败：{e}")),
    };
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line_matches_session(line, &request.session_id))
        .collect();
    let mut rewritten = kept.join("\n");
    if !rewritten.is_empty() {
        rewritten.push('\n');
    }
    std::fs::write(&file, rewritten).map_err(|e| format!("重写 eval store 失败：{e}"))?;
    apply_owner_only_permissions(&file)?;
    Ok(())
}

/// 行的 sessionId 是否匹配。解析失败的行返回 false（保留，不误删）。
fn line_matches_session(line: &str, session_id: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(|s| s == session_id)
        })
        .unwrap_or(false)
}

#[cfg(unix)]
fn apply_owner_only_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("设置文件权限失败：{e}"))
}

#[cfg(not(unix))]
fn apply_owner_only_permissions(_path: &Path) -> Result<(), String> {
    // Windows ACL 留待后续（与 session_export 一致）。
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::line_matches_session;

    #[test]
    fn matches_only_the_target_session() {
        let line = r#"{"schemaVersion":"x","sessionId":"s1","runId":"r"}"#;
        assert!(line_matches_session(line, "s1"));
        assert!(!line_matches_session(line, "s2"));
    }

    #[test]
    fn unparseable_or_missing_session_is_kept() {
        assert!(!line_matches_session("not json", "s1"));
        assert!(!line_matches_session(r#"{"runId":"r"}"#, "s1"));
        assert!(!line_matches_session(r#"{"sessionId":null}"#, "s1"));
    }
}
