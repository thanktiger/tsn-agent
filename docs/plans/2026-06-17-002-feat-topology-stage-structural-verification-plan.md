---
date: 2026-06-17
type: feat
title: "feat: 拓扑阶段结构验证过关闸（第一批，不依赖 INET）"
status: ready
depth: standard
origin: docs/brainstorms/2026-06-17-topology-stage-verification-requirements.md
---

# feat: 拓扑阶段结构验证过关闸（第一批，本地、不依赖 INET）

> 给 boss 的一句话：用户点「确认并继续」要离开拓扑阶段时，先自动检查拓扑结构对不对（连不连得通、端口配没配对、转发到不到得了）——有问题就拦住、用一句中文说哪里不对、修好才放行；通过就照常进下一阶段。这是一道**确定性代码检查**（不靠大模型判断），结论都标「仅结构级」，免得被当成"时延已保证"。本计划只做不依赖 INET 的第一批；接 INET 真跑是后续第二批。

---

## Summary

拓扑阶段目前没有真正的"过关"检查——`validate` 工具只查节点数和悬空链路（see origin: R 概述）。本批在「确认并继续」离开拓扑阶段前插入一道**确定性结构验证闸**：Rust 侧读库内拓扑（节点以 sync_name 标识、连线以 src/dst_sync_name，PR #35 后已无 imac/sync_type），跑图论校验（连通/端口配对/链路对称/孤立节点/角色/编号重复）+ MAC 转发表现算校验（每目的可达、无环、全覆盖），返回 `{ok, errors[], caliber:"structural_only"}`。校验经新 Tauri 命令 `verify_topology` 暴露；应用层在确认拓扑阶段时先调它，不过关则**不推进、把一句话结论 + 问题清单作为助手消息回显**，过关则照旧推进。MAC 表只现算用于校验、**不落库、不外发**。

---

## Problem Frame

**现状**：拓扑画完、点「确认并继续」即进入时间同步阶段，中间没有结构正确性把关——断线、孤立端系统、分裂子网都能蒙混过关，用户要到很后面（或真机）才发现。

**本批解决**：在离开拓扑阶段这一步加一道本地、断网可用的确定性检查，把"结构不完整/转发不通"挡在进下一阶段之前，并用一句人话 + 口径标签把结论讲给看不懂术语的 boss。

**为什么是确定性代码而非大模型**：通过与否是工程判断、必须可复现可硬守；大模型只产建议、不决定放行（沿用既有信任纪律，see origin: R4）。

---

## Requirements（追溯到 origin）

- **R1** 验证由「确认并继续」触发、作为离开拓扑阶段的过关闸；不过关不推进。
- **R2** 结论带口径标签；第一批固定 `仅结构级`（structural_only）。
- **R3** 失败给一句中文结论 + 具体问题清单（指明哪个节点/哪条链路）。
- **R4** 验证由代码确定性计算（Rust 读库），结论经既有应用层通道驱动拦截/放行；不重建大模型回传协议。
- **R5** 结构图论校验：连通性、端口两两配对、链路对称、无孤立节点、交换机/端系统角色合法、编号（sync_name/linkSeq）无重复；规则以可扩展清单组织。
- **R6** MAC 转发表现算现验：复用 BFS 算转发表，校验每目的恰好一个出端口、无转发环、所有端系统全可达；算完即弃、不落库。
- **R7** MAC 纳入过关闸：算不出合理转发表也判不过关；MAC 表本身不展示、不外发。
- **R8** 第一批口径 = `仅结构级`。

验收覆盖 origin 的 AE1-AE5。

---

## Key Technical Decisions

### KTD1：结构+MAC 校验做成一个纯 Rust 函数（新模块 `topology_verify.rs`），读库内拓扑
校验从 `topology_nodes`/`topology_links`（sync_name 键）读出节点与连线、在内存建邻接表后运行。纯函数、可单测、不碰网络。返回结构 `{ok: bool, errors: Vec<VerifyError{code, message_zh, ref}>, caliber: "structural_only"}`。理由：确定性、可复现、易测；与未来 INET 验证（第二批）共享同一"结论形状"（ok/errors/caliber）。

