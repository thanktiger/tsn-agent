import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { WorkflowStep } from "../domain/scenario-config";
import { validateCanonicalProject } from "../domain/validation";

export const STAGE_SKILL_SCHEMA_VERSION = "tsn-agent.stage-skill-result.v0";

export type StageSkillName = "tsn-topology" | "tsn-time-sync" | "tsn-flow-planning" | "tsn-inet-export";
export type StageSkillResultStatus = "success" | "failed" | "needs_input" | "fallback";

export interface StageSkillValidationReport {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

export interface StageSkillSafeEventSummary {
  title: string;
  content: string;
  status?: "info" | "success" | "warning" | "error";
}

export interface StageSkillBaseResult {
  schemaVersion: typeof STAGE_SKILL_SCHEMA_VERSION;
  stage: WorkflowStep;
  skillName: StageSkillName;
  status: StageSkillResultStatus;
  summary: string;
  validation: StageSkillValidationReport;
  safeEventSummary?: StageSkillSafeEventSummary;
}

export interface TopologyStageSkillResult extends StageSkillBaseResult {
  stage: "topology";
  skillName: "tsn-topology";
  payload: {
    kind: "topology";
    project: CanonicalTsnProjectV0;
  };
}

export interface FlowPlanningStageSkillResult extends StageSkillBaseResult {
  stage: "flow-template";
  skillName: "tsn-flow-planning";
  payload: {
    kind: "flow-template";
    project: CanonicalTsnProjectV0;
  };
}

export interface PlaceholderStageSkillResult extends StageSkillBaseResult {
  stage: "time-sync" | "planning-export";
  skillName: "tsn-time-sync" | "tsn-inet-export";
  payload: {
    kind: "time-sync" | "planning-export";
  };
}

export type StageSkillResult = TopologyStageSkillResult | FlowPlanningStageSkillResult | PlaceholderStageSkillResult;

export interface StageSkillSummary {
  schemaVersion: typeof STAGE_SKILL_SCHEMA_VERSION;
  stage: WorkflowStep;
  skillName: StageSkillName;
  status: StageSkillResultStatus;
  summary: string;
  validation: StageSkillValidationReport;
  safeEventSummary?: StageSkillSafeEventSummary;
  isFallback?: boolean;
}

const WORKFLOW_STEPS = ["topology", "time-sync", "flow-template", "planning-export"] as const;
const SKILL_NAMES = ["tsn-topology", "tsn-time-sync", "tsn-flow-planning", "tsn-inet-export"] as const;

export function parseStageSkillResult(value: unknown): StageSkillResult {
  if (!isRecord(value)) {
    throw new Error("Stage skill result must be an object.");
  }

  const schemaVersion = readString(value.schemaVersion, "schemaVersion");
  if (schemaVersion !== STAGE_SKILL_SCHEMA_VERSION) {
    throw new Error(`Unsupported stage skill schemaVersion: ${schemaVersion}.`);
  }

  const stage = readEnum(value.stage, WORKFLOW_STEPS, "stage");
  const skillName = readEnum(value.skillName, SKILL_NAMES, "skillName");
  const status = readEnum(value.status, ["success", "failed", "needs_input", "fallback"] as const, "status");
  const summary = readString(value.summary, "summary");
  const validation = parseValidationReport(value.validation);
  const safeEventSummary = parseSafeEventSummary(value.safeEventSummary);

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
      schemaVersion,
      stage,
      skillName,
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
      schemaVersion,
      stage,
      skillName,
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

  const expectedSkill = expectedSkillNameForStage(stage);
  if (skillName !== expectedSkill) {
    throw new Error(`${stage} stage must use ${expectedSkill} skill.`);
  }

  if (payloadKind !== stage) {
    throw new Error(`${stage} stage payload.kind must be ${stage}.`);
  }

  return {
    schemaVersion,
    stage,
    skillName,
    status,
    summary,
    validation,
    safeEventSummary,
    payload: {
      kind: stage,
    },
  } as PlaceholderStageSkillResult;
}

export function validateStageSkillResult(value: unknown): StageSkillValidationReport {
  try {
    const result = parseStageSkillResult(value);

    if (result.status === "success" && !result.validation.ok) {
      return {
        ok: false,
        errors: ["validation.ok must be true when status is success.", ...result.validation.errors],
      };
    }

    if (result.status !== "success") {
      return {
        ok: false,
        errors: result.validation.errors.length ? result.validation.errors : [`stage skill status is ${result.status}.`],
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

export function summarizeStageSkillResult(result: StageSkillResult): StageSkillSummary {
  return {
    schemaVersion: result.schemaVersion,
    stage: result.stage,
    skillName: result.skillName,
    status: result.status,
    summary: result.summary,
    validation: result.validation,
    safeEventSummary: result.safeEventSummary,
    isFallback: result.status === "fallback",
  };
}

function expectedSkillNameForStage(stage: WorkflowStep): StageSkillName {
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

function parseValidationReport(value: unknown): StageSkillValidationReport {
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

function parseSafeEventSummary(value: unknown): StageSkillSafeEventSummary | undefined {
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
