import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessionRepository,
  createEmptySession,
  createSessionRepository,
  redactSessionForStorage,
  SqliteSessionRepository,
  type SessionDatabase,
  type TsnSession,
} from "./session-repository";
import { createArtifactBundle } from "../export/artifact-bundle";
import { createProjectFromIntent } from "../domain/topology-factory";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createInitialWorkflowState } from "../project/project-state";

const DUAL_PLANE_TOPOLOGY_PROMPT = "我需要4个交换机，每个交换机连接2个端系统，双平面冗余";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

type StoredSession = Awaited<ReturnType<SessionDatabase["list"]>>[number];

class MemoryDatabase implements SessionDatabase {
  readonly rows = new Map<string, StoredSession>();
  currentSessionId?: string;

  async list(): Promise<StoredSession[]> {
    return this.sortedRows();
  }

  async getCurrent(): Promise<StoredSession | undefined> {
    return (this.currentSessionId ? this.rows.get(this.currentSessionId) : undefined) ?? this.sortedRows()[0];
  }

  async save(session: StoredSession): Promise<void> {
    this.rows.set(session.id, session);
    this.currentSessionId = session.id;
  }

  async setCurrent(sessionId: string): Promise<void> {
    this.currentSessionId = sessionId;
  }

  async remove(sessionId: string): Promise<void> {
    this.rows.delete(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = this.sortedRows()[0]?.id;
    }
  }

  private sortedRows(): StoredSession[] {
    return [...this.rows.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12);
  }
}

