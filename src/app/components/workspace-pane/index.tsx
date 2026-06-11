import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  countEndSystems,
  countSwitches,
  isEmptyTopologySnapshot,
  type TopologyRowSnapshot,
} from "../../../sessions/topology-snapshot";
import { DetailRow, Stat } from "../shared";
import { TsnFloatingEdge } from "./tsn-floating-edge";
import { linkRowId, nodeRowLabel, topologySnapshotToReactFlow } from "./topology-flow";

export {
  nodeRowLabel,
  parseLinkStyles,
  planeClassName,
  topologySnapshotToReactFlow,
} from "./topology-flow";
export type { TsnEdgeData } from "./topology-flow";

export type ConfigTabId = "node-detail" | "link-detail";

export type SelectedTopologyItem =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string };

const CONFIG_TABS: Array<{ id: ConfigTabId; label: string }> = [
  { id: "node-detail", label: "节点详情" },
  { id: "link-detail", label: "链路详情" },
];

const nodeTypes = {
  tsnNode: TsnTopologyNode,
};

const edgeTypes = {
  tsnFloating: TsnFloatingEdge,
};

export interface CommitNodePositionArgs {
  sessionId: string;
  imac: number;
  x: number;
  y: number;
  expectedMutationId: number;
}

export interface CommitNodePositionResult {
  mutationId: number;
}

/** R5：默认写通道 = update_node_position Tauri command（测试可注入替身）。 */
async function invokeCommitNodePosition(args: CommitNodePositionArgs): Promise<CommitNodePositionResult> {
  return await invoke<CommitNodePositionResult>("update_node_position", { request: args });
}

interface PendingPosition {
  x: number;
  y: number;
  /** commit 成功返回的 mutationId；其后观测到更新 mutation 时释放 overlay（接受 DB 权威，防 agent 覆写后永久钉死）。 */
  committedMutationId?: number;
}

export interface WorkspacePaneProps {
  topologySnapshot: TopologyRowSnapshot | undefined;
  selectedTopologyItem: SelectedTopologyItem | undefined;
  activeConfigTab: ConfigTabId;
  isAgentRunning: boolean;
  hasUserInteraction: boolean;
  /** 本 session 最近观测的 mutationId（R11 陈旧写检测基准）。 */
  lastMutationId: number;
  onSelectConfigTab: (tab: ConfigTabId) => void;
  onNodeSelect: (event: unknown, node: Node) => void;
  onLinkSelect: (event: unknown, edge: Edge) => void;
  /** 写入失败/陈旧时的回正：重拉快照覆盖本地（R10/R11）。 */
  onRefreshTopology: () => void;
  commitNodePosition?: (args: CommitNodePositionArgs) => Promise<CommitNodePositionResult>;
}

