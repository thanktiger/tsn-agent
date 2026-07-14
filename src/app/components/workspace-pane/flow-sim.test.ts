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
  parseExplicitPathLinkSeqs,
  parseRedundantNodePaths,
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

// ── U4：门控明细 display model / 窗口链 / 概览八项 ──────────────────────────

import {
  buildGclDisplayModel,
  buildGclOverview,
  degradedFlowSeqs,
  deriveFlowWindowChains,
  type FlowRefDto,
  type GclDetail,
  type GclWindowRow,
  gclPresentation,
  type ListFlowStreamRow,
  PROCESSING_DELAY_NS,
  serializationNs,
} from "./flow-sim";

function stStream(overrides: Partial<ListFlowStreamRow> = {}): ListFlowStreamRow {
  return {
    streamSeq: 0,
    class: "ST",
    pcp: 7,
    periodUs: 500,
    frameBytes: 512,
    count: 10000,
    talker: "1",
    listener: "2",
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
    nodePath: ["ES-1", "SW-0", "ES-2"],
    paths: null,
    ...overrides,
  };
}

function win(
  node: string,
  nodeName: string,
  ethN: number,
  entryIdx: number,
  startNs: number,
  durationNs: number,
  gateStates: number,
  flowRefs: FlowRefDto[] | null = null,
): GclWindowRow {
  return { node, nodeName, ethN, entryIdx, startNs, durationNs, gateStates, flowRefs };
}

/** 两流两跳 fixture：ES-1(mid 1).eth0 → SW-0(mid 0).eth1 → ES-2。
 * 串行化 (512+58)×8 = 4560ns；下游窗恰好 = 上游窗 + 4560 + 2000（KTD9 公式零偏差）。 */
function twoFlowDetail(): GclDetail {
  const d = (seq: number): FlowRefDto[] => [{ seq, source: "derived" }];
  return {
    windows: [
      // ES-1 出端口：s0 两实例（周期 500μs）+ s1 单实例（周期 1ms）。
      win("1", "ES-1", 0, 0, 0, 4560, 0x80, d(0)),
      win("1", "ES-1", 0, 1, 4560, 5440, 0x7f, null),
      win("1", "ES-1", 0, 2, 10000, 4560, 0x80, d(1)),
      win("1", "ES-1", 0, 3, 500000, 4560, 0x80, d(0)),
      // SW-0 出端口：每窗 = 对应上游窗 + 6560；另有一段全关窗（0x00）。
      win("0", "SW-0", 1, 0, 6560, 4560, 0x80, d(0)),
      win("0", "SW-0", 1, 1, 16560, 4560, 0x80, d(1)),
      win("0", "SW-0", 1, 2, 30000, 1000, 0x00, null),
      win("0", "SW-0", 1, 3, 506560, 4560, 0x80, d(0)),
    ],
    meta: { status: "ok", cycleNs: 1_000_000, algorithm: "Z3", stale: false },
    streams: [
      stStream({ streamSeq: 0, maxLatencyUs: 100, name: "ST流0" }),
      stStream({ streamSeq: 1, periodUs: 1000, name: "ST流1" }),
    ],
  };
}

describe("gclPresentation（新表三态）", () => {
  it("meta=null（从未规划/老工程）→ unplanned 空态", () => {
    expect(gclPresentation({ windows: [], meta: null, streams: [] })).toBe("unplanned");
  });

  it("status=no_gating → no-gating；ok+窗口行 → planned；ok 无窗 → unplanned", () => {
    const meta = { status: "no_gating", cycleNs: 1_000_000, algorithm: "Z3", stale: false };
    expect(gclPresentation({ windows: [], meta, streams: [] })).toBe("no-gating");
    const detail = twoFlowDetail();
    expect(gclPresentation(detail)).toBe("planned");
    expect(gclPresentation({ ...detail, windows: [] })).toBe("unplanned");
  });
});

