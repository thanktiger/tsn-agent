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
  /** ok | no_plan | no_streams | pcp_mismatch | no_gm | bundle_error | unreachable | load_failed | empty | fail | no_service */
  status: string;
  perStream: StreamVerdict[];
  overall: string;
  message?: string;
  /** U6/U7 多轮结果：有 RC 流 → [healthy, fault_a, fault_b]；无 RC → 缺席（老形状）。 */
  rounds?: VerifyRound[];
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

/** 验证是否全流达标（空/短/失败绝不算通过，R16）。 */
export function verifyAllPass(result: VerifyTasResult): boolean {
  return (
    result.status === "ok" && result.perStream.length > 0 && result.perStream.every((s) => s.pass)
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

/** 默认规划写通道 = plan_tas Tauri command（测试可注入替身）。 */
export async function invokePlanTas(sessionId: string): Promise<PlanResult> {
  return await invoke<PlanResult>("plan_tas", { request: { sessionId } });
}

/** 默认验证写通道 = verify_tas Tauri command（测试可注入替身）。 */
export async function invokeVerifyTas(sessionId: string): Promise<VerifyTasResult> {
  return await invoke<VerifyTasResult>("verify_tas", { request: { sessionId } });
}
