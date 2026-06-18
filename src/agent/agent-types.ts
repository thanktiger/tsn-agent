/**
 * Plan v3 Phase B-β (PR-β1)：agent runtime 公共类型。
 *
 * AgentEvent 从 fake-agent.ts 移入（fake-agent 已删除）；TsnAgentResult 不再
 * 携带 canonical project / artifact bundle —— 拓扑权威在 SQLite P0 表，
 * agent 结果只携带 workflow 状态与 topologyMutationId。
 */

import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import type { TsnSession } from "../sessions/session-repository";
import type { WorkflowState, WorkflowStep } from "../project/project-state";
import type { ToolCallRecord } from "./tool-call-record";

export type AgentEventKind =
  | "thought"
  | "skill-start"
  | "skill-result"
  | "artifact"
  | "stage-start"
  | "stage-result"
  | "confirmation-required"
  | "tool-availability"
  | "error";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  stage?: WorkflowStep;
  skillName?: string;
  title: string;
  content: string;
  status?: "info" | "success" | "warning" | "error";
  createdAt?: string;
}

/** verify_topology 命令返回值的 TS 镜像（Rust topology_verify::VerifyResult）。 */
export interface TopologyVerifyError {
  code: string;
  messageZh: string;
  nodeRef?: string;
}

export interface TopologyVerifyResult {
  ok: boolean;
  /** 验到哪一级：structural_only（本批）/ loadability_only（第二批）/ schedulability（占位）。 */
  caliber: string;
  errors: TopologyVerifyError[];
}

export interface TsnAgentResult {
  events: AgentEvent[];
  workflow: WorkflowState;
  assistantText: string;
  mode: "claude" | "local" | "unavailable";
  claudeSessionId?: string;
  /** sidecar apply_operations 写入 P0 表后的 mutationId；UI 据此感知拓扑已更新。 */
  topologyMutationId?: number;
  /** Plan 2026-06-09-003：本轮工具调用记录，挂到 assistant 消息渲染成卡片。 */
  toolCalls?: ToolCallRecord[];
  /** 拓扑阶段确认过关闸的结构验证结论；用于对话里区分渲染（拦截/通过）+ 口径标签。 */
  verification?: TopologyVerifyResult;
}

export interface TsnAgentRequest {
  userIntent: string;
  session?: TsnSession;
  runId?: string;
  /**
   * 显式确认动作（来自「确认并继续」按钮）：确定性推进 / 执行待确认的回退，不走大模型。
   * 自由文本输入不带此字段，一律走大模型判断意图。
   */
  action?: "confirm-stage";
  onChunk?: (chunk: string) => void;
  /** Plan 2026-06-10-001：流式工具事件（已脱敏+富化），run 期间按 id upsert 驱动卡片。 */
  onToolCall?: (record: ToolCallRecord) => void;
  diagnostics?: DiagnosticLogRepository;
}
