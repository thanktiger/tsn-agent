import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { logDiagnostic } from "../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { runFakeTsnAgent, type AgentEvent, type FakeAgentResult } from "./fake-agent";
import type { ChatMessage, TsnSession } from "../sessions/session-repository";
import { getScenarioConfig } from "../domain/scenario-config";
import type { CanonicalTsnProjectV0, TopologyIntent } from "../domain/canonical";
import { repairSessionTopologyFromMessages } from "../sessions/session-topology-repair";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { normalizeWorkflowState, recordStageResult } from "../project/project-state";
import { normalizePlannerRunState } from "../planner/planner-contract";
import { getTopologyRuntimeSummary } from "../topology/topology-service";
import {
  parseWorkflowStageResult,
  summarizeWorkflowStageResult,
  validateWorkflowStageResult,
  type WorkflowStageResult,
  type WorkflowStageSummary,
} from "./workflow-stage-result";

export interface TsnAgentResult extends FakeAgentResult {
  mode: "claude" | "fake";
  claudeSessionId?: string;
}

export interface TsnAgentRequest {
  userIntent: string;
  session?: TsnSession;
  runId?: string;
  onChunk?: (chunk: string) => void;
  diagnostics?: DiagnosticLogRepository;
}

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

export async function runTsnAgent(requestOrIntent: TsnAgentRequest | string): Promise<TsnAgentResult> {
  const request = typeof requestOrIntent === "string" ? { userIntent: requestOrIntent } : requestOrIntent;
  const { userIntent } = request;
  const normalizedSession = normalizeSessionForDeterministicRun(request.session);
  const deterministicResult = runFakeTsnAgent(userIntent, normalizedSession?.project, normalizedSession?.workflow);
  const preserveResult = createPreservedAgentResult(userIntent, deterministicResult, normalizedSession);
  const runId = request.runId ?? createRunId();
  const sessionId = request.session?.id;
  const startedAt = Date.now();
  const streamStats = {
    chunkCount: 0,
    totalChars: 0,
    firstChunkAtMs: undefined as number | undefined,
    lastPreview: "",
  };

  logAgent(request.diagnostics, {
    sessionId,
    runId,
    message: "Agent 请求开始",
    details: {
      mode: isTauriRuntime() && import.meta.env.VITE_TSN_AGENT_MODE !== "fake" ? "claude" : "fake",
      hasResumeSession: Boolean(request.session?.claudeSessionId),
      inputChars: userIntent.length,
      topologyRuntime: getTopologyRuntimeSummary("unknown"),
      context: request.session ? buildSessionDiagnosticsContext(request.session) : undefined,
    },
  });

  if (!isTauriRuntime() || import.meta.env.VITE_TSN_AGENT_MODE === "fake") {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Agent 使用 fake 模式完成",
      durationMs: Date.now() - startedAt,
      details: {
        artifactCount: deterministicResult.bundle?.artifacts.length ?? 0,
        projectName: deterministicResult.project.name,
        topologyRuntime: getTopologyRuntimeSummary("available"),
      },
    });

    return {
      ...deterministicResult,
      mode: "fake",
    };
  }

  if (shouldUseDeterministicOnly(userIntent, deterministicResult)) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Agent 使用本地确定性边界回复",
      durationMs: Date.now() - startedAt,
      details: {
        workflowStep: deterministicResult.workflow.currentStep,
        workflowStatus: deterministicResult.workflow.stages[deterministicResult.workflow.currentStep].status,
        artifactCount: deterministicResult.bundle?.artifacts.length ?? 0,
        topologyRuntime: getTopologyRuntimeSummary("available"),
      },
    });

    return {
      ...deterministicResult,
      mode: "fake",
    };
  }

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
        appSessionId: normalizedSession?.id,
        resumeSessionId: normalizedSession?.claudeSessionId,
        conversationContext: normalizedSession
          ? buildConversationContext(normalizedSession, userIntent)
          : buildEmptySessionContext(deterministicResult),
        stageRunnerInput: buildStageRunnerInput(userIntent, deterministicResult, normalizedSession?.project),
      },
    });
    const stageResultApplication = applyStageResults({
      stageResults: claude.stageResults ?? [],
      fallbackResult: deterministicResult,
      previousSession: normalizedSession,
      userIntent,
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
        appliedStageResult: stageResultApplication.applied
          ? `${stageResultApplication.applied.producer.type}:${stageResultApplication.applied.producer.name}`
          : undefined,
        rejectedStageResults: stageResultApplication.rejections.length,
        auditPath: claude.auditPath,
        topologyRuntime: getTopologyRuntimeSummary(stageResultApplication.rejections.length > 0 ? "call_failed" : "available"),
      },
    });

    const assistantText = stageResultApplication.result.shouldApplyProject === false
      ? stageResultApplication.result.assistantText
      : sanitizeClaudeAssistantText(claude.assistantText, stageResultApplication.result);

    return {
      ...stageResultApplication.result,
      assistantText,
      mode: "claude",
      claudeSessionId: claude.sessionId,
    };
  } catch (error) {
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      level: "warn",
      message: "智能助手请求失败，已回退本地模式",
      durationMs: Date.now() - startedAt,
      details: {
        error: normalizeError(error),
        streamStats,
        topologyRuntime: getTopologyRuntimeSummary("call_failed"),
      },
    });

    return {
      ...preserveResult,
      assistantText: buildAgentFailureText(error, userIntent),
      mode: "claude",
    };
  } finally {
    unlisten?.();
  }
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

