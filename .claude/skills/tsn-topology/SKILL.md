---
name: tsn-topology
description: TSN Agent 拓扑阶段主索引。承载场景无关的领域语义、操作流程与场景路由；各场景的模板选择与推荐参数在 references/<场景id>.md。
---

<!-- 消费方式：每次运行注入（主索引，场景无关）。场景细节见 references/，由系统按当前场景自动注入对应文件。 -->

# TSN 拓扑 Skill 主索引

本文件是拓扑阶段**可编辑的指引事实源**的主索引：只装开工前必知的场景无关内容（领域语义、操作流程、场景路由）；各场景的模板选择、推荐参数默认与规范图 preset 在 `references/` 下按场景拆分。

> **参数源声明**：
> - **推荐默认值由场景 reference 给出**（见下文「场景路由」），agent 须读取后**显式传给 `topology_initialize`**——`initialize` 不兜底默认，缺参会返回 `requires_clarification`。
> - **参数合法域（类型 / 上下限 / 枚举）以 `mcp__tsn_topology__topology_describe_templates` 返回为准**，本文件与 reference 均不复述合法域。
> - 拓扑生成细节（坐标布局、MAC/IP 派生、链路数公式、校验）由确定性 MCP 实现，指引文件不定义生成规则。

## 场景路由

当前场景 id 在阶段结构化输入的 `scenarioConfigId` 字段。系统已按该 id 自动注入对应场景 reference（正文在下方场景分隔标记之后）；其余场景文件可按注入末尾的「可用参考文件」绝对路径表用 Read 工具查阅。

| `scenarioConfigId` | 场景 | reference 文件 |
|---|---|---|
| `generic-tsn` | 通用 TSN | `references/generic-tsn.md` |
| `aerospace-onboard` | 箭载/舰载 TSN | `references/aerospace-onboard.md` |
| 未知 / 缺失 | 按通用处理 | `references/generic-tsn.md` |

调用 `topology_describe_templates` 时携带 `scenario` 参数（值 = 当前 `scenarioConfigId`）获取该场景的模板候选集；用户请求超出当前场景模板集时，先省略 `scenario` 重查全量再答复。

## 领域语义

### 节点类型与显示名映射

| 领域概念 | 库值 `node_type` | 缩写前缀 | 语义说明 |
|---|---|---|---|
| 交换机 | `switch` | `SW` | |
| 端系统 | `endSystem` | `ES` | 用户说的"端系统""端""网卡8/网卡9"都指端系统节点（"网卡"是用户口头叫法，**不是**交换机端口或物理网卡）。inspect rows 与 op 构造照抄该库值原文即可 |
| 控制器 | `server` | - | 当前模板不生成 server，画布对非 switch 一律按端系统显示 |

- 首期**排除** `T10` 类型。
- **显示名映射**：画布显示名**优先用节点的 `name`**（initialize 落库的逻辑名，如 `SW-1`/`ES-1`）；`name` 缺失时回退为 类型前缀 + `syncName`。用户提到 `SW-N`/`ES-N` 时，先按 rows 的 `name` 精确匹配，无 `name` 的节点再按 前缀+`syncName` 派生名匹配；不要按列表顺序或"第 N 台"折算。

### 链路速率参考

`dataRateMbps` 是整数 Mbps，常见取值 `{10, 100, 1000, 10000}`（1000 最常用）。确切合法域以 `describe_templates` 为准。

## 初始化路径

当当前 project 没有拓扑时：

1. 从用户需求和当前场景 reference 的「推荐参数默认」提取结构化参数。
2. 调用 `mcp__tsn_topology__topology_describe_templates`（带 `scenario` 参数）获取模板目录与参数 schema（字段名与**合法域**以该返回为准）。
3. 按场景 reference 的「模板选择」与「规范图 preset 表」确定 `templateId` 与参数，**显式**传给 `mcp__tsn_topology__topology_initialize`；它写入工程数据库并返回 `mutationId`（右侧据此落图），同时替换该会话已有拓扑。
4. 落库结果用 `mcp__tsn_topology__topology_inspect` 查看。
5. 用中文说明当前拓扑摘要并等待用户确认（`initialize` 已校验落库，无需再 validate 复检）。

## 已有拓扑编辑路径

当当前 project 已经有拓扑，且用户要插入交换机或调整连接时：

1. 调用 `mcp__tsn_topology__topology_inspect`（无参数）获取该会话全部拓扑 rows：nodes（syncName/name/nodeType/x/y/insertOrder）+ links（linkSeq/name/srcSyncName/dstSyncName/stylesJson）。节点身份是 `syncName`（逻辑序号），连线两端 `srcSyncName`/`dstSyncName` 引用节点 syncName。
2. 在 rows 中按 name/nodeType/连接关系定位目标节点与链路，得到精确的 syncName / linkSeq；如用户引用不唯一，先用中文数字编号选项向用户澄清。定位时按上文「显示名映射」匹配。
3. 构造原子 operations（如插入交换机 = `[link_delete, node_add, link_add, link_add]`）：新节点的 `nodeType` 复制 inspect 返回的同类节点原文，新链路的 `stylesJson` 参照既有链路、`srcSyncName`/`dstSyncName` 填两端节点的 syncName；新 `syncName`/`linkSeq` 必须避开 rows 中已占用的值。
4. 调用 `mcp__tsn_topology__topology_apply_operations`；不把 rows 或 changeSet 写进对话。
5. 按下文「结构验证」验一遍库内结构，把结论告诉用户。

支持的 op：`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`（字段 camelCase，详见工具 schema）。「移动节点」「改属性」用 `node_update`；`node_add` 撞已占用 syncName 会报 `SYNC_NAME_TAKEN`。

## 结构验证（apply_operations 改动拓扑后必做）

每次 `topology_apply_operations` 改动拓扑后，调用 `mcp__tsn_topology__topology_validate`（**不传任何参数**）验证库内已落库拓扑的结构：连通性、端口配对、孤立节点、转发可达、节点角色、编号重复。（`initialize` 已校验落库，不必复检。）

- `summary.errors[]`（中文）非空 → **如实把问题逐条告诉用户、让其修**，不要声称结构没问题。
- `errors[]` 为空 → 结构没问题（仅结构级），简短带过即可。
- 这是 `仅结构级` 校验：只代表结构连通可达，**不**代表时延/调度已验（那是后续阶段的事）。

## 回复边界

- 用中文简要说明当前拓扑阶段结果，并等待用户确认或继续修改。
- 不要声称时间同步、流量规划、导出文件或仿真已经完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
