import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { measureJsonBytes, measureJsonDepth, TOPOLOGY_LIMITS } from "../../src/topology/limits";
import {
  FLOW_TOOL_NAMES,
  type FlowToolName,
  TIMESYNC_TOOL_NAMES,
  type TimesyncToolName,
  TOPOLOGY_TOOL_NAMES,
  type TopologyToolName,
} from "../../src/topology/topology-service";
import { fetchSidecar, type SidecarFailure, type SidecarResult } from "./sidecar-client";

export const TOPOLOGY_MCP_ALLOWED_TOOLS = TOPOLOGY_TOOL_NAMES.map(expectedAllowedToolName);

export const TIMESYNC_MCP_ALLOWED_TOOLS = TIMESYNC_TOOL_NAMES.map(expectedAllowedToolName);

export const FLOW_MCP_ALLOWED_TOOLS = FLOW_TOOL_NAMES.map(expectedAllowedToolName);

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
 * 完全删除 in-process compute path 与旧 response-mode 协商字段。
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
      description:
        "Return the deterministic P0 topology template catalog. Pass scenario to filter templates applicable to the active scenario; omit for the full catalog.",
      inputSchema: {
        scenario: z.string().optional(),
      },
      // 注意：body 须显式转发 scenario——callSidecarTool 第三参才是发往 sidecar 的 body。
      handler: async (args) =>
        callSidecarTool("/db/topology/describe_templates", args, {
          scenario: pickString(args, "scenario"),
        }),
    },
    {
      name: "topology.initialize",
      allowedToolName: "mcp__tsn_topology__topology_initialize",
      title: "Initialize topology",
      description:
        "Compute a topology from a template and persist it into the project DB, replacing the session's current topology. Returns summary.mutationId; use topology.inspect to query the persisted result.",
      inputSchema: initializeInputSchema(),
      handler: async (args) =>
        callSidecarTool("/db/topology/initialize", args, {
          templateId: pickString(args, "templateId"),
          params: pickValue(args, "params"),
        }),
    },
    {
      name: "topology.inspect",
      allowedToolName: "mcp__tsn_topology__topology_inspect",
      title: "Inspect topology",
      description:
        "Return the session's full persisted topology rows: nodes (mid/name/nodeType/x/y/insertOrder) and links (linkSeq/name/srcNode/dstNode/srcPort/dstPort/stylesJson). No parameters. Call this first to locate existing mid/linkSeq values before building apply_operations batches. 节点身份是 mid（逻辑序号），连线两端 srcNode/dstNode 引用节点 mid。name 列是节点显示名（与对话命名一致）；定位用户说的 SW-N/ES-N 时优先按 name 精确匹配，勿按列表顺序/第 N 台折算（完整显示名规则见 skill 指引）。端口号是独立列：srcPort 在 source 端、dstPort 在 target 端（结构事实源，画布据此渲染端口标签）。links 的 stylesJson 仅承载显示属性：plane（A/B）控制画布链路配色（A=蓝、B=红，错值会误导用户）、role（access/backbone）为链路角色；端口号不在 stylesJson 里。",
      inputSchema: {},
      handler: async (args) => callSidecarTool("/db/topology/inspect", args, {}),
    },
    {
      name: "topology.describe_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_describe_artifacts",
      title: "Describe topology artifacts",
      description: "Return deterministic artifact count and size summaries.",
      inputSchema: {
        artifacts: z.unknown().optional(),
      },
      handler: async (args) =>
        callSidecarTool("/db/topology/describe_artifacts", args, {
          artifacts: pickValue(args, "artifacts") ?? {},
        }),
    },
    {
      name: "topology.validate",
      allowedToolName: "mcp__tsn_topology__topology_validate",
      title: "Validate intermediate topology",
      description:
        "Validate the session's topology. Call with NO arguments to check the PERSISTED (already-applied) topology — " +
        "this runs the full structural check (connectivity, port pairing, isolated nodes, forwarding reachability, " +
        "node roles, duplicate ids) and returns Chinese summary.errors[] you MUST relay to the user. apply_operations " +
        "already auto-runs this check and includes it in its `validation` field, so you usually don't call this separately — " +
        "use it only for an explicit re-check of the persisted topology. " +
        "(Passing a full draft JSON instead runs schema-level validation only.) " +
        "Do NOT call right after topology.initialize — it already validates+persists.",
      inputSchema: {
        topology: z.unknown().optional(),
      },
      handler: async (args) =>
        callSidecarTool("/db/topology/validate", args, { topology: pickValue(args, "topology") }),
    },
    {
      name: "topology.build_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_build_artifacts",
      title: "Build topology artifacts",
      description:
        "Build the clean topology.json export (mid/mac/ip/port) from a topology snapshot.",
      inputSchema: {
        topology: z.unknown().optional(),
      },
      handler: async (args) =>
        callSidecarTool("/db/topology/build_artifacts", args, {
          topology: pickValue(args, "topology"),
        }),
    },
    {
      name: "topology.validate_artifacts",
      allowedToolName: "mcp__tsn_topology__topology_validate_artifacts",
      title: "Validate topology artifacts",
      description: "Validate topology.json artifact structure and link references.",
      inputSchema: {
        artifacts: z.unknown().optional(),
      },
      handler: async (args) =>
        callSidecarTool("/db/topology/validate_artifacts", args, {
          artifacts: pickValue(args, "artifacts") ?? {},
        }),
    },
    {
      name: "topology.apply_operations",
      allowedToolName: "mcp__tsn_topology__topology_apply_operations",
      title: "Apply topology operations",
      description:
        "Apply atomic topology operations (node_add / node_update / node_delete / link_add / link_delete) to the session's persisted topology. Returns summary.mutationId on commit. Call topology.inspect first to locate existing mid/linkSeq values; retries must resend the exact same batch (same mid/linkSeq), never re-allocate keys. On a committed (non-dryRun) apply the response carries a `validation` field with the post-apply structural check (errors in Chinese) — relay any problems to the user. validation.ran=false means the structural-check call itself failed (infra issue, NOT a structure problem); only when ran=true judge by valid/errors.",
      inputSchema: applyOperationsInputSchema(),
      handler: async (args) => applyOperationsWithValidation(args),
    },
  ];
}

