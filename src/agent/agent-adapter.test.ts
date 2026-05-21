import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectFromIntent } from "../domain/topology-factory";
import type { DiagnosticLogRepository } from "../diagnostics/diagnostic-log-repository";
import { createInitialWorkflowState } from "../project/project-state";
import { STAGE_SKILL_SCHEMA_VERSION } from "./stage-skill-contract";
import { runFlowPlanningStage, runTopologyStage } from "../../src-node/stage-skills/tsn-stage-runner";

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

describe("runTsnAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("uses the deterministic fake agent outside Tauri", async () => {
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.bundle).toBeUndefined();
    expect(result.project.flows).toHaveLength(0);
  });

  it("uses Claude output in Tauri while keeping deterministic artifacts", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "Claude 已识别拓扑需求。",
      sessionId: "claude-session-1",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("claude");
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: {
        prompt: "我需要4个交换机，每个交换机连接5个端系统",
        runId: expect.stringMatching(/^agent-run-/),
        appSessionId: undefined,
        conversationContext: expect.stringContaining("交换机：4"),
        resumeSessionId: undefined,
        stageRunnerInput: expect.objectContaining({
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        }),
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("当前阶段：拓扑"),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机互联：线型互联"),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("流：尚未生成"),
      }),
    });
    expect(result.assistantText).toBe("智能助手已识别拓扑需求。");
    expect(result.claudeSessionId).toBe("claude-session-1");
    expect(result.project.topology.nodes).toHaveLength(24);
    expect(result.project.flows).toHaveLength(0);
  });

  it("applies a validated topology stage result from the worker", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "已通过 tsn-topology 生成拓扑。",
      sessionId: "claude-session-stage",
      stageResults: [
        runTopologyStage({ userIntent: "我需要2个交换机，每个交换机连接2个端系统" }),
      ],
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("claude");
    expect(result.project.topology.nodes).toHaveLength(6);
    expect(result.project.topology.links).toHaveLength(5);
    expect(result.workflow.stages.topology.skillResult).toMatchObject({
      skillName: "tsn-topology",
      validation: { ok: true, errors: [] },
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool-availability",
          content: expect.stringContaining("Bash、Edit、Write"),
        }),
        expect.objectContaining({
          kind: "skill-result",
          skillName: "tsn-topology",
          content: expect.stringContaining("6 个节点"),
        }),
      ]),
    );
  });

  it("applies a validated flow planning stage result from the worker", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const topologyProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统，使用环形互联", undefined, {
      includeControlFlow: false,
    });
    const existingFlowResult = runFlowPlanningStage({
      userIntent: "我还需要一条视频流，还有一条BE流",
      project: topologyProject,
    });
    if (existingFlowResult.stage !== "flow-template") {
      throw new Error("expected flow-template stage");
    }
    const projectWithExistingFlows = existingFlowResult.payload.project;
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology.status = "confirmed";
    workflow.stages["time-sync"].status = "confirmed";
    workflow.stages["flow-template"].status = "waiting_confirmation";
    invokeMock.mockResolvedValue({
      assistantText: "已通过 tsn-flow-planning 更新流量规划。",
      sessionId: "claude-session-flow-stage",
      stageResults: [
        runFlowPlanningStage({
          userIntent: "再加3条视频流吧",
          project: projectWithExistingFlows,
        }),
      ],
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "再加3条视频流吧",
      session: {
        id: "session-flow-stage",
        title: "流量规划会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow,
        project: projectWithExistingFlows,
      },
    });

    expect(result.mode).toBe("claude");
    expect(result.project.flows.map((flow) => flow.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "BE流-1",
      "视频流-2",
      "视频流-3",
      "视频流-4",
    ]);
    expect(result.workflow.currentStep).toBe("flow-template");
    expect(result.workflow.stages["flow-template"].skillResult).toMatchObject({
      skillName: "tsn-flow-planning",
      validation: { ok: true, errors: [] },
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill-result",
          skillName: "tsn-flow-planning",
          content: expect.stringContaining("已准备 6 条流"),
        }),
      ]),
    );
  });

  it("uses the current deterministic fallback when a worker stage result fails validation", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });
    invokeMock.mockResolvedValue({
      assistantText: "拓扑已更新。",
      sessionId: "claude-session-invalid-stage",
      stageResults: [
        {
          schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
          stage: "topology",
          skillName: "tsn-topology",
          status: "failed",
          summary: "拓扑校验失败。",
          validation: { ok: false, errors: ["链路端点不存在。"] },
          payload: {
            kind: "topology",
            project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统", undefined, {
              includeControlFlow: false,
            }),
          },
        },
      ],
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "改成4个交换机，每个交换机连接5个端系统",
      session: {
        id: "session-invalid-stage",
        title: "已有拓扑",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
        project: previousProject,
      },
    });

    expect(result.project.topology.nodes).toHaveLength(24);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          content: expect.stringContaining("已使用本地 fallback"),
        }),
      ]),
    );
  });

  it("keeps current deterministic flow edits when the worker returns a result for the wrong stage", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const topologyProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统，使用环形互联", undefined, {
      includeControlFlow: false,
    });
    const existingFlowResult = runFlowPlanningStage({
      userIntent: "我还需要一条视频流",
      project: topologyProject,
    });
    if (existingFlowResult.stage !== "flow-template") {
      throw new Error("expected flow-template stage");
    }
    const projectWithExistingFlows = existingFlowResult.payload.project;
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "flow-template";
    workflow.stages.topology.status = "confirmed";
    workflow.stages["time-sync"].status = "confirmed";
    workflow.stages["flow-template"].status = "waiting_confirmation";
    invokeMock.mockResolvedValue({
      assistantText: "返回了错误阶段结果。",
      sessionId: "claude-session-wrong-stage-result",
      stageResults: [
        runTopologyStage({
          userIntent: "我需要2个交换机，每个交换机连接2个端系统",
        }),
      ],
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "再加3条视频流吧",
      session: {
        id: "session-wrong-stage-result",
        title: "流量规划会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow,
        project: projectWithExistingFlows,
      },
    });

    expect(result.project.flows.map((flow) => flow.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "视频流-2",
      "视频流-3",
      "视频流-4",
    ]);
    expect(result.workflow.currentStep).toBe("flow-template");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          content: expect.stringContaining("当前阶段是 flow-template"),
        }),
      ]),
    );
  });

  it("sends explicit context and forwards streaming chunks", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let eventHandler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_eventName, handler) => {
      eventHandler = handler;
      return unlisten;
    });
    invokeMock.mockImplementation(async (_command, payload) => {
      eventHandler?.({
        payload: {
          runId: payload.request.runId,
          kind: "chunk",
          text: "流式片段",
        },
      });

      return {
        assistantText: "最终回复",
        sessionId: "claude-session-2",
      };
    });
    const chunks: string[] = [];
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "继续配置时钟",
      onChunk: (chunk) => chunks.push(chunk),
      session: {
        id: "session-1",
        title: "已有会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        claudeSessionId: "claude-session-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            createdAt: "2026-05-20T00:00:00.000Z",
            content: "我需要4个交换机",
          },
        ],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
      },
    });

    expect(chunks).toEqual(["流式片段"]);
    expect(unlisten).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        prompt: "继续配置时钟",
        appSessionId: "session-1",
        resumeSessionId: "claude-session-1",
        conversationContext: expect.stringContaining("我需要4个交换机"),
      }),
    });
    expect(result.claudeSessionId).toBe("claude-session-2");
  });

  it("records diagnostic entries for a Claude run", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "最终回复",
      sessionId: "claude-session-logs",
    });
    const diagnostics = createDiagnosticsRecorder();
    const { runTsnAgent } = await import("./agent-adapter");

    await runTsnAgent({
      userIntent: "我需要4个交换机",
      diagnostics: diagnostics.repository,
      session: {
        id: "session-logs",
        title: "日志会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
      },
    });

    expect(diagnostics.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-logs",
          category: "agent",
          message: "Agent 请求开始",
        }),
        expect.objectContaining({
          sessionId: "session-logs",
          category: "agent",
          message: "智能助手请求完成",
          details: expect.objectContaining({
            claudeSessionId: "claude-session-logs",
          }),
        }),
      ]),
    );
  });

  it("sends the current generated project as authoritative context", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "已按当前 3 交换机拓扑继续。",
      sessionId: "claude-session-3",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "直接生成",
      session: {
        id: "session-1",
        title: "已有会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        claudeSessionId: "claude-session-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            createdAt: "2026-05-20T00:00:00.000Z",
            content: "我需要3个交换机，每个交换机连接3个端系统",
          },
        ],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
        project: createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统"),
      },
    });

    expect(result.project.topology.nodes).toHaveLength(12);
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机：3"),
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("端系统：9"),
      }),
    });
  });

  it("sends corrected per-switch host count and ring interconnect as authoritative context", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "已按 4 台交换机、每台 3 个端系统和环形互联更新。",
      sessionId: "claude-session-ring",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const first = await runTsnAgent("我需要3个交换机，每个交换机连接5个端系统");
    const second = await runTsnAgent({
      userIntent: "需要改成4台交换机，每台连接3个端",
      session: {
        id: "session-ring",
        title: "拓扑会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: first.workflow,
        project: first.project,
      },
    });
    const ring = await runTsnAgent({
      userIntent: "可以使用环形互联",
      session: {
        id: "session-ring",
        title: "拓扑会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: second.workflow,
        project: second.project,
      },
    });

    expect(ring.project.topology.nodes).toHaveLength(16);
    expect(ring.project.topology.links).toHaveLength(16);
    expect(invokeMock).toHaveBeenLastCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机：4"),
      }),
    });
    expect(invokeMock).toHaveBeenLastCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("端系统：12"),
      }),
    });
    expect(invokeMock).toHaveBeenLastCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("交换机互联：环形互联"),
      }),
    });
  });

  it("repairs a saved project that drifted from user topology messages before continuing", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "继续处理当前拓扑。",
      sessionId: "claude-session-repair",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "说明当前拓扑",
      session: {
        id: "session-repair",
        title: "漂移会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [
          {
            id: "message-1",
            role: "user",
            createdAt: "2026-05-20T00:00:00.000Z",
            content: "我需要3个交换机，每个交换机连接5个端系统",
          },
          {
            id: "message-2",
            role: "user",
            createdAt: "2026-05-20T00:01:00.000Z",
            content: "需要改成4台交换机，每台连接3个端",
          },
          {
            id: "message-3",
            role: "user",
            createdAt: "2026-05-20T00:02:00.000Z",
            content: "可以使用环形互联",
          },
        ],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
        project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
      },
    });

    expect(result.project.topology.nodes).toHaveLength(16);
    expect(result.project.topology.links).toHaveLength(16);
    expect(result.project.flows).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("run_claude_agent", {
      request: expect.objectContaining({
        conversationContext: expect.stringContaining("端系统：12"),
      }),
    });
  });

  it("uses deterministic stage text for boundary confirmations so Claude cannot skip time sync", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "拓扑已确认，现在进入下一步：配置控制流。",
      sessionId: "claude-session-wrong-stage",
    });
    const { runTsnAgent } = await import("./agent-adapter");
    const topologyProject = createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "topology";
    workflow.stages.topology = {
      ...workflow.stages.topology,
      status: "waiting_confirmation",
      summary: "识别到 2 个交换机，每个交换机连接 3 个端系统。",
    };

    const result = await runTsnAgent({
      userIntent: "继续",
      session: {
        id: "session-stage",
        title: "阶段会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow,
        project: topologyProject,
      },
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("fake");
    expect(result.workflow.currentStep).toBe("time-sync");
    expect(result.assistantText).toContain("默认假设全网已完成时间同步");
    expect(result.assistantText).not.toContain("配置控制流");
  });

  it("does not send simulation requests to Claude because no runner is implemented", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue({
      assistantText: "已经在远程服务器启动仿真，稍后通知结果。",
      sessionId: "claude-session-sim",
    });
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent({
      userIntent: "启动仿真",
      session: {
        id: "session-sim",
        title: "仿真会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
        messages: [],
        agentEvents: [],
        workflow: createInitialWorkflowState(),
        project: createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统"),
      },
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("fake");
    expect(result.assistantText).toContain("不会在后台启动仿真");
  });

  it("falls back to fake output when Claude command fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockRejectedValue("claude failed");
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(result.assistantText).toContain("本机智能助手暂时不可用");
    expect(result.assistantText).not.toContain("failed");
  });

  it("normalizes Error objects when Claude command fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockRejectedValue(new Error("sdk failed"));
    const { runTsnAgent } = await import("./agent-adapter");

    const result = await runTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.mode).toBe("fake");
    expect(result.assistantText).toContain("本机智能助手暂时不可用");
    expect(result.assistantText).not.toContain("sdk failed");
  });
});
