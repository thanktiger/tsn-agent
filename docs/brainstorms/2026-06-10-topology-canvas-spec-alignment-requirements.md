---
date: 2026-06-10
topic: topology-canvas-spec-alignment
---

# 双平面拓扑画布对标规范图

## Summary

让双平面拓扑的 React Flow 画布复刻规范文档参考图的结构：Rust 生成端按组数分支布局（单跳三明治、双跳两平面行 + ES 左右外端）、端口 P0 起编、链路落库携带平面语义；前端改正交折线、平面 A 蓝 / B 红配色、四向 handle 就近出线、端口号标注在连线两端。

## Problem Frame

规范文档（`docs/prototypes/TSN典型组网测试方案_20260527.docx`）的参考图是验收者对照画布的标尺：单跳图为 E1-E3 / E4-E6 上下两行夹住居中的 SW1/SW2 行，双跳图为两平面 SW 各一行、ES 挂左右外端，连线清晰、端口号 P0/P1 标在节点边。当前画布与之差距来自四处：ES 全部挤在单行 `y=-60` 且 70px 间距小于节点实宽（必然重叠）；单跳/双跳共用「平面 A 行 + 平面 B 行」一个投影；前端 edge 用默认 bezier 且每节点仅左右各一个 handle（曲线绕行交叉）；平面归属不落库、端口号已落库但前端不消费。诊断详见 `docs/ideation/2026-06-10-topology-canvas-layout-ideation.md`。

---

## Key Decisions

- **布局形态按 switchGroup 数分支。** 单跳（1 组）复刻规范图一：SW1/SW2 同行居中、ES 上下两行夹住；双跳/多组复刻规范图二：两平面 SW 各一行、ES 按 group 挂左右外端。同一模板两种视觉投影是贴近规范，不是不一致——规范文档本身就是两套画法。
- **连线用 smoothstep 正交折线，不逐线复刻规范的斜直线。** 取舍：画布风格偏电路图，换更整洁的走线；同走廊重叠用确定性偏移兜底（R12）。
- **端口 P0 起编改在 Rust 生成端，不做前端显示映射。** 落库、agent inspect、画布三处天然一致，避免重蹈节点命名不一致的坑；存量数据不迁移。
- **平面语义由生成端写入链路 `stylesJson`，生成端是语义权威。** 复用既有字段（已承载 leftLabel/rightLabel 端口号），无 schema 迁移；前端只读消费。
- **前端可做的几何 = 对 DB 坐标的确定性纯函数。** handle 选边、走线偏移、配色不读写坐标，agent 经 inspect 看到的空间事实不分叉；节点 x/y 的唯一权威仍在 Rust 生成端。

---

## Requirements

**布局生成（Rust）**

- R1. 单跳（1 个 switchGroup）：平面 A/B 交换机同一行居中；端系统按组内声明序前半在上行、后半在下行，夹住交换机行。
- R2. 双跳/多组：每个平面的交换机各占一行（上下排布）；端系统按 group 挂在左右外端（按 group 声明序前半挂左、后半挂右，奇数组数时中位组归左），y 对齐其主接入（primary）交换机所在平面行；同组内主接入同平面的多台端系统按声明序沿外端向外水平堆叠，间距遵守 R3。
- R3. 任意两节点在画布上不重叠：端系统间距常量 ≥ 180px（节点最大渲染宽 126px 加留白），组列宽随行内端系统数量扩展；该常量作为 R4 确定性测试的断言依据。
- R4. 既有生成约束保持：节点生成/排序顺序不变（imac 身份源）、同参数两次生成坐标全等、坐标为整数可表示值；确定性测试扩展覆盖新布局形态。

**端口命名**

- R5. 生成端端口 id 从 P0 起编（替代 p1 起编），对所有模板统一生效（含 generic-line / generic-ring 新生成）；节点端口与链路标签两处命名点同步修改，落库的链路端口标签与之一致，generic 既有确定性测试夹具随之更新。存量链路保持既有 p1 标签，不做升级。

**链路语义（Rust → DB）**

- R6. 链路 `stylesJson` 携带平面归属（A / B / 无）与角色（接入 / 骨干）：生成端在中间拓扑链路上以可选字段携带，persist 拼装 `stylesJson` 时合并写入，其余既有字段（端口标签、速率）不变。
- R7. 平面字段缺失、值非法或 `stylesJson` 解析失败的链路一律渲染为中性色（复用现有边描边色 `#a8b0c0`），不报错、不迁移。

