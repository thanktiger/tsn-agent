export const WORKFLOW_STEPS = ["topology", "time-sync", "flow-template"] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

// verify-skills.mjs 正则锚点：此 union 须保持单行（R9 对账 reference 文件名）；
// 改名/换行前同步 scripts/verify-skills.mjs。
export type ScenarioConfigId = "generic-tsn" | "aerospace-onboard";

export interface ScenarioFlowTemplate {
  id: string;
  name: string;
  description: string;
  flowType: "ST" | "BE";
  periodUs: number;
  frameSizeBytes: number;
  pcp: number;
  latencyRequirementUs: number;
  jitterRequirementUs: number;
}

export interface ScenarioConfig {
  id: ScenarioConfigId;
  displayName: string;
  /** 进门输入框的示例需求（placeholder / 引导用户怎么描述）。 */
  exampleIntent: string;
  stageLabels: Record<WorkflowStep, string>;
  // 拓扑推荐默认已收口到 skill 场景 reference（R10）：唯一事实源是
  // .claude/skills/tsn-topology/references/<场景id>.md，此处不再复制。
  defaults: {
    timeSyncSummary: string;
  };
  flowTemplates: ScenarioFlowTemplate[];
  terminology: Record<string, string>;
}

export interface ScenarioConfigResolution {
  config: ScenarioConfig;
  requestedId?: string;
  fallback: boolean;
  warning?: string;
}

export const DEFAULT_SCENARIO_CONFIG_ID: ScenarioConfigId = "aerospace-onboard";

export const SCENARIO_CONFIGS: Record<ScenarioConfigId, ScenarioConfig> = {
  "generic-tsn": {
    id: "generic-tsn",
    displayName: "通用 TSN",
    exampleIntent: "我需要 4 个交换机，每个交换机连接 5 个端系统",
    stageLabels: {
      topology: "拓扑",
      "time-sync": "时间同步",
      "flow-template": "流量规划",
    },
    defaults: {
      timeSyncSummary: "默认假设全网已完成时间同步，后续仿真配置再细化 gPTP 主时钟和端口关系。",
    },
    flowTemplates: [
      {
        id: "control-st",
        name: "控制流-1",
        description: "ST 控制流模板，适合先验证规划器输入链路。",
        flowType: "ST",
        periodUs: 250,
        frameSizeBytes: 512,
        pcp: 6,
        latencyRequirementUs: 1_000,
        jitterRequirementUs: 10,
      },
    ],
    terminology: {
      endSystem: "端系统",
      flow: "控制流",
      plannerInput: "规划器输入",
    },
  },
  "aerospace-onboard": {
    id: "aerospace-onboard",
    displayName: "箭载 TSN 典型场景",
    exampleIntent: "双平面双跳冗余拓扑，4 个端系统、4 个交换机（A/B 平面物理隔离、端系统双归属）",
    stageLabels: {
      topology: "拓扑生成",
      "time-sync": "时间同步",
      "flow-template": "流量规划",
    },
    defaults: {
      timeSyncSummary:
        "默认采用全网统一时钟假设，优先保留 GM 选择、同步域和从端口关系的后续扩展位置。",
    },
    flowTemplates: [
      {
        id: "flight-control-st",
        name: "时序控制消息-1",
        description: "面向箭载双冗余链路的 1ms ST 时序控制消息模板。",
        flowType: "ST",
        periodUs: 1_000,
        frameSizeBytes: 10,
        pcp: 7,
        latencyRequirementUs: 1_000,
        jitterRequirementUs: 0.5,
      },
    ],
    terminology: {
      endSystem: "任务端系统",
      flow: "关键控制流",
      plannerInput: "调度规划输入",
    },
  },
};

export function resolveScenarioConfig(configId?: string): ScenarioConfigResolution {
  if (!configId) {
    return {
      config: SCENARIO_CONFIGS[DEFAULT_SCENARIO_CONFIG_ID],
      fallback: false,
    };
  }

  if (isScenarioConfigId(configId)) {
    return {
      config: SCENARIO_CONFIGS[configId],
      requestedId: configId,
      fallback: false,
    };
  }

  return {
    config: SCENARIO_CONFIGS[DEFAULT_SCENARIO_CONFIG_ID],
    requestedId: configId,
    fallback: true,
    warning: `Unknown scenario config "${configId}", falling back to ${DEFAULT_SCENARIO_CONFIG_ID}.`,
  };
}

export function getScenarioConfig(configId?: string): ScenarioConfig {
  return resolveScenarioConfig(configId).config;
}

function isScenarioConfigId(value: string): value is ScenarioConfigId {
  return Object.hasOwn(SCENARIO_CONFIGS, value);
}
