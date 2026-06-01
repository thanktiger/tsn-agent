import {
  INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
  createPorts,
  deriveMacAddress,
  type IntermediateLink,
  type IntermediateNode,
  type IntermediateTopology,
  type TopologyTemplateId,
} from "./intermediate";
import { SUPPORTED_DATA_RATES_MBPS, findTemplate } from "./templates";
import { failResult, okResult, topologyError, type TopologyResponseMode, type TopologyToolResult } from "./tool-result";
import { validateIntermediateTopology } from "./validate";

export interface TopologyInitIntent {
  templateId: TopologyTemplateId | string;
  params?: Record<string, unknown>;
  responseMode?: TopologyResponseMode;
}

export type TopologyTemplateParams = GenericDistributedParams | DualPlaneRedundantParams;

export interface GenericDistributedParams {
    switchCount?: number;
    endSystemsPerSwitch?: number;
    dataRateMbps?: number;
}

export type DualPlaneId = "A" | "B";

export interface DualPlaneSwitchParam {
  id: string;
  name?: string;
  plane: DualPlaneId;
  groupId: string;
  role?: "access";
  portCount?: number;
}

export interface DualPlaneSwitchGroupParam {
  id: string;
  name?: string;
  planeSwitches: Record<DualPlaneId, string>;
}

export interface DualPlaneAttachmentEndpoint {
  switchId: string;
  plane: DualPlaneId;
}

export interface DualPlaneEndSystemParam {
  id: string;
  name?: string;
  groupId: string;
  attachment: {
    primary: DualPlaneAttachmentEndpoint;
    backup: DualPlaneAttachmentEndpoint;
  };
}

export interface DualPlaneRedundantParams {
  dataRateMbps?: number;
  planes: Array<{ id: DualPlaneId; name?: string }>;
  switches: DualPlaneSwitchParam[];
  switchGroups: DualPlaneSwitchGroupParam[];
  endSystems: DualPlaneEndSystemParam[];
  backbone: {
    mode: "line" | "ring";
    withinPlane: boolean;
  };
  crossPlaneLinks: {
    mode: "none" | "paired";
  };
  allocation?: {
    idPrefix?: {
      switch?: string;
      endSystem?: string;
      link?: string;
    };
    portStrategy?: "first-free";
    layoutStrategy?: "dual-plane-grid";
  };
}

export interface TopologyInitializeSummary {
  templateId: TopologyTemplateId;
  nodeCount: number;
  linkCount: number;
  switchCount: number;
  endSystemCount: number;
  serverCount: number;
}

export interface TopologyInitializeFull {
  topology: IntermediateTopology;
}

export function initializeTopology(
  intent: TopologyInitIntent,
): TopologyToolResult<TopologyInitializeSummary, TopologyInitializeFull> {
  const responseMode = intent.responseMode ?? "summary";
  const template = findTemplate(intent.templateId);

  if (!template) {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "UNKNOWN_TEMPLATE_ID",
          message: `Unknown topology templateId: ${String(intent.templateId)}`,
          path: "$.templateId",
          requiresUserClarification: true,
        }),
      ],
    });
  }

  const dataRateResult = normalizeDataRate(getRecord(intent.params)?.dataRateMbps);
  if (!dataRateResult.ok) {
    return failResult({ responseMode, errors: [dataRateResult.error] });
  }

  let topology: IntermediateTopology;
  if (intent.templateId === "dual-plane-redundant") {
    const paramsResult = normalizeDualPlaneParams(intent.params);
    if (!paramsResult.ok) {
      return failResult({ responseMode, errors: paramsResult.errors });
    }

    topology = createDualPlaneRedundantTopology(paramsResult.value, dataRateResult.value);
  } else if (intent.templateId === "generic-line" || intent.templateId === "generic-ring") {
    const genericParams = getRecord(intent.params) ?? {};
    const switchCount = normalizeIntegerParam(genericParams.switchCount, 4, 1, 12, "$.params.switchCount");
    if (!switchCount.ok) {
      return failResult({ responseMode, errors: [switchCount.error] });
    }

    const endSystemsPerSwitch = normalizeIntegerParam(
      genericParams.endSystemsPerSwitch,
      2,
      1,
      24,
      "$.params.endSystemsPerSwitch",
    );
    if (!endSystemsPerSwitch.ok) {
      return failResult({ responseMode, errors: [endSystemsPerSwitch.error] });
    }

    topology = createGenericDistributedTopology({
      templateId: intent.templateId,
      switchCount: switchCount.value,
      endSystemsPerSwitch: endSystemsPerSwitch.value,
      dataRateMbps: dataRateResult.value,
    });
  } else {
    return failResult({
      responseMode,
      errors: [
        topologyError({
          code: "UNKNOWN_TEMPLATE_ID",
          message: `Unknown topology templateId: ${String(intent.templateId)}`,
          path: "$.templateId",
          requiresUserClarification: true,
        }),
      ],
    });
  }

  const validation = validateIntermediateTopology(topology);
  if (!validation.ok) {
    return failResult({ responseMode, errors: validation.errors, warnings: validation.warnings });
  }

  return okResult({
    responseMode,
    summary: {
      templateId: intent.templateId,
      nodeCount: topology.nodes.length,
      linkCount: topology.links.length,
      switchCount: topology.nodes.filter((node) => node.type === "switch").length,
      endSystemCount: topology.nodes.filter((node) => node.type === "endSystem").length,
      serverCount: topology.nodes.filter((node) => node.type === "server").length,
    },
    full: { topology },
    warnings: validation.warnings,
  });
}

