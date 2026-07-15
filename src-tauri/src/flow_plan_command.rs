//! `plan_tas`（U7）：让 INET Z3 配置器真算 802.1Qbv 门控表（GCL），app 读回落门控明细
//! 新表体系（`gcl_windows` / `gcl_plan_meta` / `gcl_raw_archive`，2026-07-14 U2）。
//!
//! 流程（KTD1 可测内核 + 注入式 client）：读流集 → **只保留 ST 流**（R4/KTD4：RC/BE 不进
//! synth bundle、不排窗；无 ST 流写 meta=`no_gating` 并清表，R5）→ 逐 ST 流推导路径
//! （U5，喂 pathFragments；双平面锁平面 A，KTD6）→ 组 synth flow+TAS bundle（U6）→
//! `InetSimPlanClient::plan_gcl` 跑配置器 + dump `.sca`（U1/U6 spike）→ 解析 GCL（ned→mid，
//! **含空 durations 恒态门**）→ **不可行/空则判 FAIL 不落空表（R10）** → 位图合成（KTD3
//! 切分点法）+ 流关联匹配（KTD5 首跳锚定 + 窗长指纹）→ 全量覆盖写三新表 + par 行存档。
//! `flow_plans` 停写退役（写事务内清残留行防旧管线消费中间态）。
//! 求解器出处（Z3 带保证 / Eager 无保证，R8）随结果 + 落库记录。
//! `.sca` 解析 / 位图合成 / 流关联匹配等 KTD3/KTD5 纯函数在 `gcl_synth` 模块。
//!
//! 对账（R9）是**辅助信号、测试/验收期**行为：docx 期望门窗是夹具（U10），运行期库里没有，
//! 故 `plan_tas` 不内联对账；`flow_reconcile` 供 U10 用综合结果对比冻结期望。

use serde::Serialize;
use sqlx::Row;
use std::collections::BTreeMap;

use crate::flow_route::{RouteRequest, link_plane, resolve_flow_path};
use crate::gcl_synth::{
    FlowMatchStream, GclWindowRow, match_flows_to_st_windows, parse_all_gates_from_sca,
    parse_production_offsets_from_sca, synthesize_gate_windows,
};
use crate::inet_sim_bundle::{
    FlowStreamSpec, FlowTasSchedule, GATE_CYCLE_NS, SimOverrides, build_flow_tas_sim_bundle,
    flow_frame_overhead_bytes, gcl_open_intervals, plan_flow_traffic,
};
use crate::inet_sim_command::{load_timing, load_topology};
use crate::inet_sim_http::InetSimPlanClient;

pub const CALIBER_FLOW_TAS_PLANNED: &str = "flow_tas_planned";

/// 门控新表体系的 provider 键值（KTD1/KTD6，进三表 PK）：本期唯一 provider；
/// castup 外部求解器接入时另立值。
pub(crate) const GCL_PROVIDER: &str = "inet-z3";

/// 规划结果（前端/agent 消费）。status 区分各态；solver 记出处（R8/KTD7 诚实边界）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    pub caliber: String,
    /// ok | no_streams | no_gating | no_gm | route_error | bundle_error | unreachable | solver_failed
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver: Option<String>,
    pub gate_count: usize,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PlanResult {
    fn simple(status: &str, overall: &str, message: Option<String>) -> Self {
        Self {
            caliber: CALIBER_FLOW_TAS_PLANNED.to_string(),
            status: status.to_string(),
            solver: None,
            gate_count: 0,
            overall: overall.to_string(),
            message,
        }
    }
}

/// 库内流行（flow_streams 子集，plan/verify 共用）。
pub(crate) struct DbStream {
    pub(crate) stream_seq: i64,
    pub(crate) class: String,
    pub(crate) pcp: i64,
    pub(crate) period_us: i64,
    pub(crate) frame_bytes: i64,
    pub(crate) count: i64,
    pub(crate) talker: String,
    pub(crate) listener: String,
    pub(crate) max_latency_us: Option<i64>,
    /// 显示名（NULL 回退 `{class}流{seq}` 默认名）；路径推导失败报错点名用（R16）。
    pub(crate) name: Option<String>,
    /// KTD6 凭证列（U2 录入时落）：仅展示，装配一律重推导（verify 侧重跑不相交断言）。
    #[allow(dead_code)]
    pub(crate) redundant: i64,
    /// paths 列（KTD12 统一形状）：RC=系统凭证（装配仍重推导）；ST/BE origin=user=
    /// 显式指定事实源，经 resolve_flow_path 进 pathFragments（R16）。
    pub(crate) paths: Option<String>,
}

