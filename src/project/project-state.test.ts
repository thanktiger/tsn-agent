import { describe, expect, it } from "vitest";
import { WORKFLOW_STAGE_RESULT_SCHEMA_VERSION, type WorkflowStageSummary } from "../agent/workflow-stage-result";
import {
  confirmCurrentStage,
  createInitialWorkflowState,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
} from "./project-state";

describe("workflow state machine", () => {
  it("initializes workflow state for new projects", () => {
    const workflow = createInitialWorkflowState();

    expect(workflow.scenarioConfigId).toBe("generic-tsn");
    expect(workflow.currentStep).toBe("topology");
    expect(workflow.stages.topology.status).toBe("current");
    expect(workflow.stages["time-sync"].status).toBe("locked");
  });

  it("records stage results and advances only after confirmation", () => {
    const stageResult: WorkflowStageSummary = {
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.apply_operations",
      },
      status: "success",
      summary: "拓扑已生成",
      validation: { ok: true, errors: [] },
    };
    const topologyWaiting = recordStageResult(createInitialWorkflowState(), {
      step: "topology",
      summary: "拓扑已生成",
      stageResult,
      createdAt: "2026-05-20T00:00:00.000Z",
    });

    expect(topologyWaiting.currentStep).toBe("topology");
    expect(topologyWaiting.stages.topology.status).toBe("waiting_confirmation");
    expect(topologyWaiting.stages.topology.stageResult).toEqual(stageResult);
    expect(topologyWaiting.availableActions).toContain("confirm-stage");

    const next = confirmCurrentStage(topologyWaiting, "2026-05-20T00:01:00.000Z");

    expect(next.currentStep).toBe("time-sync");
    expect(next.stages.topology.status).toBe("confirmed");
    expect(next.stages["time-sync"].status).toBe("current");
  });

  it("rejects confirmation when the current step is not waiting", () => {
    expect(() => confirmCurrentStage(createInitialWorkflowState())).toThrow("not waiting for confirmation");
  });

  it("resets later stages when the user requests changes", () => {
    const workflow = confirmCurrentStage(
      recordStageResult(createInitialWorkflowState(), {
        step: "topology",
        summary: "拓扑已生成",
      }),
    );
    const changed = requestStageChanges(workflow, "topology", "2026-05-20T00:02:00.000Z");

    expect(changed.currentStep).toBe("topology");
    expect(changed.stages.topology.status).toBe("current");
    expect(changed.stages["time-sync"].status).toBe("locked");
  });

  it("normalizes old workflow payloads without stage state", () => {
    expect(normalizeWorkflowState(undefined, "missing-config")).toMatchObject({
      scenarioConfigId: "generic-tsn",
      currentStep: "topology",
    });
  });

  it("preserves existing stage summaries when normalizing", () => {
    const workflow = recordStageResult(createInitialWorkflowState(), {
      step: "topology",
      summary: "拓扑已生成",
    });

    const normalized = normalizeWorkflowState(workflow);

    expect(normalized.stages.topology.summary).toBe("拓扑已生成");
    expect(normalized.stages.topology.status).toBe("waiting_confirmation");
  });
});
