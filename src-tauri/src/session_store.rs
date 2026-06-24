use serde::{Deserialize, Serialize};
use sqlx::{
    Pool, Row, Sqlite,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::OnceCell;

const CURRENT_SESSION_KEY: &str = "current_session_id";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    message_count: i64,
    event_count: i64,
    has_project: bool,
    project_name: Option<String>,
    bundle_file_count: i64,
    payload: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionRequest {
    session: SessionPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

#[derive(Default)]
pub struct SessionStore {
    pool: OnceCell<Pool<Sqlite>>,
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 12
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(db_error)?;

    Ok(rows.iter().map(row_to_payload).collect())
}

#[tauri::command]
pub async fn get_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let current_id: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
            .bind(CURRENT_SESSION_KEY)
            .fetch_optional(pool)
            .await
            .map_err(db_error)?;

    if let Some(session_id) = current_id
        && let Some(session) = select_session(pool, &session_id).await?
    {
        return Ok(Some(session));
    }

    let latest = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(latest.as_ref().map(row_to_payload))
}

#[tauri::command]
pub async fn save_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SaveSessionRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let session = request.session;

    upsert_session(pool, &session).await?;
    set_current_session_id(pool, &session.id).await
}

/// UPSERT 而非 INSERT OR REPLACE：REPLACE 是 DELETE+INSERT，DELETE 会触发
/// P0 拓扑表的 ON DELETE CASCADE，导致每次保存会话即清空该 session 的
/// topology_nodes/topology_links（agent 写入的拓扑随下一条消息丢失）。
async fn upsert_session(pool: &Pool<Sqlite>, session: &SessionPayload) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO sessions (
            id, title, created_at, updated_at, message_count, event_count,
            has_project, project_name, bundle_file_count, payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            message_count = excluded.message_count,
            event_count = excluded.event_count,
            has_project = excluded.has_project,
            project_name = excluded.project_name,
            bundle_file_count = excluded.bundle_file_count,
            payload = excluded.payload
        "#,
    )
    .bind(&session.id)
    .bind(&session.title)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .bind(session.message_count)
    .bind(session.event_count)
    .bind(if session.has_project { 1_i64 } else { 0_i64 })
    .bind(&session.project_name)
    .bind(session.bundle_file_count)
    .bind(&session.payload)
    .execute(pool)
    .await
    .map_err(db_error)?;

    Ok(())
}

#[tauri::command]
pub async fn set_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;

    set_current_session_id(pool, &request.session_id).await
}

#[tauri::command]
pub async fn remove_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    diagnostics: tauri::State<'_, crate::diagnostic_store::DiagnosticStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let current_id = current_session_id(pool).await?;

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .execute(pool)
        .await
        .map_err(db_error)?;
    // U_R5：删除文件 jsonl 而非 sqlite 行。即使目录不存在也直接返回。
    crate::diagnostic_store::clear_logs_for_session_fs(
        &app,
        diagnostics.inner(),
        &request.session_id,
    )
    .await?;

    if current_id.as_deref() != Some(request.session_id.as_str()) {
        return Ok(());
    }

    if let Some(next) = latest_session_id(pool).await? {
        set_current_session_id(pool, &next).await
    } else {
        sqlx::query("DELETE FROM app_state WHERE key = ?")
            .bind(CURRENT_SESSION_KEY)
            .execute(pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }
}

impl SessionStore {
    pub(crate) async fn pool(&self, app: &tauri::AppHandle) -> Result<&Pool<Sqlite>, String> {
        self.pool
            .get_or_try_init(|| async { connect_app_database(app).await })
            .await
    }
}

