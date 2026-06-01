import { TOPOLOGY_LIMITS, measureJsonBytes } from "./limits";
import {
  deriveLegacyIp,
  deriveLegacyMac,
  sortLinksByNumericId,
  sortNodesByNumericId,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateNodeType,
  type IntermediateTopology,
} from "./intermediate";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export type TopologyArtifactName =
  | "topology.json"
  | "topo_feature.json"
  | "data-server.json"
  | "mac-forwarding-table.json";

export interface TopologyArtifact<TData = unknown> {
  name: TopologyArtifactName;
  mediaType: "application/json";
  data: TData;
  text: string;
  byteLength: number;
}

export interface TopologyArtifacts {
  "topology.json": TopologyArtifact<LegacyTopologyJson>;
  "topo_feature.json": TopologyArtifact<LegacyTopoFeatureEntry[]>;
  "data-server.json": TopologyArtifact<LegacyDataServerJson>;
  "mac-forwarding-table.json": TopologyArtifact<LegacyMacForwardingTableJson>;
}

export interface TopologyArtifactSummary {
  artifactCount: number;
  artifactNames: TopologyArtifactName[];
  totalBytes: number;
  topologyNodeCount: number;
  topologyLinkCount: number;
  macEntryCount: number;
  containsHtml: false;
}

export interface TopologyBuildArtifactsFull {
  artifacts: TopologyArtifacts;
}

export function buildTopologyArtifacts(input: {
  topology: IntermediateTopology;
  responseMode?: TopologyResponseMode;
}): TopologyToolResult<TopologyArtifactSummary, TopologyBuildArtifactsFull> {
  const responseMode = input.responseMode ?? "summary";
  const validation = validateIntermediateTopology(input.topology);

  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  const topologyJson = buildLegacyTopologyJson(input.topology);
  const topoFeature = buildLegacyTopoFeature(input.topology);
  const dataServer = buildLegacyDataServer(input.topology);
  const macForwardingTable = buildLegacyMacForwardingTable(input.topology);
  const artifacts = {
    "topology.json": createArtifact("topology.json", topologyJson),
    "topo_feature.json": createArtifact("topo_feature.json", topoFeature),
    "data-server.json": createArtifact("data-server.json", dataServer),
    "mac-forwarding-table.json": createArtifact("mac-forwarding-table.json", macForwardingTable),
  } satisfies TopologyArtifacts;
  const totalBytes = Object.values(artifacts).reduce((sum, artifact) => sum + artifact.byteLength, 0);

  if (totalBytes > TOPOLOGY_LIMITS.maxArtifactBytes) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "LIMIT_EXCEEDED",
          message: `Artifact bytes exceeded: ${totalBytes} > ${TOPOLOGY_LIMITS.maxArtifactBytes}`,
          path: "$.artifacts",
          details: {
            limit: "maxArtifactBytes",
            actual: totalBytes,
            maximum: TOPOLOGY_LIMITS.maxArtifactBytes,
          },
        }),
      ],
    });
  }

  return okResult({
    responseMode,
    summary: summarizeArtifacts(artifacts),
    full: { artifacts },
    warnings: validation.warnings,
  });
}

export function describeTopologyArtifacts(input: {
  artifacts: TopologyArtifacts;
  responseMode?: TopologyResponseMode;
}): TopologyToolResult<TopologyArtifactSummary> {
  return okResult({
    responseMode: input.responseMode ?? "summary",
    summary: summarizeArtifacts(input.artifacts),
  });
}

