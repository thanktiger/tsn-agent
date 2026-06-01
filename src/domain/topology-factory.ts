import type {
  CanonicalTsnProjectV0,
  TopologyIntent,
  TsnFlow,
  TsnLink,
  TsnNode,
} from "./canonical";
import { getScenarioConfig, resolveScenarioConfig, type ScenarioFlowTemplate } from "./scenario-config";
import { initializeTopology, type DualPlaneRedundantParams, type TopologyInitIntent } from "../topology/initialize";
import { intermediateToCanonicalProject } from "../topology/project-bridge";

export interface TopologyFactoryOptions {
  scenarioConfigId?: string;
  includeControlFlow?: boolean;
}

export function parseTopologyIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): TopologyIntent {
  const switchMatch = matchTargetCount(text, "(?:系统\\s*)?(?:交换机|switch)");
  const endSystemMatch = matchTargetCount(
    text,
    "(?:网卡|端系统|终端|端(?!口)|host|end)",
    "(?:每个|每台|each).*?",
  );
  const switchInterconnect = matchSwitchInterconnect(text) ?? fallback?.switchInterconnect ?? "line";
  const defaults = getScenarioConfig(options.scenarioConfigId).defaults.topology;
  const switchCount = clampNumber(Number(switchMatch ?? fallback?.switchCount ?? defaults.switchCount), 1, 12);
  const distributedEndSystemMatch = matchDistributedEndSystemCount(text, switchCount);
  const endSystemsPerSwitch = clampNumber(
    Number(distributedEndSystemMatch ?? endSystemMatch ?? fallback?.endSystemsPerSwitch ?? defaults.endSystemsPerSwitch),
    1,
    24,
  );
  const shouldUseDualPlaneTemplate = isDualPlaneTopologyRequest(text, options.scenarioConfigId)
    || fallback?.topologyTemplate === "dual-plane-redundant";

  const intent: TopologyIntent = {
    switchCount,
    endSystemsPerSwitch,
    switchInterconnect,
    topologyTemplate: shouldUseDualPlaneTemplate ? "dual-plane-redundant" : undefined,
  };

  return intent;
}

export function createProjectFromIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const intent = parseTopologyIntent(text, fallback, options);

  if (intent.topologyTemplate === "dual-plane-redundant") {
    return createDualPlaneRedundantTopologyProject(intent, "当前规划", options);
  }

  return createLineTopologyProject(intent, "当前规划", options);
}

export function createDualPlaneRedundantTopologyProject(
  intent: TopologyIntent,
  projectName = "当前规划",
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId).config;
  const dataRateMbps = scenarioConfig.defaults.topology.dataRateMbps;
  const now = new Date().toISOString();
  const project = createProjectFromTopologyDomain({
    templateId: "dual-plane-redundant",
    params: createDualPlaneParams(intent, dataRateMbps) as unknown as Record<string, unknown>,
    projectName,
    projectId: "project-default",
    timestamp: now,
    defaultDataRateMbps: dataRateMbps,
  });

  if (options.includeControlFlow === false) {
    return project;
  }

  return {
    ...project,
    flows: [createControlFlow(project.topology.nodes, project.topology.links, intent, scenarioConfig.flowTemplates[0])],
  };
}

export function createLineTopologyProject(
  intent: TopologyIntent,
  projectName = "TSN Agent Project",
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId).config;
  const dataRateMbps = scenarioConfig.defaults.topology.dataRateMbps;
  const now = new Date().toISOString();
  const project = createProjectFromTopologyDomain({
    templateId: intent.switchInterconnect === "ring" ? "generic-ring" : "generic-line",
    params: {
      switchCount: intent.switchCount,
      endSystemsPerSwitch: intent.endSystemsPerSwitch,
      dataRateMbps,
    },
    projectName,
    projectId: "project-default",
    timestamp: now,
    defaultDataRateMbps: dataRateMbps,
  });

  const flows = options.includeControlFlow === false
    ? []
    : [createControlFlow(project.topology.nodes, project.topology.links, intent, scenarioConfig.flowTemplates[0])];

  return {
    ...project,
    flows,
  };
}

