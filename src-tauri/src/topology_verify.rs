//! 拓扑阶段结构验证（第一批，不依赖 INET）。读库内拓扑（节点以 mid 标识、
//! 连线以 src/dst_node 引用）做确定性图论 + MAC 可达校验，返回
//! `{ok, errors[], caliber}`。纯函数、可单测；不碰网络、不跑仿真。
//!
//! 口径恒 `structural_only`：只验结构连通/可达，不代表时延或可调度性（INET 验证是第二批）。
//!
//! MAC 可达性说明：转发表由"无向图最短路 BFS 取首跳"派生，按构造即无环、
//! 每目的唯一出端口。因此 MAC 现算现验在本模块归结为一条**连通性**判定：全图单连通
//! ⇔ 每个端系统对其它节点全可达 ⇔ 转发表可派生。两条 BFS 跑同一条无向边集，可达性
//! 结论按构造一致（见测试 reachability_matches_connectivity）。

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

pub const CALIBER_STRUCTURAL_ONLY: &str = "structural_only";

const NODE_TYPE_SWITCH: &str = "switch";
const NODE_TYPE_END_SYSTEM: &str = "endSystem";
const NODE_TYPE_SERVER: &str = "server";

/// 单条结构问题：code 给程序判别、message_zh 给用户直接看、node_ref 指向出问题的节点/链路。
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

/// 校验入参（镜像库内行，保持最小以便纯函数单测）。
#[derive(Debug, Clone)]
pub struct VerifyNode {
    pub mid: String,
    pub name: Option<String>,
    pub node_type: Option<String>,
    /// 队列数（topology_nodes.queue_count，默认 8）：软仿 bundle 用作 INET egress
    /// numTrafficClasses（每 PCP 一个门）。结构校验不关心，测试构造给默认 8。
    pub queue_count: i64,
}

#[derive(Debug, Clone)]
pub struct VerifyLink {
    pub link_seq: i64,
    pub src_node: String,
    pub dst_node: String,
    /// 端口配对的结构事实源（KTD1）：两列非 NULL = 配对。不再读 styles_json.leftLabel。
    pub src_port: Option<i64>,
    pub dst_port: Option<i64>,
    /// 链路速率（Mbps）列；软仿 bundle 取 bitrate（KTD1：speed 也是列、非 styles_json）。
    pub speed: Option<i64>,
    pub styles_json: String,
}

/// 节点展示名：优先用 name 列（如 SW-1/ES-1），缺失时按类型前缀 + mid 派生，
/// 与前端显示名映射一致，让结论里的节点引用对用户可读。
fn display_name(node: &VerifyNode) -> String {
    if let Some(name) = node.name.as_deref()
        && !name.is_empty()
    {
        return name.to_string();
    }
    let prefix = match node.node_type.as_deref() {
        Some(NODE_TYPE_SWITCH) => "SW",
        Some(NODE_TYPE_END_SYSTEM) => "ES",
        Some(NODE_TYPE_SERVER) => "SRV",
        _ => "节点",
    };
    format!("{prefix}-{}", node.mid)
}

fn is_known_role(node_type: Option<&str>) -> bool {
    matches!(
        node_type,
        Some(NODE_TYPE_SWITCH | NODE_TYPE_END_SYSTEM | NODE_TYPE_SERVER)
    )
}

