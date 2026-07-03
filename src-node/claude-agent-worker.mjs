import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createTopologyWorkflowStageResult } from "../src/agent/topology-workflow-stage-result";
import { buildEvalRecord, serializeEvalRecordLine } from "./eval/eval-record";
import { buildFingerprint, computeToolsHash } from "./eval/fingerprint";
import { fetchSidecar } from "./mcp/sidecar-client";

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
// timesync 工具同住 tsn_topology stdio server，仅在 time-sync 阶段放行（见
// buildAllowedToolsForStage）。worker 是纯 ESM、不能 import TS registry，故此处镜像
// topology-tools.ts 的 TIMESYNC_MCP_ALLOWED_TOOLS；测试断言两者一致防漂移。
export const TIMESYNC_MCP_ALLOWED_TOOLS = [
  "mcp__tsn_topology__timesync_set_gm",
  "mcp__tsn_topology__timesync_toggle_link",
  "mcp__tsn_topology__timesync_set_params",
  "mcp__tsn_topology__timesync_inspect",
  "mcp__tsn_topology__timesync_undo",
];
// flow 工具同住 tsn_topology stdio server，仅在 flow-template 阶段放行（见
// buildAllowedToolsForStage）。worker 是纯 ESM、不能 import TS registry，故此处镜像
// topology-tools.ts 的 FLOW_MCP_ALLOWED_TOOLS；测试断言两者一致防漂移。
export const FLOW_MCP_ALLOWED_TOOLS = [
  "mcp__tsn_topology__flow_add_stream",
  "mcp__tsn_topology__flow_inspect",
  "mcp__tsn_topology__flow_remove_stream",
];

// U1（独立编排能力）：切阶段工具独立于四个阶段，用 SDK in-process 自定义工具承载，
// 不连 sidecar、不写状态、不做合法性判断（合法性在应用层 agent-adapter）。它只把
// 大模型的「想回到哪个阶段」结构化返回；返回值经 stageResults 同款通道回传给应用层。
const WORKFLOW_MCP_SERVER_NAME = "tsn_workflow";
export const REQUEST_STAGE_CHANGE_TOOL_NAME = `mcp__${WORKFLOW_MCP_SERVER_NAME}__request_stage_change`;
// U6（单步撤销）：撤销工具也是 in-process（跑在 worker 主进程的 tsn_workflow server），
// handler 直接调 sidecar undo route——fetchSidecar 读 worker 自己进程的 env（sessionId
// 由 commands.rs 注入），无需传参。与 tsn_topology stdio 子进程工具不同，不走 buildTopologyMcpEnv 透传。
export const UNDO_TOOL_NAME = `mcp__${WORKFLOW_MCP_SERVER_NAME}__undo_last_change`;

export const requestStageChangeTool = tool(
  "request_stage_change",
  "当用户在当前阶段提出的需求其实属于之前已完成的阶段（改拓扑→topology、验时间同步→time-sync）时调用本工具。targetStage 为目标阶段，reason 为一句话理由。这一轮你只做意图判断：仅说明需要切回哪个阶段以及为什么、等用户确认；不要在这一轮追问或规划具体怎么改（如该删哪台交换机），也不要承诺立即执行——具体修改在用户确认切回目标阶段之后再处理。前进到下一阶段由用户点「确认并继续」按钮完成，不要用本工具前进。",
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
            ...(typeof args.reason === "string" && args.reason.length > 0
              ? { reason: args.reason }
              : {}),
          },
        }),
      },
    ],
  }),
);

export const undoLastChangeTool = tool(
  "undo_last_change",
  "用户说「撤销/回退刚才那步」时调用本工具，把上一次结构性拓扑改动（apply_operations / initialize）盖回到改动前的快照。无参数：会话由运行环境注入。指代不清（不确定要撤销哪一步、或上一步是不是用户想撤的）时，先用中文编号选项问清楚再调，不要擅自撤销。本工具不设单独确认闸，调用即直接执行；调用后工程库已回退，回答或继续编辑前先用 topology.inspect 重新确认当前拓扑，勿假设上一轮改动仍在。",
  {},
  async () => {
    const result = await fetchSidecar("/db/topology/undo", {});
    // 解包 fetchSidecar 信封，对齐其它 sidecar 工具的契约：成功直接给 body（{ok,undone,summary}），
    // 失败给 {ok:false,errors:[...]}，而不是把 {ok,status,body} 整个信封丢给大模型（弱模型易误读）。
    const payload = result.ok
      ? result.body
      : { ok: false, errors: [{ code: result.code, message: result.message }] };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    };
  },
);

