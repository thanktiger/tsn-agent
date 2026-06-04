/**
 * @deprecated Phase B (plan v3 U9b 范围)：GCL 流量导出在 P0 暂下线，boss P1 重建。
 * Phase B-α 仅打标；完整删除是 Phase B 后续 PR。
 */
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import type { PlannerResultSnapshot } from "../planner/planner-contract";

export interface InetPlannerGclDocument {
  schemaVersion: "tsn-agent.inet-gcl.v0";
  planId: string;
  generatedAt: string;
  sourceArtifact: "planner/flow_plan_result_1.json";
  links: InetPlannerGclLink[];
  unresolved: {
    linkIds: number[];
    streamIds: number[];
  };
  warnings: string[];
}

export interface InetPlannerGclLink {
  linkId: number;
  canonicalLinkId?: string;
  source?: string;
  target?: string;
  gclEntries: InetPlannerGclEntry[];
}

export interface InetPlannerGclEntry {
  interval: unknown;
  state: unknown;
  streamId?: number;
  flowId?: string;
  flowName?: string;
}

interface GclExportResult {
  document: InetPlannerGclDocument;
  json: string;
  notes: string;
}

export function exportInetPlannerGcl(
  project: CanonicalTsnProjectV0,
  snapshot: PlannerResultSnapshot,
): GclExportResult {
  const warnings: string[] = [];
  const solutionEntries = readSolutionEntries(snapshot.sourceOutputs.solution_json, warnings);
  const unresolvedLinkIds = new Set<number>();
  const unresolvedStreamIds = new Set<number>();
  const links = solutionEntries.map((entry) => {
    const linkId = readNumber(entry, "link_id");
    const canonicalLink = linkId === undefined
      ? undefined
      : project.topology.links.find((candidate) => candidate.numericId === linkId);

    if (linkId !== undefined && !canonicalLink) {
      unresolvedLinkIds.add(linkId);
    }

    const gclEntries = readGclEntries(entry).map((gclEntry) => {
      const streamId = readNumber(gclEntry, "stream_id");
      const flow = streamId === undefined
        ? undefined
        : project.flows.find((candidate) => candidate.numericId === streamId);

      if (streamId !== undefined && !flow) {
        unresolvedStreamIds.add(streamId);
      }

      return {
        interval: readUnknown(gclEntry, "interval"),
        state: readUnknown(gclEntry, "state"),
        streamId,
        flowId: flow?.id,
        flowName: flow?.name,
      };
    });

    return {
      linkId: linkId ?? -1,
      canonicalLinkId: canonicalLink?.id,
      source: canonicalLink ? `${canonicalLink.source.nodeId}.${canonicalLink.source.portId}` : undefined,
      target: canonicalLink ? `${canonicalLink.target.nodeId}.${canonicalLink.target.portId}` : undefined,
      gclEntries,
    };
  });

  const document: InetPlannerGclDocument = {
    schemaVersion: "tsn-agent.inet-gcl.v0",
    planId: snapshot.planId,
    generatedAt: new Date().toISOString(),
    sourceArtifact: "planner/flow_plan_result_1.json",
    links,
    unresolved: {
      linkIds: [...unresolvedLinkIds],
      streamIds: [...unresolvedStreamIds],
    },
    warnings,
  };

  return {
    document,
    json: JSON.stringify(document, null, 2),
    notes: exportInetPlannerGclNotes(document),
  };
}

function exportInetPlannerGclNotes(document: InetPlannerGclDocument): string {
  const gclEntryCount = document.links.reduce((sum, link) => sum + link.gclEntries.length, 0);
  const lines = [
    "# 规划结果到 INET 的 GCL 中间产物",
    "",
    `- plan id: ${document.planId}`,
    `- source artifact: ${document.sourceArtifact}`,
    `- links: ${document.links.length}`,
    `- gcl entries: ${gclEntryCount}`,
    "",
    "当前 `omnetpp.ini`、`traffic.ini` 和 `network.ned` 仍保持 UDP/INET 基线输出。",
    "`planner-gcl.json` 只保存真实规划结果的可追溯中间数据，尚未声明为可直接运行的 TAS gate schedule。",
    "`interval`、`state` 和硬件寄存器含义保持规划器原始值，单位和 INET gate 参数映射仍需与规划器确认。",
  ];

  if (document.unresolved.linkIds.length > 0) {
    lines.push("", `- unresolved link ids: ${document.unresolved.linkIds.join(", ")}`);
  }

  if (document.unresolved.streamIds.length > 0) {
    lines.push("", `- unresolved stream ids: ${document.unresolved.streamIds.join(", ")}`);
  }

  if (document.warnings.length > 0) {
    lines.push("", "## Warnings", ...document.warnings.map((warning) => `- ${warning}`));
  }

  return `${lines.join("\n")}\n`;
}

function readSolutionEntries(value: unknown, warnings: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (isRecord(value)) {
    warnings.push("solution_json 是 object，当前仅保留可枚举对象值中的 GCL 记录。");
    return Object.values(value).filter(isRecord);
  }

  warnings.push("solution_json 不是 array/object，无法转换 GCL 记录。");
  return [];
}

function readGclEntries(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const entries = value.gcl_entries;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readUnknown(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
