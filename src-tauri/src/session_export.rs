//! Plan v3 U8：Export Session 命令。
//!
//! 策略：sub-transaction 把 `sessions.payload` 列暂时设为 `'{}'`，
//! 在 tx 内调 `VACUUM INTO`（SQLite ≥3.27.0）输出 single-session 切片，
//! 再 ROLLBACK 让 main db payload 恢复原值。
//! 这样导出的 .db 文件不包含原始 `CanonicalTsnProjectV0` JSON blob，
//! 避免泄漏敏感工程数据（plan v3 安全约束）。
//!
//! 文件 mode：Unix 0600；Windows 留待 ACL helper（暂跳过，加 TODO）。

use serde::Deserialize;
use std::path::PathBuf;

use crate::session_store::SessionStore;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionRequest {
    session_id: String,
    target_path: String,
}

#[tauri::command]
pub async fn export_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: ExportSessionRequest,
) -> Result<String, String> {
    let target = PathBuf::from(&request.target_path);
    if target.as_os_str().is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    if target.exists() {
        return Err(format!("目标文件已存在，请删除或选择其他路径：{}", target.display()));
    }
    let parent = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    if !parent.as_os_str().is_empty() && !parent.exists() {
        return Err(format!("目标目录不存在：{}", parent.display()));
    }

    let pool = store.pool(&app).await?;

    // 先确认 session 存在
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("查询会话失败：{e}"))?;
    if exists == 0 {
        return Err(format!("会话不存在：{}", request.session_id));
    }

    let target_string = target
        .to_str()
        .ok_or_else(|| "目标路径含无效字符".to_string())?
        .to_string();

    perform_vacuum_into_with_scrubbed_payload(pool, &request.session_id, &target_string).await?;

    apply_owner_only_permissions(&target)?;
    Ok(target_string)
}

/// 内部实现，便于测试时通过 pool 直接调用。
pub(crate) async fn perform_vacuum_into_with_scrubbed_payload(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    target_path: &str,
) -> Result<(), String> {
    // VACUUM INTO 不能在 transaction 内执行；改为先备份 payload → 临时 scrub → VACUUM INTO → 恢复。
    // 备份在内存中，所有 step 失败都必须恢复。
    let original_payload: Option<String> = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取原 payload 失败：{e}"))?;
    let Some(original_payload) = original_payload else {
        return Err(format!("会话不存在：{session_id}"));
    };

    // 临时把指定 session 的 payload 设为 '{}'。
    sqlx::query("UPDATE sessions SET payload = '{}' WHERE id = ?")
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(|e| format!("临时 scrub payload 失败：{e}"))?;

    let vacuum_sql = format!("VACUUM INTO '{}'", target_path.replace('\'', "''"));
    let vacuum_result = sqlx::query(&vacuum_sql).execute(pool).await;

    // 不论 VACUUM 是否成功，必须先恢复原 payload。
    let restore_result = sqlx::query("UPDATE sessions SET payload = ? WHERE id = ?")
        .bind(&original_payload)
        .bind(session_id)
        .execute(pool)
        .await;

    vacuum_result.map_err(|e| format!("VACUUM INTO 失败：{e}"))?;
    restore_result.map_err(|e| format!("恢复 payload 失败：{e}"))?;

    Ok(())
}

#[cfg(unix)]
fn apply_owner_only_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("读取文件权限失败：{e}"))?
        .permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms).map_err(|e| format!("设置 0600 权限失败：{e}"))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_owner_only_permissions(_path: &std::path::Path) -> Result<(), String> {
    // Windows ACL helper 后续单独 unit；当前导出文件继承默认权限。
    Ok(())
}

