import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { logDiagnostic } from "../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import type { ChatMessage, TsnSession } from "../sessions/session-repository";
import {
  countEndSystems,
  countSwitches,
  type TopologyRowSnapshot,
} from "../sessions/topology-snapshot";
import { getScenarioConfig } from "../domain/scenario-config";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import {
  confirmCurrentStage,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
  type WorkflowState,
} from "../project/project-state";
import { getTopologyRuntimeSummary } from "../topology/topology-service";
import type { AgentEvent, TsnAgentRequest, TsnAgentResult } from "./agent-types";
import {
  parseWorkflowStageResult,
  summarizeWorkflowStageResult,
  validateWorkflowStageResult,
  type TopologyWorkflowStageResult,
  type WorkflowStageSummary,
} from "./workflow-stage-result";

export type { AgentEvent, TsnAgentRequest, TsnAgentResult } from "./agent-types";

interface ClaudeAgentResponse {
  assistantText: string;
  sessionId?: string;
  stageResults?: unknown[];
  auditPath?: string;
}

interface ClaudeAgentEvent {
  runId: string;
  kind: "chunk" | "session" | "done" | "error";
  text?: string;
  sessionId?: string;
}

/**
 * Plan v3 Phase B-β：Tauri-only adapter。
 *
 * - 非 Tauri（Web）fail-closed：返回「需要桌面版」结果，不再有 fake-agent 兜底。
 * - 拓扑权威在 SQLite P0 表：stage result 只携带 mutationId，adapter 不合成
 *   canonical project；UI 通过 query_topology 拉数据。
 * - 边界推进（确认 / time-sync 默认值）本地完成，不调用 Claude。
 */
export async function runTsnAgent(requestOrIntent: TsnAgentRequest | string): Promise<TsnAgentResult> {
  const request = typeof requestOrIntent === "string" ? { userIntent: requestOrIntent } : requestOrIntent;
  const { userIntent } = request;
  const workflow = normalizeWorkflowState(request.session?.workflow);
  const runId = request.runId ?? createRunId();
  const sessionId = request.session?.id;
  const startedAt = Date.now();

  if (!isTauriRuntime()) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      level: "warn",
      message: "Agent 在非桌面环境不可用",
      durationMs: Date.now() - startedAt,
    });

    return createUnavailableResult(workflow);
  }

  logAgent(request.diagnostics, {
    sessionId,
    runId,
    message: "Agent 请求开始",
    details: {
      mode: "claude",
      hasResumeSession: Boolean(request.session?.claudeSessionId),
      inputChars: userIntent.length,
      topologyRuntime: getTopologyRuntimeSummary("unknown"),
      context: request.session ? buildSessionDiagnosticsContext(request.session) : undefined,
    },
  });

  const localResult = runLocalBoundaryProgression(userIntent, workflow);
  if (localResult) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Agent 使用本地确定性边界回复",
      durationMs: Date.now() - startedAt,
      details: {
        workflowStep: localResult.workflow.currentStep,
        workflowStatus: localResult.workflow.stages[localResult.workflow.currentStep].status,
      },
    });

    return localResult;
  }

  // 灰阶段（flow-template / planning-export）收到拓扑修改意图：回退到拓扑阶段再走 Claude。
  const effectiveWorkflow =
    (workflow.currentStep === "flow-template" || workflow.currentStep === "planning-export")
      && hasTopologyChangeIntent(userIntent)
      ? requestStageChanges(workflow, "topology")
      : workflow;
  const snapshot = await fetchTopologySnapshot(sessionId);
  const streamStats = {
    chunkCount: 0,
    totalChars: 0,
    firstChunkAtMs: undefined as number | undefined,
    lastPreview: "",
  };
  const unlisten = await listenToClaudeChunks(runId, (chunk) => {
    streamStats.chunkCount += 1;
    streamStats.totalChars += chunk.length;
    streamStats.firstChunkAtMs ??= Date.now() - startedAt;
    streamStats.lastPreview = chunk.slice(-120);
    request.onChunk?.(chunk);
  });

  try {
    const claude = await invoke<ClaudeAgentResponse>("run_claude_agent", {
      request: {
        prompt: userIntent,
        runId,
        appSessionId: sessionId,
        resumeSessionId: request.session?.claudeSessionId,
        conversationContext: buildConversationContext(request.session, effectiveWorkflow, snapshot, userIntent),
        stageRunnerInput: {
          userIntent,
          stage: effectiveWorkflow.currentStep,
          scenarioConfigId: effectiveWorkflow.scenarioConfigId,
        },
      },
    });
    const application = applyStageResults({
      stageResults: claude.stageResults ?? [],
      workflow: effectiveWorkflow,
      sessionId,
    });
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "智能助手请求完成",
      durationMs: Date.now() - startedAt,
      details: {
        claudeSessionId: claude.sessionId,
        streamStats,
        assistantChars: claude.assistantText.length,
        stageResultCount: claude.stageResults?.length ?? 0,
        appliedStageResult: application.applied
          ? `${application.applied.producer.type}:${application.applied.producer.name}`
          : undefined,
        rejectedStageResults: application.rejections.length,
        auditPath: claude.auditPath,
        topologyMutationId: application.topologyMutationId,
        topologyRuntime: getTopologyRuntimeSummary(application.rejections.length > 0 ? "call_failed" : "available"),
      },
    });

    return {
      events: application.events,
      workflow: application.workflow,
      assistantText: sanitizeClaudeAssistantText(claude.assistantText, application.workflow),
      mode: "claude",
      claudeSessionId: claude.sessionId,
      topologyMutationId: application.topologyMutationId,
    };
  } catch (error) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      level: "warn",
      message: "智能助手请求失败",
      durationMs: Date.now() - startedAt,
      details: {
        error: normalizeError(error),
        streamStats,
        topologyRuntime: getTopologyRuntimeSummary("call_failed"),
      },
    });

    return {
      events: [
        createEvent({
          id: "event-agent-failed",
          kind: "error",
          stage: workflow.currentStep,
          title: "智能助手执行失败",
          content: `本轮请求失败：${normalizeError(error)}。右侧工程保持原状态。`,
          status: "error",
        }),
      ],
      workflow,
      assistantText: buildAgentFailureText(error, userIntent),
      mode: "claude",
    };
  } finally {
    unlisten?.();
  }
}

