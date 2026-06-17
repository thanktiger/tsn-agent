---
date: 2026-06-16
topic: llm-stage-switch-intent
focus: stage 切换意图判断从正则关键词改为大模型判断 + 工具驱动状态切换（方案 A）
mode: feature
---

# 需求：stage 切换意图判断改用大模型

## 问题

当前 stage 切换的意图判断（用户想切到哪个阶段）依赖正则关键词匹配，脆弱。

`src/agent/agent-adapter.ts:621` 的 `hasTopologyChangeIntent` 只匹配 `交换机|端系统|终端|网卡|拓扑|switch|topology`。用户说「加两个设备」这类自然表达不含这些词 → 匹配不到 → 不触发回退 → 跨阶段修改请求被当成当前阶段输入处理，答非所问。`isBoundaryProgressionIntent`（确认/继续）同样靠固定词表。

这是 boss 明确担心的点：**用关键词猜意图不可靠**。

## 目标与成功标准

- 用户用**任意自然表达**跨阶段意图（如「加两个设备」「这里时钟改成主从」），系统能正确判断并切到对应阶段，不再依赖特定关键词命中。
- 状态切换由**代码执行**（大模型只提议）；切换合法性、破坏性回退确认、回退重置后续阶段，全部由代码强制，不交给大模型文字层。
- 各阶段**内部处理逻辑不变**。

成功的判定：原本因「没说对关键词」而漏判的跨阶段请求，现在能被正确识别并切换；且大模型误判时，代码安全网拦住非法/破坏性切换。

## 范围

### 做

- 删除 `agent-adapter.ts` 中所有基于正则关键词的意图判断与本地确定性边界路由——`hasTopologyChangeIntent`、`isBoundaryProgressionIntent` 等意图正则（`:608-631`）及 `runLocalBoundaryProgression`（`:236`）里的**意图判断分支**。
- 新增一个让大模型表达「请求切换阶段」的能力（工具），参数含：目标阶段 + 理由。
- 大模型理解用户意图后调用该工具（含「确认/继续」这类推进意图，也由大模型判断，不保留本地正则快速路径）。
- 代码接收工具调用：先**校验切换合法性**（目标阶段存在、不越界跳阶段）→ 再执行切换（复用 `src/project/project-state.ts` 的 `requestStageChanges` / `confirmCurrentStage`）。
- 切换行为分级：
  - **往前推进**（确认进下一阶段）→ 直接执行。
  - **往后回退**（切回拓扑或更前阶段，会重置后续已做的阶段）→ **先向用户确认，确认后才执行**。

### 不做

- 不改各阶段内部处理逻辑——`time-sync` 自动生成摘要、灰阶段（flow-template / planning-export）的提示行为保留。
- 不做「每阶段验证 gate」——属独立、更大的话题，见 `docs/ideation/2026-06-16-skill-stage-verification-ideation.html`，本次不碰。

## 关键行为决策

- **意图判断全交大模型**：所有用户输入（含「确认/继续/好的」）由大模型判断意图，删除本地正则快速路径（方案 A，boss 已确认接受由此带来的延迟 + 成本）。
- **破坏性回退才确认**：往前推进不需额外确认；往后回退（会清空后续已做阶段）需用户确认后才执行。这是大模型误判的主要安全网。
- **代码守约束**：切换合法性校验、破坏性回退确认、回退时重置后续阶段——这些是正确性约束，必须在代码层强制（与项目既定边界一致：状态流转归代码骨架，大模型只提议）。

## 注意 / 风险（供实施计划）

- **删正则时必须保留「阶段处理」触发**：`time-sync` 进入时的自动生成摘要、灰阶段提示不是「意图判断」，是「阶段处理」，需要用不依赖正则的方式继续触发，不能随正则一起删掉。这是删除 `runLocalBoundaryProgression` 时最易踩的回归点。
- **大模型误判**由代码安全网兜底（合法性校验 + 破坏性回退确认）。
- **性能 / 成本**：所有输入（含确认）走大模型，延迟与成本增加，boss 已接受。

## 未决问题（留给实施计划 ce-plan）

- 「请求切阶段」能力的具体形态：是新增一个 MCP 工具，还是 worker 层的一个信号机制。
- `time-sync` 自动生成摘要的触发方式如何与新流程共存（删掉本地正则路由后，谁在进入 `time-sync` 时触发它）。
- 大模型判断「用户在确认当前阶段」的 system prompt 规则如何措辞（写在 worker 骨架还是 SKILL.md）。

## Grounding（关键文件）

- `src/agent/agent-adapter.ts` — `runLocalBoundaryProgression`（:236）、意图正则（:608-631）、拓扑回退（:109-114）、`runTimeSyncStage`（:302）、灰阶段处理（:363）。
- `src/project/project-state.ts` — `requestStageChanges`（:179，回退并重置后续阶段为 locked）、`confirmCurrentStage`（:135）、`getNextWorkflowStep`（:225）。
- `src/domain/scenario-config.ts` — `WORKFLOW_STEPS` 阶段定义。
- 来源：`docs/ideation/2026-06-16-skill-stage-verification-ideation.html`（idea「root 不是 skill，是只读投影」+ 意图判断改进）。
