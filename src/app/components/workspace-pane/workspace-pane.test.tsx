import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

const flowMocks = vi.hoisted(() => ({
  fitView: vi.fn(),
  setCenter: vi.fn(async () => true),
  internalNodes: new Map<string, unknown>(),
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  BaseEdge: ({
    id,
    path,
    interactionWidth,
  }: {
    id?: string;
    path: string;
    interactionWidth?: number;
  }) => (
    <span
      data-testid={`base-edge-${id ?? "edge"}`}
      data-path={path}
      data-interaction-width={String(interactionWidth)}
    />
  ),
  EdgeLabelRenderer: ({ children }: { children?: unknown }) => children ?? null,
  getBezierPath: () => ["M0 0", 0, 0],
  useInternalNode: (id: string) => flowMocks.internalNodes.get(id),
  applyNodeChanges: (_changes: unknown[], nodes: Array<{ id: string }>) => nodes,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  ReactFlow: (props: {
    nodes: Array<{ id: string; position: { x: number; y: number } }>;
    edges: Array<{ id: string }>;
    nodesDraggable?: boolean;
    selectionOnDrag?: boolean;
    multiSelectionKeyCode?: string | null;
    fitView?: boolean;
    onInit?: (instance: {
      fitView: () => void;
      setCenter: (x: number, y: number, options?: unknown) => Promise<boolean>;
    }) => void;
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onEdgeClick?: (event: unknown, edge: { id: string }) => void;
    onNodeDragStart?: (event: unknown, node: unknown) => void;
    onNodeDragStop?: (event: unknown, node: unknown) => void;
    onPaneClick?: (event: unknown) => void;
  }) => {
    const { nodes, edges, onNodeClick, onEdgeClick, onNodeDragStart, onNodeDragStop } = props;
    // 真实 ReactFlow 仅在挂载后调 onInit 一次；mock 每次渲染都调——
    // 让「每个拓扑版本只重置一次视口」的守卫断言更严格。
    props.onInit?.({ fitView: flowMocks.fitView, setCenter: flowMocks.setCenter });
    return (
      <div
        data-testid="rf-mock"
        data-nodes-draggable={String(props.nodesDraggable)}
        data-selection-on-drag={String(props.selectionOnDrag)}
        data-multi-selection-key={String(props.multiSelectionKeyCode)}
        data-has-fitview-prop={String(props.fitView !== undefined)}
      >
        {nodes.length} nodes / {edges.length} edges
        {nodes.map((node) => (
          <span key={`pos-${node.id}`} data-testid={`node-pos-${node.id}`}>
            {node.position.x},{node.position.y}
          </span>
        ))}
        {nodes.map((node) => (
          <button key={node.id} type="button" onClick={() => onNodeClick?.({}, node)}>
            选择节点 {node.id}
          </button>
        ))}
        {nodes.map((node) => (
          <button
            key={`drag-${node.id}`}
            type="button"
            onClick={() => {
              onNodeDragStart?.({}, node);
              onNodeDragStop?.({}, { ...node, position: { x: 480.4, y: 95.6 } });
            }}
          >
            拖毕节点 {node.id}
          </button>
        ))}
        {nodes.map((node) => (
          <button
            key={`start-${node.id}`}
            type="button"
            onClick={() => onNodeDragStart?.({}, node)}
          >
            拖起节点 {node.id}
          </button>
        ))}
        {nodes.map((node) => (
          <button
            key={`stop-${node.id}`}
            type="button"
            onClick={() => onNodeDragStop?.({}, { ...node, position: { x: 480.4, y: 95.6 } })}
          >
            放下节点 {node.id}
          </button>
        ))}
        {edges.map((edge) => (
          <button key={edge.id} type="button" onClick={() => onEdgeClick?.({}, edge)}>
            选择链路 {edge.id}
          </button>
        ))}
        <button type="button" onClick={() => props.onPaneClick?.({})}>
          点击画布空白
        </button>
      </div>
    );
  },
}));

import type { TimesyncSnapshot } from "../../../sessions/timesync-snapshot";
import type { TopologyNodeRow, TopologyRowSnapshot } from "../../../sessions/topology-snapshot";
import {
  nodeRowLabel,
  nodeTypeToken,
  parseLinkStyles,
  planeClassName,
  type TsnEdgeData,
  timesyncRoleBadge,
  topologySnapshotToReactFlow,
  WorkspacePane,
  type WorkspacePaneProps,
} from "./index";
import {
  floatingEdgeAnchors,
  parallelFloatingEdgeAnchors,
  portLabelPoint,
  straightFloatingEdgePath,
  TsnFloatingEdge,
} from "./tsn-floating-edge";