const workflowMcpServer = createSdkMcpServer({
  name: WORKFLOW_MCP_SERVER_NAME,
  version: "1.0.0",
  tools: [requestStageChangeTool, undoLastChangeTool],
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
  // Plan 2026-06-25-002 U3：eval 记录起始时刻（durationMs）。
  const evalStartedAt = Date.now();
  const cwd =
    typeof resolvedOptions.cwd === "string" && resolvedOptions.cwd.length > 0
      ? resolvedOptions.cwd
      : process.cwd();
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
  const stageResultPath = resolvedOptions.stageResultPath ?? (await createStageResultPath());
  const skillOutputDir =
    resolvedOptions.skillOutputDir ?? (await createSkillOutputDir(stageResultPath));
  // 同源（R2）：skill 指引读取根优先取 Tauri 决策的有效根（payload skillRoot，
  // release 下指向 app-data 播种副本），缺省回退 cwd 下仓库/资源路径。
  const skillRoot =
    typeof resolvedOptions.skillRoot === "string" && resolvedOptions.skillRoot.length > 0
      ? resolvedOptions.skillRoot
      : join(cwd, ".claude", "skills");
  const topologyMcpServerPath =
    resolvedOptions.topologyMcpServerPath ?? resolveTopologyMcpServerPath(cwd);
  // 打包态：Tauri 注入随 app 分发的 claude binary 路径。SDK 默认从 node_modules 的
  // 平台包（@anthropic-ai/claude-agent-sdk-{platform}）找 claude，bundle 后不存在，
  // 故打包态必须显式 pathToClaudeCodeExecutable；dev 态为 undefined，走 SDK 默认。
  const claudeBinaryPath =
    typeof resolvedOptions.claudeBinaryPath === "string" &&
    resolvedOptions.claudeBinaryPath.length > 0
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
  const topologyMcpConfig =
    topologyMcpServerPath && existsSync(topologyMcpServerPath)
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
  const stageRunnerInputPath = await writeStageRunnerInputFile(
    stageResultPath,
    resolvedOptions.stageRunnerInput,
  );
  const { systemPrompt, skillContent } = await buildSystemPromptForStage(
    resolvedOptions.stageRunnerInput,
    skillRoot,
  );
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
    // 只保留 "project"，砍掉 "user"：
    // - 不含 "user" → 不继承开发者个人 Claude Code 的 enabledPlugins（compound-engineering/
    //   gstack 等几十个 skill/agent 描述会灌进工具 schema）与个人默认模型/偏好——这是 token 大头；
    //   debug 实测已确认：Found 0 enabled plugins / Total plugin skills loaded: 0。
    // - 保留 "project" → SDK 才会从 .claude/skills/ 发现并注册 tsn-topology/tsn-time-sync/
    //   tsn-flow-planning（下方 skills 数组只是「启用哪些」的过滤白名单，不负责加载；关掉
    //   "project" 后 Skill 工具会报 Unknown skill）。debug 实测：Loaded 3 unique skills (project: 3)。
    // - 项目 AGENTS.md/CLAUDE.md 不会进 prompt：memory 注入靠 claude_code preset，而本 worker
    //   用的是自定义字符串 systemPrompt（见下方 systemPrompt），preset 未启用 → memory 不注入。
    settingSources: ["project"],
    model: "claude-sonnet-4-6",
    permissionMode: "dontAsk",
    // 只发 agent 实际用到的内置工具，不用整套 claude_code 预设（预设会把 Bash/Write/
    // Edit/Glob/Grep/Task/WebFetch/WebSearch/TodoWrite 等全套 schema 发给模型，白吃 token；
    // allowedTools 只是免确认白名单、不裁剪发送）。Read 用于查阅其它场景 reference（SKILL.md
    // 明示）；Skill 由 skills 选项管理、列此确保可用；领域写操作全走 mcpServers 的 MCP 工具。
    tools: ["Read", "Skill"],
    allowedTools: buildAllowedToolsForStage(
      resolvedOptions.stageRunnerInput,
      Boolean(topologyMcpConfig),
    ),
    // AskUserQuestion 在 dontAsk 模式下必然被拒（无终端 UI），硬禁省掉模型
    // 尝试浪费的 turn；prompt 交互规则 1 告知替代路径（中文数字编号选项）。
    disallowedTools: ["AskUserQuestion"],
    skills: ["tsn-topology", "tsn-time-sync", "tsn-flow-planning"],
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
    ...(typeof resolvedOptions.resumeSessionId === "string" &&
    resolvedOptions.resumeSessionId.length > 0
      ? { resume: resolvedOptions.resumeSessionId }
      : {}),
    systemPrompt,
  };

  // Plan 2026-06-25-002 U3/U4：eval 捕获——版本指纹、原生 output blocks 累加器、
  // apply/validate 弱标签。input.system + output.* 为 raw（不脱敏）；input.messages
  // 历史侧只有 worker 持有的 finalPrompt（含 conversationContext 有损摘要，KTD3）。
  const evalStageInput = resolvedOptions.stageRunnerInput;
  const evalStage =
    isRecord(evalStageInput) && typeof evalStageInput.stage === "string"
      ? evalStageInput.stage
      : null;
  const evalScenarioId =
    isRecord(evalStageInput) && typeof evalStageInput.scenarioConfigId === "string"
      ? evalStageInput.scenarioConfigId
      : null;
  const evalFingerprint = buildFingerprint({
    skillContent,
    skeleton: SYSTEM_PROMPT_SKELETON,
    scenarioId: evalScenarioId,
    model: sdkOptions.model,
  });
  const evalToolsHash = computeToolsHash(
    Array.isArray(sdkOptions.allowedTools) ? sdkOptions.allowedTools : [],
  );
  const evalOutputMessages = [];
  let evalLabel = null;
  const finalizeEval = async (finalText) => {
    await writeEvalRecord({
      evalDir: resolvedOptions.evalDir,
      runId: resolvedOptions.runId,
      appSessionId: resolvedOptions.appSessionId,
      claudeSessionId: sessionId,
      stage: evalStage,
      scenarioConfigId: evalScenarioId,
      model: sdkOptions.model,
      durationMs: Date.now() - evalStartedAt,
      fingerprint: evalFingerprint,
      system: systemPrompt,
      toolsHash: evalToolsHash,
      inputMessages: [{ role: "user", content: [{ type: "text", text: finalPrompt }] }],
      outputMessages: evalOutputMessages,
      finalText: typeof finalText === "string" ? finalText : "",
      label: evalLabel,
    });
  };
  const recordEvalOutput = (role, message) => {
    const blocks = collectContentBlocks(message);
    if (blocks.length > 0) {
      evalOutputMessages.push({ role, content: blocks });
    }
    const label = extractEvalLabel(blocks, toolUseNamesById);
    if (label) {
      evalLabel = label;
    }
  };

  const handleSdkMessage = (message) => {
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
      collectToolCalls(message);
      captureTopologyStageResults(message);
      captureStageChangeRequests(message);
      recordEvalOutput("assistant", message);

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
      recordEvalOutput("user", message);
    }

    if (message.type === "result") {
      sessionId = message.session_id ?? sessionId;

      // 观测（临时）：记录本轮真实 token 消耗。result.usage 来自 API 响应，后端无关
      // （vLLM/DeepSeek 皆可）。独立 jsonl、不进 eval schema；写盘失败静默、不阻断本轮。
      if (
        message.usage &&
        typeof resolvedOptions.evalDir === "string" &&
        resolvedOptions.evalDir.trim()
      ) {
        const u = message.usage;
        const usageLine =
          JSON.stringify({
            t: new Date().toISOString(),
            stage: evalStage,
            scenario: evalScenarioId,
            model: sdkOptions.model,
            num_turns: message.num_turns ?? null,
            input_tokens: u.input_tokens ?? null,
            output_tokens: u.output_tokens ?? null,
            cache_read_input_tokens: u.cache_read_input_tokens ?? null,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
          }) + "\n";
        appendFile(join(resolvedOptions.evalDir, "token-usage.jsonl"), usageLine, "utf8").catch(
          () => {},
        );
      }

      if (message.structured_output?.assistantText) {
        assistantText = message.structured_output.assistantText;
      } else if (typeof message.result === "string") {
        assistantText = parseAssistantText(message.result);
      }
    }
  };
  const captureTopologyStageResults = (message) => {
    for (const extracted of extractTopologyWorkflowStageResults(
      message,
      toolUseNamesById,
      resolvedOptions.stageRunnerInput,
    )) {
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
    resolvedOptions.onEvent?.({ event: "chunk", text });
  };
  // U8：审计已删，trace 不再落盘；保留 emitOperationTrace 仅做 key 去重（工具卡片
  // 由结构化 onToolCall 承载）。
  const emitOperationTrace = (trace) => {
    if (!trace?.text || !trace.key || operationTraceKeys.has(trace.key)) {
      return;
    }

    operationTraceKeys.add(trace.key);
  };
  const collectToolCalls = (message) => {
    for (const entry of extractToolCallEvents(message, toolUseNamesById)) {
      const existing = toolCallsById.get(entry.id) ?? {
        id: entry.id,
        name: entry.name,
        status: "success",
      };

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
            toolCall: {
              id: entry.id,
              name: existing.name,
              status: existing.status,
              result: existing.result,
              phase: "result",
            },
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
    const stageResults = mergeStageResults(
      capturedStageResults,
      await readStageResults(stageResultPath, emitOperationTrace),
    );

    if (hasRecoverableStageResult(stageResults)) {
      const recoveredText = buildRecoveredStageResultAssistantText(stageResults);
      await finalizeEval(recoveredText);

      return {
        assistantText: recoveredText,
        sessionId,
        stageResults,
        toolCalls: [...toolCallsById.values()],
      };
    }

    await finalizeEval(assistantText);
    throw error;
  }

  if (!assistantText.trim() && emittedText.length > 0) {
    assistantText = emittedText.join("");
  }

  const finalStageResults = mergeStageResults(
    capturedStageResults,
    await readStageResults(stageResultPath, emitOperationTrace),
  );

  if (!assistantText.trim() && hasRecoverableStageResult(finalStageResults)) {
    assistantText = buildRecoveredStageResultAssistantText(finalStageResults);
  }

  if (!assistantText.trim()) {
    const error = new Error("Claude returned no assistantText");
    await finalizeEval(assistantText);
    throw error;
  }

  const finalAssistantText = assistantText.trim();
  await finalizeEval(finalAssistantText);

  return {
    assistantText: finalAssistantText,
    sessionId,
    stageResults: finalStageResults,
    toolCalls: [...toolCallsById.values()],
  };
}

// Phase B-β2：adapter 端非拓扑阶段全部本地拦截，worker 只会收到 topology 阶段；
// stage runner / flow-template retry 路径已删除。
export function buildAllowedToolsForStage(stageRunnerInput, hasTopologyMcpConfig) {
  const stage =
    isRecord(stageRunnerInput) && typeof stageRunnerInput.stage === "string"
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
    // U10：timesync 工具只在时间同步阶段开放。与 topology 工具同住 tsn_topology stdio
    // server，故同样门控 hasTopologyMcpConfig（server 没注册就别白名单它们）。timesync 写库
    // 走 sidecar、前端靠查库渲染，不经 stageResult 对账，但 stage 门控仍防跨阶段误写。
    ...(hasTopologyMcpConfig && stage === "time-sync" ? TIMESYNC_MCP_ALLOWED_TOOLS : []),
    // time-sync 阶段额外放行只读的 topology_inspect：设 GM/配置时钟同步要先读拓扑
    // 把节点名（如 ES-1）解析成 mid。只读工具跨阶段安全（门控本意是挡拓扑写工具
    // apply_operations/initialize，不是挡读）。
    ...(hasTopologyMcpConfig && stage === "time-sync"
      ? ["mcp__tsn_topology__topology_inspect"]
      : []),
    // U3：flow 工具只在流量规划阶段开放（同住 tsn_topology stdio server，故同门控
    // hasTopologyMcpConfig）。录流写库走 sidecar + verify_flow 闸，不经 stageResult 对账。
    ...(hasTopologyMcpConfig && stage === "flow-template" ? FLOW_MCP_ALLOWED_TOOLS : []),
    // flow 阶段同样放行只读 topology_inspect：录流要把 talker/listener 节点名解析成 mid。
    ...(hasTopologyMcpConfig && stage === "flow-template"
      ? ["mcp__tsn_topology__topology_inspect"]
      : []),
    // U6：撤销工具只在拓扑阶段开放（不像 request_stage_change 全阶段）——本期只撤 topology，
    // 在时间同步 / 流量规划阶段撤销会错误回退拓扑。撤销 in-process 不依赖拓扑 stdio server，
    // 故只门控 stage（不门控 hasTopologyMcpConfig）。time-sync 阶段撤销走 timesync.undo 工具。
    ...(stage === "topology" ? [UNDO_TOOL_NAME] : []),
  ];
}

