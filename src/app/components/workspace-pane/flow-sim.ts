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
 * 后端已在 no_gating 时清空门控结果，verify 侧对无 ST 流集不再以空 GCL 硬拦（AE5）。
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

/** flow 揭示动作（agent 写流后引导用户到流量规划 tab，镜像 timesync computeReveal）。 */
export type FlowRevealAction = "expand-flow-list" | "badge" | "none";

/**
 * agent 经 sidecar 写流（domain="flow" mutation）后的分级揭示纯决策：
 * - 面板收起 → 展开并落流量列表子 tab；
 * - 面板开但在别的 tab → 挂 badge；
 * - 已在流量 tab → 不动。
 * 防误触：调用方须用 mutation 时间戳过滤掉「会话挂载前」的历史记录（切会话时
 * catch-up 会全量回放旧 mutation）；UI 详情弹窗保存走 Tauri command 不发 mutation，
 * 天然不触发。
 */
export function computeFlowReveal(input: {
  hasNewFlowMutation: boolean;
  inFlowStage: boolean;
  panelExpanded: boolean;
  activeIsFlow: boolean;
}): FlowRevealAction {
  if (!input.hasNewFlowMutation || !input.inFlowStage) {
    return "none";
  }
  if (!input.panelExpanded) {
    return "expand-flow-list";
  }
  return input.activeIsFlow ? "none" : "badge";
}

/** 单流行，对齐 flow_query_command::ListFlowStreamRow。
 * 设备级标识列（MAC/IP/端口/协议/VLAN/偏移/抖动/名称）NULL 时后端回退推导默认值；
 * nodePath 为路由显示名序列（推导失败为空，前端回退 talker → listener）。 */
export interface ListFlowStreamRow {
  streamSeq: number;
  class: string;
  pcp: number;
  periodUs: number;
  frameBytes: number;
  count: number;
  talker: string;
  listener: string;
  maxLatencyUs: number | null;
  redundant: boolean;
  srcMac: string | null;
  dstMac: string | null;
  vlanId: number | null;
  earliestSendOffsetNs: number | null;
  latestSendOffsetNs: number | null;
  name: string | null;
  jitterNs: number | null;
  srcIp: string | null;
  dstIp: string | null;
  srcL4Port: number | null;
  dstL4Port: number | null;
  l4Protocol: string | null;
  nodePath: string[];
  /** paths 列原文（KTD12 统一 JSON 形状；null=系统推导）。 */
  paths: string | null;
}

/** 流集查询结果（对齐 flow_query_command::ListFlowStreamsResult）。 */
export interface ListFlowStreamsResult {
  streams: ListFlowStreamRow[];
}

/** 流更新请求（对齐 flow_query_command::UpdateFlowStreamRequest）。
 * class/pcp 为只读字段（PCP 由 class 派生），故不在请求中。
 * R16 路径三态：`pathLinkSeqs` 设显式路径 / `clearPath` 改回系统自动 / 均缺省 = 不变。 */
export interface UpdateFlowStreamRequest {
  sessionId: string;
  streamSeq: number;
  periodUs: number;
  frameBytes: number;
  count: number;
  maxLatencyUs: number | null;
  srcMac: string | null;
  dstMac: string | null;
  vlanId: number | null;
  earliestSendOffsetNs: number | null;
  latestSendOffsetNs: number | null;
  name: string | null;
  jitterNs: number | null;
  srcIp: string | null;
  dstIp: string | null;
  srcL4Port: number | null;
  dstL4Port: number | null;
  l4Protocol: string | null;
  pathLinkSeqs?: number[];
  clearPath?: boolean;
}

/** 流更新结果（对齐 flow_query_command::UpdateFlowStreamResult）：规划字段/路径是否
 * 实际变更（KTD14 服务端判定，弹窗 onSaved 的 didChange 事实源）。 */
export interface UpdateFlowStreamResult {
  planningFieldsChanged: boolean;
}

/** 流更新写通道 = update_flow_stream Tauri command（测试可注入替身）。 */
export async function invokeUpdateFlowStream(
  request: UpdateFlowStreamRequest,
): Promise<UpdateFlowStreamResult> {
  return await invoke<UpdateFlowStreamResult>("update_flow_stream", { request });
}

