import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createEmptySession } from "../../../sessions/session-repository";
import { WorkspaceTools, type WorkspaceToolsProps } from "./index";

function baseProps(overrides: Partial<WorkspaceToolsProps> = {}): WorkspaceToolsProps {
  const session = createEmptySession();
  return {
    activePanel: undefined,
    setActivePanel: vi.fn(),
    currentSession: session,
    sessions: [session],
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onDeleteSession: vi.fn(),
    transferNotice: undefined,
    transferBusy: false,
    onExportSession: vi.fn(),
    onImportSession: vi.fn(),
    onRevealExport: vi.fn(),
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

  it("calls onExportSession / onImportSession from the sessions drawer", async () => {
    const user = userEvent.setup();
    const onExportSession = vi.fn();
    const onImportSession = vi.fn();
    render(
      <WorkspaceTools
        {...baseProps({ activePanel: "sessions", onExportSession, onImportSession })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /导出当前/ }));
    expect(onExportSession).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /导入会话/ }));
    expect(onImportSession).toHaveBeenCalled();
  });

  it("disables transfer buttons while the agent is running", () => {
    render(<WorkspaceTools {...baseProps({ activePanel: "sessions", transferBusy: true })} />);
    expect(screen.getByRole("button", { name: /导出当前/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /导入会话/ })).toBeDisabled();
  });

  it("会话预览跳过工具消息，回退到最近的自然语言对话", () => {
    const session = createEmptySession();
    session.messages = [
      {
        id: "m1",
        role: "user",
        content: "在最右边添加一个交换机",
        createdAt: "2026-06-08T00:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          '[工具] mcp__tsn_topology__topology_inspect: {}\n[工具结果] mcp__tsn_topology__topology_inspect 已返回: { "ok": true }',
        createdAt: "2026-06-08T00:00:01Z",
      },
    ];
    render(
      <WorkspaceTools
        {...baseProps({ activePanel: "sessions", currentSession: session, sessions: [session] })}
      />,
    );
    expect(screen.getByText("在最右边添加一个交换机")).toBeInTheDocument();
    expect(screen.queryByText(/\[工具\]/)).not.toBeInTheDocument();
  });

  it("新会话预览直接展示干净的自然语言（U8/R11）", () => {
    const session = createEmptySession();
    session.messages = [
      { id: "u1", role: "user", content: "我需要4个交换机", createdAt: "2026-06-09T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        content: "已为你生成 4 个交换机的拓扑草案。",
        createdAt: "2026-06-09T00:00:01Z",
        toolCalls: [
          {
            id: "toolu-1",
            name: "mcp__tsn_topology__topology_initialize",
            friendlyName: "topology.initialize",
            status: "success",
            summary: "template=line",
            args: { template: "line" },
            result: { ok: true },
          },
        ],
      },
    ];
    render(
      <WorkspaceTools
        {...baseProps({ activePanel: "sessions", currentSession: session, sessions: [session] })}
      />,
    );
    // 预览取自然语言；不读 toolCalls、不展示卡片内容。
    expect(screen.getByText("已为你生成 4 个交换机的拓扑草案。")).toBeInTheDocument();
    expect(screen.queryByText("topology.initialize")).not.toBeInTheDocument();
  });
});
