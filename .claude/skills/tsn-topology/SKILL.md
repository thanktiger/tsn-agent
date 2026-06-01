---
name: tsn-topology
description: TSN Agent 拓扑阶段指引。拓扑固定规则通过 tsn_topology MCP 工具或项目本地 topology domain 落地；本 skill 不维护独立 builder/validator 语义，也不导出 HTML。
---

# TSN 拓扑 Skill Shim

本 skill 只负责指导 Agent 在 TSN Agent 桌面应用里完成拓扑阶段，不再作为拓扑规则的事实来源。

## 当前边界

- 拓扑模板、初始化、校验、artifact 构建、inspect 和 P0 `apply_operations` 由 `tsn_topology` MCP 工具或项目本地 topology domain 执行。
- 自然语言理解、模板选择、selector 消歧、用户澄清和阶段推进仍由 Agent / Project 层负责。
- `generate_project`、time sync、flow planning、simulation、export 不属于 topology MCP。
- MCP tool response 默认使用 summary；只有 `topology.initialize` / `topology.apply_operations` 为了让 worker 捕获 full `IntermediateTopology` 并合成 `WorkflowStageResult` 时，才允许请求 `responseMode: "full"` 且 `topologyFullAllowed: true`。
- 不要把完整 artifact、端口表、MAC 表或完整 changeSet 写进对话。
- 最终工程状态只接受 worker/app-runtime 基于 trusted topology result 合成的结构化 `WorkflowStageResult`；不要让模型写 `stage-result.json`。

## 初始化路径

当当前 project 没有拓扑时：

1. 从用户需求和场景默认值提取结构化参数。
2. 调用 `mcp__tsn_topology__topology_describe_templates` 获取可用模板目录。
3. 选择明确的 `templateId` 和参数后调用 `mcp__tsn_topology__topology_initialize`；需要右侧落图时，请求 full topology 并让 worker 捕获。
4. 必要时调用 `mcp__tsn_topology__topology_validate_intermediate` 和 `mcp__tsn_topology__topology_build_artifacts` 获取 summary。
5. 用中文说明当前拓扑摘要并等待用户确认；不要输出完整 topology JSON 或 stage result JSON。

## 已有拓扑编辑路径

当当前 project 已经有拓扑，且用户要插入交换机或调整连接时：

1. Project/Agent 层先把自然语言引用解析为稳定 node/link ID。
2. 如引用不唯一，先向用户澄清；不要让 MCP 猜测。
3. 调用 `mcp__tsn_topology__topology_inspect` 查询相关节点、链路和端口占用 summary。
4. 对 P0 插入交换机场景，构造 `[link.delete, node.add, link.add, link.add]` operations。
5. 先调用 `mcp__tsn_topology__topology_apply_operations` 做 dryRun；对话中只总结变化计数、风险和确认点。
6. 用户确认后，由 Project 层用同一 current topology snapshot 和同一 operations 重放 apply；需要右侧落图时，让 worker 捕获 updated `IntermediateTopology` 并合成 `WorkflowStageResult`，不把 full changeSet 写进对话。

P0 不支持 `node.delete`、`node.update`、`link.update`，遇到这些需求时说明需要后续完整 CRUD 能力。

## 兼容脚本

迁移期保留 `tools/run-topology-skill.js`，只用于旧 fixture 或 legacy artifact 兼容路径。该脚本生成四份 JSON：

- `topology.json`
- `topo_feature.json`
- `data-server.json`
- `mac-forwarding-table.json`

不再生成 HTML。

## 回复边界

- 用中文简要说明当前拓扑阶段结果，并等待用户确认或继续修改。
- 不要输出 stage result JSON，不要写 `TSN_AGENT_STAGE_RESULT_PATH`。
- 不要声称时间同步、流量规划、导出文件或仿真已经完成。
- 不要把完整端口表、完整 MAC 表、完整 artifact 或完整 changeSet 写进对话。
