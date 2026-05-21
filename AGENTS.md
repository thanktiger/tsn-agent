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

## 关键代码入口

- `src/app/App.tsx`：主界面、聊天输入、阶段确认、步骤导航、artifact 显示和导出按钮门禁。
- `src/app/App.css`：主界面样式。
- `src/agent/agent-adapter.ts`：真实 Claude agent 与 fake agent 的适配层，负责 session/workflow 透传和诊断日志。
- `src/agent/fake-agent.ts`：Web/E2E 环境的确定性 agent，实现分阶段推进、确认、快速路径和 agent event。
- `src/domain/scenario-config.ts`：轻量场景配置。新增应用场景时优先扩展这里，不要复制核心 workflow。
- `src/domain/topology-factory.ts`：从自然语言和场景默认值生成 canonical TSN project。
- `src/project/project-state.ts`：workflow state、阶段状态、确认、请求修改、旧 session 归一化。
- `src/project/project-exporter.ts`、`src/project/project-writer.ts`、`src-tauri/src/project_writer.rs`：导出边界和写盘实现。
- `src/sessions/session-repository.ts`、`src-tauri/src/session_store.rs`：Web localStorage 与 Tauri SQLite 会话保存。
- `src/diagnostics/*`、`src/ui/diagnostics/DiagnosticsDrawer.tsx`：脱敏诊断日志和日志抽屉。
- `src-node/claude-agent-worker.mjs`：Tauri 中通过本机 Node worker 调用官方 `@anthropic-ai/claude-agent-sdk`。

## 分阶段工作流约束

- 稳定阶段 ID 是 `topology`、`time-sync`、`flow-template`、`planning-export`。界面文案可按场景变化，但核心状态机不要改成场景专属 ID。
- `recordStageResult()` 默认让阶段进入 `waiting_confirmation`；只有用户确认后才能 `confirmCurrentStage()` 进入下一阶段。
- UI 的左上步骤导航应对应这四个用户可见阶段：拓扑、时间同步、流量规划、模拟仿真；稳定阶段 ID 仍是 `topology`、`time-sync`、`flow-template`、`planning-export`。
- 拓扑阶段可以生成 canonical project，但 UI 不应提前展示流量规划为“已完成”。
- 只有 `flow-template` 阶段完成或等待确认后，才显示流量规划内容。
- 只有 `planning-export` 阶段生成 bundle 后，才允许刷新/保存仿真输入/导出文件。
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

- 当前导出文件包括：
  - `tsnagent/generated/network.ned`
  - `omnetpp.ini`
  - `react-flow-topology.json`
  - `flow_plan_1.json`
  - `manifest.json`
- `omnetpp.ini` 当前只承诺最小 INET/OMNeT++ 可加载运行；gPTP、TAS/GCL、调度器选择、业务流应用和规划结果回写是后续扩展。
- 导出实现需要继续拒绝危险目录，例如 repo 根目录、home 根目录、应用配置目录、根目录和 symlink 目标。

## 验证命令

- 常规前端和类型验证：`npm run build`
- 单元测试：`npm test`
- 浏览器端到端：`npm run e2e`
- Tauri/Rust 测试：`npm run cargo:test`
- Tauri 开发入口：`npm run tauri dev`
- Vite Web 开发入口：`npm run dev`

## 工作习惯

- 修改前优先读相关文件和测试，保持改动聚焦。
- 提交前至少跑与改动相关的测试；触及 workflow、导出、会话或 UI 主流程时，优先跑 `npm run build`、`npm test`、`npm run e2e`。
- `tsn-topology/` 是已有独立 skill 仓库/参考目录，不要默认把它纳入根项目修改范围。
