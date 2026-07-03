//! 流量录入结构校验闸（KTD6）。任何写入路径（本期 agent MCP，后续面板/路由回填）
//! 都先过 `verify_flow`，返回 `Vec<VerifyError>`（空=通过）。断言**结构字段本身**
//! （class/pcp/period/frame/talker/listener），非 JSON blob——对齐历史坑
//! `link-add-skips-port-columns`（单一插入助手 + 结构列校验）。
//!
//! `VerifyError` 形状复刻 `topology_verify`/`timesync_verify`（同字段 code/message_zh/
//! node_ref），消费链一致。本模块纯校验、不写库；落库归 `flow_sidecar_routes::insert_stream`。

use serde::Serialize;
use sqlx::{Pool, Row, Sqlite};

use crate::flow_route::{derive_redundant_routes, link_plane};
use crate::topology_verify::{VerifyLink, VerifyNode};

/// 门控周期（gateCycleDuration）默认 1ms=1000us（对齐 U1 spike 宿主机 Z3 配置器默认）。
/// 流周期须整除它，TAS 排程才能干净重复（R6）。
pub const GATE_CYCLE_US: i64 = 1000;

/// 链路 MTU（标准以太网 payload 上限，单位 byte）。报文不得超过它。
pub const LINK_MTU_BYTES: i64 = 1500;

/// 合法流量类别（R3 class 判别器）：ST 时间敏感 / BE 尽力而为 / RC 冗余（802.1CB 预留）。
pub const FLOW_CLASSES: &[&str] = &["ST", "BE", "RC"];

/// ST 流固定 PCP（同时即门号 gate_index，pcp→gate 恒等映射）。KTD4 pin 过滤的单一源。
pub(crate) const ST_PCP: i64 = 7;

/// class↔pcp 固定映射（R1）：ST=7 / RC=6 / BE=0；非法 class 返回 None（由 INVALID_CLASS 兜）。
/// 录入闸与 verify_tas 入口重校验（G1.3）共用。
pub(crate) fn expected_pcp(class: &str) -> Option<i64> {
    match class {
        "ST" => Some(ST_PCP),
        "RC" => Some(6),
        "BE" => Some(0),
        _ => None,
    }
}

/// 单条结构问题：code 给程序判别、message_zh 给用户直接看、node_ref 指向出问题的
/// 节点/字段（与 topology_verify::VerifyError 同字段名）。
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

/// 录入候选流：`verify_flow` 校验 + `insert_stream` 落库共用的入参契约（KTD6 单一写入路径）。
/// 五元组/max_latency/redundant/paths 是落库列，本期校验只覆盖承重结构字段。
#[derive(Debug, Clone)]
pub struct StreamInput {
    pub class: String,
    pub pcp: i64,
    pub period_us: i64,
    pub frame_bytes: i64,
    pub count: i64,
    pub talker: String,
    pub listener: String,
    pub src_ip: Option<String>,
    pub dst_ip: Option<String>,
    pub src_l4_port: Option<i64>,
    pub dst_l4_port: Option<i64>,
    pub l4_protocol: Option<String>,
    pub max_latency_us: Option<i64>,
    pub redundant: i64,
    pub paths: Option<String>,
}

