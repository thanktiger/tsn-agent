/**
 * @deprecated Phase B (plan v3 U9b 范围)：sidecar 已成为 topology 写权威，
 * `IntermediateTopology` 不再是事实源。当前文件保留是因为 ~12 个 consumer
 * (agent-adapter / fake-agent / session-repository / project-* / App.tsx /
 * topology-factory) 仍在解析 / 序列化此类型；完整删除需要重写 agent runtime
 * + UI 端 topology hydrate 路径，是 Phase B 后续 PR 范围。
 *
 * **不要在新代码里 import 这个文件**。新代码应：
 * - 写：通过 MCP `topology.apply_operations` 走 sidecar；
 * - 读：调用 `query_topology` Tauri command 拉 `{ nodes, links }` flat slice。
 */
import type { TopologyError, TopologyWarning } from "./tool-result";

export const INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION = "tsn-agent.topology.intermediate.v0" as const;

export type IntermediateTopologySchemaVersion = typeof INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION;

export type IntermediateNodeType = "switch" | "endSystem" | "server";

export type IntermediateLinkMedium = "ethernet";

export type TopologyTemplateId = "generic-line" | "generic-ring" | "dual-plane-redundant";

export interface IntermediatePosition {
  x: number;
  y: number;
}

export interface IntermediatePort {
  id: string;
  name: string;
  index: number;
}

export interface IntermediateNode {
  id: string;
  numericId: number;
  name: string;
  type: IntermediateNodeType;
  ports: IntermediatePort[];
  position: IntermediatePosition;
  macAddress?: string;
  ipAddress?: string;
}

export interface IntermediateLinkEndpoint {
  nodeId: string;
  portId: string;
}

export interface IntermediateLink {
  id: string;
  numericId: number;
  source: IntermediateLinkEndpoint;
  target: IntermediateLinkEndpoint;
  medium: IntermediateLinkMedium;
  dataRateMbps: number;
}

export interface IntermediateTopologyMetadata {
  templateId?: TopologyTemplateId;
  templateParams?: Record<string, unknown>;
  layout?: "line" | "ring" | "dual-plane" | "custom";
  source?: "template" | "operations" | "canonical" | "legacy-artifacts";
}

export interface TopologyDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  path: string;
  details?: Record<string, string | number | boolean>;
}

export interface IntermediateTopology {
  schemaVersion: IntermediateTopologySchemaVersion;
  metadata: IntermediateTopologyMetadata;
  nodes: IntermediateNode[];
  links: IntermediateLink[];
  diagnostics: TopologyDiagnostic[];
}

export interface TopologySummary {
  schemaVersion: IntermediateTopologySchemaVersion;
  templateId?: TopologyTemplateId;
  nodeCount: number;
  linkCount: number;
  switchCount: number;
  endSystemCount: number;
  serverCount: number;
  warningCount: number;
  errorCount: number;
}

export interface TopologyValidationSummary extends TopologySummary {
  valid: boolean;
  errorCodes: string[];
}

export interface TopologyValidationReport {
  ok: boolean;
  errors: TopologyError[];
  warnings: TopologyWarning[];
  summary: TopologyValidationSummary;
}

export function createPorts(count: number): IntermediatePort[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `eth${index}`,
    index,
  }));
}

export function summarizeTopology(topology: IntermediateTopology): TopologySummary {
  const switchCount = topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = topology.nodes.filter((node) => node.type === "endSystem").length;
  const serverCount = topology.nodes.filter((node) => node.type === "server").length;

  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    templateId: topology.metadata.templateId,
    nodeCount: topology.nodes.length,
    linkCount: topology.links.length,
    switchCount,
    endSystemCount,
    serverCount,
    warningCount: topology.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    errorCount: topology.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
  };
}

export function sortNodesByNumericId(nodes: IntermediateNode[]): IntermediateNode[] {
  return [...nodes].sort((left, right) => {
    if (left.numericId !== right.numericId) {
      return left.numericId - right.numericId;
    }

    return left.id.localeCompare(right.id);
  });
}

export function sortLinksByNumericId(links: IntermediateLink[]): IntermediateLink[] {
  return [...links].sort((left, right) => {
    if (left.numericId !== right.numericId) {
      return left.numericId - right.numericId;
    }

    return left.id.localeCompare(right.id);
  });
}

export function deriveMacAddress(ordinal: number): string {
  const hex = ordinal.toString(16).padStart(2, "0").toUpperCase();
  return `00:1B:44:11:3A:${hex}`;
}

export function deriveLegacyMac(nodeNumericId: number): string {
  const highByte = (nodeNumericId >> 8) & 0xff;
  const lowByte = nodeNumericId & 0xff;
  return `00:00:23:00:${hex2(highByte)}:${hex2(lowByte)}`;
}

export function deriveLegacyIp(nodeNumericId: number): string {
  const highByte = (nodeNumericId >> 8) & 0xff;
  const lowByte = nodeNumericId & 0xff;
  return `192.168.${highByte}.${lowByte}`;
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}
