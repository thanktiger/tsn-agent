---
title: "feat: 时间同步面板重构（子 tab + set_gm 揭示 + 默认值/阈值可见）"
date: 2026-06-26
type: feat
origin: docs/brainstorms/2026-06-26-timesync-panel-subtabs-reveal-requirements.md
depth: standard
---

# feat: 时间同步面板重构

## Summary

把时间同步右侧面板从「软仿/硬仿两个并排按钮 + 空白参数表单 + set_gm 后零反馈 + 阈值写死 1µs」重做成：「时钟同步」tab 改名「时间同步」并分两个**平级**子 tab（软件仿真 / 硬件部署占位）；set_gm 后按面板状态分级揭示；覆盖参数显示生效默认值（后端出、前端读）；并把库里的 `offset_threshold` 真正接进收敛判定与阈值显示（改阈值即生效）。纯前端为主 + 两处轻量后端读取/读列。

---

## Problem Frame

`src/app/components/workspace-pane/time-sync-panel.tsx` 现状四处断点（见 origin）：set_gm 后 UI 不动、软/硬仿是两个一样的按钮（硬仿点了弹 `HARD_SIM_PLACEHOLDER` 死文案）、覆盖参数 `form={}` 全空白看不到默认、阈值写死 1µs。第五处（boss 现场发现）：`timesync.set_params` 改 `offset_threshold` 已落库，但软仿链路 `inet_sim_command.rs` 既不查这列也不用它——收敛判定与图表带都用写死的 `CONVERGENCE_THRESHOLD_NS=1000`，改阈值零生效。

---

## Requirements（追溯 origin）

- R1 tab 改名「时间同步」；R2 平级子 tab（软仿/硬部署，无 gating）；R3 软仿子 tab 收纳现有全部内容、移除并排硬仿按钮。
- R4 set_gm 分级揭示（收起→展开+落软仿子 tab；开着且在别 tab→脉冲 badge 不抢焦；已在则不动）；R4a 与「点节点强制 node-props」按最近动作生效。
- R5 覆盖参数折叠 header 显生效默认摘要 + 展开预填实值 + 已覆盖标记；R6 后端暴露默认值（专用命令）。
- R7 硬部署占位空态 + 回软仿按钮。
- R8 WebKit flex 约束；R9 state 归属分层。
- **R10（本计划新增，boss 现场授权，未回写 origin——刻意的计划级扩展）**：软仿读 `offset_threshold`（语义=ns）并按各节点阈值判定收敛；图表/表格阈值显示用实际值而非写死 1µs。
- **R3 取代说明**：U3 的硬件部署子 tab 空态**取代** origin 里"硬仿按钮点击弹『待接入真实硬件』"的旧形态（按钮形 → 子 tab 空态形），非回退。

---

## Key Technical Decisions

