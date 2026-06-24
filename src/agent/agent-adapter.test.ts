import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import {
  createInitialWorkflowState,
  recordStageResult,
  type WorkflowState,
} from "../project/project-state";
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

function mockTauriCommands(
  options: {
    claude?: Record<string, unknown>;
    claudeError?: unknown;
    topology?: Record<string, unknown>;
    verify?: Record<string, unknown>;
    verifyError?: unknown;
  } = {},
) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "query_topology") {
      return options.topology ?? { sessionId: "session-1", nodes: [], links: [] };
    }

    if (command === "verify_topology") {
      if (options.verifyError !== undefined) {
        throw options.verifyError;
      }
      // 默认通过：确认过关闸放行，既有 confirm 测试不被新闸拦。
      return options.verify ?? { ok: true, caliber: "structural_only", errors: [] };
    }

    if (command === "verify_inet") {
      // verify_inet 已不在拓扑确认链路触发（INET 挪到流量规划）；保留 mock 默认仅为「未被调用」断言兜底。
      return { ok: true, caliber: "loadability_only", errors: [] };
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

function sessionWithWorkflow(
  workflow: WorkflowState,
  overrides: Partial<TsnSession> = {},
): TsnSession {
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
      "time-sync": {
        step: "time-sync",
        status: "waiting_confirmation",
        summary: "时间同步默认值。",
      },
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
      expect.arrayContaining([expect.objectContaining({ kind: "error", title: "需要桌面版" })]),
    );
  });

  it("delivers redacted, enriched streaming tool_call events to onToolCall (U3/AE4)", async () => {
    enableTauriRuntime();
    let listenHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    const unlistenMock = vi.fn();
    listenMock.mockImplementation(
      async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
        listenHandler = handler;
        return unlistenMock;
      },
    );
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
            toolCall: {
              id: "toolu-1",
              name: "Bash",
              phase: "result",
              status: "success",
              result: { ok: true },
            },
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
    listenMock.mockImplementation(
      async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
        listenHandler = handler;
        return vi.fn();
      },
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "query_topology") {
        return { sessionId: "session-1", nodes: [], links: [] };
      }
      if (command === "run_claude_agent") {
        listenHandler?.({
          payload: {
            runId: "run-x",
            kind: "tool_call",
            toolCall: { name: "Bash", phase: "start" },
          },
        });
        listenHandler?.({
          payload: { runId: "run-x", kind: "tool_call", toolCall: "not-an-object" },
        });
        listenHandler?.({
          payload: {
            runId: "run-x",
            kind: "tool_call",
            toolCall: { id: "toolu-2", name: "Bash", phase: "later" },
          },
        });
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
          scenarioConfigId: "aerospace-onboard",
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
    const context = (call?.[1] as { request: { conversationContext: string } }).request
      .conversationContext;
    expect(context).toContain("真实自然语言回复。");
    expect(context).not.toContain("[工具]");
  });

  it("injects the undo-rollback notice when pendingUndoNotice is set (U7)", async () => {
    enableTauriRuntime();
    mockTauriCommands({ claude: { assistantText: "好的。", sessionId: "claude-session-1" } });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "现在有几个交换机？",
      session: sessionWithWorkflow({ ...createInitialWorkflowState(), pendingUndoNotice: true }),
    });

    const call = invokeMock.mock.calls.find(([command]) => command === "run_claude_agent");
    const context = (call?.[1] as { request: { conversationContext: string } }).request
      .conversationContext;
    expect(context).toContain("上一步拓扑变更已被撤销");
    expect(context).toContain("topology.inspect");
    // 一次性：注入后标志从返回的 workflow 清除，避免下一轮重复注入。
    expect(result.workflow.pendingUndoNotice).toBeUndefined();
  });

  it("omits the undo-rollback notice when pendingUndoNotice is absent (U7)", async () => {
    enableTauriRuntime();
    mockTauriCommands({ claude: { assistantText: "好的。", sessionId: "claude-session-1" } });
    const { runTsnAgent } = await import("./agent-adapter");

    await runTsnAgent({
      userIntent: "现在有几个交换机？",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    const call = invokeMock.mock.calls.find(([command]) => command === "run_claude_agent");
    const context = (call?.[1] as { request: { conversationContext: string } }).request
      .conversationContext;
    expect(context).not.toContain("上一步拓扑变更已被撤销");
  });

  it("clears pendingUndoNotice on a confirm-stage advance so it cannot fire a stale turn later (U7)", async () => {
    enableTauriRuntime();
    mockTauriCommands();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow({ ...topologyWaitingWorkflow(), pendingUndoNotice: true }),
    });

    expect(result.mode).toBe("local");
    // 确认推进后标志必须清除——否则会在推进后的别的阶段晚一轮发出陈旧回退通知。
    expect(result.workflow.pendingUndoNotice).toBeUndefined();
  });

  it("returns empty toolCalls on the deterministic confirm path (U4)", async () => {
    enableTauriRuntime();
    mockTauriCommands();
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.mode).toBe("local");
    expect(result.toolCalls ?? []).toEqual([]);
  });

  it("blocks topology advance-confirm when structural verification fails (gate)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      verify: {
        ok: false,
        caliber: "structural_only",
        errors: [
          { code: "ISOLATED_NODE", messageZh: "ES-2 没连任何线，是个孤立节点。", nodeRef: "2" },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    // 不推进：仍停在 topology、waiting_confirmation。
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.verification?.ok).toBe(false);
    expect(result.assistantText).toContain("孤立节点");
    expect(result.assistantText).toContain("确认并继续");
    // 结构失败 → 短路、不进 INET 闸。
    const inetCalls = invokeMock.mock.calls.filter(([command]) => command === "verify_inet");
    expect(inetCalls).toHaveLength(0);
  });

  it("U4: normal verify failure relays Rust messageZh verbatim (TS does not re-author per-error text)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      verify: {
        ok: false,
        caliber: "structural_only",
        errors: [
          { code: "ISOLATED_NODE", messageZh: "ES-7 没连任何线，是个孤立节点。", nodeRef: "7" },
          { code: "DUP_SYNC_NAME", messageZh: "syncName 3 被两个节点占用。", nodeRef: "3" },
        ],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    // 逐条文案直接来自 Rust messageZh（节点专属串 TS 无从硬编码 → 证明透传，不另写）。
    expect(result.assistantText).toContain("ES-7 没连任何线，是个孤立节点。");
    expect(result.assistantText).toContain("syncName 3 被两个节点占用。");
    // 展示框架（可修复语气 + CTA）保留，但走的是结构分支、不是 INET 分支文案。
    expect(result.assistantText).toContain("先修好再继续");
    expect(result.assistantText).toContain("确认并继续");
    expect(result.assistantText).not.toContain("连不上远端 INET");
  });

  it("U4: inet_unreachable keeps its dedicated display text and drops per-error messageZh (intentional divergence, unchanged)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      verify: {
        ok: false,
        caliber: "loadability_only",
        errors: [{ code: "inet_unreachable", messageZh: "INET 远端 10.0.0.9 不可达。" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    // 环境问题分支：固定展示文案，不把 messageZh 当拓扑错逐条列（故意分叉，本次不收敛）。
    expect(result.assistantText).toContain("连不上远端 INET");
    expect(result.assistantText).not.toContain("INET 远端 10.0.0.9 不可达。");
    // 校验失败必拦推进：仍停 topology/waiting_confirmation（review 补：U4 inet 后置条件）。
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
  });

  it("advances topology confirm silently when the structural gate passes (no extra prompt; INET moved to flow-planning)", async () => {
    enableTauriRuntime();
    mockTauriCommands(); // 结构闸默认通过
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.workflow.currentStep).toBe("time-sync"); // 已推进
    // 通过即静默推进：不再单独弹「结构没问题」（结构反馈由 agent 操作拓扑时经 MCP validate 给出）。
    expect(result.assistantText).not.toContain("结构没问题");
    expect(result.verification).toBeUndefined();
    // 仍走结构校验兜底硬拦，但不再调 verify_inet（INET 已挪到流量规划阶段）。
    const verifyCalls = invokeMock.mock.calls.filter(([command]) => command === "verify_topology");
    expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
    const inetCalls = invokeMock.mock.calls.filter(([command]) => command === "verify_inet");
    expect(inetCalls).toHaveLength(0);
  });

  it("does NOT verify a rollback-confirm (pendingStageChange present)", async () => {
    enableTauriRuntime();
    mockTauriCommands();
    const { runTsnAgent } = await import("./agent-adapter");

    // 在 topology 阶段、带 pendingStageChange（回退确认场景的近似）：闸不应触发。
    const base = topologyWaitingWorkflow();
    const rollbackWorkflow: WorkflowState = {
      ...base,
      pendingStageChange: "topology",
      pendingStageChangeIntent: "减少一个交换机",
    };

    await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(rollbackWorkflow),
    });

    // 回退确认不调任何过关闸（结构 + INET 都不触发）。
    const verifyCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "verify_topology" || command === "verify_inet",
    );
    expect(verifyCalls).toHaveLength(0);
  });

  it("fail-closed: verify_topology rejection does not advance and shows a dedicated message", async () => {
    enableTauriRuntime();
    mockTauriCommands({ verifyError: new Error("sidecar down") });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.workflow.currentStep).toBe("topology"); // 不放行
    expect(result.mode).toBe("local");
    expect(result.assistantText).toContain("结构校验暂时无法运行");
    expect(result.verification).toBeUndefined();
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

  it("confirms a waiting topology stage via the button and auto-generates time-sync defaults (U4 regression)", async () => {
    enableTauriRuntime();
    mockTauriCommands(); // 过关闸默认通过（verify ok=true）
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.mode).toBe("local");
    // 拓扑前进确认现在先过结构校验闸（调 verify_topology），不再是完全 invoke-free。
    expect(invokeMock.mock.calls.some(([command]) => command === "verify_topology")).toBe(true);
    expect(result.workflow.stages.topology.status).toBe("confirmed");
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    // 阶段处理没丢：进入 time-sync 自动生成默认摘要。
    expect(result.workflow.stages["time-sync"].summary).toContain("统一时钟");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "confirmation-required", stage: "time-sync" }),
      ]),
    );
  });

  it("shows the offline notice when the confirm button advances into a gray stage (U4 regression)", async () => {
    enableTauriRuntime();
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "time-sync";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = {
      step: "time-sync",
      status: "waiting_confirmation",
      summary: "时间同步默认值。",
    };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(workflow),
    });

    expect(result.mode).toBe("local");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.currentStep).toBe("flow-template");
    expect(result.assistantText).toContain("暂时下线");
  });

  it("sends a typed confirmation word to the model instead of regex-matching it (U4)", async () => {
    enableTauriRuntime();
    mockTauriCommands({ claude: { assistantText: "好的。", sessionId: "claude-session-typed" } });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    // 没有 action：自由文本「继续」不再被正则确定性推进，而是走大模型。
    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", expect.anything());
  });

  it("sends offline-stage free-form input to the model without rewriting the stage (U4)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: { assistantText: "流量规划暂时下线。", sessionId: "claude-session-offline" },
    });
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

    expect(result.mode).toBe("claude");
    // 决议1：stage 不再被改写成 topology，发给 worker 的是真实当前阶段。
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        stageRunnerInput: expect.objectContaining({ stage: "flow-template" }),
      }),
    });
  });

  it("proposes a rollback to topology when the model requests it from an offline stage (U4)", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "要切回拓扑修改吗？",
        sessionId: "claude-session-edit",
        stageResults: [
          { kind: "stage-change-request", targetStage: "topology", reason: "用户要改交换机数量" },
        ],
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
    // stage 不改写：worker 收到真实当前阶段 flow-template，切阶段由工具表达。
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        stageRunnerInput: expect.objectContaining({ stage: "flow-template" }),
      }),
    });
    // 破坏性回退先记 pending、不立即执行（等用户点确认按钮）。
    expect(result.workflow.pendingStageChange).toBe("topology");
    expect(result.workflow.currentStep).toBe("flow-template");
    expect(result.workflow.stages.topology.status).toBe("confirmed");
    // fix A：提议不改写当前阶段状态（不留幽灵 waiting_confirmation）。
    expect(result.workflow.stages["flow-template"].status).toBe("current");
  });

  it("U3-fix(carry): stores the triggering intent with the pending rollback proposal", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "要切回拓扑吗？",
        sessionId: "s-carry-store",
        stageResults: [{ kind: "stage-change-request", targetStage: "topology", reason: "减设备" }],
      },
    });
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    workflow.stages["flow-template"] = { step: "flow-template", status: "current" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "减少一个交换机",
      session: sessionWithWorkflow(workflow),
    });

    expect(result.workflow.pendingStageChange).toBe("topology");
    expect(result.workflow.pendingStageChangeIntent).toBe("减少一个交换机");
  });

  it("U3-fix(carry): confirming the rollback re-runs the original intent in topology without retyping", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "已减少一个交换机。",
        sessionId: "s-carry-run",
        stageResults: [validStageResult(12)],
      },
    });
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    workflow.stages["flow-template"] = { step: "flow-template", status: "current" };
    const pending: WorkflowState = {
      ...workflow,
      pendingStageChange: "topology",
      pendingStageChangeIntent: "减少一个交换机",
    };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(pending),
    });

    // 切阶段后自动用原话跑了大模型（不是停在 local 让用户重输）。
    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        prompt: "减少一个交换机",
        stageRunnerInput: expect.objectContaining({ stage: "topology" }),
      }),
    });
    expect(result.topologyMutationId).toBe(12);
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.workflow.pendingStageChange).toBeUndefined();
    expect(result.workflow.pendingStageChangeIntent).toBeUndefined();
  });

  it("U3-fix(A): abandoning a pending rollback via free text clears it and leaves no phantom confirm", async () => {
    enableTauriRuntime();
    const base = createInitialWorkflowState();
    base.currentStep = "flow-template";
    base.stages.topology = { step: "topology", status: "confirmed" };
    base.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    base.stages["flow-template"] = { step: "flow-template", status: "current" };
    const pending: WorkflowState = { ...base, pendingStageChange: "topology" };
    mockTauriCommands({ claude: { assistantText: "好的，继续看流量。", sessionId: "s-abandon" } });
    const { runTsnAgent } = await import("./agent-adapter");

    const abandoned = await runTsnAgent({
      userIntent: "先不切了，讲讲流量规划",
      session: sessionWithWorkflow(pending),
    });
    expect(abandoned.workflow.pendingStageChange).toBeUndefined();
    expect(abandoned.workflow.stages["flow-template"].status).toBe("current");

    // 放弃后点确认按钮：既无 pending 又非 waiting_confirmation → 无操作，绝不静默前进。
    invokeMock.mockClear();
    const confirmed = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(abandoned.workflow),
    });
    expect(confirmed.mode).toBe("local");
    expect(confirmed.workflow.currentStep).toBe("flow-template");
    expect(confirmed.assistantText).toContain("没有待确认的操作");
  });

  it("U3-fix(E): confirming a rollback to time-sync re-arms it with auto-generated defaults", async () => {
    enableTauriRuntime();
    const base = createInitialWorkflowState();
    base.currentStep = "flow-template";
    base.stages.topology = { step: "topology", status: "confirmed" };
    base.stages["time-sync"] = { step: "time-sync", status: "confirmed" };
    base.stages["flow-template"] = { step: "flow-template", status: "current" };
    const pending: WorkflowState = { ...base, pendingStageChange: "time-sync" };
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(pending),
    });

    expect(result.mode).toBe("local");
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(result.workflow.stages["time-sync"].summary).toContain("统一时钟");
    expect(result.workflow.pendingStageChange).toBeUndefined();
    expect(result.workflow.stages["flow-template"].status).toBe("locked");
  });

  it("U3-fix: suppresses the no-topology-result notice when a stage-change proposal is present", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: {
        assistantText: "...",
        sessionId: "s-suppress",
        stageResults: [{ kind: "stage-change-request", targetStage: "time-sync" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "进入时间同步",
      session: sessionWithWorkflow(createInitialWorkflowState()),
    });

    expect(result.events.find((event) => event.title === "拓扑未更新")).toBeUndefined();
    expect(result.events.find((event) => event.title === "无法前进")).toBeDefined();
  });

  it("includes the current topology snapshot counts in the conversation context", async () => {
    enableTauriRuntime();
    mockTauriCommands({
      claude: { assistantText: "好的。", sessionId: "claude-session-context" },
      topology: {
        sessionId: "session-1",
        nodes: [
          { syncName: "0", name: null, x: 0, y: 0, nodeType: "switch", insertOrder: 0 },
          { syncName: "1", name: null, x: 1, y: 0, nodeType: null, insertOrder: 1 },
        ],
        links: [{ linkSeq: 0, name: null, srcSyncName: "0", dstSyncName: "1", stylesJson: "{}" }],
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
        stageResults: [
          { kind: "stage-change-request", targetStage: "topology", reason: "用户要加设备" },
        ],
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
    mockTauriCommands(); // 过关闸默认通过
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续",
      action: "confirm-stage",
      session: sessionWithWorkflow(topologyWaitingWorkflow()),
    });

    expect(result.mode).toBe("local");
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
        stageResults: [{ kind: "stage-change-request", targetStage: "flow-template" }],
      },
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "切到流量规划阶段",
      session: sessionWithWorkflow(timeSyncWaitingWorkflow()),
    });

    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.workflow.pendingStageChange).toBeUndefined();
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "error", title: "无法切换阶段" })]),
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
      expect.arrayContaining([expect.objectContaining({ kind: "error", title: "无法前进" })]),
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
