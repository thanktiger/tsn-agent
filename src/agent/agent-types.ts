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

export interface TsnAgentResult {
  events: AgentEvent[];
  workflow: WorkflowState;
  assistantText: string;
  mode: "claude" | "local" | "unavailable";
  claudeSessionId?: string;
  /** sidecar apply_operations 写入 P0 表后的 mutationId；UI 据此感知拓扑已更新。 */
  topologyMutationId?: number;
}

export interface TsnAgentRequest {
  userIntent: string;
  session?: TsnSession;
  runId?: string;
  onChunk?: (chunk: string) => void;
  diagnostics?: DiagnosticLogRepository;
}
