//! 时钟同步结构校验（重算为唯一权威）。读 `timesync_domain`（gm_mid +
//! disabled_link_seqs）与 `timesync_nodes` 落库快照，调 `timesync_tree::compute_clock_tree`
//! 以「GM + 拓扑」重算，比对落库快照检测漂移，返回 `{ok, caliber, errors}`。
//!
//! 形状复刻 `topology_verify::VerifyResult`/`VerifyError`（同字段名 code/message_zh/
//! node_ref，前端/agent 消费链零改）；caliber 恒 `timesync_structural`。
//!
//! 重算为唯一权威（R16）：比对仅检测漂移、报告（`SNAPSHOT_DRIFT`），绝不在
//! 本模块以快照覆盖重算——覆盖落库归 U7。R17：SNAPSHOT_DRIFT 为阻断级
//! （计入 ok=false），拓扑变更使快照失效时拦确认闸、逼用户重新 set_gm 刷新。

use serde::Serialize;
use sqlx::{Pool, Row, Sqlite};
use std::collections::{HashMap, HashSet};

use crate::timesync_tree::{NodePortRoles, compute_clock_tree};

pub const CALIBER_TIMESYNC_STRUCTURAL: &str = "timesync_structural";

/// 单条结构问题：code 给程序判别、message_zh 给用户直接看、node_ref 指向出问题的
/// 节点/链路（与 topology_verify::VerifyError 同字段名）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyError {
    pub code: String,
    pub message_zh: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_ref: Option<String>,
}

