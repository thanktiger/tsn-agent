import { invoke } from "@tauri-apps/api/core";
import type { Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { createRunId, runTsnAgent } from "../agent/agent-adapter";
import type { ToolCallRecord } from "../agent/tool-call-record";
import tsnAgentMark from "../assets/tsn-agent-mark.png";
import { getScenarioConfig } from "../domain/scenario-config";
import { appVersion } from "../release/release-info";
import {
  type ChatMessage,
  createId,
  createSessionRepository,
  type SessionRepository,
  type TsnSession,
} from "../sessions/session-repository";
import { isEmptyTopologySnapshot } from "../sessions/topology-snapshot";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { ChatPane } from "./components/chat-pane";
import {
  type ConfigTabId,
  type HardwareUiState,
  type PlanUiState,
  type SimUiState,
  type TimesyncSubTab,
  type VerifyUiState,
  WorkspacePane,
} from "./components/workspace-pane";
import { computeReveal, type RevealBaseline } from "./components/workspace-pane/timesync-sim";
import { type WorkspaceToolPanel, WorkspaceTools } from "./components/workspace-tools";
import { useAgentRunController } from "./hooks/use-agent-run-controller";
import { useSessionRepository } from "./hooks/use-session-repository";
import { useTimesyncSnapshot } from "./hooks/use-timesync-snapshot";
import { useTopologySnapshot } from "./hooks/use-topology-snapshot";
import {
  exportCurrentSession,
  importSessionFromFile,
  revealExportedFile,
  type TransferNotice,
} from "./session-transfer";

const repository: SessionRepository = createSessionRepository();
const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前工程上下文生成下一步规划...";
const SESSION_TITLE_MAX_CHARS = 24;

export function App() {
  const {
    sessions,
    currentSession,
    setCurrentSession,
    sessionExists,
    isSessionDeleted,
    updateAssistantMessage,
    updateAssistantToolCalls,
    reloadSessionsList,
    handleNewSession: createNewSession,
    handleSelectSession: selectSession,
    handleDeleteSession: deleteSession,
  } = useSessionRepository({ repository });
  const [input, setInput] = useState("");
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<
    WorkspaceToolPanel | undefined
  >();
  const {
    isAgentRunning,
    agentRunPhase,
    agentRunElapsedSeconds,
    pendingAssistantMessageId,
    scrollContainerRef,
    actions: agentRun,
  } = useAgentRunController({ scrollDeps: [currentSession.id, currentSession.messages] });
  // U10：弹出框显隐由独立 expand 驱动（与选中解耦）；面板可在无选中节点时打开。
  const [configPanelExpanded, setConfigPanelExpanded] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("node-props");
  // 时间同步子 tab（软件仿真/硬件部署，平级）。App 级以便 reveal 强制落 soft-sim；随会话重置。
  const [activeTimesyncSubTab, setActiveTimesyncSubTab] = useState<TimesyncSubTab>("soft-sim");
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  // U11：软仿运行态持于 App 级（非 tab 组件内）——切 tab 不取消命令、切回按 simStatus 恢复。
  const [simState, setSimState] = useState<SimUiState>({ status: "idle" });
  // U8：硬件部署运行态同样持于 App 级（切 tab/子 tab 不丢；随会话重置）。
  const [hardwareState, setHardwareState] = useState<HardwareUiState>({ status: "idle" });
  // U9：流量规划/软仿运行态持于 App 级（切 tab 不取消命令；随会话重置）。
  const [flowPlanState, setFlowPlanState] = useState<PlanUiState>({ status: "idle" });
  const [flowVerifyState, setFlowVerifyState] = useState<VerifyUiState>({ status: "idle" });
  const {
    snapshot: topologySnapshot,
    refetch: refetchTopology,
    lastMutationId,
  } = useTopologySnapshot(currentSession.id);
  const { snapshot: timesyncSnapshot } = useTimesyncSnapshot(currentSession.id);
  const [transferNotice, setTransferNotice] = useState<TransferNotice | undefined>();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // 当前这轮推理的 runId（编排层单一拥有，传给 runTsnAgent，前后端同值）。终止时按它调
  // cancel 命令。用 ref 而非 state：终止编排在 async 闭包里读取，避免读到过期快照。
  const activeRunIdRef = useRef<string | undefined>(undefined);
  // 仅当 cancel 命令返回 killed:true 才置位——是「本轮被用户真终止」的唯一依据（KTD3）。
  const cancelRequestedRef = useRef(false);
  // set_gm 揭示（U4）：时间同步 tab 上的「有新内容」脉冲 badge（面板已开但用户在别 tab 时用）。
  const [timesyncTabHasBadge, setTimesyncTabHasBadge] = useState(false);
  // 镜像最新 expand/activeConfigTab，供 reveal effect 读而不把它们放进 deps（否则会误触发）。
  const configPanelExpandedRef = useRef(configPanelExpanded);
  configPanelExpandedRef.current = configPanelExpanded;
  const activeConfigTabRef = useRef(activeConfigTab);
  activeConfigTabRef.current = activeConfigTab;
  // reveal 基线：记每会话的 gmMid 基线，区分「切会话水合」与「同会话内 set_gm」。
  const revealBaselineRef = useRef<RevealBaseline>({
    sessionId: currentSession.id,
    gmMid: undefined,
    established: false,
  });

  // U10（doc-review 决定）：会话切换时三态归零——收起、回 node-props、清选中，防 PR#23 id 污染。
  // U11：软仿运行态也随会话切换重置（不跨会话保留结果）。U4：badge 也清。
  useEffect(() => {
    setConfigPanelExpanded(false);
    setActiveConfigTab("node-props");
    setActiveTimesyncSubTab("soft-sim");
    setSelectedNodeId(undefined);
    setSimState({ status: "idle" });
    setHardwareState({ status: "idle" });
    setFlowPlanState({ status: "idle" });
    setFlowVerifyState({ status: "idle" });
    setTimesyncTabHasBadge(false);
  }, [currentSession.id]);

  // U4：set_gm 后分级揭示。纯决策在 computeReveal（可单测）；这里只把 action 落成 state。
  useEffect(() => {
    const { nextBaseline, action } = computeReveal({
      baseline: revealBaselineRef.current,
      currentSessionId: currentSession.id,
      snapshotSessionId: timesyncSnapshot?.sessionId,
      gmMid: timesyncSnapshot?.domain?.gmMid,
      inTimeSyncStage: currentSession.workflow.currentStep === "time-sync",
      panelExpanded: configPanelExpandedRef.current,
      activeIsTimeSync: activeConfigTabRef.current === "time-sync",
    });
    revealBaselineRef.current = nextBaseline;
    if (action === "expand-soft-sim") {
      setConfigPanelExpanded(true);
      setActiveConfigTab("time-sync");
      setActiveTimesyncSubTab("soft-sim");
    } else if (action === "badge") {
      setTimesyncTabHasBadge(true);
    } else if (action === "clear-badge") {
      setTimesyncTabHasBadge(false);
    }
  }, [currentSession.id, currentSession.workflow.currentStep, timesyncSnapshot]);

  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const hasUserInteraction = currentSession.messages.some((message) => message.role === "user");
  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);

  useEffect(() => {
    if (!topologySnapshot || !selectedNodeId) {
      return;
    }

    const stillExists = topologySnapshot.nodes.some((node) => node.mid === selectedNodeId);
    if (!stillExists) {
      setSelectedNodeId(undefined);
    }
  }, [topologySnapshot, selectedNodeId]);

  async function handleSubmit() {
    await submitIntent(input);
  }

  async function submitIntent(rawInput: string, options: { action?: "confirm-stage" } = {}) {
    const trimmedInput = rawInput.trim();

    if (!trimmedInput || isAgentRunning) {
      return;
    }

    // 已删 session 的残留指针不得驱动 UPSERT：否则首次 save 会把删掉的会话回写复活。
    // 入口拦截即可——本函数到首个 save 之间无 await，删除无法在中途插入。
    if (isSessionDeleted(currentSession.id)) {
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: createId("message"),
      role: "user",
      createdAt: now,
      content: trimmedInput,
    };
    const assistantMessage: ChatMessage = {
      id: createId("message"),
      role: "assistant",
      createdAt: now,
      content: ASSISTANT_CONNECTING_MESSAGE,
    };
    const contextSession = currentSession;
    const isFirstUserMessage = !contextSession.messages.some((message) => message.role === "user");
    const pendingSession: TsnSession = {
      ...contextSession,
      title: isFirstUserMessage ? truncateSessionTitle(trimmedInput) : contextSession.title,
      updatedAt: now,
      messages: [...contextSession.messages, userMessage, assistantMessage],
    };
    let streamedText = "";
    // Plan 2026-06-10-001 U4：流式工具卡片按 id upsert（纯内存，不落库）；
    // done 后由 result.toolCalls 整体覆盖对账（R12），崩溃路径随错误态丢弃（R14）。
    const streamedToolCalls = new Map<string, ToolCallRecord>();
    // 本轮 runId：编排层生成并留存，传给 runTsnAgent（前后端同一 runId），终止时据此 cancel。
    const runId = createRunId();
    activeRunIdRef.current = runId;

    setInput((value) => (value.trim() === trimmedInput ? "" : value));
    agentRun.startRun();
    agentRun.setPendingAssistantMessageId(assistantMessage.id);
    setCurrentSession(pendingSession);

    try {
      await repository.save(pendingSession);
      await reloadSessionsList();

      const result = await runTsnAgent({
        userIntent: trimmedInput,
        action: options.action,
        runId,
        session: contextSession,
        onChunk: (chunk) => {
          // 终止成功（cancelRequestedRef 已置）后到达的在途 chunk 一律丢弃，避免覆盖
          // 即将定型的「已终止」消息。守 cancelRequestedRef 而非塑形后才置的局部标志，
          // 把守卫提前到「终止生效」的瞬间，关掉 unlisten 与塑形之间的 late-chunk 窗口。
          if (cancelRequestedRef.current) {
            return;
          }
          streamedText += chunk;
          agentRun.markStreaming();
          agentRun.recordChunkAt(Date.now());
          agentRun.setPendingAssistantMessageId(undefined);
          updateAssistantMessage(
            pendingSession.id,
            assistantMessage.id,
            redactProviderNamesForDisplay(streamedText),
          );
        },
        onToolCall: (record) => {
          const previous = streamedToolCalls.get(record.id);
          // result 事件不带 args：spread 不覆盖缺席键，previous.args 自然保留；
          // 非失败时保留 start 相的 args 摘要，避免 result→done 间摘要闪变。
          streamedToolCalls.set(
            record.id,
            previous
              ? {
                  ...previous,
                  ...record,
                  summary: record.status === "error" ? record.summary : previous.summary,
                }
              : record,
          );
          agentRun.markStreaming();
          updateAssistantToolCalls(pendingSession.id, assistantMessage.id, [
            ...streamedToolCalls.values(),
          ]);
        },
      });
      const completedAt = new Date().toISOString();

      // 终止分支（KTD3）：用户已真终止（cancel 返回 killed:true）「且」本轮确实失败
      // （runFailed）→ 保留已流式产出 + 标「已终止」，丢弃 result.events（不让
      // event-agent-failed 混进事件流）、不消费 buildAgentFailureText。
      // runFailed 闸门挡住竞速：cancel 在 worker 已自然成功（结果含已落库 topologyMutationId）
      // 后才到达时，result.runFailed 为假 → 走下方正常分支，保住拓扑指针不被误丢。
      if (cancelRequestedRef.current && result.runFailed) {
        const redacted = redactProviderNamesForDisplay(streamedText);
        const terminatedContent = redacted ? `${redacted}\n\n_（已终止）_` : "_（本轮推理已终止）_";
        const latestTerminatedSession =
          (await repository.list()).find((session) => session.id === pendingSession.id) ??
          pendingSession;
        const terminatedBaseMessages = latestTerminatedSession.messages.some(
          (message) => message.id === assistantMessage.id,
        )
          ? latestTerminatedSession.messages
          : pendingSession.messages;
        const terminatedSession: TsnSession = {
          ...latestTerminatedSession,
          updatedAt: completedAt,
          messages: terminatedBaseMessages.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: terminatedContent,
                  toolCalls: [...streamedToolCalls.values()],
                }
              : message,
          ),
          workflow: result.workflow,
        };

        if (!(await sessionExists(terminatedSession.id))) {
          return;
        }

        await repository.save(terminatedSession);
        setCurrentSession((session) =>
          session.id === terminatedSession.id ? terminatedSession : session,
        );
        await reloadSessionsList();
        return;
      }

      const latestSession =
        (await repository.list()).find((session) => session.id === pendingSession.id) ??
        pendingSession;
      const baseMessages = latestSession.messages.some(
        (message) => message.id === assistantMessage.id,
      )
        ? latestSession.messages
        : pendingSession.messages;
      const nextSession: TsnSession = {
        ...latestSession,
        updatedAt: completedAt,
        messages: baseMessages.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: redactProviderNamesForDisplay(result.assistantText),
                toolCalls: result.toolCalls,
                verification: result.verification,
              }
            : message,
        ),
        claudeSessionId: result.claudeSessionId ?? latestSession.claudeSessionId,
        agentEvents: [
          ...latestSession.agentEvents,
          ...stampAgentEvents(result.events, completedAt),
        ],
        workflow: result.workflow,
        topologyMutationId: result.topologyMutationId ?? latestSession.topologyMutationId,
      };

      if (!(await sessionExists(nextSession.id))) {
        return;
      }

      await repository.save(nextSession);
      setCurrentSession((session) => (session.id === nextSession.id ? nextSession : session));
      await reloadSessionsList();
    } catch (error) {
      setInput(trimmedInput);
      agentRun.setPendingAssistantMessageId(undefined);
      setCurrentSession((session) => {
        if (session.id !== pendingSession.id) {
          return session;
        }

        return {
          ...pendingSession,
          messages: pendingSession.messages.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: `本次生成失败：${redactProviderNamesForDisplay(normalizeError(error))}`,
                }
              : message,
          ),
        };
      });
    } finally {
      activeRunIdRef.current = undefined;
      cancelRequestedRef.current = false;
      agentRun.finishRun();
    }
  }

  // 终止当前这轮推理（U3 接到发送键切出的「终止」按钮）。按 runId 调后端 cancel 命令，
  // 仅当返回 killed:true 才置 cancelRequestedRef（KTD3 唯一闸门）——堵住 worker 注册前点击 /
  // 真崩溃同瞬 / run 已自然收尾这几个误标窗口；killed:false 给一句轻提示、不置脏标志。
  const handleTerminateRun = useCallback(async () => {
    const runId = activeRunIdRef.current;
    // 守 activeRunIdRef（同步写、永远最新）而非 isAgentRunning（state，闭包快照可能
    // 停留在 startRun 前的旧帧 → 误判没在跑而提前 return）。deps 空，回调引用稳定。
    // 已终止过本轮（cancelRequestedRef 真）直接 no-op：挡住双击向已清空 registry 发第二次
    // cancel 而触发 killed:false 误导提示。
    if (!runId || cancelRequestedRef.current) {
      return;
    }

    try {
      const outcome = await invoke<{ killed: boolean }>("cancel_claude_agent", { runId });
      if (outcome.killed) {
        cancelRequestedRef.current = true;
      } else {
        setTransferNotice({ kind: "error", text: "本轮推理尚未就绪或已结束，未能终止。" });
      }
    } catch {
      // invoke 自身失败：不留脏标志，照常等本轮结束。
    }
  }, []);

  async function handleNewSession() {
    await createNewSession();
    // 不再硬替用户打字：清空输入，由场景化 placeholder（跟着选的场景变）引导（U11 配套）。
    setInput("");
    setActiveWorkspacePanel(undefined);
  }

  async function handleSelectSession(session: TsnSession) {
    await selectSession(session);
    setActiveWorkspacePanel(undefined);
  }

  // 删除走确认弹窗；确认后保持「会话」抽屉打开，方便看到列表变化。
  function handleDeleteSession() {
    setDeleteConfirmOpen(true);
  }

  async function confirmDeleteSession() {
    setDeleteConfirmOpen(false);
    await deleteSession();
  }

  // U10：点节点 → 展开面板 + 切到「节点属性」tab（显隐与选中解耦：选中只是顺带展开）。
  function handleNodeSelect(_event: unknown, node: Node) {
    setSelectedNodeId(node.id);
    setActiveConfigTab("node-props");
    setConfigPanelExpanded(true);
  }

  // U8/U7：画布撤销成功后置一次性回退通知标志。该标志须落在喂给下一轮 agent 的
  // 内存 session 上（submitIntent 读 contextSession = currentSession），下一轮
  // runTsnAgent 经 request.session.workflow.pendingUndoNotice 取回并注入；
  // normalizeWorkflowState 不持久化它，重启不还原。
  function handleTopologyUndone() {
    setCurrentSession((session) => ({
      ...session,
      workflow: { ...session.workflow, pendingUndoNotice: true },
    }));
  }

  async function handleExportSession() {
    if (isAgentRunning) {
      return;
    }
    const outcome = await exportCurrentSession(currentSession.id, currentSession.title);
    if (outcome.status === "done") {
      setTransferNotice({ kind: "success", text: `已导出到 ${outcome.path}`, path: outcome.path });
    } else if (outcome.status === "error") {
      setTransferNotice({ kind: "error", text: outcome.message });
    }
  }

  async function handleImportSession() {
    if (isAgentRunning) {
      return;
    }
    const outcome = await importSessionFromFile();
    if (outcome.status === "done") {
      await reloadSessionsList();
      const imported = (await repository.list()).find(
        (session) => session.id === outcome.sessionId,
      );
      if (imported) {
        await repository.setCurrent(imported.id);
        setCurrentSession(imported);
      }
      setTransferNotice({ kind: "success", text: "工程已导入" });
    } else if (outcome.status === "error") {
      setTransferNotice({ kind: "error", text: outcome.message });
    }
  }

  return (
    <div className="app-shell" aria-busy={isAgentRunning}>
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">HIBridge Agent</h1>
        <span className="brand-ver">VER {appVersion}</span>
        <span className={hasTopology ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {hasTopology ? "草案已生成" : "草稿"}
        </span>
        <div className="brand-spacer" />
      </header>

      <main className="project-layout">
        <WorkspaceTools
          activePanel={activeWorkspacePanel}
          setActivePanel={setActiveWorkspacePanel}
          currentSession={currentSession}
          sessions={sessions}
          transferNotice={transferNotice}
          transferBusy={isAgentRunning}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onExportSession={handleExportSession}
          onImportSession={handleImportSession}
          onRevealExport={(path) => void revealExportedFile(path)}
        />
        <ChatPane
          scenarioConfig={scenarioConfig}
          workflow={workflow}
          currentStage={currentStage}
          messages={currentSession.messages}
          pendingAssistantMessageId={pendingAssistantMessageId}
          scrollContainerRef={scrollContainerRef}
          input={input}
          isAgentRunning={isAgentRunning}
          agentRunPhase={agentRunPhase}
          agentRunElapsedSeconds={agentRunElapsedSeconds}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onConfirm={() => submitIntent("继续", { action: "confirm-stage" })}
          onTerminate={handleTerminateRun}
        />
        <WorkspacePane
          topologySnapshot={topologySnapshot}
          selectedNodeId={selectedNodeId}
          configPanelExpanded={configPanelExpanded}
          activeConfigTab={activeConfigTab}
          isAgentRunning={isAgentRunning}
          hasUserInteraction={hasUserInteraction}
          lastMutationId={lastMutationId}
          workflowStep={workflow.currentStep}
          timesyncSnapshot={timesyncSnapshot}
          sessionId={currentSession.id}
          simState={simState}
          onSimStateChange={setSimState}
          hardwareState={hardwareState}
          onHardwareStateChange={setHardwareState}
          flowPlanState={flowPlanState}
          onFlowPlanStateChange={setFlowPlanState}
          flowVerifyState={flowVerifyState}
          onFlowVerifyStateChange={setFlowVerifyState}
          activeTimesyncSubTab={activeTimesyncSubTab}
          onSelectTimesyncSubTab={setActiveTimesyncSubTab}
          timesyncTabHasBadge={timesyncTabHasBadge}
          onToggleConfigPanel={() => setConfigPanelExpanded((value) => !value)}
          onSelectConfigTab={(tab) => {
            setActiveConfigTab(tab);
            // 进时间同步 tab 即清 badge（用户已看到揭示）。
            if (tab === "time-sync") {
              setTimesyncTabHasBadge(false);
            }
          }}
          onNodeSelect={handleNodeSelect}
          onRefreshTopology={() => void refetchTopology()}
          onUndone={handleTopologyUndone}
        />
      </main>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="删除当前工程"
        body={`将删除「${currentSession.title}」及其拓扑数据，删除后无法恢复。该工程的 eval 采集样本不会被删除，如需清除请到「评估采集」面板操作。`}
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDeleteSession()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </div>
  );
}

function truncateSessionTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > SESSION_TITLE_MAX_CHARS
    ? `${collapsed.slice(0, SESSION_TITLE_MAX_CHARS)}…`
    : collapsed;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}

function stampAgentEvents<T extends { id: string; createdAt?: string }>(
  events: T[],
  createdAt: string,
): T[] {
  return events.map((event, index) => ({
    ...event,
    id: `${event.id}-${createdAt.replace(/[^0-9A-Za-z]/g, "")}-${index}`,
    createdAt,
  }));
}
