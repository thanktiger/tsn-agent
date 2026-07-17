//! `plan_tas`（U7）：让 INET Z3 配置器真算 802.1Qbv 门控表（GCL），app 读回落门控结果
//! 单表 `flow_gcl_plan`（2026-07-15 单表化）+ raw par 行出库文件（`gcl_raw_store`）。
//!
//! 流程（KTD1 可测内核 + 注入式 client）：读流集 → **只保留 ST 流**（R4/KTD4：RC/BE 不进
//! synth bundle、不排窗；无 ST 流写行 status=`no_gating` 并删 raw 文件，R5）→ 逐 ST 流推导
//! 路径（U5，喂 pathFragments；双平面锁平面 A，KTD6）→ `InetSimPlanClient::plan_gcl` 跑
//! 配置器 + dump `.sca`（U1/U6 spike）→ 解析 GCL（ned→mid，**含空 durations 恒态门**）→
//! **不可行/空则判 FAIL 不落空表（R10）** → 位图合成（KTD3 切分点法）+ 流关联匹配（KTD5
//! 首跳锚定 + 窗长指纹）→ 覆盖写 `flow_gcl_plan` 单行（windows_json）+ raw 写文件。
//! 求解器出处（Z3 带保证 / Eager 无保证，R8）随结果 + 落库记录。
//! `.sca` 解析 / 位图合成 / 流关联匹配等 KTD3/KTD5 纯函数在 `gcl_synth` 模块。
//!
//! 对账（R9）是**辅助信号、测试/验收期**行为：docx 期望门窗是夹具（U10），运行期库里没有，
//! 故 `plan_tas` 不内联对账；`flow_reconcile` 供 U10 用综合结果对比冻结期望。

use serde::Serialize;
use sqlx::Row;
use std::collections::BTreeMap;

use crate::flow_route::{RouteRequest, paths_json, resolve_flow_path, single_path_plane};
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

/// 门控结果的 provider 键值（KTD1/KTD6，进 `flow_gcl_plan` PK 与 raw 文件名）：
/// 本期唯一 provider；castup 外部求解器接入时另立值。
pub(crate) const GCL_PROVIDER: &str = "inet-z3";

/// 求解器选择（R8 修订：用户显式选择、不做静默降级——Z3 unsat 时明确报错并提示可切换）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GclSolverChoice {
    #[default]
    Z3,
    Eager,
}

impl GclSolverChoice {
    /// 请求字符串 → 选择（None/缺省 = Z3，兼容旧调用方）；未知值响亮拒绝。
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("inet-z3") => Ok(Self::Z3),
            Some("inet-eager") => Ok(Self::Eager),
            Some(other) => Err(format!(
                "未知求解器「{other}」（可选：inet-z3 / inet-eager）。"
            )),
        }
    }

    /// 出处标签（落库 algorithm 列 + 结果 solver 字段，徽章据此分「带保证/无保证」）。
    fn label(self) -> &'static str {
        match self {
            Self::Z3 => "Z3",
            Self::Eager => "Eager",
        }
    }
}

/// Z3 约束不可满足的错误指纹（Z3GateScheduleConfigurator cRuntimeError 原文）。
const Z3_UNSAT_MARKER: &str = "The specified constraints might not be satisfiable";

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
    /// paths 列（KTD12 裸数组凭证）：RC=系统凭证（装配仍重推导）；ST/BE=路径凭证
    /// （复验直用/失效静默重推导+回写刷新），经 resolve_flow_path 进 pathFragments（R16）。
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

