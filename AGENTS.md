# AGENTS.md

## 用户语言偏好

- 默认使用简体中文回复用户。
- 除非用户明确要求英文，或必须保留代码、命令、错误信息、API 名称、文件路径、日志原文，否则不要用英文输出。
- `docs/brainstorms/` 和 `docs/plans/` 下的新文档默认使用简体中文。
- 使用 `ce-brainstorm`、`ce-plan` 等英文模板技能时，保留模板结构即可，正文、标题、需求、计划说明和总结都应翻译为中文。

## 文档规范

- 文件路径保持 repo-relative，例如 `src/app/App.tsx`。
- 技术名词、包名、JSON 文件名、CLI 命令和代码标识保持原文。
- 面向用户的解释优先使用中文，避免把英文模板原样落盘。

## 项目初始化上下文

- 当前项目是 TSN Agent，一个 Tauri + React 桌面应用 MVP，面向了解 TSN 概念但不熟悉参数配置的新手用户。
- 主流程是从自然语言需求生成 TSN 项目草案，并按“拓扑、时间同步、流量规划、模拟仿真”四个用户可见阶段推进。每个关键阶段输出摘要后等待用户确认，不能一次性把所有结果都直接吐完，除非用户明确输入“直接生成”等快速路径。
- 当前主分支 `main` 已合入分阶段工作流提交 `9d15461 feat: add staged TSN planning workflow`。新窗口接手时先用 `git status --short` 确认工作区是否干净。
- `docs/prototypes/箭载TSN技术规范_V1.2_1204-s.docx` 是后续典型场景参考文档；但“箭载/舰载 TSN”只是未来 8 个应用场景中的一个，不要把核心流程写死成单一场景。
- 需求和计划文档优先参考：
  - `docs/brainstorms/2026-05-20-tsn-agent-tauri-ned-requirements.md`
  - `docs/brainstorms/2026-05-20-tsn-agent-rocket-tsn-spec-gap-analysis.md`
  - `docs/plans/2026-05-20-003-feat-staged-agent-workflow-plan.md`
  - `docs/staged-agent-workflow.md`
  - `docs/diagnostics-log-contract.md`
  - `docs/testing.md`
- 历史问题解决方案库：`docs/solutions/`（按类别组织，YAML frontmatter 含 `module`/`tags`/`problem_type`，在已有文档覆盖的领域实现或排障时可检索）。
- 共享领域词汇：`CONCEPTS.md`（实体、命名流程、状态概念的项目特定含义，初次接触代码库或讨论领域概念时可查阅）。

## 关键代码入口

- `src/app/App.tsx`：主界面、聊天输入、阶段确认、步骤导航、artifact 显示和导出按钮门禁。Phase A 起 flow-template / planning-export 阶段 UI 灰掉。
- `src/app/App.css`：主界面样式。
- `src/agent/agent-adapter.ts`：Tauri-only agent 适配层，负责 session/workflow 透传、stage result（仅携带 mutationId）和诊断日志；非 Tauri（Web）fail-closed 返回「需要桌面版」，无 fake-agent 兜底。
- `src/agent/agent-types.ts`：`AgentEvent` / `TsnAgentRequest` / `TsnAgentResult` 类型（自已删除的 fake-agent.ts 移入）。
- `src/domain/scenario-config.ts`：轻量场景配置。新增应用场景时优先扩展这里，不要复制核心 workflow。
- `src/project/project-state.ts`：workflow state、阶段状态、确认、请求修改、旧 session 归一化。
- `src/sessions/session-repository.ts`、`src-tauri/src/session_store.rs`：Web localStorage 与 Tauri SQLite 会话保存。
- `src/diagnostics/*`、`src/ui/diagnostics/DiagnosticsDrawer.tsx`：脱敏诊断日志和日志抽屉。
- `src-node/claude-agent-worker.mjs`：Tauri 中通过本机 Node worker 调用官方 `@anthropic-ai/claude-agent-sdk`。spawn 约定：秘密走进程 env（`TSN_AGENT_DB_RPC_TOKEN` 等，避免被 worker 审计序列化），非敏感配置走 argv JSON payload（`cwd`/`auditDir`/`runId`/`skillRoot`）。`skillRoot` 是 skills 父根目录（`skill_files.rs::effective_skill_root` 决策：debug 仓库 → app-data 播种副本 → Resource 只读），worker 据此读 SKILL.md 注入；缺省回退 `cwd/.claude/skills`。注意与 `TSN_AGENT_SKILL_OUTPUT_DIR` 区分——后者是 worker 给 agent 子进程的运行期输出 scratch 目录，不是 skill 源。

