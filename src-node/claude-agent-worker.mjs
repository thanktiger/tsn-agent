import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTopologyWorkflowStageResult } from "../src/agent/topology-workflow-stage-result";

const TOPOLOGY_MCP_SERVER_NAME = "tsn_topology";
export const TOPOLOGY_MCP_ALLOWED_TOOLS = [
  "mcp__tsn_topology__topology_describe_templates",
  "mcp__tsn_topology__topology_initialize",
  "mcp__tsn_topology__topology_inspect",
  "mcp__tsn_topology__topology_describe_artifacts",
  "mcp__tsn_topology__topology_validate",
  "mcp__tsn_topology__topology_build_artifacts",
  "mcp__tsn_topology__topology_validate_artifacts",
  "mcp__tsn_topology__topology_apply_operations",
];

// U1（独立编排能力）：切阶段工具独立于四个阶段，用 SDK in-process 自定义工具承载，
// 不连 sidecar、不写状态、不做合法性判断（合法性在应用层 agent-adapter）。它只把
// 大模型的「想回到哪个阶段」结构化返回；返回值经 stageResults 同款通道回传给应用层。
const WORKFLOW_MCP_SERVER_NAME = "tsn_workflow";
export const REQUEST_STAGE_CHANGE_TOOL_NAME = `mcp__${WORKFLOW_MCP_SERVER_NAME}__request_stage_change`;

export const requestStageChangeTool = tool(
  "request_stage_change",
  "当用户想回到之前已完成的阶段（拓扑 topology 或时间同步 time-sync）做修改时调用本工具。targetStage 为目标阶段，reason 为一句话理由。前进到下一阶段由用户点「确认并继续」按钮完成，不要用本工具前进。",
  // targetStage 在 schema 层即限定为合法回退目标——非法值由 SDK 拒绝、模型可自纠；
  // 应用层（agent-adapter）仍独立校验合法性/方向，作纵深防御。
  { targetStage: z.enum(["topology", "time-sync"]), reason: z.string().optional() },
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          stageChangeRequest: {
            targetStage: args.targetStage,
            ...(typeof args.reason === "string" && args.reason.length > 0 ? { reason: args.reason } : {}),
          },
        }),
      },
    ],
  }),
);

