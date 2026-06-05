---
run_id: 2026-06-03-u2-review
date: 2026-06-03
mode: autofix
branch: feat/topology-mcp-single-db-domain
base: 4cf2237f4b98f16ae3e4a733c31842be7a9f3a6a (main)
plan: docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md
reviewers: 10 (correctness, testing, maintainability, project-standards, agent-native, learnings, security, performance, data-migrations, adversarial)
test_result: 41 passed / 0 failed (was 40 pre-fix; +1 test added by autofix)
verdict: Ready with fixes
---

# Code Review Run Artifact — Plan v3 U2a + U2b

## Scope

- 5 Rust files changed: db.rs / session_store.rs / diagnostic_store.rs / commands.rs / redaction.rs (new) / lib.rs (mod registration)
- 2 commits reviewed: `0f2497e` (U2b redaction), `f4f4857` (U2a schema v2)
- Untracked excluded: `docs/tsn-artifact-fields.html` (per autofix mode rules)

## Applied Fixes (safe_auto, 4)

| # | File | Change | Reviewer |
|---|---|---|---|
| 1 | `src-tauri/src/redaction.rs:32` | `pub fn redact_token_like_word` → `fn redact_token_like_word` (no external callers verified via grep) | maintainability |
| 2 | `src-tauri/src/diagnostic_store.rs:195-197` | `pub use crate::redaction::redact_secrets` → `use crate::redaction::redact_secrets` (avoid dual binding path) | maintainability |
| 3 | `src-tauri/src/session_store.rs:fresh_memory_pool` | Test fixture now uses `SqliteConnectOptions::new().foreign_keys(true)` builder, matching production `connect_app_database` path; removes redundant manual `PRAGMA foreign_keys=ON` in cascade test | testing |
| 4 | `src-tauri/src/redaction.rs` (test added) | `redact_error_masks_authorization_header_in_error_path` — asserts Authorization header redaction in error path; documents split_whitespace limitation as known constraint (adversarial #4) | testing |

Tests after fixes: **41 passed / 0 failed** (was 40 pre-fix; +1 new test).

## Findings Summary

### P1 — Should Fix (3, all routed manual/gated_auto to downstream-resolver)

| # | File | Issue | Reviewers | Confidence | Route |
|---|---|---|---|---|---|
| 1 | `src-tauri/src/session_store.rs:nodes_subtable_foreign_key_cascade_works` | **FK CASCADE 仅覆盖 2 / 15 子表**。13 张未测的子表若 FK 定义错（如缺 `ON DELETE CASCADE`）当前测试无法发现。Plan v3 U2a Test scenarios L302 显式要求"删除 sessions 行级联删除 15 张表中该 session 数据"。 | testing + adversarial (2 reviewers) | 0.90 | manual → downstream-resolver |
| 2 | `src-tauri/src/redaction.rs:redact_secrets` | **多词 secret 被 split_whitespace 截断**。例 `password: "the rest leaks"` 只脱敏 `password:` 字面，后续 token 泄漏；diagnostic_store 的 `redact_and_truncate` 走的就是这条路径。本轮 autofix 已加测试明确该限制 (split_form 案例)，但根本解需要按 JSON 而非字符串脱敏。 | security + adversarial | 0.80 | manual → downstream-resolver |
| 3 | `src-tauri/src/db.rs:P0_DOMAIN_SCHEMA_SQL` 末尾 PRAGMA | **PRAGMA application_id 在 schema string 末尾**。审视后判定**实际不是缺陷**：`safety_net_schema_sql()` 在 `connect_app_database` 每次连接时拼 SESSION_SCHEMA_SQL + P0_DOMAIN_SCHEMA_SQL 全量跑一次，PRAGMA 会在每次启动重新设置一次（幂等）。即便 plugin migration 中途失败、应用重启，safety_net 路径仍会 reach PRAGMA。**降级为 P3 advisory + 已有专门测试 `safety_net_schema_applies_application_id_pragma` 验证。** | adversarial (false alarm post-analysis) | 0.30 (post-review) | suppressed |

### P2 — Moderate (5)

| # | File | Issue | Reviewer | Confidence | Route |
|---|---|---|---|---|---|
| 4 | `src-tauri/src/db.rs` (15 个 CHECK constraints) | **没有负向测试验证 CHECK constraint 拒绝非法值**（traffic_class>=8 / cfg_kind='bad'）。若未来 schema 变更意外放宽 CHECK，无人察觉。 | testing | 0.72 | manual |
| 5 | `src-tauri/src/db.rs::migrations()` | **`description` 字段更名一旦被改会破坏 `_sqlx_migrations` 唯一性**。已存量用户会出现 v2 双行。属流程治理（Code Reviewer 需要在 PR 审 description 不动）。 | adversarial | 0.72 | advisory |
| 6 | (multi-table 池一致性) | **safety_net_schema_sql 每次 connect 都跑 `format!()` 字符串拼接 + 17 个 CREATE IF NOT EXISTS**。生产 OnceCell 保证 connect 仅 1 次/进程，此项**性能影响可忽略**。 | performance | 0.65 | advisory |
| 7 | (并发模型) | **max_connections=1→4 + busy_timeout=5s + WAL** 引入新的并发假设。当前 U2a 还没有 sidecar，无实际 contender；U3/U4a 接入 axum sidecar 时需要在该 PR 内复审 pool 持有跨 `await` 的代码路径。 | performance + adversarial | 0.68 | advisory (defer to U3) |
| 8 | (correctness misread) | correctness reviewer 引用 plan "字节级与抽前一致" 标记 U2b 行为变化为 P2，但实际 plan 只对 diagnostic_store path 字节级一致；commit message 已显式声明 `commands::redact_error: strictly more redaction`。**误报，不计入修复队列。** | correctness | 0.30 (false positive) | suppressed |

### P3 — Low / Advisory (6)

| # | Item | Source |
|---|---|---|
| 9 | Schema draft drift (insert_order 加入；styles_json / oss_cfg / time_cfg 合并 JSON 列）— 实施与草案有简化偏离但 Spike A 验证字节等价；建议补 schema-draft.md 注解 | data-migrations |
| 10 | SENSITIVE_KEYS 未覆盖 jwt / refresh_token / 自定义 tsn_ 前缀；现有 sk-ant- + 6 SENSITIVE_KEYS 已覆盖主流模式，加固空间为 R22 future-work | security |
| 11 | Sparse node.json 测试覆盖：Spike A 仅 BFE fixture，gcl/sdu/psfg/frer 等 8 类子表无 round-trip 真数据；建议 boss 补 1-2 稠密 fixture | data-migrations + Spike A 既已注明 |
| 12 | NULLABLE 语义无显式 negative test（INSERT NULL 验通过） | testing |
| 13 | `_sqlx_migrations` 集成测试（真实 plugin migration runner） | data-migrations |
| 14 | redact 文本与文档保持中文风格统一 | maintainability (positive) |

## Pre-existing (advisory only, not counted)

- clippy 4 warning 全部在 main HEAD 既有代码（`map.entry().or_insert_with()` / `as_bytes().len()`），不在本 PR 范围。

## Coverage

- Suppressed below 0.60 confidence: 2 (correctness false-positive about plan criterion; performance OnceCell allocation concern)
- Untracked file excluded: `docs/tsn-artifact-fields.html`
- Reviewer team: 10/10 returned results, 0 failed/timed out
- Cross-reviewer agreement boosts: FK CASCADE coverage (testing + adversarial, +0.10)
- Plan source: explicit (passed via `plan:` arg)

## Requirements Trace (vs plan v3)

| Requirement | Status |
|---|---|
| R1-R4 DB 结构与边界 (15 P0 表) | ✅ 实施完整。schema 草案的 4 类细节简化 (insert_order 加入；4 处 JSON 列合并) 由 advisory #9 记录 |
| R10-R12 事务模型 (sqlx Transaction / FK / busy_timeout) | ✅ FK 开启、busy_timeout=5s、max_connections=4 |
| R22 redact 模块集中 | ✅ U2b 完成；SENSITIVE_KEYS 覆盖既有 Rust 两副本+略加固 (Authorization) |
| R5 / R5a 日志文件 writer | ⏸️ 未在本 PR 范围（U_R5 后续单独 unit） |
| R6-R9 MCP 工具契约 | ⏸️ 未在本 PR 范围（U4b 后续单独 unit） |
| R13-R16 sidecar / token / event | ⏸️ 未在本 PR 范围（U3 / U6 后续单独 unit） |

U2 unit 完整对齐 plan v3 R1-R4 + R10-R12 + R22。

## Verdict

**Ready with fixes (P1 #1-2 留给 downstream-resolver)**

- 4 safe_auto fixes 已自动应用，41/0 cargo test 全绿
- P1 #1 (FK CASCADE 13 表) 建议在 U4a 实施时一并加 loop-style 测试（与 ops 白名单 enum 同期）
- P1 #2 (多词 secret) 留作 U_R5 实施 file writer 时同步修正 (JSON-level redaction)
- Phase A Release Gate 之前需补这两项

## 残余可执行 (downstream-resolver)

1. 加 FK CASCADE 全 15 表的 parameterized test (P1) — 建议挂 U4a 实施
2. redact_secrets 改 JSON-level / 兜底文档化 split_whitespace 限制 (P1) — 建议挂 U_R5 实施
