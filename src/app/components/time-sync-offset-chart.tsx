import type * as ECharts from "echarts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./time-sync-offset-chart.css";

export const TIME_SYNC_ALL_SERIES_ID = "all";
const DEFAULT_THRESHOLD_NS = 200;
const SERIES_COLORS = ["#fa541c", "#d4380d", "#ad2102", "#722ed1", "#c41d7f", "#8c8c8c"];
const THRESHOLD_SERIES_ID_PREFIX = "__time-sync-threshold-";
const DATA_ZOOM_INSIDE_ID = "time-sync-offset-datazoom-inside";
const DATA_ZOOM_SLIDER_ID = "time-sync-offset-datazoom-slider";

export interface TimeSyncMetricPoint {
  x?: string | number;
  y?: string | number;
  bucket_start_ns?: number;
  time_ns?: number;
  sim_time_ns?: number;
  timestamp_ns?: number;
  latest_offset_ns?: number;
  avg_offset_ns?: number;
  max_abs_offset_ns?: number;
  offset_ns?: number;
  value_ns?: number;
  value?: number;
  sample_count?: number;
  threshold_exceed_count?: number;
  [key: string]: unknown;
}

export interface TimeSyncMetricSeries {
  node_id?: string | number;
  hcp_mid?: string | number;
  mid?: string | number;
  name?: string;
  label?: string;
  points?: TimeSyncMetricPoint[];
  data?: TimeSyncMetricPoint[] | Array<[string | number, string | number]>;
  [key: string]: unknown;
}

export interface TimeSyncMetricRun {
  threshold_ns?: number;
  sample_count?: number;
  status?: string;
  [key: string]: unknown;
}

export interface TimeSyncMetricsPayload {
  task_id?: string;
  metric?: string;
  metrics_status?: string;
  message?: string;
  mode?: string;
  source?: string;
  runs?: TimeSyncMetricRun[];
  series?: TimeSyncMetricSeries[];
  [key: string]: unknown;
}

export type TimeSyncMetricsQueryResponse =
  | TimeSyncMetricsPayload
  | {
      data?: TimeSyncMetricsPayload;
      [key: string]: unknown;
    };

export interface TimeSyncOffsetChartProps {
  metrics: TimeSyncMetricsQueryResponse | undefined;
  nodeLabels?: Record<string, string>;
  selectedNodeIds?: string[];
  masterNodeId?: string | null;
  masterLabel?: string;
  syncPeriodLabel?: string;
  measurePeriodLabel?: string;
  title?: string;
  className?: string;
}

interface NormalizedSeries {
  id: string;
  label: string;
  color: string;
}

interface ChartPoint {
  time: string;
  __metrics?: ChartPointMeta[];
  [seriesId: string]: ChartPointMeta[] | number | string | undefined;
}

interface ChartPointMeta {
  seriesId: string;
  latestOffsetNs?: number;
  avgOffsetNs?: number;
  maxAbsOffsetNs?: number;
}

interface MetricCard {
  label: string;
  value: string;
  tone?: "success";
}

interface DataZoomState {
  start?: number;
  end?: number;
  startValue?: string | number;
  endValue?: string | number;
}

interface NormalizedChartData {
  status: string;
  message?: string;
  thresholdNs: number;
  masterLabel: string;
  series: NormalizedSeries[];
  points: ChartPoint[];
  cards: MetricCard[];
}

export interface TimeSyncNodeMetrics {
  hasSamples: boolean;
  currentOffsetNs: number;
  maxOffsetNs: number;
  minOffsetNs: number;
  avgOffsetNs: number;
  avgAbsOffsetNs: number;
  p95OffsetNs: number;
  p99OffsetNs: number;
  maxAbsOffsetNs: number;
  successRatePct: number;
  overLimitRatePct: number;
  validSamples: number;
  thresholdExceedCount: number;
}

