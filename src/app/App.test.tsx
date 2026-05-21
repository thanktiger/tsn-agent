import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const runTsnAgentMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: {
    ArrowClosed: "arrowclosed",
  },
  Position: {
    Left: "left",
    Right: "right",
  },
  ReactFlow: ({
    nodes,
    edges,
    onNodeClick,
    onEdgeClick,
    children,
  }: {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string; source?: string; target?: string }>;
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onEdgeClick?: (event: unknown, edge: { id: string }) => void;
    children?: React.ReactNode;
  }) => (
    <div aria-label="拓扑画布">
      {nodes.length} nodes / {edges.length} edges
      {nodes.map((node) => (
        <button
          className={(node as { className?: string }).className}
          data-highlight={(node as { className?: string }).className}
          key={node.id}
          type="button"
          onClick={() => onNodeClick?.({}, node)}
        >
          选择节点 {node.id}
        </button>
      ))}
      {edges.map((edge) => (
        <button
          className={(edge as { className?: string }).className}
          data-highlight={(edge as { className?: string }).className}
          data-animated={String(Boolean((edge as { animated?: boolean }).animated))}
          data-source={edge.source}
          data-target={edge.target}
          key={edge.id}
          type="button"
          onClick={() => onEdgeClick?.({}, edge)}
        >
          选择链路 {edge.id}
        </button>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("../agent/agent-adapter", () => ({
  runTsnAgent: runTsnAgentMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

describe("App", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    runTsnAgentMock.mockReset();
    invokeMock.mockReset();
    openDialogMock.mockReset();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const { runFakeTsnAgent } = await import("../agent/fake-agent");
    runTsnAgentMock.mockImplementation(
      async ({ userIntent, session }: { userIntent: string; session?: { project?: unknown; workflow?: unknown } }) =>
        runFakeTsnAgent(
          userIntent,
          session?.project as Parameters<typeof runFakeTsnAgent>[1],
          session?.workflow as Parameters<typeof runFakeTsnAgent>[2],
        ),
    );
  });

  it("shows a product empty state before the first interaction", () => {
    render(<App />);

    expect(screen.getByText("描述你的 TSN 需求后生成拓扑图")).toBeInTheDocument();
    expect(screen.queryByText("等待 tsn-topology skill 输出拓扑")).not.toBeInTheDocument();
  });

  it("generates a topology stage and waits for confirmation from a beginner request", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要4个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(screen.getByText("交换机 4")).toBeInTheDocument();
    expect(screen.getByText("端系统 20")).toBeInTheDocument();
    expect(screen.getByText("流量 0")).toBeInTheDocument();
    expect(screen.getByText(/拓扑等待确认/)).toBeInTheDocument();
    expect(screen.queryByText("控制流-1")).not.toBeInTheDocument();
    expect(screen.getByText("等待 Agent 生成流量规划")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.getByText("完成“模拟仿真”阶段后显示仿真输入文件")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "执行步骤" }));
    expect(screen.getAllByText("tsn-topology")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText("用户提交需求")).toBeInTheDocument();
  });

  it("shows a waiting animation before the first streaming chunk arrives", async () => {
    const user = userEvent.setup();
    const { runFakeTsnAgent } = await import("../agent/fake-agent");
    const deferred = createDeferred<ReturnType<typeof runFakeTsnAgent>>();
    let streamChunk: ((chunk: string) => void) | undefined;
    runTsnAgentMock.mockImplementation(
      ({ onChunk }: { onChunk?: (chunk: string) => void }) => {
        streamChunk = onChunk;
        return deferred.promise;
      },
    );

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    const waiting = await screen.findByText("正在连接智能助手，并结合当前会话上下文生成下一步规划");
    expect(waiting).toHaveTextContent("正在连接智能助手，并结合当前会话上下文生成下一步规划");

    act(() => {
      streamChunk?.("已开始解析拓扑需求");
    });

    await waitFor(() => {
      expect(screen.queryByText("正在连接智能助手，并结合当前会话上下文生成下一步规划")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("已开始解析拓扑需求")).toBeInTheDocument();

    act(() => {
      deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));
    });
    await waitFor(() => {
      expect(screen.getAllByText(/识别到 4 个交换机/).length).toBeGreaterThan(0);
    });
  });

  it("exposes a project export action after artifacts are generated", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("控制流-1")).toBeInTheDocument();
    expect(screen.getByText("流量 1")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("omnetpp.ini")).toBeInTheDocument();
    expect(screen.getByText("INET/OMNeT++ 最小运行配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "选择导出目录" }));
    await user.click(await screen.findByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已导出 5 个文件：browser-preview/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText("项目文件已导出")).toBeInTheDocument();
  });

  it("highlights flow route nodes and links when selecting a flow row", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("控制流-1")).toBeInTheDocument();

    await user.click(screen.getByTestId("flow-row-flow-control-1"));

    expect(screen.getByTestId("flow-row-flow-control-1")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "选择节点 es1-1" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 sw1" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 sw2" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 sw3" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 sw4" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 es4-1" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择节点 es1-2" })).toHaveAttribute("data-highlight", "flow-muted");
    expect(screen.getByRole("button", { name: "选择链路 link-0" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择链路 link-20" })).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(screen.getByRole("button", { name: "选择链路 link-6" })).toHaveAttribute("data-highlight", "flow-muted");

    await user.click(screen.getByRole("button", { name: "清除高亮" }));

    expect(screen.getByTestId("flow-row-flow-control-1")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "选择节点 es1-1" })).not.toHaveAttribute("data-highlight", "flow-highlighted");
  });

  it("uses the selected flow route direction for highlighted edges", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(
      screen.getByLabelText("输入你的 TSN 需求"),
      "基于箭载TSN技术规范创建图示拓扑：创建4台交换机和7个网卡，网卡1到网卡7双冗余接入系统交换机。",
    );
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "再加一条视频流");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    expect(await screen.findByText("视频流-1")).toBeInTheDocument();

    await user.click(screen.getByTestId("flow-row-flow-video-1"));

    const nic5ToSw2Edge = screen.getByRole("button", { name: "选择链路 link-9" });
    const sw2ToSw4Edge = screen.getByRole("button", { name: "选择链路 link-11" });

    expect(nic5ToSw2Edge).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(nic5ToSw2Edge).toHaveAttribute("data-source", "nic5");
    expect(nic5ToSw2Edge).toHaveAttribute("data-target", "sw2");
    expect(sw2ToSw4Edge).toHaveAttribute("data-source", "sw2");
    expect(sw2ToSw4Edge).toHaveAttribute("data-target", "sw4");
  });

  it("marks the final planning stage confirmed instead of rerunning it", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText(/模拟仿真等待确认/)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "确认并继续" }));

    expect(screen.queryByText(/模拟仿真等待确认/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByText("omnetpp.ini")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
  });

  it("updates topology change requests using the target switch count", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要2个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    expect(await screen.findByText("交换机 2")).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "修改一下拓扑，从2交换机变为3交换机");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText("交换机 3")).toBeInTheDocument();
    expect(screen.getByText("端系统 15")).toBeInTheDocument();
    expect(screen.getByText("流量 0")).toBeInTheDocument();
    expect(screen.getByText(/拓扑等待确认/)).toBeInTheDocument();
  });

  it("keeps per-switch host edits and renders ring interconnect requests", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要3个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    expect(await screen.findByText("交换机 3")).toBeInTheDocument();
    expect(screen.getByText("端系统 15")).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "需要改成4台交换机，每台连接3个端");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText("交换机 4")).toBeInTheDocument();
    expect(screen.getByText("端系统 12")).toBeInTheDocument();
    expect(screen.getByText("链路 15")).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "可以使用环形互联");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText("交换机 4")).toBeInTheDocument();
    expect(screen.getByText("端系统 12")).toBeInTheDocument();
    expect(screen.getByText("链路 16")).toBeInTheDocument();
    expect(screen.getByText("流量 0")).toBeInTheDocument();
    expect(screen.getByText(/拓扑等待确认/)).toBeInTheDocument();
  });

  it("advances from topology to time sync using natural language stage intent", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要2个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    expect(await screen.findByText(/拓扑等待确认/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "开始做时间同步");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText(/时间同步等待确认/)).toBeInTheDocument();
    expect(screen.getByText("流量 0")).toBeInTheDocument();
    expect(screen.queryByText("控制流-1")).not.toBeInTheDocument();
  });

  it("switches inspector tabs and opens node and link details from topology clicks", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要2个交换机，每个交换机连接3个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText("等待 Agent 生成流量规划")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByText("完成“模拟仿真”阶段后显示仿真输入文件")).toBeInTheDocument();
    expect(screen.queryByText("等待 Agent 生成流量规划")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "节点详情" }));
    expect(screen.getByText("请选择拓扑画布中的节点")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择节点 sw1" }));
    expect(screen.getByRole("tab", { name: "节点详情" })).toHaveAttribute("aria-selected", "true");
    const nodeDetail = screen.getByLabelText("节点详情");
    expect(nodeDetail).toHaveTextContent("SW-1");
    expect(nodeDetail).toHaveTextContent("端口数");

    await user.click(screen.getByRole("button", { name: "选择链路 link-0" }));
    expect(screen.getByRole("tab", { name: "链路详情" })).toHaveAttribute("aria-selected", "true");
    const linkDetail = screen.getByLabelText("链路详情");
    expect(linkDetail).toHaveTextContent("link-0");
    expect(linkDetail).toHaveTextContent("源端点");
    expect(linkDetail).toHaveTextContent("1000 Mbps");
  });

  it("re-enables submit if pending session persistence fails", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、时间同步、流量规划和模拟仿真准备。");
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (key === "tsn-agent.sessions.v0") {
        throw new Error("storage failed");
      }

      return originalSetItem.call(window.localStorage, key, value);
    });

    try {
      const button = screen.getByRole("button", { name: /生成规划草案/ });
      await user.click(button);

      expect(button).toBeEnabled();
      expect(await screen.findByText("本次生成失败：storage failed")).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("falls back to an in-memory initial session if startup persistence fails", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage failed");
    });

    try {
      render(<App />);
      expect(await screen.findByText("告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、时间同步、流量规划和模拟仿真准备。")).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not restore a session deleted while the agent is running", async () => {
    const user = userEvent.setup();
    const { runFakeTsnAgent } = await import("../agent/fake-agent");
    const deferred = createDeferred<ReturnType<typeof runFakeTsnAgent>>();
    runTsnAgentMock.mockReturnValue(deferred.promise);

    render(<App />);

    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(screen.getByRole("button", { name: "会话" }));
    await user.click(screen.getByRole("button", { name: /删除当前/ }));

    deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));

    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(await screen.findByText("完成“模拟仿真”阶段后显示仿真输入文件")).toBeInTheDocument();
  });
});
