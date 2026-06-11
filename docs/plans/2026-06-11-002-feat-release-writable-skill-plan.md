---
title: "feat: release 可写 skill（app-data 播种副本 + worker 同源）"
type: feat
status: completed
date: 2026-06-11
---

# feat: release 可写 skill（app-data 播种副本 + worker 同源）

## Summary

打包 release 下界面编辑 skill 可保存并被 agent 下次 run 消费：skill 有效根的解析收口为单一决策函数，顺序「开发态仓库路径（仅 debug 构建）→ app-data 可写副本（缺失时从内置 Resource 播种）→ Resource 只读兜底」；worker 经 spawn payload 拿到同一个有效根，保证编辑器与 agent 永远同源。开发态行为不变。升级语义为「缺失才播种」：用户编辑在 app 更新后保留，不自动合并新内置指引（「重置为内置版本」按钮 deferred）。

---

## Problem Frame

`docs/plans/2026-06-09-002-refactor-editable-skill-guidance-source-plan.md` 把 SKILL.md 做成可编辑指引事实源时，把 release 可写显式 deferred（其 Scope Boundaries 预设了与本计划一致的方向：首次启动复制到可写目录、worker 与编辑器都指向该副本）。**本计划把该 deferred 项转为 in-scope 实现**（boss 2026-06-11 拍板）。当前 release 形态：

- `skill_files.rs::resolve_skill_root` 两级解析——仓库路径（`CARGO_MANIFEST_DIR` 编译期烙入，**无 debug 守卫**）→ Resource 只读。release 下界面只读，`write_skill_file` 拒绝保存。
- worker `buildSystemPromptForStage` 硬编码 `join(cwd, ".claude/skills/tsn-topology/SKILL.md")`；release 下 worker cwd = Resource 根，读内置副本。
- 既有缺陷：编辑器与 worker 是**两套独立的根解析**且优先级不一致（编辑器无 `cfg!(debug_assertions)` 守卫、worker 的 `find_worker_path` 有）——开发机上跑 release 构建时，编辑器解析到仓库可写路径而 worker 读 Resource，两端已可能不同源。本计划收口为单一决策函数，顺带修复。

---

## Requirements

- R1. release 打包下，界面编辑 skill 文件可保存（`write_skill_file` 成功），保存内容跨 app 重启持久。
- R2. 同源：agent run 注入的 SKILL.md 与界面编辑的是同一份文件——编辑器三命令与 worker spawn 消费同一个有效根决策。
- R3. 开发态（debug 构建）行为不变：直接读写仓库 `.claude/skills/`，git 可追踪；worker 注入链路不变。
- R4. 升级语义：app-data 副本按「目录缺失才播种」；用户编辑在 app 升级后保留；不自动合并新内置指引。
- R5. 降级安全：播种/解析失败回退 Resource 只读（UI 如实显示只读原因）；worker 读不到 SKILL.md 保持既有 fail-open（仅骨架注入 + `skill_guidance_unavailable` 审计警告），不崩 app / agent。
- R6. app-data 写入边界：只创建/写入自有 `skills/` 子目录，绝不清理或触碰同级内容（用户备份等资产真实存在）；沿用既有路径逃逸守卫与原子写。

---

## Key Technical Decisions