function sampleSnapshot(): TopologyRowSnapshot {
  return {
    sessionId: "s1",
    nodes: [
      { mid: "1", name: null, x: 0, y: 0, nodeType: "switch", insertOrder: 0 },
      { mid: "2", name: null, x: 160, y: 0, nodeType: null, insertOrder: 1 },
    ],
    links: [{ linkSeq: 0, name: "uplink", srcNode: "1", dstNode: "2", stylesJson: "{}" }],
  };
}

function baseProps(overrides: Partial<WorkspacePaneProps> = {}): WorkspacePaneProps {
  return {
    topologySnapshot: undefined,
    selectedTopologyItem: undefined,
    activeConfigTab: "node-detail",
    isAgentRunning: false,
    hasUserInteraction: false,
    lastMutationId: 0,
    onSelectConfigTab: vi.fn(),
    onNodeSelect: vi.fn(),
    onLinkSelect: vi.fn(),
    onClearSelection: vi.fn(),
    onRefreshTopology: vi.fn(),
    commitNodePosition: vi.fn(async () => ({ mutationId: 1 })),
    ...overrides,
  };
}

describe("WorkspacePane", () => {
  it("shows the empty prompt before any interaction", () => {
    render(<WorkspacePane {...baseProps()} />);
    expect(screen.getByText("描述你的 TSN 需求后生成拓扑图")).toBeInTheDocument();
  });

  it("renders the canvas and topology stats when a snapshot is present", () => {
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />);
    expect(screen.getByText("2 nodes / 1 edges")).toBeInTheDocument();
    const stats = screen.getByLabelText("拓扑统计");
    expect(stats).toHaveTextContent("交换机");
    expect(stats).toHaveTextContent("链路");
  });

  it("calls onNodeSelect when a node is clicked on the canvas", async () => {
    const user = userEvent.setup();
    const onNodeSelect = vi.fn();
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), onNodeSelect })} />);
    await user.click(screen.getByRole("button", { name: "选择节点 1" }));
    expect(onNodeSelect).toHaveBeenCalled();
  });

  it("renders node detail for the selected node", () => {
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "1" },
        })}
      />,
    );
    const panel = screen.getByRole("tabpanel", { name: "节点详情" });
    expect(within(panel).getByText("SW-1")).toBeInTheDocument();
    expect(within(panel).getByText("交换机")).toBeInTheDocument();
  });

  it("calls onSelectConfigTab when a config tab is clicked", async () => {
    const user = userEvent.setup();
    const onSelectConfigTab = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "1" },
          onSelectConfigTab,
        })}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "链路详情" }));
    expect(onSelectConfigTab).toHaveBeenCalledWith("link-detail");
  });
});

describe("WorkspacePane 详情面板显隐", () => {
  it("无选中时详情面板默认隐藏", () => {
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />);
    expect(screen.queryByRole("tablist", { name: "工程详情" })).not.toBeInTheDocument();
  });

  it("点击画布空白触发清除选中", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "1" },
          onClearSelection,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "点击画布空白" }));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it("关闭按钮触发清除选中", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "1" },
          onClearSelection,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(onClearSelection).toHaveBeenCalled();
  });
});

