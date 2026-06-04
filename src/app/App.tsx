import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { runTsnAgent } from "../agent/agent-adapter";
import {
  artifactBundleSummary,
  logDiagnostic,
  plannerRunSummary,
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
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createArtifactBundle, type ExportedArtifact } from "../export/artifact-bundle";
import { classifyArtifact, type ArtifactClassification, type ArtifactGroupId } from "../export/artifact-classification";
import { exportPlannerInput } from "../export/planner-exporter";
import { exportReactFlowTopology } from "../export/react-flow-exporter";
import {
  PLANNER_LINK_DEFAULTS,
  PLANNER_NODE_PARAMETER_DEFAULTS,
} from "../planner/planner-defaults";
import {
  getPlannerPlanResult,
  queryPlannerPlanStatus,
  startPlannerPlan,
  stopPlannerPlan,
} from "../planner/planner-client";
import {
  createPlannerRequestFingerprint,
  createStalePlannerRunState,
  isTerminalPlannerState,
  normalizePlannerRunState,
  resolvePlannerBaseUrl,
  summarizePlannerRequest,
  summarizePlannerResult,
  type PlannerQueryStatusResponseData,
  type PlannerResultResponseData,
  type PlannerRunState,
  type PlannerServiceEnvelope,
  type PlannerStartResponseData,
  type PlannerTaskState,
} from "../planner/planner-contract";
import { getScenarioConfig } from "../domain/scenario-config";
import {
  exportProjectBundle,
  openProjectExportDirectory,
  selectProjectExportDirectory,
  suggestProjectExportDirectory,
  type ProjectExportResult,
} from "../project/project-exporter";
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
  SKILL_CATALOG,
  type SkillCatalogItem,
} from "../skills/skill-catalog";
import tsnAgentMark from "../assets/tsn-agent-mark.png";

const repository: SessionRepository = createSessionRepository();
const diagnosticsRepository: DiagnosticLogRepository = createDiagnosticLogRepository();
const ASSISTANT_CONNECTING_MESSAGE = "正在连接智能助手，并结合当前会话上下文生成下一步规划...";
const INTENT_PLACEHOLDER = "例如：我需要 4 个交换机，每个交换机连接 5 个端系统";
const AGENT_STREAM_STALL_MS = 3000;
const PLANNER_POLL_INTERVAL_MS = import.meta.env.MODE === "test" ? 20 : 3000;
const PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT = 2;

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

type ConfigTabId = "flows" | "node-detail" | "link-detail" | "artifacts" | "steps";
type WorkspaceToolPanel = "sessions" | "diagnostics" | "skills" | "settings";

type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

type AgentRunPhase = "idle" | "connecting" | "streaming" | "waiting";

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "flows", label: "流量列表" },
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
  { id: "artifacts", label: "导出文件" },
  { id: "steps", label: "执行步骤" },
];

