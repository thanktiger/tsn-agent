import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FlowDetailModal } from "./flow-detail-modal";
import type { GetFlowPathCandidatesResult, ListFlowStreamRow } from "./flow-sim";

vi.mock("./flow-sim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./flow-sim")>();
  return {
    ...actual,
    invokeUpdateFlowStream: vi.fn(async () => ({ planningFieldsChanged: false })),
    invokeGetFlowPathCandidates: vi.fn(
      async (): Promise<GetFlowPathCandidatesResult> => ({ candidates: [], truncated: false }),
    ),
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
    paths: null,
    ...overrides,
  };
}

/** 两条候选（菱形 A/B 路）夹具。 */
function twoCandidates(truncated = false): GetFlowPathCandidatesResult {
  return {
    candidates: [
      { nodePath: ["1", "0", "2"], nodePathNames: ["ES-1", "SW-A", "ES-2"], linkSeqs: [0, 1] },
      { nodePath: ["1", "3", "2"], nodePathNames: ["ES-1", "SW-B", "ES-2"], linkSeqs: [2, 3] },
    ],
    truncated,
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

  it("保存规划字段变更 → onSaved(didChange) 吃服务端返回（true） + onClose", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce({ planningFieldsChanged: true });
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

  it("保存非规划字段（srcMac）→ onSaved(false)（服务端判定）", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce({ planningFieldsChanged: false });
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

  // ——— R16 路径字段（U10b）———

  it("R16：候选下拉渲染（系统自动默认选中 + 候选文本 + truncated 提示项）", async () => {
    render(
      <FlowDetailModal
        stream={makeStream()}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates(true))}
      />,
    );
    const select = (await screen.findByLabelText(/指定路径/)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(4));
    expect(select.value).toBe("auto");
    expect(select.options[1].textContent).toBe("ES-1→SW-A→ES-2");
    expect(select.options[2].textContent).toBe("ES-1→SW-B→ES-2");
    expect(select.options[3].textContent).toBe("还有未列出路径");
    expect(select.options[3].disabled).toBe(true);
  });

  it("R16：选中候选触发 onPreviewPath(linkSeqs)；选回系统自动回调 null", async () => {
    const user = userEvent.setup();
    const onPreviewPath = vi.fn();
    render(
      <FlowDetailModal
        stream={makeStream()}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
        onPreviewPath={onPreviewPath}
      />,
    );
    const select = await screen.findByLabelText(/指定路径/);
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(3));
    await user.selectOptions(select, "c1");
    expect(onPreviewPath).toHaveBeenLastCalledWith([2, 3]);
    await user.selectOptions(select, "auto");
    expect(onPreviewPath).toHaveBeenLastCalledWith(null);
  });

  it("R16：选中候选保存 → request 带 pathLinkSeqs", async () => {
    const user = userEvent.setup();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce({ planningFieldsChanged: true });
    render(
      <FlowDetailModal
        stream={makeStream()}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
      />,
    );
    const select = await screen.findByLabelText(/指定路径/);
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(3));
    await user.selectOptions(select, "c0");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(invokeUpdateFlowStream).toHaveBeenCalled());
    const request = vi.mocked(invokeUpdateFlowStream).mock.calls.at(-1)?.[0];
    expect(request?.pathLinkSeqs).toEqual([0, 1]);
    expect(request?.clearPath).toBeUndefined();
  });

  it("R16：已有显式路径（匹配候选）→ 初始选中该候选；选回系统自动保存 → clearPath", async () => {
    const user = userEvent.setup();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce({ planningFieldsChanged: true });
    const paths = JSON.stringify({
      version: 1,
      origin: "user",
      routes: [{ node_path: ["1", "3", "2"], link_seqs: [2, 3] }],
    });
    render(
      <FlowDetailModal
        stream={makeStream({ paths })}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
      />,
    );
    const select = (await screen.findByLabelText(/指定路径/)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("c1"));
    await user.selectOptions(select, "auto");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(invokeUpdateFlowStream).toHaveBeenCalled());
    const request = vi.mocked(invokeUpdateFlowStream).mock.calls.at(-1)?.[0];
    expect(request?.clearPath).toBe(true);
    expect(request?.pathLinkSeqs).toBeUndefined();
  });

  it("R16：未动路径保存 → request 不带 pathLinkSeqs/clearPath", async () => {
    const user = userEvent.setup();
    vi.mocked(invokeUpdateFlowStream).mockResolvedValueOnce({ planningFieldsChanged: false });
    render(
      <FlowDetailModal
        stream={makeStream()}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
      />,
    );
    await screen.findByLabelText(/指定路径/);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(invokeUpdateFlowStream).toHaveBeenCalled());
    const request = vi.mocked(invokeUpdateFlowStream).mock.calls.at(-1)?.[0];
    expect(request?.pathLinkSeqs).toBeUndefined();
    expect(request?.clearPath).toBeUndefined();
  });

  it("R16：RC 流路径区只读展示双冗余路径 + 不可手选说明，不拉候选", async () => {
    const getPathCandidates = vi.fn(async () => twoCandidates());
    const paths = JSON.stringify({
      version: 1,
      origin: "system",
      routes: [
        { node_path: ["0", "2", "1"], link_seqs: [0, 1] },
        { node_path: ["0", "3", "1"], link_seqs: [2, 3] },
      ],
    });
    render(
      <FlowDetailModal
        stream={makeStream({ class: "RC", redundant: true, paths })}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={getPathCandidates}
      />,
    );
    expect(screen.getByText(/路径A：0→2→1/)).toBeInTheDocument();
    expect(screen.getByText(/路径B：0→3→1/)).toBeInTheDocument();
    expect(screen.getByText(/FRER 双路径由算法保证不相交，不可手选/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/指定路径/)).not.toBeInTheDocument();
    expect(getPathCandidates).not.toHaveBeenCalled();
  });

  it("R16：关弹窗（stream→null）清除画布预览", async () => {
    const onPreviewPath = vi.fn();
    const { rerender } = render(
      <FlowDetailModal
        stream={makeStream()}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
        onPreviewPath={onPreviewPath}
      />,
    );
    await screen.findByLabelText(/指定路径/);
    rerender(
      <FlowDetailModal
        stream={null}
        sessionId="s1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        getPathCandidates={vi.fn(async () => twoCandidates())}
        onPreviewPath={onPreviewPath}
      />,
    );
    expect(onPreviewPath).toHaveBeenCalledWith(null);
  });
});
