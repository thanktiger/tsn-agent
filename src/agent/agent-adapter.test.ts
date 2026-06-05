import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { createInitialWorkflowState, recordStageResult, type WorkflowState } from "../project/project-state";
import { createEmptySession, type TsnSession } from "../sessions/session-repository";
import { createTopologyWorkflowStageResult } from "./topology-workflow-stage-result";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

function createDiagnosticsRecorder() {
  const entries: unknown[] = [];
  const repository: DiagnosticLogRepository = {
    append: vi.fn(async (entry) => {
      entries.push(entry);
    }),
    list: vi.fn(async () => []),
    clearSession: vi.fn(async () => undefined),
  };

  return { repository, entries };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

function enableTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function mockTauriCommands(options: {
  claude?: Record<string, unknown>;
  claudeError?: unknown;
  topology?: Record<string, unknown>;
}) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "query_topology") {
      return options.topology ?? { sessionId: "session-1", nodes: [], links: [] };
    }

    if (command === "run_claude_agent") {
      if (options.claudeError !== undefined) {
        throw options.claudeError;
      }
      return options.claude ?? { assistantText: "好的。", sessionId: "claude-session-1" };
    }

    throw new Error(`unexpected command: ${command}`);
  });
}

function sessionWithWorkflow(workflow: WorkflowState, overrides: Partial<TsnSession> = {}): TsnSession {
  return {
    ...createEmptySession(),
    id: "session-1",
    workflow,
    ...overrides,
  };
}

function topologyWaitingWorkflow(): WorkflowState {
  return recordStageResult(createInitialWorkflowState(), {
    step: "topology",
    summary: "拓扑已生成",
  });
}

function validStageResult(mutationId = 7) {
  return createTopologyWorkflowStageResult(
    { sessionId: "session-1", mutationId },
    {
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.apply_operations",
      },
    },
  );
}