describe("buildGclDisplayModel（KTD8 分组 + 筛选 + 流名）", () => {
  it("无筛选：按 (node, ethN) 分组，保持行序；流名解析自流集", () => {
    const model = buildGclDisplayModel(twoFlowDetail(), { flowSeq: null, node: null });
    expect(model.groups.length).toBe(2);
    expect(model.groups[0].nodeName).toBe("ES-1");
    expect(model.groups[0].windows.length).toBe(4);
    expect(model.groups[1].nodeName).toBe("SW-0");
    expect(model.groups[1].ethN).toBe(1);
    expect(model.groups[1].windows.length).toBe(4);
    expect(model.flowNames.get(0)).toBe("ST流0");
    expect(model.flowNames.get(1)).toBe("ST流1");
  });

  it("节点筛选：mid 或显示名均可命中，仅留该节点组", () => {
    const byMid = buildGclDisplayModel(twoFlowDetail(), { flowSeq: null, node: "0" });
    expect(byMid.groups.length).toBe(1);
    expect(byMid.groups[0].nodeName).toBe("SW-0");
    const byName = buildGclDisplayModel(twoFlowDetail(), { flowSeq: null, node: "ES-1" });
    expect(byName.groups.length).toBe(1);
    expect(byName.groups[0].node).toBe("1");
  });

  it("流筛选：仅留含该流引用的窗（门控可视化/门控表语义）", () => {
    const model = buildGclDisplayModel(twoFlowDetail(), { flowSeq: 1, node: null });
    expect(model.groups.length).toBe(2);
    expect(model.groups[0].windows.map((w) => w.startNs)).toEqual([10000]);
    expect(model.groups[1].windows.map((w) => w.startNs)).toEqual([16560]);
  });

  it("流集缺 seq 时流名回退「流{seq}」", () => {
    const detail = twoFlowDetail();
    detail.streams = [];
    const model = buildGclDisplayModel(detail, { flowSeq: null, node: null });
    expect(model.flowNames.get(0)).toBe("流0");
  });
});

describe("deriveFlowWindowChains（KTD9 展示层窗口链）", () => {
  it("两跳链：入窗 = 上游出窗 + 串行化 + 处理 2μs；发=首跳出窗、收=末跳出窗+传播", () => {
    const chains = deriveFlowWindowChains(twoFlowDetail());
    expect(chains.length).toBe(2);
    const c0 = chains[0];
    expect(c0.streamSeq).toBe(0);
    expect(c0.hops.length).toBe(2);
    // 首跳（talker 出端口）：无入窗，两实例出窗。
    expect(c0.hops[0].node).toBe("ES-1");
    expect(c0.hops[0].rxWindows).toBeNull();
    expect(c0.hops[0].txWindows).toEqual([
      [0, 4560],
      [500000, 504560],
    ]);
    // 第二跳：入窗 = 出窗(hop0) + 4560 + 2000。
    const shift = serializationNs(512) + PROCESSING_DELAY_NS;
    expect(shift).toBe(6560);
    expect(c0.hops[1].rxWindows).toEqual([
      [6560, 11120],
      [506560, 511120],
    ]);
    expect(c0.hops[1].txWindows).toEqual([
      [6560, 11120],
      [506560, 511120],
    ]);
    expect(c0.hops[1].inconsistent).toBe(false);
    expect(c0.sendWindows).toEqual(c0.hops[0].txWindows);
    expect(c0.receiveWindows).toEqual([
      [6560, 11120],
      [506560, 511120],
    ]);
  });

  it("推导入窗起点晚于本跳出窗起点 → 该跳 inconsistent（KTD9 sanity）", () => {
    const detail = twoFlowDetail();
    // 把 s1 的下游窗提前到 12000（< 10000+6560=16560 推导入窗）→ 不一致。
    const w = detail.windows.find((x) => x.startNs === 16560);
    if (w) {
      w.startNs = 12000;
    }
    const chains = deriveFlowWindowChains(detail);
    const c1 = chains.find((c) => c.streamSeq === 1);
    expect(c1?.hops[1].inconsistent).toBe(true);
  });

  it("类级降级流整链隐藏（R9）；degradedFlowSeqs 汇总 source=class 的 seq", () => {
    const detail = twoFlowDetail();
    const w = detail.windows.find((x) => x.startNs === 16560);
    if (w) {
      w.flowRefs = [{ seq: 1, source: "class" }];
    }
    expect([...degradedFlowSeqs(detail)]).toEqual([1]);
    const chains = deriveFlowWindowChains(detail);
    expect(chains.map((c) => c.streamSeq)).toEqual([0]);
  });
});

