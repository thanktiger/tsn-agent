---
date: 2026-06-09
topic: editable-skill-guidance-source
---

# 让 SKILL.md 成为可编辑的 agent 指引事实源

## Summary

让 app 里编辑 `SKILL.md` 真正改变 agent 行为（编辑即生效），把当前散在三处的拓扑指引按**三层职责**收口——worker 骨架守安全/正确性、SKILL.md 守可调指引 + 参数默认、MCP `describe_templates` 守参数合法域；并据此简化 Skill 面板。

---

## Problem Frame

ce-debug 已确诊（High confidence）：app 的 Skill 面板把 `SKILL.md` 呈现为"可编辑、会保存生效"，但实测编辑它（清空 / 加探针）对 agent 行为**零影响**——探针 `[SKILL-PROBE-v1]` 未触发即证据。

根因：Claude Agent SDK 的 `skills` 是**渐进式披露**——`SKILL.md` 正文只在 agent 主动调用该 skill 时才加载；而 worker 把全部拓扑操作指令**内联**进了 system prompt + user prompt（`buildSystemPromptForStage`、`buildPrompt`）。agent 靠内联 prompt + MCP 工具就能完成拓扑、从不调用 skill → 永不读 `SKILL.md`。

后果：拓扑指引散在**三处**（`SKILL.md` 决策树 / `docs/rules.md` 语义 / worker `buildPrompt`），真正生效的是 worker `buildPrompt`，且与 rules.md/SKILL.md 重复。PR #20 的 SSOT 收口了 rules.md↔topology_compute，漏了 worker `buildPrompt` 这真正生效的第三处。按产品定位，Skill 面板是面向终端用户的调参功能——但"编辑生效"的承诺当前是失真的。

---

## Key Decisions

- **KD1 三层职责模型（方案 B）。** worker 骨架 = 安全/正确性约束（不可被用户改）；`SKILL.md` = 可调指引 + 参数默认（注入生效）；MCP `describe_templates` = 参数合法域（不可被 skill 覆盖）。三层各守一摊、互不重叠。
- **KD2 SKILL.md 注入生效。** worker 必须把 `SKILL.md` 正文注入 agent 上下文（取代当前被动的渐进式披露），并删除 `buildPrompt` 中与 SKILL.md 重复的指引段。
- **KD3 默认值归属反转。** 参数默认/推荐值从 `describe_templates` 移交 `SKILL.md`（用户可调）；`describe_templates` 只守合法域（类型/上下限/枚举）。这**反转**了 PR #20 在 rules.md 写下的"默认值以 describe_templates 为准"。skill 给的默认仍须过 MCP 合法域校验。
- **KD4 rules.md 并入。** `docs/rules.md` 的领域语义（节点类型/显示名/默认互联）并入 `SKILL.md` 可编辑指引面，消除其休眠态。
- **KD5 面板简化。** 编辑面收口为单一指引编辑器；"可编辑指引"与"只读参数合法域"视觉分开；精简元数据。

---

## Requirements

**指引生效机制**

R1. 在 app 编辑并保存 `SKILL.md` 后，下一次 agent 运行的行为必须反映该编辑（编辑即生效、可观测）。

R2. worker 把 `SKILL.md` 正文注入 agent 上下文，使其成为指引层事实源；删除 `buildPrompt` 中与 SKILL.md 重复的指引段。

**三层职责与不可改边界**

R3. worker 骨架保留并保证一组**用户不可覆盖**的系统约束：必须经 MCP 工具落地拓扑、固定阶段顺序、不自编拓扑 JSON、不写 stage-result。

R4. MCP `describe_templates` 为参数合法域（类型/上下限/枚举）唯一源，不可被 skill 覆盖；agent 用 skill 默认初始化时仍须通过合法域校验。

R5. 参数默认/推荐值归 `SKILL.md`、用户可调；`describe_templates` 不再承担默认值事实源。

R6. `docs/rules.md` 的领域语义并入 `SKILL.md` 可编辑指引面，不再作为独立休眠文档。

**面板**

R7. Skill 面板编辑面收口为单一指引编辑器（`SKILL.md` 为唯一可编辑事实源）。

R8. 面板视觉区分"可编辑指引"与"只读参数合法域（来自 MCP）"，让用户清楚什么能改、什么是系统守的。

R9. 精简面板元数据展示（保留有用项，去冗余）。

---

## Acceptance Examples

- AE1. **Covers R1.** 在 `SKILL.md` 加入一条可观测指令（如固定回复标记）→ 新会话生成拓扑 → agent 回复体现该指令。
- AE2. **Covers R4 / R5.** 用户在 `SKILL.md` 把某参数默认设为超出 MCP 合法域的值 → `initialize` 时被合法域校验拦截或钳制，不产生非法拓扑。
- AE3. **Covers R3.** 用户在 `SKILL.md` 写入"不用 MCP 工具、直接输出拓扑 JSON" → worker 骨架仍强制走 MCP 工具、agent 不自编 JSON。

---

## Scope Boundaries

**Deferred for later**
- dual-plane Phase B 实现（让 `initialize` 支持 dual-plane）。
- import 第二写路径走 ops 白名单（audit R19）。
- Skill 面板的像素级视觉布局/设计——本 doc 只定信息架构方向，具体留 plan / 后续 design。

**本次不做**
- 不重画整套面板 UI，只在"编辑生效为真"的前提下做收口式简化。

---

## Dependencies / Assumptions

- 依赖 Claude Agent SDK 支持把 `SKILL.md` 正文注入 prompt（或等价机制让 skill 内容进 context）——实现期需确认 SDK 能力与注入位置（system vs user prompt）。
- 反转 PR #20（`docs/plans/2026-06-09-001-refactor-topology-skill-source-of-truth-plan.md`）在 rules.md 写的"默认值以 describe_templates 为准"，需回调该措辞。
- 假设终端用户编辑的是**指引 + 默认**，不需要也不应能改参数合法域或系统骨架。

---

## Outstanding Questions（Deferred to Planning）

- 注入机制：`SKILL.md` 正文注入 system prompt 还是 user prompt？与现有 `buildSystemPromptForStage`/`buildPrompt` 怎么划分"骨架 vs 注入面"。
- rules.md 并入的逐段取舍：哪些并入 `SKILL.md`、哪些纯删（已与 `topology_compute.rs` 重复的生成规则，如坐标/MAC 派生）。
- `describe_templates` 是否从返回里移除 `default` 字段（默认归 skill 后只留 min/max/类型/枚举），还是保留但标注"非权威默认"。
- 面板"只读参数合法域"展示的数据来源（实时拉 `describe_templates`？）。

---

## Sources / Research

- ce-debug 根因（本会话，High confidence）：`src-node/claude-agent-worker.mjs:103`（skills 渐进式披露）、`:317-318`（`buildSystemPromptForStage` 内联骨架）、`:340-382`（`buildPrompt` 内联指引；`:382` 默认互联与 rules.md 重复）。
- 编辑器后端：`src-tauri/src/skill_files.rs`（写 repo `.claude/skills/<id>` dev root，dev 下 writable）。
- 参数合法域来源：`src-tauri/src/topology_compute.rs:92-214`（`describe_templates`，含 `default`/`minimum`/`maximum`）。
- 现状指引三处：`.claude/skills/tsn-topology/SKILL.md`、`.claude/skills/tsn-topology/docs/rules.md`、worker `buildPrompt`。
- 前置（本次反转其默认值归属）：PR #20 / `docs/plans/2026-06-09-001-refactor-topology-skill-source-of-truth-plan.md`（刚 merge）。