export async function runTopologyTool(
  name: TopologyToolName,
  args: unknown,
): Promise<CallToolResult> {
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

type SidecarRawResult = { ok: true; body: unknown } | { ok: false; toolResult: CallToolResult };

// 低层单次 sidecar 调用：成功返回原始 body（供 handler 串联 / 合并多次调用结果），
// 失败返回已封装好的 CallToolResult（错误语义与 callSidecarTool 完全一致）。
async function callSidecarRaw(
  route: string,
  args: unknown,
  body: Record<string, unknown>,
): Promise<SidecarRawResult> {
  try {
    const ingressError = validateIngress(args);
    if (ingressError) {
      return { ok: false, toolResult: toCallToolResult({ ok: false, errors: [ingressError] }) };
    }
    const sanitized = pruneUndefined(body);
    const result: SidecarResult = await fetchSidecar(route, sanitized);
    if (!result.ok) {
      return { ok: false, toolResult: toCallToolResult(sidecarFailureToToolResult(result)) };
    }
    return { ok: true, body: result.body };
  } catch (error) {
    return {
      ok: false,
      toolResult: toCallToolResult({
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
      }),
    };
  }
}

async function callSidecarTool(
  route: string,
  args: unknown,
  body: Record<string, unknown>,
): Promise<CallToolResult> {
  const raw = await callSidecarRaw(route, args, body);
  return raw.ok ? toCallToolResult(raw.body) : raw.toolResult;
}

// U5：apply 成功且非 dryRun 后，handler 确定性地追调一次 validate（无参 = 验库内已落库
// 结构，与确认闸同 load_and_verify_topology），把结构结论并进 apply 工具返回——让 agent
// 每次操作拓扑后都看到结构状态、便于自纠，不依赖它「记得」单独调 validate（弱模型尤其）。
// 不改 Rust ApplyOpsResponse；validate 失败不掩盖 apply 成功，仅标注未取得。用户侧硬保证
// 仍是确认闸（阶段推进前 verify_topology 确定性跑一次）。
async function applyOperationsWithValidation(args: unknown): Promise<CallToolResult> {
  const dryRun = pickValue(args, "dryRun") ?? false;
  const applied = await callSidecarRaw("/db/topology/apply_operations", args, {
    operations: pickValue(args, "operations") ?? [],
    dryRun,
  });
  if (!applied.ok) {
    return applied.toolResult;
  }
  // dryRun 预演不落库、apply 自身 ok:false 已是结论——都不追 validate。
  if (dryRun === true || !isOkBody(applied.body)) {
    return toCallToolResult(applied.body);
  }
  const validated = await callSidecarRaw("/db/topology/validate", {}, {});
  return toCallToolResult(mergeStructuralValidation(applied.body, validated));
}

function isOkBody(body: unknown): boolean {
  return isRecord(body) && body.ok === true;
}

function mergeStructuralValidation(
  applyBody: unknown,
  validated: SidecarRawResult,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(applyBody)
    ? { ...applyBody }
    : { value: applyBody };
  if (!validated.ok) {
    // validate 调用本身失败（sidecar 不可达等）：不掩盖 apply 成功，标注结构校验未取得。
    merged.validation = { ran: false, reason: "structural validate call failed" };
    return merged;
  }
  const summary = isRecord(validated.body) ? validated.body.summary : undefined;
  merged.validation = isRecord(summary)
    ? {
        ran: true,
        valid: summary.valid ?? null,
        errors: summary.errors ?? [],
        caliber: summary.caliber ?? null,
      }
    : { ran: true, valid: null, errors: [], caliber: null };
  return merged;
}

function sidecarFailureToToolResult(failure: SidecarFailure): Record<string, unknown> {
  return {
    ok: false,
    errors: [
      {
        code:
          failure.code === "SIDECAR_UNREACHABLE" || failure.code === "SIDECAR_TIMEOUT"
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

/**
 * apply_operations 的完整 zod schema：字段 1:1 镜像 Rust `TopologyOp` 的 serde
 * 形态（`op` 值 snake_case、字段名 camelCase）。SDK registerTool 用它生成
 * JSON schema 给模型并在 MCP 层校验 —— 格式错误不打 HTTP 即收到字段级反馈。
 * `.max(32)` 与 sidecar `MAX_OPERATIONS_PER_REQUEST` 对齐。
 * `nodeType` 在 Rust 端虽是 Option，zod 层收紧为 required：inspect 返回的行
 * 总有非 NULL nodeType 可复制，消除 absent 歧义（三态写入假阳性防护）。
 * 导出仅供 schema 单测 safeParse（运行时校验走 registerTool/Client 路径）。
 */
export function applyOperationsInputSchema(): z.ZodRawShape {
  const nodeAddSchema = z
    .object({
      op: z.literal("node_add"),
      mid: z
        .string()
        .describe(
          '新节点 key（逻辑序号，如 "5"）；必须避开已占用 mid（先 inspect）。修改已有节点属性用 node_update，node_add 仅用于新增节点',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          "新节点显示名（交换机 SW-N、端系统 ES-N、服务器 SRV-N；省略则展示层按前缀+mid 派生）",
        ),
      x: z.number(),
      y: z.number(),
      nodeType: z
        .string()
        .describe("复制 inspect 返回的同类节点 nodeType（如 switch / endSystem）"),
      insertOrder: z.number().int(),
    })
    .strict();
  const nodeUpdateSchema = z
    .object({
      op: z.literal("node_update"),
      mid: z
        .string()
        .describe("目标节点的既有 mid（先 inspect）；只更新提供的字段，mid 本身不可改"),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("改显示名（交换机 SW-N、端系统 ES-N、服务器 SRV-N，须合前缀）"),
      x: z.number().optional(),
      y: z.number().optional(),
      nodeType: z.string().optional(),
    })
    .strict();
  const nodeDeleteSchema = z
    .object({
      op: z.literal("node_delete"),
      mid: z.string().describe("目标节点的既有 mid；仍被链路引用时会被拒绝（先 link_delete）"),
    })
    .strict();
  const linkAddSchema = z
    .object({
      op: z.literal("link_add"),
      linkSeq: z.number().int().describe("新链路 key；必须避开已占用 linkSeq（先 inspect）"),
      name: z.string().optional(),
      srcNode: z.string(),
      dstNode: z.string(),
      srcPort: z
        .number()
        .int()
        .describe(
          "链路在 srcNode 上占用的端口号（端口是结构事实源、直写列）。新生成拓扑端口 P0 起编，填两端节点实际端口；必传——缺省会被拒绝（端口不再从 stylesJson 解析）",
        ),
      dstPort: z.number().int().describe("链路在 dstNode 上占用的端口号；必传——缺省会被拒绝"),
      speed: z
        .number()
        .int()
        .optional()
        .describe(
          "链路速率 Mbps；按用户意图填（常见 {10,100,1000,10000}，1000 最常用），未指定时缺省落库 1000（与 initialize 模板默认一致，不再留 NULL）",
        ),
      stylesJson: z
        .string()
        .describe(
          "仅承载显示属性：plane（平面归属 A/B，决定画布配色，按两端节点实际平面填写或省略该键——抄错平面会让画布配色误导用户）、role（角色）。端口号/速率不再放这里，走 srcPort/dstPort/speed 显式字段",
        ),
    })
    .strict();
  const linkDeleteSchema = z
    .object({
      op: z.literal("link_delete"),
      linkSeq: z.number().int(),
    })
    .strict();

  return {
    operations: z
      .array(
        z.discriminatedUnion("op", [
          nodeAddSchema,
          nodeUpdateSchema,
          nodeDeleteSchema,
          linkAddSchema,
          linkDeleteSchema,
        ]),
      )
      .min(1)
      .max(32)
      .describe(
        "原子操作 batch（1-32）。增量修改先 inspect 再构造；重试必须复用同一 batch 的 mid/linkSeq",
      ),
    dryRun: z.boolean().optional(),
  };
}

export function initializeInputSchema(): z.ZodRawShape {
  const planeSchema = z.enum(["A", "B"]);
  const attachmentEndpointSchema = z.object({
    switchId: z.string().min(1),
    plane: planeSchema,
  });
  const dualPlaneParamsSchema = z
    .object({
      dataRateMbps: z.number().int().optional(),
      planes: z
        .array(
          z.object({
            id: planeSchema,
            name: z.string().optional(),
          }),
        )
        .length(2),
      switches: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            plane: planeSchema,
            groupId: z.string().min(1),
            portCount: z.number().int().positive().optional(),
          }),
        )
        .min(1),
      switchGroups: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            planeSwitches: z.object({
              A: z.string().min(1),
              B: z.string().min(1),
            }),
          }),
        )
        .min(1),
      endSystems: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            groupId: z.string().min(1),
            attachment: z.object({
              primary: attachmentEndpointSchema,
              backup: attachmentEndpointSchema,
            }),
          }),
        )
        .min(1),
      // Plan 2026-06-09-004 U2：收窄到已实现合法域（line/none）。ring/paired 待实现时 re-advertise。
      backbone: z.object({
        mode: z.literal("line"),
        withinPlane: z.literal(true),
      }),
      crossPlaneLinks: z.object({
        mode: z.literal("none"),
      }),
    })
    .strict();

  return {
    templateId: z.enum(["hop-linear", "dual-plane-redundant"]),
    params: z
      .union([
        z
          .object({
            switchCount: z.number().int().min(1).max(12).optional(),
            dataRateMbps: z.number().int().optional(),
          })
          .strict(),
        dualPlaneParamsSchema,
      ])
      .optional(),
  };
}