/// 结构 + MAC 可达校验。errors 为空即 ok。caliber 恒 structural_only。
pub fn verify_topology(nodes: &[VerifyNode], links: &[VerifyLink]) -> VerifyResult {
    let mut errors: Vec<VerifyError> = Vec::new();

    // 0. 空拓扑。
    if nodes.is_empty() {
        errors.push(VerifyError::new(
            "EMPTY_TOPOLOGY",
            "还没有拓扑可验，请先生成拓扑。".to_string(),
            None,
        ));
        return VerifyResult {
            ok: false,
            caliber: CALIBER_STRUCTURAL_ONLY,
            errors,
        };
    }

    let by_sync: HashMap<&str, &VerifyNode> = nodes.iter().map(|n| (n.mid.as_str(), n)).collect();

    // 1. 节点编号重复。
    let mut seen_sync: HashSet<&str> = HashSet::new();
    for node in nodes {
        if !seen_sync.insert(node.mid.as_str()) {
            errors.push(VerifyError::new(
                "DUPLICATE_NODE",
                format!("节点编号 {} 重复了。", node.mid),
                Some(node.mid.clone()),
            ));
        }
    }

    // 2. 节点角色：未知/缺失类型本身判错，不静默归类。
    for node in nodes {
        if !is_known_role(node.node_type.as_deref()) {
            errors.push(VerifyError::new(
                "UNKNOWN_NODE_ROLE",
                format!(
                    "{} 的类型未知，无法判断它是交换机还是端系统。",
                    display_name(node)
                ),
                Some(node.mid.clone()),
            ));
        }
    }

    // 2b. U6 命名前缀：name 非空时必须按类型前缀（交换机 SW-、端系统 ES-、服务器 SRV-）。
    //     跳过 name 为空的节点（apply 新增节点在 U9 落地前合法无 name）；未知类型已被 #2 判错，
    //     此处 continue 不重复报。U12 已把各场景 initialize 命名统一到 SW-/ES-，本校验才成立。
    for node in nodes {
        let name = match node.name.as_deref() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        let (prefix, role_label) = match node.node_type.as_deref() {
            Some(NODE_TYPE_SWITCH) => ("SW-", "交换机"),
            Some(NODE_TYPE_END_SYSTEM) => ("ES-", "端系统"),
            Some(NODE_TYPE_SERVER) => ("SRV-", "服务器"),
            _ => continue,
        };
        if !name.starts_with(prefix) {
            errors.push(VerifyError::new(
                "NODE_NAME_PREFIX",
                format!(
                    "{}（编号 {}）的名字 {} 不规范，应以 {} 开头。",
                    role_label, node.mid, name, prefix
                ),
                Some(node.mid.clone()),
            ));
        }
    }

    // 2c. U9 闭环：name 非空时唯一——inspect「按 name 匹配 SW-N」指引依赖唯一性，
    //     重名会让 agent 删错/连错节点。apply 开放改 name 后弱模型可注入重名，确定性拦在此。
    let mut seen_name: HashSet<&str> = HashSet::new();
    for node in nodes {
        let name = match node.name.as_deref() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if !seen_name.insert(name) {
            errors.push(VerifyError::new(
                "DUPLICATE_NAME",
                format!("有多个节点都叫 {name}，名字要唯一（改其中一个再继续）。"),
                Some(node.mid.clone()),
            ));
        }
    }

    // 3. 链路编号重复。
    let mut seen_link: HashSet<i64> = HashSet::new();
    for link in links {
        if !seen_link.insert(link.link_seq) {
            errors.push(VerifyError::new(
                "DUPLICATE_LINK",
                format!("链路编号 {} 重复了。", link.link_seq),
                None,
            ));
        }
    }

    // 4. 悬空链路（端点不存在）+ 5. 端口配对（styles_json 须有 leftLabel/rightLabel）。
    for link in links {
        let src_ok = by_sync.contains_key(link.src_node.as_str());
        let dst_ok = by_sync.contains_key(link.dst_node.as_str());
        if !src_ok || !dst_ok {
            let missing = if !src_ok {
                &link.src_node
            } else {
                &link.dst_node
            };
            errors.push(VerifyError::new(
                "DANGLING_LINK",
                format!("有一条线连到了不存在的节点 {missing}，拓扑不完整。"),
                Some(missing.clone()),
            ));
            continue;
        }
        if !link_ports_paired(link.src_port, link.dst_port) {
            let label = endpoint_label(link, &by_sync);
            errors.push(VerifyError::new(
                "PORT_UNPAIRED",
                format!("{label} 这条线缺少端口信息，没接对端口。"),
                None,
            ));
        }
    }

    // 6. 孤立节点（度为 0）。
    let degree = node_degrees(nodes, links, &by_sync);
    for node in nodes {
        if degree.get(node.mid.as_str()).copied().unwrap_or(0) == 0 {
            errors.push(VerifyError::new(
                "ISOLATED_NODE",
                format!("{} 没连任何线，是个孤立节点。", display_name(node)),
                Some(node.mid.clone()),
            ));
        }
    }

    // 7. 至少要有端系统（否则转发无从谈起）。
    let has_end_system = nodes
        .iter()
        .any(|n| n.node_type.as_deref() == Some(NODE_TYPE_END_SYSTEM));
    if !has_end_system {
        errors.push(VerifyError::new(
            "NO_END_SYSTEM",
            "还没有端系统，无法验证转发可达性。".to_string(),
            None,
        ));
    }

    // 8. MAC 可达性 = 全图单连通（每个节点对其它节点可达 → 转发表可派生）。
    //    只在没有悬空链路、且节点数 > 1 时判（悬空已单独报，避免重复噪音）。
    let has_dangling = errors.iter().any(|e| e.code == "DANGLING_LINK");
    if !has_dangling && nodes.len() > 1 {
        let adjacency = build_adjacency(nodes, links);
        let start = nodes[0].mid.as_str();
        let reached = reachable_from(start, &adjacency);
        for node in nodes {
            if !reached.contains(node.mid.as_str()) {
                errors.push(VerifyError::new(
                    "UNREACHABLE",
                    format!(
                        "{} 和拓扑其余部分不连通，转发到不了它。",
                        display_name(node)
                    ),
                    Some(node.mid.clone()),
                ));
            }
        }
    }

    VerifyResult {
        ok: errors.is_empty(),
        caliber: CALIBER_STRUCTURAL_ONLY,
        errors,
    }
}

