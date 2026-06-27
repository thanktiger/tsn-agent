---
title: "feat: 改名 HIBridge-Agent + 「会话」改「工程」（仅用户可见层）"
type: feat
date: 2026-06-27
origin: docs/ideation/2026-06-27-rebrand-hibridge-and-session-to-engineering-ideation.md
depth: standard
---

# feat: 改名 TSN Agent → HIBridge-Agent + 「会话」改「工程」

## 摘要

把项目品牌从 **TSN Agent 改成 HIBridge Agent**、把 UI 上的 **「会话」改成「工程」**——只动用户可见层，底下所有标识符与持久化键全部冻结，做到**零数据迁移、零兼容破坏**。一个聚焦 PR，5 个文件聚类单元，每个文件只改一次（品牌串 + 会话词一并改齐），同步更新各自 co-located 的测试断言。

范围决策来自 origin ideation 文档，boss 已拍板（2026-06-27）：identifier 不动、品牌写法显示带空格/productName 连字符。

---

## 问题背景

- 项目当前叫 "TSN Agent"，散落在窗口标题、主界面、文档、配置等约 50 处显示位置，写法还不统一（窗口标题 `TSN Agent` 带空格、productName `TSN-Agent` 连字符、bundle id `com.tsnagent.app`）。
- UI 用「会话」描述一个工作单元，但一个"会话"实际承载拓扑生成 / 时钟同步 / 流量规划 / 软仿 / 硬件下发一整套工程活，"会话"像聊天，**「工程」更贴**。
- 关键约束：`com.tsnagent.app`（bundle identifier）是所有用户数据目录的派生源（SQLite 会话库、skills、eval、agent-runs）。**动它就会让存量用户数据全变孤儿**，所以必须冻结。

---

## 关键技术决策

### KTD1. 所有标识符与持久化键全部冻结 = 零迁移零破坏
identifier `com.tsnagent.app`、DB 文件名 `tsn-agent.db`、schemaVersion 串（`tsn-agent.topology.intermediate.v0` / `...export-manifest.v0` / `...eval-record.v1`）、SQLite `PRAGMA application_id`、localStorage key `tsn-agent.sessions.v0`、NED 包名 `tsnagent.generated` / network 名、环境变量族 `TSN_AGENT_*` —— **一律不改**。它们要么是用户数据目录派生源（改了孤儿），要么是序列化/对外契约键（改了老导出导不进、历史 INET bundle 对不上、用户 env 覆盖失效），而且用户根本看不见。品牌 ≠ schema。（见 origin ideation）

### KTD2. Cargo 包名 / lib 名 / main.rs 引用保持不动，只改 productName 给用户可见 .app 名
macOS 用 `tauri.conf.json` 的 **productName** 命名 `.app`，**不是** Cargo 包名。所以 `productName: "TSN-Agent"→"HIBridge-Agent"` 就给了用户可见的应用改名。Cargo `[package] name = "tsn-agent"`、`[lib] name = "tsn_agent"`、`main.rs: tsn_agent::run()` 是内部 binary / 代码符号（用户看不见、且 lib 名属冻结的代码符号），改它会牵连 `src-tauri/src/main.rs` 引用与 `scripts/prepare-release.mjs:311` 正则、收益为零——**保持不动**。
> 若 boss 想连 Rust binary 一起改名，这是独立加项，会引入 main.rs/prepare-release 改动，单独说。

### KTD3. 品牌写法：显示带空格、productName/包名用连字符
- 给人看的（窗口标题 / 主界面 / about / banner / README / 文档）：`HIBridge Agent`（带空格）
- productName / `.app` 名 / npm 包名：`HIBridge-Agent` / `hibridge-agent`（**无空格**）
- "HIBridge" 大小写按原样（大写 HI + 小写 bridge）

productName **绝不能带空格**：上次 `TSN Agent`→`TSN-Agent` 改名的根因就是 worker entry-point 对含空格路径（`TSN Agent.app` / Windows `Program Files`）静默退出（见 docs/solutions 相关学习 / packaged-app-runtime-deps）。

