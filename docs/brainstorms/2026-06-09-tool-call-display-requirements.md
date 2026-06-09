---
date: 2026-06-09
topic: tool-call-display
---

# chat 工具调用展示重构：内联结构化可折叠卡片

## Summary

把 chat 里 agent 的工具调用从"拍平文本行"换成**内联的可折叠结构化卡片** —— 折叠态一行（状态 + 友好名 + 一句摘要）让用户一眼扫完概览，展开看详情（按工具类型分级）。卡片持久化进会话。为此新建一条贯穿 worker→Rust→会话存储→类型→渲染的结构化工具事件通路。

---

## Problem Frame

当前 worker 把每个工具调用拍平成 `[工具] name: args` / `[工具结果] name 已返回：summary` / `[阶段结果] …` 文本行，塞进 assistant 消息的 `content` 字符串；`chat-pane` 原样整段渲染。结果是一面文本墙：工具名带 `mcp__tsn_topology__` 冗余前缀、args/result 在**源头就被截断**（`summarizeInput` 140 字符 / `summarizeToolResult` 180 字符），没有结构、不能折叠。用户既看不清"做了哪几步"的概览，也看不到完整细节 —— 完整 args/result 在摘要后即丢弃，前端任何地方都拿不到。

---

## Key Decisions

- KD1. **内联结构化卡片（方案 B）。** 工具调用渲染为 chat 对话流里内联的可折叠卡片，按时间序与 agent 自然语言交织；默认折叠。取代新会话里的 `[工具]` 文本 trace，assistant 自然语言内容保留。
- KD2. **详情按工具类型分级。** 多数工具展开显示完整 args + 完整 result；已知超大的（topology artifact / MAC 表 / 端口表）默认折叠或只显关键字段，另给"查看原始"按需展开。与现有"完整大结果不入 agent 对话"原则一致 —— UI 卡片只读、不进 agent 上下文。
- KD3. **持久化（卡片 + 关键字段）。** 卡片、完整 args、result 关键字段持久化进会话，重开/历史会话可见；**超大原始结果不入会话存储**，仅当次运行可即时取。
- KD4. **新建结构化事件通路。** 现状无法复用：worker 只发源头截断文本、`AgentEvent` 无 args/result、消息为纯文本。需在 worker 保留原始 args/result 并发结构化事件，经 Rust 透传、扩会话存储、扩类型、到 chat 渲染。
- KD5. **向后兼容 = 不回溯。** 历史纯文本会话保持原样渲染，不解析旧 `[工具]` 文本成卡片。
- KD6. **全工具 + 友好名。** 覆盖 MCP / Bash / Skill / Read 等所有工具；统一砍掉 `mcp__tsn_topology__` 这类冗余前缀（→ `topology.initialize`）。

---

## Requirements

**展示**
- R1. 工具调用在 chat 对话流内联渲染为可折叠卡片，默认折叠。
- R2. 折叠态一行：状态（运行中 / 成功 / 失败）+ 友好工具名（去冗余前缀）+ 一句摘要。
- R3. 展开看详情：完整 args + result（详情量按 R5/R6 的工具类型分级）。
- R4. 多张卡片折叠时构成清晰可扫的步骤概览。

**详情分级**
- R5. 多数工具展开显示完整 args + 完整 result。
- R6. 已知超大结果（artifact / MAC 表 / 端口表）默认折叠或只显关键字段，并提供"查看原始"按需展开（当次运行可取完整）。

**持久化与兼容**
- R7. 卡片 + 完整 args + result 关键字段持久化进会话，重开 / 历史会话可见。
- R8. 超大原始结果不入会话存储；历史会话只能看关键字段。
- R9. 历史纯文本会话保持原样渲染，不回溯解析。

**范围**
- R10. 覆盖所有工具类型（MCP / Bash / Skill / Read），统一去冗余前缀。
- R11. 新结构化卡片取代新会话的 `[工具]` 内联文本；assistant 自然语言内容保留。

---

## Acceptance Examples

- AE1. **Covers R1/R2/R4.** agent 连续调几个工具 → chat 显示几张折叠卡片，每张一行（如 `✓ topology.initialize · 24 节点 / 23 链路 / mutation #2`），扫一眼知道做了哪几步。
- AE2. **Covers R3/R5.** 点开一张普通工具卡片 → 看到完整入参 + 完整返回 JSON。
- AE3. **Covers R6.** 点开 topology 构建 artifact 的卡片 → 默认显示关键字段（计数 / summary），"查看原始"按需展开完整 artifact（当次运行）。
- AE4. **Covers R7.** 关掉会话再打开 → 卡片仍在、关键字段仍可看。
- AE5. **Covers R8/R9.** 打开一个历史纯文本会话 → 原样显示旧文本，不崩、不强行变卡片；其超大原始结果在历史里不可回看。

---

## Scope Boundaries

**Deferred for later**
- 卡片内搜索 / 过滤、复制单个工具结果、与诊断抽屉联动跳转。
- 超大原始结果的持久化（若以后要历史也能回看完整大表，再加独立存储 / 懒加载）。

**本次不做**
- 不改 agent 实际行为、不改工具本身、不动"完整大结果不入对话"的硬规则 —— 只改展示与存储。
- 不回溯迁移历史会话。

**Outside this product's identity**
- 诊断抽屉是日志系统，本功能是对话内展示，二者不合并。

---

## Dependencies / Assumptions

- 依赖 worker 能在工具事件处（截断之前）保留原始 args/result 并发结构化事件，经 Rust event channel 透传 —— 实现期确认 channel 与消息存储的扩展点。
- 假设 result"关键字段"可按工具类型定义（topology = summary 字段 / mutationId / 计数；Bash = command + exit + 输出摘要；等），具体清单留 plan。
- 会话存储 schema 扩展须向后兼容旧 payload（旧会话无工具调用结构化字段）。

---

## Outstanding Questions（Deferred to Planning）

- "关键字段"按工具类型的具体清单 + "超大默认折叠"的判定阈值 / 工具白名单。
- 卡片折叠 / 展开状态是否持久化（还是每次默认折叠）。
- worker 结构化后是否**完全停止**往 `message.content` 塞 `[工具]` 文本 —— 影响 `sessionPreview`（`workspace-tools/index.tsx:226`）等文本消费端。
- 结构化工具调用是挂在 `ChatMessage` 上还是独立的事件流 / 关联存储（影响渲染顺序与 schema）。

---

## Sources / Research

- 数据流 grounding（本会话只读调查）：`src-node/claude-agent-worker.mjs`（截断 `summarizeInput:1176` / `summarizeToolResult:1225`、trace 形成 `:909-936`、prepend 进 content `:295`、`onEvent:231`、audit `toolCalls:536-549` 仅存摘要文本）；`AgentEvent` 无 args/result（`src/agent/agent-types.ts:24-33`）；`ChatMessage.content` 纯文本（`src/sessions/session-repository.ts:10-33`）；chat 整段渲染 content（`src/app/components/chat-pane/index.tsx:72-87`）。
- 现有"完整结果不入对话"原则：`.claude/skills/tsn-topology/SKILL.md` 回复边界 + worker 截断设计。