const workflowMcpServer = createSdkMcpServer({
  name: WORKFLOW_MCP_SERVER_NAME,
  version: "1.0.0",
  tools: [requestStageChangeTool],
});

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
  const operationTraceKeys = new Set();
  const toolUseNamesById = new Map();
  // Plan 2026-06-09-003：结构化工具记录按 tool_use id 累积，随 done 一次性返回。
  const toolCallsById = new Map();
  // Plan 2026-06-10-001：流式 tool_call 事件每 id 各相至多发一次（start/result）。
  const emittedToolCallPhases = new Set();
  const capturedStageResultKeys = new Set();
  const capturedStageResults = [];
  const stageResultPath = resolvedOptions.stageResultPath ?? await createStageResultPath();
  const skillOutputDir = resolvedOptions.skillOutputDir ?? await createSkillOutputDir(stageResultPath);
  // 同源（R2）：skill 指引读取根优先取 Tauri 决策的有效根（payload skillRoot，
  // release 下指向 app-data 播种副本），缺省回退 cwd 下仓库/资源路径。
  const skillRoot = typeof resolvedOptions.skillRoot === "string" && resolvedOptions.skillRoot.length > 0
    ? resolvedOptions.skillRoot
    : join(cwd, ".claude", "skills");
  const topologyMcpServerPath = resolvedOptions.topologyMcpServerPath ?? resolveTopologyMcpServerPath(cwd);
  // 打包态：Tauri 注入随 app 分发的 claude binary 路径。SDK 默认从 node_modules 的
  // 平台包（@anthropic-ai/claude-agent-sdk-{platform}）找 claude，bundle 后不存在，
  // 故打包态必须显式 pathToClaudeCodeExecutable；dev 态为 undefined，走 SDK 默认。
  const claudeBinaryPath = typeof resolvedOptions.claudeBinaryPath === "string" && resolvedOptions.claudeBinaryPath.length > 0
    ? resolvedOptions.claudeBinaryPath
    : undefined;
  // Plan v3 U4b + Spike B：MCP child env 必须显式声明（Node child_process.spawn
  // 显式 env 字段语义是 REPLACE 不是 merge）；CLAUDECODE 必须不带过去防嵌套
  // session 拒绝。Tauri 端通过 `commands::run_claude_agent` 向 worker 注入
  // TSN_AGENT_DB_RPC_URL/TOKEN/SESSION_ID + env_remove(CLAUDECODE)。
  const buildTopologyMcpEnv = () => {
    const env = {};
    const passthrough = [
      "PATH",
      "HOME",
      "SystemRoot",
      "APPDATA",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "TSN_AGENT_DB_RPC_URL",
      "TSN_AGENT_DB_RPC_TOKEN",
      "TSN_AGENT_SESSION_ID",
    ];
    for (const key of passthrough) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    return env;
  };
  const topologyMcpConfig = topologyMcpServerPath && existsSync(topologyMcpServerPath)
    ? {
        [TOPOLOGY_MCP_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [topologyMcpServerPath],
          alwaysLoad: true,
          env: buildTopologyMcpEnv(),
        },
      }
    : undefined;
  const stageRunnerInputPath = await writeStageRunnerInputFile(stageResultPath, resolvedOptions.stageRunnerInput);
  const { systemPrompt, skillReadWarning, scenarioReference, scenarioReferenceWarning } =
    await buildSystemPromptForStage(resolvedOptions.stageRunnerInput, skillRoot);
  const finalPrompt = buildPrompt(
    userPrompt,
    resolvedOptions.conversationContext,
    stageResultPath,
    skillOutputDir,
    resolvedOptions.stageRunnerInput,
    stageRunnerInputPath,
  );
  const sdkOptions = {
    cwd,
    // 打包态指向随 app 分发的 claude binary；dev 态 undefined → SDK 默认用 node_modules 平台包。
    ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
    settingSources: ["user", "project"],
    // 显式 pin 模型：settingSources 含 "user" 会继承开发者个人 Claude Code 的
    // 默认模型（如 /model 切到 worker 环境不可用的型号即整轮失败）——产品运行时
    // 不耦合个人偏好。
    model: "claude-sonnet-4-6",
    permissionMode: "dontAsk",
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: buildAllowedToolsForStage(resolvedOptions.stageRunnerInput, Boolean(topologyMcpConfig)),
    // AskUserQuestion 在 dontAsk 模式下必然被拒（无终端 UI），硬禁省掉模型
    // 尝试浪费的 turn；prompt 交互规则 1 告知替代路径（中文数字编号选项）。
    disallowedTools: ["AskUserQuestion"],
    skills: ["tsn-topology", "tsn-flow-planning"],
    // tsn_workflow（切阶段工具，in-process）始终注册；tsn_topology 仅在 server 路径存在时注册。
    mcpServers: { ...(topologyMcpConfig ?? {}), [WORKFLOW_MCP_SERVER_NAME]: workflowMcpServer },
    env: {
      ...process.env,
      TSN_AGENT_STAGE_RESULT_PATH: stageResultPath,
      TSN_AGENT_SKILL_OUTPUT_DIR: skillOutputDir,
      ...(stageRunnerInputPath ? { TSN_AGENT_STAGE_RUNNER_INPUT_PATH: stageRunnerInputPath } : {}),
    },
    maxTurns: resolvedOptions.maxTurns ?? 20,
    includePartialMessages: true,
    ...(typeof resolvedOptions.resumeSessionId === "string" && resolvedOptions.resumeSessionId.length > 0
      ? { resume: resolvedOptions.resumeSessionId }
      : {}),
    systemPrompt,
  };
  const auditLog = await createAgentRunAuditLog({
    auditDir: resolvedOptions.auditDir,
    appSessionId: resolvedOptions.appSessionId,
    runId: resolvedOptions.runId,
    cwd,
    skillRoot,
    userPrompt,
    prompt: finalPrompt,
    conversationContext: resolvedOptions.conversationContext,
    stageRunnerInput: resolvedOptions.stageRunnerInput,
    stageRunnerInputPath,
    stageResultPath,
    skillOutputDir,
    sdkOptions,
    scenarioReference,
  });
  if (skillReadWarning) {
    recordAuditTimeline(auditLog, skillReadWarning);
  }
  if (scenarioReferenceWarning) {
    recordAuditTimeline(auditLog, scenarioReferenceWarning);
  }
  let currentPromptRunId = "initial";
  const handleSdkMessage = (message) => {
    if (message.type === "system" && message.session_id) {
      sessionId = message.session_id;
      if (sessionId !== emittedSessionId) {
        emittedSessionId = sessionId;
        recordAuditTimeline(auditLog, { type: "sdk_session", sessionId });
        resolvedOptions.onEvent?.({ event: "session", sessionId });
      }
    }

    if (message.type === "assistant") {
      sessionId = message.session_id ?? sessionId;

      for (const trace of extractOperationTraceEvents(message, toolUseNamesById)) {
        emitOperationTrace(trace);
      }
      collectToolCalls(message);
      captureTopologyStageResults(message);
      captureStageChangeRequests(message);

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
      collectToolCalls(message);
      captureTopologyStageResults(message);
      captureStageChangeRequests(message);

      for (const text of extractStreamEventText(message)) {
        emitAssistantChunk(text);
      }
    }

    if (message.type === "user" || message.type === "tool_result") {
      for (const trace of extractOperationTraceEvents(message, toolUseNamesById)) {
        emitOperationTrace(trace);
      }
      collectToolCalls(message);
      captureTopologyStageResults(message);
      captureStageChangeRequests(message);
    }

    if (message.type === "result") {
      sessionId = message.session_id ?? sessionId;
      recordAuditTimeline(auditLog, { type: "sdk_result", sessionId });

      let resultText = "";
      if (message.structured_output?.assistantText) {
        assistantText = message.structured_output.assistantText;
        resultText = assistantText;
      } else if (typeof message.result === "string") {
        assistantText = parseAssistantText(message.result);
        resultText = assistantText;
      }
      recordAuditPromptResult(auditLog, currentPromptRunId, {
        sessionId,
        resultText,
      });
    }
  };
  const captureTopologyStageResults = (message) => {
    for (const extracted of extractTopologyWorkflowStageResults(message, toolUseNamesById, resolvedOptions.stageRunnerInput)) {
      if (capturedStageResultKeys.has(extracted.key)) {
        continue;
      }

      capturedStageResultKeys.add(extracted.key);
      capturedStageResults.push(extracted.result);
      emitOperationTrace({
        key: `workflow-stage-result:${extracted.key}`,
        text: `[阶段结果] 拓扑工具结果已生成：${summarizeStageResultForTrace(extracted.result)}`,
      });
    }
  };
  // U2：切阶段提议与拓扑结果走同一回传通道，但不受拓扑提取的 stage 门槛限制——
  // 任何阶段调 request_stage_change 都要能被捕获。提议只是「大模型可控的意图」，
  // 合法性/方向/破坏性确认全在应用层校验（见 agent-adapter applyStageResults）。
  const captureStageChangeRequests = (message) => {
    for (const extracted of extractStageChangeRequests(message, toolUseNamesById)) {
      if (capturedStageResultKeys.has(extracted.key)) {
        continue;
      }

      capturedStageResultKeys.add(extracted.key);
      capturedStageResults.push(extracted.result);
      emitOperationTrace({
        key: `stage-change-request:${extracted.key}`,
        text: `[切阶段] 大模型请求切到阶段：${extracted.result.targetStage}`,
      });
    }
  };
  const emitAssistantChunk = (text) => {
    if (!text) {
      return;
    }

    emittedText.push(text);
    recordAuditTimeline(auditLog, { type: "assistant_chunk", text });
    resolvedOptions.onEvent?.({ event: "chunk", text });
  };
  // Plan 2026-06-09-003 KTD5：trace 仅入 audit，不再发 chunk，也不再 prepend 进
  // assistantText —— 工具调用改由结构化卡片承载。
  const emitOperationTrace = (trace) => {
    if (!trace?.text || !trace.key || operationTraceKeys.has(trace.key)) {
      return;
    }

    operationTraceKeys.add(trace.key);
    recordAuditToolTrace(auditLog, trace);
  };
  const collectToolCalls = (message) => {
    for (const entry of extractToolCallEvents(message, toolUseNamesById)) {
      const existing = toolCallsById.get(entry.id) ?? { id: entry.id, name: entry.name, status: "success" };

      if (entry.phase === "use") {
        existing.name = entry.name ?? existing.name;
        if (isNonEmptyToolInput(entry.args) || existing.args === undefined) {
          existing.args = entry.args;
        }
        // Plan 2026-06-10-001 U1：完整 assistant 消息的 use 相才发 start（合法空入参
        // 也发——零参工具不能漏卡）；stream_event 的早期空参信号不触发。
        if (message.type === "assistant" && !emittedToolCallPhases.has(`${entry.id}:start`)) {
          emittedToolCallPhases.add(`${entry.id}:start`);
          resolvedOptions.onEvent?.({
            event: "tool_call",
            toolCall: { id: entry.id, name: existing.name, args: existing.args, phase: "start" },
          });
        }
      } else {
        existing.name = existing.name ?? entry.name;
        existing.status = entry.status;
        existing.result = entry.result;
        if (!emittedToolCallPhases.has(`${entry.id}:result`)) {
          emittedToolCallPhases.add(`${entry.id}:result`);
          resolvedOptions.onEvent?.({
            event: "tool_call",
            toolCall: { id: entry.id, name: existing.name, status: existing.status, result: existing.result, phase: "result" },
          });
        }
      }

      toolCallsById.set(entry.id, existing);
    }
  };

  try {
    for await (const message of queryFn({
      prompt: finalPrompt,
      options: sdkOptions,
    })) {
      handleSdkMessage(message);
    }
  } catch (error) {
    const stageResults = mergeStageResults(capturedStageResults, await readStageResults(stageResultPath, emitOperationTrace));

    if (hasRecoverableStageResult(stageResults)) {
      const recoveredText = buildRecoveredStageResultAssistantText(stageResults);
      const auditPath = await finalizeAgentRunAudit(auditLog, {
        assistantText: recoveredText,
        sessionId,
        stageResults,
        error,
        recovered: true,
      });

      return {
        assistantText: recoveredText,
        sessionId,
        stageResults,
        toolCalls: [...toolCallsById.values()],
        ...(auditPath ? { auditPath } : {}),
      };
    }

    await finalizeAgentRunAudit(auditLog, {
      assistantText,
      sessionId,
      stageResults,
      error,
    });
    throw error;
  }

  if (!assistantText.trim() && emittedText.length > 0) {
    assistantText = emittedText.join("");
  }

  const finalStageResults = mergeStageResults(capturedStageResults, await readStageResults(stageResultPath, emitOperationTrace));

  if (!assistantText.trim() && hasRecoverableStageResult(finalStageResults)) {
    assistantText = buildRecoveredStageResultAssistantText(finalStageResults);
  }

  if (!assistantText.trim()) {
    const error = new Error("Claude returned no assistantText");
    await finalizeAgentRunAudit(auditLog, {
      assistantText,
      sessionId,
      stageResults: finalStageResults,
      error,
    });
    throw error;
  }

  const finalAssistantText = assistantText.trim();
  const auditPath = await finalizeAgentRunAudit(auditLog, {
    assistantText: finalAssistantText,
    sessionId,
    stageResults: finalStageResults,
  });

  return {
    assistantText: finalAssistantText,
    sessionId,
    stageResults: finalStageResults,
    toolCalls: [...toolCallsById.values()],
    ...(auditPath ? { auditPath } : {}),
  };
}

