//! Plan v3 U8 Import：把 Export 产生的 standalone single-session .db 文件
//! 通过 whitelist-table INSERT 路径合并回 main db。
//!
//! 不直接 sqlite ATTACH（plan v3 KTD：避免外部 .db 解析层漏洞作为攻击面）。
//! 改为：开外部 db 连接 → integrity_check + cell_size_check + trusted_schema=OFF
//! → 行数/字段级上限校验 → 仅 SELECT `db::SESSION_SCOPED_TABLES` 白名单表 +
//! sessions 1 行 → 在 main db 单事务内逐行 INSERT（FK 失败即 ROLLBACK）→
//! 同事务写 `session_backfill_state = completed_walker`（导入会话不经历启动期
//! pending 循环 —— 拓扑已随切片直接落 P0 表，无需 walker 重建，plan 2026-06-05-002 R6）。
//!
//! 与 plan v3 R19 "via ops whitelist" 的偏离（**追认现状**，收敛保留为 TODOS P2）：
//! 当前 `topology_ops` 仅含 node/link 5 个 variant；其他子表直接 INSERT 而非走
//! ops。styles_json 等 JSON 字段的内容级注入面（导入文本最终经 inspect 进入
//! 模型上下文）同属 deferred —— 本层只做长度与 JSON object 结构校验。

use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use std::path::PathBuf;

use crate::session_store::SessionStore;
use crate::topology_compute::{MAX_LINKS, MAX_NODES};

/// 单次导入文件大小硬上限（plan v3 R19）。
pub const MAX_IMPORT_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// 字段级字节上限（plan 2026-06-05-002 U2，security review）：
/// 文件级 10MB + 行数上限挡不住「单行单字段塞 9MB」的炸弹 —— styles_json
/// 会经 sidecar inspect 原文直达模型上下文。
const MAX_SMALL_TEXT_BYTES: usize = 4 * 1024; // styles_json / sync_type
const MAX_JSON_TEXT_BYTES: usize = 64 * 1024; // ref_json / cfg_json / spec_json / entry_json
const MAX_IDENT_TEXT_BYTES: usize = 64; // mac_address / ip
const MAX_NAME_TEXT_BYTES: usize = 256; // sessions.title / project_name
/// sessions.payload 字节上限：导出携带完整会话（已脱敏），主库实测 payload 在
/// 数十 KB 量级；给 2MB 宽松上限防外部篡改文件单行灌爆（文件 10MB 是总闸）。
const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
/// 全部 scoped 表的总行数上限：行数守卫只盯 topology_nodes/links，子表
/// （nodes_gcl_cfg 等）可在 10MB 内塞数十万小行造成单事务长锁 + 内存压力。
const MAX_TOTAL_SCOPED_ROWS: usize = 50_000;

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
    // symlink 拒绝（codex review：metadata 检查与后续 SQLite open 是两次路径
    // 解析，symlink 是最廉价的混淆面；剩余 TOCTOU 窗口在单用户桌面下接受）。
    if let Ok(meta) = std::fs::symlink_metadata(&source)
        && meta.file_type().is_symlink()
    {
        return Err(format!("源路径是符号链接，拒绝导入：{}", source.display()));
    }
    let metadata = std::fs::metadata(&source).map_err(|e| format!("无法读取源文件元数据：{e}"))?;
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "源文件超过 {MAX_IMPORT_FILE_BYTES} 字节上限，禁止导入"
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
    // ---------- 打开源 db（防御性 PRAGMA；只读 —— 源是用户文件，不留写锁）----------
    let src_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(source_path)
        .create_if_missing(false)
        .read_only(true)
        .foreign_keys(true);
    let src_pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(src_options)
        .await
        .map_err(|e| format!("无法打开源 db：{e}"))?;

    // 显式 close 保证文件句柄同步释放（Windows 上 drop 是惰性的，导入后用户
    // 立即移动/删除源文件会失败；export 端已有同款注释）。
    let result = perform_import_inner(main_pool, &src_pool, override_session_id).await;
    src_pool.close().await;
    result
}

