//! 流量规划只读查询（面板 + 门控详情弹窗）。
//!
//! 对齐 `topology_query_command`/`timesync_query_command` 的读写分离惯例——`plan_tas` 综合写库
//! 归 `flow_plan_command`，只读明细查询在此。直接 sqlx in-process 读 main pool（不走 sidecar）。
//!
//! U4（2026-07-14 门控明细表）：`get_gcl_detail` 单查询读新表体系（`gcl_windows` +
//! `gcl_plan_meta` + 流集嵌入，KTD8）——弹窗三页签 / 概览八卡 / 面板头行三态同源。
//! 旧 `get_flow_plan`（`flow_plans` 投影）已随前端切换 `get_gcl_detail` 退役。

use serde::Serialize;
use sqlx::Row;

// ── get_gcl_detail（U4，KTD8 单查询读面）────────────────────────────────────

/// 窗口关联流引用（`gcl_windows.flow_refs` JSON 元素，对齐 flow_plan_command::FlowRef）：
/// source=derived（实例锚定/窗长指纹命中）| class（类级降级）。
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct FlowRefDto {
    pub seq: i64,
    pub source: String,
}

/// 逐窗行（弹窗三页签/概览八卡/简版时序图共用）。`node`=mid、`node_name`=显示名（缺名回退
/// mid）；`gate_states` 0-255 位图（bit g = gate g 开）；`flow_refs` JSON 解析失败按 None
/// （不臆造关联，窗口本身照常返回）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GclWindowDto {
    pub node: String,
    pub node_name: String,
    pub eth_n: i64,
    pub entry_idx: i64,
    pub start_ns: i64,
    pub duration_ns: i64,
    pub gate_states: u8,
    pub flow_refs: Option<Vec<FlowRefDto>>,
}

/// 规划级元数据投影（`gcl_plan_meta` 单行）。stale=需重新规划（KTD14）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GclMetaDto {
    pub status: String,
    pub cycle_ns: i64,
    pub algorithm: String,
    pub stale: bool,
}

/// 门控详情（KTD8：display model 一次查询的数据源）：窗口行 + meta（None=从未规划，
/// AE6 空态判据）+ 流集嵌入（弹窗要流名/路径/周期/时延约束，复用 `list_flow_streams_inner`）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GclDetail {
    pub windows: Vec<GclWindowDto>,
    pub meta: Option<GclMetaDto>,
    pub streams: Vec<ListFlowStreamRow>,
}

