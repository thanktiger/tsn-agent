import { invoke } from "@tauri-apps/api/core";

/**
 * U11/U12/U13：时钟同步软仿前端契约。
 *
 * 后端命令 run_timesync_sim 返回 SimResult（camelCase，与 inet_sim_command.rs serde 对齐）。
 * 运行态 SimUiState 持于 App 级（非 tab 组件内）——切 tab 不取消命令、切回按 status 恢复。
 */

/** offset(t) 抖动轨迹采样点：仿真时间（ms）+ 相对 GM 偏差（ns，带符号）。 */
export interface OffsetSample {
  tMs: number;
  offsetNs: number;
}

export interface PerNodeOffset {
  mid: string;
  /** 稳态 max|offset|（纳秒）。 */
  maxOffsetNs: number;
  /** 稳态 mean|offset|（纳秒）。 */
  meanOffsetNs: number;
  converged: boolean;
  /** 是否在该节点 offset_threshold 参考线内（仅参考、非质量判定）。 */
  withinThreshold: boolean;
  /** 该节点生效的收敛阈值（纳秒）——逐节点 offset_threshold，缺省回退全局兜底。 */
  thresholdNs: number;
  /** 完整 offset(t) 抖动轨迹（降采样封顶），供画收敛曲线。 */
  samples: OffsetSample[];
}

/** converged | empty | load_failed | unreachable | stale_tree | bundle_error | parse_failed */
export type SimStatus = string;

export interface SimResult {
  caliber: string;
  status: SimStatus;
  perNode: PerNodeOffset[];
  /** 顶部总判定文案。 */
  overall: string;
  /** 非 converged 时的诊断文案。 */
  message?: string;
}

/** U12：软仿覆盖表单值（缺省走后端默认）。Constant 用 driftPpm；Random 用 driftRateChangePpm + changeIntervalMs。 */
export interface SimOverrideForm {
  oscillator?: "Constant" | "Random";
  driftPpm?: number;
  driftRateChangePpm?: number;
  changeIntervalMs?: number;
  simTimeS?: number;
}

/** U5/U6：软仿覆盖参数的生效默认值（后端单一事实源，前端读用于折叠摘要 + 展开预填）。 */
export interface SimDefaults {
  oscillator: "Constant" | "Random";
  driftPpm: number;
  driftRateChangePpm: number;
  changeIntervalMs: number;
  simTimeS: number;
}

/** get_sim_defaults 取数失败/加载中的兜底（仅降级用；正常走后端单一事实源）。 */
export const FALLBACK_SIM_DEFAULTS: SimDefaults = {
  oscillator: "Random",
  driftPpm: 100,
  driftRateChangePpm: 0.3,
  changeIntervalMs: 12.5,
  simTimeS: 60,
};

/** U6：默认读通道 = get_sim_defaults Tauri command（测试可注入替身）。 */
export async function invokeGetSimDefaults(): Promise<SimDefaults> {
  return await invoke<SimDefaults>("get_sim_defaults");
}

/** U11：App 级软仿运行态——切 tab 不丢、按 status 恢复对应态。 */
export type SimUiState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: SimResult }
  | { status: "error"; message: string };

/** 软仿命令是否「全部收敛」（空结果/失败绝不算收敛）。 */
export function isFullyConverged(result: SimResult): boolean {
  return (
    result.status === "converged" &&
    result.perNode.length > 0 &&
    result.perNode.every((node) => node.converged)
  );
}

/** 是否存在未收敛节点（U13「解释」按钮的出现条件）。 */
export function hasNonConvergedNode(result: SimResult): boolean {
  return result.perNode.some((node) => !node.converged);
}

/** U4：set_gm 揭示的每会话基线——区分「切会话水合」与「同会话内 set_gm 跃迁」。 */
export interface RevealBaseline {
  sessionId: string;
  gmMid: string | null | undefined;
  established: boolean;
}

/** U4 揭示动作：展开并落软仿子 tab / 挂 badge / 清 badge / 无。 */
export type RevealAction = "expand-soft-sim" | "badge" | "clear-badge" | "none";

