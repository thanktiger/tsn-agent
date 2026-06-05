import { buildTopologyArtifacts, describeTopologyArtifacts, validateTopologyArtifacts } from "./artifacts";
import { initializeTopology } from "./initialize";
import { inspectTopology } from "./inspect";
import { applyTopologyOperations } from "./operations";
import { describeTemplates } from "./templates";
import { validateIntermediateTopology } from "./validate";

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

export function getTopologyRuntimeSummary(status: TopologyRuntimeStatus = "available"): TopologyRuntimeSummary {
  return {
    serverName: TOPOLOGY_MCP_SERVER_NAME,
    status,
    toolCount: TOPOLOGY_TOOL_NAMES.length,
    toolNames: [...TOPOLOGY_TOOL_NAMES],
  };
}

export const topologyDomainService = {
  describeTemplates,
  initializeTopology,
  inspectTopology,
  describeTopologyArtifacts,
  validateIntermediateTopology,
  buildTopologyArtifacts,
  validateTopologyArtifacts,
  applyTopologyOperations,
};
