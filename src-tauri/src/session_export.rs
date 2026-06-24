//! 单会话切片导出（plan 2026-06-05-002 U1，重写自 VACUUM INTO 版）。
//!
//! 策略：写临时文件 `{target}.tmp`（新空 DB + `safety_net_schema_sql()` +
//! 按 `db::SESSION_SCOPED_TABLES` 共享清单逐表 `INSERT ... SELECT`）→
//! 0600 → 原子 `fs::rename` 替换目标。要点：
//!   - 导出文件天然只含目标会话行，能被 `import_session` 的单 session 校验接受；
//!   - 主库全程只读 —— 旧版 scrub/restore 三步及其竞态（restore 失败永久丢
//!     payload）整体删除；
//!   - `sessions.payload` 携带源值（入库时已 redactSessionForStorage 脱敏）——
//!     导出完整会话切片含对话/workflow 进度/拓扑，让导入方从原进度续走
//!     （boss 拍板推翻 plan v3 U8 '{}' 决策，入库 redaction 已是脱敏闸）；
//!   - 覆盖语义：OS save 对话框已是用户确认点，Rust 端经 tmp+rename 接受覆盖，
//!     失败只删 `.tmp`，用户既有备份文件全程不动；target 为 symlink 时拒绝。
//!
//! 文件 mode：Unix 0600；Windows 留待 ACL helper（暂跳过，加 TODO）。

use serde::Deserialize;
use sqlx::Row;
use std::path::{Path, PathBuf};

use crate::session_import::bind_dynamic;
use crate::session_store::SessionStore;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionRequest {
    session_id: String,
    target_path: String,
}

/// 在系统文件管理器中显示导出文件（U4 成功反馈的「在 Finder 中显示」）。
/// 走 Rust 端 opener 插件（既有依赖），不引入 @tauri-apps/plugin-opener JS 包。
#[tauri::command]
pub fn reveal_in_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = validate_reveal_path(&path)?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| format!("无法打开文件位置：{e}"))
}

/// reveal 路径守卫：仅接受存在的绝对路径（command 是 IPC 面）。
fn validate_reveal_path(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() || !target.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    Ok(target)
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
    let parent = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    if !parent.as_os_str().is_empty() && !parent.exists() {
        return Err(format!("目标目录不存在：{}", parent.display()));
    }

    let target_string = target
        .to_str()
        .ok_or_else(|| "目标路径含无效字符".to_string())?
        .to_string();

    let pool = store.pool(&app).await?;
    perform_single_session_export(pool, &request.session_id, &target_string).await?;
    Ok(target_string)
}

/// 内部实现，便于测试时通过 pool 直接调用。
pub(crate) async fn perform_single_session_export(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    target_path: &str,
) -> Result<(), String> {
    // symlink guard：rename 会替换 symlink 本身，但 guard 防御「目标被换成
    // 指向他处的链接」的混淆场景。
    let target = Path::new(target_path);
    if let Ok(meta) = std::fs::symlink_metadata(target)
        && meta.file_type().is_symlink()
    {
        return Err(format!(
            "目标路径是符号链接，拒绝导出：{}",
            target.display()
        ));
    }

    // 随机后缀临时文件（codex review）：固定 `{target}.tmp` 会误删用户恰好
    // 同名的既有文件，且并发导出同 target 时两个任务互踩。
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = format!("{target_path}.{nanos}.export-tmp");

    // 预创建 0600 空文件（security review：SQLite 经 umask 创建通常是 0644，
    // 写入期间存在可读窗口；预创建后 SQLite 直接复用既有文件与其权限位）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("创建导出临时文件失败：{e}"))?;
    }

    if let Err(e) = write_export_slice(pool, session_id, &tmp_path).await {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    // 0600 设在 tmp 上，rename 保留权限位。
    if let Err(e) = apply_owner_only_permissions(Path::new(&tmp_path)) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    // 原子替换：同分区 rename；失败时 tmp 被清理，既有目标文件不动。
    if let Err(e) = std::fs::rename(&tmp_path, target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("替换目标文件失败：{e}"));
    }
    Ok(())
}

