import {
  WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
  type TopologyWorkflowStageResult,
  type WorkflowStageProducer,
} from "./workflow-stage-result";

/**
 * Plan v3 Phase B-β：trusted signal 是 sidecar apply_operations 响应里的
 * `summary.mutationId`。worker 在捕获 MCP tool_result 后调用本 builder，
 * 不再经过 IntermediateTopology → canonical project 转换。
 */
export interface TrustedTopologyMutation {
  sessionId: string;
  mutationId: number;
  /** sidecar applied 操作数，仅用于 summary 文案。 */
  appliedCount?: number;
}

export interface TopologyWorkflowStageResultOptions {
  producer: WorkflowStageProducer;
  summary?: string;
}

export function createTopologyWorkflowStageResult(
  trustedResult: TrustedTopologyMutation,
  options: TopologyWorkflowStageResultOptions,
): TopologyWorkflowStageResult {
  if (typeof trustedResult.sessionId !== "string" || trustedResult.sessionId.length === 0) {
    throw new Error("trusted topology mutation must include sessionId.");
  }

  if (!Number.isInteger(trustedResult.mutationId) || trustedResult.mutationId <= 0) {
    throw new Error("trusted topology mutation must include a positive mutationId.");
  }

  const summary = options.summary
    ?? (trustedResult.appliedCount !== undefined
      ? `拓扑已写入工程数据库（mutation #${trustedResult.mutationId}，${trustedResult.appliedCount} 个操作）。`
      : `拓扑已写入工程数据库（mutation #${trustedResult.mutationId}）。`);

  return {
    schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
    stage: "topology",
    producer: options.producer,
    status: "success",
    summary,
    validation: {
      ok: true,
      errors: [],
    },
    safeEventSummary: {
      title: "拓扑工具结果",
      content: summary,
      status: "success",
    },
    payload: {
      kind: "topology",
      sessionId: trustedResult.sessionId,
      mutationId: trustedResult.mutationId,
    },
  };
}
