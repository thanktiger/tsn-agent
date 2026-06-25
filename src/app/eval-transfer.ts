// Plan 2026-06-25-002 U6：eval store 取用/清除的纯编排层（dialog → Tauri invoke）。
// 磁盘格式即数据集（JSONL）；导出≈把 eval.jsonl 拷到用户选定路径。

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type EvalExportOutcome =
  | { status: "done"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** 打开 eval 目录（系统文件管理器）。 */
export async function openEvalDir(): Promise<void> {
  await invoke("open_eval_dir");
}

/** 导出整份 eval 数据集到用户选定路径（含未脱敏原文，Rust 端设 0600）。 */
export async function exportEvalDataset(): Promise<EvalExportOutcome> {
  const targetPath = await save({
    defaultPath: "tsn-agent-eval.jsonl",
    filters: [{ name: "JSONL dataset", extensions: ["jsonl"] }],
  });
  if (!targetPath) {
    return { status: "cancelled" };
  }
  try {
    await invoke("export_eval_dataset", { request: { targetPath } });
    return { status: "done", path: targetPath };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** 清空整个 eval store。 */
export async function clearEvalStore(): Promise<void> {
  await invoke("clear_eval_store");
}

/** 只清某会话的 eval 样本（U7 隐私兜底）。 */
export async function clearEvalForSession(sessionId: string): Promise<void> {
  await invoke("clear_eval_for_session", { request: { sessionId } });
}
