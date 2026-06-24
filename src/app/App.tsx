import { invoke } from "@tauri-apps/api/core";
import type { Edge, Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import "@xyflow/react/dist/style.css";
import { runTsnAgent } from "../agent/agent-adapter";
import type { ToolCallRecord } from "../agent/tool-call-record";
import tsnAgentMark from "../assets/tsn-agent-mark.png";
import { logDiagnostic, sessionSummary, userIntentPreview } from "../diagnostics/app-diagnostics";
import {
  createDiagnosticLogRepository,
  type DiagnosticLogRepository,
} from "../diagnostics/diagnostic-log-repository";
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
import { AgentRunStatusBar, ChatPane } from "./components/chat-pane";
import {
  type ConfigTabId,
  type SelectedTopologyItem,
  WorkspacePane,
} from "./components/workspace-pane";
import { type WorkspaceToolPanel, WorkspaceTools } from "./components/workspace-tools";
import { useAgentRunController } from "./hooks/use-agent-run-controller";
import { useBackfillFailures } from "./hooks/use-backfill-failures";
import { useSessionRepository } from "./hooks/use-session-repository";
import { useTopologySnapshot } from "./hooks/use-topology-snapshot";
import {
  exportCurrentSession,
  importSessionFromFile,
  revealExportedFile,
  type TransferNotice,
} from "./session-transfer";

const repository: SessionRepository = createSessionRepository();
const diagnosticsRepository: DiagnosticLogRepository = createDiagnosticLogRepository();
const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前会话上下文生成下一步规划...";
const SESSION_TITLE_MAX_CHARS = 24;

export function App() {
  const {
    sessions,
    currentSession,
    setCurrentSession,
    sessionExists,
    updateAssistantMessage,
    updateAssistantToolCalls,
    reloadSessionsList,
    handleNewSession: createNewSession,
    handleSelectSession: selectSession,
    handleDeleteSession: deleteSession,
  } = useSessionRepository({ repository, diagnostics: diagnosticsRepository });
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
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("node-detail");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<
    SelectedTopologyItem | undefined
  >();
  const {
    snapshot: topologySnapshot,
    refetch: refetchTopology,
    lastMutationId,
  } = useTopologySnapshot(currentSession.id);
  const [transferNotice, setTransferNotice] = useState<TransferNotice | undefined>();
  const [retryTargetId, setRetryTargetId] = useState<string | undefined>();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [payloadView, setPayloadView] = useState<{ sessionId: string; text: string } | undefined>();
  const { failures: backfillFailures, refresh: refreshBackfillFailures } = useBackfillFailures();

  useEffect(() => {
    setActiveConfigTab("node-detail");
    setSelectedTopologyItem(undefined);
  }, [currentSession.id]);

  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const hasUserInteraction = currentSession.messages.some((message) => message.role === "user");
  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);

  useEffect(() => {
    if (!topologySnapshot || !selectedTopologyItem) {
      return;
    }

    const stillExists =
      selectedTopologyItem.kind === "node"
        ? topologySnapshot.nodes.some((node) => node.syncName === selectedTopologyItem.id)
        : topologySnapshot.links.some((link) => `link-${link.linkSeq}` === selectedTopologyItem.id);

    if (!stillExists) {
      setSelectedTopologyItem(undefined);
    }
  }, [topologySnapshot, selectedTopologyItem]);

  async function handleSubmit() {
    await submitIntent(input);
  }

  async function submitIntent(rawInput: string, options: { action?: "confirm-stage" } = {}) {
    const trimmedInput = rawInput.trim();

    if (!trimmedInput || isAgentRunning) {
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

    setInput((value) => (value.trim() === trimmedInput ? "" : value));
    agentRun.startRun();
    agentRun.setPendingAssistantMessageId(assistantMessage.id);
    setCurrentSession(pendingSession);
    logDiagnostic(diagnosticsRepository, {
      sessionId: pendingSession.id,
      category: "session",
      message: "用户提交需求",
      details: userIntentPreview(trimmedInput),
    });

    try {
      await repository.save(pendingSession);
      logDiagnostic(diagnosticsRepository, {
        sessionId: pendingSession.id,
        category: "session",
        message: "pending session 已保存",
        details: sessionSummary(pendingSession),
      });
      await reloadSessionsList();

      const result = await runTsnAgent({
        userIntent: trimmedInput,
        action: options.action,
        session: contextSession,
        diagnostics: diagnosticsRepository,
        onChunk: (chunk) => {
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
      logDiagnostic(diagnosticsRepository, {
        sessionId: nextSession.id,
        category: "session",
        message: "final session 已保存",
        details: {
          ...sessionSummary(nextSession),
          agentMode: result.mode,
        },
      });
      setCurrentSession((session) => (session.id === nextSession.id ? nextSession : session));
      await reloadSessionsList();
    } catch (error) {
      setInput(trimmedInput);
      agentRun.setPendingAssistantMessageId(undefined);
      logDiagnostic(diagnosticsRepository, {
        sessionId: pendingSession.id,
        category: "session",
        level: "error",
        message: "会话生成失败",
        details: {
          error: normalizeError(error),
        },
      });
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
      agentRun.finishRun();
    }
  }

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

  function handleNodeSelect(_event: unknown, node: Node) {
    setSelectedTopologyItem({ kind: "node", id: node.id });
    setActiveConfigTab("node-detail");
  }

  function handleLinkSelect(_event: unknown, edge: Edge) {
    setSelectedTopologyItem({ kind: "link", id: edge.id });
    setActiveConfigTab("link-detail");
  }

  function handleClearTopologySelection() {
    setSelectedTopologyItem(undefined);
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
      logDiagnostic(diagnosticsRepository, {
        sessionId: currentSession.id,
        category: "session",
        message: "导出会话",
        details: { targetPath: outcome.path },
      });
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
      setTransferNotice({ kind: "success", text: "会话已导入" });
      logDiagnostic(diagnosticsRepository, {
        sessionId: outcome.sessionId,
        category: "session",
        message: "导入会话",
        details: { sessionId: outcome.sessionId },
      });
    } else if (outcome.status === "error") {
      setTransferNotice({ kind: "error", text: outcome.message });
    }
  }

  async function handleViewBackfillPayload(sessionId: string) {
    try {
      const text = await invoke<string>("view_session_payload", { request: { sessionId } });
      setPayloadView({ sessionId, text });
    } catch (err) {
      setTransferNotice({ kind: "error", text: `读取原始数据失败：${String(err)}` });
    }
  }

  async function handleRetryBackfill() {
    const sessionId = retryTargetId;
    if (!sessionId) {
      return;
    }
    setRetryTargetId(undefined);
    try {
      await invoke("retry_backfill", { request: { sessionId } });
      if (sessionId === currentSession.id) {
        await refetchTopology();
      }
      setTransferNotice({ kind: "success", text: "拓扑已从原始数据重建" });
      logDiagnostic(diagnosticsRepository, {
        sessionId,
        category: "session",
        message: "重试 backfill 重建",
        details: { sessionId },
      });
    } catch (err) {
      setTransferNotice({ kind: "error", text: `重建失败：${String(err)}` });
    } finally {
      await refreshBackfillFailures();
      await reloadSessionsList();
    }
  }

  return (
    <div className="app-shell" aria-busy={isAgentRunning}>
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">TSN Agent</h1>
        <span className="brand-ver">VER {appVersion}</span>
        <span className={hasTopology ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {hasTopology ? "草案已生成" : "草稿"}
        </span>
        <div className="brand-spacer" />
      </header>

      {isAgentRunning && (
        <AgentRunStatusBar elapsedSeconds={agentRunElapsedSeconds} phase={agentRunPhase} />
      )}

      <main className="project-layout">
        <WorkspaceTools
          activePanel={activeWorkspacePanel}
          setActivePanel={setActiveWorkspacePanel}
          currentSession={currentSession}
          sessions={sessions}
          diagnosticsRepository={diagnosticsRepository}
          backfillFailures={backfillFailures}
          transferNotice={transferNotice}
          transferBusy={isAgentRunning}
          payloadView={payloadView}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onExportSession={handleExportSession}
          onImportSession={handleImportSession}
          onViewPayload={(sessionId) => void handleViewBackfillPayload(sessionId)}
          onRequestRetry={(sessionId) => setRetryTargetId(sessionId)}
          onRevealExport={(path) => void revealExportedFile(path)}
          onClosePayloadView={() => setPayloadView(undefined)}
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
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onConfirm={() => submitIntent("继续", { action: "confirm-stage" })}
        />
        <WorkspacePane
          topologySnapshot={topologySnapshot}
          selectedTopologyItem={selectedTopologyItem}
          activeConfigTab={activeConfigTab}
          isAgentRunning={isAgentRunning}
          hasUserInteraction={hasUserInteraction}
          lastMutationId={lastMutationId}
          onSelectConfigTab={setActiveConfigTab}
          onNodeSelect={handleNodeSelect}
          onLinkSelect={handleLinkSelect}
          onClearSelection={handleClearTopologySelection}
          onRefreshTopology={() => void refetchTopology()}
          onUndone={handleTopologyUndone}
        />
      </main>

      <ConfirmDialog
        open={retryTargetId !== undefined}
        title="重建拓扑"
        body="将从原始数据重建，该会话现有拓扑数据将被替换（包括对话中做过的增量修改）。"
        confirmLabel="重建"
        danger
        onConfirm={() => void handleRetryBackfill()}
        onCancel={() => setRetryTargetId(undefined)}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="删除当前会话"
        body={`将删除「${currentSession.title}」及其拓扑数据，删除后无法恢复。`}
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
