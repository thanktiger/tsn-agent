# MVP 残留审计：v0.7.1 该删什么、该优化什么、该留什么

- 日期：2026-06-24
- 版本：v0.7.1
- 模式：仓库内审计（repo-grounded）
- 焦点：项目已脱离 MVP，盘点遗留代码 / 临时方案 / 占位实现 / 死 schema / 双轨逻辑
- 产出：7 条排序后的清理项（26 个原始发现，19 个被合并或否决），覆盖 5 个代码面

## 一句话结论

真正能放心删的 MVP 残留只有一处（`topology_backfill.rs` 整模块，约 500 行死代码），当前分支 `chore/drop-unused-tables` 已经在做同类清理。其余大部分"看起来像残留"的代码其实分三种：**仍在跑的兼容代码（别删）**、**故意保留的备用能力（要拍板）**、**弱模型切换前必须补的硬化债（不是删，是补）**。把这三类和"真残留"混为一谈，是这次审计最大的风险。

## Grounding（核对依据）

- 三段式架构：`src/`（React UI）+ `src-tauri/`（Rust 后端 + axum sidecar + SQLite）+ `src-node/`（Claude agent worker + MCP topology server）。
- 四阶段流程：拓扑 → 时间同步 → 流量规划 → 规划导出。后两个阶段 + tsn-flow-planning skill 处于 Phase B 下线占位。
- 拓扑权威已收口到 SQLite P0 表，agent 经 MCP 工具改、经 `query_topology` 读。
- 当前分支正在跑 migration v6，删除 v2 历史建的 13 张空壳表——说明清理工作已在进行。
- 5 个 agent 分别核对了 5 个代码面的真实现状（不只信文档），下面的判断都带文件证据。

## Topic Axes（拆出的 5 个代码面）

- **A. 下线阶段脚手架** — flow-template / planning-export 阶段、disabled skill、Phase B 占位文案
- **B. 遗留兼容代码** — legacy builders、backfill 工具、旧 payload 归一化、`[工具]` trace 过滤
- **C. 死 schema / 未消费 API 面** — validate/build_artifacts 参数、dual-plane 未消费字段、schedulability 占位
- **D. 保留备用能力** — INET 能力代码（`勿删` 标注）——"别误删"陷阱面
- **E. 弱模型硬化债 + 已知 bug** — 文字兜底 vs 确定性代码、session 复活 bug

---

## 排序后的清理项

### 1. 删除 `topology_backfill.rs` 整个模块（约 500 行纯死代码）

- **面**：B（遗留兼容代码）
- **判定**：DELETE　**信心**：高　**复杂度**：S
- **现状（已核对）**：`src-tauri/src/topology_backfill.rs` 约 500 行，含 7 个公开函数（含 4 个 `#[tauri::command]`）。但：① 未在 `lib.rs` 的模块列表里声明；② 没有任何 handler 注册进 `invoke_handler!`；③ `grep "use.*topology_backfill"` 零结果。它是 Phase A 一次性 canonical 迁移工具，Phase B-β 把拓扑权威搬进 P0 表后彻底失效。
- **依据**：`direct:` —— 零 import、零 handler 注册、零运行期调用。单测能过只因为函数自包含，但函数本身不可达。
- **为什么值得做**：这是整次审计里唯一一处"高信心、低风险、可直接删"的真残留。约 500 行带 `#[tauri::command]` 的代码挂在那里，会让维护者误以为它是活的入口。
- **坑**：`legacy_node_type()` 这个 `pub(crate)` 函数有可能被 `session_import` 用到——删模块前先 grep 确认，需要的话先把它移到 `session_import.rs` 或内联，再删整个文件。

### 2. 收口 `planning-export` 的多处死路径

- **面**：A（下线阶段脚手架）
- **判定**：DELETE / 统一守卫　**信心**：中（部分行号需复核）　**复杂度**：S–M
- **现状（已核对）**：`planning-export` 比 `flow-template` "更死"——它在 agent 层被 `STAGE_SWITCH_TARGETS = ["topology","time-sync"]` 挡住、永远不会成为当前阶段，但仍散落在多处：skill-catalog 条目、`workflow-stage-result.ts` 的 `PlaceholderWorkflowStageResult` 类型、`project-state.ts` 的 `getAvailableStageActions()` 里那段 `if (stage.step === "planning-export") return ["send-planning"]`（不可达分支）。
- **依据**：`direct:` —— 切换守卫只在 agent-adapter 一处生效，schema/skill/state 三处都还把它当合法阶段，口径不一致。
- **为什么值得做**：单点真相被分散成四处，未来重启 Phase B 时这些半接线的残留最容易引发"为什么这里能选那里不能选"的困惑。收成一处守卫，其余删掉或显式 throw（和 flow-template 对齐）。
- **坑**：agent A 报的部分行号（如 tsn-inet-export skill 状态）与 grounding 略有出入，动手前按文件复核一遍当前状态，别照行号盲改。