describe("WorkspacePane 拖动持久化（U4）", () => {
  it("Covers AE2：拖毕以整数坐标 + 拖动起始 mutationId 调用写入，并选中该节点", async () => {
    const user = userEvent.setup();
    const commitNodePosition = vi.fn(async () => ({ mutationId: 8 }));
    const onNodeSelect = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          lastMutationId: 7,
          commitNodePosition,
          onNodeSelect,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    await waitFor(() => expect(commitNodePosition).toHaveBeenCalledTimes(1));
    expect(commitNodePosition).toHaveBeenCalledWith({
      sessionId: "s1",
      mid: "2",
      x: 480,
      y: 96,
      expectedMutationId: 7,
    });
    expect(onNodeSelect).toHaveBeenCalled();
  });

  it("Covers AE5：写入失败 → 触发快照回正并显示可见提示", async () => {
    const user = userEvent.setup();
    const commitNodePosition = vi.fn(async () => {
      throw new Error("stale");
    });
    const onRefreshTopology = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          commitNodePosition,
          onRefreshTopology,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    await waitFor(() => expect(onRefreshTopology).toHaveBeenCalled());
    expect(screen.getByRole("alert")).toHaveTextContent("位置保存失败，已恢复");
  });

  it("R9：拖毕后详情面板坐标经 overlay 即时显示新值（写入确认前）", async () => {
    const user = userEvent.setup();
    // 快照不刷新——overlay 应当独立支撑显示。
    const commitNodePosition = vi.fn(async () => ({ mutationId: 2 }));
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          selectedTopologyItem: { kind: "node", id: "2" },
          commitNodePosition,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    const panel = screen.getByRole("tabpanel", { name: "节点详情" });
    await waitFor(() => expect(within(panel).getByText("480, 96")).toBeInTheDocument());
  });

  it("R7：拖动中到达的快照先缓存，拖毕后应用且拖动节点被 overlay 保护", async () => {
    const user = userEvent.setup();
    const commitNodePosition = vi.fn(async () => ({ mutationId: 3 }));
    const { rerender } = render(
      <WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), commitNodePosition })} />,
    );
    await user.click(screen.getByRole("button", { name: "拖起节点 2" }));

    // 拖动中到达新快照：本地位置不被立即覆盖
    const moved = sampleSnapshot();
    moved.nodes = [
      { ...moved.nodes[0], x: 50, y: 60 },
      { ...moved.nodes[1], x: 999, y: 999 },
    ];
    rerender(<WorkspacePane {...baseProps({ topologySnapshot: moved, commitNodePosition })} />);
    expect(screen.getByTestId("node-pos-2")).toHaveTextContent("160,0");
    expect(screen.getByTestId("node-pos-1")).toHaveTextContent("0,0");

    // 拖毕：缓存快照应用（节点 1 用新坐标），拖动节点保持拖后坐标
    await user.click(screen.getByRole("button", { name: "放下节点 2" }));
    expect(screen.getByTestId("node-pos-1")).toHaveTextContent("50,60");
    expect(screen.getByTestId("node-pos-2")).toHaveTextContent("480,96");
  });

  it("覆写释放：写入确认后出现更新 mutation（agent 移动同节点），overlay 不钉死旧坐标", async () => {
    const user = userEvent.setup();
    const commitNodePosition = vi.fn(async () => ({ mutationId: 5 }));
    const { rerender } = render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          lastMutationId: 4,
          commitNodePosition,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    await waitFor(() => expect(commitNodePosition).toHaveBeenCalled());

    // agent 覆写节点 2 → mutationId 推进到 6，快照坐标 (300, 200)
    const overwritten = sampleSnapshot();
    overwritten.nodes = [overwritten.nodes[0], { ...overwritten.nodes[1], x: 300, y: 200 }];
    rerender(
      <WorkspacePane
        {...baseProps({ topologySnapshot: overwritten, lastMutationId: 6, commitNodePosition })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("node-pos-2")).toHaveTextContent("300,200"));
  });

  it("本地拖动位置写入返回的 mutation 刷新快照时，不重置画布视口", async () => {
    flowMocks.setCenter.mockClear();
    const user = userEvent.setup();
    const commitNodePosition = vi.fn(async () => ({ mutationId: 5 }));
    const { rerender } = render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          lastMutationId: 4,
          commitNodePosition,
        })}
      />,
    );
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    await waitFor(() => expect(commitNodePosition).toHaveBeenCalled());

    const confirmed = sampleSnapshot();
    confirmed.nodes = [confirmed.nodes[0], { ...confirmed.nodes[1], x: 480, y: 96 }];
    rerender(
      <WorkspacePane
        {...baseProps({ topologySnapshot: confirmed, lastMutationId: 5, commitNodePosition })}
      />,
    );
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(1);
  });

  it("session 切换：overlay/拖动状态全部重置，不污染新 session 同 imac 节点", async () => {
    const user = userEvent.setup();
    // commit 永不 resolve：overlay 停留在未确认状态
    const commitNodePosition = vi.fn(() => new Promise<{ mutationId: number }>(() => {}));
    const { rerender } = render(
      <WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), commitNodePosition })} />,
    );
    await user.click(screen.getByRole("button", { name: "拖毕节点 2" }));
    expect(screen.getByTestId("node-pos-2")).toHaveTextContent("480,96");

    // 切换 session（经 undefined 过渡），新 session 同 imac 节点在 (10, 20)
    rerender(<WorkspacePane {...baseProps({ commitNodePosition })} />);
    const s2 = sampleSnapshot();
    s2.sessionId = "s2";
    s2.nodes = [s2.nodes[0], { ...s2.nodes[1], x: 10, y: 20 }];
    rerender(<WorkspacePane {...baseProps({ topologySnapshot: s2, commitNodePosition })} />);
    expect(screen.getByTestId("node-pos-2")).toHaveTextContent("10,20");
  });

  it("连续快速拖动两个节点：两条 overlay 同时存活（无闭包覆盖丢失）", () => {
    const commitNodePosition = vi.fn(() => new Promise<{ mutationId: number }>(() => {}));
    const { rerender } = render(
      <WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), commitNodePosition })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "拖毕节点 1" }));
    fireEvent.click(screen.getByRole("button", { name: "拖毕节点 2" }));

    // 新快照到达（原坐标）：两个节点都保持拖动后坐标
    rerender(
      <WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), commitNodePosition })} />,
    );
    expect(screen.getByTestId("node-pos-1")).toHaveTextContent("480,96");
    expect(screen.getByTestId("node-pos-2")).toHaveTextContent("480,96");
  });
});

