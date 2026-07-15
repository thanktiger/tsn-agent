import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { FlowPanel, type FlowPanelProps } from "./flow-panel";
import type {
  FlowPlanDetail,
  GclDetail,
  GclWindowRow,
  ListFlowStreamRow,
  ListFlowStreamsResult,
  PlanResult,
  PlanUiState,
  StreamVerdict,
  VerifyTasResult,
} from "./flow-sim";

// item 8：flow 面板订阅 session_db 变更（domain flow）→ 重拉。jsdom 下真 hook 恒 no-op，
// mock 出来捕获 onChange，以模拟 mutation 通知触发重拉。
const dbListenerOnChange = vi.hoisted(() => ({
  current: undefined as undefined | (() => void),
}));
vi.mock("../../hooks/use-session-db-listener", () => ({
  useSessionDbListener: ({ onChange }: { onChange: () => void }) => {
    dbListenerOnChange.current = onChange;
  },
}));

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

/** U4 流集夹具：默认一条 ST 流。 */
function makeFlowStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 0,
    class: "ST",
    pcp: 6,
    periodUs: 1000,
    frameBytes: 128,
    count: 1,
    talker: "es1",
    listener: "es2",
    maxLatencyUs: null,
    redundant: false,
    srcMac: null,
    dstMac: null,
    vlanId: null,
    earliestSendOffsetNs: null,
    latestSendOffsetNs: null,
    name: null,
    jitterNs: null,
    srcIp: null,
    dstIp: null,
    srcL4Port: null,
    dstL4Port: null,
    l4Protocol: null,
    nodePath: [],
    paths: null,
    ...overrides,
  };
}

function streamsResult(streams: ListFlowStreamRow[] = []): ListFlowStreamsResult {
  return { streams };
}

// ——— U9 门控明细（新表 get_gcl_detail）夹具 ———

/** 空明细（未规划/老工程）。 */
function gclDetailEmpty(): GclDetail {
  return { windows: [], meta: null, streams: [] };
}

function gclWindow(overrides: Partial<GclWindowRow> = {}): GclWindowRow {
  return {
    node: "0",
    nodeName: "es1",
    ethN: 0,
    entryIdx: 0,
    startNs: 0,
    durationNs: 1488,
    gateStates: 0x80,
    flowRefs: [{ seq: 0, source: "derived" }],
    ...overrides,
  };
}

/**
 * U9 两流已规划夹具（es1→sw1→es2，cycle=1ms）：
 * - F0：128B/1000μs，串行化 1488ns，es1 [0,1488]、sw1 [3488,4976]（shift=1488+2000）
 *   → 端到端 4976ns；maxLatency 100μs → 裕度 95024ns。
 * - F1：256B/500μs，串行化 2512ns，es1 [10000,12512]、sw1 [14512,17024]（shift=2512+2000）
 *   → 端到端 7024ns（最大）；maxLatency 未填。
 * - es1 另有 10000ns 全关窗 → 表项 5 / 打开窗 4 / 关窗占比 10000/(2×1e6)=0.5%。
 * - 每端口开窗 4000ns → 最大占用 0.4%；链路带宽 1.488+5.024=6.512Mbps → 0.7%。
 */
