import type * as ECharts from "echarts";
import { useMemo, useRef } from "react";
import { useEChartsOption } from "../../hooks/use-echarts";
import { CHART_COLORS } from "./chart-palette";
import {
  degradedFlowSeqs,
  deriveFlowWindowChains,
  type FlowChain,
  type GclDetail,
} from "./flow-sim";

/**
 * 流量维度页签（U7，R9）：按流分组的逐跳 发/入/出/收 窗口链视图。
 * 消费 U4 的 deriveFlowWindowChains 推导输出（KTD9 展示层纯推导，不落库）；
 * 本页签不受节点筛选影响（R7）——组件内自带流选择，detail 直接吃全量。
 * 类级降级流整链隐藏（R9 宁缺毋滥）：不进可选列表，仅出「N 条流…未显示」提示。
 */
export interface GclFlowChainChartProps {
  detail: GclDetail;
  selectedFlowSeq: number | null;
  onSelectFlow: (seq: number) => void;
}

/** 窗口链逐跳逐实例数据条目（buildChainOption 的数据形状，导出供测试断言）。时间均为 μs。 */
export interface ChainHopDatum {
  hopIdx: number;
  instanceIdx: number;
  node: string;
  /** send = 首跳（talker 出端口，徽章「发」）；forward = 中间/末跳（入→出）。 */
  kind: "send" | "forward";
  isLast: boolean;
  txStartUs: number;
  txEndUs: number;
  /** 推导入窗（首跳 null）。 */
  rxStartUs: number | null;
  rxEndUs: number | null;
  /** 上一跳同实例出窗尾（入→出连线起点，首跳/实例缺配对时 null）。 */
  prevTxEndUs: number | null;
  /** 末跳收段（收窗 = 末跳出窗 + 传播；非末跳 null）。 */
  receiveStartUs: number | null;
  receiveEndUs: number | null;
  /** KTD9 sanity：推导入窗与本跳出窗不一致 → 警示描边 + 悬浮卡提示。 */
  inconsistent: boolean;
}

const NS_PER_US = 1000;

function toUs(ns: number): number {
  return ns / NS_PER_US;
}

