import { describe, expect, it } from "vitest";

import {
  buildGateTimelineRows,
  type FlowPlanEntry,
  flowPlanPresentation,
  gclDutyCycle,
  gclOpenIntervals,
  gptpDiagLine,
  isZ3Guaranteed,
  nsToUs,
  type PlanResult,
  planAllowsVerify,
  planSucceeded,
  roundLabel,
  roundStatusLabel,
  showVerifyTable,
  type VerifyTasResult,
  verifyAllPass,
} from "./flow-sim";

function plan(overrides: Partial<PlanResult> = {}): PlanResult {
  return {
    caliber: "flow_tas_planned",
    status: "ok",
    solver: "Z3",
    gateCount: 4,
    overall: "已综合 4 个门控条目",
    ...overrides,
  };
}

function verify(overrides: Partial<VerifyTasResult> = {}): VerifyTasResult {
  return {
    caliber: "flow_tas_verified",
    status: "ok",
    perStream: [],
    overall: "1 个达标 / 0 个未达标",
    ...overrides,
  };
}

describe("flow-sim helpers", () => {
  it("planSucceeded 仅当 ok 且 gateCount>0", () => {
    expect(planSucceeded(plan())).toBe(true);
    expect(planSucceeded(plan({ status: "solver_failed", gateCount: 0 }))).toBe(false);
    expect(planSucceeded(plan({ status: "ok", gateCount: 0 }))).toBe(false);
  });

  it("planAllowsVerify：有门控表或 no_gating（无 ST 流，R5/AE5）均放行验证", () => {
    expect(planAllowsVerify(plan())).toBe(true);
    expect(planAllowsVerify(plan({ status: "no_gating", solver: undefined, gateCount: 0 }))).toBe(
      true,
    );
    expect(planAllowsVerify(plan({ status: "solver_failed", gateCount: 0 }))).toBe(false);
    expect(planAllowsVerify(plan({ status: "ok", gateCount: 0 }))).toBe(false);
  });

  it("isZ3Guaranteed 区分 Z3 带保证 / Eager 兜底", () => {
    expect(isZ3Guaranteed(plan({ solver: "Z3" }))).toBe(true);
    expect(isZ3Guaranteed(plan({ solver: "Eager" }))).toBe(false);
    expect(isZ3Guaranteed(plan({ solver: undefined }))).toBe(false);
  });

  it("verifyAllPass：空/失败绝不算通过（R16）", () => {
    const pass = verify({
      perStream: [
        {
          streamSeq: 0,
          talker: "1",
          listener: "2",
          received: 3,
          expected: 3,
          jitterMaxNs: 100,
          latencyMaxNs: 200,
          windowNs: 400000,
          pass: true,
        },
      ],
    });
    expect(verifyAllPass(pass)).toBe(true);
    // 空 perStream → 不算通过（即便 status ok）。
    expect(verifyAllPass(verify({ status: "ok", perStream: [] }))).toBe(false);
    // 有失败流 → 不通过。
    const oneFail = verify({
      status: "fail",
      perStream: [
        {
          streamSeq: 0,
          talker: "1",
          listener: "2",
          received: 2,
          expected: 3,
          jitterMaxNs: 100,
          latencyMaxNs: 200,
          windowNs: 400000,
          pass: false,
          reason: "丢包",
        },
      ],
    });
    expect(verifyAllPass(oneFail)).toBe(false);
  });

  it("verifyAllPass rounds-aware：断链轮 FAIL 不得被顶层健康轮绿灯掩盖", () => {
    const passStream = {
      streamSeq: 0,
      class: "RC",
      talker: "1",
      listener: "2",
      received: 2001,
      expected: 2001,
      jitterMaxNs: 100,
      latencyMaxNs: 200,
      windowNs: 400000,
      pass: true,
      judged: true,
    };
    const failStream = {
      ...passStream,
      pass: false,
      reason: "丢包",
    };
    const round = (roundName: string, perStream: (typeof passStream)[], status = "ok") => ({
      round: roundName,
      status,
      perStream,
      annotations: [],
      untestedStreams: [],
    });

    // 健康轮全过 + 断A轮 RC FAIL → false（顶层 status/perStream 恒为健康轮，不能只看顶层）。
    const faultAFail = verify({
      status: "ok",
      perStream: [passStream],
      rounds: [
        round("healthy", [passStream]),
        round("fault_a", [failStream], "fail"),
        round("fault_b", [passStream]),
      ],
    });
    expect(verifyAllPass(faultAFail)).toBe(false);

    // 断A轮只有 judged=false 的报告态流 → 不影响（报告态不阻塞）。
    const reported = { ...passStream, judged: false, pass: true, note: "仅健康轮判" };
    const faultAReportedOnly = verify({
      status: "ok",
      perStream: [passStream],
      rounds: [
        round("healthy", [passStream]),
        round("fault_a", [reported]),
        round("fault_b", [reported]),
      ],
    });
    expect(verifyAllPass(faultAReportedOnly)).toBe(true);

    // 轮 status 非 ok（如 unreachable/busy）→ 不算全过。
    const faultBBusy = verify({
      status: "ok",
      perStream: [passStream],
      rounds: [
        round("healthy", [passStream]),
        round("fault_a", [passStream]),
        round("fault_b", [], "busy"),
      ],
    });
    expect(verifyAllPass(faultBBusy)).toBe(false);

    // 无 rounds 老结果 → 行为不变。
    expect(verifyAllPass(verify({ status: "ok", perStream: [passStream] }))).toBe(true);
  });

  it("showVerifyTable：仅有逐流行时渲染（空=不绿，R16）", () => {
    expect(showVerifyTable(verify({ perStream: [] }))).toBe(false);
    expect(
      showVerifyTable(
        verify({
          perStream: [
            {
              streamSeq: 0,
              talker: "1",
              listener: "2",
              received: 3,
              expected: 3,
              jitterMaxNs: 1,
              latencyMaxNs: 1,
              windowNs: 1,
              pass: true,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("U7：轮名/轮 status 中文映射（未知词回退原样）", () => {
    expect(roundLabel("healthy")).toBe("健康轮");
    expect(roundLabel("fault_a")).toBe("断A轮");
    expect(roundLabel("fault_b")).toBe("断B轮");
    expect(roundLabel("x")).toBe("x");
    expect(roundStatusLabel("ok")).toBe("通过");
    expect(roundStatusLabel("busy")).toBe("服务占用（稍后重试）");
    expect(roundStatusLabel("weird")).toBe("weird");
  });

  it("U7/R15：gPTP 诊断行文案（只报告不判）", () => {
    expect(
      gptpDiagLine({
        convergedNodes: 3,
        totalNodes: 4,
        thresholdSummary: "1000ns",
        worstNode: "es2",
        worstOffsetNs: 1500.4,
      }),
    ).toBe("gPTP 收敛：3/4 节点 ≤ 阈值（1000ns），最差 1500 ns @es2");
  });
});

// ---------- U2：门控表明细纯函数 ----------

const CYCLE = 1_000_000; // 1ms 门周期（ns）。

function entry(overrides: Partial<FlowPlanEntry> = {}): FlowPlanEntry {
  return {
    node: "0",
    nodeName: "sw1",
    ethN: 1,
    gateIndex: 7,
    initiallyOpen: true,
    offsetNs: 0,
    durationsNs: [],
    ...overrides,
  };
}

describe("gclOpenIntervals（U2①，与后端 gcl_open_intervals 同语义）", () => {
  it("durations 空 → 恒 initiallyOpen（开=整周期，关=无窗）", () => {
    expect(gclOpenIntervals(entry({ initiallyOpen: true }), CYCLE)).toEqual([[0, CYCLE]]);
    expect(gclOpenIntervals(entry({ initiallyOpen: false }), CYCLE)).toEqual([]);
  });

  it("initiallyOpen 两态：首段状态由其决定、durations 交替翻转", () => {
    // 开 300µs / 关 700µs。
    expect(
      gclOpenIntervals(entry({ initiallyOpen: true, durationsNs: [300_000, 700_000] }), CYCLE),
    ).toEqual([[0, 300_000]]);
    // 关 472.39µs / 开 4.56µs / 关 523.05µs（Z3 真机形态）。
    expect(
      gclOpenIntervals(
        entry({ initiallyOpen: false, durationsNs: [472_390, 4_560, 523_050] }),
        CYCLE,
      ),
    ).toEqual([[472_390, 476_950]]);
  });

  it("offset 回绕：state(t)=seq((t+offset) mod cycle)，序列坐标 p 落在 (p-offset) mod cycle", () => {
    // 后端夹具同款：offset 29470ns，开窗序列坐标 [0, 205360) → 绝对时间从 cycle-29470 起回绕。
    const g = entry({
      initiallyOpen: true,
      offsetNs: 29_470,
      durationsNs: [205_360, 794_640],
    });
    expect(gclOpenIntervals(g, CYCLE)).toEqual([
      [970_530, 1_000_000],
      [0, 175_890],
    ]);
  });

  it("跨周期边界拆段：开窗尾段 + 头段（手算 ns）", () => {
    // offset 100µs：开窗 [0,300µs) 序列坐标 → 绝对 [900µs,1000µs)+[0,200µs)。
    const g = entry({
      initiallyOpen: true,
      offsetNs: 100_000,
      durationsNs: [300_000, 700_000],
    });
    expect(gclOpenIntervals(g, CYCLE)).toEqual([
      [900_000, 1_000_000],
      [0, 200_000],
    ]);
  });
});

describe("门控明细展示辅助（U2⑤）", () => {
  it("gclDutyCycle：开窗总时长 / 门周期", () => {
    expect(
      gclDutyCycle(entry({ initiallyOpen: true, durationsNs: [300_000, 700_000] }), CYCLE),
    ).toBe(0.3);
    expect(
      gclDutyCycle(entry({ initiallyOpen: false, durationsNs: [472_390, 4_560, 523_050] }), CYCLE),
    ).toBeCloseTo(0.00456, 8);
    expect(gclDutyCycle(entry({ initiallyOpen: false }), CYCLE)).toBe(0);
  });

  it("nsToUs：两位小数 µs 显示", () => {
    expect(nsToUs(472_390)).toBe("472.39");
    expect(nsToUs(4_560)).toBe("4.56");
    expect(nsToUs(0)).toBe("0.00");
  });

  it("buildGateTimelineRows：按 (节点,端口) 分组、行按首个开窗起点升序", () => {
    const rows = buildGateTimelineRows(
      [
        entry({
          node: "0",
          nodeName: "sw1",
          ethN: 1,
          initiallyOpen: false,
          durationsNs: [472_390, 4_560, 523_050],
        }),
        entry({ node: "2", nodeName: "es2", ethN: 0, durationsNs: [300_000, 700_000] }),
      ],
      CYCLE,
    );
    expect(rows.map((r) => `${r.nodeName}·eth${r.ethN}`)).toEqual(["es2·eth0", "sw1·eth1"]);
    expect(rows[0].windows).toEqual([[0, 300_000]]);
    expect(rows[1].windows).toEqual([[472_390, 476_950]]);
  });

  it("flowPlanPresentation（KTD1 三态）：entries 非空=planned；空且有流无 ST=no-gating；其余=unplanned", () => {
    const base = { cycleNs: CYCLE, stCount: 0, rcCount: 0, beCount: 0, entries: [] };
    expect(
      flowPlanPresentation({
        ...base,
        stCount: 1,
        entries: [entry({ durationsNs: [1, 999_999] })],
      }),
    ).toBe("planned");
    expect(flowPlanPresentation({ ...base, beCount: 2 })).toBe("no-gating");
    expect(flowPlanPresentation({ ...base, rcCount: 1 })).toBe("no-gating");
    expect(flowPlanPresentation({ ...base, stCount: 1 })).toBe("unplanned");
    // 空流集（还没录流）→ 未规划 CTA（点规划会得到 no_streams 引导）。
    expect(flowPlanPresentation(base)).toBe("unplanned");
  });
});

import { computeFlowReveal } from "./flow-sim";

describe("computeFlowReveal（agent 写流后分级揭示）", () => {
  const base = {
    hasNewFlowMutation: true,
    inFlowStage: true,
    panelExpanded: false,
    activeIsFlow: false,
  };

  it("面板收起 → 展开并落流量列表子 tab", () => {
    expect(computeFlowReveal(base)).toBe("expand-flow-list");
  });

  it("面板已开但在别 tab → 挂 badge，不抢焦点", () => {
    expect(computeFlowReveal({ ...base, panelExpanded: true })).toBe("badge");
  });

  it("面板已开且就在流量 tab → 不动", () => {
    expect(computeFlowReveal({ ...base, panelExpanded: true, activeIsFlow: true })).toBe("none");
  });

  it("无新 flow mutation（历史回放已被时间戳门滤掉）→ 不揭示", () => {
    expect(computeFlowReveal({ ...base, hasNewFlowMutation: false })).toBe("none");
  });

  it("非流量规划阶段 → 不揭示", () => {
    expect(computeFlowReveal({ ...base, inFlowStage: false })).toBe("none");
  });
});
