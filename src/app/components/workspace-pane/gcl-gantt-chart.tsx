import type * as ECharts from "echarts";
import { useEffect, useRef } from "react";
import { CHART_COLORS } from "./chart-palette";
import type { GclDisplayModel } from "./flow-sim";

/** 类级降级窗（「ST 类」）中性灰。 */
const DEGRADED_COLOR = "#8c8c8c";
/** 空窗（无关联流）浅灰。 */
const EMPTY_WINDOW_COLOR = "#e5e7eb";
/** 徽章可读的最小块宽（px），更窄的块只画色块不画字。 */
const BADGE_MIN_WIDTH_PX = 30;

/** 每行高度与图表固定开销（grid 上边距 + x 轴标签 + slider 缩放条）。 */
const GANTT_ROW_PX = 36;
const GANTT_CHROME_PX = 96;

/** 容器高度按行数线性自适应（组件容器与 option grid 同源）。 */
export function ganttHeightPx(rowCount: number): number {
  return rowCount * GANTT_ROW_PX + GANTT_CHROME_PX;
}

/** 每窗一条数据：[categoryIdx, startUs, endUs, gateStates, 关联流文本, 颜色, 徽章文本]。 */
export type GanttDatum = [number, number, number, number, string, string, string];

/** 数据条目下标语义（renderItem / tooltip 共用）。 */
const DIM_CATEGORY = 0;
const DIM_START_US = 1;
const DIM_END_US = 2;
const DIM_GATE_STATES = 3;
const DIM_FLOW_TEXT = 4;
const DIM_COLOR = 5;
const DIM_BADGE = 6;

