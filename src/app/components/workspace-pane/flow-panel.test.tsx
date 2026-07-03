import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FlowPanel, type FlowPanelProps } from "./flow-panel";
import type { FlowPlanDetail, PlanResult, StreamVerdict, VerifyTasResult } from "./flow-sim";

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

/** U7 多轮夹具：健康轮三类全绿 + 断A轮（RC 判/ST 报告态/untested）+ 断B轮 busy。 */
function verdict(overrides: Partial<StreamVerdict> = {}): StreamVerdict {
  return {
    streamSeq: 0,
    class: "RC",
    talker: "1",
    listener: "2",
    received: 2001,
    expected: 2001,
    jitterMaxNs: 120,
    latencyMaxNs: 100000,
    windowNs: 400000,
    pass: true,
    judged: true,
    ...overrides,
  };
}

function roundsResult(): VerifyTasResult {
  return verifyResult({
    overall:
      "健康轮：3 个达标 / 0 个未达标；断A轮：1 个达标 / 0 个未达标（另 1 个仅报告）；断B轮：busy",
    rounds: [
      {
        round: "healthy",
        status: "ok",
        perStream: [
          verdict(),
          verdict({ streamSeq: 1, class: "ST" }),
          verdict({ streamSeq: 2, class: "BE", received: 1000, deliveryRatio: 0.5 }),
        ],
        annotations: [],
        untestedStreams: [],
        gptpDiag: {
          convergedNodes: 3,
          totalNodes: 4,
          thresholdSummary: "1000ns",
          worstNode: "es2",
          worstOffsetNs: 1500,
        },
      },
      {
        round: "fault_a",
        status: "ok",
        perStream: [
          verdict(),
          verdict({
            streamSeq: 1,
            class: "ST",
            judged: false,
            note: "仅健康轮判（故障轮不判）",
          }),
        ],
        annotations: ["断链：t=400ms 单向断开链路 0（上游节点 1 出向）"],
        untestedStreams: ["流 3：未测容错（断点不在其该平面路径上）"],
      },
      {
        round: "fault_b",
        status: "busy",
        perStream: [],
        annotations: ["软仿服务占用"],
        untestedStreams: [],
      },
    ],
  });
}

/** U2 门控明细夹具：默认未规划（entries=[] 且有 ST 流）。 */
function planDetail(overrides: Partial<FlowPlanDetail> = {}): FlowPlanDetail {
  return {
    cycleNs: 1_000_000,
    solver: "Z3",
    stCount: 1,
    rcCount: 0,
    beCount: 0,
    entries: [],
    ...overrides,
  };
}