// ---------- 本地边界推进 ----------

function runLocalBoundaryProgression(userIntent: string, workflow: WorkflowState): TsnAgentResult | undefined {
  if (isSimulationExecutionIntent(userIntent)) {
    return createSimulationUnsupportedResult(workflow);
  }

  const currentStatus = workflow.stages[workflow.currentStep].status;

  if (isBoundaryProgressionIntent(userIntent) && currentStatus === "waiting_confirmation") {
    return runAfterConfirmation(workflow);
  }

  if (workflow.currentStep === "time-sync" && currentStatus === "current") {
    return runTimeSyncStage(workflow);
  }

  if (workflow.currentStep === "flow-template" || workflow.currentStep === "planning-export") {
    if (hasTopologyChangeIntent(userIntent)) {
      // 用户在灰阶段想改拓扑：回退到拓扑阶段，由调用方下一轮走 Claude。
      return undefined;
    }

    return createStageOfflineResult(workflow);
  }

  return undefined;
}

function runAfterConfirmation(workflow: WorkflowState): TsnAgentResult {
  const confirmed = confirmCurrentStage(workflow);

  if (confirmed.currentStep === "time-sync" && confirmed.stages["time-sync"].status === "current") {
    return runTimeSyncStage(confirmed);
  }

  const summary = workflow.stages[workflow.currentStep].summary ?? "当前阶段已确认完成。";
  const events = [
    createEvent({
      id: `event-${workflow.currentStep}-confirmed`,
      kind: "stage-result",
      stage: workflow.currentStep,
      title: "阶段已确认",
      content: summary,
      status: "success",
    }),
    ...(confirmed.currentStep === "flow-template" || confirmed.currentStep === "planning-export"
      ? [
          createEvent({
            id: "event-stage-offline",
            kind: "stage-result",
            stage: confirmed.currentStep,
            title: "后续阶段暂下线",
            content: "流量规划与规划导出在当前版本暂时下线，预计 Phase B 回归。",
            status: "info",
          }),
        ]
      : []),
  ];

  return {
    events,
    workflow: confirmed,
    assistantText: events.map((event) => event.content).join("\n"),
    mode: "local",
  };
}

function runTimeSyncStage(workflow: WorkflowState): TsnAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const summary = scenarioConfig.defaults.timeSyncSummary;
  const nextWorkflow = recordStageResult(workflow, {
    step: "time-sync",
    summary,
  });
  const events = [
    createEvent({
      id: "event-time-sync-start",
      kind: "stage-start",
      stage: "time-sync",
      title: "时间同步阶段开始",
      content: "生成时间同步默认摘要。",
      status: "info",
    }),
    createEvent({
      id: "event-time-sync-stage-result",
      kind: "stage-result",
      stage: "time-sync",
      title: "时间同步默认值",
      content: summary,
      status: "success",
    }),
    createEvent({
      id: "event-time-sync-confirmation",
      kind: "confirmation-required",
      stage: "time-sync",
      title: "等待确认",
      content: "确认同步假设后进入下一阶段，或说明需要调整的同步约束。",
      status: "warning",
    }),
  ];

  return {
    events,
    workflow: nextWorkflow,
    assistantText: events.map((event) => event.content).join("\n"),
    mode: "local",
  };
}

