import { describe, expect, it } from "vitest";
import {
  isEmptyTimesyncSnapshot,
  type TimesyncSnapshot,
  timesyncRoleForNode,
} from "./timesync-snapshot";

function snapshot(overrides: Partial<TimesyncSnapshot> = {}): TimesyncSnapshot {
  return {
    sessionId: "s1",
    domain: {
      gmMid: "0",
      oneStepMode: 0,
      freSwitch: 0,
      disabledLinkSeqs: [],
    },
    // 线性 0—1—2，GM=0：1 朝父(0) slave=[0]、朝子(2) master=[1]；2 slave=[0]。
    nodes: [
      {
        mid: "0",
        masterPort: [0],
        slavePort: [],
        portPtpEnabled: [0],
        syncPeriod: 128,
        measurePeriod: 1024,
        reportEnable: 1,
        meanLinkDelayThresh: 64,
        offsetThreshold: 1000,
      },
      {
        mid: "1",
        masterPort: [1],
        slavePort: [0],
        portPtpEnabled: [0, 1],
        syncPeriod: 128,
        measurePeriod: 1024,
        reportEnable: 1,
        meanLinkDelayThresh: 64,
        offsetThreshold: 1000,
      },
      {
        mid: "2",
        masterPort: [],
        slavePort: [0],
        portPtpEnabled: [0],
        syncPeriod: 128,
        measurePeriod: 1024,
        reportEnable: 1,
        meanLinkDelayThresh: 64,
        offsetThreshold: 1000,
      },
    ],
    ...overrides,
  };
}

describe("timesyncRoleForNode", () => {
  it("marks the GM node as gm", () => {
    const summary = timesyncRoleForNode(snapshot(), "0");
    expect(summary.role).toBe("gm");
    expect(summary.masterCount).toBe(1);
    expect(summary.slaveCount).toBe(0);
  });

  it("marks a node with a slave port as synced", () => {
    const s1 = timesyncRoleForNode(snapshot(), "1");
    expect(s1.role).toBe("synced");
    expect(s1.masterCount).toBe(1);
    expect(s1.slaveCount).toBe(1);
    const s2 = timesyncRoleForNode(snapshot(), "2");
    expect(s2.role).toBe("synced");
    expect(s2.slaveCount).toBe(1);
  });

  it("marks a node with no master/slave ports as passive", () => {
    const s = snapshot({
      nodes: [
        {
          mid: "0",
          masterPort: [0],
          slavePort: [],
          portPtpEnabled: [0],
          syncPeriod: null,
          measurePeriod: null,
          reportEnable: null,
          meanLinkDelayThresh: null,
          offsetThreshold: null,
        },
        {
          mid: "9",
          masterPort: [],
          slavePort: [],
          portPtpEnabled: [],
          syncPeriod: null,
          measurePeriod: null,
          reportEnable: null,
          meanLinkDelayThresh: null,
          offsetThreshold: null,
        },
      ],
    });
    expect(timesyncRoleForNode(s, "9").role).toBe("passive");
  });

  it("marks a node missing from timesync_nodes as uncovered when a GM is set", () => {
    // 设了 GM 但该节点不在 timesync_nodes（不连通子图）。
    expect(timesyncRoleForNode(snapshot(), "7").role).toBe("uncovered");
  });

  it("treats missing nodes as passive (not uncovered) when no GM is set", () => {
    const noGm = snapshot({
      domain: { gmMid: null, oneStepMode: 0, freSwitch: 0, disabledLinkSeqs: [] },
      nodes: [],
    });
    expect(timesyncRoleForNode(noGm, "0").role).toBe("passive");
  });

  it("treats an undefined snapshot as passive", () => {
    expect(timesyncRoleForNode(undefined, "0").role).toBe("passive");
  });
});

describe("isEmptyTimesyncSnapshot", () => {
  it("is empty for undefined and for null-domain + no-nodes", () => {
    expect(isEmptyTimesyncSnapshot(undefined)).toBe(true);
    expect(isEmptyTimesyncSnapshot({ sessionId: "s1", domain: null, nodes: [] })).toBe(true);
  });

  it("is non-empty once a domain row exists", () => {
    expect(isEmptyTimesyncSnapshot(snapshot())).toBe(false);
  });
});
