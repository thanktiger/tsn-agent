import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

export const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantText: {
      type: "string",
      description: "中文回复，直接展示给 TSN Agent 左侧对话框。",
    },
  },
  required: ["assistantText"],
};

export async function runClaude(userPrompt, options = {}, queryFn = query) {
  const resolvedOptions = typeof options === "string" ? { cwd: options } : options;
  const cwd = typeof resolvedOptions.cwd === "string" && resolvedOptions.cwd.length > 0 ? resolvedOptions.cwd : process.cwd();
  let assistantText = "";
  let sessionId;
  let emittedSessionId;
  const emittedText = [];
  const operationTraceLines = [];
  const operationTraceKeys = new Set();
  const toolUseNamesById = new Map();
  const stageResultPath = resolvedOptions.stageResultPath ?? await createStageResultPath();
  const stageRunnerPath = resolvedOptions.stageRunnerPath ?? resolveStageRunnerPath(cwd);
  const emitAssistantChunk = (text) => {
    if (!text) {
      return;
    }

    emittedText.push(text);
    resolvedOptions.onEvent?.({ event: "chunk", text });
  };
  const emitOperationTrace = (trace) => {
    if (!trace?.text || !trace.key || operationTraceKeys.has(trace.key)) {
      return;
    }

    operationTraceKeys.add(trace.key);
    operationTraceLines.push(trace.text);
    resolvedOptions.onEvent?.({ event: "chunk", text: `${trace.text}\n` });
  };

  try {
    for await (const message of queryFn({
      prompt: buildPrompt(
        userPrompt,
        resolvedOptions.conversationContext,
        stageResultPath,
        resolvedOptions.stageRunnerInput,
        stageRunnerPath,
      ),
      options: {
        cwd,
        settingSources: ["user", "project"],
        permissionMode: "dontAsk",
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Bash", "Edit", "Write"],
        disallowedTools: [],
        skills: ["tsn-topology", "tsn-flow-planning"],
        env: {
          ...process.env,
          TSN_AGENT_STAGE_RESULT_PATH: stageResultPath,
          TSN_AGENT_STAGE_RUNNER_PATH: stageRunnerPath,
        },
        maxTurns: 3,
        includePartialMessages: true,
        ...(typeof resolvedOptions.resumeSessionId === "string" && resolvedOptions.resumeSessionId.length > 0
          ? { resume: resolvedOptions.resumeSessionId }
          : {}),
        systemPrompt:
          "你是 TSN Agent 的规划助手。你面向懂一点 TSN 但不了解具体参数的新手用户。回复必须是简体中文，保持工程化、具体、可执行。可以使用本轮启用的工具和 tsn-topology skill，但工程状态只接受结构化校验结果。除 TSN_AGENT_STAGE_RESULT_PATH 指向的结果文件外，不要写入仓库文件。固定阶段顺序是拓扑、时间同步、流量规划、模拟仿真；拓扑确认后必须进入时间同步。当前应用没有接入 OMNeT++/远程仿真 runner，不能声称已启动仿真、SSH 执行或稍后通知结果。",
      },
    })) {
      if (message.type === "system" && message.session_id) {
        sessionId = message.session_id;
        if (sessionId !== emittedSessionId) {
          emittedSessionId = sessionId;
          resolvedOptions.onEvent?.({ event: "session", sessionId });
        }
      }

      if (message.type === "assistant") {
        sessionId = message.session_id ?? sessionId;

        for (const trace of extractOperationTraceEvents(message, toolUseNamesById)) {
          emitOperationTrace(trace);
        }

        if (emittedText.length === 0) {
          for (const text of extractAssistantTextBlocks(message)) {
            emitAssistantChunk(text);
          }
        }
      }

      if (message.type === "stream_event") {
        sessionId = message.session_id ?? sessionId;

        for (const trace of extractOperationTraceEvents(message, toolUseNamesById)) {
          emitOperationTrace(trace);
        }

        for (const text of extractStreamEventText(message)) {
          emitAssistantChunk(text);
        }
      }

      if (message.type === "user" || message.type === "tool_result") {
        for (const trace of extractOperationTraceEvents(message, toolUseNamesById)) {
          emitOperationTrace(trace);
        }
      }

      if (message.type === "result") {
        sessionId = message.session_id ?? sessionId;

        if (message.structured_output?.assistantText) {
          assistantText = message.structured_output.assistantText;
        } else if (typeof message.result === "string") {
          assistantText = parseAssistantText(message.result);
        }
      }
    }
  } catch (error) {
    const stageResults = await readOrCreateStageResults({
      stageResultPath,
      stageRunnerInput: resolvedOptions.stageRunnerInput,
      stageRunnerPath,
      cwd,
      stageRunner: resolvedOptions.stageRunner,
      onTrace: emitOperationTrace,
    });

    if (hasRecoverableStageResult(stageResults)) {
      return {
        assistantText: prependOperationTrace(
          buildRecoveredStageResultAssistantText(stageResults),
          operationTraceLines,
        ),
        sessionId,
        stageResults,
      };
    }

    throw error;
  }

  if (!assistantText.trim() && emittedText.length > 0) {
    assistantText = emittedText.join("");
  }

  const stageResults = await readOrCreateStageResults({
    stageResultPath,
    stageRunnerInput: resolvedOptions.stageRunnerInput,
    stageRunnerPath,
    cwd,
    stageRunner: resolvedOptions.stageRunner,
    onTrace: emitOperationTrace,
  });

  if (!assistantText.trim() && hasRecoverableStageResult(stageResults)) {
    assistantText = buildRecoveredStageResultAssistantText(stageResults);
  }

  if (!assistantText.trim()) {
    throw new Error("Claude returned no assistantText");
  }

  return {
    assistantText: prependOperationTrace(assistantText, operationTraceLines),
    sessionId,
    stageResults,
  };
}

