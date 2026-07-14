import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GclDetail, GclWindowRow, ListFlowStreamRow } from "./flow-sim";
import { GclDetailModal } from "./gcl-detail-modal";

function makeStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 0,
    class: "ST",
    pcp: 6,
    periodUs: 1000,
    frameBytes: 100,
    count: 1,
    talker: "es1",
    listener: "es2",
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
    nodePath: [],
    ...overrides,
  };
}

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

/** 两窗夹具：一窗带 derived refs（bit7 开）、一窗空窗（q0-q6 开态位图 0x7F）。 */
function makeDetail(overrides: Partial<GclDetail> = {}): GclDetail {
  return {
    windows: [
      makeWindow(),
      makeWindow({
        entryIdx: 1,
        startNs: 100_000,
        durationNs: 900_000,
        gateStates: 0x7f,
        flowRefs: null,
      }),
    ],
    meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: false },
    streams: [makeStream({ streamSeq: 0, name: "视频流" })],
    ...overrides,
  };
}

function renderModal(
  detail: GclDetail | (() => Promise<GclDetail>),
  props: Partial<Parameters<typeof GclDetailModal>[0]> = {},
) {
  const getGclDetail = typeof detail === "function" ? vi.fn(detail) : vi.fn(async () => detail);
  const onClose = vi.fn();
  const utils = render(
    <GclDetailModal open sessionId="s1" onClose={onClose} getGclDetail={getGclDetail} {...props} />,
  );
  return { ...utils, getGclDetail, onClose };
}

