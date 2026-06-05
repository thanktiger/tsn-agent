/**
 * Plan v3 Phase B-β (PR-β1)：UI 拓扑读路径 hook。
 *
 * - Mount / 切换 session 时 `invoke("query_topology")` 拉全量快照。
 * - 复用 useSessionDbListener（`session_db_changed` 监听 + catch-up + 60s
 *   watchdog），收到任何 mutation 信号后 refetch。
 * - 非 Tauri 环境恒为 undefined（Web 无 sidecar / 工程数据库）。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TopologyRowSnapshot } from "../../sessions/topology-snapshot";
import { useSessionDbListener } from "./use-session-db-listener";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UseTopologySnapshotResult {
  snapshot: TopologyRowSnapshot | undefined;
  /** 命令式刷新：retry_backfill / import 等非 mutation-buffer 写路径后由调用方显式触发。 */
  refetch: () => Promise<void>;
}

export function useTopologySnapshot(sessionId: string | undefined): UseTopologySnapshotResult {
  const [snapshot, setSnapshot] = useState<TopologyRowSnapshot | undefined>(undefined);
  const requestSeqRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime() || !sessionId) {
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    try {
      const next = await invoke<TopologyRowSnapshot>("query_topology", { request: { sessionId } });
      // 丢弃过期响应（session 已切换或有更新请求在途）。
      if (requestSeqRef.current === requestSeq && next.sessionId === sessionId) {
        setSnapshot(next);
      }
    } catch (err) {
      console.warn("query_topology 失败", err);
    }
  }, [sessionId]);

  useEffect(() => {
    setSnapshot(undefined);
    void refetch();
  }, [refetch]);

  useSessionDbListener({
    sessionId: isTauriRuntime() ? sessionId : undefined,
    onChange: () => {
      void refetch();
    },
  });

  return { snapshot, refetch };
}
