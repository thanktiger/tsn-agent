import type { CanonicalTsnProjectV0, TopologyIntent } from "../domain/canonical";
import {
  createProjectFromIntent,
  parseTopologyIntent,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "../domain/topology-factory";
import { createArtifactBundle, type ArtifactBundle } from "../export/artifact-bundle";
import type { WorkflowState } from "../project/project-state";

export interface RepairableSession {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  workflow: WorkflowState;
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
    bundle: session.bundle ? createArtifactBundle(projectWithFlows) : undefined,
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
    && (left.switchInterconnect ?? "line") === (right.switchInterconnect ?? "line");
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
