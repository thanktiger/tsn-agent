---
date: 2026-06-03
topic: session-db-mcp
---

# Single-DB 领域事实源重构需求

## 摘要

把当前 topology MCP 的权威事实源从 in-memory `IntermediateTopology` + `CanonicalTsnProjectV0` 双层模型切换到**单 SQLite 数据库的领域表**，事实源由 3 层（intermediate + canonical + legacy 5 件套）收敛到 1 层（DB 领域表）。Tauri Rust 持有所有 sqlx 连接，通过 **127.0.0.1 loopback HTTP + per-launch capability token** 暴露领域级 RPC，MCP server 仍作为 stdio child of Agent SDK，但其工具 handler 通过该 RPC 写 DB。**P0 只覆盖 topology domain**：flow / time-sync domain 推到 P1，**P0 期间同时停掉 flow-dependent 导出**（`planner-exporter / inet-traffic-exporter / inet-gcl-exporter / ini-exporter / artifact-bundle` 等被 boss 在 P1 重新构建）。**P0 同时删除 `IntermediateTopology` 和 `CanonicalTsnProjectV0`**，所有 topology-only 下游（React Flow、`network.ned` 中拓扑部分、`manifest.json`、topology 4 件套）改为 DB 直接 derive。

本需求文档显式覆盖 `2026-05-27-tsn-topology-mcp-requirements.md` 中"MCP 无状态、`IntermediateTopology` 是权威契约"的决策；旧文档加 deprecation 头部链回本文档。旧文档中"不做 NLU/generate_project/HTML 导出/workflow 推进"边界继续保留。

## 反转理由（What changed since 2026-05-27）

7 天前（PR #3 commit `5565a4b`）落地的 topology MCP 是**无状态 + 内存契约**模型。其 v1 设计在工程上是自洽的，本文档**不是因为某个具体 incident 推翻它**，而是 boss 在继续设计后续 domain（flow / time-sync）时形成的**工程架构偏好**：

- 让事实源从 3 层（intermediate + canonical + legacy）收敛到 1 层（DB 领域表）
- 让 session 数据从 `payload TEXT` JSON blob 变成结构化、可 SQL 查询的形态
- 让 agent ↔ MCP 不再每次重复传整张 topology JSON

这些都是**工程偏好**（"以后更顺手"），不是已确认的真实痛点 incident。旧决策（MCP 无状态）的优点（fixture 决定性、不持服务端状态）在新方案中仍然保留——MCP server 自身仍然无状态，只是把"事实表示"从 args JSON 移交给 Tauri Rust 维护。

如果本次重构在实施中暴露出 P0 工作量超预期、或对 v1 已落地的工具有意外破坏，应允许 P0 缩到只删 IntermediateTopology、CanonicalTsnProjectV0 留作 DB→legacy 中间 derive view（事实源从 3 层减到 2 层但仍不是 1 层）作为 graceful fallback。

## 目标用户与场景

**主用户**：TSN Agent 开发者（含 boss 本人 + 后续接手的同事）

**核心场景**：
- 实现拓扑相关 PR 时，调试 e2e/单测失败需要在多个 derive 层间反复定位——P0 后只有一层
- 跨同事调试时不需要再解 `payload TEXT` JSON——P0 后可直接 SQL 查
- 后续 planner / 分析工具可直接对 DB 跑查询，不需要重新解析 JSON 文件

**次要场景**（不作为 P0 核心 SC，但 P0 顺便提供工具）：
- bug report 附 session 数据 → 通过 "Export Session" 命令产 standalone `.db`
- 跨机器 demo 复现 → 通过 "Import Session" 命令导入

## Alternatives Considered

