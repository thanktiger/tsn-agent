// Plan 2026-06-25-002 U2：eval 记录的版本指纹（worker 内净新派生）。
// fingerprint = skillHash + skeletonVersion + scenarioId + model（进 EvalRecord.fingerprint）；
// toolsHash 单独算（进 EvalRecord.input.toolsHash，R5b——全量定义不入行）。

import { createHash } from "node:crypto";
import type { EvalFingerprint } from "./eval-record";

/** 内容 → "sha256:<hex>"。 */
export function sha256Hex(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * 当时可用工具的指纹。入参为工具标识（buildAllowedToolsForStage 的产物等）；
 * 排序后 join 再 hash —— 工具顺序无关，集合相同则指纹相同。
 */
export function computeToolsHash(toolIdentifiers: readonly string[]): string {
  const normalized = [...toolIdentifiers]
    .map((tool) => String(tool))
    .sort()
    .join("\n");
  return sha256Hex(normalized);
}

export interface FingerprintInputs {
  /** SKILL.md 实际读到的内容（buildSystemPromptForStage 已读）。缺则 skillHash=null。 */
  skillContent?: string | null;
  /** SYSTEM_PROMPT_SKELETON 内容。缺则 skeletonVersion=null。 */
  skeleton?: string | null;
  scenarioId?: string | null;
  model?: string | null;
}

export function buildFingerprint(input: FingerprintInputs): EvalFingerprint {
  return {
    skillHash: typeof input.skillContent === "string" ? sha256Hex(input.skillContent) : null,
    skeletonVersion: typeof input.skeleton === "string" ? sha256Hex(input.skeleton) : null,
    scenarioId: input.scenarioId ?? null,
    model: input.model ?? null,
  };
}