describe("runTsnAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("fails closed outside Tauri with a desktop CTA", async () => {
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要2个交换机，每个交换机连接2个端系统");

    expect(result.mode).toBe("unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.assistantText).toContain("桌面版");
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", title: "需要桌面版" }),
      ]),
    );
  });

  it("returns plain chat when a topology run produces no structured stage result", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: { assistantText: "已识别拓扑需求。", sessionId: "claude-session-1" },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要4个交换机，每个交换机连接5个端系统",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        prompt: "我需要4个交换机，每个交换机连接5个端系统",
        appSessionId: "session-1",
        stageRunnerInput: expect.objectContaining({
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        }),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("当前还没有生成拓扑"),
      }),
    });
    expect(result.assistantText).toBe("已识别拓扑需求。");
    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.topologyMutationId).toBeUndefined();
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thought",
          title: "拓扑未更新",
        }),
      ]),
    );
  });

  it("applies a validated mutationId stage result from the worker", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已通过 tsn_topology 写入拓扑。",
        sessionId: "claude-session-stage",
        stageResults: [validStageResult(7)],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机，每个交换机连接2个端系统",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.mode).toBe("claude");
    expect(result.topologyMutationId).toBe(7);
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.workflow.stages.topology.stageResult).toMatchObject({
      producer: {
        type: "mcp",
        name: "tsn_topology",
      },
      validation: { ok: true, errors: [] },
    });
    expect(result.claudeSessionId).toBe("claude-session-stage");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stage-result", stage: "topology" }),
        expect.objectContaining({ kind: "confirmation-required", stage: "topology" }),
      ]),
    );
  });

  it("rejects malformed stage results and keeps the workflow unchanged", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已生成拓扑。",
        sessionId: "claude-session-bad",
        stageResults: [
          {
            ...validStageResult(1),
            payload: { kind: "topology", sessionId: "session-1", mutationId: 0 },
          },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.topologyMutationId).toBeUndefined();
    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          title: "结构化结果未应用",
          content: expect.stringContaining("mutationId"),
        }),
      ]),
    );
  });

  it("rejects stage results whose sessionId does not match the current session", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已写入拓扑。",
        sessionId: "claude-session-mismatch",
        stageResults: [
          createTopologyWorkflowStageResult(
            { sessionId: "session-other", mutationId: 5 },
            { producer: { type: "mcp", name: "tsn_topology" } },
          ),
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.topologyMutationId).toBeUndefined();
    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          content: expect.stringContaining("session-other"),
        }),
      ]),
    );
  });

  it("rejects placeholder stage results for other stages", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "时间同步完成。",
        sessionId: "claude-session-ts",
        stageResults: [
          {
            schemaVersion: "tsn-agent.workflow-stage-result.v1",
            stage: "time-sync",
            producer: { type: "local-runtime", name: "tsn-agent" },
            status: "success",
            summary: "时间同步默认值。",
            validation: { ok: true, errors: [] },
            payload: { kind: "time-sync" },
          },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          content: expect.stringContaining("time-sync 阶段结果暂未启用"),
        }),
      ]),
    );
  });

  it("confirms a waiting topology stage locally and advances into time-sync defaults", async () => {
    enableTauriRuntime();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.stages.topology.status).toBe("confirmed");
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "confirmation-required", stage: "time-sync" }),
      ]),
    );
  });

  it("advances time-sync defaults locally for free-form input in the time-sync stage", async () => {
    enableTauriRuntime();
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "time-sync";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "current" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "时间同步怎么配置？",
      session: sessionWithWorkflow(workflow),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
  });

  it("rejects simulation execution requests locally", async () => {
    enableTauriRuntime();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "帮我启动仿真",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.assistantText).toContain("不会在后台启动仿真");
  });

  it("answers offline-stage input locally when no topology intent is present", async () => {
    enableTauriRuntime();
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    workflow.stages["flow-template"] = { step: "flow-template", status: "current" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "帮我建两条视频流",
      session: sessionWithWorkflow(workflow),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.assistantText).toContain("暂时下线");
    expect(result.workflow.currentStep).toBe("flow-template");
  });

  it("falls back to the topology stage when offline-stage input asks for topology changes", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已更新拓扑。",
        sessionId: "claude-session-edit",
        stageResults: [validStageResult(9)],
      },
    });
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    workflow.stages["flow-template"] = { step: "flow-template", status: "current" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "改成3个交换机，每个交换机2个端系统",
      session: sessionWithWorkflow(workflow),
    });

    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        stageRunnerInput: expect.objectContaining({ stage: "topology" }),
      }),
    });
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.topologyMutationId).toBe(9);
  });

  it("includes the current topology snapshot counts in the conversation context", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: { assistantText: "好的。", sessionId: "claude-session-context" },
      topology: {
        sessionId: "session-1",
        nodes: [
          { imac: 1, syncName: "0", x: 0, y: 0, syncType: "{}", nodeType: "switch", insertOrder: 0 },
          { imac: 2, syncName: "1", x: 1, y: 0, syncType: "{}", nodeType: null, insertOrder: 1 },
        ],
        links: [
          { linkSeq: 0, name: null, srcImac: 1, dstImac: 2, stylesJson: "{}" },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    await runTsnAgent({
      userIntent: "当前拓扑是什么样的？",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(invokeMock).toHaveBeenCalledWith("query_topology", {
      request: { sessionId: "session-1" },
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("拓扑：2 个节点，1 条链路"),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机：1"),
      }),
    });
  });

  it("keeps the workflow and reports failure when the Claude command throws", async () => {
    enableTauriRuntime();
    mockTauriCommands({ claudeError: "worker exited" });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.mode).toBe("claude");
    expect(result.assistantText).toContain("worker exited");
    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", title: "智能助手执行失败" }),
      ]),
    );
  });

  it("replaces assistant text that claims simulations are running", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "正在后台运行仿真，跑完会通知你。",
        sessionId: "claude-session-sim",
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.assistantText).not.toContain("跑完会通知你");
    expect(result.assistantText).toContain("不会启动仿真");
  });

  it("records diagnostics for the run lifecycle", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已写入拓扑。",
        sessionId: "claude-session-diag",
        stageResults: [validStageResult(3)],
      },
    });
    const { repository, entries } = createDiagnosticsRecorder();
    const { runTsnAgent } = await import("./agent-adapter");

    await runTsnAgent({
      userIntent: "我需要2个交换机",
      session: sessionWithWorkflow(createInitialWorkflowState()),
      diagnostics: repository,
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Agent 请求开始" }),
        expect.objectContaining({
          message: "智能助手请求完成",
          details: expect.objectContaining({ topologyMutationId: 3 }),
        }),
      ]),
    );
  });
});
