import { render, screen } from "@testing-library/react";
import type {
  CustomSeriesOption,
  CustomSeriesRenderItem,
  DataZoomComponentOption,
  TooltipComponentOption,
  YAXisComponentOption,
} from "echarts";
import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "./chart-palette";
import type { GclDisplayModel, GclWindowRow } from "./flow-sim";
import { buildGanttOption, type GanttDatum, GclGanttChart, ganttHeightPx } from "./gcl-gantt-chart";

function makeWindow(overrides: Partial<GclWindowRow> = {}): GclWindowRow {
  return {
    node: "0",
    nodeName: "sw1",
    ethN: 1,
    entryIdx: 0,
    startNs: 0,
    durationNs: 100_000,
    gateStates: 0x80,
    flowRefs: [{ seq: 0, source: "derived" }],
    ...overrides,
  };
}

/** 两组五窗夹具（组=节点.端口，display model 已过筛，组件不再自己筛）：
 * sw1.G1 = 单流窗 + 空窗；sw2.G2 = 双流窗 + 三流窗 + class 降级窗。 */
function makeModel(): GclDisplayModel {
  return {
    groups: [
      {
        node: "0",
        nodeName: "sw1",
        ethN: 1,
        windows: [
          makeWindow(),
          makeWindow({ entryIdx: 1, startNs: 100_000, durationNs: 900_000, flowRefs: null }),
        ],
      },
      {
        node: "1",
        nodeName: "sw2",
        ethN: 2,
        windows: [
          makeWindow({
            node: "1",
            nodeName: "sw2",
            ethN: 2,
            startNs: 100_000,
            durationNs: 50_000,
            flowRefs: [
              { seq: 0, source: "derived" },
              { seq: 1, source: "derived" },
            ],
          }),
          makeWindow({
            node: "1",
            nodeName: "sw2",
            ethN: 2,
            entryIdx: 1,
            startNs: 200_000,
            durationNs: 50_000,
            flowRefs: [
              { seq: 0, source: "derived" },
              { seq: 1, source: "derived" },
              { seq: 2, source: "derived" },
            ],
          }),
          makeWindow({
            node: "1",
            nodeName: "sw2",
            ethN: 2,
            entryIdx: 2,
            startNs: 300_000,
            durationNs: 50_000,
            flowRefs: [{ seq: 5, source: "class" }],
          }),
        ],
      },
    ],
    flowNames: new Map([
      [0, "视频流"],
      [1, "控制流"],
      [2, "雷达流"],
    ]),
  };
}

const CYCLE_NS = 1_000_000;

function seriesData(model: GclDisplayModel, degradedSeqs?: Set<number>): GanttDatum[] {
  const option = buildGanttOption(model, CYCLE_NS, degradedSeqs);
  const series = (option.series as CustomSeriesOption[])[0];
  return series.data as GanttDatum[];
}