- **KTD1 — 平级子 tab，不 gating**（boss 定）。软仿/硬部署平级，互不解锁约束——有时无需软仿可直接硬部署。
- **KTD2 — 默认值后端出、前端读，走专用命令 `get_sim_defaults`**（boss 定）。纯读、零副作用，返回 `{oscillator, driftPpm, simTimeS}`，源是 `inet_sim_bundle.rs` 的 `DEFAULT_*`/`OscillatorKind::Random`。不与 `query_timesync` 快照混（语义分离）。
- **KTD3 — 揭示分级而非一律强切**。兼顾 boss 要的「弹出+跳转」与「自动抢 tab 焦点是争议反模式」。触发信号是 `timesyncSnapshot.domain.gmMid` 由无变有（set_gm 成功，用户/agent 触发皆可），且仅在时间同步阶段。
- **KTD4 — 子 tab 容器用 flex 不用 grid**（R8）。系统 WebKit 下 grid+overflow auto 行会塌 0 高（项目踩过两次：a7f06ff/.skill-file-list、87c773a/.master-list），切 tab 用 `align-self/align-content:start` 防跳变。验证靠 Safari 开 `127.0.0.1:5173` 或真机截图，Playwright 测不出。
- **KTD5 — offset_threshold 语义=纳秒（boss 定），放宽范围；逐节点接入**。`offset_threshold` 此前是无单位、无人消费的整数（默认 1000、范围 0..4095）。boss 定：它就是**逐节点收敛偏移阈值（ns）**。U7 据此：(a) 把 `set_params` 对 `offset_threshold` 的 `0..4095` 校验放宽到允许真实 ns 值（保留非负 + 合理上限，不再卡 4095）；(b) 软仿读该列、收敛判定 `within = max_ns <= 该节点 threshold_ns`；(c) `PerNodeOffset` 增 `threshold_ns` 带回前端。
- **KTD6 — 逐节点阈值靠 mid→ned 名映射对齐到 CSV 序列**。现状 `classify_and_compute` 只用 ned 名后缀匹配 GM；从节点阈值要对到正确曲线，须把 `build_timesync_sim_bundle` 已算出的**全量 mid→ned 名映射**（GM 用的同一套，产出 `sw{N}`/`es{N}`）导出，按 module 匹配给每条 series 附其阈值。这是原 deferral 的真正阻塞点（module 路径 keyed by ned 名 vs offset_threshold keyed by DB mid），不是单纯"补一列"。
- **KTD7 — 图表带按"统一阈值"画**。各从节点阈值相同（set_params 常见情形）→ 画一条带、标签用实际值（如「±500ns 阈值」，达 µs 量级显示「±1µs」）；阈值不一致 → 不画统一带、仅表格「参考线」列按各自阈值判定。`CONVERGENCE_THRESHOLD_NS` 降级为 NULL 兜底默认。

---

## Implementation Units

### U1. tab 改名 + 平级子 tab 骨架

- **Goal**：「时钟同步」显示名改「时间同步」；时间同步面板内部建两个平级子 tab（软件仿真 / 硬件部署）容器与切换，flex 布局、WebKit 安全。
- **Requirements**：R1, R2, R8, R9。
- **Dependencies**：无。
- **Files**：`src/app/components/workspace-pane/index.tsx`（CONFIG_TABS 显示名、config-panel 渲染）、`src/app/components/workspace-pane/time-sync-panel.tsx`（内部子 tab 容器）、`src/app/App.tsx`（新增子 tab 选择 state，归入随 sessionId 重置那层）、`src/app/App.css`（子 tab 样式，flex-wrap+overflow:visible、align-self/content:start）、`src/app/components/workspace-pane/time-sync-panel.test.tsx`。
- **Approach**：「时钟同步」→「时间同步」只改显示名/aria-label，`activeConfigTab` 键不变。新增子 tab 选择状态 `activeTimesyncSubTab`（'soft-sim' | 'hard-deploy'，默认 soft-sim）持 App 级，随 `activeSessionId` 变化重置（与 expand/activeConfigTab/selectedNodeId 同层，防 PR#23 id 污染）。子 tab bar + 内容用 flex 纵向，禁用 grid。子 tab 用 W3C ARIA tabs pattern：bar `role="tablist"`、每个子 tab 按钮 `role="tab" aria-selected aria-controls={panel id}`、内容区 `role="tabpanel" aria-labelledby`。
- **Patterns to follow**：现有 CONFIG_TABS 渲染、App 级 state 随 session 重置的既有写法、`tauri-webkit-ui-debugging` 记忆的 flex 修法。
- **Test scenarios**：
  - 渲染：时间同步面板显示「软件仿真」「硬件部署」两个子 tab，默认选中软件仿真。
  - 切换：点硬件部署 → activeTimesyncSubTab 变 'hard-deploy'，反之亦然，无 gating（任意顺序可切）。
  - 会话切换：换 session 后子 tab 选择重置为软件仿真。
  - 文案：tab 名为「时间同步」（不再「时钟同步」）。
- **Verification**：dev app / Safari 5173 下两子 tab 可见可切、切换无行塌/跳变；vitest 覆盖上述。

### U2. 软件仿真子 tab 收纳现有内容 + 移除并排硬仿按钮