function createGenericDistributedTopology(input: {
  templateId: "generic-line" | "generic-ring";
  switchCount: number;
  endSystemsPerSwitch: number;
  dataRateMbps: number;
}): IntermediateTopology {
  const nodes: IntermediateNode[] = [];
  const links: IntermediateLink[] = [];
  const switchIds: string[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;

  for (let switchIndex = 1; switchIndex <= input.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;
    const switchX = 80 + 300 * (switchIndex - 1);
    switchIds.push(switchId);
    nodes.push({
      id: switchId,
      numericId: numericNodeId,
      name: `SW-${switchIndex}`,
      type: "switch",
      ports: createPorts(input.endSystemsPerSwitch + 2),
      position: { x: switchX, y: 220 },
    });
    numericNodeId += 1;
  }

  for (let switchIndex = 1; switchIndex <= input.switchCount; switchIndex += 1) {
    const switchId = `sw${switchIndex}`;

    for (let hostIndex = 1; hostIndex <= input.endSystemsPerSwitch; hostIndex += 1) {
      const hostId = `es${switchIndex}-${hostIndex}`;
      const hostOrdinal = (switchIndex - 1) * input.endSystemsPerSwitch + hostIndex;
      const switchX = 80 + 300 * (switchIndex - 1);
      const yOffset = hostIndex % 2 === 0 ? 390 : 70;
      const xJitter = (hostIndex - Math.ceil(input.endSystemsPerSwitch / 2)) * 62;

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
        macAddress: deriveMacAddress(hostOrdinal),
        ipAddress: `10.0.${switchIndex}.${hostIndex}`,
      });
      numericNodeId += 1;

      links.push(createLink({
        numericId: numericLinkId,
        sourceNodeId: hostId,
        sourcePortId: "p1",
        targetNodeId: switchId,
        targetPortId: `p${hostIndex}`,
        dataRateMbps: input.dataRateMbps,
      }));
      numericLinkId += 1;
    }
  }

  const switchInterconnectPortOffset = input.endSystemsPerSwitch;
  for (let index = 0; index < switchIds.length - 1; index += 1) {
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId: switchIds[index],
      sourcePortId: `p${switchInterconnectPortOffset + 1}`,
      targetNodeId: switchIds[index + 1],
      targetPortId: `p${switchInterconnectPortOffset + 2}`,
      dataRateMbps: input.dataRateMbps,
    }));
    numericLinkId += 1;
  }

  if (input.templateId === "generic-ring" && switchIds.length > 2) {
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId: switchIds[switchIds.length - 1],
      sourcePortId: `p${switchInterconnectPortOffset + 1}`,
      targetNodeId: switchIds[0],
      targetPortId: `p${switchInterconnectPortOffset + 2}`,
      dataRateMbps: input.dataRateMbps,
    }));
  }

  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      templateId: input.templateId,
      templateParams: {
        switchCount: input.switchCount,
        endSystemsPerSwitch: input.endSystemsPerSwitch,
        dataRateMbps: input.dataRateMbps,
      },
      layout: input.templateId === "generic-ring" ? "ring" : "line",
      source: "template",
    },
    nodes,
    links,
    diagnostics: [],
  };
}

