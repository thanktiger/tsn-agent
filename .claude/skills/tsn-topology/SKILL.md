---
name: tsn-topology
description: TSN Agent 拓扑阶段指引。拓扑固定规则通过 tsn_topology MCP 工具或项目本地 topology domain 落地；本 skill 不维护独立 builder/validator 语义，也不导出 HTML。
---

# TSN 拓扑 Skill Shim

本 skill 只负责指导 Agent 在 TSN Agent 桌面应用里完成拓扑阶段，不再作为拓扑规则的事实来源。

## 当前边界

- 拓扑模板、初始化、校验、artifact 构建、inspect 和 P0 `apply_operations` 由 `tsn_topology` MCP 工具或项目本地 topology domain 执行。
- 自然语言理解、模板选择、在 inspect rows 中定位目标、用户澄清和阶段推进仍由 Agent / Project 层负责。
- `generate_project`、time sync、flow planning、simulation、export 不属于 topology MCP。
- MCP tool 返回值已是 sidecar 结构化领域响应（不再需要 `responseMode` / `topologyFullAllowed` 字段）；`topology.initialize`（整表重建）与 `topology.apply_operations`（增量编辑）落 P0 表后响应携带 `summary.mutationId`，worker 据此合成 `WorkflowStageResult`。
- 不要把完整 artifact、端口表、MAC 表或完整 changeSet 写进对话。
- 最终工程状态只接受 worker/app-runtime 基于 trusted topology result 合成的结构化 `WorkflowStageResult`；不要让模型写 `stage-result.json`。

## 初始化路径

当当前 project 没有拓扑时：

1. 从用户需求和场景默认值提取结构化参数。
2. 调用 `mcp__tsn_topology__topology_describe_templates` 获取可用模板目录与每个模板的参数 schema。**参数字段名、默认值、上下限以该返回为准，不在本 skill 复述。**
3. 按下面「场景 → 模板」决策树选择 `templateId` 与参数后调用 `mcp__tsn_topology__topology_initialize`；它会直接写入工程数据库并返回 `mutationId`（右侧据此落图），同时替换该会话已有拓扑。
4. 必要时调用 `mcp__tsn_topology__topology_validate` 和 `mcp__tsn_topology__topology_build_artifacts` 获取 summary。
5. 用中文说明当前拓扑摘要并等待用户确认；不要输出完整 topology JSON 或 stage result JSON。

### 场景 → 模板选择

- **默认 `generic-line`**：用户描述"N 台交换机线型/串联，每台接 M 个端系统"，或未指定拓扑形态时。参数 `switchCount=N`、`endSystemsPerSwitch=M`、`dataRateMbps=用户速率`（缺省按 `describe_templates` 默认）。
  - 示例："4 个交换机每个接 5 个端系统" → `generic-line`，`switchCount=4`，`endSystemsPerSwitch=5`。
- **`generic-ring`**：用户明确要环形、交换机环网、或环形冗余时。参数同 `generic-line`。
  - 示例："航天双环冗余""交换机组成环网" → `generic-ring`。
- **`dual-plane-redundant`（Phase B，暂不可选）**：`describe_templates` 会列出该模板，但 `topology_initialize` 当前拒绝它。用户要 A/B 双平面、端系统双归属冗余时，说明该模板暂未开放，引导用 `generic-ring` 近似或记录需求待 Phase B —— 不要尝试用它初始化。

节点类型语义、显示名映射、默认互联规则见 `docs/rules.md`。

## 已有拓扑编辑路径

当当前 project 已经有拓扑，且用户要插入交换机或调整连接时：

1. 调用 `mcp__tsn_topology__topology_inspect`（无参数）获取该会话全部拓扑 rows：nodes（imac/syncName/nodeType/syncType/x/y/insertOrder）+ links（linkSeq/name/srcImac/dstImac/stylesJson）。
2. 在 rows 中按 syncName/nodeType/连接关系定位目标节点与链路，得到精确的 imac / linkSeq；如用户引用不唯一，先用中文数字编号选项向用户澄清。**显示名映射**：画布显示名 = 类型前缀 + syncName（SW-1 即 syncName="1" 的交换机，ES-4 即 syncName="4" 的端系统），用户提到 SW-N/ES-N 时按 syncName 精确等于 "N" 匹配，不要按列表顺序或「第 N 台」折算。
3. 构造原子 operations（如插入交换机 = `[link_delete, node_add, link_add, link_add]`）：新节点的 `syncType`/`nodeType` 复制 inspect 返回的同类节点原文，新链路的 `stylesJson` 参照既有链路；新 `imac`/`linkSeq` 必须避开 rows 中已占用的值。
4. 调用 `mcp__tsn_topology__topology_apply_operations`；worker 从响应的 `summary.mutationId` 合成 `WorkflowStageResult`，不把 rows 或 changeSet 写进对话。
5. 超时重试时逐字节复用上一次的同一 operations（相同 imac/linkSeq），不要重新分配 —— 重新分配 linkSeq 会产生重复的平行链路。
6. 不要用 `topology.initialize` 重建已确认的拓扑（会整表重排节点命名）；它只用于「从 0 生成」与「换模板」。

支持的 op：`node_add` / `node_update` / `node_delete` / `link_add` / `link_delete`（字段 camelCase，详见工具 schema）。「移动节点」「改属性」用 `node_update`；`node_add` 撞已占用 imac 会报 `IMAC_TAKEN`。

## 回复边界

- 用中文简要说明当前拓扑阶段结果，并等待用户确认或继续修改。
- 不要输出 stage result JSON，不要写 `TSN_AGENT_STAGE_RESULT_PATH`。
- 不要声称时间同步、流量规划、导出文件或仿真已经完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
