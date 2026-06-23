---
date: 2026-06-23
topic: single-step-undo
---

# 单步撤销（跨 stage 通用）需求

## Summary

给会话编辑加「撤销上一次改动」的单步回退：把当前 stage（domain）的状态确定性地盖回上一次结构性变更之前。存储按 domain 通用，本期只实现 topology；时间同步、流量规划以后接入。撤销是确定性操作——大模型只判「撤销」意图，回退动作和回退后的状态认知都不靠它脑补。

## Problem Frame

现在 agent 改拓扑（initialize / apply_operations）没有版本概念。用户说「回退上一步」时，大模型做完意图判断后，是按它对话里的记忆去「尝试恢复」——它可能记错、删错，越改越偏。根因是状态历史不存在：DB 只有当前态，mutation_buffer 是内存 ring（重启清零、只存 id 不存状态）。没有一个确定的「上一版」可盖回，回退只能靠大模型猜。

撤销相对「让用户再下一句精确删除指令」的增量，在难以口述逆转的场景最明显：连续操作几步后用户已记不清「刚才那步」具体改了什么，或 initialize 这类整图重置无法用单句指令精确还原。简单的「删掉刚加的那条链路」用户本就能直接说；撤销的价值集中在这些口述逆转成本高的情形。

这件事不止拓扑。时间同步是 agent 驱动的（「GM 放节点 1 还是节点 2」是大模型的判断），将来流量规划同理——它们都会有「改错一步想撤回」的需求，且撤回后同样要让各自的 agent 知道「你刚才的认知作废了」。

## Key Decisions

- **KD1 单步，不做多版本。** 只支持「撤回最近一次结构改动」，只能撤一次、无 redo。砍掉版本表、version_seq、「选第几版」的意图判断、追加 vs 删历史这一整套复杂度。依据：预期真实场景是「改错一步马上撤」；「反复退回到三四步前」的需求尚未经真实数据验证（见 Assumptions）。

- **KD2 撤销针对结构改动，但快照含位置、会一并回滚。** 撤销由 apply_operations / initialize 触发存档。节点拖拽不触发新的存档点——但 pre-image 快照是整表状态、含位置字段，所以一次结构撤销会把节点位置一并回滚到快照时刻，撤销后的手动布局不保留、无 redo。

- **KD3 存储跨 domain 通用，撤销逻辑本期直调 topology。** pre-image 存进一张按 `(session_id, domain)` 键的通用 blob 表——这是真正承重的通用点（时间同步 / 流量规划状态表结构不同甚至还没建，镜像现有表无法共用）。但本期撤销主流程直接调 topology 的序列化 / 还原 / 通知逻辑，不预先定义正式的 per-domain 钩子接口；接入第二个 domain 时再从 topology 提取。

- **KD4 回退后强制 agent 重新认知。** 会话上下文每轮已从 DB 现取拓扑计数摘要，撤销后计数类信息会自动刷新；但 agent 对话记忆里更细的认知（它以为存在的某个具体节点 / 配置）仍会失效。所以回退后要向有 agent 的 domain 注入通知：细粒度认知作废，读和写之前都先 inspect，且撤销后首条编辑指令的 inspect 必须排在写操作之前。这是确定性立论的真正承重点——否则脑补问题只是从「恢复动作」挪到「回退后的下一次交互」。

- **KD5 两个入口对等。** 画布「撤销」按钮 + 对话触发，共用同一个撤销核心。agent-native 对等：用户能撤，agent 也能撤。

## Requirements

**撤销能力**

R1. 提供「撤销上一次结构改动」的单步回退：把当前 domain 的状态恢复到最近一次结构性变更之前。

R2. 撤销覆盖结构改动（topology：apply_operations / initialize）。pre-image 快照是结构变更前的整表状态、含节点位置字段；「不针对拖拽」指拖拽本身不触发新的撤销点，不是说快照排除位置——因此结构撤销会把节点位置一并回滚到快照时刻，撤销后的手动布局不保留、无 redo。

R3. 单步语义：只能撤回最近一次，无 redo。撤销成功后立即清除该 `(session_id, domain)` 的 pre-image，使「无可撤销」成为后续撤销的真实判定，而非依赖「盖回同一份恰好 no-op」。

R4. 每次结构性变更前，把当前态存为该 domain 的 pre-image，与本次变更同一事务原子提交，覆盖式只保留一份；dry-run 路径不得留下 pre-image。

**存储与扩展**

R5. pre-image 存于一张通用 blob 表，按 `(session_id, domain)` 存一份序列化快照；存 DB，跨进程重启保留；序列化不依赖 mutationId（它是内存计数器、重启清零，不能作持久键）。

R6. 撤销主流程本期直接调用 topology 的序列化 / 还原 / 通知逻辑，不定义正式 per-domain 钩子接口。blob 表的 domain 维度保证扩展路径开放；接入第二个 domain 时再从 topology 实现中提取通用契约。

R7. 本期只实现 topology；时间同步、流量规划后续接入，不在本期实现。

**运行时同步**

R8. 撤销时，DB 盖回上一版的同时，画布刷新到回退后的状态。

R9. 撤销后，向该 domain 的 agent 注入回退通知：声明缓存的细粒度状态认知失效，回答关于当前状态的问题或编辑之前都必须先 inspect、不得凭记忆作答（通知文案通用，不枚举被撤销的操作类型、不依赖 diff）。撤销后第一条用户消息若是编辑指令，强制 inspect 必须排在任何写操作之前。

**入口**

