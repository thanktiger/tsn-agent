import { Fragment, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  ScrollText,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { runTsnAgent } from "../agent/agent-adapter";
import {
  artifactBundleSummary,
  logDiagnostic,
  sessionSummary,
  userIntentPreview,
} from "../diagnostics/app-diagnostics";
import {
  createDiagnosticLogRepository,
  type DiagnosticLogRepository,
} from "../diagnostics/diagnostic-log-repository";
import { DiagnosticsLogView } from "../ui/diagnostics/DiagnosticsDrawer";
import { redactProviderNamesForDisplay } from "../ui/display-redaction";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createArtifactBundle } from "../export/artifact-bundle";
import { exportReactFlowTopology } from "../export/react-flow-exporter";
import { getScenarioConfig } from "../domain/scenario-config";
import {
  exportProjectBundle,
  openProjectExportDirectory,
  selectProjectExportDirectory,
  suggestProjectExportDirectory,
  type ProjectExportResult,
} from "../project/project-exporter";
import {
  createEmptySession,
  createId,
  createSessionRepository,
  type ChatMessage,
  type SessionRepository,
  type TsnSession,
} from "../sessions/session-repository";
import tsnAgentMark from "../assets/tsn-agent-mark.svg";

const repository: SessionRepository = createSessionRepository();
const diagnosticsRepository: DiagnosticLogRepository = createDiagnosticLogRepository();
const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前会话上下文生成下一步规划...";

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

type ConfigTabId = "flows" | "node-detail" | "link-detail" | "artifacts" | "steps";

type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "flows", label: "流量列表" },
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
  { id: "artifacts", label: "导出文件" },
  { id: "steps", label: "执行步骤" },
];