function pickString(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function expectedAllowedToolName(
  name: TopologyToolName | TimesyncToolName | FlowToolName,
): string {
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

// ===================== timesync 工具（时钟同步阶段） =====================
// 与 topology 工具同一 sidecar、同一 stdio server（tsn_topology），按 stage 分别门控
// （worker buildAllowedToolsForStage：topology 工具仅 topology 阶段、timesync 工具仅
// time-sync 阶段）。SQL 全在 Rust；handler 走 fetchSidecar('/db/timesync/...')。

export interface TimesyncMcpToolDefinition {
  name: TimesyncToolName;
  allowedToolName: (typeof TIMESYNC_MCP_ALLOWED_TOOLS)[number];
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<CallToolResult>;
}

export function createTimesyncToolRegistry(): TimesyncMcpToolDefinition[] {
  return [
    {
      name: "timesync.set_gm",
      allowedToolName: "mcp__tsn_topology__timesync_set_gm",
      title: "Set grandmaster",
      description:
        "Set the clock-sync grandmaster (GM) for the session and recompute the whole clock tree. " +
        "gmMid must reference an existing node mid (call timesync.inspect or topology.inspect first to find it). " +
        "After this call the port roles (master/slave/passive) for every node are recomputed deterministically and persisted; " +
        "you do NOT set port roles yourself. oneStepMode / freSwitch are optional domain flags (0/1). " +
        "Sync parameters default in if not yet set; adjust them via timesync.set_params.",
      inputSchema: setGmInputSchema(),
      handler: async (args) =>
        callSidecarTool("/db/timesync/set_gm", args, {
          gmMid: pickString(args, "gmMid"),
          oneStepMode: pickValue(args, "oneStepMode"),
          freSwitch: pickValue(args, "freSwitch"),
        }),
    },
    {
      name: "timesync.toggle_link",
      allowedToolName: "mcp__tsn_topology__timesync_toggle_link",
      title: "Toggle clock-sync link",
      description:
        "Enable or disable a topology link for clock-sync tree computation (disabled=true removes it from the spanning tree, " +
        "disabled=false restores it), then recompute the whole tree. linkSeq is the topology link's seq (from topology.inspect). " +
        "Both endpoints of a disabled link become passive. Use this to steer which links carry sync.",
      inputSchema: {
        linkSeq: z.number().int().describe("目标链路的 linkSeq（先用 topology.inspect 定位）"),
        disabled: z.boolean().describe("true=禁用该链路参与时钟树，false=恢复启用"),
      },
      handler: async (args) =>
        callSidecarTool("/db/timesync/toggle_link", args, {
          linkSeq: pickValue(args, "linkSeq"),
          disabled: pickValue(args, "disabled"),
        }),
    },
    {
      name: "timesync.set_params",
      allowedToolName: "mcp__tsn_topology__timesync_set_params",
      title: "Set clock-sync parameters",
      description:
        "Update gPTP sync parameters for one node (pass mid) or all nodes (omit mid). Only provided fields change; " +
        "port roles are NOT touched. syncPeriod must be one of 125/250/500/1000/2000/4000/8000 ms " +
        "(powers-of-two seconds in integer ms; hardware OpenSync requirement); measurePeriod is a power of two in ms (1..32768); " +
        "meanLinkDelayThresh is a power of two (1..128); offsetThreshold is an integer 0..4095; reportEnable is 0/1. " +
        "Recommended defaults (already applied on set_gm): syncPeriod=125, measurePeriod=128, reportEnable=1, " +
        "meanLinkDelayThresh=64, offsetThreshold=200.",
      inputSchema: setParamsInputSchema(),
      handler: async (args) =>
        callSidecarTool("/db/timesync/set_params", args, {
          mid: pickString(args, "mid"),
          syncPeriod: pickValue(args, "syncPeriod"),
          measurePeriod: pickValue(args, "measurePeriod"),
          reportEnable: pickValue(args, "reportEnable"),
          meanLinkDelayThresh: pickValue(args, "meanLinkDelayThresh"),
          offsetThreshold: pickValue(args, "offsetThreshold"),
        }),
    },
    {
      name: "timesync.inspect",
      allowedToolName: "mcp__tsn_topology__timesync_inspect",
      title: "Inspect clock-sync config",
      description:
        "Return the session's current clock-sync config: domain { gmMid, oneStepMode, freSwitch, disabledLinkSeqs } and " +
        "nodes[] { mid, masterPort[], slavePort[], portPtpEnabled[], syncPeriod, measurePeriod, reportEnable, " +
        "meanLinkDelayThresh, offsetThreshold }. No parameters. gmMid is null when no GM has been set yet. " +
        "Call this first to see the current tree before changing GM / params / links.",
      inputSchema: {},
      handler: async (args) => callSidecarTool("/db/timesync/inspect", args, {}),
    },
    {
      name: "timesync.undo",
      allowedToolName: "mcp__tsn_topology__timesync_undo",
      title: "Undo last clock-sync change",
      description:
        "Undo the last clock-sync change (set_gm / set_params / toggle_link), restoring the timesync tables to the pre-change " +
        "snapshot. No parameters. Only touches clock-sync tables, never the topology. Returns ok with undone=false when there " +
        "is nothing to undo. After undo, call timesync.inspect to re-confirm the current config before continuing.",
      inputSchema: {},
      handler: async (args) => callSidecarTool("/db/timesync/undo", args, {}),
    },
  ];
}

export function runTimesyncTool(name: TimesyncToolName, args: unknown): Promise<CallToolResult> {
  const tool = createTimesyncToolRegistry().find((candidate) => candidate.name === name);

  if (!tool) {
    return Promise.resolve(
      toCallToolResult({
        ok: false,
        errors: [
          {
            code: "UNKNOWN_TOOL",
            message: `Unknown timesync tool: ${name}`,
            path: "$.name",
            severity: "error",
            retryable: false,
            requiresUserClarification: false,
          },
        ],
      }),
    );
  }

  return tool.handler(args);
}

// ===================== flow 工具（流量规划阶段） =====================
// 与 topology/timesync 同一 sidecar、同一 stdio server（tsn_topology），按 stage 门控
// （worker buildAllowedToolsForStage：flow 工具仅 flow-template 阶段 + 只读 topology.inspect）。
// handler 是薄 callSidecarTool('/db/flow/...')——校验闸在 Rust 路由侧（verify_flow，U2）。
// zod .min().max() 早失败服务 R6（越界/负值在到 Rust 前就拒）。

export interface FlowMcpToolDefinition {
  name: FlowToolName;
  allowedToolName: (typeof FLOW_MCP_ALLOWED_TOOLS)[number];
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<CallToolResult>;
}

function addStreamInputSchema(): z.ZodRawShape {
  return {
    class: z.enum(["ST", "BE", "RC"]).describe("流量类别：ST 时间敏感 / BE 尽力而为 / RC 冗余"),
    pcp: z.number().int().min(0).max(7).describe("802.1Q 优先级 PCP，0–7"),
    periodUs: z.number().int().min(1).describe("发送周期（us），须整除门控周期 1000us"),
    frameBytes: z.number().int().min(1).max(1500).describe("报文长度（字节），≤ 链路 MTU 1500"),
    count: z.number().int().min(1).describe("期望发送报文数（验证期判收=发）"),
    talker: z.string().min(1).describe("发送节点 mid（先用 topology.inspect 定位）"),
    listener: z.string().min(1).describe("接收节点 mid"),
    maxLatencyUs: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("端到端最大时延（us）；省略则规划期从 docx 窗口推导、再回退取周期"),
  };
}

export function createFlowToolRegistry(): FlowMcpToolDefinition[] {
  return [
    {
      name: "flow.add_stream",
      allowedToolName: "mcp__tsn_topology__flow_add_stream",
      title: "Add a traffic stream",
      description:
        "Record one traffic stream (ST/BE/RC) for the session. Runs the verify_flow gate first " +
        "(period must divide the 1000us gate cycle, frame <= link MTU, talker/listener must be existing " +
        "node mids, same PCP must map to one class); on violation the stream is rejected with the offending " +
        "field and NOT persisted. talker/listener are node mids (call topology.inspect to find them). " +
        "maxLatencyUs is optional (planning derives it from the docx window when omitted). Returns the " +
        "assigned streamSeq on success.",
      inputSchema: addStreamInputSchema(),
      handler: async (args) =>
        callSidecarTool("/db/flow/add_stream", args, {
          class: pickString(args, "class"),
          pcp: pickValue(args, "pcp"),
          periodUs: pickValue(args, "periodUs"),
          frameBytes: pickValue(args, "frameBytes"),
          count: pickValue(args, "count"),
          talker: pickString(args, "talker"),
          listener: pickString(args, "listener"),
          maxLatencyUs: pickValue(args, "maxLatencyUs"),
        }),
    },
    {
      name: "flow.inspect",
      allowedToolName: "mcp__tsn_topology__flow_inspect",
      title: "Inspect recorded streams + gate plans",
      description:
        "Return the session's recorded streams[] { streamSeq, class, pcp, periodUs, frameBytes, count, " +
        "talker, listener, maxLatencyUs, redundant, paths } and any synthesized gate plans[] " +
        "{ streamSeq, node, ethN, gateIndex, initiallyOpen, offsetNs, durationsNs, solver }. No parameters. " +
        "Call this to see what's recorded / planned before adding or removing streams.",
      inputSchema: {},
      handler: async (args) => callSidecarTool("/db/flow/inspect", args, {}),
    },
    {
      name: "flow.remove_stream",
      allowedToolName: "mcp__tsn_topology__flow_remove_stream",
      title: "Remove a traffic stream",
      description:
        "Remove the stream with the given streamSeq (from flow.inspect) and its synthesized gate plan. " +
        "No-op (removed=0) when the seq doesn't exist. Only touches flow tables.",
      inputSchema: {
        streamSeq: z
          .number()
          .int()
          .min(0)
          .describe("要删除的流 streamSeq（先用 flow.inspect 定位）"),
      },
      handler: async (args) =>
        callSidecarTool("/db/flow/remove_stream", args, {
          streamSeq: pickValue(args, "streamSeq"),
        }),
    },
  ];
}

export function runFlowTool(name: FlowToolName, args: unknown): Promise<CallToolResult> {
  const tool = createFlowToolRegistry().find((candidate) => candidate.name === name);
  if (!tool) {
    return Promise.resolve(
      toCallToolResult({
        ok: false,
        errors: [
          {
            code: "UNKNOWN_TOOL",
            message: `Unknown flow tool: ${name}`,
            path: "$.name",
            severity: "error",
            retryable: false,
            requiresUserClarification: false,
          },
        ],
      }),
    );
  }
  return tool.handler(args);
}

export function assertFlowToolMapping(): void {
  const registry = createFlowToolRegistry();
  const names = registry.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(FLOW_TOOL_NAMES)) {
    throw new Error(`Flow MCP tool registry drifted: ${names.join(", ")}`);
  }
  for (const tool of registry) {
    if (tool.allowedToolName !== expectedAllowedToolName(tool.name)) {
      throw new Error(`Flow MCP allowed tool mapping drifted for ${tool.name}.`);
    }
  }
}

// 2^n 集合校验：syncPeriod/measurePeriod 取 1..32768（n=0..15），meanLinkDelayThresh
// 取 1..128（n=0..7）。整数且为 2 的幂（含 1=2^0）才合法。
function powerOfTwoSchema(max: number, label: string): z.ZodNumber {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .refine((value) => (value & (value - 1)) === 0, {
      message: `${label} 必须是 2 的幂（1,2,4,…,${max}）`,
    });
}

// syncPeriod 合法域（boss 定）：2 的幂「秒」、整数 ms 表示 = 1000*2^k, k∈[-3,3]。
// 2^-4 秒=62.5ms 非整数 ms，故整数 ms 截到 125；硬件 OpenSync 口径。注意 125/250 不是 2 的幂 ms，
// 故不能复用 powerOfTwoSchema——这是「2 的幂秒」不是「2 的幂 ms」。
const SYNC_PERIOD_VALUES_MS = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
function syncPeriodSchema(): z.ZodTypeAny {
  return z
    .number()
    .int()
    .refine((v) => (SYNC_PERIOD_VALUES_MS as readonly number[]).includes(v), {
      message: `syncPeriod 必须是 2 的幂秒的整数 ms 值（${SYNC_PERIOD_VALUES_MS.join(" / ")}）`,
    });
}

const binaryFlagSchema = z.number().int().min(0).max(1).describe("0 或 1");

export function setGmInputSchema(): z.ZodRawShape {
  return {
    gmMid: z.string().min(1).describe("grandmaster 节点 mid（须指向现存节点，先 inspect）"),
    oneStepMode: binaryFlagSchema.optional().describe("单步模式开关（0/1，默认 0）"),
    freSwitch: binaryFlagSchema.optional().describe("频率开关（0/1，默认 0）"),
  };
}

export function setParamsInputSchema(): z.ZodRawShape {
  return {
    mid: z.string().min(1).optional().describe("目标节点 mid；省略则对全部节点应用"),
    syncPeriod: syncPeriodSchema()
      .optional()
      .describe("同步周期 ms，2 的幂秒的整数 ms 值：125/250/500/1000/2000/4000/8000（推荐 125）"),
    measurePeriod: powerOfTwoSchema(32768, "measurePeriod")
      .optional()
      .describe("测量周期 ms，2 的幂 1..32768（推荐 1024）"),
    reportEnable: binaryFlagSchema.optional().describe("上报使能 0/1（推荐 1）"),
    meanLinkDelayThresh: powerOfTwoSchema(128, "meanLinkDelayThresh")
      .optional()
      .describe("平均链路时延阈值，2 的幂 1..128"),
    offsetThreshold: z
      .number()
      .int()
      .min(0)
      .max(4095)
      .optional()
      .describe("偏移阈值整数 0..4095（推荐 200）"),
  };
}
