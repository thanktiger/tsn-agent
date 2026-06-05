//! Plan v3 U4a-1：topology MCP ops 白名单 enum。
//!
//! 跨 session_id 引用 / 写 sessions / app_state / 未声明 op 直接 400。
//! Phase A tracer subset (per plan v3 R13) 是插入交换机：`link.delete` + `node.add`
//! + `link.add`；本 enum 含 P0 全部所需 variant（Import session 复用相同 ops，
//! plan v3 R19）。

use serde::{Deserialize, Serialize};
use sqlx::Row;

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

/// 三态写入的 JSON 字段同值判定：字符串相等最快路径；不等时退到 JSON 语义比较
/// （LLM 重试时可能重新序列化 —— 键序/空白变化不应误报 IMAC_TAKEN/LINK_SEQ_TAKEN
/// 阻断合法的幂等重放）。任一侧解析失败则按字符串不等处理。
fn json_or_string_eq(stored: &str, provided: &str) -> bool {
    if stored == provided {
        return true;
    }
    match (
        serde_json::from_str::<serde_json::Value>(stored),
        serde_json::from_str::<serde_json::Value>(provided),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 执行单条 op 到 transaction；返回 summary 用于 changeSet。
///
/// 幂等约定（数据可靠性包 + 三态写入碰撞防护）：sidecar 响应超时后客户端会把
/// apply_operations 标记为 retryable，而第一次调用可能已 commit。因此写操作
/// 必须重试安全，同时不允许静默覆盖已有行：
///   - node.add / link.add 三态写入：目标 key 不存在 → 插入；存在且同值 →
///     no-op（重放安全，rows_affected=0）；存在且异值 → IMAC_TAKEN /
///     LINK_SEQ_TAKEN（防模型选错 key 时静默覆盖现有节点）。同值比较只针对
///     请求实际提供的字段（absent 的 optional 字段不参与判定）；x/y 用 f64
///     直比（initialize 坐标全为精确可表示值，JSON/REAL round-trip 无损）。
///   - node.delete / link.delete 删除不存在的目标是 no-op（rows_affected=0）
///   - node.update 重放安全（目标在重放场景必然存在）；更新真正不存在的
///     目标仍报 NOT_FOUND —— 那是逻辑错误，不是重试。
///   - link.add 前校验两端节点存在（悬空链路进不了 DB）
///   - node.delete 拒绝仍有链路引用的节点（先 link.delete）
pub async fn apply_op(
    tx: &mut sqlx::SqliteConnection,
    session_id: &str,
    op: &TopologyOp,
) -> Result<OpResultSummary, OpError> {
    match op {
        TopologyOp::NodeAdd(a) => {
            // 三态写入：写决策由数据库原子完成（DO NOTHING），冲突时读回比对，
            // 无 SELECT-then-INSERT 的 TOCTOU 窗口。
            let res = sqlx::query(
                r#"INSERT INTO topology_nodes
                   (session_id, imac, sync_name, x, y, sync_type, node_type, insert_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(session_id, imac) DO NOTHING"#,
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
            if res.rows_affected() == 0 {
                let row = sqlx::query(
                    r#"SELECT sync_name, x, y, sync_type, node_type, insert_order
                       FROM topology_nodes WHERE session_id = ? AND imac = ?"#,
                )
                .bind(session_id)
                .bind(a.imac)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| OpError::Database(e.to_string()))?;
                let same_provided = row.get::<String, _>("sync_name") == a.sync_name
                    && row.get::<f64, _>("x") == a.x
                    && row.get::<f64, _>("y") == a.y
                    && json_or_string_eq(&row.get::<String, _>("sync_type"), &a.sync_type)
                    && row.get::<i64, _>("insert_order") == a.insert_order
                    // optional 字段仅在请求提供时参与判定（防重试省略时假阳性）
                    && a.node_type.as_ref().is_none_or(|nt| {
                        row.get::<Option<String>, _>("node_type").as_deref() == Some(nt.as_str())
                    });
                if !same_provided {
                    return Err(OpError::ImacTaken(format!(
                        "imac={} 已存在且取值不同；修改已有节点属性请用 node_update，新增节点请换未占用 imac（先 inspect）",
                        a.imac
                    )));
                }
                // 同值 → no-op（幂等重放），rows_affected=0 自述。
            }
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
            let link_refs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_links WHERE session_id = ? AND (src_imac = ? OR dst_imac = ?)",
            )
            .bind(session_id)
            .bind(a.imac)
            .bind(a.imac)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if link_refs > 0 {
                return Err(OpError::NodeHasLinks(format!(
                    "topology_nodes(imac={}) still referenced by {} link(s); delete the links first",
                    a.imac, link_refs
                )));
            }
            let res = sqlx::query(
                "DELETE FROM topology_nodes WHERE session_id = ? AND imac = ?",
            )
            .bind(session_id)
            .bind(a.imac)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            // 幂等：目标不存在视为已删除（重试安全），rows_affected=0 自述 no-op。
            Ok(OpResultSummary {
                op_kind: "node.delete",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::LinkAdd(a) => {
            let endpoint_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_nodes WHERE session_id = ? AND imac IN (?, ?)",
            )
            .bind(session_id)
            .bind(a.src_imac)
            .bind(a.dst_imac)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            let expected = if a.src_imac == a.dst_imac { 1 } else { 2 };
            if endpoint_count < expected {
                return Err(OpError::UnknownNode(format!(
                    "link.add(link_seq={}) references missing node(s): src_imac={} dst_imac={}",
                    a.link_seq, a.src_imac, a.dst_imac
                )));
            }
            // 三态写入：同 node.add，冲突时读回只比对请求提供的字段。
            let res = sqlx::query(
                r#"INSERT INTO topology_links
                   (session_id, link_seq, name, src_imac, dst_imac, styles_json)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(session_id, link_seq) DO NOTHING"#,
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
            if res.rows_affected() == 0 {
                let row = sqlx::query(
                    r#"SELECT name, src_imac, dst_imac, styles_json
                       FROM topology_links WHERE session_id = ? AND link_seq = ?"#,
                )
                .bind(session_id)
                .bind(a.link_seq)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| OpError::Database(e.to_string()))?;
                let same_provided = row.get::<i64, _>("src_imac") == a.src_imac
                    && row.get::<i64, _>("dst_imac") == a.dst_imac
                    && json_or_string_eq(&row.get::<String, _>("styles_json"), &a.styles_json)
                    && a.name.as_ref().is_none_or(|n| {
                        row.get::<Option<String>, _>("name").as_deref() == Some(n.as_str())
                    });
                if !same_provided {
                    return Err(OpError::LinkSeqTaken(format!(
                        "linkSeq={} 已存在且取值不同；新增链路请换未占用 linkSeq（先 inspect），删旧建新请用 link_delete + link_add",
                        a.link_seq
                    )));
                }
            }
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
            // 幂等：目标不存在视为已删除（重试安全），rows_affected=0 自述 no-op。
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
    /// link.add 引用了不存在的端点节点（悬空链路拦截）。
    UnknownNode(String),
    /// node.delete 的目标仍被链路引用（先 link.delete）。
    NodeHasLinks(String),
    /// node.add 的目标 imac 已存在且取值不同（三态写入碰撞；改属性走 node_update）。
    ImacTaken(String),
    /// link.add 的目标 link_seq 已存在且取值不同（三态写入碰撞）。
    LinkSeqTaken(String),
}

impl OpError {
    /// SQLite 层错误（BUSY/IO/锁超时）是瞬时的，可重试；业务规则错误不可重试。
    pub fn is_retryable(&self) -> bool {
        matches!(self, OpError::Database(_))
    }
    pub fn http_status(&self) -> axum::http::StatusCode {
        match self {
            OpError::NotFound(_)
            | OpError::Database(_)
            | OpError::UnknownNode(_)
            | OpError::NodeHasLinks(_)
            | OpError::ImacTaken(_)
            | OpError::LinkSeqTaken(_) => axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            OpError::NotFound(_) => "NOT_FOUND",
            OpError::Database(_) => "DATABASE_ERROR",
            OpError::UnknownNode(_) => "UNKNOWN_NODE",
            OpError::NodeHasLinks(_) => "NODE_HAS_LINKS",
            OpError::ImacTaken(_) => "IMAC_TAKEN",
            OpError::LinkSeqTaken(_) => "LINK_SEQ_TAKEN",
        }
    }
    pub fn message(&self) -> String {
        match self {
            OpError::NotFound(m)
            | OpError::Database(m)
            | OpError::UnknownNode(m)
            | OpError::NodeHasLinks(m)
            | OpError::ImacTaken(m)
            | OpError::LinkSeqTaken(m) => m.clone(),
        }
    }
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
    fn node_delete_missing_is_idempotent_noop() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            // 幂等：删除不存在的节点 = no-op 成功（重试安全），rows_affected=0。
            let s = apply_op(
                &mut *tx,
                "s1",
                &TopologyOp::NodeDelete(NodeDeleteArgs { imac: 999 }),
            )
            .await
            .unwrap();
            assert_eq!(s.op_kind, "node.delete");
            assert_eq!(s.rows_affected, 0);
        });
    }

    #[test]
    fn insert_switch_batch_replay_is_retry_safe() {
        // 模拟 timeout-after-commit 重试：同一 tracer batch（link.delete +
        // node.add + link.add×2）跑两遍，第二遍必须整批成功且数据一致。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut seed = pool.begin().await.unwrap();
            for (imac, order) in [(1_i64, 0_i64), (2, 1)] {
                apply_op(&mut *seed, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                    imac, sync_name: imac.to_string(), x: 0.0, y: 0.0,
                    sync_type: "{}".into(), node_type: None, insert_order: order,
                })).await.unwrap();
            }
            apply_op(&mut *seed, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2, styles_json: "{}".into(),
            })).await.unwrap();
            seed.commit().await.unwrap();

            let batch = vec![
                TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }),
                TopologyOp::NodeAdd(NodeAddArgs {
                    imac: 3, sync_name: "3".into(), x: 0.5, y: 0.5,
                    sync_type: "{}".into(), node_type: Some("switch".into()), insert_order: 2,
                }),
                TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 1, name: None, src_imac: 1, dst_imac: 3, styles_json: "{}".into(),
                }),
                TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 2, name: None, src_imac: 3, dst_imac: 2, styles_json: "{}".into(),
                }),
            ];

            for round in 0..2 {
                let mut tx = pool.begin().await.unwrap();
                for op in &batch {
                    apply_op(&mut *tx, "s1", op)
                        .await
                        .unwrap_or_else(|e| panic!("round {round} failed: {e:?}"));
                }
                tx.commit().await.unwrap();
            }

            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(node_count, 3);
            assert_eq!(link_count, 2);
        });
    }

    #[test]
    fn node_add_same_value_replay_is_noop_even_with_optional_fields_omitted() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 100, sync_name: "0".into(), x: 1.0, y: 2.0,
                sync_type: "{}".into(), node_type: Some("switch".into()), insert_order: 0,
            })).await.unwrap();
            // 重放省略 optional 的 nodeType（存量行 nodeType="switch"）：
            // absent 字段不参与异值判定 → 仍判同值 no-op（假阳性回归）。
            let s = apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 100, sync_name: "0".into(), x: 1.0, y: 2.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap();
            assert_eq!(s.op_kind, "node.add");
            assert_eq!(s.rows_affected, 0);
            tx.commit().await.unwrap();

            let row = sqlx::query("SELECT node_type FROM topology_nodes WHERE session_id='s1' AND imac=100")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(row.get::<Option<String>, _>("node_type").as_deref(), Some("switch"));
        });
    }

    #[test]
    fn node_add_collision_with_different_values_reports_imac_taken() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut seed = pool.begin().await.unwrap();
            apply_op(&mut *seed, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 100, sync_name: "0".into(), x: 1.0, y: 2.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap();
            seed.commit().await.unwrap();

            // 同 imac、不同坐标 → 碰撞报错（v0.3.2 UPSERT 会静默覆盖，三态拒绝）。
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 100, sync_name: "0".into(), x: 9.0, y: 9.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap_err();
            assert!(matches!(err, OpError::ImacTaken(_)));
            assert_eq!(err.code(), "IMAC_TAKEN");
            // 错误信息给出路：改属性应走 node_update。
            assert!(err.message().contains("node_update"), "message={}", err.message());
            tx.rollback().await.unwrap();

            // 原节点完好。
            let row = sqlx::query("SELECT x FROM topology_nodes WHERE session_id='s1' AND imac=100")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(row.get::<f64, _>("x"), 1.0);
        });
    }

    #[test]
    fn link_add_collision_with_different_values_reports_link_seq_taken() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for (imac, order) in [(1_i64, 0_i64), (2, 1), (3, 2)] {
                apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                    imac, sync_name: imac.to_string(), x: 0.0, y: 0.0,
                    sync_type: "{}".into(), node_type: None, insert_order: order,
                })).await.unwrap();
            }
            apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2, styles_json: "{}".into(),
            })).await.unwrap();

            // 同 linkSeq、不同端点 → 碰撞报错。
            let err = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 3, styles_json: "{}".into(),
            })).await.unwrap_err();
            assert!(matches!(err, OpError::LinkSeqTaken(_)));
            assert_eq!(err.code(), "LINK_SEQ_TAKEN");

            // 同值重放仍是 no-op。
            let s = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2, styles_json: "{}".into(),
            })).await.unwrap();
            assert_eq!(s.rows_affected, 0);
        });
    }

    #[test]
    fn replay_with_reserialized_json_fields_is_still_noop() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for (imac, order) in [(1_i64, 0_i64), (2, 1)] {
                apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                    imac, sync_name: imac.to_string(), x: 0.0, y: 0.0,
                    sync_type: r#"{"_classPath":"Q.Graphs.exchanger2","rev":1}"#.into(),
                    node_type: None, insert_order: order,
                })).await.unwrap();
            }
            apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2,
                styles_json: r#"{"leftLabel":"P1","speed":1000}"#.into(),
            })).await.unwrap();

            // LLM 重试时重新序列化 JSON（键序/空白变化）：语义同值必须仍判 no-op，
            // 不得误报 IMAC_TAKEN / LINK_SEQ_TAKEN（adversarial 发现 3 回归）。
            let s = apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 1, sync_name: "1".into(), x: 0.0, y: 0.0,
                sync_type: r#"{ "rev": 1, "_classPath": "Q.Graphs.exchanger2" }"#.into(),
                node_type: None, insert_order: 0,
            })).await.unwrap();
            assert_eq!(s.rows_affected, 0);
            let s = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2,
                styles_json: r#"{ "speed": 1000, "leftLabel": "P1" }"#.into(),
            })).await.unwrap();
            assert_eq!(s.rows_affected, 0);

            // 语义不同的 JSON 仍是异值碰撞。
            let err = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2,
                styles_json: r#"{"leftLabel":"P1","speed":100}"#.into(),
            })).await.unwrap_err();
            assert!(matches!(err, OpError::LinkSeqTaken(_)));
        });
    }

    #[test]
    fn link_add_self_loop_requires_single_endpoint() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                imac: 1, sync_name: "0".into(), x: 0.0, y: 0.0,
                sync_type: "{}".into(), node_type: None, insert_order: 0,
            })).await.unwrap();
            // self-loop（src==dst）端点计数 expected=1：节点存在即通过悬空校验。
            let s = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 1, styles_json: "{}".into(),
            })).await.unwrap();
            assert_eq!(s.rows_affected, 1);
            // 节点不存在的 self-loop 仍被拦截。
            let err = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 1, name: None, src_imac: 9, dst_imac: 9, styles_json: "{}".into(),
            })).await.unwrap_err();
            assert!(matches!(err, OpError::UnknownNode(_)));
        });
    }

    #[test]
    fn link_add_rejects_unknown_endpoints() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 7, dst_imac: 8, styles_json: "{}".into(),
            })).await.unwrap_err();
            assert!(matches!(err, OpError::UnknownNode(_)));
            assert_eq!(err.code(), "UNKNOWN_NODE");
        });
    }

    #[test]
    fn node_delete_rejects_when_links_reference_it() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for (imac, order) in [(1_i64, 0_i64), (2, 1)] {
                apply_op(&mut *tx, "s1", &TopologyOp::NodeAdd(NodeAddArgs {
                    imac, sync_name: imac.to_string(), x: 0.0, y: 0.0,
                    sync_type: "{}".into(), node_type: None, insert_order: order,
                })).await.unwrap();
            }
            apply_op(&mut *tx, "s1", &TopologyOp::LinkAdd(LinkAddArgs {
                link_seq: 0, name: None, src_imac: 1, dst_imac: 2, styles_json: "{}".into(),
            })).await.unwrap();

            let err = apply_op(&mut *tx, "s1", &TopologyOp::NodeDelete(NodeDeleteArgs { imac: 1 }))
                .await.unwrap_err();
            assert!(matches!(err, OpError::NodeHasLinks(_)));
            assert_eq!(err.code(), "NODE_HAS_LINKS");

            // 先删链路再删节点 → 成功。
            apply_op(&mut *tx, "s1", &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }))
                .await.unwrap();
            let s = apply_op(&mut *tx, "s1", &TopologyOp::NodeDelete(NodeDeleteArgs { imac: 1 }))
                .await.unwrap();
            assert_eq!(s.rows_affected, 1);
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
    fn node_update_rejects_unknown_target() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            // 更新不存在的目标是逻辑错误（非重试场景），必须报 NOT_FOUND。
            let err = apply_op(&mut *tx, "s1", &TopologyOp::NodeUpdate(NodeUpdateArgs {
                imac: 999, sync_name: Some("ghost".into()),
                x: None, y: None, sync_type: None, node_type: None,
            })).await.unwrap_err();
            assert!(matches!(err, OpError::NotFound(_)));
            assert_eq!(err.code(), "NOT_FOUND");
        });
    }

    #[test]
    fn link_delete_missing_target_is_idempotent_noop() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            // 幂等：删除不存在的链路 = no-op 成功（重试安全），rows_affected=0。
            let s = apply_op(&mut *tx, "s1", &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 999 }))
                .await.unwrap();
            assert_eq!(s.op_kind, "link.delete");
            assert_eq!(s.rows_affected, 0);
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
        assert_eq!(OpError::UnknownNode("z".into()).code(), "UNKNOWN_NODE");
        assert_eq!(OpError::NodeHasLinks("w".into()).code(), "NODE_HAS_LINKS");
    }
}