| 方案 | 解决的痛点子集 | 排除理由 |
|---|---|---|
| Pretty-print `payload TEXT` + jq 查询脚本 | 减少手解 JSON 摩擦 | 不解决多份事实源；数据仍不可 SQL |
| 只删 `IntermediateTopology` 保持 JSON payload | 减少一层 bridge | 留 canonical + legacy 两层，工程偏好未达成；但作为 graceful fallback 仍保留 |
| 一次性 sqlite 导出脚本 | 让数据可 SQL 查询 | 仍是临时副本，不是事实源；与 in-memory 模型割裂 |
| 引入 `session_id` 引用 + summary 模式（不改存储） | 降 token 占用 | 不改变事实源分层；工程偏好未达成 |
| Per-session 物理 `.db` 文件 + Tauri sole writer | 同时解决 + session 分享单元化 | 真正的反对理由：跨 session JOIN / 多文件 schema migration 同步成本；"session 分享"价值通过 Export 命令也能实现 |
| **本方案：单 db + `session_id` 列 + loopback HTTP RPC** | 全部 4 个工程偏好 + 分享通过 "Export" 命令实现 | 选定（接受 P0 工作量是 v1 的 3-5x 的代价） |

## Architecture 概览

```
Tauri 主进程
├─ Rust (sqlx 0.8.6 + axum 0.7 + tower-http)
│   ├─ tsn-agent.db
│   │    ├─ sessions / app_state (既有)
│   │    └─ topology_nodes / topology_links / topology_ports
│   │       topology_features / data_server_entries
│   │       mac_forwarding_entries  (新增, 都有 session_id 列)
│   │
│   └─ Axum HTTP sidecar
│        └─ 127.0.0.1:<random port> + Bearer token (per-launch)
│
├─ Node worker (claude-agent-worker.mjs)
│   ├─ env: TSN_AGENT_SESSION_ID
│   ├─ env: TSN_AGENT_DB_RPC_URL
│   ├─ env: TSN_AGENT_DB_RPC_TOKEN
│   │
│   └─ Agent SDK (spawned)
│        └─ tsn_topology MCP server (stdio child)
│             └─ tool handler:
│                  fetch(`${RPC_URL}/db/topology/apply_operations`,
│                        { Authorization: `Bearer ${TOKEN}`,
│                          body: { operations, dryRun } })
│
└─ React UI
    ├─ Tauri command (sqlx in-process): db_query_topology(sessionId, selectors)
    └─ Tauri event 'session_db_changed' { sessionId, domain, mutationId }
        → 触发对应切片 refetch

复现单元:
  Tauri command "Export Session"
    → tsn-agent.db 单 session 切片 → /tmp/sess-<id>.db
  Tauri command "Import Session"
    → standalone .db → main db 新 session_id
  日志单独打包: <app-config>/logs/sess-<id>/agent-run-*.jsonl
```

### 启动顺序（lifecycle）

Tauri `setup()` 内**同步**执行：

```
1. 打开 tsn-agent.db sqlx pool (max_connections=1)
2. 跑 SESSION_SCHEMA_SQL（含新增 6 表）
3. 跑 R21 backfill（应用启动时一次性，含失败标记）
4. 用 OsRng 生成 per-launch capability token
5. axum::Server::bind("127.0.0.1:0")  // 系统分配端口；绑定失败 fail-closed panic
6. 拿到端口号、token 写入应用 state（不写 db / log）
7. 启动 webview
```

之后 worker spawn 时（`run_claude_agent` 命令入口）：
- 从 app state 拿 url + token，作为 worker 进程的 env
- worker 把同样三个 env 注入 spawned MCP server child

进程退出（`app.exit()` / panic / SIGTERM）：
- axum 用 `tauri::async_runtime::spawn` 起 + cancellation token，跟 Tauri 同生命周期
- Node worker 用进程组（Unix `setpgid` / Windows JobObject）管理，Tauri 退出时强杀子进程组

## Requirements

