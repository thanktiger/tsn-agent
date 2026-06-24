import { invoke } from "@tauri-apps/api/core";
import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  countEndSystems,
  countSwitches,
  isEmptyTopologySnapshot,
  type TopologyRowSnapshot,
} from "../../../sessions/topology-snapshot";
import { DetailRow, Stat } from "../shared";
import {
  linkRowId,
  nodeRowLabel,
  nodeTypeToken,
  type TsnNodeKind,
  topologySnapshotToReactFlow,
} from "./topology-flow";
import { TsnFloatingEdge } from "./tsn-floating-edge";

export type { TsnEdgeData, TsnNodeKind } from "./topology-flow";
export {
  nodeRowLabel,
  nodeTypeToken,
  parseLinkStyles,
  planeClassName,
  topologySnapshotToReactFlow,
} from "./topology-flow";

export type ConfigTabId = "node-detail" | "link-detail";

export type SelectedTopologyItem = { kind: "node"; id: string } | { kind: "link"; id: string };

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
  syncName: string;
  x: number;
  y: number;
  expectedMutationId: number;
}

export interface CommitNodePositionResult {
  mutationId: number;
}

export interface UndoTopologyResult {
  undone: boolean;
}

/** R5：默认写通道 = update_node_position Tauri command（测试可注入替身）。 */
async function invokeCommitNodePosition(
  args: CommitNodePositionArgs,
): Promise<CommitNodePositionResult> {
  return await invoke<CommitNodePositionResult>("update_node_position", { request: args });
}

/** U8：默认撤销通道 = undo_topology Tauri command（测试可注入替身）。 */
async function invokeUndoTopology(sessionId: string): Promise<UndoTopologyResult> {
  return await invoke<UndoTopologyResult>("undo_topology", { request: { sessionId } });
}

interface PendingPosition {
  x: number;
  y: number;
  /** commit 成功返回的 mutationId；其后观测到更新 mutation 时释放 overlay（接受 DB 权威，防 agent 覆写后永久钉死）。 */
  committedMutationId?: number;
}

const VIEWPORT_NODE_WIDTH = 126;
const VIEWPORT_NODE_HEIGHT = 56;

function topologyViewportCenter(
  snapshot: TopologyRowSnapshot | undefined,
): { x: number; y: number } | undefined {
  if (!snapshot || snapshot.nodes.length === 0) {
    return undefined;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of snapshot.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + VIEWPORT_NODE_WIDTH);
    maxY = Math.max(maxY, node.y + VIEWPORT_NODE_HEIGHT);
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}