function normalizeDualPlaneParams(
  params: unknown,
): { ok: true; value: DualPlaneRedundantParams } | { ok: false; errors: ReturnType<typeof topologyError>[] } {
  const record = getRecord(params);
  const errors: ReturnType<typeof topologyError>[] = [];

  if (!record) {
    return {
      ok: false,
      errors: [
        topologyError({
          code: "INVALID_TEMPLATE_PARAM",
          message: "$.params must be an object for dual-plane-redundant.",
          path: "$.params",
          requiresUserClarification: true,
        }),
      ],
    };
  }

  const rejectedFields = ["switchCount", "endSystemsPerSwitch", "endSystemCount"].filter((field) => field in record);
  if (rejectedFields.length > 0) {
    errors.push(topologyError({
      code: "INVALID_TEMPLATE_PARAM",
      message: "dual-plane-redundant requires explicit switches, switchGroups and endSystems; shortcut count params are not accepted.",
      path: "$.params",
      details: { rejectedFields },
      requiresUserClarification: true,
    }));
  }

  const planes = normalizePlanes(record.planes, errors);
  const switches = normalizeSwitches(record.switches, errors);
  const switchGroups = normalizeSwitchGroups(record.switchGroups, errors);
  const endSystems = normalizeEndSystems(record.endSystems, errors);
  const backbone = normalizeBackbone(record.backbone, errors);
  const crossPlaneLinks = normalizeCrossPlaneLinks(record.crossPlaneLinks, errors);

  validateDualPlaneReferences(switches, switchGroups, endSystems, backbone, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      dataRateMbps: typeof record.dataRateMbps === "number" ? record.dataRateMbps : undefined,
      planes,
      switches,
      switchGroups,
      endSystems,
      backbone,
      crossPlaneLinks,
      allocation: normalizeAllocation(record.allocation),
    },
  };
}

