---
date: 2026-06-10
topic: topology-canvas-layout
focus: 诊断双平面拓扑在 React Flow 画布上的可读性（生成坐标 + 渲染逻辑），对标规范文档三张参考图
mode: repo-grounded
---

# Ideation: 双平面拓扑画布布局可读性

## Grounding Context

### 诊断结论（现状 vs 规范图）

| 层 | 问题 | 位置 |
|---|---|---|
| Rust 坐标生成 | 全部 ES 挤单行 `y=-60`，70px 间距 < 节点实宽（CSS min 96 / max 126px）→ 必然重叠 | `src-tauri/src/topology_compute.rs:1062-1065` |
| Rust 坐标生成 | 单跳/双跳共用「平面A y=120 / 平面B y=320」一个公式；规范图单跳是 SW1/SW2 同行居中、ES 上下两行夹住 | `topology_compute.rs:1033` |
| 前端渲染 | edges 不设 `type` → 默认 bezier；每节点仅 1 个 target handle(Left) + 1 个 source handle(Right)，纵向关系被迫左右绕弧 | `src/app/components/workspace-pane/index.tsx:216-220, 248-249` |
| 数据面 | 平面归属（A/B）生成时存在但不落库；端口号已落库（links stylesJson 的 leftLabel/rightLabel = 两端 port_id，`topology_sidecar_routes.rs:299-301`）但前端零消费 | — |
| 语义缺口 | 规范图含 TSN 控制器节点，当前生成没有 | — |

### 硬约束（来自既有 plans/memory）
- 坐标唯一权威 = Rust 生成端；链路 生成→persist(P0)→query_topology→React Flow 直接吃 DB x/y；前端零布局逻辑。
- 节点生成/排序顺序 = imac 身份源，不可改（KTD3）；同参数两次生成坐标全等（确定性测试现成，`topology_compute.rs:2707`）；无两节点同坐标；坐标须整数可表示（persist `.round() as i64`）；禁随机/迭代收敛布局。
- agent 经 MCP inspect 读 DB 坐标做空间认知——前端-only 布局会让 agent 视角与画布分叉（架构变更需确认）。MAX_NODES=200。
- 旧 plan `docs/plans/2026-05-29-001` 的 dual-plane-grid 原设计（ES 放对应 group 外侧/中间轨道）实现时被简化掉，可回采。

### 外部研究
- 零依赖路径：服务端 ES 分上/下行；edge type 换 straight/smoothstep + 平面配色（AFDX/ARINC 664 业界惯例：Network A=蓝、B=红）；平行边 `getSmoothStepPath(offset)` 错开。
- 重依赖路径：elkjs(~1.5MB) layered + ORTHOGONAL + FIXED_SIDES 全自动正交布局；dagre 无 edge routing；d3-hierarchy 不支持双归属。模板拓扑层级先验已知，通用布局库是为不存在的问题付依赖与非确定性风险（Graphviz dot→xdot 先例支持「布局即生成端编译产物」形态）。

## Topic Axes
1. 坐标生成算法（Rust 端：ES 上下分行、SW 平面行、间距/重叠）
2. 连线渲染（edge 类型、平面配色、平行边偏移、交叉最小化）
3. 节点与端口呈现（handle 位置/数量、P0/P1 端口标注、节点尺寸）
4. 布局责任架构（Rust 坐标权威 vs 前端 layout pass、agent inspect 一致性）
5. 画布辅助语义（平面图例、TSN 控制器节点、与规范图视觉对齐）

## Ranked Ideas

