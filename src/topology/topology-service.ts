export type TopologyRuntimeStatus = "unknown" | "available" | "unavailable" | "call_failed";

export interface TopologyRuntimeSummary {
  serverName: "tsn_topology";
  status: TopologyRuntimeStatus;
  toolCount: number;
  toolNames: string[];
}

export const TOPOLOGY_MCP_SERVER_NAME = "tsn_topology" as const;

export const TOPOLOGY_TOOL_NAMES = [
  "topology.describe_templates",
  "topology.initialize",
  "topology.inspect",
  "topology.describe_artifacts",
  "topology.validate",
  "topology.build_artifacts",
  "topology.validate_artifacts",
  "topology.apply_operations",
] as const;

export type TopologyToolName = (typeof TOPOLOGY_TOOL_NAMES)[number];

// 时钟同步阶段的 MCP 工具（与 topology 同 sidecar、同 stdio server，按 stage 分别门控）。
// 独立于 TOPOLOGY_TOOL_NAMES，不参与 topology registry 的 drift 守卫。
export const TIMESYNC_TOOL_NAMES = [
  "timesync.set_gm",
  "timesync.toggle_link",
  "timesync.set_params",
  "timesync.inspect",
  "timesync.undo",
] as const;

export type TimesyncToolName = (typeof TIMESYNC_TOOL_NAMES)[number];

// 流量规划阶段的 MCP 工具（与 topology/timesync 同 sidecar、同 stdio server，按 stage 门控）。
// 独立于 TOPOLOGY_TOOL_NAMES，不参与 topology registry 的 drift 守卫。
export const FLOW_TOOL_NAMES = ["flow.add_stream", "flow.inspect", "flow.remove_stream"] as const;

export type FlowToolName = (typeof FLOW_TOOL_NAMES)[number];

export function getTopologyRuntimeSummary(
  status: TopologyRuntimeStatus = "available",
): TopologyRuntimeSummary {
  return {
    serverName: TOPOLOGY_MCP_SERVER_NAME,
    status,
    toolCount: TOPOLOGY_TOOL_NAMES.length,
    toolNames: [...TOPOLOGY_TOOL_NAMES],
  };
}