// Phase B-β2：adapter 端非拓扑阶段全部本地拦截，worker 只会收到 topology 阶段；
// stage runner / flow-template retry 路径已删除。
export function buildAllowedToolsForStage(stageRunnerInput, hasTopologyMcpConfig) {
  const stage = isRecord(stageRunnerInput) && typeof stageRunnerInput.stage === "string"
    ? stageRunnerInput.stage
    : undefined;
  return [
    "Skill",
    "Read",
    // 切阶段工具在所有阶段可用——非拓扑阶段也要能让大模型表达回退意图。
    REQUEST_STAGE_CHANGE_TOOL_NAME,
    // 拓扑写工具只在拓扑阶段开放：非拓扑阶段直接写库的结果不会被对账（提取按 stage 门槛），
    // 会让右侧工程与 workflow 状态静默分叉。改拓扑须先经切阶段工具回到拓扑阶段。
    ...(hasTopologyMcpConfig && stage === "topology" ? TOPOLOGY_MCP_ALLOWED_TOOLS : []),
  ];
}

// system prompt 骨架：仅守安全/正确性约束（必走 MCP、固定阶段顺序、不自编拓扑
// JSON、不写 stage-result、无仿真 runner），领域指引由注入的 SKILL.md 承载。
// R4/KTD8：协议不变量（用户改坏会破坏对账/产生数据损坏的规则）全部收口在此，
// 不进可编辑 skill 文件。迁移自 SKILL.md：①initialize 后不复检 validate；
// ②apply_operations 超时重试逐字节复用（重新分配 linkSeq 会产生重复平行链路）。
const SYSTEM_PROMPT_SKELETON = "你是 TSN Agent 的规划助手。你面向懂一点 TSN 但不了解具体参数的新手用户。回复必须是简体中文，保持工程化、具体、可执行。工程状态只接受结构化校验结果。拓扑初始化、校验、artifact 构建、inspect 和 apply_operations 必须通过 tsn_topology MCP 工具调用 sidecar，所有工具结果都已是结构化领域响应。artifact、端口表、MAC 表和完整 changeSet 不得再在自然语言里复述。不要写 TSN_AGENT_STAGE_RESULT_PATH，不要用自然语言重新构建拓扑。固定阶段顺序是拓扑、时间同步、流量规划、模拟仿真。前进到下一阶段由用户点「确认并继续」按钮完成，你不要自行宣称已进入下一阶段。用户想回到之前已完成的拓扑或时间同步阶段做修改时，调用 request_stage_change 工具（参数：目标阶段 targetStage、理由 reason），切回会让其后的阶段重做；不要用该工具前进。当前应用没有接入 OMNeT++/远程仿真 runner，不能声称已启动仿真、SSH 执行或稍后通知结果。已有拓扑用 tsn_topology inspect + apply_operations 增量编辑，initialize 仅用于从 0 生成或换模板（误用会整表重排已确认拓扑）。initialize 已内置结构校验并落库，之后不要再调用 topology_validate 复检（它只接受完整拓扑 JSON，不接受 mutationId）。apply_operations 超时重试时逐字节复用上一次的同一 operations（相同 imac/linkSeq），不要重新分配——重新分配 linkSeq 会产生重复的平行链路。最终工程状态只接受应用层合成的结构化结果，不要自行编写 stage result。";

// SKILL.md 正文每次运行注入骨架之后，用固定 sentinel 分隔，便于切分骨架段与注入段。
const SKILL_GUIDANCE_SENTINEL = "<<<SKILL_GUIDANCE>>>";
// R6：场景 reference 注入段的第二 sentinel（骨架 → 索引 → 场景 reference）。
// 注入保持单字符串拼接——string[] 形态会崩 redactSecrets。
const SCENARIO_REFERENCE_SENTINEL = "<<<SCENARIO_REFERENCE>>>";
// 未知/缺失场景回退到通用场景（与 SKILL.md 场景路由表一致）。
const FALLBACK_SCENARIO_ID = "generic-tsn";

