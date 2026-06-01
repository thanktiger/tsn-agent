import { TOPOLOGY_LIMITS } from "./limits";
import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateTopology,
} from "./intermediate";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export type TopologyOperation =
  | { op: "link.delete"; linkId: string }
  | { op: "node.add"; node: IntermediateNode }
  | { op: "link.add"; link: IntermediateLink };

export interface TopologyApplyOperationsRequest {
  topology: IntermediateTopology;
  operations: TopologyOperation[];
  dryRun?: boolean;
  responseMode?: TopologyResponseMode;
}

type IncomingTopologyOperation = TopologyOperation | { op?: unknown };

export interface TopologyChangeSet {
  dryRun: boolean;
  addedNodeIds: string[];
  removedNodeIds: string[];
  addedLinkIds: string[];
  removedLinkIds: string[];
  allocatedPorts: Array<{ nodeId: string; portId: string; linkId: string }>;
  releasedPorts: Array<{ nodeId: string; portId: string; linkId: string }>;
  flowImpact: {
    removedLinkIds: string[];
    addedLinkIds: string[];
  };
}

export interface TopologyApplySummary {
  dryRun: boolean;
  nodeCount: number;
  linkCount: number;
  changeSet: {
    addedNodeCount: number;
    removedNodeCount: number;
    addedLinkCount: number;
    removedLinkCount: number;
    allocatedPortCount: number;
    releasedPortCount: number;
    flowImpact: {
      removedLinkCount: number;
      addedLinkCount: number;
    };
  };
}

export interface TopologyApplyFull {
  topology: IntermediateTopology;
  changeSet: TopologyChangeSet;
}

export function applyTopologyOperations(
  request: TopologyApplyOperationsRequest,
): TopologyToolResult<TopologyApplySummary, TopologyApplyFull> {
  const responseMode = request.responseMode ?? "summary";
  const validation = validateIntermediateTopology(request.topology);

  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "INVALID_OPERATIONS",
          message: "operations must be a non-empty array.",
          path: "$.operations",
        }),
      ],
    });
  }

  if (request.operations.length > TOPOLOGY_LIMITS.maxOperations) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "LIMIT_EXCEEDED",
          message: `operation count exceeded: ${request.operations.length} > ${TOPOLOGY_LIMITS.maxOperations}`,
          path: "$.operations",
          details: {
            limit: "maxOperations",
            actual: request.operations.length,
            maximum: TOPOLOGY_LIMITS.maxOperations,
          },
        }),
      ],
    });
  }

  const operations = request.operations as IncomingTopologyOperation[];
  const unsupported = operations.find((operation) =>
    operation.op !== "link.delete" && operation.op !== "node.add" && operation.op !== "link.add"
  );

  if (unsupported) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "UNSUPPORTED_OPERATION",
          message: `${unsupported.op} is not supported in topology.apply_operations P0.`,
          path: `$.operations[${operations.indexOf(unsupported)}].op`,
        }),
      ],
    });
  }

  const simulation = simulateOperations(request.topology, request.operations);
  if (!simulation.ok) {
    return failResult({ responseMode, errors: simulation.errors });
  }

  const updatedValidation = validateIntermediateTopology(simulation.topology);
  if (!updatedValidation.ok) {
    return failResult({ responseMode, errors: updatedValidation.errors, warnings: updatedValidation.warnings });
  }

  const changeSet = {
    ...simulation.changeSet,
    dryRun: request.dryRun === true,
  };

  return okResult({
    responseMode,
    summary: {
      dryRun: request.dryRun === true,
      nodeCount: simulation.topology.nodes.length,
      linkCount: simulation.topology.links.length,
      changeSet: summarizeChangeSet(changeSet),
    },
    full: {
      topology: simulation.topology,
      changeSet,
    },
    warnings: updatedValidation.warnings,
  });
}

