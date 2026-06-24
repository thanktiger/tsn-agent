import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { logDiagnostic } from "../diagnostics/app-diagnostics";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { getScenarioConfig, WORKFLOW_STEPS, type WorkflowStep } from "../domain/scenario-config";
import {
  clearPendingStageChange,
  clearPendingUndoNotice,
  confirmCurrentStage,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
  type WorkflowState,
} from "../project/project-state";
import type { ChatMessage, TsnSession } from "../sessions/session-repository";
import { redactSecretsInValue } from "../sessions/session-repository";
import {
  countEndSystems,
  countSwitches,
  type TopologyRowSnapshot,
} from "../sessions/topology-snapshot";
import { getTopologyRuntimeSummary } from "../topology/topology-service";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import type {
  AgentEvent,
  TopologyVerifyResult,
  TsnAgentRequest,
  TsnAgentResult,
} from "./agent-types";
import { enrichToolCall, type RawToolCall, type ToolCallRecord } from "./tool-call-record";
import {
  parseWorkflowStageResult,
  summarizeWorkflowStageResult,
  type TopologyWorkflowStageResult,
  validateWorkflowStageResult,
  type WorkflowStageSummary,
} from "./workflow-stage-result";

export type { AgentEvent, TsnAgentRequest, TsnAgentResult } from "./agent-types";

interface ClaudeAgentResponse {
  assistantText: string;
  sessionId?: string;
  stageResults?: unknown[];
  toolCalls?: unknown[];
  auditPath?: string;
}

interface ClaudeAgentEvent {
  runId: string;
  kind: "chunk" | "session" | "tool_call" | "done" | "error";
  text?: string;
  sessionId?: string;
  /** Plan 2026-06-10-001：客户端无关工具事件，整体透传（脱敏在前端到达时做）。 */
  toolCall?: unknown;
}

/**
 * Plan v3 Phase B-β：Tauri-only adapter。
 *
 * - 非 Tauri（Web）fail-closed：返回「需要桌面版」结果，不再有 fake-agent 兜底。
 * - 拓扑权威在 SQLite P0 表：stage result 只携带 mutationId，adapter 不合成
 *   canonical project；UI 通过 query_topology 拉数据。
 * - 边界推进（确认 / time-sync 默认值）本地完成，不调用 Claude。
 */
