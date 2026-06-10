import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatPane, AgentRunStatusBar, type ChatPaneProps } from "./index";
import type { ChatMessage } from "../../../sessions/session-repository";
import { getScenarioConfig } from "../../../domain/scenario-config";
import { createInitialWorkflowState } from "../../../project/project-state";

function baseProps(overrides: Partial<ChatPaneProps> = {}): ChatPaneProps {
  const workflow = createInitialWorkflowState();
  return {
    scenarioConfig: getScenarioConfig(workflow.scenarioConfigId),
    workflow,
    currentStage: workflow.stages[workflow.currentStep],
    messages: [],
    pendingAssistantMessageId: undefined,
    scrollContainerRef: createRef<HTMLDivElement | null>(),
    input: "",
    isAgentRunning: false,
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("AgentRunStatusBar", () => {
  it("shows the phase-specific message and elapsed seconds", () => {
    render(<AgentRunStatusBar elapsedSeconds={5} phase="streaming" />);
    expect(screen.getByText(/正在持续推理/)).toBeInTheDocument();
    expect(screen.getByText(/已运行 5 秒/)).toBeInTheDocument();
  });
});

describe("ChatPane", () => {
  it("keeps the Phase B offline banner visible", () => {
    render(<ChatPane {...baseProps()} />);
    expect(screen.getByRole("note")).toHaveTextContent("流量规划与规划导出在当前版本暂时下线");
  });

  it("renders chat messages", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "我需要 4 个交换机", createdAt: "2026-06-07T00:00:00Z" },
    ];
    render(<ChatPane {...baseProps({ messages })} />);
    expect(screen.getByText("我需要 4 个交换机")).toBeInTheDocument();
  });

  it("renders streaming tool cards above the waiting indicator on the pending message (U5)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "我需要双平面拓扑", createdAt: "2026-06-10T00:00:00Z" },
      {
        id: "m2",
        role: "assistant",
        content: "正在连接智能助手",
        createdAt: "2026-06-10T00:00:01Z",
        toolCalls: [
          {
            id: "toolu-1",
            name: "mcp__tsn_topology__topology_initialize",
            friendlyName: "topology.initialize",
            status: "running",
            summary: "template=dual-plane-redundant",
            args: { template: "dual-plane-redundant" },
          },
        ],
      },
    ];
    render(<ChatPane {...baseProps({ messages, pendingAssistantMessageId: "m2" })} />);

    // pending 态：卡片与等待指示器同时可见，卡片在前。
    expect(screen.getByText("topology.initialize")).toBeInTheDocument();
    expect(screen.getByLabelText("运行中")).toBeInTheDocument();
    const article = screen.getByText("topology.initialize").closest("article");
    const waiting = screen.getByText(/正在连接智能助手，并结合当前会话上下文/);
    expect(article).toContainElement(waiting);
    expect(
      article?.querySelector(".tool-call-list")?.compareDocumentPosition(waiting) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("disables the send button when input is empty", () => {
    render(<ChatPane {...baseProps({ input: "" })} />);
    expect(screen.getByRole("button", { name: "生成规划草案" })).toBeDisabled();
  });

  it("submits on plain Enter and inserts a newline on Cmd/Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onInputChange = vi.fn();
    render(<ChatPane {...baseProps({ input: "需求", onSubmit, onInputChange })} />);
    const textarea = screen.getByLabelText("输入你的 TSN 需求") as HTMLTextAreaElement;

    textarea.focus();
    textarea.setSelectionRange(2, 2);
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Cmd+Enter：不发送，在光标处插入换行。
    textarea.setSelectionRange(2, 2);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onInputChange).toHaveBeenCalledWith("需求\n");

    // Ctrl+Enter 同理。
    onInputChange.mockClear();
    textarea.setSelectionRange(2, 2);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onInputChange).toHaveBeenCalledWith("需求\n");
  });

  it("does not submit on Enter while the agent is running or input is empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<ChatPane {...baseProps({ input: "需求", onSubmit, isAgentRunning: true })} />);
    screen.getByLabelText("输入你的 TSN 需求").focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<ChatPane {...baseProps({ input: "   ", onSubmit })} />);
    screen.getByLabelText("输入你的 TSN 需求").focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit when the send button is clicked with input present", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ChatPane {...baseProps({ input: "需求", onSubmit })} />);
    await user.click(screen.getByRole("button", { name: "生成规划草案" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("calls onInputChange when typing in the textarea", async () => {
    const user = userEvent.setup();
    const onInputChange = vi.fn();
    render(<ChatPane {...baseProps({ onInputChange })} />);
    await user.type(screen.getByLabelText("输入你的 TSN 需求"), "x");
    expect(onInputChange).toHaveBeenCalled();
  });

  it("shows a confirm button that calls onConfirm when the stage awaits confirmation", async () => {
    const user = userEvent.setup();
    const workflow = createInitialWorkflowState();
    const waitingStage = {
      ...workflow.stages[workflow.currentStep],
      status: "waiting_confirmation" as const,
      summary: "已识别 4 个交换机。",
    };
    const onConfirm = vi.fn();
    render(<ChatPane {...baseProps({ currentStage: waitingStage, onConfirm })} />);

    const confirmButton = screen.getByRole("button", { name: "确认并继续" });
    expect(confirmButton).toBeInTheDocument();
    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalled();
  });
});
