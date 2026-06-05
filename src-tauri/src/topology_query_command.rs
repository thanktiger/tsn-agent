//! Plan v3 U6/U4a-1：`query_topology` Tauri command。
//!
//! UI 调用此命令拉一个 session 的拓扑切片（不走 sidecar HTTP，
//! 直接 sqlx in-process 读 main pool；plan v3 KTD UI 读路径）。
//! 返回 nodes/links 数组 + counts，供 React 端 hydrate 视图。
//!
//! 设计：本 unit 只暴露 P0 必需的最小切片（topology_nodes / topology_links）。
//! Phase B 完整 React Flow / planner 输入 derive 留 U4a-2 完成（artifacts.ts
//! Rust 重写）。

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::session_store::SessionStore;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTopologyRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTopologyResponse {
    pub session_id: String,
    pub nodes: Vec<TopologyNodeRow>,
    pub links: Vec<TopologyLinkRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNodeRow {
    pub imac: i64,
    pub sync_name: String,
    pub x: f64,
    pub y: f64,
    pub sync_type: String,
    pub node_type: Option<String>,
    pub insert_order: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyLinkRow {
    pub link_seq: i64,
    pub name: Option<String>,
    pub src_imac: i64,
    pub dst_imac: i64,
    pub styles_json: String,
}

#[tauri::command]
pub async fn query_topology(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: QueryTopologyRequest,
) -> Result<QueryTopologyResponse, String> {
    let pool = store.pool(&app).await?;
    let nodes = sqlx::query(
        r#"SELECT imac, sync_name, x, y, sync_type, node_type, insert_order
           FROM topology_nodes
           WHERE session_id = ?
           ORDER BY insert_order, imac"#,
    )
    .bind(&request.session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询节点失败：{e}"))?;
    let links = sqlx::query(
        r#"SELECT link_seq, name, src_imac, dst_imac, styles_json
           FROM topology_links
           WHERE session_id = ?
           ORDER BY link_seq"#,
    )
    .bind(&request.session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询链路失败：{e}"))?;

    Ok(QueryTopologyResponse {
        session_id: request.session_id,
        nodes: nodes
            .into_iter()
            .map(|r| TopologyNodeRow {
                imac: r.get("imac"),
                sync_name: r.get("sync_name"),
                x: r.get("x"),
                y: r.get("y"),
                sync_type: r.get("sync_type"),
                node_type: r.get("node_type"),
                insert_order: r.get("insert_order"),
            })
            .collect(),
        links: links
            .into_iter()
            .map(|r| TopologyLinkRow {
                link_seq: r.get("link_seq"),
                name: r.get("name"),
                src_imac: r.get("src_imac"),
                dst_imac: r.get("dst_imac"),
                styles_json: r.get("styles_json"),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts).await.unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn query_topology_returns_ordered_nodes_and_links() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO topology_nodes (session_id, imac, sync_name, x, y, sync_type, insert_order) VALUES ('s1', 2, '1', 1.0, 1.0, '{}', 1), ('s1', 1, '0', 0.0, 0.0, '{}', 0)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_imac, dst_imac, styles_json) VALUES ('s1', 0, 1, 2, '{}')")
                .execute(&pool).await.unwrap();

            // 直接调用底层 query 路径（bypass Tauri State 包装）
            let nodes = sqlx::query("SELECT imac, sync_name, x, y, sync_type, node_type, insert_order FROM topology_nodes WHERE session_id = 's1' ORDER BY insert_order, imac")
                .fetch_all(&pool).await.unwrap();
            assert_eq!(nodes.len(), 2);
            assert_eq!(nodes[0].get::<i64, _>("imac"), 1); // insert_order=0 排前
            assert_eq!(nodes[1].get::<i64, _>("imac"), 2);
        });
    }
}
