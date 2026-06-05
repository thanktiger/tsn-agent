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

import { z } from "zod";
import {
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  applyOperationsInputSchema,
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

  it("inspect forwards only the session id and surfaces full rows", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: true,
        summary: {
          sessionId: "test-session-id",
          nodeCount: 1,
          linkCount: 0,
          nodes: [{ imac: 100, syncName: "0", nodeType: "switch", syncType: "{}", x: 0, y: 0, insertOrder: 0 }],
          links: [],
        },
      },
    });

    const payload = await parseToolText(runTopologyTool("topology.inspect", {}));

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/inspect");
    // DB-backed 全量 rows：不再有 topology/selectors 入参（sessionId 由 fetchSidecar 注入）。
    expect(body).toEqual({});
    expect(payload).toMatchObject({
      ok: true,
      summary: { nodeCount: 1, nodes: [{ imac: 100, syncName: "0" }] },
    });
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

  it("exposes an empty inspect input schema (no topology/selectors keys)", () => {
    const registry = createTopologyToolRegistry();
    const inspectTool = registry.find((tool) => tool.name === "topology.inspect");
    expect(Object.keys(inspectTool?.inputSchema ?? { stub: 1 })).toEqual([]);
  });

  it("rejects invalid apply_operations args at the MCP layer without hitting the sidecar", async () => {
    // runTopologyTool 直通 handler 绕过 zod —— SDK 校验只在 registerTool/Client
    // 调用路径生效，这里是「格式错误不打 HTTP」机制的唯一真实覆盖路径。
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTsnTopologyMcpServer();
    const client = new Client({ name: "topology-tools-test", version: "0.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      // 轮 3 真机错误输入：模型发明的 {"kind":"insert-switch"}。
      const result = await client.callTool({
        name: "topology.apply_operations",
        arguments: { operations: [{ kind: "insert-switch" }] },
      });

      expect(result.isError).toBe(true);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // SDK 把 zod 校验失败包成可读文本回给模型（不 throw 到协议层）。
      expect(text).toMatch(/[Ii]nvalid/);
      expect(text).toContain("op");
      expect(fetchSidecarMock).not.toHaveBeenCalled();
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

describe("applyOperationsInputSchema", () => {
  const schema = z.object(applyOperationsInputSchema());

  // 与 U6（serde 端 cargo 测试）共用同一 insert-switch batch 形态作 fixture，防两端漂移。
  const insertSwitchBatch = {
    operations: [
      { op: "link_delete", linkSeq: 0 },
      { op: "node_add", imac: 124, syncName: "24", x: 150, y: 40, syncType: '{"_classPath":"Q.Graphs.exchanger2"}', nodeType: "switch", insertOrder: 24 },
      { op: "link_add", linkSeq: 23, srcImac: 100, dstImac: 124, stylesJson: '{"leftLabel":"P1","rightLabel":"P1","speed":1000}' },
      { op: "link_add", linkSeq: 24, srcImac: 124, dstImac: 101, stylesJson: '{"leftLabel":"P2","rightLabel":"P1","speed":1000}' },
    ],
  };

  it("accepts a legal insert-switch batch", () => {
    const result = schema.safeParse(insertSwitchBatch);
    expect(result.success).toBe(true);
  });

  it("rejects the round-3 invented {kind: insert-switch} shape with an op hint", () => {
    const result = schema.safeParse({ operations: [{ kind: "insert-switch" }] });
    expect(result.success).toBe(false);
    const issueText = JSON.stringify(result.success ? [] : result.error.issues);
    expect(issueText).toContain("op");
  });

  it("accepts node_update with partial fields and node_delete", () => {
    const result = schema.safeParse({
      operations: [
        { op: "node_update", imac: 100, x: 300, y: 50 },
        { op: "node_delete", imac: 101 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects node_add missing required fields (imac / syncType / nodeType)", () => {
    const base = { op: "node_add", imac: 1, syncName: "0", x: 0, y: 0, syncType: "{}", nodeType: "switch", insertOrder: 0 };
    for (const missing of ["imac", "syncType", "nodeType"]) {
      const { [missing]: _omitted, ...incomplete } = base as Record<string, unknown>;
      const result = schema.safeParse({ operations: [incomplete] });
      expect(result.success, `node_add without ${missing} must be rejected`).toBe(false);
    }
  });

  it("rejects 33 operations via max(32)", () => {
    const operations = Array.from({ length: 33 }, (_, index) => ({
      op: "node_delete",
      imac: index,
    }));
    const result = schema.safeParse({ operations });
    expect(result.success).toBe(false);
  });

  it("rejects an empty operations batch via min(1)", () => {
    // 空批次在 sidecar 也会被拒（空事务会白白 mint mutationId）。
    const result = schema.safeParse({ operations: [] });
    expect(result.success).toBe(false);
  });
});