async function buildSystemPromptForStage(stageRunnerInput, skillRoot) {
  const skillPath = join(skillRoot, "tsn-topology", "SKILL.md");

  let guidance;
  try {
    guidance = await readFile(skillPath, "utf8");
  } catch (error) {
    return {
      systemPrompt: SYSTEM_PROMPT_SKELETON,
      skillReadWarning: {
        type: "skill_guidance_unavailable",
        level: "warn",
        skillPath,
        error: normalizeError(error),
      },
    };
  }

  // R6 按场景确定性注入：requested 场景 reference → 回退 generic-tsn → 仅索引。
  // 全链 fail-open：reference 缺失降级注入，不阻断运行。
  const referenceDir = join(skillRoot, "tsn-topology", "references");
  const requestedScenario =
    typeof stageRunnerInput?.scenarioConfigId === "string" && stageRunnerInput.scenarioConfigId.length > 0
      ? stageRunnerInput.scenarioConfigId
      : null;
  // 场景 id 进文件路径前做格式校验：畸形值（如含 ../ 的路径遍历）按未知场景
  // 走 generic-tsn 回退，不参与 join。
  const isSafeScenarioId = requestedScenario !== null && /^[a-z0-9][a-z0-9-]*$/.test(requestedScenario);
  const candidates = isSafeScenarioId && requestedScenario !== FALLBACK_SCENARIO_ID
    ? [requestedScenario, FALLBACK_SCENARIO_ID]
    : [FALLBACK_SCENARIO_ID];

  let referenceBody = null;
  let resolvedScenario = null;
  const referenceReadErrors = [];
  for (const scenario of candidates) {
    try {
      referenceBody = await readFile(join(referenceDir, `${scenario}.md`), "utf8");
      resolvedScenario = scenario;
      break;
    } catch (error) {
      // 逐级降级：记录失败原因供审计，尝试下一个候选。
      referenceReadErrors.push({ scenario, error: normalizeError(error) });
    }
  }

  // 审计字段：真机排查「agent 拿到的是哪个场景指引」直接看此对象。
  const scenarioReference = {
    requestedScenario,
    resolvedScenario,
    referencePath: resolvedScenario ? join(referenceDir, `${resolvedScenario}.md`) : null,
    fallback: resolvedScenario !== null && resolvedScenario !== requestedScenario,
  };
  // 降级路径产生 timeline 事件（与 skillReadWarning 同管道）：reference 全缺是
  // 播种半失败的典型症状，仅靠审计头字段排查不醒目。
  const scenarioReferenceWarning = referenceBody === null
    ? {
        type: "skill_reference_unavailable",
        level: "warn",
        requestedScenario,
        referenceDir,
        errors: referenceReadErrors,
      }
    : scenarioReference.fallback
      ? {
          type: "skill_reference_fallback",
          level: "info",
          requestedScenario,
          resolvedScenario,
          errors: referenceReadErrors,
        }
      : undefined;

  if (referenceBody === null) {
    return {
      systemPrompt: `${SYSTEM_PROMPT_SKELETON}\n\n${SKILL_GUIDANCE_SENTINEL}\n${guidance}`,
      scenarioReference,
      scenarioReferenceWarning,
    };
  }

  // 可用参考文件绝对路径表：其余场景按需用 Read 查阅（SKILL.md 场景路由所述）。
  let referenceListing = [];
  try {
    referenceListing = (await readdir(referenceDir))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `- ${name.replace(/\.md$/, "")}: ${join(referenceDir, name)}`);
  } catch {
    // 目录列举失败不阻断注入。
  }
  const pathTable = referenceListing.length > 0
    ? `\n\n可用参考文件（其余场景用 Read 工具按绝对路径查阅）：\n${referenceListing.join("\n")}`
    : "";

  return {
    systemPrompt: `${SYSTEM_PROMPT_SKELETON}\n\n${SKILL_GUIDANCE_SENTINEL}\n${guidance}\n\n${SCENARIO_REFERENCE_SENTINEL}\n${referenceBody}${pathTable}`,
    scenarioReference,
    scenarioReferenceWarning,
  };
}

export function buildPrompt(
  userPrompt,
  conversationContext,
  stageResultPath = "$TSN_AGENT_STAGE_RESULT_PATH",
  skillOutputDir = "$TSN_AGENT_SKILL_OUTPUT_DIR",
  stageRunnerInput,
  stageRunnerInputPath,
) {
  const contextBlock = conversationContext
    ? `\n会话上下文：\n${conversationContext}\n`
    : "";
  const stageRunnerInputBlock = stageRunnerInput
    ? `\n阶段结构化输入：\n${stageRunnerInputPath
      ? `- 已写入文件：${stageRunnerInputPath}`
      : JSON.stringify(stageRunnerInput, null, 2)}\n`
    : "";
  // Phase B-β2：worker 只服务拓扑阶段（其余阶段由 adapter 本地拦截），
  // stage runner / flow-template 指引已删除。
  const structuredResultInstructions = `结构化结果回传：
- 当前阶段如果需要生成或修改拓扑，必须优先使用 tsn_topology MCP 工具。
- 从 0 初始化拓扑时，先通过 topology.describe_templates 理解模板，再调用 topology.initialize（它会直接写入工程数据库并返回 mutationId）；已有拓扑编辑时，调用 topology.inspect / topology.apply_operations。
- tsn_topology MCP 工具结果已是 sidecar 结构化领域响应；worker 会自动解析结果并合成 WorkflowStageResult。
- 不要写 TSN_AGENT_STAGE_RESULT_PATH，不要让模型复述完整拓扑 JSON，不要从 summary 文本反解析拓扑。
- TSN_AGENT_SKILL_OUTPUT_DIR=${skillOutputDir}`;
  const executionInstructions = `执行顺序要求：
1. 先完成 topology MCP 工具调用，确保 worker 能捕获 trusted topology result。
2. 再生成左侧对话框要展示给用户的中文内容，不要输出 JSON。`;
  const interactionInstructions = `交互规则：
1. 不要调用 AskUserQuestion（运行环境无终端 UI，已禁用）；需要用户决策时在中文回复里列数字编号选项。
2. 选项编号用数字、跨轮保持指代稳定，已采纳的编号不复用为新含义。
3. 只提供当前工具/模板能落地的选项，不提供后端做不到的选项。
4. 一轮聚焦一个决策点；有合理默认值时给默认并允许用户一句话确认。
5. 用户的简短确认（如"速率够用"）不需要调用工具，直接推进。
6. 增量修改已确认的拓扑时，先 topology.inspect 查 rows 再用 topology.apply_operations 构造原子操作；不要用 initialize 重建（会重排节点命名）。
7. 不要把 inspect 返回的 rows / stylesJson / syncType 原文复述进中文回复。
8. apply_operations 超时重试时必须逐字节复用上一次的同一 batch（相同 imac/linkSeq），不要重新分配 —— 重新分配 linkSeq 会产生重复的平行链路。`;
  const failureInstruction = "7. 如果当前阶段是拓扑，不能只返回文字说明；没有 trusted topology result 就不要声称阶段已生成。";
  const fileInstruction = "5. 不要修改仓库文件；不要写 TSN_AGENT_STAGE_RESULT_PATH；不要输出 Markdown 表格。";

  return `用户正在通过 TSN Agent 桌面应用配置一个 TSN 网络。
${contextBlock}
${stageRunnerInputBlock}

用户原始需求：
${userPrompt}

${structuredResultInstructions}

${executionInstructions}

${interactionInstructions}

回复要求：
1. 用新手能理解的语言解释你识别到了哪些拓扑规模和默认假设。
2. 只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。
3. 固定阶段顺序是“拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真”。如果上下文显示当前阶段是时间同步，只能说明同步假设和等待确认，不能引导用户配置控制流。
4. 当前应用没有接入 OMNeT++/远程服务器仿真 runner；遇到启动仿真、SSH、devserver 或远程运行请求时，必须说明当前不会实际执行，也不会后台通知结果。
${fileInstruction}
6. 如果需求缺少关键参数，请给出合理默认值并说明这些默认值后续可以调整。
${failureInstruction}`;
}

