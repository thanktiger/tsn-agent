---
title: "test: 2026-06-01-002 计划的单测与 E2E 测试方案"
type: test-strategy
status: superseded
date: 2026-06-01
related_plan: docs/plans/2026-06-01-002-feat-agent-runtime-and-session-experience-plan.md
origin: ce:work 实施前测试方案对齐
superseded_by: docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md
superseded_on: 2026-06-05
superseded_reason: "配套 2026-06-01-002 的测试策略；实现经 06-03-001 PR-β1 重写后测试基线随之重建（269→194），原策略作废"
---

# 2026-06-01-002 单测与 E2E 测试方案

本文件按 plan 的 11 个 implementation unit 组织测试目标、文件归属与关键断言。**优先列单测，e2e 的可信度建立在单测之上。** 实施期每个 unit 的单测随该 unit 同 commit 落地，不延后。

---

## 测试栈与框架

| 层 | 框架 | 范围 |
| --- | --- | --- |
| TS/React 单测 | vitest + Testing Library | `src/**/*.test.ts(x)` |
| Node 单测 | vitest | `src-node/**/*.test.mjs`、`src-node/**/*.test.ts` |
| Rust 单测 | `cargo test` | `src-tauri/src/**/*` 内置 `#[cfg(test)]` |
| Rust 集成测试 | `cargo test --test <name>` | `src-tauri/tests/*.rs` |
| UI smoke E2E | Playwright + Vite | `e2e/specs/ui-smoke.spec.ts` |
| Real-agent E2E | `cargo test` + `tauri::test::mock_builder` | `src-tauri/tests/real_agent_e2e.rs` |

**Vitest setup 兜底（U5）：** 全局 `setupFiles` 默认让 `runTsnAgent` 返回 `AgentRuntimeUnavailableResult` 并在 console 打印警告，强制每个测试显式选择 fixture；不抛错以避免破坏 in-flight 分支。

---

## 一、单元测试层

### U1. Agent 契约与 sanitizer

**文件：**
- 新：`src/agent/agent-types.test.ts`、`src/agent/agent-sanitizer.test.ts`、`src/test/agent-result-fixtures.test.ts`
- 扩：`src/sessions/session-repository.test.ts`

**测试目标：**

- 三态 result 类型守卫 `isAgentSuccess` / `isAgentFailurePreservedState` / `isAgentRuntimeUnavailable` 互斥
- `sanitizeAgentStepDetail()` allowlist fail-closed：传入含 `prompt`、`headers`、`cookie`、`authorization`、`full.topology`、`stdout`、`stderr` 等字段，断言全部 drop；只保留 allowlist 字段（`traceId/runId/toolUseId/toolName/status/inputSummary/outputSummary/errorSummary/durationMs/counts/createdAt`）
- `sanitizeAgentStepDetail()` 未知字段 fail-closed：传入 `foo: "bar"`、`__proto__: {...}`，断言被 drop
- dev 构建 dropped key 观察性：传入未知字段后，`DiagnosticLogEntry.details.__droppedKeys` 含 key 名列表（仅 key 名、无值）；生产构建只有 `droppedKeysCount`
- `redactVendorNames()` 词表：含 `anthropic`/`Anthropic`/`Claude`/`claude-sonnet-4-5`/`api.anthropic.com`/`x-request-id`/`x-anthropic-*` 输入被替换；纯净输入不动
- fixture builder 类型约束：三种 `failureReason`（`agent_error` / `stall_timeout` / `no_stage_result`）各自的字段
- session normalize 降级：旧 session 没 `runId/traceId/sequence` 的事件能 normalize，按 `createdAt` 降级排序
- session normalize 打 `legacyFakeOrigin`：旧 session result 字段含 `mode: "fake"` 时设 `Session.metadata.legacyFakeOrigin = true`
- session normalize pending 步骤迁移：跨重启残留 pending 步骤改为 `status: "unknown"`

### U2. Worker `agent_step` 事件 + audit 边界

