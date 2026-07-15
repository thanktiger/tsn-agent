//! 门控求解原文（par 行）文件存档（2026-07-15 单表化配套，R2）。
//!
//! 唯一消费者是 verify pin 重放（KTD4）且读频极低，故出库到文件而非留库列
//! （eval 采集管道先例）：路径确定性派生 `<base_dir>/gcl-raw/<session_id>-<provider>.par`
//! （base_dir = app 数据目录，生产由 AppHandle 解析、测试传 tempdir），不存指针列。
//! 覆盖式最新一份；**不随会话导出、不参与 undo**——导入方/撤销后重新规划即恢复。
//!
//! session_id/provider 进文件名：虽为 uuid/常量形态，仍白名单校验（仅 `[A-Za-z0-9_-]`）
//! 防路径穿越，非法即响亮拒绝。

use std::path::{Path, PathBuf};

const RAW_DIR_NAME: &str = "gcl-raw";

/// 生产侧 base_dir 解析：与 sessions.db / eval store 同源（app_config_dir）。
/// 测试无 AppHandle——各读写函数收 base_dir 参数，测试传 tempdir。
pub fn resolve_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))
}

/// 文件名分量白名单：仅 `[A-Za-z0-9_-]`（session id 是 uuid 形态、provider 是常量，
/// 保险起见仍校验），空串/其它字符（含 `/`、`..`、`\0`）一律拒绝——防路径穿越。
fn validate_component(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("非法 {kind}（只允许字母数字与 _ -）：{value:?}"));
    }
    Ok(())
}

fn raw_path(base_dir: &Path, session_id: &str, provider: &str) -> Result<PathBuf, String> {
    validate_component("session_id", session_id)?;
    validate_component("provider", provider)?;
    Ok(base_dir
        .join(RAW_DIR_NAME)
        .join(format!("{session_id}-{provider}.par")))
}

/// 覆盖写 raw par 行（目录不存在则创建）。
pub fn write_raw(
    base_dir: &Path,
    session_id: &str,
    provider: &str,
    par_lines: &str,
) -> Result<(), String> {
    let path = raw_path(base_dir, session_id, provider)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建 gcl-raw 目录失败：{e}"))?;
    }
    std::fs::write(&path, par_lines).map_err(|e| format!("写 raw 存档失败：{e}"))
}

/// 读 raw par 行：文件缺失 → Ok(None)（verify 据此报无规划，AE2 fail-safe）；
/// 非法 id / IO 错误 → Err。
pub fn read_raw(
    base_dir: &Path,
    session_id: &str,
    provider: &str,
) -> Result<Option<String>, String> {
    let path = raw_path(base_dir, session_id, provider)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读 raw 存档失败：{e}")),
    }
}

/// 删 raw 文件（幂等：不存在即 no-op）。
pub fn remove_raw(base_dir: &Path, session_id: &str, provider: &str) -> Result<(), String> {
    let path = raw_path(base_dir, session_id, provider)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删 raw 存档失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        // 未写过 → None。
        assert_eq!(read_raw(dir.path(), "s1", "inet-z3").unwrap(), None);
        // 写（目录自动创建）→ 读回原文。
        write_raw(dir.path(), "s1", "inet-z3", "par a b c\n").unwrap();
        assert_eq!(
            read_raw(dir.path(), "s1", "inet-z3").unwrap().as_deref(),
            Some("par a b c\n")
        );
        // 覆盖写只留最新一份。
        write_raw(dir.path(), "s1", "inet-z3", "par x\n").unwrap();
        assert_eq!(
            read_raw(dir.path(), "s1", "inet-z3").unwrap().as_deref(),
            Some("par x\n")
        );
        // 删除幂等：两次都 Ok，读回 None。
        remove_raw(dir.path(), "s1", "inet-z3").unwrap();
        remove_raw(dir.path(), "s1", "inet-z3").unwrap();
        assert_eq!(read_raw(dir.path(), "s1", "inet-z3").unwrap(), None);
    }

    #[test]
    fn path_traversal_components_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../evil", "a/b", "a\\b", "", "a.b", "s1\0x"] {
            assert!(
                write_raw(dir.path(), bad, "inet-z3", "x").is_err(),
                "session_id {bad:?} 应被拒绝"
            );
            assert!(
                read_raw(dir.path(), "s1", bad).is_err(),
                "provider {bad:?} 应被拒绝"
            );
            assert!(remove_raw(dir.path(), bad, "inet-z3").is_err());
        }
    }
}
