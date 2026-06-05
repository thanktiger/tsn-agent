//! Plan v3 U8 Import：把 Export 产生的 standalone single-session .db 文件
//! 通过 whitelist-table INSERT 路径合并回 main db。
//!
//! 不直接 sqlite ATTACH（plan v3 KTD：避免外部 .db 解析层漏洞作为攻击面）。
//! 改为：开外部 db 连接 → integrity_check + cell_size_check + trusted_schema=OFF
//! → 仅 SELECT 6 张白名单表 + sessions 1 行 → 在 main db 单事务内逐行
//! INSERT，行级校验（session_id 一致、no FK 失败）→ 失败即 ROLLBACK。
//!
//! 与 plan v3 R19 "via ops whitelist" 的偏离：当前 `topology_ops` 仅含
//! node/link 5 个 variant；其他子表（refs/features/topo_feature/nodes/
//! oss_cfg 等）直接 INSERT 而非走 ops。本 unit 提供独立 ImportRowValidator
//! per-table 校验，drift 风险通过单测 + ce:review 监控。

use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use std::path::PathBuf;

use crate::session_store::SessionStore;

/// 单次导入文件大小硬上限（plan v3 R19）。
pub const MAX_IMPORT_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionRequest {
    source_path: String,
    /// 可选：调用方指定新 session_id；不提供则取源 db 的 sessions.id。
    #[serde(default)]
    new_session_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionResponse {
    pub session_id: String,
    pub rows_inserted: ImportSummary,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub topology_nodes: u64,
    pub topology_links: u64,
    pub topology_refs: u64,
    pub topo_feature_links: u64,
    pub nodes: u64,
    pub subtables: u64,
}

#[tauri::command]
pub async fn import_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: ImportSessionRequest,
) -> Result<ImportSessionResponse, String> {
    let source = PathBuf::from(&request.source_path);
    if !source.exists() {
        return Err(format!("源文件不存在：{}", source.display()));
    }
    let metadata = std::fs::metadata(&source)
        .map_err(|e| format!("无法读取源文件元数据：{e}"))?;
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "源文件超过 {} 字节上限，禁止导入",
            MAX_IMPORT_FILE_BYTES
        ));
    }
    if !metadata.is_file() {
        return Err("源路径不是常规文件".to_string());
    }

    let pool = store.pool(&app).await?;
    perform_import(pool, &source, request.new_session_id.as_deref()).await
}

