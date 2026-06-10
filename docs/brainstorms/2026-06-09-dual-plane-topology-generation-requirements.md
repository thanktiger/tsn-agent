---
date: 2026-06-09
topic: dual-plane-topology-generation
---

# dual-plane-redundant 生成逻辑（宇航双平面单跳/双跳）

## Summary

在新的 Rust 拓扑域补上被推迟的 `dual-plane-redundant` 生成逻辑（旧计划 `2026-05-29-001` 的 U2），让宇航双平面**单跳**(6 端系统 + 2 交换机)和**双跳**(4 端系统 + 4 交换机)能用**现有 dual-plane 参数**确定性落图。沿用旧计划的参数契约、校验语义与验收；不新建模板、不新增参数 schema。范围收窄到宇航最小集（`backbone=line` + `crossPlaneLinks=none` + 端系统双归属）。

---

## Problem Frame

`dual-plane-redundant` 当前是"声明但拒绝"：catalog descriptor（`src-tauri/src/topology_compute.rs:134-196`）、MCP zod（`src-node/mcp/topology-tools.ts:391-399`）、SKILL 决策树条目都已就位（旧计划 U1/U3/U6 的产物），但 `initialize_topology` 对它直接返回 `INVALID_TEMPLATE_PARAM`（`topology_compute.rs:253-285`，注释标 Phase B）。唯一缺的是生成逻辑（U2）。

旧计划 `2026-05-29-001` 是这块的权威设计（22 条需求 + 参数规则 + 8 个验收），但它写于 2026-06-03 拓扑重构之前——其 U2/U4/U5 引用的 TS 文件（`src/topology/initialize.ts`、`src/domain/topology-factory.ts`、`src/agent/fake-agent.ts`）已被那次"拓扑权威迁移到 SQLite P0 + Rust domain"的重构删除。所以本次取其**设计**、弃其**文件路径**：实现目标是 Rust 拓扑域。

宇航文档《TSN典型组网测试方案》的两个双平面拓扑完全落在现有参数表达域内（已核对）：单跳 = 1 个 switchGroup（SW1=A / SW2=B），双跳 = 2 个 group + 平面内 `line` 骨干（A: SW1→SW3 / B: SW2→SW4）。

**验收就绪性边界**：本次只解锁"拓扑可建模"（覆盖文档 8 个用例里 6 个的结构前提），不等于验收可执行。802.1AS per-node 配置、802.1Qbv 门控、802.1CB FRER 及"设备下发 json"分别落在 time-sync（当前仅本地默认摘要）/ flow-template / planning-export 阶段，后两者当前 offline（Phase B）。即文档用例在本次之后仍**不可端到端执行**，要等下发导出 + 至少一个协议层（AS per-node 是共同底座）后续落地。

---

## Requirements

**生成**
- R1. `topology.initialize` 对 `dual-plane-redundant` 不再返回 `INVALID_TEMPLATE_PARAM`；按显式 dual-plane 参数确定性生成 `IntermediateTopology`（nodes / links / ports / layout）。
- R2. 支持 `backbone.mode=line`（`withinPlane=true`）+ `crossPlaneLinks.mode=none` + 端系统主备双归属。单跳 = 1 个 switchGroup（所有端系统双归属到该 group 的 A/B 两台 switch）；双跳 = ≥2 个 group，平面内 `line` 骨干按 group 顺序级联，**端系统可分属不同 group**（这正是双跳"近端/远端"形态：近端 ES 接 g1、远端 ES 接 g2，业务流经平面内骨干跨 group）。
- R3. `backbone.mode=ring` 或 `crossPlaneLinks.mode=paired` 返回结构化"暂未实现"错误，作为防御性兜底（catalog/zod 已收窄，正常不会传入）；不静默降级、不静默成功。

