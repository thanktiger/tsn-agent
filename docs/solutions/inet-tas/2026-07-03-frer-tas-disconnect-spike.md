---
title: U1 spike — FRER × TAS × gPTP × 断链的真机契约（双平面 RC）
date: 2026-07-03
module: inet_sim / flow-planning
problem_type: architecture_pattern
plan: docs/plans/2026-07-03-001-feat-flow-three-class-st-rc-be-plan.md
host: zhang@100.104.38.106 (opp_env inet-4.6.0, /home/zhang/inet-workspace)
source: showcases/tsn/framereplication/{automaticmultipathconfiguration,manualconfiguration} + examples/mrp + src/inet/linklayer/configurator/common/StreamRedundancyConfigurator.cc + 8 轮真机实跑（/tmp/spike-frer/run1..run8，已清理）
---

# U1 spike 结论：FRER 可行但契约改型——双宿 ES 须拆「设备+内嵌桥」，全部 ST/RC 流交 StreamRedundancyConfigurator（带 pcp 键）

fixture：双平面 4 节点（es1/es2 双宿 TsnDevice + sw1/sw2 TsnSwitch）与改型 6 节点（es1—esb1—{sw_A|sw_B}—esb2—es2）。
流：ST es1→es2 pcp7 500us 512B ×2000（sim 1s）+ RC es1→es2 pcp6 1ms 512B ×1000。
TAS：pin gate7（A 核 egress，`enableImplicitGuardBand=false`）；gPTP 非理想时钟（RandomDrift 0.3ppm）全程共仿。

## 五押注结论表

| # | 押注 | 结论 | 关键证据 |
|---|------|------|----------|
| ① | FRER 与 per-PCP streamCoder 编码共存 | **PASS（改型后）**：直接叠加 FAIL——configurator 对流经节点的 identifier/coder mapping 是**整体替换**（`par("mapping")=...`，非合并），ST 掉回 pcp0/gate0。可行形态=**ST/RC 全部进 `streamRedundancyConfigurator.configuration` 并带 `pcp` 键**（源码 L156 支持），BE 留在外面（无 stream→untagged pcp0→gate0，语义正确） | run2：ST 2000→queue[7]、RC 1000→queue[6]、gPTP 20→queue[0]（三类各归其门） |
| ② | R-TAG 去重收=发 | **PASS**：健康轮 RC 1001 发→1000 收（差 1=尾包在途）；esb2 merger `droppedPackets:count`=1000=恰好全部 B 树重复份，无误删无漏删 | run3 merger in 4021/out 3021/dropped 1000 |
| ③ | 断链后 RC 不断流、gPTP 不 abort | **PASS**：t=400ms 单向断 A 核出向，RC 仍 1001 发→1000 收（**断链瞬间在途损失 0**，A 份停在 400、B 份补齐）；gPTP 无 oscillatorCompensation abort，下游（esb2/es2）时钟自由跑 0.6s 无碍；EXIT=0 | run4：merger dropped=400（断前重复数）；ST 停 799（断点在 ST 路由上，预期） |
| ④ | scenarioManager 最小声明 | **PASS**：自定义 network 里加 `import inet.common.scenario.ScenarioManager;` + 子模块 `scenarioManager: ScenarioManager;` 即可；**`hasStatus` 不需要**（未设、disconnect 正常生效）；`ethg$o[N]` 单向断开语法生效 | run4 断链证据链完整（ST/RC-A 计数精确停在 400ms 处） |
| ⑤ | 双平面 ST 单播默认落哪 + 能否钉死 | **PASS（含重要修正）**：默认**全部落 talker eth0（最小库端口）所在平面**，确定性、无环无泛洪风暴；**macTable 静态下发对双宿 ES 形态无效**（平面在 talker 的 L3 出口就定了，帧根本不进另一平面）；`destAddress "es2%eth1"`、`optimizeRoutes=false` 均不改出口（configurator 给 B 口 IP 的路由经 A 平面网关）。**可行钉死 = configurator 手工路由 xml + `%ethN` 目的地址**（见下） | run5 全落 A；run6/7 `%eth1` 仍走 A；run8 手工路由后 ST→B 过 pin 门 2000、RC→A 1000 |

