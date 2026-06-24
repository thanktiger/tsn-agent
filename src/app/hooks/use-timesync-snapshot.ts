/**
 * Plan 2026-06-24-001 U11：UI 时钟同步读路径 hook（仿 useTopologySnapshot）。
 *
 * - Mount / 切换 session 时 `invoke("query_timesync")` 拉全量配置切片。
 * - 复用 useSessionDbListener：timesync 写库经 sidecar push mutation(domain="timesync")
 *   也走 `session_db_changed`，收到信号后 refetch（端口角色重算落库后画布即更新）。
 * - 非 Tauri 环境恒为 undefined。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TimesyncSnapshot } from "../../sessions/timesync-snapshot";
import { useSessionDbListener } from "./use-session-db-listener";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UseTimesyncSnapshotResult {
  snapshot: TimesyncSnapshot | undefined;
  refetch: () => Promise<void>;
}

export function useTimesyncSnapshot(sessionId: string | undefined): UseTimesyncSnapshotResult {
  const [snapshot, setSnapshot] = useState<TimesyncSnapshot | undefined>(undefined);
  const requestSeqRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime() || !sessionId) {
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    try {
      const next = await invoke<TimesyncSnapshot>("query_timesync", { request: { sessionId } });
      // 丢弃过期响应（session 已切换或有更新请求在途）。
      if (requestSeqRef.current === requestSeq && next.sessionId === sessionId) {
        setSnapshot(next);
      }
    } catch (err) {
      console.warn("query_timesync 失败", err);
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
