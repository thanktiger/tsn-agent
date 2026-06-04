import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  TOPOLOGY_TOOL_NAMES,
  type TopologyToolName,
} from "../../src/topology/topology-service";
import { TOPOLOGY_LIMITS, measureJsonBytes, measureJsonDepth } from "../../src/topology/limits";
import {
  fetchSidecar,
  type SidecarFailure,
  type SidecarResult,
} from "./sidecar-client";

export const TOPOLOGY_MCP_ALLOWED_TOOLS = TOPOLOGY_TOOL_NAMES.map(expectedAllowedToolName);

export interface TopologyMcpToolDefinition {
  name: TopologyToolName;
  allowedToolName: (typeof TOPOLOGY_MCP_ALLOWED_TOOLS)[number];
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<CallToolResult>;
}

/**
 * Plan v3 U4b complete: 所有 8 个 topology MCP handler 走 sidecar HTTP fetch；
 * 完全删除 in-process compute path 与 responseMode/topologyFullAllowed 字段。
 *
 * 上游 invariant：sidecar URL/token/sessionId 由 Tauri 在 worker spawn env 中注入。
 * sidecar 不可达时（启动 panic 已 fail-closed），各 handler 返回 SIDECAR_UNAVAILABLE
 * 结构化错误而非 throw，确保 agent 拿到 isError=true 的 CallToolResult。
 */
export function createTopologyToolRegistry(): TopologyMcpToolDefinition[] {
  return [
    {
      name: "topology.describe_templates",
      allowedToolName: "mcp__tsn_topology__topology_describe_templates",
      title: "Describe topology templates",
      description: "Return the deterministic P0 topology template catalog.",
      inputSchema: {},
      handler: async (args) => callSidecarTool("/db/topology/describe_templates", args, {}),
    },
    {
      name: "topology.initialize",
      allowedToolName: "mcp__tsn_topology__topology_initialize",
      title: "Initialize topology",
      description: "Compute a topology from a template and persist it into the project DB, replacing the session's current topology. Returns summary.mutationId; use topology.inspect to query the persisted result.",
      inputSchema: initializeInputSchema(),
      handler: async (args) => callSidecarTool(
        "/db/topology/initialize",
        args,
        {
          templateId: pickString(args, "templateId"),
          params: pickValue(args, "params"),
        },
      ),
    },
    {
      name: "topology.inspect",
      allowedToolName: "mcp__tsn_topology__topology_inspect",
      title: "Inspect topology",
      description: "Inspect nodes, links and adjacency summaries by structured selectors.",
      inputSchema: {
        topology: z.unknown().optional(),
        selectors: z.unknown().optional(),
        includeAdjacency: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/inspect",
        args,
        {
          topology: pickValue(args, "topology"),
          selectors: pickValue(args, "selectors"),
          includeAdjacency: pickValue(args, "includeAdjacency"),
        },
      ),
    },
    {
      name: "topology.describe_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_describe_artifacts",
      title: "Describe topology artifacts",
      description: "Return deterministic artifact count and size summaries.",
      inputSchema: {
        artifacts: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/describe_artifacts",
        args,
        { artifacts: pickValue(args, "artifacts") ?? {} },
      ),
    },
    {
      name: "topology.validate",
      allowedToolName: "mcp__tsn_topology__topology_validate",
      title: "Validate intermediate topology",
      description: "Validate an IntermediateTopology and return structured errors.",
      inputSchema: {
        topology: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/validate",
        args,
        { topology: pickValue(args, "topology") },
      ),
    },
    {
      name: "topology.build_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_build_artifacts",
      title: "Build topology artifacts",
      description: "Build four legacy JSON topology artifacts from an IntermediateTopology.",
      inputSchema: {
        topology: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/build_artifacts",
        args,
        { topology: pickValue(args, "topology") },
      ),
    },
    {
      name: "topology.validate_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_validate_artifacts",
      title: "Validate topology artifacts",
      description: "Validate legacy JSON artifact references.",
      inputSchema: {
        artifacts: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/validate_artifacts",
        args,
        { artifacts: pickValue(args, "artifacts") ?? {} },
      ),
    },
    {
      name: "topology.apply_operations",
      allowedToolName: "mcp__tsn_topology__topology_apply_operations",
      title: "Apply topology operations",
      description: "Apply the P0 insert-switch operation subset to topology P0 tables.",
      inputSchema: {
        operations: z.unknown().optional(),
        dryRun: z.unknown().optional(),
      },
      handler: async (args) => callSidecarTool(
        "/db/topology/apply_operations",
        args,
        {
          operations: pickValue(args, "operations") ?? [],
          dryRun: pickValue(args, "dryRun") ?? false,
        },
      ),
    },
  ];
}

export async function runTopologyTool(name: TopologyToolName, args: unknown): Promise<CallToolResult> {
  const tool = createTopologyToolRegistry().find((candidate) => candidate.name === name);

  if (!tool) {
    return toCallToolResult({
      ok: false,
      errors: [
        {
          code: "UNKNOWN_TOOL",
          message: `Unknown topology tool: ${name}`,
          path: "$.name",
          severity: "error",
          retryable: false,
          requiresUserClarification: false,
        },
      ],
    });
  }

  return tool.handler(args);
}

interface IngressError {
  code: string;
  message: string;
  path: string;
  severity: "error";
  details: Record<string, unknown>;
  retryable: boolean;
  requiresUserClarification: boolean;
}