### KTD4. 「会话」→「工程」只改显示层，代码键全留
改显示文案与 aria-label/tooltip，连带词改齐（新建 / 导入 / 删除 / 最近 / 当前 / 会话存储 / 当前会话上下文等）。`TsnSession` 类型、`session-repository`、`sessions` 表、`sessionId`/`currentSession`、panel id `"sessions"`、`SessionToolPanel`、CSS `.session-*`、localStorage key —— **全保持 `session`**。范式同上月「时钟同步」→「时间同步」（只改显示名、内部键不变）。**每个前端单元必须同步改 co-located 测试里断言到的中文字串**，否则 vitest 红。

### KTD5. 品牌 mark 图片本期不动
`src/assets/tsn-agent-mark.png`（文件名冻结）与其 import 符号 `tsnAgentMark` 保持不变；主界面品牌靠 `App.tsx` 的 `<h1 className="brand-name">` 文本，改文本即可。若该图内含 "TSN" 文字像素，属设计任务，列入 follow-up。

---

## 改 vs 冻结（一眼对照）

| 类别 | 本期改 | 冻结（不动） |
|---|---|---|
| 应用名 | productName `TSN-Agent`→`HIBridge-Agent`、窗口标题→`HIBridge Agent` | bundle id `com.tsnagent.app` |
| 包名 | npm `package.json` name→`hibridge-agent` | Cargo `[package]`/`[lib]` name、main.rs 引用 |
| UI 品牌串 | ~50 处 `TSN Agent`→`HIBridge Agent` | — |
| 工作单元用词 | 显示「会话」→「工程」(~20)+连带词 | `session`/`TsnSession`/`sessions`表/`.session-*` CSS |
| 持久化/契约 | — | DB名、schemaVersion、application_id、NED包名、`TSN_AGENT_*` env、localStorage key |
| 资源/文件名 | — | `tsn-agent-mark.png`、`tsn-*.ts` 文件名、`.tsn-*` CSS |
| 代码符号 | — | 所有 `Tsn*`（TsnSession/TsnDevice/runTsnAgent…） |

---

## 实现单元

各单元相互独立、可单独提交；建议按 U1→U5 顺序（配置先行，便于尽早验证 .app 改名）。所有路径相对仓库根。

### U1. Tauri / Rust 配置与品牌元数据

**目标**：改应用名与 Rust 侧品牌文本，冻结 identifier 与 Cargo 包名。
**依赖**：无。
**Files**：
- `src-tauri/tauri.conf.json` —— `productName` `TSN-Agent`→`HIBridge-Agent`；`app.windows[0].title` `TSN Agent`→`HIBridge Agent`。**不动** `identifier`、`version`。
- `src-tauri/Cargo.toml` —— `description`/`authors` 里的品牌文本（"TSN Agent ..."→"HIBridge Agent ..."）。**不动** `[package] name`、`[lib] name`。
- `src-tauri/src/lib.rs` —— `:121` `.expect("failed to build TSN Agent")`→`HIBridge Agent`。
**方法**：纯字串替换；确认 identifier 与 Cargo 包名/lib 名一字不改。
**Patterns**：沿用现有 productName(连字符)/title(空格) 分裂写法。
**Test scenarios**：`Test expectation: none -- 纯配置/元数据，无行为变化`。
**验证**：`cargo build`（经 `npm run cargo:test` 或直接 build）通过；本地 `npm run tauri build`（或 dev）产物的 `.app` 名为 `HIBridge-Agent`、窗口标题显示 `HIBridge Agent`。

### U2. 应用外壳与主界面文案