function gclDetailPlanned(overrides: Partial<GclDetail> = {}): GclDetail {
  return {
    meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: false },
    windows: [
      gclWindow(),
      gclWindow({
        entryIdx: 1,
        startNs: 10_000,
        durationNs: 2512,
        flowRefs: [{ seq: 1, source: "derived" }],
      }),
      gclWindow({ node: "1", nodeName: "sw1", ethN: 1, startNs: 3488 }),
      gclWindow({
        node: "1",
        nodeName: "sw1",
        ethN: 1,
        entryIdx: 1,
        startNs: 14_512,
        durationNs: 2512,
        flowRefs: [{ seq: 1, source: "derived" }],
      }),
      gclWindow({
        entryIdx: 2,
        startNs: 990_000,
        durationNs: 10_000,
        gateStates: 0,
        flowRefs: null,
      }),
    ],
    streams: [
      makeFlowStream({
        streamSeq: 0,
        name: "F0",
        nodePath: ["es1", "sw1", "es2"],
        frameBytes: 128,
        periodUs: 1000,
        maxLatencyUs: 100,
      }),
      makeFlowStream({
        streamSeq: 1,
        name: "F1",
        nodePath: ["es1", "sw1", "es2"],
        frameBytes: 256,
        periodUs: 500,
        maxLatencyUs: null,
      }),
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
    // 默认落 gate-plan 子 tab，便于大多数测规划元素的 case；需测软仿的 case 各自 override。
    activeFlowSubTab: "gate-plan",
    onSelectFlowSubTab: vi.fn(),
    selectedFlowSeq: null,
    onSelectFlowSeq: vi.fn(),
    planTas: vi.fn(async () => planOk()),
    verifyTas: vi.fn(async () => verifyResult()),
    getFlowPlan: vi.fn(async () => planDetail()),
    listFlowStreams: vi.fn(async () => streamsResult()),
    getGclDetail: vi.fn(async () => gclDetailEmpty()),
    ...overrides,
  };
}

