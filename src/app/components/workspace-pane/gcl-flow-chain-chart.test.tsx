import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FlowChain, FlowRefDto, GclDetail, GclWindowRow, ListFlowStreamRow } from "./flow-sim";
import { buildChainDataItems, buildChainOption, GclFlowChainChart } from "./gcl-flow-chain-chart";

// jsdom 无 canvas——mock echarts init 桩（照 time-sync-offset-chart.test.tsx 手法）。
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

// ── 纯函数层 fixture：两跳流（串行化 4560ns + 处理 2000ns 零偏差链）──────────────

function twoHopChain(): FlowChain {
  return {
    streamSeq: 0,
    name: "视频流",
    hops: [
      {
        node: "ES-1",
        txWindows: [
          [0, 4560],
          [500000, 504560],
        ],
        rxWindows: null,
        inconsistent: false,
      },
      {
        node: "SW-0",
        txWindows: [
          [6560, 11120],
          [506560, 511120],
        ],
        rxWindows: [
          [6560, 11120],
          [506560, 511120],
        ],
        inconsistent: false,
      },
    ],
    sendWindows: [
      [0, 4560],
      [500000, 504560],
    ],
    receiveWindows: [
      [6560, 11120],
      [506560, 511120],
    ],
  };
}

describe("buildChainDataItems（窗口链 → 逐跳逐实例条目）", () => {
  it("两跳流：首跳 send 无入窗、末跳 forward 带入窗/连线起点/收段，ns→μs 换算", () => {
    const items = buildChainDataItems(twoHopChain());
    expect(items.length).toBe(4);
    expect(items[0]).toMatchObject({
      hopIdx: 0,
      instanceIdx: 0,
      node: "ES-1",
      kind: "send",
      isLast: false,
      txStartUs: 0,
      txEndUs: 4.56,
      rxStartUs: null,
      prevTxEndUs: null,
      receiveStartUs: null,
      inconsistent: false,
    });
    expect(items[2]).toMatchObject({
      hopIdx: 1,
      instanceIdx: 0,
      node: "SW-0",
      kind: "forward",
      isLast: true,
      txStartUs: 6.56,
      txEndUs: 11.12,
      rxStartUs: 6.56,
      rxEndUs: 11.12,
      prevTxEndUs: 4.56,
      receiveStartUs: 6.56,
      receiveEndUs: 11.12,
    });
    // 第二实例配对：上一跳出窗尾 504.56μs。
    expect(items[3]).toMatchObject({ instanceIdx: 1, txStartUs: 506.56, prevTxEndUs: 504.56 });
  });

  it("sanity 不一致跳：条目带 inconsistent 标记（KTD9）", () => {
    const chain = twoHopChain();
    chain.hops[1].inconsistent = true;
    const items = buildChainDataItems(chain);
    expect(items[2].inconsistent).toBe(true);
    expect(items[0].inconsistent).toBe(false);
  });
});

describe("buildChainOption（U7 option 构建纯函数）", () => {
  it("类目顺序 = 路径节点（inverse=true 顶部 talker）；custom series 逐实例数据；X 上限 = 超周期 μs", () => {
    const option = buildChainOption(twoHopChain(), 1_000_000);
    const y = option.yAxis as { type: string; data: string[]; inverse: boolean };
    expect(y.type).toBe("category");
    expect(y.data).toEqual(["ES-1", "SW-0"]);
    expect(y.inverse).toBe(true);
    const series = (Array.isArray(option.series) ? option.series[0] : option.series) as {
      type: string;
      data: Array<[number, number, number]>;
    };
    expect(series.type).toBe("custom");
    expect(series.data.length).toBe(4);
    expect(series.data[0]).toEqual([0, 4.56, 0]);
    const x = option.xAxis as { max?: number };
    expect(x.max).toBe(1000);
    // dataZoom inside + slider（weakFilter）。
    const zooms = option.dataZoom as Array<{ type: string; filterMode: string }>;
    expect(zooms.map((z) => z.type)).toEqual(["inside", "slider"]);
    expect(zooms.every((z) => z.filterMode === "weakFilter")).toBe(true);
  });

  it("tooltip formatter：跳节点名 + 出入站时间戳 + 数据来源 + 固定免责尾注", () => {
    const option = buildChainOption(twoHopChain(), 1_000_000);
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    const html = formatter({ dataIndex: 2 });
    expect(html).toContain("视频流 · SW-0");
    expect(html).toContain("入站时间戳: 6.56 – 11.12 μs");
    expect(html).toContain("出站时间戳: 6.56 – 11.12 μs");
    expect(html).toContain("持续: 4.56 μs");
    expect(html).toContain("接收窗口: 6.56 – 11.12 μs");
    expect(html).toContain("数据来源: GCL 规划结果");
    expect(html).toContain("时间戳为门控窗口边界，不代表报文实际到达时刻");
    expect(html).not.toContain("时延常数与求解器建模不一致");
    // 首跳（talker）：无入站行、也有免责尾注。
    const first = formatter({ dataIndex: 0 });
    expect(first).not.toContain("入站时间戳");
    expect(first).toContain("时间戳为门控窗口边界，不代表报文实际到达时刻");
  });

  it("sanity 不一致跳：tooltip 加「时延常数与求解器建模不一致」提示", () => {
    const chain = twoHopChain();
    chain.hops[1].inconsistent = true;
    const option = buildChainOption(chain, 1_000_000);
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    expect(formatter({ dataIndex: 2 })).toContain("时延常数与求解器建模不一致");
  });
});