describe("buildGclOverview（R15 八项指标）", () => {
  it("八项指标逐项数值（两流两跳 fixture）", () => {
    const o = buildGclOverview(twoFlowDetail());
    // ① 调度状态。
    expect(o.scheduleStatus).toBe("ok");
    expect(o.stale).toBe(false);
    // ② 超周期。
    expect(o.cycleNs).toBe(1_000_000);
    // ③ 流数 / 门控端口数 / 涉及队列（ST 开窗位图 distinct 位）。
    expect(o.streamCount).toBe(2);
    expect(o.gatedPortCount).toBe(2);
    expect(o.gatedQueues).toEqual([7]);
    // ④ GCL 表项数 / 打开窗口数（位图非全零；0x00 全关窗不计开）。
    expect(o.entryCount).toBe(8);
    expect(o.openWindowCount).toBe(7);
    // ⑤ 最大门控窗口占用 %：每端口 ST 开窗 3×4560ns / 1ms = 1.368%。
    expect(o.maxPortOpenPct).toBeCloseTo(1.368, 5);
    // ⑥ 关闭窗口占比 %：全关窗 1000ns / (2 端口 × 1ms) = 0.05%。
    expect(o.closedPct).toBeCloseTo(0.05, 5);
    // ⑦ 最大链路带宽占用 %：s0 4560bit/500μs=9.12Mbps + s1 4560bit/1000μs=4.56Mbps
    //    同链叠加 13.68Mbps / 1000Mbps = 1.368%。
    expect(o.maxLinkUtilizationPct).toBeCloseTo(1.368, 5);
    // ⑧ 时延分析：两流端到端均 11120ns（收尾 − 发头）；s0 裕度 = 100μs/11120ns。
    expect(o.latency.rows.length).toBe(2);
    const r0 = o.latency.rows.find((r) => r.streamSeq === 0);
    expect(r0?.latencyNs).toBe(11120);
    expect(r0?.maxLatencyNs).toBe(100000);
    expect(r0?.marginRatio).toBeCloseTo(100000 / 11120, 5);
    const r1 = o.latency.rows.find((r) => r.streamSeq === 1);
    expect(r1?.latencyNs).toBe(11120);
    // maxLatency 未设 → 裕度 null（UI 出「未设上限」）。
    expect(r1?.maxLatencyNs).toBeNull();
    expect(r1?.marginRatio).toBeNull();
    expect(o.latency.maxLatencyNs).toBe(11120);
    expect(o.latency.excludedCount).toBe(0);
  });

  it("类级降级流排除出时延分析并计入 excludedCount（R15 口径）", () => {
    const detail = twoFlowDetail();
    const w = detail.windows.find((x) => x.startNs === 16560);
    if (w) {
      w.flowRefs = [{ seq: 1, source: "class" }];
    }
    const o = buildGclOverview(detail);
    expect(o.latency.rows.map((r) => r.streamSeq)).toEqual([0]);
    expect(o.latency.excludedCount).toBe(1);
    expect(o.latency.maxLatencyNs).toBe(11120);
  });

  it("空 detail（meta=null）：比例类指标 null、计数 0（老工程空态）", () => {
    const o = buildGclOverview({ windows: [], meta: null, streams: [] });
    expect(o.scheduleStatus).toBeNull();
    expect(o.stale).toBe(false);
    expect(o.cycleNs).toBeNull();
    expect(o.streamCount).toBe(0);
    expect(o.gatedPortCount).toBe(0);
    expect(o.gatedQueues).toEqual([]);
    expect(o.entryCount).toBe(0);
    expect(o.openWindowCount).toBe(0);
    expect(o.maxPortOpenPct).toBeNull();
    expect(o.closedPct).toBeNull();
    expect(o.maxLinkUtilizationPct).toBeNull();
    expect(o.latency.rows).toEqual([]);
    expect(o.latency.maxLatencyNs).toBeNull();
    expect(o.latency.excludedCount).toBe(0);
  });

  it("stale=true 透传（KTD14 需重新规划提示判据）", () => {
    const detail = twoFlowDetail();
    if (detail.meta) {
      detail.meta.stale = true;
    }
    expect(buildGclOverview(detail).stale).toBe(true);
  });
});

describe("parseExplicitPathLinkSeqs / parseRedundantNodePaths（R16 paths 解析）", () => {
  it("origin=user 单条路由 → link_seqs；system/垃圾/null → null", () => {
    const user = JSON.stringify({
      version: 1,
      origin: "user",
      routes: [{ node_path: ["1", "0", "2"], link_seqs: [0, 1] }],
    });
    expect(parseExplicitPathLinkSeqs(user)).toEqual([0, 1]);
    const system = JSON.stringify({
      version: 1,
      origin: "system",
      routes: [{ node_path: ["1", "0", "2"], link_seqs: [0, 1] }],
    });
    expect(parseExplicitPathLinkSeqs(system)).toBeNull();
    expect(parseExplicitPathLinkSeqs("not-json")).toBeNull();
    expect(parseExplicitPathLinkSeqs(JSON.stringify({ origin: "user" }))).toBeNull();
    expect(parseExplicitPathLinkSeqs(null)).toBeNull();
  });

  it("RC 双路由 → [A 节点序列, B 节点序列]；单条/形状不符 → null", () => {
    const rc = JSON.stringify({
      version: 1,
      origin: "system",
      routes: [
        { node_path: ["0", "2", "1"], link_seqs: [0, 1] },
        { node_path: ["0", "3", "1"], link_seqs: [2, 3] },
      ],
    });
    expect(parseRedundantNodePaths(rc)).toEqual([
      ["0", "2", "1"],
      ["0", "3", "1"],
    ]);
    const single = JSON.stringify({
      version: 1,
      origin: "user",
      routes: [{ node_path: ["0", "2", "1"], link_seqs: [0, 1] }],
    });
    expect(parseRedundantNodePaths(single)).toBeNull();
    expect(parseRedundantNodePaths(null)).toBeNull();
  });
});
