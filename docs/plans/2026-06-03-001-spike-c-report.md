---
spike: C
plan: docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md
date: 2026-06-03
result: PASS_WITH_PLAN_CORRECTIONS
---

# Spike C Report — WAL upgrade + plugin-migration path + Node IPv4 fetch

## Goal

Plan v3 U1 Spike C：验证 (a) main db 升级 `journal_mode=WAL` + `busy_timeout=5000` 后既有测试不回归；(b) `tauri-plugin-sql` migration 与 `connect_app_database` 是否指向同一 db 文件（plan v3 假设可能不一致需选一条）；(c) Node fetch 用 127.0.0.1 IPv4 literal 在 dev 机能跑通（Windows IPv6-first 行为推到 CI 验证）。

## Method

dev db: `~/Library/Application Support/com.tsnagent.app/tsn-agent.db` (54MB，由 dev 机使用产生)。

```bash
# Backup
mkdir -p tmp/spike-c-wal-upgrade/backup
cp '<db>' tmp/spike-c-wal-upgrade/backup/tsn-agent.db.before-wal

# Check current state
sqlite3 '<db>' 'PRAGMA journal_mode; PRAGMA user_version; PRAGMA application_id; PRAGMA busy_timeout'
sqlite3 '<db>' "SELECT name FROM sqlite_master WHERE type='table'"
sqlite3 '<db>' 'SELECT version, description, installed_on FROM _sqlx_migrations'

# Cargo baseline
npm run cargo:test

# Node IPv4 fetch test
node tmp/spike-c-wal-upgrade/node-ipv4-fetch.mjs
```

## Findings

### 1. WAL is already enabled — sqlx default

```
PRAGMA journal_mode         → wal     (already WAL!)
PRAGMA user_version         → 0
PRAGMA application_id       → 0
PRAGMA busy_timeout         → 0       (default; needs upgrade to 5000)
```

`sqlx 0.8.6` 在 `SqliteConnectOptions::new()` 默认 `journal_mode = SqliteJournalMode::Wal`，所以 dev db 自从 v0.2 起就一直在 WAL 模式跑。**U2a 的 "PRAGMA journal_mode=WAL 升级"是 no-op**（但 keep 在 plan 里作为 explicit invariant declaration 仍合理）。

**busy_timeout=0** 是默认值，需要手动 set；U2a 加 `PRAGMA busy_timeout=5000` 必要。

### 2. Plugin migration + connect_app_database 是同一 db（不是不同文件）

```
$ sqlite3 '<db>' "SELECT name FROM sqlite_master WHERE type='table'"
_sqlx_migrations         ← plugin 加的（sqlx migrate）
sessions                 ← connect_app_database 加的（SESSION_SCHEMA_SQL）
app_state                ← connect_app_database 加的
diagnostic_logs          ← connect_app_database 加的

$ sqlite3 '<db>' 'SELECT * FROM _sqlx_migrations'
1|create_session_store|2026-05-20 07:21:46
```

`_sqlx_migrations` 与 `sessions` 表共存于**同一 db**，说明 `tauri-plugin-sql` 的 `DATABASE_URL = "sqlite:tsn-agent.db"`（相对路径）被 plugin 智能解析到 `app_config_dir/tsn-agent.db` —— 与 `connect_app_database` 用的绝对路径**完全一致**。Plan v3 担心的"两条路径指向不同 db"不存在。

**但**有一个 plan v3 假设错误需要修正：

**Plan v3 U2a 说"PRAGMA user_version=2"作为 schema 版本**——但 `tauri-plugin-sql` **不用 `user_version` PRAGMA**，它用 `_sqlx_migrations` 表（标准 sqlx migrate 表，含 version/description/installed_on/checksum 列）来跟踪 migration 版本。

`db.rs::migrations()` 当前返回 version 1 (`create_session_store`)，已经被 plugin apply。新增 6 张 topology 表应该作为 version 2 migration（描述如 `create_topology_domain_tables`），plugin 会自动跑并写一行到 `_sqlx_migrations`。

`db.rs::SESSION_SCHEMA_SQL` 的 safety-net 角色保留（`connect_app_database` 内 `CREATE TABLE IF NOT EXISTS` 是幂等），但**主迁移机制是 plugin migration**。