function buildConversationContext(session: TsnSession, currentIntent: string): string {
  const recentMessages = session.messages
    .map((message) => ({
      ...message,
      content: summarizeMessageForContext(message.content),
    }))
    .filter((message) => message.content && message.content !== currentIntent.trim())
    .slice(-6)
    .map(formatMessageForContext)
    .join("\n");
  const workflow = normalizeWorkflowState(session.workflow);
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const projectSummary = session.project
    ? [
        `当前工程：${session.project.name}`,
        `当前阶段：${scenarioConfig.stageLabels[workflow.currentStep]}`,
        `当前阶段状态：${workflow.stages[workflow.currentStep].status}`,
        `拓扑：${session.project.topology.nodes.length} 个节点，${session.project.topology.links.length} 条链路`,
        `交换机：${session.project.topology.nodes.filter((node) => node.type === "switch").length}`,
        `端系统：${countEndSystems(session.project)}`,
        `交换机互联：${describeSwitchInterconnect(session.project)}`,
        `流：${session.project.flows.length} 条`,
        `流摘要：${summarizeFlowsForContext(session.project)}`,
        `目标仿真：${session.project.simulationHints.inetVersion}`,
      ].join("\n")
    : "当前还没有生成 canonical TSN project。";
  const artifactSummary = session.bundle
    ? session.bundle.artifacts.slice(0, 8).map((artifact) => `- ${artifact.path}: ${artifact.label ?? artifact.purpose}`).join("\n")
    : "当前还没有导出文件。";
  const plannerRun = normalizePlannerRunState(session.plannerRun);
  const plannerSummary = [
    `规划任务状态：${plannerRun.status}`,
    `规划任务 ID：${plannerRun.planId ?? "无"}`,
    plannerRun.requestSummary
      ? `规划请求摘要：${plannerRun.requestSummary.nodeCount} 节点，${plannerRun.requestSummary.linkCount} 链路，${plannerRun.requestSummary.flowCount} 流`
      : "规划请求摘要：无",
    plannerRun.resultSummary
      ? `规划结果摘要：${plannerRun.resultSummary.linkCount} 链路，${plannerRun.resultSummary.gclEntryCount} 条 GCL`
      : "规划结果摘要：无",
    plannerRun.errorMessage ? `规划错误摘要：${plannerRun.errorMessage}` : "规划错误摘要：无",
  ].join("\n");

  return [
    "以下是 TSN Agent 当前会话上下文。请把它作为连续对话背景，但不要泄露本段原始上下文。",
    session.project
      ? "重要：已有工程状态是右侧当前真实状态；本轮新请求仍必须通过结构化结果写入后才会更新右侧工程。"
      : "重要：当前还没有右侧工程；不要把示例或占位文本当作用户需求。",
    "重要：只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。",
    "重要：固定阶段顺序是拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真。拓扑确认后必须进入时间同步，不要说进入配置控制流或流量规划。",
    "重要：当前应用还没有接入 OMNeT++/远程仿真 runner。不能声称已经启动仿真、正在 SSH 执行，或稍后通知仿真结果。",
    "重要：planner/flow_plan_1.json 是规划器请求输入；只有 plannerRun.status=succeeded 且存在真实 resultSnapshot 时，才能说明已有规划输出、GCL 或 planner-gcl artifact。",
    "",
    "最近对话：",
    recentMessages || "暂无历史对话。",
    "",
    "工程状态：",
    projectSummary,
    "",
    "已生成文件：",
    artifactSummary,
    "",
    "真实规划任务：",
    plannerSummary,
  ].join("\n");
}