### Plan v3（topology MCP single-DB）Phase A 新增代码入口

- `src-tauri/src/topology_sidecar.rs` / `topology_sidecar_routes.rs`：axum 127.0.0.1 sidecar + Bearer 中间件 + 8 个 `/db/topology/*` 路由。
- `src-tauri/src/topology_compute.rs`：sidecar 内 topology compute（templates / initialize / validate / artifacts 4 件套 + BFS）；Phase B-β2 起为唯一实现（TS 端 `src/topology/*` compute 已删除）。inspect 已迁至 `topology_sidecar_routes.rs`（DB-backed 全量 rows，无 selector）。
- `src-tauri/src/topology_intermediate.rs`：sidecar 内 IntermediateTopology DTO。
- `src-tauri/src/topology_ops.rs`：apply_operations 白名单 enum + sqlx 写 P0 表。
- `src-tauri/src/topology_mutation_buffer.rs` + `topology_mutations_command.rs`：mutationId ring buffer + `get_topology_mutations_since` Tauri command。
- `src-tauri/src/topology_query_command.rs`：`query_topology` Tauri command（UI 读路径，bypass sidecar HTTP，直接 sqlx in-process）。
- `src-tauri/src/topology_backfill.rs`：启动期一次性 backfill（canonical payload → P0 表）+ 失败 session UI 3 入口。
- `src-tauri/src/db.rs::P0_DOMAIN_SCHEMA_SQL`：15 张 P0 表 schema（plugin migration v2）。
- `src-node/mcp/sidecar-client.ts`：MCP handler 调用 sidecar 的 thin client（含 SIDECAR_UNAVAILABLE 错误映射）。
- `src-node/mcp/topology-tools.ts`：8 个 MCP handler 全走 fetchSidecar；`responseMode` / `topologyFullAllowed` 字段已删除。

### 会话导出/导入与 backfill 恢复（v0.4.0）新增代码入口

- `src-tauri/src/session_export.rs`：单会话切片导出（新空 DB + 双连接复制，payload 携带源值——入库时已 redactSessionForStorage 脱敏，tmp+原子 rename，主库零写入）+ `reveal_in_dir` command。
- `src-tauri/src/session_import.rs`：导入校验链（文件大小/integrity/application_id/行数与字段字节上限/symlink 拒绝）+ 行消毒 + 冲突报错。
- `src-tauri/src/db.rs::SESSION_SCOPED_TABLES`：15 张 session 域表清单，export/import 复制循环的单一事实源。
- `src/app/session-transfer.ts`：UI 侧导出/导入编排（save/open 对话框、id 冲突自动新 id 重试、错误文案映射）。
- `src/ui/confirm-dialog.tsx`：受控确认弹窗（backfill retry 警告复用）。
- `src/app/hooks/use-backfill-failures.ts`：失败会话查询 hook（mount invoke + retry resolve 重拉，无事件——启动 walker 在窗口创建前同步完成，事件无接收窗口）。

### Phase B-β2 已删除（不要再引用）

- TS 端 canonical 域与拓扑 compute：`src/domain/canonical.ts` / `validation.ts` / `topology-factory.ts`、`src/topology/*`（仅保留 `limits.ts` 与 `topology-service.ts` 的工具名/runtime 摘要）。
- 全部 TS exporters：`src/export/`（INET / planner / react-flow 导出随 Phase B 重建）。
- stage runner：`src-node/stage-skills/` 与 worker 内 runner 引导、retry 路径、`TSN_AGENT_STAGE_RUNNER_PATH` env；worker 只服务拓扑阶段（其余阶段由 adapter 本地拦截）。
- CI grep gate（`scripts/check-no-legacy-types.sh`，默认 `SCAN_MODE=fail`，经 `.github/workflows/ci.yml` 在 push/PR 运行）会拦截上述类型与字段的回流；`src-tauri/src/topology_backfill.rs` 是唯一豁免（一次性 skip-A 迁移读取方）。

