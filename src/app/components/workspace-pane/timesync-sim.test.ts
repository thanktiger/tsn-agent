import { describe, expect, it } from "vitest";
import { computeReveal, type RevealBaseline } from "./timesync-sim";

const established = (gmMid: string | null | undefined): RevealBaseline => ({
  sessionId: "s1",
  gmMid,
  established: true,
});

function reveal(over: Partial<Parameters<typeof computeReveal>[0]> = {}) {
  return computeReveal({
    baseline: established(null),
    currentSessionId: "s1",
    snapshotSessionId: "s1",
    gmMid: "0",
    inTimeSyncStage: true,
    panelExpanded: false,
    activeIsTimeSync: false,
    ...over,
  });
}

describe("computeReveal — U4 set_gm 分级揭示决策", () => {
  it("会话变了 → 基线重置未建立、不揭示（首帧旧快照不信）", () => {
    const r = computeReveal({
      baseline: established("0"),
      currentSessionId: "s2",
      snapshotSessionId: "s1", // 旧会话残留快照
      gmMid: "0",
      inTimeSyncStage: true,
      panelExpanded: false,
      activeIsTimeSync: false,
    });
    expect(r.action).toBe("none");
    expect(r.nextBaseline).toEqual({ sessionId: "s2", gmMid: undefined, established: false });
  });

  it("快照不属于当前会话（切换残留）→ 不揭示、基线不动", () => {
    const baseline: RevealBaseline = { sessionId: "s1", gmMid: undefined, established: false };
    const r = reveal({ baseline, snapshotSessionId: "old", gmMid: "0" });
    expect(r.action).toBe("none");
    expect(r.nextBaseline).toBe(baseline);
  });

  it("切进已有 GM 的会话：首个当前会话快照作基线、不揭示（防误触核心）", () => {
    const baseline: RevealBaseline = { sessionId: "s1", gmMid: undefined, established: false };
    const r = reveal({ baseline, snapshotSessionId: "s1", gmMid: "0" });
    expect(r.action).toBe("none");
    expect(r.nextBaseline).toEqual({ sessionId: "s1", gmMid: "0", established: true });
  });

  it("同会话内 gmMid 无→有、面板收起 → 展开并落软仿子 tab", () => {
    const r = reveal({ baseline: established(null), gmMid: "0", panelExpanded: false });
    expect(r.action).toBe("expand-soft-sim");
    expect(r.nextBaseline.gmMid).toBe("0");
  });

  it("换 GM（值变化）也揭示", () => {
    const r = reveal({ baseline: established("0"), gmMid: "1", panelExpanded: false });
    expect(r.action).toBe("expand-soft-sim");
  });

  it("面板已开但在别 tab → 挂 badge，不抢焦点", () => {
    const r = reveal({
      baseline: established(null),
      gmMid: "0",
      panelExpanded: true,
      activeIsTimeSync: false,
    });
    expect(r.action).toBe("badge");
  });

  it("面板已开且就在时间同步 tab → 不动", () => {
    const r = reveal({
      baseline: established(null),
      gmMid: "0",
      panelExpanded: true,
      activeIsTimeSync: true,
    });
    expect(r.action).toBe("none");
  });

  it("gmMid 未变 → 不揭示", () => {
    const r = reveal({ baseline: established("0"), gmMid: "0", panelExpanded: false });
    expect(r.action).toBe("none");
  });

  it("离开时间同步阶段 → 清 badge", () => {
    const r = reveal({ baseline: established("0"), gmMid: "0", inTimeSyncStage: false });
    expect(r.action).toBe("clear-badge");
  });

  it("非时间同步阶段 + gmMid 跃迁 → 仍只清 badge、不揭示", () => {
    const r = reveal({ baseline: established(null), gmMid: "1", inTimeSyncStage: false });
    expect(r.action).toBe("clear-badge");
  });
});
