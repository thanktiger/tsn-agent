import { describe, expect, it } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { initializeTopology } from "../topology/initialize";
import { createTopologyWorkflowStageResult } from "./topology-workflow-stage-result";
import { WORKFLOW_STAGE_RESULT_SCHEMA_VERSION, validateWorkflowStageResult } from "./workflow-stage-result";

describe("topology workflow stage result factory", () => {
  it("builds a workflow stage result from a full topology MCP result", () => {
    const topologyResult = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(2),
      responseMode: "full",
    });

    const result = createTopologyWorkflowStageResult(topologyResult, {
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.initialize",
      },
    });

    expect(result).toMatchObject({
      schemaVersion: WORKFLOW_STAGE_RESULT_SCHEMA_VERSION,
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.initialize",
      },
      status: "success",
      validation: { ok: true, errors: [] },
    });
    expect(result.payload.project.topology.nodes.filter((node) => node.type === "switch")).toHaveLength(4);
    expect(result.payload.project.topology.nodes.filter((node) => node.type === "endSystem")).toHaveLength(8);
    expect(result.payload.project.topology.nodes).toHaveLength(12);
    expect(validateWorkflowStageResult(result)).toEqual({ ok: true, errors: [] });
  });

  it("uses the trusted topology even when natural-language parsing would produce a different default", () => {
    const userIntent = "双平面冗余";
    const parserProject = createProjectFromIntent(userIntent, undefined, {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });
    const trusted = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(2),
      responseMode: "full",
    });

    const result = createTopologyWorkflowStageResult(trusted, {
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.initialize",
      },
    });

    expect(parserProject.topology.nodes.filter((node) => node.type === "endSystem")).not.toHaveLength(8);
    expect(result.payload.project.topology.nodes.filter((node) => node.type === "endSystem")).toHaveLength(8);
  });

  it("rejects summary-only topology results", () => {
    const summaryOnly = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(2),
      responseMode: "summary",
    });

    expect(() => createTopologyWorkflowStageResult(summaryOnly, {
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.initialize",
      },
    })).toThrow("trusted topology result must include full IntermediateTopology");
  });

  it("does not create topology results from legacy-skill producer", () => {
    const trusted = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(2),
      responseMode: "full",
    });

    expect(() => createTopologyWorkflowStageResult(trusted, {
      producer: {
        type: "legacy-skill",
        name: "tsn-topology",
      },
    })).toThrow("cannot be created from legacy-skill producer");
  });
});

function dualPlaneParams(endSystemsPerSwitch: number) {
  return {
    planes: [{ id: "A" }, { id: "B" }],
    switches: [
      { id: "sw1", name: "SW-1A", plane: "A", groupId: "g1" },
      { id: "sw2", name: "SW-1B", plane: "B", groupId: "g1" },
      { id: "sw3", name: "SW-2A", plane: "A", groupId: "g2" },
      { id: "sw4", name: "SW-2B", plane: "B", groupId: "g2" },
    ],
    switchGroups: [
      { id: "g1", planeSwitches: { A: "sw1", B: "sw2" } },
      { id: "g2", planeSwitches: { A: "sw3", B: "sw4" } },
    ],
    endSystems: Array.from({ length: 4 * endSystemsPerSwitch }, (_, index) => {
      const switchOrdinal = Math.floor(index / endSystemsPerSwitch) + 1;
      const hostOrdinal = index % endSystemsPerSwitch + 1;
      const groupOrdinal = Math.ceil(switchOrdinal / 2);
      return {
        id: `es${switchOrdinal}-${hostOrdinal}`,
        groupId: `g${groupOrdinal}`,
        attachment: {
          primary: { switchId: groupOrdinal === 1 ? "sw1" : "sw3", plane: "A" },
          backup: { switchId: groupOrdinal === 1 ? "sw2" : "sw4", plane: "B" },
        },
      };
    }),
    backbone: { mode: "line", withinPlane: true },
    crossPlaneLinks: { mode: "none" },
    dataRateMbps: 1_000,
  };
}
