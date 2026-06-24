/**
 * Plan v3 Phase B-β：legacy stage-skill-result.v0 协议已删除
 * （parse/validate/summarize 与 StageSkillResult union 一并移除）。
 * 仅保留 skill 目录（skill-catalog / skill-file-service / SkillFilePreview）
 * 仍在使用的 skill 名字类型。
 */
export type StageSkillName = "tsn-topology" | "tsn-time-sync" | "tsn-flow-planning";