// system prompt 骨架：仅守安全/正确性约束（必走 MCP、固定阶段顺序、不自编拓扑
// JSON、不写 stage-result），领域指引由注入的 SKILL.md 承载（含仿真「不得声称」，
// 运行时由 sanitizeClaudeAssistantText 输出守卫兜底）。
// R4/KTD8：协议不变量（用户改坏会破坏对账/产生数据损坏的规则）全部收口在此，
// 不进可编辑 skill 文件。迁移自 SKILL.md：①initialize 后不复检 validate；
// ②apply_operations 超时重试逐字节复用（重新分配 linkSeq 会产生重复平行链路）。
const SYSTEM_PROMPT_SKELETON =
  "你是 TSN Agent 的规划助手。你面向懂一点 TSN 但不了解具体参数的新手用户。回复必须是简体中文，保持工程化、具体、可执行。工程状态只接受结构化校验结果。拓扑初始化、校验、artifact 构建、inspect 和 apply_operations 必须通过 tsn_topology MCP 工具调用 sidecar，所有工具结果都已是结构化领域响应。artifact、端口表、MAC 表和完整 changeSet 不得再在自然语言里复述。不要写 TSN_AGENT_STAGE_RESULT_PATH，不要用自然语言重新构建拓扑。固定阶段顺序是拓扑、时间同步、流量规划、配置下发。前进到下一阶段由用户点「确认并继续」按钮完成，你不要自行宣称已进入下一阶段。用户在当前阶段提出的需求其实属于之前已完成的阶段（改拓扑、验时间同步）时，调用 request_stage_change 工具（参数：目标阶段 targetStage、理由 reason）表达需要切回。这一轮只做意图判断：只说明要切回哪个阶段及原因、等用户确认，不要在这一轮追问或规划具体怎么改、也不要承诺立即执行。切回会让其后的阶段重做。用户确认切回后，会用其原话在目标阶段继续处理修改；那时若需求有歧义（如有多台交换机、该删哪台不明），先用中文编号选项问清楚再动手，不要擅自替用户选。不要用该工具前进。已有拓扑用 tsn_topology inspect + apply_operations 增量编辑，initialize 仅用于从 0 生成或换模板（误用会整表重排已确认拓扑）。initialize 已校验并落库，之后无需对 initialize 结果复检；apply_operations 改动拓扑后，其返回已自动带库内结构校验结论（validation 字段），据此把中文结论告诉用户、有问题如实说。apply_operations 超时重试时逐字节复用上一次的同一 operations（相同 mid/linkSeq），不要重新分配——重新分配 linkSeq 会产生重复的平行链路。最终工程状态只接受应用层合成的结构化结果，不要自行编写 stage result。";