/** μs 数值显示：最多 3 位小数、去尾零（4560ns → "4.56"）。 */
function fmtUs(us: number): string {
  return Number(us.toFixed(3)).toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** FlowChain → 逐跳逐实例数据条目（纯函数，导出供测试）。 */
export function buildChainDataItems(chain: FlowChain): ChainHopDatum[] {
  const items: ChainHopDatum[] = [];
  chain.hops.forEach((hop, hopIdx) => {
    const prev = hopIdx > 0 ? chain.hops[hopIdx - 1] : null;
    const isLast = hopIdx === chain.hops.length - 1;
    hop.txWindows.forEach(([txStart, txEnd], instanceIdx) => {
      const rx = hop.rxWindows?.[instanceIdx] ?? null;
      const prevTx = prev?.txWindows[instanceIdx] ?? null;
      const receive = isLast ? (chain.receiveWindows[instanceIdx] ?? null) : null;
      items.push({
        hopIdx,
        instanceIdx,
        node: hop.node,
        kind: hopIdx === 0 ? "send" : "forward",
        isLast,
        txStartUs: toUs(txStart),
        txEndUs: toUs(txEnd),
        rxStartUs: rx ? toUs(rx[0]) : null,
        rxEndUs: rx ? toUs(rx[1]) : null,
        prevTxEndUs: prevTx ? toUs(prevTx[1]) : null,
        receiveStartUs: receive ? toUs(receive[0]) : null,
        receiveEndUs: receive ? toUs(receive[1]) : null,
        inconsistent: hop.inconsistent,
      });
    });
  });
  return items;
}

/** 悬浮卡 HTML（R9 诚实边界：固定免责尾注 + 数据来源 + KTD9 sanity 提示）。 */
function chainTooltipHtml(chain: FlowChain, it: ChainHopDatum): string {
  const lines = [`<strong>${escapeHtml(chain.name)} · ${escapeHtml(it.node)}</strong>`];
  if (it.rxStartUs !== null && it.rxEndUs !== null) {
    lines.push(`入站时间戳: ${fmtUs(it.rxStartUs)} – ${fmtUs(it.rxEndUs)} μs`);
  }
  lines.push(
    `出站时间戳: ${fmtUs(it.txStartUs)} – ${fmtUs(it.txEndUs)} μs`,
    `持续: ${fmtUs(it.txEndUs - it.txStartUs)} μs`,
  );
  if (it.receiveStartUs !== null && it.receiveEndUs !== null) {
    lines.push(`接收窗口: ${fmtUs(it.receiveStartUs)} – ${fmtUs(it.receiveEndUs)} μs`);
  }
  lines.push("数据来源: GCL 规划结果");
  if (it.inconsistent) {
    lines.push('<span style="color:#d4380d">时延常数与求解器建模不一致</span>');
  }
  lines.push('<span style="color:#8a919c">时间戳为门控窗口边界，不代表报文实际到达时刻</span>');
  return lines.join("<br/>");
}

/** 端点徽章 text 元素（发/入/出/收）。 */
function badge(
  text: string,
  x: number,
  y: number,
  verticalAlign: "top" | "bottom" | "middle",
  align: "left" | "right" = "left",
) {
  return {
    type: "text" as const,
    silent: true,
    style: {
      text,
      x,
      y,
      fill: "#475467",
      fontSize: 10,
      textAlign: align,
      textVerticalAlign: verticalAlign,
    },
  };
}

/** 手动按坐标系横向裁剪（等价 clipRectByRect 的 x 向；避免 runtime import echarts 破坏懒加载）。 */
function clampRect(
  x: number,
  y: number,
  width: number,
  height: number,
  sys: { x: number; width: number },
): { x: number; y: number; width: number; height: number } | null {
  const x1 = Math.max(x, sys.x);
  const x2 = Math.min(x + width, sys.x + sys.width);
  if (x2 <= x1) {
    return null;
  }
  return { x: x1, y, width: x2 - x1, height };
}

/**
 * 单流窗口链 option 构建纯函数（导出供测试）。Y 轴类目 = 流路径节点，inverse=true
 * → 顶部 talker、底部末跳；X 轴 μs（上限 = 超周期）。custom series renderItem 返回
 * group：出窗 rect + 端点徽章（首跳「发」/其余「出」+「入」+ 末跳「收」段）+
 * 入→出连线（上一跳出窗尾 → 本跳出窗头）+ sanity 警示描边。
 */
export function buildChainOption(chain: FlowChain, cycleNs: number): ECharts.EChartsOption {
  const items = buildChainDataItems(chain);
  const nodes = chain.hops.map((h) => h.node);
  const color = CHART_COLORS[Math.abs(chain.streamSeq) % CHART_COLORS.length];
  const cycleUs = cycleNs > 0 ? toUs(cycleNs) : undefined;

  const renderItem = (
    params: ECharts.CustomSeriesRenderItemParams,
    api: ECharts.CustomSeriesRenderItemAPI,
  ): ECharts.CustomSeriesRenderItemReturn => {
    const it = items[params.dataIndex];
    const children: unknown[] = [];
    if (!it) {
      return { type: "group", children: [] } as unknown as ECharts.CustomSeriesRenderItemReturn;
    }
    const sys = params.coordSys as unknown as { x: number; width: number };
    const start = api.coord([it.txStartUs, it.hopIdx]);
    const end = api.coord([it.txEndUs, it.hopIdx]);
    const sizeResult = api.size?.([0, 1]);
    const band = Array.isArray(sizeResult) ? (sizeResult[1] ?? 28) : 28;
    const h = Math.min(16, band * 0.4);
    const y = start[1] - h / 2;

    // 出窗主体色块（sanity 不一致窗加警示描边）。
    const rect = clampRect(start[0], y, Math.max(end[0] - start[0], 1), h, sys);
    if (rect) {
      children.push({
        type: "rect",
        shape: rect,
        style: {
          fill: color,
          ...(it.inconsistent ? { stroke: "#d4380d", lineWidth: 1.5, lineDash: [3, 2] } : {}),
        },
      });
      // 端点徽章：首跳「发」、其余跳「出」（出窗头上方）。
      children.push(badge(it.kind === "send" ? "发" : "出", start[0], y - 3, "bottom"));
    }
    // 「入」徽章（推导入窗头下方，textAlign right 避让收段）。
    if (it.rxStartUs !== null) {
      const rx = api.coord([it.rxStartUs, it.hopIdx]);
      children.push(badge("入", rx[0] - 2, y + h + 3, "top", "right"));
    }
    // 入→出连线：上一跳出窗尾 → 本跳出窗头。
    if (it.prevTxEndUs !== null) {
      const from = api.coord([it.prevTxEndUs, it.hopIdx - 1]);
      children.push({
        type: "line",
        silent: true,
        shape: { x1: from[0], y1: from[1] + h / 2, x2: start[0], y2: y },
        style: { stroke: "#98a2b3", lineWidth: 1, lineDash: [4, 3] },
      });
    }
    // 末跳「收」段（细条画在主 rect 下方）。
    if (it.receiveStartUs !== null && it.receiveEndUs !== null) {
      const rs = api.coord([it.receiveStartUs, it.hopIdx]);
      const re = api.coord([it.receiveEndUs, it.hopIdx]);
      const rh = Math.max(h * 0.5, 4);
      const rrect = clampRect(rs[0], y + h + 2, Math.max(re[0] - rs[0], 1), rh, sys);
      if (rrect) {
        children.push({ type: "rect", shape: rrect, style: { fill: color, opacity: 0.45 } });
        children.push(badge("收", re[0] + 2, y + h + 2 + rh / 2, "middle"));
      }
    }
    return { type: "group", children } as unknown as ECharts.CustomSeriesRenderItemReturn;
  };

  return {
    animation: false,
    grid: { top: 28, right: 28, bottom: 64, left: 88 },
    tooltip: {
      trigger: "item",
      appendToBody: true,
      extraCssText: "z-index: 2000;",
      formatter: (p: unknown) => {
        const rec = (Array.isArray(p) ? p[0] : p) as { dataIndex?: number } | undefined;
        const it = rec?.dataIndex !== undefined ? items[rec.dataIndex] : undefined;
        return it ? chainTooltipHtml(chain, it) : "";
      },
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "weakFilter" },
      { type: "slider", xAxisIndex: 0, filterMode: "weakFilter", height: 20, bottom: 14 },
    ],
    xAxis: {
      type: "value",
      min: 0,
      max: cycleUs,
      name: "时间(μs)",
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: "#747b87", fontSize: 12 },
      axisLine: { lineStyle: { color: "#aeb4bf" } },
      axisLabel: { color: "#9aa1ad", fontSize: 11 },
      splitLine: { show: true, lineStyle: { color: "#eceff3" } },
    },
    yAxis: {
      type: "category",
      data: nodes,
      // inverse=true → 类目 index 0（talker）画在顶部、末跳在底部。
      inverse: true,
      axisLine: { lineStyle: { color: "#aeb4bf" } },
      axisTick: { show: false },
      axisLabel: { color: "#5b6472", fontSize: 12 },
    },
    series: [
      {
        type: "custom",
        renderItem,
        encode: { x: [0, 1], y: 2 },
        data: items.map((it) => [it.txStartUs, it.txEndUs, it.hopIdx]),
      },
    ],
  };
}

