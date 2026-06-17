import {
  DEFAULT_SCENARIO_CONFIG_ID,
  WORKFLOW_STEPS,
  getScenarioConfig,
  resolveScenarioConfig,
  type ScenarioConfig,
  type WorkflowStep,
} from "../domain/scenario-config";
import type { WorkflowStageSummary } from "../agent/workflow-stage-result";

export type { WorkflowStep };

export type WorkflowStepStatus = "locked" | "current" | "waiting_confirmation" | "confirmed" | "error";

export interface WorkflowStageState {
  step: WorkflowStep;
  status: WorkflowStepStatus;
  summary?: string;
  stageResult?: WorkflowStageSummary;
  confirmedAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface WorkflowState {
  scenarioConfigId: string;
  currentStep: WorkflowStep;
  stages: Record<WorkflowStep, WorkflowStageState>;
  availableActions: WorkflowAction[];
  /**
   * 大模型提议的「待确认回退目标阶段」。设置后当前阶段进入 waiting_confirmation，
   * 用户点「确认并继续」时才真正执行 requestStageChanges(target)（破坏性回退）。
   */
  pendingStageChange?: WorkflowStep;
  /**
   * 触发本次回退提议的原始用户意图（如「减少一个交换机」）。用户确认回退后，
   * 切阶段是确定性的，但随即用这句原话在新阶段自动跑一轮大模型——免去用户重输。
   */
  pendingStageChangeIntent?: string;
}

export type WorkflowAction =
  | "generate-topology"
  | "confirm-stage"
  | "request-changes"
  | "send-planning"
  | "quick-generate";

export function createInitialWorkflowState(scenarioConfigId: string = DEFAULT_SCENARIO_CONFIG_ID): WorkflowState {
  const configId = resolveScenarioConfig(scenarioConfigId).config.id;
  const stages = Object.fromEntries(
    WORKFLOW_STEPS.map((step, index) => [
      step,
      {
        step,
        status: index === 0 ? "current" : "locked",
      } satisfies WorkflowStageState,
    ]),
  ) as Record<WorkflowStep, WorkflowStageState>;

  return {
    scenarioConfigId: configId,
    currentStep: "topology",
    stages,
    availableActions: ["generate-topology", "quick-generate"],
  };
}

export function normalizeWorkflowState(
  state?: WorkflowState,
  scenarioConfigId: string = DEFAULT_SCENARIO_CONFIG_ID,
): WorkflowState {
  const configId = resolveScenarioConfig(state?.scenarioConfigId ?? scenarioConfigId).config.id;

  if (!state) {
    return createInitialWorkflowState(configId);
  }

  const currentStep = isWorkflowStep(state.currentStep) ? state.currentStep : "topology";
  const stages = Object.fromEntries(
    WORKFLOW_STEPS.map((step) => {
      const existing = state.stages?.[step];

      return [
        step,
        {
          step,
          status: existing?.status ?? (step === currentStep ? "current" : "locked"),
          summary: existing?.summary,
          stageResult: existing?.stageResult,
          confirmedAt: existing?.confirmedAt,
          updatedAt: existing?.updatedAt,
          error: existing?.error,
        } satisfies WorkflowStageState,
      ];
    }),
  ) as Record<WorkflowStep, WorkflowStageState>;

  return {
    scenarioConfigId: configId,
    currentStep,
    stages,
    availableActions: state.availableActions?.length ? state.availableActions : actionsForStage(stages[currentStep]),
    // 回退目标与触发原话绑定持久化：目标无效则原话也一并丢弃。
    ...(isWorkflowStep(state.pendingStageChange)
      ? {
          pendingStageChange: state.pendingStageChange,
          ...(typeof state.pendingStageChangeIntent === "string" && state.pendingStageChangeIntent.length > 0
            ? { pendingStageChangeIntent: state.pendingStageChangeIntent }
            : {}),
        }
      : {}),
  };
}

export function getWorkflowScenarioConfig(workflow: WorkflowState): ScenarioConfig {
  return getScenarioConfig(workflow.scenarioConfigId);
}

export function recordStageResult(
  workflow: WorkflowState,
  input: {
    step?: WorkflowStep;
    summary: string;
    stageResult?: WorkflowStageSummary;
    waitingConfirmation?: boolean;
    createdAt?: string;
  },
): WorkflowState {
  const step = input.step ?? workflow.currentStep;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const status: WorkflowStepStatus = input.waitingConfirmation === false ? "current" : "waiting_confirmation";
  const stages = updateStagesForCurrentStep(workflow.stages, step);

  return {
    ...workflow,
    currentStep: step,
    stages: {
      ...stages,
      [step]: {
        ...stages[step],
        step,
        status,
        summary: input.summary,
        stageResult: input.stageResult,
        updatedAt: createdAt,
        error: undefined,
      },
    },
    availableActions: actionsForStage({ step, status }),
  };
}

// 任一阶段转移都作废上一轮未确认的回退提议——pendingStageChange 不得跨转移残留，
// 否则确认按钮会指向一个已经过期的回退目标（确定性状态归状态机骨架）。
export function clearPendingStageChange(workflow: WorkflowState): WorkflowState {
  if (!workflow.pendingStageChange && !workflow.pendingStageChangeIntent) {
    return workflow;
  }

  const { pendingStageChange: _drop, pendingStageChangeIntent: _dropIntent, ...rest } = workflow;
  return rest;
}

export function confirmCurrentStage(workflow: WorkflowState, createdAt = new Date().toISOString()): WorkflowState {
  const currentStep = workflow.currentStep;
  const stage = workflow.stages[currentStep];

  if (stage.status !== "waiting_confirmation") {
    throw new Error(`Workflow step ${currentStep} is not waiting for confirmation.`);
  }

  const nextStep = getNextWorkflowStep(currentStep);
  const confirmedStages = {
    ...workflow.stages,
    [currentStep]: {
      ...stage,
      status: "confirmed" as const,
      confirmedAt: createdAt,
      updatedAt: createdAt,
    },
  };

  if (!nextStep) {
    return clearPendingStageChange({
      ...workflow,
      stages: confirmedStages,
      availableActions: [],
    });
  }

  return clearPendingStageChange({
    ...workflow,
    currentStep: nextStep,
    stages: {
      ...confirmedStages,
      [nextStep]: {
        ...confirmedStages[nextStep],
        step: nextStep,
        status: "current",
        updatedAt: createdAt,
        error: undefined,
      },
    },
    availableActions: actionsForStage({ step: nextStep, status: "current" }),
  });
}

export function requestStageChanges(
  workflow: WorkflowState,
  step: WorkflowStep,
  createdAt = new Date().toISOString(),
): WorkflowState {
  const stepIndex = WORKFLOW_STEPS.indexOf(step);
  const stages = Object.fromEntries(
    WORKFLOW_STEPS.map((candidate, index) => {
      const existing = workflow.stages[candidate];

      if (index < stepIndex) {
        return [candidate, existing];
      }

      if (candidate === step) {
        return [
          candidate,
          {
            ...existing,
            step: candidate,
            status: "current",
            confirmedAt: undefined,
            updatedAt: createdAt,
            error: undefined,
          } satisfies WorkflowStageState,
        ];
      }

      return [
        candidate,
        {
          step: candidate,
          status: "locked",
        } satisfies WorkflowStageState,
      ];
    }),
  ) as Record<WorkflowStep, WorkflowStageState>;

  return clearPendingStageChange({
    ...workflow,
    currentStep: step,
    stages,
    availableActions: actionsForStage(stages[step]),
  });
}

export function getNextWorkflowStep(step: WorkflowStep): WorkflowStep | undefined {
  return WORKFLOW_STEPS[WORKFLOW_STEPS.indexOf(step) + 1];
}

function updateStagesForCurrentStep(
  stages: Record<WorkflowStep, WorkflowStageState>,
  step: WorkflowStep,
): Record<WorkflowStep, WorkflowStageState> {
  const stepIndex = WORKFLOW_STEPS.indexOf(step);

  return Object.fromEntries(
    WORKFLOW_STEPS.map((candidate, index) => {
      const existing = stages[candidate];

      if (index < stepIndex) {
        return [candidate, existing.status === "locked" ? { ...existing, status: "confirmed" } : existing];
      }

      if (candidate === step) {
        return [candidate, existing];
      }

      return [
        candidate,
        {
          step: candidate,
          status: "locked",
        } satisfies WorkflowStageState,
      ];
    }),
  ) as Record<WorkflowStep, WorkflowStageState>;
}

function actionsForStage(stage: Pick<WorkflowStageState, "step" | "status">): WorkflowAction[] {
  if (stage.status === "waiting_confirmation") {
    return ["confirm-stage", "request-changes"];
  }

  if (stage.status === "current") {
    if (stage.step === "topology") {
      return ["generate-topology", "quick-generate"];
    }

    if (stage.step === "planning-export") {
      return ["send-planning"];
    }

    return ["confirm-stage"];
  }

  return [];
}

function isWorkflowStep(value: string | undefined): value is WorkflowStep {
  return Boolean(value && WORKFLOW_STEPS.includes(value as WorkflowStep));
}
