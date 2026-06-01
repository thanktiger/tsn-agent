import type {
  CanonicalTsnProjectV0,
  LinkMedium,
  TsnLink,
  TsnNode,
  TsnNodeType,
} from "../domain/canonical";
import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateTopology,
} from "./intermediate";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export interface ProjectBridgeOptions {
  projectId?: string;
  projectName?: string;
  timestamp?: string;
  defaultDataRateMbps?: number;
  responseMode?: TopologyResponseMode;
}

export interface ProjectBridgeSummary {
  nodeCount: number;
  linkCount: number;
  projectId: string;
  projectName: string;
}

export function intermediateToCanonicalProject(input: {
  topology: IntermediateTopology;
  options?: ProjectBridgeOptions;
}): TopologyToolResult<ProjectBridgeSummary, { project: CanonicalTsnProjectV0 }> {
  const responseMode = input.options?.responseMode ?? "summary";
  const validation = validateIntermediateTopology(input.topology);

  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  const unsupportedNode = input.topology.nodes.find((node) => node.type === "server");
  if (unsupportedNode) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "UNSUPPORTED_CANONICAL_NODE_TYPE",
          message: `CanonicalTsnProjectV0 does not support server nodes: ${unsupportedNode.id}`,
          path: `$.nodes[${input.topology.nodes.indexOf(unsupportedNode)}].type`,
        }),
      ],
      warnings: validation.warnings,
    });
  }

  const timestamp = input.options?.timestamp ?? "2026-01-01T00:00:00.000Z";
  const projectId = input.options?.projectId ?? defaultProjectId(input.topology);
  const projectName = input.options?.projectName ?? defaultProjectName(input.topology);
  const project: CanonicalTsnProjectV0 = {
    schemaVersion: "tsn-agent.canonical.v0",
    id: projectId,
    name: projectName,
    createdAt: timestamp,
    updatedAt: timestamp,
    topology: {
      nodes: input.topology.nodes.map(toCanonicalNode),
      links: input.topology.links.map(toCanonicalLink),
    },
    flows: [],
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps: input.options?.defaultDataRateMbps ?? input.topology.links[0]?.dataRateMbps ?? 1_000,
      timeSynchronization: "assumed-synchronized",
    },
  };

  return okResult({
    responseMode,
    summary: {
      nodeCount: project.topology.nodes.length,
      linkCount: project.topology.links.length,
      projectId,
      projectName,
    },
    full: { project },
    warnings: validation.warnings,
  });
}

export function canonicalTopologyToIntermediate(project: CanonicalTsnProjectV0): IntermediateTopology {
  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      source: "canonical",
      layout: "custom",
    },
    nodes: project.topology.nodes.map((node): IntermediateNode => ({
      id: node.id,
      numericId: node.numericId,
      name: node.name,
      type: node.type,
      ports: node.ports,
      position: node.position,
      macAddress: node.macAddress,
      ipAddress: node.ipAddress,
    })),
    links: project.topology.links.map((link): IntermediateLink => ({
      id: link.id,
      numericId: link.numericId,
      source: link.source,
      target: link.target,
      medium: link.medium,
      dataRateMbps: link.dataRateMbps,
    })),
    diagnostics: [],
  };
}

function toCanonicalNode(node: IntermediateNode): TsnNode {
  return {
    id: node.id,
    numericId: node.numericId,
    name: node.name,
    type: node.type as TsnNodeType,
    ports: node.ports,
    position: node.position,
    macAddress: node.macAddress,
    ipAddress: node.ipAddress,
  };
}

function toCanonicalLink(link: IntermediateLink): TsnLink {
  return {
    id: link.id,
    numericId: link.numericId,
    source: link.source,
    target: link.target,
    medium: link.medium as LinkMedium,
    dataRateMbps: link.dataRateMbps,
  };
}

function defaultProjectId(topology: IntermediateTopology): string {
  return "project-default";
}

function defaultProjectName(topology: IntermediateTopology): string {
  return "当前规划";
}
