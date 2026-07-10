//! 工程模板 store（2026-07-09，落地页）：`project_templates` 表的读/删/排序/从 session 快照建模板。
//! 两类模板同表按 `kind` 判别（prompt / snapshot）。命令经 `SessionStore` 拿同一 app db pool。
//! 出厂 prompt 行由 `db::ensure_project_templates_seeded` 一次性播种；本模块只做 CRUD。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Pool, Row, Sqlite};

/// 模板卡列表项（不含 `topology_snapshot` 大 blob——「使用」时按 id 服务端读）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRow {
    pub id: String,
    pub kind: String,
    pub scenario_config_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    /// kind=prompt 时的构建 prompt（前端点卡即当用户意图提交）；snapshot 行为 None。
    pub prompt_text: Option<String>,
    pub sort_order: i64,
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    pub session_id: String,
    pub title: String,
    /// 前端显式传入来源 session 的 scenario（workflow 是前端 payload 独占，Rust 不解析，见 plan KTD7）。
    pub scenario_config_id: String,
}

async fn list_inner(pool: &Pool<Sqlite>) -> Result<Vec<TemplateRow>, String> {
    let rows = sqlx::query(
        "SELECT id, kind, scenario_config_id, title, subtitle, prompt_text, sort_order, origin \
         FROM project_templates ORDER BY sort_order",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|r| TemplateRow {
            id: r.get("id"),
            kind: r.get("kind"),
            scenario_config_id: r.get("scenario_config_id"),
            title: r.get("title"),
            subtitle: r.get("subtitle"),
            prompt_text: r.get("prompt_text"),
            sort_order: r.get("sort_order"),
            origin: r.get("origin"),
        })
        .collect())
}

