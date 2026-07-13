//! `get_flow_plan`（U1，面板重设计）：只读门控表明细查询。
//!
//! 对齐 `topology_query_command`/`timesync_query_command` 的读写分离惯例——`plan_tas` 综合写库
//! 归 `flow_plan_command`，只读明细查询在此。直接 sqlx in-process 读 main pool（不走 sidecar）。
//!
//! 取 `flow_plans` **仅 ST-pcp 门（gate7）**（与 verify pin 的 G2.4 过滤同源，`flow_verify::ST_PCP`
//! 单一源——legacy gate0/gate6 残留行不进图/表/solver）+ `topology_nodes.name` 显示名映射 +
//! 流集类别计数。前端三态（KTD1）全由此数据推导：entries 非空 → 已规划；entries 空且
//! stCount==0 且流集非空 → 无需门控；否则 → 未规划。

use serde::Serialize;
use sqlx::Row;

/// 门控表单条目（前端时序图/明细表消费）。`node`=mid、`node_name`=显示名（缺名回退 mid）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowPlanEntry {
    pub node: String,
    pub node_name: String,
    pub eth_n: i64,
    pub gate_index: i64,
    pub initially_open: bool,
    pub offset_ns: i64,
    pub durations_ns: Vec<u64>,
}

/// 门控表明细（KTD1）：entries + 门周期 + 求解器出处 + 流集类别计数。前端三态全由此推导：
/// entries 非空 → 已规划；entries 空且 stCount==0 且流集非空 → 无需门控；否则 → 未规划。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowPlanDetail {
    pub cycle_ns: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver: Option<String>,
    pub st_count: i64,
    pub rc_count: i64,
    pub be_count: i64,
    pub entries: Vec<FlowPlanEntry>,
}

