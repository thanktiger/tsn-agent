import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailRow, Stat, formatTime } from "./shared";

describe("shared primitives", () => {
  it("DetailRow renders its label and value", () => {
    render(<DetailRow label="IMAC" value={42} />);
    expect(screen.getByText("IMAC")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("Stat renders the label repeated with its numeric value", () => {
    render(<Stat label="交换机" value={4} />);
    expect(screen.getByText("交换机 4")).toBeInTheDocument();
  });

  it("formatTime renders a zh-CN month/day hour:minute string", () => {
    const out = formatTime("2026-06-07T11:30:00Z");
    expect(out).toMatch(/\d{2}\/\d{2}/);
    expect(out).toMatch(/\d{2}:\d{2}/);
  });
});