// SKILL.md 正文每次运行注入骨架之后，用固定 sentinel 分隔，便于切分骨架段与注入段。
const SKILL_GUIDANCE_SENTINEL = "<<<SKILL_GUIDANCE>>>";
// R6：场景 reference 注入段的第二 sentinel（骨架 → 索引 → 场景 reference）。
// 注入保持单字符串拼接——string[] 形态会崩 redactSecrets。
const SCENARIO_REFERENCE_SENTINEL = "<<<SCENARIO_REFERENCE>>>";
// 未知/缺失场景回退到通用场景（与 SKILL.md 场景路由表一致）。
const FALLBACK_SCENARIO_ID = "generic-tsn";

// 阶段 → 注入哪个 SKILL.md 目录。time-sync 注入 tsn-time-sync，其余（topology/未知）
// 注入 tsn-topology。注入始终是单字符串拼接（绝不 string[]——string[] 会崩 redactSecrets）。
function skillDirForStage(stageRunnerInput) {
  const stage =
    isRecord(stageRunnerInput) && typeof stageRunnerInput.stage === "string"
      ? stageRunnerInput.stage
      : undefined;
  if (stage === "time-sync") return "tsn-time-sync";
  if (stage === "flow-template") return "tsn-flow-planning";
  return "tsn-topology";
}