export function App() {
  const initialSession = useMemo(() => createEmptySession(), []);
  const [sessions, setSessions] = useState<TsnSession[]>([initialSession]);
  const [currentSession, setCurrentSession] = useState<TsnSession>(initialSession);
  const [input, setInput] = useState("我需要4个交换机，每个交换机连接5个端系统");
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [pendingAssistantMessageId, setPendingAssistantMessageId] = useState<string | undefined>();
  const [exportResult, setExportResult] = useState<ProjectExportResult | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const [exportDirectory, setExportDirectory] = useState("");
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("flows");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<SelectedTopologyItem | undefined>();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>();

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
    let cancelled = false;

    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);

    async function loadSuggestedExportDirectory() {
      try {
        const suggestedDirectory = await suggestProjectExportDirectory({ sessionId: currentSession.id });

        if (!cancelled && suggestedDirectory) {
          setExportDirectory(suggestedDirectory);
        }
      } catch {
        // Browser mode does not have a native project directory suggestion.
      }
    }

    void loadSuggestedExportDirectory();

    return () => {
      cancelled = true;
    };
  }, [currentSession.id]);

  useEffect(() => {
    setActiveConfigTab("flows");
    setSelectedTopologyItem(undefined);
    setSelectedFlowId(undefined);
  }, [currentSession.id]);

  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const workflow = currentSession.workflow;
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const currentStage = workflow.stages[workflow.currentStep];
  const hasUserInteraction = currentSession.messages.some((message) => message.role === "user");
  const canExport = Boolean(bundle && workflow.currentStep === "planning-export");
  const canRefreshBundle = Boolean(
    project
      && workflow.currentStep === "planning-export"
      && ["waiting_confirmation", "confirmed"].includes(workflow.stages["planning-export"].status),
  );
  const isFlowStageVisible = workflow.stages["flow-template"].status === "waiting_confirmation"
    || workflow.stages["flow-template"].status === "confirmed";
  const visibleFlows = isFlowStageVisible ? project?.flows ?? [] : [];
  const selectedFlow = visibleFlows.find((flow) => flow.id === selectedFlowId);
  const flowTopology = useMemo(() => {
    if (!project) {
      return undefined;
    }

    const topology = exportReactFlowTopology(project);

    if (!selectedFlow) {
      return topology;
    }

    const routeNodeIds = new Set(selectedFlow.routeNodeIds);
    const routeLinkIds = new Set(selectedFlow.routeLinkIds);
    const routeEdgeDirections = new Map(
      selectedFlow.routeLinkIds.map((linkId, index) => [
        linkId,
        {
          source: selectedFlow.routeNodeIds[index],
          target: selectedFlow.routeNodeIds[index + 1],
        },
      ]),
    );

    return {
      ...topology,
      nodes: topology.nodes.map((node) => ({
        ...node,
        className: routeNodeIds.has(node.id) ? "flow-highlighted" : "flow-muted",
        data: {
          ...node.data,
          highlightedByFlow: routeNodeIds.has(node.id),
        },
      })),
      edges: topology.edges.map((edge) => ({
        ...edge,
        ...(routeEdgeDirections.get(edge.id) ?? {}),
        animated: routeLinkIds.has(edge.id),
        className: routeLinkIds.has(edge.id) ? "flow-highlighted" : "flow-muted",
      })),
    };
  }, [project, selectedFlow]);
  const selectedNode = selectedTopologyItem?.kind === "node"
    ? project?.topology.nodes.find((node) => node.id === selectedTopologyItem.id)
    : undefined;
  const selectedLink = selectedTopologyItem?.kind === "link"
    ? project?.topology.links.find((link) => link.id === selectedTopologyItem.id)
    : undefined;
  const selectedLinkSourceNode = selectedLink
    ? project?.topology.nodes.find((node) => node.id === selectedLink.source.nodeId)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? project?.topology.nodes.find((node) => node.id === selectedLink.target.nodeId)
    : undefined;
  const switchCount = project?.topology.nodes.filter(isSwitch).length ?? 0;
  const endSystemCount = project?.topology.nodes.filter(isEndSystem).length ?? 0;
  const linkCount = project?.topology.links.length ?? 0;
  const flowCount = visibleFlows.length;

  useEffect(() => {
    if (!project || !selectedTopologyItem) {
      return;
    }

    const stillExists = selectedTopologyItem.kind === "node"
      ? project.topology.nodes.some((node) => node.id === selectedTopologyItem.id)
      : project.topology.links.some((link) => link.id === selectedTopologyItem.id);

    if (!stillExists) {
      setSelectedTopologyItem(undefined);
    }
  }, [project, selectedTopologyItem]);

  useEffect(() => {
    if (!selectedFlowId || visibleFlows.some((flow) => flow.id === selectedFlowId)) {
      return;
    }

    setSelectedFlowId(undefined);
  }, [selectedFlowId, visibleFlows]);

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
    const pendingSession: TsnSession = {
      ...contextSession,
      updatedAt: now,
      messages: [...contextSession.messages, userMessage, assistantMessage],
    };
    let streamedText = "";

    setInput((value) => (value.trim() === trimmedInput ? "" : value));
    setIsAgentRunning(true);
    setPendingAssistantMessageId(assistantMessage.id);
    setExportResult(undefined);
    setExportError(undefined);
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
          setPendingAssistantMessageId(undefined);
          updateAssistantMessage(pendingSession.id, assistantMessage.id, redactProviderNamesForDisplay(streamedText));
        },
      });
      const completedAt = new Date().toISOString();
      const nextSession: TsnSession = {
        ...pendingSession,
        title: result.project.name,
        updatedAt: completedAt,
        messages: pendingSession.messages.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: redactProviderNamesForDisplay(result.assistantText) }
            : message,
        ),
        claudeSessionId: result.claudeSessionId ?? pendingSession.claudeSessionId,
        agentEvents: [...pendingSession.agentEvents, ...stampAgentEvents(result.events, completedAt)],
        workflow: result.workflow,
        project: result.project,
        bundle: result.bundle,
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
      if (result.bundle) {
        logDiagnostic(diagnosticsRepository, {
          sessionId: nextSession.id,
          category: "artifact",
          message: "artifact bundle 已生成",
          details: artifactBundleSummary(result.bundle),
        });
      }
      setCurrentSession((session) => (session.id === nextSession.id ? nextSession : session));
      setSessions(await repository.list());
    } catch (error) {
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
    setIsSessionOpen(false);
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
    setIsSessionOpen(false);
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
      setExportDirectory("");
      setExportResult(undefined);
      setExportError(undefined);
      setSessions(await repository.list());
      setIsSessionOpen(false);
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
    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);
    setSessions(await repository.list());
    setIsSessionOpen(false);
  }

  async function refreshBundle() {
    if (!project || !canRefreshBundle) {
      return;
    }

    const nextBundle = createArtifactBundle(project);

    logDiagnostic(diagnosticsRepository, {
      sessionId: currentSession.id,
      category: "artifact",
      message: "刷新 artifact bundle",
      details: artifactBundleSummary(nextBundle),
    });

    await persistSession({
      ...currentSession,
      updatedAt: new Date().toISOString(),
      bundle: nextBundle,
      workflow,
    });
  }

  async function handleExportProject() {
    if (!bundle || !canExport) {
      return;
    }

    setExportError(undefined);

    try {
      const outputDir = exportDirectory.trim() || undefined;
      const result = await exportProjectBundle(bundle, outputDir);

      setExportResult(result);
      logDiagnostic(diagnosticsRepository, {
        sessionId: currentSession.id,
        category: "artifact",
        message: "项目文件已导出",
        details: {
          mode: result.mode,
          outputDir: result.outputDir,
          writtenFiles: result.writtenFiles,
        },
      });
    } catch (error) {
      const message = normalizeError(error);
      setExportError(message);
      logDiagnostic(diagnosticsRepository, {
        sessionId: currentSession.id,
        category: "artifact",
        level: "error",
        message: "项目文件导出失败",
        details: {
          error: message,
        },
      });
    }
  }

  async function handleChooseExportDirectory() {
    try {
      const selectedDirectory = await selectProjectExportDirectory(exportDirectory || undefined);

      if (selectedDirectory) {
        setExportDirectory(selectedDirectory);
        setExportError(undefined);
      }
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }

  async function handleOpenExportDirectory() {
    if (!exportResult) {
      return;
    }

    try {
      await openProjectExportDirectory(exportResult.outputDir);
    } catch (error) {
      setExportError(normalizeError(error));
    }
  }

  function handleNodeSelect(_event: unknown, node: Node) {
    setSelectedTopologyItem({ kind: "node", id: node.id });
    setActiveConfigTab("node-detail");
  }

  function handleLinkSelect(_event: unknown, edge: Edge) {
    setSelectedTopologyItem({ kind: "link", id: edge.id });
    setActiveConfigTab("link-detail");
  }

  function handleFlowSelect(flowId: string) {
    setSelectedFlowId((currentFlowId) => (currentFlowId === flowId ? undefined : flowId));
  }

  return (
    <div className="app-shell">
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">TSN Agent</h1>
        <span className="brand-ver">VER 0.1.0</span>
        <span className={project ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {project ? "草案已生成" : "草稿"}
        </span>
        <div className="brand-spacer" />
        <button className="btn btn-session" type="button" onClick={() => setIsSessionOpen(true)}>
          <FolderOpen size={15} aria-hidden="true" />
          会话
        </button>
        <button className="btn btn-session" type="button" onClick={() => setIsDiagnosticsOpen(true)}>
          <ScrollText size={15} aria-hidden="true" />
          日志
        </button>
      </header>

      {isSessionOpen && (
        <div className="session-overlay" role="presentation" onMouseDown={() => setIsSessionOpen(false)}>
          <aside
            className="session-drawer"
            aria-label="会话管理"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <p className="drawer-kicker">Sessions</p>
                <h2>会话列表</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭会话列表" onClick={() => setIsSessionOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <button className="new-session-button" type="button" onClick={handleNewSession}>
              <Plus size={16} aria-hidden="true" />
              新建会话
            </button>

            <div className="session-list" aria-label="最近会话">
              {sessions.map((session) => (
                <button
                  className={session.id === currentSession.id ? "session-item active" : "session-item"}
                  key={session.id}
                  type="button"
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="session-row1">
                    <span className="session-title">{session.title}</span>
                    <span className="session-time">{formatTime(session.updatedAt)}</span>
                  </div>
                  <p className="session-desc">{session.messages.at(-1)?.content ?? "暂无对话"}</p>
                  <span className={session.project ? "badge planned" : "badge draft"}>
                    <span className="badge-dot" />
                    {session.project ? "配置草案" : "空会话"}
                  </span>
                </button>
              ))}
            </div>

            <div className="drawer-actions">
              <button className="btn" type="button" onClick={handleDuplicateSession}>
                <Copy size={15} aria-hidden="true" />
                复制当前
              </button>
              <button className="btn danger" type="button" onClick={handleDeleteSession}>
                <Trash2 size={15} aria-hidden="true" />
                删除当前
              </button>
            </div>
          </aside>
        </div>
      )}

      {isDiagnosticsOpen && (
        <div className="session-overlay" role="presentation" onMouseDown={() => setIsDiagnosticsOpen(false)}>
          <aside
            className="session-drawer diagnostics-drawer"
            aria-label="诊断日志"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <p className="drawer-kicker">Diagnostics</p>
                <h2>诊断日志</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭诊断日志" onClick={() => setIsDiagnosticsOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <DiagnosticsLogView sessionId={currentSession.id} repository={diagnosticsRepository} />
          </aside>
        </div>
      )}

      <main className="project-layout">
        <section className="chat-pane" aria-label="对话区">
          <div className="project-strip">
            <span className="project-name">当前规划</span>
            <span className="env-badge mono">
              {project ? `canonical=v0 · ${scenarioConfig.displayName}` : scenarioConfig.displayName}
            </span>
          </div>

          <div className="chat-stepper" aria-label="配置步骤">
            {(["topology", "time-sync", "flow-template", "planning-export"] as const).map((step, index, steps) => (
              <Fragment key={step}>
                <Step index={`${index + 1}`} label={scenarioConfig.stageLabels[step]} status={workflow.stages[step].status} />
                {index < steps.length - 1 && (
                  <span className={workflow.stages[step].status === "confirmed" ? "stepper-conn active" : "stepper-conn"} />
                )}
              </Fragment>
            ))}
          </div>

          <div className="messages" aria-live="polite">
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
                onChange={(event) => setInput(event.target.value)}
                rows={3}
              />
              <button type="button" aria-label="生成规划草案" onClick={handleSubmit} disabled={isAgentRunning}>
                <TelegramSendIcon />
              </button>
            </div>
          </div>
        </section>

        <section className="workspace-pane" aria-label="工程状态">
          <div className="topology-stage grid-bg">
            <div className="topology-meta mono">CANONICAL TSN PROJECT · INET 4.x · REACT FLOW</div>
            <div className="topology-stats" aria-label="拓扑统计">
              <Stat label="交换机" value={switchCount} />
              <Stat label="端系统" value={endSystemCount} />
              <Stat label="链路" value={linkCount} />
              <Stat label="流量" value={flowCount} />
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
              <span className="config-state mono">配置 · {project ? "草案" : "未生成"}</span>
            </div>

            <div className="config-body">
              {activeConfigTab === "flows" && (
                <section
                  className="flow-panel"
                  id="config-panel-flows"
                  role="tabpanel"
                  aria-label="流量列表"
                >
                  <div className="panel-heading">
                    <div>
                      <h2>流量规划</h2>
                      <p>记录当前 TSN 流、路径和关键时延参数，用于生成后续仿真输入。</p>
                    </div>
                    {selectedFlow && (
                      <button className="btn" type="button" onClick={() => setSelectedFlowId(undefined)}>
                        清除高亮
                      </button>
                    )}
                  </div>
                  <table className="eng-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Path</th>
                        <th>Period</th>
                        <th>PCP</th>
                        <th>Deadline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFlows.length > 0 ? (
                        visibleFlows.map((flow) => (
                          <tr
                            aria-selected={flow.id === selectedFlowId}
                            className={flow.id === selectedFlowId ? "flow-row selected" : "flow-row"}
                            data-testid={`flow-row-${flow.id}`}
                            key={flow.id}
                            onClick={() => handleFlowSelect(flow.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleFlowSelect(flow.id);
                              }
                            }}
                            tabIndex={0}
                            title="点击后在拓扑图中高亮该流的路径"
                          >
                            <td>{flow.name}</td>
                            <td>{flow.routeNodeIds.join(" -> ")}</td>
                            <td>{flow.periodUs} us</td>
                            <td>{flow.pcp}</td>
                            <td>{flow.latencyRequirementUs} us</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5}>等待 Agent 生成流量规划</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
              )}

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
                    <p>{selectedNode ? selectedNode.name : "在拓扑画布选择一个节点查看端口、地址和位置。"}</p>
                  </div>
                </div>
                {selectedNode ? (
                  <div className="detail-grid">
                    <DetailRow label="节点 ID" value={selectedNode.id} />
                    <DetailRow label="名称" value={selectedNode.name} />
                    <DetailRow label="类型" value={selectedNode.type === "switch" ? "交换机" : "端系统"} />
                    <DetailRow label="数字 ID" value={selectedNode.numericId} />
                    <DetailRow label="端口数" value={selectedNode.ports.length} />
                    <DetailRow label="IP 地址" value={selectedNode.ipAddress ?? "无"} />
                    <DetailRow label="MAC 地址" value={selectedNode.macAddress ?? "无"} />
                    <DetailRow label="坐标" value={`${selectedNode.position.x}, ${selectedNode.position.y}`} />
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
                    <p>{selectedLink ? selectedLink.id : "在拓扑画布选择一条链路查看端点、端口和速率。"}</p>
                  </div>
                </div>
                {selectedLink ? (
                  <div className="detail-grid">
                    <DetailRow label="链路 ID" value={selectedLink.id} />
                    <DetailRow label="数字 ID" value={selectedLink.numericId} />
                    <DetailRow
                      label="源端点"
                      value={`${selectedLinkSourceNode?.name ?? selectedLink.source.nodeId} / ${selectedLink.source.portId}`}
                    />
                    <DetailRow
                      label="目标端点"
                      value={`${selectedLinkTargetNode?.name ?? selectedLink.target.nodeId} / ${selectedLink.target.portId}`}
                    />
                    <DetailRow label="介质" value={selectedLink.medium} />
                    <DetailRow label="速率" value={`${selectedLink.dataRateMbps} Mbps`} />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的链路</div>
                )}
              </section>
              )}

              {activeConfigTab === "artifacts" && (
                <section
                  className="artifact-panel"
                  id="config-panel-artifacts"
                  role="tabpanel"
                  aria-label="导出文件列表"
                >
                <div className="panel-heading inline">
                  <div>
                    <h2>仿真输入文件</h2>
                    <p>NED、最小 INET ini、React Flow JSON、规划器输入和 manifest；当前不会执行 OMNeT++。</p>
                  </div>
                  <button className="btn" type="button" onClick={refreshBundle} disabled={!canRefreshBundle}>
                    <RefreshCw size={14} aria-hidden="true" />
                    刷新
                  </button>
                  <button className="btn" type="button" onClick={handleExportProject} disabled={!canExport}>
                    <Download size={14} aria-hidden="true" />
                    保存
                  </button>
                </div>
                <div className="export-directory">
                  <span>导出目录</span>
                  <div className="export-directory-row">
                    <div className="export-directory-path" aria-label="导出目录">
                      {exportDirectory || "尚未选择目录"}
                    </div>
                    <button
                      className="btn"
                      type="button"
                      aria-label="选择导出目录"
                      onClick={handleChooseExportDirectory}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      选择目录
                    </button>
                  </div>
                </div>
                <div className="artifact-list">
                  {(bundle?.artifacts ?? []).map((artifact) => (
                    <article className="artifact-item" key={artifact.path}>
                      <FileText size={15} aria-hidden="true" />
                      <div>
                        <span>{artifact.path}</span>
                        <p>{artifact.label ?? artifact.purpose}</p>
                      </div>
                    </article>
                  ))}
                  {!bundle && <div className="empty-panel mono">完成“模拟仿真”阶段后显示仿真输入文件</div>}
                </div>
                {exportResult && (
                  <p className="export-status mono" role="status">
                    已导出 {exportResult.writtenFiles.length} 个文件：{exportResult.outputDir}
                    {exportResult.mode === "tauri" && (
                      <button className="inline-link" type="button" onClick={handleOpenExportDirectory}>
                        <ExternalLink size={13} aria-hidden="true" />
                        打开目录
                      </button>
                    )}
                  </p>
                )}
                {exportError && (
                  <p className="export-status error" role="alert">
                    导出失败：{exportError}
                  </p>
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

function Step({
  index,
  label,
  status,
}: {
  index: string;
  label: string;
  status: "locked" | "current" | "waiting_confirmation" | "confirmed" | "error";
}) {
  const className = status === "confirmed" ? "passed" : status;

  return (
    <div className={`stepper-item ${className}`}>
      <span className="si-num">{index}</span>
      <span className="si-label">{label}</span>
    </div>
  );
}

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    portCount?: number;
    ipAddress?: string;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">
        {nodeType === "switch" ? `${nodeData.portCount ?? 0} ports` : nodeData.ipAddress}
      </small>
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