R10. 两个入口共用同一个撤销核心：画布「撤销」按钮（经 Tauri command）+ 对话触发（in-process agent 工具）。结构写入只发生在 sidecar 路由（持有 mutation_buffer / emit）、按钮走 Tauri command，二者是不同进程面——撤销核心需抽成共享 rust 模块供两侧调用，回退后的前端刷新复用 sidecar 的 mutation 推送。

R11. 无可撤销内容时（该 `(session_id, domain)` 无 pre-image），按钮禁用、对话工具返回「无可撤销」。

## Key Flows

F1. **按钮撤销。** **Trigger:** 用户点画布「撤销」。→ 撤销核心读出该 domain 的 pre-image → 盖回 DB（同一事务）→ 清除 pre-image → 画布强制刷新到回退后状态 → 下一轮 agent 收到回退通知。**Covers R1, R3, R8, R9, R10, R11.**

F2. **对话撤销。** **Trigger:** 用户在对话里说「撤销刚才那步」。→ agent 判意图后直接调撤销工具（指代不清时先用中文编号选项问清、不擅自撤），不设单独确认闸 → 同 F1 的撤销核心。agent 因自己调用了工具而知道已撤；其余 domain 的 agent 仍按 R9 收通知。**Covers R1, R10.**

## Acceptance Examples

AE1. **按钮撤销后查询。** 用户点撤销 → 随后问「现在几个节点」→ agent 先 `topology.inspect` 再回答，给出回退后的真实状态，不凭旧记忆答撤销前的图。**Covers R9。**

AE2. **拖拽 + 结构改动 + 撤销。** 用户先拖动节点位置 → 让 agent 加一台交换机 → 撤销。结果回到「加交换机之前」的快照，节点位置一并回滚到那一刻，期间的拖拽布局丢失、无 redo。**Covers R2, R4。**

AE3. **连续撤销两次。** 撤销一次成功 → pre-image 被清除 → 再点撤销：按钮已禁用 / 工具返回「已无可撤销」，不是静默无反应。**Covers R3, R11。**

AE4. **撤销后首条消息即编辑。** 用户点撤销 → 紧接着说「在刚才那台交换机上连条线」→ agent 必须先 inspect 看到该交换机已不存在，再据真实状态处理（指代落空时按编号选项问清），不得凭旧记忆直接 apply。**Covers R9。**

AE5. **空会话撤销。** 全新会话、无任何改动时 → 撤销按钮禁用 / 工具返回「无可撤销」。**Covers R11。**

## Scope Boundaries

**Deferred for later**

- 多步回退 / 版本历史表 / version_seq（事件溯源、完整版本表）——本期单步够用，验证有多步需求后再扩。
- redo（撤销的重做）。
- 确定性 diff「看见改了什么」——本期通知不枚举操作类型，不算两版差异。
- 时间同步 / 流量规划 domain 的接入——blob 表的 domain 维度本期留好，实现等那些 stage 的 agent 就绪。
- 撤销按钮在画布上做成常驻控件还是轻量入口——涉及把产品观感往「带历史的手动编辑器」推的定位取舍，本期不展开。

**不做**

- git 管 DB 二进制文件 / 导出文件（ideation 已否决：二进制无法 diff/merge；导出是派生物，双源一致性重且绕）。
- 外部版本控制系统 / 新依赖。
- 逐键 / 逐字撤销粒度——编辑粒度是「一次结构变更」，更细无意义。

## Dependencies / Assumptions

- **需求假设（load-bearing）：** 多步回退需求未经真实使用数据验证。本期按「单步够用、改错一步马上撤」下注；若日后真机证明用户反复要退回多步，再扩到多版本。
- **现状约束：** 今天只有 topology 走大模型 worker（`src-node/claude-agent-worker.mjs`）；时间同步 / 流量规划当前由 adapter 处理或下线。因此本期只有 topology 能落地 R9 的 agent-notify——存储通用，agent 通知单点。
- **序列化对象：** pre-image 的序列化 / 还原基于 `query_topology` 的三表（topology_nodes / topology_links / topology_refs）行读取与整表替换，不是 build_artifacts（后者只产派生 artifact、不读库）；initialize 会动 topology_refs，快照须覆盖三张表。
- **新增 blob 表：** 与项目命令式 pragma 守卫迁移范式一致（`CREATE TABLE IF NOT EXISTS` + 挂进 safety-net schema 对老库自愈），不引入 migrations 向量。

## Outstanding Questions

**Deferred to Planning**

- 撤销核心的承载面与对话工具形态：撤销核心挂在 sidecar 路由、Tauri command 还是共享核心；对话入口做成 in-process SDK 工具（同 `request_stage_change`）还是 sidecar MCP 工具——同一决策的两面，合并定。
- R9 的执行强度：用「软指令」（prompt 要求先 inspect）还是「强制 inspect 兜底」（撤销后首条编辑指令前强制跑一次 inspect）。鉴于会话上下文已自动刷新计数，软指令的必要性可能比初看更高——planning 据此权衡。
- 撤销后的前端刷新通道：mutation_buffer next_id 重启清零，撤销 push 的新 id 可能与前端持久 last_seen 错位、被 `since()` 漏判。撤销刷新建议走独立的「强制全量 refetch」事件，不依赖增量 id 比较——planning 验证。
- 撤销命令与 session 生命周期的耦合：blob 表按 `(session_id, domain)` 存，session 删除后 pre-image 行须级联清除，避免类似删除复活的指针残留 / 跨会话串读。
- initialize 作为撤销点的语义：撤销 initialize 盖回的是空图还是上一份完整图，按 pre-image 定义自然落地，但需在实现期确认符合用户预期。
