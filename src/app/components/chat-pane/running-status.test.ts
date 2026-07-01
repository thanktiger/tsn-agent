import { describe, expect, it } from "vitest";
import {
  formatRunningStatus,
  pickRunningVerb,
  RUNNING_VERBS,
  runPhaseShortLabel,
} from "./running-status";

describe("running-status", () => {
  it("maps each phase to a short label", () => {
    expect(runPhaseShortLabel("connecting")).toBe("连接中");
    expect(runPhaseShortLabel("streaming")).toBe("推理中");
    expect(runPhaseShortLabel("waiting")).toBe("等待工具");
  });

  it("falls back to 推理中 for idle/unknown phase", () => {
    expect(runPhaseShortLabel("idle")).toBe("推理中");
  });

  it("always picks a verb from the pool", () => {
    for (let i = 0; i < 50; i++) {
      expect(RUNNING_VERBS).toContain(pickRunningVerb());
    }
  });

  it("formats the status text with verb, seconds, and phase word", () => {
    expect(formatRunningStatus({ verb: "盘算", phase: "streaming", elapsedSeconds: 12 })).toBe(
      "盘算中…（12s · 推理中）",
    );
    expect(formatRunningStatus({ verb: "推演", phase: "connecting", elapsedSeconds: 0 })).toBe(
      "推演中…（0s · 连接中）",
    );
  });

  it("keeps the verb stable while the phase word changes", () => {
    const s1 = formatRunningStatus({ verb: "编织", phase: "connecting", elapsedSeconds: 1 });
    const s2 = formatRunningStatus({ verb: "编织", phase: "streaming", elapsedSeconds: 2 });
    expect(s1).toContain("编织中…");
    expect(s2).toContain("编织中…");
    expect(s1).toContain("连接中");
    expect(s2).toContain("推理中");
  });
});