function createDualPlaneRedundantTopology(params: DualPlaneRedundantParams, dataRateMbps: number): IntermediateTopology {
  const nodes: IntermediateNode[] = [];
  const links: IntermediateLink[] = [];
  let numericNodeId = 0;
  let numericLinkId = 0;
  const linkKeys = new Set<string>();
  const portUsage = calculateDualPlanePortUsage(params);
  const nextSwitchPortById = new Map(params.switches.map((candidate) => [candidate.id, 1]));

  const addLink = (sourceNodeId: string, sourcePortId: string, targetNodeId: string, targetPortId: string): void => {
    const linkKey = [sourceNodeId, targetNodeId].sort().join("--");
    if (linkKeys.has(linkKey)) {
      return;
    }

    linkKeys.add(linkKey);
    links.push(createLink({
      numericId: numericLinkId,
      sourceNodeId,
      sourcePortId,
      targetNodeId,
      targetPortId,
      dataRateMbps,
    }));
    numericLinkId += 1;
  };

  const takeSwitchPort = (switchId: string): string => {
    const nextPort = nextSwitchPortById.get(switchId) ?? 1;
    nextSwitchPortById.set(switchId, nextPort + 1);
    return `p${nextPort}`;
  };

  for (const group of params.switchGroups) {
    const groupIndex = params.switchGroups.indexOf(group);
    for (const plane of ["A", "B"] as const) {
      const switchId = group.planeSwitches[plane];
      const candidate = params.switches.find((current) => current.id === switchId);
      if (!candidate) {
        continue;
      }

      const requiredPorts = portUsage.get(candidate.id) ?? 0;
      const portCount = Math.max(candidate.portCount ?? 0, requiredPorts, 1);
      nodes.push({
        id: candidate.id,
        numericId: numericNodeId,
        name: candidate.name ?? `SW-${candidate.id.replace(/^sw/i, "")}`,
        type: "switch",
        ports: createPorts(portCount),
        position: {
          x: 220 + groupIndex * 320,
          y: candidate.plane === "A" ? 140 : 360,
        },
      });
      numericNodeId += 1;
    }
  }

  for (const endSystem of params.endSystems) {
    const groupIndex = Math.max(0, params.switchGroups.findIndex((group) => group.id === endSystem.groupId));
    const groupEndSystems = params.endSystems.filter((candidate) => candidate.groupId === endSystem.groupId);
    const indexInGroup = Math.max(0, groupEndSystems.findIndex((candidate) => candidate.id === endSystem.id));

    nodes.push({
      id: endSystem.id,
      numericId: numericNodeId,
      name: endSystem.name ?? `ES-${endSystem.id.replace(/^es/i, "")}`,
      type: "endSystem",
      ports: createPorts(2),
      position: {
        x: 220 + groupIndex * 320 + (indexInGroup % 2 === 0 ? -96 : 96),
        y: indexInGroup < 2 ? 40 : 460 + (Math.floor(indexInGroup / 2) - 1) * 84,
      },
      macAddress: deriveMacAddress(numericNodeId + 1),
      ipAddress: `10.0.${groupIndex + 1}.${indexInGroup + 1}`,
    });
    numericNodeId += 1;
  }

  for (const endSystem of params.endSystems) {
    addLink(endSystem.id, "p1", endSystem.attachment.primary.switchId, takeSwitchPort(endSystem.attachment.primary.switchId));
    addLink(endSystem.id, "p2", endSystem.attachment.backup.switchId, takeSwitchPort(endSystem.attachment.backup.switchId));
  }

  for (const plane of ["A", "B"] as const) {
    const planeSwitchIds = params.switchGroups.map((group) => group.planeSwitches[plane]);
    for (let index = 0; index < planeSwitchIds.length - 1; index += 1) {
      addLink(
        planeSwitchIds[index],
        takeSwitchPort(planeSwitchIds[index]),
        planeSwitchIds[index + 1],
        takeSwitchPort(planeSwitchIds[index + 1]),
      );
    }

    if (params.backbone.mode === "ring" && planeSwitchIds.length >= 3) {
      addLink(
        planeSwitchIds[planeSwitchIds.length - 1],
        takeSwitchPort(planeSwitchIds[planeSwitchIds.length - 1]),
        planeSwitchIds[0],
        takeSwitchPort(planeSwitchIds[0]),
      );
    }
  }

  if (params.crossPlaneLinks.mode === "paired") {
    for (const group of params.switchGroups) {
      addLink(
        group.planeSwitches.A,
        takeSwitchPort(group.planeSwitches.A),
        group.planeSwitches.B,
        takeSwitchPort(group.planeSwitches.B),
      );
    }
  }

  return {
    schemaVersion: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
    metadata: {
      templateId: "dual-plane-redundant",
      templateParams: {
        ...params,
        dataRateMbps,
      },
      layout: "dual-plane",
      source: "template",
    },
    nodes,
    links,
    diagnostics: [],
  };
}

function createLink(input: {
  numericId: number;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  dataRateMbps: number;
}): IntermediateLink {
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

function normalizePlanes(value: unknown, errors: ReturnType<typeof topologyError>[]): Array<{ id: DualPlaneId; name?: string }> {
  if (!Array.isArray(value) || value.length !== 2) {
    errors.push(invalidParam("$.params.planes", "planes must contain exactly A and B."));
    return [];
  }

  const planes = value
    .map((item) => getRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: item.id,
      name: typeof item.name === "string" ? item.name : undefined,
    }));

  const ids = planes.map((plane) => plane.id);
  if (!ids.includes("A") || !ids.includes("B") || ids.some((id) => id !== "A" && id !== "B")) {
    errors.push(invalidParam("$.params.planes", "planes must be [{ id: 'A' }, { id: 'B' }] in any order."));
    return [];
  }

  return planes as Array<{ id: DualPlaneId; name?: string }>;
}

