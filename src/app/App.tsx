import { useEffect, useState } from "react";
import { type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { runTsnAgent } from "../agent/agent-adapter";
import {
  logDiagnostic,
  sessionSummary,
  userIntentPreview,
} from "../diagnostics/app-diagnostics";
import {
  createDiagnosticLogRepository,
  type DiagnosticLogRepository,
} from "../diagnostics/diagnostic-log-repository";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { getScenarioConfig } from "../domain/scenario-config";
import { appVersion } from "../release/release-info";
import {
  createId,
  createSessionRepository,
  type ChatMessage,
  type SessionRepository,
  type TsnSession,
} from "../sessions/session-repository";
import { isEmptyTopologySnapshot } from "../sessions/topology-snapshot";
import { useTopologySnapshot } from "./hooks/use-topology-snapshot";
import { useSessionRepository } from "./hooks/use-session-repository";
import { useAgentRunController } from "./hooks/use-agent-run-controller";
import { ChatPane, AgentRunStatusBar } from "./components/chat-pane";
import {
  WorkspacePane,
  type ConfigTabId,
  type SelectedTopologyItem,
} from "./components/workspace-pane";
import { WorkspaceTools, type WorkspaceToolPanel } from "./components/workspace-tools";
import tsnAgentMark from "../assets/tsn-agent-mark.png";

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
    reloadSessionsList,
    handleNewSession: createNewSession,
    handleSelectSession: selectSession,
    handleDuplicateSession: duplicateSession,
    handleDeleteSession: deleteSession,
  } = useSessionRepository({ repository, diagnostics: diagnosticsRepository });
  const [input, setInput] = useState("");
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<WorkspaceToolPanel | undefined>();
  const {
    isAgentRunning,
    agentRunPhase,
    agentRunElapsedSeconds,
    pendingAssistantMessageId,
    scrollContainerRef,
    actions: agentRun,
  } = useAgentRunController({ scrollDeps: [currentSession.id, currentSession.messages] });
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("node-detail");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<SelectedTopologyItem | undefined>();
  const topologySnapshot = useTopologySnapshot(currentSession.id);

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

    const stillExists = selectedTopologyItem.kind === "node"
      ? topologySnapshot.nodes.some((node) => String(node.imac) === selectedTopologyItem.id)
      : topologySnapshot.links.some((link) => `link-${link.linkSeq}` === selectedTopologyItem.id);

    if (!stillExists) {
      setSelectedTopologyItem(undefined);
    }
  }, [topologySnapshot, selectedTopologyItem]);

  async function handleSubmit() {
    await submitIntent(input);
  }

  async function submitIntent(rawInput: string) {
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
        session: contextSession,
        diagnostics: diagnosticsRepository,
        onChunk: (chunk) => {
          streamedText += chunk;
          agentRun.markStreaming();
          agentRun.recordChunkAt(Date.now());
          agentRun.setPendingAssistantMessageId(undefined);
          updateAssistantMessage(pendingSession.id, assistantMessage.id, redactProviderNamesForDisplay(streamedText));
        },
      });
      const completedAt = new Date().toISOString();
      const latestSession = (await repository.list()).find((session) => session.id === pendingSession.id) ?? pendingSession;
      const baseMessages = latestSession.messages.some((message) => message.id === assistantMessage.id)
        ? latestSession.messages
        : pendingSession.messages;
      const nextSession: TsnSession = {
        ...latestSession,
        updatedAt: completedAt,
        messages: baseMessages.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: redactProviderNamesForDisplay(result.assistantText) }
            : message,
        ),
        claudeSessionId: result.claudeSessionId ?? latestSession.claudeSessionId,
        agentEvents: [...latestSession.agentEvents, ...stampAgentEvents(result.events, completedAt)],
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
              ? { ...message, content: `本次生成失败：${redactProviderNamesForDisplay(normalizeError(error))}` }
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
    setInput("我需要4个交换机，每个交换机连接5个端系统");
    setActiveWorkspacePanel(undefined);
  }

  async function handleSelectSession(session: TsnSession) {
    await selectSession(session);
    setActiveWorkspacePanel(undefined);
  }

  async function handleDuplicateSession() {
    const duplicated = await duplicateSession();

    if (duplicated) {
      setActiveWorkspacePanel(undefined);
    }
  }

  async function handleDeleteSession() {
    await deleteSession();
    setActiveWorkspacePanel(undefined);
  }

  function handleNodeSelect(_event: unknown, node: Node) {
    setSelectedTopologyItem({ kind: "node", id: node.id });
    setActiveConfigTab("node-detail");
  }

  function handleLinkSelect(_event: unknown, edge: Edge) {
    setSelectedTopologyItem({ kind: "link", id: edge.id });
    setActiveConfigTab("link-detail");
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

      {isAgentRunning && <AgentRunStatusBar elapsedSeconds={agentRunElapsedSeconds} phase={agentRunPhase} />}

      <main className="project-layout">
        <WorkspaceTools
          activePanel={activeWorkspacePanel}
          setActivePanel={setActiveWorkspacePanel}
          currentSession={currentSession}
          sessions={sessions}
          diagnosticsRepository={diagnosticsRepository}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDuplicateSession={handleDuplicateSession}
          onDeleteSession={handleDeleteSession}
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
          onConfirm={() => submitIntent("继续")}
        />
        <WorkspacePane
          topologySnapshot={topologySnapshot}
          selectedTopologyItem={selectedTopologyItem}
          activeConfigTab={activeConfigTab}
          agentEvents={currentSession.agentEvents}
          isAgentRunning={isAgentRunning}
          hasUserInteraction={hasUserInteraction}
          onSelectConfigTab={setActiveConfigTab}
          onNodeSelect={handleNodeSelect}
          onLinkSelect={handleLinkSelect}
        />
      </main>
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

function stampAgentEvents<T extends { id: string; createdAt?: string }>(events: T[], createdAt: string): T[] {
  return events.map((event, index) => ({
    ...event,
    id: `${event.id}-${createdAt.replace(/[^0-9A-Za-z]/g, "")}-${index}`,
    createdAt,
  }));
}