describe("BrowserSessionRepository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves, lists, duplicates, and removes sessions", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const session = createEmptySession();

    await repository.save(session);
    expect(await repository.list()).toHaveLength(1);

    const duplicated = await repository.duplicate(session.id);
    expect(duplicated?.title).toContain("副本");
    expect(await repository.list()).toHaveLength(2);

    await repository.remove(session.id);
    const sessions = await repository.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(duplicated?.id);
  });

  it("creates and persists a default session when storage is empty", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);

    const session = await repository.ensureCurrentSession();

    expect(session.messages[0].content).toContain("TSN 网络规模");
    expect(await repository.list()).toEqual([session]);
  });

  it("repairs topology drift from stored user messages when listing sessions", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const session: TsnSession = {
      ...createEmptySession(),
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
      workflow: createInitialWorkflowState(),
      project: createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统"),
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.project?.topology.nodes).toHaveLength(16);
    expect(restored.project?.topology.links).toHaveLength(16);
    expect(restored.project?.flows).toHaveLength(0);
  });

  it("does not let continuation messages rewrite a dual-plane redundant topology", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const project = createProjectFromIntent(DUAL_PLANE_TOPOLOGY_PROMPT, undefined, {
      includeControlFlow: false,
    });
    const workflow = createInitialWorkflowState();
    workflow.currentStep = "time-sync";
    workflow.stages.topology = { step: "topology", status: "confirmed" };
    workflow.stages["time-sync"] = { step: "time-sync", status: "waiting_confirmation" };

    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: DUAL_PLANE_TOPOLOGY_PROMPT,
        },
        {
          id: "message-2",
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "继续",
        },
      ],
      workflow,
      project,
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.project?.id).toBe("project-default");
    expect(restored.project?.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(restored.project?.topology.nodes.filter(isEndSystem)).toHaveLength(8);
    expect(restored.project?.topology.links).toHaveLength(18);
  });

  it("repairs stored dual-plane topology instead of preserving a generic fallback shape", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: DUAL_PLANE_TOPOLOGY_PROMPT,
        },
        {
          id: "message-2",
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "理解的对，按照上面的理解更新拓扑",
        },
      ],
      workflow: createInitialWorkflowState(),
      project: createProjectFromIntent("我需要2个交换机，每个交换机连接5个端系统", undefined, {
        includeControlFlow: false,
      }),
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.project?.id).toBe("project-default");
    expect(restored.project?.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(restored.project?.topology.nodes.filter(isEndSystem)).toHaveLength(8);
    expect(restored.project?.topology.links).toHaveLength(18);
  });

  it("repairs dual-plane topology edits that change endpoints per switch", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const project = createProjectFromIntent(DUAL_PLANE_TOPOLOGY_PROMPT, undefined, {
      includeControlFlow: false,
    });

    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: DUAL_PLANE_TOPOLOGY_PROMPT,
        },
        {
          id: "message-2",
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "每个交换机改成3个端系统，保持双平面冗余",
        },
      ],
      workflow: createInitialWorkflowState("aerospace-onboard"),
      project,
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.project?.id).toBe("project-default");
    expect(restored.project?.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(restored.project?.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(restored.project?.topology.links).toHaveLength(26);
  });

  it("repairs flow drift from stored user messages when listing sessions", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const project = createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });
    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: "我需要2个交换机，每个交换机连接3个端系统",
        },
        {
          id: "message-2",
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "两条流，一条视频流，一条控制流",
        },
      ],
      workflow: {
        ...createInitialWorkflowState(),
        currentStep: "planning-export",
      },
      project,
      bundle: {
        artifacts: [
          {
            path: "planner/flow_plan_1.json",
            purpose: "planner-input",
            label: "旧规划器输入",
            content: "{}",
          },
          {
            path: "manifest.json",
            purpose: "manifest",
            label: "导出文件清单",
            content: "{}",
          },
        ],
        manifest: {
          schemaVersion: "tsn-agent.export-manifest.v0",
          projectId: project.id,
          generatedAt: "2026-05-20T00:00:00.000Z",
          files: [],
        },
      },
    };

    await repository.save(session);

    const restored = (await repository.list())[0];
    const flowPlan = restored.bundle?.artifacts.find((artifact) => artifact.path === "planner/flow_plan_1.json");

    expect(restored.project?.flows.map((flow) => flow.name)).toEqual(["控制流-1", "视频流-1"]);
    expect(flowPlan?.content).toContain('"sendData"');
    expect(flowPlan?.content).toContain('"stream_id": 2');
  });

  it("repairs incremental video and BE flows after topology drift repair", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统", undefined, {
      includeControlFlow: false,
    });
    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: "我需要4个交换机，每个交换机连接5个端系统",
        },
        {
          id: "message-2",
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "需要改为3个交换机ring形状，每个交换机3个端系统",
        },
        {
          id: "message-3",
          role: "user",
          createdAt: "2026-05-20T00:02:00.000Z",
          content: "我还需要一条视频流，还有一条BE流",
        },
        {
          id: "message-4",
          role: "user",
          createdAt: "2026-05-20T00:03:00.000Z",
          content: "再加3条视频流吧",
        },
      ],
      workflow: {
        ...createInitialWorkflowState(),
        currentStep: "flow-template",
        stages: {
          ...createInitialWorkflowState().stages,
          topology: { step: "topology", status: "confirmed" },
          "time-sync": { step: "time-sync", status: "confirmed" },
          "flow-template": { step: "flow-template", status: "waiting_confirmation" },
          "planning-export": { step: "planning-export", status: "locked" },
        },
      },
      project,
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.project?.topology.nodes).toHaveLength(12);
    expect(restored.project?.topology.links).toHaveLength(12);
    expect(restored.project?.flows.map((flow) => flow.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "BE流-1",
      "视频流-2",
      "视频流-3",
      "视频流-4",
    ]);
  });

  it("keeps only the most recent twelve sessions", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);

    for (let index = 0; index < 14; index += 1) {
      await repository.save({
        ...createEmptySession(),
        id: `session-${index}`,
        title: `会话 ${index}`,
        updatedAt: new Date(Date.UTC(2026, 4, 20, 0, index)).toISOString(),
      });
    }

    const sessions = await repository.list();

    expect(sessions).toHaveLength(12);
    expect(sessions[0].id).toBe("session-13");
    expect(sessions.at(-1)?.id).toBe("session-2");
  });
});

