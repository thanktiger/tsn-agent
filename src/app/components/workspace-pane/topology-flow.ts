import { type Edge, type EdgeMarker, MarkerType, type Node } from "@xyflow/react";
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
}

/**
 * R7（origin 2026-06-10）：stylesJson 容错解析——缺失、非法值、解析失败一律回退空 meta，不抛错。
 * U8/KTD1：styles_json 收敛为纯显示（仅 plane/role）；端口标签改读 src_port/dst_port 列，不再读 leftLabel/rightLabel。
 */
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
  /** U8/KTD1：端口号读自 src_port/dst_port 列；src 标在 source 端、dst 标在 target 端。NULL→不渲染。 */
  srcPort?: number;
  dstPort?: number;
  /** time-sync 视图中的同步报文动效方向；普通拓扑阶段不设置。 */
  timesyncPulse?: "forward" | "reverse" | "none";
  timesyncPulseDelaySec?: number;
  timesyncPulseTravelSec?: number;
  timesyncPulseCycleSec?: number;
  /** 同节点同方位的端口标签序数；渲染层沿连线向内分层，避免标签重叠。 */
  srcOrd?: number;
  dstOrd?: number;
  /** 同一对节点之间多条边的等分序号；渲染层据此把端点均匀分布在节点边上。 */
  parallelIndex?: number;
  parallelCount?: number;
  /** 自环（src===dst）：端点重合，渲染层据此给两标签反向小偏移防叠压。 */
  selfLoop?: boolean;
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
      // U8/KTD1：端口标签读列——src_port 在 source 端、dst_port 在 target 端（几何无关）。NULL→不渲染。
      const srcPort = link.srcPort ?? undefined;
      const dstPort = link.dstPort ?? undefined;
      const data: TsnEdgeData = {
        srcPort,
        dstPort,
        // 仅有端口号的端点占用层级槽位，无端口号端不推远后续标签。
        srcOrd: srcPort !== undefined ? takeOrd(link.srcNode, link.dstNode) : 0,
        dstOrd: dstPort !== undefined ? takeOrd(link.dstNode, link.srcNode) : 0,
        parallelIndex: parallelSlot.index,
        parallelCount: parallelSlot.count,
        selfLoop: link.srcNode === link.dstNode,
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

import type { TimesyncNodeRole, TimesyncSnapshot } from "../../../sessions/timesync-snapshot";

/** time-sync 阶段画布注入到 React Flow 节点 data 的时钟树角色（拓扑阶段为 undefined）。 */
export interface TsnNodeTimesync {
  role: TimesyncNodeRole;
  isGm?: boolean;
  arrivalDelaySec?: number;
  pulseCycleSec?: number;
}

/**
 * 时钟树边分类（time-sync 阶段，纯函数）。
 *
 * 树边判定：一端是某节点的 master 端口（朝子）、另一端是子节点的 slave 端口（朝父）。
 * - `tree-master-to-slave`：src 端口 ∈ src.masterPort 且 dst 端口 ∈ dst.slavePort（src=父、dst=子）。
 * - `tree-slave-to-master`：src 端口 ∈ src.slavePort 且 dst 端口 ∈ dst.masterPort（dst=父、src=子）。
 * - `passive`：以上都不成立（两端 passive / 禁用 / 端口缺失 / 无快照）。
 *
 * 方向信息（哪端 master=父）编码在返回值里，渲染层据此画 父→子 的同步报文方向箭头。
 */
export type TimesyncEdgeKind = "tree-master-to-slave" | "tree-slave-to-master" | "passive";

export interface TimesyncPropagationEdge {
  pulse: Exclude<TsnEdgeData["timesyncPulse"], undefined | "none">;
  depth: number;
  delaySec: number;
  travelSec: number;
  cycleSec: number;
}

export interface TimesyncPropagationNode {
  depth: number;
  arrivalDelaySec: number;
  cycleSec: number;
}

export interface TimesyncPropagationPlan {
  edges: Map<string, TimesyncPropagationEdge>;
  nodes: Map<string, TimesyncPropagationNode>;
}

const TIMESYNC_PULSE_TRAVEL_SEC = 1.8;
const TIMESYNC_PULSE_LOOP_PAUSE_SEC = 1.2;
const TIMESYNC_NODE_CONTACT_LEAD_SEC = 0.12;

function roundTimelineSec(value: number): number {
  return Math.round(value * 100) / 100;
}

export function classifyTimesyncEdge(
  link: Pick<TopologyLinkRow, "srcNode" | "dstNode" | "srcPort" | "dstPort">,
  snapshot: TimesyncSnapshot | undefined,
): TimesyncEdgeKind {
  if (!snapshot) {
    return "passive";
  }
  // U8/KTD1：端口配对读 src_port/dst_port 列（两列非 NULL=配对），不再读 styles_json.leftLabel。
  const srcPort = link.srcPort ?? undefined;
  const dstPort = link.dstPort ?? undefined;
  if (srcPort === undefined || dstPort === undefined) {
    return "passive";
  }
  const srcNode = snapshot.nodes.find((node) => node.mid === link.srcNode);
  const dstNode = snapshot.nodes.find((node) => node.mid === link.dstNode);
  if (!srcNode || !dstNode) {
    return "passive";
  }
  if (srcNode.masterPort.includes(srcPort) && dstNode.slavePort.includes(dstPort)) {
    return "tree-master-to-slave";
  }
  if (srcNode.slavePort.includes(srcPort) && dstNode.masterPort.includes(dstPort)) {
    return "tree-slave-to-master";
  }
  return "passive";
}

export function buildTimesyncPropagationPlan(
  links: TopologyLinkRow[],
  snapshot: TimesyncSnapshot | undefined,
): TimesyncPropagationPlan {
  const gmMid = snapshot?.domain?.gmMid ?? null;
  if (!gmMid) {
    return { edges: new Map(), nodes: new Map() };
  }

  type DirectedTreeEdge = {
    link: TopologyLinkRow;
    parent: string;
    child: string;
    pulse: TimesyncPropagationEdge["pulse"];
  };
  const byParent = new Map<string, DirectedTreeEdge[]>();
  const sortedLinks = [...links].sort((left, right) => left.linkSeq - right.linkSeq);
  for (const link of sortedLinks) {
    const kind = classifyTimesyncEdge(link, snapshot);
    if (kind === "tree-master-to-slave") {
      const entries = byParent.get(link.srcNode) ?? [];
      entries.push({ link, parent: link.srcNode, child: link.dstNode, pulse: "forward" });
      byParent.set(link.srcNode, entries);
    } else if (kind === "tree-slave-to-master") {
      const entries = byParent.get(link.dstNode) ?? [];
      entries.push({ link, parent: link.dstNode, child: link.srcNode, pulse: "reverse" });
      byParent.set(link.dstNode, entries);
    }
  }

  const visitedDepth = new Map<string, number>([[gmMid, 0]]);
  const queue = [gmMid];
  const traversed: Array<DirectedTreeEdge & { depth: number }> = [];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    const parentDepth = visitedDepth.get(parent) ?? 0;
    for (const edge of byParent.get(parent) ?? []) {
      if (visitedDepth.has(edge.child)) {
        continue;
      }
      const childDepth = parentDepth + 1;
      visitedDepth.set(edge.child, childDepth);
      queue.push(edge.child);
      traversed.push({ ...edge, depth: parentDepth });
    }
  }

  const maxArrivalDepth = Math.max(0, ...traversed.map((edge) => edge.depth + 1));
  const cycleSec = maxArrivalDepth * TIMESYNC_PULSE_TRAVEL_SEC + TIMESYNC_PULSE_LOOP_PAUSE_SEC;
  const edgePlan = new Map<string, TimesyncPropagationEdge>();
  const nodePlan = new Map<string, TimesyncPropagationNode>();
  for (const edge of traversed) {
    const delaySec = edge.depth * TIMESYNC_PULSE_TRAVEL_SEC;
    edgePlan.set(linkRowId(edge.link), {
      pulse: edge.pulse,
      depth: edge.depth,
      delaySec,
      travelSec: TIMESYNC_PULSE_TRAVEL_SEC,
      cycleSec,
    });
    nodePlan.set(edge.child, {
      depth: edge.depth + 1,
      arrivalDelaySec: roundTimelineSec(
        Math.max(0, delaySec + TIMESYNC_PULSE_TRAVEL_SEC - TIMESYNC_NODE_CONTACT_LEAD_SEC),
      ),
      cycleSec,
    });
  }

  return { edges: edgePlan, nodes: nodePlan };
}