**目标**：改入口标题、主界面品牌、以及 `App.tsx` 内的全部「会话」→「工程」。
**依赖**：无。
**Files**：
- `index.html` —— `<title>TSN Agent</title>`→`HIBridge Agent`。
- `src/app/App.tsx` —— `<h1 className="brand-name">TSN Agent</h1>`→`HIBridge Agent`；删除当前会话确认弹窗 `title`/`body`、连接提示常量 `ASSISTANT_CONNECTING_MESSAGE`、导入成功通知文案等所有「会话」→「工程」(连带词改齐)。**不动** import 符号 `tsnAgentMark` 与 `.png` 文件名。
- `src/app/App.test.tsx` —— 同步更新断言到的中文字串（按钮名 / getByText / getByLabelText 中的「会话」相关）。
**方法**：显示文本替换；代码符号/state 键不动。
**Patterns**：「时钟同步」→「时间同步」改文案范式（PR #65）。
**Test scenarios**：
- `App.test.tsx` 既有用例改用新文案后**全绿**（删除确认、会话列表/最近、导入通知等）。
- happy path：渲染后主标题显示 `HIBridge Agent`、工作单元相关按钮/标题显示「工程」。
- 回归：确认删除流程、导入流程的断言只换显示词、逻辑断言不变。
**验证**：`npx vitest run src/app/App.test.tsx` 绿；手测主界面标题与措辞。

### U3. 工作台工具面板文案

**目标**：导航/工具面板里「会话」→「工程」全套连带词。
**依赖**：无。
**Files**：
- `src/app/components/workspace-tools/index.tsx` —— 导航标签 `会话`→`工程`、`workspacePanelLabel` 里 `会话管理`→`工程管理`、按钮 `新建会话`/`导入会话`/`清除当前会话`、`aria-label="最近会话"`、徽章 `空会话`、tooltip（导出/导入当前会话…）、设置 `会话存储`、eval 文案（删除会话不会删除/当前会话的 eval 样本）。kicker 英文 `Sessions` 保持。**不动** panel id `"sessions"`、`SessionToolPanel`、CSS。
- `src/app/components/workspace-tools/workspace-tools.test.tsx` —— 同步更新断言到的中文按钮名/文案。
**方法**：显示文本替换；`getByRole("button", { name })` 类断言随文案改。
**Test scenarios**：
- `workspace-tools.test.tsx` 既有用例改新文案后全绿（按钮可见/可点/禁用态等）。
- happy path：工具轨标签渲染为「工程」；新建/导入/清除按钮文案为「…工程」。
**验证**：`npx vitest run` 该测试文件绿；手测工具抽屉措辞。

### U4. 聊天面板、会话传输与 agent 文案

**目标**：聊天连接提示、导出/导入对话框与校验文案、agent 上下文/CTA 的品牌+会话改动。
**依赖**：无。
**Files**：
- `src/app/components/chat-pane/index.tsx` —— 连接提示两处「当前会话上下文」→「当前工程上下文」。
- `src/app/components/chat-pane/chat-pane.test.tsx` —— 同步断言文案。
- `src/app/session-transfer.ts` —— `DB_FILE_FILTERS` 名 `TSN Agent 会话`→`HIBridge Agent 工程`；对话框 `title` `导出会话`/`导入会话`→`…工程`；import-error 文案 `不是有效的 TSN Agent 会话导出文件`→`…HIBridge Agent 工程…`。**不动** 函数/类型/常量符号。
- `src/app/session-transfer.test.ts` —— `:141` 等断言文案随之更新。
- `src/agent/agent-adapter.ts` —— 桌面版 CTA（`需要在 TSN Agent 桌面版中运行…`→`HIBridge Agent`）、上下文前缀（`TSN Agent 当前会话上下文`→`HIBridge Agent 当前工程上下文`）、拒绝信息里「会话」措辞→「工程」。**不动** sessionId/逻辑。
**方法**：品牌+会话词在每个文件一次改齐；源文件与测试同改。
**Test scenarios**：
- `session-transfer.test.ts` import-error 断言改新文案后绿（覆盖"文件非法"路径）。
- `chat-pane.test.tsx` 连接等待提示断言改新文案后绿。
- happy path：导出/导入对话框标题与文件类型名显示「HIBridge Agent 工程」。
**验证**：`npx vitest run` 上述测试绿。

### U5. 文档与 skill 描述品牌串

