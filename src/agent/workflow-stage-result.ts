import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { WorkflowStep } from "../domain/scenario-config";
import { validateCanonicalProject } from "../domain/validation";

export const WORKFLOW_STAGE_RESULT_SCHEMA_VERSION = "tsn-agent.workflow-stage-result.v1" as const;
export const LEGACY_STAGE_SKILL_SCHEMA_VERSION = "tsn-agent.stage-skill-result.v0" as const;

export type WorkflowStageResultStatus = "success" | "failed" | "needs_input";
export type WorkflowStageProducerType = "mcp" | "local-runtime" | "legacy-skill";

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

export interface TopologyWorkflowStageResult extends WorkflowStageBaseResult {
  stage: "topology";
  payload: {
    kind: "topology";
    project: CanonicalTsnProjectV0;
  };
}

export interface FlowPlanningWorkflowStageResult extends WorkflowStageBaseResult {
  stage: "flow-template";
  payload: {
    kind: "flow-template";
    project: CanonicalTsnProjectV0;
  };
}

export interface PlaceholderWorkflowStageResult extends WorkflowStageBaseResult {
  stage: "time-sync" | "planning-export";
  payload: {
    kind: "time-sync" | "planning-export";
  };
}

export type WorkflowStageResult =
  | TopologyWorkflowStageResult
  | FlowPlanningWorkflowStageResult
  | PlaceholderWorkflowStageResult;

export interface WorkflowStageSummary {
  schemaVersion: typeof WORKFLOW_STAGE_RESULT_SCHEMA_VERSION;
  stage: WorkflowStep;
  producer: WorkflowStageProducer;
  status: WorkflowStageResultStatus;
  summary: string;
  validation: WorkflowStageValidationReport;
  safeEventSummary?: WorkflowStageSafeEventSummary;
}

type LegacyStageSkillName = "tsn-topology" | "tsn-time-sync" | "tsn-flow-planning" | "tsn-inet-export";
type LegacyStageSkillStatus = "success" | "failed" | "needs_input" | "fallback";

const WORKFLOW_STEPS = ["topology", "time-sync", "flow-template", "planning-export"] as const;
const PRODUCER_TYPES = ["mcp", "local-runtime", "legacy-skill"] as const;
const LEGACY_SKILL_NAMES = ["tsn-topology", "tsn-time-sync", "tsn-flow-planning", "tsn-inet-export"] as const;

