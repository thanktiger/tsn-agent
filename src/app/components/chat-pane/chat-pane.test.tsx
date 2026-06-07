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

  it("disables the send button when input is empty", () => {
    render(<ChatPane {...baseProps({ input: "" })} />);
    expect(screen.getByRole("button", { name: "生成规划草案" })).toBeDisabled();
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