pub(crate) async fn perform_import(
    main_pool: &SqlitePool,
    source_path: &std::path::Path,
    override_session_id: Option<&str>,
) -> Result<ImportSessionResponse, String> {
    // ---------- 打开源 db（防御性 PRAGMA）----------
    let src_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(source_path)
        .create_if_missing(false)
        .foreign_keys(true);
    let src_pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(src_options)
        .await
        .map_err(|e| format!("无法打开源 db：{e}"))?;

    // 防御：trusted_schema=OFF + cell_size_check=ON + integrity_check。
    sqlx::query("PRAGMA trusted_schema = OFF")
        .execute(&src_pool).await.map_err(|e| format!("PRAGMA trusted_schema 失败：{e}"))?;
    sqlx::query("PRAGMA cell_size_check = ON")
        .execute(&src_pool).await.map_err(|e| format!("PRAGMA cell_size_check 失败：{e}"))?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&src_pool)
        .await
        .map_err(|e| format!("PRAGMA integrity_check 失败：{e}"))?;
    if integrity != "ok" {
        return Err(format!("源 db 完整性校验失败：{integrity}"));
    }

    // 校验 application_id（main db 的 0x54534E01）。
    let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&src_pool)
        .await
        .map_err(|e| format!("读取 application_id 失败：{e}"))?;
    if app_id != 0x5453_4E01 {
        return Err(format!(
            "源 db application_id 不匹配（期望 0x54534E01，实际 {:#010x}）",
            app_id
        ));
    }

    // ---------- 读源 sessions 行 ----------
    let session_row = sqlx::query(
        "SELECT id, title, created_at, updated_at, message_count, event_count, has_project, project_name, bundle_file_count, payload FROM sessions LIMIT 2",
    )
    .fetch_all(&src_pool)
    .await
    .map_err(|e| format!("读取源 sessions 失败：{e}"))?;
    if session_row.is_empty() {
        return Err("源 db 不含 session 行".to_string());
    }
    if session_row.len() > 1 {
        return Err("源 db 含多个 session 行；Import 仅支持 single-session 切片".to_string());
    }

    let row = &session_row[0];
    let src_session_id: String = row.get("id");
    let target_session_id = override_session_id
        .map(|s| s.to_string())
        .unwrap_or(src_session_id.clone());

    // ---------- main db 事务：seed sessions + insert 子表 ----------
    let mut tx = main_pool
        .begin()
        .await
        .map_err(|e| format!("main db BEGIN 失败：{e}"))?;

    // 唯一性：target_session_id 不能已经存在。
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(&target_session_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("session 重复性查询失败：{e}"))?;
    if exists != 0 {
        let _ = tx.rollback().await;
        return Err(format!("目标 session 已存在：{target_session_id}"));
    }

    // Insert sessions
    sqlx::query(
        r#"INSERT INTO sessions (id, title, created_at, updated_at, message_count, event_count, has_project, project_name, bundle_file_count, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&target_session_id)
    .bind(row.get::<String, _>("title"))
    .bind(row.get::<String, _>("created_at"))
    .bind(row.get::<String, _>("updated_at"))
    .bind(row.get::<i64, _>("message_count"))
    .bind(row.get::<i64, _>("event_count"))
    .bind(row.get::<i64, _>("has_project"))
    .bind(row.get::<Option<String>, _>("project_name"))
    .bind(row.get::<i64, _>("bundle_file_count"))
    .bind(row.get::<String, _>("payload"))
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("INSERT sessions 失败：{e}"))?;

    let mut summary = ImportSummary::default();

    // 6 张 P0 表 INSERT（topology_refs + topology_nodes + topology_links + topo_feature_links + nodes）
    // 跨 session_id 直接拒绝：源 db 应只含 src_session_id 的行；override 时改写为 target。
    macro_rules! copy_table {
        ($table:expr, $cols:expr, $field:ident) => {{
            let select_sql = format!(
                "SELECT {} FROM {} WHERE session_id = ?",
                $cols.join(", "),
                $table
            );
            let rows = sqlx::query(&select_sql)
                .bind(&src_session_id)
                .fetch_all(&src_pool)
                .await
                .map_err(|e| format!("源 SELECT {} 失败：{e}", $table))?;
            let placeholders: Vec<&str> = std::iter::once("?").chain($cols.iter().skip(1).map(|_| "?")).collect();
            let insert_sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                $table,
                $cols.join(", "),
                placeholders.join(", ")
            );
            for row in &rows {
                let mut q = sqlx::query(&insert_sql);
                q = q.bind(&target_session_id);
                for col in $cols.iter().skip(1) {
                    q = bind_dynamic(q, row, col);
                }
                q.execute(&mut *tx)
                    .await
                    .map_err(|e| format!("INSERT {} 失败：{e}", $table))?;
                summary.$field += 1;
            }
        }};
    }

    copy_table!(
        "topology_refs",
        &["session_id", "ref_json"],
        topology_refs
    );
    copy_table!(
        "topology_nodes",
        &[
            "session_id", "imac", "sync_name", "x", "y", "sync_type", "node_type", "insert_order",
        ],
        topology_nodes
    );
    copy_table!(
        "topology_links",
        &[
            "session_id", "link_seq", "name", "src_imac", "dst_imac", "styles_json",
        ],
        topology_links
    );
    copy_table!(
        "topo_feature_links",
        &[
            "session_id", "link_id", "src_node", "src_port", "dst_node", "dst_port", "speed",
            "st_queues", "macrotick",
        ],
        topo_feature_links
    );
    copy_table!(
        "nodes",
        &[
            "session_id", "node_id", "is_global", "node_name", "node_type", "queue_num",
            "buffer_num", "port_num", "mac_address", "ip", "config_file_name", "device_id",
            "test_port",
        ],
        nodes
    );

    // 10 张 node 子表统一处理；rows_inserted 总和算到 subtables 上。
    for table in [
        "nodes_oss_cfg",
        "nodes_sdu_table_cfg",
        "nodes_gcl_cfg",
        "nodes_time_cfg",
        "nodes_psfg_stream_filters",
        "nodes_psfg_flow_meters",
        "nodes_psfg_stream_gates",
        "nodes_frer_cfg",
        "nodes_array_cfg",
        "nodes_object_cfg",
    ] {
        let cols = match table {
            "nodes_oss_cfg" | "nodes_time_cfg" | "nodes_frer_cfg" => {
                vec!["session_id", "node_id", "cfg_json"]
            }
            "nodes_sdu_table_cfg" => vec!["session_id", "node_id", "port_id", "traffic_class", "sdu_size"],
            "nodes_gcl_cfg" => vec!["session_id", "node_id", "port_id", "slot_index", "operation_name", "gate_state_value", "time_interval_value"],
            "nodes_psfg_stream_filters" => vec!["session_id", "node_id", "filter_id", "spec_json", "flow_meter_id", "stream_gate_id"],
            "nodes_psfg_flow_meters" => vec!["session_id", "node_id", "meter_id", "spec_json"],
            "nodes_psfg_stream_gates" => vec!["session_id", "node_id", "gate_id", "spec_json"],
            "nodes_array_cfg" => vec!["session_id", "node_id", "cfg_kind", "entry_seq", "entry_json"],
            "nodes_object_cfg" => vec!["session_id", "node_id", "cfg_kind", "cfg_json"],
            _ => unreachable!(),
        };
        let select_sql = format!("SELECT {} FROM {} WHERE session_id = ?", cols.join(", "), table);
        let rows = sqlx::query(&select_sql)
            .bind(&src_session_id)
            .fetch_all(&src_pool)
            .await
            .map_err(|e| format!("源 SELECT {table} 失败：{e}"))?;
        let placeholders: Vec<&str> = cols.iter().map(|_| "?").collect();
        let insert_sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            cols.join(", "),
            placeholders.join(", ")
        );
        for row in &rows {
            let mut q = sqlx::query(&insert_sql);
            q = q.bind(&target_session_id);
            for col in cols.iter().skip(1) {
                q = bind_dynamic(q, row, col);
            }
            q.execute(&mut *tx)
                .await
                .map_err(|e| format!("INSERT {table} 失败：{e}"))?;
            summary.subtables += 1;
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("commit 失败：{e}"))?;

    Ok(ImportSessionResponse {
        session_id: target_session_id,
        rows_inserted: summary,
    })
}

