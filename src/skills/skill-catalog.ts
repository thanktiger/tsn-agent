import type { StageSkillName } from "../agent/stage-skill-contract";
import type { WorkflowStep } from "../domain/scenario-config";

export type SkillCatalogStatus = "enabled" | "draft" | "disabled";

export interface SkillCatalogItem {
  id: StageSkillName;
  stage: WorkflowStep;
  stageLabel: string;
  displayName: string;
  description: string;
  inputSummary: string;
  outputSummary: string;
  status: SkillCatalogStatus;
  notes: string;
}

export const SKILL_CATALOG: SkillCatalogItem[] = [
  {
    id: "tsn-topology",
    stage: "topology",
    stageLabel: "拓扑",
    displayName: "拓扑生成",
    description: "根据用户自然语言需求生成 canonical TSN 拓扑、节点、端口和链路。",
    inputSummary: "用户需求、场景配置、拓扑默认值",
    outputSummary: "canonical project、拓扑摘要、阶段确认信息",
    status: "enabled",
    notes: "已有独立 skill，可作为后续 skill 详情和执行状态展示的基准。",
  },
  {
    id: "tsn-time-sync",
    stage: "time-sync",
    stageLabel: "时间同步",
    displayName: "时间同步",
    description:
      "引导用户用自然语言指定时钟主节点（GM），按「GM + 拓扑」确定性算时钟同步树（端口 master/slave/passive 角色），补默认同步参数请确认，之后可换 GM / 改参数 / 启停链路。",
    inputSummary: "拓扑、用户指定的 GM、同步参数、启停链路意图",
    outputSummary: "时钟同步树（端口角色）、同步参数、禁用链路集",
    status: "enabled",
    notes: "确定性核心：端口角色衍生不可直填，关键不变量由 Rust 重算 + 确认闸兜底。",
  },
  {
    id: "tsn-flow-planning",
    stage: "flow-template",
    stageLabel: "流量规划",
    displayName: "流量规划",
    description: "解析用户业务流需求，生成流模板，并准备提交外部规划器所需的流参数。",
    inputSummary: "拓扑、用户流量描述、场景流模板",
    outputSummary: "业务流列表、路径、周期、帧长、优先级、时延和抖动约束",
    status: "disabled",
    notes: "流量规划暂时下线，预计随 Phase B 在工程数据库路径上重建。",
  },
];
