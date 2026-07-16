---
title: "fix: 静态转发表改 forward-only + 显式 GlobalArp（修 KTD13 环拓扑伪冲突）"
type: fix
date: 2026-07-15
origin: docs/brainstorms/2026-07-15-ktd13-forward-only-forwarding-requirements.md
depth: standard
branch: feat/ktd13-forwarding-pinning
---

# fix: 静态转发表改 forward-only + 显式 GlobalArp

## 摘要

`build_forwarding_tables`（`src-tauri/src/inet_sim_bundle.rs`）现对每条 ST/BE 流写正向（dest=listener）+ 反向（dest=talker）条目。反向条目在含环拓扑 + 节点既做 talker 又做 listener 时误报 `FORWARDING_CONFLICT`，把合法配置挡在验证门外（真实 session 实证）。本计划删掉反向条目环，改 forward-only：每条流只写正向条目。对「所有目的都是某流 listener」的拓扑（对称/收发双角色），正向条目已精确覆盖有 unicast 流量的目的、存储安全。对**纯 talker**（只发不收，TSN 传感器常见形态），其单播 ARP-reply 无正向覆盖会泛洪——本计划同时在验证 bundle 显式发 `GlobalArp`（全网 init 解析 MAC、零 ARP 帧），坐实无单播 ARP 泛洪。此存储安全论据待 U4 真机复证确认（见风险与依赖）。范围守恒：只动验证 bundle（`is_pin && !frer` 闸）与其单测，含 RC 不钉、Synth 规划 bundle 与时间同步 bundle 字节不变。

---

## 问题框架

含环拓扑（本例 5 交换机线型 + 一条弦链路 SW-2—SW-5）里，两条流共享 talker ES-7、去往不同 listener（ES-2 / ES-11）、经不同路径穿过 SW-5。反向条目对同一目的 `es07`（=共同 talker）要求不同出口 → 硬报冲突。而真正发往 ES-7 的流（流6/18）的正向条目已权威钉死「SW-5 去 es07」的正确出口；流3/13 的反向只是「反走自己路径」的猜测，一个碰巧对、一个错。用户看到的「指定同侧路径」引导在此不可操作——两条流去的是不同 listener，无从对齐。

反向条目源于 spike「双向硬要求」，但 spike 的真机证据用的是双向流量三角拓扑、且每节点都是 listener：它证明的是「双向覆盖必需」，实现成了「每条流自己写正+反」。真相是双向流量本就是两条流，forward-only 下每条流只写正向、两条流合起来照样双向覆盖——spike 三角在 forward-only 下会同样通过（此推理仅对对称/全节点皆 listener 的拓扑成立，见 origin 和解一节）。

**纯 talker 缺口（doc-review 揪出）**：ARP request 是广播，但 ARP **reply 是 unicast**（发往请求方 MAC）。纯 talker T 在 forward-only 下无任何流 listener=T → 全网无 dest=T 条目 → T 发包前 ARP 解析 listener → listener 回单播 ARP-reply(dest=T) → 查表 miss → 环拓扑泛洪（学习已关）。旧反向条目正是 dest=T 的唯一覆盖，对纯 talker 非冗余。根治不是「保留反向」（环里反向路径本身歧义），而是**消除 ARP 帧**：显式 GlobalArp 让全网 init 解析 MAC、无任何 ARP 帧上线，纯 talker 也就无单播 ARP-reply。

---

## 需求

- **R1 只写正向**：每条 ST/BE 流按 `egress`（除 talker）逐交换机写 dest=listener 条目；删除反向条目环及 talker 地址推导。
- **R2 覆盖完整**：凡收到 unicast 流量的目的（=某流 listener）在其路径沿途每交换机都有条目；无流量的目的无条目。
- **R3 保留合法正向冲突**：两条发往同一 listener 的流在共享交换机要求不同出口 → 仍报 `FORWARDING_CONFLICT`；同 listener 同出口去重。
- **R4 范围守恒**：仍 `is_pin && !frer` 闸；含 RC 不钉（字节一致）；Synth 与时间同步 bundle 字节不变。
- **R5 行为闸**：现有反向断言测试改 forward-only；新增本 session 形态回归；timesync golden 不动；全量 cargo 绿。
- **R6 真机复证**：forward-only + GlobalArp bundle 在①spike 三角（对称双向流）②本 session 环拓扑③含纯 talker 的非对称拓扑真跑，绕路口计数满、直连口 0、零泛洪、判定达标，并 grep dump 确认 `arp.typename` 已是 GlobalArp；证实后回写 spike 结论。
- **R7 错误文案**：正向冲突文案保留；反向措辞删除。
- **R8 显式无 ARP 单播**：pin 且无 RC 时 bundle 显式发 GlobalArp（全网解析 MAC、零 ARP 帧）；含 RC / Synth / 时间同步 bundle 不发（字节不变）。

