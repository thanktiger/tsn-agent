import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolCallRecord } from "../../../agent/tool-call-record";
import { ToolCallCard } from "./tool-call-card";

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "toolu-1",
    name: "mcp__tsn_topology__topology_initialize",
    friendlyName: "topology.initialize",
    status: "success",
    summary: "template=line",
    args: { template: "line", switchCount: 4 },
    result: { ok: true, summary: { mutationId: 2 } },
    ...overrides,
  };
}

describe("ToolCallCard", () => {
  it("renders a collapsed one-liner with status, friendly name and summary (R1/R2)", () => {
    render(<ToolCallCard record={record()} />);

    expect(screen.getByText("topology.initialize")).toBeInTheDocument();
    expect(screen.getByText("template=line")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    // 折叠态不渲染详情。
    expect(screen.queryByText("入参")).not.toBeInTheDocument();
  });

  it("expands to show full args and result (R3/R5)", async () => {
    const user = userEvent.setup();
    render(<ToolCallCard record={record()} />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("入参")).toBeInTheDocument();
    expect(screen.getByText("出参")).toBeInTheDocument();
    expect(screen.getByText(/"switchCount": 4/)).toBeInTheDocument();
    expect(screen.getByText(/"mutationId": 2/)).toBeInTheDocument();
  });

  it("shows a truncation note when the result was truncated (R5/R6)", async () => {
    const user = userEvent.setup();
    render(<ToolCallCard record={record({ result: "x".repeat(50), resultTruncated: true })} />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByText("出参 · 结果已截断")).toBeInTheDocument();
  });

  it("marks a failed tool call (R2)", () => {
    render(<ToolCallCard record={record({ status: "error", summary: "失败：boom" })} />);

    expect(screen.getByLabelText("失败")).toBeInTheDocument();
    expect(screen.getByText("失败：boom")).toBeInTheDocument();
  });

  it("renders the running state with placeholder result (U5/R5/R9)", async () => {
    const user = userEvent.setup();
    render(<ToolCallCard record={record({ status: "running", result: undefined })} />);

    expect(screen.getByLabelText("运行中")).toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();

    await user.click(screen.getByRole("button"));

    // 入参可看，出参为占位文案。
    expect(screen.getByText(/"template": "line"/)).toBeInTheDocument();
    expect(screen.getByText("执行中…")).toBeInTheDocument();
  });

  it("keeps the expanded state across running→success flip (U5/AE1)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ToolCallCard record={record({ status: "running", result: undefined })} />);

    await user.click(screen.getByRole("button"));
    expect(screen.getByText("执行中…")).toBeInTheDocument();

    rerender(<ToolCallCard record={record({ status: "success" })} />);

    // 翻转就地更新：保持展开，出参占位被真实结果替换。
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("执行中…")).not.toBeInTheDocument();
    expect(screen.getByText(/"mutationId": 2/)).toBeInTheDocument();
    expect(screen.getByLabelText("成功")).toBeInTheDocument();
  });
});