### KTD2：MAC 校验在 topology_verify 自建邻接表，与 compute 只保证算法一致（非代码复用）
现有 `topology_compute.rs::build_legacy_mac_forwarding_table` / `build_adjacency` / `find_first_egress_port`（BFS）操作的是内存 `IntermediateTopology`（用 `node_id`/`port_id` 类型），**这些函数无法直接用于 DB 行**（`src_sync_name`/`dst_sync_name`）——可复用的只是**算法**（BFS 首出端口、可达性），不是函数。所以 `topology_verify.rs` 从 `(src_sync_name, dst_sync_name)` 行自建邻接表跑判定（每端系统全可达 / 无转发环 / 每目的唯一出端口）。防漂移靠**一份共享测试 fixture**：同一拓扑分别喂给两条 BFS，断言可达性判定一致（不强行抽取共享 helper——那要把 build_adjacency 泛型化、比本功能还大）。

### KTD3：经新 Tauri 命令 `verify_topology` 暴露给应用层，过关闸只拦 topology 阶段的「前进确认」
新增 Tauri 命令 `verify_topology(sessionId) -> VerifyResult`（与 `query_topology`/`update_node_position` 同款 in-process 读路径）。过关闸插在 `src/agent/agent-adapter.ts` `runTsnAgent` 的 `action === "confirm-stage"` 分支、调 `runConfirmAction` 之前。

**关键：确认按钮同时驱动「前进确认」和「回退确认」**——后者带 `workflow.pendingStageChange`（用户在更后阶段说要改拓扑、大模型 request_stage_change 提议回退），`runConfirmAction` 先在 pendingStageChange 分支处理回退（带 carry-intent 重跑），**不能**对一个用户正要丢弃/重做的拓扑做"前进校验"。因此闸的触发条件必须是：

```
action === "confirm-stage" && workflow.currentStep === "topology" && !workflow.pendingStageChange
```

只拦 `runConfirmAction` 的**前进出口**；回退出口（pendingStageChange 分支）保持不验、原样走 carry-intent。命中闸时：`ok=false` → 不调 `runConfirmAction`、返回不推进的结果，workflow 原样；`ok=true` → 走现有 `runConfirmAction`（含 carry-intent / 其它阶段确认完全不变）。

**`verify_topology` 调用异常必须在本确认分支内 try/catch、fail-closed**：不得让 invoke reject 冒泡到 `App.tsx` 的通用 catch（那会把 "继续" 卡回输入框 + 显示通用"请求失败"文案）。异常时返回不推进结果、currentStep 留 topology、用专用文案"结构校验暂时无法运行，右侧工程保持原状态，未推进"。

### KTD4：本批不动 sidecar `validate` 路由（移出范围，见 Deferred）
原打算顺带把 sidecar `validate` 无参分支升级为同一校验核心。评审发现这无收益且有风险：agent 的 `topology.validate` 工具**总是带 `topology` 参数**、走的是 `validate_intermediate_topology` 那条分支（不是无参分支），且系统提示词明确叫大模型 initialize 后别再调 validate——所以升级无参分支对 agent 路径不生效；而无参分支响应壳 `{ok, summary{valid, errors:string[], warnings, source}}` 与 VerifyResult 形状不同，硬换会破坏既有消费。故本批**只做 verify_topology 命令**，不碰 sidecar validate；统一 agent 工具口径留作后续（见 Deferred）。

### KTD5：口径标签是数据字段、不是文案约定
`caliber` 作为 VerifyResult 的必填字段（本批恒 `structural_only`），UI 据此渲染标签；为第二批的 `loadability_only` 占位。"绿"永远带标签出现。

---

## High-Level Technical Design

确认即验过关闸的控制流（仅 topology 阶段）：