---

## 关键技术决策

1. **KTD1 forward-only 重构 + dead-code 收口**：`build_forwarding_tables` 保留正向段（`egress` → dest=listener）、去重/冲突 `push` 闭包、`switch_mids` 非交换机守卫、`route_listener_eth` 的 `l_eth`/`listener_addr`；删除反向循环（约 `inet_sim_bundle.rs:620-642`）、`talker_addr`（约 :598）、**`t_eth`（删 talker_addr 后失去唯一消费者，遗漏即触发 CI `clippy -D warnings`——doc-review 揪出）**、仅反向用的 `node_eth_on_link` 闭包（约 :540-541）。入口 let-else 由 `(Some(t_eth), Some(l_eth))` 收窄为仅 `l_eth`：`let Some(l_eth) = route_listener_eth(...) else { return Err(internal_err(seq, "端点端口无法映射到 ethN")); }`。**显式决定 egress 空守卫**：原 `t_eth` 的 None 分支也走 internal_err 兜底 egress 为空；收窄后 `node_path.len()>=2` 已隐含 egress 非空（talker 恒在 egress），forward 循环零迭代不会误产条目——保留 `node_path.len()<2 → continue` 即足够，无需额外守卫。`endpoint_eth`（`route_listener_eth` 内部仍用）、`by_seq`、`switch_mids`、`port_eth`、`ned_names` 正向路径仍全部使用，函数签名与返回类型不变。不做「保留反向 + 冲突择优」变体（引优先级逻辑更复杂，环里反向路径本身歧义，且 GlobalArp 已根治纯 talker 缺口）。
2. **KTD2 存储安全论据（已修正 ARP 事实错误）**：unicast 帧到目的 D 只在「某条 listener=D 的流经过的交换机」出现；正向条目在这些交换机钉死 D → 无缺条目泛洪。**对收发双角色/对称拓扑**（本 session 全部 12 端系统皆收发双角色，实测无纯 talker），每个目的都是某流 listener → forward-only 存储安全。**对纯 talker**：ARP reply 是发往 talker 的 unicast，无正向覆盖 → 由 R8 的 GlobalArp（零 ARP 帧）消除，而非靠反向条目。gPTP（802.1AS）全消息走 link-local 组播、逐跳 Gptp 处理、不过 unicast 转发表 → forward-only 与 GlobalArp 对其零影响（doc-review 已复核）。此论据整体待 R6 真机复证（推理不足以单独推翻 spike 真机结论）。
3. **KTD3 冲突语义收窄**：删反向后冲突键 (交换机, 目的地址) 只余正向条目参与 → 只剩「两流发往同一 listener 在共享交换机分叉」这一合法物理冲突。现有 `forwarding_forward_fork_conflict` 覆盖它、文案「同侧路径」引导仍恰当，保留。反向专属的 `forwarding_reverse_fork_conflict` 删除。
4. **KTD4 显式 GlobalArp**：在 pin bundle 发射段（`build_flow_tas_ini` 的 `is_pin && !frer` 分支，与 forwardingTable / configurator-disable / agingTime 同闸）加 GlobalArp 配置行。GlobalArp 只改 IP→MAC 解析（init 全局解析、零 ARP 帧），不改 UDP/gPTP/TAS 转发路径，与静态 forwardingTable（MAC→端口）不同层、无冲突。**确切 ini 路径（如 `*.*.ipv4.arp.typename` vs `**.arp.typename`，TsnDevice/TsnSwitch 的 arp 子模块路径）执行期由 dump 真 bundle 确认**——spike 声称产品 bundle「已是 GlobalArp」，本决策把它从继承默认改成显式坐实，U4 真机验证 `arp.typename` 生效。

---

## 高层设计：本 session 为例（before → after）

```
拓扑：ES-7(talker) 发往 ES-2(流3,经SW-4) 与 ES-11(流13,经SW-2弦)，两路在 SW-5 汇合；
     ES-2 与 ES-4 又各自发往 ES-7（流6 / 流18，即返回方向的两条独立流）。
     SW-5 上「去 es07」的条目来源：

before（正+反）：
  流6 正向  SW-5→es07 = eth1   ← 真实流量，权威
  流3 反向  SW-5→es07 = eth1   ← 冗余（碰巧对）
  流13 反向 SW-5→es07 = eth4   ← 冗余且错 → FORWARDING_CONFLICT（验证失败）

after（仅正向 + GlobalArp）：
  流6 正向  SW-5→es07 = eth1   ← 唯一来源，正确
  流3/13 不再贡献 es07 条目（它们的正向只钉各自 listener es02/es11）
  → 无冲突，验证通过；es07 覆盖由真正发往它的流6/18 提供
  GlobalArp：全网无 ARP 帧 → 即便某拓扑存在纯 talker 也无单播 ARP-reply 泛洪
```

