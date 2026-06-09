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
});
