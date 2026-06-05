//! Plan v3 U4a-1：topology MCP ops 白名单 enum。
//!
//! 跨 session_id 引用 / 写 sessions / app_state / 未声明 op 直接 400。
//! Phase A tracer subset (per plan v3 R13) 是插入交换机：`link.delete` + `node.add`
//! + `link.add`；本 enum 含 P0 全部所需 variant（Import session 复用相同 ops，
//! plan v3 R19）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TopologyOp {
    NodeAdd(NodeAddArgs),
    NodeUpdate(NodeUpdateArgs),
    NodeDelete(NodeDeleteArgs),
    LinkAdd(LinkAddArgs),
    LinkDelete(LinkDeleteArgs),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeAddArgs {
    pub imac: i64,
    pub sync_name: String,
    pub x: f64,
    pub y: f64,
    pub sync_type: String,
    #[serde(default)]
    pub node_type: Option<String>,
    pub insert_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUpdateArgs {
    pub imac: i64,
    #[serde(default)]
    pub sync_name: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub sync_type: Option<String>,
    #[serde(default)]
    pub node_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDeleteArgs {
    pub imac: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAddArgs {
    pub link_seq: i64,
    #[serde(default)]
    pub name: Option<String>,
    pub src_imac: i64,
    pub dst_imac: i64,
    pub styles_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDeleteArgs {
    pub link_seq: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResultSummary {
    pub op_kind: &'static str,
    pub rows_affected: u64,
}

/// 执行单条 op 到 transaction；返回 summary 用于 changeSet。
pub async fn apply_op(
    tx: &mut sqlx::SqliteConnection,
    session_id: &str,
    op: &TopologyOp,
) -> Result<OpResultSummary, OpError> {
    match op {
        TopologyOp::NodeAdd(a) => {
            let res = sqlx::query(
                r#"INSERT INTO topology_nodes
                   (session_id, imac, sync_name, x, y, sync_type, node_type, insert_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(session_id)
            .bind(a.imac)
            .bind(&a.sync_name)
            .bind(a.x)
            .bind(a.y)
            .bind(&a.sync_type)
            .bind(&a.node_type)
            .bind(a.insert_order)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            Ok(OpResultSummary {
                op_kind: "node.add",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::NodeUpdate(a) => {
            // 简化：仅在提供字段时更新；用 COALESCE 保留原值。
            let res = sqlx::query(
                r#"UPDATE topology_nodes
                   SET sync_name = COALESCE(?, sync_name),
                       x = COALESCE(?, x),
                       y = COALESCE(?, y),
                       sync_type = COALESCE(?, sync_type),
                       node_type = COALESCE(?, node_type)
                   WHERE session_id = ? AND imac = ?"#,
            )
            .bind(&a.sync_name)
            .bind(a.x)
            .bind(a.y)
            .bind(&a.sync_type)
            .bind(&a.node_type)
            .bind(session_id)
            .bind(a.imac)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                return Err(OpError::NotFound(format!("topology_nodes(imac={})", a.imac)));
            }
            Ok(OpResultSummary {
                op_kind: "node.update",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::NodeDelete(a) => {
            let res = sqlx::query(
                "DELETE FROM topology_nodes WHERE session_id = ? AND imac = ?",
            )
            .bind(session_id)
            .bind(a.imac)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                return Err(OpError::NotFound(format!("topology_nodes(imac={})", a.imac)));
            }
            Ok(OpResultSummary {
                op_kind: "node.delete",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::LinkAdd(a) => {
            let res = sqlx::query(
                r#"INSERT INTO topology_links
                   (session_id, link_seq, name, src_imac, dst_imac, styles_json)
                   VALUES (?, ?, ?, ?, ?, ?)"#,
            )
            .bind(session_id)
            .bind(a.link_seq)
            .bind(&a.name)
            .bind(a.src_imac)
            .bind(a.dst_imac)
            .bind(&a.styles_json)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            Ok(OpResultSummary {
                op_kind: "link.add",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::LinkDelete(a) => {
            let res = sqlx::query(
                "DELETE FROM topology_links WHERE session_id = ? AND link_seq = ?",
            )
            .bind(session_id)
            .bind(a.link_seq)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                return Err(OpError::NotFound(format!("topology_links(link_seq={})", a.link_seq)));
            }
            Ok(OpResultSummary {
                op_kind: "link.delete",
                rows_affected: res.rows_affected(),
            })
        }
    }
}

#[derive(Debug)]
pub enum OpError {
    NotFound(String),
    Database(String),
}

impl OpError {
    pub fn http_status(&self) -> axum::http::StatusCode {
        match self {
            OpError::NotFound(_) => axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            OpError::Database(_) => axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            OpError::NotFound(_) => "NOT_FOUND",
            OpError::Database(_) => "DATABASE_ERROR",
        }
    }
    pub fn message(&self) -> String {
        match self {
            OpError::NotFound(m) | OpError::Database(m) => m.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
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
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn node_add_then_inspect() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut *tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    imac: 100,
                    sync_name: "0".to_string(),
                    x: 1.0,
                    y: 2.0,
                    sync_type: r#"{"_classPath":"Q.Graphs.exchanger"}"#.to_string(),
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let row = sqlx::query("SELECT imac, sync_name FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(row.get::<i64, _>("imac"), 100);
            assert_eq!(row.get::<String, _>("sync_name"), "0");
        });
    }

    #[test]
    fn node_delete_missing_returns_not_found_and_rolls_back() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(
                &mut *tx,
                "s1",
                &TopologyOp::NodeDelete(NodeDeleteArgs { imac: 999 }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::NotFound(_)));
        });
    }

    #[test]
    fn link_add_and_delete_round_trip() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();

            // 先 seed 两端点节点（topology_links 无 FK 到 topology_nodes，但语义需要）
            apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 1, sync_name: "0".into(), x: 0.0, y: 0.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap();
            apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 2, sync_name: "1".into(), x: 1.0, y: 1.0,
                sync_type: "{}".into(), node_type: None, insert_order: 1,
            })).await.unwrap();

            apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2,
                styles_json: "{}".into(),
            })).await.unwrap();

            let s = apply_op(&mut *tx, "s1", &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }))
                .await.unwrap();
            assert_eq!(s.op_kind, "link.delete");
            assert_eq!(s.rows_affected, 1);
            tx.commit().await.unwrap();
        });
    }

    #[test]
    fn node_update_preserves_unmentioned_fields() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 10, sync_name: "before".into(), x: 1.0, y: 2.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap();
            apply_op(&mut *tx, "s1", &TopologyOp::NodeUpdate(NodeUpdateArgs {
                imac: 10, sync_name: Some("after".into()),
                x: None, y: None, sync_type: None, node_type: None,
            })).await.unwrap();
            tx.commit().await.unwrap();

            let row = sqlx::query("SELECT sync_name, x FROM topology_nodes WHERE imac=10")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(row.get::<String, _>("sync_name"), "after");
            assert_eq!(row.get::<f64, _>("x"), 1.0); // 未提供 x → 保留
        });
    }

    #[test]
    fn op_error_maps_to_http_codes() {
        assert_eq!(OpError::NotFound("x".into()).http_status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(OpError::Database("y".into()).http_status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(OpError::NotFound("x".into()).code(), "NOT_FOUND");
        assert_eq!(OpError::Database("y".into()).code(), "DATABASE_ERROR");
    }
}
