import type {
  CanonicalTsnProjectV0,
  TopologyIntent,
  TsnFlow,
  TsnLink,
  TsnNode,
  TsnPort,
} from "./canonical";
import { getScenarioConfig, resolveScenarioConfig, type ScenarioFlowTemplate } from "./scenario-config";

export interface TopologyFactoryOptions {
  scenarioConfigId?: string;
  includeControlFlow?: boolean;
}

export function parseTopologyIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): TopologyIntent {
  if (isAerospaceRedundantTopologyRequest(text, options.scenarioConfigId)) {
    return {
      switchCount: 4,
      endSystemsPerSwitch: 0,
      switchInterconnect: "line",
      topologyTemplate: "aerospace-redundant",
      endSystemCount: 7,
    };
  }

  const switchMatch = matchTargetCount(text, "(?:系统\\s*)?(?:交换机|switch)");
  const endSystemMatch = matchTargetCount(
    text,
    "(?:网卡|端系统|终端|端(?!口)|host|end)",
    "(?:每个|每台|each).*?",
  );
  const switchInterconnect = matchSwitchInterconnect(text) ?? fallback?.switchInterconnect ?? "line";
  const defaults = getScenarioConfig(options.scenarioConfigId).defaults.topology;
  const switchCount = clampNumber(Number(switchMatch ?? fallback?.switchCount ?? defaults.switchCount), 1, 12);
  const endSystemsPerSwitch = clampNumber(
    Number(endSystemMatch ?? fallback?.endSystemsPerSwitch ?? defaults.endSystemsPerSwitch),
    1,
    24,
  );

  const intent: TopologyIntent = {
    switchCount,
    endSystemsPerSwitch,
    switchInterconnect,
  };

  if (fallback?.topologyTemplate) {
    intent.topologyTemplate = fallback.topologyTemplate;
  }

  if (fallback?.endSystemCount !== undefined) {
    intent.endSystemCount = fallback.endSystemCount;
  }

  return intent;
}

export function createProjectFromIntent(
  text: string,
  fallback?: Partial<TopologyIntent>,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const intent = parseTopologyIntent(text, fallback, options);

  if (intent.topologyTemplate === "aerospace-redundant") {
    return createAerospaceRedundantTopologyProject("箭载双冗余拓扑", options);
  }

  return createLineTopologyProject(intent, "当前规划", options);
}