**文件：** 扩 `src-node/claude-agent-worker.test.mjs`

**测试目标：**

- `extractOperationTraceEvents()` 输出从 chunk-text 改为 agent_step draft（含 `runId/traceId/sequence/toolUseId/toolName/inputSummary/outputSummary/status`）
- `prependOperationTrace()` 不再拼工具 trace：含 tool_use/tool_result 的 fixture，最终 `assistantText` 不含 `[工具]`/`[工具结果]`/`[文件]` 前缀
- 流式 `agent_step` envelope shape 通过 JSON schema 断言
- `done` response 返回 `agentSteps`，与流式事件按 `traceId` 去重合并
- 同 `toolUseId` 的 call/result 合并为一个逻辑步骤
- 未配对步骤上限：构造 50 个孤儿 tool_result → 30 条独立 + 1 条"其余 20 个未配对调用"
- 单事件 payload > 16KB：worker 标 `status: "truncated"` 并用聚合摘要替代
- 单 run > 200 步：剩余折叠为单条 truncated 事件
- worker audit JSON：失败/成功两路径写入后 grep 断言不含 `prompt`/`stdout`/`stderr`/`full.topology`/`changeSet`/`Authorization`
- audit 历史迁移：fixture 一个旧 `{timestamp}-{runId}.json` + `latest.json`，worker 启动后断言迁移为新 schema 且失败不阻塞写入

### U3a. Adapter fail-closed 三态

**文件：** 重写 `src/agent/agent-adapter.test.ts`

**测试目标：**

- non-Tauri：返回 `AgentRuntimeUnavailableResult`，`shouldApplyProject: false`，`assistantText` 含 CTA 占位
- 真实 Agent 成功 + 合法 stage result：`AgentSuccessResult`，project 应用
- 真实 Agent 成功 + 无 stage result：`AgentFailurePreservedStateResult`、`failureReason: "no_stage_result"`，project 保留，rejection summary 写诊断日志
- 真实 Agent 抛错 + session 有 project：`failureReason: "agent_error"`，project/workflow/bundle 原样保留
- 真实 Agent 抛错 + session 无 project：结果不含 project/bundle
- 错误体含 `anthropic` / `Claude` / `api.anthropic.com`：`assistantText` 与 `errorSummary` 已脱敏
- `legacyFakeOrigin: true` session 推进：adapter 仍调真实 Agent，不信任旧 project
- 诊断日志不再出现"fake 模式" / "回退本地模式"
- 三种 `failureReason` 的 user-visible message 各不相同

### U3b. Tauri 事件通道 + watchdog

**文件：**
- 扩 `src/agent/agent-adapter.test.ts`（listener / watchdog 段）
- 新增 Rust 单测于 `src-tauri/src/commands.rs` 内置 `#[cfg(test)]`

**TS 端测试目标：**

- `listenToRunEvents` 分发：mock Tauri 事件，`kind: "chunk"` → `onChunk`、`kind: "agent_step"` → `onAgentStep`、未知 kind 丢日志不报错
- `chunk` 只更新 assistant 气泡；`agent_step` 只更新 in-flight buffer
- Watchdog stall-timer：mock 时钟，run 后 90s 无任何事件 → 合成 `kind: "agent_run_aborted", status: "aborted"`、`AgentFailurePreservedStateResult`、`failureReason: "stall_timeout"`
- Watchdog reset：每收到 chunk/agent_step 重置 stall-timer，60s + 60s + 推进 → 不触发 abort
- Late-done discard：watchdog 已 abort 后，Rust 端 200s 后才返回 done → adapter discard，不写入 session
- 单事件 > 16KB（Tauri 转发后）仍带 `truncated` 标记

**Rust 端测试目标：**

- `ClaudeAgentEventPayload` serde：`step: Some(json)` / `step: None` 都能正反序列化
- 未知 `kind` 字段 forward 不 panic
- `export_run_audit` 输入校验：sessionId 含 `..` / `/` / NUL / 空 → 拒绝；canonicalize 后路径不在 `<app_data_dir>/agent-runs/` 下 → 拒绝
- `export_run_audit` save dialog：渲染端传入裸路径被忽略，必须走 dialog 返回路径

