---
title: "refactor: flow_verify_command 拆分为职责单一兄弟模块"
type: refactor
date: 2026-07-15
origin: docs/brainstorms/2026-07-15-gcl-leftovers-batch-requirements.md
depth: standard
---

# refactor: flow_verify_command 拆分为职责单一兄弟模块

## 摘要

`src-tauri/src/flow_verify_command.rs`（3236 行 = 正文 1056 + 测试 2180）按内聚簇拆成 3 个新兄弟文件 + 保留编排主文件。**纯搬家：函数体一行不改**，只挪位置、补 `pub(crate)` 可见性、调 import。验收双闸：`cargo test flow_verify` 59 条基线不变 + 全量 cargo test 绿（origin R5 / AE5）。

---

## 问题框架

单文件堆了 DTO、CSV 解析、逐流判决、断链故障计划、多轮编排全部逻辑，每次改动要在三千行里定位，review 困难。调研确认拆分条件理想：对外契约只有 lib.rs 两行（`mod` 声明 + `verify_tas` 注册），全仓无其它消费者；五个内聚簇天然单向分层（DTO → 纯函数 → 编排），零循环依赖风险。

---

## 关键技术决策

1. **KTD1 纯搬家（move-only）**：函数体、判据、文案零改动；唯一允许的代码变化是 `pub(crate)` 可见性标注、`use` 路径、模块 doc 注释。发现想改的坏味道一律记 Deferred，不顺手改。
2. **KTD2 平铺兄弟文件，不建子目录**：src-tauri/src 是纯平铺结构（46 个平级文件，无 mod.rs 先例），沿用（先例：flow_verify / flow_route / flow_plan_command 的边界划法）。
3. **KTD3 新文件名保留 `flow_verify_` 前缀**：`cargo test flow_verify` 是既有基线口径（59 = 本文件 48 + flow_verify.rs 的 11），前缀不保则 filter 漏测。
4. **KTD4 测试随函数走，集成测试留主文件**：直测纯函数的单测随簇迁移；走 `verify_tas_inner` 的集成/矩阵/e2e 测试（含跨模块调 `plan_tas_inner` 的）留主文件。私有项直测点仅 4 处（load_gcl / fault_t_break_ns / FLOW_VERIFY_FILTER / DTO 直构），`pub(crate)` 即解。
5. **KTD5 可见性 `pub(crate)` + doc 注释标明消费方**（gcl_synth / inet_sim_bundle 既有约定）。

---

## 目标结构

| 文件 | 内容（源行号） | 规模 |
|---|---|---|
| `flow_verify_types.rs`（新） | DTO 群（56–156：StreamVerdict/GptpDiag/VerifyRound/VerifyTasResult + simple()）+ VerifyTasRequest（1031–1035）+ 跨簇共享常量（CALIBER_FLOW_TAS_VERIFIED / JITTER_LIMIT_NS / FLOW_VERIFY_FILTER） | ~115 行 + serde/DTO 直构单测随迁 |
| `flow_verify_verdict.rs`（新） | VecRow + parse_vec_csv（192–242）、classify（255–399）、gptp_diag_from_csv（407–466） | ~280 行，无随迁单测（判决测试全走 verify_tas_inner，留主文件） |
| `flow_verify_fault.rs`（新） | BreakPoint/FaultPlan/select_break_point（469–568）、fault_t_break_ns/frames_after_break + 常量 FAULT_T_BREAK_FLOOR_NS（唯一使用点在本簇） | ~130 行 + fault_t_break_ns 直测 1 条随迁 |
| `flow_verify_command.rs`（留守） | doc 注释、load_gcl、round_summary/round_label、verify_tas_inner（~433 行）、`#[tauri::command] verify_tas` 薄壳 + 集成/矩阵/e2e 测试与共享夹具 | ~500 正文 + ~1800 测试 |

依赖方向恒单向：command → {types, verdict, fault} → 外部既有模块；新模块间 verdict/fault 只依赖 types，互不依赖。

---

## 实施单元

### U1. 拆出 flow_verify_types.rs（DTO + 常量）

**Goal**：DTO 群与常量群整体迁出，全仓编译绿。

**Requirements**：R5 / AE5。

**Dependencies**：无。

**Files**：新建 `src-tauri/src/flow_verify_types.rs`；修改 `src-tauri/src/flow_verify_command.rs`、`src-tauri/src/lib.rs`（加 `mod flow_verify_types;`）。

**Approach**：搬 DTO（含 `impl VerifyTasResult::simple`）与**跨簇共享的 3 常量**（CALIBER_FLOW_TAS_VERIFIED / JITTER_LIMIT_NS / FLOW_VERIFY_FILTER）；FAULT_T_BREAK_FLOOR_NS 随 U3 进 fault（唯一使用点），FAULT_MIN_FRAMES_AFTER_BREAK 留主文件（唯一使用者 verify_tas_inner）。可见性统一 `pub(crate)` + 消费方注释。原文件加显式列名导入（照抄邻居写法）。`rounds_serde_camel_case` 等 DTO 直构单测与 FLOW_VERIFY_FILTER 常量断言随迁。

**Patterns to follow**：`gcl_raw_store.rs`（叶子模块形态）；`inet_sim_bundle.rs` 的 pub(crate)+消费方注释。

**Test scenarios**：move-only，无新测试；随迁单测原样通过。Test expectation: 基线闸见 U4。