/// 录入前校验：class/pcp/正值/周期整除门控周期/报文≤MTU/talker-listener 在拓扑/
/// pcp↔class 一致。返回全部违规（空=通过）。在 `insert_stream` 之前跑，拒绝并指出违规字段。
pub async fn verify_flow(
    pool: &Pool<Sqlite>,
    session_id: &str,
    s: &StreamInput,
) -> Result<Vec<VerifyError>, sqlx::Error> {
    let mut errors: Vec<VerifyError> = Vec::new();

    // 1. class 判别器合法。
    if !FLOW_CLASSES.contains(&s.class.as_str()) {
        errors.push(VerifyError::new(
            "INVALID_CLASS",
            format!("流量类别 {} 不合法，只能是 ST / BE / RC。", s.class),
            None,
        ));
    }

    // 2. pcp 取值域 0..=7（802.1Q 优先级）。
    if s.pcp < 0 || s.pcp > 7 {
        errors.push(VerifyError::new(
            "INVALID_PCP",
            format!("优先级 PCP={} 越界，合法范围 0–7。", s.pcp),
            None,
        ));
    }

    // 2b. class↔pcp 固定映射（R1）：ST=7 / RC=6 / BE=0，违规即拒。
    if let Some(expected) = expected_pcp(&s.class)
        && s.pcp != expected
    {
        errors.push(VerifyError::new(
            "PCP_CLASS_MISMATCH",
            format!(
                "{} 流的优先级固定为 PCP={expected}，不能用 PCP={}（映射 ST=7 / RC=6 / BE=0）。",
                s.class, s.pcp
            ),
            None,
        ));
    }

    // 3. 正值：周期 / 报文长度 / 报文数。
    if s.period_us <= 0 {
        errors.push(VerifyError::new(
            "INVALID_PERIOD",
            format!("发送周期 {}us 必须为正。", s.period_us),
            None,
        ));
    }
    if s.frame_bytes <= 0 {
        errors.push(VerifyError::new(
            "INVALID_FRAME",
            format!("报文长度 {} 字节必须为正。", s.frame_bytes),
            None,
        ));
    }
    if s.count <= 0 {
        errors.push(VerifyError::new(
            "INVALID_COUNT",
            format!("报文数 {} 必须为正。", s.count),
            None,
        ));
    }

    // 4. 周期须整除门控周期（否则 TAS 排程无法干净重复；仅在周期为正时判，避免除零）。
    if s.period_us > 0 && GATE_CYCLE_US % s.period_us != 0 {
        errors.push(VerifyError::new(
            "PERIOD_NOT_DIVISOR",
            format!(
                "发送周期 {}us 须整除门控周期 {GATE_CYCLE_US}us。",
                s.period_us
            ),
            None,
        ));
    }

    // 5. 报文不超过链路 MTU。
    if s.frame_bytes > LINK_MTU_BYTES {
        errors.push(VerifyError::new(
            "FRAME_TOO_LARGE",
            format!(
                "报文长度 {} 字节超过链路 MTU（{LINK_MTU_BYTES} 字节）。",
                s.frame_bytes
            ),
            None,
        ));
    }

    // 6. talker/listener 是拓扑里现存的节点（连通性——是否真有一条路径——在路由推导 U5
    //    响亮判定，此处只校验节点存在，避免在校验闸重复最短路）。
    let node_mids: std::collections::HashSet<String> =
        sqlx::query("SELECT mid FROM topology_nodes WHERE session_id = ?")
            .bind(session_id)
            .fetch_all(pool)
            .await?
            .iter()
            .map(|r| r.get::<String, _>("mid"))
            .collect();
    if !node_mids.contains(&s.talker) {
        errors.push(VerifyError::new(
            "TALKER_NOT_FOUND",
            format!("发送节点 {} 不在当前拓扑里。", s.talker),
            Some(s.talker.clone()),
        ));
    }
    if !node_mids.contains(&s.listener) {
        errors.push(VerifyError::new(
            "LISTENER_NOT_FOUND",
            format!("接收节点 {} 不在当前拓扑里。", s.listener),
            Some(s.listener.clone()),
        ));
    }

    // 7. pcp↔class 一致：同一 PCP 不能既承载 ST 又承载 BE——pcp 映射到唯一门（gateIndex），
    //    同 pcp 不同 class 会让门号事实源二义。仅当本条 class 合法时判（否则噪音）。
    //    per-端口细化（真同端口冲突）随路由 U5，此处取 session 级 pcp↔class 一致的安全超集。
    if FLOW_CLASSES.contains(&s.class.as_str()) {
        let conflict: Option<String> = sqlx::query(
            "SELECT class FROM topology_streams WHERE session_id = ? AND pcp = ? AND class <> ? LIMIT 1",
        )
        .bind(session_id)
        .bind(s.pcp)
        .bind(&s.class)
        .fetch_optional(pool)
        .await?
        .map(|r| r.get::<String, _>("class"));
        if let Some(other) = conflict {
            errors.push(VerifyError::new(
                "PCP_CLASS_CONFLICT",
                format!(
                    "PCP={} 已被 {other} 流占用，不能再给 {} 流用（同 PCP 须同类别）。",
                    s.pcp, s.class
                ),
                None,
            ));
        }
    }

    // 8. RC 双平面前置 + A/B 路径可推导（R2/AE3）。仅当 talker/listener 都在拓扑时跑，
    //    避免与第 6 步重复报节点缺失。
    if s.class == "RC" && node_mids.contains(&s.talker) && node_mids.contains(&s.listener) {
        if let Err(mut es) = derive_rc_paths(pool, session_id, &s.talker, &s.listener).await? {
            errors.append(&mut es);
        }
    }

    Ok(errors)
}

