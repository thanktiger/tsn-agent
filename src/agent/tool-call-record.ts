/**
 * Plan 2026-06-09-003：chat 工具调用内联卡片的单一事实源类型 + 领域助手。
 *
 * worker 只透传原始 `RawToolCall`（原始工具名 + 完整 args/result），前端把它
 * 富化成 `ToolCallRecord`（友好名 + 一句摘要）供卡片渲染。存储层用
 * `truncateResultForStorage` 给特大结果兜底。刻意不做按工具家族的关键字段
 * 抽取注册表 —— 摘要走通用探测。
 */

export type ToolCallStatus = "success" | "error";

/** worker 累积、随 `done` 返回的原始记录。 */
export interface RawToolCall {
  id: string;
  /** 原始工具名，如 `mcp__tsn_topology__topology_initialize`、`Bash`。 */
  name: string;
  status: ToolCallStatus;
  args?: unknown;
  result?: unknown;
}

/** 富化后挂在 `ChatMessage.toolCalls` 上、供卡片渲染的记录。 */
export interface ToolCallRecord extends RawToolCall {
  /** 去冗余前缀后的展示名，如 `topology.initialize`。 */
  friendlyName: string;
  /** 折叠态一行的一句摘要。 */
  summary: string;
  /** 落盘时 result 超上限被截断的标记（截断后 result 为字符串预览）。 */
  resultTruncated?: boolean;
}

/** result 序列化超过此字节数则落盘截断（仅影响存储与展示，不影响传输）。 */
export const TOOL_RESULT_STORAGE_LIMIT = 16_000;

const SUMMARY_MAX_LENGTH = 80;
const ERROR_SUMMARY_MAX_LENGTH = 120;
const SUMMARY_SALIENT_KEYS = [
  "error",
  "message",
  "stderr",
  "description",
  "summary",
  "command",
  "cmd",
  "file_path",
  "path",
  "skill",
  "skillName",
  "name",
  "template",
] as const;

/**
 * `mcp__<server>__<tool>` → `<tool>` 段首个下划线换点（`topology_initialize`
 * → `topology.initialize`）。非 MCP 工具（Bash / Read / Skill / ...）原样返回。
 */
export function toFriendlyToolName(name: string): string {
  if (!name) {
    return "工具";
  }

  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const tool = parts[parts.length - 1] || name;
    return tool.replace("_", ".");
  }

  return name;
}

/** 折叠态一行摘要：失败给错误摘要；成功优先从 args、再从 result 探测显著字段。 */
export function buildToolSummary(raw: RawToolCall): string {
  if (raw.status === "error") {
    const detail = salientString(raw.result, ERROR_SUMMARY_MAX_LENGTH)
      ?? salientString(raw.args, ERROR_SUMMARY_MAX_LENGTH);
    return detail ? `失败：${detail}` : "失败";
  }

  return salientString(raw.args, SUMMARY_MAX_LENGTH)
    ?? salientString(raw.result, SUMMARY_MAX_LENGTH)
    ?? "已完成";
}

/** 给 raw 记录补 friendlyName + summary。不在此截断 result（截断只在存储层）。 */
export function enrichToolCall(raw: RawToolCall): ToolCallRecord {
  return {
    ...raw,
    friendlyName: toFriendlyToolName(raw.name),
    summary: buildToolSummary(raw),
  };
}

/**
 * 落盘前对 result 兜底：序列化超 `limit` 时返回字符串预览 + `truncated: true`，
 * 否则原样返回。无法序列化的值（含循环引用）按截断处理。
 */
export function truncateResultForStorage(
  result: unknown,
  limit: number = TOOL_RESULT_STORAGE_LIMIT,
): { value: unknown; truncated: boolean } {
  if (result === undefined) {
    return { value: undefined, truncated: false };
  }

  let serialized: string;
  try {
    serialized = typeof result === "string" ? result : JSON.stringify(result) ?? "";
  } catch {
    return { value: "[结果无法序列化，已截断]", truncated: true };
  }

  if (serialized.length <= limit) {
    return { value: result, truncated: false };
  }

  return { value: `${serialized.slice(0, limit)}…`, truncated: true };
}

function salientString(value: unknown, max: number): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? truncate(value.trim(), max) : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of SUMMARY_SALIENT_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return truncate(candidate.trim(), max);
    }
  }

  const scalarPairs = Object.entries(value)
    .filter(([, inner]) => typeof inner === "number" || typeof inner === "boolean")
    .slice(0, 2)
    .map(([key, inner]) => `${key}=${String(inner)}`);
  if (scalarPairs.length > 0) {
    return truncate(scalarPairs.join(" · "), max);
  }

  return undefined;
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
