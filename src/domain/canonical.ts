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
