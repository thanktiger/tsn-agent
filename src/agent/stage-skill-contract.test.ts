import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import {
  STAGE_SKILL_SCHEMA_VERSION,
  parseStageSkillResult,
  summarizeStageSkillResult,
  validateStageSkillResult,
  type TopologyStageSkillResult,
  type FlowPlanningStageSkillResult,
} from "./stage-skill-contract";
import { WORKFLOW_STAGE_RESULT_SCHEMA_VERSION } from "./workflow-stage-result";

function topologyResult(overrides: Partial<TopologyStageSkillResult> = {}): TopologyStageSkillResult {
  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: "topology",
    skillName: "tsn-topology",
    status: "success",
    summary: "识别到 4 个交换机，每个交换机连接 5 个端系统。",
    validation: { ok: true, errors: [] },
    safeEventSummary: {
      title: "拓扑结果",
      content: "已生成 24 个节点和 23 条链路。",
      status: "success",
    },
    payload: {
      kind: "topology",
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统", undefined, {
        includeControlFlow: false,
      }),
    },
    ...overrides,
  };
}

function flowPlanningResult(overrides: Partial<FlowPlanningStageSkillResult> = {}): FlowPlanningStageSkillResult {
  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: "flow-template",
    skillName: "tsn-flow-planning",
    status: "success",
    summary: "已准备 2 条流。",
    validation: { ok: true, errors: [] },
    safeEventSummary: {
      title: "流量规划结果",
      content: "已准备 2 条流。",
      status: "success",
    },
    payload: {
      kind: "flow-template",
      project: createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统"),
    },
    ...overrides,
  };
}

describe("stage skill contract", () => {
  it("parses a successful topology result with canonical project payload", () => {
    const parsed = parseStageSkillResult(topologyResult());

    expect(parsed.stage).toBe("topology");
    expect(parsed.skillName).toBe("tsn-topology");
    if (parsed.stage !== "topology") {
      throw new Error("expected topology stage");
    }
    expect(parsed.payload.kind).toBe("topology");
    expect(parsed.payload.project.topology.nodes).toHaveLength(24);
    expect(validateStageSkillResult(parsed)).toEqual({ ok: true, errors: [] });
  });

  it("parses a successful flow planning result with canonical project payload", () => {
    const parsed = parseStageSkillResult(flowPlanningResult());

    expect(parsed.stage).toBe("flow-template");
    expect(parsed.skillName).toBe("tsn-flow-planning");
    if (parsed.stage !== "flow-template") {
      throw new Error("expected flow-template stage");
    }
    expect(parsed.payload.kind).toBe("flow-template");
    expect(parsed.payload.project.flows).toHaveLength(1);
    expect(validateStageSkillResult(parsed)).toEqual({ ok: true, errors: [] });
  });

  it("summarizes validated results without storing the full project", () => {
    const result = topologyResult();
    const summary = summarizeStageSkillResult(result);

    expect(summary).toMatchObject({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
      validation: { ok: true, errors: [] },
    });
    expect(JSON.stringify(summary)).not.toContain("topology.nodes");
    expect(summary).not.toHaveProperty("payload");
  });

  it("rejects unknown stages and missing validation fields", () => {
    expect(validateStageSkillResult({ ...topologyResult(), stage: "unknown" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("stage must be one of")],
    });
    expect(validateStageSkillResult({ ...topologyResult(), validation: undefined })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("validation must be an object")],
    });
  });

  it("does not allow failed validation to apply a project patch", () => {
    const invalid = topologyResult({
      status: "failed",
      validation: {
        ok: false,
        errors: ["topology.nodes must not be empty."],
      },
    });

    expect(validateStageSkillResult(invalid)).toEqual({
      ok: false,
      errors: ["topology.nodes must not be empty."],
    });
  });

  it("rejects topology results with non-canonical projects", () => {
    const invalid = topologyResult({
      payload: {
        kind: "topology",
        project: {
          ...createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
          schemaVersion: "other",
        },
      } as unknown as TopologyStageSkillResult["payload"],
    });

    expect(validateStageSkillResult(invalid)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("payload.project must be a canonical TSN project")],
    });
  });
});