### 3. 删未消费的 dual-plane zod 字段 + schedulability 占位

- **面**：C（死 schema）
- **判定**：DELETE　**信心**：高　**复杂度**：S
- **现状（已核对）**：`src-node/mcp/topology-tools.ts` 的 dual-plane `.strict()` schema 仍接受 `allocation` 对象和 `switches[].role`，但生成器 `create_dual_plane_redundant_topology` 完全不消费——`topology_compute.rs:660` 注释白纸黑字写着"allocation / role / name 等 zod `.strict()` 仍接受但生成器不消费"。另外 `VerifyResult` 的 `schedulability` caliber 枚举值从未被任何路径产出（INET 验证已挪走，verify_topology 永远返回 `structural_only`）。
- **依据**：`direct:` —— 注释自述 + grep 确认零消费点。
- **为什么值得做**：模型看得见这些字段，会以为传了有用。删掉收窄 prompt 面，消除"接受但静默丢弃"的歧义。这是 PR #19/dual-plane 当时为降风险故意留下的，理由（"删 schema 改面有风险"）在已稳定的 v0.7.1 可以反过来评估了。
- **坑**：收窄模型可见的 schema 等于改 prompt 面，改完跑一轮真机确认 agent 行为不变。

### 4. 修 session 删除复活 bug

- **面**：E（已知 bug）
- **判定**：FIX-BUG　**信心**：高（bug 已确认且既有未修）　**复杂度**：M
- **现状（已核对）**：删除 session 后立刻在同一视图提交意图，`App.tsx` 的 `repository.save(pendingSession)` 会走 `session_store.rs` 的 `upsert_session()`（`ON CONFLICT(id) DO UPDATE`），把刚删的 session 静默复活。现有的 `sessionExists()` 校验在 agent 跑完之后（约 App.tsx:239）才执行，为时已晚——第一次 save 已经把行写回去了。
- **依据**：`direct:` —— UPSERT 路径 + 校验时序错位，memory 里也记着这条既有未修。
- **为什么值得做**：这是整次审计里**唯一一个真 bug**（其余都是清理/硬化），且是用户可见的数据完整性问题（删了又自己冒出来）。
- **坑**：把 `sessionExists()` 前移到首次 `save` 之前即可，但要避开当初用 UPSERT 是为了不 CASCADE 删掉拓扑的原因——别改成会连带删拓扑的硬删。

### 5. 给约 1100 行休眠的 INET 能力代码一个明确决策

- **面**：D（保留备用能力 / 判断题）
- **判定**：需 boss 拍板（涉及删除已有能力，不自作主张）　**信心**：高（情况清楚）　**复杂度**：取决于决策
- **现状（已核对）**：`inet_verify_command.rs`(323) + `inet_bundle.rs`(324) + `inet_remote.rs`(462) ≈ 1109 行，带 60+ 单测，2026-06-17 在真机验过。`verify_inet` 在 `lib.rs` 注册成 Tauri command 但无任何 UI/agent 调用方，`lib.rs` 标了 `勿删`。它是从拓扑阶段撤出、挪去未来流量规划阶段的备用能力。
- **依据**：`reasoned:` —— 代码本身是真能力（跨平台进程管理、安全远端执行、输出脱敏），不是空想；但消费方（流量规划 Phase B）至今没有时间表，"暂时下线"=无限期。`inet_remote.rs` 的传输层确实阶段无关、可复用；`inet_bundle.rs` 是纯函数、唯一调用方就是同样不可达的 verify_command。
- **三个可选方向（请选一个，或给别的）**：
  - **(a) 维持现状 + 加固标注**：保留在 `src-tauri/src/`，在 `lib.rs` 注释里写清"等流量规划 Phase B，预计 X 时间，否则 Y 时间重审"，给 `勿删` 一个到期日。成本最低，但赌 Phase B 会来。
  - **(b) feature-gate**：把 `verify_inet` 注册和模块包进 `#[cfg(feature = "inet-verification")]`，默认关。信号上明确"已 defer"，单测仍能在 `--all-features` 跑。
  - **(c) 归档到 `docs/deferred/`**：把这 1100 行移出编译树，留 plan/真机记录可随时捞回。最干净，但重启时要搬回来。
- **为什么值得做**：`勿删` 注释正在变成"无问责保留死代码"的挡箭牌。无论选哪个，关键是**给它一个明确的归属和复审时点**，而不是无限期挂着。

### 6. 清理过时注释 + 误导命名（小修，顺手做）