function topologyCenter(nodes: TopologyNodeRow[]): { x: number; y: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + NODE_W);
    maxY = Math.max(maxY, node.y + NODE_H);
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}

export function layoutTimesyncTreeNodes(
  nodes: Node[],
  snapshot: TopologyRowSnapshot,
  snapshotTimesync: TimesyncSnapshot | undefined,
  propagationPlan: TimesyncPropagationPlan,
): Node[] {
  const gmMid = snapshotTimesync?.domain?.gmMid ?? null;
  if (!gmMid || nodes.length === 0 || snapshot.nodes.length === 0) {
    return nodes;
  }

  const rowByMid = new Map(snapshot.nodes.map((node) => [node.mid, node]));
  if (!rowByMid.has(gmMid)) {
    return nodes;
  }

  const depthByMid = new Map<string, number>([[gmMid, 0]]);
  for (const [mid, nodePlan] of propagationPlan.nodes) {
    depthByMid.set(mid, nodePlan.depth);
  }
  const maxTreeDepth = Math.max(0, ...depthByMid.values());
  const fallbackDepth = maxTreeDepth + 1;
  const groups = new Map<number, Node[]>();
  for (const node of nodes) {
    const depth = depthByMid.get(node.id) ?? fallbackDepth;
    const group = groups.get(depth) ?? [];
    group.push(node);
    groups.set(depth, group);
  }

  const center = topologyCenter(snapshot.nodes);
  const depthGap = 150;
  const siblingGap = 180;
  const depthValues = [...groups.keys()].sort((left, right) => left - right);
  const maxDepth = Math.max(...depthValues);
  const startY = center.y - (maxDepth * depthGap) / 2 - NODE_H / 2;
  const rowOrder = new Map(snapshot.nodes.map((node, index) => [node.mid, index]));
  const positioned = new Map<string, Node>();

  for (const depth of depthValues) {
    const group = [...(groups.get(depth) ?? [])].sort(
      (left, right) => (rowOrder.get(left.id) ?? 0) - (rowOrder.get(right.id) ?? 0),
    );
    const width = (group.length - 1) * siblingGap;
    const startX = center.x - width / 2 - NODE_W / 2;
    group.forEach((node, index) => {
      positioned.set(node.id, {
        ...node,
        position: {
          x: Math.round(startX + index * siblingGap),
          y: Math.round(startY + depth * depthGap),
        },
      });
    });
  }

  return nodes.map((node) => positioned.get(node.id) ?? node);
}

/** 父→子方向箭头：报文从 master（父）流向 slave（子），即 GM 往外。 */
const TREE_DIRECTION_MARKER: EdgeMarker = {
  type: MarkerType.ArrowClosed,
  width: 10,
  height: 10,
  color: "#15803d",
};

/** 时钟树边富化：注入 className（树边醒目/非树边淡化）+ 父→子方向箭头。 */
export interface TimesyncEdgeDecoration {
  className: string;
  markerStart?: EdgeMarker;
  markerEnd?: EdgeMarker;
}

export function timesyncEdgeDecoration(kind: TimesyncEdgeKind): TimesyncEdgeDecoration {
  switch (kind) {
    case "tree-master-to-slave":
      // src=父、dst=子：箭头指向 target（dst）。
      return { className: "timesync-tree-edge", markerEnd: TREE_DIRECTION_MARKER };
    case "tree-slave-to-master":
      // dst=父、src=子：箭头指向 source（src）。
      return { className: "timesync-tree-edge", markerStart: TREE_DIRECTION_MARKER };
    default:
      return { className: "timesync-passive-edge" };
  }
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