## 分阶段工作流约束

- 稳定阶段 ID 是 `topology`、`time-sync`、`flow-template`、`planning-export`。界面文案可按场景变化，但核心状态机不要改成场景专属 ID。
- **Phase A → Phase B 灰态**：`flow-template` / `planning-export` 在 UI 显示为 aria-disabled + tooltip + inline banner；阶段 ID 保留但不可推进。boss 在 P1 重新构建。
- `recordStageResult()` 默认让阶段进入 `waiting_confirmation`；只有用户确认后才能 `confirmCurrentStage()` 进入下一阶段。
- UI 的左上步骤导航应对应这四个用户可见阶段：拓扑、时间同步、流量规划、模拟仿真；稳定阶段 ID 仍是 `topology`、`time-sync`、`flow-template`、`planning-export`。
- 拓扑阶段写权威 = sidecar `topology.apply_operations` → SQLite P0 表；UI 通过 `query_topology` Tauri command 读取。
- 只有 `flow-template` 阶段完成或等待确认后，才显示流量规划内容（Phase A 期间始终不可达）。
- 只有 `planning-export` 阶段生成 bundle 后，才允许刷新/保存仿真输入/导出文件（Phase A 期间始终不可达）。
- 最终 `planning-export` 阶段确认后应标记完成，不要再次触发仿真输入导出造成确认循环。
- `flow_plan_1.json` 是规划器输入，不是规划器输出。不要在 MVP 中伪造 `flow_plan_result_1.json`、GCL 或 interface 摘要。

## 场景抽象约定

- 使用 `ScenarioConfig` 表达场景显示名、阶段文案、默认拓扑值、时间同步摘要、流模板和术语映射。
- 当前内置 `generic-tsn` 和 `aerospace-onboard`。未知场景 id 应回退到 `generic-tsn`，避免旧 session 无法打开。
- 后续新增 7 个应用场景时，优先新增配置和模板；只有存在真实流程差异时才扩展 workflow 能力。
- 不要使用“profile 契约”等不清晰造词；若需要抽象，直接说明为“场景配置”或 `ScenarioConfig`。

## Agent 与日志体验要求

- Agent 输出应逐步体现阶段进展，并在关键阶段等待用户确认。
- 执行步骤面板应让用户看到 stage、skill、artifact、confirmation，以及工具/MCP 可用状态摘要。
- 面向用户界面、聊天消息、按钮、toast、执行步骤标题、诊断抽屉和错误提示时，不要出现 `Claude`、`Claude Code` 等供应商敏感词；统一使用“智能助手”“Agent”“智能助手运行时”“工具权限”等中性表述。技术文档、代码标识、SDK 包名和内部命令名可保留真实名称。
- 诊断日志只保存脱敏摘要，例如 run id、resume 状态、chunk 统计、session 保存状态、artifact 路径和错误摘要。不要保存凭证、完整敏感上下文或大段原始工具输出。
- 真实 Claude SDK 的细粒度 `tool_use/tool_result` 解析仍是后续工作；当前不要假装已经完整支持。

## 导出边界

> **Phase A 状态**：`flow-template` / `planning-export` 阶段在 UI 灰掉，项目导出整条链路（含 `project-exporter.ts` / `project-writer.ts` / `export-manifest.ts`，已删除）暂时下线，Phase B 回归。下列契约为 Phase B 目标，当前不可达。
>
> **与会话导出区分**：会话导出/导入（单会话切片 `.db`，v0.4.0 已落地）是独立能力轨道，不受 Phase B 影响；导出文件携带完整会话 payload（对话 + 流程进度 + 拓扑，对话在入库时已 redact 脱敏），导入端校验 payload ≤2MB 且为合法 JSON object。