/// 快照当前 session 的拓扑**每一列**（含 x/y/styles_json）为 JSON。空拓扑返回 None。
async fn snapshot_topology(pool: &Pool<Sqlite>, session_id: &str) -> Result<Option<Value>, String> {
    let node_rows = sqlx::query(
        "SELECT mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order \
         FROM topology_nodes WHERE session_id = ? ORDER BY insert_order",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    if node_rows.is_empty() {
        return Ok(None);
    }

    let nodes: Vec<Value> = node_rows
        .iter()
        .map(|r| {
            json!({
                "mid": r.get::<String, _>("mid"),
                "name": r.get::<Option<String>, _>("name"),
                "x": r.get::<f64, _>("x"),
                "y": r.get::<f64, _>("y"),
                "node_type": r.get::<Option<String>, _>("node_type"),
                "mac": r.get::<Option<String>, _>("mac"),
                "ip": r.get::<Option<String>, _>("ip"),
                "port_count": r.get::<i64, _>("port_count"),
                "queue_count": r.get::<i64, _>("queue_count"),
                "insert_order": r.get::<i64, _>("insert_order"),
            })
        })
        .collect();

    let link_rows = sqlx::query(
        "SELECT link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json \
         FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let links: Vec<Value> = link_rows
        .iter()
        .map(|r| {
            json!({
                "link_seq": r.get::<i64, _>("link_seq"),
                "name": r.get::<Option<String>, _>("name"),
                "src_node": r.get::<String, _>("src_node"),
                "dst_node": r.get::<String, _>("dst_node"),
                // src_port/dst_port/speed 可为 NULL（非数字端口标签/存量行永久 NULL，见 db.rs 与
                // link-add-skips-port-columns 学习）——必须读 Option，否则非 Option 解码遇 NULL panic。
                "src_port": r.get::<Option<i64>, _>("src_port"),
                "dst_port": r.get::<Option<i64>, _>("dst_port"),
                "speed": r.get::<Option<i64>, _>("speed"),
                "styles_json": r.get::<String, _>("styles_json"),
            })
        })
        .collect();

    Ok(Some(json!({ "nodes": nodes, "links": links })))
}

async fn create_snapshot_inner(
    pool: &Pool<Sqlite>,
    req: &CreateSnapshotRequest,
) -> Result<(), String> {
    let snapshot = snapshot_topology(pool, &req.session_id)
        .await?
        .ok_or_else(|| "当前工程无拓扑，无法设为模板".to_string())?;
    let snapshot_str = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let next_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_templates")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;

    let id = format!("tpl-user-{:016x}", rand::random::<u64>());

    sqlx::query(
        "INSERT INTO project_templates \
         (id, kind, scenario_config_id, title, subtitle, prompt_text, topology_snapshot, sort_order, origin, created_at) \
         VALUES (?, 'snapshot', ?, ?, NULL, NULL, ?, ?, 'user', datetime('now'))",
    )
    .bind(&id)
    .bind(&req.scenario_config_id)
    .bind(&req.title)
    .bind(&snapshot_str)
    .bind(next_order)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseSnapshotRequest {
    pub template_id: String,
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseSnapshotResponse {
    /// 快照来源 scenario——前端据此置 session.workflow.scenarioConfigId（KTD7）。
    pub scenario_config_id: String,
    pub mutation_id: u64,
}

/// 把快照拓扑**逐列**确定性重建到目标 session（同事务：写前撤销快照 + DELETE + INSERT）。
/// 复刻 `topology_sidecar_routes::persist_initialized_topology` 的写法，但从快照原始行写。
async fn rebuild_from_snapshot(
    pool: &Pool<Sqlite>,
    session_id: &str,
    snapshot: &Value,
) -> Result<(), String> {
    let nodes = snapshot["nodes"]
        .as_array()
        .ok_or_else(|| "快照缺 nodes".to_string())?;
    let links = snapshot["links"].as_array().cloned().unwrap_or_default();

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let conn: &mut sqlx::SqliteConnection = &mut tx;

    // 写前快照（整图重置可撤，与 initialize 同口径）。
    crate::topology_undo::snapshot_pre_image(
        &mut *conn,
        session_id,
        crate::topology_undo::TOPOLOGY_DOMAIN,
    )
    .await
    .map_err(|e| format!("undo snapshot failed: {e}"))?;

    for table in ["topology_nodes", "topology_links"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?"))
            .bind(session_id)
            .execute(&mut *conn)
            .await
            .map_err(|e| format!("{table} delete failed: {e}"))?;
    }

    for (index, node) in nodes.iter().enumerate() {
        let mid = node["mid"].as_str().ok_or("快照 node 缺 mid")?;
        sqlx::query(
            r#"INSERT INTO topology_nodes
               (session_id, mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(mid)
        .bind(node["name"].as_str())
        .bind(node["x"].as_f64().unwrap_or(0.0))
        .bind(node["y"].as_f64().unwrap_or(0.0))
        .bind(node["node_type"].as_str())
        .bind(node["mac"].as_str())
        .bind(node["ip"].as_str())
        .bind(node["port_count"].as_i64().unwrap_or(8))
        .bind(node["queue_count"].as_i64().unwrap_or(8))
        .bind(index as i64)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("topology_nodes insert failed: {e}"))?;
    }

    for (index, link) in links.iter().enumerate() {
        let src = link["src_node"].as_str().ok_or("快照 link 缺 src_node")?;
        let dst = link["dst_node"].as_str().ok_or("快照 link 缺 dst_node")?;
        sqlx::query(
            r#"INSERT INTO topology_links
               (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(session_id)
        .bind(index as i64)
        .bind(link["name"].as_str())
        .bind(src)
        .bind(dst)
        // as_i64() 对 JSON null 返回 None → bind NULL，逐列保真往返（含永久 NULL 端口/speed）。
        .bind(link["src_port"].as_i64())
        .bind(link["dst_port"].as_i64())
        .bind(link["speed"].as_i64())
        .bind(link["styles_json"].as_str().unwrap_or("{}"))
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("topology_links insert failed: {e}"))?;
    }

    tx.commit().await.map_err(|e| format!("commit failed: {e}"))
}

/// 读快照模板行 → 重建拓扑 → 返回 scenario（不含 mint/emit，便于单测）。
async fn use_snapshot_inner(
    pool: &Pool<Sqlite>,
    req: &UseSnapshotRequest,
) -> Result<String, String> {
    let row = sqlx::query(
        "SELECT kind, scenario_config_id, topology_snapshot FROM project_templates WHERE id = ?",
    )
    .bind(&req.template_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("模板不存在：{}", req.template_id))?;

    if row.get::<String, _>("kind") != "snapshot" {
        return Err("该模板不是快捷模板（kind != snapshot）".to_string());
    }
    let snapshot_str: String = row
        .get::<Option<String>, _>("topology_snapshot")
        .ok_or_else(|| "快捷模板缺 topology_snapshot".to_string())?;
    let snapshot: Value = serde_json::from_str(&snapshot_str).map_err(|e| e.to_string())?;

    rebuild_from_snapshot(pool, &req.session_id, &snapshot).await?;
    Ok(row.get::<String, _>("scenario_config_id"))
}

#[tauri::command]
pub async fn list_project_templates(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<Vec<TemplateRow>, String> {
    let pool = store.pool(&app).await?;
    list_inner(pool).await
}

#[tauri::command]
pub async fn delete_project_template(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    id: String,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    sqlx::query("DELETE FROM project_templates WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_project_templates(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    for (index, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE project_templates SET sort_order = ? WHERE id = ?")
            .bind(index as i64)
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_snapshot_template(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: CreateSnapshotRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    create_snapshot_inner(pool, &request).await
}

#[tauri::command]
pub async fn use_snapshot_template(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    buffer: tauri::State<
        '_,
        std::sync::Arc<crate::topology_mutation_buffer::TopologyMutationBuffer>,
    >,
    request: UseSnapshotRequest,
) -> Result<UseSnapshotResponse, String> {
    let pool = store.pool(&app).await?;
    let scenario_config_id = use_snapshot_inner(pool, &request).await?;
    // mint mutationId + emit session_db_changed（复用既有通知链，前端 refetch 拓扑）。
    let record = buffer.push(request.session_id.clone(), "topology".to_string());
    crate::topology_position_command::emit_session_db_changed(&app, &record);
    Ok(UseSnapshotResponse {
        scenario_config_id,
        mutation_id: record.mutation_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh_pool() -> Pool<Sqlite> {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
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
        crate::db::ensure_project_templates_table(&pool)
            .await
            .unwrap();
        crate::db::ensure_project_templates_seeded(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','n','n','{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    async fn seed_topology(pool: &Pool<Sqlite>) {
        for (mid, ty, ord) in [("0", "switch", 0), ("1", "endSystem", 1)] {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, 'N', 1.5, 2.5, ?, 8, 8, ?)")
                .bind(mid).bind(ty).bind(ord).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '1', '0', 0, 0, 1000, '{\"plane\":\"A\"}')")
            .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn list_returns_seeded_factory_prompts_ordered() {
        let pool = fresh_pool().await;
        let rows = list_inner(&pool).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, "tpl-factory-linear");
        assert_eq!(rows[2].id, "tpl-factory-dualplane");
        assert!(
            rows.iter()
                .all(|r| r.kind == "prompt" && r.origin == "factory")
        );
        assert!(rows[0].prompt_text.is_some());
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let pool = fresh_pool().await;
        sqlx::query("DELETE FROM project_templates WHERE id = 'tpl-factory-star'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(list_inner(&pool).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn reorder_rewrites_sort_order() {
        let pool = fresh_pool().await;
        for (index, id) in [
            "tpl-factory-dualplane",
            "tpl-factory-linear",
            "tpl-factory-star",
        ]
        .iter()
        .enumerate()
        {
            sqlx::query("UPDATE project_templates SET sort_order = ? WHERE id = ?")
                .bind(index as i64)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let rows = list_inner(&pool).await.unwrap();
        assert_eq!(rows[0].id, "tpl-factory-dualplane");
    }

    #[tokio::test]
    async fn create_snapshot_captures_all_columns_and_scenario() {
        let pool = fresh_pool().await;
        seed_topology(&pool).await;
        create_snapshot_inner(
            &pool,
            &CreateSnapshotRequest {
                session_id: "s1".into(),
                title: "我的双平面".into(),
                scenario_config_id: "aerospace-onboard".into(),
            },
        )
        .await
        .unwrap();

        let row = sqlx::query(
            "SELECT kind, origin, scenario_config_id, title, topology_snapshot FROM project_templates WHERE kind = 'snapshot'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("kind"), "snapshot");
        assert_eq!(row.get::<String, _>("origin"), "user");
        assert_eq!(
            row.get::<String, _>("scenario_config_id"),
            "aerospace-onboard"
        );
        let snap: Value = serde_json::from_str(&row.get::<String, _>("topology_snapshot")).unwrap();
        assert_eq!(snap["nodes"].as_array().unwrap().len(), 2);
        // 逐列往返：x/y/node_type/styles_json 都在。
        assert_eq!(snap["nodes"][0]["x"], 1.5);
        assert_eq!(snap["nodes"][0]["node_type"], "switch");
        assert_eq!(snap["links"][0]["styles_json"], "{\"plane\":\"A\"}");
    }

    #[tokio::test]
    async fn use_snapshot_rebuilds_topology_and_returns_scenario() {
        let pool = fresh_pool().await;
        seed_topology(&pool).await;
        // 从 s1 建快照模板（含 aerospace 场景）。
        create_snapshot_inner(
            &pool,
            &CreateSnapshotRequest {
                session_id: "s1".into(),
                title: "快照A".into(),
                scenario_config_id: "aerospace-onboard".into(),
            },
        )
        .await
        .unwrap();
        let tpl_id: String =
            sqlx::query_scalar("SELECT id FROM project_templates WHERE kind = 'snapshot'")
                .fetch_one(&pool)
                .await
                .unwrap();

        // 目标空 session s2。
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s2','t','n','n','{}')")
            .execute(&pool).await.unwrap();

        let scenario = use_snapshot_inner(
            &pool,
            &UseSnapshotRequest {
                template_id: tpl_id,
                session_id: "s2".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(scenario, "aerospace-onboard");

        // s2 拓扑逐列 == 快照来源。
        let node_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = 's2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(node_count, 2);
        let (x, ntype): (f64, Option<String>) = sqlx::query_as(
            "SELECT x, node_type FROM topology_nodes WHERE session_id = 's2' AND mid = '0'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(x, 1.5);
        assert_eq!(ntype.as_deref(), Some("switch"));
        let styles: String = sqlx::query_scalar(
            "SELECT styles_json FROM topology_links WHERE session_id = 's2' AND link_seq = 0",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(styles, "{\"plane\":\"A\"}");
    }

    #[tokio::test]
    async fn use_snapshot_rejects_non_snapshot_kind() {
        let pool = fresh_pool().await;
        let err = use_snapshot_inner(
            &pool,
            &UseSnapshotRequest {
                template_id: "tpl-factory-linear".into(), // kind=prompt
                session_id: "s1".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("不是快捷模板"));
    }

    #[tokio::test]
    async fn snapshot_roundtrip_preserves_null_ports_without_panic() {
        let pool = fresh_pool().await;
        // 两节点 + 一条 NULL 端口/speed 的链路（存量/非数字端口行——db.rs 记为永久 NULL）。
        sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1','0',NULL,0,0,'switch',8,8,0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1','1',NULL,0,0,'endSystem',8,8,1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1',0,NULL,'1','0',NULL,NULL,NULL,'{}')")
            .execute(&pool).await.unwrap();

        // create 不因 NULL 端口 panic。
        create_snapshot_inner(
            &pool,
            &CreateSnapshotRequest {
                session_id: "s1".into(),
                title: "null 端口".into(),
                scenario_config_id: "generic-tsn".into(),
            },
        )
        .await
        .unwrap();
        let tpl_id: String =
            sqlx::query_scalar("SELECT id FROM project_templates WHERE kind='snapshot'")
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s2','t','n','n','{}')")
            .execute(&pool).await.unwrap();

        // use 不 panic，NULL 逐列保真。
        use_snapshot_inner(
            &pool,
            &UseSnapshotRequest {
                template_id: tpl_id,
                session_id: "s2".into(),
            },
        )
        .await
        .unwrap();
        let sp: Option<i64> = sqlx::query_scalar(
            "SELECT src_port FROM topology_links WHERE session_id='s2' AND link_seq=0",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(sp, None, "NULL 端口应逐列保真往返");
    }

    #[tokio::test]
    async fn create_snapshot_rejects_empty_topology() {
        let pool = fresh_pool().await;
        let err = create_snapshot_inner(
            &pool,
            &CreateSnapshotRequest {
                session_id: "s1".into(),
                title: "空".into(),
                scenario_config_id: "generic-tsn".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("无拓扑"));
    }
}
