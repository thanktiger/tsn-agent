import { invoke } from "@tauri-apps/api/core";

/**
 * U9：流量规划（plan_tas）+ 软仿验证（verify_tas）前端契约。
 *
 * DTO 与 Rust serde 对齐（camelCase）：PlanResult ← flow_plan_command.rs、
 * VerifyTasResult/StreamVerdict ← flow_verify_command.rs。运行态持于 App 级（非 tab 组件内）——
 * 切 tab 不取消命令、切回按 status 恢复（同 timesync 先例）。
 *
 * 注意：flow 按钮是 Rust 命令（plan_tas/verify_tas），**不经 worker、不被 eval 采集**
 * （仅 flow 会话被采集）——别假设按钮路径有 eval hook。
 */

/** 规划结果（对齐 flow_plan_command::PlanResult）。 */
export interface PlanResult {
  caliber: string;
  /** ok | no_streams | no_gating | no_gm | route_error | bundle_error | unreachable | solver_failed | no_service */
  status: string;
  /** 求解器出处：Z3=带调度性保证 / Eager=兜底无保证（R8/KTD7）。 */
  solver?: string;
  gateCount: number;
  overall: string;
  message?: string;
}

/** 单流实测判决（对齐 flow_verify_command::StreamVerdict）。U7 additive 字段可选以兼容旧结果。 */
export interface StreamVerdict {
  streamSeq: number;
  /** 流类别 ST/RC/BE（U7 分级判据）。 */
  class?: string;
  talker: string;
  listener: string;
  received: number;
  expected: number;
  jitterMaxNs: number;
  latencyMaxNs: number;
  windowNs: number;
  pass: boolean;
  /** 该轮是否下判（U7）：false=报告态（故障轮 ST/BE、未测容错 RC），note 说明口径。 */
  judged?: boolean;
  /** BE 送达率（收/实发，只展示不判，R13）。 */
  deliveryRatio?: number;
  /** 报告态备注（「仅健康轮判」/「未测容错」）。 */
  note?: string;
  reason?: string;
}

/** 每轮 gPTP 收敛诊断（R15，只报告不参与任何 verdict；对齐 flow_verify_command::GptpDiag）。 */
export interface GptpDiag {
  convergedNodes: number;
  totalNodes: number;
  thresholdSummary: string;
  worstNode: string;
  worstOffsetNs: number;
}

/** 单轮验证结果（U6/U7，对齐 flow_verify_command::VerifyRound）。 */
export interface VerifyRound {
  /** healthy | fault_a | fault_b */
  round: string;
  /** ok | fail | empty | load_failed | unreachable | busy | bundle_error */
  status: string;
  perStream: StreamVerdict[];
  /** 响亮标注（断点/时钟树边/ST 路由重叠/运行错误详情）。 */
  annotations: string[];
  /** 未被断链途经的 RC 流（「未测容错」，KTD8）。 */
  untestedStreams: string[];
  gptpDiag?: GptpDiag;
}

/** 验证结果（对齐 flow_verify_command::VerifyTasResult）。 */
export interface VerifyTasResult {
  caliber: string;
  /** ok | no_plan | no_streams | pcp_mismatch | no_gm | route_error | bundle_error | unreachable |
   * load_failed | empty | fail | fault_window_too_short | no_service */
  status: string;
  perStream: StreamVerdict[];
  overall: string;
  message?: string;
  /** U6/U7 多轮结果：有 RC 流 → [healthy, fault_a, fault_b]；无 RC → 缺席（老形状）。 */
  rounds?: VerifyRound[];
  /** 顶层 gPTP 收敛诊断（R15 收尾，U8）：恒为健康轮诊断——无 rounds 会话（纯 ST/ST+BE/
   * 纯 BE）也有诊断行；有 rounds 时与健康轮 gptpDiag 同值（轮小节已渲染，顶层不重复画）。 */
  gptpDiag?: GptpDiag;
}

/** 门控表单条目（U2，对齐 flow_plan_command::FlowPlanEntry）。node=mid、nodeName=显示名（缺名回退 mid）。 */
export interface FlowPlanEntry {
  node: string;
  nodeName: string;
  ethN: number;
  gateIndex: number;
  initiallyOpen: boolean;
  offsetNs: number;
  durationsNs: number[];
}

/** 门控表明细（U2，对齐 flow_plan_command::FlowPlanDetail）。三态（KTD1）全由数据推导。 */
export interface FlowPlanDetail {
  cycleNs: number;
  solver?: string;
  stCount: number;
  rcCount: number;
  beCount: number;
  entries: FlowPlanEntry[];
}

/** 门控明细查询态（组件内）：loading=取数中、unavailable=取数失败（回退按钮态判据）、loaded=有数据。 */
export type FlowPlanQueryState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "loaded"; detail: FlowPlanDetail };