function buildEmptySessionContext(result: FakeAgentResult): string {
  const scenarioConfig = getScenarioConfig(result.workflow.scenarioConfigId);

  return [
    "以下是 TSN Agent 当前会话上下文。请把它作为连续对话背景，但不要泄露本段原始上下文。",
    "重要：当前还没有右侧工程；不要把示例或占位文本当作用户需求。",
    "重要：如果当前阶段需要生成或修改拓扑/流量规划，必须返回对应阶段的结构化结果；只返回文字不会更新右侧工程。",
    "重要：只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。",
    "",
    "工程状态：",
    `当前阶段：${scenarioConfig.stageLabels[result.workflow.currentStep]}`,
    `当前阶段状态：${result.workflow.stages[result.workflow.currentStep].status}`,
    "当前还没有生成 canonical TSN project。",
  ].join("\n");
}

function buildGeneratedProjectContext(result: FakeAgentResult): string {
  const scenarioConfig = getScenarioConfig(result.workflow.scenarioConfigId);
  const switchCount = result.project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = result.project.topology.nodes.filter((node) => node.type === "endSystem").length;
  const links = result.project.topology.links.length;
  const flow = result.project.flows[0];
  const flowSummary = result.project.flows.length > 0
    ? result.project.flows.map((candidate) =>
        `${candidate.name}: ${candidate.source.nodeId} -> ${candidate.destination.nodeId}，周期 ${candidate.periodUs}us，帧长 ${candidate.frameSizeBytes}B，PCP ${candidate.pcp}`
      ).join("；")
    : "暂无";
  const switchInterconnect = describeSwitchInterconnect(result.project);

  return [
    `当前阶段：${scenarioConfig.stageLabels[result.workflow.currentStep]}`,
    `当前阶段状态：${result.workflow.stages[result.workflow.currentStep].status}`,
    `交换机：${switchCount}`,
    `端系统：${endSystemCount}`,
    `链路：${links}`,
    `交换机互联：${switchInterconnect}`,
    `流：${flow ? `${result.project.flows.length} 条` : "尚未生成"}`,
    `流详情：${flowSummary}`,
    flow ? `默认控制流：${flow.source.nodeId} -> ${flow.destination.nodeId}，周期 ${flow.periodUs}us，帧长 ${flow.frameSizeBytes}B，PCP ${flow.pcp}` : "默认控制流：暂无",
  ].join("\n");
}