/**
 * U4：set_gm 后分级揭示的纯决策（无副作用，便于单测）。App 的 effect 调它并据 action 改 state。
 * 关键防误触：只认属于当前会话的快照（snapshotSessionId === currentSessionId）。切会话时
 * useTimesyncSnapshot 首帧仍是旧会话快照，sessionId 不符 → 不揭示、不建基线，直到当前会话快照到达
 * 作基线（不揭示）；其后同会话内 gmMid 无→有/值变化才揭示。这样「切进已有 GM 的会话」不被误当 set_gm。
 */
export function computeReveal(input: {
  baseline: RevealBaseline;
  currentSessionId: string;
  snapshotSessionId: string | undefined;
  gmMid: string | null | undefined;
  inTimeSyncStage: boolean;
  panelExpanded: boolean;
  activeIsTimeSync: boolean;
}): { nextBaseline: RevealBaseline; action: RevealAction } {
  const { baseline, currentSessionId, snapshotSessionId, gmMid } = input;
  // 会话变了：基线重置为未建立，不揭示（首帧快照可能仍是旧会话的，不可信）。
  if (baseline.sessionId !== currentSessionId) {
    return {
      nextBaseline: { sessionId: currentSessionId, gmMid: undefined, established: false },
      action: "none",
    };
  }
  // 快照不属于当前会话（切换后旧快照残留）→ 等当前会话快照到达。
  if (snapshotSessionId !== currentSessionId) {
    return { nextBaseline: baseline, action: "none" };
  }
  // 首个当前会话快照 → 作基线，不揭示。
  if (!baseline.established) {
    return {
      nextBaseline: { sessionId: currentSessionId, gmMid, established: true },
      action: "none",
    };
  }
  // 离开时间同步阶段 → 清 badge。
  if (!input.inTimeSyncStage) {
    return { nextBaseline: { ...baseline, gmMid }, action: "clear-badge" };
  }
  // 真实跃迁：gmMid 有值且与基线不同（首次设 GM 或换 GM）。
  let action: RevealAction = "none";
  if (gmMid && gmMid !== baseline.gmMid) {
    action = !input.panelExpanded ? "expand-soft-sim" : input.activeIsTimeSync ? "none" : "badge";
  }
  return { nextBaseline: { ...baseline, gmMid }, action };
}

/** R5a：默认软仿写通道 = run_timesync_sim Tauri command（测试可注入替身）。 */
export async function invokeRunTimesyncSim(
  sessionId: string,
  overrides: SimOverrideForm,
): Promise<SimResult> {
  return await invoke<SimResult>("run_timesync_sim", {
    request: {
      sessionId,
      oscillator: overrides.oscillator,
      driftPpm: overrides.driftPpm,
      driftRateChangePpm: overrides.driftRateChangePpm,
      changeIntervalMs: overrides.changeIntervalMs,
      simTimeS: overrides.simTimeS,
    },
  });
}

/** U13：把软仿汇总（非原始数据）+ 合成漂移上下文喂大模型生成诊断解释。 */
export function buildSimExplainPrompt(result: SimResult): string {
  const rows = result.perNode
    .map(
      (node) =>
        `节点 ${node.mid}：稳态 max|offset|=${formatNs(node.maxOffsetNs)}、mean|offset|=${formatNs(
          node.meanOffsetNs,
        )}、${node.converged ? "已收敛" : "未收敛"}${node.withinThreshold ? "" : "、超出参考线"}`,
    )
    .join("\n");
  return [
    "下面是一次 INET gPTP 时钟同步软仿的汇总结果（非原始 .vec 数据）。请用简洁中文解释为什么部分从节点未收敛、可能的成因，并给出诊断方向。",
    "重要：本面板只用于诊断，不会修改时钟树。请引导用户回到时钟同步阶段调整 GM、链路或同步参数后重跑。",
    "上下文：本次软仿的振荡器漂移为系统合成的默认值（非真实硬件标定），用于验证配置能否装配/跑起来/收敛。",
    "",
    `总判定：${result.overall}`,
    rows,
  ].join("\n");
}

function formatNs(value: number): string {
  return `${value.toFixed(1)} ns`;
}

interface ClaudeExplainResponse {
  assistantText: string;
}

/** U13：默认解释通道 = run_claude_agent Tauri command（仅取 assistantText，测试可注入替身）。 */
export async function invokeSimExplain(prompt: string): Promise<string> {
  const response = await invoke<ClaudeExplainResponse>("run_claude_agent", {
    request: { prompt },
  });
  return response.assistantText;
}
