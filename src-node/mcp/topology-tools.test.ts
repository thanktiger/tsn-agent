import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOPOLOGY_TOOL_NAMES } from "../../src/topology/topology-service";

// Plan v3 U4b complete: 所有 handler 走 sidecar HTTP；测试 hoist mock fetchSidecar
// 提供 canned 响应。每个测试断言 (a) 请求路由 / body 正确 (b) MCP 包封正确。
const fetchSidecarMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    status: 200,
    body: { ok: true, summary: {} },
  })),
);
const readSidecarEnvMock = vi.hoisted(() => vi.fn(() => ({
  url: "http://127.0.0.1:0",
  token: "test-token",
  sessionId: "test-session-id",
})));

vi.mock("./sidecar-client", () => ({
  fetchSidecar: fetchSidecarMock,
  readSidecarEnv: readSidecarEnvMock,
}));

import {
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  assertTopologyToolMapping,
  createTopologyToolRegistry,
  expectedAllowedToolName,
  runTopologyTool,
} from "./topology-tools";
import { createTsnTopologyMcpServer, isCliEntrypoint } from "./tsn-topology-server";

async function parseToolText(promise: Promise<{ content: Array<{ type: string; text?: string }> }>): Promise<unknown> {
  const result = await promise;
  return JSON.parse(result.content[0].text ?? "{}");
}

function lastFetchCall(): { route: string; body: Record<string, unknown> } {
  const call = fetchSidecarMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetchSidecar was not called");
  }
  return {
    route: call[0] as string,
    body: (call[1] ?? {}) as Record<string, unknown>,
  };
}

