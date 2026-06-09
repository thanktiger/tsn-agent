import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsLogView } from "./DiagnosticsDrawer";
import type { DiagnosticLogEntry } from "../../diagnostics/diagnostic-log";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";

function createRepository(overrides: Partial<DiagnosticLogRepository> = {}): DiagnosticLogRepository {
  const logs: DiagnosticLogEntry[] = [
    {
      id: "log-1",
      sessionId: "session-1",
      category: "agent",
      level: "info",
      message: "Claude Agent 请求完成",
      createdAt: "2026-05-20T00:00:00.000Z",
      runId: "claude-run-1",
      durationMs: 123,
      details: { mode: "claude", provider: "Claude Code" },
    },
    {
      id: "log-2",
      sessionId: "session-1",
      category: "artifact",
      level: "info",
      message: "artifact bundle 已生成",
      createdAt: "2026-05-20T00:00:01.000Z",
    },
  ];

  return {
    append: vi.fn(),
    clearSession: vi.fn(),
    list: vi.fn(async () => logs),
    ...overrides,
  };
}

describe("DiagnosticsLogView", () => {
  it("loads and renders current session logs", async () => {
    render(<DiagnosticsLogView sessionId="session-1" repository={createRepository()} />);

    expect((await screen.findAllByText("智能助手请求完成")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("artifact bundle 已生成").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("run=agent-run-1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "日志详情" })).toHaveTextContent("智能助手请求完成");
    expect(screen.getByText(/\"provider\": \"智能助手工具\"/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
  });

  it("shows an error state when loading fails", async () => {
    render(<DiagnosticsLogView sessionId="session-1" repository={createRepository({ list: vi.fn(async () => {
      throw new Error("database failed");
    }) })} />);

    expect(await screen.findByText("日志加载失败：database failed")).toBeInTheDocument();
  });
});
