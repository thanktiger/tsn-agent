---
date: 2026-06-09
topic: aerospace-topology-support
focus: 支持《TSN典型组网测试方案_20260527》的宇航双平面/线性组网验收场景
mode: repo-grounded
---

# Ideation: 支持宇航 TSN 验收场景（双平面 + 线性 + AS/Qbv/CB）

## Grounding Context

### 文档（`docs/prototypes/TSN典型组网测试方案_20260527.docx`）
给"宇航行情"客户的 TSN 系统级验收方案。3 种拓扑 × 3 个协议 × 8 个用例：

- **双平面单跳网络**：6 端系统（E1-E6）+ 2 交换机（SW1=平面A / SW2=平面B），端系统双归属接入，A 主路径 / B 冗余路径物理隔离。
- **双平面双跳网络**：4 端系统（E1-E4）+ 4 交换机，平面 A：E1→SW1→SW3→E3，平面 B：E1→SW2→SW4→E3。
- **5 跳线性网络**：2 端系统（E1、E2）+ 5 交换机级联（E1→SW1…SW5→E2），端系统**只在两端**。
- 协议：**802.1AS** 时间同步（指定 GM 节点、同步周期 2^-3s、链路测量 500ms、offset<阈值）；**802.1Qbv** 门控调度/TAS（ST 流五元组、每端口门控窗口如 [32us,64us]、零丢包、抖动<1us）；**802.1CB** FRER（RC 流、R-TAG、源端复制/目的端消除、双平面端口对 P0/P1）。
- **职责边界（关键）**：文档里"TSN规划管理控制软件（TSN控制器）"负责*规划+配置+生成下发 json+监控*；offset/jitter/丢包等"通过标准"由 **T10 测试仪**（陪测设备）测量。本项目对标控制器，不做测量。

### Codebase Context（当前能力）
- 拓扑模板 catalog 声明 3 个：`generic-line`、`generic-ring`、`dual-plane-redundant`（`src-tauri/src/topology_compute.rs:92-196`）。
- **`generic-line` / `generic-ring` 已实现**；参数 `switchCount`(1-12) / `endSystemsPerSwitch`(1-24) / `dataRateMbps`{10,100,1000,10000}（`generic_distributed_params` :198-216）。
- **`dual-plane-redundant` 是"声明但拒绝"**：`describe_templates` 列出它、descriptor 参数完整（planes/switches/switchGroups/endSystems/backbone/crossPlaneLinks，:134-196），MCP zod `dualPlaneParamsSchema` 已在 union 校验（`src-node/mcp/topology-tools.ts:391-399`），SKILL 决策树已有条目——但 `initialize_topology` 对它直接返回 `INVALID_TEMPLATE_PARAM`（`topology_compute.rs:274-285`，注释："dual-plane 参数校验+拓扑生成 ≥600 LOC，Phase B 回归"）。
- 工作流阶段：topology → time-sync → flow-template → planning-export。**time-sync = 本地默认摘要**（`agent-adapter.ts runTimeSyncStage`，仅 summary，无 per-node 配置）；**flow-template + planning-export = 暂下线（Phase B banner）**。
- SKILL 事实源：单一可编辑 `SKILL.md`（PR #21）承载领域语义/推荐默认/场景→模板决策树；**参数合法域以 `describe_templates` 返回为准，SKILL 不复述**。

## Topic Axes
- 拓扑模板生成（dual-plane 单跳/双跳；线性 5 跳的精确形态）
- 802.1AS 时间同步配置（per-node GM/slave + 同步/链路测量周期）
- 802.1Qbv 门控调度（ST 流 + 每端口门控窗口）
- 802.1CB 冗余传输 FRER（RC 流 + R-TAG + 复制/消除 + 双平面端口对）
- 下发配置生成 + 校验/指引承载（下发 json、describe_templates 合法域、SKILL 场景映射）

## 文档要求 × 当前支持 对比（差距表）

| 方案要素 | 文档要求 | 当前项目 | 差距 |
|---|---|---|---|
| 线性拓扑 | 5 跳线性，端系统仅在两端 | `generic-line` ✓（每台 SW 挂 M 端系统） | **小**：表达不了"只首尾挂 ES"，需 placement 参数或 init 后 apply_operations 删中间 ES |
| 环形拓扑 | 文档未要求 | `generic-ring` ✓ | 无 |
| 双平面单跳 | 6 ES + 2 SW，A/B，ES 双归属 | descriptor+zod+SKILL 齐全，**生成未实现**（init 拒绝） | **大**：~600 LOC 生成逻辑 |
| 双平面双跳 | 4 ES + 4 SW，平面内 SW1→SW3 / SW2→SW4 | 同上；descriptor `backbone:line within-plane`+多 group 已能表达 | **大**：与单跳同一阻塞点，非新模板 |
| 802.1AS | 指定 GM + 同步周期 2^-3s + 链路测量 500ms | time-sync 仅默认摘要 | **中**：per-node 角色 + 同步参数未建模 |
| 802.1Qbv | ST 流五元组 + 每端口门控窗口 | flow-template 暂下线 | **大**：门控调度未实现（Phase B 核心） |
| 802.1CB | RC 流 + R-TAG + 复制/消除 + 端口对 | 无 | **大**：FRER 完全缺失（依赖双平面+流建模） |
| 下发 json 配置 | 设备下发 json | planning-export 暂下线 | **大**：导出未实现（Phase B 核心） |
| 验收指标测量 | offset/jitter/丢包 | 不在本软件职责 | **范围澄清**：控制器≠测试仪，本项目不做测量 |

