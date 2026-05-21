import type { CanonicalTsnProjectV0, TsnFlow } from "../domain/canonical";

export interface PlannerInputV1 {
  base: {
    id: number;
    name: string;
    remark: string;
    createdAt: number;
    updatedAt: number;
  };
  stream_info: Array<{
    stream_id: number;
    stream_name: string;
    size: string;
    period: string;
    path: Array<{
      dst_mac: string;
      src_mac: string;
      dst_ip: string;
      src_ip: string;
      dst_port: string;
      src_port: string;
      ip_protocol: 17;
      pcp: string;
      max_frames_per_interval: string;
      earliest_transmit_offset: string;
      latest_transmit_offset: string;
      jitter_requirement: string;
      latency_requirement: string;
      redundant: "1";
      flow_type: "ST" | "BE";
      fl_api_flag: 1;
      delay_para: 300;
      fivetuple_mask: 11111;
      route: number[];
      node: number[];
    }>;
    nodePaths: Array<{
      nodePath: string;
      linkPath: string;
      link_planning_mode: "manual";
    }>;
  }>;
}

export function exportPlannerInput(project: CanonicalTsnProjectV0): PlannerInputV1 {
  const createdAt = Date.parse(project.createdAt);
  const updatedAt = Date.parse(project.updatedAt);

  return {
    base: {
      id: 1,
      name: project.name,
      remark: "由 TSN Agent MVP 生成的规划输入",
      createdAt,
      updatedAt,
    },
    stream_info: project.flows.map((flow) => exportFlow(project, flow)),
  };
}

function exportFlow(project: CanonicalTsnProjectV0, flow: TsnFlow): PlannerInputV1["stream_info"][number] {
  const routeNumericIds = flow.routeLinkIds.map((linkId) => {
    const link = project.topology.links.find((candidate) => candidate.id === linkId);
    return link?.numericId ?? -1;
  }).filter((numericId) => numericId >= 0);
  const routeNodeNumericIds = flow.routeNodeIds.map((nodeId) => {
    const node = project.topology.nodes.find((candidate) => candidate.id === nodeId);
    return node?.numericId ?? -1;
  }).filter((numericId) => numericId >= 0);

  return {
    stream_id: flow.numericId,
    stream_name: flow.name,
    size: String(flow.frameSizeBytes),
    period: String(flow.periodUs),
    path: [
      {
        dst_mac: flow.destination.macAddress,
        src_mac: flow.source.macAddress,
        dst_ip: flow.destination.ipAddress,
        src_ip: flow.source.ipAddress,
        dst_port: String(flow.destination.udpPort),
        src_port: String(flow.source.udpPort),
        ip_protocol: 17,
        pcp: String(flow.pcp),
        max_frames_per_interval: String(flow.maxFramesPerInterval),
        earliest_transmit_offset: String(flow.earliestTransmitOffsetUs),
        latest_transmit_offset: String(flow.latestTransmitOffsetUs),
        jitter_requirement: String(flow.jitterRequirementUs),
        latency_requirement: String(flow.latencyRequirementUs),
        redundant: "1",
        flow_type: flow.flowType,
        fl_api_flag: 1,
        delay_para: 300,
        fivetuple_mask: 11111,
        route: routeNumericIds,
        node: routeNodeNumericIds,
      },
    ],
    nodePaths: [
      {
        nodePath: routeNodeNumericIds.join("."),
        linkPath: routeNumericIds.join("."),
        link_planning_mode: "manual",
      },
    ],
  };
}