function createDualPlaneParams(intent: TopologyIntent, dataRateMbps: number): DualPlaneRedundantParams {
  const switchCount = intent.switchCount % 2 === 0 ? intent.switchCount : intent.switchCount + 1;
  const groupCount = Math.max(1, Math.floor(switchCount / 2));
  const switches = Array.from({ length: groupCount * 2 }, (_, index) => {
    const groupOrdinal = Math.floor(index / 2) + 1;
    const isPlaneA = index % 2 === 0;
    return {
      id: `sw${index + 1}`,
      name: `SW-${groupOrdinal}${isPlaneA ? "A" : "B"}`,
      plane: isPlaneA ? "A" as const : "B" as const,
      groupId: `g${groupOrdinal}`,
    };
  });
  const switchGroups = Array.from({ length: groupCount }, (_, index) => ({
    id: `g${index + 1}`,
    planeSwitches: {
      A: `sw${index * 2 + 1}`,
      B: `sw${index * 2 + 2}`,
    },
  }));
  const endSystems = Array.from({ length: intent.switchCount * intent.endSystemsPerSwitch }, (_, index) => {
    const switchOrdinal = Math.floor(index / intent.endSystemsPerSwitch) + 1;
    const groupOrdinal = Math.ceil(switchOrdinal / 2);
    const hostOrdinal = index % intent.endSystemsPerSwitch + 1;
    const primarySwitchId = `sw${groupOrdinal * 2 - 1}`;
    const backupSwitchId = `sw${groupOrdinal * 2}`;

    return {
      id: `es${switchOrdinal}-${hostOrdinal}`,
      name: `ES-${switchOrdinal}-${hostOrdinal}`,
      groupId: `g${groupOrdinal}`,
      attachment: {
        primary: { switchId: primarySwitchId, plane: "A" as const },
        backup: { switchId: backupSwitchId, plane: "B" as const },
      },
    };
  });

  return {
    dataRateMbps,
    planes: [{ id: "A" }, { id: "B" }],
    switches,
    switchGroups,
    endSystems,
    backbone: {
      mode: intent.switchInterconnect === "ring" ? "ring" : "line",
      withinPlane: true,
    },
    crossPlaneLinks: {
      mode: "none",
    },
    allocation: {
      portStrategy: "first-free",
      layoutStrategy: "dual-plane-grid",
    },
  };
}

export function withDefaultControlFlow(
  project: CanonicalTsnProjectV0,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  if (project.flows.some((flow) => flow.id === "flow-control-1")) {
    return project;
  }

  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId).config;
  const intent = inferIntentFromProject(project);
  const flows = [
    createControlFlow(project.topology.nodes, project.topology.links, intent, scenarioConfig.flowTemplates[0]),
    ...project.flows,
  ];

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    flows: renumberFlows(flows),
  };
}

export function withFlowsFromIntent(
  project: CanonicalTsnProjectV0,
  text: string,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const flowIntent = parseFlowIntent(text);

  if (!flowIntent.hasFlowRequest) {
    return project;
  }

  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId).config;
  const intent = inferIntentFromProject(project);
  const flows = [...project.flows];

  if (flowIntent.controlFlow && !flows.some((flow) => flow.id === "flow-control-1")) {
    flows.unshift(createControlFlow(project.topology.nodes, project.topology.links, intent, scenarioConfig.flowTemplates[0]));
  }

  appendVideoFlows(flows, flowIntent.videoFlowCount, project.topology.nodes, project.topology.links, intent);
  appendBestEffortFlows(flows, flowIntent.bestEffortFlowCount, project.topology.nodes, project.topology.links, intent);

  if (flows.length === project.flows.length) {
    return project;
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    flows: renumberFlows(flows),
  };
}

function renumberFlows(flows: TsnFlow[]): TsnFlow[] {
  return flows.map((flow, index) => ({
    ...flow,
    numericId: index + 1,
  }));
}

function parseFlowIntent(text: string): {
  hasFlowRequest: boolean;
  controlFlow: boolean;
  heartbeatFlow: boolean;
  videoFlowCount: number;
  bestEffortFlowCount: number;
} {
  const controlFlow = /控制流|控制指令|control|时序控制|安全自毁|姿控|伺服|惯组|发动机|故障诊断/i.test(text);
  const heartbeatFlow = /心跳/i.test(text);
  const videoFlow = /视频流|视频|摄像|video/i.test(text);
  const bestEffortFlow = /BE\s*流|尽力而为流|尽力而为|best\s*effort/i.test(text);
  const countFlow = /(?:两|2)\s*条?\s*流/.test(text);
  const videoFlowCount = videoFlow ? Math.max(1, parseRequestedFlowCount(text, /(?:视频流|视频|摄像|video)/i)) : 0;
  const bestEffortFlowCount = bestEffortFlow
    ? Math.max(1, parseRequestedFlowCount(text, /(?:BE\s*流|尽力而为流|尽力而为|best\s*effort)/i))
    : 0;

  return {
    hasFlowRequest: controlFlow || heartbeatFlow || videoFlow || bestEffortFlow || countFlow,
    controlFlow: controlFlow || (countFlow && videoFlow),
    heartbeatFlow,
    videoFlowCount,
    bestEffortFlowCount,
  };
}

