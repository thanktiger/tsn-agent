import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import {
  LEGACY_STAGE_SKILL_SCHEMA_VERSION,
  WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
  parseWorkflowStageResult,
  summarizeWorkflowStageResult,
  validateWorkflowStageResult,
  type TopologyWorkflowStageResult,
} from "./workflow-stage-result";

function topologyWorkflowResult(overrides: Partial<TopologyWorkflowStageResult> = {}): TopologyWorkflowStageResult {
  return {
    schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
    stage: "topology",
    producer: {
      type: "mcp",
      name: "tsn_topology",
      tool: "topology.initialize",
    },
    status: "success",
    summary: "已生成 4 个交换机、8 个端系统和 11 条链路。",
    validation: { ok: true, errors: [] },
    payload: {
      kind: "topology",
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接2个端系统", undefined, {
        includeControlFlow: false,
      }),
    },
    ...overrides,
  };
}

describe("workflow stage result contract", () => {
  it("parses v1 topology results with producer metadata", () => {
    const parsed = parseWorkflowStageResult(topologyWorkflowResult());

    expect(parsed.stage).toBe("topology");
    expect(parsed.producer).toEqual({
      type: "mcp",
      name: "tsn_topology",
      tool: "topology.initialize",
    });
    if (parsed.stage !== "topology") {
      throw new Error("expected topology stage");
    }
    expect(parsed.payload.project.topology.nodes).toHaveLength(12);
    expect(validateWorkflowStageResult(parsed)).toEqual({ ok: true, errors: [] });
  });

  it("normalizes legacy v0 skill results into v1 workflow results", () => {
    const legacy = {
      schemaVersion: LEGACY_STAGE_SKILL_SCHEMA_VERSION,
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
      summary: "旧拓扑结果。",
      validation: { ok: true, errors: [] },
      payload: {
        kind: "topology",
        project: createProjectFromIntent("我需要2个交换机，每个交换机连接2个端系统", undefined, {
          includeControlFlow: false,
        }),
      },
    };

    const parsed = parseWorkflowStageResult(legacy);
    const summary = summarizeWorkflowStageResult(parsed);

    expect(parsed.schemaVersion).toBe(WORKFLOW_STAGE_RESULT_SCHEMA_VERSION);
    expect(parsed.producer).toEqual({
      type: "legacy-skill",
      name: "tsn-topology",
    });
    expect(summary).toMatchObject({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: {
        type: "legacy-skill",
        name: "tsn-topology",
      },
    });
    expect(summary).not.toHaveProperty("payload");
  });

  it("rejects topology success results from legacy-skill producer in v1", () => {
    expect(validateWorkflowStageResult(topologyWorkflowResult({
      producer: {
        type: "legacy-skill",
        name: "tsn-topology",
      },
    }))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("topology success result must come from mcp or local-runtime producer")],
    });
  });

  it("rejects success results when validation is false", () => {
    expect(validateWorkflowStageResult(topologyWorkflowResult({
      validation: {
        ok: false,
        errors: ["拓扑不完整。"],
      },
    }))).toEqual({
      ok: false,
      errors: ["validation.ok must be true when status is success.", "拓扑不完整。"],
    });
  });
});
