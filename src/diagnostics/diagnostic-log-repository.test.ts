import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserDiagnosticLogRepository } from "./diagnostic-log-repository";

describe("BrowserDiagnosticLogRepository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores logs per session without mixing timelines", async () => {
    const repository = new BrowserDiagnosticLogRepository(window.localStorage);

    await repository.append({
      sessionId: "session-a",
      category: "agent",
      message: "智能助手请求开始",
      details: { runId: "run-a" },
    });
    await repository.append({
      sessionId: "session-b",
      category: "session",
      message: "保存会话",
    });

    expect(await repository.list("session-a")).toHaveLength(1);
    expect((await repository.list("session-a"))[0].message).toBe("智能助手请求开始");
    expect(await repository.list("session-b")).toHaveLength(1);
  });

  it("redacts and truncates sensitive details before persistence", async () => {
    const repository = new BrowserDiagnosticLogRepository(window.localStorage);

    await repository.append({
      sessionId: "session-sensitive",
      category: "agent",
      level: "error",
      message: "api_key=sk-ant-secret",
      details: {
        token: "abc123",
        authorization: "Authorization: Bearer bearer-secret",
        longValue: "x".repeat(800),
      },
    });

    const rawPayload = JSON.stringify(await repository.list("session-sensitive"));

    expect(rawPayload).not.toContain("sk-ant-secret");
    expect(rawPayload).not.toContain("bearer-secret");
    expect(rawPayload).toContain("[redacted]");
    expect(rawPayload.length).toBeLessThan(1_500);
  });

  it("clears only the selected session", async () => {
    const repository = new BrowserDiagnosticLogRepository(window.localStorage);

    await repository.append({ sessionId: "session-a", category: "agent", message: "a" });
    await repository.append({ sessionId: "session-b", category: "agent", message: "b" });
    await repository.clearSession("session-a");

    expect(await repository.list("session-a")).toEqual([]);
    expect(await repository.list("session-b")).toHaveLength(1);
  });

  it("does not throw when storage writes fail", async () => {
    const repository = new BrowserDiagnosticLogRepository(window.localStorage);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage failed");
    });

    try {
      await expect(
        repository.append({ sessionId: "session-a", category: "agent", message: "will fail" }),
      ).resolves.toBeUndefined();
    } finally {
      setItem.mockRestore();
    }
  });
});
