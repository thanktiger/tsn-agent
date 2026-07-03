import type { WorkflowStep } from "../domain/scenario-config";

export const WORKFLOW_STAGE_RESULT_SCHEMA_VERSION = "tsn-agent.workflow-stage-result.v1" as const;

export type WorkflowStageResultStatus = "success" | "failed" | "needs_input";
export type WorkflowStageProducerType = "mcp" | "local-runtime";

export interface WorkflowStageValidationReport {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

export interface WorkflowStageSafeEventSummary {
  title: string;
  content: string;
  status?: "info" | "success" | "warning" | "error";
}

export interface WorkflowStageProducer {
  type: WorkflowStageProducerType;
  name: string;
  tool?: string;
}

export interface WorkflowStageBaseResult {
  schemaVersion: typeof WORKFLOW_STAGE_RESULT_SCHEMA_VERSION;
  stage: WorkflowStep;
  producer: WorkflowStageProducer;
  status: WorkflowStageResultStatus;
  summary: string;
  validation: WorkflowStageValidationReport;
  safeEventSummary?: WorkflowStageSafeEventSummary;
}

/**
 * Plan v3 Phase B-β：拓扑阶段结果不再携带 canonical project。
 * sidecar apply_operations 已把权威拓扑写入 P0 表，payload 只携带
 * mutationId + sessionId 供 UI catch-up / hydrate。
 */
export interface TopologyWorkflowStageResult extends WorkflowStageBaseResult {
  stage: "topology";
  payload: {
    kind: "topology";
    sessionId: string;
    mutationId: number;
  };
}

export interface PlaceholderWorkflowStageResult extends WorkflowStageBaseResult {
  stage: "time-sync";
  payload: {
    kind: "time-sync";
  };
}

export type WorkflowStageResult = TopologyWorkflowStageResult | PlaceholderWorkflowStageResult;

export interface WorkflowStageSummary {
  schemaVersion: typeof WORKFLOW_STAGE_RESULT_SCHEMA_VERSION;
  stage: WorkflowStep;
  producer: WorkflowStageProducer;
  status: WorkflowStageResultStatus;
  summary: string;
  validation: WorkflowStageValidationReport;
  safeEventSummary?: WorkflowStageSafeEventSummary;
}

const WORKFLOW_STEPS = ["topology", "time-sync", "flow-template"] as const;
const PRODUCER_TYPES = ["mcp", "local-runtime"] as const;

export function parseWorkflowStageResult(value: unknown): WorkflowStageResult {
  if (!isRecord(value)) {
    throw new Error("Workflow stage result must be an object.");
  }

  const schemaVersion = readString(value.schemaVersion, "schemaVersion");
  if (schemaVersion !== WORKFLOW_STAGE_RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow stage schemaVersion: ${schemaVersion}.`);
  }

  const stage = readEnum(value.stage, WORKFLOW_STEPS, "stage");
  // U4：flow-template 已解冻。flow 写库走 sidecar（flow.add_stream）、前端查 DB 渲染，
  // 不产 flow stageResult payload；万一收到也走下面的通用占位路径（同 time-sync 先例，
  // applyStageResults 对非 topology 阶段接受但忽略）。

  const producer = parseProducer(value.producer);
  const status = readEnum(value.status, ["success", "failed", "needs_input"] as const, "status");
  const summary = readString(value.summary, "summary");
  const validation = parseValidationReport(value.validation);
  const safeEventSummary = parseSafeEventSummary(value.safeEventSummary);

  if (!isRecord(value.payload)) {
    throw new Error("payload must be an object.");
  }

  const payloadKind = readString(value.payload.kind, "payload.kind");
  if (payloadKind !== stage) {
    throw new Error(`${stage} stage payload.kind must be ${stage}.`);
  }

  if (stage === "topology") {
    const sessionId = readString(value.payload.sessionId, "payload.sessionId");
    const mutationId = value.payload.mutationId;
    if (typeof mutationId !== "number" || !Number.isInteger(mutationId) || mutationId <= 0) {
      throw new Error("payload.mutationId must be a positive integer.");
    }

    return {
      schemaVersion,
      stage,
      producer,
      status,
      summary,
      validation,
      safeEventSummary,
      payload: {
        kind: "topology",
        sessionId,
        mutationId,
      },
    };
  }

  return {
    schemaVersion,
    stage,
    producer,
    status,
    summary,
    validation,
    safeEventSummary,
    payload: {
      kind: stage,
    },
  } as PlaceholderWorkflowStageResult;
}

export function validateWorkflowStageResult(value: unknown): WorkflowStageValidationReport {
  try {
    const result = parseWorkflowStageResult(value);

    if (result.status === "success" && !result.validation.ok) {
      return {
        ok: false,
        errors: ["validation.ok must be true when status is success.", ...result.validation.errors],
      };
    }

    if (result.status !== "success") {
      return {
        ok: false,
        errors: result.validation.errors.length
          ? result.validation.errors
          : [`workflow stage status is ${result.status}.`],
      };
    }

    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function summarizeWorkflowStageResult(result: WorkflowStageResult): WorkflowStageSummary {
  return {
    schemaVersion: result.schemaVersion,
    stage: result.stage,
    producer: result.producer,
    status: result.status,
    summary: result.summary,
    validation: result.validation,
    safeEventSummary: result.safeEventSummary,
  };
}

function parseProducer(value: unknown): WorkflowStageProducer {
  if (!isRecord(value)) {
    throw new Error("producer must be an object.");
  }

  return {
    type: readEnum(value.type, PRODUCER_TYPES, "producer.type"),
    name: readString(value.name, "producer.name"),
    tool: value.tool === undefined ? undefined : readString(value.tool, "producer.tool"),
  };
}

function parseValidationReport(value: unknown): WorkflowStageValidationReport {
  if (!isRecord(value)) {
    throw new Error("validation must be an object.");
  }

  if (typeof value.ok !== "boolean") {
    throw new Error("validation.ok must be a boolean.");
  }

  if (!Array.isArray(value.errors) || !value.errors.every((error) => typeof error === "string")) {
    throw new Error("validation.errors must be a string array.");
  }

  const warnings =
    Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string")
      ? value.warnings
      : undefined;

  return {
    ok: value.ok,
    errors: value.errors,
    warnings,
  };
}

function parseSafeEventSummary(value: unknown): WorkflowStageSafeEventSummary | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("safeEventSummary must be an object.");
  }

  return {
    title: readString(value.title, "safeEventSummary.title"),
    content: readString(value.content, "safeEventSummary.content"),
    status:
      value.status === undefined
        ? undefined
        : readEnum(
            value.status,
            ["info", "success", "warning", "error"] as const,
            "safeEventSummary.status",
          ),
  };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
  }

  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