export const EMPTY_TIME_SYNC_NODE_METRICS: TimeSyncNodeMetrics = {
  hasSamples: false,
  currentOffsetNs: 0,
  maxOffsetNs: 0,
  minOffsetNs: 0,
  avgOffsetNs: 0,
  avgAbsOffsetNs: 0,
  p95OffsetNs: 0,
  p99OffsetNs: 0,
  maxAbsOffsetNs: 0,
  successRatePct: 0,
  overLimitRatePct: 0,
  validSamples: 0,
  thresholdExceedCount: 0,
};

export function TimeSyncOffsetChart({
  metrics,
  nodeLabels = {},
  selectedNodeIds,
  masterNodeId,
  masterLabel,
  syncPeriodLabel,
  measurePeriodLabel,
  title = "时钟偏移曲线",
  className,
}: TimeSyncOffsetChartProps) {
  const [selectedSeriesId, setSelectedSeriesId] = useState(TIME_SYNC_ALL_SERIES_ID);
  const selectId = useId();
  const normalized = useMemo(
    () =>
      normalizeTimeSyncMetrics(metrics, {
        nodeLabels,
        selectedNodeIds,
        masterNodeId,
        masterLabel,
        syncPeriodLabel,
        measurePeriodLabel,
      }),
    [
      metrics,
      nodeLabels,
      selectedNodeIds,
      masterNodeId,
      masterLabel,
      syncPeriodLabel,
      measurePeriodLabel,
    ],
  );
  const visibleSeries = useMemo(
    () =>
      selectedSeriesId === TIME_SYNC_ALL_SERIES_ID
        ? normalized.series
        : normalized.series.filter((series) => series.id === selectedSeriesId),
    [normalized.series, selectedSeriesId],
  );
  const hasChartData = visibleSeries.length > 0 && normalized.points.length > 0;

  useEffect(() => {
    if (
      selectedSeriesId !== TIME_SYNC_ALL_SERIES_ID &&
      !normalized.series.some((series) => series.id === selectedSeriesId)
    ) {
      setSelectedSeriesId(TIME_SYNC_ALL_SERIES_ID);
    }
  }, [normalized.series, selectedSeriesId]);

  return (
    <section
      className={className ? `time-sync-offset-card ${className}` : "time-sync-offset-card"}
      aria-label={title}
    >
      {/* 单行头部：指标卡（左）+ 主时钟/从时钟（右）。去掉冗余「时钟偏移曲线」标题行，省纵向空间给图表。 */}
      <div className="time-sync-offset-header">
        <div className="time-sync-offset-metrics" role="group" aria-label="时钟同步指标">
          {normalized.cards.map((card) => (
            <span
              key={card.label}
              className={
                card.tone ? `time-sync-offset-metric ${card.tone}` : "time-sync-offset-metric"
              }
            >
              {card.label} <strong className="mono">{card.value}</strong>
            </span>
          ))}
        </div>
        <div className="time-sync-offset-filters">
          <span className="time-sync-offset-master">
            主时钟 <strong>{normalized.masterLabel}</strong>
          </span>
          <label className="time-sync-offset-select" htmlFor={selectId}>
            <span>从时钟</span>
            <select
              id={selectId}
              value={selectedSeriesId}
              aria-label="选择从时钟节点"
              onChange={(event) => setSelectedSeriesId(event.currentTarget.value)}
            >
              <option value={TIME_SYNC_ALL_SERIES_ID}>全部</option>
              {normalized.series.map((series) => (
                <option key={series.id} value={series.id}>
                  {series.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {normalized.message && (
        <p
          className={
            normalized.status === "failed"
              ? "time-sync-offset-status error"
              : "time-sync-offset-status"
          }
          role="status"
        >
          {normalized.message}
        </p>
      )}

      {hasChartData ? (
        <EchartsLineCanvas
          points={normalized.points}
          series={visibleSeries}
          thresholdNs={normalized.thresholdNs}
        />
      ) : (
        <div className="time-sync-offset-empty mono" role="status">
          采集中，暂无曲线点
        </div>
      )}
    </section>
  );
}

function EchartsLineCanvas({
  points,
  series,
  thresholdNs,
}: {
  points: ChartPoint[];
  series: NormalizedSeries[];
  thresholdNs: number;
}) {
  const chartElementRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<ECharts.ECharts | undefined>(undefined);
  const dataZoomStateRef = useRef<DataZoomState | undefined>(undefined);
  const latestOptionRef = useRef<ECharts.EChartsOption>(
    buildTimeSyncChartOption(points, series, thresholdNs, dataZoomStateRef.current),
  );

  useEffect(() => {
    const chart = chartInstanceRef.current;
    dataZoomStateRef.current = readDataZoomState(chart) ?? dataZoomStateRef.current;
    latestOptionRef.current = buildTimeSyncChartOption(
      points,
      series,
      thresholdNs,
      dataZoomStateRef.current,
    );
    chartInstanceRef.current?.setOption(latestOptionRef.current, {
      notMerge: true,
      lazyUpdate: true,
    });
  }, [points, series, thresholdNs]);

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
        const handleDataZoom = (payload: unknown) => {
          dataZoomStateRef.current =
            dataZoomStateFromPayload(payload) ??
            readDataZoomState(chart) ??
            dataZoomStateRef.current;
        };
        chart.on("datazoom", handleDataZoom);
        chart.setOption(latestOptionRef.current, {
          notMerge: true,
          lazyUpdate: true,
        });
        // init 可能在容器完成布局前读到 0 宽/高（Tauri WebKit 时序）——立即 resize 读真实尺寸，
        // 并用 ResizeObserver 盯容器本身（面板分栏布局变化不会触发 window resize，必须盯元素）。
        chart.resize();
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => chart?.resize());
          observer.observe(el);
        }
      })
      .catch((err) => {
        // 把被 promise 吞掉的 echarts import/init/setOption 报错暴露出来（排查空白画布）。
        console.error("[time-sync-chart] echarts 渲染失败:", err);
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.off("datazoom");
      chart?.dispose();
      if (chartInstanceRef.current === chart) {
        chartInstanceRef.current = undefined;
      }
    };
  }, []);

  return (
    <div
      className="time-sync-offset-chart"
      ref={chartElementRef}
      role="img"
      aria-label="时钟偏移曲线图"
    />
  );
}