function parseRequestedFlowCount(text: string, nounPattern: RegExp): number {
  const nounSource = nounPattern.source;
  const suffixMatch = text.match(new RegExp(`${nounSource}\\s*(\\d+)\\s*条`, "i"));
  const prefixMatch = text.match(new RegExp(`([一二两三四五六七八九十\\d]+)\\s*条\\s*${nounSource}`, "i"));
  const addPrefixMatch = text.match(new RegExp(`(?:再加|再添加|新增|添加|加)\\s*([一二两三四五六七八九十\\d]+)\\s*条\\s*${nounSource}`, "i"));
  const value = addPrefixMatch?.[1] ?? prefixMatch?.[1] ?? suffixMatch?.[1];

  return clampNumber(parseChineseNumber(value), 1, 12);
}

function parseChineseNumber(value?: string): number {
  if (!value) {
    return 1;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  return digits[value] ?? 1;
}

function matchTargetCount(text: string, nounPattern: string, prefix = ""): string | undefined {
  const targetPattern = new RegExp(
    `${prefix}(?:从|由)?\\s*\\d+\\s*(?:个|台)?\\s*${nounPattern}\\s*(?:改成|改为|变为|调整为|设为|改至|到)\\s*(\\d+)\\s*(?:个|台)?\\s*${nounPattern}?`,
    "i",
  );
  const targetMatch = text.match(targetPattern);

  if (targetMatch?.[1]) {
    return targetMatch[1];
  }

  const directPattern = new RegExp(`${prefix}(\\d+)\\s*(?:个|台)?\\s*${nounPattern}`, "i");
  return text.match(directPattern)?.[1];
}

function matchDistributedEndSystemCount(text: string, switchCount: number): string | undefined {
  const totalMatch = text.match(/(\d+)\s*(?:个|台)?\s*(?:网卡|端系统|终端|端(?!口)|host|end)s?\s*(?:，|,|\s)*(?:平均)?(?:分配|分到|分布|接入|连接)\s*(?:到|至)?\s*(\d+)?\s*(?:个|台)?\s*(?:系统\s*)?(?:交换机|switch)/i);
  const total = Number(totalMatch?.[1]);
  const switches = Number(totalMatch?.[2] ?? switchCount);

  if (!Number.isFinite(total) || !Number.isFinite(switches) || total <= 0 || switches <= 0) {
    return undefined;
  }

  return String(Math.max(1, Math.round(total / switches)));
}

function hasDistributedEndSystemTopologyRequest(text: string): boolean {
  return /(\d+)\s*(?:个|台)?\s*(?:网卡|端系统|终端|端(?!口)|host|end)s?\s*(?:，|,|\s)*(?:平均)?(?:分配|分到|分布|接入|连接)\s*(?:到|至)?\s*(\d+)?\s*(?:个|台)?\s*(?:系统\s*)?(?:交换机|switch)/i.test(text);
}

function matchSwitchInterconnect(text: string): TopologyIntent["switchInterconnect"] | undefined {
  if (/环形|环网|ring/i.test(text) || /闭环/.test(text) && !/闭环\s*(?:控制)?流/.test(text)) {
    return "ring";
  }

  if (/线型|线性|链式|串联|line/i.test(text)) {
    return "line";
  }

  return undefined;
}

function inferIntentFromProject(project: CanonicalTsnProjectV0): TopologyIntent {
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;
  const switchLinkCount = project.topology.links.filter((link) =>
    link.source.nodeId.startsWith("sw") && link.target.nodeId.startsWith("sw")
  ).length;

  return {
    switchCount,
    endSystemsPerSwitch: switchCount > 0 ? Math.round(endSystemCount / switchCount) : 0,
    switchInterconnect: switchCount > 2 && switchLinkCount >= switchCount ? "ring" : "line",
  };
}

function isDualPlaneTopologyRequest(text: string, scenarioConfigId?: string): boolean {
  return scenarioConfigId === "aerospace-onboard"
    || /双冗余|双平面|双归属|双以太网|A\/B|AB\s*平面/i.test(text);
}

function createProjectFromTopologyDomain(input: {
  templateId: TopologyInitIntent["templateId"];
  params: NonNullable<TopologyInitIntent["params"]>;
  projectName: string;
  projectId: string;
  timestamp: string;
  defaultDataRateMbps: number;
}): CanonicalTsnProjectV0 {
  const initialized = initializeTopology({
    templateId: input.templateId,
    params: input.params,
    responseMode: "full",
  });

  if (!initialized.ok || !initialized.full) {
    throw new Error(`Topology initialization failed: ${initialized.ok ? "missing full payload" : initialized.errors.map((error) => error.message).join("; ")}`);
  }

  const bridged = intermediateToCanonicalProject({
    topology: initialized.full.topology,
    options: {
      projectId: input.projectId,
      projectName: input.projectName,
      timestamp: input.timestamp,
      defaultDataRateMbps: input.defaultDataRateMbps,
      responseMode: "full",
    },
  });

  if (!bridged.ok || !bridged.full) {
    throw new Error(`Topology bridge failed: ${bridged.ok ? "missing full payload" : bridged.errors.map((error) => error.message).join("; ")}`);
  }

  return bridged.full.project;
}

function createControlFlow(
  nodes: TsnNode[],
  links: TsnLink[],
  intent: TopologyIntent,
  template: ScenarioFlowTemplate,
): TsnFlow {
  const sourceNode = findNode(nodes, "es1-1");
  const destinationNode = findNode(nodes, `es${intent.switchCount}-1`);
  const routeNodeIds = findRouteNodeIds(sourceNode.id, destinationNode.id, links);
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: "flow-control-1",
    numericId: 1,
    name: template.name,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(1),
      ipAddress: sourceNode.ipAddress ?? "10.0.1.1",
      udpPort: 25563,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(intent.switchCount),
      ipAddress: destinationNode.ipAddress ?? `10.0.${intent.switchCount}.1`,
      udpPort: 26028,
    },
    periodUs: template.periodUs,
    frameSizeBytes: template.frameSizeBytes,
    pcp: template.pcp,
    maxFramesPerInterval: 1,
    earliestTransmitOffsetUs: 0,
    latestTransmitOffsetUs: 50,
    jitterRequirementUs: template.jitterRequirementUs,
    latencyRequirementUs: template.latencyRequirementUs,
    routeLinkIds,
    routeNodeIds,
    flowType: template.flowType,
  };
}