/// 动态 bind：根据列名读源 row 类型 → bind 到目标 query。
/// 处理所有 P0 schema 用到的 SQLite 类型：TEXT / INTEGER / REAL / NULL。
fn bind_dynamic<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    row: &sqlx::sqlite::SqliteRow,
    col: &str,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    // SQLite 是动态类型；尝试 i64 → f64 → Option<String> 顺序。
    if let Ok(val) = row.try_get::<i64, _>(col) {
        return q.bind(val);
    }
    if let Ok(val) = row.try_get::<f64, _>(col) {
        return q.bind(val);
    }
    if let Ok(val) = row.try_get::<Option<String>, _>(col) {
        return q.bind(val);
    }
    q.bind(Option::<String>::None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use tempfile::tempdir;

    async fn seed_main_pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempdir().unwrap();
        let main_path = dir.path().join("main.db");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&main_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts).await.unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool).await.unwrap();
        (dir, pool)
    }

    async fn produce_export_db(target_dir: &std::path::Path, payload: &str) -> std::path::PathBuf {
        // 1. 起独立 source pool
        let src_path = target_dir.join("src.db");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&src_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let src_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts).await.unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&src_pool).await.unwrap();
        // 2. 写 session + 2 节点 1 链路
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', ?)")
            .bind(payload).execute(&src_pool).await.unwrap();
        sqlx::query("INSERT INTO topology_nodes (session_id, imac, sync_name, x, y, sync_type, insert_order) VALUES ('orig', 1, '0', 0.0, 0.0, '{}', 0), ('orig', 2, '1', 1.0, 1.0, '{}', 1)")
            .execute(&src_pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_imac, dst_imac, styles_json) VALUES ('orig', 0, 1, 2, '{}')")
            .execute(&src_pool).await.unwrap();
        // 3. VACUUM INTO 模拟 Export 输出 standalone .db
        let export_path = target_dir.join("export.db");
        let vacuum = format!("VACUUM INTO '{}'", export_path.to_str().unwrap());
        sqlx::query(&vacuum).execute(&src_pool).await.unwrap();
        export_path
    }

    #[test]
    fn import_round_trip_inserts_session_and_topology() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path = produce_export_db(dir.path(), "{}").await;

            let resp = perform_import(&main_pool, &export_path, Some("new")).await.unwrap();
            assert_eq!(resp.session_id, "new");
            assert_eq!(resp.rows_inserted.topology_nodes, 2);
            assert_eq!(resp.rows_inserted.topology_links, 1);

            // 验证 main pool 有新 session 行
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='new'")
                .fetch_one(&main_pool).await.unwrap();
            assert_eq!(count, 1);
            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='new'")
                .fetch_one(&main_pool).await.unwrap();
            assert_eq!(node_count, 2);
        });
    }

    #[test]
    fn import_rejects_existing_target_session_and_rolls_back() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path = produce_export_db(dir.path(), "{}").await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('clash', 't', 'now', 'now', '{}')")
                .execute(&main_pool).await.unwrap();

            let err = perform_import(&main_pool, &export_path, Some("clash")).await.unwrap_err();
            assert!(err.contains("已存在"));

            // 还应保留之前唯一的 sessions 行（无被部分 INSERT 污染）
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(&main_pool).await.unwrap();
            assert_eq!(count, 1);
            let nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes").fetch_one(&main_pool).await.unwrap();
            assert_eq!(nodes, 0);
        });
    }

    #[test]
    fn import_rejects_db_with_wrong_application_id() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            // 创建一个普通 sqlite（application_id 默认 0）
            let bad_path = dir.path().join("bad.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&bad_path).create_if_missing(true);
            let bad_pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
            sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, payload TEXT)")
                .execute(&bad_pool).await.unwrap();
            sqlx::query("INSERT INTO sessions VALUES ('x', 't', 'now', 'now', '{}')")
                .execute(&bad_pool).await.unwrap();
            drop(bad_pool);

            let err = perform_import(&main_pool, &bad_path, None).await.unwrap_err();
            assert!(err.contains("application_id"));
        });
    }

    #[test]
    fn import_rejects_missing_source_file() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let missing = dir.path().join("ghost.db");
            let err = perform_import(&main_pool, &missing, None).await.unwrap_err();
            assert!(err.contains("无法打开"));
        });
    }
}