const ARTIFACT_GROUP_ORDER: ArtifactGroupId[] = ["workspace", "planner", "simulation-inet", "manifest", "legacy"];

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
  const [plannerBaseUrl, setPlannerBaseUrl] = useState(resolvePlannerBaseUrl());
  const [isPlannerActionRunning, setIsPlannerActionRunning] = useState(false);
  const [pendingAssistantMessageId, setPendingAssistantMessageId] = useState<string | undefined>();
  const [exportResult, setExportResult] = useState<ProjectExportResult | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const [exportDirectory, setExportDirectory] = useState("");
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>("flows");
  const [selectedTopologyItem, setSelectedTopologyItem] = useState<SelectedTopologyItem | undefined>();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>();
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const plannerPollTimeoutRef = useRef<number | undefined>(undefined);
  const plannerTransientFailureCountRef = useRef(0);

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
    setPlannerBaseUrl(resolvePlannerBaseUrl(currentSession.plannerRun?.baseUrl));
  }, [currentSession.id]);

  useEffect(() => {
    setPlannerBaseUrl(resolvePlannerBaseUrl(currentSession.plannerRun?.baseUrl));
  }, [currentSession.plannerRun?.baseUrl]);

  useEffect(() => {
    const run = normalizePlannerRunState(currentSession.plannerRun);

    if (run.status !== "running" || !run.planId) {
      clearPlannerPollTimeout();
      return;
    }

    schedulePlannerPoll(currentSession.id, run.planId, run.baseUrl, run.runToken);
  }, [currentSession.id, currentSession.plannerRun?.planId, currentSession.plannerRun?.runToken, currentSession.plannerRun?.status]);

  useEffect(() => () => {
    clearPlannerPollTimeout();
  }, []);

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

  const project = currentSession.project;
  const bundle = currentSession.bundle;
  const workflow = currentSession.workflow;
  const plannerRun = normalizePlannerRunState(currentSession.plannerRun);
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
  const artifactGroups = useMemo(() => groupArtifacts(bundle?.artifacts ?? []), [bundle]);
  const canStartPlanner = Boolean(
    project
      && workflow.currentStep === "planning-export"
      && ["current", "waiting_confirmation", "confirmed"].includes(workflow.stages["planning-export"].status)
      && !isPlannerActionRunning
      && plannerRun.status !== "running"
      && plannerRun.status !== "cancel_requested",
  );
  const canStopPlanner = Boolean(
    (plannerRun.status === "running" || plannerRun.status === "busy" || plannerRun.status === "cancel_requested")
      && !isPlannerActionRunning,
  );
  const currentPlannerRequestFingerprint = useMemo(() => {
    if (!project) {
      return undefined;
    }

    try {
      return createPlannerRequestFingerprint(exportPlannerInput(project));
    } catch {
      return undefined;
    }
  }, [project]);
  const plannerResultForCurrentProject = currentPlannerRequestFingerprint
    && plannerRun.resultSnapshot?.requestFingerprint === currentPlannerRequestFingerprint
    ? plannerRun.resultSnapshot
    : undefined;

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

  async function persistPlannerSession(nextSession: TsnSession, message: string) {
    await repository.save(nextSession);
    logDiagnostic(diagnosticsRepository, {
      sessionId: nextSession.id,
      category: "session",
      message,
      details: plannerRunSummary(nextSession),
    });
    setCurrentSession((session) => (session.id === nextSession.id ? nextSession : session));
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
    setAgentRunPhase("connecting");
    setAgentRunStartedAt(Date.now());
    setAgentRunElapsedSeconds(0);
    setLastAgentChunkAt(undefined);
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
          setAgentRunPhase("streaming");
          setLastAgentChunkAt(Date.now());
          setPendingAssistantMessageId(undefined);
          updateAssistantMessage(pendingSession.id, assistantMessage.id, redactProviderNamesForDisplay(streamedText));
        },
      });
      const completedAt = new Date().toISOString();
      const shouldApplyProject = result.shouldApplyProject !== false;
      const latestSession = (await repository.list()).find((session) => session.id === pendingSession.id) ?? pendingSession;
      const baseMessages = latestSession.messages.some((message) => message.id === assistantMessage.id)
        ? latestSession.messages
        : pendingSession.messages;
      const previousPlannerRun = normalizePlannerRunState(latestSession.plannerRun);
      const nextPlannerRun: PlannerRunState = shouldApplyProject
        ? plannerRunForAgentResult(previousPlannerRun, result.project)
        : previousPlannerRun;
      const nextSession: TsnSession = {
        ...latestSession,
        title: shouldApplyProject ? result.project.name : pendingSession.title,
        updatedAt: completedAt,
        messages: baseMessages.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: redactProviderNamesForDisplay(result.assistantText) }
            : message,
        ),
        claudeSessionId: result.claudeSessionId ?? latestSession.claudeSessionId,
        agentEvents: [...latestSession.agentEvents, ...stampAgentEvents(result.events, completedAt)],
        workflow: shouldApplyProject ? result.workflow : pendingSession.workflow,
        project: shouldApplyProject ? result.project : pendingSession.project,
        bundle: shouldApplyProject
          ? bundleForAgentResult(result.project, result.bundle, nextPlannerRun)
          : pendingSession.bundle,
        plannerRun: nextPlannerRun,
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
      setExportDirectory("");
      setExportResult(undefined);
      setExportError(undefined);
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
    setExportDirectory("");
    setExportResult(undefined);
    setExportError(undefined);
    setSessions(await repository.list());
    setActiveWorkspacePanel(undefined);
  }

  async function refreshBundle() {
    if (!project || !canRefreshBundle) {
      return;
    }

    const nextBundle = createArtifactBundle(project, {
      plannerResult: plannerResultForCurrentProject,
    });

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

  async function handleStartPlanner() {
    if (!project || !canStartPlanner) {
      return;
    }

    setIsPlannerActionRunning(true);
    setExportError(undefined);
    setActiveConfigTab("artifacts");

    try {
      const request = exportPlannerInput(project);
      const requestSummary = summarizePlannerRequest(request);
      const requestFingerprint = createPlannerRequestFingerprint(request);
      const baseUrl = resolvePlannerBaseUrl(plannerBaseUrl);
      const runToken = createPlannerRunToken();
      const startedRun: PlannerRunState = {
        status: "running",
        baseUrl,
        runToken,
        requestFingerprint,
        startedAt: new Date().toISOString(),
        requestSummary,
      };
      const submittingSession: TsnSession = {
        ...currentSession,
        updatedAt: new Date().toISOString(),
        plannerRun: startedRun,
      };

      await persistPlannerSession(submittingSession, "规划任务开始提交");

      const response = await startPlannerPlan({ baseUrl, request });
      const run = plannerRunFromStartResponse(startedRun, response);
      const nextSession: TsnSession = {
        ...submittingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: run,
      };

      await persistPlannerSession(nextSession, "规划任务提交完成");

      if (run.status === "running" && run.planId) {
        schedulePlannerPoll(nextSession.id, run.planId, baseUrl, run.runToken);
      } else if (run.status === "succeeded" && run.planId) {
        const completedSession = await attachPlannerResult(nextSession, baseUrl, run.planId, run);
        await persistPlannerSession(completedSession, "规划任务结果已读取");
      }
    } catch (error) {
      const failedSession: TsnSession = {
        ...currentSession,
        updatedAt: new Date().toISOString(),
        plannerRun: {
          ...plannerRun,
          status: "failed",
          baseUrl: resolvePlannerBaseUrl(plannerBaseUrl),
          updatedAt: new Date().toISOString(),
          errorMessage: normalizeError(error),
        },
      };

      await persistPlannerSession(failedSession, "规划任务启动失败");
    } finally {
      setIsPlannerActionRunning(false);
    }
  }

  async function handleStopPlanner() {
    if (!canStopPlanner) {
      return;
    }

    setIsPlannerActionRunning(true);
    clearPlannerPollTimeout();
    const cancellingRun: PlannerRunState = {
      ...plannerRun,
      status: "cancel_requested",
      runToken: createPlannerRunToken(),
      updatedAt: new Date().toISOString(),
    };
    const cancellingSession: TsnSession = {
      ...currentSession,
      updatedAt: new Date().toISOString(),
      plannerRun: cancellingRun,
    };

    await persistPlannerSession(cancellingSession, "规划任务停止请求已发出");

    try {
      const baseUrl = resolvePlannerBaseUrl(plannerRun.baseUrl);
      const response = await stopPlannerPlan({ baseUrl, planId: plannerRun.planId });
      const run: PlannerRunState = {
        ...cancellingRun,
        baseUrl,
        status: normalizePlannerState(response.data.state),
        planId: response.data.stopped_plan_id ?? response.data.requested_plan_id ?? plannerRun.planId,
        updatedAt: response.timestamp ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorCode: response.err_code === 0 ? undefined : response.err_code,
        errorMessage: response.err_code === 0 ? undefined : response.err_msg,
        traceId: response.trace_id,
      };
      const nextSession: TsnSession = {
        ...cancellingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: run,
      };

      await persistPlannerSession(nextSession, "规划任务停止请求完成");
    } catch (error) {
      const nextSession: TsnSession = {
        ...cancellingSession,
        updatedAt: new Date().toISOString(),
        plannerRun: {
          ...plannerRun,
          status: "running",
          runToken: createPlannerRunToken(),
          updatedAt: new Date().toISOString(),
          errorMessage: normalizeError(error),
        },
      };

      await persistPlannerSession(nextSession, "规划任务停止失败");
    } finally {
      setIsPlannerActionRunning(false);
    }
  }

  function clearPlannerPollTimeout() {
    if (plannerPollTimeoutRef.current === undefined) {
      return;
    }

    window.clearTimeout(plannerPollTimeoutRef.current);
    plannerPollTimeoutRef.current = undefined;
  }

  function schedulePlannerPoll(sessionId: string, planId: string, baseUrl: string, runToken?: string) {
    clearPlannerPollTimeout();

    plannerPollTimeoutRef.current = window.setTimeout(() => {
      void pollPlanner(sessionId, planId, baseUrl, runToken);
    }, PLANNER_POLL_INTERVAL_MS);
  }

  async function pollPlanner(sessionId: string, planId: string, baseUrl: string, runToken?: string) {
    try {
      const latestSession = (await repository.list()).find((session) => session.id === sessionId);
      const latestRun = normalizePlannerRunState(latestSession?.plannerRun);

      if (!isExpectedPlannerRun(latestSession, planId, runToken)) {
        return;
      }

      const response = await queryPlannerPlanStatus({ baseUrl, planId });
      const nextRun = plannerRunFromQueryResponse(latestRun, response);
      let nextSession: TsnSession = {
        ...latestSession,
        updatedAt: new Date().toISOString(),
        plannerRun: nextRun,
      };

      if (!await isLatestPlannerRun(sessionId, planId, runToken)) {
        return;
      }

      if (nextRun.status === "succeeded") {
        nextSession = await attachPlannerResult(nextSession, baseUrl, planId, nextRun);
      }

      if (!await isLatestPlannerRun(sessionId, planId, runToken)) {
        return;
      }

      plannerTransientFailureCountRef.current = 0;
      await persistPlannerSession(nextSession, "规划任务状态已更新");

      if (!isTerminalPlannerState(nextRun.status)) {
        schedulePlannerPoll(sessionId, planId, baseUrl, nextRun.runToken);
      }
    } catch (error) {
      const latestSession = (await repository.list()).find((session) => session.id === sessionId);

      if (!isExpectedPlannerRun(latestSession, planId, runToken)) {
        return;
      }

      plannerTransientFailureCountRef.current += 1;
      const latestRun = normalizePlannerRunState(latestSession.plannerRun);
      const exhaustedRetries = plannerTransientFailureCountRef.current > PLANNER_TRANSIENT_FAILURE_RETRY_LIMIT;
      const nextRun: PlannerRunState = {
        ...latestRun,
        status: exhaustedRetries ? "failed" : latestRun.status,
        updatedAt: new Date().toISOString(),
        errorMessage: normalizeError(error),
      };

      await persistPlannerSession({
        ...latestSession,
        updatedAt: new Date().toISOString(),
        plannerRun: nextRun,
      }, "规划任务轮询失败");

      if (!exhaustedRetries) {
        schedulePlannerPoll(sessionId, planId, baseUrl, runToken);
      }
    }
  }

  async function attachPlannerResult(
    session: TsnSession,
    baseUrl: string,
    planId: string,
    run: PlannerRunState,
  ): Promise<TsnSession> {
    if (!session.project) {
      return session;
    }

    const resultResponse = await getPlannerPlanResult({ baseUrl, planId });
    assertSuccessfulPlannerResult(resultResponse, planId);
    const sourceOutputs = resultResponse.data.source_outputs ?? {};
    const outputFingerprints = resultResponse.data.output_fingerprints;
    const summary = summarizePlannerResult(sourceOutputs, outputFingerprints);
    const resultSnapshot = {
      planId,
      state: "succeeded" as const,
      requestFingerprint: run.requestFingerprint,
      sourceOutputs,
      outputFingerprints,
      traceId: resultResponse.trace_id,
      timestamp: resultResponse.timestamp,
      receivedAt: new Date().toISOString(),
      summary,
    };
    const plannerRunWithResult: PlannerRunState = {
      ...run,
      resultSummary: summary,
      resultSnapshot,
      traceId: resultResponse.trace_id ?? run.traceId,
      updatedAt: resultResponse.timestamp ?? run.updatedAt,
    };

    return {
      ...session,
      plannerRun: plannerRunWithResult,
      bundle: createArtifactBundle(session.project, {
        plannerResult: resultSnapshot,
      }),
    };
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
    <div className="app-shell" aria-busy={isAgentRunning}>
      <header className="brand-header">
        <div className="brand-logo" aria-hidden="true">
          <img src={tsnAgentMark} alt="" />
        </div>
        <h1 className="brand-name">TSN Agent</h1>
        <span className="brand-ver">VER {appVersion}</span>
        <span className={project ? "badge planned" : "badge draft"}>
          <span className="badge-dot" />
          {project ? "草案已生成" : "草稿"}
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
            <span className="env-badge mono">
              {project ? `canonical=v0 · ${scenarioConfig.displayName}` : scenarioConfig.displayName}
            </span>
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
                        <th>Size</th>
                        <th>PCP</th>
                        <th>Deadline</th>
                        <th>Jitter</th>
                        <th>UDP</th>
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
                            <td>{flow.frameSizeBytes} B</td>
                            <td>{flow.pcp}</td>
                            <td>{flow.latencyRequirementUs} us</td>
                            <td>{flow.jitterRequirementUs} us</td>
                            <td>{`${flow.source.udpPort} -> ${flow.destination.udpPort}`}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={8}>等待 Agent 生成流量规划</td>
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
                    <DetailRow label="规划节点类型" value={selectedNode.type === "switch" ? "0" : "1"} />
                    <DetailRow label="system_clock" value={PLANNER_NODE_PARAMETER_DEFAULTS.system_clock} />
                    <DetailRow label="qci_enable" value={PLANNER_NODE_PARAMETER_DEFAULTS.qci_enable} />
                    <DetailRow label="qbv_or_qch" value={PLANNER_NODE_PARAMETER_DEFAULTS.qbv_or_qch} />
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
                    <DetailRow
                      label="源规划端口"
                      value={selectedLinkSourceNode ? findPortIndex(selectedLinkSourceNode, selectedLink.source.portId) : "无"}
                    />
                    <DetailRow
                      label="目标规划端口"
                      value={selectedLinkTargetNode ? findPortIndex(selectedLinkTargetNode, selectedLink.target.portId) : "无"}
                    />
                    <DetailRow label="st_queues" value={PLANNER_LINK_DEFAULTS.st_queues} />
                    <DetailRow label="macrotick" value={PLANNER_LINK_DEFAULTS.macrotick} />
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
                    <h2>项目导出文件</h2>
                    <p>按用途分组的工作台数据、规划器输入和 INET 仿真输入；当前不会执行 OMNeT++。</p>
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
                <PlannerTaskPanel
                  plannerRun={plannerRun}
                  baseUrl={plannerBaseUrl}
                  canStart={canStartPlanner}
                  canStop={canStopPlanner}
                  isActionRunning={isPlannerActionRunning}
                  onBaseUrlChange={setPlannerBaseUrl}
                  onStart={handleStartPlanner}
                  onStop={handleStopPlanner}
                />
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
                  {artifactGroups.map((group) => (
                    <section className="artifact-group" key={group.id} aria-label={group.label}>
                      <div className="artifact-group-heading">
                        <span>{group.label}</span>
                        <small>{group.items.length} 个文件</small>
                      </div>
                      {group.items.map(({ artifact, classification }) => (
                        <article className="artifact-item" key={artifact.path}>
                          <FileText size={15} aria-hidden="true" />
                          <div>
                            <span>{artifact.path}</span>
                            <p>
                              {artifact.label ?? artifact.purpose}
                              <strong>{classification.roleLabel}</strong>
                              {classification.isEntrypoint && <em>入口</em>}
                              {artifact.observedExternal && <em>外部观测</em>}
                            </p>
                          </div>
                        </article>
                      ))}
                    </section>
                  ))}
                  {!bundle && <div className="empty-panel mono">完成“模拟仿真”阶段后显示项目导出文件</div>}
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
            <span className={session.project ? "badge planned" : "badge draft"}>
              <span className="badge-dot" />
              {session.project ? "配置草案" : "空会话"}
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

function PlannerTaskPanel({
  plannerRun,
  baseUrl,
  canStart,
  canStop,
  isActionRunning,
  onBaseUrlChange,
  onStart,
  onStop,
}: {
  plannerRun: PlannerRunState;
  baseUrl: string;
  canStart: boolean;
  canStop: boolean;
  isActionRunning: boolean;
  onBaseUrlChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const statusLabel = plannerStatusLabel(plannerRun.status);
  const elapsed = plannerRun.runningDurationMs === undefined
    ? undefined
    : `${Math.max(0, Math.round(plannerRun.runningDurationMs / 1000))} 秒`;

  return (
    <section className={`planner-task-panel ${plannerRun.status}`} aria-label="规划任务">
      <div className="planner-task-header">
        <div>
          <h3>规划任务</h3>
          <p>启动后会提交当前拓扑、流和规划默认参数，并持续等待规划服务返回结果。</p>
        </div>
        <span className={`planner-status ${plannerRun.status}`}>{statusLabel}</span>
      </div>
      <div className="planner-task-controls">
        <label htmlFor="planner-base-url">服务地址</label>
        <input
          id="planner-base-url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          disabled={plannerRun.status === "running" || isActionRunning}
        />
        <button className="btn-primary" type="button" onClick={onStart} disabled={!canStart}>
          <RefreshCw size={14} aria-hidden="true" />
          启动规划
        </button>
        <button className="btn" type="button" onClick={onStop} disabled={!canStop}>
          <Square size={13} aria-hidden="true" />
          停止
        </button>
      </div>
      <div className="planner-task-grid">
        <DetailRow label="任务 ID" value={plannerRun.planId ?? "未提交"} />
        <DetailRow label="节点/链路/流" value={plannerRun.requestSummary
          ? `${plannerRun.requestSummary.nodeCount}/${plannerRun.requestSummary.linkCount}/${plannerRun.requestSummary.flowCount}`
          : "未生成"} />
        <DetailRow label="运行时长" value={elapsed ?? "未开始"} />
        <DetailRow label="最近更新" value={plannerRun.updatedAt ? formatTime(plannerRun.updatedAt) : "无"} />
      </div>
      {plannerRun.resultSummary && (
        <div className="planner-result-summary" role="status">
          <span>结果摘要</span>
          <strong>{plannerRun.resultSummary.linkCount} 条链路 · {plannerRun.resultSummary.gclEntryCount} 条 GCL</strong>
          <p>{plannerRun.resultSummary.fingerprintFiles.join(", ") || "无指纹文件"}</p>
        </div>
      )}
      {plannerRun.errorMessage && (
        <p className="planner-error" role="alert">
          {plannerRun.errorMessage}
        </p>
      )}
    </section>
  );
}

function plannerStatusLabel(status: PlannerTaskState): string {
  const labels: Record<PlannerTaskState, string> = {
    idle: "未提交",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
    busy: "服务忙",
    cancel_requested: "取消中",
    cancelled: "已取消",
    no_running_plan: "无运行任务",
    not_found: "未找到",
    stale: "已失效",
    unknown: "未知",
  };

  return labels[status];
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

function findPortIndex(node: { ports: Array<{ id: string; index: number }> }, portId: string): string | number {
  return node.ports.find((port) => port.id === portId)?.index ?? "无";
}

function createPlannerRunToken(): string {
  return `planner-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function plannerRunForAgentResult(current: PlannerRunState, project: NonNullable<TsnSession["project"]>): PlannerRunState {
  if (!current.resultSnapshot && !current.requestFingerprint) {
    return current;
  }

  let nextFingerprint: string;

  try {
    nextFingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));
  } catch {
    return createStalePlannerRunState(current);
  }

  if (current.requestFingerprint === nextFingerprint && current.resultSnapshot?.requestFingerprint === nextFingerprint) {
    return current;
  }

  return createStalePlannerRunState(current);
}

function bundleForAgentResult(
  project: NonNullable<TsnSession["project"]>,
  bundle: TsnSession["bundle"],
  plannerRun: PlannerRunState,
): TsnSession["bundle"] {
  if (!bundle) {
    return bundle;
  }

  const fingerprint = createPlannerRequestFingerprint(exportPlannerInput(project));

  if (plannerRun.resultSnapshot?.requestFingerprint !== fingerprint) {
    return bundle;
  }

  return createArtifactBundle(project, {
    plannerResult: plannerRun.resultSnapshot,
  });
}

function isExpectedPlannerRun(
  session: TsnSession | undefined,
  planId: string,
  runToken?: string,
): session is TsnSession {
  const run = normalizePlannerRunState(session?.plannerRun);

  return Boolean(
    session
      && run.planId === planId
      && ["running", "cancel_requested"].includes(run.status)
      && (!runToken || run.runToken === runToken),
  );
}

async function isLatestPlannerRun(sessionId: string, planId: string, runToken?: string): Promise<boolean> {
  const latestSession = (await repository.list()).find((session) => session.id === sessionId);
  return isExpectedPlannerRun(latestSession, planId, runToken);
}

function assertSuccessfulPlannerResult(
  response: PlannerServiceEnvelope<PlannerResultResponseData>,
  expectedPlanId: string,
): void {
  if (response.err_code !== 0 || response.data.state !== "succeeded") {
    throw new Error(response.data.error_message ?? response.err_msg ?? "规划结果尚未成功生成。");
  }

  if (response.data.plan_id && response.data.plan_id !== expectedPlanId) {
    throw new Error(`规划结果任务 ID 不匹配：期望 ${expectedPlanId}，实际 ${response.data.plan_id}。`);
  }

  if (!response.data.source_outputs) {
    throw new Error("规划结果缺少 source_outputs。");
  }
}

function plannerRunFromStartResponse(
  current: PlannerRunState,
  response: PlannerServiceEnvelope<PlannerStartResponseData>,
): PlannerRunState {
  const state = normalizePlannerState(response.data.state);
  const planId = response.data.plan_id ?? response.data.running_plan_id ?? current.planId;

  return {
    ...current,
    status: state,
    planId,
    startedAt: response.data.started_at ?? current.startedAt,
    updatedAt: response.timestamp ?? new Date().toISOString(),
    runningDurationMs: response.data.running_duration_ms ?? current.runningDurationMs,
    errorCode: response.err_code === 0 ? undefined : response.err_code,
    errorMessage: response.err_code === 0 ? undefined : response.err_msg,
    traceId: response.trace_id,
  };
}

function plannerRunFromQueryResponse(
  current: PlannerRunState,
  response: PlannerServiceEnvelope<PlannerQueryStatusResponseData>,
): PlannerRunState {
  return {
    ...current,
    status: normalizePlannerState(response.data.state),
    planId: response.data.plan_id ?? current.planId,
    startedAt: response.data.started_at ?? current.startedAt,
    updatedAt: response.data.updated_at ?? response.timestamp ?? new Date().toISOString(),
    finishedAt: response.data.finished_at ?? current.finishedAt,
    runningDurationMs: response.data.running_duration_ms ?? current.runningDurationMs,
    internalResult: response.data.internal_result,
    errorCode: response.data.error_code ?? (response.err_code === 0 ? undefined : response.err_code),
    errorMessage: response.data.error_message ?? (response.err_code === 0 ? undefined : response.err_msg),
    traceId: response.trace_id ?? current.traceId,
  };
}

function normalizePlannerState(value: string): PlannerTaskState {
  if ([
    "idle",
    "running",
    "succeeded",
    "failed",
    "busy",
    "cancel_requested",
    "cancelled",
    "no_running_plan",
    "not_found",
    "stale",
    "unknown",
  ].includes(value)) {
    return value as PlannerTaskState;
  }

  return "unknown";
}

function groupArtifacts(artifacts: ExportedArtifact[]) {
  const grouped = new Map<ArtifactGroupId, Array<{ artifact: ExportedArtifact; classification: ArtifactClassification }>>();

  for (const artifact of artifacts) {
    const classification = classifyArtifact(artifact);
    const artifactsForGroup = grouped.get(classification.group) ?? [];
    artifactsForGroup.push({ artifact, classification });
    grouped.set(classification.group, artifactsForGroup);
  }

  return ARTIFACT_GROUP_ORDER
    .map((groupId) => {
      const items = grouped.get(groupId) ?? [];

      return {
        id: groupId,
        label: items[0]?.classification.groupLabel ?? artifactGroupFallbackLabels[groupId],
        items,
      };
    })
    .filter((group) => group.items.length > 0);
}

const artifactGroupFallbackLabels: Record<ArtifactGroupId, string> = {
  workspace: "工作台展示",
  planner: "外部规划器",
  "simulation-inet": "INET 仿真输入",
  manifest: "清单",
  legacy: "旧版文件",
};

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
