import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ListFlowStreamRow } from "./flow-sim";
import { FlowStreamList, type FlowStreamListProps } from "./flow-stream-list";

function makeStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 0,
    class: "ST",
    pcp: 6,
    periodUs: 1000,
    frameBytes: 128,
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
    ...overrides,
  };
}

function baseProps(overrides: Partial<FlowStreamListProps> = {}): FlowStreamListProps {
  return {
    streams: [],
    selectedFlowSeq: null,
    onSelectFlowSeq: vi.fn(),
    onOpenDetail: vi.fn(),
    inFlowStage: true,
    isLoading: false,
    ...overrides,
  };
}

describe("FlowStreamList", () => {
  it("每条流渲染一行，显示类别徽章和主要信息", () => {
    const streams = [
      makeStream({ streamSeq: 0, class: "ST", talker: "es1", listener: "es2" }),
      makeStream({ streamSeq: 1, class: "RC", talker: "es2", listener: "es3" }),
      makeStream({ streamSeq: 2, class: "BE", talker: "es3", listener: "es4" }),
    ];
    render(<FlowStreamList {...baseProps({ streams })} />);
    // 每行带 F{streamSeq}
    expect(screen.getByText("F0")).toBeTruthy();
    expect(screen.getByText("F1")).toBeTruthy();
    expect(screen.getByText("F2")).toBeTruthy();
    // 类别徽章
    expect(screen.getByText("ST")).toBeTruthy();
    expect(screen.getByText("RC")).toBeTruthy();
    expect(screen.getByText("BE")).toBeTruthy();
  });

  it("ST 徽章颜色 #0072B2，RC 颜色 #009E73，BE 颜色 #E69F00", () => {
    const streams = [
      makeStream({ streamSeq: 0, class: "ST" }),
      makeStream({ streamSeq: 1, class: "RC" }),
      makeStream({ streamSeq: 2, class: "BE" }),
    ];
    render(<FlowStreamList {...baseProps({ streams })} />);
    const stBadge = screen.getByText("ST");
    const rcBadge = screen.getByText("RC");
    const beBadge = screen.getByText("BE");
    // jsdom normalizes hex to rgb(r g b) — check background attribute directly.
    expect(stBadge.getAttribute("style")).toContain("background: rgb(0, 114, 178)"); // #0072B2
    expect(rcBadge.getAttribute("style")).toContain("background: rgb(0, 158, 115)"); // #009E73
    expect(beBadge.getAttribute("style")).toContain("background: rgb(230, 159, 0)"); // #E69F00
  });

  it("点击行 → onSelectFlowSeq 收到 streamSeq", () => {
    const onSelectFlowSeq = vi.fn();
    const stream = makeStream({ streamSeq: 3 });
    render(<FlowStreamList {...baseProps({ streams: [stream], onSelectFlowSeq })} />);
    fireEvent.click(screen.getByRole("option"));
    expect(onSelectFlowSeq).toHaveBeenCalledWith(3);
  });

  it("点击已选行 → onSelectFlowSeq(null)", () => {
    const onSelectFlowSeq = vi.fn();
    const stream = makeStream({ streamSeq: 3 });
    render(
      <FlowStreamList {...baseProps({ streams: [stream], selectedFlowSeq: 3, onSelectFlowSeq })} />,
    );
    fireEvent.click(screen.getByRole("option"));
    expect(onSelectFlowSeq).toHaveBeenCalledWith(null);
  });

  it("选中行 aria-selected=true，未选行 aria-selected=false", () => {
    const streams = [makeStream({ streamSeq: 0 }), makeStream({ streamSeq: 1 })];
    render(<FlowStreamList {...baseProps({ streams, selectedFlowSeq: 0 })} />);
    const rows = screen.getAllByRole("option");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
  });

  it("「详情」按钮调 onOpenDetail，不触发行选中", () => {
    const onOpenDetail = vi.fn();
    const onSelectFlowSeq = vi.fn();
    const stream = makeStream({ streamSeq: 5 });
    render(<FlowStreamList {...baseProps({ streams: [stream], onOpenDetail, onSelectFlowSeq })} />);
    fireEvent.click(screen.getByRole("button", { name: /F5 详情/ }));
    expect(onOpenDetail).toHaveBeenCalledWith(stream);
    expect(onSelectFlowSeq).not.toHaveBeenCalled();
  });

  it("streams 为空且 !isLoading → 渲染 PanelCta，无行", () => {
    render(<FlowStreamList {...baseProps({ streams: [], isLoading: false })} />);
    expect(screen.getByRole("button", { name: "录入流量" })).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("streams 为空且 isLoading → 不渲染 PanelCta", () => {
    render(<FlowStreamList {...baseProps({ streams: [], isLoading: true })} />);
    expect(screen.queryByRole("button", { name: "录入流量" })).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("!inFlowStage → PanelCta 按钮 disabled", () => {
    render(
      <FlowStreamList {...baseProps({ streams: [], isLoading: false, inFlowStage: false })} />,
    );
    expect(screen.getByRole("button", { name: "录入流量" }).hasAttribute("disabled")).toBe(true);
  });

  it("有数据时 isLoading 不影响列表渲染", () => {
    const streams = [makeStream({ streamSeq: 0 })];
    render(<FlowStreamList {...baseProps({ streams, isLoading: true })} />);
    expect(screen.getByText("F0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "录入流量" })).toBeNull();
  });
});