/** ns → μs 显示（与门控表页签 fmtUs 同口径：除以 1000 保留 1 位小数）。 */
function fmtUs(us: number): string {
  return us.toFixed(1);
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

/** 位图 → 打开的队列列表文本（q0-q7，bit g = gate g 开），全关 → 「无（全关）」。 */
function openQueueList(gateStates: number): string {
  const open = Array.from({ length: 8 }, (_, g) => g)
    .filter((g) => (gateStates >> g) & 1)
    .map((g) => `q${g}`);
  return open.length > 0 ? open.join(",") : "无（全关）";
}

interface RectShape {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 矩形求交裁剪（与 echarts.graphic.clipRectByRect 同语义：完全出界返回 undefined）。
 * 本组件 echarts 走动态 import（照 time-sync-offset-chart 先例保持代码分包），
 * option 纯函数不能静态引 echarts 模块，故本地实现。 */
function clipRectByRect(target: RectShape, clip: RectShape): RectShape | undefined {
  const x = Math.max(target.x, clip.x);
  const y = Math.max(target.y, clip.y);
  const x2 = Math.min(target.x + target.width, clip.x + clip.width);
  const y2 = Math.min(target.y + target.height, clip.y + clip.height);
  if (x2 <= x || y2 <= y) {
    return undefined;
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * option 构建纯函数（KTD7，测试主体）：Y=category「节点名.G{ethN}」（倒序使 model 第一组
 * 在顶部）、X=0..cycleNs/1000（μs）；custom series renderItem 画圆角窗口块 + 徽章文本；
 * 颜色=首个关联流 seq 对 CHART_COLORS 取模（类级降级中性灰、空窗浅灰）；
 * tooltip 悬浮卡多字段；dataZoom inside+slider(weakFilter)。
 * renderItem / tooltip 经 params.dataIndex（raw index，weakFilter 过滤下仍稳定）回读闭包
 * data，避免 api.value 对字符串维度解析成 NaN。
 */
export function buildGanttOption(
  model: GclDisplayModel,
  cycleNs: number,
  degradedSeqs?: Set<number>,
): ECharts.EChartsOption {
  const rowLabels = model.groups.map((g) => `${g.nodeName}.G${g.ethN}`);
  const yCategories = [...rowLabels].reverse();
  const rowCount = rowLabels.length;

  const data: GanttDatum[] = [];
  model.groups.forEach((group, groupIdx) => {
    const categoryIdx = rowCount - 1 - groupIdx;
    for (const w of group.windows) {
      const refs = w.flowRefs ?? [];
      const degraded = refs.some(
        (r) => r.source === "class" || (degradedSeqs?.has(r.seq) ?? false),
      );
      const color =
        refs.length === 0
          ? EMPTY_WINDOW_COLOR
          : degraded
            ? DEGRADED_COLOR
            : CHART_COLORS[refs[0].seq % CHART_COLORS.length];
      const badge =
        refs.length === 0
          ? ""
          : degraded
            ? "ST 类"
            : refs.length > 2
              ? `F${refs[0].seq} +${refs.length - 1}`
              : refs.map((r) => `F${r.seq}`).join(" ");
      const flowText =
        refs.length === 0
          ? "空窗"
          : degraded
            ? "ST 类"
            : refs.map((r) => `F${r.seq}·${model.flowNames.get(r.seq) ?? `流${r.seq}`}`).join(" ");
      data.push([
        categoryIdx,
        w.startNs / 1000,
        (w.startNs + w.durationNs) / 1000,
        w.gateStates,
        flowText,
        color,
        badge,
      ]);
    }
  });

  const renderItem: ECharts.CustomSeriesRenderItem = (params, api) => {
    const datum = data[params.dataIndex];
    if (!datum) {
      return null;
    }
    const start = api.coord([datum[DIM_START_US], datum[DIM_CATEGORY]]);
    const end = api.coord([datum[DIM_END_US], datum[DIM_CATEGORY]]);
    const rowSize = api.size?.([0, 1]) ?? [0, GANTT_ROW_PX];
    const barHeight = (Array.isArray(rowSize) ? rowSize[1] : rowSize) * 0.6;
    const coordSys = params.coordSys as unknown as RectShape;
    const rect = clipRectByRect(
      {
        x: start[0],
        y: start[1] - barHeight / 2,
        width: Math.max(end[0] - start[0], 1),
        height: barHeight,
      },
      coordSys,
    );
    if (!rect) {
      return null;
    }
    const badge = datum[DIM_BADGE];
    const children: unknown[] = [
      {
        type: "rect",
        shape: { ...rect, r: 3 },
        style: { fill: datum[DIM_COLOR] },
      },
    ];
    if (badge !== "" && rect.width >= BADGE_MIN_WIDTH_PX) {
      children.push({
        type: "text",
        silent: true,
        style: {
          text: badge,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          align: "center",
          verticalAlign: "middle",
          fill: "#ffffff",
          fontSize: 11,
          fontWeight: 600,
        },
      });
    }
    return { type: "group", children } as ECharts.CustomSeriesRenderItemReturn;
  };

  return {
    animation: false,
    // 容器高度 = ganttHeightPx(rowCount)；上下留白（含 x 轴标签 + slider）合计 GANTT_CHROME_PX，
    // 网格区正好 rowCount * GANTT_ROW_PX，每行 ~36px。
    grid: {
      top: 8,
      right: 24,
      bottom: GANTT_CHROME_PX - 8,
      left: 8,
      containLabel: true,
    },
    tooltip: {
      trigger: "item",
      appendToBody: true,
      extraCssText: "z-index: 2000;",
      formatter: (params: unknown) => formatGanttTooltip(params, data, yCategories),
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "weakFilter",
      },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "weakFilter",
        height: 22,
        bottom: 10,
        brushSelect: false,
      },
    ],
    xAxis: {
      type: "value",
      min: 0,
      max: cycleNs / 1000,
      name: "μs",
      nameGap: 6,
      axisLine: { lineStyle: { color: "#aeb4bf" } },
      axisTick: { show: false },
      axisLabel: { color: "#9aa1ad", fontSize: 11 },
      splitLine: { show: true, lineStyle: { color: "#eceff3" } },
    },
    yAxis: {
      type: "category",
      data: yCategories,
      axisLine: { lineStyle: { color: "#aeb4bf" } },
      axisTick: { show: false },
      axisLabel: { color: "#5b6470", fontSize: 12 },
      splitLine: { show: false },
    },
    series: [
      {
        type: "custom",
        renderItem,
        encode: { x: [DIM_START_US, DIM_END_US], y: DIM_CATEGORY },
        clip: true,
        data,
      },
    ],
  };
}

/** tooltip 悬浮卡 HTML：行标签 / 时间区间 μs / 持续 / 打开队列 / 门控操作 / 关联流。 */
function formatGanttTooltip(params: unknown, data: GanttDatum[], yCategories: string[]): string {
  if (!isRecord(params) || typeof params.dataIndex !== "number") {
    return "";
  }
  const datum = data[params.dataIndex];
  if (!datum) {
    return "";
  }
  const startUs = datum[DIM_START_US];
  const endUs = datum[DIM_END_US];
  const rowLabel = yCategories[datum[DIM_CATEGORY]] ?? "";
  return [
    `<strong>${escapeHtml(rowLabel)}</strong>`,
    `时间区间：${fmtUs(startUs)} – ${fmtUs(endUs)} μs`,
    `持续：${fmtUs(endUs - startUs)} μs`,
    `打开队列：${escapeHtml(openQueueList(datum[DIM_GATE_STATES]))}`,
    "门控操作：set-gate-states",
    `关联流：${escapeHtml(datum[DIM_FLOW_TEXT])}`,
  ].join("<br/>");
}

export interface GclGanttChartProps {
  /** 已按弹窗筛选过滤的 display model（组件不再自己筛）。 */
  model: GclDisplayModel;
  /** 超周期 ns（X 轴上界 = cycleNs/1000 μs）。 */
  cycleNs: number;
  /** 类级降级流 seq 集合（degradedFlowSeqs 输出，命中即整窗降级着灰）。 */
  degradedSeqs?: Set<number>;
}

/**
 * 门控可视化页签甘特图（U6，R8/AE1）：行=节点.端口 的时间轴开窗图。
 * 空 model 渲染占位不初始化 chart；非空走 ECharts 动态 import + init/resize/dispose
 * （照 time-sync-offset-chart.tsx 先例）。
 */
export function GclGanttChart({ model, cycleNs, degradedSeqs }: GclGanttChartProps) {
  if (model.groups.length === 0) {
    return (
      <div className="gcl-gantt-empty mono" role="status">
        无窗口数据
      </div>
    );
  }
  return <GanttCanvas model={model} cycleNs={cycleNs} degradedSeqs={degradedSeqs} />;
}

function GanttCanvas({ model, cycleNs, degradedSeqs }: GclGanttChartProps) {
  const chartElementRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<ECharts.ECharts | undefined>(undefined);
  const latestOptionRef = useRef<ECharts.EChartsOption>(
    buildGanttOption(model, cycleNs, degradedSeqs),
  );

  useEffect(() => {
    latestOptionRef.current = buildGanttOption(model, cycleNs, degradedSeqs);
    chartInstanceRef.current?.setOption(latestOptionRef.current, {
      notMerge: true,
      lazyUpdate: true,
    });
  }, [model, cycleNs, degradedSeqs]);

  useEffect(() => {
    const el = chartElementRef.current;
    if (!el) {
      return undefined;
    }
    let disposed = false;
    let chart: ECharts.ECharts | undefined;
    let observer: ResizeObserver | undefined;

    void import("echarts")
      .then((echarts) => {
        // import 是异步的——StrictMode 双挂载 / HMR 会在 import 解析前就 cleanup，此时直接退出不 init。
        if (disposed || chartElementRef.current !== el) {
          return;
        }
        // 同一 dom 重复 init 时 echarts 会返回旧实例并告警，随后前一个 effect 的 cleanup 把这个
        // 共享实例 dispose 掉 → setOption 打在已 disposed 的实例上 → 空白画布。先清残留实例，确保
        // 每次都拿到全新实例；cleanup 只 dispose 本 effect 自己的 chart（局部变量，非共享 ref）。
        echarts.getInstanceByDom(el)?.dispose();
        chart = echarts.init(el, undefined, { renderer: "canvas" });
        chartInstanceRef.current = chart;
        chart.setOption(latestOptionRef.current, {
          notMerge: true,
          lazyUpdate: true,
        });
        // init 可能在容器完成布局前读到 0 宽/高（Tauri WebKit 时序）——立即 resize 读真实尺寸，
        // 并用 ResizeObserver 盯容器本身（弹窗/分栏布局变化不会触发 window resize，必须盯元素）。
        chart.resize();
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => chart?.resize());
          observer.observe(el);
        }
      })
      .catch((err) => {
        // 把被 promise 吞掉的 echarts import/init/setOption 报错暴露出来（排查空白画布）。
        console.error("[gcl-gantt-chart] echarts 渲染失败:", err);
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
      if (chartInstanceRef.current === chart) {
        chartInstanceRef.current = undefined;
      }
    };
  }, []);

  return (
    <div
      className="gcl-gantt-chart"
      ref={chartElementRef}
      style={{ width: "100%", height: ganttHeightPx(model.groups.length) }}
      role="img"
      aria-label="门控时序图"
    />
  );
}