describe("topology MCP tool registry", () => {
  beforeEach(() => {
    fetchSidecarMock.mockReset();
    fetchSidecarMock.mockImplementation(async () => ({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: {} },
    }));
  });

  afterEach(() => {
    fetchSidecarMock.mockReset();
  });

  it("registers only the P0 topology tools and allowedTool mappings", () => {
    const registry = createTopologyToolRegistry();

    expect(registry.map((tool) => tool.name)).toEqual(TOPOLOGY_TOOL_NAMES);
    expect(registry.map((tool) => tool.allowedToolName)).toEqual(TOPOLOGY_MCP_ALLOWED_TOOLS);
    expect(TOPOLOGY_MCP_ALLOWED_TOOLS).toEqual(TOPOLOGY_TOOL_NAMES.map(expectedAllowedToolName));
    expect(registry.map((tool) => tool.name)).not.toContain("topology.render_mac_table_html");
    expect(() => assertTopologyToolMapping()).not.toThrow();
  });

  it("describe_templates forwards to sidecar and surfaces summary", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: true,
        summary: {
          templateCount: 3,
          templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
        },
      },
    });

    const payload = await parseToolText(runTopologyTool("topology.describe_templates", {}));

    const { route } = lastFetchCall();
    expect(route).toBe("/db/topology/describe_templates");
    expect(payload).toMatchObject({
      ok: true,
      summary: {
        templateCount: 3,
        templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
      },
    });
  });

  it("initialize forwards templateId + params and propagates sidecar errors", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: false,
        errors: [{
          code: "INVALID_TEMPLATE_PARAM",
          message: "$.params.switchCount must be an integer in [1, 12].",
          path: "$.params.switchCount",
        }],
      },
    });

    const payload = await parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      params: { switchCount: 200 },
    }));

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/initialize");
    expect(body).toMatchObject({
      templateId: "generic-line",
      params: { switchCount: 200 },
    });
    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_TEMPLATE_PARAM", path: "$.params.switchCount" }],
    });
  });

  it("inspect forwards topology + selectors", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: { selectedNodeIds: ["sw1"] } },
    });

    const payload = await parseToolText(runTopologyTool("topology.inspect", {
      topology: { schemaVersion: "tsn-agent.topology.intermediate.v0", nodes: [], links: [] },
      selectors: [{ kind: "node", id: "sw1" }],
    }));

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/inspect");
    expect(body).toHaveProperty("topology");
    expect(body).toHaveProperty("selectors", [{ kind: "node", id: "sw1" }]);
    expect(payload).toMatchObject({ ok: true, summary: { selectedNodeIds: ["sw1"] } });
  });

  it("build_artifacts forwards topology and returns artifacts summary", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: true,
        summary: { artifactCount: 4, containsHtml: false },
        full: { artifacts: { "topology.json": {} } },
      },
    });

    const payload = await parseToolText(runTopologyTool("topology.build_artifacts", {
      topology: { schemaVersion: "tsn-agent.topology.intermediate.v0", nodes: [], links: [] },
    }));

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/build_artifacts");
    expect(body).toHaveProperty("topology");
    expect(payload).toMatchObject({
      ok: true,
      summary: { artifactCount: 4, containsHtml: false },
    });
  });

  it("describe_artifacts forwards artifacts shape", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: { artifactCount: 4, containsHtml: false } },
    });

    const payload = await parseToolText(runTopologyTool("topology.describe_artifacts", {
      artifacts: { "topology.json": {} },
    }));

    const { route } = lastFetchCall();
    expect(route).toBe("/db/topology/describe_artifacts");
    expect(payload).toMatchObject({ ok: true, summary: { artifactCount: 4 } });
  });

  it("validate_artifacts forwards artifacts shape and surfaces sidecar errors", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: false,
        errors: [{
          code: "INVALID_ARTIFACT",
          message: "topo_feature.json must be an array.",
          path: "$.artifacts['topo_feature.json']",
        }],
      },
    });

    const payload = await parseToolText(runTopologyTool("topology.validate_artifacts", {
      artifacts: { "topology.json": {} },
    }));

    const { route } = lastFetchCall();
    expect(route).toBe("/db/topology/validate_artifacts");
    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_ARTIFACT" }],
    });
  });

  it("apply_operations forwards operations + dryRun and returns mutationId", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: { mutationId: 42, dryRun: false, applied: [] } },
    });

    const payload = await parseToolText(runTopologyTool("topology.apply_operations", {
      operations: [{ op: "node_add", imac: 1, syncName: "0", x: 0, y: 0, syncType: "{}", insertOrder: 0 }],
      dryRun: false,
    }));

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/apply_operations");
    expect(body).toHaveProperty("operations");
    expect(body).toHaveProperty("dryRun", false);
    expect(payload).toMatchObject({ ok: true, summary: { mutationId: 42 } });
  });

  it("returns structured limit errors for oversized ingress payload shapes", async () => {
    const deepPayload = {} as Record<string, unknown>;
    let cursor = deepPayload;
    for (let index = 0; index < 40; index += 1) {
      cursor.next = {} as Record<string, unknown>;
      cursor = cursor.next as Record<string, unknown>;
    }

    const deepResult = await parseToolText(runTopologyTool("topology.initialize", deepPayload));
    const wideResult = await parseToolText(runTopologyTool("topology.initialize", {
      templateId: "generic-line",
      values: Array.from({ length: 70_000 }, (_, index) => ({ index })),
    }));

    expect(deepResult).toMatchObject({
      ok: false,
      errors: [
        { code: "LIMIT_EXCEEDED", details: { limit: "maxJsonDepth" } },
      ],
    });
    expect(wideResult).toMatchObject({
      ok: false,
      errors: [
        { code: "LIMIT_EXCEEDED", details: { limit: "maxIngressPayloadBytes" } },
      ],
    });
  });

  it("keeps measurement failures inside the structured error envelope", async () => {
    const circular: Record<string, unknown> = { templateId: "generic-line" };
    circular.self = circular;

    const payload = await parseToolText(runTopologyTool("topology.initialize", circular));

    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "CALL_FAILED", path: "$" }],
    });
  });

  it("maps sidecar unreachable failures to SIDECAR_UNAVAILABLE", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: false as const,
      status: 0,
      code: "SIDECAR_UNREACHABLE",
      message: "connection refused",
      retryable: false,
    });

    const payload = await parseToolText(runTopologyTool("topology.describe_templates", {}));

    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "SIDECAR_UNAVAILABLE", retryable: false }],
    });
  });

  it("maps sidecar timeout to SIDECAR_UNAVAILABLE retryable", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: false as const,
      status: 0,
      code: "SIDECAR_TIMEOUT",
      message: "aborted",
      retryable: true,
    });

    const payload = await parseToolText(runTopologyTool("topology.validate", {
      topology: { schemaVersion: "tsn-agent.topology.intermediate.v0", nodes: [{ id: "x" }], links: [] },
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "SIDECAR_UNAVAILABLE", retryable: true }],
    });
  });

  it("preserves structured 4xx sidecar bodies (e.g. FORBIDDEN_OPERATION)", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: false as const,
      status: 422,
      code: "FORBIDDEN_OPERATION",
      message: "session does not exist",
      retryable: false,
    });

    const payload = await parseToolText(runTopologyTool("topology.apply_operations", {
      operations: [],
    }));

    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "FORBIDDEN_OPERATION", retryable: false }],
    });
  });

  it("passes real MCP tool arguments through without a payload wrapper", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: true,
        summary: { templateId: "generic-line", nodeCount: 4, linkCount: 3 },
        full: { topology: { schemaVersion: "tsn-agent.topology.intermediate.v0" } },
      },
    });

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
      expect(initializeTool?.inputSchema.properties).not.toHaveProperty("topologyFullAllowed");
      expect(applyTool?.inputSchema.properties).toHaveProperty("operations");
      expect(applyTool?.inputSchema.properties).not.toHaveProperty("topologyFullAllowed");
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
