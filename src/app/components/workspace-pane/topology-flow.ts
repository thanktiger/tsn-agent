import type { Edge, Node } from "@xyflow/react";
import type {
  TopologyLinkRow,
  TopologyNodeRow,
  TopologyRowSnapshot,
} from "../../../sessions/topology-snapshot";

/**
 * Plan 2026-06-11-001：DB 快照 → React Flow 的纯函数映射层。
 * 节点 x/y 的权威在数据库（生成端写入 + 用户拖动经 update_node_position 写回）；
 * 边几何由 TsnFloatingEdge 按节点实时位置动态计算，映射层不再做 handle 选边。
 */

export interface LinkStyleMeta {
  plane?: "A" | "B";
  leftLabel?: string;
  rightLabel?: string;
}

/** R7（origin 2026-06-10）：stylesJson 容错解析——缺失、非法值、解析失败一律回退空 meta，不抛错。 */
export function parseLinkStyles(stylesJson: string): LinkStyleMeta {
  try {
    const parsed: unknown = JSON.parse(stylesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    const meta: LinkStyleMeta = {};
    if (record.plane === "A" || record.plane === "B") {
      meta.plane = record.plane;
    }
    if (typeof record.leftLabel === "string" && record.leftLabel !== "") {
      meta.leftLabel = record.leftLabel;
    }
    if (typeof record.rightLabel === "string" && record.rightLabel !== "") {
      meta.rightLabel = record.rightLabel;
    }
    return meta;
  } catch {
    return {};
  }
}

/** R3：平面配色走 className（CSS 级联保证选中态 --accent 优先），不用 inline stroke。 */
export function planeClassName(plane: LinkStyleMeta["plane"]): string {
  if (plane === "A") {
    return "plane-a";
  }
  if (plane === "B") {
    return "plane-b";
  }
  return "plane-neutral";
}

export interface TsnEdgeData {
  leftLabel?: string;
  rightLabel?: string;
  /** 同节点同方位的端口标签序数；渲染层沿连线向内分层，避免标签重叠。 */
  leftOrd?: number;
  rightOrd?: number;
  /** 同一对节点之间多条边的等分序号；渲染层据此把端点均匀分布在节点边上。 */
  parallelIndex?: number;
  parallelCount?: number;
  /** React Flow Edge.data 的结构性要求；不影响已命名字段的类型推断。 */
  [key: string]: unknown;
}

/** 节点渲染尺寸近似（.tsn-node max-width/实测高）；序数只需初始布局的粗方位。 */
const NODE_W = 126;
const NODE_H = 56;

/** 出射方位：与 rectIntersection 同准则（Δ 按节点宽高归一化，非 45° 分界）。 */
function roughSide(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const nx = (to.x - from.x) / NODE_W;
  const ny = (to.y - from.y) / NODE_H;
  if (Math.abs(nx) >= Math.abs(ny)) {
    return nx >= 0 ? "right" : "left";
  }
  return ny >= 0 ? "bottom" : "top";
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}::${b}` : `${b}::${a}`;
}

export type TsnNodeKind = "switch" | "endSystem" | "controller";

/** DB nodeType（自由字符串）→ 渲染类型 token；未知/缺失回退端系统。 */
export function nodeTypeToken(nodeType: string | null): TsnNodeKind {
  if (nodeType === "switch") {
    return "switch";
  }
  if (nodeType === "controller") {
    return "controller";
  }
  return "endSystem";
}

export function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): {
  nodes: Node[];
  edges: Edge[];
} {
  // 端口标签序数：按 DB 初始坐标统计每个节点每个方位的边数（linkSeq 序确定性）。
  const centers = new Map(
    snapshot.nodes.map((node) => [node.mid, { x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 }]),
  );
  const sideCounter = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const pairCounter = new Map<string, number>();
  const takeOrd = (mid: string, otherMid: string): number => {
    const from = centers.get(mid);
    const to = centers.get(otherMid);
    if (!from || !to) {
      return 0;
    }
    const key = `${mid}:${roughSide(from, to)}`;
    const ord = sideCounter.get(key) ?? 0;
    sideCounter.set(key, ord + 1);
    return ord;
  };
  const takeParallelSlot = (source: string, target: string): { index: number; count: number } => {
    const key = pairKey(source, target);
    const count = pairCounts.get(key) ?? 1;
    const index = pairCounter.get(key) ?? 0;
    pairCounter.set(key, index + 1);
    return { index, count };
  };

  for (const link of snapshot.links) {
    const key = pairKey(link.srcNode, link.dstNode);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  return {
    nodes: snapshot.nodes.map((node) => ({
      id: node.mid,
      type: "tsnNode",
      position: { x: node.x, y: node.y },
      data: {
        label: nodeRowLabel(node),
        nodeType: nodeTypeToken(node.nodeType),
        mid: node.mid,
      },
    })),
    edges: snapshot.links.map((link) => {
      const meta = parseLinkStyles(link.stylesJson);
      const parallelSlot = takeParallelSlot(link.srcNode, link.dstNode);
      const data: TsnEdgeData = {
        leftLabel: meta.leftLabel,
        rightLabel: meta.rightLabel,
        // 仅有标签的端点占用层级槽位，无标签端不推远后续标签。
        leftOrd: meta.leftLabel ? takeOrd(link.srcNode, link.dstNode) : 0,
        rightOrd: meta.rightLabel ? takeOrd(link.dstNode, link.srcNode) : 0,
        parallelIndex: parallelSlot.index,
        parallelCount: parallelSlot.count,
      };
      return {
        id: linkRowId(link),
        source: link.srcNode,
        target: link.dstNode,
        type: "tsnFloating",
        className: planeClassName(meta.plane),
        data,
      };
    }),
  };
}

import type { TimesyncNodeRole } from "../../../sessions/timesync-snapshot";

/** time-sync 阶段画布注入到 React Flow 节点 data 的时钟树角色（拓扑阶段为 undefined）。 */
export interface TsnNodeTimesync {
  role: TimesyncNodeRole;
  masterCount: number;
  slaveCount: number;
  isGm: boolean;
}

/** 时钟树角色 → 节点徽标短文（画布上 GM/被同步/旁路/未覆盖一目了然）。 */
export function timesyncRoleBadge(role: TimesyncNodeRole): string {
  switch (role) {
    case "gm":
      return "GM";
    case "synced":
      return "同步";
    case "passive":
      return "旁路";
    default:
      return "未覆盖";
  }
}

const NODE_KIND_PREFIX: Record<TsnNodeKind, string> = {
  switch: "SW",
  endSystem: "ES",
  controller: "CTRL",
};

/** 画布标签：优先逻辑名（与 agent 对话命名一致），缺失回退「前缀-同步名」派生。 */
export function nodeRowLabel(node: TopologyNodeRow): string {
  if (node.name) {
    return node.name;
  }

  return `${NODE_KIND_PREFIX[nodeTypeToken(node.nodeType)]}-${node.mid}`;
}

export function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}
