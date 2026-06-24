import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENARIO_CONFIG_ID,
  getScenarioConfig,
  resolveScenarioConfig,
  SCENARIO_CONFIGS,
  WORKFLOW_STEPS,
} from "./scenario-config";

describe("scenario config", () => {
  it("uses the aerospace onboard config by default", () => {
    const config = getScenarioConfig();

    expect(DEFAULT_SCENARIO_CONFIG_ID).toBe("aerospace-onboard");
    expect(config.id).toBe(DEFAULT_SCENARIO_CONFIG_ID);
    expect(config.exampleIntent).toContain("双平面双跳");
    expect(config.stageLabels.topology).toBe("拓扑生成");
    expect(config.stageLabels["flow-template"]).toBe("流量规划");
    expect(config.flowTemplates[0].name).toBe("时序控制消息-1");
  });

  it("resolves the generic TSN config by id", () => {
    const config = getScenarioConfig("generic-tsn");

    expect(config.exampleIntent).toContain("交换机");
    expect(config.stageLabels.topology).toBe("拓扑");
    expect(config.stageLabels["flow-template"]).toBe("流量规划");
    expect(config.flowTemplates[0].name).toBe("控制流-1");
  });

  it("defines labels for every stable workflow step", () => {
    for (const config of Object.values(SCENARIO_CONFIGS)) {
      expect(Object.keys(config.stageLabels).sort()).toEqual([...WORKFLOW_STEPS].sort());
    }
  });

  it("resolves the typical aerospace onboard config", () => {
    const config = getScenarioConfig("aerospace-onboard");

    expect(config.displayName).toContain("箭载");
    expect(config.exampleIntent).toContain("双平面双跳");
    expect(config.stageLabels["flow-template"]).toBe("流量规划");
    expect(config.flowTemplates[0].name).toBe("时序控制消息-1");
    expect(config.flowTemplates[0].periodUs).toBe(1_000);
    expect(config.flowTemplates[0].frameSizeBytes).toBe(10);
  });

  it("falls back to the generic config for unknown ids with a warning", () => {
    const resolution = resolveScenarioConfig("missing-config");

    expect(resolution.config.id).toBe("aerospace-onboard");
    expect(resolution.fallback).toBe(true);
    expect(resolution.warning).toContain("missing-config");
  });
});
