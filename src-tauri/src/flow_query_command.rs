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
}
