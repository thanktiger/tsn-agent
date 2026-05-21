import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalTsnProjectV0, TopologyIntent } from "../../src/domain/canonical";
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
  if (intent.topologyTemplate === "aerospace-redundant") {
    return `识别到箭载双冗余拓扑：${intent.switchCount} 个交换机，${intent.endSystemCount ?? 7} 个网卡。`;
  }

  return `识别到 ${intent.switchCount} 个交换机，每个交换机连接 ${intent.endSystemsPerSwitch} 个端系统。`;
}

function describeTopologyInterconnect(intent: TopologyIntent): string {
  if (intent.topologyTemplate === "aerospace-redundant") {
    return "左右两组系统交换机不级联，通过双冗余主干链路互联，网卡双归属接入。";
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
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { stage, inputJson, resultPath } = parseRunnerArgs(argv);

  if (stage !== "topology" && stage !== "flow-template") {
    throw new Error(`Unsupported stage: ${stage}`);
  }

  const input = JSON.parse(inputJson) as StageRunnerInput;
  const normalizedInput = {
    ...input,
    userIntent: String(input.userIntent ?? "").trim(),
    scenarioConfigId: typeof input.scenarioConfigId === "string" ? input.scenarioConfigId : undefined,
    fallbackIntent: input.fallbackIntent,
  };
  const result = stage === "topology"
    ? runTopologyStage(normalizedInput)
    : runFlowPlanningStage(normalizedInput);

  await writeStageResult(result, resultPath);
}

function requireArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
