import type { AgentRunPhase } from "../../hooks/use-agent-run-controller";

/** 推理提示行用的中文动词——进入一轮推理时随机取一个，整轮固定，避免每秒切换晃眼。 */
export const RUNNING_VERBS = [
  "盘算",
  "推演",
  "编织",
  "梳理",
  "斟酌",
  "端详",
  "盘点",
  "勾画",
] as const;

/** 从动词库随机取一个，用于一轮推理的动画提示。 */
export function pickRunningVerb(): string {
  return RUNNING_VERBS[Math.floor(Math.random() * RUNNING_VERBS.length)];
}

/** phase → 一行提示用的短状态词（streaming 与兜底 idle 都归「推理中」）。 */
export function runPhaseShortLabel(phase: AgentRunPhase): string {
  switch (phase) {
    case "connecting":
      return "连接中";
    case "waiting":
      return "等待工具";
    default:
      return "推理中";
  }
}

/** 组装图标之外的文本，如「盘算中…（12s · 推理中）」。旋转图标是纯 CSS 装饰，不进这里。 */
export function formatRunningStatus({
  verb,
  phase,
  elapsedSeconds,
}: {
  verb: string;
  phase: AgentRunPhase;
  elapsedSeconds: number;
}): string {
  return `${verb}中…（${elapsedSeconds}s · ${runPhaseShortLabel(phase)}）`;
}