async function buildSystemPromptForStage(stageRunnerInput, skillRoot) {
  const skillDir = skillDirForStage(stageRunnerInput);
  const skillPath = join(skillRoot, skillDir, "SKILL.md");

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

  // 场景 reference 注入只属于拓扑阶段（references/ 是拓扑场景模板细则）。其它阶段
  // （time-sync）只注入骨架 + 该阶段 SKILL.md 正文，不做场景分隔。
  if (skillDir !== "tsn-topology") {
    return {
      systemPrompt: `${SYSTEM_PROMPT_SKELETON}\n\n${SKILL_GUIDANCE_SENTINEL}\n${guidance}`,
      skillContent: guidance,
    };
  }

  // R6 按场景确定性注入：requested 场景 reference → 回退 generic-tsn → 仅索引。
  // 全链 fail-open：reference 缺失降级注入，不阻断运行。
  const referenceDir = join(skillRoot, "tsn-topology", "references");
  const requestedScenario =
    typeof stageRunnerInput?.scenarioConfigId === "string" &&
    stageRunnerInput.scenarioConfigId.length > 0
      ? stageRunnerInput.scenarioConfigId
      : null;
  // 场景 id 进文件路径前做格式校验：畸形值（如含 ../ 的路径遍历）按未知场景
  // 走 generic-tsn 回退，不参与 join。
  const isSafeScenarioId =
    requestedScenario !== null && /^[a-z0-9][a-z0-9-]*$/.test(requestedScenario);
  const candidates =
    isSafeScenarioId && requestedScenario !== FALLBACK_SCENARIO_ID
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
  const scenarioReferenceWarning =
    referenceBody === null
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
      skillContent: guidance,
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
  const pathTable =
    referenceListing.length > 0
      ? `\n\n可用参考文件（其余场景用 Read 工具按绝对路径查阅）：\n${referenceListing.join("\n")}`
      : "";

  return {
    systemPrompt: `${SYSTEM_PROMPT_SKELETON}\n\n${SKILL_GUIDANCE_SENTINEL}\n${guidance}\n\n${SCENARIO_REFERENCE_SENTINEL}\n${referenceBody}${pathTable}`,
    skillContent: guidance,
    scenarioReference,
    scenarioReferenceWarning,
  };
}