---

## 实施单元

### U1. build_forwarding_tables 改 forward-only

**Goal**：删反向条目环，每条流只写正向 dest=listener 条目；合法正向分叉冲突与去重保留；无 dead-code。

**Requirements**：R1、R2、R3、R7。

**Dependencies**：无。

**Files**：修改 `src-tauri/src/inet_sim_bundle.rs`（`build_forwarding_tables` 函数体）。

**Approach**：见 KTD1。删反向 `for i in 1..node_path.len()-1` 循环、`talker_addr`、`t_eth`、`node_eth_on_link` 闭包；入口 let-else 收窄为仅 `l_eth`。正向循环、`push` 冲突/去重闭包、`FORWARDING_CONFLICT`/`FORWARDING_INTERNAL` 文案不动。落地后本地跑 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 确认零 unused。函数签名与返回类型不变。

**Patterns to follow**：现有正向段自身；`push` 闭包冲突文案（`inet_sim_bundle.rs` 既有）。

**Test scenarios**：由 U3 覆盖（同 PR，独立列出便于对账）。

**Verification**：`cargo clippy --all-targets -- -D warnings` 无 unused 警告；U3 测试绿。

### U2. pin bundle 显式发 GlobalArp

**Goal**：pin 且无 RC 时 bundle 发 GlobalArp 行；含 RC / Synth / 时同不发。

**Requirements**：R8、R4。

**Dependencies**：无（与 U1 独立，可同 PR）。

**Files**：修改 `src-tauri/src/inet_sim_bundle.rs`（`build_flow_tas_ini` 的 `is_pin && !frer` 发射分支）。

**Approach**：见 KTD4。在既有 forwardingTable / `macForwardingTableConfigurator.typename=""` / `agingTime` 同一 `is_pin && !frer` 分支追加 GlobalArp 配置行。确切路径执行期 dump 真 bundle 确认。Synth 分支与 frer 分支零改动（R4 字节不变）。

**Patterns to follow**：同分支既有 configurator-disable / agingTime 行的发射写法（`inet_sim_bundle.rs` 既有）。

**Test scenarios**：
- Pin + 纯 ST/BE：ini 含 GlobalArp 行。
- Pin + 含 RC：GlobalArp 行不出现，FRER 段与现状一致。
- Synth 模式：GlobalArp 行不出现。
- timesync golden 字节测试原样通过（R4）。

**Verification**：`cargo test` 相关 ini 断言绿；timesync golden 不动。

### U3. 测试迁移到 forward-only

**Goal**：所有断言反向条目的测试改 forward-only，删反向专属冲突测试，加本 session 环拓扑回归。

**Requirements**：R3、R4、R5。

**Dependencies**：U1、U2。

**Files**：修改 `src-tauri/src/inet_sim_bundle.rs`（`#[cfg(test)] mod tests`）。

**Approach**：**先 `grep -n "forwardingTable\|%eth" src-tauri/src/inet_sim_bundle.rs` 内 test 段枚举全部断言转发条目的用例，逐个迁移，勿只改记忆中的清单**（doc-review 实证 `pin_pure_stbe_emits_forwarding_table`(:2301) 也硬编码正+反断言、不带 `forwarding_` 前缀、易漏）。已知需动：
- `forwarding_linear_bidirectional_entries`：改断言为每交换机只余 dest=listener 正向条目。
- `forwarding_detour_uses_detour_port`：三台交换机各只含去 listener 正向条目（去掉上轮 review 补的反向断言）。
- `pin_pure_stbe_emits_forwarding_table`(:2301)：`forwardingTable` 期望去掉 es01 反向项，只留 es02 正向项；若该测试所在拓扑触发 GlobalArp，同步加 GlobalArp 行断言。
- `forwarding_reverse_fork_conflict`：删除。
- `forwarding_forward_fork_conflict`：保留不变。
- `forwarding_dedup_same_egress`：按 forward-only 调期望条目数。
- **新增 `forwarding_shared_talker_ring_no_false_conflict`**：复刻本 session 形态（同 talker、两条去不同 listener 的流经环拓扑不同路径汇合于一交换机）→ forward-only 下不报冲突、每交换机含正确正向条目。fix 核心回归。

**Test scenarios**：
- 直路 / 绕路 forward-only：沿途每交换机恰一条 dest=listener 正向条目，出口与 links 一致。
- 同 talker 异 listener 环拓扑（本 session 形态）：不报冲突、正向条目正确。
- 合法正向分叉冲突（同 listener 不同出口）：仍 `FORWARDING_CONFLICT`、点名两流 + 交换机 + 引导。
- 同 listener 同出口去重：一条。

