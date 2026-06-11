import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import type { TsnEdgeData } from "./topology-flow";

/**
 * Plan 2026-06-11-001 U3：floating 贝塞尔边（R1/R4）。
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

/** 交点落在节点哪条边 → 对应 Position（贝塞尔出射方向）。 */
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

/** 两节点 rect → floating 边两端吸附点与方向（纯函数，可直测）。 */
export function floatingEdgeAnchors(source: NodeRect, target: NodeRect): FloatingAnchors {
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

/**
 * 端口标签锚点：吸附点沿出射方向外推（R4，随拖动跟随）。
 * 同节点同方位的多条边交点相邻，标签按序数 ord 分层外推防重叠。
 */
export function portLabelPoint(
  x: number,
  y: number,
  position: Position,
  ord = 0,
): { x: number; y: number } {
  const v = 14 + ord * 13;
  const h = 16 + ord * 20;
  switch (position) {
    case Position.Top:
      return { x, y: y - v };
    case Position.Bottom:
      return { x, y: y + v };
    case Position.Left:
      return { x: x - h, y };
    default:
      return { x: x + h, y };
  }
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
  const [path] = getBezierPath({
    sourceX: anchors.sx,
    sourceY: anchors.sy,
    sourcePosition: anchors.sourcePosition,
    targetX: anchors.tx,
    targetY: anchors.ty,
    targetPosition: anchors.targetPosition,
  });
  const left = data.leftLabel
    ? portLabelPoint(anchors.sx, anchors.sy, anchors.sourcePosition, data.leftOrd ?? 0)
    : undefined;
  const right = data.rightLabel
    ? portLabelPoint(anchors.tx, anchors.ty, anchors.targetPosition, data.rightOrd ?? 0)
    : undefined;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {left && data.leftLabel && (
        <PortLabel x={left.x} y={left.y} text={data.leftLabel} selected={Boolean(selected)} />
      )}
      {right && data.rightLabel && (
        <PortLabel x={right.x} y={right.y} text={data.rightLabel} selected={Boolean(selected)} />
      )}
    </>
  );
}
