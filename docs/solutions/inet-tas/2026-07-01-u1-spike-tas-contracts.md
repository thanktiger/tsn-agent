---
title: U1 spike — INET Z3 TAS 门控综合的真机契约（GCL dump / 约束面 / 键对齐 / verify 指标）
date: 2026-07-01
module: inet_sim / flow-planning
problem_type: architecture_pattern
plan: docs/plans/2026-07-01-002-feat-flow-tas-qbv-inet-plan.md
host: zhang@100.104.38.106 (opp_env inet-4.6.0 + omnetpp-6.4.0, release, 离线 nix)
---

# U1 spike 结论：Z3 TAS 真算闭环可行（四契约全 PASS，无需退路）

计划 U1 是 U4/U6/U7 的前置门。在宿主机 `showcases/tsn/gatescheduling/sat`（Z3，ST+BE 混流 TsnDumbbellNetwork）实跑钉死四个只有真机才知道的契约。**结论：全部 PASS，`plan_tas` 的 Z3 综合 + dump GCL 路径成立。**

## 契约① — GCL dump（核心，SOLVED）

配置器在 initialize 时给每个 `PeriodicGate` 设 `par("durations")`/`par("offset")`/`par("initiallyOpen")`（`src/inet/linklayer/configurator/gatescheduling/base/GateScheduleConfiguratorBase.cc:302-306`）。**dump 路径 = 跑 inet 带 `--**.param-recording=true`，直接解析 `.sca` 里的 `par ...transmissionGate[N] offset/durations/initiallyOpen` 行**（`.sca` 是文本，`cat`/`grep` 即可，无需 scavetool、无需 `.vec`）。

真机实测（被调度门，非默认值）：
```
par ...switch1.eth[2].macLayer.queue.transmissionGate[0] initiallyOpen false
par ...switch1.eth[2].macLayer.queue.transmissionGate[0] offset 2.947e-05s
par ...switch1.eth[2].macLayer.queue.transmissionGate[0] durations "[205.36us, 84.64us, 125.36us, 84.64us, 205.36us, 84.64us, 125.36us, 84.64us]"
par ...switch2.eth[0].macLayer.queue.transmissionGate[0] offset 2.942e-05s
par ...switch2.eth[0].macLayer.queue.transmissionGate[0] durations "[84.64us, 205.36us, 84.64us, 125.36us, ...]"
```
未调度门录成 `durations []`/`offset 0s`（NED 默认）——解析时空 durations 即"该门不调度"。

**关键坑**：`EV_DEBUG`（base.cc:302 那条"Configuring gate scheduling parameters"日志）在 **release build 被剥掉**，实测 `--cmdenv-log-level=debug` 抓不到——**别指望 debug 日志 dump，用 param-recording 的 .sca**。配置器只在 initialize 跑，`--sim-time-limit=1ms` 足够拿到全部门参数（无需跑满仿真）。

跑通命令（宿主机服务 plan verb 逐字复刻）：
```
inet -u Cmdenv -c <cfg> -n <inet/src>:<showcases> --result-dir=<run> \
  --**.param-recording=true --sim-time-limit=1ms omnetpp.ini
# 然后 grep '^par .*transmissionGate.*\(offset\|durations\|initiallyOpen\)' <run>/*.sca
```

## 契约② — 输入约束面形状（SOLVED，且有两个超预期利好）

`configuration` 数组正是计划 KTD2/U7 设想的形状（`base NED` 文档确认）：
```
*.gateScheduleConfigurator.typename = "Z3GateScheduleConfigurator"
*.gateScheduleConfigurator.gateCycleDuration = 1ms
*.gateScheduleConfigurator.configuration = [{pcp, gateIndex, application, source, destination,
   packetLength, packetInterval, maxLatency, maxJitter, pathFragments}]
```
- `maxLatency`（可选，端到端最大时延）——docx 窗口预算推导的值喂这里（U7）。
- **利好①`maxJitter`**（可选，默认 0）——jitter<1us **可在规划期直接当约束喂给 Z3**（不只靠软仿测），R15 判据多一道规划期保证。
- **利好②`pathFragments`**（可选，节点名数组的数组，支持组播树；省略走最短路）——**R11 路由推导的路径可直接喂进去**，不靠 INET 猜最短路，也顺带绕过"同 plane 多路径"的歧义（U5 推导出的显式路径直接给配置器）。
- `Z3GateScheduleConfigurator` 有 `optimizeSchedule`（默认 true，求最优总时延，较慢；docx 用例可评估设 false 提速）、`labelAsserts`（Z3 调试用）。