/** 流集查询读通道 = list_flow_streams Tauri command（测试可注入替身）。 */
export async function invokeListFlowStreams(sessionId: string): Promise<ListFlowStreamsResult> {
  return await invoke<ListFlowStreamsResult>("list_flow_streams", { request: { sessionId } });
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

// ── R16 路径指定（U10b：候选枚举 + paths 解析）────────────────────────────────

/** 单条候选路径（对齐 flow_query_command::FlowPathCandidate）。 */
export interface FlowPathCandidate {
  nodePath: string[];
  nodePathNames: string[];
  linkSeqs: number[];
}

/** 候选枚举结果（对齐 flow_query_command::GetFlowPathCandidatesResult）。
 * truncated=true 表示上限（8）打满，还有未列出路径。 */
export interface GetFlowPathCandidatesResult {
  candidates: FlowPathCandidate[];
  truncated: boolean;
}

/** 候选路径读通道 = get_flow_path_candidates Tauri command（测试可注入替身）。 */
export async function invokeGetFlowPathCandidates(
  sessionId: string,
  talker: string,
  listener: string,
): Promise<GetFlowPathCandidatesResult> {
  return await invoke<GetFlowPathCandidatesResult>("get_flow_path_candidates", {
    request: { sessionId, talker, listener },
  });
}

/** paths 列 JSON 的路由段（Rust FlowPaths 序列化为 snake_case：node_path/link_seqs）。 */
interface FlowPathsRouteJson {
  node_path?: unknown;
  link_seqs?: unknown;
}

/** paths 列解析（容错：非法 JSON/形状 → null，视同未指定）。 */
function parseFlowPathsJson(
  paths: string | null,
): { origin: string; routes: Array<{ nodePath: string[]; linkSeqs: number[] }> } | null {
  if (!paths) return null;
  try {
    const v = JSON.parse(paths) as { origin?: unknown; routes?: unknown };
    if (typeof v.origin !== "string" || !Array.isArray(v.routes)) return null;
    const routes: Array<{ nodePath: string[]; linkSeqs: number[] }> = [];
    for (const r of v.routes as FlowPathsRouteJson[]) {
      if (!Array.isArray(r.node_path) || !Array.isArray(r.link_seqs)) return null;
      routes.push({
        nodePath: r.node_path.map((n) => String(n)),
        linkSeqs: r.link_seqs.map((s) => Number(s)),
      });
    }
    return routes.length > 0 ? { origin: v.origin, routes } : null;
  } catch {
    return null;
  }
}

/** 显式指定路径（origin=user）的 link_seqs；未指定/系统凭证/解析失败 → null。 */
export function parseExplicitPathLinkSeqs(paths: string | null): number[] | null {
  const parsed = parseFlowPathsJson(paths);
  if (parsed?.origin !== "user") return null;
  return parsed.routes[0]?.linkSeqs ?? null;
}

/** RC 双冗余路径的节点 mid 序列（routes[0]=A、routes[1]=B）；形状不符 → null。
 * 弹窗只读展示用（R16：FRER 双路径不可手选）。 */
export function parseRedundantNodePaths(paths: string | null): [string[], string[]] | null {
  const parsed = parseFlowPathsJson(paths);
  if (!parsed || parsed.routes.length < 2) return null;
  return [parsed.routes[0].nodePath, parsed.routes[1].nodePath];
}

/** 默认规划写通道 = plan_tas Tauri command（测试可注入替身）。 */
export async function invokePlanTas(sessionId: string): Promise<PlanResult> {
  return await invoke<PlanResult>("plan_tas", { request: { sessionId } });
}

/** 默认验证写通道 = verify_tas Tauri command（测试可注入替身）。 */
export async function invokeVerifyTas(sessionId: string): Promise<VerifyTasResult> {
  return await invoke<VerifyTasResult>("verify_tas", { request: { sessionId } });
}

// ── 门控明细（U4，get_gcl_detail 新表读面 + display model + 概览八项 + 窗口链）──────────

/** 窗口关联流引用（对齐 flow_query_command::FlowRefDto）：source=derived（确定性回算命中）
 * | class（类级降级，KTD5）。 */
export interface FlowRefDto {
  seq: number;
  source: string;
}

/** 逐窗行（对齐 flow_query_command::GclWindowDto）。gateStates=0-255 位图（bit g = gate g 开）；
 * flowRefs=null 表示无关联流（空窗/未回算）。 */
export interface GclWindowRow {
  node: string;
  nodeName: string;
  ethN: number;
  entryIdx: number;
  startNs: number;
  durationNs: number;
  gateStates: number;
  flowRefs: FlowRefDto[] | null;
}

/** 规划级元数据（对齐 flow_query_command::GclMetaDto）。stale=需重新规划（KTD14）。 */
export interface GclMetaDto {
  status: string;
  cycleNs: number;
  algorithm: string;
  stale: boolean;
}

/** 门控详情（对齐 flow_query_command::GclDetail，KTD8 单查询）：弹窗三页签 / 概览八卡 /
 * 简版时序图同源。meta=null → 从未规划（老工程空态，AE6）。 */
export interface GclDetail {
  windows: GclWindowRow[];
  meta: GclMetaDto | null;
  streams: ListFlowStreamRow[];
}

/** 门控详情读通道 = get_gcl_detail Tauri command（测试可注入替身）。 */
export async function invokeGetGclDetail(sessionId: string): Promise<GclDetail> {
  return await invoke<GclDetail>("get_gcl_detail", { request: { sessionId } });
}

/**
 * KTD1 三态（由查询数据推导，不依赖规划动作记忆；面板头行/CTA/验证按钮闸单一口径）。
 * 镜像后端 verify「无 ST 一律不 pin」口径：流集无 ST 流时，即便库里残留存量门控表，
 * 验证也不会消费它——不得呈现为「已规划」。
 * - 无 ST 且流集非空 → no-gating（蓝条「无需门控」；存量门控表与流集不符的矛盾态也落此，
 *   由面板追加「验证不会消费」文案）；
 * - 无 ST 且流集空 → unplanned（居中 CTA）；
 * - 有 ST 且有窗口行 → planned；
 * - 有 ST 且无窗口行 → unplanned（有 ST 待规划）。
 */
export function gclPresentation(detail: GclDetail): "planned" | "no-gating" | "unplanned" {
  const hasSt = detail.streams.some((s) => s.class === "ST");
  if (!hasSt) {
    const hasOthers = detail.streams.some((s) => s.class === "RC" || s.class === "BE");
    return hasOthers ? "no-gating" : "unplanned";
  }
  return detail.windows.length > 0 ? "planned" : "unplanned";
}

/** ST 门位（bit7 = pcp7 队列门，与后端 flow_verify::ST_PCP 同源语义）。 */
const ST_GATE_MASK = 0x80;

/** 展示层窗口链常量（KTD9：仅展示推导，不参与落库匹配）。 */
export const PROCESSING_DELAY_NS = 2000;
export const PROPAGATION_DELAY_NS = 0;
/** 帧开销（preamble+SFD+MAC 头+VLAN+FCS+IFG，与后端 FLOW_FRAME_OVERHEAD_BYTES 同源）。 */
export const FRAME_OVERHEAD_BYTES = 58;
/** 链路速率（Mbps，与拓扑默认 speed=1000 同源；1Gbps 下 1 字节=8ns）。 */
export const LINK_SPEED_MBPS = 1000;

/** 串行化时长（ns @1Gbps）：(帧长+58B 开销)×8。 */
export function serializationNs(frameBytes: number): number {
  return (frameBytes + FRAME_OVERHEAD_BYTES) * 8;
}

/** 弹窗 display model 的端口分组（行=窗口，组=节点.端口）。 */
export interface GclDisplayGroup {
  node: string;
  nodeName: string;
  ethN: number;
  windows: GclWindowRow[];
}

/** 弹窗 display model（KTD8：三页签 + 头部统计 + CSV 导出共享，筛选在 model 层）。 */
export interface GclDisplayModel {
  groups: GclDisplayGroup[];
  /** streamSeq → 流名（seq 不在流集时回退「流{seq}」）。 */
  flowNames: Map<number, string>;
}

/** 筛选器（顶部双下拉，null=全部）。node 接受 mid 或显示名。 */
export interface GclFilters {
  flowSeq: number | null;
  node: string | null;
}

/** 流名解析：优先流集 name（后端已填默认值），回退「流{seq}」。 */
function resolveFlowName(streams: ListFlowStreamRow[], seq: number): string {
  const s = streams.find((x) => x.streamSeq === seq);
  return s?.name ?? `流${seq}`;
}

/**
 * display model 构建纯函数（KTD8）：按 (node, ethN) 分组窗口行（保持后端行序 =
 * entry_idx 升序）+ 流名解析 + 筛选——node 过滤组、flowSeq 过滤含该流的窗
 * （门控可视化/门控表页签语义；流量维度页签消费 deriveFlowWindowChains，不吃本筛选）。
 */
export function buildGclDisplayModel(detail: GclDetail, filters: GclFilters): GclDisplayModel {
  const flowNames = new Map<number, string>();
  for (const w of detail.windows) {
    for (const r of w.flowRefs ?? []) {
      if (!flowNames.has(r.seq)) {
        flowNames.set(r.seq, resolveFlowName(detail.streams, r.seq));
      }
    }
  }

  const groups = new Map<string, GclDisplayGroup>();
  for (const w of detail.windows) {
    if (filters.node !== null && w.node !== filters.node && w.nodeName !== filters.node) {
      continue;
    }
    if (filters.flowSeq !== null && !(w.flowRefs ?? []).some((r) => r.seq === filters.flowSeq)) {
      continue;
    }
    const key = `${w.node}|${w.ethN}`;
    let g = groups.get(key);
    if (!g) {
      g = { node: w.node, nodeName: w.nodeName, ethN: w.ethN, windows: [] };
      groups.set(key, g);
    }
    g.windows.push(w);
  }
  return { groups: [...groups.values()], flowNames };
}

/** 窗口链单跳（R9 发/入/出/收）：txWindows=该跳命中窗（出）；rxWindows=上一跳出窗
 * +串行化+传播+处理推导（入，首跳 null）；inconsistent=推导入窗起点晚于本跳出窗起点
 * （KTD9 sanity，悬浮卡挂不一致提示）。 */
export interface FlowChainHop {
  node: string;
  txWindows: Array<[number, number]>;
  rxWindows: Array<[number, number]> | null;
  inconsistent: boolean;
}

/** 单流窗口链：sendWindows=首跳出窗（发）；receiveWindows=末跳出窗+传播（收，
 * 出窗尾即帧串行化完成时刻）。 */
export interface FlowChain {
  streamSeq: number;
  name: string;
  hops: FlowChainHop[];
  sendWindows: Array<[number, number]>;
  receiveWindows: Array<[number, number]>;
}

/** 类级降级流 seq 集合（任一窗口引用 source=class 即整链降级，R9 宁缺毋滥）。 */
export function degradedFlowSeqs(detail: GclDetail): Set<number> {
  const out = new Set<number>();
  for (const w of detail.windows) {
    for (const r of w.flowRefs ?? []) {
      if (r.source === "class") {
        out.add(r.seq);
      }
    }
  }
  return out;
}

/**
 * 窗口链推导纯函数（KTD9，展示层现算不落库）：每条有 derived flow_refs 的 ST 流，
 * 沿 nodePath（显示名序列，与窗口行 nodeName 同口径）取该流命中窗按时序构造逐跳
 * 发/入/出/收。入窗(hop N+1) = 出窗(hop N) + 串行化 + 传播(0) + 处理(2μs)。
 * 类级降级流整链不出（R9 整链隐藏），由 degradedFlowSeqs 提供降级集合。
 */
export function deriveFlowWindowChains(detail: GclDetail): FlowChain[] {
  const degraded = degradedFlowSeqs(detail);
  const chains: FlowChain[] = [];
  for (const s of detail.streams) {
    if (s.class !== "ST" || degraded.has(s.streamSeq)) {
      continue;
    }
    const hit = detail.windows.filter((w) => (w.flowRefs ?? []).some((r) => r.seq === s.streamSeq));
    if (hit.length === 0 || s.nodePath.length === 0) {
      continue;
    }
    const shiftNs = serializationNs(s.frameBytes) + PROPAGATION_DELAY_NS + PROCESSING_DELAY_NS;
    const hops: FlowChainHop[] = [];
    let prevTx: Array<[number, number]> | null = null;
    for (const pathNode of s.nodePath) {
      const txWindows = hit
        .filter((w) => w.nodeName === pathNode || w.node === pathNode)
        .sort((a, b) => a.startNs - b.startNs)
        .map((w) => [w.startNs, w.startNs + w.durationNs] as [number, number]);
      if (txWindows.length === 0) {
        continue; // listener（无出端口窗）或未命中跳。
      }
      const rxWindows = prevTx
        ? prevTx.map(([a, b]) => [a + shiftNs, b + shiftNs] as [number, number])
        : null;
      const inconsistent =
        rxWindows !== null &&
        (rxWindows.length !== txWindows.length ||
          rxWindows.some(([ra], i) => ra > txWindows[i][0]));
      hops.push({ node: pathNode, txWindows, rxWindows, inconsistent });
      prevTx = txWindows;
    }
    if (hops.length === 0) {
      continue;
    }
    const last = hops[hops.length - 1].txWindows;
    chains.push({
      streamSeq: s.streamSeq,
      name: s.name ?? `${s.class}流${s.streamSeq}`,
      hops,
      sendWindows: hops[0].txWindows,
      receiveWindows: last.map(
        ([a, b]) => [a + PROPAGATION_DELAY_NS, b + PROPAGATION_DELAY_NS] as [number, number],
      ),
    });
  }
  return chains;
}

/** 每流时延行（R15 时延分析）：latencyNs=端到端（逐实例配对取最大，收尾−发头）；
 * marginRatio=maxLatency/实际（>1 有裕度、<1 超限如实呈现；未设上限 null）。 */
export interface FlowLatencyRow {
  streamSeq: number;
  name: string;
  latencyNs: number;
  maxLatencyNs: number | null;
  marginRatio: number | null;
}

/** 门控概览八项指标（R15 口径细则；均为规划推导值，非实测——R9 诚实边界）。 */
export interface GclOverview {
  /** ① 调度状态：meta.status（null=从未规划）+ stale 过期标记。 */
  scheduleStatus: string | null;
  stale: boolean;
  /** ② 超周期（ns，null=从未规划）。 */
  cycleNs: number | null;
  /** ③ 业务流数 / 门控端口数 / 涉及队列（ST 开窗位图的 distinct 位）。 */
  streamCount: number;
  gatedPortCount: number;
  gatedQueues: number[];
  /** ④ GCL 表项数 / 打开窗口数（位图非全零）。 */
  entryCount: number;
  openWindowCount: number;
  /** ⑤ 最大门控窗口占用 %（per 端口 Σ ST 开窗时长/周期 取最大）。 */
  maxPortOpenPct: number | null;
  /** ⑥ 关闭窗口占比 %（全关窗 gateStates==0 时长 / Σ端口周期；INET 场景可能恒 0，如实算）。 */
  closedPct: number | null;
  /** ⑦ 最大链路带宽占用 %（per 链路 Σ流带宽 / 1000Mbps 取最大；无可归属链路 null → UI「—」）。 */
  maxLinkUtilizationPct: number | null;
  /** ⑧ 时延分析（仅 derived ST 流；类级降级排除并计数）。 */
  latency: {
    rows: FlowLatencyRow[];
    maxLatencyNs: number | null;
    excludedCount: number;
  };
}

/** 概览八项指标聚合纯函数（R15，与弹窗同源同一 detail，KTD8）。 */
export function buildGclOverview(detail: GclDetail): GclOverview {
  const cycleNs = detail.meta?.cycleNs ?? null;

  // ③ 门控端口 + 涉及队列（带 flow_refs 的 ST 开窗位图 distinct 位）。
  const ports = new Map<string, GclWindowRow[]>();
  for (const w of detail.windows) {
    const key = `${w.node}|${w.ethN}`;
    const list = ports.get(key);
    if (list) {
      list.push(w);
    } else {
      ports.set(key, [w]);
    }
  }
  const queueBits = new Set<number>();
  for (const w of detail.windows) {
    if ((w.flowRefs ?? []).length === 0) {
      continue;
    }
    for (let g = 0; g < 8; g += 1) {
      if (w.gateStates & (1 << g)) {
        queueBits.add(g);
      }
    }
  }

  // ⑤⑥ 窗口占用/关窗占比。
  let maxPortOpenPct: number | null = null;
  let closedPct: number | null = null;
  if (cycleNs !== null && cycleNs > 0 && ports.size > 0) {
    let maxOpen = 0;
    let closedTotal = 0;
    for (const wins of ports.values()) {
      let open = 0;
      for (const w of wins) {
        if (w.gateStates & ST_GATE_MASK) {
          open += w.durationNs;
        }
        if (w.gateStates === 0) {
          closedTotal += w.durationNs;
        }
      }
      maxOpen = Math.max(maxOpen, open);
    }
    maxPortOpenPct = (maxOpen / cycleNs) * 100;
    closedPct = (closedTotal / (ports.size * cycleNs)) * 100;
  }

  // ⑦ 链路带宽：每流带宽 (帧+58B)×8 bits / 周期 μs = Mbps（每周期一帧，count 为
  // 仿真总发包数不参与速率），沿 nodePath 逐链路累加同链流带宽取最大。
  const linkMbps = new Map<string, number>();
  for (const s of detail.streams) {
    if (s.periodUs <= 0 || s.nodePath.length < 2) {
      continue;
    }
    const mbps = ((s.frameBytes + FRAME_OVERHEAD_BYTES) * 8) / s.periodUs;
    for (let i = 0; i + 1 < s.nodePath.length; i += 1) {
      const key = `${s.nodePath[i]}→${s.nodePath[i + 1]}`;
      linkMbps.set(key, (linkMbps.get(key) ?? 0) + mbps);
    }
  }
  const maxLinkUtilizationPct =
    linkMbps.size > 0 ? (Math.max(...linkMbps.values()) / LINK_SPEED_MBPS) * 100 : null;

  // ⑧ 时延分析：窗口链推导，端到端 = 收尾 − 发头（逐实例按序配对取最大）。
  const degraded = degradedFlowSeqs(detail);
  const rows: FlowLatencyRow[] = [];
  for (const chain of deriveFlowWindowChains(detail)) {
    const n = Math.min(chain.sendWindows.length, chain.receiveWindows.length);
    let latencyNs = 0;
    for (let i = 0; i < n; i += 1) {
      latencyNs = Math.max(latencyNs, chain.receiveWindows[i][1] - chain.sendWindows[i][0]);
    }
    if (latencyNs <= 0) {
      continue;
    }
    const stream = detail.streams.find((s) => s.streamSeq === chain.streamSeq);
    const maxLatencyNs = stream?.maxLatencyUs != null ? stream.maxLatencyUs * 1000 : null;
    rows.push({
      streamSeq: chain.streamSeq,
      name: chain.name,
      latencyNs,
      maxLatencyNs,
      marginRatio: maxLatencyNs !== null ? maxLatencyNs / latencyNs : null,
    });
  }
  const excludedCount = detail.streams.filter(
    (s) => s.class === "ST" && degraded.has(s.streamSeq),
  ).length;

  return {
    scheduleStatus: detail.meta?.status ?? null,
    stale: detail.meta?.stale ?? false,
    cycleNs,
    streamCount: detail.streams.length,
    gatedPortCount: ports.size,
    gatedQueues: [...queueBits].sort((a, b) => a - b),
    entryCount: detail.windows.length,
    openWindowCount: detail.windows.filter((w) => w.gateStates !== 0).length,
    maxPortOpenPct,
    closedPct,
    maxLinkUtilizationPct,
    latency: {
      rows,
      maxLatencyNs: rows.length > 0 ? Math.max(...rows.map((r) => r.latencyNs)) : null,
      excludedCount,
    },
  };
}