describe("GclDetailModal", () => {
  it("open=false 不渲染、不拉数据", () => {
    const getGclDetail = vi.fn(async () => makeDetail());
    render(
      <GclDetailModal open={false} sessionId="s1" onClose={vi.fn()} getGclDetail={getGclDetail} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getGclDetail).not.toHaveBeenCalled();
  });

  it("头部元信息（buildGclOverview）：周期/端口数/打开窗口数", async () => {
    renderModal(makeDetail());
    expect(
      await screen.findByText(
        /展示周期 1000\.0 μs · 超周期 1000\.0 μs · 1 个门控端口 · 2 个打开窗口/,
      ),
    ).toBeInTheDocument();
  });

  it("三页签切换：默认门控可视化占位，切流量维度/门控表", async () => {
    const user = userEvent.setup();
    renderModal(makeDetail());
    // 默认页签 = 门控可视化（U6 占位容器）。
    expect(await screen.findByTestId("gcl-gantt-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("gcl-chain-slot")).not.toBeInTheDocument();
    // 切流量维度（U7 占位容器）。
    await user.click(screen.getByRole("tab", { name: "流量维度" }));
    expect(screen.getByTestId("gcl-chain-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("gcl-gantt-slot")).not.toBeInTheDocument();
    // 切门控表（本单元完整实现）。
    await user.click(screen.getByRole("tab", { name: "门控表" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("ESC 键关闭弹窗", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal(makeDetail());
    await screen.findByTestId("gcl-gantt-slot");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("点 backdrop 关闭弹窗", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal(makeDetail());
    await user.click(screen.getByRole("button", { name: "关闭门控详情" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("R13 加载中：显示加载指示、不出页签", () => {
    renderModal(() => new Promise<GclDetail>(() => {}));
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("R13 失败：错误文案 + 重试按钮，重试后恢复", async () => {
    const user = userEvent.setup();
    const getGclDetail = vi
      .fn<(sessionId: string) => Promise<GclDetail>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(makeDetail());
    render(<GclDetailModal open sessionId="s1" onClose={vi.fn()} getGclDetail={getGclDetail} />);
    expect(await screen.findByText(/门控明细读取失败：db down/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("gcl-gantt-slot")).toBeInTheDocument();
    expect(getGclDetail).toHaveBeenCalledTimes(2);
  });

  it("R13/AE6 空态：meta null 或无窗 → 提示重新规划、不渲染页签内容", async () => {
    // meta null（老工程从未规划）。
    const { unmount } = renderModal({ windows: [], meta: null, streams: [] });
    expect(await screen.findByText("请重新规划以生成门控明细")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    unmount();
    // meta 有行但无窗（no_gating 清表后）。
    renderModal(makeDetail({ windows: [] }));
    expect(await screen.findByText("请重新规划以生成门控明细")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("R10 门控表全列：圆点位图/关联流徽章/空窗/μs 换算/门控操作常量", async () => {
    const user = userEvent.setup();
    renderModal(makeDetail());
    await screen.findByTestId("gcl-gantt-slot");
    await user.click(screen.getByRole("tab", { name: "门控表" }));

    // 全列表头。
    for (const th of [
      "节点",
      "端口",
      "索引",
      "开始(μs)",
      "结束(μs)",
      "持续(μs)",
      "门控操作",
      "门控状态",
      "关联流",
    ]) {
      expect(screen.getByRole("columnheader", { name: th })).toBeInTheDocument();
    }

    const table = within(screen.getByRole("table"));
    const bodyRows = screen.getAllByRole("row").slice(1); // [0] 表头。
    expect(bodyRows.length).toBe(2);
    // 行1（gateStates=0x80）：实心 1 个（q7）；行2（0x7F）：实心 7 个（q0-q6）。
    expect(bodyRows[0].querySelectorAll(".gcl-q-dot.on").length).toBe(1);
    expect(bodyRows[1].querySelectorAll(".gcl-q-dot.on").length).toBe(7);
    // 关联流：行1 徽章 F0·流名，行2 空窗（scope 到表内——筛选下拉 option 同文案）。
    expect(table.getByText("F0·视频流")).toBeInTheDocument();
    expect(table.getByText("空窗")).toBeInTheDocument();
    // 端口 G{ethN} + ns→μs 除以 1000 保留 1 位小数（行2：100.0 → 1000.0，持续 900.0）。
    expect(table.getAllByText("G1").length).toBe(2);
    expect(table.getByText("900.0")).toBeInTheDocument();
    expect(table.getByText("1000.0")).toBeInTheDocument();
    // 门控操作常量列。
    expect(table.getAllByText("set-gate-states").length).toBe(2);
    // 筛选结果条数。
    expect(screen.getByText("筛选结果 2 条")).toBeInTheDocument();
  });

  it("R10：class 降级引用显示「ST 类」徽章", async () => {
    const user = userEvent.setup();
    renderModal(
      makeDetail({
        windows: [makeWindow({ flowRefs: [{ seq: 0, source: "class" }] })],
      }),
    );
    await screen.findByTestId("gcl-gantt-slot");
    await user.click(screen.getByRole("tab", { name: "门控表" }));
    const table = within(screen.getByRole("table"));
    expect(table.getByText("ST 类")).toBeInTheDocument();
    expect(table.queryByText(/F0·/)).not.toBeInTheDocument();
  });

  it("R7 节点筛选：行数变化 + 条数文案联动", async () => {
    const user = userEvent.setup();
    renderModal(
      makeDetail({
        windows: [
          makeWindow(),
          makeWindow({ node: "1", nodeName: "sw2", entryIdx: 0, startNs: 200_000 }),
        ],
      }),
    );
    await screen.findByTestId("gcl-gantt-slot");
    await user.click(screen.getByRole("tab", { name: "门控表" }));
    expect(screen.getAllByRole("row").length - 1).toBe(2);
    expect(screen.getByText("筛选结果 2 条")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("节点"), "sw2");
    expect(screen.getAllByRole("row").length - 1).toBe(1);
    expect(screen.getByText("筛选结果 1 条")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "sw2" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "sw1" })).not.toBeInTheDocument();
  });

  it("Covers AE4：CSV 导出——BOM 首字符 + 中文列头 + q0-q7 八列 + 行数=筛选后行数", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    let downloadName = "";
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    try {
      renderModal(
        makeDetail({
          windows: [
            makeWindow(),
            makeWindow({ node: "1", nodeName: "sw2", entryIdx: 0, startNs: 200_000 }),
          ],
        }),
      );
      await screen.findByTestId("gcl-gantt-slot");
      await user.click(screen.getByRole("tab", { name: "门控表" }));
      // 先筛选节点 sw1 → 导出仅含筛选后行。
      await user.selectOptions(screen.getByLabelText("节点"), "sw1");
      await user.click(screen.getByRole("button", { name: "导出 Excel" }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0];
      // jsdom Blob 无 .text()，走 FileReader 读字节（readAsText 的 UTF-8 解码会剥掉 BOM）。
      const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });
      // UTF-8 BOM 前缀（EF BB BF）。
      expect([...new Uint8Array(buf.slice(0, 3))]).toEqual([0xef, 0xbb, 0xbf]);
      // 中文列头 + gate_states 展开八列（TextDecoder 默认剥 BOM，内容断言不含它）。
      const text = new TextDecoder("utf-8").decode(buf);
      expect(text).toContain("节点,端口,索引,开始(μs),结束(μs),持续(μs),门控操作");
      expect(text).toContain("q0,q1,q2,q3,q4,q5,q6,q7,关联流");
      // 行数 = 列头 + 筛选后 1 行。
      const lines = text.split("\n");
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain("sw1,G1,0,0.0,100.0,100.0,set-gate-states,0,0,0,0,0,0,0,1");
      expect(lines[1]).toContain("F0·视频流");
      // 文件名 + 无泄漏。
      expect(downloadName).toBe("gcl-windows-s1.csv");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    } finally {
      clickSpy.mockRestore();
    }
  });
});