export function buildPrompt(
  userPrompt,
  conversationContext,
  _stageResultPath = "$TSN_AGENT_STAGE_RESULT_PATH",
  skillOutputDir = "$TSN_AGENT_SKILL_OUTPUT_DIR",
  stageRunnerInput,
  stageRunnerInputPath,
) {
  const contextBlock = conversationContext ? `\n会话上下文：\n${conversationContext}\n` : "";
  const stageRunnerInputBlock = stageRunnerInput
    ? `\n阶段结构化输入：\n${
        stageRunnerInputPath
          ? `- 已写入文件：${stageRunnerInputPath}`
          : JSON.stringify(stageRunnerInput, null, 2)
      }\n`
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
4. 一轮聚焦一个决策点；次要参数有合理默认值时给默认并允许用户一句话确认。
5. 用户的简短确认（如"速率够用"）不需要调用工具，直接推进。
6. 增量修改已确认的拓扑时，先 topology.inspect 查 rows 再用 topology.apply_operations 构造原子操作；不要用 initialize 重建（会重排节点命名）。
7. 不要把 inspect 返回的 rows / stylesJson 原文复述进中文回复。`;
  const failureInstruction =
    "6. 如果当前阶段是拓扑，不能只返回文字说明；没有 trusted topology result 就不要声称阶段已生成。";
  const fileInstruction =
    "4. 不要修改仓库文件；不要写 TSN_AGENT_STAGE_RESULT_PATH；不要输出 Markdown 表格。";

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
3. 固定阶段顺序是“拓扑 -> 时间同步 -> 流量规划 -> 配置下发”。如果上下文显示当前阶段是时间同步，只能说明同步假设和等待确认，不能引导用户配置控制流。
${fileInstruction}
5. 如果需求缺少关键参数（规模 / 拓扑形态 / 要不要冗余），先用中文编号选项问清楚（把推荐默认值列为其中一个选项、标「推荐」），别默默套默认值直接生成。用户只给了拓扑名或组网名（如双平面双跳、五跳线性）时，场景模板 / preset 补全的规模和特征是你替他做的假设，也要先列出来确认，不算「信息齐了」；只有规模、形态、冗余都显式说全了才直接生成。
${failureInstruction}`;
}

