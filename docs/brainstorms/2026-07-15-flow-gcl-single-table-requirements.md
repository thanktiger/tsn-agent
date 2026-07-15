---
topic: 门控结果单表化 flow_gcl_plan + raw 出库 + flow_plans 物理删除
date: 2026-07-15
status: ready-for-work
origin: 口头 brainstorm（boss 挑战三表设计，单表方案经推演认可）
---

# 门控结果单表化 + raw 出库 + flow_plans 删除

## 背景与决策依据

三表设计（gcl_windows/gcl_plan_meta/gcl_raw_archive，PR #117）被 boss 挑战后重新推演，结论：**单表更贴真实使用模式**。关键论据：
- 窗口行没有任何行级 SQL 操作（写=全清全写、读=全量、筛选在前端）——行粒度没被利用，窗口该是 JSON 列；
- 每规划一行后，no_gating 零窗口态天然有行承载 status，stale 是单行 UPDATE——三表的「主从分离」理由消失；
- raw 只有 verify 重放一个消费者且读频极低——出库到文件（eval 采集管道先例），连指针列都不用存（路径确定性派生），一步消掉导出/undo 列排除与 4KB 导入闸三套特殊处理。

**时机**：v1.1.0 后未发版，用户库里没有三表——零迁移窗口。

## 需求

- **R1 单表 `flow_gcl_plan`**（域前缀 boss 定）：每 (session_id, provider) 一行——status / cycle_ns / algorithm / stale / created_at / **windows_json**（窗口数组 `[{node, ethN, entryIdx, startNs, durationNs, gateStates, flowRefs}]`，字段语义沿三表版不变）。PK (session_id, provider)，ON DELETE CASCADE。
- **R2 raw 出库**：求解器原文 par 行写 `<app数据目录>/gcl-raw/<session_id>-<provider>.par`（纯文本覆盖式，eval 先例模式）。verify pin 重放改读文件；**文件缺失响亮报无规划**（fail-safe，与导入态同语义）。删工程/删流清空时删除文件。目录不存在时创建。
- **R3 flow_plans 物理删除**：schema 定义、undo FlowPreImage 对它的覆盖、写路径清残留逻辑、一切关联死代码全删。
- **R4 全消费端跟随，外部行为零变化**：落库（plan_tas）/读查询（get_gcl_detail）/verify 重放/agent inspect（响应形状 gclWindows+gclMeta **保持不变**——服务层展开 JSON）/删流清空/undo 快照/会话导出导入/stale 写手（导入置 stale 语义保留）。弹窗/概览/前端类型不感知变化。
- **R5 导入闸**：windows_json 列专属上限 512KB（照 sessions.payload 豁免先例）；导入不带 raw 文件（天然）→ verify 无规划 + stale 提示重新规划（既有口径）。
- **R6 格式文档就地改 v1**：docs/solutions/flow-planning/gcl-windows-format-v1.md 更新为单表 + raw 文件说明（castup 尚未对接，不留 v2 包袱）。

## 验收

- AE1：规划→弹窗三页签/概览八卡/CSV 与改动前完全一致；agent flow.inspect 响应形状不变。
- AE2：规划→软仿验证跑通（重放读文件）；手动删掉 .par 文件→验证响亮报无规划。
- AE3：导出→导入：windows/状态随行导入、stale=1 提示重新规划、验证报无规划（无 raw 文件）。
- AE4：undo 流操作：flow_gcl_plan 行随快照恢复；raw 文件不参与（保持最新）。
- AE5：库里无 flow_plans 表；grep 无 flow_plans 引用（除历史文档）。

## 不做

- windows_json 出库（查询主体、量级小，留库）
- raw 压缩（文本直读的调试价值优先）
- provider 维度语义变化（castup 留位照旧）