/// 覆盖写门控结果单行（2026-07-15 单表化）：事务内 undo 快照先行 → DELETE 该 session
/// 的 `flow_gcl_plan` 行 → INSERT 单行（windows 序列化进 `windows_json`）→ **提交前**
/// 写/删 raw 文件 → commit。按 status：
/// - `ok`：行 stale=0（KTD14 复位仅发生在规划成功事务内）+ raw par 行覆盖写文件。
/// - `no_gating`：行 windows_json='[]' + 删 raw 文件（R5）。
///
/// raw 文件在 commit 前操作：文件写失败则不提交（事务随 drop 回滚），DB 与文件不会
/// 出现「行是新规划、文件是旧存档」的错配；文件成功后 commit 失败仅多留一份将被
/// 下次覆盖的文件（verify 读它会与旧行 algorithm 组合，属可接受窗口——重规划即对齐）。
///
/// 失败态（solver_failed/unreachable）**不走本函数**——不写不清，保留上一次规划（R10/KTD1）。
///
/// `path_writebacks`：路径凭证沉淀/刷新（(stream_seq, paths JSON 裸数组)），与规划写同一
/// 事务——存量 NULL 流规划一次即沉淀、失效凭证自动刷新；有效凭证不回写（由调用方
/// credential_needs_refresh 过滤，保住用户绕路选择的稳定性）。
#[allow(clippy::too_many_arguments)]
async fn write_gcl_plan(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    base_dir: &std::path::Path,
    session_id: &str,
    status: &str,
    algorithm: &str,
    windows: &[GclWindowRow],
    par_lines: Option<&str>,
    path_writebacks: &[(i64, String)],
) -> Result<(), String> {
    let windows_json =
        serde_json::to_string(windows).map_err(|e| format!("序列化 windows_json 失败：{e}"))?;
    let mut tx = pool.begin().await.map_err(|e| format!("开事务失败：{e}"))?;
    // 写前快照（flow domain，撤销留位；raw 文件不参与 undo）。
    crate::topology_undo::snapshot_pre_image(
        &mut tx,
        session_id,
        crate::topology_undo::FLOW_DOMAIN,
    )
    .await
    .map_err(|e| format!("快照失败：{e}"))?;
    for (stream_seq, paths_json) in path_writebacks {
        sqlx::query("UPDATE flow_streams SET paths = ? WHERE session_id = ? AND stream_seq = ?")
            .bind(paths_json)
            .bind(session_id)
            .bind(stream_seq)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("回写路径凭证失败：{e}"))?;
    }
    sqlx::query("DELETE FROM flow_gcl_plan WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清 flow_gcl_plan 失败：{e}"))?;
    sqlx::query(
        "INSERT INTO flow_gcl_plan (session_id, provider, status, cycle_ns, algorithm, stale, created_at, windows_json) \
         VALUES (?, ?, ?, ?, ?, 0, datetime('now'), ?)",
    )
    .bind(session_id)
    .bind(GCL_PROVIDER)
    .bind(status)
    .bind(GATE_CYCLE_NS as i64)
    .bind(algorithm)
    .bind(&windows_json)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写 flow_gcl_plan 失败：{e}"))?;
    // raw 文件（提交前，见函数注释）：有 par 覆盖写；无（no_gating）删旧文件。
    match par_lines {
        Some(par) => crate::gcl_raw_store::write_raw(base_dir, session_id, GCL_PROVIDER, par)?,
        None => crate::gcl_raw_store::remove_raw(base_dir, session_id, GCL_PROVIDER)?,
    }
    tx.commit().await.map_err(|e| format!("提交失败：{e}"))?;
    Ok(())
}

/// KTD14 stale 写手：置 `flow_gcl_plan.stale=1`（无行 no-op）。写手清单 = 加流 / 改规划
/// 字段或路径 / 拓扑结构变更（initialize 与增删链路）；删流清整行故无需置位。
/// **复位仅发生在规划成功事务内**（`write_gcl_plan` 重写行 stale=0）。
pub(crate) async fn mark_gcl_stale<'e, E>(executor: E, session_id: &str) -> Result<(), String>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query("UPDATE flow_gcl_plan SET stale = 1 WHERE session_id = ?")
        .bind(session_id)
        .execute(executor)
        .await
        .map_err(|e| format!("置 flow_gcl_plan.stale 失败：{e}"))?;
    Ok(())
}

/// 路径凭证回写判定：paths 为 NULL（存量未沉淀）或不可解析（自愈）→ 回写；
/// 凭证复验失败（拓扑变更后失效，resolve 已静默重推导）→ 回写刷新。
/// 凭证有效 → **不回写不比对**——resolve 直用凭证，用户指定的绕路（非最短路）在
/// 拓扑不变时保持稳定，不被每次规划的最短路推导反复覆盖。
fn credential_needs_refresh(
    stream_paths: Option<&str>,
    talker: &str,
    listener: &str,
    links: &[crate::topology_verify::VerifyLink],
) -> bool {
    let Some(json) = stream_paths else {
        return true;
    };
    let Some(routes) = crate::flow_route::parse_flow_paths(json) else {
        return true;
    };
    let Some(first) = routes.first() else {
        return true;
    };
    crate::flow_route::build_route_from_link_seqs(&first.link_seqs, talker, listener, links)
        .is_err()
}

