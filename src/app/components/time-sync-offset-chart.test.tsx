import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildTimeSyncNodeMetrics,
  type TimeSyncMetricsQueryResponse,
  TimeSyncOffsetChart,
} from "./time-sync-offset-chart";

const echartsMock = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  getOption: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock("echarts", () => ({
  init: vi.fn(() => echartsMock),
  getInstanceByDom: vi.fn(() => undefined),
}));

function sampleMetrics(): TimeSyncMetricsQueryResponse {
  return {
    task_id: "time-sync-task-1",
    metric: "time_sync",
    metrics_status: "ready",
    mode: "series",
    source: "simulation",
    runs: [{ threshold_ns: 1000, sample_count: 3, status: "ready" }],
    series: [
      {
        node_id: "1",
        label: "GM-1",
        points: [
          {
            bucket_start_ns: 0,
            latest_offset_ns: 0,
            avg_offset_ns: 0,
            max_abs_offset_ns: 0,
          },
        ],
      },
      {
        node_id: "2",
        label: "ES-2",
        points: [
          {
            bucket_start_ns: 0,
            latest_offset_ns: 4,
            avg_offset_ns: 3,
            max_abs_offset_ns: 40,
          },
          {
            bucket_start_ns: 10_000_000,
            latest_offset_ns: -8,
            avg_offset_ns: -6,
            max_abs_offset_ns: 120,
          },
          {
            bucket_start_ns: 20_000_000,
            latest_offset_ns: 12,
            avg_offset_ns: 9,
            max_abs_offset_ns: 320,
          },
        ],
      },
    ],
  };
}

function appendPoint(metrics: TimeSyncMetricsQueryResponse): TimeSyncMetricsQueryResponse {
  const next = structuredClone(metrics) as Extract<
    TimeSyncMetricsQueryResponse,
    { series?: unknown }
  >;
  const series = next.series?.find((item) => String(item.node_id) === "2");
  series?.points?.push({
    bucket_start_ns: 30_000_000,
    latest_offset_ns: 18,
    avg_offset_ns: 12,
    max_abs_offset_ns: 360,
  });
  return next;
}

describe("TimeSyncOffsetChart", () => {
  it("使用最新、平均、最大绝对偏差计算曲线范围，并展示 dataZoom 与周期信息", async () => {
    echartsMock.setOption.mockClear();
    echartsMock.getOption.mockReset().mockReturnValue(undefined);
    echartsMock.on.mockClear();
    echartsMock.off.mockClear();

    render(
      <TimeSyncOffsetChart
        metrics={sampleMetrics()}
        masterNodeId="1"
        masterLabel="GM-1"
        syncPeriodLabel="125 ms"
        measurePeriodLabel="1024 ms"
      />,
    );

    expect(screen.getByText("时钟同步周期")).toBeInTheDocument();
    expect(screen.getByText("125 ms")).toBeInTheDocument();
    expect(screen.getByText("链路测量周期")).toBeInTheDocument();
    expect(screen.getByText("1024 ms")).toBeInTheDocument();
    expect(screen.queryByText("最新最大偏差")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "时钟偏移曲线图" })).toBeInTheDocument();

    await waitFor(() => expect(echartsMock.setOption).toHaveBeenCalled());

    const option = echartsMock.setOption.mock.calls.at(-1)?.[0] as {
      dataZoom: Array<{ id: string; type: string }>;
      series: Array<{ data: Array<number | null> }>;
      tooltip: {
        appendToBody: boolean;
        extraCssText: string;
        formatter: (params: unknown) => string;
      };
      yAxis: { min: number; max: number; interval: number };
    };
    expect(option.dataZoom.map((item) => item.type)).toEqual(["inside", "slider"]);
    expect(option.dataZoom.map((item) => item.id)).toEqual([
      "time-sync-offset-datazoom-inside",
      "time-sync-offset-datazoom-slider",
    ]);
    expect(option.tooltip.appendToBody).toBe(true);
    expect(option.tooltip.extraCssText).toContain("z-index: 2000");
    expect(option.series[2]?.data).toEqual([4, -8, 12]);
    expect(option.yAxis).toMatchObject({ min: -500, max: 500, interval: 250 });
    expect(
      option.tooltip.formatter([
        {
          axisValueLabel: "00:00:00.000",
          seriesName: "+1000ns",
          value: 1000,
          marker: "<span></span>",
        },
        {
          axisValueLabel: "00:00:00.000",
          seriesName: "ES-2",
          value: 4,
          marker: "<span></span>",
        },
        {
          axisValueLabel: "00:00:00.000",
          seriesName: "-1000ns",
          value: -1000,
          marker: "<span></span>",
        },
      ]),
    ).toBe("00:00:00.000<br/><span></span>ES-2: 4 ns");
  });

  it("轮询刷新数据时保留用户当前 dataZoom 窗口", async () => {
    echartsMock.setOption.mockClear();
    echartsMock.getOption.mockReset().mockReturnValue({
      dataZoom: [
        {
          id: "time-sync-offset-datazoom-slider",
          start: 35,
          end: 88,
        },
      ],
    });

    const { rerender } = render(
      <TimeSyncOffsetChart
        metrics={sampleMetrics()}
        masterNodeId="1"
        masterLabel="GM-1"
        syncPeriodLabel="125 ms"
        measurePeriodLabel="1024 ms"
      />,
    );
    await waitFor(() => expect(echartsMock.setOption).toHaveBeenCalled());
    echartsMock.setOption.mockClear();

    rerender(
      <TimeSyncOffsetChart
        metrics={appendPoint(sampleMetrics())}
        masterNodeId="1"
        masterLabel="GM-1"
        syncPeriodLabel="125 ms"
        measurePeriodLabel="1024 ms"
      />,
    );

    await waitFor(() => expect(echartsMock.setOption).toHaveBeenCalled());
    const option = echartsMock.setOption.mock.calls.at(-1)?.[0] as {
      dataZoom: Array<{ start?: number; end?: number }>;
    };
    expect(option.dataZoom).toEqual([
      expect.objectContaining({ start: 35, end: 88 }),
      expect.objectContaining({ start: 35, end: 88 }),
    ]);
  });

  it("节点汇总指标只从 offset 字段归一化，不依赖接口请求逻辑", () => {
    const metrics = buildTimeSyncNodeMetrics(sampleMetrics());

    expect(metrics["2"]).toMatchObject({
      hasSamples: true,
      currentOffsetNs: 12,
      maxOffsetNs: 12,
      minOffsetNs: -8,
      maxAbsOffsetNs: 12,
      thresholdExceedCount: 0,
    });
  });
});