/** ECharts 画布（共享 hook：动态 import / init / dispose / resize / setOption）。 */
function ChainCanvas({ option }: { option: ECharts.EChartsOption }) {
  const chartElementRef = useRef<HTMLDivElement | null>(null);
  useEChartsOption(chartElementRef, option, { logTag: "gcl-flow-chain-chart" });

  return (
    <div
      ref={chartElementRef}
      role="img"
      aria-label="流量维度窗口链图"
      style={{ width: "100%", flex: 1, minHeight: 320 }}
    />
  );
}

/** 流量维度页签组件（U7）。降级流不进可选列表（R9 整链隐藏）；selectedFlowSeq
 * 无效（null / 降级 / 不在链集）时默认展示首条可用流（不回写，选择权在编排层）。 */
export function GclFlowChainChart({
  detail,
  selectedFlowSeq,
  onSelectFlow,
}: GclFlowChainChartProps) {
  const chains = useMemo(() => deriveFlowWindowChains(detail), [detail]);
  const degradedCount = useMemo(() => degradedFlowSeqs(detail).size, [detail]);
  const active = chains.find((c) => c.streamSeq === selectedFlowSeq) ?? chains[0] ?? null;
  const cycleNs = detail.meta?.cycleNs ?? 0;
  const option = useMemo(
    () => (active ? buildChainOption(active, cycleNs) : null),
    [active, cycleNs],
  );

  return (
    <div
      className="gcl-chain-pane"
      style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}
    >
      <div
        className="gcl-chain-toolbar"
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        {chains.length > 0 && (
          <div className="flow-subtabs gcl-chain-flows" role="group" aria-label="选择流">
            {chains.map((c) => (
              <button
                key={c.streamSeq}
                type="button"
                aria-pressed={active?.streamSeq === c.streamSeq}
                className={active?.streamSeq === c.streamSeq ? "flow-subtab active" : "flow-subtab"}
                onClick={() => onSelectFlow(c.streamSeq)}
              >
                F{c.streamSeq}·{c.name}
              </button>
            ))}
          </div>
        )}
        {degradedCount > 0 && (
          <span className="gcl-chain-degraded-hint" role="note">
            {degradedCount} 条流因关联精度不足未显示
          </span>
        )}
      </div>
      {active && option ? (
        <ChainCanvas option={option} />
      ) : (
        <div className="gcl-chain-empty mono" role="status">
          无可显示的流窗口链
        </div>
      )}
    </div>
  );
}