function appendVideoFlows(
  flows: TsnFlow[],
  requestedCount: number,
  nodes: TsnNode[],
  links: TsnLink[],
  intent: TopologyIntent,
): void {
  const existingCount = countFlowsByPrefix(flows, "flow-video-");

  for (let index = 1; index <= requestedCount; index += 1) {
    flows.push(createVideoFlow(nodes, links, intent, existingCount + index));
  }
}

function appendBestEffortFlows(
  flows: TsnFlow[],
  requestedCount: number,
  nodes: TsnNode[],
  links: TsnLink[],
  intent: TopologyIntent,
): void {
  const existingCount = countFlowsByPrefix(flows, "flow-be-");

  for (let index = 1; index <= requestedCount; index += 1) {
    flows.push(createBestEffortFlow(nodes, links, intent, existingCount + index));
  }
}

function countFlowsByPrefix(flows: TsnFlow[], prefix: string): number {
  return flows.filter((flow) => flow.id.startsWith(prefix)).length;
}

function createVideoFlow(nodes: TsnNode[], links: TsnLink[], intent: TopologyIntent, ordinal = 1): TsnFlow {
  const hostIndex = clampNumber(ordinal + 1, 1, Math.max(intent.endSystemsPerSwitch, 1));
  const sourceNodeId = `es1-${hostIndex}`;
  const destinationNodeId = `es${intent.switchCount}-${hostIndex}`;
  const sourceNode = findNode(nodes, sourceNodeId);
  const destinationNode = findNode(nodes, destinationNodeId);
  const routeNodeIds = findRouteNodeIds(sourceNode.id, destinationNode.id, links);
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: `flow-video-${ordinal}`,
    numericId: 2,
    name: `视频流-${ordinal}`,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(hostIndex),
      ipAddress: sourceNode.ipAddress ?? `10.0.1.${hostIndex}`,
      udpPort: 25563 + ordinal,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(intent.switchCount),
      ipAddress: destinationNode.ipAddress ?? `10.0.${intent.switchCount}.${hostIndex}`,
      udpPort: 26028 + ordinal,
    },
    periodUs: 33_333,
    frameSizeBytes: 50 * 1024,
    pcp: 5,
    maxFramesPerInterval: 1,
    earliestTransmitOffsetUs: 0,
    latestTransmitOffsetUs: 1_000,
    jitterRequirementUs: 1_000,
    latencyRequirementUs: 5_000,
    routeLinkIds,
    routeNodeIds,
    flowType: "ST",
  };
}

