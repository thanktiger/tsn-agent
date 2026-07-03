import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOPOLOGY_TOOL_NAMES } from "../../src/topology/topology-service";

// Plan v3 U4b complete: 所有 handler 走 sidecar HTTP；测试 hoist mock fetchSidecar
// 提供 canned 响应。每个测试断言 (a) 请求路由 / body 正确 (b) MCP 包封正确。
const fetchSidecarMock = vi.hoisted(() =>
  vi.fn(
    async (_route: string, _body?: unknown): Promise<SidecarResult> => ({
      ok: true,
      status: 200,
      body: { ok: true, summary: {} },
    }),
  ),
);
const readSidecarEnvMock = vi.hoisted(() =>
  vi.fn(() => ({
    url: "http://127.0.0.1:0",
    token: "test-token",
    sessionId: "test-session-id",
  })),
);

vi.mock("./sidecar-client", () => ({
  fetchSidecar: fetchSidecarMock,
  readSidecarEnv: readSidecarEnvMock,
}));

import { z } from "zod";
import { FLOW_TOOL_NAMES, TIMESYNC_TOOL_NAMES } from "../../src/topology/topology-service";
import type { SidecarResult } from "./sidecar-client";
import {
  applyOperationsInputSchema,
  assertFlowToolMapping,
  assertTopologyToolMapping,
  createFlowToolRegistry,
  createTimesyncToolRegistry,
  createTopologyToolRegistry,
  expectedAllowedToolName,
  FLOW_MCP_ALLOWED_TOOLS,
  initializeInputSchema,
  runTimesyncTool,
  runTopologyTool,
  setGmInputSchema,
  setParamsInputSchema,
  TIMESYNC_MCP_ALLOWED_TOOLS,
  TOPOLOGY_MCP_ALLOWED_TOOLS,
} from "./topology-tools";
import { createTsnTopologyMcpServer, isCliEntrypoint } from "./tsn-topology-server";

async function parseToolText(
  promise: Promise<{ content: Array<{ type: string; text?: string }> }>,
): Promise<unknown> {
  const result = await promise;
  return JSON.parse(result.content[0].text ?? "{}");
}

