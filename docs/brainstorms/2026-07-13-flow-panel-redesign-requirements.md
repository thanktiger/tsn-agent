# 流量规划面板重设计需求

日期：2026-07-13

## 背景与范围

当前 `flow-panel.tsx` 是扁平单页（门控 GCL 图表 + 软仿结果），无流量列表、无详情弹框、画布无流路径高亮。本次是从 0 建：

**本期范围：**
- S1 子 tab 外壳：流量列表 / 门控规划 / 软仿模拟 / 硬件部署（最后一个占位/禁用）
- S2 流量列表回显：新 Rust 查询命令 + 前端逐行展示
- S3 拓扑流路径高亮（步骤 1：选中高亮单流，RC 同时高亮 A/B 双路径）
- S4 可编辑流详情弹框 + `flow_streams` 扩表（5 列）

**已确认决策（boss 定）：**
- 硬件部署子 tab 本期仅占位/禁用，不造实际能力
- S4 含可编辑弹框并扩 `flow_streams` 表
- RC 流高亮时同时高亮 A/B 两条平面路径

---

## S1 · 子 tab 外壳

### R1 · FlowSubTab 类型和常量

新增 `FlowSubTab` 类型和 `FLOW_SUBTABS` 常量，位置：`src/app/components/workspace-pane/flow-subtabs.tsx`（新建文件，对齐 `timesync-subtabs.tsx`）。

```ts
export type FlowSubTab = "flow-list" | "gate-plan" | "soft-sim" | "hw-deploy";

export const FLOW_SUBTABS: Array<{ id: FlowSubTab; label: string; disabled?: boolean }> = [
  { id: "flow-list",  label: "流量列表" },
  { id: "gate-plan",  label: "门控规划" },
  { id: "soft-sim",   label: "软仿模拟" },
  { id: "hw-deploy",  label: "硬件部署", disabled: true },
];
```

### R2 · FlowSubTabs 组件

`FlowSubTabs` 组件结构对齐 `TimesyncSubTabs`（42 行范式）。禁用 tab 渲染 `disabled` 属性 + `title="硬件部署功能尚未开放"` tooltip，视觉灰显（CSS opacity）。

### R3 · App 级 state 管理

`src/app/App.tsx` 新增：
```ts
const [activeFlowSubTab, setActiveFlowSubTab] = useState<FlowSubTab>("flow-list");
```

与 `activeTimesyncSubTab` 并列。将 `activeFlowSubTab` 和 `onSelectFlowSubTab={setActiveFlowSubTab}` 透传给 `FlowPanel`。

### R4 · 切会话重置

会话切换时（App 内 session change 处理处，已重置 `activeTimesyncSubTab` 的地方同处），把 `activeFlowSubTab` 重置为 `"flow-list"`。

### R5 · 现有内容重新挂载

| 当前位置 | 迁移到 |
|---------|--------|
| `PlanResultArea`（GCL 图表 + 明细表）| 门控规划 tab |
| 门控规划命令栏按钮（规划 / 重新规划） | 门控规划 tab 命令栏 |
| `VerifyResultArea`（软仿结果表） | 软仿模拟 tab |
| 软仿按钮（软仿验证）| 软仿模拟 tab 命令栏 |
| `flow-honesty-note`（仿真实测标注） | 软仿模拟 tab 命令栏 |

流量列表 tab 是新建，硬件部署 tab 为占位空内容。

### R6 · key={sessionId} 重挂

`FlowPanel` 内各 tab 面板用 `key={sessionId}` 保证切会话后彻底重挂（对齐 TimesyncSubTabs 既有 PR #65 守卫范式）。

---

## S2 · 流量列表回显

### R7 · 新 Rust 命令 `list_flow_streams`

