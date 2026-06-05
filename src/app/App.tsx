import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Copy,
  FolderOpen,
  Plus,
  ScrollText,
  Settings,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
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
import { DiagnosticsLogView } from "../ui/diagnostics/DiagnosticsDrawer";
import { SkillFilePreview } from "../ui/skills/SkillFilePreview";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { getScenarioConfig } from "../domain/scenario-config";
import { resolvePlannerBaseUrl } from "../planner/planner-contract";
import { appVersion, releaseNotes, type ReleaseNote } from "../release/release-info";
import {
  createEmptySession,
  createId,
  createSessionRepository,
  type ChatMessage,
  type SessionRepository,
  type TsnSession,
} from "../sessions/session-repository";
import {
  countEndSystems,
  countSwitches,
  isEmptyTopologySnapshot,
  type TopologyLinkRow,
  type TopologyNodeRow,
  type TopologyRowSnapshot,
} from "../sessions/topology-snapshot";
import { useTopologySnapshot } from "./hooks/use-topology-snapshot";
import {
  SKILL_CATALOG,
  type SkillCatalogItem,
} from "../skills/skill-catalog";
import tsnAgentMark from "../assets/tsn-agent-mark.png";

const repository: SessionRepository = createSessionRepository();
const diagnosticsRepository: DiagnosticLogRepository = createDiagnosticLogRepository();
const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前会话上下文生成下一步规划...";
const INTENT_PLACEHOLDER = "例如：我需要 4 个交换机，每个交换机连接 5 个端系统";
const AGENT_STREAM_STALL_MS = 3000;
const SESSION_TITLE_MAX_CHARS = 24;

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

type ConfigTabId = "node-detail" | "link-detail" | "steps";
type WorkspaceToolPanel = "sessions" | "diagnostics" | "skills" | "settings";

type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

type AgentRunPhase = "idle" | "connecting" | "streaming" | "waiting";

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
  { id: "steps", label: "执行步骤" },
];