- **KTD1 单一有效根决策函数，工作在 skills 父根级。** 新增 `resolve_effective_skill_root`（按候选路径参数化的纯函数 + AppHandle 壳层），候选 = 仓库 `.claude/skills`、app-data `skills/`、Resource `.claude/skills` 三个**父根**：debug 构建优先仓库路径；非 debug 跳过仓库路径直接 app-data → Resource。返回选中父根 + writable/status；编辑器三命令在选中父根上 join skill_id（子目录不存在维持既有 Unavailable 语义），worker payload 直接携带选中父根。混合播种状态（某 skill 目录播种失败缺失）不影响父根选择——缺失目录由编辑器 Unavailable / worker fail-open 各自兜底。编辑器与 worker 共同消费同一决策，消灭两套优先级表的漂移（修复既有不对称）。纯函数层不依赖 AppHandle，沿用 `skill_files.rs` tests 的 temp-dir 模式可单测。
- **KTD2 worker 传递通道走 spawn payload（argv JSON），不走 env。** 项目既有约定：秘密走 env（DB_RPC_TOKEN）、非敏感配置走 payload（cwd/auditDir/runId）。注意：worker 的 `runWorker` 对 payload 逐字段显式映射、审计摘要为显式白名单——新字段**不会自动**出现在审计里，skillRoot 的审计记录由 U3 显式追加才获得。范围同步时口头说的「环境变量」在此调整为 payload，机制（同源注入）不变。
- **KTD3 播种策略：懒播种、目录粒度、以 Resource 实际存在为准。** 首次解析有效根时幂等 ensure：对 Resource 下实际存在的 skill 目录（当前 `tsn-topology/`、`tsn-flow-planning/`），若 app-data `skills/<id>/` 不存在则整目录复制。不按 `SKILL_IDS` 白名单盲遍历（`tsn-time-sync`/`tsn-inet-export` 无资源，遍历会制造空目录）。复制用临时名 + rename 落位，半成品目录不会被当成已播种。
- **KTD4 注入形态不变。** worker 仅改 SKILL.md 读取根的来源（`resolvedOptions.skillRoot ?? payload.skillRoot ?? join(cwd, ".claude/skills")`），单字符串拼接 + `<<<SKILL_GUIDANCE>>>` sentinel + fail-open 降级全部保持——`string[]` 会崩 `redactSecrets` 是上轮评审实证过的回退。
- **KTD5 不动 cwd / settingSources / model pin。** cwd 被 topology MCP server 路径解析与 settingSources "project" 依赖，挪作 skill 根会破坏 release；settingSources 含 "user" 的 model 继承坑已用显式 pin 解决，本次不触碰。
- **KTD6 app-data 位置：`app_data_dir()/skills/`。** 与 `agent-runs/` 审计目录同级同模式（`commands.rs::agent_audit_dir` 先例）；DB 用的 `app_config_dir` 在 macOS 与之同路径，但语义上 skill 副本是数据不是配置。

---

## Implementation Units

### U1. 有效根决策 + 播种（Rust）

- **Goal**: `skill_files.rs` 解析升级为三级（debug 仓库 → app-data 播种副本 → Resource 只读），编辑器三命令在 release 下拿到可写根。
- **Requirements**: R1, R3, R4, R5, R6
- **Dependencies**: 无
- **Files**:
  - 修改 `src-tauri/src/skill_files.rs`（`resolve_skill_root` → 单一决策函数 + 播种；tests 模块扩展）
- **Approach**: 决策逻辑抽成路径参数纯函数（候选三父根 → `SkillRoot`，见 KTD1），AppHandle 壳层只负责取候选路径。播种为独立纯函数 `seed_skill_dir(src, dst)`：dst 存在即跳过；先 `create_dir_all` 出 app-data `skills/` 父目录（首启目录树可能完全不存在）；复制时**逐项用 `symlink_metadata` 检查、跳过 symlink 条目**（对齐编辑器侧既有 symlink 守卫，防 Resource 内 symlink 被解引用复制进用户目录）；复制到 `dst.tmp-<nanos>` 再 rename。**rename 失败后复查 dst：已存在 = 并发播种者已落位，清理自身临时目录后按已播种成功返回；仅 dst 仍缺失才回退 Resource Readonly**（编辑器命令与 worker spawn 可并发触发首播）。debug 构建走仓库候选时**完全跳过播种**（开发机不悄悄长出无人消费的 app-data 副本）。dev 候选用 `cfg!(debug_assertions)` 守卫（对齐 `find_worker_path`）。app-data 副本可写 → `status: Available`；播种失败落 Resource → `status: Readonly`，失败原因经 `SkillRoot` 新增 reason 字段穿到 `readonly_reason`（现有管道只有 per-file 硬编码原因，需小幅扩展）。错误一律 `Result<_, String>` 中文文案（项目惯例）。
- **Patterns to follow**: `skill_files.rs` 既有 tmp+rename 原子写与 `resolve_existing_file` 逃逸守卫；`commands.rs::agent_audit_dir` 的 `app_data_dir` 用法；tests 模块的 temp-dir 手工搭建（`create_test_skill_root`/`cleanup`）。
- **Test scenarios**:
  - 纯函数：dev 候选存在且启用 → 选 dev 可写（开发态回归）。
  - dev 候选禁用、app-data 缺失、resource 存在 → 播种发生，返回 app-data 可写；再次解析不重复播种（幂等，文件内容保留）。
  - app-data 已存在（含用户修改内容）→ 不覆盖，直接返回可写根（R4）。
  - resource 缺失且 app-data 缺失 → Unavailable（既有语义）。
  - 播种复制失败（dst 父目录只读注入）→ 回退 Resource Readonly 带原因，不留半成品目录（tmp 名不被识别为已播种）。
  - rename 前 dst 被预先创建（模拟并发输家）→ 按已播种成功返回 app-data 可写根，自身临时目录被清理。
  - 源目录含 symlink 条目 → 播种跳过该条目，app-data 内不出现 symlink 目标内容。
  - app-data `skills/` 父目录不存在（首启）→ 播种自动建出目录树。
  - 播种只创建 `skills/<id>` 子目录：app-data 根下预置无关文件/目录，播种后原样存在（R6）。
