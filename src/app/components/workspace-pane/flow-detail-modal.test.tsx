import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FlowDetailModal } from "./flow-detail-modal";
import type { ListFlowStreamRow } from "./flow-sim";

vi.mock("./flow-sim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./flow-sim")>();
  return {
    ...actual,
    invokeUpdateFlowStream: vi.fn(async () => undefined),
  };
});

import { invokeUpdateFlowStream } from "./flow-sim";

function makeStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 1,
    class: "ST",
    pcp: 6,
    periodUs: 1000,
    frameBytes: 100,
    count: 1,
    talker: "ES-1",
    listener: "ES-2",
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

describe("FlowDetailModal", () => {
  it("stream=null 时不渲染弹窗", () => {
    render(<FlowDetailModal stream={null} sessionId="s1" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stream 切换为 null 后擦除旧表单（避免再开时闪旧值）", () => {
    const { rerender } = render(
      <FlowDetailModal
        stream={makeStream({ periodUs: 500 })}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<FlowDetailModal stream={null} sessionId="s1" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("保存规划字段变更 → onSaved(true) + onClose", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce(undefined);
    render(
      <FlowDetailModal
        stream={makeStream({ periodUs: 1000 })}
        sessionId="s1"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    const periodInput = screen.getByLabelText(/帧发送间隔/);
    await user.clear(periodInput);
    await user.type(periodInput, "2000");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(true));
    expect(onClose).toHaveBeenCalled();
  });

  it("保存非规划字段（srcMac）→ onSaved(false)", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce(undefined);
    render(
      <FlowDetailModal stream={makeStream()} sessionId="s1" onClose={vi.fn()} onSaved={onSaved} />,
    );
    const macInput = screen.getByLabelText(/^源MAC/);
    await user.type(macInput, "00:11:22:33:44:55");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(false));
  });

  it("保存失败 → 显示 errorMessage，不调 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(invokeUpdateFlowStream).mockRejectedValueOnce(new Error("db error"));
    render(
      <FlowDetailModal stream={makeStream()} sessionId="s1" onClose={onClose} onSaved={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText(/db error/)).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ESC 键关闭弹窗", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <FlowDetailModal stream={makeStream()} sessionId="s1" onClose={onClose} onSaved={vi.fn()} />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("点 backdrop 关闭弹窗", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <FlowDetailModal stream={makeStream()} sessionId="s1" onClose={onClose} onSaved={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "关闭流量详情" }));
    expect(onClose).toHaveBeenCalled();
  });
});