describe("buildGanttOption", () => {
  it("Y 轴类目 = 节点名.G{ethN} 行标签，倒序使 model 第一组在顶部", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const yAxis = option.yAxis as YAXisComponentOption & { data: string[] };
    expect(yAxis.type).toBe("category");
    expect(yAxis.data).toEqual(["sw2.G2", "sw1.G1"]);
  });

  it("X 轴 value 0..cycleNs/1000（μs）", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const xAxis = option.xAxis as { type: string; min: number; max: number };
    expect(xAxis.type).toBe("value");
    expect(xAxis.min).toBe(0);
    expect(xAxis.max).toBe(1000);
  });

  it("data 条目数 = 窗口总数，categoryIdx 映射到倒序类目", () => {
    const data = seriesData(makeModel());
    expect(data).toHaveLength(5);
    // sw1.G1（model 第一组）→ 倒序后类目下标 1；sw2.G2 → 0。
    expect(data[0][0]).toBe(1);
    expect(data[1][0]).toBe(1);
    expect(data[2][0]).toBe(0);
    // startUs/endUs = ns/1000。
    expect(data[2][1]).toBe(100);
    expect(data[2][2]).toBe(150);
  });

  it("单流窗按流 seq 对 CHART_COLORS 取模着色，徽章 F{seq}", () => {
    const data = seriesData(makeModel());
    expect(data[0][5]).toBe(CHART_COLORS[0]);
    expect(data[0][6]).toBe("F0");
  });

  it("双流窗徽章并排「F0 F1」，颜色取首个关联流", () => {
    const data = seriesData(makeModel());
    expect(data[2][6]).toBe("F0 F1");
    expect(data[2][5]).toBe(CHART_COLORS[0]);
  });

  it("三流窗徽章折叠「F0 +2」", () => {
    const data = seriesData(makeModel());
    expect(data[3][6]).toBe("F0 +2");
  });

  it("class 降级窗 = 中性灰 #8c8c8c + 徽章「ST 类」", () => {
    const data = seriesData(makeModel());
    expect(data[4][5]).toBe("#8c8c8c");
    expect(data[4][6]).toBe("ST 类");
    expect(data[4][4]).toBe("ST 类");
  });

  it("空窗 = 浅灰 #e5e7eb、无徽章、关联流文本「空窗」", () => {
    const data = seriesData(makeModel());
    expect(data[1][5]).toBe("#e5e7eb");
    expect(data[1][6]).toBe("");
    expect(data[1][4]).toBe("空窗");
  });

  it("degradedSeqs 命中的 derived 窗同样降级为灰 +「ST 类」", () => {
    const model = makeModel();
    const data = seriesData(model, new Set([0]));
    expect(data[0][5]).toBe("#8c8c8c");
    expect(data[0][6]).toBe("ST 类");
  });

  it("tooltip formatter 悬浮卡含行标签/区间/持续/队列/门控操作/关联流全部字段", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const tooltip = option.tooltip as TooltipComponentOption;
    const formatter = tooltip.formatter as (params: unknown) => string;
    // data[2] = sw2.G2 双流窗（100–150μs，gateStates=0x80 → q7 开）。
    const html = formatter({ dataIndex: 2 });
    expect(html).toContain("sw2.G2");
    expect(html).toContain("时间区间：100.0 – 150.0 μs");
    expect(html).toContain("持续：50.0 μs");
    expect(html).toContain("打开队列：q7");
    expect(html).toContain("门控操作：set-gate-states");
    expect(html).toContain("关联流：F0·视频流 F1·控制流");
  });

  it("tooltip formatter 对空窗输出「空窗」，无效 params 回空串", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const formatter = (option.tooltip as TooltipComponentOption).formatter as (
      params: unknown,
    ) => string;
    expect(formatter({ dataIndex: 1 })).toContain("关联流：空窗");
    expect(formatter({})).toBe("");
    expect(formatter({ dataIndex: 99 })).toBe("");
  });

  it("dataZoom = inside + slider，均 weakFilter 挂 x 轴", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const zooms = option.dataZoom as DataZoomComponentOption[];
    expect(zooms.map((z) => z.type)).toEqual(["inside", "slider"]);
    for (const z of zooms) {
      expect(z.filterMode).toBe("weakFilter");
      expect(z.xAxisIndex).toBe(0);
    }
  });

  it("renderItem 输出 group：圆角 rect 着窗色 + 居中徽章 text", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const renderItem = (option.series as CustomSeriesOption[])[0]
      .renderItem as CustomSeriesRenderItem;
    const params = {
      dataIndex: 2,
      coordSys: { type: "cartesian2d", x: 0, y: 0, width: 1000, height: 72 },
    } as unknown as Parameters<CustomSeriesRenderItem>[0];
    const api = {
      coord: ([xVal, yVal]: [number, number]) => [xVal, yVal * 36 + 18],
      size: () => [0, 36],
    } as unknown as Parameters<CustomSeriesRenderItem>[1];
    const el = renderItem(params, api) as {
      type: string;
      children: Array<{ type: string; shape?: { r: number }; style: Record<string, unknown> }>;
    };
    expect(el.type).toBe("group");
    expect(el.children[0].type).toBe("rect");
    expect(el.children[0].shape?.r).toBe(3);
    expect(el.children[0].style.fill).toBe(CHART_COLORS[0]);
    expect(el.children[1].type).toBe("text");
    expect(el.children[1].style.text).toBe("F0 F1");
  });

  it("renderItem 完全出坐标区的窗返回 null（裁剪）", () => {
    const option = buildGanttOption(makeModel(), CYCLE_NS);
    const renderItem = (option.series as CustomSeriesOption[])[0]
      .renderItem as CustomSeriesRenderItem;
    const params = {
      dataIndex: 2,
      coordSys: { type: "cartesian2d", x: 0, y: 0, width: 1000, height: 72 },
    } as unknown as Parameters<CustomSeriesRenderItem>[0];
    const api = {
      // 把窗坐标映射到坐标区右侧之外。
      coord: ([xVal, yVal]: [number, number]) => [xVal + 5000, yVal * 36 + 18],
      size: () => [0, 36],
    } as unknown as Parameters<CustomSeriesRenderItem>[1];
    expect(renderItem(params, api)).toBeNull();
  });
});

describe("ganttHeightPx", () => {
  it("按行数线性递增", () => {
    const step = ganttHeightPx(2) - ganttHeightPx(1);
    expect(step).toBeGreaterThan(0);
    expect(ganttHeightPx(5) - ganttHeightPx(4)).toBe(step);
    expect(ganttHeightPx(10)).toBe(ganttHeightPx(0) + 10 * step);
  });
});

describe("GclGanttChart 组件", () => {
  it("空 model 渲染「无窗口数据」占位，不初始化 chart", () => {
    render(<GclGanttChart model={{ groups: [], flowNames: new Map() }} cycleNs={CYCLE_NS} />);
    expect(screen.getByRole("status")).toHaveTextContent("无窗口数据");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