pub(crate) async fn load_streams(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<Vec<DbStream>, String> {
    let rows = sqlx::query(
        "SELECT stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us, redundant, paths, name \
         FROM flow_streams WHERE session_id = ? ORDER BY stream_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读 flow_streams 失败：{e}"))?;
    Ok(rows
        .iter()
        .map(|r| DbStream {
            stream_seq: r.get("stream_seq"),
            class: r.get("class"),
            pcp: r.get("pcp"),
            period_us: r.get("period_us"),
            frame_bytes: r.get("frame_bytes"),
            count: r.get("count"),
            talker: r.get("talker"),
            listener: r.get("listener"),
            max_latency_us: r.get("max_latency_us"),
            redundant: r.get("redundant"),
            paths: r.get("paths"),
            name: r.get("name"),
        })
        .collect())
}

/// 端口键 `(node mid, ethN)` → 每门开窗区间集（位图合成中间形态）。
type PortGateIntervals = BTreeMap<(String, usize), BTreeMap<usize, Vec<(u64, u64)>>>;

/// 全量覆盖写门控新表体系（U2 落库切换）：事务内 undo 快照先行 → 清三新表该 session 行
/// + 清 `flow_plans` 残留（停写 ≠ 留残留，防陈旧 pin 中间态被旧管线静默消费）→ 按 status：
/// - `ok`：写 windows + meta（stale=0，KTD14 复位仅发生在规划成功事务内）+ raw 存档
///   （par 行集覆盖式最新一份）。
/// - `no_gating`：只写 meta，windows/raw 保持清空（R5）。
///
/// 失败态（solver_failed/unreachable）**不走本函数**——不写不清，保留上一次规划（R10/KTD1）。
async fn write_gcl_tables(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    status: &str,
    algorithm: &str,
    windows: &[GclWindowRow],
    par_lines: Option<&str>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("开事务失败：{e}"))?;
    // 写前快照（flow domain，撤销留位）。
    crate::topology_undo::snapshot_pre_image(
        &mut tx,
        session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    .map_err(|e| format!("快照失败：{e}"))?;
    for table in [
        "gcl_windows",
        "gcl_plan_meta",
        "gcl_raw_archive",
        "flow_plans",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?"))
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("清 {table} 失败：{e}"))?;
    }
    for w in windows {
        sqlx::query(
            "INSERT INTO gcl_windows (session_id, provider, node, eth_n, entry_idx, start_ns, duration_ns, gate_states, flow_refs) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(GCL_PROVIDER)
        .bind(&w.node)
        .bind(w.eth_n as i64)
        .bind(w.entry_idx as i64)
        .bind(w.start_ns as i64)
        .bind(w.duration_ns as i64)
        .bind(w.gate_states as i64)
        .bind(&w.flow_refs)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写 gcl_windows 失败：{e}"))?;
    }
    sqlx::query(
        "INSERT INTO gcl_plan_meta (session_id, provider, status, cycle_ns, algorithm, stale, created_at) \
         VALUES (?, ?, ?, ?, ?, 0, datetime('now'))",
    )
    .bind(session_id)
    .bind(GCL_PROVIDER)
    .bind(status)
    .bind(GATE_CYCLE_NS as i64)
    .bind(algorithm)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写 gcl_plan_meta 失败：{e}"))?;
    if let Some(par) = par_lines {
        sqlx::query(
            "INSERT INTO gcl_raw_archive (session_id, provider, par_lines, created_at) \
             VALUES (?, ?, ?, datetime('now'))",
        )
        .bind(session_id)
        .bind(GCL_PROVIDER)
        .bind(par)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写 gcl_raw_archive 失败：{e}"))?;
    }
    tx.commit().await.map_err(|e| format!("提交失败：{e}"))?;
    Ok(())
}

/// KTD14 stale 写手：置 `gcl_plan_meta.stale=1`（无行 no-op）。写手清单 = 加流 / 改规划
/// 字段或路径 / 拓扑结构变更（initialize 与增删链路）；删流清整张 meta 表故无需置位。
/// **复位仅发生在规划成功事务内**（`write_gcl_tables` 重写 meta 行 stale=0）。
pub(crate) async fn mark_gcl_stale<'e, E>(executor: E, session_id: &str) -> Result<(), String>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query("UPDATE gcl_plan_meta SET stale = 1 WHERE session_id = ?")
        .bind(session_id)
        .execute(executor)
        .await
        .map_err(|e| format!("置 gcl_plan_meta.stale 失败：{e}"))?;
    Ok(())
}

