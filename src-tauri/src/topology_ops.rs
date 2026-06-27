//! Plan v3 U4a-1：topology MCP ops 白名单 enum。
//!
//! 跨 session_id 引用 / 写 sessions / app_state / 未声明 op 直接 400。
//! Phase A tracer subset (per plan v3 R13) 是插入交换机：
//! `link.delete` + `node.add` + `link.add`；本 enum 含 P0 全部所需 variant
//! （Import session 复用相同 ops，plan v3 R19）。

use serde::{Deserialize, Serialize};
use sqlx::Row;

/// link.add 省略 speed 时的默认链路速率（Mbps），与 initialize 模板 dataRateMbps 默认对齐。
const DEFAULT_LINK_SPEED_MBPS: i64 = 1000;

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
    /// 节点逻辑序号（新主键，每会话唯一）。
    pub mid: String,
    /// 显示名（如 SW-1/ES-1）；省略则落 NULL、由展示层派生（U9，镜像 LinkAddArgs.name）。
    #[serde(default)]
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub node_type: Option<String>,
    pub insert_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUpdateArgs {
    /// 目标节点逻辑序号（键，不可改）。
    pub mid: String,
    /// 显示名（U9 闭环：node_add 设名后用本字段改名，避免「设错名只能删重建」死锁）。
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub node_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDeleteArgs {
    pub mid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAddArgs {
    pub link_seq: i64,
    #[serde(default)]
    pub name: Option<String>,
    pub src_node: String,
    pub dst_node: String,
    /// 链路在 src_node 上占用的端口号——显式直写列（KTD1/R25）。缺省 → 硬校验拒绝（KTD4，boss 定 B）。
    #[serde(default)]
    pub src_port: Option<i64>,
    /// 链路在 dst_node 上占用的端口号。缺省 → 硬校验拒绝。
    #[serde(default)]
    pub dst_port: Option<i64>,
    /// 链路速率（Mbps）；可选，缺省落库默认 1000（DEFAULT_LINK_SPEED_MBPS，与 initialize 模板对齐）。
    #[serde(default)]
    pub speed: Option<i64>,
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
///     no-op（重放安全，rows_affected=0）；存在且异值 → MID_TAKEN /
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
            // U3：mac/ip 确定性分配，ordinal 取 mid（逻辑序号）；非数字 mid 退 0。
            let ordinal = a.mid.parse::<i64>().unwrap_or(0);
            let mac = crate::topology_intermediate::assign_mac(ordinal);
            let ip = crate::topology_intermediate::assign_ip(ordinal);
            let res = sqlx::query(
                r#"INSERT INTO topology_nodes
                   (session_id, mid, name, x, y, node_type, mac, ip, insert_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(session_id, mid) DO NOTHING"#,
            )
            .bind(session_id)
            .bind(&a.mid)
            .bind(&a.name)
            .bind(a.x)
            .bind(a.y)
            .bind(&a.node_type)
            .bind(&mac)
            .bind(&ip)
            .bind(a.insert_order)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                let row = sqlx::query(
                    r#"SELECT name, x, y, node_type, insert_order
                       FROM topology_nodes WHERE session_id = ? AND mid = ?"#,
                )
                .bind(session_id)
                .bind(&a.mid)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| OpError::Database(e.to_string()))?;
                let same_provided = row.get::<f64, _>("x") == a.x
                    && row.get::<f64, _>("y") == a.y
                    && row.get::<i64, _>("insert_order") == a.insert_order
                    // optional 字段仅在请求提供时参与判定（防重试省略时假阳性）
                    && a.node_type.as_ref().is_none_or(|nt| {
                        row.get::<Option<String>, _>("node_type").as_deref() == Some(nt.as_str())
                    })
                    && a.name.as_ref().is_none_or(|n| {
                        row.get::<Option<String>, _>("name").as_deref() == Some(n.as_str())
                    });
                if !same_provided {
                    return Err(OpError::MidTaken(format!(
                        "mid={} 已存在且取值不同；修改已有节点属性请用 node_update，新增节点请换未占用 mid（先 inspect）",
                        a.mid
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
                   SET name = COALESCE(?, name),
                       x = COALESCE(?, x),
                       y = COALESCE(?, y),
                       node_type = COALESCE(?, node_type)
                   WHERE session_id = ? AND mid = ?"#,
            )
            .bind(&a.name)
            .bind(a.x)
            .bind(a.y)
            .bind(&a.node_type)
            .bind(session_id)
            .bind(&a.mid)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                return Err(OpError::NotFound(format!("topology_nodes(mid={})", a.mid)));
            }
            Ok(OpResultSummary {
                op_kind: "node.update",
                rows_affected: res.rows_affected(),
            })
        }
        TopologyOp::NodeDelete(a) => {
            let link_refs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_links WHERE session_id = ? AND (src_node = ? OR dst_node = ?)",
            )
            .bind(session_id)
            .bind(&a.mid)
            .bind(&a.mid)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if link_refs > 0 {
                return Err(OpError::NodeHasLinks(format!(
                    "topology_nodes(mid={}) still referenced by {} link(s); delete the links first",
                    a.mid, link_refs
                )));
            }
            let res = sqlx::query("DELETE FROM topology_nodes WHERE session_id = ? AND mid = ?")
                .bind(session_id)
                .bind(&a.mid)
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
                "SELECT COUNT(*) FROM topology_nodes WHERE session_id = ? AND mid IN (?, ?)",
            )
            .bind(session_id)
            .bind(&a.src_node)
            .bind(&a.dst_node)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            let expected = if a.src_node == a.dst_node { 1 } else { 2 };
            if endpoint_count < expected {
                return Err(OpError::UnknownNode(format!(
                    "link.add(link_seq={}) references missing node(s): srcNode={} dstNode={}",
                    a.link_seq, a.src_node, a.dst_node
                )));
            }
            // KTD4（boss 定 B）：端口走显式字段直写列；任一端口缺省 → 硬校验拒绝，
            // 不再 parse styles_json 兜底（拒绝即新 NULL 守卫，防列 NULL→时钟树断）。
            // styles_json 现仅承载 plane/role 显示属性。
            let (Some(src_port), Some(dst_port)) = (a.src_port, a.dst_port) else {
                return Err(OpError::LinkPortMissing(format!(
                    "link.add(link_seq={}) 缺 srcPort/dstPort：端口须经显式字段传入（styles_json 仅存 plane/role）；补全端口后重试",
                    a.link_seq
                )));
            };
            // speed 缺省兜底 1000 Mbps：大模型在 link.add 常省略 speed（schema 可选），导致手加链路
            // speed=NULL 与 initialize 模板链路（dataRateMbps 默认 1000）不一致、且触发硬件校验
            // missing_speed WARN。这里给确定性默认（用户指定速率时大模型仍可显式传，覆盖此默认）。
            let speed = a.speed.or(Some(DEFAULT_LINK_SPEED_MBPS));
            // 三态写入：同 node.add，冲突时读回只比对请求提供的字段。
            let res = sqlx::query(
                r#"INSERT INTO topology_links
                   (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(session_id, link_seq) DO NOTHING"#,
            )
            .bind(session_id)
            .bind(a.link_seq)
            .bind(&a.name)
            .bind(&a.src_node)
            .bind(&a.dst_node)
            .bind(src_port)
            .bind(dst_port)
            .bind(speed)
            .bind(&a.styles_json)
            .execute(&mut *tx)
            .await
            .map_err(|e| OpError::Database(e.to_string()))?;
            if res.rows_affected() == 0 {
                let row = sqlx::query(
                    r#"SELECT name, src_node, dst_node, src_port, dst_port, speed, styles_json
                       FROM topology_links WHERE session_id = ? AND link_seq = ?"#,
                )
                .bind(session_id)
                .bind(a.link_seq)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| OpError::Database(e.to_string()))?;
                let same_provided = row.get::<String, _>("src_node") == a.src_node
                    && row.get::<String, _>("dst_node") == a.dst_node
                    && row.get::<Option<i64>, _>("src_port") == Some(src_port)
                    && row.get::<Option<i64>, _>("dst_port") == Some(dst_port)
                    && json_or_string_eq(&row.get::<String, _>("styles_json"), &a.styles_json)
                    && a.name.as_ref().is_none_or(|n| {
                        row.get::<Option<String>, _>("name").as_deref() == Some(n.as_str())
                    })
                    && a.speed
                        .is_none_or(|s| row.get::<Option<i64>, _>("speed") == Some(s));
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
            let res =
                sqlx::query("DELETE FROM topology_links WHERE session_id = ? AND link_seq = ?")
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
    /// node.add 的目标 mid 已存在且取值不同（三态写入碰撞；改属性走 node_update）。
    MidTaken(String),
    /// link.add 的目标 link_seq 已存在且取值不同（三态写入碰撞）。
    LinkSeqTaken(String),
    /// link.add 缺显式 srcPort/dstPort（KTD4 硬校验拒绝，防列 NULL→时钟树断）。
    LinkPortMissing(String),
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
            | OpError::MidTaken(_)
            | OpError::LinkSeqTaken(_)
            | OpError::LinkPortMissing(_) => axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            OpError::NotFound(_) => "NOT_FOUND",
            OpError::Database(_) => "DATABASE_ERROR",
            OpError::UnknownNode(_) => "UNKNOWN_NODE",
            OpError::NodeHasLinks(_) => "NODE_HAS_LINKS",
            OpError::MidTaken(_) => "MID_TAKEN",
            OpError::LinkSeqTaken(_) => "LINK_SEQ_TAKEN",
            OpError::LinkPortMissing(_) => "LINK_PORT_MISSING",
        }
    }
    pub fn message(&self) -> String {
        match self {
            OpError::NotFound(m)
            | OpError::Database(m)
            | OpError::UnknownNode(m)
            | OpError::NodeHasLinks(m)
            | OpError::MidTaken(m)
            | OpError::LinkSeqTaken(m)
            | OpError::LinkPortMissing(m) => m.clone(),
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

    async fn seed_two_nodes(pool: &sqlx::Pool<sqlx::Sqlite>) {
        let mut tx = pool.begin().await.unwrap();
        for mid in ["0", "1"] {
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: mid.into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
    }

    // U6/KTD1/R25：link.add 用显式 srcPort/dstPort/speed 直写列（不经 styles_json parse）。
    #[test]
    fn link_add_writes_explicit_port_columns() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_two_nodes(&pool).await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(2),
                    dst_port: Some(3),
                    speed: Some(1000),
                    styles_json: r#"{"plane":"A","role":"master"}"#.into(),
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let row = sqlx::query(
                "SELECT src_port, dst_port, speed FROM topology_links WHERE session_id='s1' AND link_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<Option<i64>, _>("src_port"), Some(2));
            assert_eq!(row.get::<Option<i64>, _>("dst_port"), Some(3));
            assert_eq!(row.get::<Option<i64>, _>("speed"), Some(1000));
        });
    }

    // U6/KTD4（boss 定 B）/AE10：缺 srcPort 或 dstPort → 硬校验拒绝，不写库、不静默 NULL。
    #[test]
    fn link_add_rejects_missing_ports() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_two_nodes(&pool).await;
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(2),
                    dst_port: None,
                    speed: None,
                    styles_json: r#"{"plane":"A"}"#.into(),
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::LinkPortMissing(_)), "{err:?}");
            assert_eq!(err.code(), "LINK_PORT_MISSING");
            // 不写库：链路列空（时钟树不会因静默 NULL 断）。
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_links WHERE session_id='s1' AND link_seq=0",
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert_eq!(count, 0);
        });
    }

    // U6：端口齐全但 styles_json 无 leftLabel → 正常写入（证明写路径不再依赖 leftLabel）。
    #[test]
    fn link_add_writes_without_leftlabel() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_two_nodes(&pool).await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(4),
                    dst_port: Some(5),
                    speed: None,
                    styles_json: r#"{"plane":"B","role":"slave"}"#.into(),
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let row = sqlx::query(
                "SELECT src_port, dst_port FROM topology_links WHERE session_id='s1' AND link_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<Option<i64>, _>("src_port"), Some(4));
            assert_eq!(row.get::<Option<i64>, _>("dst_port"), Some(5));
        });
    }

    // link.add 省略 speed → 默认 1000 Mbps（与 initialize 模板的 dataRateMbps 默认对齐，
    // 避免手加链路 speed NULL 与初始链路 1000 不一致 + 消除硬件校验 missing_speed WARN 噪声）。
    #[test]
    fn link_add_defaults_speed_to_1000_when_omitted() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_two_nodes(&pool).await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(2),
                    dst_port: Some(3),
                    speed: None,
                    styles_json: r#"{"plane":"A"}"#.into(),
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let row = sqlx::query(
                "SELECT speed FROM topology_links WHERE session_id='s1' AND link_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<Option<i64>, _>("speed"), Some(1000));
        });
    }

    #[test]
    fn node_add_then_inspect() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".to_string(),
                    x: 1.0,
                    y: 2.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let row =
                sqlx::query("SELECT mid, insert_order FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(row.get::<String, _>("mid"), "0");
            assert_eq!(row.get::<i64, _>("insert_order"), 0);
        });
    }

    #[test]
    fn node_add_fills_mac_ip_by_mid_ordinal() {
        // U3：apply NodeAdd 增量节点按 mid（=ordinal）确定性补 mac/ip。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "7".to_string(),
                    x: 1.0,
                    y: 2.0,
                    node_type: None,
                    insert_order: 7,
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let row =
                sqlx::query("SELECT mac, ip FROM topology_nodes WHERE session_id='s1' AND mid='7'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                row.get::<Option<String>, _>("mac").as_deref(),
                Some(crate::topology_intermediate::assign_mac(7).as_str())
            );
            assert_eq!(
                row.get::<Option<String>, _>("ip").as_deref(),
                Some(crate::topology_intermediate::assign_ip(7).as_str())
            );
        });
    }

    #[test]
    fn node_add_with_name_persists() {
        // U9：node_add 带 name 落库（镜像 link_add）。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: Some("SW-5".into()),
                    mid: "5".into(),
                    x: 1.0,
                    y: 2.0,
                    node_type: Some("switch".into()),
                    insert_order: 5,
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let row =
                sqlx::query("SELECT name FROM topology_nodes WHERE session_id='s1' AND mid='5'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                row.get::<Option<String>, _>("name"),
                Some("SW-5".to_string())
            );
        });
    }

    #[test]
    fn node_add_rename_only_is_not_silent_noop() {
        // U9：三态读回含 name——同 mid 但只改 name → 取值不同 → MidTaken，
        // 不被当幂等 no-op 漏掉（没有 name 比对就会静默放过）。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: Some("SW-1".into()),
                    mid: "1".into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: Some("switch".into()),
                    insert_order: 1,
                }),
            )
            .await
            .unwrap();
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: Some("SW-99".into()),
                    mid: "1".into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: Some("switch".into()),
                    insert_order: 1,
                }),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(err, OpError::MidTaken(_)),
                "只改 name 应被当取值不同: {err:?}"
            );
        });
    }

    #[test]
    fn node_update_changes_name() {
        // review 闭环：node_add 漏 name(NULL) 后用 node_update 补/改名（解「设错名只能删重建」死锁）。
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "5".into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: Some("switch".into()),
                    insert_order: 5,
                }),
            )
            .await
            .unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeUpdate(NodeUpdateArgs {
                    name: Some("SW-5".into()),
                    mid: "5".into(),
                    x: None,
                    y: None,
                    node_type: None,
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let row =
                sqlx::query("SELECT name FROM topology_nodes WHERE session_id='s1' AND mid='5'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                row.get::<Option<String>, _>("name"),
                Some("SW-5".to_string())
            );
        });
    }

    #[test]
    fn node_delete_missing_is_idempotent_noop() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            // 幂等：删除不存在的节点 = no-op 成功（重试安全），rows_affected=0。
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeDelete(NodeDeleteArgs { mid: "999".into() }),
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
            for order in [0_i64, 1] {
                apply_op(
                    &mut seed,
                    "s1",
                    &TopologyOp::NodeAdd(NodeAddArgs {
                        name: None,
                        mid: order.to_string(),
                        x: 0.0,
                        y: 0.0,
                        node_type: None,
                        insert_order: order,
                    }),
                )
                .await
                .unwrap();
            }
            apply_op(
                &mut seed,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();
            seed.commit().await.unwrap();

            let batch = vec![
                TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }),
                TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "2".into(),
                    x: 0.5,
                    y: 0.5,
                    node_type: Some("switch".into()),
                    insert_order: 2,
                }),
                TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 1,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "2".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
                TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 2,
                    name: None,
                    src_node: "2".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            ];

            for round in 0..2 {
                let mut tx = pool.begin().await.unwrap();
                for op in &batch {
                    apply_op(&mut tx, "s1", op)
                        .await
                        .unwrap_or_else(|e| panic!("round {round} failed: {e:?}"));
                }
                tx.commit().await.unwrap();
            }

            let node_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let link_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(node_count, 3);
            assert_eq!(link_count, 2);
        });
    }

    #[test]
    fn node_add_same_value_replay_is_noop_even_with_optional_fields_omitted() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 1.0,
                    y: 2.0,
                    node_type: Some("switch".into()),
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            // 重放省略 optional 的 nodeType（存量行 nodeType="switch"）：
            // absent 字段不参与异值判定 → 仍判同值 no-op（假阳性回归）。
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 1.0,
                    y: 2.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            assert_eq!(s.op_kind, "node.add");
            assert_eq!(s.rows_affected, 0);
            tx.commit().await.unwrap();

            let row = sqlx::query(
                "SELECT node_type FROM topology_nodes WHERE session_id='s1' AND mid='0'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                row.get::<Option<String>, _>("node_type").as_deref(),
                Some("switch")
            );
        });
    }

    #[test]
    fn node_add_collision_with_different_values_reports_mid_taken() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut seed = pool.begin().await.unwrap();
            apply_op(
                &mut seed,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 1.0,
                    y: 2.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            seed.commit().await.unwrap();

            // 同 mid、不同坐标 → 碰撞报错（三态拒绝静默覆盖）。
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 9.0,
                    y: 9.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::MidTaken(_)));
            assert_eq!(err.code(), "MID_TAKEN");
            // 错误信息给出路：改属性应走 node_update。
            assert!(
                err.message().contains("node_update"),
                "message={}",
                err.message()
            );
            tx.rollback().await.unwrap();

            // 原节点完好。
            let row = sqlx::query("SELECT x FROM topology_nodes WHERE session_id='s1' AND mid='0'")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(row.get::<f64, _>("x"), 1.0);
        });
    }

    #[test]
    fn link_add_collision_with_different_values_reports_link_seq_taken() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for order in [0_i64, 1, 2] {
                apply_op(
                    &mut tx,
                    "s1",
                    &TopologyOp::NodeAdd(NodeAddArgs {
                        name: None,
                        mid: order.to_string(),
                        x: 0.0,
                        y: 0.0,
                        node_type: None,
                        insert_order: order,
                    }),
                )
                .await
                .unwrap();
            }
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();

            // 同 linkSeq、不同端点 → 碰撞报错。
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "2".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::LinkSeqTaken(_)));
            assert_eq!(err.code(), "LINK_SEQ_TAKEN");

            // 同值重放仍是 no-op。
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();
            assert_eq!(s.rows_affected, 0);
        });
    }

    #[test]
    fn replay_with_reserialized_json_fields_is_still_noop() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for order in [0_i64, 1] {
                apply_op(
                    &mut tx,
                    "s1",
                    &TopologyOp::NodeAdd(NodeAddArgs {
                        name: None,
                        mid: order.to_string(),
                        x: 0.0,
                        y: 0.0,
                        node_type: None,
                        insert_order: order,
                    }),
                )
                .await
                .unwrap();
            }
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: r#"{"plane":"A","role":"master"}"#.into(),
                }),
            )
            .await
            .unwrap();

            // LLM 重试时重新序列化 styles_json（键序/空白变化）：语义同值必须仍判 no-op，
            // 不得误报 LINK_SEQ_TAKEN（adversarial 发现的回归）。
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: r#"{ "role": "master", "plane": "A" }"#.into(),
                }),
            )
            .await
            .unwrap();
            assert_eq!(s.rows_affected, 0);

            // 语义不同的 JSON 仍是异值碰撞。
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: r#"{"plane":"B","role":"master"}"#.into(),
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::LinkSeqTaken(_)));
        });
    }

    #[test]
    fn link_add_self_loop_requires_single_endpoint() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            // self-loop（src==dst）端点计数 expected=1：节点存在即通过悬空校验。
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "0".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();
            assert_eq!(s.rows_affected, 1);
            // 节点不存在的 self-loop 仍被拦截。
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 1,
                    name: None,
                    src_node: "9".into(),
                    dst_node: "9".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::UnknownNode(_)));
        });
    }

    #[test]
    fn link_add_rejects_unknown_endpoints() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "7".into(),
                    dst_node: "8".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::UnknownNode(_)));
            assert_eq!(err.code(), "UNKNOWN_NODE");
        });
    }

    #[test]
    fn node_delete_rejects_when_links_reference_it() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            for order in [0_i64, 1] {
                apply_op(
                    &mut tx,
                    "s1",
                    &TopologyOp::NodeAdd(NodeAddArgs {
                        name: None,
                        mid: order.to_string(),
                        x: 0.0,
                        y: 0.0,
                        node_type: None,
                        insert_order: order,
                    }),
                )
                .await
                .unwrap();
            }
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();

            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeDelete(NodeDeleteArgs { mid: "0".into() }),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OpError::NodeHasLinks(_)));
            assert_eq!(err.code(), "NODE_HAS_LINKS");

            // 先删链路再删节点 → 成功。
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }),
            )
            .await
            .unwrap();
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeDelete(NodeDeleteArgs { mid: "0".into() }),
            )
            .await
            .unwrap();
            assert_eq!(s.rows_affected, 1);
        });
    }

    #[test]
    fn link_add_and_delete_round_trip() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();

            // 先 seed 两端点节点（topology_links 无 FK 到 topology_nodes，但语义需要）
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "0".into(),
                    x: 0.0,
                    y: 0.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "1".into(),
                    x: 1.0,
                    y: 1.0,
                    node_type: None,
                    insert_order: 1,
                }),
            )
            .await
            .unwrap();

            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkAdd(LinkAddArgs {
                    link_seq: 0,
                    name: None,
                    src_node: "0".into(),
                    dst_node: "1".into(),
                    src_port: Some(1),
                    dst_port: Some(2),
                    speed: None,
                    styles_json: "{}".into(),
                }),
            )
            .await
            .unwrap();

            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 0 }),
            )
            .await
            .unwrap();
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
            let err = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeUpdate(NodeUpdateArgs {
                    name: None,
                    mid: "999".into(),
                    x: None,
                    y: None,
                    node_type: None,
                }),
            )
            .await
            .unwrap_err();
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
            let s = apply_op(
                &mut tx,
                "s1",
                &TopologyOp::LinkDelete(LinkDeleteArgs { link_seq: 999 }),
            )
            .await
            .unwrap();
            assert_eq!(s.op_kind, "link.delete");
            assert_eq!(s.rows_affected, 0);
        });
    }

    #[test]
    fn node_update_preserves_unmentioned_fields() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let mut tx = pool.begin().await.unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeAdd(NodeAddArgs {
                    name: None,
                    mid: "5".into(),
                    x: 1.0,
                    y: 2.0,
                    node_type: None,
                    insert_order: 0,
                }),
            )
            .await
            .unwrap();
            apply_op(
                &mut tx,
                "s1",
                &TopologyOp::NodeUpdate(NodeUpdateArgs {
                    name: None,
                    mid: "5".into(),
                    x: None,
                    y: Some(9.0),
                    node_type: Some("switch".into()),
                }),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let row = sqlx::query(
                "SELECT x, y, node_type FROM topology_nodes WHERE session_id='s1' AND mid='5'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<f64, _>("x"), 1.0); // 未提供 x → 保留
            assert_eq!(row.get::<f64, _>("y"), 9.0); // 提供 y → 更新
            assert_eq!(
                row.get::<Option<String>, _>("node_type").as_deref(),
                Some("switch")
            );
        });
    }

    #[test]
    fn op_error_maps_to_http_codes() {
        assert_eq!(
            OpError::NotFound("x".into()).http_status(),
            axum::http::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            OpError::Database("y".into()).http_status(),
            axum::http::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(OpError::NotFound("x".into()).code(), "NOT_FOUND");
        assert_eq!(OpError::Database("y".into()).code(), "DATABASE_ERROR");
        assert_eq!(OpError::UnknownNode("z".into()).code(), "UNKNOWN_NODE");
        assert_eq!(OpError::NodeHasLinks("w".into()).code(), "NODE_HAS_LINKS");
        assert_eq!(OpError::MidTaken("s".into()).code(), "MID_TAKEN");
    }
}
