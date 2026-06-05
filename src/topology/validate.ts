/**
 * @deprecated Phase B (plan v3 U9b 范围)：sidecar 现在 owns topology 校验
 * （`topology_compute::validate_intermediate_topology` 1:1 镜像本算法）。
 * 此 TS 文件保留是因为 `topology-workflow-stage-result.ts` 等还在用；
 * 完整删除是 Phase B 后续 PR 范围。新代码用 MCP `topology.validate`。
 */
import { TOPOLOGY_LIMITS, measureJsonBytes, measureJsonDepth } from "./limits";
import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateTopology,
  type IntermediateTopologySchemaVersion,
  summarizeTopology,
  type TopologyValidationReport,
} from "./intermediate";
import { topologyError, topologyWarning, type TopologyError, type TopologyWarning } from "./tool-result";

const NODE_TYPES = new Set(["switch", "endSystem", "server"]);
const LINK_MEDIA = new Set(["ethernet"]);

export function validateIntermediateTopology(topology: unknown): TopologyValidationReport {
  const errors: TopologyError[] = [];
  const warnings: TopologyWarning[] = [];

  if (!topology || typeof topology !== "object" || Array.isArray(topology)) {
    errors.push(topologyError({
      code: "INVALID_INTERMEDIATE",
      message: "IntermediateTopology must be an object.",
      path: "$",
    }));
    return report(emptyTopology(), errors, warnings);
  }

  const candidate = topology as Partial<IntermediateTopology>;
  if (candidate.schemaVersion !== INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION) {
    errors.push(topologyError({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported topology schemaVersion: ${String(candidate.schemaVersion)}`,
      path: "$.schemaVersion",
    }));
  }

  checkJsonLimits(candidate, errors);

  if (!candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata)) {
    errors.push(topologyError({
      code: "MISSING_METADATA",
      message: "IntermediateTopology.metadata must be an object.",
      path: "$.metadata",
    }));
  }

  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const links = Array.isArray(candidate.links) ? candidate.links : [];

  if (!Array.isArray(candidate.nodes)) {
    errors.push(topologyError({
      code: "INVALID_NODES",
      message: "IntermediateTopology.nodes must be an array.",
      path: "$.nodes",
    }));
  } else if (nodes.length === 0) {
    errors.push(topologyError({
      code: "MISSING_NODES",
      message: "IntermediateTopology.nodes must not be empty.",
      path: "$.nodes",
    }));
  }

  if (!Array.isArray(candidate.links)) {
    errors.push(topologyError({
      code: "INVALID_LINKS",
      message: "IntermediateTopology.links must be an array.",
      path: "$.links",
    }));
  }

  if (!Array.isArray(candidate.diagnostics)) {
    errors.push(topologyError({
      code: "INVALID_DIAGNOSTICS",
      message: "IntermediateTopology.diagnostics must be an array.",
      path: "$.diagnostics",
    }));
  }

  if (nodes.length > TOPOLOGY_LIMITS.maxNodes) {
    errors.push(limitError("maxNodes", "$.nodes", nodes.length));
  }

  if (links.length > TOPOLOGY_LIMITS.maxLinks) {
    errors.push(limitError("maxLinks", "$.links", links.length));
  }

  const nodeIds = new Set<string>();
  const nodeNumericIds = new Set<number>();
  const portIdsByNode = new Map<string, Set<string>>();
  const nodeTypesById = new Map<string, string>();

  nodes.forEach((node, index) => validateNode(
    node as Partial<IntermediateNode>,
    index,
    errors,
    nodeIds,
    nodeNumericIds,
    portIdsByNode,
    nodeTypesById,
  ));
  validateLinks(links as Array<Partial<IntermediateLink>>, errors, nodeIds, portIdsByNode);

  if (nodes.some((node) => (node as Partial<IntermediateNode>).type === "server")) {
    warnings.push(topologyWarning({
      code: "SERVER_NODE_COMPATIBILITY_ONLY",
      message: "server nodes are allowed for legacy artifact compatibility but are not supported by the canonical project bridge.",
      path: "$.nodes",
    }));
  }

  return report(candidate as IntermediateTopology, errors, warnings);
}

function validateNode(
  node: Partial<IntermediateNode>,
  index: number,
  errors: TopologyError[],
  nodeIds: Set<string>,
  nodeNumericIds: Set<number>,
  portIdsByNode: Map<string, Set<string>>,
  nodeTypesById: Map<string, string>,
): void {
  const path = `$.nodes[${index}]`;

  if (typeof node.id !== "string" || node.id.trim() === "") {
    errors.push(topologyError({
      code: "MISSING_NODE_ID",
      message: "Node id must be a non-empty string.",
      path: `${path}.id`,
    }));
  } else if (nodeIds.has(node.id)) {
    errors.push(topologyError({
      code: "DUPLICATE_NODE_ID",
      message: `Duplicate node id: ${node.id}`,
      path: `${path}.id`,
    }));
  } else {
    nodeIds.add(node.id);
    nodeTypesById.set(node.id, String(node.type));
  }

  const nodeNumericId = node.numericId;
  if (typeof nodeNumericId !== "number" || !Number.isInteger(nodeNumericId) || nodeNumericId < 0) {
    errors.push(topologyError({
      code: "INVALID_NODE_NUMERIC_ID",
      message: "Node numericId must be a non-negative integer.",
      path: `${path}.numericId`,
    }));
  } else if (nodeNumericIds.has(nodeNumericId)) {
    errors.push(topologyError({
      code: "DUPLICATE_NODE_NUMERIC_ID",
      message: `Duplicate node numericId: ${nodeNumericId}`,
      path: `${path}.numericId`,
    }));
  } else {
    nodeNumericIds.add(nodeNumericId);
  }

  if (typeof node.name !== "string" || node.name.trim() === "") {
    errors.push(topologyError({
      code: "INVALID_NODE_NAME",
      message: "Node name must be a non-empty string.",
      path: `${path}.name`,
    }));
  }

  if (typeof node.type !== "string" || !NODE_TYPES.has(node.type)) {
    errors.push(topologyError({
      code: "UNSUPPORTED_NODE_TYPE",
      message: `Unsupported node type: ${String(node.type)}`,
      path: `${path}.type`,
    }));
  }

  if (!Array.isArray(node.ports) || node.ports.length === 0) {
    errors.push(topologyError({
      code: "MISSING_NODE_PORTS",
      message: "Node ports must be a non-empty array.",
      path: `${path}.ports`,
    }));
  } else {
    if (node.ports.length > TOPOLOGY_LIMITS.maxPortsPerNode) {
      errors.push(limitError("maxPortsPerNode", `${path}.ports`, node.ports.length));
    }

    const portIds = new Set<string>();
    node.ports.forEach((port, portIndex) => {
      const portPath = `${path}.ports[${portIndex}]`;
      if (typeof port.id !== "string" || port.id.trim() === "") {
        errors.push(topologyError({
          code: "MISSING_PORT_ID",
          message: "Port id must be a non-empty string.",
          path: `${portPath}.id`,
        }));
      } else if (portIds.has(port.id)) {
        errors.push(topologyError({
          code: "DUPLICATE_PORT_ID",
          message: `Duplicate port id on node ${String(node.id)}: ${port.id}`,
          path: `${portPath}.id`,
        }));
      } else {
        portIds.add(port.id);
      }

      if (!Number.isInteger(port.index) || port.index < 0) {
        errors.push(topologyError({
          code: "INVALID_PORT_INDEX",
          message: "Port index must be a non-negative integer.",
          path: `${portPath}.index`,
        }));
      }
    });

    if (typeof node.id === "string") {
      portIdsByNode.set(node.id, portIds);
    }
  }

  if (!node.position || typeof node.position.x !== "number" || typeof node.position.y !== "number") {
    errors.push(topologyError({
      code: "INVALID_NODE_POSITION",
      message: "Node position must contain numeric x and y.",
      path: `${path}.position`,
    }));
  }
}

function validateLinks(
  links: Array<Partial<IntermediateLink>>,
  errors: TopologyError[],
  nodeIds: Set<string>,
  portIdsByNode: Map<string, Set<string>>,
): void {
  const linkIds = new Set<string>();
  const linkNumericIds = new Set<number>();
  const usedPorts = new Map<string, string>();

  links.forEach((link, index) => {
    const path = `$.links[${index}]`;

    if (typeof link.id !== "string" || link.id.trim() === "") {
      errors.push(topologyError({
        code: "MISSING_LINK_ID",
        message: "Link id must be a non-empty string.",
        path: `${path}.id`,
      }));
    } else if (linkIds.has(link.id)) {
      errors.push(topologyError({
        code: "DUPLICATE_LINK_ID",
        message: `Duplicate link id: ${link.id}`,
        path: `${path}.id`,
      }));
    } else {
      linkIds.add(link.id);
    }

    const linkNumericId = link.numericId;
    if (typeof linkNumericId !== "number" || !Number.isInteger(linkNumericId) || linkNumericId < 0) {
      errors.push(topologyError({
        code: "INVALID_LINK_NUMERIC_ID",
        message: "Link numericId must be a non-negative integer.",
        path: `${path}.numericId`,
      }));
    } else if (linkNumericIds.has(linkNumericId)) {
      errors.push(topologyError({
        code: "DUPLICATE_LINK_NUMERIC_ID",
        message: `Duplicate link numericId: ${linkNumericId}`,
        path: `${path}.numericId`,
      }));
    } else {
      linkNumericIds.add(linkNumericId);
    }

    if (typeof link.medium !== "string" || !LINK_MEDIA.has(link.medium)) {
      errors.push(topologyError({
        code: "UNSUPPORTED_LINK_MEDIUM",
        message: `Unsupported link medium: ${String(link.medium)}`,
        path: `${path}.medium`,
      }));
    }

    if (!Number.isInteger(link.dataRateMbps) || Number(link.dataRateMbps) <= 0) {
      errors.push(topologyError({
        code: "INVALID_LINK_RATE",
        message: "Link dataRateMbps must be a positive integer.",
        path: `${path}.dataRateMbps`,
      }));
    }

    validateEndpoint(link.source, `${path}.source`, errors, nodeIds, portIdsByNode, usedPorts, link.id);
    validateEndpoint(link.target, `${path}.target`, errors, nodeIds, portIdsByNode, usedPorts, link.id);

    if (link.source?.nodeId && link.target?.nodeId && link.source.nodeId === link.target.nodeId) {
      errors.push(topologyError({
        code: "SELF_LINK",
        message: `Link ${String(link.id)} cannot connect a node to itself.`,
        path,
      }));
    }
  });
}

function validateEndpoint(
  endpoint: Partial<IntermediateLink["source"]> | undefined,
  path: string,
  errors: TopologyError[],
  nodeIds: Set<string>,
  portIdsByNode: Map<string, Set<string>>,
  usedPorts: Map<string, string>,
  linkId: unknown,
): void {
  if (!endpoint || typeof endpoint !== "object") {
    errors.push(topologyError({
      code: "MISSING_LINK_ENDPOINT",
      message: "Link endpoint must be an object.",
      path,
    }));
    return;
  }

  if (typeof endpoint.nodeId !== "string" || !nodeIds.has(endpoint.nodeId)) {
    errors.push(topologyError({
      code: "UNKNOWN_ENDPOINT_NODE",
      message: `Endpoint node does not exist: ${String(endpoint.nodeId)}`,
      path: `${path}.nodeId`,
    }));
    return;
  }

  const portIds = portIdsByNode.get(endpoint.nodeId);
  if (typeof endpoint.portId !== "string" || !portIds?.has(endpoint.portId)) {
    errors.push(topologyError({
      code: "UNKNOWN_ENDPOINT_PORT",
      message: `Endpoint port does not exist: ${endpoint.nodeId}.${String(endpoint.portId)}`,
      path: `${path}.portId`,
    }));
    return;
  }

  const portKey = `${endpoint.nodeId}:${endpoint.portId}`;
  const currentLinkId = String(linkId);
  const previousLinkId = usedPorts.get(portKey);

  if (previousLinkId !== undefined) {
    errors.push(topologyError({
      code: "PORT_ALREADY_USED",
      message: `Port ${portKey} is used by both ${previousLinkId} and ${currentLinkId}.`,
      path,
    }));
    return;
  }

  usedPorts.set(portKey, currentLinkId);
}

function checkJsonLimits(topology: unknown, errors: TopologyError[]): void {
  const depth = measureJsonDepth(topology);
  if (depth > TOPOLOGY_LIMITS.maxJsonDepth) {
    errors.push(limitError("maxJsonDepth", "$", depth));
  }

  const bytes = measureJsonBytes(topology);
  if (bytes > TOPOLOGY_LIMITS.maxIngressPayloadBytes) {
    errors.push(limitError("maxIngressPayloadBytes", "$", bytes));
  }
}

function limitError(limit: keyof typeof TOPOLOGY_LIMITS, path: string, actual: number): TopologyError {
  return topologyError({
    code: "LIMIT_EXCEEDED",
    message: `${limit} exceeded: ${actual} > ${TOPOLOGY_LIMITS[limit]}`,
    path,
    details: {
      limit,
      actual,
      maximum: TOPOLOGY_LIMITS[limit],
    },
  });
}

function emptyTopology(): IntermediateTopology {
  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION as IntermediateTopologySchemaVersion,
    metadata: {},
    nodes: [],
    links: [],
    diagnostics: [],
  };
}

function report(
  topology: IntermediateTopology,
  errors: TopologyError[],
  warnings: TopologyWarning[],
): TopologyValidationReport {
  const summary = summarizeTopology({
    ...emptyTopology(),
    ...topology,
    nodes: Array.isArray(topology.nodes) ? topology.nodes : [],
    links: Array.isArray(topology.links) ? topology.links : [],
    diagnostics: Array.isArray(topology.diagnostics) ? topology.diagnostics : [],
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      ...summary,
      valid: errors.length === 0,
      errorCodes: [...new Set(errors.map((error) => error.code))],
    },
  };
}