pub async fn connect_app_database(app: &tauri::AppHandle) -> Result<Pool<Sqlite>, String> {
    let db_path = session_database_path(app)?;
    // Plan v3 U2a (Spike C 验证):
    // - sqlx 0.8 默认 journal_mode=Wal，无需显式 PRAGMA
    // - max_connections 由 1 提至 4 以支持后续 axum sidecar 并发读 + UI 写共享同一 pool
    // - busy_timeout=5000ms 在等待写锁时不立即返回 BUSY
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_millis(5_000));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(db_error)?;

    // Safety-net schema：v1 + v2（15 张 P0 表）全部 IF NOT EXISTS 幂等执行。
    // 与 tauri_plugin_sql migrations() 双写保险，避免 plugin migration 与
    // 直 sqlx 路径在不同 db 实例上的版本漂移（Spike C 已确认两者指向同一 db）。
    sqlx::query(&crate::db::safety_net_schema_sql())
        .execute(&pool)
        .await
        .map_err(db_error)?;

    // 加列迁移：老库 topology_nodes 补 name 列（幂等，见 db.rs）。
    crate::db::ensure_topology_nodes_name_column(&pool)
        .await
        .map_err(db_error)?;

    // 去 Qunee 化 re-key：老库节点键 imac→sync_name、删 sync_type、连线端点改名（幂等，见 db.rs）。
    // 须在补 name 列之后，重建会 SELECT name 列。
    crate::db::ensure_topology_rekey_to_sync_name(&pool)
        .await
        .map_err(db_error)?;

    Ok(pool)
}

async fn select_session(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<Option<SessionPayload>, String> {
    let row = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        WHERE id = ?
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(row.as_ref().map(row_to_payload))
}

async fn set_current_session_id(pool: &Pool<Sqlite>, session_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO app_state (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        "#,
    )
    .bind(CURRENT_SESSION_KEY)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(db_error)?;

    Ok(())
}

async fn latest_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

async fn current_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
        .bind(CURRENT_SESSION_KEY)
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

fn session_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;

    std::fs::create_dir_all(&app_dir).map_err(|error| format!("无法创建应用配置目录：{error}"))?;

    Ok(app_dir.join("tsn-agent.db"))
}

fn row_to_payload(row: &sqlx::sqlite::SqliteRow) -> SessionPayload {
    SessionPayload {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        message_count: row.get("message_count"),
        event_count: row.get("event_count"),
        has_project: row.get::<i64, _>("has_project") == 1,
        project_name: row.get("project_name"),
        bundle_file_count: row.get("bundle_file_count"),
        payload: row.get("payload"),
    }
}