function simulateOperations(
  topology: IntermediateTopology,
  operations: TopologyOperation[],
): { ok: true; topology: IntermediateTopology; changeSet: TopologyChangeSet } | { ok: false; errors: ReturnType<typeof topologyError>[] } {
  const nodes = [...topology.nodes];
  const links = [...topology.links];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const linkById = new Map(links.map((link) => [link.id, link]));
  const errors: ReturnType<typeof topologyError>[] = [];
  const addedNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const addedLinkIds: string[] = [];
  const removedLinkIds: string[] = [];
  const allocatedPorts: TopologyChangeSet["allocatedPorts"] = [];
  const releasedPorts: TopologyChangeSet["releasedPorts"] = [];

  for (const [index, operation] of operations.entries()) {
    const path = `$.operations[${index}]`;

    if (operation.op === "link.delete") {
      const link = linkById.get(operation.linkId);
      if (!link) {
        errors.push(topologyError({
          code: "LINK_NOT_FOUND",
          message: `Link ${operation.linkId} does not exist.`,
          path: `${path}.linkId`,
        }));
        continue;
      }

      linkById.delete(operation.linkId);
      links.splice(links.findIndex((link) => link.id === operation.linkId), 1);
      removedLinkIds.push(operation.linkId);
      releasedPorts.push(
        { nodeId: link.source.nodeId, portId: link.source.portId, linkId: link.id },
        { nodeId: link.target.nodeId, portId: link.target.portId, linkId: link.id },
      );
      continue;
    }

    if (operation.op === "node.add") {
      if (nodeById.has(operation.node.id)) {
        errors.push(topologyError({
          code: "DUPLICATE_NODE_ID",
          message: `Node ${operation.node.id} already exists.`,
          path: `${path}.node.id`,
        }));
        continue;
      }

      nodeById.set(operation.node.id, operation.node);
      nodes.push(operation.node);
      addedNodeIds.push(operation.node.id);
      continue;
    }

    if (operation.op === "link.add") {
      if (linkById.has(operation.link.id)) {
        errors.push(topologyError({
          code: "DUPLICATE_LINK_ID",
          message: `Link ${operation.link.id} already exists.`,
          path: `${path}.link.id`,
        }));
        continue;
      }

      if (!nodeById.has(operation.link.source.nodeId)) {
        errors.push(topologyError({
          code: "UNKNOWN_ENDPOINT_NODE",
          message: `Endpoint node does not exist: ${operation.link.source.nodeId}`,
          path: `${path}.link.source.nodeId`,
        }));
      }

      if (!nodeById.has(operation.link.target.nodeId)) {
        errors.push(topologyError({
          code: "UNKNOWN_ENDPOINT_NODE",
          message: `Endpoint node does not exist: ${operation.link.target.nodeId}`,
          path: `${path}.link.target.nodeId`,
        }));
      }

      linkById.set(operation.link.id, operation.link);
      links.push(operation.link);
      addedLinkIds.push(operation.link.id);
      allocatedPorts.push(
        { nodeId: operation.link.source.nodeId, portId: operation.link.source.portId, linkId: operation.link.id },
        { nodeId: operation.link.target.nodeId, portId: operation.link.target.portId, linkId: operation.link.id },
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const updatedTopology: IntermediateTopology = {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      ...topology.metadata,
      source: "operations",
    },
    nodes,
    links,
    diagnostics: topology.diagnostics,
  };
  const changeSet: TopologyChangeSet = {
    dryRun: false,
    addedNodeIds,
    removedNodeIds,
    addedLinkIds,
    removedLinkIds,
    allocatedPorts,
    releasedPorts,
    flowImpact: {
      removedLinkIds,
      addedLinkIds,
    },
  };

  return {
    ok: true,
    topology: updatedTopology,
    changeSet,
  };
}

function summarizeChangeSet(changeSet: TopologyChangeSet): TopologyApplySummary["changeSet"] {
  return {
    addedNodeCount: changeSet.addedNodeIds.length,
    removedNodeCount: changeSet.removedNodeIds.length,
    addedLinkCount: changeSet.addedLinkIds.length,
    removedLinkCount: changeSet.removedLinkIds.length,
    allocatedPortCount: changeSet.allocatedPorts.length,
    releasedPortCount: changeSet.releasedPorts.length,
    flowImpact: {
      removedLinkCount: changeSet.flowImpact.removedLinkIds.length,
      addedLinkCount: changeSet.flowImpact.addedLinkIds.length,
    },
  };
}