fn endpoint_label(link: &VerifyLink, by_sync: &HashMap<&str, &VerifyNode>) -> String {
    let name_of = |sync: &str| {
        by_sync
            .get(sync)
            .map(|n| display_name(n))
            .unwrap_or_else(|| sync.to_string())
    };
    format!("{}↔{}", name_of(&link.src_node), name_of(&link.dst_node))
}

/// 端口配对：src_port/dst_port 两列皆非 NULL 才算配对（KTD1，列是结构事实源）。
fn link_ports_paired(src_port: Option<i64>, dst_port: Option<i64>) -> bool {
    src_port.is_some() && dst_port.is_some()
}

fn node_degrees<'a>(
    nodes: &'a [VerifyNode],
    links: &[VerifyLink],
    by_sync: &HashMap<&str, &VerifyNode>,
) -> HashMap<&'a str, usize> {
    let mut degree: HashMap<&str, usize> = nodes.iter().map(|n| (n.mid.as_str(), 0usize)).collect();
    for link in links {
        if !by_sync.contains_key(link.src_node.as_str())
            || !by_sync.contains_key(link.dst_node.as_str())
        {
            continue; // 悬空链路不计度（已单独报）。
        }
        if let Some(d) = degree.get_mut(link.src_node.as_str()) {
            *d += 1;
        }
        if let Some(d) = degree.get_mut(link.dst_node.as_str()) {
            *d += 1;
        }
    }
    degree
}

/// 从 src/dst_node 行建无向邻接（与 topology_compute build_adjacency 同规则：
/// 每条链路加两向边）。可达性只取决于边集，与端口无关，故结论与转发表 BFS 一致。
fn build_adjacency<'a>(
    nodes: &'a [VerifyNode],
    links: &'a [VerifyLink],
) -> HashMap<&'a str, Vec<&'a str>> {
    let mut adjacency: HashMap<&str, Vec<&str>> =
        nodes.iter().map(|n| (n.mid.as_str(), Vec::new())).collect();
    for link in links {
        if adjacency.contains_key(link.src_node.as_str())
            && adjacency.contains_key(link.dst_node.as_str())
        {
            adjacency
                .entry(link.src_node.as_str())
                .or_default()
                .push(link.dst_node.as_str());
            adjacency
                .entry(link.dst_node.as_str())
                .or_default()
                .push(link.src_node.as_str());
        }
    }
    adjacency
}