async function createStageResultPath() {
  const dir = join(tmpdir(), `tsn-agent-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return join(dir, "stage-result.json");
}

async function createSkillOutputDir(stageResultPath) {
  const dir = join(dirname(stageResultPath), "skill-output");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeStageRunnerInputFile(stageResultPath, stageRunnerInput) {
  if (!isRecord(stageRunnerInput)) {
    return undefined;
  }

  const inputPath = join(dirname(stageResultPath), "stage-runner-input.json");
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(stageRunnerInput, null, 2)}\n`, "utf8");
  return inputPath;
}

async function createAgentRunAuditLog(input) {
  if (typeof input.auditDir !== "string" || !input.auditDir.trim()) {
    return undefined;
  }

  const createdAt = new Date().toISOString();
  const appSessionId = safePathSegment(input.appSessionId ?? "no-session");
  const runId = safePathSegment(input.runId ?? `agent-run-${Date.now()}`);
  const sessionDir = join(input.auditDir, appSessionId);
  const auditPath = join(sessionDir, `${timestampForFile(createdAt)}-${runId}.json`);
  const latestPath = join(sessionDir, "latest.json");
  await mkdir(sessionDir, { recursive: true });

  return {
    path: auditPath,
    latestPath,
    data: {
      schemaVersion: "tsn-agent.agent-run-audit.v1",
      createdAt,
      completedAt: undefined,
      status: "running",
      appSessionId: input.appSessionId ?? null,
      runId: input.runId ?? null,
      summary: buildAuditSummary({
        status: "running",
        userPrompt: input.userPrompt,
        stageRunnerInput: input.stageRunnerInput,
        stageRunnerInputPath: input.stageRunnerInputPath,
        prompt: input.prompt,
        conversationContext: input.conversationContext,
      }),
      cwd: input.cwd,
      // skill 指引实际读取根（真机排查「agent 用的指引对不对」直接看此字段）。
      skillRoot: input.skillRoot ?? null,
      // 场景 reference 注入结果（requested/resolved/fallback，R6 审计）。
      scenarioReference: input.scenarioReference ?? null,
      prompt: redactSecrets(input.prompt),
      userPrompt: redactSecrets(input.userPrompt),
      conversationContext: typeof input.conversationContext === "string" ? redactSecrets(input.conversationContext) : null,
      stageRunnerInput: redactJsonValue(input.stageRunnerInput ?? null),
      stageRunnerInputPath: input.stageRunnerInputPath ?? null,
      promptRuns: [
        {
          id: "initial",
          kind: "initial",
          createdAt,
          promptSummary: summarizePromptForAudit(input.prompt),
          prompt: redactSecrets(input.prompt),
          resultText: "",
          sessionId: null,
        },
      ],
      stageResultPath: input.stageResultPath,
      skillOutputDir: input.skillOutputDir,
      sdkOptions: summarizeSdkOptionsForAudit(input.sdkOptions),
      timeline: [],
      toolCalls: [],
      operationTraceLines: [],
      result: null,
    },
  };
}

function recordAuditPrompt(auditLog, input) {
  if (!auditLog) {
    return "";
  }

  const id = `${auditLog.data.promptRuns.length + 1}-${input.kind}`;
  auditLog.data.promptRuns.push({
    id,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    promptSummary: summarizePromptForAudit(input.prompt),
    prompt: redactSecrets(input.prompt),
    resultText: "",
    sessionId: null,
  });
  return id;
}

function recordAuditPromptResult(auditLog, promptRunId, result) {
  if (!auditLog || !promptRunId) {
    return;
  }

  const promptRun = auditLog.data.promptRuns.find((candidate) => candidate.id === promptRunId);
  if (!promptRun) {
    return;
  }

  promptRun.completedAt = new Date().toISOString();
  promptRun.resultText = redactSecrets(result.resultText ?? "");
  promptRun.sessionId = result.sessionId ?? null;
}

function recordAuditTimeline(auditLog, event) {
  if (!auditLog) {
    return;
  }

  auditLog.data.timeline.push(redactJsonValue({
    at: new Date().toISOString(),
    ...event,
  }));
}

function recordAuditToolTrace(auditLog, trace) {
  if (!auditLog?.data || !trace?.text) {
    return;
  }

  const text = redactSecrets(trace.text);
  auditLog.data.operationTraceLines.push(text);
  auditLog.data.toolCalls.push({
    at: new Date().toISOString(),
    key: trace.key,
    kind: classifyToolTrace(text),
    text,
  });
}

async function finalizeAgentRunAudit(auditLog, output) {
  if (!auditLog) {
    return undefined;
  }

  const completedAt = new Date().toISOString();
  const errorMessage = output.error ? normalizeError(output.error) : undefined;
  auditLog.data.completedAt = completedAt;
  auditLog.data.status = errorMessage && !output.recovered ? "error" : "success";
  auditLog.data.sdkSessionId = output.sessionId ?? null;
  auditLog.data.result = {
    assistantText: redactSecrets(output.assistantText ?? ""),
    stageResults: redactJsonValue(output.stageResults ?? []),
    recovered: Boolean(output.recovered),
    error: errorMessage,
  };
  auditLog.data.summary = buildAuditSummary({
    status: auditLog.data.status,
    userPrompt: auditLog.data.userPrompt,
    stageRunnerInput: auditLog.data.stageRunnerInput,
    stageRunnerInputPath: auditLog.data.stageRunnerInputPath,
    prompt: auditLog.data.prompt,
    conversationContext: auditLog.data.conversationContext,
    completedAt,
    sdkSessionId: auditLog.data.sdkSessionId,
    stageResults: output.stageResults ?? [],
    toolCallCount: auditLog.data.toolCalls.length,
    promptRunCount: auditLog.data.promptRuns.length,
    recovered: Boolean(output.recovered),
    error: errorMessage,
  });

  const serialized = `${JSON.stringify(auditLog.data, null, 2)}\n`;

  try {
    await writeFile(auditLog.path, serialized, "utf8");
    await writeFile(auditLog.latestPath, serialized, "utf8");
    return auditLog.path;
  } catch {
    return undefined;
  }
}

