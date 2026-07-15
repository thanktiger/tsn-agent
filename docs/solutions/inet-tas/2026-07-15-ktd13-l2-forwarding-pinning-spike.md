---
module: inet_sim / flow-planning
problem_type: feasibility_spike
root_cause: framework_semantics
severity: high
symptom: 指定绕路的流规划按绕路算门控，软仿验证流量仍走 INET 自算最短路
---

# KTD13 spike：INET 软仿逐跳转发钉死——可行，机制为直写 MacForwardingTable.forwardingTable

## 结论

**可行**。逐交换机直写 `MacForwardingTable` 的 `forwardingTable` 对象参数即可把流量钉死到指定绕路，TsnSwitch/TsnDevice（产品真实形态）上直接验证通过：

```ini
*.sw1.macTable.forwardingTable = [{address: "es2", interface: "eth2"}, {address: "es1", interface: "eth0"}]
```

`address` 可写节点名（L3AddressResolver 解析成 MAC）。前提：**去掉 bundle 里的 `MacForwardingTableConfigurator` 子模块**（它会整体覆盖该参数）。外部文件变体 `forwardingTableFile`（每行 `VLAN MAC 接口名`）等价可用，但 ini 对象参数更适合产品化（单文件）。`MacForwardingTableConfigurator` 本身无路径注入口（NED 零可配参数），其内部实现（`MacForwardingTableConfigurator.cc:119`）就是写同一参数——等效性有源码背书。

## 证据（宿主机 100.125.25.12 实跑，/tmp/ktd13-spike/）

拓扑 es1—sw1—sw3—es2 直路 + sw1—sw2—sw3 绕路（三角形环），双向各 100 UDP 包：

- 基线（自动配置器）：sw2 端口全 0，sw1↔sw3 直连口 100/100——复现产品现状。
- 钉死：sw2 双口双向恰好各 100（无泛洪假阳性），直连口双向 0——真绕路、双向对称、零丢包。
- scalar：`<sw>.eth[N].phyLayer.outboundEmitter outgoingPackets:count` / `inboundEmitter incomingPackets:count`。

## 产品化注意事项（bundle 生成端）

1. **`forwardingTable` 参数单写入者**：`MacForwardingTableConfigurator` 与 `StreamRedundancyConfigurator`（RC/FRER 用）都会 `par("forwardingTable") = ...` 整体替换（后者 `StreamRedundancyConfigurator.cc:363` 无合并逻辑）；`parseForwardingTableParameter` 遇重复 (vlan, mac) 键抛 cRuntimeError。含 RC 流的拓扑上两者不能混用——需统一成单写入者（生成端自己算好全量静态表）。
2. **必须双向、全 MAC 钉死**：未命中表项的单播帧向全端口泛洪，绕路拓扑必然含环 → 泛洪即风暴。每条流收发两端 MAC 在路径沿途每个交换机都要有条目；保持 GlobalArp（产品 bundle 已是）。
3. **VLAN 键匹配**：表项按 (vlanId, mac) 查找，未打 VID 的优先级帧命中 vlan=0；产品流若带非零 VID，条目 vlan 字段必须一致，否则查不到 → 泛洪。
4. **TSN 流模式下学习被禁**：TsnSwitch 开 `hasOutgoingStreams/hasIncomingStreams` 时自动 `learner.typename=""`——静态表是唯一转发依据，第 2 条成硬要求。长仿真注意 `agingTime`（默认 120s）会淘汰静态条目，需拉大 `**.macTable.agingTime`。
5. **`GateScheduleConfigurator.pathFragments` 不配转发表**（`GateScheduleConfiguratorBase.cc:190-229` 只用于调度/时延计算）——Z3 按绕路算 GCL 与转发走直路的割裂真实存在；产品化 = 把同一份 pathFragments 翻译成逐交换机 forwardingTable 条目，两者口径才一致。
6. 老坑复现确认：`**.eth[*].bitrate = 1Gbps` 必须显式给且放 [General] 段。

## 最小复现件

宿主机 `/tmp/ktd13-spike/`（Ktd13Net.ned + omnetpp.ini 含 Baseline/Pinned/PinnedFile 三 Config + 三份 results）。ned 要点：`Ipv4NetworkConfigurator` + 可选 `MacForwardingTableConfigurator if hasAutoForwarding` + 三 TsnSwitch 三角 + 两 TsnDevice。
