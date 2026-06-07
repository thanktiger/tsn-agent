import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTools, type WorkspaceToolsProps } from "./index";
import { BrowserDiagnosticLogRepository } from "../../../diagnostics/diagnostic-log-repository";
import { createEmptySession } from "../../../sessions/session-repository";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function baseProps(overrides: Partial<WorkspaceToolsProps> = {}): WorkspaceToolsProps {
  const session = createEmptySession();
  return {
    activePanel: undefined,
    setActivePanel: vi.fn(),
    currentSession: session,
    sessions: [session],
    diagnosticsRepository: new BrowserDiagnosticLogRepository(createMemoryStorage()),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onDuplicateSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceTools", () => {
  it("renders the tool rail with sessions and settings buttons", () => {
    render(<WorkspaceTools {...baseProps()} />);
    expect(screen.getByRole("button", { name: /会话/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  });

  it("calls setActivePanel when a rail button is clicked", async () => {
    const user = userEvent.setup();
    const setActivePanel = vi.fn();
    render(<WorkspaceTools {...baseProps({ setActivePanel })} />);
    await user.click(screen.getByRole("button", { name: /会话/ }));
    expect(setActivePanel).toHaveBeenCalled();
  });

  it("renders the sessions drawer when activePanel is sessions", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions" })} />);
    expect(screen.getByRole("button", { name: /新建会话/ })).toBeInTheDocument();
  });

  it("calls onNewSession from the sessions drawer", async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn();
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions", onNewSession })} />);
    await user.click(screen.getByRole("button", { name: /新建会话/ }));
    expect(onNewSession).toHaveBeenCalled();
  });

  it("renders the settings drawer with the release notes heading", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "settings" })} />);
    expect(screen.getByText("更新日志")).toBeInTheDocument();
  });
});