async fn perform_import_inner(
    main_pool: &SqlitePool,
    src_pool: &SqlitePool,
    override_session_id: Option<&str>,
) -> Result<ImportSessionResponse, String> {
    // 防御：trusted_schema=OFF + cell_size_check=ON + integrity_check。
    sqlx::query("PRAGMA trusted_schema = OFF")
        .execute(src_pool)
        .await
        .map_err(|e| format!("PRAGMA trusted_schema 失败：{e}"))?;
    sqlx::query("PRAGMA cell_size_check = ON")
        .execute(src_pool)
        .await
        .map_err(|e| format!("PRAGMA cell_size_check 失败：{e}"))?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(src_pool)
        .await
        .map_err(|e| format!("PRAGMA integrity_check 失败：{e}"))?;
    if integrity != "ok" {
        return Err(format!("源 db 完整性校验失败：{integrity}"));
    }

    // 校验 application_id（main db 的 0x54534E01）。
    let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(src_pool)
        .await
        .map_err(|e| format!("读取 application_id 失败：{e}"))?;
    if app_id != 0x5453_4E01 {
        return Err(format!(
            "源 db application_id 不匹配（期望 0x54534E01，实际 {app_id:#010x}）"
        ));
    }

    // ---------- 读源 sessions 行 ----------
    let session_row = sqlx::query(
        "SELECT id, title, created_at, updated_at, message_count, event_count, has_project, project_name, bundle_file_count, payload FROM sessions LIMIT 2",
    )
    .fetch_all(src_pool)
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

    // sessions 行字段消毒（security review）：title/project_name 限长；payload
    // 携带源值但限 2MB + 必须合法 JSON object（导出携带完整会话，入库已脱敏）。
    let title: String = row.get("title");
    if title.len() > MAX_NAME_TEXT_BYTES {
        return Err(format!(
            "sessions.title 长度 {} 字节超过上限 {MAX_NAME_TEXT_BYTES}，拒绝导入",
            title.len()
        ));
    }
    let project_name: Option<String> = row.get("project_name");
    if project_name
        .as_ref()
        .is_some_and(|p| p.len() > MAX_NAME_TEXT_BYTES)
    {
        return Err(format!(
            "sessions.project_name 超过上限 {MAX_NAME_TEXT_BYTES} 字节，拒绝导入"
        ));
    }
    let payload: String = row.get("payload");
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "sessions.payload 长度 {} 字节超过上限 {MAX_PAYLOAD_BYTES}，拒绝导入",
            payload.len()
        ));
    }
    // payload 必须是合法 JSON object —— 前端 storedSessionToSession 会 JSON.parse；
    // 坏 payload 虽被前端 catch 兜底（过滤掉），导入时直接拒绝比静默消失更可读。
    // 同时把内嵌 id 改写为 target_session_id：换 id 重试场景下行 PK 与 payload
    // 必须一致，否则前端列表出现重复 id（双高亮 + 按新 id 定位失败）。
    let payload = match serde_json::from_str::<serde_json::Value>(&payload) {
        Ok(serde_json::Value::Object(mut obj)) => {
            obj.insert(
                "id".to_string(),
                serde_json::Value::String(target_session_id.clone()),
            );
            serde_json::Value::Object(obj).to_string()
        }
        _ => return Err("sessions.payload 不是合法 JSON object，拒绝导入".to_string()),
    };

    // 行数上限（与 compute 校验同一常量；按目标 session 过滤 —— 守卫范围必须
    // 与实际复制范围一致，否则带异 session 孤儿行的文件会被误拒）。
    let src_node_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = ?")
            .bind(&src_session_id)
            .fetch_one(src_pool)
            .await
            .map_err(|e| format!("源拓扑节点计数失败：{e}"))?;
    if src_node_count as usize > MAX_NODES {
        return Err(format!(
            "源拓扑节点数 {src_node_count} 超过上限 {MAX_NODES}，拒绝导入"
        ));
    }
    let src_link_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id = ?")
            .bind(&src_session_id)
            .fetch_one(src_pool)
            .await
            .map_err(|e| format!("源拓扑链路计数失败：{e}"))?;
    if src_link_count as usize > MAX_LINKS {
        return Err(format!(
            "源拓扑链路数 {src_link_count} 超过上限 {MAX_LINKS}，拒绝导入"
        ));
    }

    // 总行数预检（codex review：原先在 fetch_all 物化之后才累计，且 main 事务
    // 已开 —— 恶意文件仍可造成大量内存物化 + 长时间持有写事务）。COUNT 预检
    // 在源库完成，超限即拒，main 事务尚未开启。
    let mut total_scoped_rows: i64 = 0;
    for (table, _) in crate::db::SESSION_SCOPED_TABLES {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM {table} WHERE session_id = ?"
        ))
        .bind(&src_session_id)
        .fetch_one(src_pool)
        .await
        .map_err(|e| format!("源 {table} 计数失败：{e}"))?;
        total_scoped_rows += count;
        if total_scoped_rows as usize > MAX_TOTAL_SCOPED_ROWS {
            return Err(format!(
                "源数据总行数超过上限 {MAX_TOTAL_SCOPED_ROWS}，拒绝导入"
            ));
        }
    }

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

    // Insert sessions（payload 携带源值：见上方消毒注释）
    sqlx::query(
        r#"INSERT INTO sessions (id, title, created_at, updated_at, message_count, event_count, has_project, project_name, bundle_file_count, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&target_session_id)
    .bind(&title)
    .bind(row.get::<String, _>("created_at"))
    .bind(row.get::<String, _>("updated_at"))
    .bind(row.get::<i64, _>("message_count"))
    .bind(row.get::<i64, _>("event_count"))
    .bind(row.get::<i64, _>("has_project"))
    .bind(&project_name)
    .bind(row.get::<i64, _>("bundle_file_count"))
    .bind(&payload)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("INSERT sessions 失败：{e}"))?;

    let mut summary = ImportSummary::default();

    // 共享表清单统一复制（与 export 切片同一事实源，防两端漂移）。
    // 首列 session_id 改写为 target；其余列经字段级校验后动态 bind。
    // 行数已由 main 事务前的 COUNT 预检约束。
    for (table, cols) in crate::db::SESSION_SCOPED_TABLES {
        let select_sql = format!(
            "SELECT {} FROM {} WHERE session_id = ?",
            cols.join(", "),
            table
        );
        let rows = sqlx::query(&select_sql)
            .bind(&src_session_id)
            .fetch_all(src_pool)
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
            for col in cols.iter().skip(1) {
                validate_text_field(table, col, row)?;
            }
            let mut q = sqlx::query(&insert_sql);
            q = q.bind(&target_session_id);
            for col in cols.iter().skip(1) {
                q = bind_dynamic(q, row, col);
            }
            q.execute(&mut *tx)
                .await
                .map_err(|e| format!("INSERT {table} 失败：{e}"))?;
            match *table {
                "topology_refs" => summary.topology_refs += 1,
                "topology_nodes" => summary.topology_nodes += 1,
                "topology_links" => summary.topology_links += 1,
                "topo_feature_links" => summary.topo_feature_links += 1,
                "nodes" => summary.nodes += 1,
                _ => summary.subtables += 1,
            }
        }
    }

    // R6：导入会话写终态 backfill 状态（同事务 —— 行复制回滚时它也回滚）。
    // 不写则下次启动 mark_pending_for_all_sessions 会把它标 pending，经历一轮
    // 无谓的 pending→completed 循环（walker 对 '{}' 直接 mark_completed，不删行，
    // 但循环依赖该分支语义永不变化）。内联 SQL：mark_completed 签名为 &SqlitePool，
    // 不接受事务。
    sqlx::query(
        r#"INSERT INTO session_backfill_state (session_id, state, error_code, attempted_at)
           VALUES (?, 'completed_walker', NULL, ?)
           ON CONFLICT(session_id) DO UPDATE SET
               state = 'completed_walker',
               error_code = NULL,
               attempted_at = excluded.attempted_at"#,
    )
    .bind(&target_session_id)
    .bind(crate::topology_backfill::chrono_like_iso_now())
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写入 backfill 状态失败：{e}"))?;

    tx.commit().await.map_err(|e| format!("commit 失败：{e}"))?;

    Ok(ImportSessionResponse {
        session_id: target_session_id,
        rows_inserted: summary,
    })
}