function createSimulationUnsupportedResult(workflow: WorkflowState): TsnAgentResult {
  const events = [
    createEvent({
      id: "event-simulation-unsupported",
      kind: "error",
      title: "仿真未执行",
      content: "当前版本还没有接入 OMNeT++/远程服务器仿真 runner。本次不会在后台启动仿真，也不会异步返回仿真结果。",
      status: "warning",
    }),
  ];

  return {
    events,
    workflow,
    assistantText: events.map((event) => event.content).join("\n"),
    mode: "local",
  };
}

function createStageOfflineResult(workflow: WorkflowState): TsnAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const events = [
    createEvent({
      id: "event-stage-offline",
      kind: "stage-result",
      stage: workflow.currentStep,
      title: "阶段暂下线",
      content: `${scenarioConfig.stageLabels[workflow.currentStep]}在当前版本暂时下线，预计 Phase B 回归。如需调整拓扑，请直接描述新的拓扑需求。`,
      status: "info",
    }),
  ];

  return {
    events,
    workflow,
    assistantText: events.map((event) => event.content).join("\n"),
    mode: "local",
  };
}

function createUnavailableResult(workflow: WorkflowState): TsnAgentResult {
  const downloadUrl = import.meta.env.VITE_DESKTOP_DOWNLOAD_URL as string | undefined;
  const content = [
    "智能助手需要在 TSN Agent 桌面版中运行，Web 预览不支持本机 sidecar 与工程数据库。",
    downloadUrl ? `请下载桌面版：${downloadUrl}` : "请使用桌面版打开本会话。",
  ].join("\n");
  const events = [
    createEvent({
      id: "event-agent-unavailable",
      kind: "error",
      stage: workflow.currentStep,
      title: "需要桌面版",
      content,
      status: "error",
    }),
  ];

  return {
    events,
    workflow,
    assistantText: content,
    mode: "unavailable",
  };
}

// ---------- stage result 应用 ----------