### 1. ES 三明治分行 + 按组数分支布局形态
**Description:** Rust 端把 ES 确定性拆上/下两行夹住 SW；按 `switch_groups.len()` 分支——单跳（1 组）SW1/SW2 同行居中复刻规范图一，双跳（多组）两平面各一行、ES 分布两侧。间距常量改为「节点宽+留白」（≥180px），组列宽由行内 ES 数反推。纯整数算术，节点序不动。
**Axis:** 1 坐标生成算法
**Basis:** `direct:` `topology_compute.rs:1062-1065` ES 坐标单行硬编码 `y=-60` + 70px 间距；规范文档单跳/双跳本就是两套投影。
**Rationale:** ES 单行置顶是与规范图差距的第一根源；分行后接入边从「全跨层」变「就近向内」，交叉数自然减半。
**Downsides:** 分行规则（奇偶/对半/按平面）是要进确定性测试的契约，需定夺；双跳的 ES 左右分布形态与单跳上下分布并存，同模板两种视觉形态。
**Confidence:** 90%　**Complexity:** Medium　**Status:** Explored

### 2. 连线语义化：plane 落库 + 直线化 + A蓝B红
**Description:** 生成端往已有 stylesJson 写 `plane:"A"|"B"` + `role:"access"|"backbone"`（链路构造处零成本可得）；前端 edge 换 smoothstep/straight，按 AFDX 惯例 A=蓝 B=红 染色；同节点对 primary/backup 平行边用 `getSmoothStepPath(offset)` 按 linkSeq 确定性错开。零新依赖。
**Axis:** 2 连线渲染
**Basis:** `direct:` stylesJson 通道已存在且已承载 leftLabel/rightLabel（`topology_sidecar_routes.rs:299-301`）；`external:` AFDX/ARINC 664 Network A 蓝 / B 红业界惯例。
**Rationale:** 「两套独立冗余网络」是 dual-plane 核心语义，当前画布完全不可见；配色+直线是 operator 一眼验证双归属的最低成本手段。
**Downsides:** stylesJson 从自由样式袋变成有约定字段的语义契约，需明确归生成端所有；旧数据缺 plane 字段需回退色。
**Confidence:** 85%　**Complexity:** Low-Medium　**Status:** Explored

### 3. 四向 handle 几何选边 + 端口号 P0/P1 上画布
**Description:** 节点加 Top/Bottom handle，前端按 src/dst 的 DB 坐标相对方位（纯函数）选 sourceHandle/targetHandle——上下分行后 ES↔SW 走垂直短边。端口号已在 stylesJson（leftLabel/rightLabel），用 EdgeLabelRenderer 渲染在边两端，复刻规范图「P0/P1 标在节点边」。零 Rust 改动。注：生成端 p1 起始 vs 规范 P0 起始的命名统一顺带处理。
**Axis:** 3 节点与端口呈现
**Basis:** `direct:` `workspace-pane/index.tsx:248-249` 仅左右单 handle；端口数据已落库前端零消费（本轮已验证）。
**Rationale:** 不做这步，坐标修好后 ES→SW 垂直边仍从左右绕 U 形弯，坐标收益被 handle 约束吃掉一半；端口标注是规范图三要素中纯缺失的一个。
**Downsides:** 端口 label 密度（8节点14链路28标签）可能需按缩放显隐；handle 选择函数成为前端唯一一段几何逻辑，依赖 idea 4 的契约划界。
**Confidence:** 85%　**Complexity:** Low　**Status:** Explored

### 4. 渲染自由度契约 + Rust 布局质量门
**Description:** 写明契约：节点 x/y = Rust/DB 权威（agent 可见）；边路由/handle 选择/配色 = 前端对 DB 坐标的确定性纯函数（agent 不依赖）。同时把「无两节点同坐标」升级为 AABB 包围盒不相交断言 + 规范图结构断言（行序/平面分行），挂进现有确定性测试套件。
**Axis:** 4 布局责任架构
**Basis:** `reasoned:` 点级唯一挡不住 69px 错位的视觉重叠——70px < 96px 节点宽穿过了全部既有测试，护栏存在结构性盲区；布局权威在 Rust 端，质量门也必须在 Rust 端。
**Rationale:** 一次划界解锁全部渲染层迭代；测试升级让可读性回归死在 `cargo test` 而非真机截图。
**Downsides:** 节点宽高常量成为 Rust-前端跨层契约，事实源放哪侧需定一次。
**Confidence:** 80%　**Complexity:** Low-Medium　**Status:** Unexplored