**目标**：面向用户/开发者的品牌文档与 skill 描述改名；npm 包名改名。
**依赖**：无。
**Files**：
- `README.md` —— 标题与正文 `TSN Agent`→`HIBridge Agent`。
- `AGENTS.md` —— 产品定位描述里的 `TSN Agent`→`HIBridge Agent`（活文档）。
- `.claude/skills/tsn-topology/SKILL.md`、`.claude/skills/tsn-time-sync/SKILL.md`、`.claude/skills/tsn-flow-planning/SKILL.md` —— `description` 行的 `TSN Agent`→`HIBridge Agent`。**不动** skill 目录名。
- `package.json` —— `"name": "tsn-agent"`→`"hibridge-agent"`（private 应用，纯标识）。
**冻结/不改**：`CHANGELOG.md` 历史条目（记录既往事实，不改写；发版时在顶部**新增**改名条目）、`docs/plans` 与 `docs/brainstorms` 历史文档、`scripts/prepare-release.mjs:311`（匹配 Cargo 包名，本期 Cargo 名不变故不动）。
**方法**：文本替换；确认 npm name 改后 `npm run build:worker` / 脚本不依赖旧 name（已核：build:worker 依赖文件名 `tsn-topology-server.ts`，非包名）。
**Test scenarios**：`Test expectation: none -- 文档与元数据，无行为变化`（但需跑一次构建确认 package.json 改名不破坏脚本）。
**验证**：`npm run build:worker` 通过；README/AGENTS/skill 描述显示 HIBridge Agent。

---

## 风险与依赖

- **R1（.app 路径复验）**：productName 改名后 macOS `.app` 目录名变为 `HIBridge-Agent.app`，凡从可执行路径反推 worker/资源位置的代码需在新名下复验（上次空格 bug 的同类风险点）。**验证**：打包后真机启动，确认 worker 正常 spawn（chunkCount>0）、skills 播种正常、能正常发起一次 agent 运行。
- **R2（测试同步）**：多个测试断言中文 UI 字串（`App`/`workspace-tools`/`chat-pane`/`session-transfer`）。改文案必须同步改测试，否则 vitest 红——已在各单元的 Files 与 Test scenarios 中点名。
- **R3（数据路径仍含旧名，有意接受）**：identifier 不变 ⇒ 用户数据仍在 `~/Library/Application Support/com.tsnagent.app/`（磁盘路径含旧名）。用户看不到该路径，换取零迁移；about/文档不要暴露该路径以免困惑（低风险）。

---

## 范围边界

**本期做（用户可见层，一个 PR）**：
- 品牌串 `TSN Agent`→`HIBridge Agent`（~50）、productName/窗口标题、npm 包名。
- 显示层「会话」→「工程」（~20）+连带词 + co-located 测试同步。

### Deferred to Follow-Up Work
- Rust binary 改名（Cargo `[package]`/`[lib]` name + main.rs + prepare-release 正则）——如确需统一再单开。
- 代码符号 / CSS 类 / 文件名深度改名（`Tsn*`、`.tsn-*`、`tsn-*.ts`，~100+）——纯机械、用户不可见，单独 cleanup 批次。
- 品牌 mark 图片（若内含 "TSN" 文字像素）——设计任务。
- CHANGELOG 改名条目——随发版在顶部新增。

### 明确不改（契约/持久化，改了破坏存量）
`com.tsnagent.app`、`tsn-agent.db`、所有 schemaVersion 串、`application_id`、NED 包名/network、`TSN_AGENT_*` env、localStorage key、`sessions` 表 / `session` 代码键。

---

## 整体验收

- `tsc --noEmit`、`biome check`、`npx vitest run`（含更新后的测试）、`cargo build` 全绿。
- 真机打包启动：`.app` 名 = `HIBridge-Agent`、窗口标题 = `HIBridge Agent`、主界面与全 UI 品牌为 `HIBridge Agent`、工作单元用词全为「工程」。
- worker / skills 播种正常，能发起一次 agent 运行（R1）。
- **零迁移生效**：新版本仍能读到既有 `com.tsnagent.app/` 下的历史工程数据（会话列表照常、不丢历史）。
- 全仓 `grep -rn "TSN Agent"` 在用户可见层（src/UI、index.html、tauri.conf title/productName、README/AGENTS/SKILL 描述）应无残留；历史文档与冻结标识符允许保留。
