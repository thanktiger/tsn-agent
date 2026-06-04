# TSN Topology MCP 契约

> **Phase A/B 状态更新（2026-06-04）**
>
> Plan v3 `docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md` 完成 Phase A 实施后，本文档语义有两处调整：
>
> 1. **MCP handler 不再产中间表示**。所有 8 个工具通过 axum sidecar HTTP 调用 sqlx 写 SQLite，
>    `IntermediateTopology` 在 sidecar 内部被 Rust 端 1:1 镜像（`topology_compute.rs`），
>    不再作为 MCP wire 协议外露的事实源。
> 2. **`responseMode` / `topologyFullAllowed` 字段已删除**。返回值已是结构化领域响应，
>    `topology.initialize` 与 `topology.apply_operations` 默认带 `full.topology`；
>    `FORBIDDEN_RESPONSE_MODE` 错误码不再出现。
>
> 工具名重命名：`topology.validate_intermediate` → `topology.validate`。其余 7 个工具名保留。
>
> Phase A 期间 `flow-template` / `planning-export` 阶段在 UI 灰掉（aria-disabled +
> tooltip + inline banner），boss 在 P1 重新构建。

`tsn_topology` 是 P0 确定性拓扑服务。它只处理拓扑领域的固定规则，不做自然语言理解、不生成完整 project、不推进 workflow，也不导出 HTML。

## 工具列表

| MCP tool | 用途 |
|---|---|
| `topology.describe_templates` | 返回 P0 模板目录和参数约束。 |
| `topology.initialize` | 用结构化 `templateId` 和参数生成 `IntermediateTopology`。 |
| `topology.inspect` | 按稳定 selector 查询节点、链路、邻接和端口占用摘要。 |
| `topology.describe_artifacts` | 返回 legacy JSON artifact 的数量、大小和计数摘要。 |
| `topology.validate` | 校验 topology 并返回结构化错误。（原 `topology.validate_intermediate`，Phase A 起重命名） |
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

Phase A 起所有 8 工具走 sidecar HTTP。响应已是结构化领域响应：
- `topology.initialize` / `topology.apply_operations` 默认带 `full.topology` 或 `full.artifacts`；
- 其他工具默认 summary-only。
- `responseMode` / `topologyFullAllowed` 字段已删除；不再需要 agent 显式请求 full。

完整 artifact、端口表、MAC 表和完整 changeSet 仍不得进入诊断日志（参见 `docs/diagnostics-log-contract.md`）。

本地 app-runtime 直接通过 `query_topology` Tauri command 读取 SQLite 中的 P0 表（不走 sidecar HTTP）；写权威是 sidecar `apply_operations`。`CanonicalTsnProjectV0` 在 Phase A 期间仍作为 `sessions.payload` 的序列化 schema 保留（供 UI hydrate），但**不再是写权威**，将在 Phase B 后续 PR 中删除。

## 初始化与编辑

从 0 初始化：

1. Project/Agent 层从自然语言和 `ScenarioConfig` 得到结构化参数。
2. 调用 `topology.describe_templates` 确认模板目录。
3. 调用 `topology.initialize` 生成 topology（响应 `full.topology` 默认带回）。
4. 调用 `topology.apply_operations` 将 NodeAdd/LinkAdd 落 SQLite，获得 `mutationId`；UI 通过 `session_db_changed` event + `query_topology` Tauri command 拉取并 hydrate。

> Phase A 边界：`dual-plane-redundant` 模板在 sidecar 返 `INVALID_TEMPLATE_PARAM`（含 `phase: "A"`），Phase B 接入完整 Rust 端 port。

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

常见错误包括 `UNSUPPORTED_SCHEMA_VERSION`、`INVALID_TEMPLATE_PARAM`、`AMBIGUOUS_SELECTOR`、`UNKNOWN_ENDPOINT_NODE`、`PORT_ALREADY_USED`、`LIMIT_EXCEEDED`、`UNSUPPORTED_OPERATION`、`FORBIDDEN_OPERATION`、`SIDECAR_UNAVAILABLE`。

`FORBIDDEN_RESPONSE_MODE` 在 Phase A 起已删除（responseMode 字段不再存在）；
`FORBIDDEN_OPERATION` 表示跨 session 写或访问未授权 session；
`SIDECAR_UNAVAILABLE` 表示 sidecar HTTP 不可达（重装上一个 release 是唯一应急路径，**无 in-process fallback**）。

## 打包边界 + sidecar 治理（Phase A 已落地）

- Node stdio MCP host：`src-node/dist/tsn-topology-server.mjs`，启动期 `readSidecarEnv()` 校验
  `TSN_AGENT_DB_RPC_URL` / `TSN_AGENT_DB_RPC_TOKEN` / `TSN_AGENT_SESSION_ID` 全部存在；
  缺失则 `process.exit(1)`。
- axum 127.0.0.1 IPv4 only sidecar，绑定随机端口、每次启动 mint 32 字节 `OsRng` Bearer token；
  token 仅 Rust→Node spawn env 流转，UI **永远不接触**。
- Bearer 验证：`subtle::ConstantTimeEq` 自定义 middleware（不用 tower-http builtin 因后者非常量时间）。
- bind 失败 = Tauri panic + 中文友好错误页 + 引导用户重装上一个 release；**无 fallback flag**。
- mutationId u64 in-process atomic counter；进程重启清零；UI catch-up 通过
  `get_topology_mutations_since` Tauri command + ring buffer (capacity 1024)。