describe("WorkspacePane 撤销按钮（U8）", () => {
  it("点撤销调 undo_topology 并在成功后 refetch + 置回退通知标志", async () => {
    const user = userEvent.setup();
    const undoTopology = vi.fn(async () => ({ undone: true }));
    const onRefreshTopology = vi.fn();
    const onUndone = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: sampleSnapshot(),
          undoTopology,
          onRefreshTopology,
          onUndone,
        })}
      />,
    );
    const button = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(button); // 第一步：进入确认态
    await user.click(button); // 第二步：执行
    await waitFor(() => expect(undoTopology).toHaveBeenCalledWith("s1"));
    expect(onRefreshTopology).toHaveBeenCalled();
    expect(onUndone).toHaveBeenCalled();
  });

  it("撤销按钮内联两步：第一次点击只进入确认态不执行，第二次才撤销", async () => {
    const user = userEvent.setup();
    const undoTopology = vi.fn(async () => ({ undone: true }));
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), undoTopology })} />);
    const button = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(button);
    expect(button).toHaveTextContent("确认撤销?");
    expect(undoTopology).not.toHaveBeenCalled();
    await user.click(button);
    await waitFor(() => expect(undoTopology).toHaveBeenCalledTimes(1));
    expect(button).toHaveTextContent("撤销");
  });

  it("撤销确认态失焦自动取消", async () => {
    const user = userEvent.setup();
    const undoTopology = vi.fn(async () => ({ undone: true }));
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot(), undoTopology })} />);
    const button = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(button);
    expect(button).toHaveTextContent("确认撤销?");
    fireEvent.blur(button);
    expect(button).toHaveTextContent("撤销");
    await user.click(button); // 失焦取消后再点 = 重新进入确认态，仍未执行
    expect(undoTopology).not.toHaveBeenCalled();
  });

  it("Covers AE3：第二次撤销返回 undone:false → 非静默提示，不置标志", async () => {
    const user = userEvent.setup();
    const undoTopology = vi
      .fn()
      .mockResolvedValueOnce({ undone: true })
      .mockResolvedValueOnce({ undone: false });
    const onUndone = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({ topologySnapshot: sampleSnapshot(), undoTopology, onUndone })}
      />,
    );
    const button = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(button); // 确认
    await user.click(button); // 执行（undone:true）
    await waitFor(() => expect(onUndone).toHaveBeenCalledTimes(1));
    await user.click(button); // 再次确认
    await user.click(button); // 再次执行（undone:false）
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("没有可撤销的改动"));
    // undone:false 不再额外置标志。
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it("Covers AE5：空拓扑时撤销按钮禁用", () => {
    render(<WorkspacePane {...baseProps()} />);
    expect(screen.getByRole("button", { name: "撤销上一次结构改动" })).toBeDisabled();
  });

  it("撤销失败（command reject）给非静默提示，不置标志", async () => {
    const user = userEvent.setup();
    const undoTopology = vi.fn(async () => {
      throw new Error("boom");
    });
    const onUndone = vi.fn();
    render(
      <WorkspacePane
        {...baseProps({ topologySnapshot: sampleSnapshot(), undoTopology, onUndone })}
      />,
    );
    const button = screen.getByRole("button", { name: "撤销上一次结构改动" });
    await user.click(button); // 确认
    await user.click(button); // 执行（reject）
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("撤销失败"));
    expect(onUndone).not.toHaveBeenCalled();
  });
});

