import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock, open: openMock }));

import {
  defaultExportFileName,
  exportCurrentSession,
  importSessionFromFile,
  mapImportError,
  revealExportedFile,
} from "./session-transfer";

describe("session-transfer", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    openMock.mockReset();
  });

  describe("exportCurrentSession", () => {
    it("invokes export_session with the chosen path", async () => {
      saveMock.mockResolvedValue("/tmp/out.db");
      invokeMock.mockResolvedValue("/tmp/out.db");

      const outcome = await exportCurrentSession("s1", "我的拓扑");

      expect(outcome).toEqual({ status: "done", path: "/tmp/out.db" });
      expect(invokeMock).toHaveBeenCalledWith("export_session", {
        request: { sessionId: "s1", targetPath: "/tmp/out.db" },
      });
    });

    it("returns cancelled without invoking when the dialog is dismissed", async () => {
      saveMock.mockResolvedValue(null);

      const outcome = await exportCurrentSession("s1", "t");

      expect(outcome).toEqual({ status: "cancelled" });
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("surfaces Rust errors as readable text", async () => {
      saveMock.mockResolvedValue("/tmp/out.db");
      invokeMock.mockRejectedValue("会话不存在：s1");

      const outcome = await exportCurrentSession("s1", "t");

      expect(outcome.status).toBe("error");
      expect(outcome.status === "error" && outcome.message).toContain("会话不存在");
    });
  });

  describe("importSessionFromFile", () => {
    it("imports and returns the session id", async () => {
      openMock.mockResolvedValue("/tmp/in.db");
      invokeMock.mockResolvedValue({ sessionId: "imported" });

      const outcome = await importSessionFromFile();

      expect(outcome).toEqual({ status: "done", sessionId: "imported" });
      expect(invokeMock).toHaveBeenCalledWith("import_session", {
        request: { sourcePath: "/tmp/in.db" },
      });
    });

    it("retries exactly once with a fresh id on conflict", async () => {
      openMock.mockResolvedValue("/tmp/in.db");
      invokeMock
        .mockRejectedValueOnce("目标 session 已存在：session-abc")
        .mockResolvedValueOnce({ sessionId: "session-new" });

      const outcome = await importSessionFromFile();

      expect(outcome).toEqual({ status: "done", sessionId: "session-new" });
      expect(invokeMock).toHaveBeenCalledTimes(2);
      const retryArgs = invokeMock.mock.calls[1][1] as { request: { newSessionId?: string } };
      expect(retryArgs.request.newSessionId).toMatch(/^session-/);
    });

    it("does not retry twice when the conflict persists", async () => {
      openMock.mockResolvedValue("/tmp/in.db");
      invokeMock
        .mockRejectedValueOnce("目标 session 已存在：a")
        .mockRejectedValueOnce("目标 session 已存在：b");

      const outcome = await importSessionFromFile();

      expect(outcome.status).toBe("error");
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });

    it("returns cancelled when no file is picked", async () => {
      openMock.mockResolvedValue(null);

      const outcome = await importSessionFromFile();

      expect(outcome).toEqual({ status: "cancelled" });
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe("revealExportedFile", () => {
    it("invokes reveal_in_dir with the path", async () => {
      invokeMock.mockResolvedValue(undefined);

      await revealExportedFile("/tmp/out.db");

      expect(invokeMock).toHaveBeenCalledWith("reveal_in_dir", { path: "/tmp/out.db" });
    });

    it("swallows reveal failures with a console warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      invokeMock.mockRejectedValue("路径不存在");

      await expect(revealExportedFile("/gone.db")).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("mapImportError", () => {
    it("formats the byte cap as MB", () => {
      expect(mapImportError("源文件超过 10485760 字节上限，禁止导入")).toBe(
        "导入失败：文件超过 10 MB 上限",
      );
    });

    it("translates format-validation failures to a single readable message", () => {
      for (const raw of [
        "源 db application_id 不匹配（期望 0x54534E01，实际 0x00000000）",
        "源 db 完整性校验失败：corrupt",
        "源 db 不含 session 行",
        "源 db 含多个 session 行；Import 仅支持 single-session 切片",
      ]) {
        expect(mapImportError(raw)).toBe("导入失败：该文件不是有效的 TSN Agent 会话导出文件");
      }
    });

    it("passes through limit-rejection details verbatim", () => {
      const raw = "源拓扑节点数 201 超过上限 200，拒绝导入";
      expect(mapImportError(raw)).toBe(`导入失败：${raw}`);
    });
  });

  describe("defaultExportFileName", () => {
    it("sanitizes path-hostile characters and appends the date", () => {
      const name = defaultExportFileName("a/b:c*d", new Date("2026-06-05T12:00:00Z"));
      expect(name).toBe("a-b-c-d-2026-06-05.db");
    });
  });
});