### 5. 平面泳道背景带 + 图例 + 节点平面徽标
**Description:** SW 行背后铺半透明色带（A 蓝带/B 红带）+ React Flow Panel 固定图例（平面配色、SW/ES 符号说明）；节点卡片加平面徽标。纯前端展示层，零依赖。
**Axis:** 5 画布辅助语义
**Basis:** `external:` Cisco NeXt UI 分层泳道；电力单线图/航电配线图把图例当图纸法定组成部分。
**Rationale:** 配色解决「线属于谁」，泳道解决「区域属于谁」；图例是领域工程师判断「图可不可信」的门槛信号。
**Downsides:** 色带 y 范围契约（硬编码常量 vs 从坐标包络推导）要定一个不脆的方案。
**Confidence:** 70%　**Complexity:** Low　**Status:** Unexplored

### 6. TSN 控制器节点入图（决策点登记）
**Description:** 规范图一中 TSN 控制器独立挂 SW1，是图的语义锚点；当前生成完全没有。方案 A：生成端在节点序列末尾 append 控制器节点+管理链路（不扰动既有 imac 前缀序，属功能新增需 boss 授权）；方案 B：仅图例标注「本拓扑不含控制器」。
**Axis:** 5 画布辅助语义
**Basis:** `direct:` 规范图「TSN 控制器独立挂 SW1」 vs 生成事实「不含控制器节点」。
**Rationale:** 控制器是验收者对照规范图第一眼找的元素，布局调到完美也消不掉这个差异项。
**Downsides:** 触碰节点集与 imac 序边界 + 新 node_type 建模（新类型 vs 复用 ES）+ 统计口径，必须先拍板。
**Confidence:** 75%　**Complexity:** Medium　**Status:** Rejected（boss 拍板：不需要控制器节点入图）

### 7. generic-ring 顺带修复
**Description:** ring 当前与 line 共用横排布局，闭环边横穿整排。趁布局分派整修给 ring 加正多边形整数坐标（或跑道双 lane：上行一排、下行一排、两端短边闭合）。
**Axis:** 1 坐标生成算法
**Basis:** `direct:` `topology_compute.rs:440-500` ring 与 line 同布局仅多一条闭环边。
**Rationale:** 这轮势必动布局分派逻辑，顺手覆盖 ring 边际成本最低；分开做要两次踩同一片确定性测试。
**Downsides:** 正多边形 cos/sin 产生分数坐标会被 persist 静默取整破坏 f64 直比前提，须用预取整的整数顶点表。
**Confidence:** 70%　**Complexity:** Medium　**Status:** Unexplored

**自然组合**：1+2+3 是「对标规范图最小集」（已选定进 brainstorm）；4 是它们的护栏；5/6/7 为后续增量。

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | relayout 命令（存量拓扑重算落库） | 重新生成即可覆盖，现阶段存量少，性价比不足 |
| 2 | 拖拽回写 DB（nodesDraggable + onNodeDragStop mutation） | 引入「用户写坐标」数据流变更，超出本轮可读性修复必要 |
| 3 | layout descriptor 入 metadata（band 结构元数据） | 过早抽象，当前消费者只有泳道一个；Phase B 真需要时再做 |
| 4 | lane/band 独立抽象层 | 3 个模板不值一层抽象，并入 idea 1 实现注记 |
| 5 | edge 渲染策略注册表 | 2-3 种策略 if/else 够用，注册表是过度工程 |
| 6 | per-port handle（每端口一锚点） | 四向几何选边更简单、收益相近，作为 idea 3 远期变体 |
| 7 | 前缀和列宽（按 200 节点设计） | 并入 idea 1 的尺寸契约间距 |
| 8 | 引入 elkjs/dagre 前端布局库 | 模板层级先验已知，通用布局库为不存在的问题付 1.5MB 依赖+非确定性风险+agent 视角分叉 |
