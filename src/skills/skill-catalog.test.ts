import { describe, expect, it } from "vitest";
import { SKILL_CATALOG } from "./skill-catalog";

describe("skill catalog", () => {
  it("covers every stage skill used by the workflow", () => {
    expect(SKILL_CATALOG.map((skill) => skill.id)).toEqual([
      "tsn-topology",
      "tsn-time-sync",
      "tsn-flow-planning",
    ]);
    expect(SKILL_CATALOG.map((skill) => skill.stage)).toEqual([
      "topology",
      "time-sync",
      "flow-template",
    ]);
  });

  it("keeps catalog metadata read-only for the workspace skill panel", () => {
    expect(SKILL_CATALOG[0]).toMatchObject({
      id: "tsn-topology",
      displayName: "拓扑生成",
      status: "enabled",
      notes: "已有独立 skill，可作为后续 skill 详情和执行状态展示的基准。",
    });
  });
});
