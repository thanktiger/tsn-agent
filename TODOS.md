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

### mutationId 跨重启语义
**Priority:** P2
in-memory 计数器重启归零，但 `topologyMutationId` 持久化在 session payload，跨重启数值比较会错。UI 当前只作布尔/唤醒信号用（安全）；引入跨重启比较前需持久化计数或携带 launch epoch。（adversarial：claude P0#1）

### mutation buffer 全局 eviction 跨会话误判
**Priority:** P2
`out_of_range` 按全局 buffer head 计算；多会话高频写入时其它会话被误触发全量 refetch 或漏报 gap。需按 session 维护保留下界。（adversarial：claude P1#5）

### inspect 出向规模无上限：import 路径绕过 ≤200 论证
**Priority:** P2
inspect 全量 rows 的规模论证依赖「数据只能经 initialize（compute ≤200 节点）与 apply_operations（≤32/批）进入」，但 `session_import` 从外部 DB 复制任意行数/字段大小，可使 inspect 响应撑大 sidecar 内存与模型上下文（token DoS）。与 ImportRowValidator 强化合并处理：导入时校验行数/字段大小上限。（adversarial：codex #2，2026-06-05）

### apply_operations 缺 CAS 前置条件（stale batch）
**Priority:** P3
inspect 响应不带版本、apply 不收 expectedMutationId；模型基于旧 rows 构造的 batch 会在新拓扑上执行（三态只防同 key 异值，不防 stale 逻辑写）。单用户串行交互下概率低；若引入并发编辑或多 agent，需 CAS 式 expectedMutationId。（adversarial：codex #4，2026-06-05）

### link_add 允许 self-loop（src==dst）评估
**Priority:** P3
端点计数对 self-loop 取 expected=1，节点存在即插入；TSN 物理拓扑无设备自连用例，下游 artifact/布局行为未定义。评估是否在 ops 层拒绝（行为变更需拍板）。现状已有测试固化端点计数语义（link_add_self_loop_requires_single_endpoint）。（adversarial：codex #7，2026-06-05）

### topology.validate / build_artifacts 仍收 topology JSON 入参
**Priority:** P3
DB 权威后模型没有 topology JSON 可传，这两个工具的入参形态与 inspect 同病（使用频率低）。评估改为 DB-backed 或下线入参。（plan 2026-06-05-001 Deferred Features）

## Agent runtime / UI

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

### U4a-2 byte-equal 基线回归测试
**Priority:** P2
canonicalizer 移除后缺少 Spike A 基线 fixture 的字节级对照测试，「单一事实源 byte-equal」保证未在代码中强制。（plan audit PARTIAL）

## Completed

### apply_operations 幂等性 + timeout-after-commit
**Completed:** v0.3.x 数据可靠性包 (2026-06-05)
node_add/link_add 改 UPSERT；node_delete/link_delete 删除不存在目标为 no-op（rows_affected=0）；timeout 后重试整批安全（回归测试 insert_switch_batch_replay_is_retry_safe）。

### link_add 悬空引用校验 + 操作数量上限
**Completed:** v0.3.x 数据可靠性包 (2026-06-05)
link_add 校验两端 imac 存在（UNKNOWN_NODE）；node_delete 拒绝仍被链路引用的节点（NODE_HAS_LINKS）；sidecar 端 operations ≤ 32（LIMIT_EXCEEDED，对齐 MCP maxOperations）。

### backfill walker 静默丢弃缺 numericId 的节点/链路
**Completed:** v0.3.x 数据可靠性包 (2026-06-05)
缺 numericId 显式 mark_failed（CANONICAL_SCHEMA_INVALID:node/link_missing_numeric_id），进入恢复列表，不再假成功。

### use-session-db-listener 竞态修复 + 新 hook 单测
**Completed:** v0.3.x 数据可靠性包 (2026-06-05)
catch-up 单链串行化 + latest 取 max 防游标回退 + 重复事件忽略 + session 切换游标归零；新增 use-session-db-listener / use-topology-snapshot / sidecar-client 三个测试文件（20 cases）。

### check-no-legacy-types.sh 接入 CI workflow
**Completed:** v0.3.x PR-β2 (2026-06-05)
`.github/workflows/ci.yml` 在 push/PR 时运行扫描；脚本默认 `SCAN_MODE=fail`。
