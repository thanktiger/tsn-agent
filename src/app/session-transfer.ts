/**
 * 会话导出/导入编排（plan 2026-06-05-002 U4）。
 *
 * 独立于 App.tsx 的纯编排层：dialog 调用 → Tauri invoke → 错误文案映射。
 * 设计要点：
 *   - 导出覆盖确认由 OS save 对话框完成，Rust 端 tmp+rename 接受覆盖；
 *   - 导入 id 冲突静默用新 id 重试一次（boss 拍板：用户意图就是拿到数据）；
 *   - Rust 端中文/结构化错误在这里统一翻译为用户可读文案，未映射的码透传原文。
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { createId } from "../sessions/session-repository";

export type TransferNotice = { kind: "success" | "error"; text: string; path?: string };

export type ExportOutcome =
  | { status: "done"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export type ImportOutcome =
  | { status: "done"; sessionId: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const DB_FILE_FILTERS = [{ name: "HIBridge Agent 工程", extensions: ["db"] }];

/** 文件名安全化：路径分隔与控制字符替换为 '-'。 */
function sanitizeFileName(title: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 文件名安全化需显式剥离 \x00-\x1f 控制字符
  const cleaned = title.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "session";
}

export function defaultExportFileName(title: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `${sanitizeFileName(title)}-${date}.db`;
}

export async function exportCurrentSession(
  sessionId: string,
  title: string,
): Promise<ExportOutcome> {
  const targetPath = await save({
    title: "导出工程",
    defaultPath: defaultExportFileName(title),
    filters: DB_FILE_FILTERS,
  });
  if (!targetPath) {
    return { status: "cancelled" };
  }
  try {
    const path = await invoke<string>("export_session", {
      request: { sessionId, targetPath },
    });
    return { status: "done", path };
  } catch (err) {
    return { status: "error", message: `导出失败：${stringifyError(err)}` };
  }
}

export async function importSessionFromFile(): Promise<ImportOutcome> {
  const sourcePath = await open({
    title: "导入工程",
    multiple: false,
    directory: false,
    filters: DB_FILE_FILTERS,
  });
  if (!sourcePath || typeof sourcePath !== "string") {
    return { status: "cancelled" };
  }
  try {
    const resp = await invoke<{ sessionId: string }>("import_session", {
      request: { sourcePath },
    });
    return { status: "done", sessionId: resp.sessionId };
  } catch (err) {
    const message = stringifyError(err);
    // id 冲突 → 静默生成新 id 重试一次（导入为新会话）。
    if (message.includes("目标 session 已存在")) {
      try {
        const resp = await invoke<{ sessionId: string }>("import_session", {
          request: { sourcePath, newSessionId: createId("session") },
        });
        return { status: "done", sessionId: resp.sessionId };
      } catch (retryErr) {
        return { status: "error", message: mapImportError(stringifyError(retryErr)) };
      }
    }
    return { status: "error", message: mapImportError(message) };
  }
}

export async function revealExportedFile(path: string): Promise<void> {
  try {
    // 走自定义 command（Rust 端 tauri_plugin_opener 已是依赖）；
    // 不引入 @tauri-apps/plugin-opener JS 包（plan 约束：零新依赖）。
    await invoke("reveal_in_dir", { path });
  } catch (err) {
    console.warn("打开文件位置失败", err);
  }
}

/** Rust 端错误 → 用户可读文案；未识别的错误透传原文（不静默）。 */
export function mapImportError(raw: string): string {
  if (raw.includes("字节上限")) {
    return "导入失败：文件超过 10 MB 上限";
  }
  if (
    raw.includes("application_id 不匹配") ||
    raw.includes("完整性校验失败") ||
    raw.includes("不含 session 行") ||
    raw.includes("多个 session 行")
  ) {
    return "导入失败：该文件不是有效的 HIBridge Agent 工程导出文件";
  }
  return `导入失败：${raw}`;
}

function stringifyError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
