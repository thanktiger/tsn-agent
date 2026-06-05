/**
 * Plan v3 Phase B-β (PR-β1)：`query_topology` Tauri command 返回值的 TS 镜像。
 *
 * sidecar 写 P0 表（topology_nodes / topology_links）是唯一权威，UI 读路径
 * 通过 `invoke("query_topology")` 拉本快照渲染 React Flow。
 * 字段与 src-tauri/src/topology_query_command.rs 的 serde camelCase 输出一一对应。
 */

export interface TopologyRowSnapshot {
  sessionId: string;
  nodes: TopologyNodeRow[];
  links: TopologyLinkRow[];
}

export interface TopologyNodeRow {
  imac: number;
  syncName: string;
  x: number;
  y: number;
  syncType: string;
  nodeType: string | null;
  insertOrder: number;
}

export interface TopologyLinkRow {
  linkSeq: number;
  name: string | null;
  srcImac: number;
  dstImac: number;
  stylesJson: string;
}

export function countSwitches(snapshot: TopologyRowSnapshot): number {
  return snapshot.nodes.filter((node) => node.nodeType === "switch").length;
}

export function countEndSystems(snapshot: TopologyRowSnapshot): number {
  return snapshot.nodes.length - countSwitches(snapshot);
}

export function isEmptyTopologySnapshot(snapshot: TopologyRowSnapshot | undefined): boolean {
  return !snapshot || (snapshot.nodes.length === 0 && snapshot.links.length === 0);
}
