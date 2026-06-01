import { describe, expect, it } from "vitest";
import {
  createDualPlaneRedundantTopologyProject,
  createProjectFromIntent,
  parseTopologyIntent,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "./topology-factory";
import { isEndSystem, isSwitch } from "./canonical";
import { validateCanonicalProject } from "./validation";

const DUAL_PLANE_FLOW_PROMPT = [
  "生成时序控制消息，周期1ms，需要同步，延迟约束，不允许丢包，8-10字节，高关键性；",
  "同时预留视频流，按帧频周期，关注带宽和延迟，1000-1500字节。",
].join("");

describe("topology factory", () => {
  it("parses a beginner topology request", () => {
    expect(parseTopologyIntent("我需要4个交换机，每个交换机连接5个端系统")).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 5,
      switchInterconnect: "line",
    });
  });

  it("uses fallback topology values for partial edit requests", () => {
    expect(parseTopologyIntent("每个交换机改成4个端系统", { switchCount: 3, endSystemsPerSwitch: 3 })).toEqual({
      switchCount: 3,
      endSystemsPerSwitch: 4,
      switchInterconnect: "line",
    });
  });

  it("prefers the target topology value in change requests", () => {
    expect(parseTopologyIntent("修改一下拓扑，从2交换机变为3交换机", {
      switchCount: 2,
      endSystemsPerSwitch: 5,
    })).toEqual({
      switchCount: 3,
      endSystemsPerSwitch: 5,
      switchInterconnect: "line",
    });
  });

  it("parses per-switch hosts when the user says each machine connects endpoints", () => {
    expect(parseTopologyIntent("需要改成4台交换机，每台连接3个端", {
      switchCount: 3,
      endSystemsPerSwitch: 5,
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 3,
      switchInterconnect: "line",
    });
  });

  it("parses total endpoints distributed across switches as per-switch hosts", () => {
    expect(parseTopologyIntent("改为 20 个端系统，分配到 4 台交换机", {
      switchCount: 4,
      endSystemsPerSwitch: 0,
      switchInterconnect: "line",
      topologyTemplate: "dual-plane-redundant",
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 5,
      switchInterconnect: "line",
      topologyTemplate: "dual-plane-redundant",
    });
  });

  it("prefers the target host value in per-switch change requests", () => {
    expect(parseTopologyIntent("每个交换机从3个端系统改成4个端系统", {
      switchCount: 3,
      endSystemsPerSwitch: 3,
    })).toEqual({
      switchCount: 3,
      endSystemsPerSwitch: 4,
      switchInterconnect: "line",
    });
  });

  it("parses ring interconnect while preserving previous topology counts", () => {
    expect(parseTopologyIntent("可以使用环形互联", {
      switchCount: 4,
      endSystemsPerSwitch: 3,
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 3,
      switchInterconnect: "ring",
    });
  });

  it("creates a canonical line topology with one control flow", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统");

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.topology.links).toHaveLength(23);
    expect(project.flows).toHaveLength(1);
    expect(project.flows[0].routeLinkIds).toEqual(["link-0", "link-20", "link-21", "link-22", "link-15"]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("creates a canonical ring topology when requested", () => {
    const project = createProjectFromIntent("我需要4台交换机，每台连接3个端，使用环形互联");

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(project.topology.links).toHaveLength(16);
    expect(project.topology.links.some((link) => link.source.nodeId === "sw4" && link.target.nodeId === "sw1")).toBe(true);
    expect(project.flows[0].routeLinkIds).toEqual(["link-0", "link-15", "link-9"]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("parses a dual-plane redundant topology prompt without using old reference templates", () => {
    expect(parseTopologyIntent("我需要4个交换机，每个交换机连接2个端系统，双平面冗余", undefined, {
      scenarioConfigId: "aerospace-onboard",
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 2,
      switchInterconnect: "line",
      topologyTemplate: "dual-plane-redundant",
    });
  });

  it("creates a dual-plane redundant topology before the flow stage", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接2个端系统，双平面冗余", undefined, {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });

    expect(project.id).toBe("project-default");
    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(8);
    expect(project.topology.links).toHaveLength(18);
    expect(project.flows).toHaveLength(0);
    expect(project.topology.nodes.filter(isEndSystem).every((node) => node.ports.length === 2)).toBe(true);
    expect(project.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toEqual(expect.arrayContaining([
      ["sw1", "sw3"],
      ["sw2", "sw4"],
    ]));
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("keeps dual-plane topology generic for aerospace scenarios", () => {
    const project = createProjectFromIntent("箭载场景，4个交换机，每个交换机2个端系统，双归属双平面", undefined, {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });

    expect(parseTopologyIntent("箭载场景，4个交换机，每个交换机2个端系统，双归属双平面", undefined, {
      scenarioConfigId: "aerospace-onboard",
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 2,
      switchInterconnect: "line",
      topologyTemplate: "dual-plane-redundant",
    });
    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(8);
    expect(project.id).not.toBe("project-aerospace-redundant");
  });

  it("adds generic control and video flows on top of a dual-plane topology", () => {
    const topologyOnlyProject = createDualPlaneRedundantTopologyProject({
      switchCount: 4,
      endSystemsPerSwitch: 2,
      switchInterconnect: "line",
      topologyTemplate: "dual-plane-redundant",
    }, "双平面冗余拓扑", {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });

    const project = withFlowsFromIntent(topologyOnlyProject, DUAL_PLANE_FLOW_PROMPT, {
      scenarioConfigId: "aerospace-onboard",
    });

    expect(project.flows.map((flow) => flow.name)).toEqual(["时序控制消息-1", "视频流-1"]);
    expect(withDefaultControlFlow(project, {
      scenarioConfigId: "aerospace-onboard",
    }).flows.map((flow) => flow.name)).toEqual(["时序控制消息-1", "视频流-1"]);
    expect(project.flows[0]).toMatchObject({
      id: "flow-control-1",
      name: "时序控制消息-1",
      source: expect.objectContaining({ nodeId: "es1-1" }),
      destination: expect.objectContaining({ nodeId: "es4-1" }),
      periodUs: 1_000,
      frameSizeBytes: 10,
      pcp: 7,
      jitterRequirementUs: 0.5,
      routeNodeIds: ["es1-1", "sw1", "sw3", "es4-1"],
    });
    expect(project.flows[1]).toMatchObject({
      id: "flow-video-1",
      name: "视频流-1",
      source: expect.objectContaining({ nodeId: "es1-2" }),
      destination: expect.objectContaining({ nodeId: "es4-2" }),
      periodUs: 33_333,
      frameSizeBytes: 50 * 1024,
      pcp: 5,
      routeNodeIds: ["es1-2", "sw1", "sw3", "es4-2"],
    });
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("can create a topology-only project before the flow stage", () => {
    const project = createProjectFromIntent("我需要4个交换机，每个交换机连接5个端系统", undefined, {
      includeControlFlow: false,
    });

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.flows).toHaveLength(0);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("adds requested control and video flows to an existing topology", () => {
    const topologyOnlyProject = createProjectFromIntent("我需要2个交换机，每个交换机连接3个端系统", undefined, {
      includeControlFlow: false,
    });

    const project = withFlowsFromIntent(topologyOnlyProject, "两条流，一条视频流，一条控制流");

    expect(project.flows.map((flow) => flow.id)).toEqual(["flow-control-1", "flow-video-1"]);
    expect(project.flows[0]).toMatchObject({
      numericId: 1,
      name: "控制流-1",
      source: expect.objectContaining({ nodeId: "es1-1" }),
      destination: expect.objectContaining({ nodeId: "es2-1" }),
      periodUs: 250,
      frameSizeBytes: 512,
      pcp: 6,
      routeNodeIds: ["es1-1", "sw1", "sw2", "es2-1"],
    });
    expect(project.flows[1]).toMatchObject({
      numericId: 2,
      name: "视频流-1",
      source: expect.objectContaining({ nodeId: "es1-2" }),
      destination: expect.objectContaining({ nodeId: "es2-2" }),
      periodUs: 33_333,
      frameSizeBytes: 50 * 1024,
      pcp: 5,
      routeNodeIds: ["es1-2", "sw1", "sw2", "es2-2"],
    });
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("adds best-effort traffic and multiple additional video flows incrementally", () => {
    const topologyOnlyProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统，使用环形互联", undefined, {
      includeControlFlow: false,
    });
    const initialFlows = withFlowsFromIntent(topologyOnlyProject, "我还需要一条视频流，还有一条BE流");
    const expandedFlows = withFlowsFromIntent(initialFlows, "再加3条视频流吧");

    expect(initialFlows.flows.map((flow) => flow.name)).toEqual(["视频流-1", "BE流-1"]);
    expect(initialFlows.flows.map((flow) => flow.flowType)).toEqual(["ST", "BE"]);
    expect(expandedFlows.flows.map((flow) => flow.name)).toEqual([
      "视频流-1",
      "BE流-1",
      "视频流-2",
      "视频流-3",
      "视频流-4",
    ]);
    expect(expandedFlows.flows.map((flow) => flow.numericId)).toEqual([1, 2, 3, 4, 5]);
    expect(expandedFlows.flows.filter((flow) => flow.name.startsWith("视频流-"))).toHaveLength(4);
    expect(validateCanonicalProject(expandedFlows)).toEqual({ ok: true, errors: [] });
  });

  it("can use scenario config defaults and flow template labels", () => {
    const project = createProjectFromIntent("请生成一个典型场景拓扑", undefined, {
      scenarioConfigId: "aerospace-onboard",
    });

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.topology.nodes.filter(isEndSystem)).toHaveLength(20);
    expect(project.flows[0].name).toBe("时序控制消息-1");
    expect(project.simulationHints.defaultDataRateMbps).toBe(1_000);
  });

  it("falls back to generic scenario defaults for unknown config ids", () => {
    const project = createProjectFromIntent("请生成一个默认拓扑", undefined, {
      scenarioConfigId: "unknown-config",
    });

    expect(project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(project.flows[0].name).toBe("控制流-1");
  });
});
