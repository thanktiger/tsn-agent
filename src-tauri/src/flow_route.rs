//! 流路径推导（R11/R12/R17）。从库内拓扑（`topology_links` 结构列）建邻接、跑最短路，
//! 把每个转发节点的出口锚定到 **ethN**（`build_port_eth_map` 唯一门号事实源，KTD3），
//! 输出 `Vec<(node, ethN)>`——db_port 绝不外泄（R12，类型上不可能）。
//!
//! 双平面用 `styles_json.plane` 消歧（`plane=A`/`B`），单平面（链路无 plane 键）走
//! plane 缺省（全链路）。**每平面路径唯一**：存在等长多路径即响亮 `AMBIGUOUS_ROUTE`
//! 失败，绝不 `paths.first()` 静默取一条（R11）。RC/双平面备 A/B 不相交断言（R17，
//! FRER 逻辑本身不实现，只备断言）。
//!
//! 与 `MacForwardingTableConfigurator`（INET L2 转发表、纯拓扑最短路）区分——那是可选
//! 交叉核对，不是 GCL 来源。

use crate::inet_sim_bundle::build_port_eth_map;
use crate::topology_verify::{VerifyError, VerifyLink, VerifyNode};
use std::collections::{HashMap, HashSet, VecDeque};

/// 路由请求：talker→listener，可选 plane（None=单平面全链路，Some=双平面某平面子图）。
#[derive(Debug, Clone)]
pub struct RouteRequest<'a> {
    pub talker: &'a str,
    pub listener: &'a str,
    pub plane: Option<&'a str>,
}

/// 一条推导出的路径。`egress` 即 R12 的 `Vec<(node, ethN)>`（每转发节点出口，
/// talker→…、不含 listener）；`node_path`/`link_seqs` 供 R17 不相交断言。
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub egress: Vec<(String, usize)>,
    pub node_path: Vec<String>,
    pub link_seqs: Vec<i64>,
}

fn err(code: &str, message_zh: String, node_ref: Option<String>) -> VerifyError {
    VerifyError {
        code: code.to_string(),
        message_zh,
        node_ref,
    }
}

/// 链路所属平面（`styles_json.plane`）；无键返回 None。
fn link_plane(link: &VerifyLink) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&link.styles_json)
        .ok()
        .and_then(|v| {
            v.get("plane")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
        })
}

/// 有向边：从某节点经 `egress_port`（该节点上的库端口号）到 `neighbor`，用链路 `link_seq`。
struct Edge {
    neighbor: String,
    egress_port: i64,
    link_seq: i64,
}

/// 反向指针：`v` 由 `from` 经 `from` 上的 `egress_port`（链路 `link_seq`）到达。
struct Pred {
    from: String,
    egress_port: i64,
    link_seq: i64,
}

