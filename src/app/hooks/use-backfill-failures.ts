/**
 * Backfill 失败列表 hook（plan 2026-06-05-002 U5）。
 *
 * 查询型 UI，无事件依赖：启动期 walker 在 Tauri setup 内同步完成于窗口创建
 * 之前，mount 时 `list_backfill_failures` 的数据已就绪；retry 是 await 型
 * invoke，由调用方在 resolve 后用 `refresh()` 命令式重拉。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface BackfillFailureRow {
  sessionId: string;
  state: string;
  errorCode: string | null;
  attemptedAt: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UseBackfillFailuresResult {
  failures: BackfillFailureRow[];
  refresh: () => Promise<void>;
}

export function useBackfillFailures(): UseBackfillFailuresResult {
  const [failures, setFailures] = useState<BackfillFailureRow[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      return;
    }
    try {
      const rows = await invoke<BackfillFailureRow[]>("list_backfill_failures");
      // 防御非数组返回（测试 mock 缺分支时 invoke 返回 undefined → .map 崩）。
      setFailures(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.warn("list_backfill_failures 失败", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { failures, refresh };
}

/** error_code → 用户可读文案；未知码透传原文（不静默）。 */
export function describeBackfillError(errorCode: string | null): string {
  if (!errorCode) {
    return "原因未知";
  }
  if (errorCode.startsWith("PAYLOAD_NOT_JSON")) {
    return "原始数据不是合法 JSON";
  }
  if (errorCode.startsWith("CANONICAL_SCHEMA_INVALID")) {
    return "原始数据缺少必需字段";
  }
  if (errorCode.startsWith("CONSTRAINT_VIOLATION")) {
    return "数据写入冲突";
  }
  return errorCode;
}