/// RC 双平面路径推导（R2）：`verify_flow` 的 RC 分支与 `add_stream` 落库前共用。
/// 外层 `Err` = 数据库故障；内层 `Ok` 是 `paths` 列 JSON 契约
/// `{"a":{"node_path":[...],"link_seqs":[...]},"b":{...}}`（node id 为库内 mid），
/// 内层 `Err` = 校验违规。先判拓扑是否双平面——链路集里没有任何带 plane 键的链路即
/// `NOT_DUAL_PLANE` 响亮说明「需要双平面」，不掉进「平面 A 不可达」的误导报错（AE3）；
/// 双平面才跑 `derive_redundant_routes`（不可达/多路径/路径相交均在录入时拒绝）。
pub async fn derive_rc_paths(
    pool: &Pool<Sqlite>,
    session_id: &str,
    talker: &str,
    listener: &str,
) -> Result<Result<String, Vec<VerifyError>>, sqlx::Error> {
    let (nodes, links) = load_route_topology(pool, session_id).await?;
    if !links.iter().any(|l| link_plane(l).is_some()) {
        return Ok(Err(vec![VerifyError::new(
            "NOT_DUAL_PLANE",
            "当前拓扑非双平面，RC 流需要双平面冗余路径。".to_string(),
            None,
        )]));
    }
    match derive_redundant_routes(talker, listener, &nodes, &links) {
        Ok((a, b)) => Ok(Ok(serde_json::json!({
            "a": { "node_path": a.node_path, "link_seqs": a.link_seqs },
            "b": { "node_path": b.node_path, "link_seqs": b.link_seqs },
        })
        .to_string())),
        Err(errs) => Ok(Err(errs
            .into_iter()
            .map(|e| map_route_error(e, talker, listener))
            .collect())),
    }
}

/// 路由层错误 → 录入闸用户语言。双平面前置判断之后 `NO_ROUTE` 只剩一种成因——
/// 节点只挂了单平面（某平面子图里不可达），按「未接入双平面」改写文案；其余码原样透传。
fn map_route_error(
    e: crate::topology_verify::VerifyError,
    talker: &str,
    listener: &str,
) -> VerifyError {
    if e.code == "NO_ROUTE" {
        return VerifyError::new(
            "NO_ROUTE",
            format!(
                "从 {talker} 到 {listener} 有平面不可达：节点未接入双平面（RC 流要求发送/接收节点同时接入平面 A 与 B）。"
            ),
            e.node_ref,
        );
    }
    VerifyError::new(&e.code, e.message_zh, e.node_ref)
}

