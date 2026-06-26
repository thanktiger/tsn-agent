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

/** U12：软仿覆盖表单值（缺省走后端默认）。 */
export interface SimOverrideForm {
  oscillator?: "Constant" | "Random";
  driftPpm?: number;
  simTimeS?: number;
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
