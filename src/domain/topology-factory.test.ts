import { describe, expect, it } from "vitest";
import {
  createAerospaceRedundantTopologyProject,
  createProjectFromIntent,
  parseTopologyIntent,
  withDefaultControlFlow,
  withFlowsFromIntent,
} from "./topology-factory";
import { isEndSystem, isSwitch } from "./canonical";
import { validateCanonicalProject } from "./validation";

const AEROSPACE_TOPOLOGY_PROMPT = [
  "基于箭载TSN技术规范创建图示拓扑：采用双冗余链路和两组系统交换机。",
  "创建4台交换机和7个网卡，交换机1、交换机2为左侧系统交换机，交换机3、交换机4为右侧系统交换机。",
  "网卡1、网卡2、网卡3、网卡4、网卡5分别双归属连接交换机1和交换机2；网卡6、网卡7分别双归属连接交换机3和交换机4。",
  "主干链路为交换机1连接交换机3、交换机2连接交换机4，2台系统交换机为独立单机，不相互级联，链路速率不小于1000Mbps。",
].join("");

const AEROSPACE_FLOW_PROMPT = [
  "基于箭载TSN流量特征做流量规划：",
  "生成时序控制消息，周期1ms，需要同步，延迟约束，不允许丢包，8-10字节，高关键性；",
  "生成心跳消息，周期20ms，需要同步，延迟约束，不允许丢包，8-10字节，高关键性；",
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
    expect(project.flows[0].routeLinkIds).toEqual(["link-0", "link-12", "link-13", "link-14", "link-9"]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("parses the aerospace redundant topology prompt derived from the rocket TSN spec", () => {
    expect(parseTopologyIntent(AEROSPACE_TOPOLOGY_PROMPT, undefined, {
      scenarioConfigId: "aerospace-onboard",
    })).toEqual({
      switchCount: 4,
      endSystemsPerSwitch: 0,
      switchInterconnect: "line",
      topologyTemplate: "aerospace-redundant",
      endSystemCount: 7,
    });
  });

  it("creates the pictured aerospace redundant topology before the flow stage", () => {
    const project = createProjectFromIntent(AEROSPACE_TOPOLOGY_PROMPT, undefined, {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });

    expect(project.topology.nodes.filter(isSwitch).map((node) => node.name)).toEqual([
      "交换机1",
      "交换机2",
      "交换机3",
      "交换机4",
    ]);
    expect(project.topology.nodes.filter(isEndSystem).map((node) => node.name)).toEqual([
      "网卡1",
      "网卡2",
      "网卡3",
      "网卡4",
      "网卡5",
      "网卡6",
      "网卡7",
    ]);
    expect(project.topology.links).toHaveLength(16);
    expect(project.flows).toHaveLength(0);
    expect(project.topology.links.map((link) => [link.source.nodeId, link.target.nodeId])).toEqual([
      ["nic1", "sw1"],
      ["nic1", "sw2"],
      ["nic2", "sw1"],
      ["nic2", "sw2"],
      ["nic3", "sw1"],
      ["nic3", "sw2"],
      ["sw1", "nic4"],
      ["sw2", "nic4"],
      ["sw1", "nic5"],
      ["sw2", "nic5"],
      ["sw1", "sw3"],
      ["sw2", "sw4"],
      ["sw3", "nic6"],
      ["sw4", "nic6"],
      ["sw3", "nic7"],
      ["sw4", "nic7"],
    ]);
    expect(validateCanonicalProject(project)).toEqual({ ok: true, errors: [] });
  });

  it("adds aerospace control and heartbeat flows from the rocket TSN flow prompt", () => {
    const topologyOnlyProject = createAerospaceRedundantTopologyProject("箭载双冗余拓扑", {
      scenarioConfigId: "aerospace-onboard",
      includeControlFlow: false,
    });

    const project = withFlowsFromIntent(topologyOnlyProject, AEROSPACE_FLOW_PROMPT, {
      scenarioConfigId: "aerospace-onboard",
    });

    expect(project.flows.map((flow) => flow.name)).toEqual(["时序控制消息-1", "心跳消息-1", "视频流-1"]);
    expect(withDefaultControlFlow(project, {
      scenarioConfigId: "aerospace-onboard",
    }).flows.map((flow) => flow.name)).toEqual(["时序控制消息-1", "心跳消息-1", "视频流-1"]);
    expect(project.flows[0]).toMatchObject({
      id: "flow-control-1",
      name: "时序控制消息-1",
      source: expect.objectContaining({ nodeId: "nic1", ipAddress: "10.10.0.1" }),
      destination: expect.objectContaining({ nodeId: "nic7", ipAddress: "10.10.0.7" }),
      periodUs: 1_000,
      frameSizeBytes: 10,
      pcp: 7,
      jitterRequirementUs: 0.5,
      routeNodeIds: ["nic1", "sw1", "sw3", "nic7"],
    });
    expect(project.flows[1]).toMatchObject({
      id: "flow-heartbeat-1",
      name: "心跳消息-1",
      source: expect.objectContaining({ nodeId: "nic2" }),
      destination: expect.objectContaining({ nodeId: "nic6" }),
      periodUs: 20_000,
      frameSizeBytes: 10,
      pcp: 6,
      routeNodeIds: ["nic2", "sw2", "sw4", "nic6"],
    });
    expect(project.flows[2]).toMatchObject({
      id: "flow-video-1",
      name: "视频流-1",
      source: expect.objectContaining({ nodeId: "nic5" }),
      destination: expect.objectContaining({ nodeId: "nic6" }),
      periodUs: 33_333,
      frameSizeBytes: 1_500,
      pcp: 4,
      routeNodeIds: ["nic5", "sw2", "sw4", "nic6"],
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