function normalizeSwitches(value: unknown, errors: ReturnType<typeof topologyError>[]): DualPlaneSwitchParam[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(invalidParam("$.params.switches", "switches must be a non-empty array."));
    return [];
  }

  return value.flatMap((item, index): DualPlaneSwitchParam[] => {
    const record = getRecord(item);
    const path = `$.params.switches[${index}]`;
    if (!record) {
      errors.push(invalidParam(path, "switch must be an object."));
      return [];
    }

    const id = normalizeString(record.id);
    const plane = normalizePlaneId(record.plane);
    const groupId = normalizeString(record.groupId);
    if (!id) {
      errors.push(invalidParam(`${path}.id`, "switch id is required."));
    }
    if (!plane) {
      errors.push(invalidParam(`${path}.plane`, "switch plane must be A or B."));
    }
    if (!groupId) {
      errors.push(invalidParam(`${path}.groupId`, "switch groupId is required."));
    }

    const portCount = record.portCount === undefined ? undefined : Number(record.portCount);
    if (portCount !== undefined && (!Number.isInteger(portCount) || portCount < 1)) {
      errors.push(invalidParam(`${path}.portCount`, "switch portCount must be a positive integer."));
    }

    if (!id || !plane || !groupId) {
      return [];
    }

    return [{
      id,
      name: normalizeString(record.name),
      plane,
      groupId,
      role: record.role === "access" ? "access" : undefined,
      portCount,
    }];
  });
}

function normalizeSwitchGroups(value: unknown, errors: ReturnType<typeof topologyError>[]): DualPlaneSwitchGroupParam[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(invalidParam("$.params.switchGroups", "switchGroups must be a non-empty array."));
    return [];
  }

  return value.flatMap((item, index): DualPlaneSwitchGroupParam[] => {
    const record = getRecord(item);
    const path = `$.params.switchGroups[${index}]`;
    if (!record) {
      errors.push(invalidParam(path, "switchGroup must be an object."));
      return [];
    }

    const planeSwitches = getRecord(record.planeSwitches);
    const id = normalizeString(record.id);
    const aSwitchId = normalizeString(planeSwitches?.A);
    const bSwitchId = normalizeString(planeSwitches?.B);
    if (!id) {
      errors.push(invalidParam(`${path}.id`, "switchGroup id is required."));
    }
    if (!aSwitchId || !bSwitchId) {
      errors.push(invalidParam(`${path}.planeSwitches`, "switchGroup must reference A and B switches."));
    }

    if (!id || !aSwitchId || !bSwitchId) {
      return [];
    }

    return [{
      id,
      name: normalizeString(record.name),
      planeSwitches: { A: aSwitchId, B: bSwitchId },
    }];
  });
}

function normalizeEndSystems(value: unknown, errors: ReturnType<typeof topologyError>[]): DualPlaneEndSystemParam[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(invalidParam("$.params.endSystems", "endSystems must be a non-empty array."));
    return [];
  }

  return value.flatMap((item, index): DualPlaneEndSystemParam[] => {
    const record = getRecord(item);
    const path = `$.params.endSystems[${index}]`;
    if (!record) {
      errors.push(invalidParam(path, "endSystem must be an object."));
      return [];
    }

    const attachment = getRecord(record.attachment);
    const primary = normalizeAttachmentEndpoint(attachment?.primary, `${path}.attachment.primary`, errors);
    const backup = normalizeAttachmentEndpoint(attachment?.backup, `${path}.attachment.backup`, errors);
    const id = normalizeString(record.id);
    const groupId = normalizeString(record.groupId);
    if (!id) {
      errors.push(invalidParam(`${path}.id`, "endSystem id is required."));
    }
    if (!groupId) {
      errors.push(invalidParam(`${path}.groupId`, "endSystem groupId is required."));
    }

    if (!id || !groupId || !primary || !backup) {
      return [];
    }

    return [{
      id,
      name: normalizeString(record.name),
      groupId,
      attachment: { primary, backup },
    }];
  });
}

function normalizeBackbone(value: unknown, errors: ReturnType<typeof topologyError>[]): DualPlaneRedundantParams["backbone"] {
  const record = getRecord(value);
  if (!record) {
    errors.push(invalidParam("$.params.backbone", "backbone is required."));
    return { mode: "line", withinPlane: true };
  }

  const mode = record.mode === "line" || record.mode === "ring" ? record.mode : undefined;
  if (!mode) {
    errors.push(invalidParam("$.params.backbone.mode", "backbone.mode must be line or ring."));
  }
  if (record.withinPlane !== true) {
    errors.push(invalidParam("$.params.backbone.withinPlane", "P0 requires backbone.withinPlane = true."));
  }

  return { mode: mode ?? "line", withinPlane: true };
}

