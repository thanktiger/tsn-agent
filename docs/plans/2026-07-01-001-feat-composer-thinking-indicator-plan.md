---
title: "feat: 对话框输入框上方的推理动画提示"
type: feat
date: 2026-07-01
depth: lightweight
status: ready
---

# feat: 对话框输入框上方的推理动画提示

## 摘要

agent 推理时，在右侧对话框的输入框正上方显示一行带旋转动画的提示，形如
`✳ 盘算中…（12s · 推理中）`——旋转图标 + 一个固定的中文动词 + 已运行秒数 + 状态词。
参照 Claude Code 那种“运行中”反馈，让用户一眼看出“它在动、在想”，而不是只盯着一个不动的输入框干等。

纯前端小改：复用现成的运行状态（`isAgentRunning` / `agentRunPhase` / `agentRunElapsedSeconds`），
不碰 worker / Rust，不接真正的 thinking 事件，不显示 token。同时把现在塞在输入框
placeholder 里的那句运行文案撤掉，让 placeholder 回归干净。

---

## 问题背景

现在 agent 推理时的状态是“下沉”在输入框 placeholder 里的（`chat-pane/index.tsx` 第 205-214 行的三态
placeholder，第①支就是运行文案 `${getAgentRunStatusMessage(phase)} · 已运行 N 秒`）。这有两个问题：

- placeholder 是灰字、又在输入框内部，动感弱、存在感低，用户容易以为“卡住了”。
- 一旦用户在推理途中往输入框打字，placeholder 就消失了，运行状态反馈也跟着没了。

boss 希望改成 Claude Code 那样：输入框**上方**一行独立的、带动画的提示（见需求附图）。

范围边界（boss 已拍板）：

- 纯前端；不改 worker / Rust；不接 `thinking_delta` 事件；不显示 token 计数。
- 动词用中文，**整轮固定一个**（不每秒换，避免闪烁晃眼）。
- 撤掉 placeholder 里的运行文案分支。

### 不做（本次范围外）

- 真正的“思考中（模型在想还没吐字）”事件：需要贯穿 worker→Rust→前端三层，另立周期。
- token / 用量展示：同样是三层改动，boss 已明确不做。
- 滚动条美化：独立事项，boss 已 discard 上一版，等后续再单独处理。

---

## 关键决策

### 状态词用短词，另建映射

现有 `getAgentRunStatusMessage(phase)` 返回的是整句（“智能助手正在持续推理，结果会继续更新”），
太长，塞不进一行动画提示。新提示行要的是短词：`连接中 / 推理中 / 等待工具`（对应
`connecting / streaming / waiting`）。所以**新增**一个短词映射，不动原来的长句函数（placeholder
分支删掉后原函数是否还有其他调用点由实现时确认；若无调用点则一并删除）。

### 动词整轮固定，改动只落在组件内

动词要“进入推理时随机选一个、整轮不变”。最小改法：动词状态放 `ChatPane` 组件内，
用 `isAgentRunning` 由 `false→true` 的跳变作为“新一轮开始”的信号来重新选词（`useEffect` 或
记录上一次的 `isAgentRunning`）。这样**只改 `index.tsx` 一个文件**，不用给
`useAgentRunController` 加字段、也不用改 `App.tsx` 传参。

- 备选：在 `useAgentRunController` 里 `startRun` 时选词、暴露 `agentRunVerb`。更“正规”，但要多改
  hook + App.tsx 两处。boss 偏好小改，故不选，除非实现时发现组件内做法有坑。
- 随机用 `Math.random()` 即可（这是 React app 运行时，不是 workflow 脚本，无随机限制）。

### 动画提示行不做每秒 aria 播报

秒数每秒变，若给这行加 `aria-live="polite"`，读屏会每秒念一遍，很吵。所以这行的变化部分
（图标、秒数）标 `aria-hidden`，不做实时播报；无障碍播报仍由已有的 `AgentWaitingIndicator`
（`role="status"`）承担。

---

## 实现单元

### U1. 推理状态纯函数模块（动词库 + 短词映射 + 文案组装）

**目标**：把“选动词、phase→短词、拼出提示文案”做成纯函数，便于单测、与组件解耦。

**依赖**：无。

**文件**：
- 新增 `src/app/components/chat-pane/running-status.ts`
- 新增 `src/app/components/chat-pane/running-status.test.ts`

**做法**：
- 导出 `RUNNING_VERBS: string[]`——一组中文动词，如 `盘算 / 推演 / 编织 / 梳理 / 斟酌 / 端详 / 盘点 / 勾画`。
- 导出 `pickRunningVerb(): string`——从 `RUNNING_VERBS` 随机取一个。
- 导出 `runPhaseShortLabel(phase: AgentRunPhase): string`——`connecting→连接中`、`streaming→推理中`、
  `waiting→等待工具`、其余（含 `idle`）兜底 `推理中`。
- 导出 `formatRunningStatus({ verb, phase, elapsedSeconds }): string`——返回图标之外的文本部分，
  如 `盘算中…（12s · 推理中）`。（旋转图标是纯 CSS 装饰，不进这里。）

**跟随的模式**：`AgentRunPhase` 类型从 `../../hooks/use-agent-run-controller` 导入（组件已在用）。

