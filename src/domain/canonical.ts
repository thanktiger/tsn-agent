/**
 * @deprecated Phase B (plan v3 U9b 范围)：sidecar 已是 topology 写权威，
 * `CanonicalTsnProjectV0` 不再是 writable 事实源；本类型当前以
 * **session payload 序列化 schema** 的身份保留：
 * - `sessions.payload` TEXT 列仍以此 shape 存 / 读（向后兼容查看老 session）；
 * - agent-adapter / session-repository / project-state / App.tsx 等
 *   ~9 个文件仍引用此类型来 hydrate UI；它们将在 Phase B 后续 PR 中改为
 *   `query_topology` Tauri command；
 * - flow-template / planning-export 阶段相关字段在 P0 期间已 UI 灰掉。
 *
 * **不要在新代码里 import 这个文件**。新代码应：
 * - 写：通过 MCP `topology.apply_operations` 走 sidecar；
 * - 读：调用 `query_topology` Tauri command 拉 `{ nodes, links }` flat slice。
 */

export type TsnNodeType = "switch" | "endSystem";

export type LinkMedium = "ethernet";

export interface TsnPosition {
  x: number;
  y: number;
}

export interface TsnPort {
  id: string;
  name: string;
  index: number;
}

export interface TsnNode {
  id: string;
  numericId: number;
  name: string;
  type: TsnNodeType;
  ports: TsnPort[];
  position: TsnPosition;
  macAddress?: string;
  ipAddress?: string;
}

export interface TsnLinkEndpoint {
  nodeId: string;
  portId: string;
}

export interface TsnLink {
  id: string;
  numericId: number;
  source: TsnLinkEndpoint;
  target: TsnLinkEndpoint;
  medium: LinkMedium;
  dataRateMbps: number;
}

export interface TsnFlowEndpoint {
  nodeId: string;
  macAddress: string;
  ipAddress: string;
  udpPort: number;
}

export interface TsnFlow {
  id: string;
  numericId: number;
  name: string;
  source: TsnFlowEndpoint;
  destination: TsnFlowEndpoint;
  periodUs: number;
  frameSizeBytes: number;
  pcp: number;
  maxFramesPerInterval: number;
  earliestTransmitOffsetUs: number;
  latestTransmitOffsetUs: number;
  jitterRequirementUs: number;
  latencyRequirementUs: number;
  routeLinkIds: string[];
  routeNodeIds: string[];
  flowType: "ST" | "BE";
}

export interface TsnSimulationHints {
  inetVersion: string;
  nedPackage: string;
  defaultDataRateMbps: number;
  timeSynchronization: "assumed-synchronized" | "not-configured";
}

export interface CanonicalTsnProjectV0 {
  schemaVersion: "tsn-agent.canonical.v0";
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  topology: {
    nodes: TsnNode[];
    links: TsnLink[];
  };
  flows: TsnFlow[];
  simulationHints: TsnSimulationHints;
}

export interface TopologyIntent {
  switchCount: number;
  endSystemsPerSwitch: number;
  switchInterconnect?: "line" | "ring";
  topologyTemplate?: "dual-plane-redundant";
}

export function isSwitch(node: TsnNode): boolean {
  return node.type === "switch";
}

export function isEndSystem(node: TsnNode): boolean {
  return node.type === "endSystem";
}