**DB 结构与边界**
- R1. ~~P0 表结构以 topology 4 件套（`topology.json / topo_feature.json / data-server.json / mac-forwarding-table.json`）为 round-trip 目标~~。**2026-06-03 U1 schema draft 修正**：参考 CDT 工程 `docs/plans/2026-06-03-001-schema-draft.md`，实际 4 件套 = `topology.json + topo_feature.json + node.json + flow_plan_<id>.json`。`data-server.json` 是上游 Qunee 源数据**不在 4 件套**；`mac-forwarding-table.json` CDT **不生成**已删除；新增 `node.json`（9 类业务配置 + base_info）进 P0。**P0 表结构 = 3 件套（topology + topo_feature + node）的 15 张表**；DB 表字段平铺。`flow_plan_<id>.json` 不在 P0 round-trip 范围内（flow domain 进 P1）。
- R2. P0 实质覆盖 **topology 一个 domain**；flow / time-sync 推到 P1。Boss 在 plan 入口提供 topology 4 件套对应表的列清单草案。
- R3. 单 sqlite 物理文件 `<app-config>/tsn-agent.db`；所有领域行加 `session_id` 列作为外键到 `sessions.id`，并建 `(session_id, ...)` 复合索引（具体索引尾列由 plan 阶段根据 R8 工具查询模式确定）。
- R4. main db 表清单：保留 `sessions` / `app_state`；新增 `topology_nodes` / `topology_links` / `topology_ports` / `topology_features` / `data_server_entries` / `mac_forwarding_entries`；删除 `diagnostic_logs` 表（迁移到文件，见 R5）。flow / time-sync 表 P1 加。
- R5. 诊断日志移出 sqlite，写到 `<app-config>/logs/sess-<id>/agent-run-<runId>.jsonl`；既有 `diagnostic_store.rs` 的字段 allowlist + 脱敏管线必须**显式继承**到文件写出层；plan 阶段把 allowlist 集中到共享配置/枚举供两侧引用。
- R5a. "Export Session" 命令默认仅打包 `tsn-agent.db` 单 session 切片，不带 `logs/`；P0 不提供"日志包含"开关（推到 P1，作为 Outstanding-Questions Deferred 项）。

**MCP 工具契约**
- R6. MCP server 命名保持 `tsn_topology`（P0 仅 topology domain），`allowedTools` 前缀 `mcp__tsn_topology__*` 不变；P1 加 flow/time-sync 时再决定是否新 server 或扩 domain。
- R7. session_id 通过 worker spawn 时的环境变量 `TSN_AGENT_SESSION_ID` 注入 MCP server；MCP tool handler 从 env 读取，**不接受 LLM 在 args 里传 sessionId**（防伪造）。**当前 worker 已是 per-prompt spawn**（src-tauri/src/commands.rs `Command::new("node").spawn()` per `run_claude_agent`），与 env 注入语义匹配；如果未来 worker 改长生命周期，需要重新评估 R7 的注入策略。
- R8. 保留既有 8 个 topology 工具的业务语义；签名变更：删除入参中的 `topology` 字段，sessionId 不出现在 args（隐式 env）。`validate_intermediate` 重命名为 `topology.validate`。
- R9. 工具响应规则：
  - 除 `build_artifacts` 外，**所有工具**一律 summary 模式 + structured diff payload（dryRun 时含 diff、apply 时含 mutation summary 含 mutationId）；
  - **`build_artifacts` 是结构化产物工具**，仍返回完整 5 件套（P0 期间 = 4 件套）JSON，因为下游（exporter / 用户保存）需要文件内容；它是 P0 唯一不走 summary 的工具；
  - 删除 `responseMode: "full"` 和 `topologyFullAllowed` 参数；
  - worker 端 `extractTopologyWorkflowStageResults` 改为接收 mutationId + summary 作为新的 trusted signal。

**事务与一致性**
- R10. dryRun 与 apply 各自一次 RPC 调用；Tauri Rust 通过 `pool.begin()` 拿 `Transaction<Sqlite>` 执行 ops（dryRun 用 `tx.rollback()`、apply 用 `tx.commit()`）。MCP server 不持 cross-call state。
- R11. 单 session 同时只允许 1 个未完成写事务（apply）；超过 5s 硬超时强制 ROLLBACK 并返回结构化 `BUSY` / `TIMEOUT` 错误。dryRun（只读事务）可并发但有 per-session pending 上限（plan 阶段定）。
- R12. Tauri RPC handler 维护**可写表 + 操作类型白名单**（编译时 enum + match，单 domain 简单可枚举）：MCP 调用 apply_operations 时仅可触达声明的 topology 表 + 已定义 ops 类型；试图跨 session_id 引用或写 sessions/app_state 等管理表必须拒绝并返回 `FORBIDDEN_OPERATION`。Plan 阶段产出 authz fixture 测试。

