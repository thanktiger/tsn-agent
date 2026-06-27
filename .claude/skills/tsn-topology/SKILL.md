---
name: tsn-topology
description: HIBridge Agent 拓扑阶段主索引。承载场景无关的领域语义、操作流程与场景路由；各场景的模板选择与推荐参数在 references/<场景id>.md。
---

<!-- 消费方式：每次运行注入（主索引，场景无关）。场景细节见 references/，由系统按当前场景自动注入对应文件。 -->

# TSN 拓扑 Skill 主索引

这是拓扑阶段**可编辑指引**的主索引，只放开工前必须知道的场景无关内容：领域语义、操作流程、场景路由。各场景的模板怎么选、参数推荐多少，在 `references/<场景id>.md` 里按场景分开放。

## 参数从哪来

- **推荐默认值看场景 reference**（见下方「场景路由」）。读出来后要**显式传给 `topology_initialize`**——它不替你补默认，缺参数会返回 `requires_clarification`。
- **参数的合法范围（类型 / 上下限 / 枚举）以 `topology_describe_templates` 的返回为准**，本文件和 reference 都不复述合法域。
- 坐标布局、MAC/IP 派生、链路数、结构校验这些生成细节由 MCP 确定性算好，指引文件不定义生成规则。

## 场景路由

当前场景 id 在阶段结构化输入的 `scenarioConfigId` 字段。系统已按这个 id，把对应场景的 reference 正文自动注入到下方场景分隔标记之后；其它场景的文件可按注入末尾给出的「可用参考文件」绝对路径用 Read 查阅。

| `scenarioConfigId` | 场景 | reference 文件 |
|---|---|---|
| `generic-tsn` | 通用 TSN | `references/generic-tsn.md` |
| `aerospace-onboard` | 箭载 TSN | `references/aerospace-onboard.md` |
| 未知 / 缺失 | 按通用处理 | `references/generic-tsn.md` |

调 `topology_describe_templates` 时带上 `scenario` 参数（值 = 用户需求对应场景的 `scenarioConfigId`），拿到的是该场景的模板候选集。用户需求超出当前场景的模板集时，先去掉 `scenario` 重查全量再回答。

## 领域语义

### 节点类型与显示名

| 领域概念 | 库值 `node_type` | 前缀 | 说明 |
|---|---|---|---|
| 交换机 | `switch` | `SW` | TSN 交换机 |
| 端系统 | `endSystem` | `ES` | TSN 端系统 |
| 控制器 | `server` | — | 当前模板不生成 server；画布对非 switch 一律按端系统显示 |

- **显示名怎么定**（显示名的唯一权威规则）：画布显示名**优先用节点的 `name`**（initialize 落库的逻辑名，如 `SW-1`/`ES-1`）；没有 `name` 才回退成 前缀+`syncName`。用户提到 `SW-N`/`ES-N` 时，先拿 `topology_inspect` 返回里节点的 `name` 精确匹配，匹配不到再用 前缀+`syncName` 的派生名匹配——**不要**按列表顺序或"第 N 台"去折算。

### 链路速率

`dataRateMbps` 是整数 Mbps，常见取值 `{10, 100, 1000, 10000}`，1000 最常用。确切合法域以 `topology_describe_templates` 为准。

## 从零初始化（当前 project 还没有拓扑）

1. 从用户需求和当前场景 reference 的「推荐参数默认」提取结构化参数。**关键参数（规模——交换机 / 端系统数量、拓扑形态、要不要冗余）缺失或不明确时，先用中文编号选项问用户**（把场景推荐默认值列为其中一个选项、标「推荐」），用户选定后再生成——别默默套默认值就直接把拓扑摆出来。**用户只报了拓扑名或组网名（如「双平面双跳」「五跳线性」「创建箭载拓扑」）也一样**：preset 表替他补上的规模 / 特征 / 冗余是你做的假设，不算他已说清——先把这些隐含值用中文列出来确认，再 initialize。只有用户把规模、形态、冗余都显式说全了，才直接生成、不必多问。
2. 调 `mcp__tsn_topology__topology_describe_templates`（带 `scenario`），拿模板目录和参数 schema（字段名和**合法域**以这个返回为准）。
3. 按场景 reference 的「按类型选模板」表定下 `templateId` 和参数（双平面的完整参数结构照 `describe_templates` 返回的 `example` 抄），**显式**传给 `mcp__tsn_topology__topology_initialize`；它直接写工程数据库、返回 `mutationId`（右侧据此落图），并替换该会话已有的拓扑。
4. 用 `mcp__tsn_topology__topology_inspect` 看落库结果。
5. 用中文讲一下当前拓扑摘要，等用户确认。（`initialize` 已经校验并落库，不用再 `validate` 复检。）

