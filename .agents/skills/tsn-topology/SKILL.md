---
name: tsn-topology
description: TSN Agent 拓扑阶段指引。拓扑固定规则由 tsn_topology MCP 工具（Rust sidecar）落地；本 skill 不维护独立 builder/validator 语义。
---

# TSN 拓扑 Skill 指引

本 skill 是拓扑阶段**可编辑的指引事实源**：承载领域语义、推荐参数默认值与"场景 → 模板"决策树，指导 Agent 在 TSN Agent 桌面应用里完成拓扑阶段。

> **参数源声明**：
> - **推荐默认值由本文件给出**（见下文「推荐参数默认」），agent 须读取后**显式传给 `topology_initialize`**——`initialize` 不再兜底默认，缺参会返回 `requires_clarification`。
> - **参数合法域（类型 / 上下限 / 枚举）以 `mcp__tsn_topology__topology_describe_templates` 返回为准**，本文件不复述合法域。
> - 拓扑生成细节（坐标布局、MAC/IP 派生、链路数公式、四份 artifact、校验）由确定性 MCP（`topology_compute.rs`）实现，本文件不定义生成规则。

## 当前边界

- 拓扑模板、初始化、校验、artifact 构建、inspect 和 P0 `apply_operations` 由 `tsn_topology` MCP 工具（Rust sidecar）执行。
- 自然语言理解、模板选择、在 inspect rows 中定位目标、用户澄清和阶段推进仍由 Agent / Project 层负责。
- `generate_project`、time sync、flow planning、simulation、export 不属于 topology MCP。
- MCP tool 返回值已是 sidecar 结构化领域响应；`topology.initialize`（整表重建）与 `topology.apply_operations`（增量编辑）落 P0 表后响应携带 `summary.mutationId`，worker 据此合成 `WorkflowStageResult`。
- 不要把完整 artifact、端口表、MAC 表或完整 changeSet 写进对话。
- 最终工程状态只接受 worker/app-runtime 基于 trusted topology result 合成的结构化 `WorkflowStageResult`；不要让模型写 `stage-result.json`。

## 领域语义

### 节点类型与显示名映射

| 领域概念 | 库值 `node_type` | 缩写前缀 | 语义说明 |
|---|---|---|---|
| 交换机 | `switch` | `SW` | |
| 端系统 | `networkcard` | `ES` | `networkcard` 是持久层遗留枚举值（旧系统借"网卡"一词当节点类型），**不是**交换机端口或物理网卡——交换机同样有网卡接口但与此无关。用户说的"端系统""端""网卡8/网卡9"都指端系统节点。inspect rows 与 op 构造照抄该库值原文即可 |
| 控制器 | `server` | - | 当前模板不生成 server，画布对非 switch 一律按端系统显示 |

- 首期**排除** `T10` 类型。
- **显示名映射**：画布显示名**优先用节点的 `name`**（initialize 落库的逻辑名，如 `SW-1`/`ES-1`）；`name` 缺失（增量添加/历史数据）时回退为 类型前缀 + `syncName`。用户提到 `SW-N`/`ES-N` 时，先按 rows 的 `name` 精确匹配，无 `name` 的节点再按 前缀+`syncName` 派生名匹配；不要按列表顺序或"第 N 台"折算。

### 链路速率参考

`dataRateMbps` 是整数 Mbps，常见取值 `{10, 100, 1000, 10000}`（标签 10M / 100M / 1000M 千兆 / 10000M 万兆；1000 最常用）。确切取值范围以 `describe_templates` 的 `dataRateMbps` 参数合法域为准。

## 推荐参数默认

下列为推荐默认值，agent 须在用户未指定时显式传给 `topology_initialize`（`initialize` 不兜底）：

- `switchCount`：缺省 `4`
- `endSystemsPerSwitch`：缺省 `2`
- `dataRateMbps`：缺省 `1000`

合法域（上下限 / 枚举）以 `describe_templates` 为准；本文件只给推荐值，不复述合法域。

## 初始化路径

当当前 project 没有拓扑时：