- **Goal**：现有软仿全部内容（覆盖参数表单、运行态、收敛表、抖动曲线、解释）落位软件仿真子 tab；移除并排「硬仿」按钮。
- **Requirements**：R3。
- **Dependencies**：U1。
- **Files**：`src/app/components/workspace-pane/time-sync-panel.tsx`、`src/app/components/workspace-pane/time-sync-panel.test.tsx`。
- **Approach**：把现有软仿区整体移进软件仿真子 tab 渲染分支，软仿按钮触发行为不变。删除「硬仿」按钮及其 `hardSimNotice` 占位逻辑（语义由 U3 的硬件部署子 tab 承载）。simState 仍持 App 级，切子 tab 不丢、不取消正在跑的远端命令（R9）。
- **Patterns to follow**：现有 SimResultArea / SimOverrideForm 不动其内部逻辑，只换容器位置。
- **Test scenarios**：
  - 软件仿真子 tab 内可见软仿按钮 + 结果区；并排「硬仿」按钮已不存在。
  - 软仿运行中切到硬件部署子 tab 再切回，运行态/结果不丢（simState App 级）。
  - 收敛结果表 + 抖动曲线仍在软件仿真子 tab 内正常渲染。
- **Verification**：现有软仿相关测试迁移后全绿；真机软仿一次结果照常。

### U3. 硬件部署子 tab 占位空态 + 回软仿入口

- **Goal**：硬件部署子 tab 显示占位空态（是什么 + 本期不可用 + 去软件仿真），带切回软件仿真子 tab 的按钮。
- **Requirements**：R7。
- **Dependencies**：U1。
- **Files**：`src/app/components/workspace-pane/time-sync-panel.tsx`、`src/app/App.css`、`src/app/components/workspace-pane/time-sync-panel.test.tsx`。
- **Approach**：空态组件：标题「硬件部署」+ 说明（本期未接入真实硬件）+ 按钮「先用软件仿真验证」（点击 setActiveTimesyncSubTab('soft-sim')）。**视觉权重传达"占位非可用功能"**：说明文案用 muted/secondary 色、按钮用 secondary/outline 级（非 primary），避免占位看着像真入口。不显示裸 `待接入真实硬件` 文案。就绪清单（SSH 免密/INET/目标机）本期不做（origin Out of scope）。
- **Patterns to follow**：空态惯例（解释+单一 CTA）。
- **Test scenarios**：
  - 硬件部署子 tab 渲染空态文案 + 「先用软件仿真验证」按钮。
  - 点该按钮 → 切回软件仿真子 tab。
  - 不出现「待接入真实硬件」裸占位文案。
- **Verification**：真机点进硬件部署不空白、可一键回软仿。

### U4. set_gm 后分级揭示

- **Goal**：set_gm 成功后按面板状态分级揭示（收起→展开+落软仿子 tab；开着且在别 tab→时间同步 tab 挂脉冲 badge；已在→不动），与点节点竞态按最近动作生效。
- **Requirements**：R4, R4a, KTD3。
- **Dependencies**：U1。
- **Files**：`src/app/App.tsx`（监听 timesyncSnapshot.domain.gmMid 由无变有；揭示逻辑；badge state）、`src/app/components/workspace-pane/index.tsx`（时间同步 tab 标题 badge 渲染、进 tab 清 badge）、`src/app/App.css`（脉冲 badge 样式）、`src/app/App.test.tsx` 或对应测试。
- **Approach**：
  - **触发信号（KTD3 精确化）**：App 级用 ref 记 `prevGmMid`，effect 比较快照里 `domain.gmMid`。触发 reveal 的是 **same-session 内 gmMid 从无→有 或 值变化**（GM 设定/换 GM 都揭示——换 GM 是树全重算、最该看的事件），且 `workflowStep==='time-sync'`。
  - **切会话防误触（P1，feasibility）**：`useTimesyncSnapshot` 切会话会 reset 成 undefined 再重拉，切进一个已有 GM 的会话会产生 undefined→{gmMid} 的水合跃迁，不能当成 set_gm。处理：`activeSessionId` 变化时把 `prevGmMid` ref **基线设为新会话加载后的当前 gmMid**（不是 null），这样切会话不揭示，只有同会话内后续的无→有/值变化才揭示。
  - **分级**：触发时 config-panel 收起 → setConfigPanelExpanded(true)+setActiveConfigTab(time-sync)+setActiveTimesyncSubTab('soft-sim')；已开且 activeConfigTab≠time-sync → 置 `timesyncTabHasBadge=true`（不改焦点）；已开且在 time-sync → 无操作。
  - **badge 视觉规格**：实心圆点（直径 6px、无数字），accent/primary 色，inline 于 tab label 右侧 ~4px；脉冲 `@keyframes`（opacity 1→0.4，1s infinite）。badge 清除：用户首次进入时间同步 tab 时清；**离开 time-sync 阶段（workflowStep 切走）时也重置为 false**（不跨阶段残留）。
  - **与点节点竞态（R4a，P3 adversarial）**：reveal effect 须让"用户当前 render 周期内的显式 tab 切换"优先——用一个"本周期用户已导航"标志守卫 reveal，避免 React 批处理把 snapshot 驱动的 reveal 排在 click handler 之后、把刚点的 node-props 冲掉。