**测试点**：
- `runPhaseShortLabel`：`connecting/streaming/waiting` 各自映射正确；`idle` 或未知值走兜底 `推理中`。
- `pickRunningVerb`：返回值始终 ∈ `RUNNING_VERBS`（多次调用断言都命中集合）。
- `formatRunningStatus`：给定 `verb=盘算`、`elapsedSeconds=12`、`phase=streaming` → `盘算中…（12s · 推理中）`；
  `elapsedSeconds=0` 时秒数显示 `0`；`phase` 变化时尾部状态词跟着变、动词不变。

---

### U2. ChatPane 渲染推理动画提示行 + 撤掉 placeholder 运行文案

**目标**：在输入框正上方渲染动画提示行；动词整轮固定；清掉 placeholder 里的运行分支。

**依赖**：U1。

**文件**：
- 改 `src/app/components/chat-pane/index.tsx`
- 组件渲染测试 `src/app/components/chat-pane/index.test.tsx`（若已存在同名测试则扩充；
  若项目未配 `@testing-library/react`，U2 行为改由真机 + U1 单测覆盖，见“测试点”末尾）

**做法**：
- 插入位置：`.composer` 内、`.composer-box` 之前（在 label / `.stage-confirmation` 之后），
  即 textarea 正上方——与需求附图一致。
- 只在 `isAgentRunning` 为真时渲染这行：`<div className="composer-running">` 内含一个旋转图标
  `<span className="composer-running__spin" aria-hidden>`（字符如 `✳`，旋转由 CSS 做）+ 文本
  `formatRunningStatus({ verb, phase: agentRunPhase ?? 'streaming', elapsedSeconds: agentRunElapsedSeconds ?? 0 })`。
- 动词固定：组件内 `useState` 存当前动词；用 `useEffect`（或“记录上一次 isAgentRunning”的方式）在
  `isAgentRunning` 由 `false→true` 时调用 `pickRunningVerb()` 重选一次，整轮不变。
- 撤掉 placeholder 第①支：删掉 `isAgentRunning && agentRunPhase ? …运行文案… :` 分支，placeholder
  回到两态（还没发过需求→示例指引；发过→空）。
- 变化部分 `aria-hidden`，不加 `aria-live`（见关键决策）。
- 若删分支后 `getAgentRunStatusMessage` 再无调用点，一并删除该函数（实现时确认）。

**跟随的模式**：图标旋转动画参照 App.css 既有 `@keyframes toolCallRunningPulse` 的写法风格；
`role="status"` 的用法参照同文件 `AgentWaitingIndicator`。

**测试点**（组件测试，若 `@testing-library/react` 可用）：
- `isAgentRunning=true` 时，输入框上方出现提示行，文本含动词、含 `已运行秒数`、含状态短词。
- `isAgentRunning=false` 时，不渲染该行。
- 运行中 placeholder 不再包含运行文案（此时 placeholder 为空串或示例指引，取决于是否已有用户消息）。
- 动词稳定性：同一轮内 `agentRunElapsedSeconds` 从 12 变到 13 重渲染后，动词不变；
  `isAgentRunning` 走一遍 `false→true→false→true` 后允许换成新动词。
- 若项目未配组件测试：U2 以真机（或 Safari 开 5173）截图验证上述观感，纯逻辑部分由 U1 单测兜住。

---

### U3. 提示行样式 + 图标旋转动画（App.css）

**目标**：给提示行和旋转图标加样式，贴合深色/浅色主题与 composer 现有排版。

**依赖**：U2（类名以 U2 落定为准）。

**文件**：
- 改 `src/app/App.css`

**做法**：
- `.composer-running`：一行 flex（图标 + 文本），小字号（约 12px）、`--text-secondary` 或
  `--accent` 系的克制配色、与下方 `.composer-box` 留 6-8px 间距，不喧宾夺主。
- `.composer-running__spin`：`display:inline-block` + `@keyframes composerSpin { to { transform: rotate(360deg) } }`
  匀速旋转（约 1.1s linear infinite）。
- 参照既有 `@keyframes toolCallRunningPulse` / `.tool-call-card.running` 的位置就近插入，风格统一。

**测试点**：无（纯样式）。真机 / Safari 5173 目视：图标匀速转、文案不跳行、深色浅色主题下都清晰。

---

## 系统影响 / 风险

- **改动面**：新增 1 个纯函数模块（+测试），改 1 个组件，改 1 处全局 CSS。不触及数据流、worker、Rust、DB。
- **WebKit 真机**：项目历史踩过 `grid+overflow` 行塌陷、WKWebView 无法自动化的坑；本次是普通 flex 行 + CSS 旋转，
  风险低，但仍按项目惯例真机/Safari 截图收尾（playwright 全绿不等于 WKWebView 无恙）。
- **动词随机**：`Math.random()` 在 app 运行时可用；不要误用于 workflow 脚本。

## 交付顺序

U1 → U2 → U3。U1 纯函数先立并单测；U2 接线并撤 placeholder 分支；U3 补样式，最后真机目视。

## 验收

- 推理时输入框上方出现 `✳ 盘算中…（12s · 推理中）` 样式的动画行，图标匀速旋转、秒数每秒 +1、状态词随
  phase 切换（连接中/推理中/等待工具），动词整轮不变。
- 非推理态该行消失；placeholder 不再出现运行文案。
- U1 单测全绿；真机（或 Safari 5173）目视通过。