/// 可测内核：注入 `InetSimPlanClient`，编排 流集 → 路径 → synth bundle → 跑配置器 → 解析 → 落库。
/// `base_dir` = raw 文件存档根（生产由 AppHandle 解析、测试传 tempdir，见 `gcl_raw_store`）。
pub async fn plan_tas_inner<P: InetSimPlanClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    base_dir: &std::path::Path,
    session_id: &str,
    plan_client: &P,
    base_url: &str,
    solver_choice: GclSolverChoice,
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
    let (nodes, links) = load_topology(pool, session_id).await?;
    // KTD6：双平面拓扑（链路带 plane 键）上 plane=None 必然双路歧义——ST/BE 锁平面 A
    // （single_path_plane，与录入沉淀同口径）；单平面沿 plane 缺省（全链路）。
    let plane = single_path_plane(&links);

    // BE 路径凭证轻量回写（决定：BE 不进 Z3、路径仅展示/castup 用，推导失败——歧义/
    // 不可达/user 凭证失效——一律跳过不阻塞规划；沉淀主口在录入侧，此处兜存量 NULL/过期）。
    let mut path_writebacks: Vec<(i64, String)> = Vec::new();
    for s in streams.iter().filter(|s| s.class == "BE") {
        if let Ok(route) = resolve_flow_path(
            s.paths.as_deref(),
            &RouteRequest {
                talker: &s.talker,
                listener: &s.listener,
                plane,
            },
            &nodes,
            &links,
        ) && credential_needs_refresh(s.paths.as_deref(), &s.talker, &s.listener, &links)
        {
            path_writebacks.push((s.stream_seq, paths_json(std::slice::from_ref(&route))));
        }
    }

    if st_streams.is_empty() {
        // R5：无 ST 流 → 跳过求解器，行记 no_gating（windows_json='[]'）、删 raw 文件。
        write_gcl_plan(
            pool,
            base_dir,
            session_id,
            "no_gating",
            "Z3",
            &[],
            None,
            &path_writebacks,
        )
        .await?;
        return Ok(PlanResult::simple(
            "no_gating",
            "流集无 ST 流，无需门控综合；可直接验证。",
            None,
        ));
    }

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
    // R16：循环不早退——收集**全部** route 失败流，一次报全（枚举全部歧义流名），
    // 不挤牙膏式一次只报一条。
    let mut specs: Vec<FlowStreamSpec> = Vec::new();
    // 逐流 egress（(mid, ethN) 逐跳，与 specs 同序）——流关联匹配（KTD5）沿它推进（R16×R3）。
    let mut egress_of: Vec<Vec<(String, usize)>> = Vec::new();
    let mut route_failures: Vec<String> = Vec::new();
    for s in &st_streams {
        // KTD11 统一路径解析出口：凭证复验直用（用户绕路稳定沿用）、失效静默重推导；
        // NULL 沿最短路推导。
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
                // 回写沉淀：NULL 首次规划落凭证 / 失效凭证刷新（有效凭证不回写）。
                if credential_needs_refresh(s.paths.as_deref(), &s.talker, &s.listener, &links) {
                    path_writebacks.push((s.stream_seq, paths_json(std::slice::from_ref(&r))));
                }
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
                route_failures.push(format!("流 F{}·{name}：{msg}", s.stream_seq));
                continue;
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
            production_offset_ns: None, // synth：Z3 现算自设，不预置。
        });
    }
    if !route_failures.is_empty() {
        return Ok(PlanResult::simple(
            "route_error",
            "流路径推导失败（不可达或路径歧义），请在流详情中指定路径或调整拓扑。",
            Some(route_failures.join("；")),
        ));
    }

    let sim_bundle = match build_flow_tas_sim_bundle(
        &nodes,
        &links,
        &gm_mid,
        &timing,
        &SimOverrides {
            has_rc,
            eager_solver: solver_choice == GclSolverChoice::Eager,
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
    // Z3 不可满足单独给明确文案（R8 修订：不静默降级，把切换权交给用户）。
    if plan.exit_code != 0 {
        let message = if plan.output_tail.contains(Z3_UNSAT_MARKER) {
            "Z3 判定约束不可满足（unsat）：当前流集在零抖动/时延上界约束下无解。             可在求解器选择中切换「INET·Eager（贪心，无保证）」重试，             或调整流参数（减少流条数 / 放宽周期 / 调整路径）。"
        } else {
            "门控综合失败：约束不可行或配置器出错，未产出门控表。"
        };
        return Ok(PlanResult::simple(
            "solver_failed",
            message,
            Some(plan.output_tail),
        ));
    }
    // 出处 = 用户选择（app 写的 ini app 知道；不再信服务端回传字段——它对 Eager 不知情）。
    let solver = solver_choice.label().to_string();
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

    write_gcl_plan(
        pool,
        base_dir,
        session_id,
        "ok",
        &solver,
        &window_rows,
        plan.sca_gcl.as_deref(),
        &path_writebacks,
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
    /// 求解器选择："inet-z3"（缺省，SAT 带保证）/ "inet-eager"（贪心，无保证）。
    #[serde(default)]
    pub solver: Option<String>,
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
    let base_dir = crate::gcl_raw_store::resolve_base_dir(&app)?;
    let solver_choice = match GclSolverChoice::parse(request.solver.as_deref()) {
        Ok(c) => c,
        Err(m) => return Ok(PlanResult::simple("solver_failed", &m, None)),
    };
    plan_tas_inner(
        pool,
        &base_dir,
        &request.session_id,
        &crate::inet_sim_http::ReqwestInetSimClient,
        &base_url,
        solver_choice,
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

    /// R8 修订：求解器选择字符串解析——缺省/inet-z3 → Z3、inet-eager → Eager、未知值响亮拒绝。
    #[test]
    fn solver_choice_parse_maps_and_rejects() {
        assert_eq!(GclSolverChoice::parse(None).unwrap(), GclSolverChoice::Z3);
        assert_eq!(
            GclSolverChoice::parse(Some("inet-z3")).unwrap(),
            GclSolverChoice::Z3
        );
        assert_eq!(
            GclSolverChoice::parse(Some("inet-eager")).unwrap(),
            GclSolverChoice::Eager
        );
        assert!(GclSolverChoice::parse(Some("open-planner")).is_err());
    }

    /// R8 修订：选 Eager → synth ini 写 EagerGateScheduleConfigurator，出处/落库 algorithm 均
    /// 标 "Eager"（来源=用户选择，不信服务端回传字段）。
    #[test]
    fn plan_eager_choice_writes_eager_configurator_and_label() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let sca = "par N.sw01.eth[1].macLayer.queue.transmissionGate[0] initiallyOpen true\npar N.sw01.eth[1].macLayer.queue.transmissionGate[0] offset 0s\npar N.sw01.eth[1].macLayer.queue.transmissionGate[0] durations \"[300us, 700us]\"\n";
            let client = CapturingPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                }),
                ini: std::sync::Mutex::new(None),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Eager,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(r.solver.as_deref(), Some("Eager"));
            let ini = client.ini.lock().unwrap().clone().unwrap();
            assert!(ini.contains("\"EagerGateScheduleConfigurator\""), "{ini}");
            assert!(!ini.contains("Z3GateScheduleConfigurator"), "{ini}");
            let (_st, _cy, algo, _stale, _w) = read_plan_row(&pool).await.unwrap();
            assert_eq!(algo, "Eager");
        });
    }

    /// R8 修订：Z3 unsat 指纹 → 明确文案（说 unsat + 提示可切换 Eager），不静默降级。
    #[test]
    fn plan_z3_unsat_reports_explicit_message() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "<!> Error: The specified constraints might not be satisfiable. -- in module (inet::Z3GateScheduleConfigurator)".into(),
                    sca_gcl: None,
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "solver_failed");
            // 主文案在 overall（message 是原始 output_tail 详情）。
            assert!(r.overall.contains("约束不可满足"), "{}", r.overall);
            assert!(r.overall.contains("Eager"), "应提示可切换：{}", r.overall);
        });
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
        // sw01 gate7 的 .sca（ST 门；ned sw01 → mid 0）。
        let sca = "par N.sw01.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen true\npar N.sw01.eth[1].macLayer.queue.transmissionGate[7] offset 0s\npar N.sw01.eth[1].macLayer.queue.transmissionGate[7] durations \"[300us, 700us]\"\n";
        Ok(HttpPlanResult {
            exit_code: 0,
            output_tail: "ok".into(),
            sca_gcl: Some(sca.into()),
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
        // es01(1) — sw01(0) — es02(2)。GM=1。
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

    /// 读 flow_gcl_plan 单行（status/cycle/algorithm/stale + windows_json 反序列化）。
    async fn read_plan_row(
        pool: &sqlx::Pool<sqlx::Sqlite>,
    ) -> Option<(String, i64, String, i64, Vec<GclWindowRow>)> {
        let row: Option<(String, i64, String, i64, String)> = sqlx::query_as(
            "SELECT status, cycle_ns, algorithm, stale, windows_json FROM flow_gcl_plan \
             WHERE session_id='s1' AND provider='inet-z3'",
        )
        .fetch_optional(pool)
        .await
        .unwrap();
        row.map(|(status, cycle, algo, stale, windows_json)| {
            let windows: Vec<GclWindowRow> = serde_json::from_str(&windows_json).unwrap();
            (status, cycle, algo, stale, windows)
        })
    }

    /// AE2：约束可满足 → Z3 出 GCL，出处记 Z3，落 flow_gcl_plan 单行（windows_json
    /// 位图逐窗 + meta 列齐全）+ raw par 行写文件。
    #[test]
    fn plan_tas_synthesizes_and_persists() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // KTD14：预置 stale=1 的旧行——规划成功须复位为 0（覆盖式重写）。
            sqlx::query("INSERT INTO flow_gcl_plan (session_id, provider, status, cycle_ns, algorithm, stale, created_at, windows_json) VALUES ('s1', 'inet-z3', 'ok', 1000000, 'Z3', 1, 'now', '[]')")
                .execute(&pool).await.unwrap();
            // mock 服务回 sw01 gate 的 .sca（node ned sw01 → mid 0）。
            let sca = "par N.sw01.eth[1].macLayer.queue.transmissionGate[0] initiallyOpen true\npar N.sw01.eth[1].macLayer.queue.transmissionGate[0] offset 0s\npar N.sw01.eth[1].macLayer.queue.transmissionGate[0] durations \"[300us, 700us]\"\n";
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            assert_eq!(r.solver.as_deref(), Some("Z3"));
            assert_eq!(r.gate_count, 1);
            // 单行：status ok / cycle / algorithm / stale=0；windows_json 逐窗
            // （gate0 开窗 [0,300us) → 两窗 0x01 / 0x00，node=mid 0）。
            let (status, cycle, algo, stale, wins) = read_plan_row(&pool).await.unwrap();
            assert_eq!(
                (status.as_str(), cycle, algo.as_str(), stale),
                ("ok", 1_000_000, "Z3", 0)
            );
            let projected: Vec<(String, usize, usize, u64, u64, u8)> = wins
                .iter()
                .map(|w| {
                    (
                        w.node.clone(),
                        w.eth_n,
                        w.entry_idx,
                        w.start_ns,
                        w.duration_ns,
                        w.gate_states,
                    )
                })
                .collect();
            assert_eq!(
                projected,
                vec![
                    ("0".into(), 1, 0, 0, 300_000, 0x01),
                    ("0".into(), 1, 1, 300_000, 700_000, 0x00),
                ]
            );
            // raw 文件 = 服务返回的 par 行集原文。
            let par = crate::gcl_raw_store::read_raw(dir.path(), "s1", GCL_PROVIDER)
                .unwrap()
                .expect("应有 raw 文件");
            assert_eq!(par, sca);
        });
    }

    /// R16：等长多路径（歧义）→ route_error，message 点名流 F{seq}·{name} 并引导
    /// 「请在流详情中指定路径」（错误码不动）。
    #[test]
    fn plan_tas_route_error_names_stream_and_guides_to_path_pick() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
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
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
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

    /// R16：多条歧义流一次报全——菱形拓扑 2 条歧义 ST 流，message 含两个流名
    /// （不再第一条即 return 的挤牙膏式）。
    #[test]
    fn plan_tas_route_error_reports_all_failing_streams() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
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
            for (seq, name) in [(0, "视频流"), (1, "控制流")] {
                sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, name) VALUES ('s1', ?, 'ST', 7, 500, 512, 10000, '1', '2', ?)")
                    .bind(seq).bind(name).execute(&pool).await.unwrap();
            }
            let client = MockPlanClient {
                result: Err("不该被调用".into()),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "route_error", "{r:?}");
            let msg = r.message.as_deref().unwrap_or_default();
            assert!(msg.contains("F0·视频流"), "应报第一条：{msg}");
            assert!(msg.contains("F1·控制流"), "应报第二条（不早退）：{msg}");
        });
    }

    /// 回写沉淀：NULL paths 的 ST/BE 流规划成功后落裸数组凭证（与规划同事务）。
    #[test]
    fn plan_tas_writes_back_credential_for_null_paths() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await; // paths NULL
            add_stream(&pool, 1, "BE", 0).await; // paths NULL
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
                "SELECT stream_seq, paths FROM flow_streams WHERE session_id='s1' ORDER BY stream_seq",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            for (seq, paths) in rows {
                let p: serde_json::Value =
                    serde_json::from_str(paths.as_deref().expect("规划后应沉淀凭证")).unwrap();
                assert!(p.is_array(), "seq {seq}: 应为裸数组: {p}");
                // seed_linear：1→0→2，link_seqs [0,1]。
                assert_eq!(p[0]["node_path"], serde_json::json!(["1", "0", "2"]));
                assert_eq!(p[0]["link_seqs"], serde_json::json!([0, 1]));
            }
        });
    }

    /// 有效凭证规划成功后**不被回写**（凭证语义：拓扑不变即字节不动；兼收旧包装形状）。
    #[test]
    fn plan_tas_does_not_rewrite_valid_credential() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // 旧包装形状（库内存量行）：凭证有效 → 读兼容直用，也不被改写成裸数组。
            let wrapped_json = r#"{"version":1,"origin":"user","routes":[{"node_path":["1","0","2"],"link_seqs":[0,1]}]}"#;
            sqlx::query("UPDATE flow_streams SET paths=? WHERE session_id='s1' AND stream_seq=0")
                .bind(wrapped_json)
                .execute(&pool)
                .await
                .unwrap();
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let paths: Option<String> = sqlx::query_scalar(
                "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(paths.as_deref(), Some(wrapped_json), "有效凭证不得被回写");
        });
    }

    /// 绕路凭证有效时不被回写覆盖：非最短路（1-0-3-2 三跳，最短为 1-0-2 两跳）凭证
    /// 在完整拓扑上复验通过 → plan 后凭证字节不变（用户绕路选择稳定）。
    #[test]
    fn plan_tas_keeps_valid_detour_credential() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await; // 1—0—2（link 0/1）
            // 加节点 3 与链路 0—3（seq 2）、3—2（seq 3）：绕路 1-0-3-2 可复验。
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1', '3', NULL, 0, 0, 'switch', 8, 8, 3)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) VALUES ('s1', '3', '[]', '[]')")
                .execute(&pool)
                .await
                .unwrap();
            for (seq, src, sp, dst, dp) in [(2i64, "0", 2i64, "3", 0i64), (3, "3", 1, "2", 1)] {
                sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_node, src_port, dst_node, dst_port, speed, styles_json) VALUES ('s1', ?, ?, ?, ?, ?, 1000, '{}')")
                    .bind(seq).bind(src).bind(sp).bind(dst).bind(dp)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            add_stream(&pool, 0, "ST", 7).await;
            let detour_json = r#"[{"node_path":["1","0","3","2"],"link_seqs":[0,2,3]}]"#;
            sqlx::query("UPDATE flow_streams SET paths=? WHERE session_id='s1' AND stream_seq=0")
                .bind(detour_json)
                .execute(&pool)
                .await
                .unwrap();
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let paths: Option<String> = sqlx::query_scalar(
                "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                paths.as_deref(),
                Some(detour_json),
                "绕路凭证有效时不得被最短路推导覆盖"
            );
        });
    }

    /// 失效凭证（引用已不存在的链路）→ 静默重推导规划成功 + 凭证刷新为实际路径（裸数组）。
    #[test]
    fn plan_tas_refreshes_stale_credential() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let stale_json = r#"[{"node_path":["1","9","2"],"link_seqs":[0,99]}]"#;
            sqlx::query("UPDATE flow_streams SET paths=? WHERE session_id='s1' AND stream_seq=0")
                .bind(stale_json)
                .execute(&pool)
                .await
                .unwrap();
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "凭证失效应静默重推导：{r:?}");
            let paths: Option<String> = sqlx::query_scalar(
                "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let p: serde_json::Value = serde_json::from_str(paths.as_deref().unwrap()).unwrap();
            assert!(p.is_array(), "刷新应写裸数组: {p}");
            assert_eq!(
                p[0]["link_seqs"],
                serde_json::json!([0, 1]),
                "过期凭证应刷新为实际路径"
            );
        });
    }

    /// 决定：BE 歧义不阻塞规划——菱形拓扑纯 BE 流集 → no_gating 照常、BE 凭证跳过不回写
    /// （BE 不进 Z3，路径仅展示/castup 用）。
    #[test]
    fn plan_tas_be_ambiguity_does_not_block() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
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
            add_stream(&pool, 0, "BE", 0).await; // 1→2 歧义
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "no_gating", "BE 歧义不得 fail 规划：{r:?}");
            let paths: Option<String> = sqlx::query_scalar(
                "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(paths.is_none(), "歧义 BE 跳过不回写：{paths:?}");
        });
    }

    /// AE2/R10：约束不可行（exit≠0）→ FAIL，不落空表。
    #[test]
    fn plan_tas_infeasible_fails_without_empty_table() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "UNSAT".into(),
                    sca_gcl: None,
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM flow_gcl_plan WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "不可行不得落空/半截 flow_gcl_plan（R10）");
            assert!(
                crate::gcl_raw_store::read_raw(dir.path(), "s1", GCL_PROVIDER)
                    .unwrap()
                    .is_none(),
                "不可行不得写 raw 文件（R10）"
            );
        });
    }

    /// KTD1/KTD14：失败态**不写不清**——上一次规划（行 + raw 文件）原样保留，
    /// 且已置位的 stale 保持 true（复位仅发生在规划成功事务内）。
    #[test]
    fn plan_tas_failure_preserves_previous_plan_and_stale() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            sqlx::query("INSERT INTO flow_gcl_plan (session_id, provider, status, cycle_ns, algorithm, stale, created_at, windows_json) VALUES ('s1', 'inet-z3', 'ok', 1000000, 'Z3', 1, 'now', '[{\"node\":\"0\",\"ethN\":1,\"entryIdx\":0,\"startNs\":0,\"durationNs\":1000000,\"gateStates\":255,\"flowRefs\":null}]')")
                .execute(&pool).await.unwrap();
            crate::gcl_raw_store::write_raw(dir.path(), "s1", GCL_PROVIDER, "prev-par").unwrap();
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 1,
                    output_tail: "UNSAT".into(),
                    sca_gcl: None,
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "solver_failed", "{r:?}");
            let (status, _cycle, _algo, stale, wins) = read_plan_row(&pool).await.unwrap();
            assert_eq!(wins.len(), 1, "失败不得清上一次 windows");
            assert_eq!(
                (status.as_str(), stale),
                ("ok", 1),
                "行原样、stale 保持 true"
            );
            let par = crate::gcl_raw_store::read_raw(dir.path(), "s1", GCL_PROVIDER)
                .unwrap()
                .expect("raw 文件仍在");
            assert_eq!(par, "prev-par", "失败不得动 raw 文件");
        });
    }

    /// KTD2/R4：raw 文件覆盖式最新一份——旧存档被新规划的 par 行集替换。
    #[test]
    fn plan_tas_overwrites_raw_archive() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            crate::gcl_raw_store::write_raw(dir.path(), "s1", GCL_PROVIDER, "stale-par").unwrap();
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let par = crate::gcl_raw_store::read_raw(dir.path(), "s1", GCL_PROVIDER)
                .unwrap()
                .expect("应有 raw 文件");
            assert!(par.contains("transmissionGate[7]"), "{par}");
            assert!(!par.contains("stale-par"), "覆盖式只留最新一份");
        });
    }

    /// U2 端到端（Covers R3/R16×R3）：偏移行齐全 + 两跳窗长指纹匹配 → flow_refs 落
    /// derived；关窗行 flow_refs=NULL；恒态位/开窗位图正确。
    #[test]
    fn plan_tas_writes_derived_flow_refs() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            // 周期 = 门控周期（单实例），frame 512 → tx = (512+58)*8 = 4560ns。
            sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'ST', 7, 1000, 512, 100, '1', '2')")
                .execute(&pool).await.unwrap();
            // es01（talker mid 1）eth0 ST 窗 [0,4.56us)；sw01（mid 0）eth1 ST 窗
            // [10us,14.56us)（窗长 = tx 指纹）；talker 偏移 0（裸秒 dump 形态）。
            let sca = "par N.es01.eth[0].macLayer.queue.transmissionGate[7] initiallyOpen true\n\
                par N.es01.eth[0].macLayer.queue.transmissionGate[7] offset 0s\n\
                par N.es01.eth[0].macLayer.queue.transmissionGate[7] durations \"[4.56us, 995.44us]\"\n\
                par N.sw01.eth[1].macLayer.queue.transmissionGate[7] initiallyOpen false\n\
                par N.sw01.eth[1].macLayer.queue.transmissionGate[7] offset 0s\n\
                par N.sw01.eth[1].macLayer.queue.transmissionGate[7] durations \"[10us, 4.56us, 985.44us]\"\n\
                par N.es01.app[0].source initialProductionOffset 0\n";
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(sca.into()),
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let (_, _, _, _, wins) = read_plan_row(&pool).await.unwrap();
            let find = |node: &str, eth: usize, idx: usize| {
                wins.iter()
                    .find(|w| w.node == node && w.eth_n == eth && w.entry_idx == idx)
                    .unwrap()
            };
            // sw01(mid 0) eth1：三窗，开窗（idx1）带 derived 引用。
            let w = find("0", 1, 1);
            assert_eq!(w.gate_states, 0x80);
            assert_eq!(
                w.flow_refs.as_deref(),
                Some(r#"[{"seq":0,"source":"derived"}]"#)
            );
            // es01(mid 1) eth0：首窗（首跳锚定）带 derived 引用。
            let w = find("1", 0, 0);
            assert_eq!(w.gate_states, 0x80);
            assert_eq!(
                w.flow_refs.as_deref(),
                Some(r#"[{"seq":0,"source":"derived"}]"#)
            );
            // 关窗行 flowRefs = null。
            assert!(find("0", 1, 0).flow_refs.is_none(), "关窗行不得有流引用");
        });
    }

    /// KTD5 ⑤ 端到端：偏移行整体缺失（旧服务/格式变化）→ 流降级 class、落库不失败。
    #[test]
    fn plan_tas_missing_offsets_degrade_to_class() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            // ok_plan_result 的 sca 只有门参数行、无 initialProductionOffset。
            let client = MockPlanClient {
                result: ok_plan_result(),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let (_, _, _, _, wins) = read_plan_row(&pool).await.unwrap();
            let w = wins
                .iter()
                .find(|w| w.node == "0" && w.eth_n == 1 && w.entry_idx == 0)
                .unwrap();
            assert_eq!(
                w.flow_refs.as_deref(),
                Some(r#"[{"seq":0,"source":"class"}]"#)
            );
        });
    }

    /// exit=0 但 .sca 无可解析门（空 GCL）→ FAIL，不落表（R10）。
    #[test]
    fn plan_tas_empty_gcl_fails() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: "ok".into(),
                    sca_gcl: Some(
                        "par N.sw01.eth[0].macLayer.queue.transmissionGate[0] durations []\n"
                            .into(),
                    ),
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
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
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            let client = MockPlanClient {
                result: Ok(HttpPlanResult {
                    exit_code: 0,
                    output_tail: String::new(),
                    sca_gcl: None,
                }),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
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
            let dir = tempfile::tempdir().unwrap();
            seed_linear(&pool).await;
            add_stream(&pool, 0, "ST", 7).await;
            add_stream(&pool, 1, "RC", 6).await;
            add_stream(&pool, 2, "BE", 0).await;
            let client = CapturingPlanClient {
                result: ok_plan_result(),
                ini: std::sync::Mutex::new(None),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "{r:?}");
            let ini = client.ini.lock().unwrap().clone().expect("求解器应被调用");
            // specs 只含 ST → 稠密端口只有 1000；RC/BE 若混入会占 1001/1002。
            assert!(ini.contains("destPort = 6000"), "{ini}");
            assert!(!ini.contains("destPort = 6001"), "RC 不得进 bundle：{ini}");
            assert!(!ini.contains("destPort = 6002"), "BE 不得进 bundle：{ini}");
            // 只 1 个源 app；识别/编码/配置器均无 RC(pcp6)/BE(pcp0) 条目。
            assert_eq!(ini.matches("UdpSourceApp").count(), 1, "{ini}");
            assert!(ini.contains("pcp: 7"), "{ini}");
            assert!(!ini.contains("pcp: 6"), "{ini}");
            assert!(!ini.contains("pcp: 0"), "{ini}");
        });
    }

    /// Covers R5（U3②）：纯 BE / 纯 RC 流集 → no_gating、行覆盖为零窗口态、raw 文件
    /// 删除、求解器不被调用。
    #[test]
    fn plan_without_st_returns_no_gating_and_clears_plans() {
        tauri::async_runtime::block_on(async {
            for (class, pcp) in [("BE", 0i64), ("RC", 6i64)] {
                let pool = fresh_pool().await;
                let dir = tempfile::tempdir().unwrap();
                seed_linear(&pool).await;
                add_stream(&pool, 0, class, pcp).await;
                // 存量（旧规划残留：行带窗口 + raw 文件）——no_gating 应覆盖/清掉。
                sqlx::query("INSERT INTO flow_gcl_plan (session_id, provider, status, cycle_ns, algorithm, stale, created_at, windows_json) VALUES ('s1', 'inet-z3', 'ok', 1000000, 'Z3', 0, 'now', '[{\"node\":\"0\",\"ethN\":1,\"entryIdx\":0,\"startNs\":0,\"durationNs\":1000000,\"gateStates\":255,\"flowRefs\":null}]')")
                    .execute(&pool).await.unwrap();
                crate::gcl_raw_store::write_raw(dir.path(), "s1", GCL_PROVIDER, "old").unwrap();
                let client = CapturingPlanClient {
                    result: ok_plan_result(),
                    ini: std::sync::Mutex::new(None),
                };
                let r = plan_tas_inner(
                    &pool,
                    dir.path(),
                    "s1",
                    &client,
                    "http://x",
                    GclSolverChoice::Z3,
                )
                .await
                .unwrap();
                assert_eq!(r.status, "no_gating", "纯 {class}：{r:?}");
                assert!(r.overall.contains("无需门控"), "{r:?}");
                let (status, _, _, _, wins) = read_plan_row(&pool).await.unwrap();
                assert_eq!(status, "no_gating", "纯 {class} 行应记 no_gating");
                assert!(wins.is_empty(), "纯 {class} windows_json 应为空数组");
                assert!(
                    crate::gcl_raw_store::read_raw(dir.path(), "s1", GCL_PROVIDER)
                        .unwrap()
                        .is_none(),
                    "纯 {class} 应删 raw 文件"
                );
                assert!(
                    client.ini.lock().unwrap().is_none(),
                    "纯 {class} 不应调用求解器"
                );
                // BE 回写循环：no_gating 事务里也沉淀 BE 凭证；RC 不进该循环（paths 不动）。
                let paths: Option<String> = sqlx::query_scalar(
                    "SELECT paths FROM flow_streams WHERE session_id='s1' AND stream_seq=0",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if class == "BE" {
                    let p: serde_json::Value =
                        serde_json::from_str(paths.as_deref().expect("BE 应沉淀凭证")).unwrap();
                    assert!(p.is_array(), "应为裸数组: {p}");
                } else {
                    assert!(paths.is_none(), "RC 不在 BE 回写循环：{paths:?}");
                }
            }
        });
    }

    /// Covers KTD6（U3⑦）：双平面拓扑（链路带 plane 键）ST 规划 → 锁平面 A 推路径
    /// （pathFragments 走 A 路交换机），无 AMBIGUOUS_ROUTE。
    #[test]
    fn plan_dual_plane_st_locks_plane_a() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let dir = tempfile::tempdir().unwrap();
            // es01(0) =A= sw01(2) =A= es02(1)；es01 =B= sw02(3) =B= es02。GM=0。
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
            // ST 流 es01(0) → es02(1)（add_stream helper 固定 1→2，与此拓扑不符，直插）。
            sqlx::query("INSERT INTO flow_streams (session_id, stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener) VALUES ('s1', 0, 'ST', 7, 500, 512, 10000, '0', '1')")
                .execute(&pool).await.unwrap();
            let client = CapturingPlanClient {
                result: ok_plan_result(),
                ini: std::sync::Mutex::new(None),
            };
            let r = plan_tas_inner(
                &pool,
                dir.path(),
                "s1",
                &client,
                "http://x",
                GclSolverChoice::Z3,
            )
            .await
            .unwrap();
            assert_eq!(r.status, "ok", "双平面不该 AMBIGUOUS_ROUTE：{r:?}");
            let ini = client.ini.lock().unwrap().clone().unwrap();
            assert!(
                ini.contains(r#"pathFragments: [["es01", "sw01", "es02"]]"#),
                "应锁平面 A（es01→sw01→es02）：{ini}"
            );
            // 唯一一条 pathFragments（上面已断言其为 A 路）→ 没有第二条走平面 B 的路径。
            assert_eq!(ini.matches("pathFragments").count(), 1, "{ini}");
        });
    }
}
