import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import { createInitialWorkflowState } from "../project/project-state";
import { appVersion, releaseNotes } from "../release/release-info";
import { App } from "./App";

type PlannerStartResponse = {
  err_code: number;
  err_msg: string;
  data: {
    state: string;
    plan_id?: string;
    started_at?: string;
  };
  trace_id?: string;
  timestamp?: string;
};

type PlannerQueryResponse = {
  err_code: number;
  err_msg: string;
  data: {
    state: string;
    plan_id?: string;
    running_duration_ms?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
    internal_result?: unknown;
    error_code?: string | number | null;
    error_message?: string | null;
  };
  trace_id?: string;
  timestamp?: string;
};

type PlannerResultResponse = {
  err_code: number;
  err_msg: string;
  data: {
    state: string;
    plan_id?: string;
    source_outputs?: {
      solution_json?: unknown;
      tsnlight_plan_cfg_json?: unknown;
    };
    output_fingerprints?: Record<string, unknown>;
    error_message?: string | null;
  };
  trace_id?: string;
  timestamp?: string;
};

const runTsnAgentMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const startPlannerPlanMock = vi.hoisted(() => vi.fn());
const queryPlannerPlanStatusMock = vi.hoisted(() => vi.fn());
const getPlannerPlanResultMock = vi.hoisted(() => vi.fn());
const stopPlannerPlanMock = vi.hoisted(() => vi.fn());

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