function topologyViewportResetKey(
  snapshot: TopologyRowSnapshot | undefined,
  lastMutationId: number,
): string | undefined {
  if (!snapshot || snapshot.nodes.length === 0) {
    return undefined;
  }
  const nodeKey = snapshot.nodes
    .map(
      (node) => `${node.syncName}:${node.x}:${node.y}:${node.nodeType ?? ""}:${node.insertOrder}`,
    )
    .join(",");
  const linkKey = snapshot.links
    .map((link) => `${link.linkSeq}:${link.srcSyncName}:${link.dstSyncName}`)
    .join(",");
  return `${snapshot.sessionId}:${lastMutationId}:${nodeKey}:${linkKey}`;
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
  /** 清除选中：详情面板随选中态显隐（点画布空白或关闭按钮触发）。 */
  onClearSelection: () => void;
  /** 写入失败/陈旧时的回正：重拉快照覆盖本地（R10/R11）。 */
  onRefreshTopology: () => void;
  /** U8：撤销成功后置一次性回退通知标志（下一轮注入），由 App 经 setCurrentSession 实现。 */
  onUndone?: () => void;
  commitNodePosition?: (args: CommitNodePositionArgs) => Promise<CommitNodePositionResult>;
  undoTopology?: (sessionId: string) => Promise<UndoTopologyResult>;
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
  onClearSelection,
  onRefreshTopology,
  onUndone,
  commitNodePosition = invokeCommitNodePosition,
  undoTopology = invokeUndoTopology,
}: WorkspacePaneProps) {
  const flowTopology = useMemo(
    () =>
      topologySnapshot && !isEmptyTopologySnapshot(topologySnapshot)
        ? topologySnapshotToReactFlow(topologySnapshot)
        : undefined,
    [topologySnapshot],
  );

  // —— 拖动状态（R5/R7/R10/R11）——
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  // pending 坐标 overlay：dragStop 起覆盖到达快照中该节点的位置，
  // 快照坐标与 overlay 一致（写入确认）/出现更新 mutation/NACK 回正时清除。
  // ref 为权威（回调同步读写，无闭包过期）；state 仅供渲染（详情面板）。
  const pendingRef = useRef<Map<string, PendingPosition>>(new Map());
  const [pendingPositions, setPendingPositions] = useState<ReadonlyMap<string, PendingPosition>>(
    new Map(),
  );
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
  // U8：撤销「无可撤销」/失败时的非静默反馈（短暂内联提示）。
  const [undoNotice, setUndoNotice] = useState<string | undefined>(undefined);
  const undoNoticeTimerRef = useRef<number | undefined>(undefined);
  const [undoBusy, setUndoBusy] = useState(false);
  // U8：撤销无 redo、且会回滚拖拽布局——按钮加内联两步确认（点一下进确认态、再点才执行）。
  const [undoConfirming, setUndoConfirming] = useState(false);
  const undoConfirmTimerRef = useRef<number | undefined>(undefined);
  const flowInstanceRef = useRef<ReactFlowInstance<Node, Edge> | undefined>(undefined);
  const [flowInstanceVersion, setFlowInstanceVersion] = useState(0);
  const lastViewportResetKeyRef = useRef<string | undefined>(undefined);
  const localPositionMutationIdsRef = useRef<Set<number>>(new Set());

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

  // session 切换：overlay/拖动/缓存/基准全部重置——overlay 按 syncName 键控，
  // 不重置会污染另一 session 同 syncName 节点；拖动中切换时 dragStop 不再触发，
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
    localPositionMutationIdsRef.current.clear();
    lastViewportResetKeyRef.current = undefined;
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
        const superseded =
          pending.committedMutationId !== undefined &&
          lastMutationIdRef.current > pending.committedMutationId;
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

  useEffect(
    () => () => {
      if (saveFailedTimerRef.current !== undefined) {
        window.clearTimeout(saveFailedTimerRef.current);
      }
      if (undoNoticeTimerRef.current !== undefined) {
        window.clearTimeout(undoNoticeTimerRef.current);
      }
      if (undoConfirmTimerRef.current !== undefined) {
        window.clearTimeout(undoConfirmTimerRef.current);
      }
    },
    [],
  );

  const showSaveFailed = useCallback(() => {
    setSaveFailed(true);
    if (saveFailedTimerRef.current !== undefined) {
      window.clearTimeout(saveFailedTimerRef.current);
    }
    saveFailedTimerRef.current = window.setTimeout(() => setSaveFailed(false), 3000);
  }, []);

  const showUndoNotice = useCallback((text: string) => {
    setUndoNotice(text);
    if (undoNoticeTimerRef.current !== undefined) {
      window.clearTimeout(undoNoticeTimerRef.current);
    }
    undoNoticeTimerRef.current = window.setTimeout(() => setUndoNotice(undefined), 3000);
  }, []);

  const cancelUndoConfirm = useCallback(() => {
    setUndoConfirming(false);
    if (undoConfirmTimerRef.current !== undefined) {
      window.clearTimeout(undoConfirmTimerRef.current);
      undoConfirmTimerRef.current = undefined;
    }
  }, []);

  const runUndo = useCallback(async () => {
    const sessionId = topologySnapshot?.sessionId;
    if (!sessionId || undoBusy) {
      return;
    }
    setUndoBusy(true);
    try {
      const result = await undoTopology(sessionId);
      if (result.undone) {
        // 双保险：emit 已触发刷新，这里再显式全量 refetch；并置一次性回退通知标志（U7）。
        onRefreshTopology();
        onUndone?.();
      } else {
        // R11：无可撤销快照——非静默，给内联提示。
        showUndoNotice("没有可撤销的改动");
      }
    } catch {
      showUndoNotice("撤销失败");
    } finally {
      setUndoBusy(false);
    }
  }, [
    topologySnapshot?.sessionId,
    undoBusy,
    undoTopology,
    onRefreshTopology,
    onUndone,
    showUndoNotice,
  ]);

  // 内联两步：第一次点击进入「确认撤销?」态（几秒后或失焦自动取消），第二次点击才真正执行。
  const handleUndo = useCallback(() => {
    if (undoBusy) {
      return;
    }
    if (!undoConfirming) {
      setUndoConfirming(true);
      if (undoConfirmTimerRef.current !== undefined) {
        window.clearTimeout(undoConfirmTimerRef.current);
      }
      undoConfirmTimerRef.current = window.setTimeout(() => setUndoConfirming(false), 3000);
      return;
    }
    cancelUndoConfirm();
    void runUndo();
  }, [undoBusy, undoConfirming, cancelUndoConfirm, runUndo]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setFlowNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);

  const viewportResetKey = useMemo(
    () => topologyViewportResetKey(topologySnapshot, lastMutationId),
    [topologySnapshot, lastMutationId],
  );

  useEffect(() => {
    if (!viewportResetKey) {
      lastViewportResetKeyRef.current = undefined;
      flowInstanceRef.current = undefined;
    }
  }, [viewportResetKey]);

  const centerTopologyViewport = useCallback(
    (instance = flowInstanceRef.current) => {
      if (!instance || !viewportResetKey || lastViewportResetKeyRef.current === viewportResetKey) {
        return;
      }
      if (lastMutationId > 0 && localPositionMutationIdsRef.current.has(lastMutationId)) {
        lastViewportResetKeyRef.current = viewportResetKey;
        return;
      }
      const center = topologyViewportCenter(topologySnapshot);
      if (!center) {
        return;
      }
      lastViewportResetKeyRef.current = viewportResetKey;
      void instance.setCenter(center.x, center.y, { zoom: 1, duration: 0 });
    },
    [lastMutationId, topologySnapshot, viewportResetKey],
  );

  useEffect(() => {
    centerTopologyViewport();
  }, [centerTopologyViewport, flowInstanceVersion]);

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
        syncName: node.id,
        x,
        y,
        expectedMutationId: dragStartMutationIdRef.current,
      })
        .then((result) => {
          if (currentSessionIdRef.current !== sessionId) {
            return; // 迟到响应：session 已切换，状态已重置。
          }
          lastMutationIdRef.current = Math.max(lastMutationIdRef.current, result.mutationId);
          localPositionMutationIdsRef.current.add(result.mutationId);
          const entry = pendingRef.current.get(node.id);
          if (entry && entry.x === x && entry.y === y) {
            mutatePending((next) =>
              next.set(node.id, { x, y, committedMutationId: result.mutationId }),
            );
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
    [
      mutatePending,
      onNodeSelect,
      applySnapshotNodes,
      commitNodePosition,
      showSaveFailed,
      onRefreshTopology,
    ],
  );

  const hasTopology = !isEmptyTopologySnapshot(topologySnapshot);
  const switchCount = topologySnapshot ? countSwitches(topologySnapshot) : 0;
  const endSystemCount = topologySnapshot ? countEndSystems(topologySnapshot) : 0;
  const linkCount = topologySnapshot?.links.length ?? 0;
  const selectedNodeRow =
    selectedTopologyItem?.kind === "node"
      ? topologySnapshot?.nodes.find((node) => node.syncName === selectedTopologyItem.id)
      : undefined;
  // 详情面板坐标优先读 overlay（R9：拖毕即显示新坐标，无确认窗口跳变）。
  const selectedNode = selectedNodeRow
    ? (() => {
        const pending = pendingPositions.get(selectedNodeRow.syncName);
        return pending ? { ...selectedNodeRow, x: pending.x, y: pending.y } : selectedNodeRow;
      })()
    : undefined;
  const selectedLink =
    selectedTopologyItem?.kind === "link"
      ? topologySnapshot?.links.find((link) => linkRowId(link) === selectedTopologyItem.id)
      : undefined;
  const selectedLinkSourceNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.syncName === selectedLink.srcSyncName)
    : undefined;
  const selectedLinkTargetNode = selectedLink
    ? topologySnapshot?.nodes.find((node) => node.syncName === selectedLink.dstSyncName)
    : undefined;

  return (
    <section className="workspace-pane" aria-label="工程状态">
      <div className="topology-stage grid-bg">
        <div className="topology-stats" role="group" aria-label="拓扑统计">
          <Stat label="交换机" value={switchCount} />
          <Stat label="端系统" value={endSystemCount} />
          <Stat label="链路" value={linkCount} />
          <button
            type="button"
            className={undoConfirming ? "topology-undo-button confirming" : "topology-undo-button"}
            aria-label="撤销上一次结构改动"
            disabled={!hasTopology || undoBusy}
            onClick={handleUndo}
            onBlur={cancelUndoConfirm}
          >
            {undoConfirming ? "确认撤销?" : "撤销"}
          </button>
        </div>
        {saveFailed && (
          <div className="transfer-notice error tsn-position-notice" role="alert">
            位置保存失败，已恢复
          </div>
        )}
        {undoNotice && (
          <div className="transfer-notice error tsn-position-notice" role="status">
            {undoNotice}
          </div>
        )}
        <div
          className="topology-canvas"
          role="group"
          aria-label="拓扑画布"
          data-testid="topology-canvas"
        >
          {flowTopology ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowTopology.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable
              selectionOnDrag={false}
              multiSelectionKeyCode={null}
              proOptions={{ hideAttribution: true }}
              onInit={(instance) => {
                // R12：拓扑展示/生成刷新时保持 100% 比例并居中；不使用常驻
                // fitView prop，避免用户交互过程中被 React Flow 自动缩放。
                const isFirstKnownInstance = !flowInstanceRef.current;
                flowInstanceRef.current = instance;
                if (isFirstKnownInstance) {
                  setFlowInstanceVersion((version) => version + 1);
                }
              }}
              onNodesChange={handleNodesChange}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
              onNodeClick={onNodeSelect}
              onEdgeClick={onLinkSelect}
              onPaneClick={onClearSelection}
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

      {/* 详情面板默认隐藏，点击节点/链路打开（流功能后续在此承载）。 */}
      {selectedTopologyItem && (
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
            <button
              type="button"
              className="config-close"
              aria-label="关闭详情"
              onClick={onClearSelection}
            >
              ×
            </button>
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
                    <p>
                      {selectedNode
                        ? nodeRowLabel(selectedNode)
                        : "在拓扑画布选择一个节点查看类型、地址和位置。"}
                    </p>
                  </div>
                </div>
                {selectedNode ? (
                  <div className="detail-grid">
                    <DetailRow label="名称" value={selectedNode.name ?? "无"} />
                    <DetailRow label="节点号" value={selectedNode.syncName} />
                    <DetailRow
                      label="类型"
                      value={NODE_KIND_NAME[nodeTypeToken(selectedNode.nodeType)]}
                    />
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
                    <p>
                      {selectedLink ? linkRowId(selectedLink) : "在拓扑画布选择一条链路查看端点。"}
                    </p>
                  </div>
                </div>
                {selectedLink ? (
                  <div className="detail-grid">
                    <DetailRow label="链路序号" value={selectedLink.linkSeq} />
                    <DetailRow label="名称" value={selectedLink.name ?? "无"} />
                    <DetailRow
                      label="源端点"
                      value={
                        selectedLinkSourceNode
                          ? nodeRowLabel(selectedLinkSourceNode)
                          : `节点 ${selectedLink.srcSyncName}`
                      }
                    />
                    <DetailRow
                      label="目标端点"
                      value={
                        selectedLinkTargetNode
                          ? nodeRowLabel(selectedLinkTargetNode)
                          : `节点 ${selectedLink.dstSyncName}`
                      }
                    />
                  </div>
                ) : (
                  <div className="empty-panel mono">请选择拓扑画布中的链路</div>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const NODE_KIND_BADGE: Record<TsnNodeKind, string> = {
  switch: "SW",
  endSystem: "ES",
  controller: "CTRL",
};

const NODE_KIND_NAME: Record<TsnNodeKind, string> = {
  switch: "交换机",
  endSystem: "端系统",
  controller: "控制器",
};

function TsnTopologyNode({ data }: NodeProps) {
  const nodeData = data as {
    label?: string;
    nodeType?: TsnNodeKind;
    syncName?: string;
  };
  const nodeType = nodeData.nodeType ?? "endSystem";

  return (
    <div className={`tsn-node ${nodeType}`}>
      {/* R2：floating 边不锚定 handle；保留一对隐形 handle 满足 React Flow 边合法性。 */}
      <Handle id="s" type="source" position={Position.Top} />
      <Handle id="t" type="target" position={Position.Top} />
      <span className="tsn-node-type mono">{NODE_KIND_BADGE[nodeType]}</span>
      <strong>{nodeData.label}</strong>
      <small className="mono">节点 {nodeData.syncName}</small>
    </div>
  );
}
