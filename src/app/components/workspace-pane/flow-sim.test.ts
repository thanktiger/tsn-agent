import { describe, expect, it } from "vitest";

import {
  isZ3Guaranteed,
  type PlanResult,
  planSucceeded,
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
});
