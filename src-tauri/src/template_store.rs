//! 工程模板 store（2026-07-09，落地页）：`project_templates` 表的读/删/排序/从 session 快照建模板。
//! 两类模板同表按 `kind` 判别（prompt / snapshot）。命令经 `SessionStore` 拿同一 app db pool。
//! 出厂 prompt 行由 `db::ensure_project_templates_seeded` 一次性播种；本模块只做 CRUD。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
async fn snapshot_topology(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<Option<Value>, String> {
    let node_rows = sqlx::query(
        "SELECT mid, name, x, y, node_type, port_count, queue_count, insert_order \
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
                "src_port": r.get::<i64, _>("src_port"),
                "dst_port": r.get::<i64, _>("dst_port"),
                "speed": r.get::<i64, _>("speed"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh_pool() -> Pool<Sqlite> {
        let opts = SqliteConnectOptions::new().in_memory(true).foreign_keys(true);
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
        assert!(rows.iter().all(|r| r.kind == "prompt" && r.origin == "factory"));
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
        for (index, id) in ["tpl-factory-dualplane", "tpl-factory-linear", "tpl-factory-star"]
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
        assert_eq!(row.get::<String, _>("scenario_config_id"), "aerospace-onboard");
        let snap: Value =
            serde_json::from_str(&row.get::<String, _>("topology_snapshot")).unwrap();
        assert_eq!(snap["nodes"].as_array().unwrap().len(), 2);
        // 逐列往返：x/y/node_type/styles_json 都在。
        assert_eq!(snap["nodes"][0]["x"], 1.5);
        assert_eq!(snap["nodes"][0]["node_type"], "switch");
        assert_eq!(snap["links"][0]["styles_json"], "{\"plane\":\"A\"}");
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
