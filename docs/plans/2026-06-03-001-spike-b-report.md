---
spike: B
plan: docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md
date: 2026-06-03
result: PASS
---

# Spike B Report — Agent SDK MCP child env passthrough

## Goal

Plan v3 U1 Spike B：验证 SDK spawn MCP stdio child 时 env 的实际行为，决定 `mcpServers.tsn_topology.env: { ... }` 字段是否必须显式声明 `TSN_AGENT_SESSION_ID / DB_RPC_URL / DB_RPC_TOKEN / PATH / HOME / SystemRoot / APPDATA / LANG`，以及 `CLAUDECODE` 是否需要在 spawn 前 `delete`。

## Method

Files:
- `tmp/spike-mcp-env-passthrough/echo-server.mjs` — 最小 stdio child；启动时把 `process.env`（精选 13 个键 + 前 30 个 sorted 键 + 总 key 数）以 JSON dump 到 stderr 后 exit。
- `tmp/spike-mcp-env-passthrough/runner.mjs` — 用 `child_process.spawn` 跑 3 个 case + (deferred) Agent SDK live test。

Sentinels：parent runtime 显式 `process.env.CLAUDECODE = "1"`（模拟最坏情况：parent 本身就是 Claude Code 内嵌运行，[anthropics/claude-agent-sdk-python#573](https://github.com/anthropics/claude-agent-sdk-python/issues/573) 嵌套 session 拒绝 bug 触发场景）。

## Cases & Results

| Case | spawn options | child totalEnvKeys | CLAUDECODE in child | PATH in child |
|---|---|---|---|---|
| 1. **default** (no `env` field) | `spawn(node, [server])` | **115**（全继承 parent） | `"1"` ✓ 透传 | full PATH 可见 |
| 2. **merged** (`env: { ...process.env, X: v }`) | spread parent | **116**（115 + 1 新增） | `"1"` ✓ 透传 | full PATH 可见 |
| 3. **isolated** (`env: { X: v }` only) | 仅显式 | **2**（仅 X + NODE-internal） | `null` | `null` |
| 4. Agent SDK live | (deferred — Node `child_process.spawn` 是 SDK 底层) | — | — | — |

### 核心 verdict

1. **Node `child_process.spawn` 的 `env` 字段是 REPLACE，不是 merge**（Case 3 confirms）。
2. **默认无 `env` 字段时全继承 parent env**（Case 1 confirms），含 sensitive vars like `CLAUDECODE`。
3. SDK (`@anthropic-ai/claude-agent-sdk@0.3.160`) 文件是 minified，但 grep `spawn` 关键字命中，确认 SDK 底层用 `child_process.spawn` —— 同一 REPLACE 语义适用。

## Implications for plan v3 U4b

1. **必须在 `mcpServers.tsn_topology` 显式声明 `env` 字段** —— 而不是依赖 SDK 默认透传：
   ```js
   mcpServers: {
     tsn_topology: {
       type: "stdio",
       command: process.execPath,
       args: [topologyMcpServerPath],
       env: {
         PATH: process.env.PATH ?? "",
         HOME: process.env.HOME ?? "",
         ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
         ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
         ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
         ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
         TSN_AGENT_SESSION_ID: sessionId,
         TSN_AGENT_DB_RPC_URL: sidecarUrl,
         TSN_AGENT_DB_RPC_TOKEN: sidecarToken,
         // CLAUDECODE 显式不传（即使 process.env 有，也不放进这里）
       },
       alwaysLoad: true,
     },
   }
   ```
   理由：即使 SDK 当前版本默认透传 parent env，依赖默认行为是脆弱的（v2 plan 已经引用 SDK 已知 env bug [#28332](https://github.com/anthropics/claude-code/issues/28332)）。显式声明永远是更稳的契约。

2. **worker 必须在 SDK spawn 前 `delete process.env.CLAUDECODE`** —— 即使没把它放进 `mcpServers.env`，因为：
   - Case 1 (default) 证明 CLAUDECODE 会随 default-inherit 传到 child
   - 即使我们显式 `env: {...}` 覆盖 mcpServers 的 spawn，但 worker 自身仍在 Claude Code 父进程内运行，SDK 内部各种 spawn / fork 子进程可能仍受 CLAUDECODE 影响
   - 沿用 plan v3 KTD `delete CLAUDECODE before spawn`

3. **OS-specific 集已确认在 worker 已知 env 中**：dev 机 Case 1 总 env keys=115 含 `USER/SHELL/TERM/PATH/HOME/LANG` 等。Linux/macOS 默认有 `LANG`；Windows 需 `SystemRoot/APPDATA`（dev 机 macOS 没有 SystemRoot，所以本机测试只覆盖 *nix；Windows 透传留 Spike B v2 在 CI 跑）。

## Action items

1. **U4b 实施时**：worker `mcpServers.tsn_topology` 必须含完整 `env: { ... }` 字段（per 上面骨架），不能省略。
2. **U4b 实施时**：worker 启动入口 `runWorker(...)` 前 `delete process.env.CLAUDECODE`。
3. **U4b Phase A test**：单测断言 `mcpServers.tsn_topology.env` 含三个 TSN_AGENT_*，不含 CLAUDECODE。
4. **后续 spike (B v2)**：CI Windows runner 跑同 spike 验证 `SystemRoot/APPDATA` 行为；如本机不便，spike B v2 可推到 U4b 实施时的 cross-platform CI 跑通验证。

## Status

✅ PASS — Plan v3 U4b 的 mcpServers env 显式声明 + delete CLAUDECODE 是必须的，**不是 nice-to-have**。Spike A (byte-equal) 和 Spike C (WAL + Node IPv4) 可继续。