async function callSidecarTool(
  route: string,
  args: unknown,
  body: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const ingressError = validateIngress(args);
    if (ingressError) {
      return toCallToolResult({ ok: false, errors: [ingressError] });
    }
    const sanitized = pruneUndefined(body);
    const result: SidecarResult = await fetchSidecar(route, sanitized);
    if (!result.ok) {
      return toCallToolResult(sidecarFailureToToolResult(result));
    }
    return toCallToolResult(result.body);
  } catch (error) {
    return toCallToolResult({
      ok: false,
      errors: [
        {
          code: "CALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
          path: "$",
          severity: "error",
          retryable: true,
          requiresUserClarification: false,
        },
      ],
    });
  }
}

function sidecarFailureToToolResult(failure: SidecarFailure): Record<string, unknown> {
  return {
    ok: false,
    errors: [
      {
        code: failure.code === "SIDECAR_UNREACHABLE" || failure.code === "SIDECAR_TIMEOUT"
          ? "SIDECAR_UNAVAILABLE"
          : failure.code,
        message: failure.message || "topology sidecar returned an error",
        path: "$",
        severity: "error",
        details: { status: failure.status, code: failure.code },
        retryable: failure.retryable,
        requiresUserClarification: false,
      },
    ],
  };
}

function validateIngress(args: unknown): IngressError | undefined {
  const bytes = measureJsonBytes(args ?? {});
  if (bytes > TOPOLOGY_LIMITS.maxIngressPayloadBytes) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `ingress payload bytes exceeded: ${bytes} > ${TOPOLOGY_LIMITS.maxIngressPayloadBytes}`,
      path: "$",
      severity: "error",
      details: {
        limit: "maxIngressPayloadBytes",
        actual: bytes,
        maximum: TOPOLOGY_LIMITS.maxIngressPayloadBytes,
      },
      retryable: false,
      requiresUserClarification: false,
    };
  }

  const depth = measureJsonDepth(args ?? {});
  if (depth > TOPOLOGY_LIMITS.maxJsonDepth) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `JSON depth exceeded: ${depth} > ${TOPOLOGY_LIMITS.maxJsonDepth}`,
      path: "$",
      severity: "error",
      details: {
        limit: "maxJsonDepth",
        actual: depth,
        maximum: TOPOLOGY_LIMITS.maxJsonDepth,
      },
      retryable: false,
      requiresUserClarification: false,
    };
  }

  return undefined;
}

function toCallToolResult(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function initializeInputSchema(): z.ZodRawShape {
  const planeSchema = z.enum(["A", "B"]);
  const attachmentEndpointSchema = z.object({
    switchId: z.string().min(1),
    plane: planeSchema,
  });
  const dualPlaneParamsSchema = z.object({
    dataRateMbps: z.number().int().optional(),
    planes: z.array(z.object({
      id: planeSchema,
      name: z.string().optional(),
    })).length(2),
    switches: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      plane: planeSchema,
      groupId: z.string().min(1),
      role: z.literal("access").optional(),
      portCount: z.number().int().positive().optional(),
    })).min(1),
    switchGroups: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      planeSwitches: z.object({
        A: z.string().min(1),
        B: z.string().min(1),
      }),
    })).min(1),
    endSystems: z.array(z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      groupId: z.string().min(1),
      attachment: z.object({
        primary: attachmentEndpointSchema,
        backup: attachmentEndpointSchema,
      }),
    })).min(1),
    backbone: z.object({
      mode: z.enum(["line", "ring"]),
      withinPlane: z.literal(true),
    }),
    crossPlaneLinks: z.object({
      mode: z.enum(["none", "paired"]),
    }),
    allocation: z.object({
      idPrefix: z.object({
        switch: z.string().optional(),
        endSystem: z.string().optional(),
        link: z.string().optional(),
      }).optional(),
      portStrategy: z.literal("first-free").optional(),
      layoutStrategy: z.literal("dual-plane-grid").optional(),
    }).optional(),
  }).strict();

  return {
    templateId: z.enum(["generic-line", "generic-ring", "dual-plane-redundant"]),
    params: z.union([
      z.object({
        switchCount: z.number().int().min(1).max(12).optional(),
        endSystemsPerSwitch: z.number().int().min(1).max(24).optional(),
        dataRateMbps: z.number().int().optional(),
      }).strict(),
      dualPlaneParamsSchema,
    ]).optional(),
  };
}

function pickString(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function pickValue(args: unknown, key: string): unknown {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return (args as Record<string, unknown>)[key];
  }
  return undefined;
}

function pruneUndefined(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function expectedAllowedToolName(name: TopologyToolName): string {
  return `mcp__tsn_topology__${name.replaceAll(".", "_")}`;
}

export function assertTopologyToolMapping(): void {
  const registry = createTopologyToolRegistry();
  const names = registry.map((tool) => tool.name);

  if (JSON.stringify(names) !== JSON.stringify(TOPOLOGY_TOOL_NAMES)) {
    throw new Error(`Topology MCP tool registry drifted: ${names.join(", ")}`);
  }

  for (const tool of registry) {
    if (tool.allowedToolName !== expectedAllowedToolName(tool.name)) {
      throw new Error(`Topology MCP allowed tool mapping drifted for ${tool.name}.`);
    }
  }
}