```
用户点「确认并继续」(action=confirm-stage)
        │
        ▼
currentStep===topology 且 无 pendingStageChange（=前进确认）?
        │ 是                                   │ 否（回退确认 / time-sync 等）
        ▼                                       ▼
invoke("verify_topology", sessionId)        现有 runConfirmAction 路径（回退分支/其它阶段，不变）
   （异常→本分支内 catch、fail-closed、不推进）
        │
        ▼
Rust topology_verify：读库(nodes/links) → 建邻接表
   → 结构规则清单(连通/端口/对称/孤立/角色/重复)
   → MAC 现算(每端系统可达 / 无环 / 每目的唯一出端口)
   → {ok, errors[], caliber:"structural_only"}
        │
   ok=false ─────────────► 不推进；助手消息＝一句话结论＋问题清单(标 仅结构级)；workflow 原样
        │
   ok=true ──────────────► runConfirmAction(workflow)（推进/carry-intent 等现有行为不变）
```

口径/结论形状（本批与第二批共用）：`{ ok, caliber, errors:[{code, message_zh, ref}] }`，`caliber ∈ {structural_only(本批), loadability_only(第二批), schedulability(占位未做)}`。

---

## Implementation Units

### U1. Rust 结构+MAC 校验核心（纯函数，新模块）
**Goal**：在 `topology_verify.rs` 实现读库内拓扑、跑结构规则清单 + MAC 可达校验、返回 `{ok, errors[], caliber}` 的纯函数。
**Requirements**：R5, R6, R7, R8（caliber=structural_only）。
**Dependencies**：无。
**Files**：`src-tauri/src/topology_verify.rs`（新建，含 `#[cfg(test)]`）、`src-tauri/src/lib.rs`（加 `mod topology_verify;`）。可能从 `src-tauri/src/topology_compute.rs` 抽取/借鉴 `build_adjacency`/`find_first_egress_port` 为共享 helper。
**Approach**：入参 = 该 session 的节点（sync_name/node_type）与连线（src/dst_sync_name + styles_json 里的端口）行集合（调用方读库传入，便于纯函数单测）。规则做成一组判定函数（`Vec<fn>`/闭包数组即可，不引入 Rule trait——~6 条规则不需要多态分发，满足"加一条不改引擎"），逐条产出 `VerifyError{code, message_zh, ref}`。自建邻接表（见 KTD2）。结构规则：连通性、端口两两配对（端口取自 styles_json 的 leftLabel/rightLabel；缺失/为 "{}" 视为端口配对错而非 panic）、链路对称、无孤立节点、**节点角色合法**（node_type 是 `Option<String>`，值域 switch/endSystem/server；**缺失或未知 node_type 本身判结构错** `unknown_node_role`，不得静默归类——否则会漏进 switch/端系统划分；server 是否合法按 topology_compute 既有口径，执行期确认）、sync_name 与 linkSeq 无重复。MAC：对邻接表 BFS，校验每端系统对其它端系统全可达、转发无环、每"交换机×目的"唯一出端口；任一不满足 → 不过关。`caliber` 恒 `"structural_only"`。错误信息中文、含具体节点/链路引用（如 "交换机 SW3 有一条线没接对端"）。
**最小拓扑边界（明确判定，免 execution 歧义）**：空拓扑（无节点）→ ok=false（"还没有拓扑可验"）；单交换机无链路 / 任意孤立节点 → ok=false（无孤立节点规则）；只有交换机、零端系统 → ok=false（"还没有端系统，无法验证转发"，不靠"空集合可达"蒙混通过）。
**Patterns to follow**：`topology_compute.rs` 的 BFS/邻接构建；`topology_ops.rs`/`db.rs` 的 sync_name 键模型（PR #35）。
**Test scenarios**：
- Covers AE1：某链路只连一端（悬空/缺对端）→ 返回 ok=false，errors 含该链路、指明缺对端。
- Covers AE2：某端系统未连任何交换机（孤立）→ ok=false，errors 指明该端系统。
- Covers AE3：拓扑分裂成两个互不连通子网 → MAC 现算发现有目的不可达 → ok=false。
- 合法星型/线型拓扑（含多交换机骨干）→ ok=true，errors 空，caliber="structural_only"。
- 转发环构造（人为制造回指）→ ok=false，标无环校验失败。
- 重复 sync_name / 重复 linkSeq → ok=false。
- 空拓扑（无节点）→ ok=false（"还没有拓扑可验"）。
- node_type 为 NULL 或未知值的节点 → ok=false（`unknown_node_role`），不被静默归入交换机/端系统划分。
- 只有交换机、零端系统的连通拓扑 → ok=false（"还没有端系统"），不因"空集合可达"误判通过。
- styles_json 缺 leftLabel/rightLabel 或为 "{}" → 端口配对错（ok=false），不 panic。
- 跨 BFS 一致性：同一拓扑分别喂 topology_verify 的可达判定与 topology_compute::build_legacy_mac_forwarding_table，断言可达性结论一致（防两份 BFS 漂移，见 KTD2）。
**Verification**：cargo test 覆盖以上；纯函数对给定行集合产出确定结果。