### U3c. App runId 派生 + final response 合并

**文件：** 扩 `src/app/App.test.tsx`、`src/sessions/session-repository.test.ts`

**测试目标：**

- 提交时生成 `runId`（mock `crypto.randomUUID`）：user message、pending assistant、后续 step 事件共享同一 `runId`
- 同 session 并发锁：pending 期间再次点击提交 → 按钮禁用、第二次调用不触发
- Final response merge：流式 buffer 3 步 + final response 3 步且 `traceId` 重叠 → session 持久化只有 3 步
- Done 解析失败：fallback 用 in-flight buffer，run 标 `partial: true`
- 跨 trust boundary 再 sanitize：mock worker final response 故意塞 `prompt: "secret"` → adapter 落 session 前已 drop
- 切换 session 后旧 run 迟到事件不写入新 session 当前 run
- 旧 session 没 runId：UI 按 `createdAt` 降级排序

### U4. 删除 fake-agent + 覆盖等价 gate

**前置 gate（PR description）：** 附 `fake-agent.test.ts` 原 `it` → 新位置映射表，逐条标"迁移到 X" 或"故意删除（属真实 Agent E2E）"

**文件分配：**

| 原 fake-agent.test.ts 覆盖 | 新位置 |
| --- | --- |
| 拓扑规模 / 模板 / 双平面规则 | `src/topology/initialize.test.ts`、`src/topology/templates.test.ts` |
| 节点 / 链路 CRUD（合法 / 缺参 / 歧义 / 重复 ID） | `src/topology/operations.test.ts` |
| inspect / intermediate 查询 | `src/topology/inspect.test.ts`、`src/topology/intermediate.test.ts` |
| artifacts / project-bridge | `src/topology/artifacts.test.ts`、`src/topology/project-bridge.test.ts` |
| MCP envelope 边界 | `src-node/mcp/topology-tools.test.ts` |
| 阶段 waiting/confirm/request changes/final | `src/project/project-state.test.ts` |
| 导出 bundle | `src/domain/topology-factory.test.ts` 或对应 exporter test |

**故意删除（不迁移）：**

- 自然语言"继续 / 确认 / 改成 N 台"模拟智能助手行为 → 属真实 Agent E2E
- `parseTopologyIntent()` 自然语言解析覆盖 → 属 prompt/skill 层

### U5. React/UI fixture 重写

**文件：** 重写 `src/app/App.test.tsx`（大部分 case）、新增 `src/test/agent-result-fixtures.ts` 测试 setup

**测试目标：**

- vitest setup 兜底：未 mock `runTsnAgent` 的测试默认返回 `AgentRuntimeUnavailableResult` 并 console 警告
- 三个命名 fixture 各驱动一段 UI：拓扑待确认 / 失败保留 / runtime unavailable
- 含 runId + 多步骤成功结果 → UI 步骤摘要组渲染
- 含错误步骤的失败保留 → UI 原拓扑保留 + 错误卡 + vendor 名脱敏
- runtime unavailable → 错误卡 + "下载桌面版" CTA + 链接走 `VITE_DESKTOP_DOWNLOAD_URL`
- 流式 chunk：fixture 模拟 deferred promise → UI 显示 streaming 状态

### U6. 主会话流步骤摘要 + 详情展开 + 旧 session normalize

**文件：** 扩 `src/app/App.test.tsx`、可选 snapshot

**测试目标：**