export async function runTsnAgent(
  requestOrIntent: TsnAgentRequest | string,
): Promise<TsnAgentResult> {
  const request =
    typeof requestOrIntent === "string" ? { userIntent: requestOrIntent } : requestOrIntent;
  const { userIntent, action } = request;
  // normalizeWorkflowState 会 drop 掉一次性的 pendingUndoNotice（不持久化）。但按钮路径是
  // 在内存里经 setCurrentSession 置位的带外标志，本轮注入还需要它——所以从原始 workflow 取回
  // 再挂上来。它只活在内存、注入后立即清，存储/加载路径仍由 normalize 一律剥离。
  const normalized = normalizeWorkflowState(request.session?.workflow);
  const workflow: WorkflowState = request.session?.workflow?.pendingUndoNotice
    ? { ...normalized, pendingUndoNotice: true }
    : normalized;
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

  // 大模型路径实际使用的意图/工作流。正常等于用户输入；确认回退「带原话」时被替换为
  // 切阶段后的工作流 + 触发回退的原话，从而切完自动执行原始编辑（不用用户重输）。
  let effectiveIntent = userIntent;
  let effectiveWorkflow = workflow;

  // 显式确认动作（确认按钮）：切阶段本身确定性、不走大模型。
  if (action === "confirm-stage") {
    // 拓扑阶段「前进确认」过关闸（只拦前进、不验回退；回退确认带 pendingStageChange）。
    // 代码兜底硬拦：结构不过则不推进；通过则静默推进——结构反馈已由 agent 操作拓扑时经 MCP validate 给出。
    if (sessionId && workflow.currentStep === "topology" && !workflow.pendingStageChange) {
      let verdict: TopologyVerifyResult;
      try {
        verdict = await invoke<TopologyVerifyResult>("verify_topology", { request: { sessionId } });
      } catch (error) {
        // fail-closed：不推进、不冒泡到 App 通用 catch（否则把"继续"卡回输入框）。
        logAgent(request.diagnostics, {
          sessionId,
          runId,
          message: "结构校验调用失败，未推进",
          details: { error: error instanceof Error ? error.message : String(error) },
        });
        return {
          events: [],
          workflow,
          assistantText:
            "结构校验暂时无法运行，右侧工程保持原状态，未推进。请稍后再点「确认并继续」。",
          mode: "local",
        };
      }
      if (!verdict.ok) {
        logAgent(request.diagnostics, {
          sessionId,
          runId,
          message: "结构校验未通过，拦截推进",
          details: { errorCount: verdict.errors.length },
        });
        return {
          events: [],
          workflow,
          assistantText: composeVerificationBlockText(verdict),
          mode: "local",
          verification: verdict,
        };
      }
      // 结构通过：代码兜底放行，静默推进（不再单独弹「结构没问题」）。
    }

    // 时钟同步阶段「前进确认」过关闸：与拓扑分支并列。重算时钟树校验结构（GM 悬空/
    // 未设、端口越界拦推进），通过则静默推进。回退确认（带 pendingStageChange）不验。
    if (sessionId && workflow.currentStep === "time-sync" && !workflow.pendingStageChange) {
      let verdict: TopologyVerifyResult;
      try {
        verdict = await invoke<TopologyVerifyResult>("verify_time_sync", {
          request: { sessionId },
        });
      } catch (error) {
        // fail-closed：不推进、不冒泡到 App 通用 catch。
        logAgent(request.diagnostics, {
          sessionId,
          runId,
          message: "时钟同步校验调用失败，未推进",
          details: { error: error instanceof Error ? error.message : String(error) },
        });
        return {
          events: [],
          workflow,
          assistantText:
            "时钟同步校验暂时无法运行，右侧工程保持原状态，未推进。请稍后再点「确认并继续」。",
          mode: "local",
        };
      }
      if (!verdict.ok) {
        logAgent(request.diagnostics, {
          sessionId,
          runId,
          message: "时钟同步校验未通过，拦截推进",
          details: { errorCount: verdict.errors.length },
        });
        return {
          events: [],
          workflow,
          assistantText: composeTimeSyncBlockText(verdict),
          mode: "local",
          verification: verdict,
        };
      }
    }

    const confirmResult = runConfirmAction(workflow);
    logAgent(request.diagnostics, {
      sessionId,
      runId,
      message: "Agent 使用确认动作推进",
      durationMs: Date.now() - startedAt,
      details: {
        workflowStep: confirmResult.workflow.currentStep,
        workflowStatus: confirmResult.workflow.stages[confirmResult.workflow.currentStep].status,
      },
    });

    // 无「带原话」标记 → 纯确定性确认（推进 / time-sync 自动生成 / 无操作），直接返回（静默推进）。
    // 清掉一次性回退通知：确认推进了阶段，若按钮撤销的标志还挂着，会在后续别的阶段晚一轮
    // 发出「拓扑已撤销，先 inspect」的陈旧通知。这条路径不跑大模型、不注入，标志在此消费即弃。
    if (!confirmResult.carryIntent) {
      return { ...confirmResult, workflow: clearPendingUndoNotice(confirmResult.workflow) };
    }

    // 回退带着原话：切阶段已完成（确定性），下面用原话在切换后的阶段继续走大模型。
    effectiveIntent = confirmResult.carryIntent;
    effectiveWorkflow = confirmResult.workflow;
  }

  // 自由文本一律走大模型判断意图（不再有正则快速路径）。跨阶段意图由大模型调
  // request_stage_change 工具表达，应用层在 applyStageResults 校验后执行。
  const snapshot = await fetchTopologySnapshot(sessionId);
  const streamStats = {
    chunkCount: 0,
    totalChars: 0,
    firstChunkAtMs: undefined as number | undefined,
    lastPreview: "",
    // R13：工具事件诊断只记计数，不进原始 args/result。
    toolCallEvents: 0,
  };
  // 竞态守卫：invoke 返回后仍可能有 IPC 在途的 tool_call 事件在 done 对账的
  // await 间隙送达——run 收尾后丢弃，防止 running 残卡覆盖权威列表。
  let runFinished = false;
  const unlisten = await listenToClaudeEvents(runId, {
    onChunk: (chunk) => {
      streamStats.chunkCount += 1;
      streamStats.totalChars += chunk.length;
      streamStats.firstChunkAtMs ??= Date.now() - startedAt;
      streamStats.lastPreview = chunk.slice(-120);
      request.onChunk?.(chunk);
    },
    onToolCall: request.onToolCall
      ? (payload) => {
          if (runFinished) {
            return;
          }
          const record = toStreamedToolCallRecord(payload);
          if (record) {
            streamStats.toolCallEvents += 1;
            request.onToolCall?.(record);
          }
        }
      : undefined,
  });

  // 一次性消费撤销回退通知：用当前 effectiveWorkflow（含标志）拼上下文后立即清位，
  // 清后的 workflow 流进 applyStageResults 与最终返回，确保不会下一轮重复注入。
  const conversationContext = buildConversationContext(
    request.session,
    effectiveWorkflow,
    snapshot,
    effectiveIntent,
  );
  effectiveWorkflow = clearPendingUndoNotice(effectiveWorkflow);

  try {
    const claude = await invoke<ClaudeAgentResponse>("run_claude_agent", {
      request: {
        prompt: effectiveIntent,
        runId,
        appSessionId: sessionId,
        resumeSessionId: request.session?.claudeSessionId,
        conversationContext,
        stageRunnerInput: {
          userIntent: effectiveIntent,
          stage: effectiveWorkflow.currentStep,
          scenarioConfigId: effectiveWorkflow.scenarioConfigId,
        },
      },
    });
    runFinished = true;
    const application = applyStageResults({
      stageResults: claude.stageResults ?? [],
      workflow: effectiveWorkflow,
      sessionId,
      userIntent: effectiveIntent,
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
        topologyRuntime: getTopologyRuntimeSummary(
          application.rejections.length > 0 ? "call_failed" : "available",
        ),
      },
    });

    return {
      events: application.events,
      workflow: application.workflow,
      assistantText: sanitizeClaudeAssistantText(claude.assistantText, application.workflow),
      mode: "claude",
      claudeSessionId: claude.sessionId,
      topologyMutationId: application.topologyMutationId,
      // done 列表与流式路径走同一脱敏（R8）：避免已脱敏的流式卡片在对账后翻回原文。
      toolCalls: (claude.toolCalls ?? []).map((raw) =>
        enrichToolCall(redactSecretsInValue(raw) as RawToolCall),
      ),
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
          stage: effectiveWorkflow.currentStep,
          title: "智能助手执行失败",
          content: `本轮请求失败：${normalizeError(error)}。右侧工程保持原状态。`,
          status: "error",
        }),
      ],
      workflow: effectiveWorkflow,
      assistantText: buildAgentFailureText(error, effectiveIntent),
      mode: "claude",
    };
  } finally {
    unlisten?.();
  }
}

