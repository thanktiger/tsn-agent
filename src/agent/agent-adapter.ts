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
import { recordStageResult } from "../project/project-state";
import {
  parseStageSkillResult,
  summarizeStageSkillResult,
  validateStageSkillResult,
  type StageSkillResult,
  type StageSkillSummary,
} from "./stage-skill-contract";

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
          ? buildConversationContext(normalizedSession, userIntent, deterministicResult)
          : buildGeneratedProjectContext(deterministicResult),
        stageRunnerInput: buildStageRunnerInput(userIntent, deterministicResult, normalizedSession?.project),
      },
    });
    const stageResultApplication = applyStageResults({
      stageResults: claude.stageResults ?? [],
      fallbackResult: deterministicResult,
      previousSession: normalizedSession,
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
        appliedStageResult: stageResultApplication.applied?.skillName,
        rejectedStageResults: stageResultApplication.rejections.length,
      },
    });

    const assistantText = sanitizeClaudeAssistantText(claude.assistantText, stageResultApplication.result);

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
      },
    });

    return {
      ...deterministicResult,
      assistantText: [
        "本机智能助手暂时不可用，已切换到内置规划器完成当前草案。",
        deterministicResult.assistantText,
      ].join("\n"),
      mode: "fake",
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

function buildConversationContext(session: TsnSession, currentIntent: string, result: FakeAgentResult): string {
  const recentMessages = session.messages
    .filter((message) => message.content.trim() && message.content.trim() !== currentIntent.trim())
    .slice(-10)
    .map(formatMessageForContext)
    .join("\n");
  const projectSummary = session.project
    ? [
        `当前工程：${session.project.name}`,
        `拓扑：${session.project.topology.nodes.length} 个节点，${session.project.topology.links.length} 条链路`,
        `交换机互联：${describeSwitchInterconnect(session.project)}`,
        `流：${session.project.flows.length} 条`,
        `目标仿真：${session.project.simulationHints.inetVersion}`,
      ].join("\n")
    : "当前还没有生成 canonical TSN project。";
  const artifactSummary = session.bundle
    ? session.bundle.artifacts.map((artifact) => `- ${artifact.path}: ${artifact.label ?? artifact.purpose}`).join("\n")
    : "当前还没有导出文件。";

  return [
    "以下是 TSN Agent 当前会话上下文。请把它作为连续对话背景，但不要泄露本段原始上下文。",
    "重要：本轮右侧工程视图已经按“本轮生成结果”落地。你的回复必须以“本轮生成结果”为准，不要沿用历史里冲突的拓扑规模。",
    "重要：只描述当前阶段已经完成或正在等待确认的内容；不要提前宣称后续阶段的控制流、规划器输入或导出文件已经生成。",
    "重要：固定阶段顺序是拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真。拓扑确认后必须进入时间同步，不要说进入配置控制流或流量规划。",
    "重要：当前应用还没有接入 OMNeT++/远程仿真 runner。不能声称已经启动仿真、正在 SSH 执行，或稍后通知仿真结果。",
    "",
    "本轮生成结果：",
    buildGeneratedProjectContext(result),
    "",
    "最近对话：",
    recentMessages || "暂无历史对话。",
    "",
    "工程状态：",
    projectSummary,
    "",
    "已生成文件：",
    artifactSummary,
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

function applyStageResults(input: {
  stageResults: unknown[];
  fallbackResult: FakeAgentResult;
  previousSession?: TsnSession;
}): {
  result: FakeAgentResult;
  applied?: StageSkillSummary;
  rejections: string[];
} {
  const rejections: string[] = [];

  for (const rawResult of input.stageResults) {
    const validation = validateStageSkillResult(rawResult);
    let parsed: StageSkillResult | undefined;

    try {
      parsed = parseStageSkillResult(rawResult);
    } catch (error) {
      rejections.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (!validation.ok) {
      rejections.push(validation.errors.join("；") || `${parsed.skillName} 校验未通过。`);
      continue;
    }

    if (parsed.stage !== input.fallbackResult.workflow.currentStep) {
      rejections.push(`收到 ${parsed.stage} 阶段结果，但当前阶段是 ${input.fallbackResult.workflow.currentStep}。`);
      continue;
    }

    if (parsed.stage !== "topology") {
      if (parsed.stage === "flow-template") {
        const skillResult = summarizeStageSkillResult(parsed);
        const workflow = recordStageResult(input.fallbackResult.workflow, {
          step: "flow-template",
          summary: parsed.summary,
          skillResult,
        });
        const result = {
          ...input.fallbackResult,
          project: parsed.payload.project,
          workflow,
          bundle: undefined,
          events: createAppliedFlowPlanningEvents(parsed, skillResult),
        };

        return {
          result,
          applied: skillResult,
          rejections,
        };
      }

      rejections.push(`${parsed.stage} 阶段 skill 结果暂未启用。`);
      continue;
    }

    const skillResult = summarizeStageSkillResult(parsed);
    const workflow = recordStageResult(input.fallbackResult.workflow, {
      step: "topology",
      summary: parsed.summary,
      skillResult,
    });
    const result = {
      ...input.fallbackResult,
      project: parsed.payload.project,
      workflow,
      bundle: undefined,
      events: createAppliedTopologyEvents(parsed, skillResult),
    };

    return {
      result,
      applied: skillResult,
      rejections,
    };
  }

  return {
    result: markFallbackResult(input.fallbackResult, input.stageResults.length > 0 ? rejections : []),
    rejections,
  };
}

function createAppliedTopologyEvents(result: StageSkillResult & { stage: "topology" }, skillResult: StageSkillSummary): AgentEvent[] {
  const safeEvent = result.safeEventSummary;

  return [
    createEvent({
      id: "event-tool-availability",
      kind: "tool-availability",
      stage: "topology",
      title: "工具权限",
      content: "本轮智能助手已启用 Bash、Edit、Write 工具权限；右侧工程状态只应用通过校验的结构化结果。",
      status: "info",
    }),
    createEvent({
      id: "event-topology-skill-result",
      kind: "skill-result",
      stage: "topology",
      skillName: skillResult.skillName,
      title: safeEvent?.title ?? "拓扑 skill 结果",
      content: safeEvent?.content ?? result.summary,
      status: safeEvent?.status ?? "success",
    }),
    createEvent({
      id: "event-topology-validation",
      kind: "stage-result",
      stage: "topology",
      skillName: skillResult.skillName,
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

function createAppliedFlowPlanningEvents(result: StageSkillResult & { stage: "flow-template" }, skillResult: StageSkillSummary): AgentEvent[] {
  const safeEvent = result.safeEventSummary;

  return [
    createEvent({
      id: "event-tool-availability",
      kind: "tool-availability",
      stage: "flow-template",
      title: "工具权限",
      content: "本轮智能助手已启用 Bash、Edit、Write 工具权限；右侧工程状态只应用通过校验的结构化结果。",
      status: "info",
    }),
    createEvent({
      id: "event-flow-planning-skill-result",
      kind: "skill-result",
      stage: "flow-template",
      skillName: skillResult.skillName,
      title: safeEvent?.title ?? "流量规划 skill 结果",
      content: safeEvent?.content ?? result.summary,
      status: safeEvent?.status ?? "success",
    }),
    createEvent({
      id: "event-flow-planning-validation",
      kind: "stage-result",
      stage: "flow-template",
      skillName: skillResult.skillName,
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

function markFallbackResult(result: FakeAgentResult, rejections: string[]): FakeAgentResult {
  const events = result.events.map((event) => {
    if (event.kind !== "tool-availability" && event.kind !== "skill-result") {
      return event;
    }

    const suffix = event.kind === "tool-availability"
      ? "当前工程状态来自本地 fallback。"
      : "本轮未收到可应用的结构化 skill 结果，已使用本地 fallback 生成。";

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
          content: `本轮 skill 结果未通过校验，已使用本地 fallback。原因：${rejections.join("；")}`,
          status: "error",
        }),
      ]
    : [];

  return {
    ...result,
    events: [...events, ...rejectionEvents],
  };
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
  if (!/^(确认|可以|好的|没问题|按这个|就这样|同意|通过|使用|采用|先给默认|默认|用默认|采用默认|使用默认|继续|下一步)\s*[。.!！]?$/i.test(userIntent.trim())) {
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
  if (isAerospaceRedundantProject(project)) {
    return "箭载双冗余主干";
  }

  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const switchLinkCount = project.topology.links.filter((link) =>
    link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
  ).length;

  return switchCount > 2 && switchLinkCount >= switchCount ? "环形互联" : "线型互联";
}

function inferTopologyIntentFromProject(project: CanonicalTsnProjectV0): TopologyIntent {
  if (isAerospaceRedundantProject(project)) {
    return {
      switchCount: 4,
      endSystemsPerSwitch: 0,
      switchInterconnect: "line",
      topologyTemplate: "aerospace-redundant",
      endSystemCount: 7,
    };
  }

  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length || 1;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;

  return {
    switchCount,
    endSystemsPerSwitch: Math.max(1, Math.round(endSystemCount / switchCount)),
    switchInterconnect: describeSwitchInterconnect(project) === "环形互联" ? "ring" : "line",
  };
}

function isAerospaceRedundantProject(project: CanonicalTsnProjectV0): boolean {
  const nodeIds = new Set(project.topology.nodes.map((node) => node.id));

  return project.id === "project-aerospace-redundant"
    || ["nic1", "nic2", "nic3", "nic4", "nic5", "nic6", "nic7", "sw1", "sw2", "sw3", "sw4"]
      .every((nodeId) => nodeIds.has(nodeId));
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
