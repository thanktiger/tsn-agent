//! 拓扑阶段结构验证（第一批，不依赖 INET）。读库内拓扑（节点以 sync_name 标识、
//! 连线以 src/dst_sync_name 引用）做确定性图论 + MAC 可达校验，返回
//! `{ok, errors[], caliber}`。纯函数、可单测；不碰网络、不跑仿真。
//!
//! 口径恒 `structural_only`：只验结构连通/可达，不代表时延或可调度性（INET 验证是第二批）。
//!
//! MAC 可达性说明：转发表由"无向图最短路 BFS 取首跳"派生（见 topology_compute
//! build_legacy_mac_forwarding_table / find_first_egress_port），按构造即无环、
//! 每目的唯一出端口。因此 MAC 现算现验在本模块归结为一条**连通性**判定：全图单连通
//! ⇔ 每个端系统对其它节点全可达 ⇔ 转发表可派生。两条 BFS 跑同一条无向边集，可达性
//! 结论按构造一致（见测试 reachability_matches_connectivity）。

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

pub const CALIBER_STRUCTURAL_ONLY: &str = "structural_only";
/// 第二批 INET 加载冒烟口径：能加载运行 ≠ 时延/调度已验。与上面并列、口径常量集中一处（KTD5）。
pub const CALIBER_LOADABILITY_ONLY: &str = "loadability_only";

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
        Self { code: code.to_string(), message_zh, node_ref }
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
    pub sync_name: String,
    pub name: Option<String>,
    pub node_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VerifyLink {
    pub link_seq: i64,
    pub src_sync_name: String,
    pub dst_sync_name: String,
    pub styles_json: String,
}

