import { describe, expect, it } from "vitest";

import {
  gptpDiagLine,
  isZ3Guaranteed,
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