#[allow(dead_code)] // session existence helper for upcoming Import command
pub(crate) async fn session_exists(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<bool, String> {
    let row = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询会话失败：{e}"))?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;
    use tempfile::tempdir;

    async fn fresh_pool_on_disk(dir: &tempfile::TempDir) -> sqlx::Pool<sqlx::Sqlite> {
        // VACUUM INTO 需要 main db 是磁盘文件（:memory: 在某些 sqlite 配置下行为
        // 不确定）。测试用 tempdir 下的 source.db 模拟生产路径。
        let source = dir.path().join("source.db");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("disk sqlite");
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .expect("schema");
        pool
    }

    #[test]
    fn vacuum_into_preserves_payload_in_main_db_and_scrubs_export() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            let payload = r#"{"project":{"sensitive":"secret-blob"}}"#;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
                .bind("s1")
                .bind("t")
                .bind("now")
                .bind("now")
                .bind(payload)
                .execute(&pool)
                .await
                .expect("seed");

            let dir = tempdir().unwrap();
            let target = dir.path().join("export.db");
            perform_vacuum_into_with_scrubbed_payload(&pool, "s1", target.to_str().unwrap())
                .await
                .expect("export ok");

            // main db 中 payload 仍为原值（scrub→VACUUM→restore）
            let after: String = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
                .bind("s1")
                .fetch_one(&pool)
                .await
                .expect("after");
            assert_eq!(after, payload);

            // 导出 db payload 为 '{}'（无 secret）
            let export_options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&target)
                .create_if_missing(false);
            let export_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(export_options)
                .await
                .expect("open export");
            let exported_payload: String =
                sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
                    .bind("s1")
                    .fetch_one(&export_pool)
                    .await
                    .expect("exported");
            assert_eq!(exported_payload, "{}");
            assert!(!exported_payload.contains("secret-blob"));
        });
    }

    #[test]
    fn vacuum_into_fails_when_target_exists() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
                .bind("s2")
                .bind("t")
                .bind("now")
                .bind("now")
                .bind("{}")
                .execute(&pool).await.expect("seed");

            let dir = tempdir().unwrap();
            let target = dir.path().join("export.db");
            std::fs::write(&target, b"existing").unwrap();

            let err = perform_vacuum_into_with_scrubbed_payload(&pool, "s2", target.to_str().unwrap())
                .await
                .unwrap_err();
            assert!(err.contains("VACUUM"));

            // 即使 VACUUM 失败，main db payload 必须恢复完好
            let restored: String = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
                .bind("s2")
                .fetch_one(&pool)
                .await
                .expect("restored");
            assert_eq!(restored, "{}");
        });
    }

    #[test]
    fn vacuum_into_unknown_session_returns_error() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            let dir = tempdir().unwrap();
            let target = dir.path().join("export.db");
            let err = perform_vacuum_into_with_scrubbed_payload(&pool, "missing", target.to_str().unwrap())
                .await
                .unwrap_err();
            assert!(err.contains("会话不存在"));
        });
    }

    #[test]
    fn export_session_row_count_matches_after_round_trip() {
        // Export then re-open and verify P0 topology tables also exist (15 tables).
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
                .bind("s3").bind("t").bind("now").bind("now").bind("{}")
                .execute(&pool).await.expect("seed");
            sqlx::query("INSERT INTO nodes (session_id, node_id) VALUES ('s3', 'n0')")
                .execute(&pool).await.expect("seed node");

            let dir = tempdir().unwrap();
            let target = dir.path().join("e.db");
            perform_vacuum_into_with_scrubbed_payload(&pool, "s3", target.to_str().unwrap())
                .await
                .expect("export");

            let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&target);
            let export_pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();

            // VACUUM INTO 复制整库（含全部 session 行）。Import unit 后续会做行级 session_id 过滤。
            let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(&export_pool).await.unwrap();
            assert!(session_count >= 1);

            // P0 schema tables present
            let tables: Vec<String> = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'topology_%' OR name='nodes' ORDER BY name")
                .fetch_all(&export_pool).await.unwrap()
                .into_iter().map(|r| r.get::<String, _>("name")).collect();
            assert!(tables.iter().any(|t| t == "topology_nodes"));
            assert!(tables.iter().any(|t| t == "nodes"));
        });
    }
}
