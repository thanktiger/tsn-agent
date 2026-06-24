/**
 * Plan 2026-06-24-001 U11：`query_timesync` Tauri command 返回值的 TS 镜像。
 *
 * time-sync 阶段画布渲染时钟树的只读数据源。端口角色（master/slave/passive）由
 * Rust 确定性算好并落库，前端只读渲染、不参与计算。字段与
 * src-tauri/src/timesync_query_command.rs 的 serde camelCase 输出一一对应。
 */

export interface TimesyncSnapshot {
  sessionId: string;
  /** 还没设过 GM（无 timesync_domain 行）时为 null。 */
  domain: TimesyncDomainRow | null;
  nodes: TimesyncNodeRow[];
}

export interface TimesyncDomainRow {
  /** 时钟主节点 mid；未设时为 null。 */
  gmMid: string | null;
  oneStepMode: number;
  freSwitch: number;
  disabledLinkSeqs: number[];
}

export interface TimesyncNodeRow {
  mid: string;
  /** 朝子端口（master 角色）。 */
  masterPort: number[];
  /** 朝父端口（slave 角色）。 */
  slavePort: number[];
  /** 参与时钟树的端口（master ∪ slave）。 */
  portPtpEnabled: number[];
  syncPeriod: number | null;
  measurePeriod: number | null;
  reportEnable: number | null;
  meanLinkDelayThresh: number | null;
  offsetThreshold: number | null;
}

/** 节点在时钟树里的角色：GM（根）、有 slave 端口（被同步）、纯 passive、未覆盖。 */
export type TimesyncNodeRole = "gm" | "synced" | "passive" | "uncovered";

/** 单节点端口角色摘要（供画布徽标 + 详情）。 */
export interface TimesyncNodeRoleSummary {
  role: TimesyncNodeRole;
  masterCount: number;
  slaveCount: number;
}

/**
 * 从快照推导某节点的时钟树角色摘要。GM 优先；有 slave 端口=被同步；
 * 参与树（master 或 slave 非空）但无 slave 的非 GM 节点仍视为 synced 的上游；
 * 完全不参与树（master/slave 皆空）=passive。无对应 node 行=uncovered。
 */
export function timesyncRoleForNode(
  snapshot: TimesyncSnapshot | undefined,
  mid: string,
): TimesyncNodeRoleSummary {
  const gmMid = snapshot?.domain?.gmMid ?? null;
  const node = snapshot?.nodes.find((candidate) => candidate.mid === mid);
  if (!node) {
    // 设了 GM 但该节点不在 timesync_nodes（不连通子图）→ 未覆盖。
    return { role: gmMid ? "uncovered" : "passive", masterCount: 0, slaveCount: 0 };
  }
  const masterCount = node.masterPort.length;
  const slaveCount = node.slavePort.length;
  if (gmMid !== null && mid === gmMid) {
    return { role: "gm", masterCount, slaveCount };
  }
  if (masterCount === 0 && slaveCount === 0) {
    return { role: "passive", masterCount, slaveCount };
  }
  return { role: "synced", masterCount, slaveCount };
}

export function isEmptyTimesyncSnapshot(snapshot: TimesyncSnapshot | undefined): boolean {
  return !snapshot || (snapshot.domain === null && snapshot.nodes.length === 0);
}