impl VerifyError {
    fn new(code: &str, message_zh: String, node_ref: Option<String>) -> Self {
        Self {
            code: code.to_string(),
            message_zh,
            node_ref,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub ok: bool,
    pub caliber: &'static str,
    pub errors: Vec<VerifyError>,
}

/// 落库快照里单节点的端口角色（用于和重算结果比对漂移）。
struct SnapshotRoles {
    master_port: Vec<i64>,
    slave_port: Vec<i64>,
}

/// 读 timesync 配置 + 重算 + 比对，返回 VerifyResult。errors 含 fail 级（GM 悬空/
/// 未设、端口越界、快照漂移）与告警级（未覆盖节点、禁用链路悬空）。fail 级存在时 ok=false。
pub async fn verify_time_sync(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<VerifyResult, sqlx::Error> {
    let mut errors: Vec<VerifyError> = Vec::new();

    // 1. 读 domain（gm_mid + disabled_link_seqs）。无行视为未设 GM。
    let domain_row =
        sqlx::query("SELECT gm_mid, disabled_link_seqs FROM timesync_domain WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;

    let (gm_mid, disabled_raw): (Option<String>, String) = match &domain_row {
        Some(row) => (row.get("gm_mid"), row.get("disabled_link_seqs")),
        None => (None, "[]".to_string()),
    };

    // gm_mid 为空 / NULL → GM_NOT_SET（fail）。
    let gm_mid = match gm_mid.as_deref() {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => {
            errors.push(VerifyError::new(
                "GM_NOT_SET",
                "还没有指定时钟主节点（GM），先选一个 GM 再继续。".to_string(),
                None,
            ));
            return Ok(VerifyResult {
                ok: false,
                caliber: CALIBER_TIMESYNC_STRUCTURAL,
                errors,
            });
        }
    };

    // 2. 读拓扑节点（mid → port_count），供 GM 存在性 + 端口越界校验。
    let node_rows = sqlx::query(
        "SELECT mid, port_count FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let port_count_by_mid: HashMap<String, i64> = node_rows
        .iter()
        .map(|r| (r.get::<String, _>("mid"), r.get::<i64, _>("port_count")))
        .collect();

    // gm_mid 不指向现存节点 → GM_DANGLING（fail）。
    if !port_count_by_mid.contains_key(&gm_mid) {
        errors.push(VerifyError::new(
            "GM_DANGLING",
            format!("指定的时钟主节点 {gm_mid} 已不存在，请重新选一个 GM。"),
            Some(gm_mid.clone()),
        ));
    }

    // 3. 解析禁用链路集；剔除已不存在的 link_seq（告警，重算时忽略）。
    let disabled_all: Vec<i64> =
        serde_json::from_str::<Vec<i64>>(&disabled_raw).unwrap_or_default();
    let existing_seqs: HashSet<i64> =
        sqlx::query("SELECT link_seq FROM topology_links WHERE session_id = ?")
            .bind(session_id)
            .fetch_all(pool)
            .await?
            .iter()
            .map(|r| r.get::<i64, _>("link_seq"))
            .collect();
    let disabled: Vec<i64> = disabled_all
        .iter()
        .copied()
        .filter(|seq| existing_seqs.contains(seq))
        .collect();
    for seq in &disabled_all {
        if !existing_seqs.contains(seq) {
            errors.push(VerifyError::new(
                "DISABLED_LINK_DANGLING",
                format!("禁用链路集里的链路 {seq} 已不存在，已忽略。"),
                None,
            ));
        }
    }

    // 4. 重算时钟树（权威）。
    let tree = compute_clock_tree(pool, session_id, &gm_mid, &disabled).await?;
    let recomputed: HashMap<&str, &NodePortRoles> =
        tree.per_node.iter().map(|n| (n.mid.as_str(), n)).collect();

    // 5. 读落库快照（master_port/slave_port JSON 串），供端口越界 + 漂移比对。
    let snapshot_rows =
        sqlx::query("SELECT mid, master_port, slave_port FROM timesync_nodes WHERE session_id = ?")
            .bind(session_id)
            .fetch_all(pool)
            .await?;
    let snapshot: HashMap<String, SnapshotRoles> = snapshot_rows
        .iter()
        .map(|r| {
            let mid: String = r.get("mid");
            let master_port = serde_json::from_str::<Vec<i64>>(&r.get::<String, _>("master_port"))
                .unwrap_or_default();
            let slave_port = serde_json::from_str::<Vec<i64>>(&r.get::<String, _>("slave_port"))
                .unwrap_or_default();
            (
                mid,
                SnapshotRoles {
                    master_port,
                    slave_port,
                },
            )
        })
        .collect();

    // 6. 端口越界（fail）：落库 master_port/slave_port 元素 > 对应节点 port_count - 1
    //    （端口号 0-based，合法范围 0..port_count）。按 mid 升序稳定遍历。
    let mut snapshot_mids: Vec<&String> = snapshot.keys().collect();
    snapshot_mids.sort();
    for mid in snapshot_mids {
        let roles = &snapshot[mid];
        if let Some(&port_count) = port_count_by_mid.get(mid) {
            let over = roles
                .master_port
                .iter()
                .chain(roles.slave_port.iter())
                .any(|&p| p < 0 || p >= port_count);
            if over {
                errors.push(VerifyError::new(
                    "PORT_OUT_OF_RANGE",
                    format!("节点 {mid} 的端口角色引用了超出端口数（{port_count}）的端口。"),
                    Some(mid.clone()),
                ));
            }
        }
    }

    // 7. 快照漂移（R17 阻断，fail）：落库 master/slave 与重算不一致 = 拓扑改后
    //    timesync 快照失效（角色 stale）。按 mid 升序遍历。
    //    GM 悬空时重算结果（uncovered）不可信，跳过漂移检测避免噪音。
    if port_count_by_mid.contains_key(&gm_mid) {
        let mut drift_mids: Vec<&String> = snapshot.keys().collect();
        drift_mids.sort();
        for mid in drift_mids {
            let snap = &snapshot[mid];
            match recomputed.get(mid.as_str()) {
                Some(recomp) => {
                    if snap.master_port != recomp.master_port
                        || snap.slave_port != recomp.slave_port
                    {
                        errors.push(VerifyError::new(
                            "SNAPSHOT_DRIFT",
                            format!(
                                "节点 {mid} 的落库端口角色与拓扑重算结果不一致，时钟同步配置已过期，请重新指定 GM 刷新。"
                            ),
                            Some(mid.clone()),
                        ));
                    }
                }
                None => {
                    errors.push(VerifyError::new(
                        "SNAPSHOT_DRIFT",
                        format!(
                            "节点 {mid} 在拓扑重算结果里不存在，时钟同步配置已过期，请重新指定 GM 刷新。"
                        ),
                        Some(mid.clone()),
                    ));
                }
            }
        }
    }

    // 8. 未覆盖节点（R23 告警，不 fail）：与 GM 不连通、BFS 到不了的节点。
    for mid in &tree.uncovered {
        errors.push(VerifyError::new(
            "UNCOVERED_NODES",
            format!("节点 {mid} 与时钟主节点不连通，时钟同步覆盖不到它。"),
            Some(mid.clone()),
        ));
    }

    // ok 看 fail 级错误码；告警（未覆盖/禁用链路悬空）不拦推进。
    // R17：SNAPSHOT_DRIFT 阻断——拓扑改后 timesync 落库快照失效（角色 stale），
    // 经确认闸放行会让 stale 配置静默推进；拦住强制用户重新 set_gm 刷新。
    let has_fail = errors.iter().any(|e| {
        matches!(
            e.code.as_str(),
            "GM_NOT_SET" | "GM_DANGLING" | "PORT_OUT_OF_RANGE" | "SNAPSHOT_DRIFT"
        )
    });

    Ok(VerifyResult {
        ok: !has_fail,
        caliber: CALIBER_TIMESYNC_STRUCTURAL,
        errors,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTimeSyncRequest {
    pub session_id: String,
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
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) \
             VALUES ('s1', 't', 'now', 'now', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn add_node(pool: &Pool<Sqlite>, mid: &str, order: i64, port_count: i64) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1', ?, NULL, 0, 0, 'switch', ?, 8, ?)",
        )
        .bind(mid)
        .bind(port_count)
        .bind(order)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn add_link(pool: &Pool<Sqlite>, seq: i64, src: &str, dst: &str, sp: i64, dp: i64) {
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, '{}')",
        )
        .bind(seq)
        .bind(src)
        .bind(dst)
        .bind(sp)
        .bind(dp)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_domain(pool: &Pool<Sqlite>, gm_mid: Option<&str>, disabled: &str) {
        sqlx::query(
            "INSERT INTO timesync_domain (session_id, gm_mid, disabled_link_seqs) VALUES ('s1', ?, ?)",
        )
        .bind(gm_mid)
        .bind(disabled)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_node_roles(pool: &Pool<Sqlite>, mid: &str, master: &str, slave: &str) {
        sqlx::query(
            "INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled) \
             VALUES ('s1', ?, ?, ?, '[]')",
        )
        .bind(mid)
        .bind(master)
        .bind(slave)
        .execute(pool)
        .await
        .unwrap();
    }

    fn codes(r: &VerifyResult) -> Vec<&str> {
        r.errors.iter().map(|e| e.code.as_str()).collect()
    }

    /// 快照与重算一致 → ok、无错误。线性 0—1—2，GM=0。
    #[tokio::test]
    async fn snapshot_matches_recompute_is_ok() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        add_node(&pool, "1", 1, 8).await;
        add_node(&pool, "2", 2, 8).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "1", "2", 1, 0).await;
        set_domain(&pool, Some("0"), "[]").await;
        // 与 compute_clock_tree 一致的落库快照。
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[1]", "[0]").await;
        set_node_roles(&pool, "2", "[]", "[0]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(r.ok, "errors: {:?}", r.errors);
        assert_eq!(r.caliber, "timesync_structural");
        assert!(r.errors.is_empty(), "应无任何告警: {:?}", codes(&r));
    }

    /// 空 GM → GM_NOT_SET（fail）。
    #[tokio::test]
    async fn empty_gm_blocks() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        set_domain(&pool, None, "[]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok);
        assert_eq!(codes(&r), vec!["GM_NOT_SET"]);
    }

    /// 无 timesync_domain 行 → 同样视为未设 GM。
    #[tokio::test]
    async fn missing_domain_row_is_gm_not_set() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok);
        assert!(codes(&r).contains(&"GM_NOT_SET"));
    }

    /// gm_mid 指向已删节点 → GM_DANGLING（fail）。
    #[tokio::test]
    async fn dangling_gm_blocks() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        set_domain(&pool, Some("99"), "[]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok);
        assert!(codes(&r).contains(&"GM_DANGLING"));
    }

    /// master_port 越界（端口号 ≥ port_count）→ PORT_OUT_OF_RANGE（fail）。
    #[tokio::test]
    async fn port_out_of_range_blocks() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 2).await; // port_count=2 → 合法端口 0/1
        add_node(&pool, "1", 1, 2).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        set_domain(&pool, Some("0"), "[]").await;
        // 节点 1 落库 slave_port=[5]，超出 port_count=2。
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[]", "[5]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok);
        assert!(codes(&r).contains(&"PORT_OUT_OF_RANGE"));
    }

    /// R17 路径：先 port_count=8 落库合法（节点 1 slave_port=[5]，对应真实链路端口5）→
    /// 把节点 1 port_count 改小到 4 → slave_port=[5] 越界 → PORT_OUT_OF_RANGE（fail）。
    /// 链路端口5 让重算也产 slave=[5]，快照与重算一致、不混入 SNAPSHOT_DRIFT 噪音。
    #[tokio::test]
    async fn shrinking_port_count_makes_existing_role_out_of_range() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        add_node(&pool, "1", 1, 8).await;
        // 节点 1 经端口5 连 GM 的端口0：重算 → 节点1 slave=[5]。
        add_link(&pool, 0, "0", "1", 0, 5).await;
        set_domain(&pool, Some("0"), "[]").await;
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[]", "[5]").await;

        // port_count=8 时合法（端口5 < 8）。
        let r_ok = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(r_ok.ok, "port_count=8 时应放行: {:?}", codes(&r_ok));

        // 把节点 1 端口数改小到 4 → slave_port=[5] 越界。
        sqlx::query("UPDATE topology_nodes SET port_count = 4 WHERE session_id='s1' AND mid='1'")
            .execute(&pool)
            .await
            .unwrap();

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok, "端口数缩小后越界应阻断: {:?}", codes(&r));
        assert!(codes(&r).contains(&"PORT_OUT_OF_RANGE"));
        assert!(
            r.errors
                .iter()
                .any(|e| e.code == "PORT_OUT_OF_RANGE" && e.node_ref.as_deref() == Some("1"))
        );
    }

    /// 未覆盖节点（与 GM 不连通）→ UNCOVERED_NODES 告警，不 fail。
    #[tokio::test]
    async fn uncovered_nodes_warns_but_ok() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        add_node(&pool, "1", 1, 8).await;
        add_node(&pool, "2", 2, 8).await; // 孤岛，无连线
        add_link(&pool, 0, "0", "1", 0, 0).await;
        set_domain(&pool, Some("0"), "[]").await;
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[]", "[0]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(r.ok, "未覆盖只告警不 fail: {:?}", codes(&r));
        assert!(codes(&r).contains(&"UNCOVERED_NODES"));
        assert!(
            r.errors
                .iter()
                .any(|e| e.code == "UNCOVERED_NODES" && e.node_ref.as_deref() == Some("2"))
        );
    }

    /// R17：落库快照与重算不一致 → SNAPSHOT_DRIFT 阻断（ok=false），拦确认闸逼重设 GM。
    #[tokio::test]
    async fn snapshot_drift_blocks() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        add_node(&pool, "1", 1, 8).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        set_domain(&pool, Some("0"), "[]").await;
        // 节点 1 落库 slave_port 故意写错（[3] 而非重算的 [0]）。
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[]", "[3]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(!r.ok, "漂移应阻断（R17）: {:?}", codes(&r));
        assert!(codes(&r).contains(&"SNAPSHOT_DRIFT"));
    }

    /// 禁用链路集里链路已不存在 → DISABLED_LINK_DANGLING 告警，不 fail。
    #[tokio::test]
    async fn disabled_link_dangling_warns_but_ok() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0, 8).await;
        add_node(&pool, "1", 1, 8).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        set_domain(&pool, Some("0"), "[99]").await; // 99 不存在
        set_node_roles(&pool, "0", "[0]", "[]").await;
        set_node_roles(&pool, "1", "[]", "[0]").await;

        let r = verify_time_sync(&pool, "s1").await.unwrap();
        assert!(r.ok, "禁用链路悬空只告警: {:?}", codes(&r));
        assert!(codes(&r).contains(&"DISABLED_LINK_DANGLING"));
    }
}