/// 可测内核：注入 `InetSimPlanClient`，编排 流集 → 路径 → synth bundle → 跑配置器 → 解析 → 落库。
pub async fn plan_tas_inner<P: InetSimPlanClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
    plan_client: &P,
    base_url: &str,
) -> Result<PlanResult, String> {
    let streams = load_streams(pool, session_id).await?;
    if streams.is_empty() {
        return Ok(PlanResult::simple(
            "no_streams",
            "还没有录入任何流，先录流再规划。",
            None,
        ));
    }

    // R4/KTD4：Z3 只喂 ST——RC/BE 完全不进 synth bundle（app/识别/编码都不出现）。
    // 会话是否有 RC 从**全流集**判（帧开销 +4B R-TAG 经 overrides.has_rc 传给 builder，U4）。
    let has_rc = streams.iter().any(|s| s.class == "RC");
    let st_streams: Vec<&DbStream> = streams.iter().filter(|s| s.class == "ST").collect();
    if st_streams.is_empty() {
        // R5：无 ST 流 → 跳过求解器，meta 记 no_gating、清 windows/raw 与 flow_plans 存量。
        write_gcl_tables(pool, session_id, "no_gating", "Z3", &[], None).await?;
        return Ok(PlanResult::simple(
            "no_gating",
            "流集无 ST 流，无需门控综合；可直接验证。",
            None,
        ));
    }

    let (nodes, links) = load_topology(pool, session_id).await?;
    let gm_mid: Option<String> =
        sqlx::query_scalar("SELECT gm_mid FROM timesync_domain WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读 GM 失败：{e}"))?
            .flatten();
    let Some(gm_mid) = gm_mid.filter(|g| !g.is_empty()) else {
        return Ok(PlanResult::simple(
            "no_gm",
            "未设 GM，请先在时间同步阶段设定 GM（流量软仿需非理想时钟同步）。",
            None,
        ));
    };
    let timing = load_timing(pool, session_id).await?;

    // 逐 ST 流推导路径（歧义/不可达响亮失败，surfaced）。喂 pathFragments。
    // KTD6：双平面拓扑（链路带 plane 键）上 plane=None 必然双路歧义——ST 锁平面 A
    // （docx Qbv 用例同路径）；单平面沿 plane 缺省（全链路）。先判后推，不做失败重试式。
    let dual_plane = links.iter().any(|l| link_plane(l).is_some());
    let plane = if dual_plane { Some("A") } else { None };
    let mut specs: Vec<FlowStreamSpec> = Vec::new();
    // 逐流 egress（(mid, ethN) 逐跳，与 specs 同序）——流关联匹配（KTD5）沿它推进（R16×R3）。
    let mut egress_of: Vec<Vec<(String, usize)>> = Vec::new();
    for s in &st_streams {
        // KTD11 统一路径解析出口：显式指定（paths.origin=user）优先、失效 PATH_STALE 响亮；
        // 未指定沿最短路推导。
        let route = resolve_flow_path(
            s.paths.as_deref(),
            &RouteRequest {
                talker: &s.talker,
                listener: &s.listener,
                plane,
            },
            &nodes,
            &links,
        );
        let path_fragments = match route {
            Ok(r) => {
                egress_of.push(r.egress);
                Some(r.node_path)
            }
            Err(errs) => {
                let msg = errs
                    .iter()
                    .map(|e| e.message_zh.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                // R16：报错点名流（F{seq}·{name}）+ 指定路径引导（错误码不动）。
                let name = s.name.clone().unwrap_or_else(|| {
                    crate::flow_query_command::default_stream_name(&s.class, s.stream_seq)
                });
                return Ok(PlanResult::simple(
                    "route_error",
                    "流路径推导失败（不可达或路径歧义），请在流详情中指定路径或调整拓扑。",
                    Some(format!("流 F{}·{name}：{msg}", s.stream_seq)),
                ));
            }
        };
        specs.push(FlowStreamSpec {
            stream_seq: s.stream_seq,
            class: s.class.clone(),
            pcp: s.pcp,
            talker: s.talker.clone(),
            listener: s.listener.clone(),
            period_us: s.period_us,
            frame_bytes: s.frame_bytes,
            count: s.count,
            max_latency_us: s.max_latency_us,
            path_fragments,
            frer_trees: None, // synth 无 FRER 段（RC 不进 bundle）；has_rc 只影响帧开销。
            pin_links: None,
        });
    }

    let sim_bundle = match build_flow_tas_sim_bundle(
        &nodes,
        &links,
        &gm_mid,
        &timing,
        &SimOverrides {
            has_rc,
            ..Default::default()
        },
        &specs,
        FlowTasSchedule::Synth,
        session_id,
        0,
    ) {
        Ok(b) => b,
        Err(errs) => {
            let msg = errs
                .iter()
                .map(|e| e.message_zh.clone())
                .collect::<Vec<_>>()
                .join("；");
            return Ok(PlanResult::simple(
                "bundle_error",
                "规划工程生成失败。",
                Some(msg),
            ));
        }
    };

    let plan = match plan_client.plan_gcl(base_url, &sim_bundle.bundle) {
        Ok(p) => p,
        Err(m) => {
            return Ok(PlanResult::simple(
                "unreachable",
                "规划暂时无法运行（软仿服务不可达），工程保持原状。",
                Some(m),
            ));
        }
    };

    // 不可行 / 求解器失败 / 无 GCL → FAIL，绝不落空/半截表（R10）。
    if plan.exit_code != 0 {
        return Ok(PlanResult::simple(
            "solver_failed",
            "门控综合失败：约束不可行或配置器出错，未产出门控表。",
            Some(plan.output_tail),
        ));
    }
    let solver = plan.solver.clone().unwrap_or_else(|| "Z3".to_string());
    let ned_to_mid: BTreeMap<String, String> = sim_bundle
        .node_ned_names
        .iter()
        .map(|(mid, ned)| (ned.clone(), mid.clone()))
        .collect();
    let sca = plan.sca_gcl.as_deref().unwrap_or_default();
    // 全门解析（含空 durations 恒态门，R2）；被调度门口径 = gate_count（与切表前一致）。
    let all_gates = parse_all_gates_from_sca(sca, &ned_to_mid, &solver);
    let gate_count = all_gates
        .iter()
        .filter(|g| !g.durations_ns.is_empty())
        .count();
    if gate_count == 0 {
        return Ok(PlanResult::simple(
            "solver_failed",
            "门控综合未产出可解析的门控表（约束可能不可行），未落库。",
            Some(plan.output_tail),
        ));
    }

    // 位图合成（KTD3）：全部门按端口分组展开开窗区间（恒态门 = 恒开/恒关）。
    let mut port_gates: PortGateIntervals = BTreeMap::new();
    for g in &all_gates {
        let ivs = match gcl_open_intervals(g) {
            Ok(v) => v,
            Err(e) => {
                // durations 与门控周期不符——结果无法逐窗展开，判 FAIL 不落库（R10 口径）。
                return Ok(PlanResult::simple(
                    "solver_failed",
                    "门控综合结果无法按门控周期展开，未落库。",
                    Some(e.message_zh),
                ));
            }
        };
        port_gates
            .entry((g.node.clone(), g.eth_n))
            .or_default()
            .insert(g.gate_index, ivs);
    }

    // ST 门（gate7）各端口开窗区间（按 start 升序，下标即窗身份）——流关联匹配靶面。
    let st_gate = crate::flow_verify::ST_PCP as usize;
    let mut st_open: BTreeMap<(String, usize), Vec<(u64, u64)>> = BTreeMap::new();
    for (port, gates) in &port_gates {
        if let Some(ivs) = gates.get(&st_gate)
            && !ivs.is_empty()
        {
            let mut sorted = ivs.clone();
            sorted.sort_unstable();
            st_open.insert(port.clone(), sorted);
        }
    }

    // 流关联匹配（KTD5）：偏移行经 plan_flow_traffic 同源放置（app 下标绝不各算一份）
    // 关联到流；帧传输时长简化按 1Gbps（8ns/B），开销含 R-TAG（有 RC 时）。
    let offset_by_key: BTreeMap<(String, usize), u64> = parse_production_offsets_from_sca(sca)
        .into_iter()
        .map(|(ned, app_idx, off)| ((ned, app_idx), off))
        .collect();
    let (_classes, placements, _node_apps) = plan_flow_traffic(&specs);
    let overhead = flow_frame_overhead_bytes(has_rc);
    let match_streams: Vec<FlowMatchStream> = specs
        .iter()
        .enumerate()
        .map(|(i, sp)| {
            let talker_ned = sim_bundle
                .node_ned_names
                .get(&sp.talker)
                .cloned()
                .unwrap_or_else(|| sp.talker.clone());
            FlowMatchStream {
                stream_seq: sp.stream_seq,
                period_ns: sp.period_us.max(0) as u64 * 1_000,
                tx_ns: (sp.frame_bytes + overhead).max(0) as u64 * 8,
                offset_ns: offset_by_key
                    .get(&(talker_ned, placements[i].talker_app))
                    .copied(),
                egress: egress_of[i].clone(),
            }
        })
        .collect();
    let flow_refs = match_flows_to_st_windows(&match_streams, &st_open, GATE_CYCLE_NS);

    // 逐窗行装配：切分点保证每个 ST 位开的窗 ⊆ 恰一个 ST 开窗区间，按包含取该区间引用。
    let mut window_rows: Vec<GclWindowRow> = Vec::new();
    for (port, gates) in &port_gates {
        for (idx, (start, dur, bits)) in synthesize_gate_windows(gates, GATE_CYCLE_NS)
            .into_iter()
            .enumerate()
        {
            let refs_json = if bits & (1 << st_gate) != 0 {
                st_open
                    .get(port)
                    .and_then(|ivs| {
                        ivs.iter()
                            .position(|&(a, b)| a <= start && start + dur <= b)
                    })
                    .and_then(|iv_idx| flow_refs.get(&(port.0.clone(), port.1, iv_idx)))
                    .filter(|v| !v.is_empty())
                    .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()))
            } else {
                None
            };
            window_rows.push(GclWindowRow {
                node: port.0.clone(),
                eth_n: port.1,
                entry_idx: idx,
                start_ns: start,
                duration_ns: dur,
                gate_states: bits,
                flow_refs: refs_json,
            });
        }
    }

    write_gcl_tables(
        pool,
        session_id,
        "ok",
        &solver,
        &window_rows,
        plan.sca_gcl.as_deref(),
    )
    .await?;

    let guarantee = if solver == "Z3" {
        "带可调度性保证"
    } else {
        "兜底解、无保证"
    };
    Ok(PlanResult {
        caliber: CALIBER_FLOW_TAS_PLANNED.to_string(),
        status: "ok".to_string(),
        solver: Some(solver),
        gate_count,
        overall: format!("已综合 {gate_count} 个门控条目（{guarantee}）。"),
        message: None,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTasRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn plan_tas(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: PlanTasRequest,
) -> Result<PlanResult, String> {
    let pool = store.pool(&app).await?;
    let Some(base_url) = crate::inet_sim_http_config::resolve_inet_sim_http_url(pool).await? else {
        return Ok(PlanResult::simple(
            "no_service",
            "未配置软仿 HTTP 服务地址，请在设置里填写。",
            Some("InetSimHttpConfig.base_url 为空。".to_string()),
        ));
    };
    plan_tas_inner(
        pool,
        &request.session_id,
        &crate::inet_sim_http::ReqwestInetSimClient,
        &base_url,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inet_sim_http::HttpPlanResult;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    // ---------- plan_tas_inner（MockPlanClient 注入）----------

    struct MockPlanClient {
        result: Result<HttpPlanResult, String>,
    }
    impl InetSimPlanClient for MockPlanClient {
        fn plan_gcl(
            &self,
            _base_url: &str,
            _bundle: &crate::inet_remote::InetBundle,
        ) -> Result<HttpPlanResult, String> {
            self.result.clone()
        }
    }

    /// 捕获送去求解的 ini（断言 synth bundle 形态；ini 为 None 即求解器未被调用）。
    struct CapturingPlanClient {
        result: Result<HttpPlanResult, String>,
        ini: std::sync::Mutex<Option<String>>,
    }
    impl InetSimPlanClient for CapturingPlanClient {
        fn plan_gcl(
            &self,
            _base_url: &str,
            bundle: &crate::inet_remote::InetBundle,
        ) -> Result<HttpPlanResult, String> {
            *self.ini.lock().unwrap() = Some(bundle.omnetpp_ini.clone());
            self.result.clone()
        }
    }

    fn ok_plan_result() -> Result<HttpPlanResult, String> {
        // sw1 gate7 的 .sca（ST 门；ned sw1 → mid 0）。
        let sca = "par N.sw1.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[7] durations \"[300us, 700us]\"\n";
        Ok(HttpPlanResult {
            exit_code: 0,
            output_tail: "ok".into(),
            sca_gcl: Some(sca.into()),
            solver: Some("Z3".into()),
        })
    }

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

    /// AE2：约束可满足 → Z3 出 GCL，出处记 Z3，落门控新表（U2：flow_plans 停写、
    /// 残留清空；windows 位图逐窗 + meta + raw 存档齐全）。
    #[test]
    fn plan_tas_synthesizes_and_persists() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // flow_plans 残留（旧管线）——写路径须清（停写 ≠ 留残留）。
            sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 7, 1, 0, '[1]', 'Z3')")
                .execute(&pool).await.unwrap();
            // KTD14：预置 stale=1 的旧 meta——规划成功须复位为 0（覆盖式重写）。
            sqlx::query("INSERT INTO gcl_plan_meta (session_id, provider, status, cycle_ns, algorithm, stale, created_at) VALUES ('s1', 'inet-z3', 'ok', 1000000, 'Z3', 1, 'now')")
                .execute(&pool).await.unwrap();
            // mock 服务回 sw1 gate 的 .sca（node ned sw1 → mid 0）。
            let sca = "par N.sw1.eth[1].macLayer.queue.transmissionGate[0] initiallyOpen true\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] offset 0s\npar N.sw1.eth[1].macLayer.queue.transmissionGate[0] durations \"[300us, 700us]\"\n";
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                    solver: Some("Z3".into()),
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(r.solver.as_deref(), Some("Z3"));
            assert_eq!(r.gate_count, 1);
            // flow_plans 停写且残留被清。
            let plans_left: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_plans WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(plans_left, 0, "flow_plans 停写且残留清空");
            // gcl_windows：gate0 开窗 [0,300us) → 两窗（0x01 / 0x00），node=mid 0。
            let wins: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT node, eth_n, entry_idx, start_ns, duration_ns, gate_states \
                 FROM gcl_windows WHERE session_id='s1' AND provider='inet-z3' ORDER BY entry_idx",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            assert_eq!(
                wins,
                vec![
                    ("0".into(), 1, 0, 0, 300_000, 0x01),
                    ("0".into(), 1, 1, 300_000, 700_000, 0x00),
                ]
            );
            // meta：status ok / cycle / algorithm / stale=0。
            let (status, cycle, algo, stale): (String, i64, String, i64) = sqlx::query_as(
                "SELECT status, cycle_ns, algorithm, stale FROM gcl_plan_meta WHERE session_id='s1' AND provider='inet-z3'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                (status.as_str(), cycle, algo.as_str(), stale),
                ("ok", 1_000_000, "Z3", 0)
            );
            // raw 存档 = 服务返回的 par 行集原文。
            let par: String = sqlx::query_scalar(
                "SELECT par_lines FROM gcl_raw_archive WHERE session_id='s1' AND provider='inet-z3'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(par, sca);
        });
    }

    /// R16：等长多路径（歧义）→ route_error，message 点名流 F{seq}·{name} 并引导
    /// 「请在流详情中指定路径」（错误码不动）。
    #[test]
    fn plan_tas_route_error_names_stream_and_guides_to_path_pick() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 菱形：1—0—2 与 1—3—2 两条等长路径（无 plane 键 → AMBIGUOUS_ROUTE）。
            for (mid, ty, ord) in [
                ("0", "switch", 0),
                ("1", "endSystem", 1),
                ("2", "endSystem", 2),
                ("3", "switch", 3),
            ] {
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                    .bind(mid).bind(ty).bind(ord).execute(&pool).await.unwrap();
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
            sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '1')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, name) VALUES ('s1', 0, 'ST', 7, 500, 512, 10000, '1', '2', '视频流')")
                .execute(&pool).await.unwrap();
            let client = MockPlanClient {
                result: Err("不该被调用".into()),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "route_error", "{r:?}");
            assert!(
                r.overall.contains("请在流详情中指定路径"),
                "overall 应含指定路径引导：{r:?}"
            );
            let msg = r.message.as_deref().unwrap_or_default();
            assert!(msg.contains("F0·视频流"), "message 应点名流：{msg}");
        });
    }

    /// AE2/R10：约束不可行（exit≠0）→ FAIL，不落空表。
    #[test]
    fn plan_tas_infeasible_fails_without_empty_table() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "UNSAT".into(),
                    sca_gcl: None,
                    solver: None,
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
            for table in [
                "flow_plans",
                "gcl_windows",
                "gcl_plan_meta",
                "gcl_raw_archive",
            ] {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM {table} WHERE session_id='s1'"
                ))
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(count, 0, "不可行不得落空/半截 {table}（R10）");
            }
        });
    }

    /// KTD1/KTD14：失败态**不写不清**——上一次规划（windows/meta/raw）原样保留，
    /// 且已置位的 stale 保持 true（复位仅发生在规划成功事务内）。
    #[test]
    fn plan_tas_failure_preserves_previous_plan_and_stale() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            sqlx::query("INSERT INTO gcl_windows (session_id, provider, node, eth_n, entry_idx, start_ns, duration_ns, gate_states, flow_refs) VALUES ('s1', 'inet-z3', '0', 1, 0, 0, 1000000, 255, NULL)")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO gcl_plan_meta (session_id, provider, status, cycle_ns, algorithm, stale, created_at) VALUES ('s1', 'inet-z3', 'ok', 1000000, 'Z3', 1, 'now')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO gcl_raw_archive (session_id, provider, par_lines, created_at) VALUES ('s1', 'inet-z3', 'prev-par', 'now')")
                .execute(&pool).await.unwrap();
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "UNSAT".into(),
                    sca_gcl: None,
                    solver: None,
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
            let wins: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM gcl_windows WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(wins, 1, "失败不得清上一次 windows");
            let (status, stale): (String, i64) =
                sqlx::query_as("SELECT status, stale FROM gcl_plan_meta WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                (status.as_str(), stale),
                ("ok", 1),
                "meta 原样、stale 保持 true"
            );
            let par: String =
                sqlx::query_scalar("SELECT par_lines FROM gcl_raw_archive WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(par, "prev-par", "失败不得动 raw 存档");
        });
    }

    /// KTD2/R4：raw 存档覆盖式最新一份——旧存档被新规划的 par 行集替换。
    #[test]
    fn plan_tas_overwrites_raw_archive() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            sqlx::query("INSERT INTO gcl_raw_archive (session_id, provider, par_lines, created_at) VALUES ('s1', 'inet-z3', 'stale-par', 'now')")
                .execute(&pool).await.unwrap();
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let pars: Vec<String> =
                sqlx::query_scalar("SELECT par_lines FROM gcl_raw_archive WHERE session_id='s1'")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(pars.len(), 1, "覆盖式只留一份");
            assert!(pars[0].contains("transmissionGate[7]"), "{}", pars[0]);
            assert!(!pars[0].contains("stale-par"));
        });
    }

    /// U2 端到端（Covers R3/R16×R3）：偏移行齐全 + 两跳窗长指纹匹配 → flow_refs 落
    /// derived；关窗行 flow_refs=NULL；恒态位/开窗位图正确。
    #[test]
    fn plan_tas_writes_derived_flow_refs() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            // 周期 = 门控周期（单实例），frame 512 → tx = (512+58)*8 = 4560ns。
            sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'ST', 7, 1000, 512, 100, '1', '2')")
                .execute(&pool).await.unwrap();
            // es1（talker mid 1）eth0 ST 窗 [0,4.56us)；sw1（mid 0）eth1 ST 窗
            // [10us,14.56us)（窗长 = tx 指纹）；talker 偏移 0（裸秒 dump 形态）。
            let sca = "par N.es1.eth[0].macLayer.queue.transmissionGate[7] initiallyOpen true\n\
                par N.es1.eth[0].macLayer.queue.transmissionGate[7] offset 0s\n\
                par N.es1.eth[0].macLayer.queue.transmissionGate[7] durations \"[4.56us, 995.44us]\"\n\
                par N.sw1.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen false\n\
                par N.sw1.eth[1].macLayer.queue.transmissionGate[7] offset 0s\n\
                par N.sw1.eth[1].macLayer.queue.transmissionGate[7] durations \"[10us, 4.56us, 985.44us]\"\n\
                par N.es1.app[0].source initialProductionOffset 0\n";
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                    solver: Some("Z3".into()),
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            // sw1(mid 0) eth1：三窗，开窗（idx1）带 derived 引用。
            let (bits, refs): (i64, Option<String>) = sqlx::query_as(
                "SELECT gate_states, flow_refs FROM gcl_windows WHERE session_id='s1' AND node='0' AND eth_n=1 AND entry_idx=1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(bits, 0x80);
            assert_eq!(refs.as_deref(), Some(r#"[{"seq":0,"source":"derived"}]"#));
            // es1(mid 1) eth0：首窗（首跳锚定）带 derived 引用。
            let (bits, refs): (i64, Option<String>) = sqlx::query_as(
                "SELECT gate_states, flow_refs FROM gcl_windows WHERE session_id='s1' AND node='1' AND eth_n=0 AND entry_idx=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(bits, 0x80);
            assert_eq!(refs.as_deref(), Some(r#"[{"seq":0,"source":"derived"}]"#));
            // 关窗行 flow_refs = NULL。
            let refs: Option<String> = sqlx::query_scalar(
                "SELECT flow_refs FROM gcl_windows WHERE session_id='s1' AND node='0' AND eth_n=1 AND entry_idx=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(refs.is_none(), "关窗行不得有流引用");
        });
    }

    /// KTD5 ⑤ 端到端：偏移行整体缺失（旧服务/格式变化）→ 流降级 class、落库不失败。
    #[test]
    fn plan_tas_missing_offsets_degrade_to_class() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // ok_plan_result 的 sca 只有门参数行、无 initialProductionOffset。
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let refs: Option<String> = sqlx::query_scalar(
                "SELECT flow_refs FROM gcl_windows WHERE session_id='s1' AND node='0' AND eth_n=1 AND entry_idx=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(refs.as_deref(), Some(r#"[{"seq":0,"source":"class"}]"#));
        });
    }

    /// exit=0 但 .sca 无可解析门（空 GCL）→ FAIL，不落表（R10）。
    #[test]
    fn plan_tas_empty_gcl_fails() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(
                        "par N.sw1.eth[0].macLayer.queue.transmissionGate[0] durations []\n".into(),
                    ),
                    solver: Some("Z3".into()),
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
        });
    }

    /// 无流 → no_streams。
    #[test]
    fn plan_tas_no_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: String::new(),
                    sca_gcl: None,
                    solver: None,
                }),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "no_streams");
        });
    }

    /// Covers R4/KTD4（U3①）：ST+RC+BE 混合集 → synth ini 只出现 ST 的 app/识别/门控条目，
    /// RC/BE 完全不进 bundle（端口 1001/1002 与 pcp 6/0 均不得出现）。
    #[test]
    fn plan_synth_ini_only_contains_st_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_stream(&pool, 1, "RC", 6).await;
            add_stream(&pool, 2, "BE", 0).await;
            let client = CapturingPlanClient {
                result: ok_plan_result(),
                ini: std::sync::Mutex::new(None),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = client.ini.lock().unwrap().clone().expect("求解器应被调用");
            // specs 只含 ST → 稠密端口只有 1000；RC/BE 若混入会占 1001/1002。
            assert!(ini.contains("destPort = 1000"), "{ini}");
            assert!(!ini.contains("destPort = 1001"), "RC 不得进 bundle：{ini}");
            assert!(!ini.contains("destPort = 1002"), "BE 不得进 bundle：{ini}");
            // 只 1 个源 app；识别/编码/配置器均无 RC(pcp6)/BE(pcp0) 条目。
            assert_eq!(ini.matches("UdpSourceApp").count(), 1, "{ini}");
            assert!(ini.contains("pcp: 7"), "{ini}");
            assert!(!ini.contains("pcp: 6"), "{ini}");
            assert!(!ini.contains("pcp: 0"), "{ini}");
        });
    }

    /// Covers R5（U3②）：纯 BE / 纯 RC 流集 → no_gating、flow_plans 与门控新表存量清空、
    /// meta 记 status=no_gating、求解器不被调用。
    #[test]
    fn plan_without_st_returns_no_gating_and_clears_plans() {
        tauri::async_runtime::block_on(async {
            for (class, pcp) in [("BE", 0i64), ("RC", 6i64)] {
                let pool = fresh_pool().await;
                seed_linear(&pool).await;
                add_stream(&pool, 0, class, pcp).await;
                // 存量（旧规划残留：flow_plans + 新表三张）——no_gating 应全部清掉。
                sqlx::query("INSERT INTO flow_plans (session_id, stream_seq, node, eth_n, gate_index, initially_open, offset_ns, durations_ns, solver) VALUES ('s1', 0, '0', 1, 7, 1, 0, '[300000,700000]', 'Z3')")
                    .execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO gcl_windows (session_id, provider, node, eth_n, entry_idx, start_ns, duration_ns, gate_states, flow_refs) VALUES ('s1', 'inet-z3', '0', 1, 0, 0, 1000000, 255, NULL)")
                    .execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO gcl_raw_archive (session_id, provider, par_lines, created_at) VALUES ('s1', 'inet-z3', 'old', 'now')")
                    .execute(&pool).await.unwrap();
                let client = CapturingPlanClient {
                    result: ok_plan_result(),
                    ini: std::sync::Mutex::new(None),
                };
                let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                    .await
                    .unwrap();
                assert_eq!(r.status, "no_gating", "纯 {class}：{r:?}");
                assert!(r.overall.contains("无需门控"), "{r:?}");
                for table in ["flow_plans", "gcl_windows", "gcl_raw_archive"] {
                    let count: i64 = sqlx::query_scalar(&format!(
                        "SELECT COUNT(*) FROM {table} WHERE session_id='s1'"
                    ))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                    assert_eq!(count, 0, "纯 {class} 应清空 {table}");
                }
                let status: String = sqlx::query_scalar(
                    "SELECT status FROM gcl_plan_meta WHERE session_id='s1' AND provider='inet-z3'",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(status, "no_gating", "纯 {class} meta 应记 no_gating");
                assert!(
                    client.ini.lock().unwrap().is_none(),
                    "纯 {class} 不应调用求解器"
                );
            }
        });
    }

    /// Covers KTD6（U3⑦）：双平面拓扑（链路带 plane 键）ST 规划 → 锁平面 A 推路径
    /// （pathFragments 走 A 路交换机），无 AMBIGUOUS_ROUTE。
    #[test]
    fn plan_dual_plane_st_locks_plane_a() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // es1(0) =A= sw1(2) =A= es2(1)；es1 =B= sw2(3) =B= es2。GM=0。
            for (mid, ty, ord) in [
                ("0", "endSystem", 0),
                ("1", "endSystem", 1),
                ("2", "switch", 2),
                ("3", "switch", 3),
            ] {
                sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', ?, NULL, 0, 0, ?, 8, 8, ?)")
                    .bind(mid).bind(ty).bind(ord).execute(&pool).await.unwrap();
            }
            for (seq, src, sp, dst, dp, plane) in [
                (0, "0", 0, "2", 0, "A"),
                (1, "2", 1, "1", 0, "A"),
                (2, "0", 1, "3", 0, "B"),
                (3, "3", 1, "1", 1, "B"),
            ] {
                sqlx::query("INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) VALUES ('s1', ?, NULL, ?, ?, ?, ?, 1000, ?)")
                    .bind(seq).bind(src).bind(dst).bind(sp).bind(dp)
                    .bind(format!(r#"{{"plane":"{plane}"}}"#))
                    .execute(&pool).await.unwrap();
            }
            sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '0')")
                .execute(&pool)
                .await
                .unwrap();
            for mid in ["0", "1", "2", "3"] {
                sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', ?, '[]', '[]')")
                    .bind(mid).execute(&pool).await.unwrap();
            }
            // ST 流 es1(0) → es2(1)（add_stream helper 固定 1→2，与此拓扑不符，直插）。
            sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'ST', 7, 500, 512, 10000, '0', '1')")
                .execute(&pool).await.unwrap();
            let client = CapturingPlanClient {
                result: ok_plan_result(),
                ini: std::sync::Mutex::new(None),
            };
            let r = plan_tas_inner(&pool, "s1", &client, "http://x")
                .await
                .unwrap();
            assert_eq!(r.status, "ok", "双平面不该 AMBIGUOUS_ROUTE：{r:?}");
            let ini = client.ini.lock().unwrap().clone().unwrap();
            assert!(
                ini.contains(r#"pathFragments: [["es1", "sw1", "es2"]]"#),
                "应锁平面 A（es1→sw1→es2）：{ini}"
            );
            // 唯一一条 pathFragments（上面已断言其为 A 路）→ 没有第二条走平面 B 的路径。
            assert_eq!(ini.matches("pathFragments").count(), 1, "{ini}");
        });
    }
}