function createBestEffortFlow(nodes: TsnNode[], links: TsnLink[], intent: TopologyIntent, ordinal = 1): TsnFlow {
  const hostIndex = clampNumber(ordinal + 2, 1, Math.max(intent.endSystemsPerSwitch, 1));
  const sourceNodeId = `es1-${hostIndex}`;
  const destinationNodeId = `es${intent.switchCount}-${hostIndex}`;
  const sourceNode = findNode(nodes, sourceNodeId);
  const destinationNode = findNode(nodes, destinationNodeId);
  const routeNodeIds = findRouteNodeIds(sourceNode.id, destinationNode.id, links);
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: `flow-be-${ordinal}`,
    numericId: 3,
    name: `BE流-${ordinal}`,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(hostIndex),
      ipAddress: sourceNode.ipAddress ?? `10.0.1.${hostIndex}`,
      udpPort: 25680 + ordinal,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(intent.switchCount),
      ipAddress: destinationNode.ipAddress ?? `10.0.${intent.switchCount}.${hostIndex}`,
      udpPort: 26180 + ordinal,
    },
    periodUs: 100_000,
    frameSizeBytes: 1_500,
    pcp: 0,
    maxFramesPerInterval: 1,
    earliestTransmitOffsetUs: 0,
    latestTransmitOffsetUs: 10_000,
    jitterRequirementUs: 10_000,
    latencyRequirementUs: 100_000,
    routeLinkIds,
    routeNodeIds,
    flowType: "BE",
  };
}

function createRouteLinkIds(routeNodeIds: string[], links: TsnLink[]): string[] {
  const routeLinkIds: string[] = [];

  for (let index = 0; index < routeNodeIds.length - 1; index += 1) {
    const fromNodeId = routeNodeIds[index];
    const toNodeId = routeNodeIds[index + 1];
    const link = links.find((candidate) => {
      const forward = candidate.source.nodeId === fromNodeId && candidate.target.nodeId === toNodeId;
      const backward = candidate.source.nodeId === toNodeId && candidate.target.nodeId === fromNodeId;
      return forward || backward;
    });

    if (!link) {
      throw new Error(`No link exists between ${fromNodeId} and ${toNodeId}.`);
    }

    routeLinkIds.push(link.id);
  }

  return routeLinkIds;
}

function findRouteNodeIds(sourceNodeId: string, destinationNodeId: string, links: TsnLink[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    const sourceNeighbors = adjacency.get(link.source.nodeId) ?? [];
    sourceNeighbors.push(link.target.nodeId);
    adjacency.set(link.source.nodeId, sourceNeighbors);

    const targetNeighbors = adjacency.get(link.target.nodeId) ?? [];
    targetNeighbors.push(link.source.nodeId);
    adjacency.set(link.target.nodeId, targetNeighbors);
  }

  const queue: string[] = [sourceNodeId];
  const previous = new Map<string, string | undefined>([[sourceNodeId, undefined]]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === destinationNodeId) {
      break;
    }

    const neighbors = [...(adjacency.get(current) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (previous.has(neighbor)) {
        continue;
      }

      previous.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  if (!previous.has(destinationNodeId)) {
    throw new Error(`No route exists between ${sourceNodeId} and ${destinationNodeId}.`);
  }

  const route: string[] = [];
  let current: string | undefined = destinationNodeId;
  while (current) {
    route.unshift(current);
    current = previous.get(current);
  }

  return route;
}

function findNode(nodes: TsnNode[], nodeId: string): TsnNode {
  const node = nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    throw new Error(`Node ${nodeId} does not exist.`);
  }

  return node;
}

function createMacAddress(ordinal: number): string {
  const hex = ordinal.toString(16).padStart(2, "0").toUpperCase();
  return `00:1B:44:11:3A:${hex}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}