**校验**（沿用旧计划 R10/R11 语义）
- R4. 校验并对违规返回可定位的结构化错误：每个 switchGroup 必须引用一台 A 平面 + 一台 B 平面 switch；端系统 `primary`/`backup` 必须跨平面（不同 plane）**且指向不同 switch**（两条接入链到同一交换机不算双归属）；端系统/交换机引用必须存在；端口容量不足；缺必填 `backbone` 或 `crossPlaneLinks`。
- R5. 确定性：相同参数得到完全相同的 nodes / links / ports / coordinates / summary。dual-plane 输入是数组+引用结构，确定性依赖**显式规范排序**：节点序 = switches（按 group、A 平面先于 B），再 end systems（按 group、再声明序）；链路序 = 接入链路 → 平面内 backbone → cross-plane。

**实现边界**
- R6. 实现落在 Rust 拓扑域（`topology_compute.rs` 及相关 sidecar），不复活旧计划已删除的 TS 路径。**复用**限于 `IntermediateTopology` 表达、`TopologyErrorOut` 错误信封、确定性契约、MAC/IP 派生 helper；端系统/group 交叉校验层与 dual-plane 端口分配（混合 接入+骨干 fan-in，generic 的定偏移端口方案不通用）是**新建**，不是套用 generic 生成器。
- R7. SKILL 决策树解禁 `dual-plane-redundant`：仅两处改动——删"暂不可选"措辞 + 加一行"宇航双平面单跳/双跳 → dual-plane-redundant"场景映射；不写 `switches`/`endSystems` 字段说明（合法域仍以 `describe_templates` 为准）。catalog descriptor 与 MCP zod **收窄到本次实现的合法域**：`backbone.mode` 仅 `line`、`crossPlaneLinks.mode` 仅 `none`、`backbone.withinPlane` 固定 `true`；`ring`/`paired` 待后续实现时再 re-advertise。`switches[].role` 与 `allocation` 块为可选、生成器用确定性默认（first-free 端口 + grid 布局），本次不要求调用方传、descriptor 不强制列。

---

## Key Decisions

- KD1. 沿用 `2026-05-29-001` 的参数契约与语义（双平面≠双归属；显式 `switches`/`switchGroups`/`endSystems`；不接收 `endSystemsPerSwitch`）。本文档不重新设计参数。
- KD2. 范围收窄到宇航最小集（`line` + `none`），并**让 advertise 的合法域与实现一致**：descriptor + zod 收窄到 `line`/`none`/`withinPlane:true`，`ring`/`paired` 不再 advertise（待实现时 re-advertise）。理由：SKILL 解禁后 `describe_templates` 是 agent 的合法域权威，若仍 advertise ring/paired 会诱导 agent 生成后撞运行时拒绝——advertise 只暴露已实现能力才是诚实契约。initialize 仍保留对 ring/paired 的结构化拒绝作防御兜底。
- KD3. 实现目标为 Rust 拓扑域；旧计划的 TS 文件路径已失效，ce-plan 据此重新定位。
- KD4. 显示名沿用现有 numericId 派生约定（UI 渲染 `SW-N`/`ES-N`，来自 `sync_name`）。**不**追求文档的 E1-E6/SW1-SW2 字面名——`initialize` 的 P0 持久化（`persist_initialized_topology` 写 `sync_name=numeric_id`、丢弃 `name`）不支持显式名 round-trip，硬上需改 P0 schema（架构改动），超本次范围。文档命名只是测试方案的标签，不要求 app 复刻。

---

## Acceptance Examples