fn reachable_from<'a>(
    start: &'a str,
    adjacency: &HashMap<&'a str, Vec<&'a str>>,
) -> HashSet<&'a str> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = VecDeque::new();
    seen.insert(start);
    queue.push_back(start);
    while let Some(node) = queue.pop_front() {
        if let Some(neighbors) = adjacency.get(node) {
            for &next in neighbors {
                if seen.insert(next) {
                    queue.push_back(next);
                }
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(sync: &str, ty: &str) -> VerifyNode {
        VerifyNode {
            mid: sync.into(),
            name: None,
            node_type: Some(ty.into()),
            queue_count: 8,
        }
    }
    fn link(seq: i64, src: &str, dst: &str) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_node: src.into(),
            dst_node: dst.into(),
            src_port: Some(0),
            dst_port: Some(0),
            speed: None,
            styles_json: "{}".into(),
        }
    }
    fn codes(r: &VerifyResult) -> Vec<&str> {
        r.errors.iter().map(|e| e.code.as_str()).collect()
    }
    fn named_node(sync: &str, ty: &str, name: &str) -> VerifyNode {
        VerifyNode {
            mid: sync.into(),
            name: Some(name.into()),
            node_type: Some(ty.into()),
            queue_count: 8,
        }
    }

    /// 合法星型：1 交换机 + 2 端系统全连通 → ok。
    #[test]
    fn legal_star_passes() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let r = verify_topology(&nodes, &links);
        assert!(r.ok, "errors: {:?}", r.errors);
        assert_eq!(r.caliber, "structural_only");
    }

    /// 合法线型（多交换机骨干）→ ok。
    #[test]
    fn legal_line_passes() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "switch"),
            node("2", "endSystem"),
            node("3", "endSystem"),
        ];
        let links = vec![link(0, "0", "1"), link(1, "0", "2"), link(2, "1", "3")];
        assert!(verify_topology(&nodes, &links).ok);
    }

    /// AE1：链路连到不存在的节点（缺对端）→ DANGLING_LINK。
    #[test]
    fn dangling_link_blocks() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1"), link(1, "0", "99")];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"DANGLING_LINK"));
    }

    /// AE2：孤立端系统（未连任何线）→ ISOLATED_NODE。
    #[test]
    fn isolated_node_blocks() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        let links = vec![link(0, "0", "1")]; // 节点 2 没连
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"ISOLATED_NODE"));
    }

    /// AE3：分裂成两个互不连通子网 → UNREACHABLE。
    #[test]
    fn split_subnets_unreachable() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "switch"),
            node("3", "endSystem"),
        ];
        let links = vec![link(0, "0", "1"), link(1, "2", "3")]; // 两个孤岛
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"UNREACHABLE"));
    }

    #[test]
    fn empty_topology_blocks() {
        let r = verify_topology(&[], &[]);
        assert!(!r.ok);
        assert_eq!(codes(&r), vec!["EMPTY_TOPOLOGY"]);
    }

    #[test]
    fn unknown_node_role_blocks() {
        let mut nodes = vec![node("0", "switch"), node("1", "endSystem")];
        nodes.push(VerifyNode {
            mid: "2".into(),
            name: None,
            node_type: None,
            queue_count: 8,
        });
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"UNKNOWN_NODE_ROLE"));
    }

    // U6 命名前缀校验（依赖 U12 把各场景命名统一为 SW-/ES-）。
    #[test]
    fn node_name_prefix_accepts_conforming_sw_es() {
        let nodes = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "endSystem", "ES-1"),
        ];
        let links = vec![link(0, "0", "1")];
        let r = verify_topology(&nodes, &links);
        assert!(
            !codes(&r).contains(&"NODE_NAME_PREFIX"),
            "合规命名不应触发: {:?}",
            codes(&r)
        );
    }

    #[test]
    fn node_name_prefix_rejects_end_system_named_sw() {
        // 负例：端系统 name 为 SW-2（应 ES-）→ NODE_NAME_PREFIX。
        let nodes = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "endSystem", "SW-2"),
        ];
        let links = vec![link(0, "0", "1")];
        let r = verify_topology(&nodes, &links);
        assert!(
            codes(&r).contains(&"NODE_NAME_PREFIX"),
            "端系统叫 SW-2 应被拒: {:?}",
            codes(&r)
        );
    }

    #[test]
    fn node_name_prefix_skips_empty_name() {
        // apply 新增节点（U9 前合法无 name）跳过命名校验、不误拦。
        let nodes = vec![named_node("0", "switch", "SW-1"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let r = verify_topology(&nodes, &links);
        assert!(
            !codes(&r).contains(&"NODE_NAME_PREFIX"),
            "空 name 应跳过: {:?}",
            codes(&r)
        );
    }

    #[test]
    fn node_name_prefix_accepts_server_srv_and_rejects_wrong() {
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        // server → SRV-（与 SW/ES 对称分支）。
        let ok = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "endSystem", "ES-1"),
            named_node("2", "server", "SRV-1"),
        ];
        assert!(!codes(&verify_topology(&ok, &links)).contains(&"NODE_NAME_PREFIX"));
        // server 叫 X-1 → 被拒。
        let bad = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "endSystem", "ES-1"),
            named_node("2", "server", "X-1"),
        ];
        assert!(
            codes(&verify_topology(&bad, &links)).contains(&"NODE_NAME_PREFIX"),
            "server 叫 X-1 应被拒"
        );
    }

    #[test]
    fn node_name_prefix_skips_unknown_type_no_double_report() {
        // 未知类型 + 非空 name：只出 UNKNOWN_NODE_ROLE，不重复出 NODE_NAME_PREFIX。
        let nodes = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "endSystem", "ES-1"),
            VerifyNode {
                mid: "2".into(),
                name: Some("FOO-1".into()),
                node_type: None,
                queue_count: 8,
            },
        ];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let r = verify_topology(&nodes, &links);
        let c = codes(&r);
        assert!(c.contains(&"UNKNOWN_NODE_ROLE"));
        assert!(
            !c.contains(&"NODE_NAME_PREFIX"),
            "未知类型不应再报命名前缀: {c:?}"
        );
    }

    #[test]
    fn duplicate_name_blocks() {
        // review 闭环：两个不同 mid 节点同名 → DUPLICATE_NAME（inspect 按 name 匹配依赖唯一）。
        let nodes = vec![
            named_node("0", "switch", "SW-1"),
            named_node("1", "switch", "SW-1"),
            named_node("2", "endSystem", "ES-1"),
        ];
        let links = vec![link(0, "0", "2"), link(1, "1", "2")];
        let r = verify_topology(&nodes, &links);
        assert!(
            codes(&r).contains(&"DUPLICATE_NAME"),
            "重名应被拒: {:?}",
            codes(&r)
        );
        // 空 name 多个不算重名。
        let with_empty = vec![
            named_node("0", "switch", "SW-1"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        let r2 = verify_topology(&with_empty, &[link(0, "0", "1"), link(1, "0", "2")]);
        assert!(
            !codes(&r2).contains(&"DUPLICATE_NAME"),
            "空 name 不算重名: {:?}",
            codes(&r2)
        );
    }

    #[test]
    fn switches_only_no_end_system_blocks() {
        let nodes = vec![node("0", "switch"), node("1", "switch")];
        let links = vec![link(0, "0", "1")];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"NO_END_SYSTEM"));
    }

    #[test]
    fn unpaired_ports_block() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![VerifyLink {
            link_seq: 0,
            src_node: "0".into(),
            dst_node: "1".into(),
            src_port: Some(0),
            dst_port: None, // 一端口列 NULL → 未配对
            speed: None,
            styles_json: "{}".into(),
        }];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"PORT_UNPAIRED"));
    }

    // U7/AE10（verify 侧）：端口列齐全但 styles_json 无 leftLabel → 仍配对（不再依赖 styles_json）。
    #[test]
    fn paired_ports_without_leftlabel_pass() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        let links = vec![
            VerifyLink {
                link_seq: 0,
                src_node: "0".into(),
                dst_node: "1".into(),
                src_port: Some(1),
                dst_port: Some(0),
                speed: None,
                styles_json: r#"{"plane":"A"}"#.into(),
            },
            VerifyLink {
                link_seq: 1,
                src_node: "0".into(),
                dst_node: "2".into(),
                src_port: Some(2),
                dst_port: Some(0),
                speed: None,
                styles_json: r#"{"plane":"A"}"#.into(),
            },
        ];
        let r = verify_topology(&nodes, &links);
        assert!(r.ok, "errors: {:?}", r.errors);
        assert!(!codes(&r).contains(&"PORT_UNPAIRED"));
    }

    #[test]
    fn duplicate_mid_and_link_seq_block() {
        let nodes = vec![node("0", "switch"), node("0", "endSystem")];
        let links = vec![link(0, "0", "0"), link(0, "0", "0")];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        let c = codes(&r);
        assert!(c.contains(&"DUPLICATE_NODE"));
        assert!(c.contains(&"DUPLICATE_LINK"));
    }

    /// 锁定本模块不变式：连通 ⇔ 转发表可派生（连通拓扑的可达集覆盖全部节点，转发表对每对都能取首跳）。
    /// 与 topology_compute 转发 BFS 的一致性由两侧同规则建边（每链路加双向边）的构造保证，本测试不断言跨模块对账。
    #[test]
    fn reachability_matches_connectivity() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "switch"),
            node("2", "endSystem"),
            node("3", "endSystem"),
            node("4", "endSystem"),
        ];
        let links = vec![
            link(0, "0", "1"),
            link(1, "0", "2"),
            link(2, "0", "3"),
            link(3, "1", "4"),
        ];
        let adjacency = build_adjacency(&nodes, &links);
        let reached = reachable_from("0", &adjacency);
        // 连通 → 全部 5 个节点可达 → verify 通过。
        assert_eq!(reached.len(), nodes.len());
        assert!(verify_topology(&nodes, &links).ok);
    }
}
