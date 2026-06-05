/**
 * Plan v3 U6 — React hook：监听 `session_db_changed` + catch-up + 60s watchdog。
 *
 * 责任：
 *   1. Mount 时 `get_topology_mutations_since(sessionId, lastSeen=0)` 全量取
 *      当前 mutation 列表，触发一次 `onChange`。
 *   2. 监听 `session_db_changed` event：
 *      - mutationId === lastSeen + 1 → 直接 +1 应用
 *      - 跳号 / outOfRange → invoke catch-up 拉缺失增量
 *   3. 60s watchdog：定时调 catch-up 兜底（防 Tauri emit 丢失 #8177）。
 *   4. unmount 时 unlisten + clearInterval。
 *
 * 调用方提供 `onChange` 触发 React Flow refetch 或自己的 setState。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { listenToSessionDbChanges, type SessionDbChangedPayload } from "../../agent/listen-to-session-db-changes";

const WATCHDOG_INTERVAL_MS = 60_000;

interface MutationRecord {
  sessionId: string;
  domain: string;
  mutationId: number;
  timestampMs: number;
}

interface CatchUpResponse {
  mutations: MutationRecord[];
  latest: number;
  outOfRange: boolean;
}

async function fetchSince(sessionId: string, lastSeen: number): Promise<CatchUpResponse> {
  return invoke<CatchUpResponse>("get_topology_mutations_since", {
    request: { sessionId, lastSeen },
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UseSessionDbListenerOptions {
  sessionId: string | undefined;
  onChange: (mutations: MutationRecord[]) => void;
}

export function useSessionDbListener({ sessionId, onChange }: UseSessionDbListenerOptions): void {
  const lastSeenRef = useRef<number>(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!isTauriRuntime() || !sessionId) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchdog: number | undefined;

    const applyCatchUp = async (): Promise<void> => {
      try {
        const resp = await fetchSince(sessionId, lastSeenRef.current);
        if (cancelled) return;
        if (resp.outOfRange) {
          lastSeenRef.current = resp.latest;
          // 调用方收到空数组 + outOfRange 等同信号；UI 应做全量 refetch。
          onChangeRef.current([]);
          return;
        }
        if (resp.mutations.length > 0) {
          lastSeenRef.current = resp.latest;
          onChangeRef.current(resp.mutations);
        }
      } catch (err) {
        console.warn("get_topology_mutations_since 失败", err);
      }
    };

    // 初始全量
    void applyCatchUp();

    // 监听 wake-up event
    void (async () => {
      const off = await listenToSessionDbChanges((payload: SessionDbChangedPayload) => {
        if (payload.sessionId !== sessionId) return;
        if (payload.mutationId === lastSeenRef.current + 1) {
          // 严格连续 → 直接 +1 应用
          lastSeenRef.current = payload.mutationId;
          onChangeRef.current([{ ...payload, timestampMs: Date.now() }]);
          return;
        }
        // 跳号 / 重复 → catch-up
        void applyCatchUp();
      });
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();

    // 60s watchdog
    watchdog = window.setInterval(() => {
      void applyCatchUp();
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      cancelled = true;
      unlisten?.();
      if (watchdog !== undefined) {
        window.clearInterval(watchdog);
      }
    };
  }, [sessionId]);
}
