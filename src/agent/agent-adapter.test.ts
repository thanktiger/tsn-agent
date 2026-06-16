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

function timeSyncWaitingWorkflow(): WorkflowState {
  const base = createInitialWorkflowState();
  return {
    ...base,
    currentStep: "time-sync",
    stages: {
      ...base.stages,
      topology: { step: "topology", status: "confirmed" },
      "time-sync": { step: "time-sync", status: "waiting_confirmation", summary: "时间同步默认值。" },
    },
  };
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

  it("delivers redacted, enriched streaming tool_call events to onToolCall (U3/AE4)", async () => {
    enableTauriRuntime();
    let listenHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    const unlistenMock = vi.fn();
    listenMock.mockImplementation(async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listenHandler = handler;
      return unlistenMock;
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "query_topology") {
        return { sessionId: "session-1", nodes: [], links: [] };
      }
      if (command === "run_claude_agent") {
        // run 中途：start（含敏感入参）→ 异 runId 噪声 → result
        listenHandler?.({
          payload: {
            runId: "run-x",
            kind: "tool_call",
            toolCall: {
              id: "toolu-1",
              name: "Bash",
              phase: "start",
              args: { command: "curl -H Authorization: Bearer tok-secret-xyz" },
            },
          },
        });
        listenHandler?.({
          payload: {
            runId: "other-run",
            kind: "tool_call",
            toolCall: { id: "noise", name: "Bash", phase: "start", args: {} },
          },
        });
        listenHandler?.({
          payload: {
            runId: "run-x",
            kind: "tool_call",
            toolCall: { id: "toolu-1", name: "Bash", phase: "result", status: "success", result: { ok: true } },
          },
        });
        return { assistantText: "完成。", sessionId: "claude-session-1" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const records: import("./tool-call-record").ToolCallRecord[] = [];
    // 不传 onChunk：仅 onToolCall 也要建立监听并送达（守卫放宽）。
    await runTsnAgent({
      userIntent: "执行一个命令",
      session: sessionWithWorkflow(createInitialWorkflowState()),
      runId: "run-x",
      onToolCall: (record) => records.push(record),
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: "toolu-1", status: "running", friendlyName: "Bash" });
    // R8：到达即脱敏——args 与派生 summary 都不得携带原始 token。
    const args = records[0].args as { command: string };
    expect(args.command).toContain("[redacted]");
    expect(args.command).not.toContain("tok-secret-xyz");
    expect(records[0].summary).not.toContain("tok-secret-xyz");
    expect(records[1]).toMatchObject({ id: "toolu-1", status: "success", result: { ok: true } });
    // run 结束后监听器必须解绑（finally 路径是防泄漏的负载承重点）。
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed or unknown-phase tool_call payloads without throwing (U3)", async () => {
    enableTauriRuntime();
    let listenHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listenMock.mockImplementation(async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listenHandler = handler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "query_topology") {
        return { sessionId: "session-1", nodes: [], links: [] };
      }
      if (command === "run_claude_agent") {
        listenHandler?.({ payload: { runId: "run-x", kind: "tool_call", toolCall: { name: "Bash", phase: "start" } } });
        listenHandler?.({ payload: { runId: "run-x", kind: "tool_call", toolCall: "not-an-object" } });
        listenHandler?.({ payload: { runId: "run-x", kind: "tool_call", toolCall: { id: "toolu-2", name: "Bash", phase: "later" } } });
        return { assistantText: "完成。", sessionId: "claude-session-1" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const records: unknown[] = [];
    const result = await runTsnAgent({
      userIntent: "执行一个命令",
      session: sessionWithWorkflow(createInitialWorkflowState()),
      runId: "run-x",
      onToolCall: (record) => records.push(record),
    });

    expect(records).toHaveLength(0);
    expect(result.mode).toBe("claude");
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

  it("enriches worker toolCalls into the result (U4)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已识别拓扑需求。",
        sessionId: "claude-session-1",
        toolCalls: [
          {
            id: "toolu-1",
            name: "mcp__tsn_topology__topology_initialize",
            status: "success",
            args: { template: "line" },
            result: { ok: true, summary: { mutationId: 2 } },
          },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我需要4个交换机，每个交换机连接5个端系统",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "toolu-1",
      friendlyName: "topology.initialize",
      status: "success",
      args: { template: "line" },
    });
    expect(result.toolCalls?.[0].summary).toBeTruthy();
  });

  it("filters legacy [工具] trace lines out of the conversation context (U8)", async () => {
    enableTauriRuntime();
    mockTauriCommands({ claude: { assistantText: "好的。", sessionId: "claude-session-1" } });
    const { runTsnAgent } = await import("./agent-adapter");

    const session = sessionWithWorkflow(createInitialWorkflowState(), {
      messages: [
        { id: "u0", role: "user", content: "上一轮需求", createdAt: "2026-06-08T00:00:00Z" },
        {
          id: "a0",
          role: "assistant",
          content: "[工具] Bash: ls\n[工具结果] Bash 已返回\n真实自然语言回复。",
          createdAt: "2026-06-08T00:00:01Z",
        },
      ],
    });

    await runTsnAgent({ userIntent: "继续优化拓扑", session });

    const call = invokeMock.mock.calls.find(([command]) => command === "run_claude_agent");
    const context = (call?.[1] as { request: { conversationContext: string } }).request.conversationContext;
    expect(context).toContain("真实自然语言回复。");
    expect(context).not.toContain("[工具]");
  });

  it("returns empty toolCalls on the local boundary path (U4)", async () => {
    enableTauriRuntime();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "启动仿真",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.mode).toBe("local");
    expect(result.toolCalls ?? []).toEqual([]);
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

  it("U3: proposes a destructive rollback as pending confirmation without resetting stages", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "要切回拓扑吗？",
        sessionId: "claude-session-switch",
        stageResults: [{ kind: "stage-change-request", targetStage: "topology", reason: "用户要加设备" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "我想回到拓扑加两个端系统",
      session: sessionWithWorkflow(timeSyncWaitingWorkflow()),
    });

    expect(result.mode).toBe("claude");
    expect(result.workflow.pendingStageChange).toBe("topology");
    // 仅记 pending，尚未执行回退：当前阶段不变、拓扑仍 confirmed（未重置）。
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.stages.topology.status).toBe("confirmed");
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "confirmation-required", title: "确认切回阶段" }),
      ]),
    );
  });

  it("U3: confirm-stage action executes the pending rollback and resets later stages", async () => {
    enableTauriRuntime();
    const pending: WorkflowState = { ...timeSyncWaitingWorkflow(), pendingStageChange: "topology" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(pending),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("current");
    expect(result.workflow.stages["time-sync"].status).toBe("locked");
    expect(result.workflow.pendingStageChange).toBeUndefined();
  });

  it("U3: confirm-stage action advances a waiting stage when there is no pending rollback", async () => {
    enableTauriRuntime();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.stages.topology.status).toBe("confirmed");
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
  });

  it("U3: rejects an illegal (offline) stage-switch target", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "...",
        sessionId: "claude-session-illegal",
        stageResults: [{ kind: "stage-change-request", targetStage: "planning-export" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "切到配置生成阶段",
      session: sessionWithWorkflow(timeSyncWaitingWorkflow()),
    });

    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.pendingStageChange).toBeUndefined();
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", title: "无法切换阶段" }),
      ]),
    );
  });

  it("U3: rejects a forward stage switch proposed via the tool", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "...",
        sessionId: "claude-session-forward",
        stageResults: [{ kind: "stage-change-request", targetStage: "time-sync" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "直接进入时间同步",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.workflow.currentStep).toBe("topology");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", title: "无法前进" }),
      ]),
    );
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