- **Execution note**：先写「gmMid 跃迁 → 揭示分级」的行为测试再实现，覆盖三分支 + 切会话不触发 + 与点节点同周期竞态。
- **Patterns to follow**：现有 handleNodeSelect 的「强制切 tab+展开」、useTimesyncSnapshot 订阅与切会话 reset。
- **Test scenarios**：
  - 面板收起 + 时间同步阶段 + 同会话 gmMid 由无→有 → 面板展开、activeConfigTab=time-sync、子 tab=soft-sim。
  - 同会话 gmMid 值变化（换 GM）→ 同样揭示。
  - **切进一个已有 GM 的会话（undefined→有值水合）→ 不揭示**（基线 ref 防误触）。
  - 面板已开且在 node-props + gmMid 跃迁 → 不切 tab，时间同步 tab 出现 badge。
  - 面板已开且在 time-sync + gmMid 跃迁 → 无变化、无 badge。
  - badge 存在时用户点进时间同步 tab → badge 清除；离开 time-sync 阶段 → badge 重置。
  - 非时间同步阶段 gmMid 变化 → 不揭示。
  - 揭示与点节点同一周期 → 用户点节点优先（activeConfigTab 留 node-props）。
- **Verification**：dev app 真机：对话里 set_gm 后面板按分级反应；切会话进已有 GM 的会话不被弹；正编节点属性时 set_gm 不被甩走。

### U5. 后端 get_sim_defaults 命令（默认值单一事实源）

- **Goal**：新增纯读 Tauri 命令暴露软仿默认值给前端。
- **Requirements**：R6, KTD2。
- **Dependencies**：无。
- **Files**：`src-tauri/src/inet_sim_command.rs`（或就近模块）新增 `get_sim_defaults` 命令、`src-tauri/src/lib.rs`（注册命令）、对应 Rust 单测。
- **Approach**：命令返回 serde camelCase `{ oscillator: "Random", driftPpm: 100.0, simTimeS: 60.0 }`，值取自 `inet_sim_bundle.rs` 的 `DEFAULT_DRIFT_PPM`/`DEFAULT_SIM_TIME_S`/`OscillatorKind::default()`。纯读、不碰库、不触发重算。
- **Patterns to follow**：现有 get_inet_host_config 等纯读命令的形状与 serde camelCase 约定。
- **Test scenarios**：
  - 命令返回的字段名是 camelCase（driftPpm/simTimeS/oscillator）。
  - 返回值与 inet_sim_bundle.rs 常量一致（改常量 → 返回跟随）。
- **Verification**：cargo 单测绿；前端 invoke 拿到默认值。

### U6. 覆盖参数默认值可见（折叠摘要 + 展开预填 + 已覆盖）

