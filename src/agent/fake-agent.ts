import type { CanonicalTsnProjectV0, TopologyIntent } from "../domain/canonical";
import { getScenarioConfig } from "../domain/scenario-config";
import { getTopologyRuntimeSummary } from "../topology/topology-service";
import {
  createProjectFromIntent,
  parseTopologyIntent,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "../domain/topology-factory";
import type { ArtifactBundle } from "../export/artifact-bundle";
import { createArtifactBundle } from "../export/artifact-bundle";
import {
  confirmCurrentStage,
  normalizeWorkflowState,
  recordStageResult,
  requestStageChanges,
  type WorkflowState,
  type WorkflowStep,
} from "../project/project-state";

export type AgentEventKind =
  | "thought"
  | "skill-start"
  | "skill-result"
  | "artifact"
  | "stage-start"
  | "stage-result"
  | "confirmation-required"
  | "tool-availability"
  | "error";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  stage?: WorkflowStep;
  skillName?: string;
  title: string;
  content: string;
  status?: "info" | "success" | "warning" | "error";
  createdAt?: string;
}

export interface FakeAgentResult {
  events: AgentEvent[];
  project: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
  workflow: WorkflowState;
  assistantText: string;
  shouldApplyProject?: boolean;
}

export function runFakeTsnAgent(
  userIntent: string,
  previousProject?: CanonicalTsnProjectV0,
  previousWorkflow?: WorkflowState,
): FakeAgentResult {
  const baseWorkflow = normalizeWorkflowState(previousWorkflow);
  const projectWithUserFlows = applyUserFlowIntent(previousProject, userIntent, baseWorkflow);

  if (isSimulationExecutionIntent(userIntent)) {
    return runUnsupportedSimulationRequest(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (isQuickGenerateIntent(userIntent)) {
    return runQuickGenerate(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (hasTopologyChangeIntent(userIntent, baseWorkflow)) {
    return runTopologyStage(userIntent, projectWithUserFlows, requestStageChanges(baseWorkflow, "topology"));
  }

  if (baseWorkflow.currentStep === "flow-template" && hasFlowConfigurationIntent(userIntent)) {
    return runCurrentStage(projectWithUserFlows, baseWorkflow, userIntent);
  }

  if (isStageAdvanceIntent(userIntent, "time-sync") && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (isStageAdvanceIntent(userIntent, "flow-template") && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (isStageAdvanceIntent(userIntent, "planning-export") && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (isStageConfirmationIntent(userIntent) && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (isContinuationIntent(userIntent) && baseWorkflow.stages[baseWorkflow.currentStep].status === "waiting_confirmation") {
    return runAfterConfirmation(userIntent, projectWithUserFlows, baseWorkflow);
  }

  if (baseWorkflow.currentStep === "topology") {
    return runTopologyStage(userIntent, projectWithUserFlows, baseWorkflow);
  }

  return runCurrentStage(projectWithUserFlows, baseWorkflow, userIntent);
}

export function hasExplicitTopologyIntent(text: string): boolean {
  return /(\d+)\s*(?:个|台)?\s*(?:交换机|switch)/i.test(text)
    || /(?:每个|每台|each).*?(\d+)\s*(?:个|台)?\s*(?:网卡|端系统|终端|端(?!口)|host|end)/i.test(text)
    || /双冗余|双平面|系统交换机|网卡\s*[一二两三四五六七八九十\d]+/i.test(text)
    || /箭载.*拓扑|拓扑.*箭载/i.test(text)
    || hasSwitchInterconnectIntent(text);
}

function runAfterConfirmation(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const confirmed = confirmCurrentStage(workflow);

  if (confirmed.currentStep === workflow.currentStep) {
    return completeFinalStage(userIntent, previousProject, workflow, confirmed);
  }

  return runCurrentStage(previousProject, confirmed, userIntent);
}

function completeFinalStage(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  previousWorkflow: WorkflowState,
  confirmedWorkflow: WorkflowState,
): FakeAgentResult {
  const project = previousProject
    ? refreshProject(previousProject)
    : createProjectFromIntent(userIntent || "请生成默认拓扑", undefined, {
        scenarioConfigId: confirmedWorkflow.scenarioConfigId,
      });
  const projectWithFlow = withDefaultControlFlow(project, {
    scenarioConfigId: confirmedWorkflow.scenarioConfigId,
  });
  const bundle = createArtifactBundle(projectWithFlow);
  const summary = previousWorkflow.stages[previousWorkflow.currentStep].summary ?? "当前阶段已确认完成。";
  const events = [
    createToolAvailabilityEvent(),
    createStageResultEvent(previousWorkflow.currentStep, "阶段已确认", summary),
  ] satisfies AgentEvent[];

  return {
    project: projectWithFlow,
    bundle,
    workflow: confirmedWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runCurrentStage(
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
  userIntent = "",
): FakeAgentResult {
  if (workflow.currentStep === "topology" || !previousProject) {
    return runTopologyStage(userIntent || "请生成默认拓扑", previousProject, workflow);
  }

  if (workflow.currentStep === "time-sync") {
    return runTimeSyncStage(previousProject, workflow, userIntent);
  }

  if (workflow.currentStep === "flow-template") {
    return runFlowStage(previousProject, workflow);
  }

  return runPlanningExportStage(previousProject, workflow);
}

function runTopologyStage(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;
  const project = createProjectFromIntent(userIntent, fallbackIntent, {
    scenarioConfigId: workflow.scenarioConfigId,
    includeControlFlow: false,
  });
  const intent = parseTopologyIntent(userIntent, fallbackIntent, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const summary = describeTopologyIntent(intent);
  const interconnectSummary = describeTopologyInterconnect(intent);
  const nextWorkflow = recordStageResult(workflow, {
    step: "topology",
    summary: `${summary}${interconnectSummary}`,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("topology", "拓扑阶段开始", "解析自然语言拓扑规模，准备生成 canonical 拓扑。"),
    {
      id: "event-intent",
      kind: "thought",
      stage: "topology",
      title: "需求识别",
      content: `${summary}${interconnectSummary}`,
      status: "info",
    },
    {
      id: "event-topology-result",
      kind: "skill-result",
      stage: "topology",
      skillName: "tsn-topology",
      title: "拓扑结果",
      content: `已生成 ${project.topology.nodes.length} 个节点和 ${project.topology.links.length} 条链路。`,
      status: "success",
    },
    createStageResultEvent("topology", "拓扑摘要", `${summary}${interconnectSummary}`),
    createConfirmationEvent("topology", "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。"),
  ] satisfies AgentEvent[];

  return {
    project,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runTimeSyncStage(project: CanonicalTsnProjectV0, workflow: WorkflowState, userIntent = ""): FakeAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const summary = scenarioConfig.defaults.timeSyncSummary;
  const capturedFlowSummary = hasFlowConfigurationIntent(userIntent) && project.flows.length > 0
    ? `已记录 ${project.flows.length} 条流需求，当前仍先完成时间同步确认；确认后进入流量规划阶段会展示这些流。`
    : undefined;
  const nextWorkflow = recordStageResult(workflow, {
    step: "time-sync",
    summary: capturedFlowSummary ? `${summary}${capturedFlowSummary}` : summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("time-sync", "时间同步阶段开始", "生成时间同步默认摘要。"),
    createStageResultEvent("time-sync", "时间同步默认值", summary),
    ...(capturedFlowSummary
      ? [
          {
            id: "event-captured-flow-intent",
            kind: "thought",
            stage: "time-sync",
            title: "流需求已暂存",
            content: capturedFlowSummary,
            status: "info",
          } satisfies AgentEvent,
        ]
      : []),
    createConfirmationEvent("time-sync", "确认同步假设后进入流量规划阶段，或说明需要调整的同步约束。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(project),
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runFlowStage(project: CanonicalTsnProjectV0, workflow: WorkflowState): FakeAgentResult {
  const nextProject = withDefaultControlFlow(project, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const summary = nextProject.flows.length > 0
    ? `已准备 ${nextProject.flows.length} 条流：${nextProject.flows.map(describeFlow).join("；")}。`
    : "当前拓扑还没有可用流量规划。";
  const nextWorkflow = recordStageResult(workflow, {
    step: "flow-template",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("flow-template", "流量规划阶段开始", "根据当前拓扑和用户已说明的业务流生成流量规划。"),
    {
      id: "event-flow-template",
      kind: "skill-result",
      stage: "flow-template",
      skillName: "tsn-flow-template",
      title: "流量规划",
      content: summary,
      status: "success",
    },
    createConfirmationEvent("flow-template", "确认流量规划后生成仿真输入和导出清单。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(nextProject),
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runPlanningExportStage(project: CanonicalTsnProjectV0, workflow: WorkflowState): FakeAgentResult {
  const projectWithFlow = withDefaultControlFlow(project, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const bundle = createArtifactBundle(projectWithFlow);
  const summary = `已生成规划器输入和导出清单：${bundle.artifacts.map((artifact) => artifact.path).join("、")}。`;
  const nextWorkflow = recordStageResult(workflow, {
    step: "planning-export",
    summary,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("planning-export", "模拟仿真阶段开始", "刷新仿真输入、规划器输入和项目导出清单；当前不会执行 OMNeT++。"),
    {
      id: "event-export",
      kind: "artifact",
      stage: "planning-export",
      skillName: "tsn-export",
      title: "导出文件",
      content: summary,
      status: "success",
    },
    createStageResultEvent("planning-export", "规划器输入已准备", "flow_plan_1.json 是规划器输入，不是规划器执行结果。"),
    createConfirmationEvent("planning-export", "确认仿真输入后完成本轮草案，或继续描述需要修改的输入文件。"),
  ] satisfies AgentEvent[];

  return {
    project: refreshProject(projectWithFlow),
    bundle,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runUnsupportedSimulationRequest(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const project = previousProject
    ? refreshProject(previousProject)
    : createProjectFromIntent(userIntent || "请生成默认拓扑", undefined, {
        scenarioConfigId: workflow.scenarioConfigId,
        includeControlFlow: false,
      });
  const events = [
    createToolAvailabilityEvent(),
    {
      id: "event-simulation-unsupported",
      kind: "error",
      title: "仿真未执行",
      content: "当前版本还没有接入 OMNeT++/远程服务器仿真 runner。本次不会在后台启动仿真，也不会异步返回仿真结果；请先使用导出文件，后续接入仿真执行器后再启动运行。",
      status: "warning",
    },
  ] satisfies AgentEvent[];

  return {
    project,
    bundle: shouldKeepExportBundle(workflow)
      ? createArtifactBundle(withDefaultControlFlow(project, {
          scenarioConfigId: workflow.scenarioConfigId,
        }))
      : undefined,
    workflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function runQuickGenerate(
  userIntent: string,
  previousProject: CanonicalTsnProjectV0 | undefined,
  workflow: WorkflowState,
): FakeAgentResult {
  const scenarioConfig = getScenarioConfig(workflow.scenarioConfigId);
  const fallbackIntent = previousProject ? inferIntentFromProject(previousProject) : undefined;
  const project = previousProject && !hasExplicitTopologyIntent(userIntent)
    ? refreshProject(previousProject)
    : createProjectFromIntent(userIntent, fallbackIntent, {
        scenarioConfigId: workflow.scenarioConfigId,
      });
  const projectWithFlow = withDefaultControlFlow(project, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
  const bundle = createArtifactBundle(projectWithFlow);
  const intent = inferIntentFromProject(projectWithFlow);
  const topologySummary = describeTopologyIntent(intent);
  const interconnectSummary = describeTopologyInterconnect(intent);
  let nextWorkflow = recordStageResult(workflow, { step: "topology", summary: `${topologySummary}${interconnectSummary}` });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "time-sync",
    summary: scenarioConfig.defaults.timeSyncSummary,
  });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "flow-template",
    summary: `已准备 ${projectWithFlow.flows[0]?.name ?? "流量规划"}。`,
  });
  nextWorkflow = confirmCurrentStage(nextWorkflow);
  nextWorkflow = recordStageResult(nextWorkflow, {
    step: "planning-export",
    summary: `已生成 ${bundle.artifacts.length} 个导出文件。`,
  });
  const events = [
    createToolAvailabilityEvent(),
    createStageStartEvent("topology", "快速生成开始", "按显式快速路径连续完成拓扑、同步、流量规划和模拟仿真输入准备。"),
    createStageResultEvent("topology", "拓扑结果", `${topologySummary}${interconnectSummary}`),
    createStageResultEvent("time-sync", "时间同步默认值", scenarioConfig.defaults.timeSyncSummary),
    createStageResultEvent("flow-template", "流量规划", `已准备 ${projectWithFlow.flows[0]?.name ?? "流量规划"}。`),
    {
      id: "event-export",
      kind: "artifact",
      stage: "planning-export",
      skillName: "tsn-export",
      title: "导出文件",
      content: bundle.artifacts.map((artifact) => artifact.path).join("、"),
      status: "success",
    },
  ] satisfies AgentEvent[];

  return {
    project: projectWithFlow,
    bundle,
    workflow: nextWorkflow,
    events,
    assistantText: events.map((event) => event.content).join("\n"),
  };
}

function isContinuationIntent(text: string): boolean {
  return /^(直接生成|生成|确认|可以|好的|开始|继续|按这个|就这样|执行|下一步)\s*[。.!！]?$/i.test(text.trim());
}

function isStageConfirmationIntent(text: string): boolean {
  return /^(确认|可以|好的|没问题|理解的对|对|正确|按这个|就这样|同意|通过|使用|采用|先给默认|默认|用默认|采用默认|使用默认)/i.test(text.trim());
}

function isQuickGenerateIntent(text: string): boolean {
  return /^(直接生成|生成完整草案|一键生成|生成全部|直接导出)\s*[。.!！]?$/i.test(text.trim());
}

function isSimulationExecutionIntent(text: string): boolean {
  return /启动仿真|运行仿真|执行仿真|跑仿真|跑一下|跑起来|simulation|simulate|omnet|inet|devserver|ssh|服务器/i.test(text);
}

function hasFlowConfigurationIntent(text: string): boolean {
  return /控制流|业务流|视频流|视频|摄像|traffic|flow|流量|时序控制|心跳|安全自毁|姿控|伺服|惯组|发动机|故障诊断/i.test(text);
}

function isStageAdvanceIntent(text: string, stage: WorkflowStep): boolean {
  const trimmed = text.trim();

  if (stage === "time-sync") {
    return /时间同步|时钟同步|同步|统一时钟|gptp|802\.1as/i.test(trimmed) && /开始|继续|做|进入|配置|生成|确认/.test(trimmed);
  }

  if (stage === "flow-template") {
    return /流量规划|建立流|控制流|业务流|流模板|流量/i.test(trimmed) && /开始|继续|做|进入|配置|生成|确认/.test(trimmed);
  }

  return /模拟仿真|仿真输入|发送规划|导出|规划器|保存|生成文件|文件/i.test(trimmed) && /开始|继续|做|进入|配置|生成|确认/.test(trimmed);
}

function hasTopologyChangeIntent(text: string, workflow: WorkflowState): boolean {
  if (workflow.currentStep === "topology") {
    return hasExplicitTopologyIntent(text);
  }

  return hasExplicitTopologyIntent(text) && !hasFlowConfigurationIntent(text)
    || /拓扑|交换机|端系统|终端|host|end/i.test(text) && /改|调整|重新|变成/.test(text);
}

function hasSwitchInterconnectIntent(text: string): boolean {
  return /环形|环网|ring|线型|线性|链式|串联|line/i.test(text)
    || /闭环/.test(text) && !/闭环\s*(?:控制)?流/.test(text);
}

function inferIntentFromProject(project: CanonicalTsnProjectV0): TopologyIntent {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;
  const switchLinkCount = project.topology.links.filter((link) =>
    link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
  ).length;

  return {
    switchCount,
    endSystemsPerSwitch: switchCount > 0 ? Math.round(endSystemCount / switchCount) : 0,
    switchInterconnect: switchCount > 2 && switchLinkCount >= switchCount ? "ring" : "line",
  };
}

function describeTopologyIntent(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "dual-plane-redundant") {
    return `识别到双平面冗余拓扑：${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
  }

  return `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
}

function describeTopologyInterconnect(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "dual-plane-redundant") {
    return "交换机按 A/B 双平面成对分组，端系统双归属接入对应故障域。";
  }

  return intent.switchInterconnect === "ring" ? "交换机采用环形互联。" : "交换机采用线型互联。";
}

function refreshProject(project: CanonicalTsnProjectV0): CanonicalTsnProjectV0 {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
  };
}

function applyUserFlowIntent(
  project: CanonicalTsnProjectV0 | undefined,
  userIntent: string,
  workflow: WorkflowState,
): CanonicalTsnProjectV0 | undefined {
  if (!project || workflow.currentStep === "topology") {
    return project;
  }

  return withFlowsFromIntent(project, userIntent, {
    scenarioConfigId: workflow.scenarioConfigId,
  });
}

function shouldKeepExportBundle(workflow: WorkflowState): boolean {
  const planningStatus = workflow.stages["planning-export"].status;

  return workflow.currentStep === "planning-export"
    && (planningStatus === "waiting_confirmation" || planningStatus === "confirmed");
}

function describeFlow(flow: CanonicalTsnProjectV0["flows"][number]): string {
  return `${flow.name}，路径 ${flow.routeNodeIds.join(" -> ")}，周期 ${flow.periodUs}us，帧长 ${flow.frameSizeBytes}B，PCP ${flow.pcp}`;
}

function createToolAvailabilityEvent(): AgentEvent {
  const runtime = getTopologyRuntimeSummary("available");

  return {
    id: "event-tool-availability",
    kind: "tool-availability",
    title: "拓扑工具",
    content: `${runtime.serverName} ${runtime.status}；${runtime.toolCount} 个 topology MCP 工具可用于模板、初始化、校验、artifact、inspect 和 operations。本轮不会把完整 artifact、端口表、MAC 表或完整 changeSet 写入对话。`,
    status: "info",
  };
}

function createStageStartEvent(stage: WorkflowStep, title: string, content: string): AgentEvent {
  return {
    id: `event-${stage}-start`,
    kind: "stage-start",
    stage,
    title,
    content,
    status: "info",
  };
}

function createStageResultEvent(stage: WorkflowStep, title: string, content: string): AgentEvent {
  return {
    id: `event-${stage}-stage-result`,
    kind: "stage-result",
    stage,
    title,
    content,
    status: "success",
  };
}

function createConfirmationEvent(stage: WorkflowStep, content: string): AgentEvent {
  return {
    id: `event-${stage}-confirmation`,
    kind: "confirmation-required",
    stage,
    title: "等待确认",
    content,
    status: "warning",
  };
}