export function normalizeTimeSyncMetrics(
  metrics: TimeSyncMetricsQueryResponse | undefined,
  options: {
    nodeLabels?: Record<string, string>;
    selectedNodeIds?: string[];
    masterNodeId?: string | null;
    masterLabel?: string;
    syncPeriodLabel?: string;
    measurePeriodLabel?: string;
  } = {},
): NormalizedChartData {
  const payload = resolvePayload(metrics);
  const selected = new Set(options.selectedNodeIds?.map(String));
  const rawSeries = payload?.series ?? [];
  const series = rawSeries
    .map((item, index) => normalizeSeries(item, index, options.nodeLabels ?? {}))
    .filter((item): item is NormalizedSeries => Boolean(item))
    .filter((item) => selected.size === 0 || selected.has(item.id))
    .filter((item) => item.id !== options.masterNodeId);
  const points = normalizePoints(rawSeries, series);
  const thresholdNs = resolveThreshold(payload);
  return {
    status: String(payload?.metrics_status ?? "idle"),
    message: payload?.message,
    thresholdNs,
    masterLabel:
      options.masterLabel ??
      (options.masterNodeId ? options.nodeLabels?.[options.masterNodeId] : undefined) ??
      "未配置",
    series,
    points,
    cards: buildMetricCards(
      options.syncPeriodLabel,
      options.measurePeriodLabel,
      thresholdNs,
      resolveDurationNs(points),
    ),
  };
}