function normalizeCrossPlaneLinks(value: unknown, errors: ReturnType<typeof topologyError>[]): DualPlaneRedundantParams["crossPlaneLinks"] {
  const record = getRecord(value);
  if (!record) {
    errors.push(invalidParam("$.params.crossPlaneLinks", "crossPlaneLinks is required."));
    return { mode: "none" };
  }

  if (record.mode !== "none" && record.mode !== "paired") {
    errors.push(invalidParam("$.params.crossPlaneLinks.mode", "crossPlaneLinks.mode must be none or paired."));
    return { mode: "none" };
  }

  return { mode: record.mode };
}

function normalizeAllocation(value: unknown): DualPlaneRedundantParams["allocation"] {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    portStrategy: record.portStrategy === "first-free" ? "first-free" : undefined,
    layoutStrategy: record.layoutStrategy === "dual-plane-grid" ? "dual-plane-grid" : undefined,
    idPrefix: getRecord(record.idPrefix) ? {
      switch: normalizeString(getRecord(record.idPrefix)?.switch),
      endSystem: normalizeString(getRecord(record.idPrefix)?.endSystem),
      link: normalizeString(getRecord(record.idPrefix)?.link),
    } : undefined,
  };
}

function normalizeAttachmentEndpoint(
  value: unknown,
  path: string,
  errors: ReturnType<typeof topologyError>[],
): DualPlaneAttachmentEndpoint | undefined {
  const record = getRecord(value);
  if (!record) {
    errors.push(invalidParam(path, "attachment endpoint is required."));
    return undefined;
  }

  const switchId = normalizeString(record.switchId);
  const plane = normalizePlaneId(record.plane);
  if (!switchId) {
    errors.push(invalidParam(`${path}.switchId`, "attachment switchId is required."));
  }
  if (!plane) {
    errors.push(invalidParam(`${path}.plane`, "attachment plane must be A or B."));
  }

  return switchId && plane ? { switchId, plane } : undefined;
}