describe("WorkspacePane 画布配置与视口（R9/R12）", () => {
  it("R9：节点可拖动、禁用框选与多选（ReactFlow 配置）", () => {
    render(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />);
    const canvas = screen.getByTestId("rf-mock");
    expect(canvas).toHaveAttribute("data-nodes-draggable", "true");
    expect(canvas).toHaveAttribute("data-selection-on-drag", "false");
    expect(canvas).toHaveAttribute("data-multi-selection-key", "null");
  });

  it("R12：拓扑展示时以 100% 比例居中（onInit 单路径，无常驻 fitView prop）", () => {
    flowMocks.fitView.mockClear();
    flowMocks.setCenter.mockClear();
    const { rerender } = render(
      <WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />,
    );
    expect(screen.getByTestId("rf-mock")).toHaveAttribute("data-has-fitview-prop", "false");
    expect(flowMocks.fitView).not.toHaveBeenCalled();
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(1);
    expect(flowMocks.setCenter).toHaveBeenLastCalledWith(143, 28, { zoom: 1, duration: 0 });

    // 完全相同的拓扑版本刷新（mock 每次渲染都触发 onInit）：不重复重置视口。
    rerender(<WorkspacePane {...baseProps({ topologySnapshot: sampleSnapshot() })} />);
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(1);

    // 同 session 新拓扑/Agent 重建：重新以 100% 居中。
    const refreshed = sampleSnapshot();
    refreshed.nodes = [refreshed.nodes[0], { ...refreshed.nodes[1], x: 300, y: 300 }];
    rerender(<WorkspacePane {...baseProps({ topologySnapshot: refreshed })} />);
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(2);
    expect(flowMocks.setCenter).toHaveBeenLastCalledWith(213, 178, { zoom: 1, duration: 0 });

    // session 切换（经 undefined 过渡 → 重挂载）：再居中一次。
    rerender(<WorkspacePane {...baseProps()} />);
    const s2 = sampleSnapshot();
    s2.sessionId = "s2";
    rerender(<WorkspacePane {...baseProps({ topologySnapshot: s2 })} />);
    expect(flowMocks.setCenter).toHaveBeenCalledTimes(3);
    expect(flowMocks.setCenter).toHaveBeenLastCalledWith(143, 28, { zoom: 1, duration: 0 });
  });
});

describe("nodeRowLabel", () => {
  function nodeRow(overrides: Partial<TopologyNodeRow> = {}): TopologyNodeRow {
    return {
      mid: "2",
      name: null,
      x: 0,
      y: 0,
      nodeType: "endSystem",
      insertOrder: 2,
      ...overrides,
    };
  }

  it("画布标签优先用逻辑名，与 agent 对话命名一致", () => {
    expect(nodeRowLabel(nodeRow({ name: "ES-1" }))).toBe("ES-1");
    expect(nodeRowLabel(nodeRow({ name: "SW-1", nodeType: "switch", mid: "0" }))).toBe("SW-1");
  });

  it("逻辑名缺失（增量节点/历史数据）回退「前缀-同步名」派生", () => {
    expect(nodeRowLabel(nodeRow())).toBe("ES-2");
    expect(nodeRowLabel(nodeRow({ nodeType: "switch", mid: "0" }))).toBe("SW-0");
    expect(nodeRowLabel(nodeRow({ nodeType: "controller", mid: "9" }))).toBe("CTRL-9");
  });
});

describe("nodeTypeToken（节点类型视觉系统）", () => {
  it("switch/controller 原值映射，未知与缺失回退端系统", () => {
    expect(nodeTypeToken("switch")).toBe("switch");
    expect(nodeTypeToken("controller")).toBe("controller");
    expect(nodeTypeToken("endSystem")).toBe("endSystem");
    expect(nodeTypeToken(null)).toBe("endSystem");
    expect(nodeTypeToken("unknown-future-kind")).toBe("endSystem");
  });
});

describe("parseLinkStyles（R7 容错）", () => {
  it("解析 plane 与端口标签", () => {
    expect(
      parseLinkStyles('{"plane":"A","leftLabel":"P0","rightLabel":"P1","speed":1000}'),
    ).toEqual({
      plane: "A",
      leftLabel: "P0",
      rightLabel: "P1",
    });
  });

  it("缺失/非法 plane、非 JSON、非对象一律回退空 meta 不抛错", () => {
    expect(parseLinkStyles("{}")).toEqual({});
    expect(parseLinkStyles('{"plane":"C"}')).toEqual({});
    expect(parseLinkStyles('{"plane":1}')).toEqual({});
    expect(parseLinkStyles("not-json")).toEqual({});
    expect(parseLinkStyles("[1,2]")).toEqual({});
    expect(parseLinkStyles("null")).toEqual({});
  });

  it("存量 p1 标签原值透传（AE4：不映射、不过滤）", () => {
    expect(parseLinkStyles('{"leftLabel":"p1","rightLabel":"p2"}')).toEqual({
      leftLabel: "p1",
      rightLabel: "p2",
    });
  });

  it("空字符串标签按缺失处理（不渲染空标签）", () => {
    expect(parseLinkStyles('{"leftLabel":"","rightLabel":""}')).toEqual({});
  });
});

describe("planeClassName（R3）", () => {
  it("三态 className", () => {
    expect(planeClassName("A")).toBe("plane-a");
    expect(planeClassName("B")).toBe("plane-b");
    expect(planeClassName(undefined)).toBe("plane-neutral");
  });
});

