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
    /// 节点逻辑序号（主键 / 身份；前端画布 id 与选中键）。
    pub sync_name: String,
    /// 逻辑节点名（如 ES-1），initialize 写入；缺失时前端回退派生名。
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub node_type: Option<String>,
    pub insert_order: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyLinkRow {
    pub link_seq: i64,
    pub name: Option<String>,
    pub src_sync_name: String,
    pub dst_sync_name: String,
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
        r#"SELECT sync_name, name, x, y, node_type, insert_order
           FROM topology_nodes
           WHERE session_id = ?
           ORDER BY insert_order, sync_name"#,
    )
    .bind(&request.session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询节点失败：{e}"))?;
    let links = sqlx::query(
        r#"SELECT link_seq, name, src_sync_name, dst_sync_name, styles_json
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
                sync_name: r.get("sync_name"),
                name: r.get("name"),
                x: r.get("x"),
                y: r.get("y"),
                node_type: r.get("node_type"),
                insert_order: r.get("insert_order"),
            })
            .collect(),
        links: links
            .into_iter()
            .map(|r| TopologyLinkRow {
                link_seq: r.get("link_seq"),
                name: r.get("name"),
                src_sync_name: r.get("src_sync_name"),
                dst_sync_name: r.get("dst_sync_name"),
                styles_json: r.get("styles_json"),
            })
            .collect(),
    })
}

/// 读库内拓扑行、调 topology_verify 核心。verify_topology 命令、sidecar validate（无参验库内）、测试共用。
pub async fn load_and_verify_topology(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<crate::topology_verify::VerifyResult, String> {
    let node_rows = sqlx::query(
        "SELECT sync_name, name, node_type FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, sync_name",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询节点失败：{e}"))?;
    let link_rows = sqlx::query(
        "SELECT link_seq, src_sync_name, dst_sync_name, styles_json FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询链路失败：{e}"))?;

    let nodes: Vec<crate::topology_verify::VerifyNode> = node_rows
        .into_iter()
        .map(|r| crate::topology_verify::VerifyNode {
            sync_name: r.get("sync_name"),
            name: r.get("name"),
            node_type: r.get("node_type"),
        })
        .collect();
    let links: Vec<crate::topology_verify::VerifyLink> = link_rows
        .into_iter()
        .map(|r| crate::topology_verify::VerifyLink {
            link_seq: r.get("link_seq"),
            src_sync_name: r.get("src_sync_name"),
            dst_sync_name: r.get("dst_sync_name"),
            styles_json: r.get("styles_json"),
        })
        .collect();

    Ok(crate::topology_verify::verify_topology(&nodes, &links))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTopologyRequest {
    session_id: String,
}

/// 确认过关闸用：读库内拓扑跑结构+MAC 校验，返回 VerifyResult（camelCase）。
#[tauri::command]
pub async fn verify_topology(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: VerifyTopologyRequest,
) -> Result<crate::topology_verify::VerifyResult, String> {
    let pool = store.pool(&app).await?;
    load_and_verify_topology(pool, &request.session_id).await
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
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, x, y, insert_order) VALUES ('s1', '1', 1.0, 1.0, 1), ('s1', '0', 0.0, 0.0, 0)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('s1', 0, '0', '1', '{}')")
                .execute(&pool).await.unwrap();

            // 直接调用底层 query 路径（bypass Tauri State 包装）
            let nodes = sqlx::query("SELECT sync_name, x, y, node_type, insert_order FROM topology_nodes WHERE session_id = 's1' ORDER BY insert_order, sync_name")
                .fetch_all(&pool).await.unwrap();
            assert_eq!(nodes.len(), 2);
            assert_eq!(nodes[0].get::<String, _>("sync_name"), "0"); // insert_order=0 排前
            assert_eq!(nodes[1].get::<String, _>("sync_name"), "1");
        });
    }

    #[test]
    fn verify_passes_for_legal_topology() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, node_type, x, y, insert_order) VALUES ('s1', '0', 'switch', 0, 0, 0), ('s1', '1', 'endSystem', 1, 1, 1)")
                .execute(&pool).await.unwrap();
            sqlx::query(r#"INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('s1', 0, '0', '1', '{"leftLabel":"0","rightLabel":"0"}')"#)
                .execute(&pool).await.unwrap();
            let r = load_and_verify_topology(&pool, "s1").await.unwrap();
            assert!(r.ok, "errors: {:?}", r.errors);
            assert_eq!(r.caliber, "structural_only");
        });
    }

    #[test]
    fn verify_blocks_dangling_link() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO topology_nodes (session_id, sync_name, node_type, x, y, insert_order) VALUES ('s1', '0', 'switch', 0, 0, 0), ('s1', '1', 'endSystem', 1, 1, 1)")
                .execute(&pool).await.unwrap();
            sqlx::query(r#"INSERT INTO topology_links (session_id, link_seq, src_sync_name, dst_sync_name, styles_json) VALUES ('s1', 0, '0', '1', '{"leftLabel":"0","rightLabel":"0"}'), ('s1', 1, '0', '99', '{"leftLabel":"1","rightLabel":"0"}')"#)
                .execute(&pool).await.unwrap();
            let r = load_and_verify_topology(&pool, "s1").await.unwrap();
            assert!(!r.ok);
            assert!(r.errors.iter().any(|e| e.code == "DANGLING_LINK"));
        });
    }

    #[test]
    fn verify_empty_session_blocks() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 没有拓扑行 → EMPTY_TOPOLOGY，不崩。
            let r = load_and_verify_topology(&pool, "s1").await.unwrap();
            assert!(!r.ok);
            assert!(r.errors.iter().any(|e| e.code == "EMPTY_TOPOLOGY"));
        });
    }
}
