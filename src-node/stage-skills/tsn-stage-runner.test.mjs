import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { STAGE_SKILL_SCHEMA_VERSION } from "../../src/agent/stage-skill-contract";
import { createProjectFromIntent } from "../../src/domain/topology-factory";
import { runCli, runFlowPlanningStage, runTopologyStage } from "./tsn-stage-runner";

const execFileAsync = promisify(execFile);

const DUAL_PLANE_TOPOLOGY_PROMPT = "我需要4个交换机，每个交换机连接2个端系统，双平面冗余";

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

  it("switches from a dual-plane fallback to a generic distributed endpoint topology", () => {
    const result = runTopologyStage({
      userIntent: "改为 20 个端系统，分配到 4 台交换机",
      fallbackIntent: {
        switchCount: 4,
        endSystemsPerSwitch: 0,
        switchInterconnect: "line",
        topologyTemplate: "dual-plane-redundant",
      },
    });

    expect(result.summary).toContain("4 个交换机");
    expect(result.summary).toContain("5 个端系统");
    expect(result.payload.project.id).toBe("project-default");
    expect(result.payload.project.topology.nodes).toHaveLength(24);
  });

  it("generates the dual-plane redundant topology stage result from the prompt", () => {
    const result = runTopologyStage({
      userIntent: DUAL_PLANE_TOPOLOGY_PROMPT,
      scenarioConfigId: "aerospace-onboard",
    });

    expect(result.summary).toContain("双平面冗余拓扑");
    expect(result.summary).toContain("每个交换机连接 2 个端系统");
    expect(result.payload.project.topology.nodes).toHaveLength(12);
    expect(result.payload.project.topology.links).toHaveLength(18);
    expect(result.payload.project.flows).toHaveLength(0);
    expect(result.payload.project.topology.nodes.filter((node) => node.type === "endSystem").every((node) => node.ports.length === 2)).toBe(true);
  });

  it("keeps endpoint wording on the dual-plane topology path", () => {
    const result = runTopologyStage({
      userIntent: DUAL_PLANE_TOPOLOGY_PROMPT,
      scenarioConfigId: "generic-tsn",
    });

    expect(result.summary).toContain("双平面冗余拓扑");
    expect(result.payload.project.id).toBe("project-default");
    expect(result.payload.project.topology.nodes).toHaveLength(12);
    expect(result.payload.project.topology.links).toHaveLength(18);
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

  it("imports complete tsn-topology skill artifacts into the canonical project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-stage-runner-skill-"));
    const resultPath = join(dir, "result.json");
    const skillOutputDir = join(dir, "skill-output");

    await mkdir(skillOutputDir, { recursive: true });
    await writeFile(
      join(skillOutputDir, "topology.json"),
      JSON.stringify({
        node: {
          nodes: [
            { imac: 100, sync_name: "0", x: 0, y: 0, node_type: "networkcard" },
            { imac: 101, sync_name: "1", x: 100, y: 0, node_type: "switch" },
            { imac: 102, sync_name: "2", x: 200, y: 0, node_type: "networkcard" },
          ],
          links: [
            { name: "0:0-1:0", styles: { leftLabel: "0", rightLabel: "0", speed: 1000 }, imac: 100, addr: 101 },
            { name: "2:0-1:1", styles: { leftLabel: "0", rightLabel: "1", speed: 1000 }, imac: 102, addr: 101 },
          ],
        },
        refs: {},
      }),
      "utf8",
    );
    await writeFile(
      join(skillOutputDir, "data-server.json"),
      JSON.stringify({
        version: "2.0",
        refs: {},
        datas: [
          { _className: "Q.Node", id: 100, src_imac: 100, display_name: "ES0", node_type: "networkcard", mac_address: "00:00:23:00:00:00", ip: "192.168.0.0", port_count: 1 },
          { _className: "Q.Node", id: 101, src_imac: 101, display_name: "SW0", node_type: "switch", port_count: 4 },
          { _className: "Q.Node", id: 102, src_imac: 102, display_name: "ES1", node_type: "networkcard", mac_address: "00:00:23:00:00:02", ip: "192.168.0.2", port_count: 1 },
        ],
        scale: 1,
      }),
      "utf8",
    );

    await runCli([
      "--stage",
      "topology",
      "--input",
      JSON.stringify({ userIntent: "生成一个星型拓扑" }),
      "--skill-output-dir",
      skillOutputDir,
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.summary).toContain("tsn-topology skill 已生成");
    expect(result.payload.project.id).toBe("project-tsn-topology-skill");
    expect(result.payload.project.topology.nodes.map((node) => node.id)).toEqual(["es1-1", "sw1", "es1-2"]);
    expect(result.payload.project.topology.nodes.map((node) => node.name)).toEqual(["ES0", "SW0", "ES1"]);
    expect(result.payload.project.topology.links).toEqual([
      expect.objectContaining({
        source: { nodeId: "es1-1", portId: "p1" },
        target: { nodeId: "sw1", portId: "p1" },
        dataRateMbps: 1000,
      }),
      expect.objectContaining({
        source: { nodeId: "es1-2", portId: "p1" },
        target: { nodeId: "sw1", portId: "p2" },
        dataRateMbps: 1000,
      }),
    ]);
  });

  it("runs the complete tsn-topology skill tool for a 9-networkcard dual-homed topology", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-topology-skill-runner-"));
    const intermediatePath = join(dir, "intermediate.json");
    const skillOutputDir = join(dir, "skill-output");
    const resultPath = join(dir, "result.json");
    const switches = [
      { node_id: 3, node_type: "switch", display_name: "交换机1" },
      { node_id: 4, node_type: "switch", display_name: "交换机2" },
      { node_id: 5, node_type: "switch", display_name: "交换机3" },
      { node_id: 6, node_type: "switch", display_name: "交换机4" },
    ];
    const networkcards = Array.from({ length: 9 }, (_, index) => ({
      node_id: index + 10,
      node_type: "networkcard",
      display_name: `网卡${index + 1}`,
    }));
    const links = [
      ...[10, 11, 12, 13, 14].flatMap((nodeId, index) => [
        { src: nodeId, src_port: 0, dst: 3, dst_port: index, speed: 1000 },
        { src: nodeId, src_port: 1, dst: 4, dst_port: index, speed: 1000 },
      ]),
      { src: 3, src_port: 5, dst: 5, dst_port: 0, speed: 1000 },
      { src: 4, src_port: 5, dst: 6, dst_port: 0, speed: 1000 },
      ...[15, 16, 17, 18].flatMap((nodeId, index) => [
        { src: nodeId, src_port: 0, dst: 5, dst_port: index + 2, speed: 1000 },
        { src: nodeId, src_port: 1, dst: 6, dst_port: index + 2, speed: 1000 },
      ]),
    ];

    await writeFile(
      intermediatePath,
      JSON.stringify({
        nodes: [...switches, ...networkcards],
        links,
      }, null, 2),
      "utf8",
    );

    await execFileAsync(process.execPath, [
      resolve(".claude/skills/tsn-topology/tools/run-topology-skill.js"),
      intermediatePath,
    ], {
      env: {
        ...process.env,
        TSN_AGENT_SKILL_OUTPUT_DIR: skillOutputDir,
      },
      maxBuffer: 1024 * 1024,
    });

    const outputFiles = await readdir(skillOutputDir);
    expect(outputFiles).toEqual(expect.arrayContaining([
      "topology.json",
      "topo_feature.json",
      "data-server.json",
      "mac-forwarding-table.json",
    ]));
    expect(outputFiles).not.toContain("mac-forwarding-table.html");

    await runCli([
      "--stage",
      "topology",
      "--input",
      JSON.stringify({ userIntent: "交换机3和4那里，我希望再添加网卡8和9" }),
      "--skill-output-dir",
      skillOutputDir,
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.summary).toContain("9 个端系统");
    expect(result.payload.project.topology.nodes).toHaveLength(13);
    expect(result.payload.project.topology.nodes.filter((node) => node.type === "endSystem")).toHaveLength(9);
    expect(result.payload.project.topology.links).toHaveLength(20);
    expect(result.payload.project.topology.nodes.map((node) => node.name)).toEqual([
      "交换机1",
      "交换机2",
      "交换机3",
      "交换机4",
      "网卡1",
      "网卡2",
      "网卡3",
      "网卡4",
      "网卡5",
      "网卡6",
      "网卡7",
      "网卡8",
      "网卡9",
    ]);
  });

  it("uses the generic topology layout when the skill output omits coordinates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-topology-default-layout-"));
    const intermediatePath = join(dir, "intermediate.json");
    const skillOutputDir = join(dir, "skill-output");

    await writeFile(
      intermediatePath,
      JSON.stringify({
        nodes: [
          { node_id: 1, node_type: "switch", display_name: "交换机1" },
          { node_id: 2, node_type: "switch", display_name: "交换机2" },
          { node_id: 10, node_type: "networkcard", display_name: "端系统1" },
          { node_id: 11, node_type: "networkcard", display_name: "端系统2" },
          { node_id: 12, node_type: "networkcard", display_name: "端系统3" },
          { node_id: 13, node_type: "networkcard", display_name: "端系统4" },
        ],
        links: [
          { src: 10, src_port: 0, dst: 1, dst_port: 0, speed: 1000 },
          { src: 11, src_port: 0, dst: 1, dst_port: 1, speed: 1000 },
          { src: 12, src_port: 0, dst: 2, dst_port: 0, speed: 1000 },
          { src: 13, src_port: 0, dst: 2, dst_port: 1, speed: 1000 },
          { src: 1, src_port: 2, dst: 2, dst_port: 2, speed: 1000 },
        ],
      }, null, 2),
      "utf8",
    );

    await execFileAsync(process.execPath, [
      resolve(".claude/skills/tsn-topology/tools/run-topology-skill.js"),
      intermediatePath,
    ], {
      env: {
        ...process.env,
        TSN_AGENT_SKILL_OUTPUT_DIR: skillOutputDir,
      },
      maxBuffer: 1024 * 1024,
    });

    const topology = JSON.parse(await readFile(join(skillOutputDir, "topology.json"), "utf8"));
    const positionsBySyncName = new Map(
      topology.node.nodes.map((node) => [node.sync_name, { x: node.x, y: node.y }]),
    );

    expect(positionsBySyncName.get("1")).toEqual({ x: 80, y: 220 });
    expect(positionsBySyncName.get("2")).toEqual({ x: 380, y: 220 });
    expect(positionsBySyncName.get("10")).toEqual({ x: 80, y: 70 });
    expect(positionsBySyncName.get("11")).toEqual({ x: 142, y: 390 });
    expect(positionsBySyncName.get("12")).toEqual({ x: 380, y: 70 });
    expect(positionsBySyncName.get("13")).toEqual({ x: 442, y: 390 });
  });

  it("rejects distributed skill topology output when switch interconnect links are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-topology-missing-switch-links-"));
    const intermediatePath = join(dir, "intermediate.json");
    const skillOutputDir = join(dir, "skill-output");
    const resultPath = join(dir, "result.json");
    const nodes = [
      ...Array.from({ length: 4 }, (_, index) => ({
        node_id: index,
        node_type: "switch",
        display_name: `SW${index}`,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        node_id: index + 4,
        node_type: "networkcard",
        display_name: `ES${index}`,
      })),
    ];
    const links = Array.from({ length: 20 }, (_, index) => {
      const switchIndex = Math.floor(index / 5);
      return {
        src: index + 4,
        src_port: 0,
        dst: switchIndex,
        dst_port: index % 5,
        speed: 1000,
      };
    });

    await writeFile(
      intermediatePath,
      JSON.stringify({ nodes, links }, null, 2),
      "utf8",
    );

    await execFileAsync(process.execPath, [
      resolve(".claude/skills/tsn-topology/tools/run-topology-skill.js"),
      intermediatePath,
    ], {
      env: {
        ...process.env,
        TSN_AGENT_SKILL_OUTPUT_DIR: skillOutputDir,
      },
      maxBuffer: 1024 * 1024,
    });

    await runCli([
      "--stage",
      "topology",
      "--input",
      JSON.stringify({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" }),
      "--skill-output-dir",
      skillOutputDir,
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.status).toBe("failed");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.join("；")).toContain("缺少交换机互联链路");
  });

  it("accepts distributed skill topology output with default line switch interconnect links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsn-topology-with-switch-links-"));
    const intermediatePath = join(dir, "intermediate.json");
    const skillOutputDir = join(dir, "skill-output");
    const resultPath = join(dir, "result.json");
    const nodes = [
      ...Array.from({ length: 4 }, (_, index) => ({
        node_id: index,
        node_type: "switch",
        display_name: `SW${index}`,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        node_id: index + 4,
        node_type: "networkcard",
        display_name: `ES${index}`,
      })),
    ];
    const links = [
      ...Array.from({ length: 20 }, (_, index) => {
        const switchIndex = Math.floor(index / 5);
        return {
          src: index + 4,
          src_port: 0,
          dst: switchIndex,
          dst_port: index % 5,
          speed: 1000,
        };
      }),
      { src: 0, src_port: 5, dst: 1, dst_port: 5, speed: 1000 },
      { src: 1, src_port: 6, dst: 2, dst_port: 5, speed: 1000 },
      { src: 2, src_port: 6, dst: 3, dst_port: 5, speed: 1000 },
    ];

    await writeFile(
      intermediatePath,
      JSON.stringify({ nodes, links }, null, 2),
      "utf8",
    );

    await execFileAsync(process.execPath, [
      resolve(".claude/skills/tsn-topology/tools/run-topology-skill.js"),
      intermediatePath,
    ], {
      env: {
        ...process.env,
        TSN_AGENT_SKILL_OUTPUT_DIR: skillOutputDir,
      },
      maxBuffer: 1024 * 1024,
    });

    await runCli([
      "--stage",
      "topology",
      "--input",
      JSON.stringify({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" }),
      "--skill-output-dir",
      skillOutputDir,
      "--result-path",
      resultPath,
    ]);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.status).toBe("success");
    expect(result.validation.ok).toBe(true);
    expect(result.payload.project.topology.links).toHaveLength(23);
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