- **面**：B + C
- **判定**：OPTIMIZE　**信心**：高　**复杂度**：S
- **现状（已核对）**：① `topology_sidecar.rs:145` 注释"build_artifacts / validate_artifacts / describe_* 占位会被替换为 Rust 端实现"——其实已经实现并接线，注释是过时的 plan 笔记。② `build_legacy_topology_json/topo_feature/data_server/mac_forwarding_table` 和 `derive_legacy_mac/ip` **仍是 artifact 生成主链路的活代码**（别删），但 `legacy` 前缀会误导读者以为是兼容废料。③ `inet_verify_command.rs:26` 的 `sourceMutationId=0` 占位 TODO（INET 既已休眠，跟着 #5 的决策走即可）。
- **依据**：`direct:` —— 注释与实现不符、命名与生命周期不符。
- **为什么值得做**：这类"文档债"不改代码行为，但每个新读者都要被误导一次。占位注释删掉或更正；`legacy` 命名若确认是稳定主链路，考虑改成更中性的名字（如 `build_artifact_*`）。
- **坑**：命名是 rename，跨 Rust 调用点，用编译器兜，别手改漏。

### 7. 把"弱模型硬化债"从散落 defer 收成一张显式 checklist

- **面**：E（硬化债——不是删，是补）
- **判定**：HARDEN-BEFORE-WEAK-MODEL　**信心**：高　**复杂度**：每项 S–M
- **现状（已核对）**：当前 pin 在 Sonnet，多条规则靠 SKILL.md 纯文字（① 纯指引）兜底，Sonnet 听话所以现在没事，但都标了"弱模型切换前必做"：
  - **仿真完成态正则缺口**（`agent-adapter.ts:530` `isUnsupportedSimulationClaim`）：catch 了"启动仿真"但漏"仿真已完成/已启动/远程运行已启动"——弱模型更常这么说。风险高。
  - **破坏性删除确认门 U10**（仅 `SKILL.md:66` 文字"删关键项前先问"）：无代码门、无平面/冗余模型、无影响面检测。弱模型可能直接删骨干链路/双归一侧。风险高。
  - **linkSeq 重试幂等**（B 档 defer）：底层写幂等，但"同逻辑链路换 linkSeq 重发"不兜，弱模型重试更易重分配。
  - **完成态/artifact 转储声明**（SKILL.md 文字）：流量规划/导出"已完成"、整张 MAC 表转储，目前只有文字拦。
- **依据**：`reasoned:` + AGENTS.md 多处明记 "弱模型切换前"。
- **为什么值得做**：这几条**不是 MVP 残留、不该删**，恰恰相反——是切换到更便宜模型前的**前置硬化**。现在它们散落在 SKILL.md、AGENTS.md、各 plan 的 defer 段里。收成一张带触发条件（"切弱模型前"）的 checklist，避免切换那天漏项导致数据损坏/虚假成功。
- **坑**：不要在 Sonnet 期就急着全做成确定性代码——那会是过度工程。先成清单 + 触发条件，到真要切模型时再逐项实现。

---

## 被否决 / 合并的发现（附理由）

| 发现 | 处理 | 理由 |
|---|---|---|
| 删 `build_legacy_*` / `derive_legacy_*` | 否决 | artifact 生成主链路有活调用方（topology_compute 多处），命名误导已并入 #6 |
| 删 session payload 归一化 / `[工具]` trace 过滤 / diagnostic 迁移 | 否决 | 都是现役兼容代码，字段数据/旧 .db 导入仍依赖 |
| 统一 sidecar `{ok,summary}` 与 `VerifyResult{ok,caliber,errors}` 双形状 | 否决 | 故意的架构分层（HTTP 信封 vs 领域类型），非残留，2026-06-17 KTD4 已论证 |
| `flow-template` 早期 throw / stage-change 确认门 / undo 重放 | 否决 | 都按设计正常工作，确认门已是确定性 UI 按钮、非文字 |
| `warnings` `#[allow(dead_code)]` 字段 | 合并入 #6 | 小事，跟注释清理一起评估 |
| 新建 `DEFERRED_CODE_POLICY.md` / feature-flag 工作流 / roadmap 文档 | 否决 | 相对收益过度工程；#5 给单点决策即可，不必先立制度 |
| `tsn-time-sync` 标 draft 但已 wired → 改 enabled | 降级合入 #2 | 真实但极小，归到阶段脚手架收口一起做 |

## 建议落地顺序

1. **先合当前分支**（`chore/drop-unused-tables` 已在删空壳表），同一节奏把 **#1 backfill 删除**接上去——同类、低风险。
2. **#4 session 复活 bug** 单独修（唯一真 bug，用户可见）。
3. **#3 死 schema + #6 注释/命名** 一个小 PR 顺手清。
4. **#2 planning-export 收口** 复核行号后做。
5. **#5 INET 决策**：需要你拍 (a)/(b)/(c)，再动手。
6. **#7 硬化 checklist**：整理成文档，不在 Sonnet 期实现，挂到"切弱模型"触发。

> 注：本文件保存在 `docs/ideation/`。`docs/solutions/` 目前几乎空白，这次审计的判断（尤其"哪些 legacy 是活的别删"）值得用 `/ce-compound` 沉淀一篇，避免下次有人误删主链路。
