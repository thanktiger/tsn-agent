//! 流量录入结构校验闸（KTD6）。任何写入路径（本期 agent MCP，后续面板/路由回填）
//! 都先过 `verify_flow`，返回 `Vec<VerifyError>`（空=通过）。断言**结构字段本身**
//! （class/pcp/period/frame/talker/listener），非 JSON blob——对齐历史坑
//! `link-add-skips-port-columns`（单一插入助手 + 结构列校验）。
//!
//! `VerifyError` 形状复刻 `topology_verify`/`timesync_verify`（同字段 code/message_zh/
//! node_ref），消费链一致。本模块纯校验、不写库；落库归 `flow_sidecar_routes::insert_stream`。

use serde::Serialize;
use sqlx::{Pool, Row, Sqlite};

/// 门控周期（gateCycleDuration）默认 1ms=1000us（对齐 U1 spike 宿主机 Z3 配置器默认）。
/// 流周期须整除它，TAS 排程才能干净重复（R6）。
pub const GATE_CYCLE_US: i64 = 1000;

/// 链路 MTU（标准以太网 payload 上限，单位 byte）。报文不得超过它。
pub const LINK_MTU_BYTES: i64 = 1500;

/// 合法流量类别（R3 class 判别器）：ST 时间敏感 / BE 尽力而为 / RC 冗余（802.1CB 预留）。
pub const FLOW_CLASSES: &[&str] = &["ST", "BE", "RC"];

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

    Ok(errors)
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