## 核心契约改型（U4 必读）

**4 节点双宿直连形态下 FRER 分流不可行**：StreamSplitter 复制的帧继承原包的 `InterfaceReq`
（L3 按路由已定 eth0），两份从同一网卡出去，B 树份在邻居交换机入口被 vlanIdFilter 剪掉
（sw2 全程 0 包）。RelayInterfaceSelector.cc L45：有 InterfaceReq 直接照发，不查表。
INET 全部 showcase/validation 的 FRER source 都是单宿——多宿 talker 分流无原生机制。

**改型（802.1CB 现实形态）**：装配 bundle 时把参与 RC 的双宿 ES 拆成
`TsnDevice（单口）+ 内嵌 TsnSwitch（3 口：1 口接设备、2 口接双平面）`，分流/合流发生在内嵌桥。
6 节点验证全通过（run3/run4）。净影响：
- NED 生成：RC 会话中双宿 ES → device+bridge 对；gPTP 树多一跳（内嵌桥为 BRIDGE_NODE）。
- trees 写 NED 名全路径（含内嵌桥）：`[["es1","sw1","sw2","sw4","es2"]]`。
- es2 单口 → **不需要** showcase 的统一 MAC（`*.destination.eth[*].address`）；
  **不需要**关 `macForwardingTableConfigurator`（唯一 MAC 无冲突，auto 表 + vlan 流泛洪剪枝共存，实测无风暴）。
- 若不拆桥而直接给双宿 es2 统一 MAC：auto MAC 配置器直接崩
  `Table already contains ... unicast MAC address`（run1 第一次失败）。

## 可工作语法逐字记录

### FRER 段（run3/run4 实测，U4 照抄）

```ini
*.*.hasStreamRedundancy = true
*.streamRedundancyConfigurator.typename = "StreamRedundancyConfigurator"
*.streamRedundancyConfigurator.configuration = [{name: "st0", pcp: 7, packetFilter: expr(udp != nullptr && udp.destPort == 1000), source: "es1", destination: "es2", trees: [[["es1","sw1","sw2","sw4","es2"]]]}, {name: "rc0", pcp: 6, packetFilter: expr(udp != nullptr && udp.destPort == 1001), source: "es1", destination: "es2", trees: [[["es1","sw1","sw2","sw4","es2"]],[["es1","sw1","sw3","sw4","es2"]]]}]
```
- `pcp` 键必带：决定 configurator 替换后的 encoder mapping 里的 PCP → 交换机 egress 按
  PcpTrafficClassClassifier 进对应门（ST→gate7 由 pin 排、RC→gate6 恒开、gPTP→gate0）。
- `packetFilter` 沿用 `expr(udp != nullptr && ...)` 守卫（a761dd9 教训，spike 全程无 eval_error）。
- ST 单树也进 configurator（被替换的 mapping 无法保留手工 ST 条目，二选一没有中间态）。
- 手工的 `streamIdentifier/streamCoder mapping` 行在 RC 会话中全部变死配置（被替换）；
  U4 生成时对流经 FRER 的节点可不写（写了无害但误导）。
- vlanIdFilter/merger/splitter 全由 configurator 自管，不写。

### 断链段（run4 实测，U6 照抄）

NED（网络体内，import 区加 `import inet.common.scenario.ScenarioManager;`）：
```ned
submodules:
        scenarioManager: ScenarioManager;
```
ini（单向 TX 断开，gate 下标即 ethN）：
```ini
*.scenarioManager.script = xml("<script><at t='400ms'><disconnect src-module='sw2' src-gate='ethg$o[1]'/></at></script>")
```
- `hasStatus` 不需要；双向断用 `src-gate='ethg[1]'`（mrp 例语法，未测）。
- 断门后上游持续来帧：在断口交换机 relay 层静默丢弃（interface down 不再被选），
  **不 abort**（run4：断后 1200 个 ST 帧无一进队、EXIT=0）。
