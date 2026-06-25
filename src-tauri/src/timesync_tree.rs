//! 时钟同步树构建（纯函数，读库不写库、不碰网络）。
//!
//! 输入 `(gm_mid, 禁用链路集, 拓扑)`，以 GM 为根做 BFS 生成树（802.1AS：以 GM
//! 为根的最短路生成树），确定性衍生每个节点的端口角色：
//! - 非 GM 节点：朝根方向端口 = slave（恰 1 个）、朝子方向端口 = master（1..n 个）；
//! - 非树边（不在 BFS 树上的边）两端、被禁用链路两端 = passive；
//! - GM 节点所有参与端口 = master。
//!
//! 端口号取自 link 的 src_port/dst_port（哪一端连本节点用哪个端口）。
//!
//! 确定性 tie-break（KTD7）：mid 是数值序号字符串，BFS 邻接遍历按 `mid` 数值序、
//! 端口号整数序入队（**不是** String 字典序，"2" < "10" 必须成立）。排序逻辑抽成
//! `tie_break_key` 供本模块单点使用，防与他处 BFS 排序漂移。
//!
//! `port_ptp_enabled` = 参与树的端口（master ∪ slave），由本函数顺带输出。
//!
//! 本模块的导出项（`compute_clock_tree`/`ClockTree` 等）由 U6（校验）消费。

use serde::Serialize;
use sqlx::{Pool, Row, Sqlite};
use std::collections::{HashMap, HashSet, VecDeque};

/// 单个节点的端口角色划分（端口号去重升序）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodePortRoles {
    pub mid: String,
    pub master_port: Vec<i64>,
    pub slave_port: Vec<i64>,
    pub passive_port: Vec<i64>,
    /// 参与树的端口（master ∪ slave），供 U7 落库派生 port_ptp_enabled。
    pub port_ptp_enabled: Vec<i64>,
}

/// 时钟树构建结果。`per_node` 按 mid 数值序排列；`uncovered` = 与 GM 不连通、
/// BFS 到不了的节点 mid（R23）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClockTree {
    pub per_node: Vec<NodePortRoles>,
    pub uncovered: Vec<String>,
}

/// 一条无向边在某节点视角下的「出向」：通往的邻居 + 本节点这一端的端口号。
#[derive(Debug, Clone)]
struct Incidence {
    neighbor: String,
    /// 本节点这一端的端口号（可能缺失 → None，不计入角色集）。
    local_port: Option<i64>,
}

/// 数值序 tie-break key（KTD7）：mid 按 i64 数值排序（解析失败退化为 i64::MAX
/// 让非数值 mid 稳定排尾），端口按整数序（None 排尾）。本模块单点使用。
fn tie_break_key(mid: &str, port: Option<i64>) -> (i64, i64) {
    let mid_num = mid.parse::<i64>().unwrap_or(i64::MAX);
    let port_num = port.unwrap_or(i64::MAX);
    (mid_num, port_num)
}