/**
 * KTD1 三态（由查询数据推导，不依赖规划动作记忆）。镜像后端 verify「无 ST 一律不 pin」口径：
 * 流集无 ST 流时，即便库里残留存量门控表，验证也不会消费它——不得呈现为「已规划」。
 * - stCount==0 且流集非空 → no-gating（蓝条「无需门控」；存量门控表与流集不符的矛盾态也落此，
 *   由面板追加「验证不会消费」文案，不画时序图）；
 * - stCount==0 且流集空 → unplanned（居中 CTA）；
 * - stCount>0 且 entries 非空 → planned（画时序图 + 明细表）；
 * - stCount>0 且 entries 空 → unplanned（有 ST 待规划）。
 */
export function flowPlanPresentation(
  detail: FlowPlanDetail,
): "planned" | "no-gating" | "unplanned" {
  if (detail.stCount === 0) {
    return detail.rcCount + detail.beCount > 0 ? "no-gating" : "unplanned";
  }
  return detail.entries.length > 0 ? "planned" : "unplanned";
}

/**
 * 开窗区间还原纯函数（U2/KTD2）——与后端 `inet_sim_bundle::gcl_open_intervals` 同语义：
 * INET PeriodicGate t=0 时排程已前进 offset，即 state(t) = seq((t + offset) mod cycle)，
 * 序列坐标 p 的开窗落在绝对时间 (p - offset) mod cycle；initiallyOpen 定首段状态、durations
 * 交替翻转；跨周期边界的开窗拆成尾段 + 头段。durations 空 → 恒 initiallyOpen。
 * （后端在 durations 总和 ≠ 周期时响亮 Err——那是互补关窗推导的前置；本函数纯展示，按同一
 * 公式尽力渲染。）返回 [startNs, endNs) 列表。
 */
export function gclOpenIntervals(entry: FlowPlanEntry, cycleNs: number): Array<[number, number]> {
  if (entry.durationsNs.length === 0) {
    return entry.initiallyOpen ? [[0, cycleNs]] : [];
  }
  const off = entry.offsetNs % cycleNs;
  let open = entry.initiallyOpen;
  let pos = 0;
  const out: Array<[number, number]> = [];
  for (const d of entry.durationsNs) {
    if (open && d > 0) {
      const start = (pos + cycleNs - off) % cycleNs;
      if (start + d <= cycleNs) {
        out.push([start, start + d]);
      } else {
        // offset 回绕：开窗跨周期边界，拆成尾段 + 头段。
        out.push([start, cycleNs]);
        out.push([0, start + d - cycleNs]);
      }
    }
    pos += d;
    open = !open;
  }
  return out;
}

/** 占空比（U2 明细表列）：开窗总时长 / 门周期，0..1。 */
export function gclDutyCycle(entry: FlowPlanEntry, cycleNs: number): number {
  const openTotal = gclOpenIntervals(entry, cycleNs).reduce((sum, [s, e]) => sum + (e - s), 0);
  return cycleNs > 0 ? openTotal / cycleNs : 0;
}

/** 时序图单行 = (节点, 端口)：该端口全部门条目的开窗区间并集（当前 ST 单门，通常即一条）。 */
export interface GateTimelineRow {
  node: string;
  nodeName: string;
  ethN: number;
  windows: Array<[number, number]>;
}

/** 时序图行构建（U2/KTD2）：按 (node, ethN) 分组，行按首个开窗起点升序（Z3 流水线阶梯错位
 * 自然呈现）；无开窗的行排末尾。 */
export function buildGateTimelineRows(
  entries: FlowPlanEntry[],
  cycleNs: number,
): GateTimelineRow[] {
  const byPort = new Map<string, GateTimelineRow>();
  for (const entry of entries) {
    const key = `${entry.node}|${entry.ethN}`;
    let row = byPort.get(key);
    if (!row) {
      row = { node: entry.node, nodeName: entry.nodeName, ethN: entry.ethN, windows: [] };
      byPort.set(key, row);
    }
    row.windows.push(...gclOpenIntervals(entry, cycleNs));
  }
  const rows = [...byPort.values()];
  for (const row of rows) {
    row.windows.sort((a, b) => a[0] - b[0]);
  }
  rows.sort((a, b) => {
    const fa = a.windows[0]?.[0] ?? Number.POSITIVE_INFINITY;
    const fb = b.windows[0]?.[0] ?? Number.POSITIVE_INFINITY;
    return fa - fb;
  });
  return rows;
}

/** ns → µs 显示（时序图 hover / 明细表），保留两位小数：472390 → "472.39"。 */
export function nsToUs(ns: number): string {
  return (ns / 1000).toFixed(2);
}

/** App 级规划运行态——切 tab 不丢、按 status 恢复。 */
export type PlanUiState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: PlanResult }
  | { status: "error"; message: string };

