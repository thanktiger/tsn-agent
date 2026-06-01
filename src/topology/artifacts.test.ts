import { describe, expect, it } from "vitest";
import { buildTopologyArtifacts, describeTopologyArtifacts, validateTopologyArtifacts } from "./artifacts";
import { INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION, type IntermediateTopology } from "./intermediate";
import { initializeTopology } from "./initialize";

describe("topology artifacts", () => {
  it("builds the four legacy JSON artifacts without HTML", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const result = buildTopologyArtifacts({
      topology: initialized.full!.topology,
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.artifactNames).toEqual([
        "topology.json",
        "topo_feature.json",
        "data-server.json",
        "mac-forwarding-table.json",
      ]);
      expect(result.summary.containsHtml).toBe(false);
      expect(Object.keys(result.full!.artifacts)).not.toContain("mac-forwarding-table.html");
      expect(result.full!.artifacts["topology.json"].data.node.nodes).toHaveLength(4);
      expect(result.full!.artifacts["topo_feature.json"].data).toHaveLength(6);
    }
  });

  it("describes artifact summaries without returning full artifact text", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const built = buildTopologyArtifacts({
      topology: initialized.full!.topology,
      responseMode: "full",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }

    const description = describeTopologyArtifacts({
      artifacts: built.full!.artifacts,
    });

    expect(description.ok).toBe(true);
    if (description.ok) {
      expect(description.summary).toMatchObject({
        artifactCount: 4,
        topologyNodeCount: 2,
        topologyLinkCount: 1,
      });
      expect(description.full).toBeUndefined();
    }
  });

  it("validates artifact references", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }
    const built = buildTopologyArtifacts({ topology: initialized.full!.topology, responseMode: "full" });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }

    const validation = validateTopologyArtifacts({
      artifacts: {
        "topology.json": built.full!.artifacts["topology.json"].data,
        "topo_feature.json": built.full!.artifacts["topo_feature.json"].data,
        "data-server.json": built.full!.artifacts["data-server.json"].data,
        "mac-forwarding-table.json": built.full!.artifacts["mac-forwarding-table.json"].data,
      },
    });

    expect(validation.ok).toBe(true);
  });

  it("rejects missing data-server.json during artifact validation", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }
    const built = buildTopologyArtifacts({ topology: initialized.full!.topology, responseMode: "full" });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }

    const validation = validateTopologyArtifacts({
      artifacts: {
        "topology.json": built.full!.artifacts["topology.json"].data,
        "topo_feature.json": built.full!.artifacts["topo_feature.json"].data,
        "mac-forwarding-table.json": built.full!.artifacts["mac-forwarding-table.json"].data,
      },
    });

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors).toContainEqual(expect.objectContaining({
        code: "INVALID_ARTIFACT",
        path: "$.artifacts['data-server.json']",
      }));
    }
  });

  it("projects custom intermediate port ids through stable port indexes", () => {
    const topology: IntermediateTopology = {
      schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
      metadata: { source: "operations", layout: "custom" },
      nodes: [
        {
          id: "sw1",
          numericId: 0,
          name: "SW-1",
          type: "switch",
          ports: [
            { id: "uplink-a", name: "uplink-a", index: 0 },
            { id: "uplink-b", name: "uplink-b", index: 1 },
          ],
          position: { x: 0, y: 0 },
        },
        {
          id: "es1",
          numericId: 1,
          name: "ES-1",
          type: "endSystem",
          ports: [{ id: "sensor-main", name: "sensor-main", index: 0 }],
          position: { x: 0, y: 120 },
        },
      ],
      links: [
        {
          id: "link-0",
          numericId: 0,
          source: { nodeId: "es1", portId: "sensor-main" },
          target: { nodeId: "sw1", portId: "uplink-b" },
          medium: "ethernet",
          dataRateMbps: 1_000,
        },
      ],
      diagnostics: [],
    };

    const result = buildTopologyArtifacts({ topology, responseMode: "full" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.full!.artifacts["topology.json"].text).not.toContain("null");
      expect(result.full!.artifacts["topo_feature.json"].data[0]).toMatchObject({
        src_port: 0,
        dst_port: 1,
      });
      expect(result.full!.artifacts["mac-forwarding-table.json"].data.entries[0]).toMatchObject({
        egress_port: 1,
      });
    }
  });
});