**RPC 通道与安全**
- R13. Tauri Rust 起 axum sidecar 绑 `127.0.0.1:<random port>`（IPv4 only，IPv6 loopback `::1` 不开），**端口绑定失败必须 fail-closed panic 不 fallback**；每次启动生成 per-launch capability token（≥32 字节，源 `OsRng` + base64url）。
- R14. worker 启动时从 Tauri command 拿 token + url，spawn MCP server 时通过 env 注入；MCP handler 每次请求带 `Authorization: Bearer <token>`，token 错误一律 401；**连续 3 次 401**（仅统计 worker 自己发出的请求的响应，不计 sidecar 拒掉的外来无 token 请求）必须停止 worker 并报告。
- R15. token 仅存于应用 state 内存，**不持久化**到 main db / logs / app_state；token 类型自定义 `Debug` impl 输出 `***`，禁止进入 panic backtrace / tracing log。进程结束时 Tauri 关闭 sidecar。
- R16. UI **不走 sidecar**，直接调 Tauri command (`db_query_topology(sessionId, selectors)`) 读 DB（sqlx in-process）。Tauri 在每次 apply 的 commit 之后**先持久化 mutationId 到一个本地缓存（应用 state Vec）再** emit Tauri event `session_db_changed` `{ sessionId, domain, mutationId }`；UI 监听 + 拉对应切片；UI 启动时 / route 切换时拉取最近 mutationId 列表补漏（防 emit 丢失）。

**复现与导出**
- R17. Planner 输入 4 件套 JSON 仅从 DB derive（5 件套中 `flow_plan_1.json` 由 P1 提供）；plan 阶段把 SQL ORDER BY / float 精度策略落具体。**byte-equal round-trip spike 移入 Resolve Before Planning**（见 Outstanding Questions），spike 失败时允许 graceful 降级到"语义等价 + planner accept"。
- R18. Tauri command "Export Session"：把指定 session 的所有领域行 + 元数据导出为 standalone single-session `.db` 文件；文件 mode 设 0600（Unix）/ ACL only owner（Windows）。
- R19. Tauri command "Import Session"：standalone `.db` → main db 中新 session_id；**走与 RPC `apply_operations` 完全相同的白名单路径**（不允许 sqlite ATTACH + 全表 copy），把外部 `.db` 当 untrusted operations 流逐行校验；schema_version 不兼容时显式 fail 并提示用户使用同版本 app 重新导出。

**Migration & 兼容（必须按顺序执行）**

Phase A（同一个 P0 PR / release 内）：
- R20a. 新增 6 个 topology 表 + schema_version + axum sidecar + Tauri command 全部上线
- R20b. backfill 模块（保留 IntermediateTopology / canonical bridge 副本作为 backfill 模块内部依赖）跑过启动一次性 backfill
- R20c. 失败 session 阻塞使用并提示用户

Phase B（P0 上线 + 1 个 release 后）：
- R20d. 一次性删除 `src/topology/intermediate.ts` + `validate.ts` 中 IntermediateTopology 类型 + `project-bridge.ts` 中 `intermediateToCanonicalProject` / `canonicalTopologyToIntermediate` + `src/domain/canonical.ts` 中 `CanonicalTsnProjectV0` 等
- R20e. 同步删除 backfill 模块内部 bridge 副本
- R20f. 同步删除以下 flow-dependent 导出文件的生成逻辑（boss 在 P1 重新构建）：
  - `src/export/planner-exporter.ts`
  - `src/export/inet-traffic-exporter.ts`
  - `src/export/inet-gcl-exporter.ts`
  - `src/export/ini-exporter.ts`（traffic.ini 部分；如 `omnetpp.ini` 同文件，先保留 topology-only 部分）
  - `src/export/artifact-bundle.ts`（中 `flow_plan_1.json` / `traffic.ini` 的 bundle 路径）
  - 对应 UI 入口（导出按钮 / 阶段进度）灰掉 + tooltip "P1 重新上线"