export function validateTopologyArtifacts(input: {
  artifacts: Partial<Record<TopologyArtifactName, unknown>>;
  responseMode?: TopologyResponseMode;
}): TopologyToolResult<{ valid: boolean; errorCount: number; artifactNames: string[] }> {
  const errors = [];
  const topology = input.artifacts["topology.json"] as LegacyTopologyJson | undefined;
  const topoFeature = input.artifacts["topo_feature.json"] as LegacyTopoFeatureEntry[] | undefined;
  const dataServer = input.artifacts["data-server.json"] as LegacyDataServerJson | undefined;
  const macTable = input.artifacts["mac-forwarding-table.json"] as LegacyMacForwardingTableJson | undefined;

  if (!topology?.node || !Array.isArray(topology.node.nodes) || !Array.isArray(topology.node.links)) {
    errors.push(topologyError({
      code: "INVALID_ARTIFACT",
      message: "topology.json must contain node.nodes and node.links arrays.",
      path: "$.artifacts['topology.json']",
    }));
  }

  if (!Array.isArray(topoFeature)) {
    errors.push(topologyError({
      code: "INVALID_ARTIFACT",
      message: "topo_feature.json must be an array.",
      path: "$.artifacts['topo_feature.json']",
    }));
  }

  if (!dataServer || dataServer.version !== "2.0" || !Array.isArray(dataServer.datas)) {
    errors.push(topologyError({
      code: "INVALID_ARTIFACT",
      message: "data-server.json must contain version 2.0 and datas array.",
      path: "$.artifacts['data-server.json']",
    }));
  }

  if (!macTable || macTable.version !== "1.0" || !Array.isArray(macTable.entries)) {
    errors.push(topologyError({
      code: "INVALID_ARTIFACT",
      message: "mac-forwarding-table.json must contain version 1.0 and entries array.",
      path: "$.artifacts['mac-forwarding-table.json']",
    }));
  }

  if (topology?.node && Array.isArray(topoFeature)) {
    const nodeIds = new Set(topology.node.nodes.map((node) => Number(node.sync_name)));
    for (const [index, edge] of topoFeature.entries()) {
      if (!nodeIds.has(edge.src_node) || !nodeIds.has(edge.dst_node)) {
        errors.push(topologyError({
          code: "ARTIFACT_REFERENCE_ERROR",
          message: "topo_feature edge references an unknown node.",
          path: `$.artifacts['topo_feature.json'][${index}]`,
        }));
      }
    }
  }

  if (topology?.node && macTable?.entries) {
    const nodeIds = new Set(topology.node.nodes.map((node) => Number(node.sync_name)));
    for (const [index, entry] of macTable.entries.entries()) {
      if (!nodeIds.has(entry.switch_node) || !nodeIds.has(entry.destination_node)) {
        errors.push(topologyError({
          code: "ARTIFACT_REFERENCE_ERROR",
          message: "mac-forwarding-table entry references an unknown node.",
          path: `$.artifacts['mac-forwarding-table.json'].entries[${index}]`,
        }));
      }
    }
  }

  if (errors.length > 0) {
    return failResult({
      responseMode: input.responseMode ?? "summary",
      errors,
    });
  }

  return okResult({
    responseMode: input.responseMode ?? "summary",
    summary: {
      valid: true,
      errorCount: 0,
      artifactNames: Object.keys(input.artifacts).sort(),
    },
  });
}

function buildLegacyTopologyJson(topology: IntermediateTopology): LegacyTopologyJson {
  const sortedNodes = sortNodesByNumericId(topology.nodes);
  const imacByNodeId = imacByNodeIdMap(sortedNodes);
  const sortedLinks = sortLinksByNumericId(topology.links);

  return {
    node: {
      nodes: sortedNodes.map((node) => ({
        imac: imacByNodeId.get(node.id) ?? 100,
        sync_name: String(node.numericId),
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        sync_type: { _classPath: legacyClassPath(node.type) },
        node_type: legacyNodeType(node.type),
      })),
      links: sortedLinks.map((link) => {
        const sourceNode = nodeById(topology, link.source.nodeId);
        const targetNode = nodeById(topology, link.target.nodeId);
        const sourcePort = legacyPortNumber(sourceNode, link.source.portId);
        const targetPort = legacyPortNumber(targetNode, link.target.portId);

        return {
          name: `${sourceNode.numericId}:${sourcePort}-${targetNode.numericId}:${targetPort}`,
          styles: {
            leftLabel: String(sourcePort),
            rightLabel: String(targetPort),
            speed: link.dataRateMbps,
          },
          imac: imacByNodeId.get(sourceNode.id) ?? 100,
          addr: imacByNodeId.get(targetNode.id) ?? 100,
        };
      }),
    },
    refs: {},
  };
}

function buildLegacyTopoFeature(topology: IntermediateTopology): LegacyTopoFeatureEntry[] {
  const nodeTypesById = new Map(topology.nodes.map((node) => [node.id, node.type]));
  const entries: LegacyTopoFeatureEntry[] = [];
  let linkId = 0;

  for (const link of sortLinksByNumericId(topology.links)) {
    const sourceNode = nodeById(topology, link.source.nodeId);
    const targetNode = nodeById(topology, link.target.nodeId);

    if (nodeTypesById.get(sourceNode.id) === "server" || nodeTypesById.get(targetNode.id) === "server") {
      continue;
    }

    const sourcePort = legacyPortNumber(sourceNode, link.source.portId);
    const targetPort = legacyPortNumber(targetNode, link.target.portId);
    entries.push({
      link_id: linkId,
      src_node: sourceNode.numericId,
      src_port: sourcePort,
      dst_node: targetNode.numericId,
      dst_port: targetPort,
      speed: link.dataRateMbps,
      st_queues: 3,
    });
    linkId += 1;
    entries.push({
      link_id: linkId,
      src_node: targetNode.numericId,
      src_port: targetPort,
      dst_node: sourceNode.numericId,
      dst_port: sourcePort,
      speed: link.dataRateMbps,
      st_queues: 3,
    });
    linkId += 1;
  }

  return entries;
}

