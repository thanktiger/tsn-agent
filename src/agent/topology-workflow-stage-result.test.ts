import { describe, expect, it } from "vitest";
import { createTopologyWorkflowStageResult } from "./topology-workflow-stage-result";
import { WORKFLOW_STAGE_RESULT_SCHEMA_VERSION, validateWorkflowStageResult } from "./workflow-stage-result";

describe("topology workflow stage result factory", () => {
  it("builds a workflow stage result from a trusted sidecar mutation", () => {
    const result = createTopologyWorkflowStageResult(
      { sessionId: "session-1", mutationId: 7, appliedCount: 3 },
      {
        producer: {
          type: "mcp",
          name: "tsn_topology",
          tool: "topology.apply_operations",
        },
      },
    );

    expect(result).toMatchObject({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.apply_operations",
      },
      status: "success",
      validation: { ok: true, errors: [] },
      payload: {
        kind: "topology",
        sessionId: "session-1",
        mutationId: 7,
      },
    });
    expect(result.summary).toContain("mutation #7");
    expect(result.summary).toContain("3 个操作");
    expect(result.safeEventSummary).toMatchObject({ status: "success" });
    expect(validateWorkflowStageResult(result)).toEqual({ ok: true, errors: [] });
  });

  it("honors a caller-provided summary", () => {
    const result = createTopologyWorkflowStageResult(
      { sessionId: "session-1", mutationId: 2 },
      {
        producer: { type: "mcp", name: "tsn_topology" },
        summary: "自定义摘要。",
      },
    );

    expect(result.summary).toBe("自定义摘要。");
    expect(result.safeEventSummary?.content).toBe("自定义摘要。");
  });

  it("rejects a non-positive mutationId", () => {
    expect(() =>
      createTopologyWorkflowStageResult(
        { sessionId: "session-1", mutationId: 0 },
        { producer: { type: "mcp", name: "tsn_topology" } },
      ),
    ).toThrowError(/positive mutationId/);
  });

  it("rejects an empty sessionId", () => {
    expect(() =>
      createTopologyWorkflowStageResult(
        { sessionId: "", mutationId: 1 },
        { producer: { type: "mcp", name: "tsn_topology" } },
      ),
    ).toThrowError(/sessionId/);
  });
});