function validateDualPlaneReferences(
  switches: DualPlaneSwitchParam[],
  switchGroups: DualPlaneSwitchGroupParam[],
  endSystems: DualPlaneEndSystemParam[],
  backbone: DualPlaneRedundantParams["backbone"],
  errors: ReturnType<typeof topologyError>[],
): void {
  const switchIds = new Set<string>();
  const groupIds = new Set<string>();
  const endSystemIds = new Set<string>();
  const switchesById = new Map<string, DualPlaneSwitchParam>();
  const groupsById = new Map<string, DualPlaneSwitchGroupParam>();

  for (const candidate of switches) {
    if (switchIds.has(candidate.id)) {
      errors.push(invalidParam("$.params.switches", `duplicate switch id: ${candidate.id}`));
    }
    switchIds.add(candidate.id);
    switchesById.set(candidate.id, candidate);
  }

  for (const group of switchGroups) {
    if (groupIds.has(group.id)) {
      errors.push(invalidParam("$.params.switchGroups", `duplicate switchGroup id: ${group.id}`));
    }
    groupIds.add(group.id);
    groupsById.set(group.id, group);

    for (const plane of ["A", "B"] as const) {
      const switchId = group.planeSwitches[plane];
      const switchNode = switchesById.get(switchId);
      if (!switchNode) {
        errors.push(invalidParam(`$.params.switchGroups.${group.id}.planeSwitches.${plane}`, `switch does not exist: ${switchId}`));
      } else if (switchNode.plane !== plane || switchNode.groupId !== group.id) {
        errors.push(invalidParam(
          `$.params.switchGroups.${group.id}.planeSwitches.${plane}`,
          `switch ${switchId} must be in plane ${plane} and group ${group.id}.`,
        ));
      }
    }
  }

  for (const endSystem of endSystems) {
    if (endSystemIds.has(endSystem.id)) {
      errors.push(invalidParam("$.params.endSystems", `duplicate endSystem id: ${endSystem.id}`));
    }
    endSystemIds.add(endSystem.id);

    const group = groupsById.get(endSystem.groupId);
    if (!group) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.groupId`, `switchGroup does not exist: ${endSystem.groupId}`));
      continue;
    }

    const primarySwitch = switchesById.get(endSystem.attachment.primary.switchId);
    const backupSwitch = switchesById.get(endSystem.attachment.backup.switchId);
    if (!primarySwitch) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment.primary.switchId`, `switch does not exist: ${endSystem.attachment.primary.switchId}`));
    }
    if (!backupSwitch) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment.backup.switchId`, `switch does not exist: ${endSystem.attachment.backup.switchId}`));
    }
    if (primarySwitch && primarySwitch.plane !== endSystem.attachment.primary.plane) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment.primary.plane`, "primary plane must match referenced switch plane."));
    }
    if (backupSwitch && backupSwitch.plane !== endSystem.attachment.backup.plane) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment.backup.plane`, "backup plane must match referenced switch plane."));
    }
    if (primarySwitch && backupSwitch && primarySwitch.plane === backupSwitch.plane) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment`, "primary and backup attachments must cross A/B planes."));
    }
    if (primarySwitch && backupSwitch && (primarySwitch.groupId !== group.id || backupSwitch.groupId !== group.id)) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment`, "attachments must reference switches in the endSystem group."));
    }
    if (
      endSystem.attachment.primary.switchId !== group.planeSwitches[endSystem.attachment.primary.plane]
      || endSystem.attachment.backup.switchId !== group.planeSwitches[endSystem.attachment.backup.plane]
    ) {
      errors.push(invalidParam(`$.params.endSystems.${endSystem.id}.attachment`, "attachments must use the group's A/B switches."));
    }
  }

  if (backbone.mode === "ring" && switchGroups.length < 3) {
    errors.push(invalidParam("$.params.backbone.mode", "ring backbone requires at least 3 switchGroups."));
  }
}

function calculateDualPlanePortUsage(params: DualPlaneRedundantParams): Map<string, number> {
  const usage = new Map(params.switches.map((candidate) => [candidate.id, 0]));
  const increment = (switchId: string): void => {
    usage.set(switchId, (usage.get(switchId) ?? 0) + 1);
  };

  for (const endSystem of params.endSystems) {
    increment(endSystem.attachment.primary.switchId);
    increment(endSystem.attachment.backup.switchId);
  }

  for (const plane of ["A", "B"] as const) {
    const planeSwitchIds = params.switchGroups.map((group) => group.planeSwitches[plane]);
    for (let index = 0; index < planeSwitchIds.length - 1; index += 1) {
      increment(planeSwitchIds[index]);
      increment(planeSwitchIds[index + 1]);
    }
    if (params.backbone.mode === "ring" && planeSwitchIds.length >= 3) {
      increment(planeSwitchIds[planeSwitchIds.length - 1]);
      increment(planeSwitchIds[0]);
    }
  }

  if (params.crossPlaneLinks.mode === "paired") {
    for (const group of params.switchGroups) {
      increment(group.planeSwitches.A);
      increment(group.planeSwitches.B);
    }
  }

  return usage;
}

function invalidParam(path: string, message: string): ReturnType<typeof topologyError> {
  return topologyError({
    code: "INVALID_TEMPLATE_PARAM",
    message,
    path,
    requiresUserClarification: true,
  });
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizePlaneId(value: unknown): DualPlaneId | undefined {
  return value === "A" || value === "B" ? value : undefined;
}

function normalizeIntegerParam(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
  path: string,
): { ok: true; value: number } | { ok: false; error: ReturnType<typeof topologyError> } {
  const normalized = value === undefined ? defaultValue : Number(value);

  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    return {
      ok: false,
      error: topologyError({
        code: "INVALID_TEMPLATE_PARAM",
        message: `${path} must be an integer in [${minimum}, ${maximum}].`,
        path,
        details: {
          minimum,
          maximum,
          actual: String(value),
        },
        requiresUserClarification: true,
      }),
    };
  }

  return { ok: true, value: normalized };
}

function normalizeDataRate(value: unknown): { ok: true; value: number } | { ok: false; error: ReturnType<typeof topologyError> } {
  const normalized = value === undefined ? 1_000 : Number(value);

  if (!SUPPORTED_DATA_RATES_MBPS.some((candidate) => candidate === normalized)) {
    return {
      ok: false,
      error: topologyError({
        code: "INVALID_TEMPLATE_PARAM",
        message: `$.params.dataRateMbps must be one of ${SUPPORTED_DATA_RATES_MBPS.join(", ")}.`,
        path: "$.params.dataRateMbps",
        details: {
          allowed: [...SUPPORTED_DATA_RATES_MBPS],
          actual: String(value),
        },
        requiresUserClarification: true,
      }),
    };
  }

  return { ok: true, value: normalized };
}