- **Goal**：覆盖参数折叠态 header 显示生效默认摘要，展开预填实值，改过的项标「已覆盖」；值来自 U5。
- **Requirements**：R5, KTD2。
- **Dependencies**：U2, U5。
- **Files**：`src/app/components/workspace-pane/time-sync-panel.tsx`（SimOverrideForm/SimOverrideRegion）、`src/app/components/workspace-pane/timesync-sim.ts`（默认值读取封装/类型）、`src/app/App.css`、`src/app/components/workspace-pane/time-sync-panel.test.tsx`。
- **Approach**：
  - **取默认**：进软件仿真子 tab 时（依赖 U2，触发点明确为该子 tab 挂载，非顶层面板）invoke get_sim_defaults。loading 态 header 用占位（"加载中…"/骨架）；invoke 失败静默回退前端硬编码默认（Random/100ppm/60s），不报错（与 KTD2 纯读零副作用一致）。
  - **摘要**：折叠 header 由死字符串改为「振荡器 Random · 漂移 100ppm · 时长 60s · 默认」（值来自 defaults）。
  - **已覆盖语义（P3 adversarial 收口）**：用**显式"用户已编辑"标志**（touched set）判定「已覆盖」，**不**用 `form 值==默认值` 比较——预填会让"未改"与"恰好设成默认"无法区分，且后端默认换版时值比较会误报。展开后字段为编辑方便预填默认实值，但「已覆盖」只看该字段是否被用户实际编辑过。呈现：逐字段后缀角标，如「振荡器 Custom（已覆盖）· 漂移 100ppm · 时长 60s」。
  - **提交**：发给后端的是当前显示值（保持现有提交语义）。
- **Patterns to follow**：现有 SimOverrideForm 受控字段；U5 命令读取。
- **Test scenarios**：
  - 折叠态 header 显示三项生效默认（Random/100ppm/60s），不再空白。
  - loading 态 header 显占位；get_sim_defaults 失败 → 静默回退硬编码默认、不报错。
  - 展开后三个字段预填默认实值（非空 input）。
  - 用户编辑某字段 → header 该项后缀「（已覆盖）」；未编辑项仍「默认」。
  - **未编辑任何字段（即便值=默认）→ 不标「已覆盖」**（touched 判定而非值比较）。
  - 默认值来自后端（mock get_sim_defaults 改值 → 摘要/预填跟随）。
- **Verification**：真机展开覆盖参数见预填默认；改后端常量后前端摘要/预填跟随；未改的字段不误标已覆盖。

### U7. offset_threshold 接入（语义=ns，收敛判定 + 阈值显示用实际值）

- **Goal**：把 `offset_threshold` 正式定为逐节点收敛阈值（ns）、放宽其校验范围；软仿读它、收敛判定按各节点阈值；收敛表「参考线」与图表阈值带显示实际阈值而非写死 1µs。
- **Requirements**：R10, KTD5, KTD6, KTD7。
- **Dependencies**：U2（图表/表格在软件仿真子 tab 内）。
- **Files**：`src-tauri/src/timesync_sidecar_routes.rs`（放宽 set_params 对 offset_threshold 的校验范围：非负 + 合理上限，不再卡 0..4095；更新注释标明单位 ns）、`src-tauri/src/inet_sim_command.rs`（timing 查询补 offset_threshold；`classify_and_compute` 收敛判定改用各节点阈值；`PerNodeOffset` 加 `threshold_ns`；导出/接收全量 mid→ned 名映射对齐 series）、`src-tauri/src/inet_sim_bundle.rs`（`SimNodeTiming` 加 `offset_threshold_ns` 字段；`build_timesync_sim_bundle` 暴露全量 mid→ned 名映射）、`src/app/components/workspace-pane/timesync-sim.ts`（`PerNodeOffset` 加 `thresholdNs`）、`src/app/components/workspace-pane/time-sync-panel.tsx`（图表带 + 表格「参考线」用实际阈值、标签去硬编码 1µs）、对应 Rust + vitest 测试。
- **Approach**：
  - **校验放宽**：`set_params` 把 offset_threshold 的 `0..4095` 改为「非负 + 合理 ns 上限」，注释标单位 ns。
  - **取数对齐（KTD6）**：timing 查询补 `offset_threshold`（i64 ns，NULL → 兜底 `CONVERGENCE_THRESHOLD_NS`）。`build_timesync_sim_bundle` 把每个 mid→ned 名（GM 已有的同一套，产出 sw{N}/es{N}）作为映射带出；`classify_and_compute` 用它把各节点阈值附到对应 module 的 series，而非只 GM 后缀匹配。
  - **判定**：`within = max_ns <= 该节点 threshold_ns`（取代写死 1000）。`PerNodeOffset` 带回 `threshold_ns`。
  - **前端**：图表带按 KTD7（统一→画带用实际值标签；不一致→不画带、表格逐节点判定）。前端 `CONVERGENCE_THRESHOLD_NS` 常量改为仅兜底注释，阈值由数据（thresholdNs）驱动。