/** 已规划夹具：两个端口各一条 ST 门条目（es2 开窗起点 0 在前、sw1 在后，阶梯错位）。 */
function planDetailWithGcl(): FlowPlanDetail {
  return planDetail({
    beCount: 1,
    entries: [
      {
        node: "0",
        nodeName: "sw1",
        ethN: 1,
        gateIndex: 7,
        initiallyOpen: false,
        offsetNs: 0,
        durationsNs: [472_390, 4_560, 523_050],
      },
      {
        node: "2",
        nodeName: "es2",
        ethN: 0,
        gateIndex: 7,
        initiallyOpen: true,
        offsetNs: 0,
        durationsNs: [300_000, 700_000],
      },
    ],
  });
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
    getFlowPlan: vi.fn(async () => planDetail()),
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

  it("Covers AE5：no_gating（流集无 ST 流）后软仿验证按钮放行且文案可见", () => {
    const noGating = planOk({
      status: "no_gating",
      solver: undefined,
      gateCount: 0,
      overall: "流集无 ST 流，无需门控综合；可直接验证。",
    });
    render(<FlowPanel {...baseProps({ planState: { status: "done", result: noGating } })} />);
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/无需门控综合/)).toBeTruthy();
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

  it("U7：有 rounds 按轮分组渲染（健康轮/断A轮/断B轮小节 + 顶层摘要串联）", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    // U3 徽章条头：轮名与状态徽章分列（文案语义不变）。
    expect(screen.getByText("健康轮")).toBeTruthy();
    expect(screen.getByText("断A轮")).toBeTruthy();
    expect(screen.getByText("断B轮")).toBeTruthy();
    expect(screen.getAllByText("通过").length).toBe(2); // 健康轮 + 断A轮。
    expect(screen.getByText("服务占用（稍后重试）")).toBeTruthy();
    // 顶层摘要沿 U6 overall 串联。
    expect(screen.getByText(/健康轮：3 个达标/)).toBeTruthy();
  });

  it("U3：轮状态徽章化（sim-badge ok/bad）+ 标注 chips 进徽章条", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    const okBadges = screen.getAllByText("通过");
    for (const badge of okBadges) {
      expect(badge.className).toContain("sim-badge");
      expect(badge.className).toContain("ok");
    }
    const busyBadge = screen.getByText("服务占用（稍后重试）");
    expect(busyBadge.className).toContain("sim-badge");
    expect(busyBadge.className).toContain("bad");
    // 断链标注作为 chip 仍可见。
    expect(screen.getByText(/断链：t=400ms/).className).toContain("flow-round-chip");
  });

  it("U7：多轮表带「类别」列，RC 行时延/抖动标「首达路实测」", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    expect(screen.getAllByText("类别").length).toBeGreaterThan(0);
    expect(screen.getAllByText("RC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BE").length).toBeGreaterThan(0);
    // RC 行两列（抖动/时延）都带首达路标注；ST/BE 行不带。
    expect(screen.getAllByText(/首达路实测/).length).toBe(4); // 健康轮 + 断A轮各 2 格。
  });

  it("U7/R13：BE 行达标旁并列送达率", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    expect(screen.getByText("达标（送达率 50%）")).toBeTruthy();
  });

  it("U7/R15：gPTP 诊断行文案逐轮渲染（只报告）", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    expect(
      screen.getByText("gPTP 收敛：3/4 节点 ≤ 阈值（1000ns），最差 1500 ns @es2"),
    ).toBeTruthy();
  });

  it("U7/KTD8：报告态行显示 note、untested 流标记与断链标注可见", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: roundsResult() } })} />,
    );
    expect(screen.getByText("仅健康轮判（故障轮不判）")).toBeTruthy();
    expect(screen.getByText(/流 3：未测容错/)).toBeTruthy();
    expect(screen.getByText(/断链：t=400ms/)).toBeTruthy();
  });

  it("U7：无 rounds 老结果渲染现状不变（无轮小节、无类别列）", () => {
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: verifyResult() } })} />,
    );
    expect(screen.queryByText(/健康轮/)).toBeNull();
    expect(screen.queryByText("类别")).toBeNull();
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText("达标")).toBeTruthy();
  });

  it("U8/R15：无 rounds 结果带顶层 gptpDiag → 渲染一行诊断（纯 ST/纯 BE 会话也有）", () => {
    const withDiag = verifyResult({
      gptpDiag: {
        convergedNodes: 2,
        totalNodes: 2,
        thresholdSummary: "1000ns",
        worstNode: "sw1",
        worstOffsetNs: 500,
      },
    });
    render(<FlowPanel {...baseProps({ verifyState: { status: "done", result: withDiag } })} />);
    expect(screen.getByText("gPTP 收敛：2/2 节点 ≤ 阈值（1000ns），最差 500 ns @sw1")).toBeTruthy();
    // 顶层键缺席（旧结果）→ 不渲染诊断行（不臆造）。
    render(
      <FlowPanel {...baseProps({ verifyState: { status: "done", result: verifyResult() } })} />,
    );
    expect(screen.getAllByText(/gPTP 收敛/).length).toBe(1);
  });

  it("U2②：有门控明细 → 时序图行数 = 端口数、折叠明细表条目数一致（展开后出表）", async () => {
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    // 面板挂载即拉明细；时序图每行一个 (节点,端口)，行按首个开窗起点升序（es2 起点 0 在前）。
    const chart = await screen.findByRole("img", { name: "门控时序图" });
    const labels = [...chart.querySelectorAll(".flow-gcl-row-label")].map((t) => t.textContent);
    expect(labels).toEqual(["es2·eth0", "sw1·eth1"]);
    expect(chart.querySelectorAll(".flow-gcl-track").length).toBe(2);
    // 开窗色块 hover title 显示精确值（sw1：472.39µs → 476.95µs，4560ns）。
    const titles = [...chart.querySelectorAll(".flow-gcl-window title")].map((t) => t.textContent);
    expect(titles).toContain("开 472.39µs → 476.95µs（4560ns）");
    // 折叠明细：默认收起（无表），头部显示条目数，点开出表。
    const toggle = screen.getByRole("button", { name: /门控明细 · 2 条目/ });
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(toggle);
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr").length).toBe(2);
    expect(screen.getByText("eth1")).toBeTruthy();
    expect(screen.getByText("472.39–476.95")).toBeTruthy(); // 开窗(µs) 列。
    expect(screen.getByText("0.5%")).toBeTruthy(); // sw1 占空比 4560/1000000。
    expect(screen.getByText("30.0%")).toBeTruthy(); // es2 占空比 300000/1000000。
  });

  it("U2③：no_gating（流集无 ST 流）→ 蓝色信息条、不画空图", async () => {
    const getFlowPlan = vi.fn(async () => planDetail({ stCount: 0, beCount: 2 }));
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByText(/流集无 ST 流，无需门控/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
    // 无 ST 无需门控 → 验证按钮放行（查询三态非未规划）。
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("U2④：未规划 → 居中 CTA；有结果 → 按钮收进命令栏右上（重新规划）", async () => {
    // 未规划（entries=[] 且有 ST）：CTA 在 body、命令栏无重新规划按钮。
    const { unmount } = render(<FlowPanel {...baseProps()} />);
    const cta = screen.getByRole("button", { name: "规划门控表" });
    expect(cta.closest(".panel-cta")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新规划" })).toBeNull();
    unmount();
    // 已规划（库里有门控表）：CTA 消失、重新规划进命令栏、验证放行（planState 仍 idle）。
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByRole("button", { name: "重新规划" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "规划门控表" })).toBeNull();
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
    // 切会话回来凭数据恢复展示（KTD1）：头行合成条目数 + 求解器徽章。
    expect(screen.getByText(/门控表 · 2 条目/)).toBeTruthy();
    expect(screen.getByText(/Z3·带可调度性保证/)).toBeTruthy();
  });

  it("U2：规划成功后自动拉取明细刷新展示（KTD3）", async () => {
    const getFlowPlan = vi
      .fn()
      .mockResolvedValueOnce(planDetail()) // 挂载：未规划。
      .mockResolvedValueOnce(planDetailWithGcl()); // 规划成功后刷新。
    const planTas = vi.fn(async () => planOk());
    render(<FlowPanel {...baseProps({ getFlowPlan, planTas })} />);
    fireEvent.click(await screen.findByRole("button", { name: "规划门控表" }));
    await waitFor(() => expect(getFlowPlan).toHaveBeenCalledTimes(2));
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
