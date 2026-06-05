import { describe, expect, it } from "vitest";
import {
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
      tool: "topology.apply_operations",
    },
    status: "success",
    summary: "拓扑已写入工程数据库（mutation #7）。",
    validation: { ok: true, errors: [] },
    payload: {
      kind: "topology",
      sessionId: "session-1",
      mutationId: 7,
    },
    ...overrides,
  };
}

describe("workflow stage result contract", () => {
  it("parses v1 topology results with mutationId payload", () => {
    const parsed = parseWorkflowStageResult(topologyWorkflowResult());

    expect(parsed.stage).toBe("topology");
    expect(parsed.producer).toEqual({
      type: "mcp",
      name: "tsn_topology",
      tool: "topology.apply_operations",
    });
    if (parsed.stage !== "topology") {
      throw new Error("expected topology stage");
    }
    expect(parsed.payload).toEqual({
      kind: "topology",
      sessionId: "session-1",
      mutationId: 7,
    });
    expect(validateWorkflowStageResult(parsed)).toEqual({ ok: true, errors: [] });
  });

  it("summarizes results without payload", () => {
    const summary = summarizeWorkflowStageResult(parseWorkflowStageResult(topologyWorkflowResult()));

    expect(summary).toMatchObject({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
      },
    });
    expect(summary).not.toHaveProperty("payload");
  });

  it("rejects legacy stage-skill-result.v0 schema", () => {
    expect(validateWorkflowStageResult({
      schemaVersion: "tsn-agent.stage-skill-result.v0",
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
      summary: "旧拓扑结果。",
      validation: { ok: true, errors: [] },
      payload: { kind: "topology" },
    })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("Unsupported workflow stage schemaVersion")],
    });
  });

  it("rejects topology payload without a positive mutationId", () => {
    expect(validateWorkflowStageResult(topologyWorkflowResult({
      payload: {
        kind: "topology",
        sessionId: "session-1",
        mutationId: 0,
      },
    }))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("payload.mutationId must be a positive integer")],
    });
  });

  it("rejects flow-template stage results while the stage is offline", () => {
    expect(validateWorkflowStageResult({
      ...topologyWorkflowResult(),
      stage: "flow-template",
      payload: { kind: "flow-template" },
    })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("flow-template 阶段结果暂未启用")],
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

  it("accepts placeholder time-sync results", () => {
    const parsed = parseWorkflowStageResult({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "time-sync",
      producer: { type: "local-runtime", name: "tsn-agent" },
      status: "success",
      summary: "时间同步默认值。",
      validation: { ok: true, errors: [] },
      payload: { kind: "time-sync" },
    });

    expect(parsed.stage).toBe("time-sync");
    expect(parsed.payload).toEqual({ kind: "time-sync" });
  });
});
