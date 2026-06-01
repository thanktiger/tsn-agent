import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { IntermediateTopology } from "../topology/intermediate";
import { summarizeTopology } from "../topology/intermediate";
import { intermediateToCanonicalProject } from "../topology/project-bridge";
import type { TopologyToolResult } from "../topology/tool-result";
import { validateIntermediateTopology } from "../topology/validate";
import {
  WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
  type TopologyWorkflowStageResult,
  type WorkflowStageProducer,
} from "./workflow-stage-result";

export interface TopologyWorkflowStageResultOptions {
  scenarioConfigId?: string;
  projectId?: string;
  projectName?: string;
  timestamp?: string;
  defaultDataRateMbps?: number;
  producer: WorkflowStageProducer;
  summary?: string;
}

export type TrustedTopologyResult =
  | IntermediateTopology
  | TopologyToolResult<unknown, { topology: IntermediateTopology }>;

export function createTopologyWorkflowStageResult(
  trustedResult: TrustedTopologyResult,
  options: TopologyWorkflowStageResultOptions,
): TopologyWorkflowStageResult {
  if (options.producer.type === "legacy-skill") {
    throw new Error("topology workflow stage result cannot be created from legacy-skill producer.");
  }

  const topology = extractTrustedTopology(trustedResult);
  const validation = validateIntermediateTopology(topology);
  const topologySummary = summarizeTopology(topology);

  if (!validation.ok) {
    return {
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: options.producer,
      status: "failed",
      summary: options.summary ?? "拓扑工具结果未通过校验。",
      validation: {
        ok: false,
        errors: validation.errors.map((error) => error.message),
        warnings: validation.warnings.map((warning) => warning.message),
      },
      safeEventSummary: {
        title: "拓扑工具结果",
        content: `拓扑校验失败：${validation.errors.map((error) => error.message).join("；")}`,
        status: "error",
      },
      payload: {
        kind: "topology",
        project: emptyFailedProject(options, topology),
      },
    };
  }

  const bridgeResult = intermediateToCanonicalProject({
    topology,
    options: {
      responseMode: "full",
      projectId: options.projectId,
      projectName: options.projectName,
      timestamp: options.timestamp,
      defaultDataRateMbps: options.defaultDataRateMbps,
    },
  });
  if (!bridgeResult.ok || !bridgeResult.full?.project) {
    const errors = bridgeResult.ok ? ["project bridge did not return a canonical project."] : bridgeResult.errors.map((error) => error.message);
    return {
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: options.producer,
      status: "failed",
      summary: options.summary ?? "拓扑工具结果无法转换为项目拓扑。",
      validation: {
        ok: false,
        errors,
        warnings: bridgeResult.warnings.map((warning) => warning.message),
      },
      safeEventSummary: {
        title: "拓扑工具结果",
        content: `拓扑转换失败：${errors.join("；")}`,
        status: "error",
      },
      payload: {
        kind: "topology",
        project: emptyFailedProject(options, topology),
      },
    };
  }

  const summary = options.summary
    ?? `已生成 ${topologySummary.switchCount} 个交换机、${topologySummary.endSystemCount} 个端系统和 ${topologySummary.linkCount} 条链路。`;

  return {
    schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
    stage: "topology",
    producer: options.producer,
    status: "success",
    summary,
    validation: {
      ok: true,
      errors: [],
      warnings: validation.warnings.map((warning) => warning.message),
    },
    safeEventSummary: {
      title: "拓扑工具结果",
      content: `已生成 ${bridgeResult.full.project.topology.nodes.length} 个节点和 ${bridgeResult.full.project.topology.links.length} 条链路。`,
      status: "success",
    },
    payload: {
      kind: "topology",
      project: bridgeResult.full.project,
    },
  };
}

function extractTrustedTopology(result: TrustedTopologyResult): IntermediateTopology {
  if (isTopologyToolResult(result)) {
    if (!result.ok) {
      throw new Error(`trusted topology result failed: ${result.errors.map((error) => error.message).join("；")}`);
    }

    if (result.metadata.responseMode !== "full" || result.metadata.summaryOnly || !result.full?.topology) {
      throw new Error("trusted topology result must include full IntermediateTopology.");
    }

    return result.full.topology;
  }

  return result;
}

function isTopologyToolResult(value: TrustedTopologyResult): value is TopologyToolResult<unknown, { topology: IntermediateTopology }> {
  return Boolean(value && typeof value === "object" && "ok" in value && "metadata" in value);
}

function emptyFailedProject(options: TopologyWorkflowStageResultOptions, topology?: IntermediateTopology): CanonicalTsnProjectV0 {
  const timestamp = options.timestamp ?? "2026-01-01T00:00:00.000Z";

  return {
    schemaVersion: "tsn-agent.canonical.v0",
    id: options.projectId ?? "project-invalid-topology-result",
    name: options.projectName ?? "不可应用拓扑结果",
    createdAt: timestamp,
    updatedAt: timestamp,
    topology: {
      nodes: [],
      links: [],
    },
    flows: [],
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps: options.defaultDataRateMbps ?? topology?.links[0]?.dataRateMbps ?? 1_000,
      timeSynchronization: "assumed-synchronized",
    },
  };
}