function summarizeSdkOptionsForAudit(options) {
  return {
    cwd: options.cwd,
    settingSources: options.settingSources,
    permissionMode: options.permissionMode,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    skills: options.skills,
    mcpServers: options.mcpServers
      ? Object.fromEntries(Object.entries(options.mcpServers).map(([name, config]) => [
          name,
          {
            type: config.type,
            command: basename(config.command ?? ""),
            argCount: Array.isArray(config.args) ? config.args.length : 0,
            alwaysLoad: config.alwaysLoad === true,
          },
        ]))
      : undefined,
    maxTurns: options.maxTurns,
    includePartialMessages: options.includePartialMessages,
    hasResumeSession: typeof options.resume === "string" && options.resume.length > 0,
    systemPrompt: redactSecrets(options.systemPrompt ?? ""),
    env: {
      TSN_AGENT_STAGE_RESULT_PATH: options.env?.TSN_AGENT_STAGE_RESULT_PATH,
      TSN_AGENT_SKILL_OUTPUT_DIR: options.env?.TSN_AGENT_SKILL_OUTPUT_DIR,
      TSN_AGENT_STAGE_RUNNER_INPUT_PATH: options.env?.TSN_AGENT_STAGE_RUNNER_INPUT_PATH,
    },
  };
}

function buildAuditSummary(input) {
  const stage = isRecord(input.stageRunnerInput) && typeof input.stageRunnerInput.stage === "string"
    ? input.stageRunnerInput.stage
    : undefined;
  const stageResultSummaries = Array.isArray(input.stageResults)
    ? input.stageResults
        .filter(isRecord)
        .map((result) => ({
          stage: result.stage,
          schemaVersion: result.schemaVersion,
          producer: summarizeProducerForAudit(result.producer),
          skillName: result.skillName,
          status: result.status,
          summary: typeof result.summary === "string" ? truncateForAudit(result.summary, 220) : undefined,
        }))
    : [];

  return redactJsonValue({
    status: input.status,
    stage,
    userPromptPreview: truncateForAudit(input.userPrompt, 220),
    prompt: summarizePromptForAudit(input.prompt),
    context: summarizeContextForAudit(input.conversationContext),
    stageRunnerInputPath: input.stageRunnerInputPath ?? null,
    stageResults: stageResultSummaries,
    promptRunCount: input.promptRunCount ?? 1,
    toolCallCount: input.toolCallCount ?? 0,
    recovered: Boolean(input.recovered),
    sdkSessionId: input.sdkSessionId ?? null,
    completedAt: input.completedAt,
    error: input.error ? truncateForAudit(input.error, 220) : undefined,
  });
}

function summarizeProducerForAudit(producer) {
  if (!isRecord(producer)) {
    return undefined;
  }

  return {
    type: typeof producer.type === "string" ? producer.type : undefined,
    name: typeof producer.name === "string" ? producer.name : undefined,
    tool: typeof producer.tool === "string" ? producer.tool : undefined,
  };
}

function summarizePromptForAudit(prompt) {
  const source = typeof prompt === "string" ? prompt : "";

  return {
    charCount: source.length,
    lineCount: source ? source.split("\n").length : 0,
    hasInlineStageRunnerInputJson: source.includes('"userIntent"') || source.includes('"project"'),
    usesStageRunnerInputPath: source.includes("TSN_AGENT_STAGE_RUNNER_INPUT_PATH") || source.includes("stage-runner-input.json"),
    preview: truncateForAudit(source.replace(/\s+/g, " ").trim(), 320),
  };
}

function summarizeContextForAudit(context) {
  if (typeof context !== "string" || !context.trim()) {
    return {
      charCount: 0,
      includesLocalCandidate: false,
      recentMessageLines: 0,
    };
  }

  return {
    charCount: context.length,
    includesLocalCandidate: context.includes("本地预解析候选"),
    recentMessageLines: extractContextSection(context, "最近对话：", "工程状态：")
      .split("\n")
      .filter((line) => line.trim())
      .length,
    preview: truncateForAudit(context.replace(/\s+/g, " ").trim(), 260),
  };
}

function extractContextSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    return "";
  }

  const contentStart = start + startMarker.length;
  const end = source.indexOf(endMarker, contentStart);
  return source.slice(contentStart, end === -1 ? undefined : end).trim();
}

function truncateForAudit(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redactJsonValue(value) {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return redactSecrets(String(value ?? ""));
  }
}

function safePathSegment(value) {
  const sanitized = String(value ?? "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  return sanitized || "unknown";
}

function timestampForFile(value) {
  return value.replace(/[:.]/g, "-");
}

function classifyToolTrace(text) {
  if (text.startsWith("[Skill]")) {
    return "skill";
  }

  if (text.startsWith("[文件]")) {
    return "file";
  }

  if (text.startsWith("[工具结果]")) {
    return "tool_result";
  }

  if (text.startsWith("[阶段结果]")) {
    return "stage_result";
  }

  return "tool_use";
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
        const producer = isRecord(result) && isRecord(result.producer) ? result.producer : undefined;
        if (producer && typeof producer.name === "string") {
          const resultSummary = summarizeStageResultForTrace(result);
          const producerName = typeof producer.tool === "string"
            ? `${producer.name}:${producer.tool}`
            : producer.name;
          onTrace?.({
            key: `workflow-stage-result:${isRecord(result) ? result.stage ?? "unknown" : "unknown"}:${producerName}`,
            text: `[阶段结果] ${producerName} 结果已返回${resultSummary ? `：${resultSummary}` : ""}`,
          });
          continue;
        }

        const skillName = isRecord(result) && typeof result.skillName === "string"
          ? result.skillName
          : skillNameForStage(isRecord(result) && typeof result.stage === "string" ? result.stage : undefined);
        if (skillName) {
          const resultSummary = summarizeStageResultForTrace(result);
          onTrace?.({
            key: `skill:result:${isRecord(result) ? result.stage ?? "unknown" : "unknown"}:${skillName}`,
            text: `[Skill] ${skillName} 结果已返回${resultSummary ? `：${resultSummary}` : ""}`,
          });
        }
      }
    }

    return stageResults;
  } catch {
    return [];
  }
}

function mergeStageResults(...groups) {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const result of group) {
      const key = stableStringify(result);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(result);
    }
  }

  return merged;
}

function summarizeStageResultForTrace(result) {
  if (!isRecord(result)) {
    return "";
  }

  const summary = typeof result.summary === "string" ? result.summary : "";
  const validation = isRecord(result.validation) ? result.validation : undefined;
  const validationErrors = Array.isArray(validation?.errors)
    ? validation.errors.filter((error) => typeof error === "string")
    : [];
  if (result.status !== "success" || validation?.ok === false) {
    return validationErrors.length > 0
      ? `校验失败：${truncate(validationErrors.join("；"), 120)}`
      : `状态为 ${String(result.status ?? "unknown")}`;
  }

  return summary ? truncate(summary.replace(/\s+/g, " "), 120) : "";
}