新文件 `src-tauri/src/flow_list_command.rs`（或追加到 `flow_query_command.rs`），提供只读查询：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStreamRow {
    pub stream_seq: i64,
    pub class: String,           // "ST" | "RC" | "BE"
    pub pcp: i64,
    pub period_us: i64,
    pub frame_bytes: i64,
    pub count: i64,
    pub talker: String,          // sync_name
    pub listener: String,        // sync_name
    pub max_latency_us: Option<i64>,
    pub redundant: bool,
    // S4 扩表新列（R17），均可空，存量行为 NULL：
    pub src_mac: Option<String>,
    pub dst_mac: Option<String>,
    pub vlan_id: Option<i64>,
    pub earliest_send_offset_ns: Option<i64>,
    pub latest_send_offset_ns: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFlowStreamsResult {
    pub streams: Vec<FlowStreamRow>,
}
```

查询：`SELECT stream_seq, class, pcp, period_us, frame_bytes, count, talker, listener, max_latency_us, redundant, src_mac, dst_mac, vlan_id, earliest_send_offset_ns, latest_send_offset_ns FROM flow_streams WHERE session_id = ? ORDER BY stream_seq`

入参 `ListFlowStreamsRequest { session_id: String }`，Tauri command 名称：`list_flow_streams`。

### R8 · 前端调用函数

`src/app/components/workspace-pane/flow-sim.ts` 追加：

```ts
export interface FlowStreamRow {
  streamSeq: number;
  class: "ST" | "RC" | "BE";
  pcp: number;
  periodUs: number;
  frameBytes: number;
  count: number;
  talker: string;
  listener: string;
  maxLatencyUs: number | null;
  redundant: boolean;
  // S4 扩表新列（R17），存量行为 null：
  srcMac: string | null;
  dstMac: string | null;
  vlanId: number | null;
  earliestSendOffsetNs: number | null;
  latestSendOffsetNs: number | null;
}
export interface ListFlowStreamsResult {
  streams: FlowStreamRow[];
}
export async function invokeListFlowStreams(sessionId: string): Promise<ListFlowStreamsResult> {
  return await invoke<ListFlowStreamsResult>("list_flow_streams", { request: { sessionId } });
}
```

### R9 · 流量列表 UI 组件

流量列表 tab 内新建 `FlowStreamList` 组件。每行显示：

| 列 | 内容 |
|----|------|
| 类别徽章 | `ST` / `RC` / `BE` 有色小徽章（CSS class `flow-class-badge st/rc/be`） |
| 序号 | `F{streamSeq}` |
| 路径 | `{talker} → {listener}` |
| 周期 | `{periodUs} µs` |
| 帧长 | `{frameBytes} B` |
| 操作 | 「详情」按钮 |

徽章配色：ST = `CHART_COLORS[0]`（#0072B2）蓝，RC = `CHART_COLORS[2]`（#009E73）绿，BE = `CHART_COLORS[1]`（#E69F00）琥珀。

点击某行高亮该行（`aria-selected="true"`），同时驱动 S3 画布高亮。再次点击同行取消选中。

### R10 · 空态

流量列表为空时（`streams.length === 0`），复用 `PanelCta` 居中 CTA：

```
label: "录入流量"
hint: "请通过对话描述需要规划的 TSN 流，agent 将自动录入流量参数。"
disabled: !inFlowStage
```

空态不显示「详情」入口。

### R11 · 数据刷新触发

复用已有 `useSessionDbListener`，DB 变更后重拉 `list_flow_streams`（同 `refreshPlanQuery` 模式）。挂载 / 切会话先回 loading，等数据落定再渲染。

---

## S3 · 拓扑流路径高亮

### R12 · 新 Rust 命令 `get_flow_route_map`

计算本 session 所有流的拓扑路径（link_seq 集合），供前端高亮用。

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRouteEntry {
    pub stream_seq: i64,
    pub link_ids: Vec<String>,          // ["link-0","link-3"]，ST/BE 单路径
    pub plane_b_link_ids: Option<Vec<String>>,  // RC 才有，平面 B 路径
}
```

计算方法：复用 `flow_route.rs` 的 `derive_route()`（ST/BE）和 `derive_redundant_routes()`（RC，plane A + B），把返回的 `link_seqs: Vec<i64>` 格式化为 `"link-{seq}"` 对齐 `linkRowId()` 的命名。

**双平面拓扑 plane 参数**（对齐 `flow_plan_command.rs` KTD6）：先检查当前 session 是否有任意一条 link 的 `styles_json` 含 `plane` 字段（单平面拓扑所有 link 无此字段）。若是双平面拓扑，ST/BE 传 `plane=Some("A")`——传 `None` 会命中 BFS 等长多路径歧义（AMBIGUOUS_ROUTE）导致路由失败。RC 仍走 `derive_redundant_routes()`（内部自动取 A+B）。单平面拓扑 ST/BE 传 `plane=None` 不变。

路由失败（拓扑里无可达路径）不中断整批——跳过该条流，不进返回列表（`link_ids=[]` 会导致误取消高亮，跳过更诚实）。

Tauri command：`get_flow_route_map`，入参：`GetFlowRouteMapRequest { session_id: String }`。

### R13 · 前端路由 map 类型与调用

```ts
export interface FlowRouteEntry {
  streamSeq: number;
  linkIds: string[];
  planeBLinkIds?: string[];
}
export async function invokeGetFlowRouteMap(sessionId: string): Promise<FlowRouteEntry[]>
```

`list_flow_streams` 成功后跟着调用 `get_flow_route_map`，结果存为 `flowRouteMap: Map<number, FlowRouteEntry>`（key = streamSeq）。

### R14 · 选中流 state

`App.tsx` 新增：

```ts
const [selectedFlowSeq, setSelectedFlowSeq] = useState<number | null>(null);
```

切会话重置为 `null`。透传给 `FlowPanel`（驱动列表行高亮）和 `WorkspacePane` / 画布（驱动边高亮）。

点击流量列表某行 → `setSelectedFlowSeq(streamSeq)`（再次点击同行 → `setSelectedFlowSeq(null)`，取消选中）。

### R15 · 画布边高亮渲染

`WorkspacePane/index.tsx` 中的 `flowTopology` useMemo 扩展：当 `selectedFlowSeq !== null` 且 `flowRouteMap` 已加载时，追加 `decorateFlowHighlightEdges(flow.edges, highlightEdgeIds)` 步骤，对齐 `decorateTimesyncEdges` 的模式：

```ts
function decorateFlowHighlightEdges(edges: Edge[], highlightIds: Set<string>): Edge[] {
  return edges.map((e) => ({
    ...e,
    className: highlightIds.size === 0
      ? e.className                                  // 无选中，原样
      : highlightIds.has(e.id)
        ? `${e.className ?? ""} flow-highlighted`    // 命中 → 高亮
        : `${e.className ?? ""} flow-dimmed`,        // 未命中 → 淡化
  }));
}
```

`highlightEdgeIds` = `flowRouteMap.get(selectedFlowSeq)?.linkIds.concat(planeBLinkIds ?? [])` 转 `Set<string>`。

CSS 规格（在 `tsn-topology-canvas.css` 或对应 CSS 文件追加）：

```css
/* 未选中 dim */
.react-flow__edge.flow-dimmed { opacity: 0.2; transition: opacity 0.15s; }
/* 选中高亮：实线加粗 + CHART_COLORS[3] 橙色（与平面色差异化）*/
.react-flow__edge.flow-highlighted path.react-flow__edge-path {
  stroke: #D55E00;
  stroke-width: 3;
  stroke-dasharray: 6 3;
}
```

（`CHART_COLORS[3]` = `#D55E00` 橙红，与 plane-a/plane-b 蓝绿色系有视觉区分。）

### R16 · 取消高亮行为

- 再点同一行 → `selectedFlowSeq = null`，边恢复原始 className
- 切换流量列表 tab 以外的其他 tab → 保持 `selectedFlowSeq` 不变（画布始终在背景显示，切 tab 不清除选中，保持视觉锚点）
- 切会话 → 重置为 `null`

---

## S4 · 可编辑流详情弹框 + 扩表

### R17 · DB schema 扩展

`flow_streams` 追加 5 列（命令式 pragma 守卫，模式同 `ensure_topology_nodes_name_column`）：

```sql
-- 新列（均可 NULL，兼容存量行）：
src_mac                TEXT     -- 源 MAC 地址（48位冒号分隔字符串，可 NULL）
dst_mac                TEXT     -- 目标 MAC 地址
vlan_id                INTEGER  -- VLAN ID（0–4094，可 NULL）
earliest_send_offset_ns INTEGER  -- 最早发送偏移（ns，可 NULL）
latest_send_offset_ns  INTEGER  -- 最晚发送偏移（ns，可 NULL）
```

**不新增 jitter 列**：jitter 是软仿实测输出，存在 `verify_tas` 返回的 `VerifyTasResult.perStream` 内，不属于流参数。

**三处同步更新（缺一不可）：**
1. `ensure_flow_streams_extended_columns()`（pragma-guard ALTER TABLE，存量 DB 补列）
2. `db.rs` 的 `FLOW_DOMAIN_SCHEMA_SQL` CREATE TABLE 定义——新建 session 的 DB 必须包含 5 列，否则全新 DB 无这些列
3. `db.rs` 的 `SESSION_SCOPED_TABLES` 中 `flow_streams` 的列名列表——导出时 INSERT...SELECT 靠此列表复制数据，漏掉则导出时静默丢列

导入旧文件（无新列的旧导出）：import 时对应字段默认 NULL，可正常运行，无需额外处理。

**本期 5 列为存储/展示用途**，不参与门控规划（`get_flow_plan`）或路由计算；规划消费字段仍为原有 10 列（pcp / period_us / frame_bytes / count / max_latency_us / talker / listener / class / redundant / stream_seq）。

### R18 · DB 迁移函数

`src-tauri/src/db.rs` 新增 `pub async fn ensure_flow_streams_extended_columns(pool: ...) -> Result<(), sqlx::Error>`，按列名逐一检查 `pragma_table_info('flow_streams')` 后 `ALTER TABLE flow_streams ADD COLUMN ...`。

在 `session_store.rs::connect_app_database()` 的迁移序列末尾调用，加在 `ensure_flow_streams_rename` 之后。

### R19 · FlowStreamRow 含新列（已并入 R7/R8 定义）

R17 新增的 5 列随 `list_flow_streams` 一并返回——字段已直接写进 R7 的 Rust 结构体 / SELECT 语句与 R8 的 TS 接口（`srcMac` / `dstMac` / `vlanId` / `earliestSendOffsetNs` / `latestSendOffsetNs`，均可空）。弹框（R20）读同一查询结果，不发第二次请求。

### R20 · 流详情弹框组件

点击流量列表某行「详情」按钮弹出 `FlowDetailModal`（新组件）。弹框结构：

**只读字段：**
- 流序号 (`F{streamSeq}`)
- 类别 (`ST` / `RC` / `BE` 徽章）
- 发送端 / 接收端（`talker → listener`）
- 是否冗余（`redundant`，RC 才显示）

**可编辑字段（表单）：**
| 字段 | 类型 | 约束 |
|------|------|------|
| PCP 优先级 | **只读显示** | 由 class 决定（ST=7, RC=6, BE=0），不可手动改，修改会破坏 gate7 过滤 |
| 发送周期 (µs) | number input | 正整数 |
| 帧大小 (bytes) | number input | 正整数 |
| 帧数/周期 | number input | 正整数 |
| 最大延迟 (µs) | number input / 空 | 可空，空=规划推导 |
| 源 MAC | text input | 可空（仅显示/存储，本期不参与规划计算） |
| 目标 MAC | text input | 可空（仅显示/存储，本期不参与规划计算） |
| VLAN ID | number input | 0–4094，可空（仅显示/存储，本期不参与规划计算） |
| 最早发送偏移 (ns) | number input | 可空（仅显示/存储，本期不参与规划计算） |
| 最晚发送偏移 (ns) | number input | 可空（仅显示/存储，本期不参与规划计算） |

弹框操作：「保存」（提交 `update_flow_stream`）/ 「取消」（丢弃改动）。ESC / 点遮罩 = 取消。无自动保存。

**UI 状态**：保存期间按钮置 loading（禁用避免重复提交）；服务端返回错误时在弹框内显示红色错误信息（不关闭弹框，让用户看到原因并可重试或取消）。

### R21 · 新 Rust 命令 `update_flow_stream`

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFlowStreamRequest {
    pub session_id: String,
    pub stream_seq: i64,
    // 全量写——前端始终传完整弹框快照，Rust 无条件写全部可编辑列：
    pub period_us: i64,
    pub frame_bytes: i64,
    pub count: i64,
    pub max_latency_us: Option<i64>,          // null = 置 NULL
    pub src_mac: Option<String>,
    pub dst_mac: Option<String>,
    pub vlan_id: Option<i64>,
    pub earliest_send_offset_ns: Option<i64>,
    pub latest_send_offset_ns: Option<i64>,
}
```

`Option<Option<T>>` 不可用（serde JSON 无法区分缺字段与 null，`Some(None)` 不可达，项目 Cargo.toml 无 `serde_with`）。改为全量写：前端「保存」时发完整弹框当前值，Rust 直接全量 UPDATE 所有可编辑列。

执行 UPDATE 前：
1. 调用 `validate_stream()`（`flow_verify.rs`）校验 period 整除门控周期、帧≤MTU 等不变量；失败返回 Err，前端展示错误，不写 DB
2. 调用 `snapshot_pre_image(FLOW_DOMAIN)` 写撤销快照（对齐 `flow_sidecar_routes.rs`）

UPDATE 后检查 `rows_affected`：若为 0（stream_seq 不存在或 session_id 不匹配）返回 Err。

Tauri command 名称：`update_flow_stream`。

### R22 · 保存后行为

「保存」成功后：
1. 关闭弹框
2. 刷新流量列表（重调 `list_flow_streams`）
3. 当本次变更涉及**规划消费字段**（`period_us` / `frame_bytes` / `count` / `max_latency_us`）时，FlowPanel 顶部显示黄色 banner：「参数已修改，请点击「重新规划」以更新门控表。」banner 在用户下一次规划完成后消失（或用户手动关闭）。仅修改 `src_mac` / `dst_mac` / `vlan_id` / `earliest_send_offset_ns` / `latest_send_offset_ns` 时**不触发** banner（本期无规划消费者）。

**Banner state 位置**：state 挂在 `FlowPanel` 层级（非流量列表 tab 内部），避免用户切到「门控规划」tab 点「重新规划」时因 tab 卸载导致 banner state 丢失。

保存**不触发**自动重新规划。

### R23 · agent-native 对等 — Defer

UI 编辑 `flow_streams` 引入了第二条写路径。agent 目前只能通过对话录入流（写同一张表）。本期不做 agent 侧 `update_flow_stream` MCP 工具和 SKILL.md 指引，作为独立待办推后。

---

## 后端 API 契约摘要

| 命令 | 入参 | 返回 |
|------|------|------|
| `list_flow_streams` | `{ sessionId }` | `{ streams: FlowStreamRow[] }` |
| `get_flow_route_map` | `{ sessionId }` | `FlowRouteEntry[]` |
| `update_flow_stream` | `UpdateFlowStreamRequest` | `null`（成功） |

---

## DB Schema 变更

```sql
-- 在 ensure_flow_streams_extended_columns() 内逐列 pragma-guard 执行：
ALTER TABLE flow_streams ADD COLUMN src_mac TEXT;
ALTER TABLE flow_streams ADD COLUMN dst_mac TEXT;
ALTER TABLE flow_streams ADD COLUMN vlan_id INTEGER;
ALTER TABLE flow_streams ADD COLUMN earliest_send_offset_ns INTEGER;
ALTER TABLE flow_streams ADD COLUMN latest_send_offset_ns INTEGER;
```

无 `PRAGMA user_version` 版本号——项目全用 pragma_table_info 列守卫模式，保持一致。

---

## 验收标准

### S1 子 tab
- [ ] 四个子 tab 渲染正确，硬件部署灰显、按下无响应、hover 显 tooltip
- [ ] 切 tab 不中断进行中的规划/软仿命令（App-level state 隔离）
- [ ] 切会话后 activeFlowSubTab 重置为「流量列表」
- [ ] 现有 GCL 图表在「门控规划」tab 正常显示，软仿结果在「软仿模拟」tab 正常显示

### S2 流量列表
- [ ] agent 录入 ST/RC/BE 流后，切到「流量列表」tab 正确回显每条流
- [ ] 徽章颜色三类型有明确视觉区分
- [ ] 空态 CTA 显示，已录流时不显示
- [ ] DB 变更（agent 录入新流）后列表自动刷新

### S3 拓扑高亮
- [ ] 点击某行 → 该流经过的所有 link 在画布上高亮（橙色虚粗线），其余边淡化
- [ ] RC 流：A + B 两平面路径同时高亮
- [ ] 再次点击同行 → 取消高亮，画布恢复
- [ ] 切会话 → 高亮清除

### S4 弹框 + 扩表
- [ ] 点「详情」弹出弹框，所有字段值与 DB 数据一致
- [ ] 修改可编辑字段后「保存」成功，DB 值已更新
- [ ] 保存后列表刷新，显示黄色 re-plan 提示 banner
- [ ] 「取消」或 ESC 不写入 DB
- [ ] 存量拓扑（无新增列数据）打开弹框时新增字段显示为空，不 panic

---

## Defer 项

- S3 步骤 2：画布旁流图例 + hover 淡出交互（本期只做选中高亮）
- S3 步骤 3：多流同屏并行车道（`geom_edge_parallel` 偏移色带）
- agent-native 对等：`update_flow_stream` MCP 工具 + SKILL.md 指引（R23）
- 硬件部署子 tab 实际能力（flow 侧设备下发）

## Open Questions

- **并发写冲突（P1, defer）**：agent 写 `flow_streams`（录入/更新流）与用户在 modal 打开期间的编辑同时发生时，agent 响应落库会覆盖弹框里未保存的修改。本期无并发写保护机制（无乐观锁/版本字段）。后续方案待独立 ideation（可选：保存前重载对比、版本字段、modal 打开时加版本戳）。
- **verify 产出陈旧判决（P2, defer）**：banner 提示「请重新规划」但不拦截「软仿模拟」按钮。若用户在重新规划之前先跑软仿，软仿结果基于旧 GCL，判决可能陈旧。本期认为不值得增加阻断，标注为已知行为差距。