- 步骤摘要按 run 分组渲染：连续两轮提交，DOM 两个 run 容器
- 步骤卡 7 态视觉差异（snapshot 或 classname 断言）：`pending` / `streaming` / `success` / `error` / `no-detail` / `orphan` / `aborted`
- 点击展开 + 同时只一个：点 step 1 → detail 出现；点 step 2 → step 1 detail 消失、step 2 detail 出现
- 失败 run 默认展开摘要不展开详情：第二次提交失败后回看，可见步骤摘要列表但无 detail
- 同 `toolUseId` 的 call/result 显示为一个逻辑卡，状态从 pending → success/error 切换
- 旧事件无 detail：详情区显示"该步骤没有保存更多详情"
- `scrollIntoView` 用户点击触发，streaming 更新不触发（spy `scrollIntoView`）
- 旧 session normalize：fixture 一个含 `[工具]` 行的旧 assistant message，打开后断言 session JSON 中 message 文本已被重写（不只是 render 隐藏）
- normalize 失败回退：mock 写入失败 → render-only 清洗仍生效，诊断日志增一条
- `legacyFakeOrigin: true` 提示卡：可见 + "复制需求新开会话"按钮可点击（生成新 session 并 prefill）+ "我知道了"写入 `legacyOriginAck`
- runtime unavailable CTA 卡：`VITE_DESKTOP_DOWNLOAD_URL` 缺失时回退到 README anchor
- 底部配置区不再有"执行步骤"页签
- 可访问性：`aria-expanded` / `aria-controls` 正确、Escape 关闭并焦点回到触发按钮、`aria-live="polite"` 在新步骤到达时触发

### U7. 日志改名 + audit 边界

**文件：** `src/ui/diagnostics/DiagnosticsDrawer.test.tsx`、`src/diagnostics/app-diagnostics.test.ts`、扩 `src/app/App.test.tsx`

**测试目标：**

- 工具栏按钮文案"日志"、抽屉标题"日志"、副标题"程序运行日志"
- 日志条目标题用程序语义（"运行完成 · 7 个步骤 · 1 个错误"）
- 日志 details 含 `runId/stepCount/errorStepCount/traceIds/droppedKeysCount`
- dev 构建 details 含 `__droppedKeys`（key 名列表）；生产只有计数
- 现有 session/artifact/planner 日志筛选器仍工作
- audit 文件路径：fixture 写入后 `fs.stat` 断言路径 `<app_data_dir>/agent-runs/{sessionId}/{runId}.json`
- audit 文件 mode：POSIX `0o600`；Windows ACL 等效或 skip
- 21 个 run 触发轮转：写入 21 条后断言剩 20 条且最旧被删
- audit 不随 session export：mock session export 后断言 audit 目录未被拷
- `export_run_audit` UI 入口：日志抽屉中每条 Agent run 完成记录右侧有"导出 audit"按钮

---

## 二、E2E 测试层

### UI smoke（Playwright + Vite）

**文件：** 重命名 `e2e/specs/smoke.spec.ts` → `e2e/specs/ui-smoke.spec.ts`；`package.json` 新增 `e2e:ui-smoke` 脚本

**测试目标（每条 < 5s）：**

1. fixture 打开页面，初始拓扑画布可见
2. 提交输入 → runtime unavailable 错误卡可见 + "下载桌面版" CTA href 非空
3. fixture mock `runTsnAgent` 返回多步骤成功 → 步骤摘要组渲染、点第 1 个 → 详情可见、点第 2 个 → 详情切换
4. 失败保留 fixture → 原拓扑保留 + 错误卡可见 + vendor 词不出现在 DOM
5. `legacyFakeOrigin` fixture session → 顶部提示卡可见、"我知道了"点击后 reload 不再出现
6. 侧栏工具栏文案"日志"，点击打开抽屉
7. 底部配置区不再有"执行步骤"页签

**显式不在 UI smoke：** 真实 Agent 调用、真实 MCP、真实 worker。

### Real-agent E2E（cargo test + tauri-test）

**文件：**
- 新：`src-tauri/tests/real_agent_e2e.rs`
- 改：`src-tauri/Cargo.toml`（`[dev-dependencies]` 加 `tauri = { version = "2", features = ["test"] }`）
- 改：`package.json` 新增 `e2e:real-agent` 脚本 → `cargo test --test real_agent_e2e -- --ignored`

**测试用例（全部 `#[ignore]`）：**