export function buildTimeSyncNodeMetrics(
  metrics: TimeSyncMetricsQueryResponse | undefined,
): Record<string, TimeSyncNodeMetrics> {
  const payload = resolvePayload(metrics);
  if (!payload?.series || payload.series.length === 0) {
    return {};
  }
  const thresholdNs = resolveThreshold(payload);
  return Object.fromEntries(
    payload.series.flatMap((series) => {
      const nodeId = nodeIdFromSeries(series);
      if (!nodeId) {
        return [];
      }
      const values = pointsFromSeries(series)
        .map(offsetNsFromPoint)
        .filter((value): value is number => typeof value === "number");
      if (values.length === 0) {
        return [[nodeId, emptyNodeMetrics()]];
      }
      return [[nodeId, summarizeNodeOffsets(values, thresholdNs)]];
    }),
  );
}

function emptyNodeMetrics(): TimeSyncNodeMetrics {
  return EMPTY_TIME_SYNC_NODE_METRICS;
}

function resolvePayload(
  metrics: TimeSyncMetricsQueryResponse | undefined,
): TimeSyncMetricsPayload | undefined {
  if (isRecord(metrics) && isRecord(metrics.data)) {
    return metrics.data as TimeSyncMetricsPayload;
  }
  return metrics as TimeSyncMetricsPayload | undefined;
}

function normalizeSeries(
  item: TimeSyncMetricSeries,
  index: number,
  nodeLabels: Record<string, string>,
): NormalizedSeries | undefined {
  const id = nodeIdFromSeries(item);
  if (!id) {
    return undefined;
  }
  return {
    id,
    label:
      stringField(item, "label") ?? stringField(item, "name") ?? nodeLabels[id] ?? `节点 ${id}`,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  };
}

function normalizePoints(
  rawSeries: TimeSyncMetricSeries[],
  series: NormalizedSeries[],
): ChartPoint[] {
  if (rawSeries.length === 0 || series.length === 0) {
    return [];
  }
  const availableIds = new Set(series.map((item) => item.id));
  const pointByTime = new Map<string, { order: number; point: ChartPoint }>();
  for (const row of rawSeries) {
    const nodeId = nodeIdFromSeries(row);
    if (!nodeId || !availableIds.has(nodeId)) {
      continue;
    }
    for (const [pointIndex, point] of pointsFromSeries(row).entries()) {
      const time = timeFromPoint(point, pointIndex);
      const value = offsetNsFromPoint(point);
      if (!time || value === undefined) {
        continue;
      }
      const existing = pointByTime.get(time.key);
      const chartPoint = existing?.point ?? { time: time.label, __metrics: [] };
      chartPoint[nodeId] = value;
      chartPoint.__metrics?.push({
        seriesId: nodeId,
        latestOffsetNs: numberField(point, "latest_offset_ns"),
        avgOffsetNs: numberField(point, "avg_offset_ns"),
        maxAbsOffsetNs: numberField(point, "max_abs_offset_ns"),
      });
      pointByTime.set(time.key, { order: existing?.order ?? time.order, point: chartPoint });
    }
  }
  return [...pointByTime.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.point);
}

