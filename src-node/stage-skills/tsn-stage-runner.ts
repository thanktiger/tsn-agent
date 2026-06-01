import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CanonicalTsnProjectV0, TopologyIntent, TsnPort } from "../../src/domain/canonical";
import { createProjectFromIntent, parseTopologyIntent } from "../../src/domain/topology-factory";
import { withFlowsFromIntent, withDefaultControlFlow } from "../../src/domain/topology-factory";
import { validateCanonicalProject } from "../../src/domain/validation";
import { STAGE_SKILL_SCHEMA_VERSION, type StageSkillResult } from "../../src/agent/stage-skill-contract";

export interface StageRunnerInput {
  userIntent: string;
  stage?: string;
  scenarioConfigId?: string;
  fallbackIntent?: Partial<TopologyIntent>;
  project?: CanonicalTsnProjectV0;
  skillOutputDir?: string;
}

export function runTopologyStage(input: StageRunnerInput): StageSkillResult {
  const project = createProjectFromIntent(input.userIntent, input.fallbackIntent, {
    scenarioConfigId: input.scenarioConfigId,
    includeControlFlow: false,
  });
  const intent = parseTopologyIntent(input.userIntent, input.fallbackIntent, {
    scenarioConfigId: input.scenarioConfigId,
  });
  const validation = validateCanonicalProject(project);
  const summary = `${describeTopologyIntent(intent)}${describeTopologyInterconnect(intent)}`;

  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: "topology",
    skillName: "tsn-topology",
    status: validation.ok ? "success" : "failed",
    summary,
    validation,
    safeEventSummary: {
      title: "拓扑结果",
      content: validation.ok
        ? `已生成 ${project.topology.nodes.length} 个节点和 ${project.topology.links.length} 条链路。`
        : `拓扑校验失败：${validation.errors.join("；")}`,
      status: validation.ok ? "success" : "error",
    },
    payload: {
      kind: "topology",
      project,
    },
  };
}

export async function runTopologyStageFromSkillOutput(input: StageRunnerInput): Promise<StageSkillResult> {
  if (!input.skillOutputDir) {
    throw new Error("skillOutputDir is required for tsn-topology skill output import.");
  }

  const project = await createProjectFromTsnTopologySkillOutput(input.skillOutputDir, input.scenarioConfigId);
  const validation = mergeValidationReports(
    validateCanonicalProject(project),
    validateTopologySkillIntentConsistency(project, input),
  );
  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;
  const summary = `tsn-topology skill 已生成 ${switchCount} 个交换机、${endSystemCount} 个端系统和 ${project.topology.links.length} 条链路。`;

  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: "topology",
    skillName: "tsn-topology",
    status: validation.ok ? "success" : "failed",
    summary,
    validation,
    safeEventSummary: {
      title: "拓扑结果",
      content: validation.ok
        ? `已导入 skill 生成的 ${project.topology.nodes.length} 个节点和 ${project.topology.links.length} 条链路。`
        : `拓扑校验失败：${validation.errors.join("；")}`,
      status: validation.ok ? "success" : "error",
    },
    payload: {
      kind: "topology",
      project,
    },
  };
}

function mergeValidationReports(
  ...reports: Array<{ ok: boolean; errors: string[] }>
): { ok: boolean; errors: string[] } {
  const errors = reports.flatMap((report) => report.errors);

  return {
    ok: reports.every((report) => report.ok) && errors.length === 0,
    errors,
  };
}

function validateTopologySkillIntentConsistency(
  project: CanonicalTsnProjectV0,
  input: StageRunnerInput,
): { ok: boolean; errors: string[] } {
  const intent = parseTopologyIntent(input.userIntent, input.fallbackIntent, {
    scenarioConfigId: input.scenarioConfigId,
  });

  if (intent.topologyTemplate || intent.switchInterconnect !== "line" || hasExplicitIndependentSwitches(input.userIntent)) {
    return { ok: true, errors: [] };
  }

  const switchCount = project.topology.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = project.topology.nodes.filter((node) => node.type === "endSystem").length;
  if (switchCount < 2 || endSystemCount === 0) {
    return { ok: true, errors: [] };
  }

  const expectedEndSystemCount = intent.switchCount * intent.endSystemsPerSwitch;
  if (switchCount !== intent.switchCount || endSystemCount !== expectedEndSystemCount) {
    return { ok: true, errors: [] };
  }

  const switchLinkCount = countSwitchToSwitchLinks(project);
  const expectedSwitchLinkCount = Math.max(0, switchCount - 1);

  if (switchLinkCount >= expectedSwitchLinkCount) {
    return { ok: true, errors: [] };
  }

  return {
    ok: false,
    errors: [
      `通用分布式拓扑缺少交换机互联链路：识别到 ${switchCount} 个交换机、每台 ${intent.endSystemsPerSwitch} 个端系统，默认应有 ${expectedSwitchLinkCount} 条交换机线型互联链路，实际只有 ${switchLinkCount} 条。`,
    ],
  };
}