/// 字段级校验：长度上限按列名分级；styles_json 额外要求 JSON object 结构
/// （非 object 的 styles_json 是 trivially crafted 的毒数据，UI/agent 端无消费语义）。
/// 未点名的 TEXT 列（sync_name/name/node_id/node_name/operation_name 等会流向
/// UI label 与 agent inspect）统一吃 4KB 兜底上限 —— 不再有无限大的口子。
fn validate_text_field(
    table: &str,
    col: &str,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<(), String> {
    let limit = match col {
        "styles_json" => MAX_SMALL_TEXT_BYTES,
        "ref_json" | "cfg_json" | "spec_json" | "entry_json" => MAX_JSON_TEXT_BYTES,
        "mac_address" | "ip" => MAX_IDENT_TEXT_BYTES,
        _ => MAX_SMALL_TEXT_BYTES,
    };
    let Ok(Some(value)) = row.try_get::<Option<String>, _>(col) else {
        return Ok(());
    };
    if value.len() > limit {
        return Err(format!(
            "{table}.{col} 字段长度 {} 字节超过上限 {limit}，拒绝导入",
            value.len()
        ));
    }
    if col == "styles_json" {
        let parsed: serde_json::Value = serde_json::from_str(&value)
            .map_err(|e| format!("{table}.styles_json 不是合法 JSON，拒绝导入：{e}"))?;
        if !parsed.is_object() {
            return Err(format!("{table}.styles_json 必须是 JSON object，拒绝导入"));
        }
    }
    Ok(())
}

/// 动态 bind：根据列名读源 row 类型 → bind 到目标 query。
/// 处理所有 P0 schema 用到的 SQLite 类型：TEXT / INTEGER / REAL / NULL。
/// pub(crate)：session_export 的切片写入复用同一 bind 逻辑。
pub(crate) fn bind_dynamic<'q>(
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
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        (dir, pool)
    }

    /// 起一个带 schema 的独立源 pool（测试用，模拟「另一台机器的主库」）。
    async fn source_pool(target_dir: &std::path::Path) -> SqlitePool {
        let src_path = target_dir.join("src.db");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&src_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    /// 真往返：用 U1 的**真实导出函数**产 fixture（取代旧的手写 VACUUM 模拟），
    /// export↔import 两端共同被测试。
    async fn produce_export_db(target_dir: &std::path::Path, payload: &str) -> std::path::PathBuf {
        let src_pool = source_pool(target_dir).await;
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', ?)")
            .bind(payload).execute(&src_pool).await.unwrap();
        sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('orig', '0', 0.0, 0.0, 0), ('orig', '1', 1.0, 1.0, 1)")
            .execute(&src_pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('orig', 0, '0', '1', '{}')")
            .execute(&src_pool).await.unwrap();
        let export_path = target_dir.join("export.db");
        crate::session_export::perform_single_session_export(
            &src_pool,
            "orig",
            export_path.to_str().unwrap(),
        )
        .await
        .expect("real export");
        export_path
    }

    #[test]
    fn import_round_trip_inserts_session_and_topology() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path = produce_export_db(dir.path(), "{}").await;

            let resp = perform_import(&main_pool, &export_path, Some("new"))
                .await
                .unwrap();
            assert_eq!(resp.session_id, "new");
            assert_eq!(resp.rows_inserted.topology_nodes, 2);
            assert_eq!(resp.rows_inserted.topology_links, 1);

            // 验证 main pool 有新 session 行
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='new'")
                .fetch_one(&main_pool)
                .await
                .unwrap();
            assert_eq!(count, 1);
            let node_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='new'")
                    .fetch_one(&main_pool)
                    .await
                    .unwrap();
            assert_eq!(node_count, 2);
        });
    }

    #[test]
    fn import_rewrites_embedded_payload_id_to_target_session_id() {
        // 换 id 重试场景：payload 内嵌旧 id 必须改写为行 PK，否则前端列表
        // 出现重复 id（双高亮）且按新 id 定位失败。
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path =
                produce_export_db(dir.path(), r#"{"id":"orig","title":"源会话"}"#).await;

            perform_import(&main_pool, &export_path, Some("new"))
                .await
                .unwrap();

            let payload: String = sqlx::query_scalar("SELECT payload FROM sessions WHERE id='new'")
                .fetch_one(&main_pool)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(value["id"], "new", "payload 内嵌 id 必须与行 PK 一致");
            assert_eq!(value["title"], "源会话", "其余字段保持源值");
        });
    }

    #[test]
    fn import_rejects_existing_target_session_and_rolls_back() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path = produce_export_db(dir.path(), "{}").await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('clash', 't', 'now', 'now', '{}')")
                .execute(&main_pool).await.unwrap();

            let err = perform_import(&main_pool, &export_path, Some("clash"))
                .await
                .unwrap_err();
            assert!(err.contains("已存在"));

            // 还应保留之前唯一的 sessions 行（无被部分 INSERT 污染）
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                .fetch_one(&main_pool)
                .await
                .unwrap();
            assert_eq!(count, 1);
            let nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes")
                .fetch_one(&main_pool)
                .await
                .unwrap();
            assert_eq!(nodes, 0);
        });
    }

    #[test]
    fn round_trip_preserves_non_integer_real_coordinates() {
        // bind_dynamic 的类型试探顺序是 i64 → f64：REAL 存储值若被 try_get::<i64>
        // 接受会发生截断（1.7 → 1，静默数据损坏）。本测试用非整数坐标固化
        // round-trip 无损（adversarial review RR-1）。
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('orig', '0', 1.7, 2.3, 0)")
                .execute(&src_pool).await.unwrap();
            let export_path = dir.path().join("export.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                export_path.to_str().unwrap(),
            )
            .await
            .unwrap();

            perform_import(&main_pool, &export_path, Some("rt"))
                .await
                .unwrap();

            let (x, y): (f64, f64) = sqlx::query_as(
                "SELECT x, y FROM topology_nodes WHERE session_id='rt' AND sync_name='0'",
            )
            .fetch_one(&main_pool)
            .await
            .unwrap();
            assert_eq!(x, 1.7, "x 坐标 round-trip 必须无损");
            assert_eq!(y, 2.3, "y 坐标 round-trip 必须无损");
        });
    }

    #[test]
    fn import_writes_completed_walker_and_survives_startup_walker() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let export_path = produce_export_db(dir.path(), "{}").await;

            perform_import(&main_pool, &export_path, Some("imported"))
                .await
                .unwrap();

            // R6：导入即带终态 state 行。
            let state: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id='imported'",
            )
            .fetch_one(&main_pool)
            .await
            .unwrap();
            assert_eq!(state, "completed_walker");

            // 模拟下次 app 启动：mark_pending（INSERT OR IGNORE，有行不动）+ walker。
            crate::topology_backfill::mark_pending_for_all_sessions(&main_pool)
                .await
                .unwrap();
            let state_after_mark: String = sqlx::query_scalar(
                "SELECT state FROM session_backfill_state WHERE session_id='imported'",
            )
            .fetch_one(&main_pool)
            .await
            .unwrap();
            assert_eq!(
                state_after_mark, "completed_walker",
                "导入会话不得被重标 pending"
            );

            crate::topology_backfill::run_walker_for_pending_sessions(&main_pool)
                .await
                .unwrap();
            let node_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_nodes WHERE session_id='imported'",
            )
            .fetch_one(&main_pool)
            .await
            .unwrap();
            assert_eq!(
                node_count, 2,
                "导入的 P0 行必须在启动 walker 全跑后原样保留"
            );
        });
    }

    #[test]
    fn import_failure_rolls_back_backfill_state_with_rows() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            // 手工构造恶意切片：带孤儿 nodes_oss_cfg 行（无对应 nodes 行）。
            // 真实导出函数 FK on 产不出这种文件 —— import 防的是任意外部 .db。
            let export_path = dir.path().join("export.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&export_path)
                .create_if_missing(true);
            let evil_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&evil_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&evil_pool).await.unwrap();
            sqlx::query("PRAGMA foreign_keys = OFF")
                .execute(&evil_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO nodes_oss_cfg (session_id, node_id, cfg_json) VALUES ('orig', 'ghost', '{}')")
                .execute(&evil_pool).await.unwrap();
            evil_pool.close().await;

            let err = perform_import(&main_pool, &export_path, Some("broken"))
                .await
                .unwrap_err();
            assert!(err.contains("nodes_oss_cfg"), "err={err}");

            // 整体回滚：sessions 行与 backfill state 行都不存在（同事务联动）。
            let sessions: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='broken'")
                    .fetch_one(&main_pool)
                    .await
                    .unwrap();
            assert_eq!(sessions, 0);
            let states: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM session_backfill_state WHERE session_id='broken'",
            )
            .fetch_one(&main_pool)
            .await
            .unwrap();
            assert_eq!(states, 0);
        });
    }

    #[test]
    fn import_rejects_node_count_over_limit() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            // MAX_NODES + 1 行（批量 INSERT 提速）。
            let mut values = Vec::new();
            for i in 0..=(MAX_NODES as i64) {
                values.push(format!("('orig', '{i}', 0.0, 0.0, {i})"));
            }
            let sql = format!(
                "INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES {}",
                values.join(", ")
            );
            sqlx::query(&sql).execute(&src_pool).await.unwrap();
            let export_path = dir.path().join("export.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                export_path.to_str().unwrap(),
            )
            .await
            .unwrap();

            let err = perform_import(&main_pool, &export_path, Some("big"))
                .await
                .unwrap_err();
            assert!(err.contains("超过上限"), "err={err}");
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id='big'")
                .fetch_one(&main_pool)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn import_rejects_oversized_and_malformed_styles_json() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;

            // 场景 1：styles_json 超 4KB。
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('orig', '0', 0.0, 0.0, 0), ('orig', '1', 1.0, 1.0, 1)")
                .execute(&src_pool).await.unwrap();
            let bomb = format!("{{\"pad\":\"{}\"}}", "x".repeat(5000));
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('orig', 0, '0', '1', ?)")
                .bind(&bomb).execute(&src_pool).await.unwrap();
            let bomb_path = dir.path().join("bomb.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                bomb_path.to_str().unwrap(),
            )
            .await
            .unwrap();
            let err = perform_import(&main_pool, &bomb_path, Some("bomb"))
                .await
                .unwrap_err();
            assert!(err.contains("超过上限"), "err={err}");

            // 场景 2：styles_json 是 JSON 数组（非 object）。
            sqlx::query(
                "UPDATE topology_links SET styles_json = '[1,2,3]' WHERE session_id='orig'",
            )
            .execute(&src_pool)
            .await
            .unwrap();
            let arr_path = dir.path().join("arr.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                arr_path.to_str().unwrap(),
            )
            .await
            .unwrap();
            let err = perform_import(&main_pool, &arr_path, Some("arr"))
                .await
                .unwrap_err();
            assert!(err.contains("JSON object"), "err={err}");
        });
    }

    #[test]
    fn import_rejects_oversized_ident_and_sanitizes_session_row() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            // mac_address 超 64B → 拒（字段上限的 ident 档代表用例）。
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            sqlx::query(
                "INSERT INTO nodes (session_id, node_id, mac_address) VALUES ('orig', 'n0', ?)",
            )
            .bind("a".repeat(65))
            .execute(&src_pool)
            .await
            .unwrap();
            let export_path = dir.path().join("export.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                export_path.to_str().unwrap(),
            )
            .await
            .unwrap();
            let err = perform_import(&main_pool, &export_path, Some("mac"))
                .await
                .unwrap_err();
            assert!(err.contains("mac_address"), "err={err}");

            // 合法 JSON object payload 保留源字段，但内嵌 id 改写为行 PK（换 id
            // 重试场景下二者必须一致，见 import_rewrites_embedded_payload_id 测试）。
            let keep_path = dir.path().join("keep.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&keep_path)
                .create_if_missing(true);
            let keep_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&keep_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', ?)")
                .bind(r#"{"messages":[{"role":"user"}]}"#)
                .execute(&keep_pool).await.unwrap();
            keep_pool.close().await;
            perform_import(&main_pool, &keep_path, Some("clean"))
                .await
                .unwrap();
            let payload: String =
                sqlx::query_scalar("SELECT payload FROM sessions WHERE id='clean'")
                    .fetch_one(&main_pool)
                    .await
                    .unwrap();
            assert_eq!(payload, r#"{"id":"clean","messages":[{"role":"user"}]}"#);

            // 非法 JSON payload 被拒（前端 JSON.parse 有 catch 兜底，导入端显式拒绝更可读）。
            let bad_path = dir.path().join("bad.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&bad_path)
                .create_if_missing(true);
            let bad_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&bad_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', ?)")
                .bind("not-json")
                .execute(&bad_pool).await.unwrap();
            bad_pool.close().await;
            let err = perform_import(&main_pool, &bad_path, Some("badjson"))
                .await
                .unwrap_err();
            assert!(err.contains("JSON object"), "err={err}");

            // title 超 256B → 拒。
            let long_title_path = dir.path().join("title.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&long_title_path)
                .create_if_missing(true);
            let t_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&t_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', ?, 'now', 'now', '{}')")
                .bind("t".repeat(300))
                .execute(&t_pool).await.unwrap();
            t_pool.close().await;
            let err = perform_import(&main_pool, &long_title_path, Some("longtitle"))
                .await
                .unwrap_err();
            assert!(err.contains("title"), "err={err}");
        });
    }

    #[test]
    fn import_rejects_remaining_limit_variants() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;

            // links > MAX_LINKS → 拒。
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('orig', '0', 0.0, 0.0, 0), ('orig', '1', 1.0, 1.0, 1)")
                .execute(&src_pool).await.unwrap();
            let mut values = Vec::new();
            for i in 0..=(MAX_LINKS as i64) {
                values.push(format!("('orig', {i}, '0', '1', '{{}}')"));
            }
            let sql = format!(
                "INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES {}",
                values.join(", ")
            );
            sqlx::query(&sql).execute(&src_pool).await.unwrap();
            let links_path = dir.path().join("links.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                links_path.to_str().unwrap(),
            )
            .await
            .unwrap();
            let err = perform_import(&main_pool, &links_path, Some("links"))
                .await
                .unwrap_err();
            assert!(err.contains("链路数"), "err={err}");

            // project_name > 256B → 拒(手工切片)。
            let pn_path = dir.path().join("pn.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&pn_path)
                .create_if_missing(true);
            let pn_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&pn_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, project_name, payload) VALUES ('orig', 't', 'now', 'now', ?, '{}')")
                .bind("p".repeat(300))
                .execute(&pn_pool).await.unwrap();
            pn_pool.close().await;
            let err = perform_import(&main_pool, &pn_path, Some("pn"))
                .await
                .unwrap_err();
            assert!(err.contains("project_name"), "err={err}");

            // 总行数 > MAX_TOTAL_SCOPED_ROWS → 拒(子表塞行;手工切片绕过 FK）。
            let rows_path = dir.path().join("rows.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&rows_path)
                .create_if_missing(true);
            let rows_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(&crate::db::safety_net_schema_sql())
                .execute(&rows_pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&rows_pool).await.unwrap();
            sqlx::query("PRAGMA foreign_keys = OFF")
                .execute(&rows_pool)
                .await
                .unwrap();
            // nodes 表（PK 含 node_id）灌入超过总上限的行数。
            let mut batch = Vec::with_capacity(2000);
            for i in 0..=MAX_TOTAL_SCOPED_ROWS {
                batch.push(format!("('orig', 'n{i}')"));
                if batch.len() == 2000 {
                    let sql = format!(
                        "INSERT INTO nodes (session_id, node_id) VALUES {}",
                        batch.join(", ")
                    );
                    sqlx::query(&sql).execute(&rows_pool).await.unwrap();
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                let sql = format!(
                    "INSERT INTO nodes (session_id, node_id) VALUES {}",
                    batch.join(", ")
                );
                sqlx::query(&sql).execute(&rows_pool).await.unwrap();
            }
            rows_pool.close().await;
            let err = perform_import(&main_pool, &rows_path, Some("rows"))
                .await
                .unwrap_err();
            assert!(err.contains("总行数"), "err={err}");
        });
    }

    #[test]
    fn import_accepts_exact_limit_counts() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let src_pool = source_pool(dir.path()).await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('orig', 't', 'now', 'now', '{}')")
                .execute(&src_pool).await.unwrap();
            let mut values = Vec::new();
            for i in 0..(MAX_NODES as i64) {
                values.push(format!("('orig', '{i}', 0.0, 0.0, {i})"));
            }
            let sql = format!(
                "INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES {}",
                values.join(", ")
            );
            sqlx::query(&sql).execute(&src_pool).await.unwrap();
            let export_path = dir.path().join("export.db");
            crate::session_export::perform_single_session_export(
                &src_pool,
                "orig",
                export_path.to_str().unwrap(),
            )
            .await
            .unwrap();

            let resp = perform_import(&main_pool, &export_path, Some("edge"))
                .await
                .unwrap();
            assert_eq!(resp.rows_inserted.topology_nodes, MAX_NODES as u64);
        });
    }

    #[test]
    fn import_rejects_db_with_wrong_application_id() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            // 创建一个普通 sqlite（application_id 默认 0）
            let bad_path = dir.path().join("bad.db");
            let opts = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&bad_path)
                .create_if_missing(true);
            let bad_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, payload TEXT)")
                .execute(&bad_pool).await.unwrap();
            sqlx::query("INSERT INTO sessions VALUES ('x', 't', 'now', 'now', '{}')")
                .execute(&bad_pool)
                .await
                .unwrap();
            drop(bad_pool);

            let err = perform_import(&main_pool, &bad_path, None)
                .await
                .unwrap_err();
            assert!(err.contains("application_id"));
        });
    }

    #[test]
    fn import_rejects_missing_source_file() {
        tauri::async_runtime::block_on(async {
            let (dir, main_pool) = seed_main_pool().await;
            let missing = dir.path().join("ghost.db");
            let err = perform_import(&main_pool, &missing, None)
                .await
                .unwrap_err();
            assert!(err.contains("无法打开"));
        });
    }
}