- Phase B 目标导出文件包括：
  - `tsnagent/generated/network.ned`
  - `omnetpp.ini`
  - `react-flow-topology.json`
  - `flow_plan_1.json`
  - `manifest.json`
- `omnetpp.ini` 只承诺最小 INET/OMNeT++ 可加载运行；gPTP、TAS/GCL、调度器选择、业务流应用和规划结果回写是后续扩展。
- 导出实现需要继续拒绝危险目录，例如 repo 根目录、home 根目录、应用配置目录、根目录和 symlink 目标。
- 拓扑数据不再走文件导出落盘：sidecar `topology.apply_operations` 直接写 SQLite P0 表，UI 通过 `query_topology` Tauri command 读取。

## 验证命令

- 常规前端和类型验证：`npm run build`
- 单元测试：`npm test`
- 浏览器端到端：`npm run e2e`
- Tauri/Rust 测试：`npm run cargo:test`
- worker 构建：`npm run build:worker`——`src-node/` 源码改动后必跑；dev 与 release 跑的都是 dist 产物，不重建则验证的是旧代码
- Tauri 开发入口：`npm run tauri dev`
- Vite Web 开发入口：`npm run dev`

## 发布与客户端构建流程

- GitHub 桌面端生产构建只允许在 `release/**` 分支触发；不要通过推送 `main` 触发客户端打包。
- 准备发布时，从已合入的 `main` 新建发布分支，例如 `release/v0.6.0`，再 push 该分支触发 `.github/workflows/production-build.yml`，全平台构建并由 tauri-action 建 GitHub release（tag `vX.Y.Z`）。
- workflow 会在打包前运行 `npm run release:prepare`，根据最近的 `vX.Y.Z` tag 到当前提交之间的 commit 自动决定版本号：
  - commit 含 `!` 或正文含 `BREAKING CHANGE:` 时升 major。
  - 存在 `feat:` 时升 minor。
  - 其他代码变更默认升 patch。
  - 没有历史 tag 时以 `package.json` 当前版本为基准。
- `npm run release:prepare` 同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`，并生成 `release-metadata.json` 与 `release-notes.md`（GitHub release 正文）。
- **CHANGELOG 是「大模型/人工精修」的事实源，CI 只读取、不生成。** `prepare-release` 从 `CHANGELOG.md` 读取与本次版本号匹配的顶层条目当 release 正文；**缺该条目即报错中止发版**。发版前必须先把该版本的 `## vX.Y.Z - 日期` 精修条目写进 `CHANGELOG.md` 并提交进 `main`（条目写客户可见的人话，参照已有 v0.4.x 风格，不是 commit 标题）。app 内版本 banner 取 `CHANGELOG.md` 顶部条目的版本号。
- 若只是本地检查版本计算，使用 `npm run release:prepare:check`（dry-run，不写文件、不校验 CHANGELOG 条目）。

### 助手处理「发版」类请求的固定流程

当用户说「发版」「发布」「出新版本」「release」等词时，自动按以下顺序执行（无需逐步追问）：

1. 跑 `npm run release:prepare:check` 取下一个版本号（版本号自动 bump，不需用户手填）。
2. 根据自上次 release tag 以来的 commit / 改动，**起草该版本的客户可见精修 CHANGELOG 条目**（人话、按 新功能 / 优化 / 修复 分类，参照已有 v0.4.x 风格）。
3. **把草稿展示给用户扫一眼确认**——这是公开发布前的唯一确认点，未确认前不要 push 发布分支。
4. 用户确认后：把条目写进 `CHANGELOG.md` 顶部、提交进 `main` → 从 `main` 建 `release/vX.Y.Z` 并 push 触发构建。
5. 构建完成后，用同一条目更新该 `vX.Y.Z` GitHub release 的正文。

## 工作习惯

- 修改前优先读相关文件和测试，保持改动聚焦。
- 提交前至少跑与改动相关的测试；触及 workflow、导出、会话或 UI 主流程时，优先跑 `npm run build`、`npm test`、`npm run e2e`。
- `tsn-topology/` 是已有独立 skill 仓库/参考目录，不要默认把它纳入根项目修改范围。