### U2. Tauri 命令 verify_topology
**Goal**：把 U1 核心暴露为应用层可调的 `verify_topology` 命令（仅此，不碰 sidecar validate，见 KTD4）。
**Requirements**：R1, R4, R2/R8（透传 caliber）。
**Dependencies**：U1。
**Files**：`src-tauri/src/topology_query_command.rs`（或新建命令文件，放 `verify_topology` 命令，读库后调 U1）、`src-tauri/src/lib.rs`（`invoke_handler` 注册命令）；`#[cfg(test)]`。
**Approach**：`verify_topology(session_id)` 读 `topology_nodes`/`topology_links`、调 U1、返回 serde camelCase 的 `VerifyResult{ok, caliber, errors:[{code, messageZh, ...}]}`（与 `query_topology`/`update_node_position` 同款命令 + 读路径）。
**Patterns to follow**：`query_topology`/`update_node_position` 的 Tauri 命令与读路径。
**Test scenarios**：
- verify_topology 对已知坏拓扑返回 ok=false + errors（camelCase 字段、含 caliber="structural_only"）。
- verify_topology 对合法拓扑返回 ok=true、errors 空。
- 不存在的 session：按现有错误风格处理、不崩。
**Verification**：cargo test 全绿；命令在 lib invoke_handler 中注册。

### U3. 确认过关闸接入（只 gate topology 阶段，不破坏现有确认/carry-intent）
**Goal**：在确认拓扑阶段时先验、不过关则不推进并回显结论；其它阶段确认与 carry-intent 行为完全不变。
**Requirements**：R1, R3, R4。
**Dependencies**：U2。
**Files**：`src/agent/agent-adapter.ts`（`runTsnAgent` 的 `action==="confirm-stage"` 分支加 topology gate）、`src/agent/agent-adapter.test.ts`。可能 `src/agent/agent-types.ts`（结果里带 verify 结论字段，若需要结构化回显）。
**Approach**：在调用 `runConfirmAction(workflow)` 前判断闸条件（见 KTD3）：`action==="confirm-stage" && workflow.currentStep==="topology" && !workflow.pendingStageChange`（只拦前进确认，回退确认不验）。命中 → `await invoke("verify_topology", {sessionId})`，**整段包在本分支的 try/catch 内（fail-closed）**：
- `ok=false`：返回不推进的 `TsnAgentResult`——workflow 原样、`assistantText` = 一句话结论 + 问题清单（中文，标"仅结构级"），不调 `runConfirmAction`、不产 carry-intent。
- `ok=true`：走现有 `runConfirmAction`（推进 / time-sync 自动摘要 / carry-intent 全不变）；通过结论**并进** runConfirmAction 产出的推进摘要（首行追加"结构没问题（仅结构级）"），**不另发一条助手消息**。
- invoke 异常：在本分支 catch、返回不推进结果、currentStep 留 topology、专用文案（不冒泡到 App.tsx 通用 catch，避免 "继续" 卡回输入框）。
未命中闸（回退确认 / 非 topology 阶段）：直接走现有 `runConfirmAction`，零改动。
**Execution note**：先写"确认拓扑但结构不过关 → 不推进 + 回显结论"的失败测试，再接 gate。
**Patterns to follow**：现有 `runConfirmAction` 调用与 carry-intent / pendingStageChange 分支（agent-adapter.ts:99-121 与 ~249-285）；`fetchTopologySnapshot` 的 invoke 读法。
**Test scenarios**：
- Covers AE1/AE4：topology 前进确认，verify ok=false → 不推进（currentStep 仍 topology）、assistantText 含问题清单；ok=true → 推进到 time-sync、推进摘要含"结构没问题（仅结构级）"且无额外消息。
- 回归（P1 守护）：**带 pendingStageChange 的回退确认**（在 topology 或其它阶段）→ verify_topology **不被调用**、carry-intent 正常触发、回退照旧。
- 回归：time-sync 等非 topology 阶段的前进确认 → 不调 verify_topology、行为与现状一致。
- fail-closed：verify_topology invoke reject → 不推进（currentStep 留 topology）、显示专用校验失败文案、**输入框不残留 "继续"**、不复用通用 agent 失败文案。
**Verification**：vitest 全绿；坏拓扑前进确认被挡、好拓扑放行；回退确认/切阶段/既有确认测试零回归。

