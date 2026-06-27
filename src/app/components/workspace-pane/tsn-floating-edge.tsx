import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  useInternalNode,
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
const TSN_EDGE_INTERACTION_WIDTH = 4;

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
export function straightFloatingEdgePath(
  anchors: Pick<FloatingAnchors, "sx" | "sy" | "tx" | "ty">,
): string {
  return `M ${anchors.sx},${anchors.sy} L ${anchors.tx},${anchors.ty}`;
}

function parallelSlot(index: number, count: number): number {
  const safeCount = Math.max(1, Math.floor(count));
  const safeIndex = Math.min(Math.max(0, Math.floor(index)), safeCount - 1);
  return (safeIndex + 0.5) / safeCount;
}

function pointOnNodeSide(
  node: NodeRect,
  position: Position,
  slot: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Top:
      return { x: node.x + node.width * slot, y: node.y };
    case Position.Bottom:
      return { x: node.x + node.width * slot, y: node.y + node.height };
    case Position.Left:
      return { x: node.x, y: node.y + node.height * slot };
    default:
      return { x: node.x + node.width, y: node.y + node.height * slot };
  }
}

export function parallelFloatingEdgeAnchors(
  source: NodeRect,
  target: NodeRect,
  index = 0,
  count = 1,
): FloatingAnchors {
  const anchors = floatingEdgeAnchors(source, target);
  if (count <= 1) {
    return anchors;
  }

  const slot = parallelSlot(index, count);
  const sourcePoint = pointOnNodeSide(source, anchors.sourcePosition, slot);
  const targetPoint = pointOnNodeSide(target, anchors.targetPosition, slot);
  return {
    ...anchors,
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
  };
}

/**
 * 端口标签锚点：吸附点沿出射方向外推。
 * 同节点同方位的多条边交点相邻，标签按序数 ord 分层外推防重叠。
 */
export function portLabelPoint(
  x: number,
  y: number,
  position: Position,
  ord = 0,
  avoidMarker = false,
): { x: number; y: number } {
  const markerGap = avoidMarker ? 10 : 0;
  const v = 14 + markerGap + ord * 13;
  const h = 16 + markerGap + ord * 20;
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

function PortLabel({
  x,
  y,
  text,
  selected,
}: {
  x: number;
  y: number;
  text: string;
  selected: boolean;
}) {
  return (
    <EdgeLabelRenderer>
      <div
        className={
          selected
            ? "tsn-port-label selected mono nodrag nopan"
            : "tsn-port-label mono nodrag nopan"
        }
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

function EdgePulse({
  id,
  path,
  delaySec = 0,
  travelSec = 1.8,
  cycleSec,
}: {
  id: string;
  path: string;
  delaySec?: number;
  travelSec?: number;
  cycleSec?: number;
}) {
  const motionPathId = `${id}-timesync-motion-path`;
  const safeDelaySec = Math.max(0, delaySec);
  const safeTravelSec = Math.max(0.1, travelSec);
  const safeCycleSec = Math.max(safeTravelSec, cycleSec ?? safeTravelSec);
  const hideBeginSec = Math.min(safeCycleSec, safeDelaySec + safeTravelSec);
  const startRatio = safeDelaySec / safeCycleSec;
  const endRatio = hideBeginSec / safeCycleSec;
  return (
    <>
      <path id={motionPathId} d={path} className="tsn-edge-motion-path" />
      <circle className="tsn-edge-pulse" r="8" opacity="0">
        <animate
          attributeName="opacity"
          values="0;0;1;1;0;0"
          keyTimes={`0;${startRatio};${startRatio};${endRatio};${endRatio};1`}
          dur={`${safeCycleSec}s`}
          repeatCount="indefinite"
        />
        <animateMotion
          calcMode="linear"
          dur={`${safeCycleSec}s`}
          keyPoints="0;0;1;1"
          keyTimes={`0;${startRatio};${endRatio};1`}
          repeatCount="indefinite"
          rotate="auto"
        >
          <mpath href={`#${motionPathId}`} />
        </animateMotion>
      </circle>
    </>
  );
}

export function TsnFloatingEdge(props: EdgeProps) {
  const { id, source, target, markerEnd, markerStart, style, selected } = props;
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
  const parallelIndex = typeof data.parallelIndex === "number" ? data.parallelIndex : 0;
  const parallelCount = typeof data.parallelCount === "number" ? data.parallelCount : 1;
  const anchors = parallelFloatingEdgeAnchors(sourceRect, targetRect, parallelIndex, parallelCount);
  const path = straightFloatingEdgePath(anchors);
  const reversePath = straightFloatingEdgePath({
    sx: anchors.tx,
    sy: anchors.ty,
    tx: anchors.sx,
    ty: anchors.sy,
  });
  // U8/KTD1：src_port 标在 source 端、dst_port 标在 target 端（几何无关，跟节点不跟屏幕）。
  // 自环（src===dst）端点重合：两标签各自反向小偏移（src 上、dst 下）防叠压。
  const selfLoop = data.selfLoop === true;
  const hasSrc = typeof data.srcPort === "number";
  const hasDst = typeof data.dstPort === "number";
  const src = hasSrc
    ? portLabelPoint(
        anchors.sx,
        anchors.sy,
        selfLoop ? Position.Top : anchors.sourcePosition,
        data.srcOrd ?? 0,
        Boolean(markerStart),
      )
    : undefined;
  const dst = hasDst
    ? portLabelPoint(
        anchors.tx,
        anchors.ty,
        selfLoop ? Position.Bottom : anchors.targetPosition,
        data.dstOrd ?? 0,
        Boolean(markerEnd),
      )
    : undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
        interactionWidth={TSN_EDGE_INTERACTION_WIDTH}
      />
      {(data.timesyncPulse === "forward" || data.timesyncPulse === "reverse") && (
        <EdgePulse
          id={id}
          path={data.timesyncPulse === "reverse" ? reversePath : path}
          delaySec={data.timesyncPulseDelaySec}
          travelSec={data.timesyncPulseTravelSec}
          cycleSec={data.timesyncPulseCycleSec}
        />
      )}
      {src && hasSrc && (
        <PortLabel x={src.x} y={src.y} text={String(data.srcPort)} selected={Boolean(selected)} />
      )}
      {dst && hasDst && (
        <PortLabel x={dst.x} y={dst.y} text={String(data.dstPort)} selected={Boolean(selected)} />
      )}
    </>
  );
}
