//! 流路径推导（R11/R12/R17）。从库内拓扑（`topology_links` 结构列）建邻接、跑最短路，
//! 把每个转发节点的出口锚定到 **ethN**（`build_port_eth_map` 唯一门号事实源，KTD3），
//! 输出 `Vec<(node, ethN)>`——db_port 绝不外泄（R12，类型上不可能）。
//!
//! 双平面用 `styles_json.plane` 消歧（`plane=A`/`B`），单平面（链路无 plane 键）走
//! plane 缺省（全链路）。**每平面路径唯一**：存在等长多路径即响亮 `AMBIGUOUS_ROUTE`
//! 失败，绝不 `paths.first()` 静默取一条（R11）。RC/双平面 A/B 不相交断言由录入闸
//! 消费（R2；FRER 装配另在 verify bundle 侧）。
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

/// 链路所属平面（`styles_json.plane`）；无键返回 None。录入闸（flow_verify）用它
/// 判「拓扑是否双平面」（存在任一带 plane 键的链路）。
pub(crate) fn link_plane(link: &VerifyLink) -> Option<String> {
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

/// RC/双平面：推导 A/B 两路径并断言不相交（R2/R17）。录入闸（`flow_verify::derive_rc_paths`）
/// 在 RC 落库前消费；共用中间节点或链路即响亮失败。
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

// ───────────────────────── 路径指定（R16 / KTD11 / KTD12） ─────────────────────────

/// `flow_streams.paths` 列的统一 JSON 形状（KTD12，v1）：
/// `{"version":1,"origin":"user"|"system","routes":[{node_path,link_seqs},...]}`。
/// RC 恒两条（routes[0]=A 平面、routes[1]=B 平面，origin=system 凭证）；
/// ST/BE 显式指定恒一条（origin=user 事实源）。NULL=系统推导。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FlowPaths {
    pub version: u32,
    pub origin: String, // "user" | "system"
    pub routes: Vec<PathRoute>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PathRoute {
    pub node_path: Vec<String>,
    pub link_seqs: Vec<i64>,
}

/// 解析 paths 列 JSON，兼容旧 RC 形状 `{"a":{...},"b":{...}}`（读侧兼容，
/// 旧形状归一由 session_import 写边界完成，此处只转不回写）。解析失败返回 None（视同未指定）。
pub fn parse_flow_paths(json: &str) -> Option<FlowPaths> {
    if let Ok(v) = serde_json::from_str::<FlowPaths>(json)
        && !v.routes.is_empty()
    {
        return Some(v);
    }
    // 旧形状：{"a":{node_path,link_seqs},"b":{...}}
    let legacy: serde_json::Value = serde_json::from_str(json).ok()?;
    let parse_leg =
        |key: &str| -> Option<PathRoute> { serde_json::from_value(legacy.get(key)?.clone()).ok() };
    let (a, b) = (parse_leg("a")?, parse_leg("b")?);
    Some(FlowPaths {
        version: 1,
        origin: "system".to_string(),
        routes: vec![a, b],
    })
}

/// 从 link_seq 序列重建 Route 并完整校验：逐段链路存在、端点连续、首尾锚定
/// talker/listener、无重复节点、（双平面拓扑）整条同平面。错误码具体
/// （LINK_NOT_FOUND/PATH_DISCONTINUOUS/...），消费期由 resolve_flow_path 统一包装 PATH_STALE。
pub fn build_route_from_link_seqs(
    link_seqs: &[i64],
    talker: &str,
    listener: &str,
    links: &[VerifyLink],
) -> Result<Route, Vec<VerifyError>> {
    if link_seqs.is_empty() {
        return Err(vec![err("PATH_EMPTY", "指定路径为空。".to_string(), None)]);
    }
    let by_seq: HashMap<i64, &VerifyLink> = links.iter().map(|l| (l.link_seq, l)).collect();
    let port_map = build_port_eth_map(links);

    let mut node_path = vec![talker.to_string()];
    let mut egress = Vec::new();
    let mut cur = talker.to_string();
    let mut planes: Vec<Option<String>> = Vec::new();
    for seq in link_seqs {
        let Some(link) = by_seq.get(seq) else {
            return Err(vec![err(
                "LINK_NOT_FOUND",
                format!("指定路径中的链路 {seq} 已不存在。"),
                None,
            )]);
        };
        // 方向判定：当前节点必须是链路一端。
        let (egress_port, next) = if link.src_node == cur {
            (link.src_port, link.dst_node.clone())
        } else if link.dst_node == cur {
            (link.dst_port, link.src_node.clone())
        } else {
            return Err(vec![err(
                "PATH_DISCONTINUOUS",
                format!("指定路径在节点 {cur} 处断开（链路 {seq} 不与其相连）。"),
                Some(cur.clone()),
            )]);
        };
        let Some(ep) = egress_port else {
            return Err(vec![err(
                "PORT_UNMAPPED",
                format!("链路 {seq} 在节点 {cur} 侧无端口号，无法锚定门。"),
                Some(cur.clone()),
            )]);
        };
        let Some(eth_n) = port_map.get(&cur).and_then(|m| m.get(&ep)).copied() else {
            return Err(vec![err(
                "PORT_UNMAPPED",
                format!("节点 {cur} 的出口端口 {ep} 无法映射到 ethN。"),
                Some(cur.clone()),
            )]);
        };
        planes.push(link_plane(link));
        egress.push((cur.clone(), eth_n));
        if node_path.contains(&next) {
            return Err(vec![err(
                "PATH_NODE_REPEATED",
                format!("指定路径重复经过节点 {next}。"),
                Some(next.clone()),
            )]);
        }
        node_path.push(next.clone());
        cur = next;
    }
    if cur != listener {
        return Err(vec![err(
            "PATH_ENDPOINT_MISMATCH",
            format!("指定路径终点 {cur} 不是接收节点 {listener}。"),
            None,
        )]);
    }
    // 双平面拓扑：整条路径须落在同一平面（沿现状 ST 锁平面语义）。
    let dual_plane = links.iter().any(|l| link_plane(l).is_some());
    if dual_plane {
        let first = planes.first().cloned().flatten();
        if first.is_none() || planes.iter().any(|p| *p != first) {
            return Err(vec![err(
                "PATH_CROSSES_PLANES",
                "双平面拓扑上指定路径须整条落在同一平面内。".to_string(),
                None,
            )]);
        }
    }
    Ok(Route {
        egress,
        node_path,
        link_seqs: link_seqs.to_vec(),
    })
}

/// 统一路径解析出口（KTD11）：ST/BE 显式指定（origin=user）优先——消费前复验，
/// 失效响亮 `PATH_STALE`（绝不静默回退最短路）；未指定走 `derive_route` 现状推导。
/// RC 不经此出口（双路径凭证由 derive_redundant_routes 重推导）。
pub fn resolve_flow_path(
    paths_json: Option<&str>,
    req: &RouteRequest,
    nodes: &[VerifyNode],
    links: &[VerifyLink],
) -> Result<Route, Vec<VerifyError>> {
    if let Some(json) = paths_json
        && let Some(fp) = parse_flow_paths(json)
        && fp.origin == "user"
        && let Some(route) = fp.routes.first()
    {
        return build_route_from_link_seqs(&route.link_seqs, req.talker, req.listener, links)
            .map_err(|es| {
                let detail = es.first().map(|e| e.message_zh.clone()).unwrap_or_default();
                vec![err(
                    "PATH_STALE",
                    format!("指定路径已失效（{detail}），请重新指定或改回系统自动。"),
                    None,
                )]
            });
    }
    derive_route(req, nodes, links)
}

/// 候选简单路径枚举（弹窗路径下拉用）：DFS 有界，按（跳数, link_seq 字典序）排序，
/// 最多 `limit` 条；返回 (候选, 是否截断)。plane 语义与 derive_route 一致。
pub fn enumerate_candidate_paths(
    req: &RouteRequest,
    links: &[VerifyLink],
    limit: usize,
) -> (Vec<Route>, bool) {
    // 邻接（与 derive_route 同口径：plane 过滤 + NULL 端口跳过）。
    let mut adj: HashMap<String, Vec<(String, i64, i64)>> = HashMap::new(); // (next, egress_port, link_seq)
    for link in links {
        if let Some(p) = req.plane
            && link_plane(link).as_deref() != Some(p)
        {
            continue;
        }
        let (Some(sp), Some(dp)) = (link.src_port, link.dst_port) else {
            continue;
        };
        adj.entry(link.src_node.clone()).or_default().push((
            link.dst_node.clone(),
            sp,
            link.link_seq,
        ));
        adj.entry(link.dst_node.clone()).or_default().push((
            link.src_node.clone(),
            dp,
            link.link_seq,
        ));
    }
    // link_seq 序遍历保证枚举顺序确定。
    for edges in adj.values_mut() {
        edges.sort_by_key(|(_, _, seq)| *seq);
    }
    let mut found: Vec<Vec<i64>> = Vec::new();
    let mut truncated = false;
    let mut stack_nodes: Vec<String> = vec![req.talker.to_string()];
    let mut stack_links: Vec<i64> = Vec::new();
    // 收集上限：limit+1 用于判截断；深度上限=节点数（简单路径天然有界）。
    fn dfs(
        cur: &str,
        listener: &str,
        adj: &HashMap<String, Vec<(String, i64, i64)>>,
        stack_nodes: &mut Vec<String>,
        stack_links: &mut Vec<i64>,
        found: &mut Vec<Vec<i64>>,
        cap: usize,
    ) {
        if found.len() >= cap {
            return;
        }
        if cur == listener {
            found.push(stack_links.clone());
            return;
        }
        if let Some(edges) = adj.get(cur) {
            for (next, _ep, seq) in edges {
                if stack_nodes.contains(next) {
                    continue;
                }
                stack_nodes.push(next.clone());
                stack_links.push(*seq);
                dfs(next, listener, adj, stack_nodes, stack_links, found, cap);
                stack_nodes.pop();
                stack_links.pop();
            }
        }
    }
    dfs(
        req.talker,
        req.listener,
        &adj,
        &mut stack_nodes,
        &mut stack_links,
        &mut found,
        limit + 1,
    );
    if found.len() > limit {
        truncated = true;
        found.truncate(limit);
    }
    found.sort_by(|a, b| (a.len(), a.as_slice()).cmp(&(b.len(), b.as_slice())));
    let routes = found
        .into_iter()
        .filter_map(|seqs| build_route_from_link_seqs(&seqs, req.talker, req.listener, links).ok())
        .collect();
    (routes, truncated)
}

/// agent path 参数解析：节点引用序列（mid 或**唯一** name）→ Route。
/// 无名节点只能用 mid；重名 name 报 NODE_NAME_AMBIGUOUS；相邻对存在多条平行链路
/// 报 PARALLEL_LINKS_AMBIGUOUS（节点序列无法唯一确定链路）。
pub fn route_from_node_refs(
    refs: &[String],
    talker: &str,
    listener: &str,
    nodes: &[VerifyNode],
    links: &[VerifyLink],
) -> Result<Route, Vec<VerifyError>> {
    if refs.len() < 2 {
        return Err(vec![err(
            "PATH_TOO_SHORT",
            "路径至少要有发送与接收两个节点。".to_string(),
            None,
        )]);
    }
    // 引用 → mid：先精确 mid，再唯一 name。
    let mut mids = Vec::with_capacity(refs.len());
    for r in refs {
        if nodes.iter().any(|n| n.mid == *r) {
            mids.push(r.clone());
            continue;
        }
        let matches: Vec<&VerifyNode> = nodes
            .iter()
            .filter(|n| n.name.as_deref() == Some(r.as_str()))
            .collect();
        match matches.len() {
            1 => mids.push(matches[0].mid.clone()),
            0 => {
                return Err(vec![err(
                    "NODE_NOT_FOUND",
                    format!("路径中的节点 {r} 不存在（可用 mid 或唯一名称指定）。"),
                    Some(r.clone()),
                )]);
            }
            _ => {
                return Err(vec![err(
                    "NODE_NAME_AMBIGUOUS",
                    format!("节点名称 {r} 有多个匹配，请改用 mid 指定。"),
                    Some(r.clone()),
                )]);
            }
        }
    }
    // 相邻对 → 唯一链路。
    let mut link_seqs = Vec::with_capacity(mids.len() - 1);
    for w in mids.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let cands: Vec<i64> = links
            .iter()
            .filter(|l| {
                (l.src_node == *a && l.dst_node == *b) || (l.src_node == *b && l.dst_node == *a)
            })
            .map(|l| l.link_seq)
            .collect();
        match cands.len() {
            1 => link_seqs.push(cands[0]),
            0 => {
                return Err(vec![err(
                    "NO_LINK_BETWEEN",
                    format!("节点 {a} 与 {b} 之间没有链路。"),
                    None,
                )]);
            }
            _ => {
                return Err(vec![err(
                    "PARALLEL_LINKS_AMBIGUOUS",
                    format!(
                        "节点 {a} 与 {b} 之间有多条链路，节点序列无法唯一确定，请在界面候选中选择。"
                    ),
                    None,
                )]);
            }
        }
    }
    build_route_from_link_seqs(&link_seqs, talker, listener, links)
}