/// 只读查询内核：flow_plans 的 ST-pcp 门行 + topology_nodes.name 显示名映射 + 类别计数。
pub async fn get_flow_plan_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<FlowPlanDetail, String> {
    let (mut st_count, mut rc_count, mut be_count) = (0i64, 0i64, 0i64);
    let count_rows = sqlx::query(
        "SELECT class, COUNT(*) AS n FROM flow_streams WHERE session_id = ? GROUP BY class",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_streams 计数失败：{e}"))?;
    for r in &count_rows {
        let class: String = r.get("class");
        let n: i64 = r.get("n");
        match class.as_str() {
            "ST" => st_count = n,
            "RC" => rc_count = n,
            "BE" => be_count = n,
            _ => {}
        }
    }

    // G2.4/KTD4：只取 ST-pcp 门（gate7），与 verify pin 过滤同源（`flow_verify::ST_PCP`）——
    // 存量 gate0/gate6 旧全类条目忽略，不进图/表/solver。
    let rows = sqlx::query(
        "SELECT p.node, n.name AS node_name, p.eth_n, p.gate_index, p.initially_open, p.offset_ns, p.durations_ns, p.solver \
         FROM flow_plans p \
         LEFT JOIN topology_nodes n ON n.session_id = p.session_id AND n.mid = p.node \
         WHERE p.session_id = ? AND p.gate_index = ? ORDER BY p.node, p.eth_n, p.gate_index",
    )
    .bind(session_id)
    .bind(crate::flow_verify::ST_PCP)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_plans 失败：{e}"))?;

    // 求解器出处：任取一行即可（同一 plan 全行同 solver）。
    let solver: Option<String> = rows.first().map(|r| r.get::<String, _>("solver"));
    // durations_ns 本读面解析成 Vec<u64>（时序图/占空比要算）；另一读面 flow_sidecar_routes
    // inspect 回原始 JSON 字符串（agent 只读透传，不算）——两面类型分叉，消费端不同，勿强行统一。
    // JSON 解析失败跳行（不臆造恒开门；损坏行不进图/表/solver）。
    let entries = rows
        .iter()
        .filter_map(|r| {
            let durs: String = r.get("durations_ns");
            let durations_ns: Vec<u64> = serde_json::from_str(&durs).ok()?;
            let node: String = r.get("node");
            let name: Option<String> = r.get("node_name");
            Some(FlowPlanEntry {
                node_name: name
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| node.clone()),
                node,
                eth_n: r.get("eth_n"),
                gate_index: r.get("gate_index"),
                initially_open: r.get::<i64, _>("initially_open") != 0,
                offset_ns: r.get("offset_ns"),
                durations_ns,
            })
        })
        .collect();

    Ok(FlowPlanDetail {
        cycle_ns: crate::inet_sim_bundle::GATE_CYCLE_NS,
        solver,
        st_count,
        rc_count,
        be_count,
        entries,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowPlanRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn get_flow_plan(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: GetFlowPlanRequest,
) -> Result<FlowPlanDetail, String> {
    let pool = store.pool(&app).await?;
    get_flow_plan_inner(pool, &request.session_id).await
}

// ── update_flow_stream（U7）──────────────────────────────────────────────────

/// 流更新请求：session_id + stream_seq（不可变身份键）+ 可变字段（无 class/pcp，
/// 由 DB 读出后合进 StreamInput，保持 class↔pcp 固定映射不变）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFlowStreamRequest {
    pub session_id: String,
    pub stream_seq: i64,
    pub period_us: i64,
    pub frame_bytes: i64,
    pub count: i64,
    pub max_latency_us: Option<i64>,
    pub src_mac: Option<String>,
    pub dst_mac: Option<String>,
    pub vlan_id: Option<i64>,
    pub earliest_send_offset_ns: Option<i64>,
    pub latest_send_offset_ns: Option<i64>,
}

/// 写前验证 + 快照 + UPDATE 内核（可注入 pool 供单测）。
pub async fn update_flow_stream_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    req: &UpdateFlowStreamRequest,
) -> Result<(), String> {
    // 1. 读不可变字段（class/pcp 决定 verify_flow 路径，talker/listener 决定节点存在性检查）。
    let row = sqlx::query(
        "SELECT class, pcp, talker, listener, src_ip, dst_ip, src_l4_port, dst_l4_port, \
         l4_protocol, redundant, paths FROM flow_streams WHERE session_id = ? AND stream_seq = ?",
    )
    .bind(&req.session_id)
    .bind(req.stream_seq)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("读 flow_streams 失败：{e}"))?
    .ok_or_else(|| format!("stream_seq={} 不存在", req.stream_seq))?;

    // 2. 合入请求可变字段构造 StreamInput。
    let stream_input = crate::flow_verify::StreamInput {
        class: row.get("class"),
        pcp: row.get("pcp"),
        period_us: req.period_us,
        frame_bytes: req.frame_bytes,
        count: req.count,
        talker: row.get("talker"),
        listener: row.get("listener"),
        src_ip: row.get("src_ip"),
        dst_ip: row.get("dst_ip"),
        src_l4_port: row.get("src_l4_port"),
        dst_l4_port: row.get("dst_l4_port"),
        l4_protocol: row.get("l4_protocol"),
        max_latency_us: req.max_latency_us,
        redundant: row.get("redundant"),
        paths: row.get("paths"),
    };

    // 3. 结构校验（class/pcp 不变，重跑以防节点已删或周期越界）。
    let errors = crate::flow_verify::verify_flow(pool, &req.session_id, &stream_input)
        .await
        .map_err(|e| format!("校验失败：{e}"))?;
    if !errors.is_empty() {
        let msgs: Vec<String> = errors.iter().map(|e| e.message_zh.clone()).collect();
        return Err(format!("流量校验不通过：{}", msgs.join("；")));
    }

    // 4. 开事务。
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开事务失败：{e}"))?;

    // 5. 写前快照（flow domain，撤销留位）。
    crate::topology_undo::snapshot_pre_image(
        &mut tx,
        &req.session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    .map_err(|e| format!("快照失败：{e}"))?;

    // 6. 全列 UPDATE（含可空列）。
    let result = sqlx::query(
        "UPDATE flow_streams SET period_us=?, frame_bytes=?, count=?, max_latency_us=?, \
         src_mac=?, dst_mac=?, vlan_id=?, earliest_send_offset_ns=?, latest_send_offset_ns=? \
         WHERE session_id=? AND stream_seq=?",
    )
    .bind(req.period_us)
    .bind(req.frame_bytes)
    .bind(req.count)
    .bind(req.max_latency_us)
    .bind(&req.src_mac)
    .bind(&req.dst_mac)
    .bind(req.vlan_id)
    .bind(req.earliest_send_offset_ns)
    .bind(req.latest_send_offset_ns)
    .bind(&req.session_id)
    .bind(req.stream_seq)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新 flow_streams 失败：{e}"))?;

    // 7. 并发竞态守卫（SELECT 后到 UPDATE 前被删）。
    if result.rows_affected() == 0 {
        return Err(format!("stream_seq={} 不存在", req.stream_seq));
    }

    // 8. 提交。
    tx.commit()
        .await
        .map_err(|e| format!("提交失败：{e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn update_flow_stream(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: UpdateFlowStreamRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    update_flow_stream_inner(pool, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
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
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','n','n','{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    async fn seed_linear(pool: &sqlx::Pool<sqlx::Sqlite>) {
        // es1(1) — sw1(0) — es2(2)。GM=1。
        for (mid, ty, ord) in [
            ("0", "switch", 0),
            ("1", "endSystem", 1),
            ("2", "endSystem", 2),
        ] {
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                .bind(mid).bind(ty).bind(ord).execute(pool).await.unwrap();
        }
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 0, NULL, '1', '0', 0, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', 1, NULL, '0', '2', 1, 0, 1000, '{}')")
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '1')")
            .execute(pool)
            .await
            .unwrap();
        for mid in ["0", "1", "2"] {
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', ?, '[]', '[]')")
                .bind(mid).execute(pool).await.unwrap();
        }
    }

    async fn add_stream(pool: &sqlx::Pool<sqlx::Sqlite>, seq: i64, class: &str, pcp: i64) {
        sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', ?, ?, ?, 500, 512, 10000, '1', '2')")
            .bind(seq).bind(class).bind(pcp).execute(pool).await.unwrap();
    }

    /// 直插一条 flow_plans 门条目（gate_index 可控，用于门过滤/损坏行测试）。
    async fn add_plan(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        node: &str,
        eth_n: i64,
        gate_index: i64,
        durs: &str,
    ) {
        sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, ?, ?, ?, 1, 0, ?, 'Z3')")
            .bind(node).bind(eth_n).bind(gate_index).bind(durs)
            .execute(pool).await.unwrap();
    }

    /// U1①：有 GCL 会话 → 返回全行 + 显示名映射（有名用名/缺名回退 mid）+ 类别计数 + 周期。
    #[test]
    fn get_flow_plan_returns_entries_names_and_counts() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            // 给 sw1(mid 0) 起显示名；es 节点保持 NULL（回退 mid）。
            sqlx::query(
                "UPDATE topology_nodes SET name='核心交换机' WHERE session_id='s1' AND mid='0'",
            )
            .execute(&pool)
            .await
            .unwrap();
            add_stream(&pool, 0, "ST", 7).await;
            add_stream(&pool, 1, "BE", 0).await;
            add_plan(&pool, "0", 1, 7, "[4560,995440]").await;
            add_plan(&pool, "2", 0, 7, "[300000,700000]").await;
            let d = get_flow_plan_inner(&pool, "s1").await.unwrap();
            assert_eq!(d.cycle_ns, 1_000_000);
            assert_eq!(d.solver.as_deref(), Some("Z3"));
            assert_eq!((d.st_count, d.rc_count, d.be_count), (1, 0, 1));
            assert_eq!(d.entries.len(), 2);
            let g0 = &d.entries[0];
            assert_eq!(g0.node, "0");
            assert_eq!(g0.node_name, "核心交换机");
            assert_eq!(g0.eth_n, 1);
            assert_eq!(g0.gate_index, 7);
            assert!(g0.initially_open);
            assert_eq!(g0.offset_ns, 0);
            assert_eq!(g0.durations_ns, vec![4_560, 995_440]);
            // 缺名节点回退 mid。
            assert_eq!(d.entries[1].node_name, "2");
        });
    }

    /// U1②：空表 + 纯 BE 流集 → entries=[] 且 beCount>0（前端蓝条「无需门控」判据）。
    #[test]
    fn get_flow_plan_empty_with_pure_be_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "BE", 0).await;
            let d = get_flow_plan_inner(&pool, "s1").await.unwrap();
            assert!(d.entries.is_empty());
            assert_eq!(d.st_count, 0);
            assert_eq!(d.be_count, 1);
            assert!(d.solver.is_none());
        });
    }

    /// U1③：空表 + 有 ST 流 → entries=[] 且 stCount>0（前端未规划 CTA 判据）。
    #[test]
    fn get_flow_plan_empty_with_st_streams_means_unplanned() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let d = get_flow_plan_inner(&pool, "s1").await.unwrap();
            assert!(d.entries.is_empty());
            assert_eq!(d.st_count, 1);
        });
    }

    /// 读侧门过滤（与 verify pin G2.4 同源）：混门 flow_plans（gate0/gate6/gate7）→ 仅 gate7
    /// 返回，legacy 全类残留行不进图/表/solver。
    #[test]
    fn get_flow_plan_filters_non_st_gate_rows() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_plan(&pool, "0", 1, 0, "[500000,500000]").await; // legacy gate0
            add_plan(&pool, "0", 1, 6, "[400000,600000]").await; // legacy gate6
            add_plan(&pool, "0", 1, 7, "[300000,700000]").await; // ST gate7
            let d = get_flow_plan_inner(&pool, "s1").await.unwrap();
            assert_eq!(d.entries.len(), 1, "只应返回 gate7：{:?}", d.entries);
            assert_eq!(d.entries[0].gate_index, 7);
            assert_eq!(d.entries[0].durations_ns, vec![300_000, 700_000]);
        });
    }

    /// durations_ns JSON 解析失败跳行（不臆造恒开门）：损坏行不返回，有效 gate7 行照常返回。
    #[test]
    fn get_flow_plan_skips_rows_with_corrupt_durations() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_plan(&pool, "0", 1, 7, "not-json").await; // 损坏行 → 跳过
            add_plan(&pool, "2", 0, 7, "[300000,700000]").await; // 有效行
            let d = get_flow_plan_inner(&pool, "s1").await.unwrap();
            assert_eq!(
                d.entries.len(),
                1,
                "损坏 durations 行应跳过：{:?}",
                d.entries
            );
            assert_eq!(d.entries[0].node, "2");
            assert_eq!(d.entries[0].durations_ns, vec![300_000, 700_000]);
        });
    }

    /// U1④：serde camelCase 契约（前端 DTO 镜像依赖字段名）。
    #[test]
    fn flow_plan_detail_serializes_camel_case() {
        let detail = FlowPlanDetail {
            cycle_ns: 1_000_000,
            solver: Some("Z3".into()),
            st_count: 1,
            rc_count: 0,
            be_count: 2,
            entries: vec![FlowPlanEntry {
                node: "0".into(),
                node_name: "sw1".into(),
                eth_n: 1,
                gate_index: 7,
                initially_open: true,
                offset_ns: 29_470,
                durations_ns: vec![4_560, 995_440],
            }],
        };
        let v = serde_json::to_value(&detail).unwrap();
        assert_eq!(v["cycleNs"], 1_000_000);
        assert_eq!(v["stCount"], 1);
        assert_eq!(v["rcCount"], 0);
        assert_eq!(v["beCount"], 2);
        let e = &v["entries"][0];
        assert_eq!(e["nodeName"], "sw1");
        assert_eq!(e["ethN"], 1);
        assert_eq!(e["gateIndex"], 7);
        assert_eq!(e["initiallyOpen"], true);
        assert_eq!(e["offsetNs"], 29_470);
        assert_eq!(e["durationsNs"][0], 4_560);
    }

    // ── update_flow_stream 测试 ──────────────────────────────────────────────

    /// 基础合法请求（period=500us 整除 1000us，frame=512B ≤ MTU，count=10000）。
    fn make_update_req() -> UpdateFlowStreamRequest {
        UpdateFlowStreamRequest {
            session_id: "s1".to_string(),
            stream_seq: 0,
            period_us: 500,
            frame_bytes: 512,
            count: 10000,
            max_latency_us: None,
            src_mac: None,
            dst_mac: None,
            vlan_id: None,
            earliest_send_offset_ns: None,
            latest_send_offset_ns: None,
        }
    }

    /// U7①：合法更新 → 全可变列写入 DB。
    #[test]
    fn update_flow_stream_updates_fields() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let req = UpdateFlowStreamRequest {
                period_us: 250,
                frame_bytes: 256,
                count: 5000,
                max_latency_us: Some(800),
                src_mac: Some("00:11:22:33:44:55".to_string()),
                dst_mac: Some("aa:bb:cc:dd:ee:ff".to_string()),
                vlan_id: Some(10),
                earliest_send_offset_ns: Some(1000),
                latest_send_offset_ns: Some(2000),
                ..make_update_req()
            };
            update_flow_stream_inner(&pool, &req).await.unwrap();
            let row = sqlx::query(
                "SELECT period_us, frame_bytes, count, max_latency_us, src_mac, dst_mac, \
                 vlan_id, earliest_send_offset_ns, latest_send_offset_ns \
                 FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.get::<i64, _>("period_us"), 250);
            assert_eq!(row.get::<i64, _>("frame_bytes"), 256);
            assert_eq!(row.get::<i64, _>("count"), 5000);
            assert_eq!(row.get::<Option<i64>, _>("max_latency_us"), Some(800));
            assert_eq!(
                row.get::<Option<String>, _>("src_mac").as_deref(),
                Some("00:11:22:33:44:55")
            );
            assert_eq!(
                row.get::<Option<String>, _>("dst_mac").as_deref(),
                Some("aa:bb:cc:dd:ee:ff")
            );
            assert_eq!(row.get::<Option<i64>, _>("vlan_id"), Some(10));
            assert_eq!(
                row.get::<Option<i64>, _>("earliest_send_offset_ns"),
                Some(1000)
            );
            assert_eq!(
                row.get::<Option<i64>, _>("latest_send_offset_ns"),
                Some(2000)
            );
        });
    }

    /// U7②：period_us=0 → verify_flow 返回 INVALID_PERIOD → Err，DB 不写。
    #[test]
    fn update_flow_stream_invalid_period_rejected() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let req = UpdateFlowStreamRequest {
                period_us: 0,
                ..make_update_req()
            };
            let err = update_flow_stream_inner(&pool, &req).await.unwrap_err();
            assert!(err.contains("校验不通过"), "应含校验不通过：{err}");
            // DB 原值保持 500us。
            let period: i64 = sqlx::query_scalar(
                "SELECT period_us FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(period, 500, "DB 不应被改动");
        });
    }

    /// U7③：stream_seq 不存在 → SELECT 提前返回 Err。
    #[test]
    fn update_flow_stream_stream_not_found() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            let req = UpdateFlowStreamRequest {
                stream_seq: 99,
                ..make_update_req()
            };
            let err = update_flow_stream_inner(&pool, &req).await.unwrap_err();
            assert!(
                err.contains("不存在") || err.contains("99"),
                "应报不存在：{err}"
            );
        });
    }

    /// U7④：可空列 max_latency_us/src_mac 均 None → DB 写 NULL（覆盖原有非空值）。
    #[test]
    fn update_flow_stream_null_optional_cols() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            // 先插入带非空可选列的行。
            sqlx::query(
                "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, \
                 frame_bytes, count, talker, listener, max_latency_us, src_mac) \
                 VALUES ('s1', 0, 'ST', 7, 500, 512, 10000, '1', '2', 1000, 'aa:bb:cc:dd:ee:ff')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let req = make_update_req(); // max_latency_us=None, src_mac=None
            update_flow_stream_inner(&pool, &req).await.unwrap();
            let row = sqlx::query(
                "SELECT max_latency_us, src_mac FROM flow_streams \
                 WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(
                row.get::<Option<i64>, _>("max_latency_us").is_none(),
                "max_latency_us 应为 NULL"
            );
            assert!(
                row.get::<Option<String>, _>("src_mac").is_none(),
                "src_mac 应为 NULL"
            );
        });
    }

    /// U7⑤：成功更新后 topology_undo_snapshots 有 domain='flow' 快照（snapshot_pre_image 已调）。
    #[test]
    fn update_flow_stream_snapshot_created() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            update_flow_stream_inner(&pool, &make_update_req())
                .await
                .unwrap();
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_undo_snapshots \
                 WHERE session_id='s1' AND domain='flow'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 1, "应有 flow domain 快照");
        });
    }
}