/// 节点展示名：优先用 name 列（如 SW-1/ES-1），缺失时按类型前缀 + sync_name 派生，
/// 与前端显示名映射一致，让结论里的节点引用对用户可读。
fn display_name(node: &VerifyNode) -> String {
    if let Some(name) = node.name.as_deref() {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let prefix = match node.node_type.as_deref() {
        Some(NODE_TYPE_SWITCH) => "SW",
        Some(NODE_TYPE_END_SYSTEM) => "ES",
        Some(NODE_TYPE_SERVER) => "SRV",
        _ => "节点",
    };
    format!("{prefix}-{}", node.sync_name)
}

fn is_known_role(node_type: Option<&str>) -> bool {
    matches!(node_type, Some(NODE_TYPE_SWITCH | NODE_TYPE_END_SYSTEM | NODE_TYPE_SERVER))
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
        return VerifyResult { ok: false, caliber: CALIBER_STRUCTURAL_ONLY, errors };
    }

    let by_sync: HashMap<&str, &VerifyNode> =
        nodes.iter().map(|n| (n.sync_name.as_str(), n)).collect();

    // 1. 节点编号重复。
    let mut seen_sync: HashSet<&str> = HashSet::new();
    for node in nodes {
        if !seen_sync.insert(node.sync_name.as_str()) {
            errors.push(VerifyError::new(
                "DUPLICATE_NODE",
                format!("节点编号 {} 重复了。", node.sync_name),
                Some(node.sync_name.clone()),
            ));
        }
    }

    // 2. 节点角色：未知/缺失类型本身判错，不静默归类。
    for node in nodes {
        if !is_known_role(node.node_type.as_deref()) {
            errors.push(VerifyError::new(
                "UNKNOWN_NODE_ROLE",
                format!("{} 的类型未知，无法判断它是交换机还是端系统。", display_name(node)),
                Some(node.sync_name.clone()),
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
        let src_ok = by_sync.contains_key(link.src_sync_name.as_str());
        let dst_ok = by_sync.contains_key(link.dst_sync_name.as_str());
        if !src_ok || !dst_ok {
            let missing = if !src_ok { &link.src_sync_name } else { &link.dst_sync_name };
            errors.push(VerifyError::new(
                "DANGLING_LINK",
                format!("有一条线连到了不存在的节点 {missing}，拓扑不完整。"),
                Some(missing.clone()),
            ));
            continue;
        }
        if !link_ports_paired(&link.styles_json) {
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
        if degree.get(node.sync_name.as_str()).copied().unwrap_or(0) == 0 {
            errors.push(VerifyError::new(
                "ISOLATED_NODE",
                format!("{} 没连任何线，是个孤立节点。", display_name(node)),
                Some(node.sync_name.clone()),
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
        let start = nodes[0].sync_name.as_str();
        let reached = reachable_from(start, &adjacency);
        for node in nodes {
            if !reached.contains(node.sync_name.as_str()) {
                errors.push(VerifyError::new(
                    "UNREACHABLE",
                    format!("{} 和拓扑其余部分不连通，转发到不了它。", display_name(node)),
                    Some(node.sync_name.clone()),
                ));
            }
        }
    }

    VerifyResult { ok: errors.is_empty(), caliber: CALIBER_STRUCTURAL_ONLY, errors }
}

fn endpoint_label(link: &VerifyLink, by_sync: &HashMap<&str, &VerifyNode>) -> String {
    let name_of = |sync: &str| {
        by_sync
            .get(sync)
            .map(|n| display_name(n))
            .unwrap_or_else(|| sync.to_string())
    };
    format!("{}↔{}", name_of(&link.src_sync_name), name_of(&link.dst_sync_name))
}

/// styles_json 是 JSON 串，端口在 leftLabel/rightLabel；两者皆有非空值才算配对。
fn link_ports_paired(styles_json: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(styles_json) else {
        return false;
    };
    let has = |key: &str| {
        value
            .get(key)
            .map(|v| !v.is_null() && v.to_string() != "\"\"")
            .unwrap_or(false)
    };
    has("leftLabel") && has("rightLabel")
}

fn node_degrees<'a>(
    nodes: &'a [VerifyNode],
    links: &[VerifyLink],
    by_sync: &HashMap<&str, &VerifyNode>,
) -> HashMap<&'a str, usize> {
    let mut degree: HashMap<&str, usize> =
        nodes.iter().map(|n| (n.sync_name.as_str(), 0usize)).collect();
    for link in links {
        if !by_sync.contains_key(link.src_sync_name.as_str())
            || !by_sync.contains_key(link.dst_sync_name.as_str())
        {
            continue; // 悬空链路不计度（已单独报）。
        }
        if let Some(d) = degree.get_mut(link.src_sync_name.as_str()) {
            *d += 1;
        }
        if let Some(d) = degree.get_mut(link.dst_sync_name.as_str()) {
            *d += 1;
        }
    }
    degree
}

/// 从 src/dst_sync_name 行建无向邻接（与 topology_compute build_adjacency 同规则：
/// 每条链路加两向边）。可达性只取决于边集，与端口无关，故结论与转发表 BFS 一致。
fn build_adjacency<'a>(
    nodes: &'a [VerifyNode],
    links: &'a [VerifyLink],
) -> HashMap<&'a str, Vec<&'a str>> {
    let mut adjacency: HashMap<&str, Vec<&str>> =
        nodes.iter().map(|n| (n.sync_name.as_str(), Vec::new())).collect();
    for link in links {
        if adjacency.contains_key(link.src_sync_name.as_str())
            && adjacency.contains_key(link.dst_sync_name.as_str())
        {
            adjacency
                .entry(link.src_sync_name.as_str())
                .or_default()
                .push(link.dst_sync_name.as_str());
            adjacency
                .entry(link.dst_sync_name.as_str())
                .or_default()
                .push(link.src_sync_name.as_str());
        }
    }
    adjacency
}

fn reachable_from<'a>(start: &'a str, adjacency: &HashMap<&'a str, Vec<&'a str>>) -> HashSet<&'a str> {
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
        VerifyNode { sync_name: sync.into(), name: None, node_type: Some(ty.into()) }
    }
    fn link(seq: i64, src: &str, dst: &str) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_sync_name: src.into(),
            dst_sync_name: dst.into(),
            styles_json: r#"{"leftLabel":"0","rightLabel":"0"}"#.into(),
        }
    }
    fn codes(r: &VerifyResult) -> Vec<&str> {
        r.errors.iter().map(|e| e.code.as_str()).collect()
    }

    /// 合法星型：1 交换机 + 2 端系统全连通 → ok。
    #[test]
    fn legal_star_passes() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem"), node("2", "endSystem")];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let r = verify_topology(&nodes, &links);
        assert!(r.ok, "errors: {:?}", r.errors);
        assert_eq!(r.caliber, "structural_only");
    }

    /// 合法线型（多交换机骨干）→ ok。
    #[test]
    fn legal_line_passes() {
        let nodes = vec![
            node("0", "switch"), node("1", "switch"),
            node("2", "endSystem"), node("3", "endSystem"),
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
        let nodes = vec![node("0", "switch"), node("1", "endSystem"), node("2", "endSystem")];
        let links = vec![link(0, "0", "1")]; // 节点 2 没连
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"ISOLATED_NODE"));
    }

    /// AE3：分裂成两个互不连通子网 → UNREACHABLE。
    #[test]
    fn split_subnets_unreachable() {
        let nodes = vec![
            node("0", "switch"), node("1", "endSystem"),
            node("2", "switch"), node("3", "endSystem"),
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
        nodes.push(VerifyNode { sync_name: "2".into(), name: None, node_type: None });
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"UNKNOWN_NODE_ROLE"));
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
            link_seq: 0, src_sync_name: "0".into(), dst_sync_name: "1".into(),
            styles_json: "{}".into(), // 无 leftLabel/rightLabel
        }];
        let r = verify_topology(&nodes, &links);
        assert!(!r.ok);
        assert!(codes(&r).contains(&"PORT_UNPAIRED"));
    }

    #[test]
    fn duplicate_sync_name_and_link_seq_block() {
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
            node("0", "switch"), node("1", "switch"),
            node("2", "endSystem"), node("3", "endSystem"), node("4", "endSystem"),
        ];
        let links = vec![link(0, "0", "1"), link(1, "0", "2"), link(2, "0", "3"), link(3, "1", "4")];
        let adjacency = build_adjacency(&nodes, &links);
        let reached = reachable_from("0", &adjacency);
        // 连通 → 全部 5 个节点可达 → verify 通过。
        assert_eq!(reached.len(), nodes.len());
        assert!(verify_topology(&nodes, &links).ok);
    }
}