vi.mock("../planner/planner-client", () => ({
  startPlannerPlan: startPlannerPlanMock,
  queryPlannerPlanStatus: queryPlannerPlanStatusMock,
  getPlannerPlanResult: getPlannerPlanResultMock,
  stopPlannerPlan: stopPlannerPlanMock,
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

function createDefaultTestProject() {
  return createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统", undefined, {
    includeControlFlow: false,
  });
}

function createDefaultTestWorkflow() {
  return createInitialWorkflowState();
}

function firstReleaseNoteItem(): string {
  const item = releaseNotes[0]?.categories[0]?.items[0];

  if (!item) {
    throw new Error("Expected at least one customer-visible release note item.");
  }

  return item;
}

function createPlannerStartResponse(state = "running", planId = "plan-1"): PlannerStartResponse {
  return {
    err_code: 0,
    err_msg: "规划任务已启动",
    data: {
      state,
      plan_id: planId,
      started_at: "2026-05-22T10:00:00+08:00",
    },
    trace_id: "trace-start",
    timestamp: "2026-05-22T10:00:00+08:00",
  };
}

function createPlannerQueryResponse(state = "succeeded", planId = "plan-1"): PlannerQueryResponse {
  return {
    err_code: 0,
    err_msg: state === "succeeded" ? "规划完成" : "规划运行中",
    data: {
      plan_id: planId,
      state,
      running_duration_ms: state === "running" ? 2000 : 4200,
      started_at: "2026-05-22T10:00:00+08:00",
      updated_at: "2026-05-22T10:00:04+08:00",
      finished_at: state === "succeeded" ? "2026-05-22T10:00:04+08:00" : undefined,
      internal_result: state === "succeeded" ? 1 : undefined,
      error_code: null,
      error_message: null,
    },
    trace_id: "trace-query",
    timestamp: "2026-05-22T10:00:04+08:00",
  };
}

function createPlannerResultResponse(planId = "plan-1"): PlannerResultResponse {
  return {
    err_code: 0,
    err_msg: "ok",
    data: {
      state: "succeeded",
      plan_id: planId,
      source_outputs: {
        solution_json: [
          {
            link_id: 0,
            gcl_entries: [
              {
                interval: 32,
                state: "open",
                stream_id: 1,
              },
            ],
          },
        ],
        tsnlight_plan_cfg_json: {
          network_plan_cfg: {
            node: [],
          },
        },
      },
      output_fingerprints: {
        solution_json: {
          file_name: "solution.json",
          size_bytes: 128,
          sha256: "a".repeat(64),
          mtime_ns: 1,
        },
      },
    },
    trace_id: "trace-result",
    timestamp: "2026-05-22T10:00:05+08:00",
  };
}

async function typeDefaultIntent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要4个交换机，每个交换机连接5个端系统");
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    window.localStorage.clear();
    runTsnAgentMock.mockReset();
    startPlannerPlanMock.mockReset();
    queryPlannerPlanStatusMock.mockReset();
    getPlannerPlanResultMock.mockReset();
    stopPlannerPlanMock.mockReset();
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

    expect(screen.getByText(`VER ${appVersion}`)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "工作台工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行日志" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("描述你的 TSN 需求后生成拓扑图")).toBeInTheDocument();
    expect(screen.queryByText("等待 tsn-topology skill 输出拓扑")).not.toBeInTheDocument();
    expect(screen.getByLabelText("输入你的 TSN 需求")).toHaveAttribute("placeholder", "例如：我需要 4 个交换机，每个交换机连接 5 个端系统");
    expect(screen.getByRole("button", { name: /生成规划草案/ })).toBeDisabled();
  });

  it("shows customer-facing changelog content inside settings", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(screen.queryByRole("button", { name: /更新日志/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByRole("region", { name: "更新日志" })).toBeInTheDocument();
    expect(screen.getAllByText(`v${appVersion}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(firstReleaseNoteItem())).toBeInTheDocument();
    expect(screen.queryByText(/restrict desktop builds/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dfa4d68/)).not.toBeInTheDocument();
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
    expect(screen.getByText("完成“模拟仿真”阶段后显示项目导出文件")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "执行步骤" }));
    expect(screen.getAllByText("tsn-topology")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "执行日志" }));
    expect(await screen.findByText("用户提交需求")).toBeInTheDocument();
  });

  it("does not overwrite the visible project when an agent result is marked non-applicable", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "我需要3个交换机，每个交换机连接3个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText("交换机 3")).toBeInTheDocument();
    expect(screen.getByText("端系统 9")).toBeInTheDocument();

    runTsnAgentMock.mockResolvedValueOnce({
      mode: "claude",
      assistantText: "本轮拓扑没有更新，因为没有拿到可应用的结构化结果。\n右侧工程已保持原状态，不会自动 fallback 到默认拓扑。",
      events: [
        {
          id: "event-project-preserved",
          kind: "error",
          title: "工程已保留",
          content: "本轮没有生成可应用的结构化结果，右侧工程保持上一版，不会用本地默认拓扑覆盖。",
          status: "warning",
        },
      ],
      project: createDefaultTestProject(),
      workflow: createDefaultTestWorkflow(),
      shouldApplyProject: false,
    });

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "改成4个交换机，每个交换机连接5个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByText(/本轮拓扑没有更新/)).toBeInTheDocument();
    expect(screen.getByText("交换机 3")).toBeInTheDocument();
    expect(screen.getByText("端系统 9")).toBeInTheDocument();
    expect(screen.queryByText("交换机 4")).not.toBeInTheDocument();
    expect(screen.queryByText("端系统 20")).not.toBeInTheDocument();
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

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    const waiting = await screen.findByText("正在连接智能助手，并结合当前会话上下文生成下一步规划");
    expect(waiting).toHaveTextContent("正在连接智能助手，并结合当前会话上下文生成下一步规划");
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("智能助手正在连接并准备当前会话上下文");
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("已运行 0 秒");

    act(() => {
      streamChunk?.("已开始解析拓扑需求");
    });

    await waitFor(() => {
      expect(screen.queryByText("正在连接智能助手，并结合当前会话上下文生成下一步规划")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("已开始解析拓扑需求")).toBeInTheDocument();
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("智能助手正在持续推理，结果会继续更新");

    act(() => {
      deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));
    });
    await waitFor(() => {
      expect(screen.getAllByText(/识别到 4 个交换机/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("agent-run-status")).not.toBeInTheDocument();
  });

  it("scrolls the chat to the newest streamed output", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<Awaited<ReturnType<typeof runTsnAgentMock>>>();
    const scrollToMock = vi.fn();
    let streamChunk: ((chunk: string) => void) | undefined;
    runTsnAgentMock.mockImplementation(
      ({ onChunk }: { onChunk?: (chunk: string) => void }) => {
        streamChunk = onChunk;
        return deferred.promise;
      },
    );
    vi.spyOn(HTMLDivElement.prototype, "scrollHeight", "get").mockReturnValue(480);
    Object.defineProperty(HTMLDivElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith({ top: 480, behavior: "smooth" });
    });

    scrollToMock.mockClear();

    await act(async () => {
      streamChunk?.("第一段输出");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith({ top: 480, behavior: "smooth" });
    });

    deferred.resolve({
      mode: "fake",
      assistantText: "完成",
      events: [],
      project: createDefaultTestProject(),
      workflow: createDefaultTestWorkflow(),
    });
  });

  it("keeps a global running indicator visible while streamed replies wait for long tasks", async () => {
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

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));

    expect(await screen.findByTestId("agent-run-status")).toHaveTextContent("智能助手正在连接并准备当前会话上下文");
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("已运行 0 秒");

    await act(async () => {
      streamChunk?.("已开始解析拓扑需求");
      await Promise.resolve();
    });

    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("智能助手正在持续推理，结果会继续更新");

    await waitFor(() => {
      expect(screen.getByTestId("agent-run-status")).toHaveTextContent("智能助手仍在处理，可能正在等待工具或子任务返回");
    }, { timeout: 3600 });
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("已运行 3 秒");

    await act(async () => {
      streamChunk?.("工具返回后继续生成");
      await Promise.resolve();
    });

    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("智能助手正在持续推理，结果会继续更新");

    await act(async () => {
      deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("agent-run-status")).not.toBeInTheDocument();
    });
  }, 8000);

  it("exposes a project export action after artifacts are generated", async () => {
    const user = userEvent.setup();

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("控制流-1")).toBeInTheDocument();
    expect(screen.getByText("流量 1")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText("simulation/inet/omnetpp.ini")).toBeInTheDocument();
    expect(screen.getByText("simulation/inet/traffic.ini")).toBeInTheDocument();
    expect(screen.getByText("workspace/react-flow-topology.json")).toBeInTheDocument();
    expect(screen.getByText("planner/flow_plan_1.json")).toBeInTheDocument();
    expect(screen.getByText("INET 仿真输入")).toBeInTheDocument();
    expect(screen.getByText("外部规划器")).toBeInTheDocument();
    expect(screen.getByText("工作台展示")).toBeInTheDocument();
    expect(screen.getByText("INET/OMNeT++ 入口配置")).toBeInTheDocument();
    expect(screen.getByText("UDP 业务流配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "选择导出目录" }));
    await user.click(await screen.findByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已导出 6 个文件：browser-preview/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "执行日志" }));
    expect((await screen.findAllByText("项目文件已导出")).length).toBeGreaterThanOrEqual(1);
  });

  it("runs planner task from running to succeeded and adds result artifacts", async () => {
    const user = userEvent.setup();
    startPlannerPlanMock.mockResolvedValue(createPlannerStartResponse());
    queryPlannerPlanStatusMock.mockResolvedValue(createPlannerQueryResponse());
    getPlannerPlanResultMock.mockResolvedValue(createPlannerResultResponse());

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));

    expect(screen.getByLabelText("规划任务")).toHaveTextContent("未提交");
    expect(screen.getByDisplayValue("http://100.78.48.43:18080")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "启动规划" }));

    expect(startPlannerPlanMock).toHaveBeenCalledWith({
      baseUrl: "http://100.78.48.43:18080",
      request: expect.objectContaining({
        sendData: expect.objectContaining({
          mode: "time-trigger",
        }),
      }),
    });
    expect(await screen.findByText("plan-1")).toBeInTheDocument();

    await waitFor(() => {
      expect(getPlannerPlanResultMock).toHaveBeenCalledWith({
        baseUrl: "http://100.78.48.43:18080",
        planId: "plan-1",
      });
    });
    expect(await screen.findByText("planner/flow_plan_result_1.json")).toBeInTheDocument();
    expect(screen.getByText("simulation/inet/planner-gcl.json")).toBeInTheDocument();
    expect(screen.getByText("simulation/inet/planner-gcl-notes.md")).toBeInTheDocument();
    expect(screen.getByText("外部观测输出")).toBeInTheDocument();
    expect(screen.getAllByText("GCL 追溯数据").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("规划任务")).toHaveTextContent("1 条链路 · 1 条 GCL");
  }, 10000);

  it("does not create planner output when result endpoint returns a business error", async () => {
    const user = userEvent.setup();
    startPlannerPlanMock.mockResolvedValue(createPlannerStartResponse());
    queryPlannerPlanStatusMock.mockResolvedValue(createPlannerQueryResponse());
    getPlannerPlanResultMock.mockResolvedValue({
      err_code: 1004,
      err_msg: "规划任务尚未完成",
      data: {
        state: "running",
        plan_id: "plan-1",
        error_message: "规划任务尚未完成",
      },
      trace_id: "trace-result",
      timestamp: "2026-05-22T10:00:05+08:00",
    });

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    await user.click(screen.getByRole("button", { name: "启动规划" }));

    expect(await screen.findByText("规划任务尚未完成")).toBeInTheDocument();
    expect(screen.queryByText("planner/flow_plan_result_1.json")).not.toBeInTheDocument();
    expect(screen.queryByText("simulation/inet/planner-gcl.json")).not.toBeInTheDocument();
  }, 10000);

  it("invalidates planner result artifacts when the project changes", async () => {
    const user = userEvent.setup();
    startPlannerPlanMock.mockResolvedValue(createPlannerStartResponse());
    queryPlannerPlanStatusMock.mockResolvedValue(createPlannerQueryResponse());
    getPlannerPlanResultMock.mockResolvedValue(createPlannerResultResponse());

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    await user.click(screen.getByRole("button", { name: "启动规划" }));
    expect(await screen.findByText("planner/flow_plan_result_1.json")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("输入你的 TSN 需求"));
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "改成3个交换机，每个交换机连接3个端系统");
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));

    expect(await screen.findByText("工程输入已更新，原规划结果已失效，请重新启动规划任务。")).toBeInTheDocument();
    expect(screen.queryByText("planner/flow_plan_result_1.json")).not.toBeInTheDocument();
    expect(screen.queryByText("simulation/inet/planner-gcl.json")).not.toBeInTheDocument();
  }, 12000);

  it("keeps polling after a transient planner status failure", async () => {
    const user = userEvent.setup();
    startPlannerPlanMock.mockResolvedValue(createPlannerStartResponse());
    queryPlannerPlanStatusMock
      .mockRejectedValueOnce(new Error("temporary timeout"))
      .mockResolvedValueOnce(createPlannerQueryResponse());
    getPlannerPlanResultMock.mockResolvedValue(createPlannerResultResponse());

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    await user.click(screen.getByRole("button", { name: "启动规划" }));

    await waitFor(() => {
      expect(queryPlannerPlanStatusMock).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("planner/flow_plan_result_1.json")).toBeInTheDocument();
    expect(queryPlannerPlanStatusMock).toHaveBeenCalledTimes(2);
  }, 12000);

  it("prevents an in-flight poll from writing results after the user stops a planner task", async () => {
    const user = userEvent.setup();
    const queryDeferred = createDeferred<PlannerQueryResponse>();
    startPlannerPlanMock.mockResolvedValue(createPlannerStartResponse());
    queryPlannerPlanStatusMock.mockReturnValue(queryDeferred.promise);
    stopPlannerPlanMock.mockResolvedValue({
      err_code: 0,
      err_msg: "已取消",
      data: {
        state: "cancelled",
        stopped_plan_id: "plan-1",
      },
      trace_id: "trace-stop",
      timestamp: "2026-05-22T10:00:06+08:00",
    });
    getPlannerPlanResultMock.mockResolvedValue(createPlannerResultResponse());

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    await user.click(screen.getByRole("button", { name: "启动规划" }));

    await waitFor(() => {
      expect(queryPlannerPlanStatusMock).toHaveBeenCalledTimes(1);
    });
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();

    queryDeferred.resolve(createPlannerQueryResponse());
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(getPlannerPlanResultMock).not.toHaveBeenCalled();
    expect(screen.queryByText("planner/flow_plan_result_1.json")).not.toBeInTheDocument();
  }, 12000);

  it("highlights flow route nodes and links when selecting a flow row", async () => {
    const user = userEvent.setup();

    render(<App />);

    await typeDefaultIntent(user);
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

    const esToSwitchEdge = screen.getByRole("button", { name: "选择链路 link-2" });
    const switchBackboneEdge = screen.getByRole("button", { name: "选择链路 link-40" });
    const switchToEsEdge = screen.getByRole("button", { name: "选择链路 link-32" });

    expect(esToSwitchEdge).toHaveAttribute("data-highlight", "flow-highlighted");
    expect(esToSwitchEdge).toHaveAttribute("data-source", "es1-2");
    expect(esToSwitchEdge).toHaveAttribute("data-target", "sw1");
    expect(switchBackboneEdge).toHaveAttribute("data-source", "sw1");
    expect(switchBackboneEdge).toHaveAttribute("data-target", "sw3");
    expect(switchToEsEdge).toHaveAttribute("data-source", "sw3");
    expect(switchToEsEdge).toHaveAttribute("data-target", "es4-2");
  });

  it("marks the final planning stage confirmed instead of rerunning it", async () => {
    const user = userEvent.setup();

    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    await user.click(await screen.findByRole("button", { name: "确认并继续" }));
    expect(await screen.findByText(/模拟仿真等待确认/)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "确认并继续" }));

    expect(screen.queryByText(/模拟仿真等待确认/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(screen.getByText("simulation/inet/omnetpp.ini")).toBeInTheDocument();
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
    expect(screen.getByText("完成“模拟仿真”阶段后显示项目导出文件")).toBeInTheDocument();
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
      await typeDefaultIntent(user);
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

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: /生成规划草案/ }));
    await user.click(screen.getByRole("button", { name: "会话" }));
    await user.click(screen.getByRole("button", { name: /删除当前/ }));

    deferred.resolve(runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统"));

    await user.click(screen.getByRole("tab", { name: "导出文件" }));
    expect(await screen.findByText("完成“模拟仿真”阶段后显示项目导出文件")).toBeInTheDocument();
  });

  it("opens workspace skill and settings panels from the tool rail", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill" }));
    expect(screen.getByRole("complementary", { name: "Skill 能力" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Skill 详情" })).toBeInTheDocument();
    expect(screen.getAllByText("tsn-topology").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("tsn-time-sync")).toBeInTheDocument();
    expect(screen.getByText("tsn-flow-planning")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /tsn-flow-planning/ }));
    expect(screen.getByText("解析用户业务流需求，生成流模板，并准备提交外部规划器所需的流参数。")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Skill 文件" })).toBeInTheDocument();
    expect(screen.getByText("请在桌面应用中预览和编辑本地 skill 文件。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑元数据" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("complementary", { name: "工作台设置" })).toBeInTheDocument();
    expect(screen.getAllByText("当前版本").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("默认规划服务")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "更新日志" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`v${appVersion}`) })).toBeInTheDocument();
  });
});
