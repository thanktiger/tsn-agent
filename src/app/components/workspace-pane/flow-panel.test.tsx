import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FlowPanel, type FlowPanelProps } from "./flow-panel";
import type { PlanResult, VerifyTasResult } from "./flow-sim";

function planOk(overrides: Partial<PlanResult> = {}): PlanResult {
  return {
    caliber: "flow_tas_planned",
    status: "ok",
    solver: "Z3",
    gateCount: 4,
    overall: "已综合 4 个门控条目（带可调度性保证）。",
    ...overrides,
  };
}

function verifyResult(overrides: Partial<VerifyTasResult> = {}): VerifyTasResult {
  return {
    caliber: "flow_tas_verified",
    status: "ok",
    overall: "1 个达标 / 0 个未达标",
    perStream: [
      {
        streamSeq: 0,
        talker: "1",
        listener: "2",
        received: 3,
        expected: 3,
        jitterMaxNs: 120,
        latencyMaxNs: 240,
        windowNs: 400000,
        pass: true,
      },
    ],
    ...overrides,
  };
}

function baseProps(overrides: Partial<FlowPanelProps> = {}): FlowPanelProps {
  return {
    inFlowStage: true,
    sessionId: "s1",
    planState: { status: "idle" },
    onPlanStateChange: vi.fn(),
    verifyState: { status: "idle" },
    onVerifyStateChange: vi.fn(),
    planTas: vi.fn(async () => planOk()),
    verifyTas: vi.fn(async () => verifyResult()),
    ...overrides,
  };
}

describe("FlowPanel", () => {
  it("R21：容器级诚实标注始终可见（读到结果前即可见）", () => {
    render(<FlowPanel {...baseProps()} />);
    expect(screen.getByText(/仿真实测 · 非 T10 硬件判决/)).toBeTruthy();
  });

  it("非 flow 阶段规划按钮禁用", () => {
    render(<FlowPanel {...baseProps({ inFlowStage: false })} />);
    expect(screen.getByRole("button", { name: "规划门控表" }).hasAttribute("disabled")).toBe(true);
  });

  it("点击规划 → 调 plan_tas，onPlanStateChange running→done", async () => {
    const planTas = vi.fn(async () => planOk());
    const onPlanStateChange = vi.fn();
    render(<FlowPanel {...baseProps({ planTas, onPlanStateChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "规划门控表" }));
    await waitFor(() => expect(planTas).toHaveBeenCalledTimes(1));
    expect(onPlanStateChange).toHaveBeenCalledWith({ status: "running" });
    await waitFor(() =>
      expect(onPlanStateChange).toHaveBeenCalledWith({ status: "done", result: planOk() }),
    );
  });

  it("双击只派发一次（inflight 守卫）", async () => {
    let resolveFn: (r: PlanResult) => void = () => {};
    const planTas = vi.fn(() => new Promise<PlanResult>((res) => (resolveFn = res)));
    render(<FlowPanel {...baseProps({ planTas })} />);
    const btn = screen.getByRole("button", { name: "规划门控表" });
    fireEvent.click(btn);
    fireEvent.click(btn); // 第二次应被 ref 守卫拦
    expect(planTas).toHaveBeenCalledTimes(1);
    resolveFn(planOk());
  });

  it("R22：规划进行中显示进行中态", () => {
    render(<FlowPanel {...baseProps({ planState: { status: "running" } })} />);
    expect(screen.getByRole("button", { name: "综合中…（分钟级）" })).toBeTruthy();
    expect(screen.getByText(/正在跑 Z3 门控综合/)).toBeTruthy();
  });

  it("R8/KTD7：Z3 出带保证徽章、Eager 出兜底无保证徽章", () => {
    const { rerender } = render(
      <FlowPanel
        {...baseProps({ planState: { status: "done", result: planOk({ solver: "Z3" }) } })}
      />,
    );
    expect(screen.getByText(/Z3·带可调度性保证/)).toBeTruthy();
    rerender(
      <FlowPanel
        {...baseProps({
          planState: { status: "done", result: planOk({ solver: "Eager" }) },
        })}
      />,
    );
    expect(screen.getByText(/Eager·兜底解无保证/)).toBeTruthy();
  });

  it("规划成功后才允许验证", () => {
    const { rerender } = render(<FlowPanel {...baseProps()} />);
    // 未规划 → 验证禁用。
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(true);
    rerender(<FlowPanel {...baseProps({ planState: { status: "done", result: planOk() } })} />);
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("验证结果渲染逐流表（收/发 + 判定）", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: verifyResult() } })} />,
    );
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText("达标")).toBeTruthy();
  });

  it("R16：空结果不渲染逐流表（不染绿）", () => {
    const empty = verifyResult({ status: "empty", perStream: [], overall: "结果为空" });
    render(<FlowPanel {...baseProps({ verifyState: { status: "done", result: empty } })} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/结果为空/)).toBeTruthy();
  });

  it("会话切换后迟到结果被丢弃", async () => {
    let resolveFn: (r: PlanResult) => void = () => {};
    const planTas = vi.fn(() => new Promise<PlanResult>((res) => (resolveFn = res)));
    const onPlanStateChange = vi.fn();
    const { rerender } = render(
      <FlowPanel {...baseProps({ sessionId: "s1", planTas, onPlanStateChange })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "规划门控表" }));
    await waitFor(() => expect(planTas).toHaveBeenCalled());
    // 切到 s2，再让 s1 的命令落地。
    rerender(<FlowPanel {...baseProps({ sessionId: "s2", planTas, onPlanStateChange })} />);
    resolveFn(planOk());
    await Promise.resolve();
    // 只应有 running（发起时）；done 被丢弃（runSessionId !== 当前）。
    expect(onPlanStateChange).not.toHaveBeenCalledWith({ status: "done", result: planOk() });
  });
});