export function buildPrompt(
  userPrompt,
  conversationContext,
  stageResultPath = "$TSN_AGENT_STAGE_RESULT_PATH",
  stageRunnerInput,
  stageRunnerPath = resolveStageRunnerPath(process.cwd()),
) {
  const contextBlock = conversationContext
    ? `\n会话上下文：\n${conversationContext}\n`
    : "";
  const stageRunnerInputBlock = stageRunnerInput
    ? `\n建议传给 stage runner 的结构化输入：\n${JSON.stringify(stageRunnerInput, null, 2)}\n`
    : "";

  return `用户正在通过 TSN Agent 桌面应用配置一个 TSN 网络。
${contextBlock}
${stageRunnerInputBlock}

用户原始需求：
${userPrompt}

结构化结果回传：
- 当前阶段如果需要生成或修改拓扑，必须使用 tsn-topology skill。
- 当前阶段如果需要生成或修改流量规划，必须使用 tsn-flow-planning skill。
- 结构化结果必须由项目 runner 写入 TSN_AGENT_STAGE_RESULT_PATH。
- TSN_AGENT_STAGE_RESULT_PATH=${stageResultPath}
- TSN_AGENT_STAGE_RUNNER_PATH=${stageRunnerPath}
- 如果上方提供了 stage runner 结构化输入，调用 runner 时优先使用该 JSON；只可根据用户本轮需求补充缺失字段。

请直接生成左侧对话框要展示给用户的中文内容，不要输出 JSON。要求：
1. 用新手能理解的语言解释你识别到了哪些拓扑规模和默认假设。
2. 只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。
3. 固定阶段顺序是“拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真”。如果上下文显示当前阶段是时间同步，只能说明同步假设和等待确认，不能引导用户配置控制流。
4. 当前应用没有接入 OMNeT++/远程服务器仿真 runner；遇到启动仿真、SSH、devserver 或远程运行请求时，必须说明当前不会实际执行，也不会后台通知结果。
5. 不要修改仓库文件；如需生成拓扑结构化结果，只允许写入 TSN_AGENT_STAGE_RESULT_PATH 指向的结果文件；不要输出 Markdown 表格。
6. 如果需求缺少关键参数，请给出合理默认值并说明这些默认值后续可以调整。`;
}