### 3. cargo test 不回归

```
test result: ok. 28 passed; 0 failed; 0 ignored
```

包含：`session_schema_contains_expected_tables` / `diagnostic_store::tests::*` / `session_store::tests::*` 等关键测试全过。WAL 默认 + busy_timeout=0 状态下既有功能正常。

### 4. Node fetch IPv4 literal 在 macOS 上 work（Windows 行为推到 CI）

```
Server bound to 127.0.0.1:61719 (IPv4)
  Case 1 [default fetch IPv4 literal]: 200 family=IPv4 remote=127.0.0.1
  Case 2 [fetch + family:4 dispatcher]: SKIPPED (node:undici not exposed in Node 24)
  Case 3 [fetch localhost on macOS]: 200 family=IPv4 remote=127.0.0.1
```

**关键 verdict**: 
- 在 macOS 上 `fetch("http://127.0.0.1:<port>/")` 自然走 IPv4，无需任何额外配置。
- `node:undici` 在 Node 24 不暴露为可 import 模块 → `Agent({ connect: { family: 4 } })` 模式不可用。
- Windows IPv6-first 行为的真正缓解方案：
  - **最简单**：始终用 `127.0.0.1` literal in URL（plan v3 KTD 已规定），不用 `localhost`。
  - **可选加固**：worker startup 加 `dns.setDefaultResultOrder('ipv4first')`（Node ≥17）作为防御。

## Implications for plan v3 (corrections needed)

### U2a 修正

| v3 写法 | 修正为 |
|---|---|
| `PRAGMA user_version=2` 升级 | 用 `tauri-plugin-sql` migration version 2（在 `db.rs::migrations()` 返回数组里追加） |
| `PRAGMA journal_mode=WAL`（升级动作） | declarative invariant — sqlx 0.8 默认已经是 WAL，但**显式 set 仍可保留**作为 defense |
| `PRAGMA application_id = 0x54534E01` | 仍需在 schema migration 内显式 set（plugin migration 内执行）|
| `PRAGMA busy_timeout=5000` | 仍需手动 set（默认是 0） |
| `connect_app_database` `max_connections=1` → 4 | 仍需（与 sidecar 并发） |
| `SESSION_SCHEMA_SQL` safety-net 角色 | 保留 — `connect_app_database` 启动时跑 CREATE TABLE IF NOT EXISTS 是无害冗余 |

### Cargo.toml 依赖

Spike C 没新增 axum/secrecy/subtle（那是 U3 工作）；当前 cargo test 全过验证 baseline 是好的 starting point。

### Node IPv4 worker spawn

U4b 的 sidecar-client.ts `fetch` 写法：
```js
const res = await fetch(`http://127.0.0.1:${port}/db/topology/...`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(15_000),
});
```
**用 IPv4 literal 即可，不需要 dispatcher**。可选在 worker 启动入口加 `dns.setDefaultResultOrder('ipv4first')` 作为防御。

### Plan v3 顶部段落需补一句

在 "Architecture 概览 → 数据流" 段加注：
> sqlx 0.8 默认 `journal_mode=Wal`；U2a 升级动作主要是 `busy_timeout` + `max_connections` + `application_id` + 新表 schema，**WAL 已默认开启**。

## What's deferred

- ⏸️ `npm test` (vitest 全测) — Spike C v1 没跑，需要 30+ 分钟，留 U2a 实施前/后跑一次 baseline
- ⏸️ `npm run e2e` (Playwright) — 同上
- ⏸️ Windows IPv6-first 行为验证 — 推到 CI Windows runner（U4b 的 cross-platform e2e）

## Status

✅ **PASS_WITH_PLAN_CORRECTIONS** — Spike C 揭示了 3 处 plan v3 假设错误（user_version PRAGMA、WAL 升级、plugin-migration 路径），需要在 U2a 实施前更新 plan v3 文本。核心结论：
1. WAL 已默认 — `busy_timeout` + `max_connections` 是 U2a 真正改动
2. Plugin migration + connect_app_database 同 db — 不需要二选一
3. 127.0.0.1 IPv4 literal 即可，无需 dispatcher hack
4. cargo:test baseline 28/28 pass — 可继续 U2a 实施