/// 只读查询内核（AE5 单查询 DoD）：`gcl_windows`（LEFT JOIN 显示名）+ `gcl_plan_meta` +
/// 流集，provider 恒 `flow_plan_command::GCL_PROVIDER`（本期唯一 provider，R6）。
pub async fn get_gcl_detail_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<GclDetail, String> {
    let rows = sqlx::query(
        "SELECT w.node, n.name AS node_name, w.eth_n, w.entry_idx, w.start_ns, w.duration_ns, w.gate_states, w.flow_refs \
         FROM gcl_windows w \
         LEFT JOIN topology_nodes n ON n.session_id = w.session_id AND n.mid = w.node \
         WHERE w.session_id = ? AND w.provider = ? \
         ORDER BY w.node, w.eth_n, w.entry_idx",
    )
    .bind(session_id)
    .bind(crate::flow_plan_command::GCL_PROVIDER)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 gcl_windows 失败：{e}"))?;

    let windows = rows
        .iter()
        .map(|r| {
            let node: String = r.get("node");
            let name: Option<String> = r.get("node_name");
            let refs_json: Option<String> = r.get("flow_refs");
            GclWindowDto {
                node_name: name
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| node.clone()),
                node,
                eth_n: r.get("eth_n"),
                entry_idx: r.get("entry_idx"),
                start_ns: r.get("start_ns"),
                duration_ns: r.get("duration_ns"),
                gate_states: (r.get::<i64, _>("gate_states") & 0xFF) as u8,
                flow_refs: refs_json.and_then(|s| serde_json::from_str::<Vec<FlowRefDto>>(&s).ok()),
            }
        })
        .collect();

    let meta = sqlx::query(
        "SELECT status, cycle_ns, algorithm, stale FROM gcl_plan_meta \
         WHERE session_id = ? AND provider = ?",
    )
    .bind(session_id)
    .bind(crate::flow_plan_command::GCL_PROVIDER)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("读 gcl_plan_meta 失败：{e}"))?
    .map(|r| GclMetaDto {
        status: r.get("status"),
        cycle_ns: r.get("cycle_ns"),
        algorithm: r.get("algorithm"),
        stale: r.get::<i64, _>("stale") != 0,
    });

    let streams = list_flow_streams_inner(pool, session_id).await?.streams;

    Ok(GclDetail {
        windows,
        meta,
        streams,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetGclDetailRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn get_gcl_detail(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: GetGclDetailRequest,
) -> Result<GclDetail, String> {
    let pool = store.pool(&app).await?;
    get_gcl_detail_inner(pool, &request.session_id).await
}

// ---------- 设备级流标识默认值（录入时落库，boss 定规则） ----------

/// MAC 默认值：`00:00:23:00:00:{mid:02X}`。mid 非数字（异常态）→ None，不臆造。
pub fn default_mac_for_mid(mid: &str) -> Option<String> {
    let n: u8 = mid.parse().ok()?;
    Some(format!("00:00:23:00:00:{n:02X}"))
}

/// IP 默认值：`192.168.0.{mid+1}`（+1 避开 .0 网络地址）。mid 非数字 → None。
pub fn default_ip_for_mid(mid: &str) -> Option<String> {
    let n: u8 = mid.parse().ok()?;
    Some(format!("192.168.0.{}", u16::from(n) + 1))
}

pub const DEFAULT_SRC_L4_PORT: i64 = 10000;
pub const DEFAULT_DST_L4_PORT: i64 = 20000;
pub const DEFAULT_L4_PROTOCOL: &str = "UDP";
pub const DEFAULT_VLAN_ID: i64 = 0;
pub const DEFAULT_EARLIEST_SEND_OFFSET_NS: i64 = 0;
pub const DEFAULT_LATEST_SEND_OFFSET_NS: i64 = 100;
pub const DEFAULT_JITTER_NS: i64 = 50;

/// 流名称默认值：`{class}流{seq}`（如 "ST流0"），详情弹窗可改。
pub fn default_stream_name(class: &str, stream_seq: i64) -> String {
    format!("{class}流{stream_seq}")
}

/// 单流行：流面板重设计 U3 + 参考图对齐扩展。命名 `ListFlowStreamRow`（非 `FlowStreamRow`）
/// 以规避 `topology_undo` 私有同名结构体冲突。`redundant` 存 INTEGER，`!= 0` 映成 bool。
/// 设备级流标识列（MAC/IP/端口/协议/VLAN/偏移/抖动/名称）老行为 NULL 时返回推导默认值
/// （录入即落库是新行为，老行详情保存后补落库）；`node_path` 为路由显示名序列（推导失败为空，
/// 前端回退 talker → listener）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListFlowStreamRow {
    pub stream_seq: i64,
    pub class: String,
    pub pcp: i64,
    pub period_us: i64,
    pub frame_bytes: i64,
    pub count: i64,
    pub talker: String,
    pub listener: String,
    pub max_latency_us: Option<i64>,
    pub redundant: bool,
    pub src_mac: Option<String>,
    pub dst_mac: Option<String>,
    pub vlan_id: Option<i64>,
    pub earliest_send_offset_ns: Option<i64>,
    pub latest_send_offset_ns: Option<i64>,
    pub name: Option<String>,
    pub jitter_ns: Option<i64>,
    pub src_ip: Option<String>,
    pub dst_ip: Option<String>,
    pub src_l4_port: Option<i64>,
    pub dst_l4_port: Option<i64>,
    pub l4_protocol: Option<String>,
    pub node_path: Vec<String>,
    /// paths 列原文（KTD12 统一 JSON 形状；NULL=系统推导）。弹窗解析 origin=user 的
    /// link_seqs 匹配候选选中项；RC 只读展示双路径。
    pub paths: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFlowStreamsRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListFlowStreamsResult {
    pub streams: Vec<ListFlowStreamRow>,
}

/// 只读查询内核：取指定会话的所有流集行，按 `stream_seq` 升序。
/// 设备级流标识 NULL 列回退推导默认值（显示层回退，DB 不写——详情保存才落库）；
/// `node_path` 现推路由并映射显示名（与 `get_flow_route_map_inner` 同路由逻辑，失败为空）。
pub async fn list_flow_streams_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<ListFlowStreamsResult, String> {
    let rows = sqlx::query(
        "SELECT stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, \
                max_latency_us, redundant, src_mac, dst_mac, vlan_id, \
                earliest_send_offset_ns, latest_send_offset_ns, \
                name, jitter_ns, src_ip, dst_ip, src_l4_port, dst_l4_port, l4_protocol, paths \
         FROM flow_streams WHERE session_id = ? ORDER BY stream_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_streams 失败：{e}"))?;

    // 路由拓扑 + mid→显示名映射（回退裸 mid，同 get_gcl_detail_inner 口径）。
    let (nodes, links) = crate::flow_verify::load_route_topology(pool, session_id)
        .await
        .map_err(|e| format!("读拓扑失败：{e}"))?;
    let dual_plane = links
        .iter()
        .any(|l| crate::flow_route::link_plane(l).is_some());
    let display_name = |mid: &str| -> String {
        nodes
            .iter()
            .find(|n| n.mid == mid)
            .and_then(|n| n.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| mid.to_string())
    };

    let streams = rows
        .iter()
        .map(|r| {
            let class: String = r.get("class");
            let stream_seq: i64 = r.get("stream_seq");
            let talker: String = r.get("talker");
            let listener: String = r.get("listener");

            // 路由显示名路径：RC 展示 A 平面路径；失败为空（前端回退 talker → listener）。
            let node_path: Vec<String> = if class == "RC" {
                crate::flow_route::derive_redundant_routes(&talker, &listener, &nodes, &links)
                    .map(|(a, _)| a.node_path)
                    .unwrap_or_default()
            } else {
                let plane = if dual_plane { Some("A") } else { None };
                let req = crate::flow_route::RouteRequest {
                    talker: &talker,
                    listener: &listener,
                    plane,
                };
                // KTD11 统一出口：显式指定优先（失效则空路径，前端回退 talker → listener）。
                crate::flow_route::resolve_flow_path(
                    r.get::<Option<String>, _>("paths").as_deref(),
                    &req,
                    &nodes,
                    &links,
                )
                .map(|route| route.node_path)
                .unwrap_or_default()
            }
            .iter()
            .map(|mid| display_name(mid))
            .collect();

            ListFlowStreamRow {
                stream_seq,
                pcp: r.get("pcp"),
                period_us: r.get("period_us"),
                frame_bytes: r.get("frame_bytes"),
                count: r.get("count"),
                max_latency_us: r.get("max_latency_us"),
                redundant: r.get::<i64, _>("redundant") != 0,
                src_mac: r
                    .get::<Option<String>, _>("src_mac")
                    .or_else(|| default_mac_for_mid(&talker)),
                dst_mac: r
                    .get::<Option<String>, _>("dst_mac")
                    .or_else(|| default_mac_for_mid(&listener)),
                vlan_id: r.get::<Option<i64>, _>("vlan_id").or(Some(DEFAULT_VLAN_ID)),
                earliest_send_offset_ns: r
                    .get::<Option<i64>, _>("earliest_send_offset_ns")
                    .or(Some(DEFAULT_EARLIEST_SEND_OFFSET_NS)),
                latest_send_offset_ns: r
                    .get::<Option<i64>, _>("latest_send_offset_ns")
                    .or(Some(DEFAULT_LATEST_SEND_OFFSET_NS)),
                name: r
                    .get::<Option<String>, _>("name")
                    .or_else(|| Some(default_stream_name(&class, stream_seq))),
                jitter_ns: r
                    .get::<Option<i64>, _>("jitter_ns")
                    .or(Some(DEFAULT_JITTER_NS)),
                src_ip: r
                    .get::<Option<String>, _>("src_ip")
                    .or_else(|| default_ip_for_mid(&talker)),
                dst_ip: r
                    .get::<Option<String>, _>("dst_ip")
                    .or_else(|| default_ip_for_mid(&listener)),
                src_l4_port: r
                    .get::<Option<i64>, _>("src_l4_port")
                    .or(Some(DEFAULT_SRC_L4_PORT)),
                dst_l4_port: r
                    .get::<Option<i64>, _>("dst_l4_port")
                    .or(Some(DEFAULT_DST_L4_PORT)),
                l4_protocol: r
                    .get::<Option<String>, _>("l4_protocol")
                    .or_else(|| Some(DEFAULT_L4_PROTOCOL.to_string())),
                paths: r.get("paths"),
                class,
                talker,
                listener,
                node_path,
            }
        })
        .collect();

    Ok(ListFlowStreamsResult { streams })
}

#[tauri::command]
pub async fn list_flow_streams(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: ListFlowStreamsRequest,
) -> Result<ListFlowStreamsResult, String> {
    let pool = store.pool(&app).await?;
    list_flow_streams_inner(pool, &request.session_id).await
}

/// 单流路由条目（U5，流面板路由可视化）。`link_ids` 为 A 平面（或单平面）链路 id 列表，
/// 格式 `"link-{seq}"`（对齐前端 `linkRowId`）；`plane_b_link_ids` 仅 RC 流的 B 平面路径，
/// ST/BE 及单平面场景为 `None`。路由失败的流不计入结果（无 entry，无 panic）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRouteEntry {
    pub stream_seq: i64,
    pub link_ids: Vec<String>,
    pub plane_b_link_ids: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowRouteMapRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowRouteMapResult {
    pub routes: Vec<FlowRouteEntry>,
}

/// 只读内核：为 session 内所有流推导路由，双平面感知。
/// - RC：`derive_redundant_routes` → A/B 两路；
/// - ST/BE：`resolve_flow_path`（显式指定优先；双平面锁 A、单平面全链路）；
/// - 路由失败跳过（不返回 entry，不 panic）。
pub async fn get_flow_route_map_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<GetFlowRouteMapResult, String> {
    let (nodes, links) = crate::flow_verify::load_route_topology(pool, session_id)
        .await
        .map_err(|e| format!("读拓扑失败：{e}"))?;

    // 镜像 flow_plan_command.rs 双平面检测模式。
    let dual_plane = links
        .iter()
        .any(|l| crate::flow_route::link_plane(l).is_some());

    let stream_rows = sqlx::query(
        "SELECT stream_seq, class, talker, listener, paths \
         FROM flow_streams WHERE session_id = ? ORDER BY stream_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_streams 失败：{e}"))?;

    let mut routes: Vec<FlowRouteEntry> = Vec::new();
    for r in &stream_rows {
        let stream_seq: i64 = r.get("stream_seq");
        let class: String = r.get("class");
        let talker: String = r.get("talker");
        let listener: String = r.get("listener");

        if class == "RC" {
            // RC 双平面：A/B 两路径，不相交断言已在录入闸通过。路由失败 → 跳过，不 panic。
            if let Ok((a, b)) =
                crate::flow_route::derive_redundant_routes(&talker, &listener, &nodes, &links)
            {
                let link_ids = a.link_seqs.iter().map(|s| format!("link-{s}")).collect();
                let plane_b_link_ids =
                    Some(b.link_seqs.iter().map(|s| format!("link-{s}")).collect());
                routes.push(FlowRouteEntry {
                    stream_seq,
                    link_ids,
                    plane_b_link_ids,
                });
            }
        } else {
            // ST/BE：双平面锁 A 平面，单平面全链路（与 flow_plan_command.rs 同逻辑）。
            let plane = if dual_plane { Some("A") } else { None };
            let req = crate::flow_route::RouteRequest {
                talker: &talker,
                listener: &listener,
                plane,
            };
            // KTD11 统一出口（显式指定优先）；路由失败/PATH_STALE → 跳过高亮，不 panic
            // （详情弹窗与规划路径各自响亮报错，画布高亮只做尽力展示）。
            if let Ok(route) = crate::flow_route::resolve_flow_path(
                r.get::<Option<String>, _>("paths").as_deref(),
                &req,
                &nodes,
                &links,
            ) {
                let link_ids = route
                    .link_seqs
                    .iter()
                    .map(|s| format!("link-{s}"))
                    .collect();
                routes.push(FlowRouteEntry {
                    stream_seq,
                    link_ids,
                    plane_b_link_ids: None,
                });
            }
        }
    }

    Ok(GetFlowRouteMapResult { routes })
}