// MCP client.callTool 的运行时结果形状（SDK 默认返回类型里 content 为 unknown）。
type McpToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function lastFetchCall(): { route: string; body: Record<string, unknown> } {
  const call = fetchSidecarMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetchSidecar was not called");
  }
  return {
    route: call[0],
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
          templateIds: ["hop-linear", "dual-plane-redundant"],
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
        templateIds: ["hop-linear", "dual-plane-redundant"],
      },
    });
  });

  it("describe_templates forwards the optional scenario filter in the sidecar body", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: { templateCount: 3 } },
    });

    await parseToolText(
      runTopologyTool("topology.describe_templates", { scenario: "aerospace-onboard" }),
    );

    const { body } = lastFetchCall();
    expect(body.scenario).toBe("aerospace-onboard");
  });

  it("initialize forwards templateId + params and propagates sidecar errors", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: {
        ok: false,
        errors: [
          {
            code: "INVALID_TEMPLATE_PARAM",
            message: "$.params.switchCount must be an integer in [1, 12].",
            path: "$.params.switchCount",
          },
        ],
      },
    });

    const payload = await parseToolText(
      runTopologyTool("topology.initialize", {
        templateId: "hop-linear",
        params: { switchCount: 200 },
      }),
    );

    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/topology/initialize");
    expect(body).toMatchObject({
      templateId: "hop-linear",
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
          nodes: [{ mid: "0", nodeType: "switch", x: 0, y: 0, insertOrder: 0 }],
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
      summary: { nodeCount: 1, nodes: [{ mid: "0" }] },
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

    const payload = await parseToolText(
      runTopologyTool("topology.build_artifacts", {
        topology: { schemaVersion: "tsn-agent.topology.intermediate.v0", nodes: [], links: [] },
      }),
    );

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

    const payload = await parseToolText(
      runTopologyTool("topology.describe_artifacts", {
        artifacts: { "topology.json": {} },
      }),
    );

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
        errors: [
          {
            code: "INVALID_ARTIFACT",
            message: "topo_feature.json must be an array.",
            path: "$.artifacts['topo_feature.json']",
          },
        ],
      },
    });

    const payload = await parseToolText(
      runTopologyTool("topology.validate_artifacts", {
        artifacts: { "topology.json": {} },
      }),
    );

    const { route } = lastFetchCall();
    expect(route).toBe("/db/topology/validate_artifacts");
    expect(payload).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_ARTIFACT" }],
    });
  });

  it("apply_operations forwards operations + dryRun and returns mutationId", async () => {
    fetchSidecarMock
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { mutationId: 42, dryRun: false, applied: [] } },
      })
      // U5：apply 成功非 dryRun → handler 追调 validate（库内结构）。
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { valid: true, errors: [], caliber: "structural_only" } },
      });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [{ op: "node_add", mid: "0", x: 0, y: 0, nodeType: "switch", insertOrder: 0 }],
        dryRun: false,
      }),
    );

    // 第一次调用是 apply（携带 operations + dryRun）。
    const applyCall = fetchSidecarMock.mock.calls[0];
    expect(applyCall[0]).toBe("/db/topology/apply_operations");
    expect(applyCall[1]).toHaveProperty("operations");
    expect(applyCall[1]).toHaveProperty("dryRun", false);
    expect(payload).toMatchObject({ ok: true, summary: { mutationId: 42 } });
  });

  it("U5: apply 成功非 dryRun 后自动追调 validate，把结构结论并进返回（正例：孤立节点）", async () => {
    fetchSidecarMock
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { mutationId: 7, dryRun: false, applied: [{}] } },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: {
          ok: true,
          summary: {
            valid: false,
            errors: ["ES-2 没连任何线，是个孤立节点。"],
            caliber: "structural_only",
          },
        },
      });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [
          { op: "node_add", mid: "2", x: 0, y: 0, nodeType: "endSystem", insertOrder: 2 },
        ],
        dryRun: false,
      }),
    );

    // 两次 sidecar 调用：apply → validate（无参验库内）。
    expect(fetchSidecarMock).toHaveBeenCalledTimes(2);
    expect(fetchSidecarMock.mock.calls[1][0]).toBe("/db/topology/validate");
    // 即使 agent 没显式调 validate，apply 返回也带结构错误结论。
    expect(payload).toMatchObject({
      ok: true,
      summary: { mutationId: 7 },
      validation: { ran: true, valid: false, errors: ["ES-2 没连任何线，是个孤立节点。"] },
    });
  });

  it("U5: 合法 apply 不误报结构错误（负例）", async () => {
    fetchSidecarMock
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { mutationId: 8, dryRun: false, applied: [{}] } },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { valid: true, errors: [], caliber: "structural_only" } },
      });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [{ op: "node_update", mid: "0", x: 1, y: 1 }],
        dryRun: false,
      }),
    );

    expect(fetchSidecarMock).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({ ok: true, validation: { ran: true, valid: true, errors: [] } });
  });

  it("U5: dryRun 不追 validate（只一次 sidecar 调用、无 validation 字段）", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: true, summary: { mutationId: null, dryRun: true, applied: [{}] } },
    });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [{ op: "node_delete", mid: "3" }],
        dryRun: true,
      }),
    );

    expect(fetchSidecarMock).toHaveBeenCalledTimes(1);
    expect(fetchSidecarMock.mock.calls[0][0]).toBe("/db/topology/apply_operations");
    expect(payload).not.toHaveProperty("validation");
  });

  it("U5: apply 自身失败时不追 validate（失败已是结论）", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: true as const,
      status: 200,
      body: { ok: false, errors: [{ code: "MID_TAKEN", message: "mid 0 已被占用" }] },
    });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [{ op: "node_add", mid: "0", x: 0, y: 0, nodeType: "switch", insertOrder: 0 }],
        dryRun: false,
      }),
    );

    expect(fetchSidecarMock).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ ok: false, errors: [{ code: "MID_TAKEN" }] });
  });

  it("U5: validate 追调失败不掩盖 apply 成功（validation.ran=false）", async () => {
    fetchSidecarMock
      .mockResolvedValueOnce({
        ok: true as const,
        status: 200,
        body: { ok: true, summary: { mutationId: 9, dryRun: false, applied: [{}] } },
      })
      // 第二次（validate）sidecar 不可达。
      .mockResolvedValueOnce({
        ok: false as const,
        status: 0,
        code: "SIDECAR_UNREACHABLE",
        message: "connection refused",
        retryable: false,
      });

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [{ op: "node_add", mid: "1", x: 0, y: 0, nodeType: "switch", insertOrder: 1 }],
        dryRun: false,
      }),
    );

    expect(fetchSidecarMock).toHaveBeenCalledTimes(2);
    // apply 成功（ok/mutationId）不被掩盖；validate 调用失败标 ran:false（非结构问题）。
    expect(payload).toMatchObject({
      ok: true,
      summary: { mutationId: 9 },
      validation: { ran: false },
    });
  });

  it("returns structured limit errors for oversized ingress payload shapes", async () => {
    const deepPayload = {} as Record<string, unknown>;
    let cursor = deepPayload;
    for (let index = 0; index < 40; index += 1) {
      cursor.next = {} as Record<string, unknown>;
      cursor = cursor.next as Record<string, unknown>;
    }

    const deepResult = await parseToolText(runTopologyTool("topology.initialize", deepPayload));
    const wideResult = await parseToolText(
      runTopologyTool("topology.initialize", {
        templateId: "hop-linear",
        values: Array.from({ length: 70_000 }, (_, index) => ({ index })),
      }),
    );

    expect(deepResult).toMatchObject({
      ok: false,
      errors: [{ code: "LIMIT_EXCEEDED", details: { limit: "maxJsonDepth" } }],
    });
    expect(wideResult).toMatchObject({
      ok: false,
      errors: [{ code: "LIMIT_EXCEEDED", details: { limit: "maxIngressPayloadBytes" } }],
    });
  });

  it("keeps measurement failures inside the structured error envelope", async () => {
    const circular: Record<string, unknown> = { templateId: "hop-linear" };
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

    const payload = await parseToolText(
      runTopologyTool("topology.validate", {
        topology: {
          schemaVersion: "tsn-agent.topology.intermediate.v0",
          nodes: [{ id: "x" }],
          links: [],
        },
      }),
    );

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

    const payload = await parseToolText(
      runTopologyTool("topology.apply_operations", {
        operations: [],
      }),
    );

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
        summary: { templateId: "hop-linear", nodeCount: 4, linkCount: 3 },
        full: { topology: { schemaVersion: "tsn-agent.topology.intermediate.v0" } },
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTsnTopologyMcpServer();
    const client = new Client({ name: "topology-tools-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = (await client.callTool({
        name: "topology.initialize",
        arguments: {
          templateId: "hop-linear",
          params: { switchCount: 2 },
        },
      })) as McpToolResult;
      const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "{}") : "{}";
      const payload = JSON.parse(text);

      expect(payload).toMatchObject({
        ok: true,
        summary: {
          templateId: "hop-linear",
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

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // 轮 3 真机错误输入：模型发明的 {"kind":"insert-switch"}。
      const result = (await client.callTool({
        name: "topology.apply_operations",
        arguments: { operations: [{ kind: "insert-switch" }] },
      })) as McpToolResult;

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
      expect(isCliEntrypoint(fixturePath, pathToFileURL(fixturePath).href)).toBe(true);
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
      { op: "node_add", mid: "24", x: 150, y: 40, nodeType: "switch", insertOrder: 24 },
      {
        op: "link_add",
        linkSeq: 23,
        srcNode: "0",
        dstNode: "24",
        srcPort: 1,
        dstPort: 1,
        speed: 1000,
        stylesJson: '{"plane":"A","role":"master"}',
      },
      {
        op: "link_add",
        linkSeq: 24,
        srcNode: "24",
        dstNode: "1",
        srcPort: 2,
        dstPort: 1,
        speed: 1000,
        stylesJson: '{"plane":"A","role":"slave"}',
      },
    ],
  };

  it("accepts a legal insert-switch batch", () => {
    const result = schema.safeParse(insertSwitchBatch);
    expect(result.success).toBe(true);
  });

  // U6/KTD4：link_add 端口走显式必填字段——缺 srcPort/dstPort 在 MCP 层即被拒。
  it("U6: link_add rejects missing srcPort/dstPort", () => {
    const result = schema.safeParse({
      operations: [
        {
          op: "link_add",
          linkSeq: 23,
          srcNode: "0",
          dstNode: "24",
          stylesJson: '{"plane":"A"}',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("U9: node_add accepts optional name (omitted still valid)", () => {
    const withName = schema.safeParse({
      operations: [
        {
          op: "node_add",
          mid: "5",
          name: "SW-5",
          x: 0,
          y: 0,
          nodeType: "switch",
          insertOrder: 5,
        },
      ],
    });
    expect(withName.success).toBe(true);
    const noName = schema.safeParse({
      operations: [{ op: "node_add", mid: "6", x: 0, y: 0, nodeType: "switch", insertOrder: 6 }],
    });
    expect(noName.success).toBe(true);
  });

  it("U9 review: rejects empty-string name; node_update accepts name", () => {
    // 空串 name 被拒（避免 '' 与 NULL 两种「无名」表示）。
    expect(
      schema.safeParse({
        operations: [
          {
            op: "node_add",
            mid: "5",
            name: "",
            x: 0,
            y: 0,
            nodeType: "switch",
            insertOrder: 5,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ operations: [{ op: "node_update", mid: "5", name: "" }] }).success,
    ).toBe(false);
    // node_update 接受非空 name（改名闭环）。
    expect(
      schema.safeParse({ operations: [{ op: "node_update", mid: "5", name: "SW-9" }] }).success,
    ).toBe(true);
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
        { op: "node_update", mid: "0", x: 300, y: 50 },
        { op: "node_delete", mid: "1" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects node_add missing required fields (mid / nodeType)", () => {
    const base = { op: "node_add", mid: "0", x: 0, y: 0, nodeType: "switch", insertOrder: 0 };
    for (const missing of ["mid", "nodeType"]) {
      const { [missing]: _omitted, ...incomplete } = base as Record<string, unknown>;
      const result = schema.safeParse({ operations: [incomplete] });
      expect(result.success, `node_add without ${missing} must be rejected`).toBe(false);
    }
  });

  it("rejects 33 operations via max(32)", () => {
    const operations = Array.from({ length: 33 }, (_, index) => ({
      op: "node_delete",
      mid: index.toString(),
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

describe("initializeInputSchema dual-plane narrowing (U2)", () => {
  const schema = z.object(initializeInputSchema());
  const base = {
    templateId: "dual-plane-redundant",
    params: {
      dataRateMbps: 1000,
      planes: [{ id: "A" }, { id: "B" }],
      switches: [
        { id: "sw1", plane: "A", groupId: "g1" },
        { id: "sw2", plane: "B", groupId: "g1" },
      ],
      switchGroups: [{ id: "g1", planeSwitches: { A: "sw1", B: "sw2" } }],
      endSystems: [
        {
          id: "es1",
          groupId: "g1",
          attachment: {
            primary: { switchId: "sw1", plane: "A" },
            backup: { switchId: "sw2", plane: "B" },
          },
        },
      ],
      backbone: { mode: "line", withinPlane: true },
      crossPlaneLinks: { mode: "none" },
    },
  };

  it("accepts backbone=line + crossPlaneLinks=none", () => {
    expect(schema.safeParse(base).success).toBe(true);
  });

  it("rejects backbone.mode=ring after narrowing to line", () => {
    const ring = structuredClone(base);
    ring.params.backbone.mode = "ring";
    expect(schema.safeParse(ring).success).toBe(false);
  });

  it("rejects crossPlaneLinks.mode=paired after narrowing to none", () => {
    const paired = structuredClone(base);
    paired.params.crossPlaneLinks.mode = "paired";
    expect(schema.safeParse(paired).success).toBe(false);
  });
});

describe("timesync MCP tool registry", () => {
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

  it("registers the timesync tools with the expected allowedTool mappings", () => {
    const registry = createTimesyncToolRegistry();
    expect(registry.map((tool) => tool.name)).toEqual(TIMESYNC_TOOL_NAMES);
    expect(registry.map((tool) => tool.allowedToolName)).toEqual(TIMESYNC_MCP_ALLOWED_TOOLS);
    expect(TIMESYNC_MCP_ALLOWED_TOOLS).toEqual(TIMESYNC_TOOL_NAMES.map(expectedAllowedToolName));
    // timesync 工具与 topology 工具同住 tsn_topology server，前缀一致。
    for (const name of TIMESYNC_MCP_ALLOWED_TOOLS) {
      expect(name.startsWith("mcp__tsn_topology__timesync_")).toBe(true);
    }
  });

  it("set_gm forwards gmMid + optional flags to the sidecar", async () => {
    await parseToolText(
      runTimesyncTool("timesync.set_gm", { gmMid: "3", oneStepMode: 1, freSwitch: 0 }),
    );
    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/timesync/set_gm");
    expect(body).toMatchObject({ gmMid: "3", oneStepMode: 1, freSwitch: 0 });
  });

  it("toggle_link forwards linkSeq + disabled", async () => {
    await parseToolText(runTimesyncTool("timesync.toggle_link", { linkSeq: 2, disabled: true }));
    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/timesync/toggle_link");
    expect(body).toMatchObject({ linkSeq: 2, disabled: true });
  });

  it("set_params forwards only provided fields (mid omitted = all nodes)", async () => {
    await parseToolText(runTimesyncTool("timesync.set_params", { syncPeriod: 250 }));
    const { route, body } = lastFetchCall();
    expect(route).toBe("/db/timesync/set_params");
    expect(body).toMatchObject({ syncPeriod: 250 });
    // pruneUndefined 剔除未提供字段：不发 mid / offsetThreshold。
    expect(body).not.toHaveProperty("mid");
    expect(body).not.toHaveProperty("offsetThreshold");
  });

  it("inspect and undo post with no extra body", async () => {
    await parseToolText(runTimesyncTool("timesync.inspect", {}));
    expect(lastFetchCall().route).toBe("/db/timesync/inspect");
    await parseToolText(runTimesyncTool("timesync.undo", {}));
    expect(lastFetchCall().route).toBe("/db/timesync/undo");
  });

  it("propagates sidecar failures as structured tool errors", async () => {
    fetchSidecarMock.mockResolvedValueOnce({
      ok: false as const,
      status: 422,
      code: "FORBIDDEN_OPERATION",
      message: "unknown session",
      retryable: false,
    });
    const payload = (await parseToolText(runTimesyncTool("timesync.set_gm", { gmMid: "3" }))) as {
      ok: boolean;
      errors: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0].code).toBe("FORBIDDEN_OPERATION");
  });

  it("returns UNKNOWN_TOOL for an unregistered timesync tool name", async () => {
    const payload = (await parseToolText(
      // biome-ignore lint/suspicious/noExplicitAny: 故意传非法工具名探测 UNKNOWN_TOOL。
      runTimesyncTool("timesync.bogus" as any, {}),
    )) as { ok: boolean; errors: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0].code).toBe("UNKNOWN_TOOL");
  });
});

describe("timesync input schemas (zod boundary)", () => {
  const setGm = z.object(setGmInputSchema());
  const setParams = z.object(setParamsInputSchema());

  it("set_gm requires non-empty gmMid; flags are 0/1", () => {
    expect(setGm.safeParse({ gmMid: "3" }).success).toBe(true);
    expect(setGm.safeParse({ gmMid: "" }).success).toBe(false);
    expect(setGm.safeParse({ gmMid: "3", oneStepMode: 1, freSwitch: 0 }).success).toBe(true);
    // 标志越界（2 / 负数）早失败。
    expect(setGm.safeParse({ gmMid: "3", oneStepMode: 2 }).success).toBe(false);
    expect(setGm.safeParse({ gmMid: "3", freSwitch: -1 }).success).toBe(false);
  });

  it("set_params syncPeriod accepts only 2^k-second integer-ms values; measurePeriod stays power-of-two ms", () => {
    // syncPeriod 合法集 {125,250,500,1000,2000,4000,8000}（2 的幂秒、整数 ms）。
    expect(setParams.safeParse({ syncPeriod: 125 }).success).toBe(true);
    expect(setParams.safeParse({ syncPeriod: 1000 }).success).toBe(true);
    expect(setParams.safeParse({ syncPeriod: 8000 }).success).toBe(true);
    // 旧 128（2 的幂 ms 但非 2 的幂秒）+ 其它非集合值 → 拒绝。
    expect(setParams.safeParse({ syncPeriod: 128 }).success).toBe(false);
    expect(setParams.safeParse({ syncPeriod: 1 }).success).toBe(false);
    expect(setParams.safeParse({ syncPeriod: 32768 }).success).toBe(false);
    expect(setParams.safeParse({ syncPeriod: 100 }).success).toBe(false);
    // measurePeriod 仍是 2 的幂 ms（1..32768）。
    expect(setParams.safeParse({ measurePeriod: 1024 }).success).toBe(true);
    expect(setParams.safeParse({ measurePeriod: 125 }).success).toBe(false);
  });

  it("set_params meanLinkDelayThresh is a power of two 1..128", () => {
    expect(setParams.safeParse({ meanLinkDelayThresh: 128 }).success).toBe(true);
    expect(setParams.safeParse({ meanLinkDelayThresh: 64 }).success).toBe(true);
    // 800（U7 Rust 默认）不是 2 的幂、且 >128 → zod 拒绝（须由用户夹到合法幂）。
    expect(setParams.safeParse({ meanLinkDelayThresh: 800 }).success).toBe(false);
    expect(setParams.safeParse({ meanLinkDelayThresh: 256 }).success).toBe(false);
    expect(setParams.safeParse({ meanLinkDelayThresh: 3 }).success).toBe(false);
  });

  it("set_params offsetThreshold is an integer 0..4095", () => {
    expect(setParams.safeParse({ offsetThreshold: 0 }).success).toBe(true);
    expect(setParams.safeParse({ offsetThreshold: 1000 }).success).toBe(true);
    expect(setParams.safeParse({ offsetThreshold: 4095 }).success).toBe(true);
    expect(setParams.safeParse({ offsetThreshold: 4096 }).success).toBe(false);
    expect(setParams.safeParse({ offsetThreshold: -1 }).success).toBe(false);
    expect(setParams.safeParse({ offsetThreshold: 1.5 }).success).toBe(false);
  });

  it("set_params reportEnable is 0/1; mid optional non-empty", () => {
    expect(setParams.safeParse({ reportEnable: 1 }).success).toBe(true);
    expect(setParams.safeParse({ reportEnable: 0 }).success).toBe(true);
    expect(setParams.safeParse({ reportEnable: 2 }).success).toBe(false);
    expect(setParams.safeParse({ mid: "5", syncPeriod: 250 }).success).toBe(true);
    expect(setParams.safeParse({ mid: "" }).success).toBe(false);
    // 空补丁（全部省略）是合法的——sidecar 端 COALESCE 全 no-op。
    expect(setParams.safeParse({}).success).toBe(true);
  });
});

describe("flow MCP tool registry", () => {
  it("registers the flow tools with the expected allowedTool mappings (drift guard)", () => {
    const registry = createFlowToolRegistry();
    expect(registry.map((tool) => tool.name)).toEqual(FLOW_TOOL_NAMES);
    expect(registry.map((tool) => tool.allowedToolName)).toEqual(FLOW_MCP_ALLOWED_TOOLS);
    expect(FLOW_MCP_ALLOWED_TOOLS).toEqual(FLOW_TOOL_NAMES.map(expectedAllowedToolName));
    for (const name of FLOW_MCP_ALLOWED_TOOLS) {
      expect(name.startsWith("mcp__tsn_topology__flow_")).toBe(true);
    }
    expect(() => assertFlowToolMapping()).not.toThrow();
  });

  it("flow.add_stream zod schema rejects out-of-range pcp / non-positive period (early fail, R6)", () => {
    const addStream = z.object(
      createFlowToolRegistry().find((t) => t.name === "flow.add_stream")?.inputSchema ?? {},
    );
    const base = {
      class: "ST",
      pcp: 7,
      periodUs: 500,
      frameBytes: 512,
      count: 10000,
      talker: "0",
      listener: "1",
    };
    expect(addStream.safeParse(base).success).toBe(true);
    // pcp 越界。
    expect(addStream.safeParse({ ...base, pcp: 8 }).success).toBe(false);
    // 周期非正。
    expect(addStream.safeParse({ ...base, periodUs: 0 }).success).toBe(false);
    // 报文超 MTU。
    expect(addStream.safeParse({ ...base, frameBytes: 2000 }).success).toBe(false);
    // class 非法。
    expect(addStream.safeParse({ ...base, class: "XX" }).success).toBe(false);
    // maxLatencyUs 可选（省略合法）。
    expect(addStream.safeParse(base).success).toBe(true);
  });
});