export function WorkspacePane({
  topologySnapshot,
  selectedTopologyItem,
  activeConfigTab,
  isAgentRunning,
  hasUserInteraction,
  lastMutationId,
  onSelectConfigTab,
  onNodeSelect,
  onLinkSelect,
  onRefreshTopology,
  commitNodePosition = invokeCommitNodePosition,
}: WorkspacePaneProps) {
  const flowTopology = useMemo(
    () => (topologySnapshot && !isEmptyTopologySnapshot(topologySnapshot)
      ? topologySnapshotToReactFlow(topologySnapshot)
      : undefined),
    [topologySnapshot],
  );

  // —— 拖动状态（R5/R7/R10/R11）——
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  // pending 坐标 overlay：dragStop 起覆盖到达快照中该节点的位置，
  // 快照坐标与 overlay 一致（写入确认）/出现更新 mutation/NACK 回正时清除。
  // ref 为权威（回调同步读写，无闭包过期）；state 仅供渲染（详情面板）。
  const pendingRef = useRef<Map<string, PendingPosition>>(new Map());
  const [pendingPositions, setPendingPositions] = useState<ReadonlyMap<string, PendingPosition>>(new Map());
  const draggingRef = useRef(false);
  const dragStartMutationIdRef = useRef(0);
  const dragSessionRef = useRef<string | undefined>(undefined);
  const bufferedNodesRef = useRef<Node[] | undefined>(undefined);
  // 本地 mutationId 基准 = max(prop, 本组件 commit 响应)：事件丢失时后续拖动不被连环误判 stale。
  const lastMutationIdRef = useRef(0);
  const currentSessionIdRef = useRef<string | undefined>(undefined);
  const resetSessionRef = useRef<string | undefined>(undefined);
  const [saveFailed, setSaveFailed] = useState(false);
  const saveFailedTimerRef = useRef<number | undefined>(undefined);
  const fittedSessionRef = useRef<string | undefined>(undefined);

  // 拖动回调身份须稳定（拖动中回调换引用可能丢 dragStop）→ 经 ref 读最新值。
  useEffect(() => {
    currentSessionIdRef.current = topologySnapshot?.sessionId;
  });
  useEffect(() => {
    lastMutationIdRef.current = Math.max(lastMutationIdRef.current, lastMutationId);
  }, [lastMutationId]);

  const mutatePending = useCallback((mutator: (next: Map<string, PendingPosition>) => void) => {
    const next = new Map(pendingRef.current);
    mutator(next);
    pendingRef.current = next;
    setPendingPositions(next);
  }, []);

  // session 切换：overlay/拖动/缓存/基准全部重置——overlay 按 imac 键控，
  // 不重置会污染另一 session 同 imac 节点；拖动中切换时 dragStop 不再触发，
  // draggingRef 也在此回正，防快照永久滞留缓存。
  useEffect(() => {
    const sessionId = topologySnapshot?.sessionId;
    if (!sessionId || sessionId === resetSessionRef.current) {
      return;
    }
    resetSessionRef.current = sessionId;
    pendingRef.current = new Map();
    setPendingPositions(new Map());
    draggingRef.current = false;
    bufferedNodesRef.current = undefined;
    lastMutationIdRef.current = lastMutationId;
  }, [topologySnapshot?.sessionId, lastMutationId]);

  const applySnapshotNodes = useCallback(
    (nodes: Node[], overlay: ReadonlyMap<string, PendingPosition>) => {
      const next = nodes.map((node) => {
        const pending = overlay.get(node.id);
        if (!pending || (node.position.x === pending.x && node.position.y === pending.y)) {
          return node;
        }
        return { ...node, position: { x: pending.x, y: pending.y } };
      });
      setFlowNodes(next);
    },
    [],
  );

  // overlay 释放：写入确认（快照坐标一致），或已提交后出现更新 mutation
  // （如 agent 覆写同节点）→ 接受 DB 权威，防止 overlay 永久钉死旧坐标。
  const releasePendingAgainst = useCallback(
    (nodes: Node[]) => {
      if (pendingRef.current.size === 0) {
        return;
      }
      const released: string[] = [];
      for (const [id, pending] of pendingRef.current) {
        const row = nodes.find((node) => node.id === id);
        if (!row) {
          continue;
        }
        const confirmed = row.position.x === pending.x && row.position.y === pending.y;
        const superseded = pending.committedMutationId !== undefined
          && lastMutationIdRef.current > pending.committedMutationId;
        if (confirmed || superseded) {
          released.push(id);
        }
      }
      if (released.length > 0) {
        mutatePending((next) => {
          for (const id of released) {
            next.delete(id);
          }
        });
      }
    },
    [mutatePending],
  );

  // 快照 → 本地 nodes：拖动中缓存，拖毕应用；overlay 覆盖未确认坐标（R7 全窗口）。
  // 释放与应用合并为单一 effect（拆分时两个 effect 会经 pendingPositions 相互追逐）；
  // 依赖 pendingPositions 是为 commit 响应迟于快照到达时重评估释放——
  // 释放是单 effect 内批量完成的，最多多收敛一轮，不会循环。
  useEffect(() => {
    const nodes = flowTopology?.nodes ?? [];
    if (draggingRef.current) {
      bufferedNodesRef.current = nodes;
      return;
    }
    releasePendingAgainst(nodes);
    applySnapshotNodes(nodes, pendingRef.current);
  }, [flowTopology, pendingPositions, releasePendingAgainst, applySnapshotNodes]);

  useEffect(() => () => {
    if (saveFailedTimerRef.current !== undefined) {
      window.clearTimeout(saveFailedTimerRef.current);
    }
  }, []);

  const showSaveFailed = useCallback(() => {
    setSaveFailed(true);
    if (saveFailedTimerRef.current !== undefined) {
      window.clearTimeout(saveFailedTimerRef.current);
    }
    saveFailedTimerRef.current = window.setTimeout(() => setSaveFailed(false), 3000);
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setFlowNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);

  const handleNodeDragStart = useCallback(() => {
    draggingRef.current = true;
    dragStartMutationIdRef.current = lastMutationIdRef.current;
    dragSessionRef.current = currentSessionIdRef.current;
  }, []);

  const handleNodeDragStop = useCallback(
    (event: unknown, node: Node) => {
      draggingRef.current = false;
      const sessionId = currentSessionIdRef.current;
      // 拖动期间发生 session 切换：丢弃本次拖动（不写 overlay、不提交到新 session）。
      if (!sessionId || sessionId !== dragSessionRef.current) {
        bufferedNodesRef.current = undefined;
        return;
      }
      const x = Math.round(node.position.x);
      const y = Math.round(node.position.y);
      mutatePending((next) => next.set(node.id, { x, y }));

      // 拖毕视同选中该节点（R9），详情面板坐标经 overlay 即时显示新值。
      onNodeSelect(event, node);

      // 拖动中缓存的快照现在应用（位置仍被 overlay 保护）。
      if (bufferedNodesRef.current) {
        applySnapshotNodes(bufferedNodesRef.current, pendingRef.current);
        bufferedNodesRef.current = undefined;
      }

      void commitNodePosition({
        sessionId,
        imac: Number(node.id),
        x,
        y,
        expectedMutationId: dragStartMutationIdRef.current,
      })
        .then((result) => {
          if (currentSessionIdRef.current !== sessionId) {
            return; // 迟到响应：session 已切换，状态已重置。
          }
          lastMutationIdRef.current = Math.max(lastMutationIdRef.current, result.mutationId);
          const entry = pendingRef.current.get(node.id);
          if (entry && entry.x === x && entry.y === y) {
            mutatePending((next) => next.set(node.id, { x, y, committedMutationId: result.mutationId }));
          }
        })
        .catch(() => {
          if (currentSessionIdRef.current !== sessionId) {
            return;
          }
          // R10/R11：失败或陈旧 → 清 overlay、重拉快照回正、可见提示。
          mutatePending((next) => next.delete(node.id));
          showSaveFailed();
          onRefreshTopology();
        });
    },
    [mutatePending, onNodeSelect, applySnapshotNodes, commitNodePosition, showSaveFailed, onRefreshTopology],
  );

  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);
  const switchCount = topologySnapshot ? countSwitches(topologySnapshot) : 0;
  const endSystemCount = topologySnapshot ? countEndSystems(topologySnapshot) : 0;
  const linkCount = topologySnapshot?.links.length ?? 0;
  const selectedNodeRow = selectedTopologyItem?.kind === "node"
    ? topologySnapshot?.nodes.find((node) => String(node.imac) === selectedTopologyItem.id)
    : undefined;
  // 详情面板坐标优先读 overlay（R9：拖毕即显示新坐标，无确认窗口跳变）。
  const selectedNode = selectedNodeRow
    ? (() => {
        const pending = pendingPositions.get(String(selectedNodeRow.imac));
        return pending ? { ...selectedNodeRow, x: pending.x, y: pending.y } : selectedNodeRow;
      })()
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
        {saveFailed && (
          <div className="transfer-notice error tsn-position-notice" role="alert">
            位置保存失败，已恢复
          </div>
        )}
        <div className="topology-canvas" aria-label="拓扑画布" data-testid="topology-canvas">
          {flowTopology ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowTopology.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable
              selectionOnDrag={false}
              multiSelectionKeyCode={null}
              onInit={(instance) => {
                // R12：每 session 首次挂载 fitView 一次。session 切换时快照必经
                // undefined 过渡（hook 同步清空）→ ReactFlow 重挂载 → onInit 重触发，
                // 单路径即可覆盖；fittedSessionRef 兜 StrictMode 双触发。
                const sessionId = topologySnapshot?.sessionId;
                if (sessionId && fittedSessionRef.current !== sessionId) {
                  fittedSessionRef.current = sessionId;
                  void instance.fitView();
                }
              }}
              onNodesChange={handleNodesChange}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
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
                <DetailRow label="名称" value={selectedNode.name ?? "无"} />
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
        </div>
      </div>
    </section>
  );
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
      {/* R2：floating 边不锚定 handle；保留一对隐形 handle 满足 React Flow 边合法性。 */}
      <Handle id="s" type="source" position={Position.Top} />
      <Handle id="t" type="target" position={Position.Top} />
      <span className="tsn-node-type mono">{nodeType === "switch" ? "SW" : "ES"}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">imac {nodeData.imac}</small>
    </div>
  );
}