**画布渲染（前端）**

- R8. edge 使用 smoothstep 正交折线替代默认 bezier。
- R9. 边按平面配色：平面 A 蓝、平面 B 红（AFDX 业界惯例），使用独立 CSS token（如 `--plane-a` / `--plane-b`），不复用 `--info` / `--error` / `--accent` 等既有语义 token；中性色用于无平面归属的边。
- R10. 节点提供四向 handle，按连线两端 DB 坐标的相对方位以纯函数选择出入边：跨行（y 不同）的边一律走垂直 handle（按 Δy 符号定上/下），同行（y 相同）的边走水平 handle，避免水平段穿过节点所在行。
- R11. 端口号渲染在连线靠近两端节点处，数据来自 `stylesJson` 既有端口标签；标签贴近端点、随 R12 的偏移同步平移、不与节点框重叠（字号与密度细节留规划）。
- R12. 汇入同一 handle 的多条边以确定性偏移错开，横段不完全重叠。

---

## Acceptance Examples

- AE1. **单跳形态。** Given 双平面单跳参数（6 ES + 2 SW、1 组），When initialize 后渲染，Then SW1/SW2 同行居中，ES-1..3 在上行、ES-4..6 在下行，任意两节点无视觉重叠。**Covers R1, R3.**
- AE2. **双跳形态。** Given 双平面双跳参数（4 ES + 4 SW、2 组），When initialize 后渲染，Then 平面 A 交换机一行、平面 B 交换机一行，组 1 的 ES 在左外端、组 2 的 ES 在右外端，y 对齐各自主接入平面行；同组多台 ES 主接入同平面时沿外端水平堆叠、不重叠。**Covers R2, R3.**
- AE3. **端口标注。** Given 新生成的双平面拓扑，When 查看画布连线，Then 每条边两端显示 P0 起编的端口号，与 agent inspect 读到的端口标签一致。**Covers R5, R11.**
- AE4. **存量回退。** Given 本变更前生成的会话拓扑（链路无平面字段、端口标签为 p1 起编），When 打开画布，Then 边渲染为中性色、端口标签按既有 p1 值显示、布局保持旧坐标，无报错。**Covers R5, R7.**
- AE5. **确定性保持。** Given 同一组双平面参数，When 两次 initialize，Then 两次坐标完全相等且无两节点同坐标。**Covers R4.**

---

## Scope Boundaries

- TSN 控制器节点不入图——已明确不做，画布不要求与规范图在该元素上对齐（ideation idea 6 已否决）。
- 平面泳道背景带与画布图例（idea 5）、布局质量门契约与 AABB 断言的形式化（idea 4）——后续增量。
- 存量拓扑不做迁移或 relayout：旧会话保持旧坐标与 p1 端口命名，重新生成才获得新形态。
- generic-line / generic-ring 布局不动（ring 可读性问题已在 ideation 登记，idea 7）。
- 节点拖拽、前端布局库（elkjs/dagre）——ideation 已否决。

---

## Dependencies / Assumptions

- 节点卡片渲染宽度约 96-126px（`src/app/App.css` `.tsn-node`），布局间距常量以此为据；该尺寸若大改需同步布局常量。
- agent 经 apply_operations 新增链路时写入的 `stylesJson` 平面值不保证正确，前端按 R7 容错处理而非信任。
- 规范参考图来源：`docs/prototypes/TSN典型组网测试方案_20260527.docx` 图 4-1（单跳）、双跳组网图、图 5-15（跳线性）。

---

## Outstanding Questions

**Deferred to Planning**

- smoothstep 偏移的实现通道（React Flow `pathOptions.offset` vs 自定义 edge）与偏移量取值。
- 平面 A/B 独立 token 的具体色值与现有浅色主题、节点配色的协调。
- 端口标签的字号与密度处理（当前模板规模 8-14 节点下预计可直接渲染）。

---

## Sources

- 诊断与候选评估：`docs/ideation/2026-06-10-topology-canvas-layout-ideation.md`（含代码定位与硬约束清单）
- 坐标生成：`src-tauri/src/topology_compute.rs`（`create_dual_plane_redundant_topology`）
- 链路落库：`src-tauri/src/topology_sidecar_routes.rs`（stylesJson 含端口标签）
- 画布渲染：`src/app/components/workspace-pane/index.tsx`
- 双平面生成需求（已交付）：`docs/brainstorms/2026-06-09-dual-plane-topology-generation-requirements.md`