**总判断**：完整覆盖该文档 ≈ 实现 dual-plane 生成 + 把 Phase B（flow-template + planning-export）做出来 + 新增 802.1CB 层 + 把 time-sync 从默认升级为可配置。其中 **dual-plane 生成是最便宜、杠杆最高、纯增量（骨架已就位）的第一步**。

## Ranked Ideas

### 1. 实现 `dual-plane-redundant` 生成逻辑（解锁单跳 + 双跳）
**Description:** 在 topology domain（sidecar/Rust）实现 dual-plane 的 params→nodes/links 生成 + 校验，移除 `initialize_topology` 的拒绝分支，SKILL 决策树解禁该模板。单跳（1 个 switchGroup）与双跳（2 个 group + `backbone:line within-plane`）用**同一套参数**表达，无需新模板。
**Axis:** 拓扑模板生成
**Basis:** `direct:` `topology_compute.rs:274-285` 拒绝分支 + `:134-196` 完整 descriptor/example + `topology-tools.ts:391-399` zod 已校验 dual-plane。文档双平面单跳=6ES+2SW（1 group）、双跳=4ES+4SW（2 group + 平面内级联）正好落在 descriptor 表达域内。
**Rationale:** 这是宇航两个双平面拓扑（占 8 用例中 6 个）的唯一结构性阻塞；scaffolding 已花过钱，回报最高。
**Downsides:** ~600 LOC；端口分配 / 跨平面 paired / backbone ring 的边界用例多，校验需扎实；与现有 generic 生成路径要复用 intermediate topology 表达。
**Confidence:** 90%　**Complexity:** High　**Status:** Explored

### 2. 线性 5 跳的"端系统仅在两端"形态
**Description:** `generic-line` 当前给每台交换机挂 `endSystemsPerSwitch` 个端系统，表达不了文档的"E1 在 SW1、E2 在 SW5、中间无 ES"。两条路：给 generic-line 加 `endSystemPlacement: ends-only | per-switch` 参数（合法域进 describe_templates + zod + Rust），或 init 后用 `apply_operations` 删中间 ES。
**Axis:** 拓扑模板生成
**Basis:** `direct:` `generic_distributed_params` 只有 switchCount/endSystemsPerSwitch（`topology_compute.rs:198-216`）；文档线性拓扑 ES 仅首尾。
**Rationale:** 5 跳线性是低成本就能精确支持的用例；门控/同步测试对 ES 落点敏感。
**Downsides:** 加参数会扩 generic-line 合法域，要守 catalog/zod/Rust 三处一致（已有 drift 测试约定）；apply_operations 兜底则把形态责任推给 agent。
**Confidence:** 70%　**Complexity:** Low-Medium　**Status:** Unexplored

### 3. 802.1AS：per-node 同步角色 + 同步参数建模
**Description:** 把 time-sync 阶段从"默认摘要"升级为可配置：指定 GM 节点、其余为 Slave、`syncInterval`(2^-3s)、`linkMeasInterval`(500ms)，并能在监控里看 offset（数据来自外部测量/设备上报，不在本软件算）。
**Axis:** 802.1AS 时间同步
**Basis:** `direct:` 文档 4.x.1 测试步骤（GM 指定 + 周期参数）；当前 `runTimeSyncStage` 仅产 summary 字符串。
**Rationale:** AS 是 3 个协议里每个用例都要配的基础层；GM 指定是双平面/线性都需要的最小配置。
**Downsides:** 需要 per-node 角色的存储与 UI；与现有"time-sync 走本地默认推进"的简化路径冲突，要决定是否引入 MCP/domain 配置面。
**Confidence:** 75%　**Complexity:** Medium　**Status:** Unexplored

### 4. 802.1Qbv 门控调度配置（复活 flow-template）
**Description:** Phase B flow-template 的核心：建模 ST 流（五元组 + 周期）+ 每端口门控窗口列表（如 E6/SW1 输出口 [32us,64us]/[64us,96us]）。这是文档 4.x.2 全部 Qbv 用例的配置面。
**Axis:** 802.1Qbv 门控调度
**Basis:** `direct:` 文档各 4.x.2（门控窗口、五元组、1ms 周期、512B、10000 帧）；flow-template 阶段当前 Phase B 暂下线。
**Rationale:** 没有门控配置就无法生成 Qbv 下发，宇航验收的"确定性时延"维度全靠它。
**Downsides:** 门控窗口与拓扑路径耦合（每跳端口都要排程）；属于 Phase B 大件，需先有路径/流的数据模型。
**Confidence:** 70%　**Complexity:** High　**Status:** Unexplored

