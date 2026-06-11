---
date: 2026-06-11
topic: topology-canvas-interaction
---

# 拓扑画布交互与连线重做

## Summary

连线改为 floating 贝塞尔曲线（边动态吸附节点边框、无固定 handle 圆点），节点开放拖动且位置持久化到数据库；P0/P1 端口标签与平面蓝/红配色保留在新连线上。取代上一轮的正交折线 + 四向 handle 方案。

## Problem Frame

上一轮交付的正交折线在真机暴露三个问题：同一 handle 出口的多条边竖直段共线重叠、看不清也不好看；节点四边的 handle 圆点形似交换机/端系统的端口但并非端口语义，误导阅读；节点锁死不可拖动，复杂拓扑生成后无法手动调整查看。对 React Flow 全部 edge 方案（bezier/simplebezier/straight/step/smoothstep/floating）的对比结论：floating 边天然无固定锚点、同节点多边沿边框自然散开、拖动时贴边滑动，配贝塞尔曲线观感最佳。

本文档取代 `docs/brainstorms/2026-06-10-topology-canvas-spec-alignment-requirements.md` 中 R8/R10/R12（连线几何、四向 handle、走廊偏移），并推翻其 Scope Boundaries 对节点拖拽的否决（本轮显式启用）。其余决策继续有效且本文档不复述：布局投影与间距常量（≥180px）、端口 P0 起编、plane/role 落库与存量容错、配色 token。

---

## Key Decisions

- **Floating 贝塞尔替换正交折线。** 撤销 smoothstep 决策：观感与拖动体验优先于规范图逐线复刻。自建的正交走廊/绕行机制（corridor/detour 序数）随之移除——floating 端点天然互异，机制不再需要。
- **拖动坐标持久化进 DB。** 坐标唯一权威仍是数据库；用户拖动成为坐标的第二写入方（与 agent `node_update` 同语义），agent inspect 与画布永远同源，刷新/重开不丢。
- **handle 不再承担视觉与交互。** 画布是展示图，不开放手动拉线；连线锚点由 floating 计算得出，类端口圆点从画布消失。

---

## Requirements

**连线渲染**

- R1. 连线为 floating 贝塞尔：边端点动态吸附两端节点边框上朝向对端的位置，不锚定固定 handle；拖动节点时连线贴边跟随。退化兜底：两节点边框相交或中心重合时回退为中心直连，任意坐标下路径始终有限可渲染。
- R2. 节点四边不再显示 handle 圆点；不开放用户手动连线。边点击热区用 React Flow 默认 interaction 宽度，曲线密集区不做额外优化。
- R3. 平面配色保留：A 蓝 / B 红 / 中性回退，className 机制与选中态高亮优先级不变。
- R4. P0/P1 端口标签保留，锚定在连线两端吸附点附近，随节点拖动跟随移动。

**节点拖动**

- R5. 节点可拖动；拖动结束后新坐标（整数化）持久化到数据库，agent inspect 读到的坐标与画布一致，刷新/重开 app 不丢。
- R6. 重新生成（initialize）全量重建坐标并覆盖手拖位置——预期行为，不做保护。
- R7. 拖动位置不被拓扑快照刷新打断回跳，保护窗口覆盖拖动中至写入确认前：期间以本地坐标为准，快照不覆盖未确认坐标。
- R9. 拖动交互：悬停/拖动中有 grab/grabbing 光标反馈；禁用多选与框选（单节点拖动）；拖动结束视同选中该节点，详情面板同步显示新坐标。
- R10. 持久化失败时画布节点回滚到数据库当前坐标并给出可见提示，禁止画布与数据库静默分叉。
- R11. 并发语义：手拖写入与重新生成（initialize）交错时以重建结果为准——写入丢弃、画布回正到数据库快照。
- R12. 视口：首次加载执行一次 fitView；其后快照刷新与拖动不重置视口缩放与位置。

**生成端布局微调**

- R8. 同 lane 堆叠的 ES 在生成端加小幅纵向错位，避免同行水平连线穿过中间节点；既有约束保持（间距 ≥180px、节点生成序不变、整数坐标、同参两次全等、无两节点同坐标），「堆叠 ES 的 y 严格对齐平面行」的既有测试断言放宽为允许错位幅度。

---

## Acceptance Examples

- AE1. **连线形态。** Given 双平面单跳拓扑，When 渲染画布，Then 节点无 handle 圆点，ES 的两条上联曲线从节点边框不同位置出发、互不重叠，蓝/红平面配色与 P0 标签可见。**Covers R1, R2, R3, R4.**
- AE2. **拖动持久化。** Given 画布上任一节点，When 拖到新位置松手，Then 节点详情面板坐标更新，重开 app 后位置保持，agent inspect 返回新坐标。**Covers R5.**
- AE3. **堆叠不穿框。** Given 同组同主平面的两台 ES（堆叠 lane），When 渲染画布，Then 外侧 ES 的连线不穿过内侧 ES 的节点框。**Covers R8.**
- AE4. **存量兼容与退化兜底。** Given 本变更前生成的会话拓扑（含缺平面字段、p1 端口标签的链路），When 打开画布，Then 连线以 floating 贝塞尔正常渲染，端口标签按既有值显示、缺平面字段渲染中性色；节点被拖到与另一节点重叠时连线退化为中心直连不报错。**Covers R1, R3, R4.**
- AE5. **写入失败回滚。** Given 拖动松手后坐标写入失败（如数据库忙），When 写入返回错误，Then 节点回滚到数据库当前坐标并出现可见提示。**Covers R10.**

---

## Scope Boundaries

- 生成端初始布局投影不动（单跳三明治 / 双跳双平面行，上轮交付保留；R8 错位微调除外）。
- 不做画布编辑（手动连线、增删节点）；不做自动重排按钮。
- 不做节点碰撞检测：用户可拖到任意位置（含重叠），位置合理性自行负责（R1 退化兜底保证不崩）。
- 平面泳道、图例、generic-ring 布局修复仍为后续增量。

---

## Dependencies / Assumptions

- 前端写坐标走**新增 Tauri command**：sidecar HTTP 的 Bearer token 按设计仅在 Rust 内存流转（不暴露 webview），复用 HTTP 路径会破坏该安全边界，故排除。新 command 需同步触发既有变更通知（快照刷新机制感知坐标变化）。
- React Flow 官方 Floating Edges 示例为实现参照（@xyflow/react 12.x）；其边框交点计算在节点中心重合时产出 NaN，是 R1 退化兜底的由来。
- 已知窄窗口边界（接受不修）：agent `node_add` 超时重放期间若用户恰好拖动同一节点，三态写入的坐标同值比对会误判碰撞报错。

---

## Outstanding Questions

**Deferred to Planning**

- 堆叠 ES 纵向错位幅度常量取值（需按 floating 直线几何验算 AE3 不穿框）。
- 拖动是否网格吸附（默认自由拖动，不吸附）。

---

## Sources

- 上轮需求与交付：`docs/brainstorms/2026-06-10-topology-canvas-spec-alignment-requirements.md`、`docs/plans/2026-06-10-002-feat-topology-canvas-spec-alignment-plan.md`
- 现状代码：`src/app/components/workspace-pane/topology-flow.ts`（映射层）、`src/app/components/workspace-pane/tsn-link-edge.tsx`（待替换的正交边）、`src/app/components/workspace-pane/index.tsx`（handle 渲染、nodesDraggable）
- React Flow edge 方案调研：内置 bezier/simplebezier/straight/step/smoothstep + 官方 Floating Edges / Simple Floating Edges 示例（reactflow.dev/examples/edges）
