import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  countEndSystems,
  countSwitches,
  isEmptyTopologySnapshot,
  type TopologyLinkRow,
  type TopologyNodeRow,
  type TopologyRowSnapshot,
} from "../../../sessions/topology-snapshot";
import type { AgentEvent } from "../../../agent/agent-types";
import { redactProviderNamesForDisplay } from "../../../ui/display-redaction";
import { DetailRow, Stat } from "../shared";

export type ConfigTabId = "node-detail" | "link-detail" | "steps";

export type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
  { id: "steps", label: "执行步骤" },
];

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

export interface WorkspacePaneProps {
  topologySnapshot: TopologyRowSnapshot | undefined;
  selectedTopologyItem: SelectedTopologyItem | undefined;
  activeConfigTab: ConfigTabId;
  agentEvents: AgentEvent[];
  isAgentRunning: boolean;
  hasUserInteraction: boolean;
  onSelectConfigTab: (tab: ConfigTabId) => void;
  onNodeSelect: (event: unknown, node: Node) => void;
  onLinkSelect: (event: unknown, edge: Edge) => void;
}

export function WorkspacePane({
  topologySnapshot,
  selectedTopologyItem,
  activeConfigTab,
  agentEvents,
  isAgentRunning,
  hasUserInteraction,
  onSelectConfigTab,
  onNodeSelect,
  onLinkSelect,
}: WorkspacePaneProps) {
  const flowTopology = useMemo(
    () => (topologySnapshot && !isEmptyTopologySnapshot(topologySnapshot)
      ? topologySnapshotToReactFlow(topologySnapshot)
      : undefined),
    [topologySnapshot],
  );
  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);
  const switchCount = topologySnapshot ? countSwitches(topologySnapshot) : 0;
  const endSystemCount = topologySnapshot ? countEndSystems(topologySnapshot) : 0;
  const linkCount = topologySnapshot?.links.length ?? 0;
  const selectedNode = selectedTopologyItem?.kind === "node"
    ? topologySnapshot?.nodes.find((node) => String(node.imac) === selectedTopologyItem.id)
    : undefined;
  const selectedLink = selectedTopologyItem?.kind === "link"
    ? topologySnapshot?.links.find((link) => linkRowId(link) === selectedTopologyItem.id)
    : undefined;
  const selectedLinkSourceNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.srcImac)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.imac === selectedLink.dstImac)
    : undefined;

  return (
    <section className="workspace-pane" aria-label="工程状态">
      <div className="topology-stage grid-bg">
        <div className="topology-meta mono">TSN PROJECT DB · REACT FLOW</div>
        <div className="topology-stats" aria-label="拓扑统计">
          <Stat label="交换机" value={switchCount} />
          <Stat label="端系统" value={endSystemCount} />
          <Stat label="链路" value={linkCount} />
        </div>
        <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
          {flowTopology ? (
            <ReactFlow
              nodes={flowTopology.nodes}
              edges={flowTopology.edges}
              nodeTypes={nodeTypes}
              fitView
              nodesDraggable={false}
              onNodeClick={onNodeSelect}
              onEdgeClick={onLinkSelect}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="topology-empty mono">
              {isAgentRunning
                ? "正在生成拓扑图"
                : hasUserInteraction
                  ? "拓扑生成后在这里显示"
                  : "描述你的 TSN 需求后生成拓扑图"}
            </div>
          )}
        </div>
      </div>

      <div className="config-panel">
        <div className="config-tabs" role="tablist" aria-label="工程详情">
          {CONFIG_TABS.map((tab) => (
            <button
              className={activeConfigTab === tab.id ? "config-tab active" : "config-tab"}
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeConfigTab === tab.id}
              aria-controls={`config-panel-${tab.id}`}
              id={`config-tab-${tab.id}`}
              onClick={() => onSelectConfigTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          <div className="config-spacer" />
          <span className="config-state mono">配置 · {hasTopology ? "草案" : "未生成"}</span>
        </div>

        <div className="config-body">
          {activeConfigTab === "node-detail" && (
            <section
              className="detail-panel"
              id="config-panel-node-detail"
              role="tabpanel"
              aria-label="节点详情"
            >
            <div className="panel-heading">
              <div>
                <h2>节点详情</h2>
                <p>{selectedNode ? nodeRowLabel(selectedNode) : "在拓扑画布选择一个节点查看类型、地址和位置。"}</p>
              </div>
            </div>
            {selectedNode ? (
              <div className="detail-grid">
                <DetailRow label="IMAC" value={selectedNode.imac} />
                <DetailRow label="同步名称" value={selectedNode.syncName} />
                <DetailRow label="类型" value={selectedNode.nodeType === "switch" ? "交换机" : "端系统"} />
                <DetailRow label="坐标" value={`${selectedNode.x}, ${selectedNode.y}`} />
                <DetailRow label="插入顺序" value={selectedNode.insertOrder} />
              </div>
            ) : (
              <div className="empty-panel mono">请选择拓扑画布中的节点</div>
            )}
          </section>
          )}

          {activeConfigTab === "link-detail" && (
            <section
              className="detail-panel"
              id="config-panel-link-detail"
              role="tabpanel"
              aria-label="链路详情"
            >
            <div className="panel-heading">
              <div>
                <h2>链路详情</h2>
                <p>{selectedLink ? linkRowId(selectedLink) : "在拓扑画布选择一条链路查看端点。"}</p>
              </div>
            </div>
            {selectedLink ? (
              <div className="detail-grid">
                <DetailRow label="链路序号" value={selectedLink.linkSeq} />
                <DetailRow label="名称" value={selectedLink.name ?? "无"} />
                <DetailRow
                  label="源端点"
                  value={selectedLinkSourceNode ? nodeRowLabel(selectedLinkSourceNode) : `imac ${selectedLink.srcImac}`}
                />
                <DetailRow
                  label="目标端点"
                  value={selectedLinkTargetNode ? nodeRowLabel(selectedLinkTargetNode) : `imac ${selectedLink.dstImac}`}
                />
              </div>
            ) : (
              <div className="empty-panel mono">请选择拓扑画布中的链路</div>
            )}
          </section>
          )}

          {activeConfigTab === "steps" && (
            <section
              className="steps-panel"
              id="config-panel-steps"
              role="tabpanel"
              aria-label="执行步骤"
            >
            <div className="panel-heading">
              <h2>执行步骤</h2>
            </div>
            <ol className="event-list">
              {agentEvents.map((event, index) => (
                <li className={event.kind} key={`${event.id}-${index}`}>
                  <span>{redactProviderNamesForDisplay(event.skillName ?? event.title)}</span>
                  <p>{redactProviderNamesForDisplay(event.content)}</p>
                </li>
              ))}
              {agentEvents.length === 0 && <li className="empty-step">等待 Agent 输出</li>}
            </ol>
          </section>
          )}
        </div>
      </div>
    </section>
  );
}

function topologySnapshotToReactFlow(snapshot: TopologyRowSnapshot): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: snapshot.nodes.map((node) => ({
      id: String(node.imac),
      type: "tsnNode",
      position: { x: node.x, y: node.y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: nodeRowLabel(node),
        nodeType: node.nodeType === "switch" ? "switch" : "endSystem",
        imac: node.imac,
      },
    })),
    edges: snapshot.links.map((link) => ({
      id: linkRowId(link),
      source: String(link.srcImac),
      target: String(link.dstImac),
    })),
  };
}

function nodeRowLabel(node: TopologyNodeRow): string {
  const prefix = node.nodeType === "switch" ? "SW" : "ES";
  return `${prefix}-${node.syncName}`;
}

function linkRowId(link: TopologyLinkRow): string {
  return `link-${link.linkSeq}`;
}

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: "switch" | "endSystem";
    imac?: number;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">imac {nodeData.imac}</small>
    </div>
  );
}