export function createAerospaceRedundantTopologyProject(
  projectName = "箭载双冗余拓扑",
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId ?? "aerospace-onboard").config;
  const dataRateMbps = scenarioConfig.defaults.topology.dataRateMbps;
  const now = new Date().toISOString();
  const nodes: TsnNode[] = [];
  const links: TsnLink[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  const addNode = (input: {
    id: string;
    name: string;
    type: TsnNode["type"];
    portCount: number;
    position: TsnNode["position"];
    hostOrdinal?: number;
  }) => {
    nodes.push({
      id: input.id,
      numericId: numericNodeId,
      name: input.name,
      type: input.type,
      ports: createPorts(input.portCount),
      position: input.position,
      macAddress: input.hostOrdinal === undefined ? undefined : createMacAddress(input.hostOrdinal),
      ipAddress: input.hostOrdinal === undefined ? undefined : `10.10.0.${input.hostOrdinal}`,
    });
    numericNodeId += 1;
  };

  const addLink = (sourceNodeId: string, sourcePortId: string, targetNodeId: string, targetPortId: string) => {
    links.push(
      createLink({
        numericId: numericLinkId,
        sourceNodeId,
        sourcePortId,
        targetNodeId,
        targetPortId,
        dataRateMbps,
      }),
    );
    numericLinkId += 1;
  };

  addNode({ id: "nic1", name: "网卡1", type: "endSystem", portCount: 2, position: { x: 30, y: 40 }, hostOrdinal: 1 });
  addNode({ id: "nic2", name: "网卡2", type: "endSystem", portCount: 2, position: { x: 30, y: 160 }, hostOrdinal: 2 });
  addNode({ id: "nic3", name: "网卡3", type: "endSystem", portCount: 2, position: { x: 30, y: 300 }, hostOrdinal: 3 });
  addNode({ id: "sw1", name: "交换机1", type: "switch", portCount: 8, position: { x: 210, y: 55 } });
  addNode({ id: "sw2", name: "交换机2", type: "switch", portCount: 8, position: { x: 210, y: 195 } });
  addNode({ id: "nic4", name: "网卡4", type: "endSystem", portCount: 2, position: { x: 380, y: 80 }, hostOrdinal: 4 });
  addNode({ id: "nic5", name: "网卡5", type: "endSystem", portCount: 2, position: { x: 380, y: 210 }, hostOrdinal: 5 });
  addNode({ id: "sw3", name: "交换机3", type: "switch", portCount: 6, position: { x: 590, y: 55 } });
  addNode({ id: "sw4", name: "交换机4", type: "switch", portCount: 6, position: { x: 590, y: 195 } });
  addNode({ id: "nic6", name: "网卡6", type: "endSystem", portCount: 2, position: { x: 760, y: 40 }, hostOrdinal: 6 });
  addNode({ id: "nic7", name: "网卡7", type: "endSystem", portCount: 2, position: { x: 760, y: 195 }, hostOrdinal: 7 });

  addLink("nic1", "p1", "sw1", "p1");
  addLink("nic1", "p2", "sw2", "p1");
  addLink("nic2", "p1", "sw1", "p2");
  addLink("nic2", "p2", "sw2", "p2");
  addLink("nic3", "p1", "sw1", "p3");
  addLink("nic3", "p2", "sw2", "p3");
  addLink("sw1", "p4", "nic4", "p1");
  addLink("sw2", "p4", "nic4", "p2");
  addLink("sw1", "p5", "nic5", "p1");
  addLink("sw2", "p5", "nic5", "p2");
  addLink("sw1", "p6", "sw3", "p1");
  addLink("sw2", "p6", "sw4", "p1");
  addLink("sw3", "p3", "nic6", "p1");
  addLink("sw4", "p3", "nic6", "p2");
  addLink("sw3", "p4", "nic7", "p1");
  addLink("sw4", "p4", "nic7", "p2");

  const project: CanonicalTsnProjectV0 = {
    schemaVersion: "tsn-agent.canonical.v0",
    id: "project-aerospace-redundant",
    name: projectName,
    createdAt: now,
    updatedAt: now,
    topology: { nodes, links },
    flows: [],
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps: dataRateMbps,
      timeSynchronization: "assumed-synchronized",
    },
  };

  if (options.includeControlFlow === false) {
    return project;
  }

  return {
    ...project,
    flows: createAerospaceRedundantFlows(nodes, links, scenarioConfig.flowTemplates[0]),
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
  const nodes: TsnNode[] = [];
  const links: TsnLink[] = [];
  const switchIds: string[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  for (let switchIndex = 1; switchIndex <= intent.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;
    const switchX = 80 + 300 * (switchIndex - 1);
    switchIds.push(switchId);
    nodes.push({
      id: switchId,
      numericId: numericNodeId,
      name: `SW-${switchIndex}`,
      type: "switch",
      ports: createPorts(intent.endSystemsPerSwitch + 2),
      position: { x: switchX, y: 220 },
    });
    numericNodeId += 1;
  }

  for (let switchIndex = 1; switchIndex <= intent.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;

    for (let hostIndex = 1; hostIndex <= intent.endSystemsPerSwitch; hostIndex += 1) {
      const hostId = `es${switchIndex}-${hostIndex}`;
      const hostOrdinal = (switchIndex - 1) * intent.endSystemsPerSwitch + hostIndex;
      const switchX = 80 + 300 * (switchIndex - 1);
      const yOffset = hostIndex % 2 === 0 ? 390 : 70;
      const xJitter = (hostIndex - Math.ceil(intent.endSystemsPerSwitch / 2)) * 62;

      nodes.push({
        id: hostId,
        numericId: numericNodeId,
        name: `ES-${switchIndex}-${hostIndex}`,
        type: "endSystem",
        ports: createPorts(1),
        position: {
          x: switchX + xJitter,
          y: yOffset,
        },
        macAddress: createMacAddress(hostOrdinal),
        ipAddress: `10.0.${switchIndex}.${hostIndex}`,
      });
      numericNodeId += 1;

      links.push(
        createLink({
          numericId: numericLinkId,
          sourceNodeId: hostId,
          sourcePortId: "p1",
          targetNodeId: switchId,
          targetPortId: `p${hostIndex}`,
          dataRateMbps,
        }),
      );
      numericLinkId += 1;
    }
  }

  const switchInterconnectPortOffset = intent.endSystemsPerSwitch;

  for (let index = 0; index < switchIds.length - 1; index += 1) {
    links.push(
      createLink({
        numericId: numericLinkId,
        sourceNodeId: switchIds[index],
        sourcePortId: `p${switchInterconnectPortOffset + 1}`,
        targetNodeId: switchIds[index + 1],
        targetPortId: `p${switchInterconnectPortOffset + 2}`,
        dataRateMbps,
      }),
    );
    numericLinkId += 1;
  }

  if (intent.switchInterconnect === "ring" && switchIds.length > 2) {
    links.push(
      createLink({
        numericId: numericLinkId,
        sourceNodeId: switchIds[switchIds.length - 1],
        sourcePortId: `p${switchInterconnectPortOffset + 1}`,
        targetNodeId: switchIds[0],
        targetPortId: `p${switchInterconnectPortOffset + 2}`,
        dataRateMbps,
      }),
    );
    numericLinkId += 1;
  }

  const flows = options.includeControlFlow === false
    ? []
    : [createControlFlow(nodes, links, intent, scenarioConfig.flowTemplates[0])];

  return {
    schemaVersion: "tsn-agent.canonical.v0",
    id: "project-default",
    name: projectName,
    createdAt: now,
    updatedAt: now,
    topology: { nodes, links },
    flows,
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps: dataRateMbps,
      timeSynchronization: "assumed-synchronized",
    },
  };
}