## 契约③ — host ethg 与 app build_port_eth_map 键对齐（by construction）

**app 自己生成 NED**（`build_sim_bundle` 用 `build_port_eth_map` 定 `ethg[k]`/`eth{k}`），host 只跑这份 NED，dump 里的 `ethN` 就是 app 自己的编号——**对齐 by construction，无错位风险**，只要 flow bundle 的 NED 经 `build_port_eth_map`（U6 保证）。`transmissionGate[gateIndex]` 的 gateIndex = 流量类下标（配置面里的 `gateIndex`，对应 pcp→traffic class）。故 GclEntry 键 = (node, ethN, gate_index) 三者都由 app 掌控。

## 契约④ — drift+gPTP+TAS 三方共仿抖动地板（设计note，非 blocker）

SAT showcase 用理想时钟（门控调度 demo，无 gPTP）——抖动地板这一条 showcase 证不了。**结论**：非 blocker，转为 U6 设计要求——flow bundle 须复用 timesync 已验证的 gPTP 同步子栈（drift 无同步会发散），抖动地板在 U6/U8 首次组装 flow bundle 时验证（timesync 侧 gPTP+drift 收敛已证，见 PR #59）。若组装后抖动地板异常（发散或恒 0），回到此契约排查。

## 附 — verify 侧 per-stream 指标真实向量名（修正计划 R13）

真机 `.vci` 实测的 sink 侧向量（**都落 `.vec`，现服务 scavetool 路径可取**）：
- **时延**：`server*.app[N].sink packetLifeTime:vector`（per-packet 端到端时延）——**用这个，非计划写的 `lifeTimePerPacket:vector`**（`meanBitLifeTimePerPacket:vector` 是 per-bit 均值，也存在但非首选）。
- **抖动**：`server*.app[N].sink packetJitter:vector`（直接抖动向量，jitter<1us 判它；另有 `packetDelayVariation:vector`）。
- **丢包**：`packetReceived:count`（sink `app[N].io`）vs `packetSent:count`（source `app[N].io`）——**是标量、落 `.sca`**，现服务只导 `.vec` 取不到 → verify 侧服务须一并回 `.sca` 的 count 行（与 plan dump 同 `.sca` cat 机制），或改录成 `:vector`。

## GclEntry 结构草案（KTD2b，U6 pin / U7 dump 解析 / U8 读 三处共用）

```rust
// durations/offset 一律 ns（.sca 里是 us/ns/s 混合单位，解析时归一化到 ns）
pub struct GclEntry {
    pub node: String,          // NED 节点名（app 侧）
    pub eth_n: usize,          // build_port_eth_map 的 ethN
    pub gate_index: usize,     // transmissionGate[gate_index] = 流量类（pcp→class）
    pub initially_open: bool,
    pub offset_ns: u64,
    pub durations_ns: Vec<u64>, // 交替 open/close 时长，和 = gateCycleDuration
    pub solver: String,        // "Z3" | "Eager"（出处，R8）
}
```
`.sca` 解析正则：`^par (\S+)\.transmissionGate\[(\d+)\] (offset|durations|initiallyOpen) (.+)$`，从模块路径抽 node + `eth\[(\d+)\]`，durations 去括号按逗号拆、各带单位归一化 ns。

## 对计划的净影响

- U1 **PASS**：dump（.sca param-recording）+ 约束面 + 键对齐 三个真 blocker 清除 → U4/U6/U7 可推进。
- 服务 verb（U7）：跑 inet 带 `--**.param-recording=true --sim-time-limit=1ms` → 回 `.sca`（app grep transmissionGate 行）。**不需要 scavetool**（比 verify 路径还简单）。
- verify（U8）：latency/jitter 从 `.vec`（`packetLifeTime`/`packetJitter`，现路径可取）+ 收发 count 从 `.sca` → 服务 verify 也要回 `.sca` count 行。
- 规划期可传 `maxJitter`（jitter 约束）+ `pathFragments`（显式路径），比计划更强。
- 计划 R13 的向量名 `lifeTimePerPacket:vector` 修正为 `packetLifeTime:vector`。
