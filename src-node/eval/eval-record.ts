// Plan 2026-06-25-002 U1：eval 采集记录的 schema 与 JSONL 序列化。
// 一行一 run（R2）；input.system + output.* 为 raw（不截断、不脱敏，R6）；
// input.messages 历史侧是 worker 持有的有损摘要（conversationContext），由 lossyHistory 显式标注。

export const EVAL_RECORD_SCHEMA_VERSION = "tsn-agent.eval-record.v1" as const;

/** Anthropic 原生 content-block（已知三类 + 前向兼容透传）。 */
export type EvalContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface EvalMessage {
  role: "user" | "assistant";
  content: EvalContentBlock[];
}

export interface EvalFingerprint {
  /** SKILL.md 内容 hash。 */
  skillHash: string | null;
  /** SYSTEM_PROMPT_SKELETON 内容 hash。 */
  skeletonVersion: string | null;
  scenarioId: string | null;
  model: string | null;
}

/** 取 worker 内 apply/validate 工具结果的 verification（KTD4）；拓扑外 run 为 null。 */
export interface EvalLabel {
  ok: boolean;
  caliber: string;
  errors: unknown[];
}

export interface EvalRecord {
  schemaVersion: typeof EVAL_RECORD_SCHEMA_VERSION;
  runId: string | null;
  /** app 会话 id。 */
  sessionId: string | null;
  /** SDK 会话 id。 */
  claudeSessionId: string | null;
  stage: string | null;
  scenarioConfigId: string | null;
  model: string | null;
  createdAt: string;
  durationMs: number | null;
  fingerprint: EvalFingerprint;
  input: {
    /** 当时实际组装的完整 systemPrompt（raw）。 */
    system: string;
    /** 当时可用 MCP 工具定义的指纹；全量定义不入行（R5b）。 */
    toolsHash: string | null;
    /** 本轮用户输入 + worker 持有的会话上下文（历史侧为有损摘要）。 */
    messages: EvalMessage[];
    /** 显式标注：input.messages 的历史部分是 conversationContext 有损摘要，非逐轮原生 blocks（KTD3）。 */
    lossyHistory: boolean;
  };
  output: {
    /** 本轮模型产出的完整 assistant/tool_use/tool_result 序列（原生 blocks，未截断）。 */
    messages: EvalMessage[];
    finalText: string;
  };
  label: EvalLabel | null;
}

export interface BuildEvalRecordInput {
  runId?: string | null;
  appSessionId?: string | null;
  claudeSessionId?: string | null;
  stage?: string | null;
  scenarioConfigId?: string | null;
  model?: string | null;
  createdAt: string;
  durationMs?: number | null;
  fingerprint: EvalFingerprint;
  /** raw 完整 systemPrompt。 */
  system: string;
  toolsHash?: string | null;
  /** 本轮用户输入（含 worker 持有的会话上下文），原生 blocks。 */
  inputMessages: EvalMessage[];
  /** 本轮模型产出，原生 blocks（未截断、未脱敏）。 */
  outputMessages: EvalMessage[];
  finalText?: string;
  label?: EvalLabel | null;
}

export function buildEvalRecord(input: BuildEvalRecordInput): EvalRecord {
  return {
    schemaVersion: EVAL_RECORD_SCHEMA_VERSION,
    runId: input.runId ?? null,
    sessionId: input.appSessionId ?? null,
    claudeSessionId: input.claudeSessionId ?? null,
    stage: input.stage ?? null,
    scenarioConfigId: input.scenarioConfigId ?? null,
    model: input.model ?? null,
    createdAt: input.createdAt,
    durationMs: typeof input.durationMs === "number" ? input.durationMs : null,
    fingerprint: input.fingerprint,
    input: {
      system: input.system,
      toolsHash: input.toolsHash ?? null,
      messages: input.inputMessages,
      // 历史侧恒为有损摘要——固定为 true，提醒下游不要假设逐轮保真（KTD3）。
      lossyHistory: true,
    },
    output: {
      messages: input.outputMessages,
      finalText: input.finalText ?? "",
    },
    label: input.label ?? null,
  };
}

/** 序列化成一行 JSON（末尾换行），供 append 到 JSONL store（R5）。 */
export function serializeEvalRecordLine(record: EvalRecord): string {
  return `${JSON.stringify(record)}\n`;
}