export function withDefaultControlFlow(
  project: CanonicalTsnProjectV0,
  options: TopologyFactoryOptions = {},
): CanonicalTsnProjectV0 {
  if (isAerospaceRedundantProject(project)) {
    const scenarioConfig = resolveScenarioConfig(options.scenarioConfigId ?? "aerospace-onboard").config;
    const defaultFlows = createAerospaceRedundantFlows(
      project.topology.nodes,
      project.topology.links,
      scenarioConfig.flowTemplates[0],
    );
    const defaultFlowIds = new Set(defaultFlows.map((flow) => flow.id));
    const mergedFlows = [
      ...defaultFlows.map((flow) => project.flows.find((candidate) => candidate.id === flow.id) ?? flow),
      ...project.flows.filter((flow) => !defaultFlowIds.has(flow.id)),
    ];

    if (mergedFlows.length === project.flows.length) {
      return project;
    }

    return {
      ...project,
      updatedAt: new Date().toISOString(),
      flows: renumberFlows(mergedFlows),
    };
  }

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

  const scenarioConfig = isAerospaceRedundantProject(project)
    ? resolveScenarioConfig(options.scenarioConfigId ?? "aerospace-onboard").config
    : resolveScenarioConfig(options.scenarioConfigId).config;
  const intent = inferIntentFromProject(project);
  const flows = [...project.flows];

  if (isAerospaceRedundantProject(project)) {
    if (flowIntent.controlFlow && !flows.some((flow) => flow.id === "flow-control-1")) {
      flows.unshift(createAerospaceControlFlow(project.topology.nodes, project.topology.links, scenarioConfig.flowTemplates[0]));
    }

    if (flowIntent.heartbeatFlow && !flows.some((flow) => flow.id === "flow-heartbeat-1")) {
      const controlFlowIndex = flows.findIndex((flow) => flow.id === "flow-control-1");
      const heartbeatFlow = createAerospaceHeartbeatFlow(project.topology.nodes, project.topology.links);

      if (controlFlowIndex >= 0) {
        flows.splice(controlFlowIndex + 1, 0, heartbeatFlow);
      } else {
        flows.push(heartbeatFlow);
      }
    }

    appendAerospaceVideoFlows(flows, flowIntent.videoFlowCount, project.topology.nodes, project.topology.links);

    if (flows.length === project.flows.length) {
      return project;
    }

    return {
      ...project,
      updatedAt: new Date().toISOString(),
      flows: renumberFlows(flows),
    };
  }

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
  if (isAerospaceRedundantProject(project)) {
    return {
      switchCount: 4,
      endSystemsPerSwitch: 0,
      switchInterconnect: "line",
      topologyTemplate: "aerospace-redundant",
      endSystemCount: 7,
    };
  }

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

function isAerospaceRedundantTopologyRequest(text: string, scenarioConfigId?: string): boolean {
  const hasAerospaceSignal = /箭载|航天|火箭|飞控|箭机|级间/i.test(text) || scenarioConfigId === "aerospace-onboard";
  const hasRedundantSignal = /双冗余|双平面|系统交换机|双归属|双以太网|网卡[1-7]/i.test(text);
  const hasDiagramScale = /4\s*(?:个|台)?\s*(?:系统\s*)?交换机/i.test(text)
    && /7\s*(?:个|块|张|台)?\s*网卡/i.test(text);
  const hasNamedDiagramNodes = /网卡1/.test(text) && /网卡7/.test(text) && /交换机1/.test(text) && /交换机4/.test(text);

  return hasNamedDiagramNodes || hasDiagramScale && hasRedundantSignal || hasAerospaceSignal && hasRedundantSignal;
}

function isAerospaceRedundantProject(project: CanonicalTsnProjectV0): boolean {
  const nodeIds = new Set(project.topology.nodes.map((node) => node.id));

  return project.id === "project-aerospace-redundant"
    || ["nic1", "nic2", "nic3", "nic4", "nic5", "nic6", "nic7", "sw1", "sw2", "sw3", "sw4"]
      .every((nodeId) => nodeIds.has(nodeId));
}

function createPorts(count: number): TsnPort[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `eth${index}`,
    index,
  }));
}