describe("topologySnapshotToReactFlow（U3 映射）", () => {
  function node(id: number, x: number, y: number): TopologyNodeRow {
    return {
      mid: String(id),
      name: null,
      x,
      y,
      nodeType: id < 10 ? "switch" : "endSystem",
      insertOrder: id,
    };
  }

  it("Covers AE1/AE4：floating 边无 handle 绑定、className 三态、存量 p1 标签透传", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60)],
      links: [
        {
          linkSeq: 0,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"plane":"A","leftLabel":"P0","rightLabel":"P0"}',
        },
        {
          linkSeq: 1,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"leftLabel":"p1","rightLabel":"p2"}',
        },
        { linkSeq: 2, name: null, srcNode: "10", dstNode: "1", stylesJson: "broken" },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    expect(edges.map((e) => e.className)).toEqual(["plane-a", "plane-neutral", "plane-neutral"]);
    expect(edges.every((e) => e.type === "tsnFloating")).toBe(true);
    expect(edges.every((e) => e.sourceHandle === undefined && e.targetHandle === undefined)).toBe(
      true,
    );
    const legacy = edges[1].data as TsnEdgeData;
    expect(legacy.leftLabel).toBe("p1");
    expect(legacy.rightLabel).toBe("p2");
  });

  it("同节点同方位的标签序数递增，无标签端不占槽（标签防撞分层）", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60)],
      links: [
        {
          linkSeq: 0,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"leftLabel":"P0","rightLabel":"P0"}',
        },
        {
          linkSeq: 1,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"leftLabel":"P1","rightLabel":"P1"}',
        },
        { linkSeq: 2, name: null, srcNode: "10", dstNode: "1", stylesJson: "broken" },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    const [d0, d1, d2] = edges.map((e) => e.data as TsnEdgeData);
    expect([d0.leftOrd, d0.rightOrd]).toEqual([0, 0]);
    expect([d1.leftOrd, d1.rightOrd]).toEqual([1, 1]);
    expect([d2.leftOrd, d2.rightOrd]).toEqual([0, 0]);
  });

  it("同一对节点之间多条边记录等分序号，避免画布连线完全重合", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60)],
      links: [
        {
          linkSeq: 0,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"leftLabel":"P0","rightLabel":"P0"}',
        },
        {
          linkSeq: 1,
          name: null,
          srcNode: "10",
          dstNode: "1",
          stylesJson: '{"leftLabel":"P1","rightLabel":"P1"}',
        },
        {
          linkSeq: 2,
          name: null,
          srcNode: "2",
          dstNode: "3",
          stylesJson: "{}",
        },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    const [first, second, single] = edges.map((e) => e.data as TsnEdgeData);
    expect([first.parallelIndex, first.parallelCount]).toEqual([0, 2]);
    expect([second.parallelIndex, second.parallelCount]).toEqual([1, 2]);
    expect([single.parallelIndex, single.parallelCount]).toEqual([0, 1]);
  });

  it("方向相反的同节点对也按同一组平行边分开", () => {
    const snapshot: TopologyRowSnapshot = {
      sessionId: "s1",
      nodes: [node(1, 120, 300), node(10, 90, 60)],
      links: [
        { linkSeq: 0, name: null, srcNode: "10", dstNode: "1", stylesJson: "{}" },
        { linkSeq: 1, name: null, srcNode: "1", dstNode: "10", stylesJson: "{}" },
      ],
    };
    const { edges } = topologySnapshotToReactFlow(snapshot);
    expect(
      edges.map((e) => [
        (e.data as TsnEdgeData).parallelIndex,
        (e.data as TsnEdgeData).parallelCount,
      ]),
    ).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });
});

