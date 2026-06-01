import type { CanonicalTsnProjectV0, TopologyIntent } from "../domain/canonical";
import {
  createProjectFromIntent,
  parseTopologyIntent,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "../domain/topology-factory";
import { createArtifactBundle, type ArtifactBundle } from "../export/artifact-bundle";
import { normalizePlannerRunState, type PlannerRunState } from "../planner/planner-contract";
import type { WorkflowState } from "../project/project-state";

export interface RepairableSession {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  workflow: WorkflowState;
  plannerRun?: PlannerRunState;
  project?: CanonicalTsnProjectV0;
  bundle?: ArtifactBundle;
}

export function repairSessionTopologyFromMessages<T extends RepairableSession>(session: T): T {
  if (!session.project) {
    return session;
  }

  const inferredProject = inferProjectFromUserMessages(session);
  const baseProject = inferredProject ?? session.project;
  const projectWithFlows = inferFlowsFromUserMessages(session, baseProject);

  if (
    (!inferredProject || isSameTopologyShape(session.project, inferredProject))
    && isSameFlows(session.project, projectWithFlows)
  ) {
    return session;
  }

  return {
    ...session,
    project: projectWithFlows,
    bundle: session.bundle ? createArtifactBundle(projectWithFlows, {
      plannerResult: normalizePlannerRunState(session.plannerRun).resultSnapshot,
    }) : undefined,
  };
}

function inferProjectFromUserMessages(session: RepairableSession): CanonicalTsnProjectV0 | undefined {
  if (!session.project) {
    return undefined;
  }

  const scenarioConfigId = session.workflow.scenarioConfigId;
  let intent = inferTopologyIntentFromProject(session.project);
  let changed = false;

  for (const message of session.messages) {
    if (message.role !== "user") {
      continue;
    }

    if (!hasTopologyRepairIntent(message.content)) {
      continue;
    }

    const nextIntent = parseTopologyIntent(message.content, intent, { scenarioConfigId });

    if (!isSameTopologyIntent(intent, nextIntent)) {
      intent = nextIntent;
      changed = true;
    }
  }

  if (!changed) {
    return undefined;
  }

  return createProjectFromIntent(formatTopologyIntent(intent), intent, {
    scenarioConfigId,
    includeControlFlow: false,
  });
}

function hasTopologyRepairIntent(text: string): boolean {
  return /(\d+)\s*(?:个|台)?\s*(?:系统\s*)?(?:交换机|switch)/i.test(text)
    || /(?:每个|每台|each).*?(\d+)\s*(?:个|台)?\s*(?:网卡|端系统|终端|端(?!口)|host|end)/i.test(text)
    || /(\d+)\s*(?:个|台)?\s*(?:网卡|端系统|终端|端(?!口)|host|end)s?\s*(?:，|,|\s)*(?:平均)?(?:分配|分到|分布|接入|连接)\s*(?:到|至)?\s*(\d+)?\s*(?:个|台)?\s*(?:系统\s*)?(?:交换机|switch)/i.test(text)
    || /双冗余|双平面|系统交换机|双归属|(?:网卡|端系统|终端|端(?!口))\s*[一二两三四五六七八九十\d]+/i.test(text)
    || /拓扑.*(?:改|调整|重新|变成)|(?:改|调整|重新|变成).*拓扑/i.test(text)
    || /环形|环网|ring|线型|线性|链式|串联|line/i.test(text)
    || /闭环/.test(text) && !/闭环\s*(?:控制)?流/.test(text);
}

function inferFlowsFromUserMessages(
  session: RepairableSession,
  project: CanonicalTsnProjectV0,
): CanonicalTsnProjectV0 {
  if (session.workflow.currentStep === "topology") {
    return project;
  }

  const flowReadyProject = shouldIncludeDefaultFlow(session.workflow)
    ? withDefaultControlFlow(project, {
        scenarioConfigId: session.workflow.scenarioConfigId,
      })
    : project;

  return session.messages.reduce<CanonicalTsnProjectV0>((nextProject, message) => {
    if (message.role !== "user") {
      return nextProject;
    }

    return withFlowsFromIntent(nextProject, message.content, {
      scenarioConfigId: session.workflow.scenarioConfigId,
    });
  }, flowReadyProject);
}

function shouldIncludeDefaultFlow(workflow: WorkflowState): boolean {
  return workflow.currentStep === "flow-template"
    || workflow.currentStep === "planning-export"
    || workflow.stages["flow-template"].status === "waiting_confirmation"
    || workflow.stages["flow-template"].status === "confirmed";
}

function inferTopologyIntentFromProject(project: CanonicalTsnProjectV0): TopologyIntent {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;

  return {
    switchCount,
    endSystemsPerSwitch: switchCount > 0 ? Math.round(endSystemCount / switchCount) : 0,
    switchInterconnect: describeSwitchInterconnect(project) === "环形互联" ? "ring" : "line",
  };
}

function isSameTopologyIntent(left: TopologyIntent, right: TopologyIntent): boolean {
  return left.switchCount === right.switchCount
    && left.endSystemsPerSwitch === right.endSystemsPerSwitch
    && (left.switchInterconnect ?? "line") === (right.switchInterconnect ?? "line")
    && left.topologyTemplate === right.topologyTemplate;
}

function isSameTopologyShape(left: CanonicalTsnProjectV0, right: CanonicalTsnProjectV0): boolean {
  return left.topology.nodes.filter((node) => node.type === "switch").length === right.topology.nodes.filter((node) => node.type === "switch").length
    && left.topology.nodes.filter((node) => node.type === "endSystem").length === right.topology.nodes.filter((node) => node.type === "endSystem").length
    && left.topology.links.length === right.topology.links.length;
}

function isSameFlows(left: CanonicalTsnProjectV0, right: CanonicalTsnProjectV0): boolean {
  return left.flows.length === right.flows.length
    && left.flows.every((flow, index) => flow.id === right.flows[index]?.id);
}

function formatTopologyIntent(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "dual-plane-redundant") {
    return `双平面冗余拓扑，创建${intent.switchCount}台交换机，每台连接${intent.endSystemsPerSwitch}个端系统，端系统双归属接入 A/B 平面`;
  }

  const interconnect = intent.switchInterconnect === "ring" ? "环形互联" : "线型互联";
  return `${intent.switchCount}台交换机，每台连接${intent.endSystemsPerSwitch}个端系统，${interconnect}`;
}

function describeSwitchInterconnect(project: CanonicalTsnProjectV0): string {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const switchLinkCount = project.topology.links.filter((link) =>
    link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
  ).length;

  return switchCount > 2 && switchLinkCount >= switchCount ? "环形互联" : "线型互联";
}