// ---------- 阶段推进（确定性） ----------

// 结构校验未通过时的对话文案：可修复语气（非"出错了"）+ 问题清单 + 可操作引导 + 口径。
// 结构化 verdict 另随 result.verification 回传，由 chat-pane 区分渲染（U4）。
function composeVerificationBlockText(verdict: TopologyVerifyResult): string {
  // 远端连不上（环境问题）：不说拓扑错、不列问题清单当拓扑错（U5 据 code 走中性外观）。
  if (verdict.errors.some((error) => error.code === "inet_unreachable")) {
    return [
      "校验暂时无法运行：连不上远端 INET，右侧工程保持原状态，未推进。",
      "请检查网络 / 远端后再点「确认并继续」。",
    ].join("\n");
  }
  const problems = verdict.errors.map((error) => `· ${error.messageZh}`);
  const head =
    verdict.caliber === "loadability_only"
      ? "拓扑在 INET 上还跑不起来，先修好再继续（仅能加载运行）："
      : "拓扑还差一点，先修好再继续（仅结构级）：";
  return [head, ...problems, "改好后再点「确认并继续」。"].join("\n");
}

// 时钟同步校验未通过时的对话文案：另写一份（不复用拓扑语气），列问题清单 + 可操作引导。
function composeTimeSyncBlockText(verdict: TopologyVerifyResult): string {
  const problems = verdict.errors
    // 只列拦推进的 fail 级问题；告警（漂移/未覆盖/禁用悬空）不进拦截清单。
    .filter((error) => ["GM_NOT_SET", "GM_DANGLING", "PORT_OUT_OF_RANGE"].includes(error.code))
    .map((error) => `· ${error.messageZh}`);
  return ["时钟同步还差一点，先理顺再继续：", ...problems, "处理好后再点「确认并继续」。"].join(
    "\n",
  );
}