describe("floatingEdgeAnchors（U3 交点纯函数）", () => {
  const rect = (x: number, y: number, width = 126, height = 56) => ({ x, y, width, height });

  it("水平相邻节点：交点落在相对的左右边框上", () => {
    const source = rect(0, 0);
    const target = rect(400, 0);
    const anchors = floatingEdgeAnchors(source, target);
    expect(anchors.sx).toBeCloseTo(126);
    expect(anchors.sourcePosition).toBe("right");
    expect(anchors.tx).toBeCloseTo(400);
    expect(anchors.targetPosition).toBe("left");
    expect(anchors.sy).toBeCloseTo(28);
    expect(anchors.ty).toBeCloseTo(28);
  });

  it("垂直相邻节点：交点落在上下边框上", () => {
    const source = rect(0, 0);
    const target = rect(0, 300);
    const anchors = floatingEdgeAnchors(source, target);
    expect(anchors.sx).toBeCloseTo(63);
    expect(anchors.tx).toBeCloseTo(63);
    expect(anchors.sy).toBeCloseTo(56);
    expect(anchors.sourcePosition).toBe("bottom");
    expect(anchors.ty).toBeCloseTo(300);
    expect(anchors.targetPosition).toBe("top");
  });

  it("上下节点宽度不同且近似对齐时，端点吸到同一条垂直线", () => {
    const source = rect(100, 0, 100, 56);
    const target = rect(80, 180, 140, 56);
    const anchors = floatingEdgeAnchors(source, target);
    expect(anchors.sx).toBeCloseTo(150);
    expect(anchors.tx).toBeCloseTo(150);
    expect(anchors.sy).toBeCloseTo(56);
    expect(anchors.ty).toBeCloseTo(180);
    expect(straightFloatingEdgePath(anchors)).toBe("M 150,56 L 150,180");
  });

  it("对角节点：交点仍在节点边框范围内", () => {
    const source = rect(0, 0);
    const target = rect(400, 300);
    const anchors = floatingEdgeAnchors(source, target);
    expect(anchors.sx).not.toBeCloseTo(anchors.tx);
    expect(anchors.sx).toBeGreaterThanOrEqual(0);
    expect(anchors.sx).toBeLessThanOrEqual(126);
    expect(anchors.sy).toBeGreaterThanOrEqual(0);
    expect(anchors.sy).toBeLessThanOrEqual(56);
  });

  it("Covers AE4 退化：中心重合时返回有限坐标（中心直连兜底，不产 NaN）", () => {
    const a = rect(100, 100);
    const b = rect(100, 100);
    const anchors = floatingEdgeAnchors(a, b);
    for (const value of [anchors.sx, anchors.sy, anchors.tx, anchors.ty]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("floating edge 使用两端吸附点之间的直线路径", () => {
    const path = straightFloatingEdgePath({ sx: 126, sy: 28, tx: 400, ty: 28 });
    expect(path).toBe("M 126,28 L 400,28");
  });

  it("平行连线端点按节点边长等分，路径仍保持直线", () => {
    const source = rect(0, 0);
    const target = rect(400, 0);
    const first = parallelFloatingEdgeAnchors(source, target, 0, 2);
    const second = parallelFloatingEdgeAnchors(source, target, 1, 2);
    expect(first).toMatchObject({ sx: 126, sy: 14, tx: 400, ty: 14 });
    expect(second).toMatchObject({ sx: 126, sy: 42, tx: 400, ty: 42 });
    expect(straightFloatingEdgePath(first)).toBe("M 126,14 L 400,14");
    expect(straightFloatingEdgePath(second)).toBe("M 126,42 L 400,42");
  });

  it("自定义连线点击区域接近视觉线宽，避免密集连线互相遮挡", () => {
    flowMocks.internalNodes.set("1", {
      internals: { positionAbsolute: { x: 0, y: 0 } },
      measured: { width: 126, height: 56 },
    });
    flowMocks.internalNodes.set("2", {
      internals: { positionAbsolute: { x: 400, y: 0 } },
      measured: { width: 126, height: 56 },
    });

    render(
      <TsnFloatingEdge
        id="e1"
        source="1"
        target="2"
        sourceX={0}
        sourceY={0}
        targetX={0}
        targetY={0}
        sourcePosition={"right" as never}
        targetPosition={"left" as never}
        data={{}}
        selected={false}
      />,
    );

    const baseEdge = screen.getByTestId("base-edge-e1");
    expect(baseEdge).toHaveAttribute("data-path", "M 126,28 L 400,28");
    expect(baseEdge).toHaveAttribute("data-interaction-width", "4");
    flowMocks.internalNodes.clear();
  });

  it("平行连线使用不同直线路径渲染，起点终点不共用", () => {
    flowMocks.internalNodes.set("1", {
      internals: { positionAbsolute: { x: 0, y: 0 } },
      measured: { width: 126, height: 56 },
    });
    flowMocks.internalNodes.set("2", {
      internals: { positionAbsolute: { x: 400, y: 0 } },
      measured: { width: 126, height: 56 },
    });

    render(
      <>
        <TsnFloatingEdge
          id="e1"
          source="1"
          target="2"
          sourceX={0}
          sourceY={0}
          targetX={0}
          targetY={0}
          sourcePosition={"right" as never}
          targetPosition={"left" as never}
          data={{ parallelIndex: 0, parallelCount: 2 }}
          selected={false}
        />
        <TsnFloatingEdge
          id="e2"
          source="1"
          target="2"
          sourceX={0}
          sourceY={0}
          targetX={0}
          targetY={0}
          sourcePosition={"right" as never}
          targetPosition={"left" as never}
          data={{ parallelIndex: 1, parallelCount: 2 }}
          selected={false}
        />
      </>,
    );

    expect(screen.getByTestId("base-edge-e1")).toHaveAttribute("data-path", "M 126,14 L 400,14");
    expect(screen.getByTestId("base-edge-e2")).toHaveAttribute("data-path", "M 126,42 L 400,42");
    flowMocks.internalNodes.clear();
  });

  it("portLabelPoint 沿出射方向外推，序数 ord 分层推远", () => {
    expect(portLabelPoint(100, 50, "top" as never)).toEqual({ x: 100, y: 36 });
    expect(portLabelPoint(100, 50, "right" as never)).toEqual({ x: 116, y: 50 });
    expect(portLabelPoint(100, 50, "top" as never, 1)).toEqual({ x: 100, y: 23 });
    expect(portLabelPoint(100, 50, "bottom" as never, 2)).toEqual({ x: 100, y: 90 });
    expect(portLabelPoint(100, 50, "right" as never, 1)).toEqual({ x: 136, y: 50 });
  });
});

// U11：time-sync 阶段时钟树视图（GM 高亮、端口角色、未覆盖告警）。
describe("WorkspacePane 时钟同步视图（U11）", () => {
  // 线性 SW-1(0) — ES-2(1)，GM=0：0 master=[0]，1 slave=[0]。
  function timesyncFor(gmMid: string | null): TimesyncSnapshot {
    return {
      sessionId: "s1",
      domain: gmMid
        ? { gmMid, oneStepMode: 0, freSwitch: 0, disabledLinkSeqs: [] }
        : { gmMid: null, oneStepMode: 0, freSwitch: 0, disabledLinkSeqs: [] },
      nodes: gmMid
        ? [
            {
              mid: "1",
              masterPort: [0],
              slavePort: [],
              portPtpEnabled: [0],
              syncPeriod: 128,
              measurePeriod: 1024,
              reportEnable: 1,
              meanLinkDelayThresh: 64,
              offsetThreshold: 1000,
            },
            {
              mid: "2",
              masterPort: [],
              slavePort: [0],
              portPtpEnabled: [0],
              syncPeriod: 128,
              measurePeriod: 1024,
              reportEnable: 1,
              meanLinkDelayThresh: 64,
              offsetThreshold: 1000,
            },
          ]
        : [],
    };
  }

  function namedSnapshot(): TopologyRowSnapshot {
    return {
      sessionId: "s1",
      nodes: [
        { mid: "1", name: "SW-1", x: 0, y: 0, nodeType: "switch", insertOrder: 0 },
        { mid: "2", name: "ES-2", x: 160, y: 0, nodeType: "endSystem", insertOrder: 1 },
      ],
      links: [{ linkSeq: 0, name: null, srcNode: "1", dstNode: "2", stylesJson: "{}" }],
    };
  }

  it("topology 阶段不显示时钟同步栏", () => {
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: namedSnapshot(),
          workflowStep: "topology",
          timesyncSnapshot: timesyncFor("1"),
        })}
      />,
    );
    expect(screen.queryByLabelText("时钟同步")).not.toBeInTheDocument();
  });

  it("time-sync 阶段显示时钟同步栏与 GM 显示名", () => {
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: namedSnapshot(),
          workflowStep: "time-sync",
          timesyncSnapshot: timesyncFor("1"),
        })}
      />,
    );
    const bar = screen.getByLabelText("时钟同步");
    expect(bar).toHaveTextContent("时钟同步树");
    // GM = mid "1" → 显示名 SW-1。
    expect(bar).toHaveTextContent("SW-1");
  });

  it("time-sync 阶段未设 GM 时提示未指定", () => {
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: namedSnapshot(),
          workflowStep: "time-sync",
          timesyncSnapshot: timesyncFor(null),
        })}
      />,
    );
    expect(screen.getByLabelText("时钟同步")).toHaveTextContent("未指定时钟主节点");
  });

  it("time-sync 阶段未覆盖节点进告警", () => {
    // GM=1 落库但 ES-2 不在 timesync_nodes（不连通）→ 未覆盖告警含 ES-2。
    const partial: TimesyncSnapshot = {
      sessionId: "s1",
      domain: { gmMid: "1", oneStepMode: 0, freSwitch: 0, disabledLinkSeqs: [] },
      nodes: [
        {
          mid: "1",
          masterPort: [],
          slavePort: [],
          portPtpEnabled: [],
          syncPeriod: 128,
          measurePeriod: 1024,
          reportEnable: 1,
          meanLinkDelayThresh: 64,
          offsetThreshold: 1000,
        },
      ],
    };
    render(
      <WorkspacePane
        {...baseProps({
          topologySnapshot: namedSnapshot(),
          workflowStep: "time-sync",
          timesyncSnapshot: partial,
        })}
      />,
    );
    expect(screen.getByText(/未覆盖/)).toHaveTextContent("ES-2");
  });

  it("timesyncRoleBadge 文案映射", () => {
    expect(timesyncRoleBadge("gm")).toBe("GM");
    expect(timesyncRoleBadge("synced")).toBe("同步");
    expect(timesyncRoleBadge("passive")).toBe("旁路");
    expect(timesyncRoleBadge("uncovered")).toBe("未覆盖");
  });
});