- R20g. 保留 topology-only 导出：`react-flow-exporter.ts` + `ned-exporter.ts`（topology 部分）+ `manifest.json` 中 topology 部分

**说明**：Phase A 与 Phase B 是两个 release（不是同一 PR），目的是让真实用户先经历一个完整使用周期验证 backfill 数据正确性后再删旧代码。

**安全约束（继承自 2026-05-27 R35a-R35c / R45）**
- R21. RPC 通道 fail-closed：Tauri 端验证失败、超时、白名单拒绝时一律返回结构化错误且不应用写入。
- R22. 日志写出层强制 allowlist 字段，禁止凭证、用户 prompt 全文、家目录路径等敏感字段；R5 文件迁移路径必须 inherit 既有 `diagnostic_store` 的过滤逻辑而非重写；plan 阶段把 allowlist 提到一个共享配置使 DB writer 与 file writer 共用。

## Success Criteria

- 调试任一拓扑相关失败时**只有一份事实源**（DB 领域表）；intermediate / canonical / legacy 都不再是生产代码路径上的事实源（**Phase B 完成后**生效；Phase A 期间 backfill 模块内部仍持 canonical 副本，属已知过渡）。
- **静态可验证**：Phase B 完成后 `git grep -nE 'IntermediateTopology|CanonicalTsnProjectV0' src/`（排除 `src-tauri/migration/` 与 `tests/`）命中 = 0。
- Agent 调 MCP 工具不再传任何 topology JSON；agent prompt 不再保留 in-context topology 摘要。
- 既有 8 个 topology 工具的业务语义在 e2e 层**无功能回归**（topology.initialize / apply_operations dryRun+apply / topology.validate / build_artifacts 等用例全过）。
- 既有用户 session（main db `payload TEXT`）**100% 走 backfill 路径**：成功的进 DB；失败的明确显示阻塞原因 + 错误码 + 不可作其他后台修改。
- UI 在 MCP apply commit 后通过 `session_db_changed` 事件**自动刷新**（功能性，不带具体延迟门槛；延迟基线由 plan 阶段实测）；UI 启动时从 mutationId 缓存补漏。
- 一条"Export Session"命令产生的 standalone `.db` 可在同版本 app 的"Import Session"上还原所有 topology 领域行（**flow-dependent artifact P0 期间不可用**，这是已知 boundary）。
- 安全验收：sidecar 仅绑 127.0.0.1；non-Bearer 请求返回 401；尝试跨 session_id 写入返回 `FORBIDDEN_OPERATION`；token 不出现在任何日志 / panic backtrace 中。

## Scope Boundaries

- 不做 UI 状态数据库化（瞬态 React state + localStorage 保留）
- 不做 per-session 物理 `.db` 文件方案（已对比并排除）
- 不做 staging 表 / dryrun_id 方案（事务模型已选 BEGIN+ROLLBACK / BEGIN+COMMIT）
- 不让 MCP server 进程直接打开 sqlite 文件（DB ownership = Tauri Rust 单一）
- 不让 MCP server 拼写 SQL（领域级 RPC，SQL 仅在 Rust 侧）
- 不让 LLM 在 args 中传 sessionId（防伪造，强制 env 注入）
- 不在 P0 同时铺 flow / time-sync domain（P1）
- **P0 期间停掉 flow-dependent 导出**（planner / inet-traffic / inet-gcl / traffic.ini / artifact-bundle 的 flow 部分），boss 在 P1 重新构建——这是显式接受的 P0 boundary
- 不保留 `IntermediateTopology` 或 `CanonicalTsnProjectV0` 在生产代码路径（**Phase B 完成后**生效；Phase A 期间在 backfill 模块内部保留属于过渡期，最长 1 个 release）
- 不让 Tauri sidecar 绑非 loopback / 暴露外网 / 绑 IPv6
- 不继承 `responseMode: "full"` 协议
- 沿用旧 brainstorm 的"不做 NLU、generate_project、workflow 推进、HTML 导出"边界
- P0 不解决"同机器恶意本地用户"威胁模型（Bearer token 在 env 中可见，是已识别接受的局限）

