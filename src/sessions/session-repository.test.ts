import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessionRepository,
  createEmptySession,
  redactSessionForStorage,
  SqliteSessionRepository,
  type SessionDatabase,
  type TsnSession,
} from "./session-repository";

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

  it("persists topologyMutationId across save/list round trips", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const session: TsnSession = {
      ...createEmptySession(),
      topologyMutationId: 7,
    };

    await repository.save(session);

    const restored = (await repository.list())[0];

    expect(restored.topologyMutationId).toBe(7);
  });

  it("normalizes legacy payloads without topologyMutationId", async () => {
    const repository = new BrowserSessionRepository(window.localStorage);
    const session = createEmptySession();
    // 模拟升级前 payload：附带已删除的 project/bundle 字段。
    const legacyPayload = [{
      ...session,
      project: { schemaVersion: "tsn-agent.canonical.v0", topology: { nodes: [], links: [] }, flows: [] },
      bundle: { artifacts: [] },
    }];
    window.localStorage.setItem("tsn-agent.sessions.v0", JSON.stringify(legacyPayload));

    const restored = (await repository.list())[0];

    expect(restored.id).toBe(session.id);
    expect(restored.topologyMutationId).toBeUndefined();
    expect(restored.workflow.currentStep).toBe("topology");
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

  it("maps topologyMutationId onto the stored hasProject column", async () => {
    const database = new MemoryDatabase();
    const repository = new SqliteSessionRepository(Promise.resolve(database));

    await repository.save({ ...createEmptySession(), id: "session-empty" });
    await repository.save({ ...createEmptySession(), id: "session-topo", topologyMutationId: 3 });

    expect(database.rows.get("session-empty")).toMatchObject({ hasProject: false, bundleFileCount: 0 });
    expect(database.rows.get("session-topo")).toMatchObject({ hasProject: true, bundleFileCount: 0 });
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