**Verification**：`cargo test forwarding_` 全绿；全量 `cargo test` 绿（含 timesync golden 不动，R4/R5）。

### U4. 真机复证 + 回写 spike

**Goal**：宿主机证实 forward-only + GlobalArp 不泛洪（含纯 talker 场景）、判定可信；回写 spike。

**Requirements**：R6、R7（doc 层）。

**Dependencies**：U1、U2、U3。

**Files**：修改 `docs/solutions/inet-tas/2026-07-15-ktd13-l2-forwarding-pinning-spike.md`（追加 forward-only + GlobalArp 更正一节）。

**Approach**：dump 验证 bundle，`grep arp.typename` 确认 GlobalArp 生效；宿主机 inet-sim-http 真跑三场景——①spike 三角（对称双向流，确认仍通过、无泛洪）②本 session 环拓扑（原冲突消失、绕路口计数满、直连口 0、零泛洪、判定达标）③**含纯 talker 的非对称拓扑**（关键判别场景：确认 GlobalArp 下纯 talker 无单播 ARP-reply 泛洪）。手法照 spike：scavetool/直读 scalar 端口计数。证实后把 spike 第 2 条「必须双向」更正为「每条流正向；双向覆盖由双向流各自正向提供，反向条目冗余且在环拓扑致伪冲突；纯 talker 缺口由显式 GlobalArp 消除而非反向条目」。

**Test scenarios**：Test expectation: none —— 真机验收单元，观测手段为宿主机 .sca 计数人工核对（boss 手动执行）。

**Verification**：三场景绕路证据 + 零泛洪 + 原冲突消失 + `arp.typename`=GlobalArp；spike 已回写。

---

## 范围边界

**做**：验证 bundle 的 `build_forwarding_tables`、pin 分支 GlobalArp 发射、相关单测、错误文案、spike 回写、真机复证。

**不做**：
- Synth 规划 bundle、时间同步 bundle 的任何改动。
- 含 RC 流集钉死（维持现状）。
- UI 变化。
- U4 真机执行本身（需宿主机 inet-sim-http，boss 手动跑）。

**Deferred to Follow-Up Work**：
- RC 混排单写入者统一（既有 KTD13 遗留，不在本 fix 范围）。

---

## 风险与依赖

- **forward-only + GlobalArp 存储安全依赖真机复证**（KTD2/R6）：逻辑论据完整（对称拓扑正向充分 + 纯 talker 由 GlobalArp 消除 ARP 帧），但 spike 曾以真机断言「双向必需」、且 GlobalArp 此前是继承默认非显式——U4 三场景（尤其纯 talker 非对称拓扑）是判别防线，须 grep 确认 `arp.typename` 生效、并以「为何不泛洪」的机制而非仅计数收口，避免 GlobalArp 掩盖或 U4 跳过导致 storm-prone bundle 带全绿出门。若真机仍观测纯 talker 泛洪，回退「保留反向 + 冲突择优」变体（origin 已记为已知回退路径）。
- **单测测不出泛洪**（doc-review）：U3 是对 `build_forwarding_tables` 返回值的纯函数断言，只验条目在不在、测不了运行时帧行为——泛洪判别只能靠 U4 真机，故 U4 的纯 talker 场景不可省。
- **共享测试脚手架**：`build_forwarding_tables`/`build_flow_tas_ini` 与 Synth/timesync 共处 `inet_sim_bundle.rs`——U2/U3 保留 timesync golden 不动是回归锁。
- **commit/PR 命名**（doc-review FYI）：本计划 U1-U4 与同分支已落地的 plan 003「KTD13 U1-U3」提交撞名——本计划提交文案用描述性 scope 或标注 plan 004，勿再写「KTD13 U1」避免 git log 认错单元。
- 依赖：宿主机 inet-sim-http 服务可用（U4）。

---

## 验收

- AE1：本 session（同 talker 异 listener 环拓扑）软仿验证不再报 `FORWARDING_CONFLICT`、判定达标（U4 真机）。
- AE2：spike 三角对称双向流 forward-only + GlobalArp 仍通过、无泛洪（U4 真机）。
- AE3：含纯 talker 非对称拓扑无单播 ARP-reply 泛洪、`arp.typename`=GlobalArp（U4 真机，关键判别）。
- AE4：合法正向分叉冲突（同 listener 不同出口）仍响亮报错含引导（U3 单测）。
- AE5：含 RC 流集、Synth、时间同步 bundle 字节不变；timesync golden 不动（U2/U3 + 回归断言）。
- AE6：全量 cargo 测试绿（R5）。