function createLink(input: {
  numericId: number;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  dataRateMbps: number;
}): TsnLink {
  return {
    id: `link-${input.numericId}`,
    numericId: input.numericId,
    source: {
      nodeId: input.sourceNodeId,
      portId: input.sourcePortId,
    },
    target: {
      nodeId: input.targetNodeId,
      portId: input.targetPortId,
    },
    medium: "ethernet",
    dataRateMbps: input.dataRateMbps,
  };
}

function createControlFlow(
  nodes: TsnNode[],
  links: TsnLink[],
  intent: TopologyIntent,
  template: ScenarioFlowTemplate,
): TsnFlow {
  const sourceNode = findNode(nodes, "es1-1");
  const destinationNode = findNode(nodes, `es${intent.switchCount}-1`);
  const routeNodeIds = [
    sourceNode.id,
    ...Array.from({ length: intent.switchCount }, (_, index) => `sw${index + 1}`),
    destinationNode.id,
  ];
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
  const routeNodeIds = [
    sourceNode.id,
    ...Array.from({ length: intent.switchCount }, (_, index) => `sw${index + 1}`),
    destinationNode.id,
  ];
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
  const routeNodeIds = [
    sourceNode.id,
    ...Array.from({ length: intent.switchCount }, (_, index) => `sw${index + 1}`),
    destinationNode.id,
  ];
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

function createAerospaceRedundantFlows(
  nodes: TsnNode[],
  links: TsnLink[],
  template: ScenarioFlowTemplate,
): TsnFlow[] {
  return [
    createAerospaceControlFlow(nodes, links, template),
    createAerospaceHeartbeatFlow(nodes, links),
  ];
}

function createAerospaceControlFlow(
  nodes: TsnNode[],
  links: TsnLink[],
  template: ScenarioFlowTemplate,
): TsnFlow {
  const sourceNode = findNode(nodes, "nic1");
  const destinationNode = findNode(nodes, "nic7");
  const routeNodeIds = ["nic1", "sw1", "sw3", "nic7"];
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: "flow-control-1",
    numericId: 1,
    name: template.name,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(1),
      ipAddress: sourceNode.ipAddress ?? "10.10.0.1",
      udpPort: 25563,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(7),
      ipAddress: destinationNode.ipAddress ?? "10.10.0.7",
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

function createAerospaceHeartbeatFlow(nodes: TsnNode[], links: TsnLink[]): TsnFlow {
  const sourceNode = findNode(nodes, "nic2");
  const destinationNode = findNode(nodes, "nic6");
  const routeNodeIds = ["nic2", "sw2", "sw4", "nic6"];
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: "flow-heartbeat-1",
    numericId: 2,
    name: "心跳消息-1",
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(2),
      ipAddress: sourceNode.ipAddress ?? "10.10.0.2",
      udpPort: 25565,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(6),
      ipAddress: destinationNode.ipAddress ?? "10.10.0.6",
      udpPort: 26030,
    },
    periodUs: 20_000,
    frameSizeBytes: 10,
    pcp: 6,
    maxFramesPerInterval: 1,
    earliestTransmitOffsetUs: 0,
    latestTransmitOffsetUs: 100,
    jitterRequirementUs: 0.5,
    latencyRequirementUs: 1_000,
    routeLinkIds,
    routeNodeIds,
    flowType: "ST",
  };
}

function appendAerospaceVideoFlows(flows: TsnFlow[], requestedCount: number, nodes: TsnNode[], links: TsnLink[]): void {
  const existingCount = countFlowsByPrefix(flows, "flow-video-");

  for (let index = 1; index <= requestedCount; index += 1) {
    flows.push(createAerospaceVideoFlow(nodes, links, existingCount + index));
  }
}

function createAerospaceVideoFlow(nodes: TsnNode[], links: TsnLink[], ordinal = 1): TsnFlow {
  const sourceNode = findNode(nodes, "nic5");
  const destinationNode = findNode(nodes, "nic6");
  const routeNodeIds = ["nic5", "sw2", "sw4", "nic6"];
  const routeLinkIds = createRouteLinkIds(routeNodeIds, links);

  return {
    id: `flow-video-${ordinal}`,
    numericId: 3,
    name: `视频流-${ordinal}`,
    source: {
      nodeId: sourceNode.id,
      macAddress: sourceNode.macAddress ?? createMacAddress(5),
      ipAddress: sourceNode.ipAddress ?? "10.10.0.5",
      udpPort: 25563 + ordinal,
    },
    destination: {
      nodeId: destinationNode.id,
      macAddress: destinationNode.macAddress ?? createMacAddress(6),
      ipAddress: destinationNode.ipAddress ?? "10.10.0.6",
      udpPort: 26028 + ordinal,
    },
    periodUs: 33_333,
    frameSizeBytes: 1_500,
    pcp: 4,
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
