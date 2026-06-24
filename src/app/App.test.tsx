import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TsnAgentResult } from "../agent/agent-types";
import {
  createInitialWorkflowState,
  recordStageResult,
  type WorkflowState,
} from "../project/project-state";
import { appVersion, releaseNotes } from "../release/release-info";
import { App } from "./App";

const runTsnAgentMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
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
    <div role="group" aria-label="拓扑画布">
      {nodes.length} nodes / {edges.length} edges
      {nodes.map((node) => (
        <button key={node.id} type="button" onClick={() => onNodeClick?.({}, node)}>
          选择节点 {node.id}
        </button>
      ))}
      {edges.map((edge) => (
        <button key={edge.id} type="button" onClick={() => onEdgeClick?.({}, edge)}>
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

function topologyWaitingWorkflow(): WorkflowState {
  return recordStageResult(createInitialWorkflowState(), {
    step: "topology",
    summary: "已识别 4 个交换机，每个交换机连接 5 个端系统。",
  });
}

function topologyAgentResult(overrides: Partial<TsnAgentResult> = {}): TsnAgentResult {
  return {
    events: [
      {
        id: "event-topology-workflow-stage-result",
        kind: "stage-result",
        stage: "topology",
        skillName: "tsn_topology",
        title: "拓扑工具结果",
        content: "拓扑已写入工程数据库（mutation #1）。",
        status: "success",
      },
      {
        id: "event-topology-confirmation",
        kind: "confirmation-required",
        stage: "topology",
        title: "等待确认",
        content: "确认拓扑后进入时间同步阶段，或继续描述需要修改的拓扑规模。",
        status: "warning",
      },
    ],
    workflow: topologyWaitingWorkflow(),
    assistantText: "已根据本轮需求生成拓扑草案。",
    mode: "claude",
    claudeSessionId: "claude-session-1",
    topologyMutationId: 1,
    ...overrides,
  };
}

function enableTauriRuntime(topology?: Record<string, unknown>) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "query_topology") {
      return topology ?? { sessionId: "unknown", nodes: [], links: [] };
    }

    if (command === "get_topology_mutations_since") {
      return { mutations: [], latest: 0, outOfRange: false };
    }

    if (command === "list_sessions") {
      return [];
    }

    if (command === "get_current_session") {
      return null;
    }

    return undefined;
  });
}

function sampleTopologyRows(sessionId: string) {
  return {
    sessionId,
    nodes: [
      { syncName: "0", name: null, x: 0, y: 0, nodeType: "switch", insertOrder: 0 },
      { syncName: "1", name: null, x: 160, y: 0, nodeType: "switch", insertOrder: 1 },
      { syncName: "2", name: null, x: 0, y: 120, nodeType: null, insertOrder: 2 },
    ],
    links: [
      { linkSeq: 0, name: null, srcSyncName: "0", dstSyncName: "1", stylesJson: "{}" },
      { linkSeq: 1, name: "uplink", srcSyncName: "0", dstSyncName: "2", stylesJson: "{}" },
    ],
  };
}

function firstReleaseNoteItem(): string {
  const item = releaseNotes[0]?.categories[0]?.items[0];

  if (!item) {
    throw new Error("Expected at least one customer-visible release note item.");
  }

  return item;
}

