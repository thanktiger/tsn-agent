import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopologyRowSnapshot } from "../../sessions/topology-snapshot";
import { useTopologySnapshot } from "./use-topology-snapshot";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../agent/listen-to-session-db-changes", () => ({
  listenToSessionDbChanges: vi.fn(async () => () => {}),
}));

function snapshotFor(sessionId: string, nodeCount: number): TopologyRowSnapshot {
  return {
    sessionId,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      imac: index + 1,
      syncName: String(index),
      x: 0,
      y: 0,
      syncType: "{}",
      nodeType: index === 0 ? "switch" : null,
      insertOrder: index,
    })),
    links: [],
  };
}

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

describe("useTopologySnapshot", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  function mockCommands(queryImpl: (sessionId: string) => Promise<unknown>) {
    invokeMock.mockImplementation(async (command: string, args?: { request?: { sessionId?: string } }) => {
      if (command === "query_topology") {
        return queryImpl(args?.request?.sessionId ?? "unknown");
      }
      if (command === "get_topology_mutations_since") {
        return { mutations: [], latest: 0, outOfRange: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });
  }

  it("fetches the snapshot on mount", async () => {
    mockCommands(async (sessionId) => snapshotFor(sessionId, 2));

    const { result } = renderHook(() => useTopologySnapshot("s1"));

    await waitFor(() => {
      expect(result.current.snapshot?.sessionId).toBe("s1");
    });
    expect(result.current.snapshot?.nodes).toHaveLength(2);
  });

  it("refetch imperatively reloads the snapshot", async () => {
    let nodeCount = 1;
    mockCommands(async (sessionId) => snapshotFor(sessionId, nodeCount));

    const { result } = renderHook(() => useTopologySnapshot("s1"));
    await waitFor(() => expect(result.current.snapshot?.nodes).toHaveLength(1));

    // 数据在外部变化（如 retry_backfill 重建）→ 调用方显式 refetch。
    nodeCount = 5;
    await result.current.refetch();

    await waitFor(() => expect(result.current.snapshot?.nodes).toHaveLength(5));
  });

  it("discards a stale in-flight response after the session switches", async () => {
    const pending = new Map<string, Deferred>();
    mockCommands(
      (sessionId) =>
        new Promise((resolve, reject) => {
          pending.set(sessionId, { resolve, reject });
        }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useTopologySnapshot(sessionId),
      { initialProps: { sessionId: "s1" } },
    );
    await waitFor(() => expect(pending.has("s1")).toBe(true));

    rerender({ sessionId: "s2" });
    await waitFor(() => expect(pending.has("s2")).toBe(true));

    // s2 先返回 → 应用；迟到的 s1 响应必须被 requestSeq 守卫丢弃。
    pending.get("s2")!.resolve(snapshotFor("s2", 3));
    await waitFor(() => expect(result.current.snapshot?.sessionId).toBe("s2"));

    pending.get("s1")!.resolve(snapshotFor("s1", 9));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.snapshot?.sessionId).toBe("s2");
    expect(result.current.snapshot?.nodes).toHaveLength(3);
  });

  it("keeps the snapshot undefined when the query rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCommands(async () => {
      throw new Error("db locked");
    });

    const { result } = renderHook(() => useTopologySnapshot("s1"));

    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(result.current.snapshot).toBeUndefined();
    warn.mockRestore();
  });

  it("does not invoke outside the Tauri runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    const { result } = renderHook(() => useTopologySnapshot("s1"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.snapshot).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
