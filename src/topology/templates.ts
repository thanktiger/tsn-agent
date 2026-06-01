import type { TopologyTemplateId } from "./intermediate";

export interface TopologyTemplateParam {
  name: string;
  type: "integer" | "enum" | "array" | "object" | "tuple";
  required?: boolean;
  default?: number | string;
  minimum?: number;
  maximum?: number;
  values?: Array<number | string>;
  description: string;
  itemShape?: Record<string, unknown>;
}

export interface TopologyTemplateDescription {
  id: TopologyTemplateId;
  name: string;
  description: string;
  tags: string[];
  params: TopologyTemplateParam[];
  example: Record<string, unknown>;
}

export interface TopologyTemplateCatalogSummary {
  templateCount: number;
  templateIds: TopologyTemplateId[];
  templates: TopologyTemplateDescription[];
}

export const SUPPORTED_DATA_RATES_MBPS = [10, 100, 1_000, 10_000] as const;

export function describeTemplates(): {
  summary: TopologyTemplateCatalogSummary;
  templates: TopologyTemplateDescription[];
} {
  const templates: TopologyTemplateDescription[] = [
    {
      id: "generic-line",
      name: "通用线型拓扑",
      description: "多台交换机线型互联，每台交换机接入固定数量端系统。",
      tags: ["generic", "line", "beginner"],
      params: genericDistributedParams(),
      example: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
    },
    {
      id: "generic-ring",
      name: "通用环形拓扑",
      description: "多台交换机环形互联，每台交换机接入固定数量端系统。",
      tags: ["generic", "ring", "redundant"],
      params: genericDistributedParams(),
      example: {
        switchCount: 4,
        endSystemsPerSwitch: 2,
        dataRateMbps: 1_000,
      },
    },
    {
      id: "dual-plane-redundant",
      name: "通用双平面冗余拓扑",
      description: "A/B 两个交换机平面，端系统显式双归属接入成对 switch group。",
      tags: ["generic", "dual-plane", "dual-homed", "redundant"],
      params: [
        {
          name: "planes",
          type: "tuple",
          required: true,
          description: "固定两个平面，P0 只支持 A/B。",
          itemShape: {
            id: "A | B",
            name: "string?",
          },
        },
        {
          name: "switches",
          type: "array",
          required: true,
          description: "显式交换机列表，每台交换机声明所属平面、groupId 和可选端口数。",
          itemShape: {
            id: "string",
            name: "string?",
            plane: "A | B",
            groupId: "string",
            portCount: "integer?",
          },
        },
        {
          name: "switchGroups",
          type: "array",
          required: true,
          description: "成对 A/B 交换机故障域，每个 group 必须引用一台 A 平面和一台 B 平面交换机。",
          itemShape: {
            id: "string",
            name: "string?",
            planeSwitches: {
              A: "switchId",
              B: "switchId",
            },
          },
        },
        {
          name: "endSystems",
          type: "array",
          required: true,
          description: "显式端系统列表，每个端系统必须声明 primary/backup 接入。",
          itemShape: {
            id: "string",
            name: "string?",
            groupId: "string",
            attachment: {
              primary: { switchId: "string", plane: "A | B" },
              backup: { switchId: "string", plane: "A | B" },
            },
          },
        },
        {
          name: "backbone",
          type: "object",
          required: true,
          description: "平面内骨干连接策略，P0 支持 line/ring。",
          itemShape: {
            mode: "line | ring",
            withinPlane: "boolean",
          },
        },
        {
          name: "crossPlaneLinks",
          type: "object",
          required: true,
          description: "跨平面桥接策略，none 表示隔离平面，paired 表示每个 group 内 A/B 成对互联。",
          itemShape: {
            mode: "none | paired",
          },
        },
        dataRateParam(),
      ],
      example: {
        planes: [{ id: "A" }, { id: "B" }],
        switches: [
          { id: "sw1", plane: "A", groupId: "g1" },
          { id: "sw2", plane: "B", groupId: "g1" },
          { id: "sw3", plane: "A", groupId: "g2" },
          { id: "sw4", plane: "B", groupId: "g2" },
        ],
        switchGroups: [
          { id: "g1", planeSwitches: { A: "sw1", B: "sw2" } },
          { id: "g2", planeSwitches: { A: "sw3", B: "sw4" } },
        ],
        endSystems: [
          { id: "es1-1", groupId: "g1", attachment: { primary: { switchId: "sw1", plane: "A" }, backup: { switchId: "sw2", plane: "B" } } },
          { id: "es1-2", groupId: "g1", attachment: { primary: { switchId: "sw1", plane: "A" }, backup: { switchId: "sw2", plane: "B" } } },
          { id: "es2-1", groupId: "g2", attachment: { primary: { switchId: "sw3", plane: "A" }, backup: { switchId: "sw4", plane: "B" } } },
          { id: "es2-2", groupId: "g2", attachment: { primary: { switchId: "sw3", plane: "A" }, backup: { switchId: "sw4", plane: "B" } } },
        ],
        backbone: { mode: "line", withinPlane: true },
        crossPlaneLinks: { mode: "none" },
        dataRateMbps: 1_000,
      },
    },
  ];

  return {
    summary: {
      templateCount: templates.length,
      templateIds: templates.map((template) => template.id),
      templates,
    },
    templates,
  };
}

export function findTemplate(templateId: string): TopologyTemplateDescription | undefined {
  return describeTemplates().templates.find((template) => template.id === templateId);
}

function genericDistributedParams(): TopologyTemplateParam[] {
  return [
    {
      name: "switchCount",
      type: "integer",
      default: 4,
      minimum: 1,
      maximum: 12,
      description: "交换机数量。",
    },
    {
      name: "endSystemsPerSwitch",
      type: "integer",
      default: 2,
      minimum: 1,
      maximum: 24,
      description: "每台交换机接入的端系统数量。",
    },
    dataRateParam(),
  ];
}

function dataRateParam(): TopologyTemplateParam {
  return {
    name: "dataRateMbps",
    type: "enum",
    default: 1_000,
    values: [...SUPPORTED_DATA_RATES_MBPS],
    description: "链路速率，单位 Mbps。",
  };
}