- AE1. **单跳。** 1 个 switchGroup（SW1=A、SW2=B）、6 个端系统各双归属到 SW1/SW2、`backbone=line`、`crossPlaneLinks=none` → 生成 8 个节点（2 个交换机 + 6 个端系统）+ 每个 ES 两条接入链路（主接 SW1、备接 SW2），`withinPlane=true` 单 group 下无 backbone 链路；重复运行结果相等。
- AE2. **双跳。** 2 个 switchGroup（g1: SW1/SW2、g2: SW3/SW4）、4 个端系统**分属不同 group**（E1/E2 接 g1，E3/E4 接 g2，各自双归属本 group 的 A/B）、`backbone=line within-plane` → 平面 A 生成 SW1→SW3 骨干、平面 B 生成 SW2→SW4 骨干；断言存在跨 group 路径（E1 端口 → SW1→SW3 → E3 端口，平面 B 对称）。节点/链路数量稳定、端口无冲突、结果可重复。
- AE3. 端系统 `primary` 与 `backup` 指向同一平面（或同一 switch）→ 结构化错误（双归属未跨故障域）。
- AE4. `backbone=ring` 或 `crossPlaneLinks=paired`（绕过收窄后的 catalog 直接构造）→ 结构化"暂未实现"错误，不生成拓扑。
- AE5. switchGroup 只引用一个平面 / 端系统引用不存在的 switchId / 缺 `backbone` 或 `crossPlaneLinks` → 各自返回可定位的结构化错误。

---

## Scope Boundaries

### 范围内
- aerospace-minimal dual-plane 生成（`line` + `none` + 双归属）+ 输入交叉校验 + dual-plane 端口分配 + SKILL 决策树解禁 + descriptor/zod 收窄到已实现合法域。

### Deferred for later
- `backbone=ring` 骨干、`crossPlaneLinks=paired` 跨平面桥接（旧计划 P0 含，本次推迟；实现时需 re-advertise descriptor/zod）。**前向注记**：后续 802.1CB FRER 落地前需确认其是否依赖 cross-plane `paired` 链路，还是 `none`+双归属即可——若依赖 `paired`，会 re-open 本生成逻辑。
- `attachmentPlan` / `endSystemsPerGroup` 压缩展开参数（旧计划 R12/KD5 已列后续）。
- 工业/车载/电力等场景级 dual-plane 参数预设。
- 相比旧计划 `2026-05-29-001` 的 AE1-9，本文档收窄后只列核心 5 例（aerospace-minimal 相关）；AE6-9 涉及的 `paired`/`topologyFullAllowed`/旧模板移除等不在本次范围。

### 本次不做
- 802.1AS per-node 同步配置、802.1Qbv 门控调度、802.1CB FRER、5 跳线性 ends-only 形态（ideation `2026-06-09-aerospace-topology-support` 的 idea 3/4/5/2，各自独立推进）。
- offset / jitter / 丢包等验收指标测量。

### Outside this product's identity
- 本软件 = TSN 控制器（规划 + 配置 + 监控）；offset/jitter/丢包由 T10 测试仪测量，不并入本软件。

---

## Dependencies / Assumptions

- 依赖现有 descriptor（`topology_compute.rs:134-196`）、MCP zod（`topology-tools.ts:391-399`）、`IntermediateTopology` 表达保持不变。
- 假设宇航文档两拓扑用现有 dual-plane 参数可完整表达（已核：单跳=1 组、双跳=2 组 + line backbone）。
- 旧计划 `2026-05-29-001` 仍标 `status: active`，但其 U2/U4/U5 的 TS 文件路径已被 2026-06-03 重构废弃；本文档取其设计、弃其文件路径。ce-plan 应据当前 Rust 架构重新定位实施单元。

---

## Sources / Research

- `docs/plans/2026-05-29-001-feat-dual-plane-topology-template-plan.md` — 设计源（参数规则 `DualPlaneRedundantParams`、校验语义、AE1-9）。
- `docs/brainstorms/2026-05-27-tsn-topology-mcp-requirements.md` — 上游需求。
- `docs/prototypes/TSN典型组网测试方案_20260527.docx` — 宇航验收场景（单跳 6+2 / 双跳 4+4）。
- `docs/ideation/2026-06-09-aerospace-topology-support-ideation.md` — idea 1 种子 + 全景差距表。
- `src-tauri/src/topology_compute.rs:134-196`（descriptor）、`:253-285`（initialize + dual-plane 拒绝分支）、`generic_distributed_params` / 现有 generic 生成路径。
- `src-node/mcp/topology-tools.ts:391-399`（zod union，含 dualPlaneParamsSchema）。
- `.claude/skills/tsn-topology/SKILL.md` — 决策树与 dual-plane 条目（待解禁）。