/// 推导单条路径。plane 过滤后 BFS 最短路 + 路径计数（唯一性）。egress 只经
/// `build_port_eth_map` 构造 ethN。不可达 → NO_ROUTE；等长多路径 → AMBIGUOUS_ROUTE。
pub fn derive_route(
    req: &RouteRequest,
    nodes: &[VerifyNode],
    links: &[VerifyLink],
) -> Result<Route, Vec<VerifyError>> {
    let node_set: HashSet<&str> = nodes.iter().map(|n| n.mid.as_str()).collect();
    let mut errors = Vec::new();
    if !node_set.contains(req.talker) {
        errors.push(err(
            "TALKER_NOT_FOUND",
            format!("发送节点 {} 不在拓扑里。", req.talker),
            Some(req.talker.to_string()),
        ));
    }
    if !node_set.contains(req.listener) {
        errors.push(err(
            "LISTENER_NOT_FOUND",
            format!("接收节点 {} 不在拓扑里。", req.listener),
            Some(req.listener.to_string()),
        ));
    }
    if req.talker == req.listener {
        errors.push(err(
            "TALKER_IS_LISTENER",
            format!("发送节点与接收节点相同（{}）。", req.talker),
            Some(req.talker.to_string()),
        ));
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // 门号映射从**全部**链路建（ethN 编号须与 U6 生成的 NED 一致，含跨平面全端口）。
    let port_map = build_port_eth_map(links);

    // plane 过滤后的邻接（NULL 端口链路不可路由，跳过——无 ethN 可锚）。
    let mut adj: HashMap<String, Vec<Edge>> = HashMap::new();
    for link in links {
        if let Some(p) = req.plane
            && link_plane(link).as_deref() != Some(p)
        {
            continue;
        }
        let (Some(sp), Some(dp)) = (link.src_port, link.dst_port) else {
            continue;
        };
        adj.entry(link.src_node.clone()).or_default().push(Edge {
            neighbor: link.dst_node.clone(),
            egress_port: sp,
            link_seq: link.link_seq,
        });
        adj.entry(link.dst_node.clone()).or_default().push(Edge {
            neighbor: link.src_node.clone(),
            egress_port: dp,
            link_seq: link.link_seq,
        });
    }

    // BFS 最短路 + 路径计数（同层计数完成后才出队，FIFO 保证）。
    let mut dist: HashMap<String, i64> = HashMap::new();
    let mut count: HashMap<String, u64> = HashMap::new();
    let mut pred: HashMap<String, Pred> = HashMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    dist.insert(req.talker.to_string(), 0);
    count.insert(req.talker.to_string(), 1);
    queue.push_back(req.talker.to_string());

    while let Some(u) = queue.pop_front() {
        let du = dist[&u];
        let cu = count[&u];
        if let Some(edges) = adj.get(&u) {
            for e in edges {
                match dist.get(&e.neighbor) {
                    None => {
                        dist.insert(e.neighbor.clone(), du + 1);
                        count.insert(e.neighbor.clone(), cu);
                        pred.insert(
                            e.neighbor.clone(),
                            Pred {
                                from: u.clone(),
                                egress_port: e.egress_port,
                                link_seq: e.link_seq,
                            },
                        );
                        queue.push_back(e.neighbor.clone());
                    }
                    Some(&dv) if dv == du + 1 => {
                        *count.get_mut(&e.neighbor).unwrap() += cu;
                    }
                    _ => {}
                }
            }
        }
    }

    if !dist.contains_key(req.listener) {
        let plane_hint = req
            .plane
            .map(|p| format!("（平面 {p}）"))
            .unwrap_or_default();
        return Err(vec![err(
            "NO_ROUTE",
            format!(
                "从 {} 到 {} 没有可达路径{plane_hint}。",
                req.talker, req.listener
            ),
            None,
        )]);
    }
    if count[req.listener] > 1 {
        let plane_hint = req.plane.map(|p| format!("平面 {p} ",)).unwrap_or_default();
        return Err(vec![err(
            "AMBIGUOUS_ROUTE",
            format!(
                "{plane_hint}从 {} 到 {} 存在多条等长路径，无法唯一确定门锚，请消歧后重试。",
                req.talker, req.listener
            ),
            None,
        )]);
    }

    // 反向重建路径（listener → talker），再反转。
    let mut hops: Vec<(String, i64, i64)> = Vec::new(); // (from, egress_port, link_seq)
    let mut node_path_rev: Vec<String> = vec![req.listener.to_string()];
    let mut cur = req.listener.to_string();
    while cur != req.talker {
        let p = &pred[&cur];
        hops.push((p.from.clone(), p.egress_port, p.link_seq));
        node_path_rev.push(p.from.clone());
        cur = p.from.clone();
    }
    hops.reverse();
    node_path_rev.reverse();
    let node_path = node_path_rev;

    // 每跳出口 → ethN（唯一门号事实源）。
    let mut egress = Vec::new();
    let mut link_seqs = Vec::new();
    for (from, egress_port, link_seq) in &hops {
        let eth_n = port_map
            .get(from)
            .and_then(|inner| inner.get(egress_port))
            .copied();
        match eth_n {
            Some(k) => egress.push((from.clone(), k)),
            None => {
                return Err(vec![err(
                    "PORT_UNMAPPED",
                    format!("节点 {from} 的出口端口 {egress_port} 无法映射到 ethN。"),
                    Some(from.clone()),
                )]);
            }
        }
        link_seqs.push(*link_seq);
    }

    Ok(Route {
        egress,
        node_path,
        link_seqs,
    })
}

/// RC/双平面：推导 A/B 两路径并断言不相交（R17）。FRER 帧复制逻辑本身不实现，
/// 只备断言——共用中间节点或链路即响亮失败。
///
/// `#[allow(dead_code)]`：本函数是 RC 路径的入口，按 R17「只备断言」暂无生产调用方
/// （FRER 本期不实现）；它引用 `derive_route`/`Route` 等，连带把本模块 API 标记为 live，
/// 待 U6/U7 消费 `derive_route` 后可移除本 allow（RC 若仍未接则保留）。
#[allow(dead_code)]
pub fn derive_redundant_routes(
    talker: &str,
    listener: &str,
    nodes: &[VerifyNode],
    links: &[VerifyLink],
) -> Result<(Route, Route), Vec<VerifyError>> {
    let a = derive_route(
        &RouteRequest {
            talker,
            listener,
            plane: Some("A"),
        },
        nodes,
        links,
    )?;
    let b = derive_route(
        &RouteRequest {
            talker,
            listener,
            plane: Some("B"),
        },
        nodes,
        links,
    )?;
    let disjoint = assert_disjoint(&a, &b);
    if !disjoint.is_empty() {
        return Err(disjoint);
    }
    Ok((a, b))
}

/// 两路径不相交断言：共用中间节点（非 talker/listener 端点）或共用链路即违规。
fn assert_disjoint(a: &Route, b: &Route) -> Vec<VerifyError> {
    let mut errors = Vec::new();
    let inner = |path: &[String]| -> HashSet<String> {
        if path.len() <= 2 {
            HashSet::new()
        } else {
            path[1..path.len() - 1].iter().cloned().collect()
        }
    };
    let a_mid = inner(&a.node_path);
    for n in inner(&b.node_path) {
        if a_mid.contains(&n) {
            errors.push(err(
                "PATHS_SHARE_NODE",
                format!("A/B 冗余路径共用中间节点 {n}，802.1CB 要求路径不相交。"),
                Some(n.clone()),
            ));
        }
    }
    let a_links: HashSet<i64> = a.link_seqs.iter().copied().collect();
    for ls in &b.link_seqs {
        if a_links.contains(ls) {
            errors.push(err(
                "PATHS_SHARE_LINK",
                format!("A/B 冗余路径共用链路 {ls}，802.1CB 要求路径不相交。"),
                None,
            ));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(mid: &str) -> VerifyNode {
        VerifyNode {
            mid: mid.to_string(),
            name: None,
            node_type: Some("switch".to_string()),
            queue_count: 8,
        }
    }

    fn link(seq: i64, src: &str, sp: i64, dst: &str, dp: i64, plane: Option<&str>) -> VerifyLink {
        let styles = match plane {
            Some(p) => format!(r#"{{"plane":"{p}"}}"#),
            None => "{}".to_string(),
        };
        VerifyLink {
            link_seq: seq,
            src_node: src.to_string(),
            dst_node: dst.to_string(),
            src_port: Some(sp),
            dst_port: Some(dp),
            speed: Some(1000),
            styles_json: styles,
        }
    }

    fn codes(errs: &[VerifyError]) -> Vec<&str> {
        errs.iter().map(|e| e.code.as_str()).collect()
    }

    /// AE6：线性链路 0—1—2—3—4—5（6 节点 5 跳），每转发节点出口全为 ethN；
    /// 构造 db_port≠ethN（节点 0 出口 db_port=5）→ 门锚 ethN=0 而非 eth5。
    #[test]
    fn linear_egress_all_ethn_with_db_port_not_equal_ethn() {
        let nodes: Vec<_> = ["0", "1", "2", "3", "4", "5"]
            .iter()
            .map(|m| node(m))
            .collect();
        // 节点 0 唯一端口 db_port=5（→ethN 0）；中间节点两端口按升序取 0/1。
        let links = vec![
            link(0, "0", 5, "1", 0, None),
            link(1, "1", 1, "2", 0, None),
            link(2, "2", 1, "3", 0, None),
            link(3, "3", 1, "4", 0, None),
            link(4, "4", 1, "5", 0, None),
        ];
        let route = derive_route(
            &RouteRequest {
                talker: "0",
                listener: "5",
                plane: None,
            },
            &nodes,
            &links,
        )
        .unwrap();
        assert_eq!(route.node_path, vec!["0", "1", "2", "3", "4", "5"]);
        // 5 个转发节点出口。节点 0 db_port=5 → ethN 0（非 5）。
        assert_eq!(
            route.egress,
            vec![
                ("0".to_string(), 0),
                ("1".to_string(), 1),
                ("2".to_string(), 1),
                ("3".to_string(), 1),
                ("4".to_string(), 1),
            ]
        );
    }

    /// 双平面单跳：plane=A 唯一确定 0-2-1；plane=B 得 0-3-1（不相交）。
    #[test]
    fn dual_plane_selects_per_plane_path() {
        let nodes: Vec<_> = ["0", "1", "2", "3"].iter().map(|m| node(m)).collect();
        let links = vec![
            link(0, "0", 0, "2", 0, Some("A")),
            link(1, "2", 1, "1", 0, Some("A")),
            link(2, "0", 1, "3", 0, Some("B")),
            link(3, "3", 1, "1", 1, Some("B")),
        ];
        let a = derive_route(
            &RouteRequest {
                talker: "0",
                listener: "1",
                plane: Some("A"),
            },
            &nodes,
            &links,
        )
        .unwrap();
        assert_eq!(a.node_path, vec!["0", "2", "1"]);
        let b = derive_route(
            &RouteRequest {
                talker: "0",
                listener: "1",
                plane: Some("B"),
            },
            &nodes,
            &links,
        )
        .unwrap();
        assert_eq!(b.node_path, vec!["0", "3", "1"]);
    }

    /// 同 plane 等长多路径（0-1-3 与 0-2-3）→ AMBIGUOUS_ROUTE 响亮失败（非静默取一条）。
    #[test]
    fn same_plane_multipath_fails_loudly() {
        let nodes: Vec<_> = ["0", "1", "2", "3"].iter().map(|m| node(m)).collect();
        let links = vec![
            link(0, "0", 0, "1", 0, None),
            link(1, "1", 1, "3", 0, None),
            link(2, "0", 1, "2", 0, None),
            link(3, "2", 1, "3", 1, None),
        ];
        let errs = derive_route(
            &RouteRequest {
                talker: "0",
                listener: "3",
                plane: None,
            },
            &nodes,
            &links,
        )
        .unwrap_err();
        assert!(
            codes(&errs).contains(&"AMBIGUOUS_ROUTE"),
            "{:?}",
            codes(&errs)
        );
    }

    /// 不可达 → NO_ROUTE。
    #[test]
    fn unreachable_listener_no_route() {
        let nodes: Vec<_> = ["0", "1", "9"].iter().map(|m| node(m)).collect();
        let links = vec![link(0, "0", 0, "1", 0, None)]; // 9 孤岛
        let errs = derive_route(
            &RouteRequest {
                talker: "0",
                listener: "9",
                plane: None,
            },
            &nodes,
            &links,
        )
        .unwrap_err();
        assert!(codes(&errs).contains(&"NO_ROUTE"), "{:?}", codes(&errs));
    }

    /// RC 双平面：A(0-2-1)/B(0-3-1) 节点/链路不相交 → 断言通过。
    #[test]
    fn redundant_disjoint_paths_pass() {
        let nodes: Vec<_> = ["0", "1", "2", "3"].iter().map(|m| node(m)).collect();
        let links = vec![
            link(0, "0", 0, "2", 0, Some("A")),
            link(1, "2", 1, "1", 0, Some("A")),
            link(2, "0", 1, "3", 0, Some("B")),
            link(3, "3", 1, "1", 1, Some("B")),
        ];
        let (a, b) = derive_redundant_routes("0", "1", &nodes, &links).unwrap();
        assert_eq!(a.node_path, vec!["0", "2", "1"]);
        assert_eq!(b.node_path, vec!["0", "3", "1"]);
    }

    /// 人为让 A/B 共用中间节点 2 → PATHS_SHARE_NODE 断言失败。
    #[test]
    fn redundant_sharing_node_fails() {
        let nodes: Vec<_> = ["0", "1", "2"].iter().map(|m| node(m)).collect();
        // 平面 A 与 B 都经节点 2（并行链路，不同 link_seq）。
        let links = vec![
            link(0, "0", 0, "2", 0, Some("A")),
            link(1, "2", 1, "1", 0, Some("A")),
            link(2, "0", 1, "2", 2, Some("B")),
            link(3, "2", 3, "1", 1, Some("B")),
        ];
        let errs = derive_redundant_routes("0", "1", &nodes, &links).unwrap_err();
        assert!(
            codes(&errs).contains(&"PATHS_SHARE_NODE"),
            "{:?}",
            codes(&errs)
        );
    }
}
