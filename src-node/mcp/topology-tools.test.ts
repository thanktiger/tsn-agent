import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOPOLOGY_TOOL_NAMES } from "../../src/topology/topology-service";
import { buildTopologyArtifacts } from "../../src/topology/artifacts";
import { initializeTopology } from "../../src/topology/initialize";
import {
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  assertTopologyToolMapping,
  createTopologyToolRegistry,
  expectedAllowedToolName,
  runTopologyTool,
} from "./topology-tools";
import { createTsnTopologyMcpServer, isCliEntrypoint } from "./tsn-topology-server";

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("topology MCP tool registry", () => {
  it("registers only the P0 topology tools and allowedTool mappings", () => {
    const registry = createTopologyToolRegistry();

    expect(registry.map((tool) => tool.name)).toEqual(TOPOLOGY_TOOL_NAMES);
    expect(registry.map((tool) => tool.allowedToolName)).toEqual(TOPOLOGY_MCP_ALLOWED_TOOLS);
    expect(TOPOLOGY_MCP_ALLOWED_TOOLS).toEqual(TOPOLOGY_TOOL_NAMES.map(expectedAllowedToolName));
    expect(registry.map((tool) => tool.name)).not.toContain("topology.render_mac_table_html");
    expect(() => assertTopologyToolMapping()).not.toThrow();
  });

  it("returns structured template summaries", () => {
    const payload = parseToolText(runTopologyTool("topology.describe_templates", {}));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        templateCount: 3,
        templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
        templates: expect.arrayContaining([
          expect.objectContaining({
            id: "generic-line",
            params: expect.arrayContaining([
              expect.objectContaining({ name: "switchCount", default: 4, minimum: 1, maximum: 12 }),
              expect.objectContaining({ name: "endSystemsPerSwitch", default: 2, minimum: 1, maximum: 24 }),
              expect.objectContaining({ name: "dataRateMbps", default: 1_000, values: [10, 100, 1_000, 10_000] }),
            ]),
            example: {
              switchCount: 4,
              endSystemsPerSwitch: 2,
              dataRateMbps: 1_000,
            },
          }),
          expect.objectContaining({
            id: "dual-plane-redundant",
            params: expect.arrayContaining([
              expect.objectContaining({ name: "switches", required: true }),
              expect.objectContaining({ name: "switchGroups", required: true }),
              expect.objectContaining({ name: "endSystems", required: true }),
              expect.objectContaining({ name: "backbone", required: true }),
              expect.objectContaining({ name: "crossPlaneLinks", required: true }),
            ]),
          }),
        ]),
      },
      metadata: {
        responseMode: "summary",
        summaryOnly: true,
      },
    });
  });

  it("returns full topology only when explicitly allowed for composable topology calls", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      responseMode: "full",
      topologyFullAllowed: true,
    }));

    expect(payload).toMatchObject({
      ok: true,
      full: {
        topology: {
          schemaVersion: "tsn-agent.topology.intermediate.v0",
        },
      },
      metadata: {
        responseMode: "full",
        summaryOnly: false,
      },
    });
  });

  it("rejects full response mode without explicit topology allowance", () => {
    const payload = parseToolText(runTopologyTool("topology.build_artifacts", {
      topology: {},
      responseMode: "full",
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "FORBIDDEN_RESPONSE_MODE",
          path: "$.responseMode",
        },
      ],
    });
  });

  it("does not let topologyFullAllowed expose full non-topology payloads", () => {
    const payload = parseToolText(runTopologyTool("topology.describe_templates", {
      responseMode: "full",
      topologyFullAllowed: true,
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "FORBIDDEN_RESPONSE_MODE",
          path: "$.responseMode",
        },
      ],
    });
    expect(payload).not.toHaveProperty("full");
  });

  it("summarizes initialize results without full topology data by default", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
    }));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        templateId: "generic-line",
        nodeCount: 4,
        linkCount: 3,
      },
    });
    expect(payload).not.toHaveProperty("full.topology");
  });

  it("maps invalid inputs to structured errors", () => {
    const payload = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      params: { switchCount: 200 },
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "INVALID_TEMPLATE_PARAM",
          path: "$.params.switchCount",
        },
      ],
    });
  });

  it("returns structured errors for old template ids and dual-plane shortcut params", () => {
    const oldTemplate = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "aerospace-redundant",
      params: { endSystemCount: 7 },
    }));
    const shortcutParams = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "dual-plane-redundant",
      params: { switchCount: 4, endSystemsPerSwitch: 2 },
    }));

    expect(oldTemplate).toMatchObject({
      ok: false,
      errors: [
        {
          code: "UNKNOWN_TEMPLATE_ID",
          path: "$.templateId",
        },
      ],
    });
    expect(shortcutParams).toMatchObject({ ok: false });
    expect((shortcutParams as { errors: unknown[] }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "INVALID_TEMPLATE_PARAM",
        path: "$.params",
      }),
    ]));
  });

  it("returns structured limit errors for oversized ingress payload shapes", () => {
    const deepPayload = {};
    let cursor = deepPayload as Record<string, unknown>;
    for (let index = 0; index < 40; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    const deepResult = parseToolText(runTopologyTool("topology.initialize", deepPayload));
    const wideResult = parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      values: Array.from({ length: 70_000 }, (_, index) => ({ index })),
    }));

    expect(deepResult).toMatchObject({
      ok: false,
      errors: [
        {
          code: "LIMIT_EXCEEDED",
          details: { limit: "maxJsonDepth" },
        },
      ],
    });
    expect(wideResult).toMatchObject({
      ok: false,
      errors: [
        {
          code: "LIMIT_EXCEEDED",
          details: { limit: "maxIngressPayloadBytes" },
        },
      ],
    });
  });

  it("keeps measurement failures inside the structured error envelope", () => {
    const circular: Record<string, unknown> = { templateId: "generic-line" };
    circular.self = circular;

    const payload = parseToolText(runTopologyTool("topology.initialize", circular));

    expect(payload).toMatchObject({
      ok: false,
      errors: [
        {
          code: "CALL_FAILED",
          path: "$",
        },
      ],
    });
  });

  it("handles build_artifacts through the same summary boundary", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 1, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const payload = parseToolText(runTopologyTool("topology.build_artifacts", {
      topology: initialized.full!.topology,
    }));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        artifactCount: 4,
        containsHtml: false,
      },
    });
    expect(payload).not.toHaveProperty("full.artifacts");
  });

  it("routes all read-only topology handlers through the MCP summary boundary", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
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

    const inspect = parseToolText(runTopologyTool("topology.inspect", {
      topology: initialized.full!.topology,
      selectors: [{ kind: "node", id: "sw1" }],
    }));
    const describeArtifacts = parseToolText(runTopologyTool("topology.describe_artifacts", {
      artifacts: built.full!.artifacts,
    }));
    const validateIntermediate = parseToolText(runTopologyTool("topology.validate_intermediate", {
      topology: initialized.full!.topology,
    }));
    const validateArtifacts = parseToolText(runTopologyTool("topology.validate_artifacts", {
      artifacts: {
        "topology.json": built.full!.artifacts["topology.json"].data,
        "topo_feature.json": built.full!.artifacts["topo_feature.json"].data,
        "data-server.json": built.full!.artifacts["data-server.json"].data,
        "mac-forwarding-table.json": built.full!.artifacts["mac-forwarding-table.json"].data,
      },
    }));

    expect(inspect).toMatchObject({
      ok: true,
      summary: {
        selectedNodeIds: ["sw1"],
      },
    });
    expect(inspect).not.toHaveProperty("full.portUsage");
    expect(describeArtifacts).toMatchObject({
      ok: true,
      summary: {
        artifactCount: 4,
        containsHtml: false,
      },
    });
    expect(validateIntermediate).toMatchObject({
      ok: true,
      summary: {
        valid: true,
      },
    });
    expect(validateArtifacts).toMatchObject({
      ok: true,
      summary: {
        valid: true,
        artifactNames: [
          "data-server.json",
          "mac-forwarding-table.json",
          "topo_feature.json",
          "topology.json",
        ],
      },
    });
  });

  it("keeps apply_operations summaries free of full changeSet details", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const payload = parseToolText(runTopologyTool("topology.apply_operations", {
      topology: initialized.full!.topology,
      operations: [
        { op: "link.delete", linkId: "link-2" },
        {
          op: "node.add",
          node: {
            id: "sw3",
            numericId: 4,
            name: "SW-3",
            type: "switch",
            ports: [
              { id: "p1", name: "eth0", index: 0 },
              { id: "p2", name: "eth1", index: 1 },
            ],
            position: { x: 230, y: 220 },
          },
        },
        {
          op: "link.add",
          link: {
            id: "link-3",
            numericId: 3,
            source: { nodeId: "sw1", portId: "p2" },
            target: { nodeId: "sw3", portId: "p1" },
            medium: "ethernet",
            dataRateMbps: 1_000,
          },
        },
        {
          op: "link.add",
          link: {
            id: "link-4",
            numericId: 4,
            source: { nodeId: "sw3", portId: "p2" },
            target: { nodeId: "sw2", portId: "p3" },
            medium: "ethernet",
            dataRateMbps: 1_000,
          },
        },
      ],
      dryRun: true,
    }));

    expect(payload).toMatchObject({
      ok: true,
      summary: {
        dryRun: true,
        changeSet: {
          addedNodeCount: 1,
          removedLinkCount: 1,
          addedLinkCount: 2,
        },
      },
    });
    expect(payload).not.toHaveProperty("summary.changeSet.addedNodeIds");
    expect(payload).not.toHaveProperty("summary.changeSet.allocatedPorts");
    expect(payload).not.toHaveProperty("full.changeSet");
  });

  it("allows apply_operations to return updated topology while keeping full changeSet out of MCP text", () => {
    const initialized = initializeTopology({
      templateId: "generic-line",
      params: { switchCount: 2, endSystemsPerSwitch: 1 },
      responseMode: "full",
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) {
      return;
    }

    const payload = parseToolText(runTopologyTool("topology.apply_operations", {
      topology: initialized.full!.topology,
      operations: [
        { op: "link.delete", linkId: "link-2" },
        {
          op: "node.add",
          node: {
            id: "sw3",
            numericId: 4,
            name: "SW-3",
            type: "switch",
            ports: [
              { id: "p1", name: "eth0", index: 0 },
              { id: "p2", name: "eth1", index: 1 },
            ],
            position: { x: 230, y: 220 },
          },
        },
        {
          op: "link.add",
          link: {
            id: "link-3",
            numericId: 3,
            source: { nodeId: "sw1", portId: "p2" },
            target: { nodeId: "sw3", portId: "p1" },
            medium: "ethernet",
            dataRateMbps: 1_000,
          },
        },
        {
          op: "link.add",
          link: {
            id: "link-4",
            numericId: 4,
            source: { nodeId: "sw3", portId: "p2" },
            target: { nodeId: "sw2", portId: "p3" },
            medium: "ethernet",
            dataRateMbps: 1_000,
          },
        },
      ],
      responseMode: "full",
      topologyFullAllowed: true,
    }));

    expect(payload).toMatchObject({
      ok: true,
      full: {
        topology: {
          nodes: [
            expect.objectContaining({ id: "sw1" }),
            expect.objectContaining({ id: "sw2" }),
            expect.objectContaining({ id: "es1-1" }),
            expect.objectContaining({ id: "es2-1" }),
            expect.objectContaining({ id: "sw3" }),
          ],
        },
      },
    });
    expect(payload).not.toHaveProperty("full.changeSet");
  });

  it("passes real MCP tool arguments through without a payload wrapper", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTsnTopologyMcpServer();
    const client = new Client({ name: "topology-tools-test", version: "0.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "topology.initialize",
        arguments: {
          templateId: "generic-line",
          params: { switchCount: 2, endSystemsPerSwitch: 1 },
        },
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
      const payload = JSON.parse(text);

      expect(payload).toMatchObject({
        ok: true,
        summary: {
          templateId: "generic-line",
          nodeCount: 4,
          linkCount: 3,
        },
      });
      const tools = await client.listTools();
      const initializeTool = tools.tools.find((tool) => tool.name === "topology.initialize");
      const applyTool = tools.tools.find((tool) => tool.name === "topology.apply_operations");
      expect(initializeTool?.inputSchema.properties).toHaveProperty("templateId");
      expect(initializeTool?.inputSchema.properties).toHaveProperty("topologyFullAllowed");
      expect(applyTool?.inputSchema.properties).toHaveProperty("operations");
      expect(JSON.stringify(initializeTool?.inputSchema)).toContain("dual-plane-redundant");
      expect(JSON.stringify(initializeTool?.inputSchema)).toContain("switchGroups");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("recognizes the CLI entrypoint when the module path contains spaces", async () => {
    const fixtureDir = join(tmpdir(), "tsn topology mcp spaced path");
    const fixturePath = join(fixtureDir, "tsn-topology-server.mjs");
    await rm(fixtureDir, { recursive: true, force: true });
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(fixturePath, "", "utf8");

    try {
      expect(isCliEntrypoint(fixturePath, new URL(fixturePath, "file:").href)).toBe(true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