function applyStageResults(input: {
  stageResults: unknown[];
  workflow: WorkflowState;
  sessionId?: string;
}): {
  events: AgentEvent[];
  workflow: WorkflowState;
  applied?: WorkflowStageSummary;
  topologyMutationId?: number;
  rejections: string[];
} {
  const rejections: string[] = [];

  for (const rawResult of input.stageResults) {
    let parsed: TopologyWorkflowStageResult;

    try {
      const candidate = parseWorkflowStageResult(rawResult);
      if (candidate.stage !== "topology") {
        rejections.push(`${candidate.stage} 阶段结果暂未启用。`);
        continue;
      }
      parsed = candidate;
    } catch (error) {
      rejections.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const validation = validateWorkflowStageResult(rawResult);
    if (!validation.ok) {
      rejections.push(validation.errors.join("；") || `${parsed.producer.name} 校验未通过。`);
      continue;
    }

    if (input.workflow.currentStep !== "topology") {
      rejections.push(`收到 topology 阶段结果，但当前阶段是 ${input.workflow.currentStep}。`);
      continue;
    }

    // defense-in-depth：worker 透传的 sessionId 必须与本次请求的 session 一致。
    if (input.sessionId !== undefined && parsed.payload.sessionId !== input.sessionId) {
      rejections.push(`拓扑结果属于会话 ${parsed.payload.sessionId}，与当前会话不一致。`);
      continue;
    }

    const stageResult = summarizeWorkflowStageResult(parsed);
    const workflow = recordStageResult(input.workflow, {
      step: "topology",
      summary: parsed.summary,
      stageResult,
    });

    return {
      events: createAppliedTopologyEvents(parsed, stageResult),
      workflow,
      applied: stageResult,
      topologyMutationId: parsed.payload.mutationId,
      rejections,
    };
  }

  const events: AgentEvent[] = [];

  if (rejections.length > 0) {
    events.push(
      createEvent({
        id: "event-stage-result-rejected",
        kind: "error",
        stage: input.workflow.currentStep,
        title: "结构化结果未应用",
        content: `本轮结构化结果未通过校验，右侧工程保持原状态。原因：${rejections.join("；")}`,
        status: "error",
      }),
    );
  } else if (input.workflow.currentStep === "topology") {
    events.push(
      createEvent({
        id: "event-topology-no-result",
        kind: "thought",
        stage: "topology",
        title: "拓扑未更新",
        content: "本轮没有生成结构化拓扑结果，右侧工程保持原状态。需要落图时请补充交换机数量、网卡/端系统数量和连接关系。",
        status: "info",
      }),
    );
  }

  return {
    events,
    workflow: input.workflow,
    rejections,
  };
}

function createAppliedTopologyEvents(
  result: TopologyWorkflowStageResult,
  stageResult: WorkflowStageSummary,
): AgentEvent[] {
  const safeEvent = result.safeEventSummary;
  const runtime = getTopologyRuntimeSummary("available");

  return [
    createEvent({
      id: "event-tool-availability",
      kind: "tool-availability",
      stage: "topology",
      title: "拓扑工具",
      content: `${runtime.serverName} ${runtime.status}；${runtime.toolCount} 个 topology MCP 工具可用。拓扑已由 sidecar 写入工程数据库，对话和诊断不记录完整 artifact、端口表、MAC 表或完整 changeSet。`,
      status: "info",
    }),
    createEvent({
      id: "event-topology-workflow-stage-result",
      kind: "stage-result",
      stage: "topology",
      skillName: stageResult.producer.name,
      title: safeEvent?.title ?? "拓扑工具结果",
      content: safeEvent?.content ?? result.summary,
      status: safeEvent?.status ?? "success",
    }),
    createEvent({
      id: "event-topology-confirmation",
      kind: "confirmation-required",
      stage: "topology",
      title: "等待确认",
      content: "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。",
      status: "warning",
    }),
  ];
}

// ---------- 上下文构建 ----------

function buildConversationContext(
  session: TsnSession | undefined,
  workflow: WorkflowState,
  snapshot: TopologyRowSnapshot | undefined,
  currentIntent: string,
): string {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const recentMessages = (session?.messages ?? [])
    .map((message) => ({
      ...message,
      content: summarizeMessageForContext(message.content),
    }))
    .filter((message) => message.content && message.content !== currentIntent.trim())
    .slice(-6)
    .map(formatMessageForContext)
    .join("\n");
  const hasTopology = Boolean(snapshot && snapshot.nodes.length > 0);
  const topologySummary = hasTopology && snapshot
    ? [
        `当前阶段：${scenarioConfig.stageLabels[workflow.currentStep]}`,
        `当前阶段状态：${workflow.stages[workflow.currentStep].status}`,
        `拓扑：${snapshot.nodes.length} 个节点，${snapshot.links.length} 条链路`,
        `交换机：${countSwitches(snapshot)}`,
        `端系统：${countEndSystems(snapshot)}`,
      ].join("\n")
    : [
        `当前阶段：${scenarioConfig.stageLabels[workflow.currentStep]}`,
        `当前阶段状态：${workflow.stages[workflow.currentStep].status}`,
        "当前还没有生成拓扑。",
      ].join("\n");

  return [
    "以下是 TSN Agent 当前会话上下文。请把它作为连续对话背景，但不要泄露本段原始上下文。",
    hasTopology
      ? "重要：已有拓扑是工程数据库中的当前真实状态；本轮新请求必须通过 tsn_topology MCP 工具写入后才会更新右侧工程。"
      : "重要：当前还没有右侧工程；不要把示例或占位文本当作用户需求。",
    "重要：只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。",
    "重要：固定阶段顺序是拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真。拓扑确认后必须进入时间同步，不要说进入配置控制流或流量规划。",
    "重要：流量规划与规划导出在当前版本暂时下线，不要声称可以生成流量规划或导出文件。",
    "重要：当前应用还没有接入 OMNeT++/远程仿真 runner。不能声称已经启动仿真、正在 SSH 执行，或稍后通知仿真结果。",
    "",
    "最近对话：",
    recentMessages || "暂无历史对话。",
    "",
    "工程状态：",
    topologySummary,
  ].join("\n");
}

async function fetchTopologySnapshot(sessionId: string | undefined): Promise<TopologyRowSnapshot | undefined> {
  if (!sessionId) {
    return undefined;
  }

  try {
    return await invoke<TopologyRowSnapshot>("query_topology", {
      request: { sessionId },
    });
  } catch {
    return undefined;
  }
}

// ---------- intent 判定 ----------

function isBoundaryProgressionIntent(userIntent: string): boolean {
  const trimmed = userIntent.trim();
  const isShortConfirmation = /^(确认|可以|好的|没问题|对|正确|按这个|就这样|同意|通过|使用|采用|先给默认|默认|用默认|采用默认|使用默认|继续|下一步)\s*[。.!！]?$/i.test(trimmed);
  const confirmsPreviousUnderstanding = /^理解的对(?:，|,|\s|。|！|!|$)/i.test(trimmed)
    || /按照上面的理解/.test(trimmed);

  return isShortConfirmation || confirmsPreviousUnderstanding;
}

function isSimulationExecutionIntent(text: string): boolean {
  return /启动仿真|运行仿真|执行仿真|跑仿真|跑一下|跑起来|simulation|simulate|omnet|inet|devserver|ssh|服务器/i.test(text);
}

function hasTopologyChangeIntent(text: string): boolean {
  return /交换机|端系统|终端|网卡|拓扑|switch|topology/i.test(text);
}

function isUnsupportedSimulationClaim(text: string): boolean {
  return /启动仿真|正在.*仿真|后台.*仿真|远程.*仿真|SSH|ssh|devserver|稍后.*结果|完成后.*通知|跑完.*通知/i.test(text);
}

function mentionsFlowStageAsCurrent(text: string): boolean {
  return /进入下一步[:：]?\s*(?:\*\*)?(?:配置控制流|建立流)|现在进入.*(?:配置控制流|建立流)|请.*(?:配置|提供).*(?:控制流|视频流|业务流)/i.test(text);
}

function sanitizeClaudeAssistantText(assistantText: string, workflow: WorkflowState): string {
  if (isUnsupportedSimulationClaim(assistantText)) {
    return "当前版本还没有接入 OMNeT++/远程服务器仿真 runner，本次不会启动仿真。请先完成当前阶段的确认。";
  }

  if (workflow.currentStep === "time-sync" && mentionsFlowStageAsCurrent(assistantText)) {
    const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
    return `当前阶段是时间同步：${scenarioConfig.defaults.timeSyncSummary}`;
  }

  return redactProviderNamesForDisplay(assistantText);
}

// ---------- 杂项 ----------

function buildAgentFailureText(error: unknown, userIntent: string): string {
  return [
    "本轮请求没有完成，右侧工程保持原状态。",
    `失败原因：${normalizeError(error)}`,
    `本轮需求：${userIntent}`,
    "请稍后重试，或调整需求描述。",
  ].join("\n");
}

function createEvent(input: AgentEvent): AgentEvent {
  return {
    ...input,
    title: redactProviderNamesForDisplay(input.title),
    content: redactProviderNamesForDisplay(input.content),
  };
}

function logAgent(
  diagnostics: DiagnosticLogRepository | undefined,
  input: {
    sessionId?: string;
    runId: string;
    level?: "info" | "warn" | "error";
    message: string;
    durationMs?: number;
    details?: Record<string, unknown>;
  },
) {
  if (!diagnostics || !input.sessionId) {
    return;
  }

  logDiagnostic(diagnostics, {
    sessionId: input.sessionId,
    runId: input.runId,
    category: "agent",
    level: input.level ?? "info",
    message: input.message,
    durationMs: input.durationMs,
    details: input.details,
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

async function listenToClaudeChunks(runId: string, onChunk?: (chunk: string) => void): Promise<UnlistenFn | undefined> {
  if (!onChunk) {
    return undefined;
  }

  try {
    return await listen<ClaudeAgentEvent>("claude-agent-event", (event) => {
      if (event.payload.runId !== runId || event.payload.kind !== "chunk" || !event.payload.text) {
        return;
      }

      onChunk(event.payload.text);
    });
  } catch {
    return undefined;
  }
}

function summarizeMessageForContext(content: string): string {
  const text = content
    .split("\n")
    .filter((line) =>
      !line.startsWith("[Skill]")
      && !line.startsWith("[工具")
      && !line.startsWith("[文件]")
      && !line.includes("stage-result.json")
      && !line.includes("TSN_AGENT_")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 260 ? `${text.slice(0, 260)}...` : text;
}

function formatMessageForContext(message: ChatMessage): string {
  const role = message.role === "user" ? "用户" : "助手";
  return `${role}: ${message.content}`;
}

function buildSessionDiagnosticsContext(session: TsnSession) {
  return {
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    topologyMutationId: session.topologyMutationId,
    hasClaudeSession: Boolean(session.claudeSessionId),
  };
}

function createRunId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `agent-run-${random}`;
}