export function parseWorkflowStageResult(value: unknown): WorkflowStageResult {
  if (!isRecord(value)) {
    throw new Error("Workflow stage result must be an object.");
  }

  const schemaVersion = readString(value.schemaVersion, "schemaVersion");
  if (schemaVersion === LEGACY_STAGE_SKILL_SCHEMA_VERSION) {
    return normalizeLegacyStageSkillResult(value);
  }

  if (schemaVersion !== WORKFLOW_STAGE_RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow stage schemaVersion: ${schemaVersion}.`);
  }

  const stage = readEnum(value.stage, WORKFLOW_STEPS, "stage");
  const producer = parseProducer(value.producer);
  const status = readEnum(value.status, ["success", "failed", "needs_input"] as const, "status");
  const summary = readString(value.summary, "summary");
  const validation = parseValidationReport(value.validation);
  const safeEventSummary = parseSafeEventSummary(value.safeEventSummary);

  if (stage === "topology" && status === "success" && producer.type === "legacy-skill") {
    throw new Error("topology success result must come from mcp or local-runtime producer.");
  }

  if (!isRecord(value.payload)) {
    throw new Error("payload must be an object.");
  }

  const payloadKind = readString(value.payload.kind, "payload.kind");
  if (stage === "topology") {
    if (payloadKind !== "topology") {
      throw new Error("topology stage payload.kind must be topology.");
    }

    const project = value.payload.project;
    if (!isCanonicalProject(project)) {
      throw new Error("topology payload.project must be a canonical TSN project.");
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
        project,
      },
    };
  }

  if (stage === "flow-template") {
    if (payloadKind !== "flow-template") {
      throw new Error("flow-template stage payload.kind must be flow-template.");
    }

    const project = value.payload.project;
    if (!isCanonicalProject(project)) {
      throw new Error("flow-template payload.project must be a canonical TSN project.");
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
        kind: "flow-template",
        project,
      },
    };
  }

  if (payloadKind !== stage) {
    throw new Error(`${stage} stage payload.kind must be ${stage}.`);
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
        errors: result.validation.errors.length ? result.validation.errors : [`workflow stage status is ${result.status}.`],
      };
    }

    if (result.stage === "topology" || result.stage === "flow-template") {
      const projectValidation = validateCanonicalProject(result.payload.project);
      if (!projectValidation.ok) {
        return projectValidation;
      }
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

function normalizeLegacyStageSkillResult(value: Record<string, unknown>): WorkflowStageResult {
  const stage = readEnum(value.stage, WORKFLOW_STEPS, "stage");
  const skillName = readEnum(value.skillName, LEGACY_SKILL_NAMES, "skillName");
  const status = normalizeLegacyStatus(readEnum(value.status, ["success", "failed", "needs_input", "fallback"] as const, "status"));
  const summary = readString(value.summary, "summary");
  const validation = parseValidationReport(value.validation);
  const safeEventSummary = parseSafeEventSummary(value.safeEventSummary);
  const producer: WorkflowStageProducer = {
    type: "legacy-skill",
    name: skillName,
  };

  if (!isRecord(value.payload)) {
    throw new Error("payload must be an object.");
  }

  const payloadKind = readString(value.payload.kind, "payload.kind");
  if (stage === "topology") {
    if (skillName !== "tsn-topology") {
      throw new Error("topology stage must use tsn-topology skill.");
    }

    if (payloadKind !== "topology") {
      throw new Error("topology stage payload.kind must be topology.");
    }

    const project = value.payload.project;
    if (!isCanonicalProject(project)) {
      throw new Error("topology payload.project must be a canonical TSN project.");
    }

    return {
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage,
      producer,
      status,
      summary,
      validation,
      safeEventSummary,
      payload: {
        kind: "topology",
        project,
      },
    };
  }

  if (stage === "flow-template") {
    if (skillName !== "tsn-flow-planning") {
      throw new Error("flow-template stage must use tsn-flow-planning skill.");
    }

    if (payloadKind !== "flow-template") {
      throw new Error("flow-template stage payload.kind must be flow-template.");
    }

    const project = value.payload.project;
    if (!isCanonicalProject(project)) {
      throw new Error("flow-template payload.project must be a canonical TSN project.");
    }

    return {
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage,
      producer,
      status,
      summary,
      validation,
      safeEventSummary,
      payload: {
        kind: "flow-template",
        project,
      },
    };
  }

  const expectedSkill = expectedLegacySkillNameForStage(stage);
  if (skillName !== expectedSkill) {
    throw new Error(`${stage} stage must use ${expectedSkill} skill.`);
  }

  if (payloadKind !== stage) {
    throw new Error(`${stage} stage payload.kind must be ${stage}.`);
  }

  return {
    schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
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

function normalizeLegacyStatus(status: LegacyStageSkillStatus): WorkflowStageResultStatus {
  return status === "fallback" ? "failed" : status;
}

function expectedLegacySkillNameForStage(stage: WorkflowStep): LegacyStageSkillName {
  switch (stage) {
    case "topology":
      return "tsn-topology";
    case "time-sync":
      return "tsn-time-sync";
    case "flow-template":
      return "tsn-flow-planning";
    case "planning-export":
      return "tsn-inet-export";
  }
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

  const warnings = Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string")
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
    status: value.status === undefined
      ? undefined
      : readEnum(value.status, ["info", "success", "warning", "error"] as const, "safeEventSummary.status"),
  };
}

function isCanonicalProject(value: unknown): value is CanonicalTsnProjectV0 {
  return isRecord(value)
    && value.schemaVersion === "tsn-agent.canonical.v0"
    && isRecord(value.topology)
    && Array.isArray(value.topology.nodes)
    && Array.isArray(value.topology.links)
    && Array.isArray(value.flows)
    && isRecord(value.simulationHints);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
  }

  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