// 确认按钮的确定性入口：先处理待确认的破坏性回退，否则普通推进。切阶段本身不走大模型；
// 但回退「带原话」时返回 carryIntent，由 runTsnAgent 在切换后的阶段用原话自动跑一轮大模型。
function runConfirmAction(workflow: WorkflowState): TsnAgentResult & { carryIntent?: string } {
  if (workflow.pendingStageChange) {
    const target = workflow.pendingStageChange;
    const carriedIntent = workflow.pendingStageChangeIntent;
    // requestStageChanges 会清空 pendingStageChange/Intent 并把后续阶段重置为 locked。
    const switched = requestStageChanges(workflow, target);

    // 回退到拓扑且带着触发它的原话：切阶段后让调用方用原话在拓扑阶段自动执行真正的编辑，
    // 免去用户重输（time-sync 无可编辑工具，不走此路）。
    if (target === "topology" && carriedIntent) {
      return {
        events: [],
        workflow: switched,
        assistantText: "",
        mode: "local",
        carryIntent: carriedIntent,
      };
    }

    // 回退到 time-sync：重新走引导选 GM（current 态仍带确认按钮，由 U6 校验闸把关），
    // 否则会停在裸 current 无引导文案。
    if (target === "time-sync" && switched.stages["time-sync"].status === "current") {
      return runTimeSyncStage(switched);
    }

    const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
    const events = [
      createEvent({
        id: "event-stage-rolled-back",
        kind: "stage-result",
        stage: target,
        title: "已切回阶段",
        content: `已切回${scenarioConfig.stageLabels[target]}阶段，其后的阶段已重置。请描述需要修改的内容。`,
        status: "success",
      }),
    ];

    return {
      events,
      workflow: switched,
      assistantText: events.map((event) => event.content).join("\n"),
      mode: "local",
    };
  }

  if (workflow.stages[workflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(workflow);
  }

  return {
    events: [],
    workflow,
    assistantText: "当前没有待确认的操作。",
    mode: "local",
  };
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
    ...(confirmed.currentStep === "flow-template"
      ? [
          createEvent({
            id: "event-stage-offline",
            kind: "stage-result",
            stage: confirmed.currentStep,
            title: "后续阶段暂下线",
            content: "流量规划在当前版本暂时下线，预计 Phase B 回归。",
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

// U9：进入时间同步阶段的引导（确定性、不走大模型）。阶段置 current（非 waiting_confirmation）：
// 用户先用自然语言指定 GM（经大模型调 timesync 工具落库），再点「确认并继续」由 U6 校验闸放行。
// GM 未定时点确认 → verify_time_sync 拦截（GM_NOT_SET），提示选 GM。
function runTimeSyncStage(workflow: WorkflowState): TsnAgentResult {
  const guidance = [
    "进入时间同步阶段。请用自然语言指定时钟主节点（GM），例如「把 GM 设成 ES-1」。",
    "可同时指定同步参数（同步周期 / 测量周期 / 偏移阈值等）；没指定的我会补推荐默认值，整理好整份配置请你确认。",
    "之后也能随时换 GM、改参数或启停某条链路，系统会按新设置重算时钟树。",
  ].join("\n");
  // status: current（waitingConfirmation:false）——不进 waiting_confirmation，等用户先给 GM。
  const nextWorkflow = recordStageResult(workflow, {
    step: "time-sync",
    summary: "等待指定时钟主节点（GM）。",
    waitingConfirmation: false,
  });
  const events = [
    createEvent({
      id: "event-time-sync-start",
      kind: "stage-start",
      stage: "time-sync",
      title: "时间同步阶段开始",
      content: "请指定时钟主节点（GM）。",
      status: "info",
    }),
    createEvent({
      id: "event-time-sync-guidance",
      kind: "thought",
      stage: "time-sync",
      title: "指定时钟主节点",
      content: guidance,
      status: "info",
    }),
  ];

  return {
    events,
    workflow: nextWorkflow,
    assistantText: guidance,
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

interface StageChangeRequest {
  targetStage: string;
  reason?: string;
}

// 只允许切回有真实处理的阶段；flow-template 暂下线，切过去是死胡同。
const STAGE_SWITCH_TARGETS: readonly WorkflowStep[] = ["topology", "time-sync"];

function asStageChangeRequest(value: unknown): StageChangeRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    record.kind !== "stage-change-request" ||
    typeof record.targetStage !== "string" ||
    record.targetStage.length === 0
  ) {
    return undefined;
  }

  return {
    targetStage: record.targetStage,
    reason:
      typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined,
  };
}

function isLegalStageSwitchTarget(target: string): target is WorkflowStep {
  return (STAGE_SWITCH_TARGETS as readonly string[]).includes(target);
}

function applyStageResults(input: {
  stageResults: unknown[];
  workflow: WorkflowState;
  sessionId?: string;
  userIntent: string;
}): {
  events: AgentEvent[];
  workflow: WorkflowState;
  applied?: WorkflowStageSummary;
  topologyMutationId?: number;
  rejections: string[];
} {
  // 切阶段提议是独立形状（{kind:"stage-change-request"}），必须在拓扑 parse 之前拎出，
  // 否则会被 parseWorkflowStageResult 当成非法拓扑结果直接拒掉。
  const stageChangeRequests: StageChangeRequest[] = [];
  const topologyResults: unknown[] = [];
  for (const raw of input.stageResults) {
    const request = asStageChangeRequest(raw);
    if (request) {
      stageChangeRequests.push(request);
    } else {
      topologyResults.push(raw);
    }
  }

  // 顺序固定（拓扑落库在前、切阶段在后）：先处理拓扑结果。
  const topology = applyTopologyStageResults({
    stageResults: topologyResults,
    workflow: input.workflow,
    sessionId: input.sessionId,
    suppressNoResult: stageChangeRequests.length > 0,
  });

  if (stageChangeRequests.length === 0) {
    // 无切阶段提议：自由文本新一轮作废上一轮未确认的回退提议。
    return { ...topology, workflow: clearPendingStageChange(topology.workflow) };
  }

  // 再处理切阶段提议（多个时取最后一个）。
  const switchOutcome = applyStageChangeRequest(
    stageChangeRequests[stageChangeRequests.length - 1],
    topology.workflow,
    input.userIntent,
  );
  return {
    events: [...topology.events, ...switchOutcome.events],
    workflow: switchOutcome.workflow,
    applied: topology.applied,
    topologyMutationId: topology.topologyMutationId,
    rejections: topology.rejections,
  };
}

function applyTopologyStageResults(input: {
  stageResults: unknown[];
  workflow: WorkflowState;
  sessionId?: string;
  suppressNoResult: boolean;
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
      // U9：time-sync 写库走 sidecar 工具（set_gm 等），不经 stageResult payload——
      // 前端靠查库渲染。故 time-sync 阶段结果接受但忽略（不再 push「暂未启用」、不落工程态）。
      // parse 只产 topology / time-sync 两种 stage；排除 time-sync 后剩 topology。
      if (candidate.stage !== "topology") {
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
  } else if (!input.suppressNoResult && input.workflow.currentStep === "topology") {
    events.push(
      createEvent({
        id: "event-topology-no-result",
        kind: "thought",
        stage: "topology",
        title: "拓扑未更新",
        content:
          "本轮没有生成结构化拓扑结果，右侧工程保持原状态。需要落图时请补充交换机数量、网卡/端系统数量和连接关系。",
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

// 切阶段提议处理：合法性 + 方向校验，往后回退记 pending 待确认（不立即执行）。
function applyStageChangeRequest(
  request: StageChangeRequest,
  workflow: WorkflowState,
  userIntent: string,
): { events: AgentEvent[]; workflow: WorkflowState } {
  const target = request.targetStage;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);

  if (!isLegalStageSwitchTarget(target)) {
    return {
      workflow: clearPendingStageChange(workflow),
      events: [
        createEvent({
          id: "event-stage-change-rejected",
          kind: "error",
          stage: workflow.currentStep,
          title: "无法切换阶段",
          content: `无法切换到「${target}」：只能切回拓扑或时间同步阶段。`,
          status: "error",
        }),
      ],
    };
  }

  const currentIndex = WORKFLOW_STEPS.indexOf(workflow.currentStep);
  const targetIndex = WORKFLOW_STEPS.indexOf(target);

  if (targetIndex === currentIndex) {
    return { workflow: clearPendingStageChange(workflow), events: [] };
  }

  // 方向约束：前进只走「确认并继续」按钮，工具只用于回退——同时消除大模型正向误判风险。
  if (targetIndex > currentIndex) {
    return {
      workflow: clearPendingStageChange(workflow),
      events: [
        createEvent({
          id: "event-stage-change-forward-rejected",
          kind: "error",
          stage: workflow.currentStep,
          title: "无法前进",
          content: `前进到${scenarioConfig.stageLabels[target]}请点「确认并继续」按钮，本工具只用于切回更早的阶段。`,
          status: "error",
        }),
      ],
    };
  }

  // 往后回退（破坏性）：只记 pendingStageChange，不改任何阶段状态——确认按钮的显隐由
  // pendingStageChange 决定（见 chat-pane）。若放弃提议（下一轮自由文本），clearPendingStageChange
  // 直接抹掉它、按钮随之消失，不会留下指向过期目标的「幽灵」待确认状态。
  const reasonSuffix = request.reason ? `（${request.reason}）` : "";
  const summary = `切回${scenarioConfig.stageLabels[target]}会让其后已完成的阶段重新来过${reasonSuffix}。确认要切回吗？确认后点「确认并继续」。`;

  return {
    // 同时记下触发回退的原话：确认后由 runConfirmAction/runTsnAgent 用它在新阶段自动执行编辑。
    workflow: { ...workflow, pendingStageChange: target, pendingStageChangeIntent: userIntent },
    events: [
      createEvent({
        id: "event-stage-change-pending",
        kind: "confirmation-required",
        stage: workflow.currentStep,
        title: "确认切回阶段",
        content: summary,
        status: "warning",
      }),
    ],
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
  const topologySummary =
    hasTopology && snapshot
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
    "重要：固定阶段顺序是拓扑 -> 时间同步 -> 流量规划。拓扑确认后必须进入时间同步，不要说进入配置控制流或流量规划。",
    "重要：流量规划在当前版本暂时下线，不要声称可以生成流量规划或导出文件。",
    workflow.pendingStageChange
      ? `重要：已有一个待用户确认的回退提议（目标阶段：${scenarioConfig.stageLabels[workflow.pendingStageChange]}）。不要重复调用 request_stage_change；等待用户点确认按钮。`
      : "",
    workflow.pendingUndoNotice
      ? "重要：上一步拓扑变更已被撤销，工程数据库已回退到撤销前状态。在回答关于当前拓扑的问题或进行任何编辑之前，必须先用 topology.inspect 查看当前真实状态，不要假设你上一轮的改动仍然存在。"
      : "",
    "",
    "最近对话：",
    recentMessages || "暂无历史对话。",
    "",
    "工程状态：",
    topologySummary,
  ].join("\n");
}

async function fetchTopologySnapshot(
  sessionId: string | undefined,
): Promise<TopologyRowSnapshot | undefined> {
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

// ---------- 输出侧守卫（大模型回复的安全兜底） ----------

function isUnsupportedSimulationClaim(text: string): boolean {
  return /启动仿真|正在.*仿真|后台.*仿真|远程.*仿真|SSH|ssh|devserver|稍后.*结果|完成后.*通知|跑完.*通知/i.test(
    text,
  );
}

function mentionsFlowStageAsCurrent(text: string): boolean {
  return /进入下一步[:：]?\s*(?:\*\*)?(?:配置控制流|建立流)|现在进入.*(?:配置控制流|建立流)|请.*(?:配置|提供).*(?:控制流|视频流|业务流)/i.test(
    text,
  );
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

async function listenToClaudeEvents(
  runId: string,
  handlers: {
    onChunk?: (chunk: string) => void;
    onToolCall?: (payload: unknown) => void;
  },
): Promise<UnlistenFn | undefined> {
  if (!handlers.onChunk && !handlers.onToolCall) {
    return undefined;
  }

  try {
    return await listen<ClaudeAgentEvent>("claude-agent-event", (event) => {
      if (event.payload.runId !== runId) {
        return;
      }

      if (event.payload.kind === "chunk" && event.payload.text) {
        handlers.onChunk?.(event.payload.text);
        return;
      }

      if (event.payload.kind === "tool_call" && event.payload.toolCall !== undefined) {
        handlers.onToolCall?.(event.payload.toolCall);
      }
    });
  } catch {
    return undefined;
  }
}

/**
 * Plan 2026-06-10-001 U3：流式工具事件 → 卡片记录。顺序是硬约束：先对事件 payload
 * 整体递归脱敏，再构造 RawToolCall，再 enrich —— enrich 的摘要从 args 派生，顺序
 * 倒置会让 summary 携带未脱敏值且不再被任何 redact 覆盖。
 */
function toStreamedToolCallRecord(payload: unknown): ToolCallRecord | undefined {
  const redacted = redactSecretsInValue(payload);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    return undefined;
  }

  const event = redacted as {
    id?: unknown;
    name?: unknown;
    phase?: unknown;
    args?: unknown;
    status?: unknown;
    result?: unknown;
  };
  if (typeof event.id !== "string" || !event.id || typeof event.name !== "string") {
    return undefined;
  }

  if (event.phase === "start") {
    return enrichToolCall({ id: event.id, name: event.name, status: "running", args: event.args });
  }

  if (event.phase === "result") {
    const raw: RawToolCall = {
      id: event.id,
      name: event.name,
      status: event.status === "error" ? "error" : "success",
    };
    if (event.result !== undefined) {
      raw.result = event.result;
    }
    return enrichToolCall(raw);
  }

  return undefined;
}

function summarizeMessageForContext(content: string): string {
  const text = content
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("[Skill]") &&
        !line.startsWith("[工具") &&
        !line.startsWith("[文件]") &&
        !line.includes("stage-result.json") &&
        !line.includes("TSN_AGENT_"),
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
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return `agent-run-${random}`;
}