async function createStageResultPath() {
  const dir = join(tmpdir(), `tsn-agent-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return join(dir, "stage-result.json");
}

async function readStageResults(stageResultPath, onTrace) {
  try {
    const raw = await readFile(stageResultPath, "utf8");
    const parsed = JSON.parse(raw);
    const stageResults = Array.isArray(parsed) ? parsed : [parsed];

    if (stageResults.length > 0) {
      onTrace?.({
        key: `file:read:${stageResultPath}`,
        text: `[文件] 读取阶段结果 ${formatPathForDisplay(stageResultPath)}`,
      });
      for (const result of stageResults) {
        const skillName = isRecord(result) && typeof result.skillName === "string"
          ? result.skillName
          : skillNameForStage(isRecord(result) && typeof result.stage === "string" ? result.stage : undefined);
        if (skillName) {
          onTrace?.({
            key: `skill:result:${isRecord(result) ? result.stage ?? "unknown" : "unknown"}:${skillName}`,
            text: `[Skill] ${skillName} 结果已返回`,
          });
        }
      }
    }

    return stageResults;
  } catch {
    return [];
  }
}

async function readOrCreateStageResults({ stageResultPath, stageRunnerInput, stageRunnerPath, cwd, stageRunner, onTrace }) {
  const stageResults = await readStageResults(stageResultPath, onTrace);

  if (stageResults.length > 0 || !shouldRunLocalStageRunner(stageRunnerInput)) {
    return stageResults;
  }

  try {
    const skillName = skillNameForStage(stageRunnerInput.stage);
    if (skillName) {
      onTrace?.({
        key: `skill:invoke:${stageRunnerInput.stage}:${skillName}`,
        text: `[Skill] 调用 ${skillName}`,
      });
    }

    onTrace?.({
      key: `tool:stage-runner:${stageRunnerInput.stage}`,
      text: `[工具] Bash: node tsn-stage-runner --stage ${stageRunnerInput.stage} --result-path stage-result.json`,
    });

    if (typeof stageRunner === "function") {
      await stageRunner({ input: stageRunnerInput, resultPath: stageResultPath, cwd, runnerPath: stageRunnerPath });
    } else {
      await runStageRunnerProcess({ input: stageRunnerInput, resultPath: stageResultPath, cwd, runnerPath: stageRunnerPath });
    }

    onTrace?.({
      key: `file:write:${stageRunnerInput.stage}:${stageResultPath}`,
      text: `[文件] 写入阶段结果 ${formatPathForDisplay(stageResultPath)}`,
    });

    return readStageResults(stageResultPath, onTrace);
  } catch {
    return [];
  }
}

function shouldRunLocalStageRunner(stageRunnerInput) {
  return isRecord(stageRunnerInput)
    && (stageRunnerInput.stage === "topology" || stageRunnerInput.stage === "flow-template")
    && typeof stageRunnerInput.userIntent === "string"
    && stageRunnerInput.userIntent.trim().length > 0;
}

function hasRecoverableStageResult(stageResults) {
  return stageResults.some((result) =>
    isRecord(result)
      && (result.stage === "topology" || result.stage === "flow-template")
      && result.status === "success"
      && isRecord(result.validation)
      && result.validation.ok === true
      && isRecord(result.payload)
      && (result.payload.kind === "topology" || result.payload.kind === "flow-template")
      && isRecord(result.payload.project)
  );
}

function buildRecoveredStageResultAssistantText(stageResults) {
  const result = stageResults.find((candidate) =>
    isRecord(candidate) && (candidate.stage === "topology" || candidate.stage === "flow-template")
  );
  const summary = isRecord(result) && typeof result.summary === "string"
    ? result.summary
    : "已生成当前阶段结构化结果。";

  if (isRecord(result) && result.stage === "flow-template") {
    return [
      "已根据本轮需求更新流量规划。",
      summary,
      "确认流量规划后生成仿真输入和导出清单，或继续描述需要新增、删除或调整的流。",
    ].join("\n");
  }

  return [
    "已根据本轮需求生成拓扑草案。",
    summary,
    "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。",
  ].join("\n");
}

function runStageRunnerProcess({ input, resultPath, cwd, runnerPath }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        runnerPath,
        "--stage",
        input.stage,
        "--input",
        JSON.stringify(input),
        "--result-path",
        resultPath,
      ],
      {
        cwd,
        env: {
          ...process.env,
          TSN_AGENT_STAGE_RESULT_PATH: resultPath,
        },
      },
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
}

function resolveStageRunnerPath(cwd) {
  const candidates = [
    join(cwd, "src-node", "tsn-stage-runner.mjs"),
    join(cwd, "src-node", "dist", "tsn-stage-runner.mjs"),
    new URL("./tsn-stage-runner.mjs", import.meta.url).pathname,
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function extractAssistantTextBlocks(message) {
  const content = message.message?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0)
    .map((block) => block.text);
}

export function extractStreamEventText(message) {
  const event = message.event;

  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return [event.delta.text].filter(Boolean);
  }

  if (event?.type === "content_block_start" && event.content_block?.type === "text") {
    return [event.content_block.text].filter(Boolean);
  }

  return [];
}

export function extractOperationTraceEvents(message, toolUseNamesById = new Map()) {
  const traces = [];
  const contentBlocks = collectContentBlocks(message);

  for (const block of contentBlocks) {
    if (block?.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "工具";
      if (typeof block.id === "string") {
        toolUseNamesById.set(block.id, name);
      }
      traces.push({
        key: `tool_use:${block.id ?? `${name}:${stableStringify(block.input)}`}`,
        text: formatToolUseTrace(name, block.input),
      });
    }

    if (block?.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const name = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
      const failed = block.is_error === true || block.error === true;
      traces.push({
        key: `tool_result:${toolUseId ?? stableStringify(block)}`,
        text: `[工具结果] ${formatToolName(name ?? "工具")} 已返回${failed ? "（失败）" : ""}`,
      });
    }
  }

  return traces.filter((trace) => trace.text);
}

function collectContentBlocks(message) {
  const blocks = [];

  if (Array.isArray(message.message?.content)) {
    blocks.push(...message.message.content);
  }

  if (Array.isArray(message.content)) {
    blocks.push(...message.content);
  }

  const eventBlock = message.event?.content_block;
  if (eventBlock?.type === "tool_use" || eventBlock?.type === "tool_result") {
    blocks.push(eventBlock);
  }

  if (message.tool_use) {
    blocks.push({ type: "tool_use", ...message.tool_use });
  }

  if (message.tool_result) {
    blocks.push({ type: "tool_result", ...message.tool_result });
  }

  return blocks;
}

function formatToolUseTrace(name, input) {
  const toolName = formatToolName(name);
  const normalizedName = String(name ?? "").toLowerCase();
  const inputRecord = isRecord(input) ? input : {};

  if (normalizedName === "skill") {
    const skillName = stringValue(inputRecord.skill)
      ?? stringValue(inputRecord.skillName)
      ?? stringValue(inputRecord.name)
      ?? summarizeInput(input);
    return `[Skill] ${skillName || "调用"}`;
  }

  if (normalizedName === "read") {
    return `[文件] 读取 ${formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path))}`;
  }

  if (normalizedName === "write") {
    return `[文件] 写入 ${formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path))}`;
  }

  if (normalizedName === "edit" || normalizedName === "multiedit") {
    return `[文件] 修改 ${formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path))}`;
  }

  if (normalizedName === "bash") {
    return `[工具] Bash: ${summarizeCommand(stringValue(inputRecord.command) ?? stringValue(inputRecord.cmd) ?? summarizeInput(input))}`;
  }

  const summary = summarizeInput(input);
  return summary ? `[工具] ${toolName}: ${summary}` : `[工具] ${toolName}`;
}

function formatToolName(name) {
  return String(name ?? "工具").trim() || "工具";
}

function summarizeCommand(command) {
  const redacted = redactSecrets(String(command ?? "").trim());

  if (!redacted) {
    return "执行命令";
  }

  const stage = redacted.match(/--stage\s+([^\s]+)/)?.[1];
  if (redacted.includes("TSN_AGENT_STAGE_RUNNER_PATH") || redacted.includes("tsn-stage-runner")) {
    return `node tsn-stage-runner${stage ? ` --stage ${stage}` : ""} --result-path stage-result.json`;
  }

  return truncate(redacted.replace(/\s+/g, " "), 180);
}

function summarizeInput(input) {
  if (typeof input === "string") {
    return truncate(redactSecrets(input), 140);
  }

  if (!isRecord(input)) {
    return "";
  }

  const candidate = stringValue(input.description)
    ?? stringValue(input.summary)
    ?? stringValue(input.path)
    ?? stringValue(input.file_path)
    ?? stringValue(input.command)
    ?? stringValue(input.cmd);
  if (candidate) {
    return truncate(redactSecrets(candidate), 140);
  }

  return truncate(redactSecrets(stableStringify(input)), 140);
}

function formatPathForDisplay(path) {
  if (!path) {
    return "目标文件";
  }

  const value = String(path);
  if (value.includes("tsn-agent-stage-") && value.endsWith("stage-result.json")) {
    return "stage-result.json";
  }

  if (value.startsWith("$")) {
    return value;
  }

  return truncate(value.startsWith("/") ? basename(value) : value, 140);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function skillNameForStage(stage) {
  if (stage === "topology") {
    return "tsn-topology";
  }

  if (stage === "flow-template") {
    return "tsn-flow-planning";
  }

  return undefined;
}

function prependOperationTrace(assistantText, operationTraceLines) {
  const body = assistantText.trim();
  const trace = operationTraceLines.join("\n").trim();

  return trace ? `${trace}\n\n${body}` : body;
}

export function parseAssistantText(value) {
  try {
    const parsed = JSON.parse(value);

    if (typeof parsed.assistantText === "string") {
      return parsed.assistantText;
    }
  } catch {
    return value;
  }

  return value;
}

export function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}

export function redactSecrets(value) {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|claude_api_key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/("(?:accessToken|refreshToken|authToken|apiKey|api_key|token|secret|password)"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, "$1[redacted]");
}

export async function runWorker(rawInput) {
  const input = JSON.parse(rawInput);
  const prompt = String(input.prompt ?? "").trim();

  if (!prompt) {
    throw new Error("prompt is required");
  }

  return runClaude(prompt, {
    cwd: input.cwd,
    conversationContext: typeof input.conversationContext === "string" ? input.conversationContext : undefined,
    resumeSessionId: typeof input.resumeSessionId === "string" ? input.resumeSessionId : undefined,
    stageRunnerInput: isRecord(input.stageRunnerInput) ? input.stageRunnerInput : undefined,
    onEvent: (event) => {
      if (typeof input.runId !== "string" || !input.runId) {
        return;
      }

      process.stdout.write(`${JSON.stringify({ ...event, runId: input.runId })}\n`);
    },
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , rawInput = "{}"] = process.argv;

  try {
    const response = await runWorker(rawInput);
    process.stdout.write(`${JSON.stringify({ event: "done", ...response })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: normalizeError(error) })}\n`);
    process.exitCode = 1;
  }
}
