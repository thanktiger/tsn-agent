import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionRepository } from "./use-session-repository";
import {
  BrowserSessionRepository,
  createEmptySession,
  type SessionRepository,
  type TsnSession,
} from "../../sessions/session-repository";
import { BrowserDiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function createTestRepository(): SessionRepository {
  return new BrowserSessionRepository(createMemoryStorage());
}

function createTestDiagnostics(): BrowserDiagnosticLogRepository {
  return new BrowserDiagnosticLogRepository(createMemoryStorage());
}

describe("useSessionRepository", () => {
  let repository: SessionRepository;
  let diagnostics: BrowserDiagnosticLogRepository;

  beforeEach(() => {
    repository = createTestRepository();
    diagnostics = createTestDiagnostics();
  });

  afterEach(() => {
    // No global state to clean.
  });

  it("hydrates with an empty initial session when repository is empty", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));

    await waitFor(() => {
      expect(result.current.isHydrating).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.currentSession.id).toBe(result.current.sessions[0].id);
    expect(result.current.currentSession.messages).toHaveLength(1);
  });

  it("hydrates with the existing current session from repository", async () => {
    const seeded: TsnSession = { ...createEmptySession(), id: "seeded-session", title: "种子会话" };
    await repository.save(seeded);
    await repository.setCurrent(seeded.id);

    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));

    await waitFor(() => {
      expect(result.current.isHydrating).toBe(false);
    });

    expect(result.current.currentSession.id).toBe("seeded-session");
    expect(result.current.sessions.map((s) => s.id)).toContain("seeded-session");
  });

  it("falls back to an in-memory session when repository throws on hydration", async () => {
    const failingRepository: SessionRepository = {
      list: async () => [],
      getCurrent: async () => undefined,
      ensureCurrentSession: async () => {
        throw new Error("repo down");
      },
      save: async () => undefined,
      setCurrent: async () => undefined,
      remove: async () => undefined,
      duplicate: async () => undefined,
    };

    const { result } = renderHook(() =>
      useSessionRepository({ repository: failingRepository, diagnostics }),
    );

    await waitFor(() => {
      expect(result.current.isHydrating).toBe(false);
    });

    expect(result.current.currentSession).toBeDefined();
    expect(result.current.sessions).toHaveLength(1);
  });

  it("persistSession saves + logs + updates currentSession when ids match", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const sessionId = result.current.currentSession.id;
    const updated: TsnSession = {
      ...result.current.currentSession,
      title: "updated title",
    };

    await act(async () => {
      await result.current.persistSession(updated);
    });

    expect(result.current.currentSession.title).toBe("updated title");
    const logs = await diagnostics.list(sessionId);
    expect(logs.some((log) => log.message === "会话已保存")).toBe(true);
  });

  it("persistSession unconditionally sets currentSession to the persisted one", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const replacement: TsnSession = {
      ...createEmptySession(),
      id: "replacement",
      title: "new tab",
    };

    await act(async () => {
      await result.current.persistSession(replacement);
    });

    expect(result.current.currentSession.id).toBe("replacement");
    expect(result.current.sessions.some((s) => s.id === "replacement")).toBe(true);
  });

  it("persistSessionIfCurrent does not overwrite currentSession when ids differ", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const orphan: TsnSession = {
      ...createEmptySession(),
      id: "orphan",
      title: "another tab",
    };

    await act(async () => {
      await result.current.persistSessionIfCurrent(orphan);
    });

    expect(result.current.currentSession.id).not.toBe("orphan");
    // Still saved to repository even if currentSession not updated
    expect(result.current.sessions.some((s) => s.id === "orphan")).toBe(true);
  });

  it("persistSessionIfCurrent updates currentSession when ids match", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const updated: TsnSession = {
      ...result.current.currentSession,
      title: "guarded title",
    };

    await act(async () => {
      await result.current.persistSessionIfCurrent(updated);
    });

    expect(result.current.currentSession.title).toBe("guarded title");
  });

  it("handleNewSession creates and switches to a new session", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const originalId = result.current.currentSession.id;
    let newSessionId = "";

    await act(async () => {
      const newSession = await result.current.handleNewSession();
      newSessionId = newSession.id;
    });

    expect(result.current.currentSession.id).toBe(newSessionId);
    expect(newSessionId).not.toBe(originalId);
  });

  it("handleSelectSession switches the current session", async () => {
    const targetSession: TsnSession = { ...createEmptySession(), id: "target", title: "target session" };
    await repository.save(targetSession);

    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    await act(async () => {
      await result.current.handleSelectSession(targetSession);
    });

    expect(result.current.currentSession.id).toBe("target");
  });

  it("handleDuplicateSession duplicates and switches", async () => {
    const original: TsnSession = { ...createEmptySession(), id: "to-dup", title: "original" };
    await repository.save(original);
    await repository.setCurrent(original.id);

    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.currentSession.id).toBe("to-dup"));

    let duplicated: TsnSession | undefined;
    await act(async () => {
      duplicated = await result.current.handleDuplicateSession();
    });

    expect(duplicated).toBeDefined();
    expect(duplicated?.id).not.toBe("to-dup");
    expect(result.current.currentSession.id).toBe(duplicated?.id);
  });

  it("handleDeleteSession removes current and switches to a new one", async () => {
    const original: TsnSession = { ...createEmptySession(), id: "to-delete", title: "delete me" };
    await repository.save(original);
    await repository.setCurrent(original.id);

    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.currentSession.id).toBe("to-delete"));

    let nextSession: TsnSession | undefined;
    await act(async () => {
      nextSession = await result.current.handleDeleteSession();
    });

    expect(nextSession).toBeDefined();
    expect(nextSession?.id).not.toBe("to-delete");
    expect(result.current.currentSession.id).toBe(nextSession?.id);
    const allSessions = await repository.list();
    expect(allSessions.some((s) => s.id === "to-delete")).toBe(false);
  });

  it("sessionExists returns true for saved sessions and false for unknown", async () => {
    const saved: TsnSession = { ...createEmptySession(), id: "known" };
    await repository.save(saved);

    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    expect(await result.current.sessionExists("known")).toBe(true);
    expect(await result.current.sessionExists("unknown")).toBe(false);
  });

  it("updateAssistantMessage updates message content when session id matches", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const session = result.current.currentSession;
    const initialMessage = session.messages[0];

    act(() => {
      result.current.updateAssistantMessage(session.id, initialMessage.id, "新内容");
    });

    expect(result.current.currentSession.messages[0].content).toBe("新内容");
  });

  it("updateAssistantMessage does not update when session id does not match", async () => {
    const { result } = renderHook(() => useSessionRepository({ repository, diagnostics }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    const session = result.current.currentSession;
    const initialContent = session.messages[0].content;

    act(() => {
      result.current.updateAssistantMessage("wrong-session", session.messages[0].id, "should not apply");
    });

    expect(result.current.currentSession.messages[0].content).toBe(initialContent);
  });
});