function buildStageRunnerInput(
  userIntent: string,
  result: FakeAgentResult,
  previousProject?: CanonicalTsnProjectV0,
) {
  const stage = result.workflow.currentStep;

  return {
    userIntent,
    stage,
    scenarioConfigId: result.workflow.scenarioConfigId,
    fallbackIntent: previousProject ? inferTopologyIntentFromProject(previousProject) : undefined,
    project: stage === "flow-template" ? previousProject : undefined,
  };
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

function summarizeFlowsForContext(project: CanonicalTsnProjectV0): string {
  if (project.flows.length === 0) {
    return "暂无";
  }

  return project.flows
    .slice(0, 5)
    .map((flow) => `${flow.name}: ${flow.source.nodeId} -> ${flow.destination.nodeId}，周期 ${flow.periodUs}us，PCP ${flow.pcp}`)
    .join("；");
}

function applyStageResults(input: {
  stageResults: unknown[];
  fallbackResult: FakeAgentResult;
  previousSession?: TsnSession;
  userIntent: string;
}): {
  result: FakeAgentResult;
  applied?: WorkflowStageSummary;
  rejections: string[];
} {
  const rejections: string[] = [];

  for (const rawResult of input.stageResults) {
    const validation = validateWorkflowStageResult(rawResult);
    let parsed: WorkflowStageResult | undefined;

    try {
      parsed = parseWorkflowStageResult(rawResult);
    } catch (error) {
      rejections.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (!validation.ok) {
      rejections.push(validation.errors.join("；") || `${parsed.producer.name} 校验未通过。`);
      continue;
    }

    if (parsed.stage !== input.fallbackResult.workflow.currentStep) {
      rejections.push(`收到 ${parsed.stage} 阶段结果，但当前阶段是 ${input.fallbackResult.workflow.currentStep}。`);
      continue;
    }

    if (parsed.stage !== "topology") {
      if (parsed.stage === "flow-template") {
        const stageResult = summarizeWorkflowStageResult(parsed);
        const workflow = recordStageResult(input.fallbackResult.workflow, {
          step: "flow-template",
          summary: parsed.summary,
          stageResult,
        });
        const result = {
          ...input.fallbackResult,
          project: parsed.payload.project,
          workflow,
          bundle: undefined,
          events: createAppliedFlowPlanningEvents(parsed, stageResult),
        };

        return {
          result,
          applied: stageResult,
          rejections,
        };
      }

      rejections.push(`${parsed.stage} 阶段结果暂未启用。`);
      continue;
    }

    const intentRejection = rejectTopologyResultForCurrentIntent(
      parsed,
      input.userIntent,
      input.previousSession?.project,
      input.fallbackResult.project,
    );

    if (intentRejection) {
      rejections.push(intentRejection);
      continue;
    }

    const stageResult = summarizeWorkflowStageResult(parsed);
    const workflow = recordStageResult(input.fallbackResult.workflow, {
      step: "topology",
      summary: parsed.summary,
      stageResult,
    });
    const result = {
      ...input.fallbackResult,
      project: parsed.payload.project,
      workflow,
      bundle: undefined,
      events: createAppliedTopologyEvents(parsed, stageResult),
    };

    return {
      result,
      applied: stageResult,
      rejections,
    };
  }

  if (isTopologyRequestWithoutExistingProject(input.fallbackResult, input.previousSession)) {
    return {
      result: markFallbackResult(input.fallbackResult, input.previousSession, ["未收到结构化拓扑结果。"]),
      rejections: ["未收到结构化拓扑结果。"],
    };
  }

  return {
    result: markFallbackResult(input.fallbackResult, input.previousSession, input.stageResults.length > 0 ? rejections : []),
    rejections,
  };
}

function createAppliedTopologyEvents(result: WorkflowStageResult & { stage: "topology" }, stageResult: WorkflowStageSummary): AgentEvent[] {
  const safeEvent = result.safeEventSummary;
  const runtime = getTopologyRuntimeSummary("available");

  return [
    createEvent({
      id: "event-tool-availability",
      kind: "tool-availability",
      stage: "topology",
      title: "拓扑工具",
      content: `${runtime.serverName} ${runtime.status}；${runtime.toolCount} 个 topology MCP 工具可用。右侧工程状态只应用通过校验的结构化结果，对话和诊断不记录完整 artifact、端口表、MAC 表或完整 changeSet。`,
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
      id: "event-topology-validation",
      kind: "stage-result",
      stage: "topology",
      skillName: stageResult.producer.name,
      title: "拓扑校验通过",
      content: result.summary,
      status: "success",
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

function createAppliedFlowPlanningEvents(result: WorkflowStageResult & { stage: "flow-template" }, stageResult: WorkflowStageSummary): AgentEvent[] {
  const safeEvent = result.safeEventSummary;
  const runtime = getTopologyRuntimeSummary("available");

  return [
    createEvent({
      id: "event-tool-availability",
      kind: "tool-availability",
      stage: "flow-template",
      title: "拓扑工具",
      content: `${runtime.serverName} ${runtime.status}；拓扑工具保持结构化边界，本阶段只应用通过校验的流量规划结构化结果。`,
      status: "info",
    }),
    createEvent({
      id: "event-flow-planning-workflow-stage-result",
      kind: "stage-result",
      stage: "flow-template",
      skillName: stageResult.producer.name,
      title: safeEvent?.title ?? "流量规划阶段结果",
      content: safeEvent?.content ?? result.summary,
      status: safeEvent?.status ?? "success",
    }),
    createEvent({
      id: "event-flow-planning-validation",
      kind: "stage-result",
      stage: "flow-template",
      skillName: stageResult.producer.name,
      title: "流量规划校验通过",
      content: result.summary,
      status: "success",
    }),
    createEvent({
      id: "event-flow-planning-confirmation",
      kind: "confirmation-required",
      stage: "flow-template",
      title: "等待确认",
      content: "确认流量规划后生成仿真输入和导出清单，或继续描述需要新增、删除或调整的流。",
      status: "warning",
    }),
  ];
}

function markFallbackResult(result: FakeAgentResult, previousSession: TsnSession | undefined, rejections: string[]): FakeAgentResult {
  if (result.workflow.currentStep !== "topology") {
    const events = result.events.map((event) => {
      if (event.kind !== "tool-availability" && event.kind !== "stage-result") {
        return event;
      }

      const suffix = event.kind === "tool-availability"
        ? "当前工程状态来自本地 fallback。"
        : "本轮未收到可应用的结构化结果，已使用本地 fallback 生成。";

      return {
        ...event,
        title: event.kind === "tool-availability" ? "本地 fallback" : event.title,
        content: `${event.content}${event.content.endsWith("。") ? "" : "。"}${suffix}`,
        status: event.status === "error" ? event.status : "warning",
      } satisfies AgentEvent;
    });
    const rejectionEvents = rejections.length > 0
      ? [
          createEvent({
            id: "event-stage-result-rejected",
            kind: "error",
            stage: result.workflow.currentStep,
            title: "结构化结果未应用",
            content: `本轮结构化结果未通过校验，已使用本地 fallback。原因：${rejections.join("；")}`,
            status: "error",
          }),
        ]
      : [];

    return {
      ...result,
      events: [...events, ...rejectionEvents],
    };
  }

  const preservedResult = createPreservedAgentResult("", result, previousSession);
  const rejectionEvents = rejections.length > 0
    ? [
        createEvent({
          id: "event-stage-result-rejected",
          kind: "error",
          stage: result.workflow.currentStep,
          title: "结构化结果未应用",
          content: `本轮结构化结果未通过校验，已保留当前工程状态。原因：${rejections.join("；")}`,
          status: "error",
        }),
      ]
    : [];

  return {
    ...preservedResult,
    assistantText: buildTopologyFailureText(rejections),
    events: [...preservedResult.events, ...rejectionEvents],
  };
}

function createPreservedAgentResult(
  userIntent: string,
  deterministicResult: FakeAgentResult,
  previousSession?: TsnSession,
): FakeAgentResult {
  if (!previousSession?.project) {
    const events = [
      createEvent({
        id: "event-topology-no-result",
        kind: "error",
        stage: deterministicResult.workflow.currentStep,
        title: "拓扑未更新",
        content: "本轮没有生成可应用的拓扑结果，右侧工程暂不落图。请补充交换机数量、网卡/端系统数量、连接关系，或按错误提示修改后重试。",
        status: "error",
      }),
    ] satisfies AgentEvent[];

    return {
      ...deterministicResult,
      bundle: undefined,
      events,
      assistantText: buildTopologyFailureText([]),
      shouldApplyProject: false,
    };
  }

  const events = [
    createEvent({
      id: "event-project-preserved",
      kind: "error",
      stage: deterministicResult.workflow.currentStep,
      title: "工程已保留",
      content: "本轮没有生成可应用的结构化结果，右侧工程保持上一版，不会用本地默认拓扑覆盖。",
      status: "warning",
    }),
  ] satisfies AgentEvent[];

  return {
    ...deterministicResult,
    project: previousSession.project,
    bundle: previousSession.bundle,
    workflow: previousSession.workflow,
    events,
    assistantText: userIntent ? buildTopologyFailureText([]) : "",
    shouldApplyProject: false,
  };
}

function buildAgentFailureText(error: unknown, userIntent: string): string {
  return buildTopologyFailureText([
    `智能助手执行失败：${normalizeError(error)}`,
    `本轮需求：${userIntent}`,
  ]);
}

function buildTopologyFailureText(reasons: string[]): string {
  const reasonText = reasons.length > 0
    ? `\n失败原因：${reasons.join("；")}`
    : "";

  return [
    "本轮拓扑没有更新，因为没有拿到可应用的结构化结果。",
    "右侧工程已保持原状态，不会自动 fallback 到默认拓扑。",
    `${reasonText}`,
    "请检查或补充：交换机数量、网卡/端系统数量、每个网卡连接到哪台交换机、双归属网卡是否使用两个不同端口。",
  ].filter((line) => line.trim()).join("\n");
}

function createEvent(input: AgentEvent): AgentEvent {
  return {
    ...input,
    title: redactProviderNamesForDisplay(input.title),
    content: redactProviderNamesForDisplay(input.content),
  };
}

function shouldUseDeterministicOnly(userIntent: string, result: FakeAgentResult): boolean {
  return isSimulationExecutionIntent(userIntent) || isBoundaryProgressionIntent(userIntent, result);
}

function isBoundaryProgressionIntent(userIntent: string, result: FakeAgentResult): boolean {
  const trimmed = userIntent.trim();
  const isShortConfirmation = /^(确认|可以|好的|没问题|对|正确|按这个|就这样|同意|通过|使用|采用|先给默认|默认|用默认|采用默认|使用默认|继续|下一步)\s*[。.!！]?$/i.test(trimmed);
  const confirmsPreviousUnderstanding = /^理解的对(?:，|,|\s|。|！|!|$)/i.test(trimmed)
    || /按照上面的理解/.test(trimmed);

  if (!isShortConfirmation && !confirmsPreviousUnderstanding) {
    return false;
  }

  return result.workflow.stages[result.workflow.currentStep].status === "waiting_confirmation"
    || result.workflow.stages[result.workflow.currentStep].status === "confirmed";
}

function sanitizeClaudeAssistantText(assistantText: string, result: FakeAgentResult): string {
  if (isUnsupportedSimulationClaim(assistantText)) {
    return result.assistantText;
  }

  if (result.workflow.currentStep === "time-sync" && mentionsFlowStageAsCurrent(assistantText)) {
    return result.assistantText;
  }

  return redactProviderNamesForDisplay(assistantText);
}

function isSimulationExecutionIntent(text: string): boolean {
  return /启动仿真|运行仿真|执行仿真|跑仿真|跑一下|跑起来|simulation|simulate|omnet|inet|devserver|ssh|服务器/i.test(text);
}

function isUnsupportedSimulationClaim(text: string): boolean {
  return /启动仿真|正在.*仿真|后台.*仿真|远程.*仿真|SSH|ssh|devserver|稍后.*结果|完成后.*通知|跑完.*通知/i.test(text);
}

function mentionsFlowStageAsCurrent(text: string): boolean {
  return /进入下一步[:：]?\s*(?:\*\*)?(?:配置控制流|建立流)|现在进入.*(?:配置控制流|建立流)|请.*(?:配置|提供).*(?:控制流|视频流|业务流)/i.test(text);
}

function describeSwitchInterconnect(project: CanonicalTsnProjectV0): string {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const switchLinkCount = project.topology.links.filter((link) =>
    link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
  ).length;

  return switchCount > 2 && switchLinkCount >= switchCount ? "环形互联" : "线型互联";
}

function inferTopologyIntentFromProject(project: CanonicalTsnProjectV0): TopologyIntent {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length || 1;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;

  return {
    switchCount,
    endSystemsPerSwitch: Math.max(1, Math.round(endSystemCount / switchCount)),
    switchInterconnect: describeSwitchInterconnect(project) === "环形互联" ? "ring" : "line",
  };
}

function rejectTopologyResultForCurrentIntent(
  result: WorkflowStageResult & { stage: "topology" },
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  fallbackProject: CanonicalTsnProjectV0,
): string | undefined {
  const previousCount = previousProject ? countEndSystems(previousProject) : undefined;
  const switchCount = previousProject ? countSwitches(previousProject) : countSwitches(fallbackProject);
  const expectedCount = inferRequestedEndSystemCount(userIntent, previousCount, switchCount);

  if (expectedCount === undefined) {
    return undefined;
  }

  const actualCount = countEndSystems(result.payload.project);
  const fallbackCount = countEndSystems(fallbackProject);

  if (actualCount === expectedCount || fallbackCount !== expectedCount) {
    return undefined;
  }

  return `拓扑结构化结果与本轮用户意图不一致：用户请求 ${expectedCount} 个网卡/端系统，但结果返回 ${actualCount} 个。`;
}

function isTopologyRequestWithoutExistingProject(result: FakeAgentResult, previousSession?: TsnSession): boolean {
  return !previousSession?.project && result.workflow.currentStep === "topology";
}

function inferRequestedEndSystemCount(text: string, previousCount?: number, switchCount?: number): number | undefined {
  const values: number[] = [];
  const perSwitchPatterns = [
    /(?:每个|每台|每一台|每个交换机|每台交换机)\s*(?:交换机)?\s*(?:连接|接入|挂载|配置|改成|改为|变为|调整为|设为)?\s*([一二两三四五六七八九十\d]+)\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端|端(?!口))/gi,
    /(?:交换机|sw)\s*(?:各|分别|都)\s*(?:连接|接入|挂载|配置)?\s*([一二两三四五六七八九十\d]+)\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端|端(?!口))/gi,
  ];
  const totalPatterns = [
    /(?:从|由)?\s*[一二两三四五六七八九十\d]+\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端|端(?!口))\s*(?:改成|改为|变为|调整为|设为|改至|到)\s*([一二两三四五六七八九十\d]+)\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端|端(?!口))?/gi,
    /([一二两三四五六七八九十\d]+)\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端|端(?!口))/gi,
  ];

  if (switchCount !== undefined && switchCount > 0) {
    for (const pattern of perSwitchPatterns) {
      for (const match of text.matchAll(pattern)) {
        values.push(parseChineseNumber(match[1]) * switchCount);
      }
    }
  }

  for (const pattern of totalPatterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(parseChineseNumber(match[1]));
    }
  }

  for (const match of text.matchAll(/(?:网卡|端系统|终端)\s*([一二两三四五六七八九十\d]+)/gi)) {
    values.push(parseChineseNumber(match[1]));
  }

  for (const match of text.matchAll(/(?:网卡|端系统|终端)\s*((?:[一二两三四五六七八九十\d]+\s*(?:、|,|，|和|及|与)?\s*)+)/gi)) {
    for (const value of match[1].matchAll(/[一二两三四五六七八九十\d]+/g)) {
      values.push(parseChineseNumber(value[0]));
    }
  }

  const addMatch = text.match(/(?:再加|再添加|新增|添加|加|增加)\s*([一二两三四五六七八九十\d]+)\s*(?:个|块|张|台)?\s*(?:网卡|端系统|终端)/i);
  if (addMatch && previousCount !== undefined) {
    values.push(previousCount + parseChineseNumber(addMatch[1]));
  }

  const validValues = values.filter((value) => Number.isFinite(value) && value > 0);
  return validValues.length > 0 ? Math.max(...validValues) : undefined;
}

function parseChineseNumber(value?: string): number {
  if (!value) {
    return 0;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  return digits[value] ?? 0;
}

function countEndSystems(project: CanonicalTsnProjectV0): number {
  return project.topology.nodes.filter((node) => node.type === "endSystem").length;
}

function countSwitches(project: CanonicalTsnProjectV0): number {
  return project.topology.nodes.filter((node) => node.type === "switch").length;
}

function buildSessionDiagnosticsContext(session: TsnSession) {
  return {
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    hasProject: Boolean(session.project),
    projectName: session.project?.name,
    artifactCount: session.bundle?.artifacts.length ?? 0,
    hasClaudeSession: Boolean(session.claudeSessionId),
  };
}

function formatMessageForContext(message: ChatMessage): string {
  const role = message.role === "user" ? "用户" : "助手";
  return `${role}: ${message.content}`;
}

function normalizeSessionForDeterministicRun(session?: TsnSession): TsnSession | undefined {
  return session ? repairSessionTopologyFromMessages(session) : undefined;
}

function createRunId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `agent-run-${random}`;
}
