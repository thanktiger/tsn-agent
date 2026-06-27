# 改名 TSN Agent → HIBridge-Agent + 「会话」改「工程」— ideation

日期：2026-06-27
分支/worktree：`feat/rebrand-hibridge-agent`（基于 origin/main `8bbca31`）

## 这次要干什么

boss 已经定了两件事，WHAT 没有歧义：

1. 把项目名 **TSN Agent 改成 HIBridge-Agent**，所有显示给用户看的地方都要改。
2. 把 app 里的 **「会话」改成「工程」**。理由：一个"会话"其实装着拓扑生成、时钟同步、流量规划、软仿、硬件下发一整套工程活，叫"会话"像聊天，叫"工程"更贴。

所以这份文档不是来想点子的，是来把**改名波及面摸清**、把几个**绕不开的决策叉口**摆出来，让改动既改干净又不踩坑。

## 摸到的底（两张占用图）

### TSN 占用：分两层，一层安全一层危险

- **显示层**（"TSN Agent" 字面给人看的）：约 50 处，纯文本替换，零风险。窗口标题、主界面品牌标题、README、CHANGELOG、about、SKILL.md 描述、导出文件对话框名、桌面版提示等。
- **标识符层**（藏在底下的"名字"）：危险都在这里。
  - `com.tsnagent.app`（**bundle identifier**）—— **所有用户数据目录从它派生**。
  - `productName: "TSN-Agent"`、包名 `tsn-agent`（npm + Cargo）。
  - DB 文件名 `tsn-agent.db`、localStorage key `tsn-agent.sessions.v0`。
  - schemaVersion 串：`tsn-agent.topology.intermediate.v0`、`...export-manifest.v0`、`...eval-record.v1`（导入导出兼容靠它）。
  - SQLite `PRAGMA application_id = 0x54534E01`（"TSN\x01"，库文件签名）。
  - NED 包名 `tsnagent.generated` + network `TsnAgentNetwork`（INET 软仿产物，远端对账靠它）。
  - 环境变量族 `TSN_AGENT_*`（对外覆盖项，用户可能已在用）。
- **代码符号 / CSS / 文件名**：`TsnSession`、`runTsnAgent`、`.tsn-node`、`tsn-topology-server.ts`、`tsn-agent-mark.png` 等，约 100+ 处。纯编译期/表现层，改了不影响用户，但也看不见。

### 「会话」占用：显示层和代码层能干净分开

- **显示层**（要改的）：约 20 处中文文案，集中在 `workspace-tools/index.tsx`、`App.tsx`、`chat-pane`、`session-transfer.ts`、`agent-adapter.ts`。包括导航标签"会话"、"新建会话"、"导入会话"、"删除当前会话"、"会话存储"、"当前会话上下文"、"会话已导入"等。
- **代码层**（不该动的）：`TsnSession`、`session-repository`、`sessionId`、`currentSession`、panel id `"sessions"`、`SessionToolPanel`、CSS `.session-*`、SQLite `sessions` 表、localStorage key —— 全保持 `session`。
- 没有混用风险：代码里"会话"专指工程生命周期对象，LLM 的"对话"走 `messages` 数组，两者正交，改名不会割裂。

## 脊柱决策：改名改到哪一层

这是整件事唯一真正要 boss 拍板的地方，其它都跟着它走。

**关键事实**：`com.tsnagent.app` 决定用户数据落在哪
（`session_store.rs` 用 `app_config_dir()` 派生 `tsn-agent.db`，`skill_files.rs`/`commands.rs` 同源派生 skills 和 agent-runs）。
而且 productName、bundle id、窗口标题现在本来就是三种写法、互相独立。

- **不动 identifier** → 用户的会话库、skills、eval、审计日志**全不动，零孤儿数据**。这是安全路径。
- **改 identifier**（比如 `com.hibridge.app`）→ 数据目录整体换地方，**存量用户历史会话瞬间全变孤儿**。要救就得新写一次性迁移逻辑（旧路径存在则搬到新路径、不删旧址兜底），而 `docs/solutions/` 里没有现成做法，是要新建的能力。

## 入选方向（建议这么改）

按推荐优先级排，每条都给了依据。

### 1. 分层改名：用户可见层全改，标识符/持久化键默认不动 ★推荐脊柱

- **怎么做**：这次只改"给用户看的"——品牌显示串（约 50 处）+「会话」→「工程」（约 20 处）。`com.tsnagent.app`、DB 名、schemaVersion、application_id、NED 包名、`TSN_AGENT_*` 全部保持不变。
- **依据**：identifier 不变=零数据迁移（代码实证）；schemaVersion/DB 名/NED 名是序列化与对外契约键，改了会让老导出文件导不进、历史 INET bundle 对不上、用户 env 覆盖失效；这些用户根本看不见，品牌 ≠ schema。
- **为什么值**：把"用户能看到的改名"和"藏在底下的标识符"分开，PR 小、可评审、零破坏，完全符合"单路径、改动最小"。品牌焕新这件事用户感知 100% 来自显示层。

### 2. 「会话」→「工程」只改显示层，session 代码键不动 ★推荐