describe("FlowPanel", () => {
  it("R21：soft-sim 子 tab 诚实标注可见（读到结果前即可见）", () => {
    render(<FlowPanel {...baseProps({ activeFlowSubTab: "soft-sim" })} />);
    expect(screen.getByText(/仿真实测 · 非 T10 硬件判决/)).toBeTruthy();
  });

  it("非 flow 阶段规划按钮禁用", async () => {
    render(<FlowPanel {...baseProps({ inFlowStage: false })} />);
    expect(
      (await screen.findByRole("button", { name: "规划门控表" })).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("点击规划 → 调 plan_tas，onPlanStateChange running→done", async () => {
    const planTas = vi.fn(async () => planOk());
    const onPlanStateChange = vi.fn();
    render(<FlowPanel {...baseProps({ planTas, onPlanStateChange })} />);
    fireEvent.click(await screen.findByRole("button", { name: "规划门控表" }));
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
    const btn = await screen.findByRole("button", { name: "规划门控表" });
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
    // 验证按钮在 soft-sim 子 tab。
    const { rerender } = render(<FlowPanel {...baseProps({ activeFlowSubTab: "soft-sim" })} />);
    // 未规划 → 验证禁用。
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(true);
    rerender(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          planState: { status: "done", result: planOk() },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("Covers AE5：no_gating（流集无 ST 流）后软仿验证按钮放行且文案可见", () => {
    const noGating = planOk({
      status: "no_gating",
      solver: undefined,
      gateCount: 0,
      overall: "流集无 ST 流，无需门控综合；可直接验证。",
    });
    // gate-plan 子 tab：no_gating 文案可见。
    const { rerender } = render(
      <FlowPanel {...baseProps({ planState: { status: "done", result: noGating } })} />,
    );
    expect(screen.getByText(/无需门控综合/)).toBeTruthy();
    // soft-sim 子 tab：验证按钮放行。
    rerender(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          planState: { status: "done", result: noGating },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("验证结果渲染逐流表（收/发 + 判定）", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: verifyResult() },
        })}
      />,
    );
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText("达标")).toBeTruthy();
  });

  it("R16：空结果不渲染逐流表（不染绿）", () => {
    const empty = verifyResult({ status: "empty", perStream: [], overall: "结果为空" });
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: empty },
        })}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/结果为空/)).toBeTruthy();
  });

  it("U7：有 rounds 按轮分组渲染（轮名↔状态 within 小节绑定 + 顶层摘要串联）", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
    );
    // U3 徽章条头：轮名与其状态徽章绑定在各自小节内（within，防跨轮误配 count 断言）。
    const healthy = screen.getByText("健康轮").closest("section") as HTMLElement;
    const faultA = screen.getByText("断A轮").closest("section") as HTMLElement;
    const faultB = screen.getByText("断B轮").closest("section") as HTMLElement;
    expect(within(healthy).getByText("通过")).toBeTruthy();
    expect(within(faultA).getByText("通过")).toBeTruthy();
    expect(within(faultB).getByText("服务占用（稍后重试）")).toBeTruthy();
    // 顶层摘要沿 U6 overall 串联。
    expect(screen.getByText(/健康轮：3 个达标/)).toBeTruthy();
  });

  it("U3：轮状态徽章化（sim-badge ok/bad）+ 标注 chips 进徽章条", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
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
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
    );
    expect(screen.getAllByText("类别").length).toBeGreaterThan(0);
    expect(screen.getAllByText("RC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BE").length).toBeGreaterThan(0);
    // RC 行两列（抖动/时延）都带首达路标注；ST/BE 行不带。
    expect(screen.getAllByText(/首达路实测/).length).toBe(4); // 健康轮 + 断A轮各 2 格。
  });

  it("U7/R13：BE 行达标旁并列送达率", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
    );
    expect(screen.getByText("达标（送达率 50%）")).toBeTruthy();
  });

  it("U7/R15：gPTP 诊断行文案逐轮渲染（只报告）", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
    );
    expect(
      screen.getByText("gPTP 收敛：3/4 节点 ≤ 阈值（1000ns），最差 1500 ns @es2"),
    ).toBeTruthy();
  });

  it("U7/KTD8：报告态行显示 note、untested 流标记与断链标注可见", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: roundsResult() },
        })}
      />,
    );
    expect(screen.getByText("仅健康轮判（故障轮不判）")).toBeTruthy();
    expect(screen.getByText(/流 3：未测容错/)).toBeTruthy();
    expect(screen.getByText(/断链：t=400ms/)).toBeTruthy();
  });

  it("U7：无 rounds 老结果渲染现状不变（无轮小节、无类别列）", () => {
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: verifyResult() },
        })}
      />,
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
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: withDiag },
        })}
      />,
    );
    expect(screen.getByText("gPTP 收敛：2/2 节点 ≤ 阈值（1000ns），最差 500 ns @sw1")).toBeTruthy();
    // 顶层键缺席（旧结果）→ 不渲染诊断行（不臆造）。
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "soft-sim",
          verifyState: { status: "done", result: verifyResult() },
        })}
      />,
    );
    expect(screen.getAllByText(/gPTP 收敛/).length).toBe(1);
  });

  it("U2②（boss 精简）：已规划 → 只渲染判定头行，时序图/明细表并入弹窗不再重复", async () => {
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    // 头行（凭数据合成：条目数 + 求解器徽章）。
    expect(await screen.findByText(/门控表 · 2 条目/)).toBeTruthy();
    // 面板不再渲染时序图与门控明细折叠表。
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
    expect(screen.queryByRole("button", { name: /门控明细/ })).toBeNull();
  });

  it("U2③：no_gating（流集无 ST 流）→ 蓝色信息条、不画空图", async () => {
    const getFlowPlan = vi.fn(async () => planDetail({ stCount: 0, beCount: 2 }));
    // gate-plan 子 tab：蓝色信息条可见、无时序图。
    const { rerender } = render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByText(/流集无 ST 流，无需门控/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
    // soft-sim 子 tab：无 ST 无需门控 → 验证按钮放行（查询三态非未规划）。
    rerender(<FlowPanel {...baseProps({ activeFlowSubTab: "soft-sim", getFlowPlan })} />);
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("U2④：未规划 → 居中 CTA；有结果 → 按钮收进命令栏右上（重新规划）", async () => {
    // 未规划（entries=[] 且有 ST）：CTA 在 body、命令栏无重新规划按钮。
    const { unmount } = render(<FlowPanel {...baseProps()} />);
    const cta = await screen.findByRole("button", { name: "规划门控表" });
    expect(cta.closest(".panel-cta")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新规划" })).toBeNull();
    unmount();
    // 已规划（库里有门控表）：gate-plan 子 tab：CTA 消失、重新规划进命令栏。
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    const { rerender } = render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByRole("button", { name: "重新规划" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "规划门控表" })).toBeNull();
    // 切会话回来凭数据恢复展示（KTD1）：头行合成条目数 + 求解器徽章。
    expect(screen.getByText(/门控表 · 2 条目/)).toBeTruthy();
    expect(screen.getByText(/Z3·带可调度性保证/)).toBeTruthy();
    // soft-sim 子 tab：验证放行（planState 仍 idle 但库里有门控表）。
    rerender(<FlowPanel {...baseProps({ activeFlowSubTab: "soft-sim", getFlowPlan })} />);
    expect(screen.getByRole("button", { name: "软仿验证" }).hasAttribute("disabled")).toBe(false);
  });

  it("U2/item5：planState→done 经 effect 刷新明细（非 handlePlan 内联，切 tab 重挂后完成也刷新）", async () => {
    const getFlowPlan = vi
      .fn()
      .mockResolvedValueOnce(planDetail()) // 挂载（模拟切回 tab、命令仍在跑）：未规划、无图。
      .mockResolvedValue(planDetailWithGcl()); // done 刷新：已规划、出图。
    // 以 running 挂载、从不点击规划按钮——刷新只可能来自 done effect。
    const { rerender } = render(
      <FlowPanel {...baseProps({ getFlowPlan, planState: { status: "running" } })} />,
    );
    await waitFor(() => expect(getFlowPlan).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/门控表 · 2 条目/)).toBeNull();
    rerender(
      <FlowPanel
        {...baseProps({ getFlowPlan, planState: { status: "done", result: planOk() } })}
      />,
    );
    // done → effect 重拉明细 → 重新规划按钮进命令栏（明细已刷新的可见信号）。
    expect(await screen.findByRole("button", { name: "重新规划" })).toBeTruthy();
    expect(getFlowPlan).toHaveBeenCalledTimes(2);
  });

  it("item6①：挂载取数失败 → CTA 仍渲染（回退未规划）、不抛未处理拒绝", async () => {
    const getFlowPlan = vi.fn(async () => {
      throw new Error("db down");
    });
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByRole("button", { name: "规划门控表" })).toBeTruthy();
  });

  it("item6②：plan 成功后明细刷新失败 → planState 仍 done、显不可用态不画旧图", async () => {
    const getFlowPlan = vi
      .fn()
      .mockResolvedValueOnce(planDetail()) // 挂载：未规划。
      .mockRejectedValue(new Error("db down")); // done 刷新：失败。
    const { rerender } = render(
      <FlowPanel {...baseProps({ getFlowPlan, planState: { status: "idle" } })} />,
    );
    await screen.findByRole("button", { name: "规划门控表" });
    rerender(
      <FlowPanel
        {...baseProps({ getFlowPlan, planState: { status: "done", result: planOk() } })}
      />,
    );
    // 明细读取失败：出显式「不可用」提示、不画旧/空图；planState 成功判定不被改写成 error。
    expect(await screen.findByText(/门控明细暂不可用/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
    expect(screen.getByText(/已综合 4 个门控条目/)).toBeTruthy();
  });

  it("item7：挂载取数未回（loading）时不渲染 CTA（防已规划会话 CTA 闪现被误点）", () => {
    // getFlowPlan 永不 resolve → planQuery 恒 loading。
    const getFlowPlan = vi.fn(() => new Promise<FlowPlanDetail>(() => {}));
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(screen.queryByRole("button", { name: "规划门控表" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新规划" })).toBeNull();
  });

  it("item8：flow domain 变更（onChange）→ 二次取数（照 timesync 消费先例）", async () => {
    const getFlowPlan = vi.fn(async () => planDetail());
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    await waitFor(() => expect(getFlowPlan).toHaveBeenCalledTimes(1));
    await act(async () => {
      dbListenerOnChange.current?.();
    });
    await waitFor(() => expect(getFlowPlan).toHaveBeenCalledTimes(2));
  });

  it("item4：流集无 ST 但库里残留门控表（矛盾态）→ 蓝条『验证不会消费』、不画旧图", async () => {
    const getFlowPlan = vi.fn(async () =>
      planDetail({ stCount: 0, beCount: 2, entries: planDetailWithGcl().entries }),
    );
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    expect(await screen.findByText(/存量门控表与当前流集不符，验证不会消费/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
  });

  it("item10.7：error 态 × 库里有旧门控表 → 不画旧图（态未定、避误导）", async () => {
    const getFlowPlan = vi.fn(async () => planDetailWithGcl()); // 有 ST + 旧 GCL。
    render(
      <FlowPanel
        {...baseProps({ getFlowPlan, planState: { status: "error", message: "boom" } })}
      />,
    );
    expect(await screen.findByText(/规划失败：boom/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
  });

  it("item10.7：solver_failed × 库里有旧门控表（有 ST）→ 保留失败判定（旧 GCL 仍会被 pin；图表在弹窗）", async () => {
    const solverFailed = planOk({
      status: "solver_failed",
      solver: undefined,
      gateCount: 0,
      overall: "门控综合失败：约束不可行或配置器出错，未产出门控表。",
    });
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    render(
      <FlowPanel
        {...baseProps({ getFlowPlan, planState: { status: "done", result: solverFailed } })}
      />,
    );
    expect(await screen.findByText(/门控综合失败/)).toBeTruthy();
    // 旧 GCL 的图表展示在门控详情弹窗，面板不再画图。
    expect(screen.queryByRole("img", { name: "门控时序图" })).toBeNull();
  });

  it("会话切换后迟到结果被丢弃", async () => {
    let resolveFn: (r: PlanResult) => void = () => {};
    const planTas = vi.fn(() => new Promise<PlanResult>((res) => (resolveFn = res)));
    const onPlanStateChange = vi.fn();
    const { rerender } = render(
      <FlowPanel {...baseProps({ sessionId: "s1", planTas, onPlanStateChange })} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "规划门控表" }));
    await waitFor(() => expect(planTas).toHaveBeenCalled());
    // 切到 s2，再让 s1 的命令落地。
    rerender(<FlowPanel {...baseProps({ sessionId: "s2", planTas, onPlanStateChange })} />);
    resolveFn(planOk());
    await Promise.resolve();
    // 只应有 running（发起时）；done 被丢弃（runSessionId !== 当前）。
    expect(onPlanStateChange).not.toHaveBeenCalledWith({ status: "done", result: planOk() });
  });

  // item9：复刻 App.tsx 的会话绑定守卫 + 生产 key={sessionId} 重挂——面板内 sessionIdRef 随 key
  // 重挂冻结失效（上一 test 靠无 key rerender 测的是内部守卫），此处靠 App 侧守卫兜底。守卫代码
  // 与 App.tsx setFlowPlanStateGuarded 同形（会话绑定 + 当前会话 ref 比对）。
  function AppGuardHarness({
    planTas,
    getFlowPlan,
  }: {
    planTas: (sessionId: string) => Promise<PlanResult>;
    getFlowPlan: (sessionId: string) => Promise<FlowPlanDetail>;
  }) {
    const [sessionId, setSessionId] = useState("s1");
    const [planState, setPlanState] = useState<PlanUiState>({ status: "idle" });
    const currentSessionIdRef = useRef(sessionId);
    currentSessionIdRef.current = sessionId;
    const setPlanStateGuarded = useCallback(
      (state: PlanUiState) => {
        if (currentSessionIdRef.current === sessionId) setPlanState(state);
      },
      [sessionId],
    );
    // 会话切换归零（复刻 App reset effect）。
    // biome-ignore lint/correctness/useExhaustiveDependencies: 仅按 sessionId 归零，与 App 一致。
    useEffect(() => {
      setPlanState({ status: "idle" });
    }, [sessionId]);
    return (
      <>
        <button type="button" onClick={() => setSessionId("s2")}>
          切到 s2
        </button>
        <FlowPanel
          key={sessionId}
          inFlowStage
          sessionId={sessionId}
          planState={planState}
          onPlanStateChange={setPlanStateGuarded}
          verifyState={{ status: "idle" }}
          onVerifyStateChange={() => {}}
          activeFlowSubTab="gate-plan"
          onSelectFlowSubTab={() => {}}
          selectedFlowSeq={null}
          onSelectFlowSeq={() => {}}
          planTas={planTas}
          verifyTas={vi.fn(async () => verifyResult())}
          getFlowPlan={getFlowPlan}
        />
      </>
    );
  }

  it("item9：生产 key 重挂 + App 会话守卫——旧会话迟到 done 不污染新会话", async () => {
    let resolvePlan: (r: PlanResult) => void = () => {};
    const planTas = vi.fn(() => new Promise<PlanResult>((res) => (resolvePlan = res)));
    const getFlowPlan = vi.fn(async () => planDetail()); // 两会话都未规划 → CTA。
    render(<AppGuardHarness planTas={planTas} getFlowPlan={getFlowPlan} />);
    // s1：点规划（handlePlan 捕获 s1 绑定的守卫 setter）。
    fireEvent.click(await screen.findByRole("button", { name: "规划门控表" }));
    await waitFor(() => expect(planTas).toHaveBeenCalledTimes(1));
    // 切到 s2：面板按 key 重挂、planState 归零。
    fireEvent.click(screen.getByRole("button", { name: "切到 s2" }));
    // s1 的 plan 迟到落地 → 守卫按发起会话丢弃，不写进 s2。
    await act(async () => {
      resolvePlan(planOk());
    });
    // s2 未被污染：无 s1 综合结果，CTA 仍在。
    expect(screen.queryByText(/已综合 4 个门控条目/)).toBeNull();
    expect(await screen.findByRole("button", { name: "规划门控表" })).toBeTruthy();
  });

  // ——— U5 门控详情弹窗入口 ———

  it("U5：无规划数据（no-gating）→ 门控详情按钮禁用", async () => {
    const getFlowPlan = vi.fn(async () => planDetail({ stCount: 0, beCount: 2 }));
    render(<FlowPanel {...baseProps({ getFlowPlan })} />);
    const btn = await screen.findByRole("button", { name: "门控详情" });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("U5：有门控表 → 门控详情按钮可点，点击开弹窗", async () => {
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    const getGclDetail = vi.fn(async () => ({ windows: [], meta: null, streams: [] }));
    render(<FlowPanel {...baseProps({ getFlowPlan, getGclDetail })} />);
    const btn = await screen.findByRole("button", { name: "门控详情" });
    expect(btn.hasAttribute("disabled")).toBe(false);
    fireEvent.click(btn);
    expect(await screen.findByRole("dialog", { name: "门控详情" })).toBeTruthy();
    await waitFor(() => expect(getGclDetail).toHaveBeenCalledWith("s1"));
  });

  // ——— U9 门控概览八卡（R15/AE7）———

  /** 已规划态渲染基座：planQuery=planned（时序图口径）+ gclDetail 两流夹具。 */
  function renderOverview(detail: GclDetail = gclDetailPlanned()) {
    const getFlowPlan = vi.fn(async () => planDetailWithGcl());
    const getGclDetail = vi.fn(async () => detail);
    return render(<FlowPanel {...baseProps({ getFlowPlan, getGclDetail })} />);
  }

  /** 按标签定位概览卡（label 唯一）。 */
  function cardOf(label: string): HTMLElement {
    return screen.getByText(label).closest(".gcl-overview-card") as HTMLElement;
  }

  it("U9/AE7：已规划态渲染八卡，数值与 buildGclOverview 口径一致", async () => {
    renderOverview();
    expect(await screen.findByText("门控概览")).toBeTruthy();
    // ① 调度状态：绿卡「可调度」+ 副行「GCL 已生成」。
    const statusCard = cardOf("调度状态");
    expect(within(statusCard).getByText("可调度")).toBeTruthy();
    expect(within(statusCard).getByText("GCL 已生成")).toBeTruthy();
    expect(statusCard.className).toContain("gcl-overview-card--ok");
    // ② 超周期。
    expect(within(cardOf("超周期")).getByText("1000.00 μs")).toBeTruthy();
    expect(within(cardOf("超周期")).getByText("规划周期")).toBeTruthy();
    // ③ 业务流/门控端口 + 涉及队列。
    const flowsCard = cardOf("业务流 / 门控端口");
    expect(within(flowsCard).getByText("2 条 / 2")).toBeTruthy();
    expect(within(flowsCard).getByText("涉及 q7 队列")).toBeTruthy();
    // ④ GCL 表项/打开窗口。
    const entriesCard = cardOf("GCL 表项");
    expect(within(entriesCard).getByText("5")).toBeTruthy();
    expect(within(entriesCard).getByText("打开窗口 4 个")).toBeTruthy();
    // ⑤⑥⑦ 三个百分比卡。
    expect(within(cardOf("最大门控窗口占用")).getByText("0.4%")).toBeTruthy();
    const bwCard = cardOf("最大链路带宽占用");
    expect(within(bwCard).getByText("0.7%")).toBeTruthy();
    expect(within(bwCard).getByText("按流带宽/链路速率推导")).toBeTruthy();
    expect(within(cardOf("关闭窗口占比")).getByText("0.5%")).toBeTruthy();
    // ⑧ 时延分析高亮卡：最大端到端 = F1 的 7024ns。
    const latCard = cardOf("时延分析");
    expect(within(latCard).getByText("最大端到端 7.02 μs")).toBeTruthy();
    expect(within(latCard).getByText("最大端到端时延·规划推导值")).toBeTruthy();
    expect(latCard.className).toContain("gcl-overview-card--highlight");
  });

  it("U9：时延分析卡展开每流明细（时延/裕度；未设上限）", async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole("button", { name: /时延分析/ }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("F0")).toBeTruthy();
    expect(within(table).getByText("4.98")).toBeTruthy(); // F0 端到端 4976ns。
    expect(within(table).getByText("95.02 μs")).toBeTruthy(); // F0 裕度 100000−4976。
    expect(within(table).getByText("F1")).toBeTruthy();
    expect(within(table).getByText("7.02")).toBeTruthy();
    expect(within(table).getByText("未设上限")).toBeTruthy(); // F1 maxLatency 未填。
  });

  it("U9：负裕度红字 +「口径不同」提示（推导超 maxLatency 如实呈现）", async () => {
    const detail = gclDetailPlanned();
    detail.streams[0] = { ...detail.streams[0], maxLatencyUs: 2 }; // 2000ns < 4976ns。
    renderOverview(detail);
    fireEvent.click(await screen.findByRole("button", { name: /时延分析/ }));
    const neg = screen.getByText("-2.98 μs（口径不同）");
    expect(neg.className).toContain("gcl-overview-margin-neg");
  });

  it("U9/KTD14：meta.stale=true → 琥珀卡「需重新规划」+ 副行「配置已变更」", async () => {
    renderOverview(
      gclDetailPlanned({
        meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: true },
      }),
    );
    expect(await screen.findByText("需重新规划")).toBeTruthy();
    const statusCard = cardOf("调度状态");
    expect(within(statusCard).getByText("配置已变更")).toBeTruthy();
    expect(statusCard.className).toContain("gcl-overview-card--stale");
    expect(statusCard.className).not.toContain("gcl-overview-card--ok");
  });

  it("U9：类级降级流排除出最大值并提示「N 条流未计入」", async () => {
    const detail = gclDetailPlanned();
    detail.windows[1] = { ...detail.windows[1], flowRefs: [{ seq: 1, source: "class" }] };
    renderOverview(detail);
    expect(await screen.findByText(/（1 条流未计入）/)).toBeTruthy();
    // F1 整链降级后最大端到端只剩 F0 的 4976ns。
    expect(screen.getByText("最大端到端 4.98 μs")).toBeTruthy();
  });

  it("U9：未规划态不渲染概览卡片区（CTA 现状不变）", async () => {
    render(<FlowPanel {...baseProps()} />); // getFlowPlan=未规划、getGclDetail=空。
    expect(await screen.findByRole("button", { name: "规划门控表" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /门控概览/ })).toBeNull();
    expect(screen.queryByText("调度状态")).toBeNull();
  });

  it("U9：无可归属链路 → 带宽卡显示「—」+ 副行「链路速率未知」", async () => {
    const detail = gclDetailPlanned({
      streams: [
        makeFlowStream({ streamSeq: 0, name: "F0", nodePath: [], maxLatencyUs: null }),
        makeFlowStream({ streamSeq: 1, name: "F1", nodePath: [], frameBytes: 256, periodUs: 500 }),
      ],
    });
    renderOverview(detail);
    await screen.findByText("门控概览");
    const bwCard = cardOf("最大链路带宽占用");
    expect(within(bwCard).getByText("—")).toBeTruthy();
    expect(within(bwCard).getByText("链路速率未知")).toBeTruthy();
  });

  // ——— U4 流量列表 ———

  it("U4：flow-list 子 tab 有流时渲染行列表（F0/F1 可见）", async () => {
    const streams = [
      makeFlowStream({ streamSeq: 0, class: "ST", talker: "es1", listener: "es2" }),
      makeFlowStream({ streamSeq: 1, class: "RC", talker: "es2", listener: "es3" }),
    ];
    const listFlowStreams = vi.fn(async () => streamsResult(streams));
    render(<FlowPanel {...baseProps({ activeFlowSubTab: "flow-list", listFlowStreams })} />);
    expect(await screen.findByText("F0")).toBeTruthy();
    expect(screen.getByText("F1")).toBeTruthy();
  });

  it("U4：flow-list 空且 !isLoading → PanelCta 可见（!inFlowStage → disabled）", async () => {
    const listFlowStreams = vi.fn(async () => streamsResult([]));
    render(
      <FlowPanel
        {...baseProps({
          activeFlowSubTab: "flow-list",
          inFlowStage: false,
          listFlowStreams,
        })}
      />,
    );
    const cta = await screen.findByRole("button", { name: "录入流量" });
    expect(cta.hasAttribute("disabled")).toBe(true);
  });

  it("U4：flow-list loading 中不出 PanelCta", () => {
    // listFlowStreams 永不 resolve → streamsLoading 恒 true。
    const listFlowStreams = vi.fn(() => new Promise<ListFlowStreamsResult>(() => {}));
    render(<FlowPanel {...baseProps({ activeFlowSubTab: "flow-list", listFlowStreams })} />);
    expect(screen.queryByRole("button", { name: "录入流量" })).toBeNull();
  });

  it("U4：DB 变更 → listFlowStreams 也重拉", async () => {
    const listFlowStreams = vi.fn(async () => streamsResult([]));
    render(<FlowPanel {...baseProps({ activeFlowSubTab: "flow-list", listFlowStreams })} />);
    await waitFor(() => expect(listFlowStreams).toHaveBeenCalledTimes(1));
    await act(async () => {
      dbListenerOnChange.current?.();
    });
    await waitFor(() => expect(listFlowStreams).toHaveBeenCalledTimes(2));
  });

  it("U4：点击行 → onSelectFlowSeq 收到 streamSeq", async () => {
    const onSelectFlowSeq = vi.fn();
    const stream = makeFlowStream({ streamSeq: 3 });
    const listFlowStreams = vi.fn(async () => streamsResult([stream]));
    render(
      <FlowPanel
        {...baseProps({ activeFlowSubTab: "flow-list", listFlowStreams, onSelectFlowSeq })}
      />,
    );
    await screen.findByText("F3");
    fireEvent.click(screen.getAllByRole("row")[1]); // [0] 是表头行
    expect(onSelectFlowSeq).toHaveBeenCalledWith(3);
  });
});