async function createStageResultPath() {
  const dir = join(
    tmpdir(),
    `tsn-agent-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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

// Plan 2026-06-25-002 U3/U4：把一条 raw eval 记录 append 到注入的 eval/ 目录（JSONL）。
// 未注入 evalDir（dev/test）或写盘失败均降级——不阻断本轮 agent（R5）。文件首建设 0600。
async function writeEvalRecord(input) {
  const evalDir = input.evalDir;
  if (typeof evalDir !== "string" || !evalDir.trim()) {
    return undefined;
  }
  try {
    await mkdir(evalDir, { recursive: true });
    const filePath = join(evalDir, "eval.jsonl");
    const existed = existsSync(filePath);
    const record = buildEvalRecord({
      runId: input.runId,
      appSessionId: input.appSessionId,
      claudeSessionId: input.claudeSessionId,
      stage: input.stage,
      scenarioConfigId: input.scenarioConfigId,
      model: input.model,
      createdAt: new Date().toISOString(),
      durationMs: input.durationMs,
      fingerprint: input.fingerprint,
      system: input.system,
      toolsHash: input.toolsHash,
      inputMessages: input.inputMessages,
      outputMessages: input.outputMessages,
      finalText: input.finalText,
      label: input.label,
    });
    await appendFile(filePath, serializeEvalRecordLine(record), "utf8");
    if (!existed) {
      try {
        await chmod(filePath, 0o600);
      } catch {
        // Windows 等不支持 chmod，忽略。
      }
    }
    return filePath;
  } catch {
    return undefined;
  }
}

// label 取 worker 内 apply/validate 工具结果的 verification（KTD4）；拓扑外/无则 null。
const EVAL_LABEL_TOOLS = new Set([
  "mcp__tsn_topology__topology_apply_operations",
  "mcp__tsn_topology__topology_validate",
]);

function extractEvalLabel(blocks, toolUseNamesById) {
  for (const block of blocks) {
    if (block?.type !== "tool_result") {
      continue;
    }
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const toolName = toolUseId ? toolUseNamesById.get(toolUseId) : undefined;
    if (!toolName || !EVAL_LABEL_TOOLS.has(toolName)) {
      continue;
    }
    const label = normalizeEvalLabel(extractJsonFromToolResultBlock(block));
    if (label) {
      return label;
    }
  }
  return null;
}

function normalizeEvalLabel(result) {
  if (!isRecord(result)) {
    return null;
  }
  // apply_operations 返回带 validation 子对象；validate 直接是 VerifyResult。
  const verification = isRecord(result.validation) ? result.validation : result;
  const ok =
    typeof verification.ok === "boolean"
      ? verification.ok
      : typeof verification.valid === "boolean"
        ? verification.valid
        : undefined;
  const caliber = typeof verification.caliber === "string" ? verification.caliber : undefined;
  if (ok === undefined && caliber === undefined) {
    return null;
  }
  return {
    ok: ok ?? false,
    caliber: caliber ?? "structural_only",
    errors: Array.isArray(verification.errors) ? verification.errors : [],
  };
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
        const producer =
          isRecord(result) && isRecord(result.producer) ? result.producer : undefined;
        if (producer && typeof producer.name === "string") {
          const resultSummary = summarizeStageResultForTrace(result);
          const producerName =
            typeof producer.tool === "string" ? `${producer.name}:${producer.tool}` : producer.name;
          onTrace?.({
            key: `workflow-stage-result:${isRecord(result) ? (result.stage ?? "unknown") : "unknown"}:${producerName}`,
            text: `[阶段结果] ${producerName} 结果已返回${resultSummary ? `：${resultSummary}` : ""}`,
          });
          continue;
        }

        const skillName =
          isRecord(result) && typeof result.skillName === "string"
            ? result.skillName
            : skillNameForStage(
                isRecord(result) && typeof result.stage === "string" ? result.stage : undefined,
              );
        if (skillName) {
          const resultSummary = summarizeStageResultForTrace(result);
          onTrace?.({
            key: `skill:result:${isRecord(result) ? (result.stage ?? "unknown") : "unknown"}:${skillName}`,
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
  return stageResults.some(
    (result) =>
      isRecord(result) &&
      result.stage === "topology" &&
      result.status === "success" &&
      isRecord(result.validation) &&
      result.validation.ok === true &&
      isRecord(result.payload) &&
      result.payload.kind === "topology" &&
      typeof result.payload.mutationId === "number",
  );
}

function buildRecoveredStageResultAssistantText(stageResults) {
  const result = stageResults.find(
    (candidate) => isRecord(candidate) && candidate.stage === "topology",
  );
  const summary =
    isRecord(result) && typeof result.summary === "string"
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
    .filter(
      (block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0,
    )
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
      .map((item) =>
        typeof item === "string"
          ? item
          : isRecord(item) && typeof item.text === "string"
            ? item.text
            : "",
      )
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

export function extractTopologyWorkflowStageResults(
  message,
  toolUseNamesById = new Map(),
  stageRunnerInput,
) {
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
    if (
      toolName !== "mcp__tsn_topology__topology_initialize" &&
      toolName !== "mcp__tsn_topology__topology_apply_operations"
    ) {
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
    const skillName =
      stringValue(inputRecord.skill) ??
      stringValue(inputRecord.skillName) ??
      stringValue(inputRecord.name);
    return skillName ? `[Skill] 调用 ${skillName}` : "";
  }

  if (normalizedName === "read") {
    const path = formatPathForDisplay(
      stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path),
    );
    return path ? `[文件] 读取 ${path}` : "";
  }

  if (normalizedName === "write") {
    const path = formatPathForDisplay(
      stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path),
    );
    const contentSummary = summarizeWriteContent(inputRecord.content);
    return path ? `[文件] 写入 ${path}${contentSummary}` : "";
  }

  if (normalizedName === "edit" || normalizedName === "multiedit") {
    const path = formatPathForDisplay(
      stringValue(inputRecord.file_path) ?? stringValue(inputRecord.path),
    );
    return path ? `[文件] 修改 ${path}` : "";
  }

  if (normalizedName === "bash") {
    const command = summarizeCommand(
      stringValue(inputRecord.command) ?? stringValue(inputRecord.cmd),
    );
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
  if (
    typeof content === "string" &&
    /<tool_use_error>|^Error:|Exit code\s+[1-9]/i.test(content.trim())
  ) {
    return true;
  }

  const toolUseResult = block?.toolUseResult;
  if (
    typeof toolUseResult === "string" &&
    /^Error:|Exit code\s+[1-9]/i.test(toolUseResult.trim())
  ) {
    return true;
  }

  if (isRecord(toolUseResult)) {
    const interrupted = toolUseResult.interrupted === true;
    const stderr = stringValue(toolUseResult.stderr);
    const exitCode = Number(toolUseResult.exitCode ?? toolUseResult.code);
    return interrupted || (Boolean(stderr) && Number.isFinite(exitCode) && exitCode !== 0);
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

  const candidate =
    stringValue(input.description) ??
    stringValue(input.summary) ??
    stringValue(input.path) ??
    stringValue(input.file_path) ??
    stringValue(input.command) ??
    stringValue(input.cmd);
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
    const cleaned = content
      .replace(/<tool_use_error>|<\/tool_use_error>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned ? truncate(redactSecrets(cleaned), 180) : "";
  }

  if (Array.isArray(content)) {
    return content
      .map((item) =>
        isRecord(item)
          ? summarizeToolResultContent(item.text ?? item.content ?? item.file?.filePath)
          : summarizeToolResultContent(item),
      )
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
    .replace(
      /((?:api[_-]?key|token|secret|password|claude_api_key)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:accessToken|refreshToken|authToken|apiKey|api_key|token|secret|password)"\s*:\s*")([^"]+)(")/gi,
      "$1[redacted]$3",
    )
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
    conversationContext:
      typeof input.conversationContext === "string" ? input.conversationContext : undefined,
    resumeSessionId: typeof input.resumeSessionId === "string" ? input.resumeSessionId : undefined,
    stageRunnerInput: isRecord(input.stageRunnerInput) ? input.stageRunnerInput : undefined,
    appSessionId: typeof input.appSessionId === "string" ? input.appSessionId : undefined,
    runId: typeof input.runId === "string" ? input.runId : undefined,
    evalDir: typeof input.evalDir === "string" ? input.evalDir : undefined,
    skillRoot: typeof input.skillRoot === "string" ? input.skillRoot : undefined,
    claudeBinaryPath:
      typeof input.claudeBinaryPath === "string" ? input.claudeBinaryPath : undefined,
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