async function typeDefaultIntent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText("输入你的 TSN 需求"),
    "我需要4个交换机，每个交换机连接5个端系统",
  );
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    runTsnAgentMock.mockReset();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    runTsnAgentMock.mockImplementation(async () => topologyAgentResult());
  });

  it("shows a product empty state before the first interaction", () => {
    render(<App />);

    expect(screen.getByText(`VER ${appVersion}`)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "工作台工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "会话" })).toBeInTheDocument();
    expect(screen.getByText("描述你的 TSN 需求后生成拓扑图")).toBeInTheDocument();
    expect(screen.getByText("草稿")).toBeInTheDocument();
  });

  it("keeps the disabled flow step visible", () => {
    render(<App />);

    const stepper = screen.getByLabelText("配置步骤");
    const flowStep = within(stepper).getByText("流量规划").closest(".stepper-item");
    expect(flowStep).toHaveAttribute("aria-disabled", "true");
  });

  it("defaults to the aerospace scenario and applies it to the agent session", async () => {
    const user = userEvent.setup();
    render(<App />);

    // 进门默认箭载：placeholder 即双平面双跳推荐（不再展示场景选择控件）。
    expect(screen.getByPlaceholderText(/双平面双跳/)).toBeInTheDocument();

    // 提交后 agent 收到的会话 scenarioConfigId 已是 aerospace-onboard。
    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));
    await waitFor(() => {
      expect(runTsnAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            workflow: expect.objectContaining({ scenarioConfigId: "aerospace-onboard" }),
          }),
        }),
      );
    });
  });

  it("runs the agent and applies workflow from the result", async () => {
    const user = userEvent.setup();
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    await waitFor(() => {
      expect(screen.getByText("已根据本轮需求生成拓扑草案。")).toBeInTheDocument();
    });
    expect(runTsnAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "我需要4个交换机，每个交换机连接5个端系统",
      }),
    );
    expect(screen.getByText("拓扑生成等待确认")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
  });

  it("persists toolCalls onto the finalized assistant message (U6)", async () => {
    const user = userEvent.setup();
    runTsnAgentMock.mockResolvedValueOnce(
      topologyAgentResult({
        toolCalls: [
          {
            id: "toolu-1",
            name: "Bash",
            friendlyName: "Bash",
            status: "success",
            summary: "ls",
            args: { command: "ls" },
            result: { stdout: "ok" },
          },
        ],
      }),
    );
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    await waitFor(() => {
      expect(screen.getByText("已根据本轮需求生成拓扑草案。")).toBeInTheDocument();
    });

    const stored = JSON.parse(window.localStorage.getItem("tsn-agent.sessions.v0") ?? "[]");
    const withTools = stored[0].messages.find(
      (message: { role: string; toolCalls?: unknown[] }) =>
        message.role === "assistant" && message.toolCalls?.length,
    );
    expect(withTools?.toolCalls[0]).toMatchObject({
      friendlyName: "Bash",
      result: { stdout: "ok" },
    });

    // U7：卡片在对话流内联渲染。
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("ls")).toBeInTheDocument();
  });

  it("streams running cards mid-run (id upsert) and reconciles with done toolCalls (U4/AE1/AE6)", async () => {
    const user = userEvent.setup();
    let resolveRun!: (value: TsnAgentResult) => void;
    runTsnAgentMock.mockImplementationOnce(
      (request: { onToolCall?: (record: unknown) => void }) => {
        request.onToolCall?.({
          id: "toolu-1",
          name: "Bash",
          friendlyName: "Bash",
          status: "running",
          summary: "ls",
          args: { command: "ls" },
        });
        // 同 id 重复 start：upsert 就地合并，不追加新卡。
        request.onToolCall?.({
          id: "toolu-1",
          name: "Bash",
          friendlyName: "Bash",
          status: "running",
          summary: "ls",
          args: { command: "ls" },
        });
        return new Promise<TsnAgentResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    );
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    // run 中途：流式卡片已出现，且同 id 只有一张。
    await waitFor(() => {
      expect(screen.getAllByText("Bash")).toHaveLength(1);
    });

    // done 对账：权威列表补齐流式期间漏发的 toolu-2。
    resolveRun(
      topologyAgentResult({
        toolCalls: [
          {
            id: "toolu-1",
            name: "Bash",
            friendlyName: "Bash",
            status: "success",
            summary: "ls",
            args: { command: "ls" },
            result: "ok",
          },
          {
            id: "toolu-2",
            name: "Read",
            friendlyName: "Read",
            status: "success",
            summary: "App.tsx",
            args: { file_path: "App.tsx" },
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("已根据本轮需求生成拓扑草案。")).toBeInTheDocument();
    });
    expect(screen.getByText("Read")).toBeInTheDocument();

    const stored = JSON.parse(window.localStorage.getItem("tsn-agent.sessions.v0") ?? "[]");
    const withTools = stored[0].messages.find(
      (message: { role: string; toolCalls?: Array<{ status: string }> }) =>
        message.role === "assistant" && message.toolCalls?.length,
    );
    expect(withTools?.toolCalls).toHaveLength(2);
    expect(
      withTools?.toolCalls.every((call: { status: string }) => call.status !== "running"),
    ).toBe(true);
  });

  it("drops streamed cards when the run resolves a failure result without toolCalls (U4/AE5)", async () => {
    const user = userEvent.setup();
    runTsnAgentMock.mockImplementationOnce(
      async (request: { onToolCall?: (record: unknown) => void }) => {
        request.onToolCall?.({
          id: "toolu-1",
          name: "Bash",
          friendlyName: "Bash",
          status: "running",
          summary: "ls",
          args: { command: "ls" },
        });
        // 真实崩溃路径：adapter catch 吞掉异常，resolve 不含 toolCalls 的失败文案结果。
        return {
          events: [],
          workflow: createInitialWorkflowState(),
          assistantText: "本轮请求失败：智能助手运行时异常退出。",
          mode: "claude",
        } satisfies TsnAgentResult;
      },
    );
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    await waitFor(() => {
      expect(screen.getByText(/本轮请求失败/)).toBeInTheDocument();
    });

    // 流式卡片随 done 覆盖（toolCalls: undefined）丢弃：无运行中残卡、不落库。
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem("tsn-agent.sessions.v0") ?? "[]");
    const assistantMessages = stored[0].messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(
      assistantMessages.every((message: { toolCalls?: unknown[] }) => !message.toolCalls?.length),
    ).toBe(true);
  });

  it("renames the session after the first user message", async () => {
    const user = userEvent.setup();
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    await waitFor(() => {
      expect(screen.getByText("已根据本轮需求生成拓扑草案。")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "会话" }));
    const sessionList = screen.getByLabelText("最近会话");
    expect(
      within(sessionList).getAllByText("我需要4个交换机，每个交换机连接5个端系统").length,
    ).toBeGreaterThan(0);
  });

  it("submits a continuation when the user confirms the waiting stage", async () => {
    const user = userEvent.setup();
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "确认并继续" })).toBeEnabled();
    });

    runTsnAgentMock.mockClear();
    runTsnAgentMock.mockResolvedValueOnce(
      topologyAgentResult({
        assistantText: "时间同步默认值已生成。",
        mode: "local",
        workflow: (() => {
          const workflow = createInitialWorkflowState();
          workflow.currentStep = "time-sync";
          workflow.stages.topology = { step: "topology", status: "confirmed" };
          workflow.stages["time-sync"] = {
            step: "time-sync",
            status: "waiting_confirmation",
            summary: "gPTP 默认同步假设。",
          };
          return workflow;
        })(),
        topologyMutationId: undefined,
      }),
    );

    await user.click(screen.getByRole("button", { name: "确认并继续" }));

    await waitFor(() => {
      expect(screen.getByText("时间同步默认值已生成。")).toBeInTheDocument();
    });
    expect(runTsnAgentMock).toHaveBeenCalledWith(expect.objectContaining({ userIntent: "继续" }));
    expect(screen.getByText("时间同步等待确认")).toBeInTheDocument();
  });

  it("restores the composer input when the agent run fails", async () => {
    runTsnAgentMock.mockRejectedValueOnce(new Error("worker exited"));
    const user = userEvent.setup();
    render(<App />);

    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));

    await waitFor(() => {
      expect(screen.getByText(/本次生成失败：worker exited/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText("输入你的 TSN 需求")).toHaveValue(
      "我需要4个交换机，每个交换机连接5个端系统",
    );
  });

  it("renders topology rows from query_topology in Tauri runtime", async () => {
    enableTauriRuntime();
    invokeMock.mockImplementation(
      async (command: string, args?: { request?: { sessionId?: string } }) => {
        if (command === "query_topology") {
          return sampleTopologyRows(args?.request?.sessionId ?? "unknown");
        }

        if (command === "get_topology_mutations_since") {
          return { mutations: [], latest: 0, outOfRange: false };
        }

        if (command === "list_sessions") {
          return [];
        }

        if (command === "get_current_session") {
          return null;
        }

        return undefined;
      },
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("3 nodes / 2 edges")).toBeInTheDocument();
    });
    const stats = screen.getByLabelText("拓扑统计");
    expect(within(stats).getByText("交换机 2")).toBeInTheDocument();
    expect(within(stats).getByText("端系统 1")).toBeInTheDocument();
    expect(within(stats).getByText("链路 2")).toBeInTheDocument();
    expect(screen.getByText("草案已生成")).toBeInTheDocument();
  });

  it("undo button invokes undo_topology and lands pendingUndoNotice on the next run session (U8/U7)", async () => {
    enableTauriRuntime();
    invokeMock.mockImplementation(
      async (command: string, args?: { request?: { sessionId?: string } }) => {
        if (command === "query_topology") {
          return sampleTopologyRows(args?.request?.sessionId ?? "unknown");
        }
        if (command === "get_topology_mutations_since") {
          return { mutations: [], latest: 0, outOfRange: false };
        }
        if (command === "list_sessions") {
          return [];
        }
        if (command === "get_current_session") {
          return null;
        }
        if (command === "undo_topology") {
          return { undone: true };
        }
        return undefined;
      },
    );
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("3 nodes / 2 edges")).toBeInTheDocument();
    });

    const undoButton = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(undoButton); // 第一步：确认态
    await user.click(undoButton); // 第二步：执行
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "undo_topology",
        expect.objectContaining({
          request: expect.objectContaining({ sessionId: expect.any(String) }),
        }),
      ),
    );

    // 下一轮 agent run 的 session.workflow 携带一次性 pendingUndoNotice（喂给 U7 注入）。
    await typeDefaultIntent(user);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));
    await waitFor(() =>
      expect(runTsnAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            workflow: expect.objectContaining({ pendingUndoNotice: true }),
          }),
        }),
      ),
    );
  });

  it("shows node and link details for canvas selections", async () => {
    enableTauriRuntime();
    invokeMock.mockImplementation(
      async (command: string, args?: { request?: { sessionId?: string } }) => {
        if (command === "query_topology") {
          return sampleTopologyRows(args?.request?.sessionId ?? "unknown");
        }

        if (command === "get_topology_mutations_since") {
          return { mutations: [], latest: 0, outOfRange: false };
        }

        if (command === "list_sessions") {
          return [];
        }

        if (command === "get_current_session") {
          return null;
        }

        return undefined;
      },
    );
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("3 nodes / 2 edges")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "选择节点 1" }));
    const nodePanel = screen.getByRole("tabpanel", { name: "节点详情" });
    expect(within(nodePanel).getByText("SW-1")).toBeInTheDocument();
    expect(within(nodePanel).getByText("交换机")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择链路 link-1" }));
    const linkPanel = screen.getByRole("tabpanel", { name: "链路详情" });
    expect(within(linkPanel).getByText("uplink")).toBeInTheDocument();
    expect(within(linkPanel).getByText("SW-0")).toBeInTheDocument();
    expect(within(linkPanel).getByText("ES-2")).toBeInTheDocument();
  });

  it("creates and deletes sessions with confirmation while the drawer stays open", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "会话" }));
    await user.click(screen.getByRole("button", { name: "新建会话" }));

    // 新会话清空输入（不再硬预填），由场景化 placeholder 引导。
    expect(screen.getByLabelText("输入你的 TSN 需求")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "会话" }));
    await waitFor(() => {
      expect(screen.getAllByText("新的 TSN 规划").length).toBeGreaterThanOrEqual(2);
    });
    const sessionsBefore = screen.getAllByText("新的 TSN 规划").length;

    // 取消路径：弹确认、不删除。
    await user.click(screen.getByRole("button", { name: "删除当前" }));
    expect(screen.getByText("删除当前会话")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("删除当前会话")).not.toBeInTheDocument();
    expect(screen.getAllByText("新的 TSN 规划")).toHaveLength(sessionsBefore);

    // 确认路径：删除生效，且「会话」抽屉保持打开（仍可见新建会话按钮与列表）。
    await user.click(screen.getByRole("button", { name: "删除当前" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(screen.getAllByText("新的 TSN 规划").length).toBeLessThan(sessionsBefore);
    });
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
  });

  it("surfaces release notes in the settings panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByText("更新日志")).toBeInTheDocument();
    expect(screen.getByText(firstReleaseNoteItem())).toBeInTheDocument();
  });
});