function buildLegacyDataServer(topology: IntermediateTopology): LegacyDataServerJson {
  const sortedNodes = sortNodesByNumericId(topology.nodes);
  const imacByNodeId = imacByNodeIdMap(sortedNodes);
  const datas: LegacyDataServerItem[] = [];

  for (const node of sortedNodes) {
    const legacyType = legacyNodeType(node.type);
    const imac = imacByNodeId.get(node.id) ?? 100;
    const item: LegacyDataServerItem = {
      _className: "Q.Node",
      json: {
        name: String(node.numericId),
        location: {
          _className: "Q.Point",
          json: {
            x: Math.round(node.position.x),
            y: Math.round(node.position.y),
            rotate: 0,
          },
        },
        image: { _classPath: legacyClassPath(node.type) },
      },
      id: imac,
      src_imac: imac,
      display_name: node.name,
      node_type: legacyType,
    };

    if (legacyType !== "server") {
      item.buffer_num = 8;
      item.queue_num = 3;
      item.mac_address = node.macAddress ?? deriveLegacyMac(node.numericId);
      item.ip = node.ipAddress ?? deriveLegacyIp(node.numericId);
      item.port_count = node.ports.length;
    }

    datas.push(item);
  }

  let edgeId = 100 + sortedNodes.length;
  for (const link of sortLinksByNumericId(topology.links)) {
    const sourceNode = nodeById(topology, link.source.nodeId);
    const targetNode = nodeById(topology, link.target.nodeId);
    const sourcePort = legacyPortNumber(sourceNode, link.source.portId);
    const targetPort = legacyPortNumber(targetNode, link.target.portId);
    datas.push({
      _className: "Q.Edge",
      json: {
        name: `${sourceNode.numericId}:${sourcePort}-${targetNode.numericId}:${targetPort}`,
        from: { _ref: imacByNodeId.get(sourceNode.id) ?? 100 },
        to: { _ref: imacByNodeId.get(targetNode.id) ?? 100 },
        styles: {
          leftLabel: String(sourcePort),
          rightLabel: String(targetPort),
          speed: link.dataRateMbps,
        },
      },
      id: edgeId,
      bindingUIs: [],
    });
    edgeId += 1;
  }

  return {
    version: "2.0",
    refs: {},
    datas,
    scale: 1,
  };
}

function buildLegacyMacForwardingTable(topology: IntermediateTopology): LegacyMacForwardingTableJson {
  const sortedNodes = sortNodesByNumericId(topology.nodes);
  const imacById = imacByNodeIdMap(sortedNodes);
  const adjacency = buildAdjacency(topology);
  const entries: LegacyMacForwardingEntry[] = [];

  for (const switchNode of sortedNodes.filter((node) => node.type === "switch")) {
    for (const destination of sortedNodes) {
      if (destination.id === switchNode.id) {
        continue;
      }

      const egressPort = findFirstEgressPort(switchNode.id, destination.id, adjacency);
      if (egressPort === undefined) {
        continue;
      }

      entries.push({
        switch_node: switchNode.numericId,
        switch_imac: imacById.get(switchNode.id) ?? 100,
        switch_name: switchNode.name,
        destination_node: destination.numericId,
        destination_imac: imacById.get(destination.id) ?? 100,
        destination_mac: destination.macAddress ?? deriveLegacyMac(destination.numericId),
        destination_name: destination.name,
        egress_port: egressPort,
      });
    }
  }

  return {
    version: "1.0",
    entries,
  };
}

function summarizeArtifacts(artifacts: TopologyArtifacts): TopologyArtifactSummary {
  return {
    artifactCount: 4,
    artifactNames: [
      "topology.json",
      "topo_feature.json",
      "data-server.json",
      "mac-forwarding-table.json",
    ],
    totalBytes: Object.values(artifacts).reduce((sum, artifact) => sum + artifact.byteLength, 0),
    topologyNodeCount: artifacts["topology.json"].data.node.nodes.length,
    topologyLinkCount: artifacts["topology.json"].data.node.links.length,
    macEntryCount: artifacts["mac-forwarding-table.json"].data.entries.length,
    containsHtml: false,
  };
}

function createArtifact<TData>(name: TopologyArtifactName, data: TData): TopologyArtifact<TData> {
  const text = `${JSON.stringify(data, null, 2)}\n`;

  return {
    name,
    mediaType: "application/json",
    data,
    text,
    byteLength: measureJsonBytes(data),
  };
}

