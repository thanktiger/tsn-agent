import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import type { TsnEdgeData } from "./topology-flow";

/**
 * Plan 2026-06-11-001 U3：floating 直线边（R1/R4）。
 * 边端点动态吸附两端节点边框上朝向对端的交点（官方 Floating Edges 算法移植），
 * 不锚定固定 handle；拖动节点时连线贴边跟随。两节点中心重合/包含时交点数学
 * 分母为零产 NaN——退化兜底为中心直连，任意坐标下路径有限可渲染。
 */

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingAnchors {
  sx: number;
  sy: number;
  sourcePosition: Position;
  tx: number;
  ty: number;
  targetPosition: Position;
}

const VERTICAL_EDGE_SNAP_THRESHOLD = 32;
const TSN_EDGE_INTERACTION_WIDTH = 48;

/** 节点边框上朝向 target 中心的交点；退化（NaN/Infinity）时回退本节点中心。 */
function rectIntersection(node: NodeRect, target: NodeRect): { x: number; y: number } {
  const w = node.width / 2;
  const h = node.height / 2;
  const cx = node.x + w;
  const cy = node.y + h;
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;

  const dx = (tx - cx) / (2 * w) - (ty - cy) / (2 * h);
  const dy = (tx - cx) / (2 * w) + (ty - cy) / (2 * h);
  const scale = 1 / (Math.abs(dx) + Math.abs(dy));
  const sx = scale * dx;
  const sy = scale * dy;
  const x = w * (sx + sy) + cx;
  const y = h * (-sx + sy) + cy;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x: cx, y: cy };
  }
  return { x, y };
}

/** 交点落在节点哪条边 → 对应 Position（端口标签外推方向）。 */
function edgePosition(node: NodeRect, point: { x: number; y: number }): Position {
  const nx = Math.round(node.x);
  const ny = Math.round(node.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);

  if (px <= nx + 1) {
    return Position.Left;
  }
  if (px >= nx + Math.round(node.width) - 1) {
    return Position.Right;
  }
  if (py <= ny + 1) {
    return Position.Top;
  }
  if (py >= ny + Math.round(node.height) - 1) {
    return Position.Bottom;
  }
  return Position.Top;
}

function rectCenter(node: NodeRect): { x: number; y: number } {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function verticalSnapAnchors(source: NodeRect, target: NodeRect): FloatingAnchors | undefined {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    return undefined;
  }

  const sourceCenter = rectCenter(source);
  const targetCenter = rectCenter(target);
  const dx = Math.abs(sourceCenter.x - targetCenter.x);
  const dy = Math.abs(sourceCenter.y - targetCenter.y);
  if (dy <= dx || dx > VERTICAL_EDGE_SNAP_THRESHOLD) {
    return undefined;
  }

  const overlapLeft = Math.max(source.x, target.x);
  const overlapRight = Math.min(source.x + source.width, target.x + target.width);
  if (overlapLeft > overlapRight) {
    return undefined;
  }

  const x = (overlapLeft + overlapRight) / 2;
  if (targetCenter.y >= sourceCenter.y) {
    return {
      sx: x,
      sy: source.y + source.height,
      sourcePosition: Position.Bottom,
      tx: x,
      ty: target.y,
      targetPosition: Position.Top,
    };
  }

  return {
    sx: x,
    sy: source.y,
    sourcePosition: Position.Top,
    tx: x,
    ty: target.y + target.height,
    targetPosition: Position.Bottom,
  };
}

/** 两节点 rect → floating 边两端吸附点与方向（纯函数，可直测）。 */
export function floatingEdgeAnchors(source: NodeRect, target: NodeRect): FloatingAnchors {
  const snapped = verticalSnapAnchors(source, target);
  if (snapped) {
    return snapped;
  }

  const sourcePoint = rectIntersection(source, target);
  const targetPoint = rectIntersection(target, source);
  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    sourcePosition: edgePosition(source, sourcePoint),
    tx: targetPoint.x,
    ty: targetPoint.y,
    targetPosition: edgePosition(target, targetPoint),
  };
}

/** 两端吸附点之间使用直线路径。 */
export function straightFloatingEdgePath(anchors: Pick<FloatingAnchors, "sx" | "sy" | "tx" | "ty">): string {
  return `M ${anchors.sx},${anchors.sy} L ${anchors.tx},${anchors.ty}`;
}

/**
 * 端口标签锚点：从端点沿实际连线向内推进，保证标签中心落在连线上。
 * ord 仅保留为兼容旧 Edge.data；端口与节点距离需要稳定一致，不再按层级推远。
 */
export function portLabelPoint(
  x: number,
  y: number,
  otherX: number,
  otherY: number,
  _ord = 0,
): { x: number; y: number } {
  const dx = otherX - x;
  const dy = otherY - y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || !Number.isFinite(length)) {
    return { x, y };
  }

  const distance = 16;
  const t = Math.min(distance / length, 0.45);
  return {
    x: x + dx * t,
    y: y + dy * t,
  };
}

function PortLabel({ x, y, text, selected }: { x: number; y: number; text: string; selected: boolean }) {
  return (
    <EdgeLabelRenderer>
      <div
        className={selected ? "tsn-port-label selected mono nodrag nopan" : "tsn-port-label mono nodrag nopan"}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

export function TsnFloatingEdge(props: EdgeProps) {
  const { id, source, target, markerEnd, style, selected } = props;
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const data = (props.data ?? {}) as Partial<TsnEdgeData>;
  const sourceRect: NodeRect = {
    x: sourceNode.internals.positionAbsolute.x,
    y: sourceNode.internals.positionAbsolute.y,
    width: sourceNode.measured.width ?? 0,
    height: sourceNode.measured.height ?? 0,
  };
  const targetRect: NodeRect = {
    x: targetNode.internals.positionAbsolute.x,
    y: targetNode.internals.positionAbsolute.y,
    width: targetNode.measured.width ?? 0,
    height: targetNode.measured.height ?? 0,
  };
  const anchors = floatingEdgeAnchors(sourceRect, targetRect);
  const path = straightFloatingEdgePath(anchors);
  const left = data.leftLabel
    ? portLabelPoint(anchors.sx, anchors.sy, anchors.tx, anchors.ty, data.leftOrd ?? 0)
    : undefined;
  const right = data.rightLabel
    ? portLabelPoint(anchors.tx, anchors.ty, anchors.sx, anchors.sy, data.rightOrd ?? 0)
    : undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={TSN_EDGE_INTERACTION_WIDTH}
      />
      {left && data.leftLabel && (
        <PortLabel x={left.x} y={left.y} text={data.leftLabel} selected={Boolean(selected)} />
      )}
      {right && data.rightLabel && (
        <PortLabel x={right.x} y={right.y} text={data.rightLabel} selected={Boolean(selected)} />
      )}
    </>
  );
}