1. **`real_agent_topology_initialize_happy_path`**：mock_builder 起 app → 调 `run_claude_agent`、参数"创建 4 个交换机的拓扑"→ 断言：
   - worker 通过 Node sidecar 拉起（`find_worker_path()` 解析到 dev 构建产物）
   - 真实 SDK 调用走 `ANTHROPIC_API_KEY`
   - stage result 应用、project/bundle 落到 `<app_data_dir>`
   - audit 写入符合 R38 路径与 mode

2. **`real_agent_failure_preserves_state`**：故意用无效 key → Agent 抛 401 → 断言：
   - 返回 `AgentFailurePreservedStateResult`
   - 无新 project 创建
   - 错误体中的 `anthropic` 已被 redactor 脱敏

3. **`real_agent_audit_path_and_mode`**：跑一次成功 run → `fs::metadata` 断言路径 `<app_data_dir>/agent-runs/{sessionId}/{runId}.json`，POSIX `mode == 0o600`

4. **`real_agent_credential_missing_skips`**：unset `ANTHROPIC_API_KEY` → 测试 skip 并打印 skip reason（不 panic、不泄露 env）

**泄露防护机制（mod-level setup）：**

- `std::panic::set_hook` 入口拦截 panic message 跑 vendor+key regex 替换
- `RUST_BACKTRACE=0`
- test runner 包装 stdout+stderr 通过 sanitizer 才落到 CI artifact
- 测试结束自动 `std::env::remove_var("ANTHROPIC_API_KEY")`
- CI job 末尾跑 `grep -c "sk-ant"` 验证 artifact 不含 key 前缀，命中则 fail

**显式不在 real-agent E2E：**

- JS 端 adapter 的 stall-timer / runId 派生 / 主会话渲染（由 U3b/U3c/U6 单测覆盖）
- 步骤摘要 UI 行为（由 UI smoke 覆盖）

---

## 三、运行命令

```bash
# 开发期
npm test                                                # vitest 跑 U1-U7 + cross-cutting
npm run cargo:test                                      # 跑 U3b Tauri 单测、U7 audit 单测（非 ignored）
npm run e2e:ui-smoke                                    # 本地 ~5s 跑完 UI 行为
cargo test --test real_agent_e2e -- --ignored           # 本地手动验真实链路（需本地 ANTHROPIC_API_KEY）

# CI（PR）
npm test
npm run cargo:test
npm run e2e:ui-smoke
# 不跑 --ignored

# CI（nightly on main）
上述 + cargo test --test real_agent_e2e -- --ignored

# Ship gate
最近一次 nightly real-agent E2E 通过
```

---

## 四、覆盖完整性 gate

实施期 PR description 必须列出：

1. **U4 等价覆盖映射表：** `fake-agent.test.ts` 原 `it` → 新位置 / 故意删除（属 E2E）
2. **U2 大小限制测试：** 16KB / 200 steps / 30 unpaired 三个 cap 各有 explicit 测试
3. **U6 七态步骤卡测试：** snapshot 或 classname 断言每态独立可识别
4. **泄露回归 grep：** `npm test` 通过后跑 `rg -n "runFakeTsnAgent|VITE_TSN_AGENT_MODE|mode: \"fake\"|回退本地模式|\[工具\]|\[工具结果\]|\[文件\]|执行日志" src docs` 应只剩历史归档或 0 命中

---

## 五、不在本测试方案中（属 follow-up）

- 跨设备 sync 冲突的 normalize 行为（R27 二轮 review 标记的 P1 follow-up）
- `export_run_audit` 的 audit 内容是否比 UI 多（P1 review 标记）
- Web→Desktop CTA 点击后的 prompt 转移流程
- changeSet diff viewer 的用户审计路径（AE12 follow-up）
- 多窗口 / 多 tab 并发 run 行为（R36 第一版假设单窗口）
- 性能回归测试（步骤摘要 200 条时的渲染性能）
- 视觉 token 与设计系统对齐的回归（属设计 follow-up）