describe("redactSessionForStorage", () => {
  it("redacts token-like values from messages and agent output before persistence", () => {
    const session: TsnSession = {
      ...createEmptySession(),
      messages: [
        {
          id: "message-sensitive",
          role: "assistant",
          createdAt: "2026-05-20T00:00:00.000Z",
          content: 'api_key=sk-ant-secret token: abc123 "refreshToken":"oauth-secret" Authorization: Bearer bearer-secret',
        },
      ],
      agentEvents: [
        {
          id: "event-sensitive",
          kind: "thought",
          title: "env",
          content: 'CLAUDE_API_KEY=should-not-persist {"accessToken":"json-secret"}',
        },
      ],
    };

    const redacted = redactSessionForStorage(session);
    const payload = JSON.stringify(redacted);

    expect(payload).not.toContain("sk-ant-secret");
    expect(payload).not.toContain("should-not-persist");
    expect(payload).not.toContain("oauth-secret");
    expect(payload).not.toContain("bearer-secret");
    expect(payload).not.toContain("json-secret");
    expect(payload).toContain("[redacted]");
  });
});

describe("SqliteSessionRepository", () => {
  it("stores sessions through the command database boundary and restores payloads", async () => {
    const database = new MemoryDatabase();
    const repository = new SqliteSessionRepository(Promise.resolve(database));
    const session = createEmptySession();

    await repository.save(session);

    const sessions = await repository.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(session.id);
    expect(database.rows.get(session.id)?.messageCount).toBe(1);
  });

  it("tracks the selected current session independently from recency", async () => {
    const database = new MemoryDatabase();
    const repository = new SqliteSessionRepository(Promise.resolve(database));
    const older = { ...createEmptySession(), id: "session-old", updatedAt: "2026-05-20T00:00:00.000Z" };
    const newer = { ...createEmptySession(), id: "session-new", updatedAt: "2026-05-20T00:01:00.000Z" };

    await repository.save(older);
    await repository.save(newer);
    await repository.setCurrent(older.id);

    expect((await repository.getCurrent())?.id).toBe(older.id);
  });

  it("falls back to the newest session when current id is stale", async () => {
    const database = new MemoryDatabase();
    const repository = new SqliteSessionRepository(Promise.resolve(database));
    const session = { ...createEmptySession(), id: "session-new", updatedAt: "2026-05-20T00:01:00.000Z" };

    await repository.save(session);
    await repository.setCurrent("missing-session");

    expect((await repository.getCurrent())?.id).toBe(session.id);
  });

  it("moves current session on remove and clears it when the store is empty", async () => {
    const database = new MemoryDatabase();
    const repository = new SqliteSessionRepository(Promise.resolve(database));
    const first = { ...createEmptySession(), id: "session-first", updatedAt: "2026-05-20T00:00:00.000Z" };
    const second = { ...createEmptySession(), id: "session-second", updatedAt: "2026-05-20T00:01:00.000Z" };

    await repository.save(first);
    await repository.save(second);
    await repository.remove(second.id);
    expect((await repository.getCurrent())?.id).toBe(first.id);

    await repository.remove(first.id);
    expect(await repository.getCurrent()).toBeUndefined();
  });

  it("creates a default session on an empty database", async () => {
    const repository = new SqliteSessionRepository(Promise.resolve(new MemoryDatabase()));

    const session = await repository.ensureCurrentSession();

    expect(session.title).toBe("新的 TSN 规划");
    expect(await repository.list()).toHaveLength(1);
  });

  it("loads the database lazily only once", async () => {
    const loadDatabase = vi.fn(async () => new MemoryDatabase());
    const repository = new SqliteSessionRepository(loadDatabase());

    await repository.save(createEmptySession());
    await repository.list();

    expect(loadDatabase).toHaveBeenCalledTimes(1);
  });
});

describe("createSessionRepository", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    window.localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("uses the Tauri command database in Tauri runtime", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValue([]);
    const { createSessionRepository: createRepository } = await import("./session-repository");
    const repository = createRepository();

    await repository.list();

    expect(invokeMock).toHaveBeenCalledWith("list_sessions");
  });

  it("uses browser storage outside Tauri runtime", async () => {
    const { createSessionRepository: createRepository } = await import("./session-repository");
    const repository = createRepository();
    const session = createEmptySession();

    await repository.save(session);

    expect(await repository.list()).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