- **Execution note**：先加「节点阈值=500、max=400 → within=true；max=600 → false」的后端测试再改判定逻辑（验逻辑用对了 per-node 值而非全局 1000）。
- **Patterns to follow**：现有 timing 查询字段加载、`gm_ned_name` 的 mid→ned 映射产出、`PerNodeOffset` serde camelCase、图表带 `thresholdInView` 逻辑改为读实际值。
- **Test scenarios**：
  - 后端：节点 offset_threshold=500、稳态 max=400 → within=true；max=600 → within=false（证明用 500 不是 1000）。
  - 后端：offset_threshold NULL → 兜底 1000。
  - 后端：多从节点不同阈值 → 各自阈值对到各自 series（mid→ned 映射正确），不串台。
  - 后端：`set_params` 接受 >4095 的 ns 值（如 5000）不再被旧范围拒。
  - 后端：`PerNodeOffset` 序列化含 `thresholdNs`（camelCase）。
  - 后端：既有会话（offset_threshold 之前经 set_params 设为非默认，如 500）下次跑软仿，判定按 500 而非 1000——**显式覆盖"既有会话判定翻转"这一行为变化**。
  - 前端：所有节点阈值=500 → 图表带标签「±500ns 阈值」（非硬编码 1µs）、带位置对应 500。
  - 前端：表格「参考线」内/外按节点实际阈值判定。
  - 前端：节点阈值不一致 → 不画统一带，表格仍逐节点判定。
- **Verification**：对话里 `set_params offset_threshold=500` 后跑软仿，收敛判定与图表/表格阈值都按 500 反映；真机验证。

---

## Scope Boundaries

### 本期做
- R1-R10 全部（tab 改名/平级子 tab/软仿收纳/硬部署空态/set_gm 揭示/默认值可见/offset_threshold 接入）。

### Deferred to Follow-Up Work
- 硬件部署真实功能与接口（独立周期）。
- 硬部署空态的「硬件就绪清单」（SSH 免密/远端 INET/目标机映射）——真做硬部署时再填。
- 折叠摘要（CollapsibleSummary）/占位空态（PlaceholderPhase）抽成跨面板通用组件——等第二个真实使用者出现再提取，避免单一使用者过早抽象。

### Outside（本期不做）
- 软仿/硬部署的「软仿收敛才解锁硬部署」gating（boss 定平级）。
- reveal 抽象成通用事件总线（硬编码 set_gm 一个触发点即可）。
- 覆盖参数预设方案/分组（当前仅 3 参数，过早抽象）。

---

## Open Questions

- **图表阈值带在「各节点阈值不一致」时的呈现**（KTD7）：默认按"不画统一带、仅表格逐节点判定"实现。若实跑中确实出现 per-node 不同阈值且需要在图上体现，留 ce-work 期按真实数据决定（画多条参考线 / 取 GM domain 代表值 / 取最严阈值）。当前 set_params 多为统一设值，默认实现已覆盖常见情形。
- ~~offset_threshold 单位~~：**已定（boss）= 纳秒（ns）**，U7 据此放宽 0..4095 范围并直接当 ns 用，不再留待实跑。

---

## System-Wide Impact

- IPC 契约新增一个命令（get_sim_defaults）+ PerNodeOffset 新增 thresholdNs 字段——前后端 serde camelCase 对齐，既有 SimResult 消费端需容纳新字段（向后兼容，纯增字段）。
- App 级新增一个 state（子 tab 选择）+ 一个 badge state，纳入会话重置层。
- WebKit 布局风险集中在 U1/U3 的子 tab 容器——必须真机/Safari 验。
