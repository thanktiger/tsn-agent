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
  /** ok | no_streams | no_gm | route_error | bundle_error | unreachable | solver_failed | no_service */
  status: string;
  /** 求解器出处：Z3=带调度性保证 / Eager=兜底无保证（R8/KTD7）。 */
  solver?: string;
  gateCount: number;
  overall: string;
  message?: string;
}

/** 单流实测判决（对齐 flow_verify_command::StreamVerdict）。 */
export interface StreamVerdict {
  streamSeq: number;
  talker: string;
  listener: string;
  received: number;
  expected: number;
  jitterMaxNs: number;
  latencyMaxNs: number;
  windowNs: number;
  pass: boolean;
  reason?: string;
}

/** 验证结果（对齐 flow_verify_command::VerifyTasResult）。 */
export interface VerifyTasResult {
  caliber: string;
  /** ok | no_plan | no_streams | no_gm | bundle_error | unreachable | load_failed | empty | fail | no_service */
  status: string;
  perStream: StreamVerdict[];
  overall: string;
  message?: string;
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

/** 默认规划写通道 = plan_tas Tauri command（测试可注入替身）。 */
export async function invokePlanTas(sessionId: string): Promise<PlanResult> {
  return await invoke<PlanResult>("plan_tas", { request: { sessionId } });
}

/** 默认验证写通道 = verify_tas Tauri command（测试可注入替身）。 */
export async function invokeVerifyTas(sessionId: string): Promise<VerifyTasResult> {
  return await invoke<VerifyTasResult>("verify_tas", { request: { sessionId } });
}