// ── 组件层 fixture：GclDetail（与 flow-sim.test.ts twoFlowDetail 同型两流两跳）──────

function stStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 0,
    class: "ST",
    pcp: 7,
    periodUs: 500,
    frameBytes: 512,
    count: 10000,
    talker: "1",
    listener: "2",
    maxLatencyUs: null,
    redundant: false,
    srcMac: null,
    dstMac: null,
    vlanId: null,
    earliestSendOffsetNs: null,
    latestSendOffsetNs: null,
    name: null,
    jitterNs: null,
    srcIp: null,
    dstIp: null,
    srcL4Port: null,
    dstL4Port: null,
    l4Protocol: null,
    nodePath: ["ES-1", "SW-0", "ES-2"],
    paths: null,
    ...overrides,
  };
}

function win(
  node: string,
  nodeName: string,
  ethN: number,
  entryIdx: number,
  startNs: number,
  durationNs: number,
  gateStates: number,
  flowRefs: FlowRefDto[] | null = null,
): GclWindowRow {
  return { node, nodeName, ethN, entryIdx, startNs, durationNs, gateStates, flowRefs };
}

function twoFlowDetail(): GclDetail {
  const d = (seq: number): FlowRefDto[] => [{ seq, source: "derived" }];
  return {
    windows: [
      win("1", "ES-1", 0, 0, 0, 4560, 0x80, d(0)),
      win("1", "ES-1", 0, 1, 10000, 4560, 0x80, d(1)),
      win("0", "SW-0", 1, 0, 6560, 4560, 0x80, d(0)),
      win("0", "SW-0", 1, 1, 16560, 4560, 0x80, d(1)),
    ],
    meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: false },
    streams: [
      stStream({ streamSeq: 0, name: "ST流0" }),
      stStream({ streamSeq: 1, periodUs: 1000, name: "ST流1" }),
    ],
  };
}

describe("GclFlowChainChart（流量维度页签组件）", () => {
  it("降级流不在可选列表（R9 整链隐藏）+ 降级数提示文案", () => {
    const detail = twoFlowDetail();
    // s1 的下游窗降级为类级 → 整链隐藏。
    const w = detail.windows.find((x) => x.startNs === 16560);
    if (w) {
      w.flowRefs = [{ seq: 1, source: "class" }];
    }
    render(<GclFlowChainChart detail={detail} selectedFlowSeq={null} onSelectFlow={vi.fn()} />);
    expect(screen.getByRole("button", { name: "F0·ST流0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ST流1/ })).toBeNull();
    expect(screen.getByText("1 条流因关联精度不足未显示")).toBeInTheDocument();
  });

  it("selectedFlowSeq 无效（null / 不在链集）→ 默认选中首条可用流", () => {
    const { rerender } = render(
      <GclFlowChainChart detail={twoFlowDetail()} selectedFlowSeq={null} onSelectFlow={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "F0·ST流0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "F1·ST流1" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    rerender(
      <GclFlowChainChart detail={twoFlowDetail()} selectedFlowSeq={99} onSelectFlow={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "F0·ST流0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("点击流按钮 → onSelectFlow(seq)；选中流跟随 selectedFlowSeq", () => {
    const onSelectFlow = vi.fn();
    render(
      <GclFlowChainChart
        detail={twoFlowDetail()}
        selectedFlowSeq={1}
        onSelectFlow={onSelectFlow}
      />,
    );
    expect(screen.getByRole("button", { name: "F1·ST流1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "F0·ST流0" }));
    expect(onSelectFlow).toHaveBeenCalledWith(0);
  });

  it("空 chains（无窗口/无 ST 流）→ 「无可显示的流窗口链」占位", () => {
    const detail: GclDetail = {
      windows: [],
      meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: false },
      streams: [],
    };
    render(<GclFlowChainChart detail={detail} selectedFlowSeq={null} onSelectFlow={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("无可显示的流窗口链");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
