import { describe, expect, it } from "vitest";
import { initializeTopology } from "./initialize";

describe("initializeTopology", () => {
  it("creates a deterministic generic ring topology", () => {
    const first = initializeTopology({
      templateId: "generic-ring",
      params: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
      responseMode: "full",
    });
    const second = initializeTopology({
      templateId: "generic-ring",
      params: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
      responseMode: "full",
    });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.summary).toEqual({
        templateId: "generic-ring",
        nodeCount: 12,
        linkCount: 12,
        switchCount: 4,
        endSystemCount: 8,
        serverCount: 0,
      });
      expect(first.full?.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toContainEqual(["sw4", "sw1"]);
    }
  });

  it("creates a line topology with N-1 switch interconnect links", () => {
    const result = initializeTopology({
      templateId: "generic-line",
      params: {
        switchCount: 3,
        endSystemsPerSwitch: 2,
      },
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.nodeCount).toBe(9);
      expect(result.summary.linkCount).toBe(8);
      expect(result.full?.topology.links.filter((link) =>
        link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
      )).toHaveLength(2);
    }
  });

  it("creates a dual-plane redundant topology from explicit A/B attachments", () => {
    const result = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(4),
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toEqual({
        templateId: "dual-plane-redundant",
        nodeCount: 12,
        linkCount: 18,
        switchCount: 4,
        endSystemCount: 8,
        serverCount: 0,
      });
      expect(result.full?.topology.metadata.layout).toBe("dual-plane");
      expect(result.full?.topology.nodes.filter((node) => node.type === "endSystem").every((node) => node.ports.length === 2)).toBe(true);
      expect(result.full?.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toContainEqual(["sw1", "sw3"]);
      expect(result.full?.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toContainEqual(["sw2", "sw4"]);
    }
  });

  it("rejects old aerospace template ids with a structured error", () => {
    const result = initializeTopology({
      templateId: "aerospace-redundant",
      params: { endSystemCount: 7 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "UNKNOWN_TEMPLATE_ID",
        path: "$.templateId",
        requiresUserClarification: true,
      });
    }
  });

  it("rejects dual-plane shortcut count params", () => {
    const result = initializeTopology({
      templateId: "dual-plane-redundant",
      params: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "INVALID_TEMPLATE_PARAM",
        path: "$.params",
        requiresUserClarification: true,
      });
    }
  });

  it("returns structured errors for invalid template params", () => {
    const result = initializeTopology({
      templateId: "generic-line",
      params: {
        switchCount: 99,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: "INVALID_TEMPLATE_PARAM",
        path: "$.params.switchCount",
        requiresUserClarification: true,
      });
    }
  });
});

function dualPlaneParams(endSystemsPerGroup: number) {
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
    endSystems: Array.from({ length: endSystemsPerGroup * 2 }, (_, index) => {
      const groupOrdinal = index < endSystemsPerGroup ? 1 : 2;
      const hostOrdinal = index % endSystemsPerGroup + 1;
      return {
        id: `es${groupOrdinal}-${hostOrdinal}`,
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