- **Verification**: `npm run cargo:test` 全绿；既有 `list/read/write_skill_file` 单测不回归。

### U2. worker spawn 同源 payload（Rust）

- **Goal**: spawn worker 时把 U1 决策出的有效 skill 根放进 argv payload，编辑器与 agent 消费同一决策。
- **Requirements**: R2
- **Dependencies**: U1
- **Files**:
  - 修改 `src-tauri/src/commands.rs`（`run_claude_agent_blocking` payload 增 `skillRoot` 字段）
  - 修改 `AGENTS.md`（payload 字段说明，与 `TSN_AGENT_SKILL_OUTPUT_DIR`——agent 运行期输出 scratch——的语义区分写清）
- **Approach**: 调 U1 的决策函数取父根（worker 只需要根路径，不关心 writable）；解析失败不阻塞 spawn——payload 省略该字段，worker 走 cwd 兜底。**注意该兜底在 release 下不是 R5 告警链**：cwd = Resource 根且工厂 SKILL.md 在 Resource 内，cwd 兜底会**成功读到工厂副本**、`skill_guidance_unavailable` 不触发——界面编辑与 agent 消费的 desync 在此失败路径上静默复活。因此 Rust 侧解析失败省略字段时必须用既有 `log_worker_event` 发 warn（注明本次 run 走 cwd 兜底、release 下等价于工厂副本），留下可排查痕迹。skill 根传「skills 目录」而非单文件路径，worker 端自行 join skill id（为后续阶段 skill 复用同一根留口，不新增多余抽象）。
- **Patterns to follow**: payload 既有字段（cwd/auditDir/runId）的构造与命名；`TSN_AGENT_*` 命名仅用于 env，payload 字段用 camelCase；`log_worker_event` 既有告警基础设施。
- **Test scenarios**: payload 构造若有可测纯函数则断言含 `skillRoot`；否则以 U3 worker 侧测试为该链路的行为覆盖（Rust 侧 `run_claude_agent_blocking` 吃 AppHandle，按既有测试边界不强行单测）。`Test expectation: none -- payload 构造无独立纯函数时，行为由 U3 worker 测试覆盖`。
- **Verification**: `npm run cargo:test` 全绿。

### U3. worker SKILL.md 读取根可配（Node worker）

- **Goal**: `buildSystemPromptForStage` 的 skill 根来源改为 `resolvedOptions.skillRoot ?? payload.skillRoot ?? join(cwd, ".claude/skills")`，release 下读 app-data 副本。
- **Requirements**: R2, R3, R5
- **Dependencies**: U2
- **Files**:
  - 修改 `src-node/claude-agent-worker.mjs`（根解析 + 审计摘要记录 skillRoot）
  - 修改 `src-node/claude-agent-worker.test.mjs`
- **Approach**: 只改读盘 base path 来源；拼接形态、sentinel、fail-open 降级（仅骨架 + `skill_guidance_unavailable`）原样保持（KTD4）。审计摘要（既有 cwd/settingSources 记录处）追加 skillRoot，便于真机排查同源问题。改完必跑 `npm run build:worker`（dev 也跑 dist 产物）。
- **Patterns to follow**: `resolvedOptions.X ?? 默认值` 的测试注入缝（stageResultPath/skillOutputDir 同款）；既有两条 SKILL 注入测试的 mkdtemp 构造方式。
- **Test scenarios**:
  - 既有用例回归：cwd 下 `.claude/skills` 存在且未指定 root → 注入正文（兜底路径不回归）。
  - 新用例：指定 skillRoot（option 注入，不污染 process.env）指向另一临时目录 → 注入该目录的 SKILL.md 正文，即使 cwd 下存在不同内容（root 优先于 cwd）。
  - 新用例：指定的 skillRoot 不存在 → 降级为仅骨架 + `skill_guidance_unavailable`（fail-open 不崩）。