function buildTimeSyncChartOption(
  points: ChartPoint[],
  series: NormalizedSeries[],
  thresholdNs = DEFAULT_THRESHOLD_NS,
  dataZoomState?: DataZoomState,
): ECharts.EChartsOption {
  const yRange = resolveYAxisRange(points, series);
  return {
    animation: false,
    color: series.map((item) => item.color),
    // y 轴名移到左侧竖排（不占顶部纵向）→ top 收紧，把高度让给曲线。
    grid: { top: 14, right: 42, bottom: 88, left: 66 },
    tooltip: {
      trigger: "axis",
      appendToBody: true,
      extraCssText: "z-index: 2000;",
      formatter: formatTimeSyncTooltip,
    },
    legend: { show: false },
    dataZoom: [
      {
        id: DATA_ZOOM_INSIDE_ID,
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none",
        ...dataZoomState,
      },
      {
        id: DATA_ZOOM_SLIDER_ID,
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        ...dataZoomState,
        height: 22,
        bottom: 18,
        brushSelect: false,
        handleSize: 14,
        borderColor: "#d8dee8",
        fillerColor: "rgba(47, 107, 214, 0.16)",
        backgroundColor: "#f7f9fc",
        dataBackground: {
          lineStyle: { color: "#b8c5d9" },
          areaStyle: { color: "#e7edf6" },
        },
        selectedDataBackground: {
          lineStyle: { color: "#5b83d1" },
          areaStyle: { color: "#dbe7fb" },
        },
        textStyle: { color: "#6c7480", fontSize: 11 },
      },
    ],
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: points.map((point) => point.time),
      axisLine: { lineStyle: { color: "#aeb4bf" } },
      axisTick: { show: false },
      axisLabel: { color: "#9aa1ad", fontSize: 11, margin: 14 },
      splitLine: { show: true, lineStyle: { color: "#eceff3" } },
    },
    yAxis: {
      type: "value",
      min: yRange.min,
      max: yRange.max,
      interval: yRange.interval,
      name: "时钟偏移(ns)",
      nameLocation: "middle",
      nameRotate: 90,
      nameGap: 46,
      nameTextStyle: { color: "#747b87", fontSize: 12, fontWeight: 600 },
      splitLine: { lineStyle: { color: "#eceff3" } },
      axisLine: { show: true, lineStyle: { color: "#aeb4bf" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#9aa1ad",
        fontSize: 11,
        formatter: (value: number) => (value > 0 ? `+${value}` : `${value}`),
      },
    },
    series: [
      thresholdLine(`+${thresholdNs}ns`, points, thresholdNs),
      thresholdLine(`-${thresholdNs}ns`, points, -thresholdNs),
      ...series.map((item) => ({
        name: item.label,
        type: "line" as const,
        smooth: 0.25,
        symbol: "circle",
        symbolSize: 7,
        data: points.map((point) =>
          typeof point[item.id] === "number" ? (point[item.id] as number) : null,
        ),
        lineStyle: { width: 2.4 },
        itemStyle: {
          color: item.color,
          borderColor: "#ffffff",
          borderWidth: 1.5,
        },
      })),
    ],
  };
}

function thresholdLine(name: string, points: ChartPoint[], value: number) {
  return {
    id: `${THRESHOLD_SERIES_ID_PREFIX}${value > 0 ? "positive" : "negative"}`,
    name,
    type: "line" as const,
    data: points.map(() => value),
    symbol: "none",
    silent: true,
    lineStyle: { color: "#ef9a9a", width: 1.4, type: "dashed" as const },
    endLabel: {
      show: true,
      formatter: name,
      color: "#e57373",
      fontSize: 11,
    },
  };
}

function readDataZoomState(chart: ECharts.ECharts | undefined): DataZoomState | undefined {
  if (!chart) {
    return undefined;
  }
  try {
    const option = chart.getOption?.() as { dataZoom?: unknown } | undefined;
    const zooms = Array.isArray(option?.dataZoom) ? option.dataZoom.filter(isRecord) : [];
    return dataZoomStateFromRecord(
      zooms.find((zoom) => zoom.id === DATA_ZOOM_SLIDER_ID) ?? zooms[0],
    );
  } catch {
    return undefined;
  }
}

function dataZoomStateFromPayload(payload: unknown): DataZoomState | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const batches = Array.isArray(payload.batch) ? payload.batch.filter(isRecord) : undefined;
  return dataZoomStateFromRecord(batches?.[0] ?? payload);
}

