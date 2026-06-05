# TODOS

按组件分组；组内按优先级 P0（最高）到 P4 排序。完成项移入底部 Completed。

## Phase A 收尾（用户可见缺口）

### Export / Import 会话 UI 接线
**Priority:** P1
Rust `export_session` / `import_session` 命令已就绪并经测试，UI 无入口。
接线前必须先修导出语义：当前导出是整库 `VACUUM INTO`（含其它会话数据，隐私泄漏，且导入端拒绝多 session DB），scrub 非事务（并发保存可能读到 `{}`，恢复失败会永久丢 payload）。需改为单会话导出 + 事务化。（adversarial：codex #1/#2，2026-06-04）

### Backfill 失败恢复 UX
**Priority:** P1
`retry_backfill` / `list_backfill_failures` / `view_session_payload` 命令已就绪，UI 无入口；`backfill_progress` 事件未发射；失败会话在 UI 上与空会话不可区分。
防护：`retry_backfill` 从 payload 重建会清掉 MCP 增量编辑（walker DELETE+重建），接 UI 前需加确认或合并策略。（adversarial：claude P0#3）

## Sidecar / 数据完整性

### apply_operations 幂等性 + timeout-after-commit
**Priority:** P1
`node_add` / `link_add` 是裸 INSERT，超时重试会撞 UNIQUE 导致整批回滚并报 `DATABASE_ERROR`；commit 后响应超时被客户端报为 retryable，UI 已更新而对话报失败。需要幂等键 / `ON CONFLICT` 语义 + commit 状态可查询。（adversarial：claude P1#9/#10）

### link_add 悬空引用校验 + 操作数量上限
**Priority:** P1
`topology_links` 无 FK，`link_add` 不校验 imac 存在，悬空链路可持久化；operations 数量无 Rust 端上限（MCP 层 maxOperations 未落到 sidecar）。（adversarial：codex #4/#5）

### backfill walker 静默丢弃缺 numericId 的节点/链路
**Priority:** P1
`filter_map` 跳过缺字段节点后仍标记 `completed_walker`，拓扑缺数据但无错误状态。（adversarial：claude P2#15 + codex #9，多源确认）

### mutationId 跨重启语义
**Priority:** P2
in-memory 计数器重启归零，但 `topologyMutationId` 持久化在 session payload，跨重启数值比较会错。UI 当前只作布尔/唤醒信号用（安全）；引入跨重启比较前需持久化计数或携带 launch epoch。（adversarial：claude P0#1）

### mutation buffer 全局 eviction 跨会话误判
**Priority:** P2
`out_of_range` 按全局 buffer head 计算；多会话高频写入时其它会话被误触发全量 refetch 或漏报 gap。需按 session 维护保留下界。（adversarial：claude P1#5）

## Agent runtime / UI

### use-session-db-listener 竞态修复 + 新 hook 单测
**Priority:** P1
初始 catch-up 与事件回调并发读写 `lastSeenRef`，乱序时永久退化为 60s watchdog 轮询。`use-session-db-listener` / `use-topology-snapshot` / `sidecar-client` 均无直接单测（coverage audit + testing specialist 多源确认，2026-06-04）。

### run_claude_agent 超时不杀 MCP 子进程组
**Priority:** P2
超时只 kill worker 进程，SDK 拉起的 MCP child 带 `TSN_AGENT_DB_RPC_TOKEN` 残留。（adversarial：claude P2#13 + codex #6，多源确认）

### app_session_id 缺失时 fail-fast
**Priority:** P2
未传 session id 时 worker 收到空串 → sidecar 422 `FORBIDDEN_OPERATION`，报错对 agent 不可读。应在 `run_claude_agent` 入口拒绝。（adversarial：claude P1#7）

### redaction 空格分隔 Bearer token 不打码
**Priority:** P2
`Authorization: Bearer <x>` 空白分词后 value 保留明文（代码内已注明 known limitation）。（security specialist + codex #8，多源确认）

### session_import 独立 ImportRowValidator 偏离 plan 边界
**Priority:** P2
Plan 要求复用 ops 白名单，实际实现为独立 validator + 直接 INSERT（代码内已注明偏离）；评估收敛或在 plan 中追认。（plan audit CHANGED，2026-06-04）

## CI

### check-no-legacy-types.sh 接入 CI workflow
**Priority:** P1
脚本存在但没有任何 workflow 调用，drift 检测 inert；PR-β2 翻 `SCAN_MODE=fail` 时一并接入 `.github/workflows/`。（plan audit PARTIAL）

### U4a-2 byte-equal 基线回归测试
**Priority:** P2
canonicalizer 移除后缺少 Spike A 基线 fixture 的字节级对照测试，「单一事实源 byte-equal」保证未在代码中强制。（plan audit PARTIAL）

## Completed