- **Verification**: `npm test` 全绿；`npm run build:worker` 通过（verify-skills 闸不受影响——本计划不增删打包资源映射，已对照脚本验证）；dev 跑通一轮 agent（手动）确认审计摘要含 skillRoot。

### U4. 前端只读语义文案更新（React）

- **Goal**: `SkillFilePreview` 的只读提示从「发版应用不可编辑」改为反映新语义：只读仅发生在播种失败回退 Resource 的兜底场景。
- **Requirements**: R5
- **Dependencies**: U1
- **Files**:
  - 修改 `src/ui/skills/SkillFilePreview.tsx`（readonly 提示文案）
  - 修改 `src/ui/skills/SkillFilePreview.test.tsx`（文案断言同步）
- **Approach**: status 枚举与 service 类型不变（`available/readonly/unavailable` 三态语义未动，release 正常路径从 readonly 变 available 是后端行为变化，前端零结构改动）。文案不得出现供应商敏感词。
- **Patterns to follow**: 既有 `rootStatusLabel` 与提示条结构。
- **Test scenarios**: readonly 状态渲染新文案；available 状态无提示条（既有行为回归）。
- **Verification**: `npm test` 全绿。

---

## Scope Boundaries

- **不做**：「重置为内置版本」按钮（升级后获取新内置指引的补救入口）——deferred，连同上一轮的「恢复默认指引」deferred 一并留待后续（本计划落地后 Resource 出厂副本天然是恢复源，实现成本已降低）。
- **不做**：出厂指引与用户副本的自动合并/版本戳比较——升级语义就是「用户编辑保留、新内置不自动到达」。
- **不做**：skill 列表/编辑 UI 结构变化；`SKILL_IDS` 白名单与 `tsn-time-sync`/`tsn-inet-export` 的 Unavailable 语义不变。
- **不动**：cwd、settingSources、model pin、tauri.conf 资源打包清单、`verify-skills` 闸（KTD5；本计划不增删打包文件）。
- **已知边界（接受）**：SDK 自身的 skills/Skill 工具发现路径仍随 cwd 指向 Resource 出厂副本，与 app-data 副本可能短暂不同源——注入路径是权威指引来源，SDK skill 路径此前已验证休眠（worker buildPrompt 注入才生效），不在本计划收口。

---

## Risks & Dependencies

- **升级后旧指引滞留——可能主动冲突而非仅错过改进**：目录已播种即跳过，用户从不编辑也拿不到新版内置指引；更尖锐的失败模式是冻结副本引用**已被新二进制移除的工具/契约**而主动误导 agent（本仓库有先例：`render_mac_table_html` 工具删除后须从 SKILL.md 清洗残留引用，`verify-skills` 闸只护仓库树、够不到已播种的用户副本）。现场表现与模型问题难区分，且重置按钮 deferred、无 staleness 诊断手段。接受——重置按钮是后续补救的第一优先理由；风险记录在 Scope Boundaries。
- **app-data 半成品目录**：播种中断可能留 `*.tmp-*` 临时目录；解析只认精确目录名，临时目录最多占盘不破坏功能。可在播种前顺手清理同名前缀临时目录（实现时决定，不强制）。
- **开发机 release 构建**：修复后 debug 守卫使 release 构建在开发机上也走 app-data——验证 release 行为时注意清理 `~/Library/Application Support/com.tsnagent.app/skills/` 才能复现首启播种。
- **worker dist 构建**：U3 改 `src-node` 源码，真机/dev 验证前必须 `npm run build:worker`，否则验证的是旧产物（反复踩过的坑）。

---

## System-Wide Impact

- 编辑器三命令（list/read/write）与 worker spawn 从两套解析收敛到一个决策函数——后续任何 skill 根策略变化单点生效。
- 审计摘要新增 skillRoot 字段：真机排查「agent 用的指引对不对」从猜测变成读审计。
- app-data 目录新增 `skills/` 子树：备份/清空 session 数据的手工操作不受影响（互不触碰），但「彻底重置 app」的心智模型从「删 DB」扩展为「删 DB + skills 副本」。

---

## Assumptions

- Tauri `app_data_dir()` 在三平台均可写且无需提权（与 `agent-runs/` 审计目录同一前提，已有真机验证）。
- Resource 打包副本保持现有三文件清单；后续新增 skill 文件时播种逻辑按目录复制自动覆盖——**仅对新装机/目录缺失的安装生效**，存量已播种安装不会收到新增工厂文件（目录存在即跳过，与 R4 升级语义一致）。