#[tauri::command]
pub async fn get_flow_route_map(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: GetFlowRouteMapRequest,
) -> Result<GetFlowRouteMapResult, String> {
    let pool = store.pool(&app).await?;
    get_flow_route_map_inner(pool, &request.session_id).await
}

// ── get_flow_path_candidates（U10b，弹窗路径下拉）─────────────────────────────

/// 候选枚举上限（R16：上限打满时 truncated=true，弹窗提示「还有未列出路径」）。
const FLOW_PATH_CANDIDATE_LIMIT: usize = 8;

/// 单条候选路径：`node_path` mid 序列、`node_path_names` 同序显示名（缺名回退 mid）、
/// `link_seqs` 回传 update_flow_stream 的 path_link_seqs。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowPathCandidate {
    pub node_path: Vec<String>,
    pub node_path_names: Vec<String>,
    pub link_seqs: Vec<i64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowPathCandidatesRequest {
    pub session_id: String,
    pub talker: String,
    pub listener: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GetFlowPathCandidatesResult {
    pub candidates: Vec<FlowPathCandidate>,
    pub truncated: bool,
}

/// 只读内核：枚举 talker→listener 的候选简单路径（上限 8、按跳数/link_seq 有序）。
/// plane 语义照 plan_tas：双平面锁 A、单平面全链路（ST/BE 口径；RC 不经此出口）。
pub async fn get_flow_path_candidates_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    talker: &str,
    listener: &str,
) -> Result<GetFlowPathCandidatesResult, String> {
    let (nodes, links) = crate::flow_verify::load_route_topology(pool, session_id)
        .await
        .map_err(|e| format!("读拓扑失败：{e}"))?;
    let dual_plane = links
        .iter()
        .any(|l| crate::flow_route::link_plane(l).is_some());
    let plane = if dual_plane { Some("A") } else { None };
    let req = crate::flow_route::RouteRequest {
        talker,
        listener,
        plane,
    };
    let (routes, truncated) =
        crate::flow_route::enumerate_candidate_paths(&req, &links, FLOW_PATH_CANDIDATE_LIMIT);
    let display_name = |mid: &str| -> String {
        nodes
            .iter()
            .find(|n| n.mid == mid)
            .and_then(|n| n.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| mid.to_string())
    };
    let candidates = routes
        .into_iter()
        .map(|r| FlowPathCandidate {
            node_path_names: r.node_path.iter().map(|m| display_name(m)).collect(),
            node_path: r.node_path,
            link_seqs: r.link_seqs,
        })
        .collect();
    Ok(GetFlowPathCandidatesResult {
        candidates,
        truncated,
    })
}