/// 从库读拓扑、剔除禁用链路、算时钟树。纯函数语义：只读、不写、不碰网络。
pub async fn compute_clock_tree(
    pool: &Pool<Sqlite>,
    session_id: &str,
    gm_mid: &str,
    disabled_link_seqs: &[i64],
) -> Result<ClockTree, sqlx::Error> {
    let node_rows = sqlx::query(
        r#"SELECT mid, port_count FROM topology_nodes
           WHERE session_id = ? ORDER BY insert_order, mid"#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let link_rows = sqlx::query(
        r#"SELECT link_seq, src_node, dst_node, src_port, dst_port FROM topology_links
           WHERE session_id = ? ORDER BY link_seq"#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let mids: Vec<String> = node_rows
        .iter()
        .map(|r| r.get::<String, _>("mid"))
        .collect();

    let disabled: HashSet<i64> = disabled_link_seqs.iter().copied().collect();

    // 邻接表：每节点 → 出向边集（含本端端口号）。每条启用链路加双向。
    let mut adjacency: HashMap<String, Vec<Incidence>> =
        mids.iter().map(|m| (m.clone(), Vec::new())).collect();
    for row in &link_rows {
        let link_seq: i64 = row.get("link_seq");
        if disabled.contains(&link_seq) {
            continue;
        }
        let src: String = row.get("src_node");
        let dst: String = row.get("dst_node");
        let src_port: Option<i64> = row.get("src_port");
        let dst_port: Option<i64> = row.get("dst_port");
        // 端点须都在节点集内（悬空链路忽略，校验在 U6）。
        if !adjacency.contains_key(&src) || !adjacency.contains_key(&dst) {
            continue;
        }
        adjacency.entry(src.clone()).or_default().push(Incidence {
            neighbor: dst.clone(),
            local_port: src_port,
        });
        adjacency.entry(dst.clone()).or_default().push(Incidence {
            neighbor: src.clone(),
            local_port: dst_port,
        });
    }

    // 每节点的出向边按数值序 tie-break 排序，保证 BFS 入队确定性。
    for incidences in adjacency.values_mut() {
        incidences.sort_by(|a, b| {
            tie_break_key(&a.neighbor, a.local_port).cmp(&tie_break_key(&b.neighbor, b.local_port))
        });
    }

    // 角色累加器：每节点三集合（用 HashSet 去重，输出时升序）。
    let mut master: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut slave: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut passive: HashMap<String, HashSet<i64>> = HashMap::new();
    for m in &mids {
        master.insert(m.clone(), HashSet::new());
        slave.insert(m.clone(), HashSet::new());
        passive.insert(m.clone(), HashSet::new());
    }

    // BFS 生成树：从 GM 出发。`tree_parent[child]` 记录朝根方向（child→parent）
    // 本端口号；`reached` 记录已纳入树的节点。tie-break 已在邻接排序里固化，故
    // 多条等价最短路总取 mid 数值序最小的父。
    let gm_in_graph = adjacency.contains_key(gm_mid);
    let mut reached: HashSet<String> = HashSet::new();
    // 标记哪些 (mid, port) 已被生成树占用为 master/slave，便于后续把剩余端口判 passive。
    let mut tree_ports: HashSet<(String, i64)> = HashSet::new();

    if gm_in_graph {
        let mut queue: VecDeque<String> = VecDeque::new();
        reached.insert(gm_mid.to_string());
        queue.push_back(gm_mid.to_string());

        while let Some(node) = queue.pop_front() {
            let incidences = adjacency.get(&node).cloned().unwrap_or_default();
            for inc in incidences {
                if reached.insert(inc.neighbor.clone()) {
                    // 这是一条树边：node 侧端口 = master（朝子），neighbor 侧端口 = slave（朝父）。
                    if let Some(port) = inc.local_port {
                        master.get_mut(&node).unwrap().insert(port);
                        tree_ports.insert((node.clone(), port));
                    }
                    // neighbor 侧的端口：在 neighbor 的邻接里找回连 node 的那条边的本端端口。
                    let child_port = adjacency
                        .get(&inc.neighbor)
                        .and_then(|incs| incs.iter().find(|i| i.neighbor == node))
                        .and_then(|i| i.local_port);
                    if let Some(port) = child_port {
                        slave.get_mut(&inc.neighbor).unwrap().insert(port);
                        tree_ports.insert((inc.neighbor.clone(), port));
                    }
                    queue.push_back(inc.neighbor);
                }
            }
        }
    }

    // 非树边 + 禁用链路两端 = passive：遍历每节点剩余的参与端口（不在 tree_ports 里的），
    // 判 passive。禁用链路因被排除在 adjacency 外、其端口不会进 master/slave，故须从
    // 原始 link 集单独补 passive。
    // 先处理启用但非树边的端口（adjacency 里在、但未被生成树占用）。
    for (mid, incidences) in &adjacency {
        for inc in incidences {
            if let Some(port) = inc.local_port
                && !tree_ports.contains(&(mid.clone(), port))
            {
                passive.get_mut(mid).unwrap().insert(port);
            }
        }
    }
    // 禁用链路两端端口补 passive（端点须在节点集内）。
    for row in &link_rows {
        let link_seq: i64 = row.get("link_seq");
        if !disabled.contains(&link_seq) {
            continue;
        }
        let src: String = row.get("src_node");
        let dst: String = row.get("dst_node");
        let src_port: Option<i64> = row.get("src_port");
        let dst_port: Option<i64> = row.get("dst_port");
        if let (Some(set), Some(port)) = (passive.get_mut(&src), src_port)
            && !tree_ports.contains(&(src.clone(), port))
        {
            set.insert(port);
        }
        if let (Some(set), Some(port)) = (passive.get_mut(&dst), dst_port)
            && !tree_ports.contains(&(dst.clone(), port))
        {
            set.insert(port);
        }
    }

    // 组装输出，按 mid 数值序排列（与 tie-break 一致）。
    let mut ordered_mids = mids.clone();
    ordered_mids.sort_by_key(|m| tie_break_key(m, None));

    let sorted_vec = |set: &HashSet<i64>| -> Vec<i64> {
        let mut v: Vec<i64> = set.iter().copied().collect();
        v.sort_unstable();
        v
    };

    let mut per_node = Vec::with_capacity(ordered_mids.len());
    for mid in &ordered_mids {
        let master_port = sorted_vec(&master[mid]);
        let slave_port = sorted_vec(&slave[mid]);
        let passive_port = sorted_vec(&passive[mid]);
        let mut ptp: Vec<i64> = master_port
            .iter()
            .chain(slave_port.iter())
            .copied()
            .collect();
        ptp.sort_unstable();
        ptp.dedup();
        per_node.push(NodePortRoles {
            mid: mid.clone(),
            master_port,
            slave_port,
            passive_port,
            port_ptp_enabled: ptp,
        });
    }

    let mut uncovered: Vec<String> = ordered_mids
        .iter()
        .filter(|m| !reached.contains(*m))
        .cloned()
        .collect();
    uncovered.sort_by_key(|m| tie_break_key(m, None));

    Ok(ClockTree {
        per_node,
        uncovered,
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
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) \
             VALUES ('s1', 't', 'now', 'now', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn add_node(pool: &Pool<Sqlite>, mid: &str, order: i64) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, ?)",
        )
        .bind(mid)
        .bind(order)
        .execute(pool)
        .await
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    async fn add_link(
        pool: &Pool<Sqlite>,
        seq: i64,
        src: &str,
        dst: &str,
        src_port: i64,
        dst_port: i64,
    ) {
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, '{}')",
        )
        .bind(seq)
        .bind(src)
        .bind(dst)
        .bind(src_port)
        .bind(dst_port)
        .execute(pool)
        .await
        .unwrap();
    }

    fn roles_of<'a>(tree: &'a ClockTree, mid: &str) -> &'a NodePortRoles {
        tree.per_node.iter().find(|n| n.mid == mid).unwrap()
    }

    /// 线性拓扑 0—1—2，GM=0：
    /// 0(GM) 全 master；1 slave 朝 0、master 朝 2；2 slave 朝 1。
    #[tokio::test]
    async fn linear_topology_gm_at_end() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0).await;
        add_node(&pool, "1", 1).await;
        add_node(&pool, "2", 2).await;
        // 0.port0 — 1.port0 ；1.port1 — 2.port0
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "1", "2", 1, 0).await;

        let tree = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();

        let n0 = roles_of(&tree, "0");
        assert_eq!(n0.master_port, vec![0], "GM 朝子端口 master");
        assert!(n0.slave_port.is_empty(), "GM 无 slave");

        let n1 = roles_of(&tree, "1");
        assert_eq!(n1.slave_port, vec![0], "1 朝父(0) 端口=slave");
        assert_eq!(n1.master_port, vec![1], "1 朝子(2) 端口=master");

        let n2 = roles_of(&tree, "2");
        assert_eq!(n2.slave_port, vec![0], "2 朝父(1) 端口=slave");
        assert!(n2.master_port.is_empty(), "叶子无 master");

        assert!(tree.uncovered.is_empty());
    }

    /// Covers AE3：同拓扑+同 GM+同禁用集连算两次输出逐字节一致。
    #[tokio::test]
    async fn deterministic_repeated_runs_identical() {
        let pool = fresh_pool().await;
        for (i, m) in ["0", "1", "2", "3"].iter().enumerate() {
            add_node(&pool, m, i as i64).await;
        }
        // 带环 + 多分支，触发 tie-break。
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "0", "2", 1, 0).await;
        add_link(&pool, 2, "1", "3", 1, 0).await;
        add_link(&pool, 3, "2", "3", 1, 1).await;

        let a = compute_clock_tree(&pool, "s1", "0", &[3]).await.unwrap();
        let b = compute_clock_tree(&pool, "s1", "0", &[3]).await.unwrap();
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap(),
            "确定性：两次序列化逐字节一致"
        );
    }

    /// 数值序：mid 含 "2" 和 "10" 时排序按数值（"2" < "10"），非字典序。
    /// GM=0 同时连 2 和 10，两条等价最短路；tie-break 数值序应让 BFS 先访问 "2"。
    #[tokio::test]
    async fn numeric_tie_break_not_lexical() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0).await;
        add_node(&pool, "2", 1).await;
        add_node(&pool, "10", 2).await;
        // 0 直连 2 和 10；2 与 10 之间也有一条边（构成环，迫使 tie-break 决定父）。
        add_link(&pool, 0, "0", "2", 0, 0).await;
        add_link(&pool, 1, "0", "10", 1, 0).await;
        add_link(&pool, 2, "2", "10", 1, 1).await;

        let tree = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();

        // per_node 顺序按数值序：0,2,10（非字典序 0,10,2）。
        let order: Vec<&str> = tree.per_node.iter().map(|n| n.mid.as_str()).collect();
        assert_eq!(order, vec!["0", "2", "10"], "输出按数值序");

        // 2 与 10 都直挂 GM（各 1 跳），它们之间的边 (seq=2) 是非树边 → 两端 passive。
        let n2 = roles_of(&tree, "2");
        let n10 = roles_of(&tree, "10");
        assert_eq!(n2.slave_port, vec![0], "2 朝 GM slave");
        assert_eq!(n10.slave_port, vec![0], "10 朝 GM slave");
        assert!(n2.passive_port.contains(&1), "2—10 非树边端口 passive");
        assert!(n10.passive_port.contains(&1), "2—10 非树边端口 passive");
    }

    /// Covers AE1：禁用一条链路 → 该链路两端 passive、子树重算。
    /// 0—1—2 线性，禁用 1—2(seq=1) → 2 不再经 1 到 GM；但若有备份路径重算。
    /// 这里无备份 → 2 uncovered；禁用链路两端 passive。
    #[tokio::test]
    async fn disable_link_marks_passive_and_recomputes() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0).await;
        add_node(&pool, "1", 1).await;
        add_node(&pool, "2", 2).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "1", "2", 1, 0).await;

        // 先不禁用：2 可达、slave 朝 1。
        let full = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();
        assert!(full.uncovered.is_empty());
        assert_eq!(roles_of(&full, "2").slave_port, vec![0]);

        // 禁用 1—2(seq=1)。
        let tree = compute_clock_tree(&pool, "s1", "0", &[1]).await.unwrap();
        // 禁用链路两端端口 passive。
        assert!(
            roles_of(&tree, "1").passive_port.contains(&1),
            "1 的端口1（连 2）禁用后 passive"
        );
        assert!(
            roles_of(&tree, "2").passive_port.contains(&0),
            "2 的端口0（连 1）禁用后 passive"
        );
        // 2 失去唯一路径 → uncovered。
        assert_eq!(tree.uncovered, vec!["2"], "禁用后 2 不可达");
        // 1 仍经端口0 朝 GM slave、无 master（子树重算）。
        assert_eq!(roles_of(&tree, "1").slave_port, vec![0]);
        assert!(roles_of(&tree, "1").master_port.is_empty(), "1 子树丢失");
    }

    /// 有环拓扑：非树边两端 passive、无环（生成树）。
    /// 三角 0-1-2，GM=0：树边 0-1, 0-2；环边 1-2 非树边两端 passive。
    #[tokio::test]
    async fn ring_topology_non_tree_edge_passive() {
        let pool = fresh_pool().await;
        add_node(&pool, "0", 0).await;
        add_node(&pool, "1", 1).await;
        add_node(&pool, "2", 2).await;
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "0", "2", 1, 0).await;
        add_link(&pool, 2, "1", "2", 1, 1).await; // 环边

        let tree = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();

        // GM 两端口都 master（朝两个子）。
        assert_eq!(roles_of(&tree, "0").master_port, vec![0, 1]);
        // 1, 2 各 slave 朝 GM（端口0）。
        assert_eq!(roles_of(&tree, "1").slave_port, vec![0]);
        assert_eq!(roles_of(&tree, "2").slave_port, vec![0]);
        // 环边 1—2(seq=2) 非树边 → 1.port1 与 2.port1 passive。
        assert_eq!(roles_of(&tree, "1").passive_port, vec![1]);
        assert_eq!(roles_of(&tree, "2").passive_port, vec![1]);
        // 角色互斥：master/slave/passive 不重叠。
        for n in &tree.per_node {
            let m: HashSet<_> = n.master_port.iter().collect();
            let s: HashSet<_> = n.slave_port.iter().collect();
            let p: HashSet<_> = n.passive_port.iter().collect();
            assert!(m.is_disjoint(&s) && m.is_disjoint(&p) && s.is_disjoint(&p));
        }
        assert!(tree.uncovered.is_empty());
    }

    /// Covers AE5：dual-plane 式——端系统双挂两子图，单 GM 经端系统覆盖全网。
    /// 平面 A: SW0—SW1；平面 B: SW2—SW3；端系统 ES4 双挂 SW1 和 SW2。
    /// GM=0：0→1→4→2→3 经端系统跨平面，全网覆盖。
    #[tokio::test]
    async fn dual_plane_single_gm_covers_via_end_system() {
        let pool = fresh_pool().await;
        for (i, m) in ["0", "1", "2", "3", "4"].iter().enumerate() {
            add_node(&pool, m, i as i64).await;
        }
        // 平面 A
        add_link(&pool, 0, "0", "1", 0, 0).await;
        // 平面 B
        add_link(&pool, 1, "2", "3", 0, 0).await;
        // 端系统 4 双挂：连 1（平面A）和 2（平面B）
        add_link(&pool, 2, "1", "4", 1, 0).await;
        add_link(&pool, 3, "2", "4", 1, 1).await;

        let tree = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();
        assert!(
            tree.uncovered.is_empty(),
            "单 GM 经端系统覆盖全网，无 uncovered: {:?}",
            tree.uncovered
        );
        // ES4 是跨平面中转：slave 朝平面A（端口0 连 1），master 朝平面B（端口1 连 2）。
        let n4 = roles_of(&tree, "4");
        assert_eq!(n4.slave_port, vec![0], "ES4 slave 朝来路");
        assert_eq!(n4.master_port, vec![1], "ES4 master 朝平面B");
        // 全网每节点都有 port_ptp_enabled（参与树）。
        for m in ["0", "1", "2", "3", "4"] {
            assert!(
                !roles_of(&tree, m).port_ptp_enabled.is_empty(),
                "{m} 应参与树"
            );
        }
    }

    /// 不连通子图：uncovered 列出到不了的节点。
    /// 0—1 一组；2—3 另一组（与 GM=0 不连通）。
    #[tokio::test]
    async fn disconnected_subgraph_reports_uncovered() {
        let pool = fresh_pool().await;
        for (i, m) in ["0", "1", "2", "3"].iter().enumerate() {
            add_node(&pool, m, i as i64).await;
        }
        add_link(&pool, 0, "0", "1", 0, 0).await;
        add_link(&pool, 1, "2", "3", 0, 0).await; // 孤岛

        let tree = compute_clock_tree(&pool, "s1", "0", &[]).await.unwrap();
        assert_eq!(tree.uncovered, vec!["2", "3"], "孤岛节点 uncovered");
        // 不可达节点无任何树端口角色。
        assert!(roles_of(&tree, "2").port_ptp_enabled.is_empty());
        assert!(roles_of(&tree, "3").port_ptp_enabled.is_empty());
    }
}
