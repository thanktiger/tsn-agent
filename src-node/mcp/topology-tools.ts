import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  TOPOLOGY_TOOL_NAMES,
  type TopologyToolName,
} from "../../src/topology/topology-service";
import { buildTopologyArtifacts, describeTopologyArtifacts, validateTopologyArtifacts, type TopologyArtifacts } from "../../src/topology/artifacts";
import { initializeTopology, type TopologyInitIntent } from "../../src/topology/initialize";
import { inspectTopology, type TopologyInspectRequest } from "../../src/topology/inspect";
import { applyTopologyOperations, type TopologyApplyOperationsRequest } from "../../src/topology/operations";
import { describeTemplates } from "../../src/topology/templates";
import { forbiddenFullResponseError, failResult, okResult, type TopologyResponseMode, type TopologyToolResult } from "../../src/topology/tool-result";
import { validateIntermediateTopology } from "../../src/topology/validate";
import { TOPOLOGY_LIMITS, measureJsonBytes, measureJsonDepth } from "../../src/topology/limits";

export const TOPOLOGY_MCP_ALLOWED_TOOLS = TOPOLOGY_TOOL_NAMES.map(expectedAllowedToolName);

export interface TopologyMcpToolDefinition {
  name: TopologyToolName;
  allowedToolName: (typeof TOPOLOGY_MCP_ALLOWED_TOOLS)[number];
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<CallToolResult> | CallToolResult;
}

export function createTopologyToolRegistry(): TopologyMcpToolDefinition[] {
  return [
    {
      name: "topology.describe_templates",
      allowedToolName: "mcp__tsn_topology__topology_describe_templates",
      title: "Describe topology templates",
      description: "Return the deterministic P0 topology template catalog.",
      inputSchema: responseModeSchema(),
      handler: (args) => toCallToolResult(runAgentFacing(() => okResult({ summary: describeTemplates().summary }), args)),
    },
    {
      name: "topology.initialize",
      allowedToolName: "mcp__tsn_topology__topology_initialize",
      title: "Initialize topology",
      description: "Create an IntermediateTopology from a structured template id and params.",
      inputSchema: initializeInputSchema(),
      handler: (args) => toCallToolResult(runAgentFacing(() => initializeTopology(args as TopologyInitIntent), args, { allowFullTopology: true })),
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
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(() => inspectTopology(args as TopologyInspectRequest), args)),
    },
    {
      name: "topology.describe_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_describe_artifacts",
      title: "Describe topology artifacts",
      description: "Return deterministic artifact count and size summaries.",
      inputSchema: {
        artifacts: z.unknown().optional(),
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(
        () => describeTopologyArtifacts((args ?? {}) as { artifacts: TopologyArtifacts; responseMode?: TopologyResponseMode }),
        args,
      )),
    },
    {
      name: "topology.validate_intermediate",
      allowedToolName: "mcp__tsn_topology__topology_validate_intermediate",
      title: "Validate intermediate topology",
      description: "Validate an IntermediateTopology and return structured errors.",
      inputSchema: {
        topology: z.unknown().optional(),
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(() => {
        const report = validateIntermediateTopology((args as { topology?: unknown })?.topology ?? args);
        return report.ok
          ? {
              ok: true,
              summary: report.summary,
              warnings: report.warnings,
              metadata: { responseMode: "summary", summaryOnly: true },
            }
          : failResult({ errors: report.errors, warnings: report.warnings });
      }, args)),
    },
    {
      name: "topology.build_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_build_artifacts",
      title: "Build topology artifacts",
      description: "Build four legacy JSON topology artifacts from an IntermediateTopology.",
      inputSchema: {
        topology: z.unknown().optional(),
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(
        () => buildTopologyArtifacts((args ?? {}) as Parameters<typeof buildTopologyArtifacts>[0]),
        args,
      )),
    },
    {
      name: "topology.validate_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_validate_artifacts",
      title: "Validate topology artifacts",
      description: "Validate legacy JSON artifact references.",
      inputSchema: {
        artifacts: z.unknown().optional(),
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(
        () => validateTopologyArtifacts((args ?? {}) as Parameters<typeof validateTopologyArtifacts>[0]),
        args,
      )),
    },
    {
      name: "topology.apply_operations",
      allowedToolName: "mcp__tsn_topology__topology_apply_operations",
      title: "Apply topology operations",
      description: "Apply the P0 insert-switch operation subset to an IntermediateTopology.",
      inputSchema: {
        topology: z.unknown().optional(),
        operations: z.unknown().optional(),
        dryRun: z.unknown().optional(),
        ...responseModeSchema(),
      },
      handler: (args) => toCallToolResult(runAgentFacing(
        () => applyTopologyOperations((args ?? {}) as TopologyApplyOperationsRequest),
        args,
        { allowFullTopology: true, stripFullChangeSet: true },
      )),
    },
  ];
}

export function runTopologyTool(name: TopologyToolName, args: unknown): CallToolResult {
  const tool = createTopologyToolRegistry().find((candidate) => candidate.name === name);

  if (!tool) {
    return toCallToolResult(failResult({
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
    }));
  }

  return tool.handler(args) as CallToolResult;
}

function runAgentFacing<TSummary, TFull>(
  callback: () => TopologyToolResult<TSummary, TFull>,
  args: unknown,
  options: {
    allowFullTopology?: boolean;
    stripFullChangeSet?: boolean;
  } = {},
): TopologyToolResult<TSummary, TFull> {
  try {
    const ingressError = validateIngress(args);
    if (ingressError) {
      return failResult({ errors: [ingressError] });
    }

    if (isFullResponseMode(args) && (!options.allowFullTopology || !allowsAgentFullTopology(args))) {
      return failResult({ errors: [forbiddenFullResponseError()] });
    }

    const result = callback();
    return options.stripFullChangeSet ? stripFullChangeSet(result) : result;
  } catch (error) {
    return failResult({
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

function stripFullChangeSet<TSummary, TFull>(
  result: TopologyToolResult<TSummary, TFull>,
): TopologyToolResult<TSummary, TFull> {
  if (!result.ok || !result.full || typeof result.full !== "object") {
    return result;
  }

  const full = { ...(result.full as Record<string, unknown>) };
  delete full.changeSet;

  return {
    ...result,
    full: full as TFull,
  };
}

function validateIngress(args: unknown) {
  const bytes = measureJsonBytes(args ?? {});
  if (bytes > TOPOLOGY_LIMITS.maxIngressPayloadBytes) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `ingress payload bytes exceeded: ${bytes} > ${TOPOLOGY_LIMITS.maxIngressPayloadBytes}`,
      path: "$",
      severity: "error" as const,
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
      severity: "error" as const,
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

function isFullResponseMode(args: unknown): boolean {
  return Boolean(args && typeof args === "object" && "responseMode" in args && (args as { responseMode?: unknown }).responseMode === "full");
}

function allowsAgentFullTopology(args: unknown): boolean {
  return Boolean(args && typeof args === "object" && "topologyFullAllowed" in args && (args as { topologyFullAllowed?: unknown }).topologyFullAllowed === true);
}

function toCallToolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function responseModeSchema(): z.ZodRawShape {
  return {
    responseMode: z.enum(["summary", "full"]).optional(),
    topologyFullAllowed: z.boolean().optional(),
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
    ...responseModeSchema(),
  };
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