function dataZoomStateFromRecord(
  record: Record<string, unknown> | undefined,
): DataZoomState | undefined {
  if (!record) {
    return undefined;
  }
  const state: DataZoomState = {};
  for (const key of ["start", "end", "startValue", "endValue"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      state[key] = value;
    } else if ((key === "startValue" || key === "endValue") && typeof value === "string") {
      state[key] = value;
    }
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function formatTimeSyncTooltip(params: unknown): string {
  const items = (Array.isArray(params) ? params : [params]).filter(isRecord);
  const dataItems = items.filter((item) => !isThresholdTooltipItem(item));
  const header = tooltipAxisLabel(items[0]);
  const rows = dataItems.flatMap((item) => {
    const value = tooltipNumericValue(item);
    if (value === undefined) {
      return [];
    }
    const marker = typeof item.marker === "string" ? item.marker : "";
    const seriesName =
      typeof item.seriesName === "string" && item.seriesName.trim() !== ""
        ? item.seriesName
        : "节点";
    return `${marker}${escapeTooltipText(seriesName)}: ${value} ns`;
  });
  return [header ? escapeTooltipText(header) : undefined, ...rows].filter(Boolean).join("<br/>");
}

function isThresholdTooltipItem(item: Record<string, unknown>): boolean {
  const seriesName = typeof item.seriesName === "string" ? item.seriesName.trim() : "";
  return (
    (typeof item.seriesId === "string" && item.seriesId.startsWith(THRESHOLD_SERIES_ID_PREFIX)) ||
    /^[+-]\d+(?:\.\d+)?ns$/.test(seriesName)
  );
}

function tooltipAxisLabel(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  for (const key of ["axisValueLabel", "axisValue", "name"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function tooltipNumericValue(item: Record<string, unknown>): number | undefined {
  const value = item.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const parsed = tooltipNumericValue({ value: value[index] });
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function escapeTooltipText(value: string): string {
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

function resolveYAxisRange(
  points: ChartPoint[],
  series: NormalizedSeries[],
): { min: number; max: number; interval: number } {
  const visibleIds = new Set(series.map((item) => item.id));
  const values = points.flatMap((point) => {
    const metricValues = point.__metrics
      ?.filter((metric) => visibleIds.has(metric.seriesId))
      .flatMap((metric) => [
        metric.latestOffsetNs,
        metric.avgOffsetNs,
        metric.maxAbsOffsetNs,
        metric.maxAbsOffsetNs === undefined ? undefined : -metric.maxAbsOffsetNs,
      ])
      .filter((value): value is number => typeof value === "number");
    return metricValues ?? [];
  });
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  const padded = maxAbs * 1.12;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const bound = niceNormalized * magnitude;
  return {
    min: -bound,
    max: bound,
    interval: bound / 2,
  };
}

function summarizeNodeOffsets(values: number[], thresholdNs: number): TimeSyncNodeMetrics {
  const absValues = values.map((value) => Math.abs(value));
  const thresholdExceedCount = absValues.filter((value) => value > thresholdNs).length;
  return {
    hasSamples: true,
    currentOffsetNs: values.at(-1) ?? 0,
    maxOffsetNs: Math.max(...values),
    minOffsetNs: Math.min(...values),
    avgOffsetNs: average(values),
    avgAbsOffsetNs: average(absValues),
    p95OffsetNs: percentile(absValues, 0.95),
    p99OffsetNs: percentile(absValues, 0.99),
    maxAbsOffsetNs: Math.max(...absValues),
    successRatePct: ((values.length - thresholdExceedCount) / values.length) * 100,
    overLimitRatePct: (thresholdExceedCount / values.length) * 100,
    validSamples: values.length,
    thresholdExceedCount,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

function buildMetricCards(
  syncPeriodLabel: string | undefined,
  measurePeriodLabel: string | undefined,
  thresholdNs: number,
  durationNs: number | undefined,
): MetricCard[] {
  return [
    { label: "时钟同步周期", value: syncPeriodLabel ?? "--" },
    { label: "链路测量周期", value: measurePeriodLabel ?? "--" },
    { label: "同步阈值", value: `±${thresholdNs} ns` },
    { label: "测试时长", value: formatDuration(durationNs) },
  ];
}

function resolveThreshold(payload: TimeSyncMetricsPayload | undefined): number {
  const threshold = payload?.runs
    ?.map((run) => run.threshold_ns)
    .find((value): value is number => typeof value === "number");
  return threshold ?? DEFAULT_THRESHOLD_NS;
}

function resolveDurationNs(points: ChartPoint[]): number | undefined {
  // 每个点是一个 1s 桶，测试时长 = 桶的时间跨度。不能用 runs.sample_count——那是样本总数
  // （硬件下每秒上报多条），当秒数会算出离谱的「1h 4m 32s」。
  return points.length > 1 ? (points.length - 1) * 1_000_000_000 : undefined;
}

function nodeIdFromSeries(item: TimeSyncMetricSeries): string | undefined {
  const firstPoint = pointsFromSeries(item).find(
    (point) => point.node_id ?? point.hcp_mid ?? point.mid,
  );
  const value =
    item.node_id ??
    item.hcp_mid ??
    item.mid ??
    firstPoint?.node_id ??
    firstPoint?.hcp_mid ??
    firstPoint?.mid;
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function offsetNsFromPoint(point: TimeSyncMetricPoint): number | undefined {
  return (
    numberField(point, "y") ??
    numberField(point, "latest_offset_ns") ??
    numberField(point, "avg_offset_ns") ??
    numberField(point, "offset_ns") ??
    numberField(point, "value_ns") ??
    numberField(point, "value")
  );
}

function pointsFromSeries(series: TimeSyncMetricSeries): TimeSyncMetricPoint[] {
  if (series.points && series.points.length > 0) {
    return series.points;
  }
  if (!series.data) {
    return series.points ?? [];
  }
  return series.data
    .map((item) => {
      if (Array.isArray(item)) {
        return { x: item[0], y: item[1] };
      }
      return item;
    })
    .filter(isRecord) as TimeSyncMetricPoint[];
}

function timeFromPoint(
  point: TimeSyncMetricPoint,
  index: number,
): { key: string; label: string; order: number } | undefined {
  const rawX = point.x;
  if (typeof rawX === "number" && Number.isFinite(rawX)) {
    return {
      key: `x:${rawX}`,
      label: formatTimeValue(rawX),
      order: rawX,
    };
  }
  if (typeof rawX === "string" && rawX.trim() !== "") {
    const numeric = Number(rawX);
    return {
      key: `x:${rawX}`,
      label: Number.isFinite(numeric) ? formatTimeValue(numeric) : rawX,
      order: Number.isFinite(numeric) ? numeric : index,
    };
  }

  const timeNs =
    numberField(point, "bucket_start_ns") ??
    numberField(point, "time_ns") ??
    numberField(point, "sim_time_ns") ??
    numberField(point, "timestamp_ns");
  if (timeNs === undefined) {
    return undefined;
  }
  return {
    key: `ns:${timeNs}`,
    label: formatNsTime(timeNs),
    order: timeNs,
  };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatNsTime(ns: number): string {
  const date = new Date(ns / 1_000_000);
  if (ns >= 86_400_000_000_000) {
    return date.toISOString().slice(11, 23);
  }
  const seconds = Math.floor(ns / 1_000_000_000);
  const millis = Math.floor((ns % 1_000_000_000) / 1_000_000);
  return `00:00:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatTimeValue(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Math.abs(value) >= 1_000_000) {
    return formatNsTime(value);
  }
  return String(value);
}

function formatDuration(ns: number | undefined): string {
  if (!ns || ns <= 0) {
    return "--";
  }
  const totalSeconds = Math.round(ns / 1_000_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
