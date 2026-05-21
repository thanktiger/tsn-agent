import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { STAGE_SKILL_SCHEMA_VERSION } from "../../src/agent/stage-skill-contract";
import { createProjectFromIntent } from "../../src/domain/topology-factory";
import { runCli, runFlowPlanningStage, runTopologyStage } from "./tsn-stage-runner";

const AEROSPACE_TOPOLOGY_PROMPT = [
  "基于箭载TSN技术规范创建图示拓扑：采用双冗余链路和两组系统交换机。",
  "创建4台交换机和7个网卡，交换机1、交换机2为左侧系统交换机，交换机3、交换机4为右侧系统交换机。",
  "网卡1、网卡2、网卡3、网卡4、网卡5分别双归属连接交换机1和交换机2；网卡6、网卡7分别双归属连接交换机3和交换机4。",
  "主干链路为交换机1连接交换机3、交换机2连接交换机4，2台系统交换机为独立单机，不相互级联，链路速率不小于1000Mbps。",
].join("");

describe("tsn-stage-runner", () => {
  it("generates a canonical-first topology stage result", () => {
    const result = runTopologyStage({
      userIntent: "我需要4个交换机，每个交换机连接5个端系统",
    });

    expect(result).toMatchObject({
      schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
      validation: { ok: true, errors: [] },
      payload: { kind: "topology" },
    });
    expect(result.payload.kind).toBe("topology");
    expect(result.payload.project.topology.nodes).toHaveLength(24);
    expect(result.payload.project.topology.links).toHaveLength(23);
    expect(result.payload.project.flows).toHaveLength(0);
  });

  it("uses fallback topology intent for partial edits", () => {
    const result = runTopologyStage({
      userIntent: "需要改成4台交换机，每台连接3个端",
      fallbackIntent: {
        switchCount: 3,
        endSystemsPerSwitch: 5,
        switchInterconnect: "line",
      },
    });

    expect(result.summary).toContain("4 个交换机");
    expect(result.summary).toContain("3 个端系统");
    expect(result.payload.project.topology.nodes).toHaveLength(16);
  });

  it("generates the aerospace redundant topology stage result from the spec prompt", () => {
    const result = runTopologyStage({
      userIntent: AEROSPACE_TOPOLOGY_PROMPT,
      scenarioConfigId: "aerospace-onboard",
    });

    expect(result.summary).toContain("箭载双冗余拓扑");
    expect(result.summary).toContain("7 个网卡");
    expect(result.payload.project.topology.nodes).toHaveLength(11);
    expect(result.payload.project.topology.links).toHaveLength(16);
    expect(result.payload.project.flows).toHaveLength(0);
    expect(result.payload.project.topology.nodes.map((node) => node.name)).toEqual([
      "网卡1",
      "网卡2",
      "网卡3",
      "交换机1",
      "交换机2",
      "网卡4",
      "网卡5",
      "交换机3",
      "交换机4",
      "网卡6",
      "网卡7",
    ]);
  });

  it("writes the result to the requested result path without stdout coupling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-stage-runner-"));
    const resultPath = join(dir, "result.json");

    await runCli([
      "--stage",
      "topology",
      "--input",
      JSON.stringify({ userIntent: "我需要2个交换机，每个交换机连接2个端系统" }),
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.stage).toBe("topology");
    expect(result.payload.project.topology.nodes).toHaveLength(6);
  });

  it("generates flow planning stage results with additional video and BE flows", () => {
    const topologyProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统，使用环形互联", undefined, {
      includeControlFlow: false,
    });
    const result = runFlowPlanningStage({
      userIntent: "我还需要一条视频流，还有一条BE流",
      stage: "flow-template",
      scenarioConfigId: "generic-tsn",
      project: topologyProject,
    });

    expect(result).toMatchObject({
      schemaVersion: STAGE_SKILL_SCHEMA_VERSION,
      stage: "flow-template",
      skillName: "tsn-flow-planning",
      status: "success",
      validation: { ok: true, errors: [] },
      payload: { kind: "flow-template" },
    });
    expect(result.payload.kind).toBe("flow-template");
    expect(result.payload.project.flows.map((flow) => flow.name)).toEqual(["控制流-1", "视频流-1", "BE流-1"]);
  });

  it("writes flow planning CLI results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-stage-runner-"));
    const resultPath = join(dir, "result.json");
    const project = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });

    await runCli([
      "--stage",
      "flow-template",
      "--input",
      JSON.stringify({ userIntent: "再加3条视频流吧", project }),
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.stage).toBe("flow-template");
    expect(result.payload.project.flows.map((flow) => flow.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "视频流-2",
      "视频流-3",
    ]);
  });

  it("rejects unsupported stages", async () => {
    await expect(
      runCli(["--stage", "time-sync", "--input", "{}", "--result-path", "/tmp/unused.json"]),
    ).rejects.toThrow("Unsupported stage");
  });
});