fn db_error(error: sqlx::Error) -> String {
    format!("session database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::{SessionPayload, upsert_session};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Pool, Row, Sqlite};

    /// U_R5 后 v1 schema 不再含 `diagnostic_logs`（迁出到文件 jsonl）。
    const EXPECTED_V1_TABLES: &[&str] = &["sessions", "app_state"];

    /// Plan v3 U2a schema 草案：15 张 P0 领域表。
    const EXPECTED_V2_TABLES: &[&str] = &[
        // topology.json (3)
        "topology_nodes",
        "topology_links",
        "topology_refs",
        // topo_feature.json (1)
        "topo_feature_links",
        // node.json (11)
        "nodes",
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
    ];

    #[test]
    fn session_schema_contains_expected_tables() {
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS sessions"));
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS app_state"));
        // U_R5: v1 schema 不再含 diagnostic_logs（迁到文件 jsonl）。
        assert!(
            !crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS diagnostic_logs")
        );
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("idx_sessions_updated_at"));
    }

    #[test]
    fn migration_v3_drops_diagnostic_logs() {
        let migs = crate::db::migrations();
        assert_eq!(migs[2].version, 3);
        assert_eq!(migs[2].description, "drop_diagnostic_logs_for_file_writer");
        assert!(
            crate::db::DROP_DIAGNOSTIC_LOGS_SQL.contains("DROP TABLE IF EXISTS diagnostic_logs")
        );
    }

    #[test]
    fn safety_net_drops_legacy_diagnostic_logs_table_on_v1_db() {
        tauri::async_runtime::block_on(async {
            // 模拟 v1 老 db：含 sessions + app_state + 历史 diagnostic_logs。
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .expect("memory sqlite");
            sqlx::query(crate::db::SESSION_SCHEMA_SQL)
                .execute(&pool)
                .await
                .expect("v1 schema");
            sqlx::query(crate::db::LEGACY_DIAGNOSTIC_LOGS_DDL)
                .execute(&pool)
                .await
                .expect("legacy diagnostic_logs");

            // 升级路径：safety_net_schema_sql 末尾的 DROP 会移除老表。
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .expect("safety_net_schema_sql");

            let tables = list_tables(&pool).await;
            assert!(
                !tables.iter().any(|t| t == "diagnostic_logs"),
                "diagnostic_logs 应已被 DROP，actual = {tables:?}"
            );
        });
    }

    #[test]
    fn p0_domain_schema_lists_all_fifteen_tables() {
        let sql = crate::db::P0_DOMAIN_SCHEMA_SQL;
        for table in EXPECTED_V2_TABLES {
            let needle = format!("CREATE TABLE IF NOT EXISTS {table}");
            assert!(sql.contains(&needle), "missing {table} in P0 schema");
        }
        // application_id (0x54534E01 = 1414745601) 必须由 v2 migration 写入。
        assert!(sql.contains("PRAGMA application_id = 1414745601"));
    }

    #[test]
    fn migrations_expose_v1_through_v5_in_order() {
        let migs = crate::db::migrations();
        assert_eq!(migs.len(), 5);
        assert_eq!(migs[0].version, 1);
        assert_eq!(migs[0].description, "create_session_store");
        assert_eq!(migs[1].version, 2);
        assert_eq!(migs[1].description, "create_p0_domain_tables");
        assert_eq!(migs[2].version, 3);
        assert_eq!(migs[2].description, "drop_diagnostic_logs_for_file_writer");
        assert_eq!(migs[3].version, 4);
        assert_eq!(migs[3].description, "create_session_backfill_state");
        assert_eq!(migs[4].version, 5);
        assert_eq!(
            migs[4].description,
            "rename_networkcard_node_type_to_end_system"
        );
    }

    /// 在内存库里手工建出旧（imac/sync_type）结构 + sessions，灌入样例数据，
    /// 供 re-key 守卫测试。返回的 pool 是「老库」形态。
    async fn legacy_imac_pool() -> Pool<Sqlite> {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory sqlite");
        sqlx::query(
            r#"
            CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE topology_nodes (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                imac INTEGER NOT NULL, sync_name TEXT NOT NULL, name TEXT,
                x REAL NOT NULL, y REAL NOT NULL, sync_type TEXT NOT NULL,
                node_type TEXT, insert_order INTEGER NOT NULL,
                PRIMARY KEY (session_id, imac)
            );
            CREATE TABLE topology_links (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                link_seq INTEGER NOT NULL, name TEXT,
                src_imac INTEGER NOT NULL, dst_imac INTEGER NOT NULL,
                styles_json TEXT NOT NULL,
                PRIMARY KEY (session_id, link_seq)
            );
            INSERT INTO sessions (id) VALUES ('s1');
            INSERT INTO topology_nodes (session_id, imac, sync_name, name, x, y, sync_type, node_type, insert_order)
                VALUES ('s1', 100, '0', 'SW-0', 0, 0, '{"_classPath":"Q.Graphs.exchanger2"}', 'switch', 0),
                       ('s1', 101, '1', 'ES-1', 10, 10, '{"_classPath":"Q.Graphs.node"}', 'endSystem', 1);
            INSERT INTO topology_links (session_id, link_seq, name, src_imac, dst_imac, styles_json)
                VALUES ('s1', 0, '0:0-1:0', 100, 101, '{}');
            "#,
        )
        .execute(&pool)
        .await
        .expect("legacy schema + data");
        pool
    }

    #[tokio::test]
    async fn rekey_promotes_sync_name_drops_imac_and_remaps_links() {
        let pool = legacy_imac_pool().await;
        crate::db::ensure_topology_rekey_to_sync_name(&pool)
            .await
            .expect("rekey");

        // imac / sync_type 列消失
        let imac_cols: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name IN ('imac','sync_type')")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(imac_cols, 0, "imac/sync_type 应已删除");

        // 节点按 sync_name 可查、名字/坐标保留
        let (name, x): (Option<String>, f64) = sqlx::query_as(
            "SELECT name, x FROM topology_nodes WHERE session_id='s1' AND sync_name='1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(name.as_deref(), Some("ES-1"));
        assert_eq!(x, 10.0);

        // 连线端点由 imac 重映射为 sync_name
        let (src, dst): (String, String) =
            sqlx::query_as("SELECT src_sync_name, dst_sync_name FROM topology_links WHERE session_id='s1' AND link_seq=0")
                .fetch_one(&pool).await.unwrap();
        assert_eq!((src.as_str(), dst.as_str()), ("0", "1"));
    }

    #[tokio::test]
    async fn rekey_is_noop_on_already_migrated_db() {
        // 新结构库（safety_net 直接建出新 schema）再跑 re-key 应 no-op、不报错。
        let pool = fresh_memory_pool().await;
        crate::db::ensure_topology_rekey_to_sync_name(&pool)
            .await
            .expect("rekey noop");
        let imac_cols: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name='imac'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(imac_cols, 0);
    }

    async fn fresh_memory_pool() -> Pool<Sqlite> {
        // 与 `connect_app_database` 生产路径一致：通过 SqliteConnectOptions
        // builder 启用 foreign_keys=true，而不是事后手动 PRAGMA，
        // 以保证测试覆盖到 .foreign_keys(true) 初始化路径。
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory sqlite");
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .expect("safety_net_schema_sql executes");
        pool
    }

    fn sample_session_payload(id: &str, title: &str) -> SessionPayload {
        SessionPayload {
            id: id.to_string(),
            title: title.to_string(),
            created_at: "2026-06-04T00:00:00.000Z".to_string(),
            updated_at: "2026-06-04T00:00:00.000Z".to_string(),
            message_count: 1,
            event_count: 0,
            has_project: true,
            project_name: None,
            bundle_file_count: 0,
            payload: "{}".to_string(),
        }
    }

    #[test]
    fn upsert_session_keeps_topology_rows_on_resave() {
        // 回归：INSERT OR REPLACE 的 DELETE 会触发 ON DELETE CASCADE，
        // 把该 session 的 P0 拓扑行清空；UPSERT 不得有此副作用。
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;
            upsert_session(&pool, &sample_session_payload("s1", "t1"))
                .await
                .expect("initial insert");
            sqlx::query(
                "INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) \
                 VALUES ('s1', '0', 0.0, 0.0, 0)",
            )
            .execute(&pool)
            .await
            .expect("seed topology node");
            sqlx::query(
                "INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) \
                 VALUES ('s1', 0, '0', '0', '{}')",
            )
            .execute(&pool)
            .await
            .expect("seed topology link");

            // 模拟用户发下一条消息后的会话保存。
            upsert_session(&pool, &sample_session_payload("s1", "t1-updated"))
                .await
                .expect("resave");

            let node_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = 's1'")
                    .fetch_one(&pool)
                    .await
                    .expect("count nodes");
            let link_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id = 's1'")
                    .fetch_one(&pool)
                    .await
                    .expect("count links");
            let title: String = sqlx::query_scalar("SELECT title FROM sessions WHERE id = 's1'")
                .fetch_one(&pool)
                .await
                .expect("title");

            assert_eq!(
                node_count, 1,
                "resave must not cascade-delete topology nodes"
            );
            assert_eq!(
                link_count, 1,
                "resave must not cascade-delete topology links"
            );
            assert_eq!(title, "t1-updated");
        });
    }

    async fn list_tables(pool: &Pool<Sqlite>) -> Vec<String> {
        sqlx::query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .fetch_all(pool)
            .await
            .expect("list tables")
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect()
    }

    #[test]
    fn safety_net_schema_creates_all_v1_and_v2_tables_idempotently() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;

            let tables = list_tables(&pool).await;
            for expected in EXPECTED_V1_TABLES.iter().chain(EXPECTED_V2_TABLES.iter()) {
                assert!(
                    tables.iter().any(|t| t == expected),
                    "missing table {expected}; actual = {tables:?}"
                );
            }

            // Re-running the safety-net schema must remain idempotent.
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .expect("idempotent re-run");

            let tables_again = list_tables(&pool).await;
            assert_eq!(tables, tables_again);
        });
    }

    #[test]
    fn safety_net_schema_applies_application_id_pragma() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;
            let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
                .fetch_one(&pool)
                .await
                .expect("application_id pragma");
            assert_eq!(app_id, 0x5453_4E01);
        });
    }

    #[test]
    fn undo_snapshots_table_has_expected_columns_and_pk() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;

            // 列：session_id / domain / blob_json / created_at
            let cols: Vec<String> =
                sqlx::query("SELECT name FROM pragma_table_info('topology_undo_snapshots')")
                    .fetch_all(&pool)
                    .await
                    .expect("table_info")
                    .iter()
                    .map(|row| row.get::<String, _>("name"))
                    .collect();
            assert_eq!(
                cols,
                vec!["session_id", "domain", "blob_json", "created_at"],
                "undo snapshots 列清单 actual = {cols:?}"
            );

            // 主键 (session_id, domain)：pragma 的 pk 序号 1/2。
            let pk: Vec<(String, i64)> = sqlx::query(
                "SELECT name, pk FROM pragma_table_info('topology_undo_snapshots') WHERE pk > 0 ORDER BY pk",
            )
            .fetch_all(&pool)
            .await
            .expect("pk info")
            .iter()
            .map(|row| (row.get::<String, _>("name"), row.get::<i64, _>("pk")))
            .collect();
            assert_eq!(
                pk,
                vec![("session_id".to_string(), 1), ("domain".to_string(), 2)]
            );
        });
    }

    #[test]
    fn safety_net_creates_undo_snapshots_table_on_old_db() {
        tauri::async_runtime::block_on(async {
            // 模拟「老库」：只有 v1 schema，没有 topology_undo_snapshots。
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .expect("memory sqlite");
            sqlx::query(crate::db::SESSION_SCHEMA_SQL)
                .execute(&pool)
                .await
                .expect("v1 schema");

            let before = list_tables(&pool).await;
            assert!(
                !before.iter().any(|t| t == "topology_undo_snapshots"),
                "老库不应预含该表"
            );

            // 启动自愈：safety_net 跑一遍后该表被建出。
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pool)
                .await
                .expect("safety_net_schema_sql");

            let after = list_tables(&pool).await;
            assert!(
                after.iter().any(|t| t == "topology_undo_snapshots"),
                "safety-net 后应建出 topology_undo_snapshots，actual = {after:?}"
            );
        });
    }

    #[test]
    fn deleting_session_cascade_removes_undo_snapshot_rows() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_memory_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','t','t','{}')")
                .execute(&pool).await.expect("seed session");
            sqlx::query(
                "INSERT INTO topology_undo_snapshots (session_id, domain, blob_json, created_at) \
                 VALUES ('s1', 'topology', '{}', 't')",
            )
            .execute(&pool)
            .await
            .expect("seed snapshot");

            sqlx::query("DELETE FROM sessions WHERE id = 's1'")
                .execute(&pool)
                .await
                .expect("delete session");

            let remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_undo_snapshots WHERE session_id = 's1'",
            )
            .fetch_one(&pool)
            .await
            .expect("count snapshots");
            assert_eq!(remaining, 0, "删除 session 应级联清掉其撤销快照");
        });
    }

    #[test]
    fn session_scoped_tables_excludes_undo_snapshots() {
        assert!(
            !crate::db::SESSION_SCOPED_TABLES
                .iter()
                .any(|(table, _)| *table == "topology_undo_snapshots"),
            "撤销快照是本机临时状态，不得进导出/导入清单"
        );
    }

    #[test]
    fn nodes_subtable_foreign_key_cascade_works() {
        tauri::async_runtime::block_on(async {
            // fresh_memory_pool 已通过 .foreign_keys(true) builder 启用 FK，
            // 与 `connect_app_database` 生产路径一致。
            let pool = fresh_memory_pool().await;

            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','t','t','{}')")
                .execute(&pool).await.expect("seed session");
            sqlx::query("INSERT INTO nodes (session_id, node_id) VALUES ('s1', 'n0')")
                .execute(&pool)
                .await
                .expect("seed node");
            sqlx::query(
                "INSERT INTO nodes_oss_cfg (session_id, node_id, cfg_json) VALUES ('s1','n0','{}')",
            )
            .execute(&pool)
            .await
            .expect("seed oss_cfg");

            // 删除 session → 应级联删除 nodes 与 nodes_oss_cfg。
            sqlx::query("DELETE FROM sessions WHERE id = 's1'")
                .execute(&pool)
                .await
                .expect("delete session");

            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
                .fetch_one(&pool)
                .await
                .expect("count nodes");
            let oss_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes_oss_cfg")
                .fetch_one(&pool)
                .await
                .expect("count oss_cfg");
            assert_eq!(node_count, 0);
            assert_eq!(oss_count, 0);
        });
    }
}
