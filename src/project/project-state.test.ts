import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createArtifactBundle } from "../export/artifact-bundle";
import {
  STAGE_SKILL_SCHEMA_VERSION,
  type StageSkillSummary,
} from "../agent/stage-skill-contract";
import { WORKFLOW_STAGE_RESULT_SCHEMA_VERSION, type WorkflowStageSummary } from "../agent/workflow-stage-result";
import {
  confirmCurrentStage,
  createInitialWorkflowState,
  createProjectState,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
  withProjectBundle,
} from "./project-state";
import { appendSnapshot, restoreSnapshot } from "./snapshots";

describe("project state snapshots", () => {
  it("captures and restores step snapshots without mutating later state", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");
    const bundle = createArtifactBundle(project);
    const state = withProjectBundle(createProjectState({ sessionId: "session-1", project }), bundle);

    const snapshotted = appendSnapshot(state, {
      step: "topology",
      summary: "拓扑已生成",
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    const changed = {
      ...snapshotted,
      project: createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统"),
      bundle: undefined,
    };

    const restored = restoreSnapshot(changed, snapshotted.snapshots[0].id);

    expect(restored.project.topology.nodes).toHaveLength(24);
    expect(restored.bundle?.artifacts.map((artifact) => artifact.path)).toContain("simulation/inet/tsnagent/generated/network.ned");
    expect(restored.bundle?.artifacts.map((artifact) => artifact.path)).toContain("simulation/inet/omnetpp.ini");
    expect(restored.workflow.currentStep).toBe("topology");
    expect(restored.activeSnapshotId).toBe(snapshotted.snapshots[0].id);
  });

  it("rejects missing snapshots explicitly", () => {
    const state = createProjectState({
      sessionId: "session-1",
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
    });

    expect(() => restoreSnapshot(state, "missing-snapshot")).toThrow("does not exist");
  });

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
        tool: "topology.initialize",
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

  it("normalizes legacy skillResult into stageResult", () => {
    const skillResult = {
      schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
      stage: "topology",
      skillName: "tsn-topology",
      producer: {
        type: "legacy-skill",
        name: "tsn-topology",
      },
      status: "success",
      summary: "旧拓扑已生成",
      validation: { ok: true, errors: [] },
    } as unknown as StageSkillSummary;
    const normalized = normalizeWorkflowState({
      scenarioConfigId: "generic-tsn",
      currentStep: "topology",
      availableActions: [],
      stages: {
        ...createInitialWorkflowState().stages,
        topology: {
          step: "topology",
          status: "waiting_confirmation",
          summary: "旧拓扑已生成",
          skillResult,
        },
      },
    });

    expect(normalized.stages.topology.stageResult).toEqual(skillResult);
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
});
