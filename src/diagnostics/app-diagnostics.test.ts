import { describe, expect, it, vi } from "vitest";
import { createEmptySession } from "../sessions/session-repository";
import { logDiagnostic, sessionSummary, userIntentPreview } from "./app-diagnostics";
import type { DiagnosticLogRepository } from "./diagnostic-log-repository";

describe("app diagnostics helpers", () => {
  it("summarizes sessions without embedding full payloads", () => {
    const session = {
      ...createEmptySession(),
      topologyMutationId: 7,
    };

    expect(sessionSummary(session)).toMatchObject({
      title: "新的 TSN 规划",
      messageCount: 1,
      topologyMutationId: 7,
      workflowStep: "topology",
    });
  });

  it("redacts user intent previews", () => {
    expect(userIntentPreview("api_key=sk-ant-secret 我需要4个交换机").preview).not.toContain("sk-ant-secret");
  });

  it("logs best-effort without awaiting callers", () => {
    const append = vi.fn(async () => undefined);
    const repository: DiagnosticLogRepository = {
      append,
      list: vi.fn(),
      clearSession: vi.fn(),
    };

    logDiagnostic(repository, { sessionId: "session-1", category: "session", message: "保存会话" });

    expect(append).toHaveBeenCalledWith({ sessionId: "session-1", category: "session", message: "保存会话" });
  });
});