function countSwitchToSwitchLinks(project: CanonicalTsnProjectV0): number {
  const typeByNodeId = new Map(project.topology.nodes.map((node) => [node.id, node.type]));

  return project.topology.links.filter((link) =>
    typeByNodeId.get(link.source.nodeId) === "switch"
      && typeByNodeId.get(link.target.nodeId) === "switch"
  ).length;
}

function hasExplicitIndependentSwitches(text: string): boolean {
  return /交换机(?:之间)?(?:相互)?(?:独立|不互联|不连接|无需互联)|不(?:要|需要)?交换机(?:之间)?互联|单独成星型/i.test(text);
}

export function runFlowPlanningStage(input: StageRunnerInput): StageSkillResult {
  const baseProject = input.project
    ? normalizeProject(input.project)
    : createProjectFromIntent(input.userIntent || "请生成默认拓扑", input.fallbackIntent, {
        scenarioConfigId: input.scenarioConfigId,
        includeControlFlow: false,
      });
  const projectWithDefaultFlow = withDefaultControlFlow(baseProject, {
    scenarioConfigId: input.scenarioConfigId,
  });
  const project = withFlowsFromIntent(projectWithDefaultFlow, input.userIntent, {
    scenarioConfigId: input.scenarioConfigId,
  });
  const validation = validateCanonicalProject(project);
  const summary = describeFlowPlanning(project);

  return {
    schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
    stage: "flow-template",
    skillName: "tsn-flow-planning",
    status: validation.ok ? "success" : "failed",
    summary,
    validation,
    safeEventSummary: {
      title: "流量规划结果",
      content: validation.ok ? summary : `流量规划校验失败：${validation.errors.join("；")}`,
      status: validation.ok ? "success" : "error",
    },
    payload: {
      kind: "flow-template",
      project,
    },
  };
}

function normalizeProject(project: CanonicalTsnProjectV0): CanonicalTsnProjectV0 {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    topology: {
      nodes: [...project.topology.nodes],
      links: [...project.topology.links],
    },
    flows: [...project.flows],
  };
}

function describeFlowPlanning(project: CanonicalTsnProjectV0): string {
  if (project.flows.length === 0) {
    return "当前拓扑还没有可用流量规划。";
  }

  return `已准备 ${project.flows.length} 条流：${project.flows.map(describeFlow).join("；")}。`;
}

function describeFlow(flow: CanonicalTsnProjectV0["flows"][number]): string {
  return `${flow.name}，路径 ${flow.routeNodeIds.join(" -> ")}，周期 ${flow.periodUs}us，帧长 ${flow.frameSizeBytes}B，PCP ${flow.pcp}`;
}

function describeTopologyIntent(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "dual-plane-redundant") {
    return `识别到双平面冗余拓扑：${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
  }

  return `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
}

function describeTopologyInterconnect(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "dual-plane-redundant") {
    return "交换机按 A/B 双平面成对分组，端系统双归属接入对应故障域。";
  }

  return intent.switchInterconnect === "ring" ? "交换机采用环形互联。" : "交换机采用线型互联。";
}