function hasRecoverableStageResult(stageResults) {
  return stageResults.some((result) =>
    isRecord(result)
      && result.stage === "topology"
      && result.status === "success"
      && isRecord(result.validation)
      && result.validation.ok === true
      && isRecord(result.payload)
      && result.payload.kind === "topology"
      && typeof result.payload.mutationId === "number"
  );
}

function buildRecoveredStageResultAssistantText(stageResults) {
  const result = stageResults.find((candidate) => isRecord(candidate) && candidate.stage === "topology");
  const summary = isRecord(result) && typeof result.summary === "string"
    ? result.summary
    : "已生成当前阶段结构化结果。";

  return [
    "已根据本轮需求生成拓扑草案。",
    summary,
    "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。",
  ].join("\n");
}

function resolveTopologyMcpServerPath(cwd) {
  const candidates = [
    join(cwd, "src-node", "tsn-topology-server.mjs"),
    join(cwd, "src-node", "dist", "tsn-topology-server.mjs"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
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
        key: `tool_use:${block.id ?? `${name}:${stableStringify(block.input)}`}:${traceDetailKey(block.input)}`,
        text: formatToolUseTrace(name, block.input),
      });
    }

    if (block?.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const name = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
      const failed = isFailedToolResult(block);
      traces.push({
        key: `tool_result:${toolUseId ?? stableStringify(block)}:${failed ? "error" : "ok"}:${traceDetailKey(block.content ?? block.toolUseResult)}`,
        text: formatToolResultTrace(name ?? "工具", block, failed),
      });
    }
  }

  return traces.filter((trace) => trace.text);
}

// Plan 2026-06-09-003：从 SDK 消息抽出结构化工具调用条目（use / result 两相）。
// worker 只透传原始 name + 完整 args/result，前端富化成卡片。
export function extractToolCallEvents(message, toolUseNamesById = new Map()) {
  const entries = [];
  const contentBlocks = collectContentBlocks(message);

  for (const block of contentBlocks) {
    if (block?.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "工具";
      if (typeof block.id === "string") {
        toolUseNamesById.set(block.id, name);
      }
      entries.push({
        phase: "use",
        id: typeof block.id === "string" ? block.id : undefined,
        name,
        args: block.input,
      });
    }

    if (block?.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const name = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
      entries.push({
        phase: "result",
        id: toolUseId,
        name,
        status: isFailedToolResult(block) ? "error" : "success",
        result: extractJsonFromToolResultBlock(block) ?? toolResultRawContent(block),
      });
    }
  }

  return entries.filter((entry) => entry.id);
}

function toolResultRawContent(block) {
  const content = block.content ?? block.toolUseResult;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => (typeof item === "string" ? item : isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
    return text || content;
  }

  return content;
}

function isNonEmptyToolInput(input) {
  if (input === undefined || input === null) {
    return false;
  }

  if (isRecord(input)) {
    return Object.keys(input).length > 0;
  }

  return true;
}

export function extractTopologyWorkflowStageResults(message, toolUseNamesById = new Map(), stageRunnerInput) {
  if (!isRecord(stageRunnerInput) || stageRunnerInput.stage !== "topology") {
    return [];
  }

  const results = [];
  const contentBlocks = collectContentBlocks(message);

  for (const block of contentBlocks) {
    if (block?.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const toolName = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
    if (toolName !== "mcp__tsn_topology__topology_initialize" && toolName !== "mcp__tsn_topology__topology_apply_operations") {
      continue;
    }

    const toolResult = extractJsonFromToolResultBlock(block);
    const mutation = extractTrustedTopologyMutation(toolResult);
    if (!mutation) {
      continue;
    }

    const workflowResult = createTopologyWorkflowStageResult(mutation, {
      producer: {
        type: "mcp",
        name: TOPOLOGY_MCP_SERVER_NAME,
        tool: toolNameToTopologyToolName(toolName),
      },
    });
    results.push({
      key: `${toolUseId ?? toolName}:${toolName}:${stableStringify(toolResult.summary)}`,
      result: workflowResult,
    });
  }

  return results;
}

// U2：从 request_stage_change 工具的 tool_result 提取切阶段提议。与拓扑提取的
// 边界一致（只认来自该工具调用的结果——大模型在自然语言里写「切到拓扑」但没调
// 工具则不产生提议），但不接 stageRunnerInput.stage 门槛：任何阶段都要能切。
// 注意：targetStage 是大模型填的参数，这里不校验合法性（合法性在应用层）。
export function extractStageChangeRequests(message, toolUseNamesById = new Map()) {
  const results = [];
  const contentBlocks = collectContentBlocks(message);

  for (const block of contentBlocks) {
    if (block?.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const toolName = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
    if (toolName !== REQUEST_STAGE_CHANGE_TOOL_NAME) {
      continue;
    }

    const request = extractStageChangeRequest(extractJsonFromToolResultBlock(block));
    if (!request) {
      continue;
    }

    results.push({
      key: `${toolUseId ?? toolName}:${REQUEST_STAGE_CHANGE_TOOL_NAME}:${request.targetStage}`,
      result: {
        kind: "stage-change-request",
        targetStage: request.targetStage,
        ...(request.reason ? { reason: request.reason } : {}),
      },
    });
  }

  return results;
}

function extractStageChangeRequest(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.stageChangeRequest)) {
    return undefined;
  }

  const { targetStage, reason } = value.stageChangeRequest;
  if (typeof targetStage !== "string" || targetStage.length === 0) {
    return undefined;
  }

  return {
    targetStage,
    reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
  };
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

function extractJsonFromToolResultBlock(block) {
  const content = block.content ?? block.toolUseResult;
  if (typeof content === "string") {
    return parseJsonOrUndefined(content);
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        const parsed = parseJsonOrUndefined(item);
        if (parsed !== undefined) {
          return parsed;
        }
      }

      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        const parsed = parseJsonOrUndefined(item.text);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    }
  }

  if (isRecord(content)) {
    return content;
  }

  return undefined;
}

function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Plan v3 Phase B-β：trusted signal 是 sidecar 响应的 `summary.mutationId`。
// 旧 `responseMode==="full"` resume 路径已删除 —— 新 workflow-stage-result
// 契约要求 payload 携带 mutationId，legacy 全量 topology 无法再合成阶段结果。
function extractTrustedTopologyMutation(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.summary)) {
    return undefined;
  }

  const { sessionId, mutationId, applied } = value.summary;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return undefined;
  }
  if (typeof mutationId !== "number" || !Number.isInteger(mutationId) || mutationId <= 0) {
    return undefined;
  }

  return {
    sessionId,
    mutationId,
    appliedCount: Array.isArray(applied) ? applied.length : undefined,
  };
}

/// Test-only helper to make extractor symmetry assertable from outside.
export function _extractTrustedTopologyMutationForTest(value) {
  return extractTrustedTopologyMutation(value);
}