### U4. 一句话结论 + 口径标签的对话回显
**Goal**：把 verify 结论以"一句中文 + 口径标签 + 问题清单"呈现在对话里；通过时给简短放行语。
**Requirements**：R2, R3, R8。
**Dependencies**：U3。
**Files**：`src/app/components/chat-pane/index.tsx`（渲染 verify 结论消息 + 口径标签 chip）、`src/app/App.css`（标签样式，复用既有 chip/标签 token）、相应 `*.test.tsx`。
**Approach**：
- **拦截消息要和普通助手消息视觉区分**（否则 boss 看不出是"被拦住了"还是"在给建议"）：拦截结论不走普通 `msg-agent` 气泡的同款外观，加可见的"未通过"信号（如左侧错误色边 / 顶部"验证未通过"标题行）。需要给该消息一个可被 chat-pane 识别的标记（如结果上带结构化 verdict 或消息上一个可选 kind 字段——具体载体执行期定，但渲染必须可区分）。
- **文案是"可修复"语气、不是"出错了"**：开头不用"请求失败/出错"，用"拓扑还差一点"一类；问题清单后**必须**带可操作引导句"请修改拓扑后再次点「确认并继续」"（R3）。问题清单逐条列出，原始细节可收进可展开处。
- **口径 chip 内联定位**：与结论首句内联、放句末括号内（"…（仅结构级）"），不单独占行；用带底色小标签（如 `<span class="caliber-chip">`）。structural_only → "仅结构级"，为第二批 loadability_only 预留。
- **通过结论并进推进摘要**（U3 已定）：不另发消息；通过文案"结构没问题（仅结构级）"作为推进摘要首行，chip 同款内联。
- 文案全程直白中文（boss 看不懂术语）。
**Patterns to follow**：现有 chat-pane 助手消息渲染、`.stage-confirmation`/`.tool-call-card` 的色边与标签 CSS（PR #34 改过确认区）；既有 chip token。
**Test scenarios**：
- 不过关结论渲染：出现一句话结论 + 内联"仅结构级"chip + 问题清单条目 + 可操作引导句；且容器与普通 `msg-agent` 视觉可区分（带未通过信号）。
- 通过结论渲染：推进摘要含"结构没问题（仅结构级）"，不出现脱离标签的裸"绿勾"（Covers AE5），且无额外独立消息。
- 多条问题时逐条列出、可读。
- 文案不含"失败/出错"等系统故障措辞（与 agent 运行失败消息区分）。
**Verification**：vitest 全绿；真机：坏拓扑确认被拦、消息明显是"待修"而非报错、文案可读；好拓扑确认放行并进入时间同步。

---

## Scope Boundaries

**本批做**：U1-U4 = 本地结构+MAC 确定性校验、verify_topology 命令、确认过关闸（仅 topology 阶段的前进确认）、一句话结论+口径标签。对应 R1-R8、AE1-AE5。（AE6-AE8 属第二批 INET 验证，见 Deferred。）

