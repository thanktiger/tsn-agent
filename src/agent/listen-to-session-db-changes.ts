/**
 * Plan v3 U6 — Tauri event 监听 helper：`session_db_changed` 仅作 wake-up 信号，
 * 真实数据切片由 UI 调 `query_topology` Tauri command 拉取。
 *
 * 沿用 `agent-adapter.ts::listenToClaudeChunks` 的 try/listen/unlisten 模式。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SessionDbChangedPayload {
  sessionId: string;
  domain: string;
  mutationId: number;
}

export async function listenToSessionDbChanges(
  onChange: (payload: SessionDbChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionDbChangedPayload>("session_db_changed", (event) => {
    if (
      event.payload &&
      typeof event.payload.sessionId === "string" &&
      typeof event.payload.mutationId === "number"
    ) {
      onChange(event.payload);
    }
  });
}
