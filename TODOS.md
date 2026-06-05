# TODOS

按组件分组；组内按优先级 P0（最高）到 P4 排序。完成项移入底部 Completed。

## Sidecar / 数据完整性

### mutationId 跨重启语义
**Priority:** P2
in-memory 计数器重启归零，但 `topologyMutationId` 持久化在 session payload，跨重启数值比较会错。UI 当前只作布尔/唤醒信号用（安全）；引入跨重启比较前需持久化计数或携带 launch epoch。（adversarial：claude P0#1）

### mutation buffer 全局 eviction 跨会话误判
**Priority:** P2
`out_of_range` 按全局 buffer head 计算；多会话高频写入时其它会话被误触发全量 refetch 或漏报 gap。需按 session 维护保留下界。（adversarial：claude P1#5）

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

### 会话导出/导入 UI（含单会话切片导出重写）
**Completed:** v0.4.0 (2026-06-05)
导出重写为单会话切片（tmp+原子 rename、symlink guard、payload 置 '{}'、主库零写入，scrub/restore 竞态整体删除）；UI 接入 save/open 对话框、id 冲突自动新 id、错误文案映射、「在 Finder 中显示」；agent 运行中禁用。导出↔导入真往返被测试固化。

### Backfill 失败恢复 UX
**Completed:** v0.4.0 (2026-06-05)
失败会话「迁移失败」badge + 错误码映射 + payload 预览（redact 后截断 64KB）+ retry 确认弹窗（固定强警告）+ 三处刷新；retry 的 walker 早期错误兜底 mark_failed(WALKER_ERROR) 防永久卡 pending。结论：`backfill_progress` 事件不做——启动 walker 在 setup 同步完成于窗口创建前，事件无有效接收窗口；mount invoke + retry resolve 回调覆盖全部刷新时机。

### import 路径规模上限（关闭 inspect 出向 DoS 缺口）
**Completed:** v0.4.0 (2026-06-05)
行数上限复用 compute MAX_NODES/MAX_LINKS（按 session 过滤）、字段级字节上限（styles_json/sync_type ≤4KB、*_json ≤64KB、mac/ip ≤64B、title/project_name ≤256B）、styles_json 必须为 JSON object、总行数 ≤50k、payload 强制 '{}'。内容级注入面（ops 白名单收敛）仍为 P2。

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