/** App 级验证运行态。 */
export type VerifyUiState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: VerifyTasResult }
  | { status: "error"; message: string };

/** 规划是否成功产出门控表（空/失败绝不算成功，R16）。 */
export function planSucceeded(result: PlanResult): boolean {
  return result.status === "ok" && result.gateCount > 0;
}

/**
 * 验证按钮闸口径（R5/KTD4）：产出门控表，或流集无 ST 流（`no_gating`，无需门控）均放行。
 * 后端已在 no_gating 时清空 flow_plans，verify 侧对无 ST 流集不再以空 GCL 硬拦（AE5）。
 */
export function planAllowsVerify(result: PlanResult): boolean {
  return planSucceeded(result) || result.status === "no_gating";
}

/** 规划是否 Z3 带保证（诚实边界徽章，R8/KTD7）：Eager 兜底不得与 Z3 同等呈现。 */
export function isZ3Guaranteed(result: PlanResult): boolean {
  return (result.solver ?? "") === "Z3";
}

/** 验证是否全流达标（空/短/失败绝不算通过，R16）。rounds-aware：有多轮结果（RC 断链轮）时
 * 每轮 status 须 ok 且该轮下判（judged）的流全过——顶层 status/perStream 恒为健康轮，
 * 断链轮 FAIL 不得被顶层绿灯掩盖；无 rounds 的老结果行为不变。 */
export function verifyAllPass(result: VerifyTasResult): boolean {
  const roundsPass = (result.rounds ?? []).every(
    (r) => r.status === "ok" && r.perStream.every((s) => s.judged === false || s.pass),
  );
  return (
    result.status === "ok" &&
    result.perStream.length > 0 &&
    result.perStream.every((s) => s.pass) &&
    roundsPass
  );
}

/** R16：仅当有逐流行时渲染结果表（空=不渲染绿）。 */
export function showVerifyTable(result: VerifyTasResult): boolean {
  return result.perStream.length > 0;
}

/** 轮名 → 中文标签（U7 多轮渲染）。 */
export function roundLabel(round: string): string {
  switch (round) {
    case "healthy":
      return "健康轮";
    case "fault_a":
      return "断A轮";
    case "fault_b":
      return "断B轮";
    default:
      return round;
  }
}

/** 轮 status 机器词 → 中文（busy=环境冲突非验证 FAIL，词表对齐后端 VerifyRound 注释）。 */
export function roundStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "通过";
    case "fail":
      return "未达标";
    case "empty":
      return "结果为空";
    case "load_failed":
      return "运行失败";
    case "unreachable":
      return "服务不可达";
    case "busy":
      return "服务占用（稍后重试）";
    case "bundle_error":
      return "装配失败";
    default:
      return status;
  }
}

/** gPTP 收敛诊断行文案（R15，只报告不判）。 */
export function gptpDiagLine(d: GptpDiag): string {
  return `gPTP 收敛：${d.convergedNodes}/${d.totalNodes} 节点 ≤ 阈值（${d.thresholdSummary}），最差 ${d.worstOffsetNs.toFixed(0)} ns @${d.worstNode}`;
}

/** 默认门控明细读通道 = get_flow_plan Tauri command（测试可注入替身）。 */
export async function invokeGetFlowPlan(sessionId: string): Promise<FlowPlanDetail> {
  return await invoke<FlowPlanDetail>("get_flow_plan", { request: { sessionId } });
}

/** 默认规划写通道 = plan_tas Tauri command（测试可注入替身）。 */
export async function invokePlanTas(sessionId: string): Promise<PlanResult> {
  return await invoke<PlanResult>("plan_tas", { request: { sessionId } });
}

/** 单流路由条目（U5，对齐 flow_query_command::FlowRouteEntry）。
 * `linkIds` = A 平面（或单平面）链路 id 列表，格式 `"link-{seq}"`（对齐 linkRowId）；
 * `planeBLinkIds` 仅 RC 双平面 B 路径，ST/BE 及单平面为 null。 */
export interface FlowRouteEntry {
  streamSeq: number;
  linkIds: string[];
  planeBLinkIds: string[] | null;
}

/** 路由图查询结果（U5，对齐 flow_query_command::GetFlowRouteMapResult）。 */
export interface GetFlowRouteMapResult {
  routes: FlowRouteEntry[];
}

/** 路由图读通道 = get_flow_route_map Tauri command（测试可注入替身）。 */
export async function invokeGetFlowRouteMap(sessionId: string): Promise<GetFlowRouteMapResult> {
  return await invoke<GetFlowRouteMapResult>("get_flow_route_map", { request: { sessionId } });
}

/** 默认验证写通道 = verify_tas Tauri command（测试可注入替身）。 */
export async function invokeVerifyTas(sessionId: string): Promise<VerifyTasResult> {
  return await invoke<VerifyTasResult>("verify_tas", { request: { sessionId } });
}