/// 显式指定路径的 paths 列 JSON（origin=user，恒一条）。
pub fn explicit_paths_json(route: &Route) -> String {
    serde_json::to_string(&FlowPaths {
        version: 1,
        origin: "user".to_string(),
        routes: vec![PathRoute {
            node_path: route.node_path.clone(),
            link_seqs: route.link_seqs.clone(),
        }],
    })
    .expect("FlowPaths 序列化不可失败")
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

    // ── R16 路径指定（U10a） ─────────────────────────────────────────────

    /// 旧 RC 形状 {a,b} 读侧兼容：转为 routes[a,b] + origin=system。
    #[test]
    fn parse_flow_paths_legacy_ab_shape() {
        let legacy = r#"{"a":{"node_path":["0","2","1"],"link_seqs":[0,1]},"b":{"node_path":["0","3","1"],"link_seqs":[2,3]}}"#;
        let fp = parse_flow_paths(legacy).unwrap();
        assert_eq!(fp.origin, "system");
        assert_eq!(fp.routes.len(), 2);
        assert_eq!(fp.routes[0].link_seqs, vec![0, 1]);
        assert_eq!(fp.routes[1].node_path, vec!["0", "3", "1"]);
    }

    /// 新形状直读；垃圾 JSON → None（视同未指定）。
    #[test]
    fn parse_flow_paths_new_shape_and_garbage() {
        let new =
            r#"{"version":1,"origin":"user","routes":[{"node_path":["0","1"],"link_seqs":[0]}]}"#;
        let fp = parse_flow_paths(new).unwrap();
        assert_eq!(fp.origin, "user");
        assert_eq!(fp.routes.len(), 1);
        assert!(parse_flow_paths("not-json").is_none());
        assert!(parse_flow_paths(r#"{"a":"garbage"}"#).is_none());
    }

    /// build_route_from_link_seqs：合法路径重建 node_path/egress，方向自适应。
    #[test]
    fn build_route_valid_path_reconstructs() {
        let links = vec![link(0, "0", 0, "2", 0, None), link(1, "1", 0, "2", 1, None)];
        // 0→2 用 link0，2→1 用 link1（link1 存的方向是 1→2，反向走）。
        let r = build_route_from_link_seqs(&[0, 1], "0", "1", &links).unwrap();
        assert_eq!(r.node_path, vec!["0", "2", "1"]);
        assert_eq!(r.link_seqs, vec![0, 1]);
        assert_eq!(r.egress.len(), 2);
    }

    /// 失效面全覆盖：链路不存在 / 断开 / 终点不符 / 重复节点 / 空路径。
    #[test]
    fn build_route_failure_modes() {
        let links = vec![link(0, "0", 0, "2", 0, None), link(1, "1", 0, "2", 1, None)];
        let c = |seqs: &[i64], t: &str, l: &str| {
            build_route_from_link_seqs(seqs, t, l, &links)
                .unwrap_err()
                .first()
                .unwrap()
                .code
                .clone()
        };
        assert_eq!(c(&[9], "0", "1"), "LINK_NOT_FOUND");
        assert_eq!(c(&[1], "0", "1"), "PATH_DISCONTINUOUS"); // link1 不连节点 0
        assert_eq!(c(&[0], "0", "1"), "PATH_ENDPOINT_MISMATCH"); // 止于 2 非 1
        assert_eq!(c(&[0, 0], "0", "1"), "PATH_NODE_REPEATED"); // 原路返回
        assert_eq!(c(&[], "0", "1"), "PATH_EMPTY");
    }

    /// 双平面拓扑：跨平面路径拒绝，同平面通过。
    #[test]
    fn build_route_plane_consistency() {
        let links = vec![
            link(0, "0", 0, "2", 0, Some("A")),
            link(1, "2", 1, "1", 0, Some("B")),
            link(2, "2", 2, "1", 1, Some("A")),
        ];
        let err = build_route_from_link_seqs(&[0, 1], "0", "1", &links).unwrap_err();
        assert_eq!(err[0].code, "PATH_CROSSES_PLANES");
        assert!(build_route_from_link_seqs(&[0, 2], "0", "1", &links).is_ok());
    }

    /// resolve_flow_path：origin=user 指定优先；失效包装 PATH_STALE；无指定走推导。
    #[test]
    fn resolve_flow_path_explicit_priority_and_stale() {
        let nodes: Vec<_> = ["0", "1", "2", "3"].iter().map(|m| node(m)).collect();
        // 0-2-1 与 0-3-1 两条等长路径（推导会 AMBIGUOUS），显式指定消歧。
        let links = vec![
            link(0, "0", 0, "2", 0, None),
            link(1, "2", 1, "1", 0, None),
            link(2, "0", 1, "3", 0, None),
            link(3, "3", 1, "1", 1, None),
        ];
        let req = RouteRequest {
            talker: "0",
            listener: "1",
            plane: None,
        };
        // 无指定 → 歧义响亮。
        assert_eq!(
            derive_route(&req, &nodes, &links).unwrap_err()[0].code,
            "AMBIGUOUS_ROUTE"
        );
        // 显式指定 → 消歧成功。
        let json = r#"{"version":1,"origin":"user","routes":[{"node_path":["0","2","1"],"link_seqs":[0,1]}]}"#;
        let r = resolve_flow_path(Some(json), &req, &nodes, &links).unwrap();
        assert_eq!(r.node_path, vec!["0", "2", "1"]);
        // 指定路径的链路被删 → PATH_STALE 响亮，不静默回退。
        let links_after_delete: Vec<_> =
            links.iter().filter(|l| l.link_seq != 1).cloned().collect();
        let err = resolve_flow_path(Some(json), &req, &nodes, &links_after_delete).unwrap_err();
        assert_eq!(err[0].code, "PATH_STALE");
        // origin=system（RC 凭证形状）不进显式分支 → 走推导。
        let sys_json = r#"{"version":1,"origin":"system","routes":[{"node_path":["0","2","1"],"link_seqs":[0,1]}]}"#;
        assert_eq!(
            resolve_flow_path(Some(sys_json), &req, &nodes, &links).unwrap_err()[0].code,
            "AMBIGUOUS_ROUTE"
        );
    }

    /// 候选枚举：等长两条 + 更长一条全部列出、有序；limit 截断置位。
    #[test]
    fn enumerate_candidates_ordering_and_truncation() {
        let links = vec![
            link(0, "0", 0, "2", 0, None),
            link(1, "2", 1, "1", 0, None),
            link(2, "0", 1, "3", 0, None),
            link(3, "3", 1, "1", 1, None),
            link(4, "2", 2, "3", 2, None), // 引出更长路径 0-2-3-1 / 0-3-2-1
        ];
        let req = RouteRequest {
            talker: "0",
            listener: "1",
            plane: None,
        };
        let (routes, truncated) = enumerate_candidate_paths(&req, &links, 8);
        assert!(!truncated);
        assert_eq!(routes.len(), 4);
        // 跳数升序：两条 2 跳在前。
        assert!(routes[0].link_seqs.len() == 2 && routes[1].link_seqs.len() == 2);
        let (short, truncated) = enumerate_candidate_paths(&req, &links, 2);
        assert!(truncated);
        assert_eq!(short.len(), 2);
    }

    /// agent 节点引用：唯一 name 解析、不存在/重名/平行链路各自结构化报错。
    #[test]
    fn route_from_node_refs_resolution() {
        let mut nodes: Vec<_> = ["0", "1", "2"].iter().map(|m| node(m)).collect();
        nodes[2].name = Some("SW-mid".to_string());
        let links = vec![link(0, "0", 0, "2", 0, None), link(1, "2", 1, "1", 0, None)];
        // name 混用 mid。
        let refs = vec!["0".to_string(), "SW-mid".to_string(), "1".to_string()];
        let r = route_from_node_refs(&refs, "0", "1", &nodes, &links).unwrap();
        assert_eq!(r.link_seqs, vec![0, 1]);
        // 不存在。
        let bad = vec!["0".to_string(), "ghost".to_string(), "1".to_string()];
        assert_eq!(
            route_from_node_refs(&bad, "0", "1", &nodes, &links).unwrap_err()[0].code,
            "NODE_NOT_FOUND"
        );
        // 重名。
        let mut dup_nodes = nodes.clone();
        dup_nodes[0].name = Some("SW-mid".to_string());
        assert_eq!(
            route_from_node_refs(&refs, "0", "1", &dup_nodes, &links).unwrap_err()[0].code,
            "NODE_NAME_AMBIGUOUS"
        );
        // 平行链路歧义。
        let mut para = links.clone();
        para.push(link(9, "0", 5, "2", 5, None));
        assert_eq!(
            route_from_node_refs(&refs, "0", "1", &nodes, &para).unwrap_err()[0].code,
            "PARALLEL_LINKS_AMBIGUOUS"
        );
    }
}