1. 从用户需求和上面「推荐参数默认」提取结构化参数。
2. 调用 `mcp__tsn_topology__topology_describe_templates` 获取可用模板目录与每个模板的参数 schema（字段名与**合法域**以该返回为准）。
3. 按下面「场景 → 模板」决策树选择 `templateId`，并把参数（含上述默认值或用户指定值）**显式**传给 `mcp__tsn_topology__topology_initialize`；它会直接写入工程数据库并返回 `mutationId`（右侧据此落图），同时替换该会话已有拓扑。
4. `initialize` 已内置结构校验并落库，**之后不要再调用 `topology_validate` 复检**（它只接受完整 IntermediateTopology JSON，不接受 `mutationId`/summary；initialize 不返回完整拓扑）。需要查看落库结果用 `mcp__tsn_topology__topology_inspect`。
5. 用中文说明当前拓扑摘要并等待用户确认；不要输出完整 topology JSON 或 stage result JSON。

### 场景 → 模板选择

- **默认 `generic-line`**：用户描述"N 台交换机线型/串联，每台接 M 个端系统"，或未指定拓扑形态时。语义上交换机线型互联（`SW1 -- SW2 -- ... -- SWN`），每台下挂固定数量端系统。参数 `switchCount=N`、`endSystemsPerSwitch=M`、`dataRateMbps=用户速率（缺省 1000）`。
  - 示例："4 个交换机每个接 5 个端系统" → `generic-line`，`switchCount=4`，`endSystemsPerSwitch=5`。
  - 只有用户明确要求"交换机相互独立""交换机之间不互联""每台交换机单独成星型"时，才省略交换机互联（由 MCP 模板参数表达，本文件不定义生成细节）。
- **`generic-ring`**：用户明确要环形、交换机环网、或环形冗余时。参数同 `generic-line`。
  - 示例："航天双环冗余""交换机组成环网" → `generic-ring`。
- **`dual-plane-redundant`**：用户要 A/B 双平面、端系统双归属冗余时使用。典型场景：宇航双平面验收的**单跳**（端系统经一组 A/B 交换机双归属）与**双跳**（两组 A/B 交换机级联）。参数字段与合法域以 `describe_templates` 返回为准。

## 已有拓扑编辑路径

当当前 project 已经有拓扑，且用户要插入交换机或调整连接时：

1. 调用 `mcp__tsn_topology__topology_inspect`（无参数）获取该会话全部拓扑 rows：nodes（imac/syncName/name/nodeType/syncType/x/y/insertOrder）+ links（linkSeq/name/srcImac/dstImac/stylesJson）。
2. 在 rows 中按 name/nodeType/连接关系定位目标节点与链路，得到精确的 imac / linkSeq；如用户引用不唯一，先用中文数字编号选项向用户澄清。定位时按上文「显示名映射」匹配 `SW-N`/`ES-N`（优先 `name` 精确匹配，无 `name` 再按 前缀+`syncName`）。
3. 构造原子 operations（如插入交换机 = `[link_delete, node_add, link_add, link_add]`）：新节点的 `syncType`/`nodeType` 复制 inspect 返回的同类节点原文，新链路的 `stylesJson` 参照既有链路；新 `imac`/`linkSeq` 必须避开 rows 中已占用的值。
4. 调用 `mcp__tsn_topology__topology_apply_operations`；worker 从响应的 `summary.mutationId` 合成 `WorkflowStageResult`，不把 rows 或 changeSet 写进对话。
5. 超时重试时逐字节复用上一次的同一 operations（相同 imac/linkSeq），不要重新分配 —— 重新分配 linkSeq 会产生重复的平行链路。

支持的 op：`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`（字段 camelCase，详见工具 schema）。「移动节点」「改属性」用 `node_update`；`node_add` 撞已占用 imac 会报 `IMAC_TAKEN`。

## 回复边界

- 用中文简要说明当前拓扑阶段结果，并等待用户确认或继续修改。
- 不要输出 stage result JSON，不要写 `TSN_AGENT_STAGE_RESULT_PATH`。
- 不要声称时间同步、流量规划、导出文件或仿真已经完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
