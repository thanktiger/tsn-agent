---
title: "feat: 流量规划面板重设计 — GCL 门控时序图 + 明细表 + 对齐时间同步设计语言"
type: feat
date: 2026-07-03
---

# feat: 流量规划面板重设计（GCL 可视化 + 视觉对齐时间同步）

## Summary

流量规划面板从纯文字消息升级为与时间同步面板同一设计语言：新增只读 `get_flow_plan` 命令暴露 `flow_plans` 门控表，规划结果区渲染门控时序图（零依赖 SVG 泳道：每行一个节点端口、x 轴 = 1ms 门周期、ST 开窗色块，阶梯错位直观呈现 Z3 流水线）+ 可折叠明细表；未规划态走居中 CTA 渐进式；验证多轮结果卡片化统一徽章视觉。boss 已确认设计方案（门控时序图 + 折叠明细 + 渐进式 CTA + 验证视觉统一）。

---

## Problem Frame

门控表综合后只显示「已综合 N 个门控条目」，明细无任何查询面（数据在 `flow_plans` 表但 UI/agent 都读不到）；面板整体是裸文字+裸表格，与时间同步面板（命令栏/CTA/判定条/徽章/SVG 曲线）视觉断档。

---

## Key Technical Decisions

**KTD1 — GCL 读取走新只读 Tauri command，三态全部由数据推导。** `get_flow_plan(session_id)` 读 `flow_plans` 全行 + `topology_nodes.name` 显示名映射 + 门周期常量 + 流集类别计数（stCount/rcCount/beCount），camelCase DTO。前端呈现态由查询推导、不依赖规划动作记忆：entries 非空 → 结果区；entries 空且流集无 ST（有流）→ 蓝色信息条（「流集无 ST 流，无需门控」——对未点过规划的纯 BE/RC 会话同样是真命题，语义自洽）；entries 空且有 ST 流 → 未规划 CTA。切会话回来凭数据即可恢复展示，不与 App 级「运行态随会话重置」（U11 既有约定）冲突——planState 只承载 running/error 瞬态。

**KTD2 — 时序图零依赖 SVG，复用时间同步图表手法。** 参照 `time-sync-panel.tsx` 的 `OffsetChart`（viewBox 缩放、Okabe-Ito 色板、`sim-chart-*` 类名族）：每行 = (节点,端口)，x 轴 0→1ms（刻度 0/250/500/750/1000µs），由 `initiallyOpen/offset/durations` 还原开窗区间画色块（复用后端语义：state(t)=seq((t+offset) mod cycle)，前端按同语义还原，跨周期边界拆段）。行序按首个开窗起点升序（流水线阶梯自然呈现）。

**KTD3 — 渐进式呈现沿时间同步惯例。** 未规划（无 GCL 且非 no_gating）→ 居中 `PanelCta`「规划门控表」；已有结果 → 按钮收进命令栏右上（「重新规划」+「软仿验证」）。no_gating → 蓝色信息条，不画空图。规划成功后自动拉取明细刷新展示。

**KTD4 — 只动前端与一个只读命令，验证逻辑零改动。** 验证区仅视觉统一（轮徽章条、`sim-overall`/`sim-badge`/`eng-table` 类名对齐、gPTP 诊断行样式），rounds/判据/DTO 不动。

---

## Implementation Units

### U1. 只读命令 get_flow_plan

- **Goal:** 暴露门控表明细给前端。
- **Files:** `src-tauri/src/flow_plan_command.rs`（查询函数 + DTO + `#[tauri::command]`）、`src-tauri/src/lib.rs`（注册）；测试同文件。
- **Approach:** `FlowPlanDetail { cycleNs, solver, stCount, rcCount, beCount, entries: [{ node, nodeName, ethN, gateIndex, initiallyOpen, offsetNs, durationsNs }] }`；节点显示名复用 `load_topology` 既有取名模式（缺名回退 mid）；类别计数查 `topology_streams`；三态判定见 KTD1（entries=[] 不等于未规划，须结合 stCount）。`GATE_CYCLE_NS` 需在 `inet_sim_bundle.rs` 提为 `pub(crate)`（当前模块私有，跨模块引用编译不过）。serde camelCase 契约测试。
- **Test scenarios:** ①有 GCL 会话返回全行+显示名+计数 ②空表+纯 BE 流集 → entries=[] 且 beCount>0（前端蓝条判据）③空表+有 ST → 未规划判据 ④camelCase 字段断言。
- **Verification:** cargo test 绿。

