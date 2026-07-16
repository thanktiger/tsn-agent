---
title: "KTD13 静态转发表改 forward-only（去反向条目）"
date: 2026-07-15
status: requirements
branch: feat/ktd13-forwarding-pinning
origin: ce-debug（真实 session 触发 FORWARDING_CONFLICT）+ docs/solutions/inet-tas/2026-07-15-ktd13-l2-forwarding-pinning-spike.md
---

# KTD13 静态转发表改 forward-only（去反向条目）

## 一句话

验证 bundle 的逐交换机静态转发表，只按每条流的**正向**（去 listener）写条目，删掉现在还额外写的**反向**（去 talker）条目——反向那份是冗余，且在含环拓扑里会误报冲突把合法配置挡在门外。

## 背景与根因（ce-debug 已确认）

现 `build_forwarding_tables`（`src-tauri/src/inet_sim_bundle.rs`）对每条 ST/BE 流写两类条目：正向（dest=listener，沿 `egress`）+ 反向（dest=talker，反走 `node_path`）。

真实 session 实证（5 交换机线型 + 一条弦链路 SW-2—SW-5 成环）：SW-5 上流3(ST, ES-7→ES-2) 与流13(BE, ES-7→ES-11) 的**反向**条目对同一目的 `es07`（=共同 talker ES-7）要求不同出口（eth1 vs eth4）→ 硬报 `FORWARDING_CONFLICT`。而真正发往 ES-7 的流6/18 的**正向**条目已权威把「SW-5 去 es07」钉在 eth1；流3/13 的反向只是「反走自己路径」的猜测，一个碰巧对、一个错。用户看到的「指定同侧路径」引导在此不可操作——两条流去的是不同 listener，无从对齐。

**核心洞察**：所有流的正向条目 = 「有 unicast 流量到达的目的 × 承载它的交换机」的精确覆盖，既充分又存储安全；反向条目纯冗余，且是这类环拓扑伪冲突的唯一来源。

## 与 spike「双向硬要求」的和解（承重，已想通）

spike 的真机证据用**三角拓扑 + 双向各 100 UDP 包**，证明的是「双向流量在环拓扑里每个交换机对两个目的都要有条目」——这没错。但它把「双向覆盖必需」实现成了「每条流自己写正+反」。真相是：双向流量本就是**两条流**（A→B 和 B→A），forward-only 下每条流只写正向、两条流合起来照样覆盖两个方向。

- spike 三角在 forward-only 下**会同样通过**：A→B 流钉 B、B→A 流钉 A，两方向都有，不需要反向机制。
- spike 之所以没暴露问题：三角里两条镜像流写出的反向条目恰好相同、被去重了。
- 我们的伪冲突：ES-7 的返回覆盖已由流6/18 提供，流3/13 反向多余且矛盾。

结论：spike 没证明「反向条目必需」，只证明了「双向覆盖必需」；forward-only 用「反向那条流的正向条目」提供覆盖，等价且无伪冲突。**此和解需 U4 真机复证后回写 spike。**

## 需求

- **R1 只写正向**：每条 ST/BE 流按 `egress`（除 talker）逐交换机写 dest=listener 条目；删除反向（dest=talker）条目环及其 talker 地址推导。
- **R2 覆盖完整**：凡收到 unicast 流量的目的（= 某流 listener），在其路径沿途每交换机都有条目——由该 listener 的流正向路径保证；无流量的目的无条目（也收不到帧）。
- **R3 保留合法正向冲突**：两条发往同一 listener 的流在共享交换机要求不同出口 → 仍报 `FORWARDING_CONFLICT`（物理不可满足，用户可对齐路径解决）；同 listener 同出口去重。
- **R4 范围守恒**：仍 `is_pin && !frer` 闸；含 RC 流集不钉（与现状字节一致）；Synth 规划 bundle 与时间同步 bundle 字节不变。
- **R5 行为闸**：`forwarding_linear_bidirectional_entries` / `forwarding_detour_uses_detour_port` 现硬编码反向断言，改为 forward-only 断言；新增本 session 形态回归（同 talker、异 listener、环拓扑 → 不再误冲突、验证通过）；既有 `forwarding_reverse_fork_conflict` 删除或改写（反向冲突不再是行为）；timesync golden 字节测试不动；全量 cargo 绿。
- **R6 真机验证（U4）**：dump forward-only bundle，在①spike 三角（双向流）②本 session（环）真跑：绕路口计数满、直连口 0、**零泛洪计数**、验证判定达标；证实后回写 spike 结论（把「每条流双向」修正为「每条流正向，双向覆盖由双向流提供」）。
- **R7 错误文案**：正向冲突文案（点名两流 seq + 交换机 + 同侧路径引导）保留；反向相关措辞删除。

## 方案

**唯一方案：forward-only（删反向环）**。这是简化不是新增——删掉 `build_forwarding_tables` 里反向条目那段循环（约 `inet_sim_bundle.rs:620-642`）及 `talker_addr` 推导，正向段、去重/冲突 `push`、`switch_mids` 非交换机守卫、`%ethN` listener 地址（`forward_dest`/`route_listener_eth`）全部不动。冲突键仍 (交换机, 目的地址)，但现在只有正向条目参与 → 只剩合法的同-listener 分叉冲突。

不做「保留反向但降级冲突为择优」的复杂变体：那要引入「正向条目权威、反向让路」的优先级逻辑，比直接删更复杂、且反向条目本就无用。

## 范围边界

**做**：验证 bundle 的 `build_forwarding_tables` 及其单测、错误文案、spike 结论回写、U4 真机复证。

**不做**：
- Synth 规划 bundle、时间同步 bundle 的任何改动。
- 含 RC 流集的钉死（维持现状：StreamRedundancyConfigurator 按 pathFragments 钉）。
- UI 变化（无新界面；错误走既有验证失败展示）。
- U4 真机执行本身（需宿主机 inet-sim-http，boss 手动跑）。

## 承重验证与假设

- **假设**：软仿里无「未声明为流」的 unicast 返回流量（UdpSourceApp→UdpSinkApp 单向、sink 不回包）；ARP/gPTP 为广播/组播，不受静态 unicast 表管辖、反向条目也不参与。→ 若 U4 观测到泛洪，此假设被证伪，需回到「保留反向 + 择优」变体。
- **U4 双场景对照**是唯一能证实/证伪 forward-only 存储安全的手段（纯逻辑推理不足以推翻 spike 的真机结论）。

## Outstanding Questions

- 无阻断性未决项。forward-only 方向、spike 和解、测试迁移口径均已定；余下靠 U4 真机复证收口。

## 关联

- 根因与因果链：本轮 ce-debug（未单独存档，摘要在会话）。
- 前序：`docs/plans/2026-07-15-003-feat-ktd13-forwarding-pinning-plan.md`（U1-U3 已落，U4 未做）；本 redesign 并入 U4 之前。
- spike：`docs/solutions/inet-tas/2026-07-15-ktd13-l2-forwarding-pinning-spike.md`（待 R6 回写）。