### 5. 802.1CB FRER 配置（RC 流 + R-TAG + 复制/消除 + 端口对）
**Description:** 建模 RC 流的源端帧复制（P0/P1 注入 A/B 平面）与目的端帧消除（R-TAG 识别去重），生成 CB 下发配置。强依赖 idea 1（双平面）+ 流建模（idea 4 的数据模型）。
**Axis:** 802.1CB 冗余传输
**Basis:** `direct:` 文档各 4.x.3（帧复制/消除、R-TAG、单链路故障零丢包）。
**Rationale:** CB 是双平面"高可靠性"卖点的落地，是宇航场景区别于普通线性网的核心价值。
**Downsides:** 依赖链最长（双平面+流都要先有）；R-TAG/端口对语义需新 domain 概念；优先级应在 1/4 之后。
**Confidence:** 65%　**Complexity:** High　**Status:** Unexplored

### 6. 下发 json 配置导出（复活 planning-export）
**Description:** Phase B planning-export 的核心：把拓扑 + AS + Qbv + CB 配置汇总成"设备下发 json"，对齐文档对控制器软件的职责描述。
**Axis:** 下发配置生成 + 校验/指引
**Basis:** `direct:` 文档软件职责"自动生成…用于设备下发的 json 配置文件"；planning-export 当前暂下线。
**Rationale:** 没有下发产物，前面所有配置只是 UI 状态；这是控制器对外交付物。
**Downsides:** 下发 json schema 需对齐真实设备（外部契约，风险点）；要等 AS/Qbv/CB 模型稳定。
**Confidence:** 70%　**Complexity:** Medium-High　**Status:** Unexplored

### 7. 职责边界澄清 + 宇航场景→模板映射写进 SKILL（直接回答"是否加 reference / MCP 校验"）
**Description:** 不单开 skill reference 文件——保持单一 `SKILL.md` 事实源（PR #21）。改动：①决策树解禁 `dual-plane-redundant`、加"宇航双平面验收（单跳/双跳）→ dual-plane-redundant"、"5 跳线性级联 → generic-line + ends-only"映射；②参数合法域仍以 `describe_templates` 为准，SKILL 不复述；③新协议（Qbv/CB/AS per-node）的参数校验加在 **MCP zod + Rust domain**（与现有 dual-plane scaffolding 同位置），不进 SKILL；④在 SKILL/文档明确"本软件=控制器（规划+配置+监控），offset/jitter/丢包由 T10 测试仪测量"。
**Axis:** 下发配置生成 + 校验/指引
**Basis:** `direct:` SKILL.md 单文件 + "合法域以 describe_templates 为准"约定（`SKILL.md:12,49`）；dual-plane zod 已在 `topology-tools.ts` union；文档软件清单区分控制器与测试仪。
**Rationale:** 直接回答用户问题：校验属于 MCP/domain 层（已有先例），SKILL 只承载场景→模板指引；分清职责避免把"测量"误纳入范围、避免重蹈多文件 skill。
**Downsides:** 几乎纯指引/文档改动，本身不产生能力——必须配合 idea 1 才有意义（解禁了却没实现生成会误导 agent）。
**Confidence:** 85%　**Complexity:** Low　**Status:** Unexplored

## 建议优先级（不是承诺，供排期参考）
1（dual-plane 生成）→ 7（SKILL 解禁+边界，与 1 同 PR）→ 2（线性 ends-only）→ 3（AS per-node）→ 4（Qbv flow）→ 6（下发导出）→ 5（CB，依赖最重）。前三项是"宇航拓扑可建模"的最小集；4/5/6 是 Phase B 协议配置大件。

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | 为单跳/双跳各建独立模板 | descriptor 已能参数化表达两者；独立模板违背现有单一 dual-plane 设计、会膨胀 |
| 2 | 在 app 内集成测量 offset/jitter/丢包 | 超范围：测量是 T10 测试仪职责，文档明确控制器≠测试仪 |
| 3 | 自动编排跑完整 8 用例验收 | 依赖测试仪硬件+测量；超本软件范围（可作远期"验收用例模板"，非当前） |
| 4 | 为宇航 fork 一套独立 skill / reference 文件 | 与可编辑单一 SKILL.md 事实源（PR #21）冲突；决策树映射即可 |
| 5 | 在 SKILL 里复述 dual-plane 参数合法域 | 违背"合法域以 describe_templates 为准"约定；双硬编码会 drift |