function imacByNodeIdMap(nodes: IntermediateNode[]): Map<string, number> {
  return new Map(sortNodesByNumericId(nodes).map((node, index) => [node.id, 100 + index]));
}

function nodeById(topology: IntermediateTopology, nodeId: string): IntermediateNode {
  const node = topology.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new Error(`Node ${nodeId} does not exist.`);
  }

  return node;
}

function legacyPortNumber(node: IntermediateNode, portId: string): number {
  const port = node.ports.find((candidate) => candidate.id === portId);

  if (!port) {
    throw new Error(`Port ${node.id}.${portId} does not exist.`);
  }

  return port.index;
}

function legacyNodeType(type: IntermediateNodeType): "switch" | "networkcard" | "server" {
  if (type === "endSystem") {
    return "networkcard";
  }

  return type;
}

function legacyClassPath(type: IntermediateNodeType): string {
  if (type === "switch") {
    return "Q.Graphs.exchanger2";
  }

  if (type === "server") {
    return "Q.Graphs.server";
  }

  return "Q.Graphs.node";
}

function buildAdjacency(topology: IntermediateTopology): Map<string, Array<{ nodeId: string; outPort: number }>> {
  const adjacency = new Map(topology.nodes.map((node) => [node.id, [] as Array<{ nodeId: string; outPort: number }>]));

  for (const link of topology.links) {
    const sourceNode = nodeById(topology, link.source.nodeId);
    const targetNode = nodeById(topology, link.target.nodeId);

    adjacency.get(link.source.nodeId)?.push({
      nodeId: link.target.nodeId,
      outPort: legacyPortNumber(sourceNode, link.source.portId),
    });
    adjacency.get(link.target.nodeId)?.push({
      nodeId: link.source.nodeId,
      outPort: legacyPortNumber(targetNode, link.target.portId),
    });
  }

  for (const edges of adjacency.values()) {
    edges.sort((left, right) => {
      if (left.nodeId !== right.nodeId) {
        return left.nodeId.localeCompare(right.nodeId);
      }

      return left.outPort - right.outPort;
    });
  }

  return adjacency;
}

function findFirstEgressPort(
  startNodeId: string,
  destinationNodeId: string,
  adjacency: Map<string, Array<{ nodeId: string; outPort: number }>>,
): number | undefined {
  const seen = new Set([startNodeId]);
  const queue: Array<{ nodeId: string; firstPort?: number }> = [{ nodeId: startNodeId }];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];

    for (const edge of adjacency.get(current.nodeId) ?? []) {
      if (seen.has(edge.nodeId)) {
        continue;
      }

      const firstPort = current.nodeId === startNodeId ? edge.outPort : current.firstPort;
      if (edge.nodeId === destinationNodeId) {
        return firstPort;
      }

      seen.add(edge.nodeId);
      queue.push({ nodeId: edge.nodeId, firstPort });
    }
  }

  return undefined;
}

interface LegacyTopologyJson {
  node: {
    nodes: LegacyTopologyNode[];
    links: LegacyTopologyLink[];
  };
  refs: Record<string, never>;
}

interface LegacyTopologyNode {
  imac: number;
  sync_name: string;
  x: number;
  y: number;
  sync_type: { _classPath: string };
  node_type: "switch" | "networkcard" | "server";
}

interface LegacyTopologyLink {
  name: string;
  styles: {
    leftLabel: string;
    rightLabel: string;
    speed: number;
  };
  imac: number;
  addr: number;
}

interface LegacyTopoFeatureEntry {
  link_id: number;
  src_node: number;
  src_port: number;
  dst_node: number;
  dst_port: number;
  speed: number;
  st_queues: number;
}

interface LegacyDataServerJson {
  version: "2.0";
  refs: Record<string, never>;
  datas: LegacyDataServerItem[];
  scale: 1;
}

interface LegacyDataServerItem {
  _className: "Q.Node" | "Q.Edge";
  json: Record<string, unknown>;
  id: number;
  src_imac?: number;
  display_name?: string;
  node_type?: "switch" | "networkcard" | "server";
  buffer_num?: number;
  queue_num?: number;
  mac_address?: string;
  ip?: string;
  port_count?: number;
  bindingUIs?: unknown[];
}

interface LegacyMacForwardingTableJson {
  version: "1.0";
  entries: LegacyMacForwardingEntry[];
}

interface LegacyMacForwardingEntry {
  switch_node: number;
  switch_imac: number;
  switch_name: string;
  destination_node: number;
  destination_imac: number;
  destination_mac: string;
  destination_name: string;
  egress_port: number;
}