/// 把目标会话切片写入 tmp 文件（独立连接；journal=DELETE 保证单文件落盘）。
/// 错误路径也 close 导出连接（Windows 上句柄未释放会让调用方删 tmp 失败）。
async fn write_export_slice(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    tmp_path: &str,
) -> Result<(), String> {
    let export_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(tmp_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
        .foreign_keys(true);
    let export_pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(export_options)
        .await
        .map_err(|e| format!("创建导出文件失败：{e}"))?;

    let result = copy_slice_into(pool, session_id, &export_pool).await;
    // 无论成败都关闭：成功路径保证落盘无 journal 残留；失败路径释放句柄
    // 让调用方能删 tmp。
    export_pool.close().await;
    result
}

/// 在主库单一只读事务内读取 session 行 + 全部 scoped 表（一致性快照 ——
/// 并发 apply_operations 在表间提交不会让导出文件混合新旧拓扑），写入导出库。
async fn copy_slice_into(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    export_pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<(), String> {
    // 完整 schema（含 PRAGMA application_id，import 端校验它）。
    sqlx::query(&crate::db::safety_net_schema_sql())
        .execute(export_pool)
        .await
        .map_err(|e| format!("导出文件建表失败：{e}"))?;

    let mut read_tx = pool
        .begin()
        .await
        .map_err(|e| format!("读取事务开启失败：{e}"))?;

    // session 存在性 + sessions 行读取（含 payload —— 导出携带完整会话切片）。
    let session_row = sqlx::query(
        r#"SELECT id, title, created_at, updated_at, message_count, event_count,
                  has_project, project_name, bundle_file_count, payload
           FROM sessions WHERE id = ?"#,
    )
    .bind(session_id)
    .fetch_optional(&mut *read_tx)
    .await
    .map_err(|e| format!("读取会话失败：{e}"))?;
    let Some(session_row) = session_row else {
        return Err(format!("会话不存在：{session_id}"));
    };

    // sessions 行：携带源 payload —— 入库时已 redactSessionForStorage 脱敏，
    // 导出完整会话切片（对话 + workflow 进度 + 拓扑），让导入方能从原进度续走。
    sqlx::query(
        r#"INSERT INTO sessions
           (id, title, created_at, updated_at, message_count, event_count,
            has_project, project_name, bundle_file_count, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(session_row.get::<String, _>("id"))
    .bind(session_row.get::<String, _>("title"))
    .bind(session_row.get::<String, _>("created_at"))
    .bind(session_row.get::<String, _>("updated_at"))
    .bind(session_row.get::<i64, _>("message_count"))
    .bind(session_row.get::<i64, _>("event_count"))
    .bind(session_row.get::<i64, _>("has_project"))
    .bind(session_row.get::<Option<String>, _>("project_name"))
    .bind(session_row.get::<i64, _>("bundle_file_count"))
    .bind(session_row.get::<String, _>("payload"))
    .execute(export_pool)
    .await
    .map_err(|e| format!("写入会话行失败：{e}"))?;

    // 共享表清单逐表切片复制（同一只读事务 = 一致性快照）。
    for (table, cols) in crate::db::SESSION_SCOPED_TABLES {
        let select_sql = format!(
            "SELECT {} FROM {} WHERE session_id = ?",
            cols.join(", "),
            table
        );
        let rows = sqlx::query(&select_sql)
            .bind(session_id)
            .fetch_all(&mut *read_tx)
            .await
            .map_err(|e| format!("读取 {table} 失败：{e}"))?;
        if rows.is_empty() {
            continue;
        }
        let placeholders: Vec<&str> = cols.iter().map(|_| "?").collect();
        let insert_sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            cols.join(", "),
            placeholders.join(", ")
        );
        for row in &rows {
            let mut q = sqlx::query(&insert_sql);
            for col in cols.iter() {
                q = bind_dynamic(q, row, col);
            }
            q.execute(export_pool)
                .await
                .map_err(|e| format!("写入 {table} 失败：{e}"))?;
        }
    }

    // 只读事务，commit 仅释放快照。
    let _ = read_tx.commit().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use tempfile::tempdir;

    async fn fresh_pool_on_disk(dir: &tempfile::TempDir) -> sqlx::Pool<sqlx::Sqlite> {
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

    async fn seed_two_sessions(pool: &sqlx::Pool<sqlx::Sqlite>) {
        for (id, payload) in [
            ("s1", r#"{"project":{"sensitive":"secret-blob"}}"#),
            ("s2", "{}"),
        ] {
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES (?, ?, 'now', 'now', ?)")
                .bind(id)
                .bind(format!("title-{id}"))
                .bind(payload)
                .execute(pool)
                .await
                .expect("seed session");
        }
        // s1：2 节点 1 链路 + 1 个 nodes 行；s2：1 节点（断言不被带出）。
        sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('s1', '0', 0.0, 0.0, 0), ('s1', '1', 1.0, 1.0, 1), ('s2', '9', 9.0, 9.0, 0)")
            .execute(pool).await.expect("seed nodes");
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('s1', 0, '0', '1', '{}')")
            .execute(pool).await.expect("seed links");
        sqlx::query("INSERT INTO nodes (session_id, node_id) VALUES ('s1', 'n0')")
            .execute(pool)
            .await
            .expect("seed legacy node");
    }

    async fn open_export(path: &std::path::Path) -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open export")
    }

    #[test]
    fn export_contains_only_target_session_slice() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            seed_two_sessions(&pool).await;

            let out = tempdir().unwrap();
            let target = out.path().join("export.db");
            perform_single_session_export(&pool, "s1", target.to_str().unwrap())
                .await
                .expect("export ok");

            let export_pool = open_export(&target).await;
            // 仅 1 行 sessions 且为 s1；payload 携带源值（导出完整切片）；title 保留。
            let sessions: Vec<(String, String, String)> =
                sqlx::query_as("SELECT id, title, payload FROM sessions")
                    .fetch_all(&export_pool)
                    .await
                    .unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].0, "s1");
            assert_eq!(sessions[0].1, "title-s1");
            assert_eq!(sessions[0].2, r#"{"project":{"sensitive":"secret-blob"}}"#);

            // s1 的 P0 行齐全，s2 的不存在。
            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes")
                .fetch_one(&export_pool)
                .await
                .unwrap();
            assert_eq!(node_count, 2);
            let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_links")
                .fetch_one(&export_pool)
                .await
                .unwrap();
            assert_eq!(link_count, 1);
            let legacy_nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
                .fetch_one(&export_pool)
                .await
                .unwrap();
            assert_eq!(legacy_nodes, 1);

            // application_id 正确（import 校验它）。
            let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
                .fetch_one(&export_pool)
                .await
                .unwrap();
            assert_eq!(app_id, 0x5453_4E01);
        });
    }

    #[test]
    fn export_leaves_main_db_untouched() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            seed_two_sessions(&pool).await;
            let before: String = sqlx::query_scalar("SELECT payload FROM sessions WHERE id='s1'")
                .fetch_one(&pool)
                .await
                .unwrap();

            let out = tempdir().unwrap();
            let target = out.path().join("export.db");
            perform_single_session_export(&pool, "s1", target.to_str().unwrap())
                .await
                .expect("export ok");

            // 主库 payload 与导出前逐字节一致（零写入断言；旧 scrub 路径已删）。
            let after: String = sqlx::query_scalar("SELECT payload FROM sessions WHERE id='s1'")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(after, before);
            assert!(after.contains("secret-blob"));
        });
    }

    #[test]
    fn export_overwrites_existing_target_atomically() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            seed_two_sessions(&pool).await;

            let out = tempdir().unwrap();
            let target = out.path().join("export.db");
            std::fs::write(&target, b"old backup content").unwrap();

            perform_single_session_export(&pool, "s1", target.to_str().unwrap())
                .await
                .expect("overwrite ok");

            // 旧内容被替换为合法导出（OS save 对话框已是用户确认点）。
            let export_pool = open_export(&target).await;
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                .fetch_one(&export_pool)
                .await
                .unwrap();
            assert_eq!(count, 1);
        });
    }

    #[test]
    fn export_failure_preserves_existing_backup_file() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            // 不 seed —— "missing" 会话不存在，导出必然失败。

            let out = tempdir().unwrap();
            let target = out.path().join("export.db");
            std::fs::write(&target, b"precious old backup").unwrap();

            let err = perform_single_session_export(&pool, "missing", target.to_str().unwrap())
                .await
                .unwrap_err();
            assert!(err.contains("会话不存在"));

            // 旧备份原样保留，无临时文件残留（tmp+rename 的备份安全性质）。
            assert_eq!(std::fs::read(&target).unwrap(), b"precious old backup");
            let leftovers: Vec<_> = std::fs::read_dir(out.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains("export-tmp"))
                .collect();
            assert!(leftovers.is_empty(), "tmp 残留: {leftovers:?}");
        });
    }

    #[test]
    fn reveal_path_guard_rejects_relative_and_missing() {
        // 相对路径拒。
        assert!(validate_reveal_path("relative/path.db").is_err());
        // 不存在的绝对路径拒。
        let dir = tempdir().unwrap();
        let missing = dir.path().join("ghost.db");
        assert!(validate_reveal_path(missing.to_str().unwrap()).is_err());
        // 存在的绝对路径通过。
        let real = dir.path().join("real.db");
        std::fs::write(&real, b"x").unwrap();
        assert!(validate_reveal_path(real.to_str().unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlink_target() {
        tauri::async_runtime::block_on(async {
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            seed_two_sessions(&pool).await;

            let out = tempdir().unwrap();
            let real = out.path().join("real-file.db");
            std::fs::write(&real, b"victim content").unwrap();
            let link = out.path().join("export.db");
            std::os::unix::fs::symlink(&real, &link).unwrap();

            let err = perform_single_session_export(&pool, "s1", link.to_str().unwrap())
                .await
                .unwrap_err();
            assert!(err.contains("符号链接"));
            // symlink 指向的文件未被修改。
            assert_eq!(std::fs::read(&real).unwrap(), b"victim content");
        });
    }

    #[cfg(unix)]
    #[test]
    fn export_file_has_owner_only_permissions() {
        tauri::async_runtime::block_on(async {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempdir().unwrap();
            let pool = fresh_pool_on_disk(&dir).await;
            seed_two_sessions(&pool).await;

            let out = tempdir().unwrap();
            let target = out.path().join("export.db");
            perform_single_session_export(&pool, "s1", target.to_str().unwrap())
                .await
                .expect("export ok");

            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        });
    }
}
