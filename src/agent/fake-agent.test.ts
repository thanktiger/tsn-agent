import { describe, expect, it } from "vitest";
import { runFakeTsnAgent } from "./fake-agent";
import { createProjectFromIntent } from "../domain/topology-factory";
import { isEndSystem, isSwitch } from "../domain/canonical";
import { createInitialWorkflowState } from "../project/project-state";

const DUAL_PLANE_TOPOLOGY_PROMPT = "我需要4个交换机，每个交换机连接2个端系统，双平面冗余";

describe("fake tsn agent", () => {
  it("runs only the topology stage for an initial topology request", () => {
    const result = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");

    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.bundle).toBeUndefined();
    expect(result.project.flows).toHaveLength(0);
    expect(result.events.map((event) => event.kind)).toContain("confirmation-required");
    expect(result.events.find((event) => event.kind === "tool-availability")?.content).toContain("tsn_topology available");
    expect(result.events.map((event) => event.skillName).filter(Boolean)).toEqual(["tsn-topology"]);
  });

  it("advances one stage at a time when the user confirms", () => {
    const topology = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);

    expect(timeSync.workflow.currentStep).toBe("time-sync");
    expect(timeSync.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(timeSync.bundle).toBeUndefined();
    expect(timeSync.assistantText).toContain("默认假设全网已完成时间同步");
  });

  it("uses scenario configured time sync defaults", () => {
    const topology = runFakeTsnAgent(
      "我需要4个交换机，每个交换机连接5个端系统",
      undefined,
      createInitialWorkflowState("aerospace-onboard"),
    );
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);

    expect(timeSync.assistantText).toContain("默认采用全网统一时钟假设");
    expect(timeSync.assistantText).toContain("GM 选择、同步域和从端口关系");
  });

  it("runs a dual-plane redundant topology as a topology-only stage", () => {
    const result = runFakeTsnAgent(
      DUAL_PLANE_TOPOLOGY_PROMPT,
      undefined,
      createInitialWorkflowState("aerospace-onboard"),
    );

    expect(result.workflow.currentStep).toBe("topology");
    expect(result.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(8);
    expect(result.project.topology.links).toHaveLength(18);
    expect(result.project.flows).toHaveLength(0);
    expect(result.assistantText).toContain("双平面冗余拓扑");
    expect(result.assistantText).toContain("每个交换机连接 2 个端系统");
  });

  it("updates a dual-plane topology when the user changes per-switch endpoints", () => {
    const previous = runFakeTsnAgent(
      DUAL_PLANE_TOPOLOGY_PROMPT,
      undefined,
      createInitialWorkflowState("aerospace-onboard"),
    );

    const result = runFakeTsnAgent("每个交换机改成3个端系统，保持双平面冗余", previous.project, previous.workflow);

    expect(result.workflow.currentStep).toBe("topology");
    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(result.project.topology.links).toHaveLength(26);
    expect(result.assistantText).toContain("每个交换机连接 3 个端系统");
  });

  it("confirms the final planning stage without rerunning it", () => {
    const topology = runFakeTsnAgent("我需要4个交换机，每个交换机连接5个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);
    const planning = runFakeTsnAgent("继续", flow.project, flow.workflow);

    expect(planning.workflow.currentStep).toBe("planning-export");
    expect(planning.workflow.stages["planning-export"].status).toBe("waiting_confirmation");
    expect(planning.events.map((event) => event.kind)).toContain("confirmation-required");

    const confirmed = runFakeTsnAgent("继续", planning.project, planning.workflow);

    expect(confirmed.workflow.currentStep).toBe("planning-export");
    expect(confirmed.workflow.stages["planning-export"].status).toBe("confirmed");
    expect(confirmed.events.map((event) => event.kind)).not.toContain("confirmation-required");
    expect(confirmed.bundle?.artifacts.some((artifact) => artifact.path === "simulation/inet/omnetpp.ini")).toBe(true);
    expect(confirmed.assistantText).toContain("已生成规划器输入和导出清单");
  });

  it("uses an explicit quick path when the user asks for direct generation", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("直接生成", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(9);
    expect(result.workflow.currentStep).toBe("planning-export");
    expect(result.bundle?.artifacts.some((artifact) => artifact.path === "simulation/inet/tsnagent/generated/network.ned")).toBe(true);
    expect(result.bundle?.artifacts.some((artifact) => artifact.path === "simulation/inet/omnetpp.ini")).toBe(true);
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("3 个端系统");
  });

  it("keeps existing switch count when the user only changes host count", () => {
    const previousProject = createProjectFromIntent("我需要3个交换机，每个交换机连接3个端系统");

    const result = runFakeTsnAgent("每个交换机改成4个端系统", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.assistantText).toContain("3 个交换机");
    expect(result.assistantText).toContain("4 个端系统");
  });

  it("uses the target switch count when changing topology from one count to another", () => {
    const previousProject = createProjectFromIntent("我需要2个交换机，每个交换机连接5个端系统");

    const result = runFakeTsnAgent("修改一下拓扑，从2交换机变为3交换机", previousProject);

    expect(result.project.topology.nodes.filter(isSwitch)).toHaveLength(3);
    expect(result.project.topology.nodes.filter(isEndSystem)).toHaveLength(15);
    expect(result.project.flows).toHaveLength(0);
    expect(result.workflow.currentStep).toBe("topology");
    expect(result.assistantText).toContain("3 个交换机");
  });

  it("keeps edited host count and applies ring interconnect in follow-up topology edits", () => {
    const initial = runFakeTsnAgent("我需要3个交换机，每个交换机连接5个端系统");
    const changed = runFakeTsnAgent("需要改成4台交换机，每台连接3个端", initial.project, initial.workflow);
    const ring = runFakeTsnAgent("可以使用环形互联", changed.project, changed.workflow);

    expect(changed.project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(changed.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(changed.project.topology.links).toHaveLength(15);
    expect(changed.project.flows).toHaveLength(0);
    expect(changed.assistantText).toContain("4 个交换机");
    expect(changed.assistantText).toContain("3 个端系统");

    expect(ring.project.topology.nodes.filter(isSwitch)).toHaveLength(4);
    expect(ring.project.topology.nodes.filter(isEndSystem)).toHaveLength(12);
    expect(ring.project.topology.links).toHaveLength(16);
    expect(ring.project.topology.links.some((link) => link.source.nodeId === "sw4" && link.target.nodeId === "sw1")).toBe(true);
    expect(ring.project.flows).toHaveLength(0);
    expect(ring.workflow.currentStep).toBe("topology");
    expect(ring.workflow.stages.topology.status).toBe("waiting_confirmation");
    expect(ring.assistantText).toContain("环形互联");
  });

  it("confirms topology with affirmative natural language that is not a topology edit", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接5个端系统");

    const timeSync = runFakeTsnAgent("可以，继续", topology.project, topology.workflow);

    expect(timeSync.workflow.currentStep).toBe("time-sync");
    expect(timeSync.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
  });

  it("can advance to time sync with natural language stage intent", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接5个端系统");

    const timeSync = runFakeTsnAgent("开始做时间同步", topology.project, topology.workflow);

    expect(timeSync.workflow.currentStep).toBe("time-sync");
    expect(timeSync.workflow.stages["time-sync"].status).toBe("waiting_confirmation");
    expect(timeSync.project.flows).toHaveLength(0);
  });

  it("creates the control flow only in the flow template stage", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接5个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);

    expect(flow.workflow.currentStep).toBe("flow-template");
    expect(flow.workflow.stages["flow-template"].status).toBe("waiting_confirmation");
    expect(flow.project.flows).toHaveLength(1);
    expect(flow.project.flows[0].routeNodeIds).toEqual(["es1-1", "sw1", "sw2", "es2-1"]);
  });

  it("creates scenario control flow only after topology and time sync confirmation", () => {
    const topology = runFakeTsnAgent(
      DUAL_PLANE_TOPOLOGY_PROMPT,
      undefined,
      createInitialWorkflowState("aerospace-onboard"),
    );
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);

    expect(topology.project.flows).toHaveLength(0);
    expect(timeSync.project.flows).toHaveLength(0);
    expect(flow.workflow.currentStep).toBe("flow-template");
    expect(flow.project.flows.map((candidate) => candidate.name)).toEqual(["时序控制消息-1"]);
    expect(flow.project.flows[0].routeNodeIds).toEqual(["es1-1", "sw1", "sw3", "es4-1"]);
  });

  it("keeps user-declared video flow when it is mentioned before the flow stage", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接3个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const captured = runFakeTsnAgent("两条流，一条视频流，一条控制流", timeSync.project, timeSync.workflow);
    const flow = runFakeTsnAgent("继续", captured.project, captured.workflow);
    const planning = runFakeTsnAgent("继续", flow.project, flow.workflow);
    const flowPlan = planning.bundle?.artifacts.find((artifact) => artifact.path === "planner/flow_plan_1.json");

    expect(captured.workflow.currentStep).toBe("time-sync");
    expect(captured.project.flows.map((candidate) => candidate.name)).toEqual(["控制流-1", "视频流-1"]);
    expect(captured.assistantText).toContain("当前仍先完成时间同步确认");
    expect(flow.workflow.currentStep).toBe("flow-template");
    expect(flow.assistantText).toContain("已准备 2 条流");
    expect(flow.assistantText).toContain("视频流-1");
    expect(planning.project.flows).toHaveLength(2);
    expect(flowPlan?.content).toContain('"sendData"');
    expect(flowPlan?.content).toContain('"stream_id": 2');
    expect(flowPlan?.content).toContain('"size": 51200');
  });

  it("does not treat closed-loop control flow text as a topology ring edit", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接24个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);

    const captured = runFakeTsnAgent(
      "添加三条流，（1）时间敏感流（ST）：如传感器-控制器-执行器的闭环控制流；（2）带宽保证流（AVB）：监控视频流；（3）尽力而为流（BE）。",
      flow.project,
      flow.workflow,
    );

    expect(captured.workflow.currentStep).toBe("flow-template");
    expect(captured.workflow.stages.topology.status).toBe("confirmed");
    expect(captured.project.topology.links.some((link) => link.source.nodeId === "sw2" && link.target.nodeId === "sw1")).toBe(false);
    expect(captured.project.flows.map((candidate) => candidate.name)).toContain("视频流-1");
  });

  it("keeps additional flow requests while waiting in the flow planning stage", () => {
    const topology = runFakeTsnAgent("我需要3个交换机，每个交换机连接3个端系统，使用环形互联");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);
    const mixedFlows = runFakeTsnAgent("我还需要一条视频流，还有一条BE流", flow.project, flow.workflow);
    const moreVideo = runFakeTsnAgent("再加3条视频流吧", mixedFlows.project, mixedFlows.workflow);

    expect(mixedFlows.workflow.currentStep).toBe("flow-template");
    expect(mixedFlows.project.flows.map((candidate) => candidate.name)).toEqual(["控制流-1", "视频流-1", "BE流-1"]);
    expect(moreVideo.project.flows.map((candidate) => candidate.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "BE流-1",
      "视频流-2",
      "视频流-3",
      "视频流-4",
    ]);
    expect(moreVideo.assistantText).toContain("已准备 6 条流");
    expect(moreVideo.assistantText).toContain("视频流-4");
    expect(moreVideo.assistantText).toContain("BE流-1");
  });

  it("does not advance to simulation when the user describes more flow requirements", () => {
    const topology = runFakeTsnAgent(DUAL_PLANE_TOPOLOGY_PROMPT);
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);

    const updatedFlow = runFakeTsnAgent(
      "基于箭载TSN流量特征做流量规划：生成时序控制消息，周期1ms；生成心跳消息，周期20ms；同时预留视频流。",
      flow.project,
      flow.workflow,
    );

    expect(updatedFlow.workflow.currentStep).toBe("flow-template");
    expect(updatedFlow.workflow.stages["flow-template"].status).toBe("waiting_confirmation");
    expect(updatedFlow.bundle).toBeUndefined();
    expect(updatedFlow.project.flows.map((candidate) => candidate.name)).toContain("视频流-1");
  });

  it("does not pretend to run simulation work that is not implemented", () => {
    const topology = runFakeTsnAgent("我需要2个交换机，每个交换机连接3个端系统");
    const timeSync = runFakeTsnAgent("继续", topology.project, topology.workflow);
    const flow = runFakeTsnAgent("继续", timeSync.project, timeSync.workflow);
    const planning = runFakeTsnAgent("继续", flow.project, flow.workflow);

    const result = runFakeTsnAgent("启动仿真", planning.project, planning.workflow);

    expect(result.workflow.currentStep).toBe("planning-export");
    expect(result.assistantText).toContain("还没有接入 OMNeT++/远程服务器仿真 runner");
    expect(result.assistantText).toContain("不会在后台启动仿真");
    expect(result.events.some((event) => event.title === "仿真未执行")).toBe(true);
  });
});
