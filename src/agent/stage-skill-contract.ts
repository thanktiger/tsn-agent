import type { WorkflowStep } from "../domain/scenario-config";
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import {
  LEGACY_STAGE_SKILL_SCHEMA_VERSION,
  parseWorkflowStageResult,
  summarizeWorkflowStageResult,
  validateWorkflowStageResult,
  type WorkflowStageSafeEventSummary,
  type WorkflowStageSummary,
  type WorkflowStageValidationReport,
} from "./workflow-stage-result";

export const STAGE_SKILL_SCHEMA_VERSION = LEGACY_STAGE_SKILL_SCHEMA_VERSION;

export type StageSkillName = "tsn-topology" | "tsn-time-sync" | "tsn-flow-planning" | "tsn-inet-export";
export type StageSkillResultStatus = "success" | "failed" | "needs_input" | "fallback";

export type StageSkillValidationReport = WorkflowStageValidationReport;
export type StageSkillSafeEventSummary = WorkflowStageSafeEventSummary;

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

export type StageSkillResult =
  | TopologyStageSkillResult
  | FlowPlanningStageSkillResult
  | PlaceholderStageSkillResult;

export interface StageSkillSummary extends WorkflowStageSummary {
  skillName?: StageSkillName;
  isFallback?: boolean;
}

export function parseStageSkillResult(value: unknown): StageSkillResult {
  const result = parseWorkflowStageResult(value);
  const skillName = legacySkillNameForStage(result.stage, result.producer.name);

  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: result.stage,
    skillName,
    status: result.status,
    summary: result.summary,
    validation: result.validation,
    safeEventSummary: result.safeEventSummary,
    payload: result.payload,
  } as StageSkillResult;
}

export function validateStageSkillResult(value: unknown): StageSkillValidationReport {
  return validateWorkflowStageResult(value);
}

export function summarizeStageSkillResult(result: StageSkillResult): StageSkillSummary {
  const workflowResult = parseWorkflowStageResult(result);
  const summary = summarizeWorkflowStageResult(workflowResult);

  return {
    ...summary,
    skillName: result.skillName,
    isFallback: result.status === "fallback",
  };
}

function legacySkillNameForStage(stage: WorkflowStep, producerName: string): StageSkillName {
  if (producerName === "tsn-topology" || producerName === "tsn-time-sync" || producerName === "tsn-flow-planning" || producerName === "tsn-inet-export") {
    return producerName;
  }

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
