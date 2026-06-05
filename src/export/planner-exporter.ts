/**
 * @deprecated Phase B (plan v3 U9b 范围)：流量规划导出在 P0 暂下线
 * （UI 灰掉 flow-template / planning-export workflow 阶段），boss 在 P1 重新
 * 构建。完整删除是 Phase B 后续 PR（与 inet-traffic / inet-gcl / artifact-bundle
 * 中 flow 部分一同删）。Phase B-α 仅打标。
 */
import type { CanonicalTsnProjectV0, TsnFlow, TsnLink, TsnNode, TsnPort } from "../domain/canonical";
import {
  type PlannerFlowFeature,
  type PlannerNodeParameter,
  type PlannerPathFeature,
  type PlannerStartRequest,
  type PlannerTopoFeature,
} from "../planner/planner-contract";
import {
  PLANNER_LINK_DEFAULTS,
  PLANNER_NODE_PARAMETER_DEFAULTS,
  PLANNER_PATH_DEFAULTS,
} from "../planner/planner-defaults";

export type PlannerInputV1 = PlannerStartRequest;

export function exportPlannerInput(project: CanonicalTsnProjectV0): PlannerInputV1 {
  validatePlannerExportProject(project);

  return {
    sendData: {
      mode: "time-trigger",
      source_config: {
        cfg_parameter: {
          cfg_parameter: {
            node: project.topology.nodes.map(exportNodeParameter),
          },
        },
        flow_feature: project.flows.map((flow) => exportFlowFeature(project, flow)),
        topo_feature: project.topology.links.map((link) => exportTopoFeature(project, link)),
      },
    },
  };
}

function exportNodeParameter(node: TsnNode): PlannerNodeParameter {
  return {
    ...PLANNER_NODE_PARAMETER_DEFAULTS,
    node_id: String(node.numericId),
    port_num: String(node.ports.length),
    node_type: node.type === "switch" ? "0" : "1",
  };
}

function exportFlowFeature(project: CanonicalTsnProjectV0, flow: TsnFlow): PlannerFlowFeature {
  if (flow.flowType !== "ST") {
    throw new Error(`Cannot export planner input: flow ${flow.id} uses unsupported flow type ${flow.flowType}.`);
  }

  if (flow.routeLinkIds.length === 0) {
    throw new Error(`Cannot export planner input: flow ${flow.id} has no route links.`);
  }

  return {
    stream_id: flow.numericId,
    src_node: numericNodeId(project, flow.source.nodeId, flow.id),
    dst_node: numericNodeId(project, flow.destination.nodeId, flow.id),
    path_number: 1,
    size: flow.frameSizeBytes,
    period: flow.periodUs,
    path: [exportPathFeature(project, flow)],
  };
}

function exportPathFeature(project: CanonicalTsnProjectV0, flow: TsnFlow): PlannerPathFeature {
  return {
    route: flow.routeLinkIds.map((linkId) => numericLinkId(project, flow, linkId)),
    flow_type: "ST",
    latency_requirement: flow.latencyRequirementUs,
    jitter_requirement: flow.jitterRequirementUs,
    redundant: PLANNER_PATH_DEFAULTS.redundant,
    fl_api_flag: PLANNER_PATH_DEFAULTS.fl_api_flag,
    delay_para: PLANNER_PATH_DEFAULTS.delay_para,
    src_ip: flow.source.ipAddress,
    dst_ip: flow.destination.ipAddress,
    src_port: flow.source.udpPort,
    dst_port: flow.destination.udpPort,
    dst_mac: flow.destination.macAddress,
    ip_protocol: PLANNER_PATH_DEFAULTS.ip_protocol,
    fivetuple_mask: PLANNER_PATH_DEFAULTS.fivetuple_mask,
  };
}

function exportTopoFeature(project: CanonicalTsnProjectV0, link: TsnLink): PlannerTopoFeature {
  const sourceNode = findNode(project, link.source.nodeId);
  const targetNode = findNode(project, link.target.nodeId);

  return {
    link_id: link.numericId,
    src_node: sourceNode.numericId,
    src_port: portIndex(sourceNode, link.source.portId, link.id),
    dst_node: targetNode.numericId,
    dst_port: portIndex(targetNode, link.target.portId, link.id),
    speed: link.dataRateMbps,
    st_queues: PLANNER_LINK_DEFAULTS.st_queues,
    macrotick: PLANNER_LINK_DEFAULTS.macrotick,
  };
}

function validatePlannerExportProject(project: CanonicalTsnProjectV0): void {
  if (project.topology.nodes.length === 0) {
    throw new Error("Cannot export planner input: project has no topology nodes.");
  }

  if (project.topology.links.length === 0) {
    throw new Error("Cannot export planner input: project has no topology links.");
  }

  if (project.flows.length === 0) {
    throw new Error("Cannot export planner input: project has no flows.");
  }

  assertUnique(project.topology.nodes.map((node) => node.numericId), "node numericId");
  assertUnique(project.topology.links.map((link) => link.numericId), "link numericId");
  assertUnique(project.flows.map((flow) => flow.numericId), "flow numericId");
}

function assertUnique(values: number[], label: string): void {
  const seen = new Set<number>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Cannot export planner input: duplicated ${label} ${value}.`);
    }

    seen.add(value);
  }
}

function numericNodeId(project: CanonicalTsnProjectV0, nodeId: string, flowId: string): number {
  const node = project.topology.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new Error(`Cannot export planner input: flow ${flowId} references missing node ${nodeId}.`);
  }

  return node.numericId;
}

function numericLinkId(project: CanonicalTsnProjectV0, flow: TsnFlow, linkId: string): number {
  const link = project.topology.links.find((candidate) => candidate.id === linkId);

  if (!link) {
    throw new Error(`Cannot export planner input: flow ${flow.id} references missing route link ${linkId}.`);
  }

  return link.numericId;
}

function findNode(project: CanonicalTsnProjectV0, nodeId: string): TsnNode {
  const node = project.topology.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new Error(`Cannot export planner input: link references missing node ${nodeId}.`);
  }

  return node;
}

function portIndex(node: TsnNode, portId: string, linkId: string): number {
  const port = node.ports.find((candidate: TsnPort) => candidate.id === portId);

  if (!port) {
    throw new Error(`Cannot export planner input: link ${linkId} references missing port ${node.id}.${portId}.`);
  }

  return port.index;
}