/// 读路由推导所需拓扑结构列 → `VerifyNode`/`VerifyLink`（与 `inet_sim_command::load_topology`
/// 同口径；此处独立查询以保持本模块 `sqlx::Error` 错误类型）。
async fn load_route_topology(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<(Vec<VerifyNode>, Vec<VerifyLink>), sqlx::Error> {
    let nodes = sqlx::query(
        "SELECT mid, name, node_type, queue_count FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r| VerifyNode {
        mid: r.get("mid"),
        name: r.get("name"),
        node_type: r.get("node_type"),
        queue_count: r.get("queue_count"),
    })
    .collect();
    let links = sqlx::query(
        "SELECT link_seq, src_node, dst_node, src_port, dst_port, speed, styles_json FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r| VerifyLink {
        link_seq: r.get("link_seq"),
        src_node: r.get("src_node"),
        dst_node: r.get("dst_node"),
        src_port: r.get("src_port"),
        dst_port: r.get("dst_port"),
        speed: r.get("speed"),
        styles_json: r.get("styles_json"),
    })
    .collect();
    Ok((nodes, links))
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
        // safety-net 现含 flow 两表（session-scoped，与 timesync 同口径）。
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

    async fn add_node(pool: &Pool<Sqlite>, mid: &str) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, 0)",
        )
        .bind(mid)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 插入链路（plane=None 为单平面链路；Some 写 styles_json.plane，双平面 fixture 用）。
    async fn add_link(
        pool: &Pool<Sqlite>,
        seq: i64,
        src: &str,
        sp: i64,
        dst: &str,
        dp: i64,
        plane: Option<&str>,
    ) {
        let styles = match plane {
            Some(p) => format!(r#"{{"plane":"{p}"}}"#),
            None => "{}".to_string(),
        };
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, ?)",
        )
        .bind(seq)
        .bind(src)
        .bind(dst)
        .bind(sp)
        .bind(dp)
        .bind(styles)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 双平面 fixture：0→1 经平面 A（0-2-1，seq 0/1）与平面 B（0-3-1，seq 2/3）。
    async fn seed_dual_plane(pool: &Pool<Sqlite>) {
        for mid in ["0", "1", "2", "3"] {
            add_node(pool, mid).await;
        }
        add_link(pool, 0, "0", 0, "2", 0, Some("A")).await;
        add_link(pool, 1, "2", 1, "1", 0, Some("A")).await;
        add_link(pool, 2, "0", 1, "3", 0, Some("B")).await;
        add_link(pool, 3, "3", 1, "1", 1, Some("B")).await;
    }

    async fn insert_existing_stream(pool: &Pool<Sqlite>, seq: i64, class: &str, pcp: i64) {
        sqlx::query(
            "INSERT INTO topology_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) \
             VALUES ('s1', ?, ?, ?, 500, 512, 100, '0', '1')",
        )
        .bind(seq)
        .bind(class)
        .bind(pcp)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 构造合法 ST 流（talker=0, listener=1, pcp=7, 周期 500us 整除 1000us, 512B）。
    fn st(pcp: i64) -> StreamInput {
        StreamInput {
            class: "ST".to_string(),
            pcp,
            period_us: 500,
            frame_bytes: 512,
            count: 10000,
            talker: "0".to_string(),
            listener: "1".to_string(),
            src_ip: None,
            dst_ip: None,
            src_l4_port: None,
            dst_l4_port: None,
            l4_protocol: None,
            max_latency_us: None,
            redundant: 0,
            paths: None,
        }
    }

    fn codes(errs: &[VerifyError]) -> Vec<&str> {
        errs.iter().map(|e| e.code.as_str()).collect()
    }

    /// 合法 ST 流 → 无违规。
    #[tokio::test]
    async fn valid_stream_passes() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        let errs = verify_flow(&pool, "s1", &st(7)).await.unwrap();
        assert!(errs.is_empty(), "应无违规: {:?}", codes(&errs));
    }

    /// AE1：周期 700us、门控周期 1ms（700∤1000）→ PERIOD_NOT_DIVISOR。
    #[tokio::test]
    async fn period_not_dividing_gate_cycle_rejected() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        let mut s = st(7);
        s.period_us = 700;
        let errs = verify_flow(&pool, "s1", &s).await.unwrap();
        assert!(
            codes(&errs).contains(&"PERIOD_NOT_DIVISOR"),
            "{:?}",
            codes(&errs)
        );
    }

    /// 报文 > 链路 MTU → FRAME_TOO_LARGE。
    #[tokio::test]
    async fn frame_over_mtu_rejected() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        let mut s = st(7);
        s.frame_bytes = 2000;
        let errs = verify_flow(&pool, "s1", &s).await.unwrap();
        assert!(
            codes(&errs).contains(&"FRAME_TOO_LARGE"),
            "{:?}",
            codes(&errs)
        );
    }

    /// talker 不在拓扑 → TALKER_NOT_FOUND（node_ref 指向缺失节点）。
    #[tokio::test]
    async fn talker_not_in_topology_rejected() {
        let pool = fresh_pool().await;
        add_node(&pool, "1").await; // 只加 listener，不加 talker "0"
        let errs = verify_flow(&pool, "s1", &st(7)).await.unwrap();
        assert!(
            codes(&errs).contains(&"TALKER_NOT_FOUND"),
            "{:?}",
            codes(&errs)
        );
        assert!(
            errs.iter()
                .any(|e| e.code == "TALKER_NOT_FOUND" && e.node_ref.as_deref() == Some("0"))
        );
    }

    /// pcp 越界 / 非法 class 各自违规。
    #[tokio::test]
    async fn out_of_range_pcp_and_class_rejected() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        let mut s = st(9); // pcp 越界
        s.class = "XX".to_string(); // class 非法
        let errs = verify_flow(&pool, "s1", &s).await.unwrap();
        assert!(codes(&errs).contains(&"INVALID_PCP"), "{:?}", codes(&errs));
        assert!(
            codes(&errs).contains(&"INVALID_CLASS"),
            "{:?}",
            codes(&errs)
        );
    }

    /// R1/②：class↔pcp 固定映射，ST@pcp5 / BE@pcp3 → PCP_CLASS_MISMATCH。
    #[tokio::test]
    async fn wrong_pcp_for_class_rejected_mismatch() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        let errs = verify_flow(&pool, "s1", &st(5)).await.unwrap();
        assert!(
            codes(&errs).contains(&"PCP_CLASS_MISMATCH"),
            "{:?}",
            codes(&errs)
        );
        let mut be = st(3);
        be.class = "BE".to_string();
        let errs = verify_flow(&pool, "s1", &be).await.unwrap();
        assert!(
            codes(&errs).contains(&"PCP_CLASS_MISMATCH"),
            "{:?}",
            codes(&errs)
        );
    }

    /// R1/R2：双平面拓扑上 RC@pcp6 过闸（A/B 路径可推导且不相交）。
    #[tokio::test]
    async fn rc_at_pcp6_on_dual_plane_passes() {
        let pool = fresh_pool().await;
        seed_dual_plane(&pool).await;
        let mut rc = st(6);
        rc.class = "RC".to_string();
        let errs = verify_flow(&pool, "s1", &rc).await.unwrap();
        assert!(errs.is_empty(), "应无违规: {:?}", codes(&errs));
    }

    /// Covers AE3. 线性拓扑（链路无 plane 键）录 RC → NOT_DUAL_PLANE 响亮说明需双平面，
    /// 不得掉进「平面 A 不可达」（NO_ROUTE）的误导报错。
    #[tokio::test]
    async fn rc_on_non_dual_plane_topology_rejected_not_dual_plane() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        add_link(&pool, 0, "0", 0, "1", 0, None).await;
        let mut rc = st(6);
        rc.class = "RC".to_string();
        let errs = verify_flow(&pool, "s1", &rc).await.unwrap();
        assert!(
            codes(&errs).contains(&"NOT_DUAL_PLANE"),
            "{:?}",
            codes(&errs)
        );
        assert!(!codes(&errs).contains(&"NO_ROUTE"), "{:?}", codes(&errs));
        let msg = &errs
            .iter()
            .find(|e| e.code == "NOT_DUAL_PLANE")
            .unwrap()
            .message_zh;
        assert!(msg.contains("非双平面"), "{msg}");
        assert!(!msg.contains("平面 A"), "不得误导为平面不可达: {msg}");
    }

    /// R2/⑤：talker 只挂平面 A（平面 B 上不可达）→ NO_ROUTE 文案映射为「未接入双平面」。
    #[tokio::test]
    async fn rc_talker_on_single_plane_reports_not_attached_dual_plane() {
        let pool = fresh_pool().await;
        for mid in ["0", "1", "2", "3"] {
            add_node(&pool, mid).await;
        }
        // 平面 A：0-2-1；平面 B 只有 3-1（talker 0 未接入平面 B）。
        add_link(&pool, 0, "0", 0, "2", 0, Some("A")).await;
        add_link(&pool, 1, "2", 1, "1", 0, Some("A")).await;
        add_link(&pool, 2, "3", 1, "1", 1, Some("B")).await;
        let mut rc = st(6);
        rc.class = "RC".to_string();
        let errs = verify_flow(&pool, "s1", &rc).await.unwrap();
        let no_route = errs.iter().find(|e| e.code == "NO_ROUTE");
        assert!(no_route.is_some(), "{:?}", codes(&errs));
        assert!(
            no_route.unwrap().message_zh.contains("未接入双平面"),
            "{}",
            no_route.unwrap().message_zh
        );
    }

    /// 同端口 ST(pcp7) 与 BE(pcp0) 不同 pcp → 无 PCP_CLASS_CONFLICT。
    #[tokio::test]
    async fn st_pcp7_and_be_pcp0_no_conflict() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        insert_existing_stream(&pool, 0, "ST", 7).await;
        let mut be = st(0);
        be.class = "BE".to_string();
        let errs = verify_flow(&pool, "s1", &be).await.unwrap();
        assert!(
            !codes(&errs).contains(&"PCP_CLASS_CONFLICT"),
            "不同 pcp 不应冲突: {:?}",
            codes(&errs)
        );
    }

    /// 同 pcp 不同 class（已存 ST pcp7，再录 BE pcp7）→ PCP_CLASS_CONFLICT。
    #[tokio::test]
    async fn same_pcp_different_class_conflicts() {
        let pool = fresh_pool().await;
        add_node(&pool, "0").await;
        add_node(&pool, "1").await;
        insert_existing_stream(&pool, 0, "ST", 7).await;
        let mut be = st(7);
        be.class = "BE".to_string();
        let errs = verify_flow(&pool, "s1", &be).await.unwrap();
        assert!(
            codes(&errs).contains(&"PCP_CLASS_CONFLICT"),
            "同 pcp 不同 class 应冲突: {:?}",
            codes(&errs)
        );
    }
}
