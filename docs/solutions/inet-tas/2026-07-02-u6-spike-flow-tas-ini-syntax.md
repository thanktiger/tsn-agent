---
title: U6 spike — INET 流量+TAS bundle 的真机 ini/NED 语法（照抄 SAT showcase）
date: 2026-07-02
module: inet_sim / flow-planning
problem_type: architecture_pattern
plan: docs/plans/2026-07-01-002-feat-flow-tas-qbv-inet-plan.md
host: zhang@100.104.38.106 (opp_env inet-4.6.0, /home/zhang/inet-workspace)
source: showcases/tsn/gatescheduling/sat/{omnetpp.ini, results/SAT-#0.sca} + src/.../TsnNetworkBase.ned
---

# U6 spike 结论：flow+TAS ini 语法照抄 SAT showcase，pin/synth 一行切换

boss 定「U6 先真机 spike」。dump 宿主机 `showcases/tsn/gatescheduling/sat/omnetpp.ini`（Z3
门控综合的官方 showcase，带完整流量 app + 流识别 + 整形 + 配置器）+ 真机 `.sca` 的门参数 +
`TsnNetworkBase.ned`，把 `build_flow_tas_ini` 要生成的每一段语法钉死。**无 blocker。**

## ①流量 app 层（每 talker 一 UdpSourceApp、每 listener 一 UdpSinkApp）

```ini
*.<talker>.numApps = N
*.<talker>.app[i].typename = "UdpSourceApp"
*.<talker>.app[i].io.destAddress = "<listener_ned>"
*.<talker>.app[i].io.destPort = <port>
*.<talker>.app[i].source.packetLength = <frame>B
*.<talker>.app[i].source.productionInterval = <period>us
*.<talker>.app[i].source.packetNameFormat = "%M-%m-%c"

*.<listener>.numApps = M
*.<listener>.app[j].typename = "UdpSinkApp"
*.<listener>.app[j].io.localPort = <port>   # 与对应 source 的 destPort 相同
```

## ②流识别 + 编码（talker 出流、switch 收发流、listener 收流）

```ini
*.<talker>.hasOutgoingStreams = true
*.<talker>.bridging.streamIdentifier.identifier.mapping =
  [{stream: "<name>", packetFilter: expr(udp.destPort == <port>)}, ...]
*.<talker>.bridging.streamCoder.encoder.mapping = [{stream: "<name>", pcp: <pcp>}, ...]

*.<switch>.hasIncomingStreams = true
*.<switch>.hasOutgoingStreams = true
*.<switch>.bridging.streamCoder.decoder.mapping = [{pcp: <pcp>, stream: "<name>"}, ...]
*.<switch>.bridging.streamCoder.encoder.mapping = [{stream: "<name>", pcp: <pcp>}, ...]

*.<listener>.hasIncomingStreams = true
```

## ③出口整形 + 队列/门（R14）

```ini
*.<switch>.hasEgressTrafficShaping = true
*.<switch>.eth[*].macLayer.queue.numTrafficClasses = <numClasses>
*.<switch>.eth[*].macLayer.queue.queue[k].display-name = "<class name>"
```
`numTrafficClasses` 实例化每端口 `transmissionGate[0..numClasses-1]`。**gateIndex = 流量类下标、
非 pcp**（showcase：pcp0→gate0 BE、pcp4→gate1 video）。本项目 ST=pcp7/BE=pcp0 → 定 BE→gate0、
ST→gate1（numTrafficClasses=2）。

## ④synth 模式（Z3 综合，U7）——配置器 typename + configuration 数组

```ini
*.gateScheduleConfigurator.typename = "Z3GateScheduleConfigurator"
*.gateScheduleConfigurator.gateCycleDuration = 1ms
*.gateScheduleConfigurator.configuration =
  [{pcp: 0, gateIndex: 0, application: "app[0]", source: "<talker_ned>", destination: "<listener_ned>",
    packetLength: <frame>B + 58B, packetInterval: <period>us, maxLatency: <docx窗口>us}, ...]
```
- **报文长度 +58B 开销**：`8B(UDP)+20B(IP)+4B(802.1Q)+14B(ETH MAC)+4B(FCS)+8B(PHY)`。综合约束面 packetLength 要带这 58B。
- `application: "app[i]"` = **source 节点上的** app 下标（须与 ①的 numApps 分配一致）。
- 可选 `maxJitter`（规划期抖动约束，U1 利好①）、`pathFragments`（显式路径，U1 利好②，绕开最短路歧义）。

## ⑤pin 模式（U8）——不声明配置器 + 直接写门参数

`TsnNetworkBase.ned` 关键（真机确认）：
```ned
network TsnNetworkBase extends WiredNetworkBase {
    submodules:
        gateScheduleConfigurator: <default("")> like IGateScheduleConfigurator if typename != "" { ... }
        streamRedundancyConfigurator: <default("")> like INetworkConfigurator if typename != "" { ... }
        failureProtectionConfigurator: <default("")> like INetworkConfigurator if typename != "" { ... }
}
```
→ 我们生成的网络 extends `TsnNetworkBase`，**白得**这三个条件子模块（默认 typename="" = 不实例化）。
故 **pin 与 synth 只差一行**：pin 不设 `gateScheduleConfigurator.typename`（保持 ""=无配置器），
改直接写门参数；synth 设 `="Z3GateScheduleConfigurator"`。**NED 无需为两模式分叉**。
连带白得 `streamRedundancyConfigurator`/`failureProtectionConfigurator`（802.1CB FRER，本期 defer、将来 RC 直接开）。

真机 `.sca` 的门参数形（未调度门录 `durations []`/`offset 0s`）→ pin 模式 ini 写：
```ini
*.<node>.eth[<n>].macLayer.queue.transmissionGate[<gi>].initiallyOpen = <bool>
*.<node>.eth[<n>].macLayer.queue.transmissionGate[<gi>].offset = <offset>us
*.<node>.eth[<n>].macLayer.queue.transmissionGate[<gi>].durations = [<d0>, <d1>, ...]
```
（`GclEntry` 存 ns，写 ini 时可用 ns 或换 us；INET 接受带单位字面量。）

## 对 U6 的净影响

- `build_flow_tas_ini(streams, schedule)`：app 层（①②）+ 整形（③）两模式共享；`schedule=Synth{configuration}`
  走④、`Pin{gcl}` 走⑤。NED 复用 timesync 的 submodule/connection 脚手架（含 `ethg[N];` 声明、KTD3），
  只改网络名 `TsnAgentFlowTasNetwork` + 不含 clock-only 的 timesync 专属键（gPTP 键仍要，R15 非理想时钟）。
- 网络名/base/caliber 参数化即可，`TsnNetworkBase` 已含配置器槽，无需改 NED 结构。
- 端口/app 下标分配须确定性且四处一致（source numApps、sink numApps、streamIdentifier destPort、
  configurator application/source/destination）——U6 用 stream_seq 稳定派生。