## 已有拓扑的增量编辑（当前 project 已有拓扑）

用户要插交换机、改连接时：

1. 调 `mcp__tsn_topology__topology_inspect`（无参数）拿该会话全部 rows：nodes（mid/name/nodeType/x/y/insertOrder）+ links（linkSeq/name/srcNode/dstNode/srcPort/dstPort/stylesJson）。节点身份是 `mid`（逻辑序号），连线两端 `srcNode`/`dstNode` 引用节点的 mid；端口号是独立列 `srcPort`/`dstPort`（结构事实源）。
2. 在 rows 里按 name/nodeType/连接关系找到目标节点和链路，拿到准确的 mid / linkSeq。用户的指代不唯一时，先用中文数字编号给选项问清楚。匹配按上面「显示名怎么定」来。
3. 构造原子 operations（比如插一台交换机 = `[link_delete, node_add, link_add, link_add]`）：新节点的 `nodeType` 照抄 inspect 里同类节点的原文，`srcNode`/`dstNode` 填两端节点的 mid；新的 `mid`/`linkSeq` 要避开 rows 里已经占用的值。**链路端口走显式字段**：`link_add` 必须传 `srcPort`/`dstPort`（两端节点实际占用的端口号，新生成拓扑 P0 起编）——端口是结构事实源、直写库列，**不再塞进 `stylesJson`**；漏传端口会被拒（`LINK_PORT_MISSING`），补全后重试。`stylesJson` 现在只放显示属性（plane 平面配色 / role 角色），可参照已有链路但不要照抄其端口。`node_add` 可带 `name` 显示名（交换机 `SW-N`、端系统 `ES-N`、服务器 `SRV-N`，序号 N 接现有同类最大值往下；省略则展示层按前缀+mid 派生，但若填了 name 必须合前缀、且各节点 name 不重名，否则结构校验报 `NODE_NAME_PREFIX`/`DUPLICATE_NAME`）。补名或改名用 `node_update`（同样带 `name`）。
4. 调 `mcp__tsn_topology__topology_apply_operations`；不要把 rows 或 changeSet 写进对话。
5. 看 `apply_operations` 返回的 `validation` 字段（库内结构校验结论，handler 自动追的），按它把结果告诉用户（见下「结构校验」）。

支持的 op：`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`（字段 camelCase，详见工具 schema）。"移动节点""改属性"用 `node_update`；`node_add` 撞上已占用的 syncName 会报 `SYNC_NAME_TAKEN`。

**删关键项前先问**：`node_delete`/`link_delete` 一个看起来关键的节点或链路（唯一骨干、双归属冗余的一侧、删了会断连通或降冗余）之前，先用中文跟用户确认再删，别擅自删——这类破坏性删除当前没有自动确认门，靠你主动问。

**撤销上一步**：用户说「撤销/回退刚才那步」时调 `mcp__tsn_workflow__undo_last_change`（无参数），把上一次结构改动（apply_operations / initialize）盖回到改动前。指代不清（不确定要撤哪一步）时先用中文编号选项问清楚再调，不擅自撤；本工具不设单独确认闸，调用即直接执行。撤销后工程库已回退，回答或继续编辑前先 `topology.inspect` 重新确认当前拓扑，勿假设上一轮改动仍在。

## 结构校验（apply 改完拓扑后自动带）

`apply_operations` 提交成功（非 dryRun）后，handler **自动**追一次库内结构校验，把结论放进返回的 `validation` 字段：连通性、端口配对、孤立节点、转发可达、节点角色、编号重复、命名规范（交换机 `SW-`、端系统 `ES-` 前缀）。**你不用再单独调 validate**。（`initialize` 已经校验过，不验。）

- `validation.ran` 为 `false` → 校验调用本身没成功（基础设施问题，不代表结构有错）；`ran` 为 `true` 才看下面。
- `validation.errors[]`（中文）非空 → **把问题逐条如实告诉用户、让他改**，不要声称结构没问题。
- `errors[]` 为空 → 结构没问题（仅结构级），简短带过即可。
- 这是 `仅结构级` 校验：只说明结构连通可达，**不**代表时延/调度已验（那是后面阶段的事）。
- 需要单独复查库内结构时，可调 `mcp__tsn_topology__topology_validate`（**不传任何参数**）。

## 回复边界

- 用中文简要说当前拓扑阶段的结果，等用户确认或继续改。
- 不要声称时间同步、流量规划、导出文件已经完成。
- 当前没有接入 OMNeT++/远程仿真 runner：遇到"启动仿真""SSH 执行""远程运行""稍后通知结果"这类请求，要说明本次不会真的执行、也不会后台通知，**不得**声称仿真已启动或已完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