## Key Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| 主驱动 | 消除多份事实源（工程偏好） | boss 设计后续 domain 时形成的架构偏好，非 incident 驱动 |
| Storage 物理形态 | 单 db + `session_id` 列 | per-session 文件方案的复杂度/价值比不划算 |
| DB ownership | Tauri Rust 唯一 writer | 单写者协议简单，避免跨进程文件锁竞态 |
| RPC 通道 | Loopback HTTP + per-launch token | 协议成熟、调试便利、鉴权标准 |
| RPC 负载语义 | 领域级 JSON RPC，SQL 全在 Rust 侧 | 防 SQL 注入，schema 单侧维护 |
| P0 范围 | topology only + 停掉 flow-dependent 导出 | flow domain 重构整体推到 P1 |
| 事务模型 | sqlx `Transaction<Sqlite>` + commit/rollback | 无服务端 pending state |
| dryRun 数据来源 | MCP 返回 structured diff payload | UI 不回 DB 读（已 ROLLBACK） |
| Canonical 处理 | Phase A 上线 + Phase B（+1 release）删除 | 留 1 个 release 验证 backfill 数据正确性 |
| 复现单元 | "Export Session" 命令产 standalone `.db` | 不需要 per-session 文件就能拿到分享物 |
| 日志 | 文件 + session-scoped jsonl + 字段 allowlist 继承 | 文件比 DB 便于 rotate + 分析 + share/strip |
| MCP server 命名 | 维持 `tsn_topology` | P0 仅 topology domain；不破坏 allowedTools |
| session_id 注入 | spawn-env，不可被 LLM 在 args 传 | 防伪造；与当前 per-prompt worker spawn 语义匹配 |
| UI 读路径 | Tauri command + sqlx in-process | 不走 sidecar，零 RPC 开销 |
| UI 刷新机制 | mutationId 缓存 + Tauri event `session_db_changed` | 替代 `responseMode: "full"` 的 stage capture；启动 / route 切换时补漏 |
| Sidecar 启动 | `setup()` 内同步起 + IPv4 only + bind 失败 fail-closed | 避免懒起 race；不 fallback 到任意端口 |
| 401 阈值 | 3 次（仅 worker 自身请求） | 防止远程伪造请求触发 worker 自杀 |

## Dependencies / Assumptions

- 新增 Cargo dep：`axum` ≥0.7、`tower-http` ≥0.5；扩 `tokio` features 到 `["rt-multi-thread", "net", "macros", "sync"]`（当前只有 `["sync"]`）—— **属于 boss CLAUDE.md "新增外部依赖需要问我" 范围，plan 入口需要 boss 显式确认**
- `sqlx 0.8.6`（当前版本，不需要升级到 5+）
- Tauri 2 + `tauri::async_runtime::spawn` 可承载长生命周期 axum 服务
- Node worker 仍是 per-prompt spawn（src-tauri/src/commands.rs 现状），与 R7 env 注入匹配
- `@anthropic-ai/claude-agent-sdk` 的 `mcpServers` 配置在 spawn MCP child 时**透传父进程 env**（plan 阶段先 spike 验证）
- 现有 `buildXxxArtifacts` 算法的内存 traversal 顺序可在 SQL `ORDER BY` 下重建（**Resolve Before Planning** 的 spike 验证）
- 既有 `sessions.payload` blob 的所有变种都能被现有 `canonicalTopologyToIntermediate` 解析（backfill 前提）
- 现有 7 个 exporter 中 4 个（planner / inet-traffic / inet-gcl / ini-traffic 部分）在 P0 期间被移除，boss 在 P1 重新构建
- boss 在 plan 入口提供 topology 4 件套对应表的字段清单草案

## Outstanding Questions

### Resolve Before Planning