export function App() {
  const initialSession = useMemo(() => createEmptySession(), []);
  const [sessions, setSessions] = useState<TsnSession[]>([initialSession]);
  const [currentSession, setCurrentSession] = useState<TsnSession>(initialSession);
  const [input, setInput] = useState("");
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<WorkspaceToolPanel | undefined>();
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentRunPhase, setAgentRunPhase] = useState<AgentRunPhase>("idle");
  const [agentRunStartedAt, setAgentRunStartedAt] = useState<number | undefined>();
  const [agentRunElapsedSeconds, setAgentRunElapsedSeconds] = useState(0);
  const [lastAgentChunkAt, setLastAgentChunkAt] = useState<number | undefined>();
  const [pendingAssistantMessageId, setPendingAssistantMessageId] = useState<string | undefined>();
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("node-detail");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<SelectedTopologyItem | undefined>();
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const topologySnapshot = useTopologySnapshot(currentSession.id);

  useEffect(() => {
    let cancelled = false;

    async function loadSessionState() {
      try {
        const session = await repository.ensureCurrentSession();
        const recentSessions = await repository.list();

        if (!cancelled) {
          setCurrentSession(session);
          setSessions(recentSessions.length > 0 ? recentSessions : [session]);
        }
      } catch {
        if (!cancelled) {
          setCurrentSession(initialSession);
          setSessions([initialSession]);
        }
      }
    }

    void loadSessionState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveConfigTab("node-detail");
    setSelectedTopologyItem(undefined);
  }, [currentSession.id]);

  useEffect(() => {
    if (!isAgentRunning || agentRunPhase !== "streaming") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAgentRunPhase((phase) => (phase === "streaming" ? "waiting" : phase));
    }, AGENT_STREAM_STALL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [agentRunPhase, isAgentRunning, lastAgentChunkAt]);

  useEffect(() => {
    if (!isAgentRunning || agentRunStartedAt === undefined) {
      return;
    }

    const updateElapsedSeconds = () => {
      setAgentRunElapsedSeconds(Math.max(0, Math.floor((Date.now() - agentRunStartedAt) / 1000)));
    };

    updateElapsedSeconds();
    const intervalId = window.setInterval(updateElapsedSeconds, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [agentRunStartedAt, isAgentRunning]);

  useEffect(() => {
    const messagesContainer = messagesContainerRef.current;

    if (!messagesContainer) {
      return;
    }

    if (typeof messagesContainer.scrollTo === "function") {
      messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: isAgentRunning ? "smooth" : "auto",
      });
    } else {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }, [currentSession.id, currentSession.messages, isAgentRunning]);

  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const hasUserInteraction = currentSession.messages.some((message) => message.role === "user");
  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);
  const flowTopology = useMemo(
    () => (topologySnapshot && !isEmptyTopologySnapshot(topologySnapshot)
      ? topologySnapshotToReactFlow(topologySnapshot)
      : undefined),
    [topologySnapshot],
  );
  const selectedNode = selectedTopologyItem?.kind === "node"
    ? topologySnapshot?.nodes.find((node) => String(node.imac) === selectedTopologyItem.id)
    : undefined;
  const selectedLink = selectedTopologyItem?.kind === "link"
    ? topologySnapshot?.links.find((link) => linkRowId(link) === selectedTopologyItem.id)
    : undefined;
  const selectedLinkSourceNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.srcImac)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.dstImac)
    : undefined;
  const switchCount = topologySnapshot ? countSwitches(topologySnapshot) : 0;
  const endSystemCount = topologySnapshot ? countEndSystems(topologySnapshot) : 0;
  const linkCount = topologySnapshot?.links.length ?? 0;

  useEffect(() => {
    if (!topologySnapshot || !selectedTopologyItem) {
      return;
    }

    const stillExists = selectedTopologyItem.kind === "node"
      ? topologySnapshot.nodes.some((node) => String(node.imac) === selectedTopologyItem.id)
      : topologySnapshot.links.some((link) => linkRowId(link) === selectedTopologyItem.id);

    if (!stillExists) {
      setSelectedTopologyItem(undefined);
    }
  }, [topologySnapshot, selectedTopologyItem]);

  async function persistSession(nextSession: TsnSession) {
    await repository.save(nextSession);
    logDiagnostic(diagnosticsRepository, {
      sessionId: nextSession.id,
      category: "session",
      message: "会话已保存",
      details: sessionSummary(nextSession),
    });
    setCurrentSession(nextSession);
    setSessions(await repository.list());
  }

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
    setIsAgentRunning(true);
    setAgentRunPhase("connecting");
    setAgentRunStartedAt(Date.now());
    setAgentRunElapsedSeconds(0);
    setLastAgentChunkAt(undefined);
    setPendingAssistantMessageId(assistantMessage.id);
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
      setSessions(await repository.list());

      const result = await runTsnAgent({
        userIntent: trimmedInput,
        session: contextSession,
        diagnostics: diagnosticsRepository,
        onChunk: (chunk) => {
          streamedText += chunk;
          setAgentRunPhase("streaming");
          setLastAgentChunkAt(Date.now());
          setPendingAssistantMessageId(undefined);
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
      setSessions(await repository.list());
    } catch (error) {
      setInput(trimmedInput);
      setPendingAssistantMessageId(undefined);
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
      setPendingAssistantMessageId(undefined);
      setAgentRunPhase("idle");
      setAgentRunStartedAt(undefined);
      setAgentRunElapsedSeconds(0);
      setLastAgentChunkAt(undefined);
      setIsAgentRunning(false);
    }
  }

  async function sessionExists(sessionId: string) {
    return (await repository.list()).some((session) => session.id === sessionId);
  }

  function updateAssistantMessage(sessionId: string, messageId: string, content: string) {
    setCurrentSession((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      return {
        ...session,
        messages: session.messages.map((message) =>
          message.id === messageId ? { ...message, content } : message,
        ),
      };
    });
  }

  async function handleNewSession() {
    const session = createEmptySession();
    await persistSession(session);
    logDiagnostic(diagnosticsRepository, {
      sessionId: session.id,
      category: "session",
      message: "新建会话",
      details: sessionSummary(session),
    });
    setInput("我需要4个交换机，每个交换机连接5个端系统");
    setActiveWorkspacePanel(undefined);
  }

  async function handleSelectSession(session: TsnSession) {
    await repository.setCurrent(session.id);
    logDiagnostic(diagnosticsRepository, {
      sessionId: session.id,
      category: "session",
      message: "切换到会话",
      details: sessionSummary(session),
    });
    setCurrentSession(session);
    setActiveWorkspacePanel(undefined);
  }

  async function handleDuplicateSession() {
    const duplicated = await repository.duplicate(currentSession.id);

    if (duplicated) {
      logDiagnostic(diagnosticsRepository, {
        sessionId: duplicated.id,
        category: "session",
        message: "复制会话",
        details: {
          sourceSessionId: currentSession.id,
          ...sessionSummary(duplicated),
        },
      });
      setCurrentSession(duplicated);
      setSessions(await repository.list());
      setActiveWorkspacePanel(undefined);
    }
  }

  async function handleDeleteSession() {
    const deletedSessionId = currentSession.id;
    await repository.remove(currentSession.id);
    await diagnosticsRepository.clearSession(deletedSessionId);
    const nextSession = await repository.ensureCurrentSession();
    logDiagnostic(diagnosticsRepository, {
      sessionId: nextSession.id,
      category: "session",
      message: "删除会话并切换",
      details: {
        deletedSessionId,
        nextSessionId: nextSession.id,
      },
    });
    setCurrentSession(nextSession);
    setSessions(await repository.list());
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
        <WorkspaceToolRail
          activePanel={activeWorkspacePanel}
          onSelectPanel={(panel) => setActiveWorkspacePanel((current) => (current === panel ? undefined : panel))}
        />
        {activeWorkspacePanel && (
          <WorkspaceToolDrawer
            activePanel={activeWorkspacePanel}
            currentSession={currentSession}
            diagnosticsRepository={diagnosticsRepository}
            sessions={sessions}
            onClose={() => setActiveWorkspacePanel(undefined)}
            onDeleteSession={handleDeleteSession}
            onDuplicateSession={handleDuplicateSession}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
          />
        )}
        <section className="chat-pane" aria-label="对话区">
          <div className="project-strip">
            <span className="project-name">当前规划</span>
            <span className="env-badge mono">{scenarioConfig.displayName}</span>
          </div>

          {/* Phase B-α (plan v3 U9c)：流量规划暂下线告知 banner。具体回归版本号由 boss
              在 Phase B release 时确定后填入；保留 v0.X 占位以便 grep 替换。 */}
          <div
            className="phase-b-banner"
            role="note"
            aria-live="polite"
          >
            流量规划与规划导出在当前版本暂时下线，预计 v0.X 随 Phase B 回归。
          </div>

          <div className="chat-stepper" aria-label="配置步骤">
            {(["topology", "time-sync", "flow-template", "planning-export"] as const).map((step, index, steps) => {
              // Phase B-α：flow-template / planning-export 阶段 aria-disabled + tooltip
              const isFlowStage = step === "flow-template" || step === "planning-export";
              return (
                <Fragment key={step}>
                  <Step
                    index={`${index + 1}`}
                    label={scenarioConfig.stageLabels[step]}
                    status={workflow.stages[step].status}
                    disabled={isFlowStage}
                    disabledReason={isFlowStage ? "流量规划与规划导出在当前版本暂时下线，预计 v0.X 回归" : undefined}
                  />
                  {index < steps.length - 1 && (
                    <span className={workflow.stages[step].status === "confirmed" ? "stepper-conn active" : "stepper-conn"} />
                  )}
                </Fragment>
              );
            })}
          </div>

          <div className="messages" aria-live="polite" ref={messagesContainerRef}>
            {currentSession.messages.map((message) => (
              <article
                className={[
                  message.role === "user" ? "msg-user" : "msg-agent",
                  message.id === pendingAssistantMessageId ? "pending" : "",
                ].filter(Boolean).join(" ")}
                key={message.id}
              >
                <span className="message-role">{message.role === "user" ? "USER" : "AGENT"}</span>
                {message.id === pendingAssistantMessageId ? (
                  <AgentWaitingIndicator />
                ) : (
                  <p>{message.role === "assistant" ? redactProviderNamesForDisplay(message.content) : message.content}</p>
                )}
              </article>
            ))}
          </div>

          <div className="composer">
            <label htmlFor="intent">描述你的 TSN 需求</label>
            {currentStage.status === "waiting_confirmation" && (
              <div className="stage-confirmation" role="status">
                <div>
                  <strong>{scenarioConfig.stageLabels[workflow.currentStep]}等待确认</strong>
                  <p>{currentStage.summary}</p>
                </div>
                <button className="btn-primary" type="button" onClick={() => submitIntent("继续")} disabled={isAgentRunning}>
                  确认并继续
                </button>
              </div>
            )}
            <div className="composer-box">
              <textarea
                id="intent"
                aria-label="输入你的 TSN 需求"
                value={input}
                placeholder={INTENT_PLACEHOLDER}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
              />
              <button type="button" aria-label="生成规划草案" onClick={handleSubmit} disabled={isAgentRunning || !input.trim()}>
                <TelegramSendIcon />
              </button>
            </div>
          </div>
        </section>

        <section className="workspace-pane" aria-label="工程状态">
          <div className="topology-stage grid-bg">
            <div className="topology-meta mono">TSN PROJECT DB · REACT FLOW</div>
            <div className="topology-stats" aria-label="拓扑统计">
              <Stat label="交换机" value={switchCount} />
              <Stat label="端系统" value={endSystemCount} />
              <Stat label="链路" value={linkCount} />
            </div>
            <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
              {flowTopology ? (
                <ReactFlow
                  nodes={flowTopology.nodes}
                  edges={flowTopology.edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  onNodeClick={handleNodeSelect}
                  onEdgeClick={handleLinkSelect}
                >
                  <Background />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : (
                <div className="topology-empty mono">
                  {isAgentRunning
                    ? "正在生成拓扑图"
                    : hasUserInteraction
                      ? "拓扑生成后在这里显示"
                      : "描述你的 TSN 需求后生成拓扑图"}
                </div>
              )}
            </div>
          </div>

          <div className="config-panel">
            <div className="config-tabs" role="tablist" aria-label="工程详情">
              {CONFIG_TABS.map((tab) => (
                <button
                  className={activeConfigTab === tab.id ? "config-tab active" : "config-tab"}
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeConfigTab === tab.id}
                  aria-controls={`config-panel-${tab.id}`}
                  id={`config-tab-${tab.id}`}
                  onClick={() => setActiveConfigTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              <div className="config-spacer" />
              <span className="config-state mono">配置 · {hasTopology ? "草案" : "未生成"}</span>
            </div>

            <div className="config-body">
              {activeConfigTab === "node-detail" && (
                <section
                  className="detail-panel"
                  id="config-panel-node-detail"
                  role="tabpanel"
                  aria-label="节点详情"
                >
                <div className="panel-heading">
                  <div>
                    <h2>节点详情</h2>
                    <p>{selectedNode ? nodeRowLabel(selectedNode) : "在拓扑画布选择一个节点查看类型、地址和位置。"}</p>
                  </div>
                </div>
                {selectedNode ? (
                  <div className="detail-grid">
                    <DetailRow label="IMAC" value={selectedNode.imac} />
                    <DetailRow label="同步名称" value={selectedNode.syncName} />
                    <DetailRow label="类型" value={selectedNode.nodeType === "switch" ? "交换机" : "端系统"} />
                    <DetailRow label="坐标" value={`${selectedNode.x}, ${selectedNode.y}`} />
                    <DetailRow label="插入顺序" value={selectedNode.insertOrder} />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的节点</div>
                )}
              </section>
              )}

              {activeConfigTab === "link-detail" && (
                <section
                  className="detail-panel"
                  id="config-panel-link-detail"
                  role="tabpanel"
                  aria-label="链路详情"
                >
                <div className="panel-heading">
                  <div>
                    <h2>链路详情</h2>
                    <p>{selectedLink ? linkRowId(selectedLink) : "在拓扑画布选择一条链路查看端点。"}</p>
                  </div>
                </div>
                {selectedLink ? (
                  <div className="detail-grid">
                    <DetailRow label="链路序号" value={selectedLink.linkSeq} />
                    <DetailRow label="名称" value={selectedLink.name ?? "无"} />
                    <DetailRow
                      label="源端点"
                      value={selectedLinkSourceNode ? nodeRowLabel(selectedLinkSourceNode) : `imac ${selectedLink.srcImac}`}
                    />
                    <DetailRow
                      label="目标端点"
                      value={selectedLinkTargetNode ? nodeRowLabel(selectedLinkTargetNode) : `imac ${selectedLink.dstImac}`}
                    />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的链路</div>
                )}
              </section>
              )}

              {activeConfigTab === "steps" && (
                <section
                  className="steps-panel"
                  id="config-panel-steps"
                  role="tabpanel"
                  aria-label="执行步骤"
                >
                <div className="panel-heading">
                  <h2>执行步骤</h2>
                </div>
                <ol className="event-list">
                  {currentSession.agentEvents.map((event, index) => (
                    <li className={event.kind} key={`${event.id}-${index}`}>
                      <span>{redactProviderNamesForDisplay(event.skillName ?? event.title)}</span>
                      <p>{redactProviderNamesForDisplay(event.content)}</p>
                    </li>
                  ))}
                  {currentSession.agentEvents.length === 0 && <li className="empty-step">等待 Agent 输出</li>}
                </ol>
              </section>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: snapshot.nodes.map((node) => ({
      id: String(node.imac),
      type: "tsnNode",
      position: { x: node.x, y: node.y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: nodeRowLabel(node),
        nodeType: node.nodeType === "switch" ? "switch" : "endSystem",
        imac: node.imac,
      },
    })),
    edges: snapshot.links.map((link) => ({
      id: linkRowId(link),
      source: String(link.srcImac),
      target: String(link.dstImac),
    })),
  };
}

function nodeRowLabel(node: TopologyNodeRow): string {
  const prefix = node.nodeType === "switch" ? "SW" : "ES";
  return `${prefix}-${node.syncName}`;
}

function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}

function WorkspaceToolRail({
  activePanel,
  onSelectPanel,
}: {
  activePanel?: WorkspaceToolPanel;
  onSelectPanel: (panel: WorkspaceToolPanel) => void;
}) {
  const tools: Array<{ id: WorkspaceToolPanel; label: string; icon: typeof FolderOpen }> = [
    { id: "sessions", label: "会话", icon: FolderOpen },
    { id: "diagnostics", label: "执行日志", icon: ScrollText },
    { id: "skills", label: "Skill", icon: Wrench },
    { id: "settings", label: "设置", icon: Settings },
  ];

  return (
    <nav className="workspace-tool-rail" aria-label="工作台工具">
      {tools.map((tool) => {
        const Icon = tool.icon;

        return (
          <button
            className={activePanel === tool.id ? "workspace-tool-button active" : "workspace-tool-button"}
            key={tool.id}
            type="button"
            aria-pressed={activePanel === tool.id}
            onClick={() => onSelectPanel(tool.id)}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{tool.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function WorkspaceToolDrawer({
  activePanel,
  currentSession,
  diagnosticsRepository,
  sessions,
  onClose,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
}: {
  activePanel: WorkspaceToolPanel;
  currentSession: TsnSession;
  diagnosticsRepository: DiagnosticLogRepository;
  sessions: TsnSession[];
  onClose: () => void;
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
}) {
  return (
    <aside className="workspace-tool-drawer" aria-label={workspacePanelLabel(activePanel)}>
      <div className="drawer-header">
        <div>
          <p className="drawer-kicker">{workspacePanelKicker(activePanel)}</p>
          <h2>{workspacePanelLabel(activePanel)}</h2>
        </div>
        <button className="icon-button" type="button" aria-label={`关闭${workspacePanelLabel(activePanel)}`} onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {activePanel === "sessions" && (
        <SessionToolPanel
          currentSession={currentSession}
          sessions={sessions}
          onDeleteSession={onDeleteSession}
          onDuplicateSession={onDuplicateSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
        />
      )}
      {activePanel === "diagnostics" && (
        <DiagnosticsLogView sessionId={currentSession.id} repository={diagnosticsRepository} />
      )}
      {activePanel === "skills" && <SkillToolPanel currentSession={currentSession} />}
      {activePanel === "settings" && <SettingsToolPanel version={appVersion} releases={releaseNotes} />}
    </aside>
  );
}

function SessionToolPanel({
  currentSession,
  sessions,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
}: {
  currentSession: TsnSession;
  sessions: TsnSession[];
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
}) {
  return (
    <>
      <button className="new-session-button" type="button" onClick={onNewSession}>
        <Plus size={16} aria-hidden="true" />
        新建会话
      </button>

      <div className="session-list" aria-label="最近会话">
        {sessions.map((session) => (
          <button
            className={session.id === currentSession.id ? "session-item active" : "session-item"}
            key={session.id}
            type="button"
            onClick={() => onSelectSession(session)}
          >
            <div className="session-row1">
              <span className="session-title">{session.title}</span>
              <span className="session-time">{formatTime(session.updatedAt)}</span>
            </div>
            <p className="session-desc">{session.messages.at(-1)?.content ?? "暂无对话"}</p>
            <span className={session.topologyMutationId ? "badge planned" : "badge draft"}>
              <span className="badge-dot" />
              {session.topologyMutationId ? "配置草案" : "空会话"}
            </span>
          </button>
        ))}
      </div>

      <div className="drawer-actions">
        <button className="btn" type="button" onClick={onDuplicateSession}>
          <Copy size={15} aria-hidden="true" />
          复制当前
        </button>
        <button className="btn danger" type="button" onClick={onDeleteSession}>
          <Trash2 size={15} aria-hidden="true" />
          删除当前
        </button>
      </div>
    </>
  );
}

function SkillToolPanel({ currentSession }: { currentSession: TsnSession }) {
  const [selectedSkillId, setSelectedSkillId] = useState(SKILL_CATALOG[0]?.id);
  const selectedSkill = SKILL_CATALOG.find((skill) => skill.id === selectedSkillId) ?? SKILL_CATALOG[0];
  const recentEvent = selectedSkill
    ? [...currentSession.agentEvents]
      .reverse()
      .find((event) => event.skillName === selectedSkill.id || event.stage === selectedSkill.stage)
    : undefined;

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">
        查看当前工作台可调用的 TSN 阶段能力，并预览已注册 skill 的本地文件。
      </p>
      <div className="master-detail-layout skill-detail-layout">
        <div className="master-list" aria-label="Skill 列表">
          {SKILL_CATALOG.map((skill) => (
            <button
              className={selectedSkill?.id === skill.id ? "master-list-item active" : "master-list-item"}
              key={skill.id}
              type="button"
              aria-selected={selectedSkill?.id === skill.id}
              onClick={() => setSelectedSkillId(skill.id)}
            >
              <span className="tool-card-label mono">{skill.id}</span>
              <strong>{skill.displayName}</strong>
              <small>{skill.stageLabel}</small>
            </button>
          ))}
        </div>

        <section className="detail-surface skill-detail" aria-label="Skill 详情">
          {selectedSkill ? (
            <>
              <div className="detail-surface-header">
                <div>
                  <p className="drawer-kicker">Skill Detail</p>
                  <h3>{selectedSkill.displayName}</h3>
                </div>
                <span className={`skill-status ${selectedSkill.status}`}>{skillStatusLabel(selectedSkill.status)}</span>
              </div>

              <p className="detail-description">{selectedSkill.description}</p>
              <SkillFilePreview skillId={selectedSkill.id} />
              <div className="detail-grid">
                <DetailRow label="Skill ID" value={selectedSkill.id} />
                <DetailRow label="阶段" value={selectedSkill.stageLabel} />
                <DetailRow label="输入" value={selectedSkill.inputSummary} />
                <DetailRow label="输出" value={selectedSkill.outputSummary} />
                <DetailRow
                  label="最近运行"
                  value={recentEvent
                    ? `${redactProviderNamesForDisplay(recentEvent.title)} · ${formatTime(recentEvent.createdAt ?? currentSession.updatedAt)}`
                    : "当前会话暂无记录"}
                />
                <DetailRow label="备注" value={selectedSkill.notes || "无"} />
              </div>
            </>
          ) : (
            <div className="empty-panel mono">请选择一个 skill</div>
          )}
        </section>
      </div>
    </div>
  );
}

function SettingsToolPanel({ version, releases }: { version: string; releases: ReleaseNote[] }) {
  const defaultSelectedVersion = releases.find((release) => release.version === version)?.version ?? releases[0]?.version;
  const [selectedVersion, setSelectedVersion] = useState(defaultSelectedVersion);
  const selectedRelease = releases.find((release) => release.version === selectedVersion) ?? releases[0];

  useEffect(() => {
    setSelectedVersion(defaultSelectedVersion);
  }, [defaultSelectedVersion]);

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">集中管理工作台运行参数、版本号和客户可见的更新内容。</p>
      <div className="settings-list" aria-label="工作台设置">
        <DetailRow label="当前版本" value={`v${version}`} />
        <DetailRow label="默认规划服务" value={resolvePlannerBaseUrl()} />
        <DetailRow label="会话存储" value={window.__TAURI_INTERNALS__ ? "本机数据库" : "浏览器 localStorage"} />
        <DetailRow label="导出模式" value={window.__TAURI_INTERNALS__ ? "桌面文件系统" : "浏览器预览"} />
      </div>

      <section className="settings-release-panel" aria-label="更新日志">
        <div className="detail-surface-header">
          <div>
            <p className="drawer-kicker">Release Notes</p>
            <h3>更新日志</h3>
          </div>
        </div>
        {releases.length > 0 ? (
          <div className="master-detail-layout release-detail-layout">
            <div className="master-list release-version-list" aria-label="版本列表">
              {releases.map((release) => (
                <button
                  className={selectedRelease?.version === release.version ? "master-list-item active" : "master-list-item"}
                  key={release.version}
                  type="button"
                  aria-selected={selectedRelease?.version === release.version}
                  onClick={() => setSelectedVersion(release.version)}
                >
                  <span className="release-version mono">v{release.version}</span>
                  <strong>{release.version === version ? "当前版本" : `版本 ${release.version}`}</strong>
                  {release.date && <small>{release.date}</small>}
                </button>
              ))}
            </div>
            <ReleaseNoteDetail version={version} release={selectedRelease} />
          </div>
        ) : (
          <div className="empty-panel mono">暂无可展示的更新内容</div>
        )}
      </section>
    </div>
  );
}

function workspacePanelLabel(panel: WorkspaceToolPanel): string {
  const labels: Record<WorkspaceToolPanel, string> = {
    sessions: "会话管理",
    diagnostics: "执行日志",
    skills: "Skill 能力",
    settings: "工作台设置",
  };

  return labels[panel];
}

function workspacePanelKicker(panel: WorkspaceToolPanel): string {
  const labels: Record<WorkspaceToolPanel, string> = {
    sessions: "Sessions",
    diagnostics: "Diagnostics",
    skills: "Skills",
    settings: "Settings",
  };

  return labels[panel];
}

function ReleaseNoteDetail({ version, release }: { version: string; release?: ReleaseNote }) {
  if (!release) {
    return <div className="empty-panel mono">暂无可展示的更新内容</div>;
  }

  return (
    <article className="detail-surface release-note-detail" aria-label={`v${release.version} 更新内容`}>
      <div className="release-note-header">
        <div>
          <span className="release-version mono">v{release.version}</span>
          <h3>{release.version === version ? "当前版本" : `版本 ${release.version}`}</h3>
        </div>
        {release.date && <time dateTime={release.date}>{release.date}</time>}
      </div>
      <div className="release-category-list">
        {release.categories.map((category) => (
          <section className="release-category" key={`${release.version}-${category.title}`}>
            <h4>{category.title}</h4>
            <ul>
              {category.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

function skillStatusLabel(status: SkillCatalogItem["status"]): string {
  const labels: Record<SkillCatalogItem["status"], string> = {
    enabled: "已启用",
    draft: "草稿",
    disabled: "已停用",
  };

  return labels[status];
}

function Step({
  index,
  label,
  status,
  disabled,
  disabledReason,
}: {
  index: string;
  label: string;
  status: "locked" | "current" | "waiting_confirmation" | "confirmed" | "error";
  /** Phase B-α (plan v3 U9c)：标记暂下线阶段（flow-template / planning-export）。 */
  disabled?: boolean;
  /** tooltip 文案，鼠标 hover + screen reader 都可以读。 */
  disabledReason?: string;
}) {
  const className = status === "confirmed" ? "passed" : status;

  return (
    <div
      className={`stepper-item ${className}${disabled ? " disabled" : ""}`}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
    >
      <span className="si-num">{index}</span>
      <span className="si-label">{label}</span>
    </div>
  );
}

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    imac?: number;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">imac {nodeData.imac}</small>
    </div>
  );
}

function AgentWaitingIndicator() {
  return (
    <div className="agent-waiting" role="status" aria-live="polite">
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>正在连接智能助手，并结合当前会话上下文生成下一步规划</span>
    </div>
  );
}

function AgentRunStatusBar({ elapsedSeconds, phase }: { elapsedSeconds: number; phase: AgentRunPhase }) {
  const message = getAgentRunStatusMessage(phase);

  return (
    <div className={`agent-run-status ${phase}`} role="status" aria-live="polite" data-testid="agent-run-status">
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{message}</span>
      <span className="agent-run-elapsed mono">已运行 {elapsedSeconds} 秒</span>
    </div>
  );
}

function getAgentRunStatusMessage(phase: AgentRunPhase): string {
  if (phase === "waiting") {
    return "智能助手仍在处理，可能正在等待工具或子任务返回";
  }

  if (phase === "streaming") {
    return "智能助手正在持续推理，结果会继续更新";
  }

  return "智能助手正在连接并准备当前会话上下文";
}

function TelegramSendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="telegram-send-icon"
    >
      <path
        fill="currentColor"
        d="M20.68 4.44c.42-.18.85.18.73.62l-3.78 14.18c-.11.41-.61.57-.95.31l-5.38-4.02-2.76 2.66c-.29.28-.78.13-.86-.27l-.95-4.73-4.36-1.36c-.44-.14-.48-.76-.06-.96L20.68 4.44Z"
      />
      <path
        fill="var(--accent)"
        d="M8.92 12.95 17.8 7.4c.18-.11.36.13.21.28l-7.32 7.04-.29 2.73-1.48-4.5Z"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="stat-pill">
      <span>{label}</span>
      <strong>
        {label} {value}
      </strong>
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function truncateSessionTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > SESSION_TITLE_MAX_CHARS
    ? `${collapsed.slice(0, SESSION_TITLE_MAX_CHARS)}…`
    : collapsed;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