**Verification**：`cargo test --manifest-path src-tauri/Cargo.toml flow_verify` 59 passed 不变。

### U2. 拆出 flow_verify_verdict.rs（CSV 解析 + 逐流判决 + gPTP 诊断）

**Goal**：三组纯函数迁出，判决逻辑独立可读。

**Requirements**：R5 / AE5。

**Dependencies**：U1（依赖 types）。

**Files**：新建 `src-tauri/src/flow_verify_verdict.rs`；修改 `src-tauri/src/flow_verify_command.rs`、`src-tauri/src/lib.rs`（加 `mod flow_verify_verdict;`）。

**Approach**：搬 VecRow/parse_vec_csv/classify/gptp_diag_from_csv 正文；依赖面 = types + inet_sim_bundle（FlowStreamSpec/FlowPlacement/flow_expected_sent）+ inet_sim_command（解析三件套）——**不含 flow_verify**（ST_PCP/expected_pcp 的使用点全在留守的 verify_tas_inner 内，误加会撞 clippy unused import）。**无随迁单测**：全部判决测试都经 verify_tas_inner，按 KTD4 留主文件；夹具（healthy_csv 等）也只被集成测试用，原地不动。

**Patterns to follow**：`gcl_synth.rs`（纯函数模块 + 自带 tests）。

**Test scenarios**：move-only，无新测试。

**Verification**：同 U1 基线闸；classify/parse 单测在新 mod 路径下全绿。

### U3. 拆出 flow_verify_fault.rs（断链故障计划）

**Goal**：断点选择与守卫小函数迁出。

**Requirements**：R5 / AE5。

**Dependencies**：U1。

**Files**：新建 `src-tauri/src/flow_verify_fault.rs`；修改 `src-tauri/src/flow_verify_command.rs`、`src-tauri/src/lib.rs`（加 `mod flow_verify_fault;`）。

**Approach**：搬 BreakPoint/FaultPlan/select_break_point/fault_t_break_ns/frames_after_break + 常量 FAULT_T_BREAK_FLOOR_NS（唯一使用点在 fault_t_break_ns，随簇走，见 U1 口径）；依赖 flow_route::Route / topology_verify::VerifyLink / timesync_tree::ClockTree。随迁单测仅 1 条：`fault_t_break_ns` 直测（t_break_forty_percent_with_200ms_floor）；select_break_point 相关测试走 verify_tas_inner，留主文件。

**Patterns to follow**：`flow_route.rs`（纯逻辑模块形态）。

**Test scenarios**：move-only，无新测试。

**Verification**：同 U1 基线闸。

### U4. 主文件收尾 + 双闸验收

**Goal**：留守文件只剩编排（load_gcl/round_summary/verify_tas_inner/verify_tas）+ 集成测试；全仓行为零变化确认。

**Requirements**：R5 / AE5。

**Dependencies**：U1、U2、U3。

**Files**：修改 `src-tauri/src/flow_verify_command.rs`（doc 注释更新为编排层职责 + 指向三个新模块）、`src-tauri/src/lib.rs`。

**Approach**：确认 lib.rs 的 `invoke_handler` 注册不动；模块头 doc 注释把 U6/U7/U8 设计决策记录按归属分拆到对应新文件（决策文字原样搬，不重写）。跑双闸 + `cargo fmt --check` + `cargo clippy -- -D warnings`（pre-commit 不跑 Rust lint，CI 会拦——本地必须手跑，见 ci-rust-lint-gotchas 先例）。

**Test scenarios**：move-only。验收断言：① `cargo test flow_verify` 计数 = 59；② 全量 `cargo test` 通过数与拆分前一致（动手前先实跑记基线数）；③ `git diff` 逐 hunk 核对无函数体改动（纯移动 + import/可见性）。

**Verification**：双闸绿 + fmt/clippy 绿 + vitest 不受影响（未动前端）。

---

## 范围边界

**不做**：
- 任何行为/判据/文案调整（发现坏味道记下面 Deferred）。
- 不建子目录/mod.rs 结构（KTD2）。
- 不动 `flow_verify.rs`（录入闸模块，另一职责，5+ 文件引用）。

**Deferred to Follow-Up Work**：
- `verify_tas_inner` 433 行编排内核的进一步分解（run_round 闭包提独立函数等）——涉及签名设计，非纯搬家，另起周期。
- 测试夹具群（MockRunner/ScriptedRunner/seed 族）若跨模块共享变多，可考虑 `#[cfg(test)]` 公共夹具模块——本期按「谁用跟谁走/共享留主文件」处理。

---

## 风险与依赖

- **filter 语义**（KTD3）：新文件名不带 `flow_verify_` 前缀会让 59 条基线静默缩水——U4 验收显式断言计数。
- **测试夹具耦合**：2180 行测试里夹具相互引用密，迁移时以「编译器驱动」逐步挪，每个单元结束跑基线闸，不攒大步。
- **clippy 版本错位**：CI 用最新 stable，本地过了 CI 可能拦（ci-rust-lint-gotchas 先例）——U4 收尾本地跑 clippy，仍以 CI 为准。
- 无前端、无 DB、无外部接口影响。

---

## 验收（对照 origin AE5）

- 库里 `cargo test flow_verify` 59 passed 不变；全量 cargo test 与拆分前同数通过。
- grep 确认 `verify_tas` 对外注册唯一入口不变；无任何行为差异（move-only diff 核对）。