- **[Affects R1, R2, R3, R17][Spike]** **byte-equal round-trip spike 必须先于 plan 阶段跑通**：在现有 `IntermediateTopology` fixture（至少覆盖 `generic-line` + `generic-ring` + `dual-plane-redundant` 三个模板）上跑 DB → SQL ORDER BY → JSON，与原 `buildXxxArtifacts` 输出做字节级比对。Spike 失败时 boss 决策：(a) 调整 schema 加 ORDER BY 辅助列 (b) 降级 SC 到"语义等价 + planner accept" (c) 回 brainstorm 评估 graceful fallback 方案（只删 IntermediateTopology 保留 canonical）。
- **[Affects R7, R14][Spike]** **Agent SDK MCP child env 透传**必须 spike 一次：跑一个 echo MCP server 验证 `process.env.TSN_AGENT_SESSION_ID` 在 child 端可见；若 SDK 不自动透传，则 `topologyMcpConfig` 必须显式声明 `env: { ... }`。
- **[Affects dependencies][Authorization]** **新增 axum / tower-http 依赖** + 扩 tokio features 需要 boss 显式批准（CLAUDE.md 规则）。

### Deferred to Planning

- **[Affects R2, R4][Schema]** topology 4 件套对应表的具体列、外键、索引（boss 提供草案后 plan 阶段细化）
- **[Affects R5, R22][Logging]** 日志文件格式（ndjson 单文件 vs 按 run 分文件） + rotate 策略 + 字段 allowlist 的共享配置实现
- **[Affects R5a][UX]** "Export Session 是否提供包含日志开关"推到 P1 设计
- **[Affects R11][Concurrency]** dryRun 并发 pending 上限具体值（per-session 1 还是 N）+ 写事务硬超时具体值（建议 5s）+ `BUSY` / `TIMEOUT` 错误码字典 + 客户端重试策略
- **[Affects R12][Authz]** ops 类型白名单的具体 enum 定义（`node.add` / `link.delete` / 等）+ authz fixture 测试用例
- **[Affects R16][UI]** mutationId 缓存数据结构 + 启动 / route 切换的补漏查询 API + React refetch 策略
- **[Affects R17][Spike followup]** spike 通过后跑 plan 入口的所有 P0 fixture（不只是 3 个推荐模板）
- **[Affects R18, R19][Export]** Export/Import session 的 UX（文件选择对话框、覆盖确认、跨版本 fail 时的 fallback 行为、tarball mode 是否提供）
- **[Affects R20][Migration]** Phase A → Phase B 的 release 编号 + 删除 PR 的具体 file list + 补充 `git grep = 0` 的 CI gate
- **[Affects R20f][UI]** 灰掉 flow-dependent 导出按钮的 UI copy + tooltip 文案

## Next Steps

→ 跑 3 条 **Resolve Before Planning** spike（byte-equal round-trip、Agent SDK env 透传、依赖审批）后进 `/ce:plan` 制定 P0 实施计划。Plan 入口需要 boss 提供 topology 4 件套对应表的字段草案。

---

## 来源 / 调研

- 既有 brainstorm `docs/brainstorms/2026-05-27-tsn-topology-mcp-requirements.md`（"MCP 无状态、IntermediateTopology 为权威契约"决策被本文档**显式取代**）
- 既有 PR #3 commit `5565a4b` "feat(topology): iterate topology MCP with dual-plane + stage-result boundary"
- `src-tauri/src/session_store.rs` / `src-tauri/src/db.rs` / `src-tauri/src/diagnostic_store.rs` / `src-tauri/src/commands.rs`
- `src-tauri/Cargo.toml`（确认 axum 不是现有 dep）
- `src/topology/intermediate.ts` / `validate.ts` / `artifacts.ts` / `project-bridge.ts` / `topology-workflow-stage-result.ts`
- `src/domain/canonical.ts` / `topology-factory.ts`
- `src/export/{planner,inet-traffic,inet-gcl,ini,artifact-bundle,react-flow,ned}-exporter.ts`（确认 flow-dependent 范围）
- `src-node/mcp/topology-tools.ts` / `src-node/claude-agent-worker.mjs`
- `AGENTS.md`（"导出 bundle 5 件套"、"flow_plan_1.json 是规划器输入"、四阶段稳定 ID）
- 2026-06-03 document-review 两轮评审反馈（v1 27 findings + v2 23 findings → v3 应解决全部 6 个 v2 P0 errors）