- 反向（未断方向）信道继续工作；gPTP pdelay 残留交互无异常日志。

### 平面钉死段（run8 实测，无 RC 的纯 ST/BE 双平面会话用；KTD6）

```ini
*.es1.app[0].io.destAddress = "es2%eth1"
*.configurator.addStaticRoutes = false
*.configurator.config = xml("<config><interface hosts='**' address='10.0.0.x' netmask='255.255.255.x'/><route hosts='es1' destination='es2%eth1' netmask='255.255.255.255' interface='eth1'/><route hosts='es1' destination='es2%eth0' netmask='255.255.255.255' interface='eth0'/></config>")
```
- 三件套缺一不可：`%ethN` 目的地址（L3AddressResolver 官方语法）选 listener 侧接口 IP；
  手工 `<route>` 把该 IP 钉到 talker 对应平面网卡；`addStaticRoutes = false` 防 auto 路由
  （更具体的 /32）压掉手工路由。每个 talker 对每个 listener 的每个用到的平面各一条 route。
- 不配时的默认行为（run5）：一切单播走 **talker eth0（最小库端口）所在平面**，确定性；
  若「平面 A」恰为各节点最小端口侧，可零配置直接对齐——U4 可先断言再决定是否下发 xml。
- **macTable.forwardingTable 静态下发钉不动平面**（决定点在 talker L3 出口）。
  语法本身有效且 vlan-less 形态可用（run1/run2 实测）：
  `*.sw1.macTable.forwardingTable = [{address: "es2", interface: "eth1"}]`
  ——仅在「关 auto 配置器后交换机内选路」场景用得上，平面选择不归它管。

### TAS pin 门与 R-TAG 开销（U5/U8 注意）

```ini
*.sw2.eth[1].macLayer.queue.transmissionGate[7].initiallyOpen = true
*.sw2.eth[1].macLayer.queue.transmissionGate[7].offset = 0ns
*.sw2.eth[1].macLayer.queue.transmissionGate[7].durations = [4800ns, 495200ns]
*.sw2.eth[1].macLayer.queue.transmissionGate[7].enableImplicitGuardBand = false
```
- **经 configurator 的流（含单树 ST）帧上多 4B R-TAG（802.1R）**：512B 帧的线上时长从
  570B/4560ns 变 574B/4592ns。spike 直接按 4800ns 开窗通过；4560ns 窗未实测失败与否，
  但零余量窗 + implicit guard band 关闭下 4592>4560 必然跨窗——**U5 排窗与 U4 的 Z3
  packetLength 必须把 +4B 计入 FRER 会话的 ST/RC 帧开销**（58B→62B）。

## 实测数字汇总（收/发；尾包在途差 1~2 属正常，U8 判据须容忍）

| run | 形态 | ST 发→收 | RC 发→收 | 备注 |
|-----|------|---------|---------|------|
| run1 | 4 节点直连+FRER 叠加 | 2001→2000（走 gate0！） | 1001→1000 | 押注① FAIL 形态：mapping 被替换 |
| run2 | 同上+pcp 键 | 2001→2000 过 gate7 | 1001→1000 过 gate6 | 编码共存 OK；但 B 树 0 包（分流废） |
| run3 | 6 节点桥接（健康） | 2001→1999 | 1001→1000 | merger dropped=1000；双平面各 1000 |
| run4 | 6 节点+断链 400ms | 2001→799（断点在 ST 路由） | 1001→**1000** | merger dropped=400；gPTP 无 abort |
| run5 | 4 节点无 FRER 默认 | 2001→1999 | 1001→1000 | 全落 A（talker eth0 侧） |
| run6/7 | %eth1 / +optimizeRoutes=false | 2001→2000 | 1001→1000 | 仍全落 A：路由钉不动 |
| run8 | 手工路由 xml | 2001→1999（B 平面过 pin 门） | 1001→1000（A 平面） | 平面钉死三件套生效 |