#[tauri::command]
pub async fn get_flow_path_candidates(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: GetFlowPathCandidatesRequest,
) -> Result<GetFlowPathCandidatesResult, String> {
    let pool = store.pool(&app).await?;
    get_flow_path_candidates_inner(
        pool,
        &request.session_id,
        &request.talker,
        &request.listener,
    )
    .await
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
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub jitter_ns: Option<i64>,
    #[serde(default)]
    pub src_ip: Option<String>,
    #[serde(default)]
    pub dst_ip: Option<String>,
    #[serde(default)]
    pub src_l4_port: Option<i64>,
    #[serde(default)]
    pub dst_l4_port: Option<i64>,
    #[serde(default)]
    pub l4_protocol: Option<String>,
    /// R16 路径变更三态：`path_link_seqs`（弹窗候选回传，link_seq 序列）或
    /// `path_node_refs`（agent 节点引用序列）二选一设置显式路径；`clear_path=true`
    /// 改回系统自动（paths 置 NULL）；全缺省 = 路径不变。RC 流拒绝路径变更。
    #[serde(default)]
    pub path_link_seqs: Option<Vec<i64>>,
    #[serde(default)]
    pub path_node_refs: Option<Vec<String>>,
    #[serde(default)]
    pub clear_path: bool,
}

/// 流更新结果：`planning_fields_changed` = 规划字段（period/frame/count/max_latency）或
/// 路径有实际变更（KTD14 服务端判定，弹窗与 agent 通道同源；置 stale 与此同值）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFlowStreamResult {
    pub planning_fields_changed: bool,
}