### U2. 规划结果区重构（时序图 + 折叠明细 + 渐进式 CTA）

- **Goal:** 规划结果可视化，boss 的「查询门控表」诉求落地。
- **Files:** `src/app/components/workspace-pane/flow-sim.ts`（DTO 镜像 + `invokeGetFlowPlan` + 开窗区间还原纯函数 + 图表色板常量）、`flow-panel.tsx`（`GateTimelineChart` + `GclDetailTable` 折叠区 + CTA/命令栏改造）、`time-sync-panel.tsx`（`CHART_COLORS` 加 export 供两面板同源）、`src/app/App.css`（`flow-gcl-*` 增量类，复用 `sim-chart-*` 变量）；测试 co-located。
- **Approach:** 见 KTD2/KTD3。明细表列：节点/端口 ethN/门/offset(µs)/开窗宽度(µs)/占空比/初态；折叠头样式同 `sim-override-toggle`（「▸ 门控明细 · N 条目」）。时序图行标签「短名·ethN」，ST 窗色取导出后的 `CHART_COLORS[0]`，hover title 显示精确 ns。面板挂载与 plan 成功（含 no_gating）后都调 `invokeGetFlowPlan` 刷新（跨会话恢复展示的入口）；验证按钮闸口径升级为「planAllowsVerify(planState) 或 查询三态非未规划」。
- **Test scenarios:** ①开窗区间还原纯函数：initiallyOpen 两态 + offset 回绕 + 跨周期拆段（手算 ns 断言）②有明细渲染时序图行数与折叠表条目数 ③no_gating → 蓝条无图 ④未规划 → CTA 居中、规划后按钮进命令栏 ⑤占空比计算。
- **Verification:** vitest 绿；真机看图。

### U3. 验证区视觉统一 + 样式收尾

- **Goal:** 多轮验证结果与时间同步同语言。
- **Files:** `flow-panel.tsx`（轮徽章条 + 类名对齐）、`App.css`；测试同步。
- **Approach:** 轮 section 头改徽章条（`sim-badge ok/bad` + 轮名 + 标注 chip）；per-stream 表统一 `eng-table`；判定列徽章化；gPTP 诊断行样式对齐 `sim-message mono`；overall 用 `sim-overall converged/warn`。不改任何判据/DTO/文案语义（既有测试锁定的文案不动，只动容器与类名——断言文案的测试不受影响，断言结构的按需微调）。
- **Test scenarios:** ①既有 flow-panel 测试全绿（文案断言不破）②轮徽章渲染 ③e2e smoke 不破。
- **Verification:** `npm test` + `npm run e2e` 绿；真机与时间同步面板并排目视一致。

---

## Scope Boundaries

- 不做：`flow.inspect` 门控表输出的显示名等增强（agent 现已能经 flow.inspect 读到 flow_plans 原始行，UI 才是本次缺口）；时序图缩放/悬停交互增强（hover title 之外）；多 ST 流分色（当前 ST 单门，留多流真实需求出现时）；验证逻辑/判据任何改动。

---

## Sources & Research

- 设计参照：`src/app/components/workspace-pane/time-sync-panel.tsx`（commandbar/PanelCta/sim-overall/eng-table/sim-badge/OffsetChart 手法）、`timesync-subtabs.tsx`、`panel-cta.tsx`；样式在 `src/app/App.css`。
- 数据源：`flow_plans` 表（db.rs FLOW_DOMAIN_SCHEMA_SQL，PK (session_id, stream_seq, node, eth_n, gate_index)，durations_ns JSON 数组，语义见 `inet_sim_bundle.rs` pin 段与 `gcl_open_intervals`）。
- 门周期常量：`inet_sim_bundle::GATE_CYCLE_NS`（由 `flow_verify::GATE_CYCLE_US` 推导）。