- **怎么做**：改那约 20 处中文文案，连带词一起改齐（新建会话→新建工程、最近会话→最近工程、会话存储→工程存储、删除当前会话→删除当前工程、当前会话上下文→当前工程上下文等），别改一半割裂。代码里的 `session`/`TsnSession`/`sessions` 表全留。
- **依据**：显示层和代码层已证实能干净分开；这正是上个月「时钟同步」→「时间同步」用过的范式（只改显示名/aria-label，内部键不变，避免 state 持久化/测试断言全炸）。
- **为什么值**：用户拿到"工程"心智，代码零震动，测试基本不用改。

### 3. 品牌写法定调：显示带空格、productName 用连字符 ★推荐先定

- **怎么做**：
  - 给人看的（窗口标题/主界面/about/banner）：`HIBridge Agent`
  - productName / `.app` 名 / 包名：`HIBridge-Agent` / `hibridge-agent`（**不能带空格**）
  - "HIBridge" 大小写按 boss 原样保留（大写 HI + 小写 bridge）
- **依据**：上一次改名（`TSN Agent`→`TSN-Agent`）根本不是为品牌，是为修一个 bug——worker entry-point 对含空格路径（`TSN Agent.app`、Windows `Program Files`）静默退出。所以 productName 这种会变成文件/目录名的**绝不能带空格**；UI 显示文本带空格无所谓。这也正好沿用现在 "TSN Agent"(显示) / "TSN-Agent"(productName) 的既有分裂写法，boss 早接受过。
- **小提醒**：低风险选择，boss 也可以要求"全程连字符 HIBridge-Agent"图统一，告诉我一声即可。

### 4. 代码符号 / CSS / 文件名：本期不改，或单独低优先级批次 ★推荐缓做

- **怎么做**：`TsnSession`、`.tsn-node`、`tsn-topology-server.ts` 这些这次不动；想清爽就另开一个纯 cleanup 批次。
- **依据**：纯编译期/表现层，用户看不见，但量大（100+）、改动噪音高、价值低。混进品牌 PR 会让 diff 难评审。
- **为什么值**：让品牌 PR 保持小而聚焦；这堆 churn 留给单独的机械替换批次，要不要做随时再定。

## 否决的做法（以及为什么）

- **改 bundle identifier `com.tsnagent.app`** —— 默认否决。会让所有存量用户数据变孤儿，为纯视觉改名引入高风险 + 一套全新迁移能力。只有 boss 明确要"干净的新 identifier"且接受配套迁移时才做。
- **把 schemaVersion 前缀改成 `hibridge-agent.`** —— 否决。老导出文件直接导不进（除非做双前缀兼容），用户看不见，品牌 ≠ schema。
- **改 SQLite `application_id` 签名** —— 否决。会让现有库被识别成"陌生数据库"。
- **改 NED 包名 / network 名** —— 本期否决。会和历史 INET bundle、scavetool 查询对不上；软仿刚稳定不久，风险 > 收益。
- **改 `TSN_AGENT_*` 环境变量** —— 否决（或仅加别名）。是对外契约，用户可能已在脚本里用。
- **77 文件深度一刀切全改** —— 否决。把视觉改名和高危标识符混在一起、难评审、用户侧零额外收益。

## 已定范围（boss 2026-06-27 拍板）

- **脊柱**：bundle identifier `com.tsnagent.app` **保持不动** = 零数据迁移、零孤儿。底下 DB 名 / schemaVersion / application_id / NED 包名 / `TSN_AGENT_*` env 一并保持不变。
- **品牌写法**：
  - 给人看的（窗口标题 / 主界面 / about / banner / README 等）：`HIBridge Agent`（带空格）
  - productName / `.app` 名 / npm 包名 / Cargo 包名：`HIBridge-Agent` / `hibridge-agent`（无空格）
  - "HIBridge" 大小写按原样（大写 HI + 小写 bridge）
- **「会话」→「工程」**：只改显示层约 20 处中文文案（连带词改齐），`session`/`TsnSession`/`sessions` 表等代码键全留。
- **代码符号 / CSS / 文件名（Tsn*/.tsn-*/tsn-*.ts）**：本期不改。

## 本期改名清单（落地范围）

只动"用户可见层"，一个聚焦 PR：

1. 品牌显示串 `TSN Agent` → `HIBridge Agent`（约 50 处：window title、主界面品牌、README、CHANGELOG、AGENTS.md、SKILL.md 描述、导出对话框名、桌面版提示等）。
2. productName `TSN-Agent` → `HIBridge-Agent`、包名 `tsn-agent` → `hibridge-agent`（npm + Cargo；注意连带 `build:worker` 等脚本引用）。
3. 「会话」→「工程」显示层约 20 处 + 连带词改齐。
4. **不碰**：`com.tsnagent.app`、`tsn-agent.db`、schemaVersion 串、`application_id`、NED 包名/network、`TSN_AGENT_*` env、所有 `Tsn*`/`session` 代码符号、`.tsn-*`/`.session-*` CSS、`tsn-*` 文件名。

## 下一步

范围已锁。任务具体到不必再 brainstorm，直接进 **ce-plan** 在本 worktree 出实施计划 + 落地。

一个落地时要留意的细节（plan 里展开）：改包名 `tsn-agent` → `hibridge-agent` 时，`package.json` 的 `build:worker` 等脚本、产物名、import 路径要同步；productName 改了之后 macOS `.app` 目录名变化，凡是从可执行路径反推资源/worker 位置的代码要在新名字下复验（上次空格 bug 的同类风险点）。