## 坑列表

1. **StreamRedundancyConfigurator 整体替换 mapping**（`.cc` L296/309/318/329/351/373）：
   identifier/decoder/encoder/merger/splitter/vlanIdFilter 全量重写流经节点，与手工 ini 条目
   不可共存——要么全交它管（带 pcp 键），要么全手工（manualconfiguration showcase，复杂度爆炸）。
2. **双宿 talker 分流废**：splitter 复制帧继承 InterfaceReq；两份同口而出，B 份被邻居
   vlanIdFilter 剪掉——收包数看起来正常（去重掩盖），只有查 B 平面交换机计数才会发现。
   **验收 FRER 必须查两平面各自的转发计数，不能只看 sink 收=发。**
3. **统一 MAC × auto MacForwardingTableConfigurator 崩**：`Table already contains ...`；
   桥接改型后不需要统一 MAC，此坑绕开。
4. **MacForwardingTable 按 (vid,address) 精确匹配无 vlan0 回退**（`.cc` L118）：vlan 流查表
   miss→泛洪→邻居 vlanIdFilter 剪枝（FRER 树因此自然成立）；vlan0/untagged 命中 auto 表不泛洪。
   桥接形态 4 桥成环但无风暴（实测）。
5. **es2 跨口收帧**：目的 MAC=eth1 的帧从 eth0 进来照收（run6 收 2000）——INET 主机不严格
   校验入口 MAC，别拿「收到了」当「走对了平面」的证据。
6. **scavetool 过滤语法**：`-f 'module=~"**.app[*].io" AND name=~"packetSent:count"'`
   （裸 `name(...)`/字符串会 Parse error）；列值加 `-l`；EV 日志（dumpRoutes 等）在
   `cmdenv-express-mode=true` 下不可见，诊断跑要显式关。
7. **远端 zsh**：`echo ====` 会炸（equals 展开）；分隔符引号包住。多层引号嵌套时把查询
   写成宿主机脚本文件再 `opp_env ... -c "bash script.sh"` 最稳。
8. **FRER 恢复窗口**：StreamMerger `bufferSize` 默认 10（序列号窗/流）。对称双平面时延差
   ≈0 无碍；若两平面时延差超过 10 帧在途量会漏删/误删——装配时保持默认即可，诊断时知道有它。

## 对后续单元的三条最重要实现指令

1. **U4（FRER 装配）**：存在 RC 流时——(a) 双宿 ES 一律拆 device+内嵌桥（ethN 映射、gPTP
   树、trees 路径全部按拆后拓扑生成）；(b) ST/RC 全部写进 `streamRedundancyConfigurator.
   configuration`（带 `pcp` 键 + udp 守卫 packetFilter + NED 名 trees），不再写手工
   identifier/coder mapping；BE 不进配置（untagged pcp0 天然走 gate0）；(c) FRER 会话帧
   开销 58B→62B（+4B R-TAG），传导给 Z3 约束与 U5 关窗算术。
2. **U6（断链轮）**：NED 加 `scenarioManager: ScenarioManager;`（+import），断链
   `xml("<script><at t='T'><disconnect src-module='X' src-gate='ethg$o[N]'/></at></script>")`，
   N 即 ethN、无需 hasStatus；判 RC 存活查 sink 计数，判「A 份确实死了」查断点下游平面
   交换机 queue[6] 计数停在断链时刻。
3. **U3/KTD6（无 RC 会话的平面锁定）**：INET 默认把 ST/BE 全送 talker eth0（最小库端口）
   平面——先断言该平面是否即推导用的平面 A；不是则下发三件套（`%ethN` destAddress +
   configurator 手工 `<route>` + `addStaticRoutes=false`）。macTable 静态表钉不动平面，别走那条路。