function toolNameToTopologyToolName(toolName) {
  if (toolName === "mcp__tsn_topology__topology_apply_operations") {
    return "topology.apply_operations";
  }

  return "topology.initialize";
}

function formatToolUseTrace(name, input) {
  const toolName = formatToolName(name);
  const normalizedName = String(name ?? "").toLowerCase();
  const inputRecord = isRecord(input) ? input : {};
  const inputSummary = summarizeInput(input);

  if (normalizedName === "skill") {
    const skillName = stringValue(inputRecord.skill)
      ?? stringValue(inputRecord.skillName)
      ?? stringValue(inputRecord.name);
    return skillName ? `[Skill] 调用 ${skillName}` : "";
  }

  if (normalizedName === "read") {
    const path = formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path));
    return path ? `[文件] 读取 ${path}` : "";
  }

  if (normalizedName === "write") {
    const path = formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path));
    const contentSummary = summarizeWriteContent(inputRecord.content);
    return path ? `[文件] 写入 ${path}${contentSummary}` : "";
  }

  if (normalizedName === "edit" || normalizedName === "multiedit") {
    const path = formatPathForDisplay(stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path));
    return path ? `[文件] 修改 ${path}` : "";
  }

  if (normalizedName === "bash") {
    const command = summarizeCommand(stringValue(inputRecord.command) ?? stringValue(inputRecord.cmd));
    const description = stringValue(inputRecord.description);
    if (command && description) {
      return `[工具] Bash: ${command}（${truncate(redactSecrets(description), 60)}）`;
    }

    return command ? `[工具] Bash: ${command}` : "";
  }

  return inputSummary ? `[工具] ${toolName}: ${inputSummary}` : "";
}

function formatToolResultTrace(name, block, failed) {
  const toolName = formatToolName(name);
  const summary = summarizeToolResult(block);

  if (failed) {
    return summary
      ? `[工具结果] ${toolName} 已返回（失败）：${summary}`
      : `[工具结果] ${toolName} 已返回（失败）`;
  }

  return summary ? `[工具结果] ${toolName} 已返回：${summary}` : `[工具结果] ${toolName} 已返回`;
}

function isFailedToolResult(block) {
  if (block?.is_error === true || block?.error === true) {
    return true;
  }

  const content = block?.content;
  if (typeof content === "string" && /<tool_use_error>|^Error:|Exit code\s+[1-9]/i.test(content.trim())) {
    return true;
  }

  const toolUseResult = block?.toolUseResult;
  if (typeof toolUseResult === "string" && /^Error:|Exit code\s+[1-9]/i.test(toolUseResult.trim())) {
    return true;
  }

  if (isRecord(toolUseResult)) {
    const interrupted = toolUseResult.interrupted === true;
    const stderr = stringValue(toolUseResult.stderr);
    const exitCode = Number(toolUseResult.exitCode ?? toolUseResult.code);
    return interrupted || Boolean(stderr) && Number.isFinite(exitCode) && exitCode !== 0;
  }

  return false;
}

function formatToolName(name) {
  return String(name ?? "工具").trim() || "工具";
}

function summarizeCommand(command) {
  const redacted = redactSecrets(String(command ?? "").trim());

  if (!redacted) {
    return "";
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
    return "";
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

function summarizeWriteContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    return "";
  }

  const bytes = Buffer.byteLength(content, "utf8");
  const lineCount = content.split(/\r?\n/).length;
  return `（${lineCount} 行，${bytes} bytes）`;
}

function summarizeToolResult(block) {
  const content = block?.content ?? block?.toolUseResult;
  const summary = summarizeToolResultContent(content);

  if (summary) {
    return summary;
  }

  if (isRecord(block?.toolUseResult)) {
    const stdout = stringValue(block.toolUseResult.stdout);
    const stderr = stringValue(block.toolUseResult.stderr);
    if (stderr) {
      return truncate(redactSecrets(stderr.replace(/\s+/g, " ")), 180);
    }
    if (stdout) {
      return truncate(redactSecrets(stdout.replace(/\s+/g, " ")), 180);
    }
  }

  return "";
}

function summarizeToolResultContent(content) {
  if (typeof content === "string") {
    const cleaned = content.replace(/<tool_use_error>|<\/tool_use_error>/g, "").replace(/\s+/g, " ").trim();
    return cleaned ? truncate(redactSecrets(cleaned), 180) : "";
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => isRecord(item) ? summarizeToolResultContent(item.text ?? item.content ?? item.file?.filePath) : summarizeToolResultContent(item))
      .filter(Boolean)
      .join("；")
      .slice(0, 180);
  }

  if (isRecord(content)) {
    const filePath = isRecord(content.file) ? stringValue(content.file.filePath) : undefined;
    const error = stringValue(content.error) ?? stringValue(content.message);
    const stdout = stringValue(content.stdout);
    const stderr = stringValue(content.stderr);

    if (error) {
      return truncate(redactSecrets(error.replace(/\s+/g, " ")), 180);
    }
    if (stderr) {
      return truncate(redactSecrets(stderr.replace(/\s+/g, " ")), 180);
    }
    if (stdout) {
      return truncate(redactSecrets(stdout.replace(/\s+/g, " ")), 180);
    }
    if (filePath) {
      return `文件 ${formatPathForDisplay(filePath)}`;
    }
  }

  return "";
}

function traceDetailKey(value) {
  const summary = summarizeInput(value) || summarizeToolResultContent(value);
  return summary ? stableStringify(summary) : "empty";
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
    appSessionId: typeof input.appSessionId === "string" ? input.appSessionId : undefined,
    runId: typeof input.runId === "string" ? input.runId : undefined,
    auditDir: typeof input.auditDir === "string" ? input.auditDir : undefined,
    skillRoot: typeof input.skillRoot === "string" ? input.skillRoot : undefined,
    claudeBinaryPath: typeof input.claudeBinaryPath === "string" ? input.claudeBinaryPath : undefined,
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

if (await isCliEntryPoint(import.meta.url, process.argv[1])) {
  const [, , rawInput = "{}"] = process.argv;

  try {
    const response = await runWorker(rawInput);
    process.stdout.write(`${JSON.stringify({ event: "done", ...response })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: normalizeError(error) })}\n`);
    process.exitCode = 1;
  }
}

export async function isCliEntryPoint(moduleUrl, argvPath) {
  if (!argvPath) {
    return false;
  }

  // fileURLToPath 正确解码 %20 → 空格并跨平台处理盘符；旧实现 new URL().pathname 保留
  // %20，遇到含空格的打包路径（"TSN Agent.app"）realpath 必失败、fallback 也失配，
  // 导致 runWorker 永不执行、worker 静默 exit 0（dev 路径无空格故一直未暴露）。
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  try {
    return (await realpath(modulePath)) === (await realpath(argvPath));
  } catch {
    return modulePath === argvPath;
  }
}
