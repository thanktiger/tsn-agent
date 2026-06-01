import { describe, expect, it } from "vitest";
import { describeTemplates } from "./templates";

describe("topology templates", () => {
  it("describes the deterministic P0 template catalog", () => {
    const catalog = describeTemplates();

    expect(catalog.summary).toEqual({
      templateCount: 3,
      templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
      templates: catalog.templates,
    });
    expect(catalog.templates.map((template) => template.id)).toEqual([
      "generic-line",
      "generic-ring",
      "dual-plane-redundant",
    ]);
    expect(catalog.templates[0].params.map((param) => param.name)).toEqual([
      "switchCount",
      "endSystemsPerSwitch",
      "dataRateMbps",
    ]);
    expect(catalog.templates[2].params.map((param) => param.name)).toEqual([
      "planes",
      "switches",
      "switchGroups",
      "endSystems",
      "backbone",
      "crossPlaneLinks",
      "dataRateMbps",
    ]);
  });
});
