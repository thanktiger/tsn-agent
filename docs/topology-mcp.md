# TSN Topology MCP 契约

`tsn_topology` 是 P0 确定性拓扑服务。它只处理拓扑领域的固定规则，不做自然语言理解、不生成完整 project、不推进 workflow，也不导出 HTML。

## 工具列表

| MCP tool | 用途 |
|---|---|
| `topology.describe_templates` | 返回 P0 模板目录和参数约束。 |
| `topology.initialize` | 用结构化 `templateId` 和参数生成 `IntermediateTopology`。 |
| `topology.inspect` | 按稳定 selector 查询节点、链路、邻接和端口占用摘要。 |
| `topology.describe_artifacts` | 返回 legacy JSON artifact 的数量、大小和计数摘要。 |
| `topology.validate_intermediate` | 校验 `IntermediateTopology` 并返回结构化错误。 |
| `topology.build_artifacts` | 从 `IntermediateTopology` 构建四份 JSON artifact。 |
| `topology.validate_artifacts` | 校验 legacy JSON artifact 引用和基本 schema。 |
| `topology.apply_operations` | P0 支持 `link.delete`、`node.add`、`link.add` 的原子 operations。 |

Agent allowedTools 使用 SDK fully-qualified 名称，例如 `mcp__tsn_topology__topology_initialize`。

## 当前模板目录

`topology.describe_templates` 是唯一可信模板目录。P0 当前包含：

- `generic-line`：通用线型拓扑，接收 `switchCount`、`endSystemsPerSwitch`、`dataRateMbps`。
- `generic-ring`：通用环型拓扑，接收 `switchCount`、`endSystemsPerSwitch`、`dataRateMbps`。
- `dual-plane-redundant`：通用双平面/双归属/双冗余拓扑，必须接收显式 `planes`、`switches`、`switchGroups`、`endSystems`、`backbone`、`crossPlaneLinks`；不接收 `switchCount`、`endSystemsPerSwitch`、`endSystemCount` 这类 shortcut。

`aerospace-redundant` 不再是公开模板。箭载/航天等场景如果需要双平面拓扑，应由 Agent / Project 层选择 `dual-plane-redundant`，并把自然语言数量展开为明确节点和 A/B 接入关系。

## 数据边界

Agent-facing MCP response 默认使用 summary。只有 `topology.initialize` 和 `topology.apply_operations` 为了让 worker 捕获 full `IntermediateTopology` 并合成 `WorkflowStageResult` 时，允许 `responseMode: "full"` 且 `topologyFullAllowed: true`，返回范围只包含 full topology；完整 artifact、端口表、MAC 表和完整 changeSet 仍不得进入模型上下文。

本地 app-runtime、fake agent 和 project bridge 可直接调用 `src/topology` domain 获取 full 数据，再合成 `CanonicalTsnProjectV0`。完整 artifact、端口表、MAC 表和 full changeSet 只进入本地 project/session storage 和导出层，不进入诊断日志。

## 初始化与编辑

从 0 初始化：

1. Project/Agent 层从自然语言和 `ScenarioConfig` 得到结构化参数。
2. 调用 `topology.describe_templates` 确认模板目录。
3. 调用 `topology.initialize` 生成 topology；如需要继续传给后续工具，可显式请求 full topology。
4. 本地 bridge 把 `IntermediateTopology` 合成 canonical project。

已有拓扑编辑：

1. Project/Agent 层把用户引用解析为稳定 node/link ID。
2. 调用 `topology.inspect` 查询邻接和端口占用 summary。
3. 构造 P0 operations，例如插入交换机时 `[link.delete, node.add, link.add, link.add]`。
4. 先 dryRun，用户确认后用同一 snapshot 和 operations 重放 apply；对话中只展示摘要，worker/app-runtime 可消费 updated topology。

`node.delete`、`node.update`、`link.update` 属于 P1 完整 CRUD；P0 返回 `UNSUPPORTED_OPERATION`。

## Artifact

P0 构建四份 JSON：

- `topology.json`
- `topo_feature.json`
- `data-server.json`
- `mac-forwarding-table.json`

不生成 `mac-forwarding-table.html`，也没有 `topology.render_mac_table_html`。

## 错误 Envelope

错误固定包含：

- `code`
- `message`
- `path`
- `severity`
- `details`
- `retryable`
- `requiresUserClarification`

常见错误包括 `UNSUPPORTED_SCHEMA_VERSION`、`INVALID_TEMPLATE_PARAM`、`AMBIGUOUS_SELECTOR`、`UNKNOWN_ENDPOINT_NODE`、`PORT_ALREADY_USED`、`LIMIT_EXCEEDED`、`UNSUPPORTED_OPERATION` 和 `FORBIDDEN_RESPONSE_MODE`。其中 `FORBIDDEN_RESPONSE_MODE` 表示调用方请求 full topology 但没有显式设置 `topologyFullAllowed: true`，或试图获取 artifact/changeSet 等禁止外发数据；它不是安全鉴权结果。

## 打包边界

P0 提供 Node stdio dev/test host：`src-node/dist/tsn-topology-server.mjs`。`build:worker` 会打包该 host，真实 Agent 开发路径可以发现并使用它；Tauri 生产 resources 暂不携带 topology MCP host，避免在生产 sidecar 决策前提前承诺 packaged MCP 可用。

生产 sidecar 安全治理仍是后续 decision gate：固定随包路径、禁止从 `PATH` 解析、签名/hash 校验、private IPC 或 localhost-only、每会话 capability token 和 fail-closed 都需要单独验收。