### Deferred to Follow-Up Work（第二批：接 INET，本计划不展开）
- **R9 序列化 inet-bundle**（network.ned + omnetpp.ini + manifest，schema tsn-agent.export-manifest.v0）。
- **R10 节点类型→INET 模块映射**（交换机→TsnSwitch、端系统→TsnDevice，命名 sw{N}/es{sw}_{n}）。
- **R11 远端加载 smoke**（发到 boss 的远端 INET 跑 `inet -u Cmdenv -f omnetpp.ini -n .`，口径 loadability_only）。
- **R12 转发表对账**（INET 自生成 FDB vs 我方 BFS 逐条 diff）。
- **R13 阶段无关验证通道**（/verify/inet 供后续阶段复用）。
- **统一 agent 的 validate 工具口径**：让 agent 的 `topology.validate`（带 topology 参数那条分支）也走完整结构+MAC 校验、与过关闸一致；本批不做（见 KTD4：当前升级无参分支对 agent 无效且有响应壳兼容风险）。
- **衔接点**：本批的 `VerifyResult{ok,caliber,errors}` 结论形状与 caliber 枚举为第二批预留；`topology_verify.rs` 的邻接/BFS 算法可供第二批序列化与对账复用（代码层面各自实现、共享测试 fixture 保一致）。

### 明确不做（非目标）
- MAC 表落库或外发（现算即弃；规划阶段开启后再发规划器——属更后续）。
- 更高级别验证（gPTP/TAS/GCL/可调度性）——`schedulability` 标签占位、本计划不实现。
- 不在桌面应用内打包 INET/OMNeT++。
- 单路径不双轨：不保留旧 `validate` 的"仅 dangling"行为作并行分支（直接升级为完整校验）。

---

## System-Wide Impact

- **确认流程**：gate 插在 `runTsnAgent` 确认分支，只影响 topology 阶段的**前进确认**（`!pendingStageChange`）；回退确认、time-sync/flow 确认、carry-intent、request_stage_change（PR #26/#34）零回归——U3 测试显式守护（含"回退确认不被验"用例）。
- **agent 的 validate 工具**：本批不动（见 KTD4），行为不变。
- **断网/无 INET**：本批纯本地，断网完全可用。

---

## Risks & Dependencies

- **R-改到确认流程**（高关注）：confirm 分支刚被 PR #26/#34 改过（切阶段意图/carry-intent）。缓解：gate 严格限定 `currentStep==="topology"` 且只在 ok=false 时短路；U3 专门加 carry-intent / 非 topology 阶段不回归的测试。
- **R-两份 BFS 漂移**：U1 的可达校验与 `build_legacy_mac_forwarding_table` 各自实现（DB 行 vs 内存拓扑，无法共用函数）。缓解（KTD2 已定）：一份共享测试 fixture 同时喂两条 BFS、断言可达判定一致——这是必做测试（U1 已列），不是可选。
- **R-误判拦截**：结构规则过严会把合法拓扑误拦。缓解：规则集起步保守（只挡明确错误：悬空/孤立/不可达/成环/重复），可扩展清单留余地；合法拓扑放行测试覆盖。
- **依赖顺序**：U1 → U2 → U3 → U4 线性。

---

## Open Questions（执行期定）

- `node_type === "server"` 在结构校验里是否合法（按 `topology_compute.rs` 既有口径确认；初判：允许但非交换机/端系统的常规角色）——执行期确认。
- 拦截消息的"可区分"载体（结果带结构化 verdict 字段 vs 消息上加 kind 标记）——执行期选其一，渲染须可区分（U4 已定要求）。
- 错误清单的最终错误码与中文文案措辞——执行期细化（起步集见 U1/U4 测试场景）。

---

## Sources & Research

- 源需求：`docs/brainstorms/2026-06-17-topology-stage-verification-requirements.md`（R1-R8、AE1-AE5、范围边界）。
- 确认流程现状：`src/agent/agent-adapter.ts`（runTsnAgent confirm-stage 分支 + runConfirmAction + carry-intent）、`src/project/project-state.ts`（confirmCurrentStage / pendingStageChange）、`src/app/components/chat-pane/index.tsx`（确认区，PR #34）。
- 校验落点：`src-tauri/src/topology_sidecar_routes.rs`（现 validate 仅查节点数+悬空链路）、`src-tauri/src/topology_query_command.rs`（query_topology 读路径）、`src-tauri/src/db.rs`（topology_nodes/links sync_name 键，PR #35）。
- MAC BFS：`src-tauri/src/topology_compute.rs`（build_legacy_mac_forwarding_table / build_adjacency / find_first_egress_port）。
- 同源点子梳理：`docs/ideation/2026-06-17-topology-stage-inet-verification-ideation.html`。