/// 写前验证 + 快照 + UPDATE 内核（可注入 pool 供单测）。
pub async fn update_flow_stream_inner(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    req: &UpdateFlowStreamRequest,
) -> Result<UpdateFlowStreamResult, String> {
    // 1. 读不可变字段（class/pcp 决定 verify_flow 路径，talker/listener 决定节点存在性检查）
    // 与规划字段旧值（KTD14 服务端 diff）。
    let row = sqlx::query(
        "SELECT class, pcp, talker, listener, src_ip, dst_ip, src_l4_port, dst_l4_port, \
         l4_protocol, redundant, paths, period_us, frame_bytes, count, max_latency_us \
         FROM flow_streams WHERE session_id = ? AND stream_seq = ?",
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
        src_ip: req.src_ip.clone().or_else(|| row.get("src_ip")),
        dst_ip: req.dst_ip.clone().or_else(|| row.get("dst_ip")),
        src_l4_port: req.src_l4_port.or_else(|| row.get("src_l4_port")),
        dst_l4_port: req.dst_l4_port.or_else(|| row.get("dst_l4_port")),
        l4_protocol: req.l4_protocol.clone().or_else(|| row.get("l4_protocol")),
        max_latency_us: req.max_latency_us,
        redundant: row.get("redundant"),
        paths: row.get("paths"),
    };

    // 2b. R16 路径变更三态：set（link_seqs 或节点引用）/ clear / 不变。
    // RC 拒绝（双路径系统推导）。set 时解析+校验并把新 paths 带进 verify_flow。
    let class: String = row.get("class");
    let path_change: Option<Option<String>> = if req.clear_path {
        if req.path_link_seqs.is_some() || req.path_node_refs.is_some() {
            return Err("clear_path 与指定路径参数不能同时使用。".to_string());
        }
        Some(None) // 改回系统自动
    } else if req.path_link_seqs.is_some() || req.path_node_refs.is_some() {
        if class == "RC" {
            return Err("RC 流的双冗余路径由系统推导（保证不相交），不支持手动指定。".to_string());
        }
        let (nodes, links) = crate::flow_verify::load_route_topology(pool, &req.session_id)
            .await
            .map_err(|e| format!("读拓扑失败：{e}"))?;
        let route = if let Some(seqs) = &req.path_link_seqs {
            crate::flow_route::build_route_from_link_seqs(
                seqs,
                &stream_input.talker,
                &stream_input.listener,
                &links,
            )
        } else {
            crate::flow_route::route_from_node_refs(
                req.path_node_refs.as_deref().unwrap_or(&[]),
                &stream_input.talker,
                &stream_input.listener,
                &nodes,
                &links,
            )
        };
        match route {
            Ok(r) => Some(Some(crate::flow_route::explicit_paths_json(&r))),
            Err(errors) => {
                let msgs: Vec<String> = errors.iter().map(|e| e.message_zh.clone()).collect();
                return Err(format!("路径校验不通过：{}", msgs.join("；")));
            }
        }
    } else {
        None // 路径不变
    };
    let mut stream_input = stream_input;
    if let Some(new_paths) = &path_change {
        stream_input.paths = new_paths.clone();
    }

    // 2c. KTD14 规划字段变更判定（服务端 diff，弹窗/agent 双通道同源）：
    // period/frame/count/max_latency 任一与旧值不同，或有路径变更 → 置 stale。
    let planning_fields_changed = req.period_us != row.get::<i64, _>("period_us")
        || req.frame_bytes != row.get::<i64, _>("frame_bytes")
        || req.count != row.get::<i64, _>("count")
        || req.max_latency_us != row.get::<Option<i64>, _>("max_latency_us")
        || path_change.is_some();

    // 3. 结构校验（class/pcp 不变，重跑以防节点已删或周期越界）。
    let errors = crate::flow_verify::verify_flow(pool, &req.session_id, &stream_input)
        .await
        .map_err(|e| format!("校验失败：{e}"))?;
    if !errors.is_empty() {
        let msgs: Vec<String> = errors.iter().map(|e| e.message_zh.clone()).collect();
        return Err(format!("流量校验不通过：{}", msgs.join("；")));
    }

    // 4. 开事务。
    let mut tx = pool.begin().await.map_err(|e| format!("开事务失败：{e}"))?;

    // 5. 写前快照（flow domain，撤销留位）。
    crate::topology_undo::snapshot_pre_image(
        &mut tx,
        &req.session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    .map_err(|e| format!("快照失败：{e}"))?;

    // 6. 全列 UPDATE（含可空列）。参考图新字段（名称/抖动/IP/端口/协议）用 COALESCE：
    // 请求未带（None，如 agent 老调用）保留原值，不清空。
    let result = sqlx::query(
        "UPDATE flow_streams SET period_us=?, frame_bytes=?, count=?, max_latency_us=?, \
         src_mac=?, dst_mac=?, vlan_id=?, earliest_send_offset_ns=?, latest_send_offset_ns=?, \
         name=COALESCE(?, name), jitter_ns=COALESCE(?, jitter_ns), \
         src_ip=COALESCE(?, src_ip), dst_ip=COALESCE(?, dst_ip), \
         src_l4_port=COALESCE(?, src_l4_port), dst_l4_port=COALESCE(?, dst_l4_port), \
         l4_protocol=COALESCE(?, l4_protocol) \
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
    .bind(&req.name)
    .bind(req.jitter_ns)
    .bind(&req.src_ip)
    .bind(&req.dst_ip)
    .bind(req.src_l4_port)
    .bind(req.dst_l4_port)
    .bind(&req.l4_protocol)
    .bind(&req.session_id)
    .bind(req.stream_seq)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新 flow_streams 失败：{e}"))?;

    // 7. 并发竞态守卫（SELECT 后到 UPDATE 前被删）。
    if result.rows_affected() == 0 {
        return Err(format!("stream_seq={} 不存在", req.stream_seq));
    }

    // 7b. R16 路径变更单独写（需支持写 NULL 改回系统自动，不能进 COALESCE 主句）。
    if let Some(new_paths) = &path_change {
        sqlx::query("UPDATE flow_streams SET paths=? WHERE session_id=? AND stream_seq=?")
            .bind(new_paths)
            .bind(&req.session_id)
            .bind(req.stream_seq)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("更新路径失败：{e}"))?;
    }

    // 7c. KTD14：规划字段变更 → 同事务置 gcl_plan_meta.stale（无行 no-op）。
    if planning_fields_changed {
        crate::flow_plan_command::mark_gcl_stale(&mut *tx, &req.session_id).await?;
    }

    // 8. 提交。
    tx.commit().await.map_err(|e| format!("提交失败：{e}"))?;

    Ok(UpdateFlowStreamResult {
        planning_fields_changed,
    })
}

#[tauri::command]
pub async fn update_flow_stream(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: UpdateFlowStreamRequest,
) -> Result<UpdateFlowStreamResult, String> {
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

    /// 直插一条 gcl_windows 逐窗行（provider=inet-z3，U4 新表读面测试）。
    #[allow(clippy::too_many_arguments)]
    async fn add_gcl_window(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        node: &str,
        eth_n: i64,
        entry_idx: i64,
        start_ns: i64,
        duration_ns: i64,
        gate_states: i64,
        flow_refs: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO gcl_windows (session_id, provider, node, eth_n, entry_idx, start_ns, duration_ns, gate_states, flow_refs) \
             VALUES ('s1', 'inet-z3', ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(node).bind(eth_n).bind(entry_idx).bind(start_ns).bind(duration_ns)
        .bind(gate_states).bind(flow_refs)
        .execute(pool).await.unwrap();
    }

    /// 直插 gcl_plan_meta 单行。
    async fn add_gcl_meta(pool: &sqlx::Pool<sqlx::Sqlite>, status: &str, stale: i64) {
        sqlx::query(
            "INSERT INTO gcl_plan_meta (session_id, provider, status, cycle_ns, algorithm, stale, created_at) \
             VALUES ('s1', 'inet-z3', ?, 1000000, 'Z3', ?, 'now')",
        )
        .bind(status)
        .bind(stale)
        .execute(pool)
        .await
        .unwrap();
    }

    // ── get_gcl_detail 测试（U4）────────────────────────────────────────────

    /// U4①：端到端——窗口行（显示名映射 + flow_refs 解析）+ meta + 流集嵌入一次返回（AE5）。
    #[test]
    fn get_gcl_detail_returns_windows_meta_and_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            sqlx::query(
                "UPDATE topology_nodes SET name='核心交换机' WHERE session_id='s1' AND mid='0'",
            )
            .execute(&pool)
            .await
            .unwrap();
            add_stream(&pool, 0, "ST", 7).await;
            add_gcl_meta(&pool, "ok", 1).await;
            add_gcl_window(
                &pool,
                "0",
                1,
                0,
                0,
                4_560,
                0x80,
                Some(r#"[{"seq":0,"source":"derived"}]"#),
            )
            .await;
            add_gcl_window(&pool, "0", 1, 1, 4_560, 995_440, 0x7F, None).await;
            let d = get_gcl_detail_inner(&pool, "s1").await.unwrap();
            assert_eq!(d.windows.len(), 2);
            let w0 = &d.windows[0];
            assert_eq!(w0.node, "0");
            assert_eq!(w0.node_name, "核心交换机");
            assert_eq!((w0.eth_n, w0.entry_idx), (1, 0));
            assert_eq!((w0.start_ns, w0.duration_ns), (0, 4_560));
            assert_eq!(w0.gate_states, 0x80);
            assert_eq!(
                w0.flow_refs,
                Some(vec![FlowRefDto {
                    seq: 0,
                    source: "derived".into()
                }])
            );
            assert!(d.windows[1].flow_refs.is_none());
            let meta = d.meta.expect("应有 meta");
            assert_eq!(meta.status, "ok");
            assert_eq!(meta.cycle_ns, 1_000_000);
            assert_eq!(meta.algorithm, "Z3");
            assert!(meta.stale);
            // 流集嵌入（复用 list_flow_streams_inner，含流名默认值与路径）。
            assert_eq!(d.streams.len(), 1);
            assert_eq!(d.streams[0].name.as_deref(), Some("ST流0"));
        });
    }

    /// U4②：flow_refs JSON 损坏 → 该窗 flow_refs=None（不臆造关联），窗口本身照常返回。
    #[test]
    fn get_gcl_detail_corrupt_flow_refs_becomes_none() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_gcl_meta(&pool, "ok", 0).await;
            add_gcl_window(&pool, "0", 1, 0, 0, 4_560, 0x80, Some("not-json")).await;
            let d = get_gcl_detail_inner(&pool, "s1").await.unwrap();
            assert_eq!(d.windows.len(), 1);
            assert!(d.windows[0].flow_refs.is_none());
        });
    }

    /// U4③：无 meta 行（老工程/从未规划）→ meta=None、windows=[]（AE6 空态判据）。
    #[test]
    fn get_gcl_detail_no_meta_row_means_never_planned() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let d = get_gcl_detail_inner(&pool, "s1").await.unwrap();
            assert!(d.meta.is_none());
            assert!(d.windows.is_empty());
            assert_eq!(d.streams.len(), 1);
        });
    }

    /// U4④：serde camelCase 契约（前端 GclDetail DTO 镜像依赖字段名）。
    #[test]
    fn gcl_detail_serializes_camel_case() {
        let detail = GclDetail {
            windows: vec![GclWindowDto {
                node: "0".into(),
                node_name: "sw1".into(),
                eth_n: 1,
                entry_idx: 0,
                start_ns: 100,
                duration_ns: 4_560,
                gate_states: 0x80,
                flow_refs: Some(vec![FlowRefDto {
                    seq: 3,
                    source: "class".into(),
                }]),
            }],
            meta: Some(GclMetaDto {
                status: "ok".into(),
                cycle_ns: 1_000_000,
                algorithm: "Z3".into(),
                stale: false,
            }),
            streams: vec![],
        };
        let v = serde_json::to_value(&detail).unwrap();
        let w = &v["windows"][0];
        assert_eq!(w["nodeName"], "sw1");
        assert_eq!(w["ethN"], 1);
        assert_eq!(w["entryIdx"], 0);
        assert_eq!(w["startNs"], 100);
        assert_eq!(w["durationNs"], 4_560);
        assert_eq!(w["gateStates"], 128);
        assert_eq!(w["flowRefs"][0]["seq"], 3);
        assert_eq!(w["flowRefs"][0]["source"], "class");
        assert_eq!(v["meta"]["cycleNs"], 1_000_000);
        assert_eq!(v["meta"]["stale"], false);
        assert!(v["streams"].is_array());
    }

    // ── list_flow_streams 测试 ──────────────────────────────────────────────

    /// U3①：空流集 → streams=[]。
    #[test]
    fn list_flow_streams_empty_session() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            let result = list_flow_streams_inner(&pool, "s1").await.unwrap();
            assert!(result.streams.is_empty());
        });
    }

    /// U3②：单条 ST 流（设备级标识列 NULL）→ 显示层回退推导默认值
    /// （MAC/IP 按 mid、端口/协议/VLAN/偏移/抖动/名称按常量规则）。
    #[test]
    fn list_flow_streams_single_st_stream_defaults_filled() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let result = list_flow_streams_inner(&pool, "s1").await.unwrap();
            assert_eq!(result.streams.len(), 1);
            let s = &result.streams[0];
            assert_eq!(s.stream_seq, 0);
            assert_eq!(s.class, "ST");
            assert_eq!(s.pcp, 7);
            assert_eq!(s.period_us, 500);
            assert_eq!(s.frame_bytes, 512);
            assert_eq!(s.count, 10000);
            assert_eq!(s.talker, "1");
            assert_eq!(s.listener, "2");
            assert!(s.max_latency_us.is_none());
            assert!(!s.redundant);
            // 设备级标识 NULL → 推导默认值（talker mid=1、listener mid=2）。
            assert_eq!(s.src_mac.as_deref(), Some("00:00:23:00:00:01"));
            assert_eq!(s.dst_mac.as_deref(), Some("00:00:23:00:00:02"));
            assert_eq!(s.src_ip.as_deref(), Some("192.168.0.2"));
            assert_eq!(s.dst_ip.as_deref(), Some("192.168.0.3"));
            assert_eq!(s.vlan_id, Some(DEFAULT_VLAN_ID));
            assert_eq!(
                s.earliest_send_offset_ns,
                Some(DEFAULT_EARLIEST_SEND_OFFSET_NS)
            );
            assert_eq!(s.latest_send_offset_ns, Some(DEFAULT_LATEST_SEND_OFFSET_NS));
            assert_eq!(s.src_l4_port, Some(DEFAULT_SRC_L4_PORT));
            assert_eq!(s.dst_l4_port, Some(DEFAULT_DST_L4_PORT));
            assert_eq!(s.l4_protocol.as_deref(), Some(DEFAULT_L4_PROTOCOL));
            assert_eq!(s.name.as_deref(), Some("ST流0"));
            assert_eq!(s.jitter_ns, Some(DEFAULT_JITTER_NS));
        });
    }

    /// U3③：ST + RC + BE 三流 → 三行按 stream_seq 升序返回。
    #[test]
    fn list_flow_streams_st_rc_be_ordered_by_seq() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // RC 流：redundant=1。
            sqlx::query(
                "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, \
                 frame_bytes, count, talker, listener, redundant) \
                 VALUES ('s1', 1, 'RC', 6, 500, 512, 10000, '1', '2', 1)",
            )
            .execute(&pool)
            .await
            .unwrap();
            add_stream(&pool, 2, "BE", 0).await;
            let result = list_flow_streams_inner(&pool, "s1").await.unwrap();
            assert_eq!(result.streams.len(), 3);
            assert_eq!(result.streams[0].class, "ST");
            assert_eq!(result.streams[1].class, "RC");
            assert_eq!(result.streams[2].class, "BE");
        });
    }

    /// U3④：RC 流 redundant=1 → redundant: true 映射正确。
    #[test]
    fn list_flow_streams_redundant_true_for_rc() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            sqlx::query(
                "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, \
                 frame_bytes, count, talker, listener, redundant) \
                 VALUES ('s1', 0, 'RC', 6, 500, 512, 10000, '1', '2', 1)",
            )
            .execute(&pool)
            .await
            .unwrap();
            let result = list_flow_streams_inner(&pool, "s1").await.unwrap();
            assert_eq!(result.streams.len(), 1);
            assert!(result.streams[0].redundant);
        });
    }

    /// U3⑤：错误的 session_id → streams=[]。
    #[test]
    fn list_flow_streams_wrong_session_id_returns_empty() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let result = list_flow_streams_inner(&pool, "wrong-session")
                .await
                .unwrap();
            assert!(result.streams.is_empty());
        });
    }

    /// U3⑥：serde camelCase 契约（前端 DTO 镜像依赖字段名）。
    #[test]
    fn list_flow_stream_row_serializes_camel_case() {
        let row = ListFlowStreamRow {
            stream_seq: 0,
            class: "ST".into(),
            pcp: 7,
            period_us: 500,
            frame_bytes: 512,
            count: 10000,
            talker: "1".into(),
            listener: "2".into(),
            max_latency_us: Some(1000),
            redundant: false,
            src_mac: None,
            dst_mac: None,
            vlan_id: None,
            earliest_send_offset_ns: None,
            latest_send_offset_ns: None,
            name: Some("ST流0".into()),
            jitter_ns: Some(50),
            src_ip: None,
            dst_ip: None,
            src_l4_port: None,
            dst_l4_port: None,
            l4_protocol: None,
            node_path: vec!["ES-1".into(), "SW-0".into(), "ES-2".into()],
            paths: None,
        };
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(v["streamSeq"], 0);
        assert_eq!(v["class"], "ST");
        assert_eq!(v["pcp"], 7);
        assert_eq!(v["periodUs"], 500);
        assert_eq!(v["frameBytes"], 512);
        assert_eq!(v["count"], 10000);
        assert_eq!(v["maxLatencyUs"], 1000);
        assert_eq!(v["redundant"], false);
        assert!(v["srcMac"].is_null());
        assert!(v["dstMac"].is_null());
        assert!(v["vlanId"].is_null());
        assert!(v["earliestSendOffsetNs"].is_null());
        assert!(v["latestSendOffsetNs"].is_null());
        assert_eq!(v["name"], "ST流0");
        assert_eq!(v["jitterNs"], 50);
        assert_eq!(v["nodePath"][0], "ES-1");
        assert!(v["srcIp"].is_null());
        assert!(v["l4Protocol"].is_null());
    }

    // ── get_flow_route_map 测试 ────────────────────────────────────────────

    /// 添加节点（mid=任意，no name）。
    async fn add_node_r(pool: &sqlx::Pool<sqlx::Sqlite>, mid: &str) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, 0)",
        )
        .bind(mid)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 添加链路（plane=None 单平面，Some(p) 双平面）。
    async fn add_link_r(
        pool: &sqlx::Pool<sqlx::Sqlite>,
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

    /// 添加流（仅必填列：talker/listener 可自定义）。
    async fn add_stream_r(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        seq: i64,
        class: &str,
        pcp: i64,
        talker: &str,
        listener: &str,
    ) {
        sqlx::query(
            "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) \
             VALUES ('s1', ?, ?, ?, 500, 512, 10000, ?, ?)",
        )
        .bind(seq)
        .bind(class)
        .bind(pcp)
        .bind(talker)
        .bind(listener)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 双平面 fixture：节点 0/1/2/3；A 平面 0-2-1（seq 0/1），B 平面 0-3-1（seq 2/3）。
    async fn seed_dual_plane_r(pool: &sqlx::Pool<sqlx::Sqlite>) {
        for mid in ["0", "1", "2", "3"] {
            add_node_r(pool, mid).await;
        }
        add_link_r(pool, 0, "0", 0, "2", 0, Some("A")).await;
        add_link_r(pool, 1, "2", 1, "1", 0, Some("A")).await;
        add_link_r(pool, 2, "0", 1, "3", 0, Some("B")).await;
        add_link_r(pool, 3, "3", 1, "1", 1, Some("B")).await;
    }

    /// U5①：空流集 → routes=[]。
    #[test]
    fn route_map_empty_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            let r = get_flow_route_map_inner(&pool, "s1").await.unwrap();
            assert!(r.routes.is_empty());
        });
    }

    /// U5②：单平面拓扑 + ST 流 → link_ids 非空（路径 seq 0/1），plane_b_link_ids=None，
    /// link-{seq} 格式正确。
    #[test]
    fn route_map_single_plane_st_stream() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await; // 节点 1→0→2，链路 seq 0/1
            add_stream_r(&pool, 0, "ST", 7, "1", "2").await;
            let r = get_flow_route_map_inner(&pool, "s1").await.unwrap();
            assert_eq!(r.routes.len(), 1);
            let entry = &r.routes[0];
            assert_eq!(entry.stream_seq, 0);
            assert!(!entry.link_ids.is_empty(), "ST 路径应非空");
            assert!(entry.plane_b_link_ids.is_none());
            // 链路 id 格式为 "link-{seq}"。
            for id in &entry.link_ids {
                assert!(id.starts_with("link-"), "格式应为 link-{{seq}}：{id}");
            }
        });
    }

    /// U5③：双平面拓扑 + ST 流 → plane_b_link_ids=None，link_ids 取 A 平面路径（seq 0/1）。
    #[test]
    fn route_map_dual_plane_st_locks_plane_a() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_r(&pool).await;
            add_stream_r(&pool, 0, "ST", 7, "0", "1").await;
            let r = get_flow_route_map_inner(&pool, "s1").await.unwrap();
            assert_eq!(r.routes.len(), 1);
            let entry = &r.routes[0];
            assert!(entry.plane_b_link_ids.is_none(), "ST 无 B 平面路径");
            // A 平面路径 link_seqs=[0, 1]。
            assert_eq!(entry.link_ids, vec!["link-0", "link-1"]);
        });
    }

    /// U5④：双平面拓扑 + RC 流 → link_ids（A 平面 seq 0/1）和 plane_b_link_ids（B 平面 seq 2/3）均非空。
    #[test]
    fn route_map_dual_plane_rc_has_both_planes() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_dual_plane_r(&pool).await;
            sqlx::query(
                "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, redundant) \
                 VALUES ('s1', 0, 'RC', 6, 500, 512, 10000, '0', '1', 1)",
            )
            .execute(&pool)
            .await
            .unwrap();
            let r = get_flow_route_map_inner(&pool, "s1").await.unwrap();
            assert_eq!(r.routes.len(), 1);
            let entry = &r.routes[0];
            assert_eq!(entry.link_ids, vec!["link-0", "link-1"]); // A 平面
            let b = entry.plane_b_link_ids.as_ref().expect("RC 应有 B 平面路径");
            assert_eq!(b, &vec!["link-2", "link-3"]); // B 平面
        });
    }

    /// U5⑤：listener 不可达 → 该流无 entry（路由失败跳过，不 panic）。
    #[test]
    fn route_map_unreachable_listener_skipped() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            // 节点 9 孤岛，1→9 不可达。
            add_node_r(&pool, "9").await;
            add_stream_r(&pool, 0, "ST", 7, "1", "9").await;
            let r = get_flow_route_map_inner(&pool, "s1").await.unwrap();
            assert!(r.routes.is_empty(), "不可达流不应有 entry：{:?}", r.routes);
        });
    }

    /// U5⑥：serde camelCase 契约。
    #[test]
    fn flow_route_entry_serializes_camel_case() {
        let entry = FlowRouteEntry {
            stream_seq: 3,
            link_ids: vec!["link-0".to_string()],
            plane_b_link_ids: Some(vec!["link-2".to_string()]),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["streamSeq"], 3);
        assert_eq!(v["linkIds"][0], "link-0");
        assert_eq!(v["planeBLinkIds"][0], "link-2");
    }

    /// U5⑦：plane_b_link_ids=None 序列化为 null（前端 null 判断）。
    #[test]
    fn flow_route_entry_plane_b_null_when_none() {
        let entry = FlowRouteEntry {
            stream_seq: 0,
            link_ids: vec!["link-0".to_string()],
            plane_b_link_ids: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v["planeBLinkIds"].is_null());
    }

    // ── update_flow_stream 测试 ──────────────────────────────────────────────

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
            name: None,
            jitter_ns: None,
            src_ip: None,
            dst_ip: None,
            src_l4_port: None,
            dst_l4_port: None,
            l4_protocol: None,
            path_link_seqs: None,
            path_node_refs: None,
            clear_path: false,
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
            sqlx::query(
                "INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, \
                 frame_bytes, count, talker, listener, max_latency_us, src_mac) \
                 VALUES ('s1', 0, 'ST', 7, 500, 512, 10000, '1', '2', 1000, 'aa:bb:cc:dd:ee:ff')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let req = make_update_req();
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

    async fn read_stale(pool: &sqlx::Pool<sqlx::Sqlite>) -> i64 {
        sqlx::query_scalar("SELECT stale FROM gcl_plan_meta WHERE session_id='s1'")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// KTD14①：非规划字段（名称/MAC）变更 → planning_fields_changed=false、stale 不置位。
    #[test]
    fn update_non_planning_field_does_not_mark_stale() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_gcl_meta(&pool, "ok", 0).await;
            let req = UpdateFlowStreamRequest {
                name: Some("改名".to_string()),
                src_mac: Some("00:11:22:33:44:55".to_string()),
                ..make_update_req() // 规划字段与 add_stream 落库值一致（500/512/10000/None）
            };
            let result = update_flow_stream_inner(&pool, &req).await.unwrap();
            assert!(!result.planning_fields_changed);
            assert_eq!(read_stale(&pool).await, 0, "非规划字段不置 stale");
        });
    }

    /// KTD14②：改周期 → planning_fields_changed=true、stale=1（同事务持久化）。
    #[test]
    fn update_period_marks_stale() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_gcl_meta(&pool, "ok", 0).await;
            let req = UpdateFlowStreamRequest {
                period_us: 250,
                ..make_update_req()
            };
            let result = update_flow_stream_inner(&pool, &req).await.unwrap();
            assert!(result.planning_fields_changed);
            assert_eq!(read_stale(&pool).await, 1, "改周期须置 stale");
        });
    }

    /// KTD14③：路径变更（path_link_seqs）→ planning_fields_changed=true、stale=1；
    /// 无 meta 行时置位是 no-op（不报错）。
    #[test]
    fn update_path_marks_stale_and_noop_without_meta() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // 无 meta 行：路径变更照常成功（no-op 置位）。
            let req = UpdateFlowStreamRequest {
                path_link_seqs: Some(vec![0, 1]),
                ..make_update_req()
            };
            let result = update_flow_stream_inner(&pool, &req).await.unwrap();
            assert!(result.planning_fields_changed, "路径变更算规划字段变更");
            // 有 meta 行：clear_path 同样置位。
            add_gcl_meta(&pool, "ok", 0).await;
            let req = UpdateFlowStreamRequest {
                clear_path: true,
                ..make_update_req()
            };
            let result = update_flow_stream_inner(&pool, &req).await.unwrap();
            assert!(result.planning_fields_changed);
            assert_eq!(read_stale(&pool).await, 1, "路径变更须置 stale");
        });
    }

    // ── get_flow_path_candidates 测试（U10b）─────────────────────────────────

    /// 菱形拓扑（1-0-2 / 1-3-2 等长两条）→ 两条候选、显示名映射（0 有名、3 缺名回退 mid）。
    #[test]
    fn path_candidates_diamond_two_routes_with_names() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            for (mid, name) in [
                ("0", Some("SW-A")),
                ("1", Some("ES-1")),
                ("2", Some("ES-2")),
                ("3", None),
            ] {
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, ?, 0, 0, 'switch', 8, 8, 0)")
                    .bind(mid).bind(name).execute(&pool).await.unwrap();
            }
            for (seq, src, sp, dst, dp) in [
                (0, "1", 0, "0", 0),
                (1, "0", 1, "2", 0),
                (2, "1", 1, "3", 0),
                (3, "3", 1, "2", 1),
            ] {
                sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, '{}')")
                    .bind(seq).bind(src).bind(dst).bind(sp).bind(dp).execute(&pool).await.unwrap();
            }
            let r = get_flow_path_candidates_inner(&pool, "s1", "1", "2")
                .await
                .unwrap();
            assert!(!r.truncated);
            assert_eq!(r.candidates.len(), 2);
            assert_eq!(r.candidates[0].node_path, vec!["1", "0", "2"]);
            assert_eq!(
                r.candidates[0].node_path_names,
                vec!["ES-1", "SW-A", "ES-2"]
            );
            assert_eq!(r.candidates[0].link_seqs, vec![0, 1]);
            assert_eq!(r.candidates[1].node_path, vec!["1", "3", "2"]);
            assert_eq!(r.candidates[1].node_path_names, vec!["ES-1", "3", "ES-2"]);
        });
    }

    /// 9 条并行两跳路径 > 上限 8 → 截断标志置位、返回 8 条。
    #[test]
    fn path_candidates_truncated_at_limit() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            for mid in ["t", "l"] {
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, 'endSystem', 8, 8, 0)")
                    .bind(mid).execute(&pool).await.unwrap();
            }
            for i in 0..9i64 {
                let mid = format!("m{i}");
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, 'switch', 8, 8, 0)")
                    .bind(&mid).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, 't', ?, ?, 0, 1000, '{}')")
                    .bind(i * 2).bind(&mid).bind(i).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, ?, 'l', 1, ?, 1000, '{}')")
                    .bind(i * 2 + 1).bind(&mid).bind(i).execute(&pool).await.unwrap();
            }
            let r = get_flow_path_candidates_inner(&pool, "s1", "t", "l")
                .await
                .unwrap();
            assert!(r.truncated, "9 条候选超上限 8 应截断");
            assert_eq!(r.candidates.len(), 8);
        });
    }
}