export async function writeStageResult(result: StageSkillResult, resultPath: string): Promise<void> {
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export function parseRunnerArgs(argv: string[]): {
  stage: string;
  inputJson: string;
  resultPath: string;
  skillOutputDir?: string;
} {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument at position ${index}: ${key ?? ""}`);
    }

    args.set(key, value);
  }

  return {
    stage: requireArg(args, "--stage"),
    inputJson: requireArg(args, "--input"),
    resultPath: requireArg(args, "--result-path"),
    skillOutputDir: args.get("--skill-output-dir"),
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { stage, inputJson, resultPath, skillOutputDir } = parseRunnerArgs(argv);

  if (stage !== "topology" && stage !== "flow-template") {
    throw new Error(`Unsupported stage: ${stage}`);
  }

  const input = JSON.parse(inputJson) as StageRunnerInput;
  const normalizedInput = {
    ...input,
    userIntent: String(input.userIntent ?? "").trim(),
    scenarioConfigId: typeof input.scenarioConfigId === "string" ? input.scenarioConfigId : undefined,
    fallbackIntent: input.fallbackIntent,
    project: input.project,
    skillOutputDir: skillOutputDir ?? (typeof input.skillOutputDir === "string" ? input.skillOutputDir : undefined),
  };
  const result = stage === "topology"
    ? normalizedInput.skillOutputDir
      ? await runTopologyStageFromSkillOutput(normalizedInput)
      : runTopologyStage(normalizedInput)
    : runFlowPlanningStage(normalizedInput);

  await writeStageResult(result, resultPath);
}

async function createProjectFromTsnTopologySkillOutput(
  skillOutputDir: string,
  scenarioConfigId?: string,
): Promise<CanonicalTsnProjectV0> {
  const topology = await readJsonFile<TsnTopologyJson>(join(skillOutputDir, "topology.json"));
  const dataServerMetadata = await readDataServerMetadata(skillOutputDir);
  const rawNodes = topology.node?.nodes;
  const rawLinks = topology.node?.links;

  if (!Array.isArray(rawNodes) || !Array.isArray(rawLinks)) {
    throw new Error("tsn-topology topology.json must contain node.nodes and node.links arrays.");
  }

  const switchImacs = new Set(
    rawNodes
      .filter((node) => node.node_type === "switch")
      .map((node) => Number(node.imac)),
  );
  const switchOrdinalByImac = new Map<number, number>();
  const endSystemPrimarySwitchByImac = inferPrimarySwitchByEndSystemImac(rawLinks, switchImacs);
  const endpointOrdinalBySwitch = new Map<number, number>();
  const portMaxByImac = collectPortMaxByImac(rawLinks);
  const nodeIdByImac = new Map<number, string>();
  let switchOrdinal = 0;
  let endpointOrdinal = 0;

  for (const rawNode of rawNodes) {
    const imac = Number(rawNode.imac);
    if (rawNode.node_type === "switch") {
      switchOrdinal += 1;
      switchOrdinalByImac.set(imac, switchOrdinal);
      nodeIdByImac.set(imac, `sw${switchOrdinal}`);
    }
  }

  for (const rawNode of rawNodes) {
    const imac = Number(rawNode.imac);
    if (rawNode.node_type === "switch") {
      continue;
    }

    endpointOrdinal += 1;
    const primarySwitchImac = endSystemPrimarySwitchByImac.get(imac);
    const primarySwitchOrdinal = primarySwitchImac === undefined ? undefined : switchOrdinalByImac.get(primarySwitchImac);

    if (primarySwitchOrdinal !== undefined) {
      const nextEndpointOrdinal = (endpointOrdinalBySwitch.get(primarySwitchOrdinal) ?? 0) + 1;
      endpointOrdinalBySwitch.set(primarySwitchOrdinal, nextEndpointOrdinal);
      nodeIdByImac.set(imac, `es${primarySwitchOrdinal}-${nextEndpointOrdinal}`);
    } else {
      nodeIdByImac.set(imac, `es${endpointOrdinal}`);
    }
  }

  const nodes: CanonicalTsnProjectV0["topology"]["nodes"] = rawNodes.map((rawNode, index) => {
    const imac = Number(rawNode.imac);
    const type = rawNode.node_type === "switch" ? "switch" : "endSystem";
    const nodeId = nodeIdByImac.get(imac) ?? `${type === "switch" ? "sw" : "es"}${index + 1}`;
    const metadata = dataServerMetadata.get(imac);
    const maxPort = portMaxByImac.get(imac) ?? 0;
    const declaredPortCount = Number(metadata?.portCount);
    const portCount = Math.max(1, maxPort + 1, Number.isFinite(declaredPortCount) ? declaredPortCount : 0);

    return {
      id: nodeId,
      numericId: parseFiniteNumber(rawNode.sync_name, index),
      name: metadata?.displayName ?? defaultNodeName(nodeId, type),
      type,
      ports: createPorts(portCount),
      position: {
        x: parseFiniteNumber(rawNode.x, index * 160),
        y: parseFiniteNumber(rawNode.y, 0),
      },
      macAddress: metadata?.macAddress,
      ipAddress: metadata?.ipAddress,
    };
  });

  const links = rawLinks.map((rawLink, index) => {
    const sourceImac = Number(rawLink.imac);
    const targetImac = Number(rawLink.addr);
    const sourceNodeId = nodeIdByImac.get(sourceImac);
    const targetNodeId = nodeIdByImac.get(targetImac);

    if (!sourceNodeId || !targetNodeId) {
      throw new Error(`tsn-topology link ${index} references an unknown node imac.`);
    }

    return {
      id: `link-${index}`,
      numericId: index,
      source: {
        nodeId: sourceNodeId,
        portId: portLabelToPortId(rawLink.styles?.leftLabel),
      },
      target: {
        nodeId: targetNodeId,
        portId: portLabelToPortId(rawLink.styles?.rightLabel),
      },
      medium: "ethernet" as const,
      dataRateMbps: parseFiniteNumber(rawLink.styles?.speed, 1000),
    };
  });

  const now = new Date().toISOString();
  const defaultDataRateMbps = links[0]?.dataRateMbps ?? 1000;

  return {
    schemaVersion: "tsn-agent.canonical.v0",
    id: "project-tsn-topology-skill",
    name: "tsn-topology skill 拓扑",
    createdAt: now,
    updatedAt: now,
    topology: { nodes, links },
    flows: [],
    simulationHints: {
      inetVersion: "INET 4.x",
      nedPackage: "tsnagent.generated",
      defaultDataRateMbps,
      timeSynchronization: "assumed-synchronized",
    },
  };
}

async function readDataServerMetadata(skillOutputDir: string): Promise<Map<number, SkillNodeMetadata>> {
  try {
    const dataServer = await readJsonFile<TsnDataServerJson>(join(skillOutputDir, "data-server.json"));
    const metadata = new Map<number, SkillNodeMetadata>();

    for (const item of dataServer.datas ?? []) {
      if (item?._className !== "Q.Node") {
        continue;
      }

      const imac = Number(item.src_imac ?? item.id);
      if (!Number.isFinite(imac)) {
        continue;
      }

      metadata.set(imac, {
        displayName: typeof item.display_name === "string" ? item.display_name : undefined,
        macAddress: typeof item.mac_address === "string" ? item.mac_address : undefined,
        ipAddress: typeof item.ip === "string" ? item.ip : undefined,
        portCount: typeof item.port_count === "number" ? item.port_count : undefined,
      });
    }

    return metadata;
  } catch {
    return new Map();
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function inferPrimarySwitchByEndSystemImac(
  rawLinks: TsnTopologyLinkJson[],
  switchImacs: Set<number>,
): Map<number, number> {
  const primarySwitchByEndSystem = new Map<number, number>();

  for (const rawLink of rawLinks) {
    const sourceImac = Number(rawLink.imac);
    const targetImac = Number(rawLink.addr);
    const sourceIsSwitch = switchImacs.has(sourceImac);
    const targetIsSwitch = switchImacs.has(targetImac);

    if (sourceIsSwitch === targetIsSwitch) {
      continue;
    }

    const endSystemImac = sourceIsSwitch ? targetImac : sourceImac;
    const switchImac = sourceIsSwitch ? sourceImac : targetImac;
    const current = primarySwitchByEndSystem.get(endSystemImac);

    if (current === undefined || switchImac < current) {
      primarySwitchByEndSystem.set(endSystemImac, switchImac);
    }
  }

  return primarySwitchByEndSystem;
}

function collectPortMaxByImac(rawLinks: TsnTopologyLinkJson[]): Map<number, number> {
  const portMaxByImac = new Map<number, number>();

  for (const rawLink of rawLinks) {
    notePort(portMaxByImac, Number(rawLink.imac), rawLink.styles?.leftLabel);
    notePort(portMaxByImac, Number(rawLink.addr), rawLink.styles?.rightLabel);
  }

  return portMaxByImac;
}

function notePort(portMaxByImac: Map<number, number>, imac: number, label: unknown): void {
  const port = parseFiniteNumber(label, 0);
  const current = portMaxByImac.get(imac) ?? 0;
  portMaxByImac.set(imac, Math.max(current, port));
}

function portLabelToPortId(value: unknown): string {
  return `p${parseFiniteNumber(value, 0) + 1}`;
}

function parseFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultNodeName(nodeId: string, type: "switch" | "endSystem"): string {
  if (type === "switch") {
    return nodeId.replace(/^sw/, "SW-");
  }

  return nodeId.replace(/^es/, "ES-");
}

function createPorts(count: number): TsnPort[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `eth${index}`,
    index,
  }));
}

interface TsnTopologyJson {
  node?: {
    nodes?: TsnTopologyNodeJson[];
    links?: TsnTopologyLinkJson[];
  };
}

interface TsnTopologyNodeJson {
  imac: number | string;
  sync_name: number | string;
  x?: number | string;
  y?: number | string;
  node_type?: string;
}

interface TsnTopologyLinkJson {
  imac: number | string;
  addr: number | string;
  styles?: {
    leftLabel?: number | string;
    rightLabel?: number | string;
    speed?: number | string;
  };
}

interface TsnDataServerJson {
  datas?: TsnDataServerItemJson[];
}

interface TsnDataServerItemJson {
  _className?: string;
  id?: number | string;
  src_imac?: number | string;
  display_name?: string;
  mac_address?: string;
  ip?: string;
  port_count?: number;
}

interface SkillNodeMetadata {
  displayName?: string;
  macAddress?: string;
  ipAddress?: string;
  portCount?: number;
}

function requireArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

if (await isCliEntryPoint(import.meta.url, process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function isCliEntryPoint(moduleUrl: string, argvPath?: string): Promise<boolean> {
  if (!argvPath) {
    return false;
  }

  try {
    return await realpath(new URL(moduleUrl).pathname) === await realpath(argvPath);
  } catch {
    return moduleUrl === `file://${argvPath}`;
  }
}
