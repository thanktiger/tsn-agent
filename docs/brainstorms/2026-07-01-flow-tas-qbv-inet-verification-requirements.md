---
date: 2026-07-01
topic: flow-tas-qbv-inet-verification
---

# 流量 + TAS/Qbv 规划 + INET 软仿验证 需求

## Summary

解冻 `flow-template`（流量规划）阶段，落地一条完整闭环：录入 ST/BE 流（本期对话录入 + 共享 DB/校验闸；面板表单录入紧接后续 PR）→ 让 INET 的门控表配置器**真算** 802.1Qbv 门控表（GCL）→ INET 软仿**实测** jitter/丢包/时延判通过。数据模型与路由从第一天为 802.1CB 留双平面 A/B 槽位，本期不实现 FRER 逻辑。测试至少覆盖 `docs/prototypes/TSN典型组网测试方案_20260527.docx` 的 8 用例，并新增一个 ST+BE 混合场景。

## Problem Frame

INET 时间同步软仿已跑通（工程 DB → INET bundle → 宿主机 HTTP 服务跑 OMNeT++ → CSV → app 侧判收敛）。但 INET 的真正价值是**带流量的仿真**——时延与调度，而这一段一直停在 `flow-template` 占位阶段：`src/agent/agent-adapter.ts` 本地拦截该阶段、切过去是死胡同（代码注释"flow-template 暂下线"），flow MCP 工具未定义，SKILL 是休眠占位。

这一期把这段接通。核心不是"再做一个仿真"，而是把产品从"能验时钟同步"推进到"能规划流量调度并验证调度是否成立"。规划引擎的选择是这一期的分水岭：docx 已把 8 个 Qbv 用例每跳门窗写死，最省事的做法是把窗口逐字搬进 INET 只做验证——但那样产品只是个搬运工。boss 定调走 INET 求解器真算 GCL，docx 窗口降为对账靶，这样对计划外的新拓扑/新流集也能自动出表，能力不封顶。

## Key Decisions

**规划引擎是 INET 求解器，不是写死窗口。** App 把流集合翻译成 INET `.ini` 约束面，交门控表配置器综合 GCL，再读回每端口 `transmissionGate` 的 durations/offset。求解器优先 `Z3GateScheduleConfigurator`（SAT，保证 maxLatency/maxJitter），失败或 libz3 不可用时退 `EagerGateScheduleConfigurator`（贪心兜底）。docx 写死的门窗降为对账靶——综合结果与文档窗口比对，match 上证明参数选对，对不上暴露约束翻译或求解器问题。

**成功判据是软仿实测，不是排程对账。** INET 软仿实际量出 per-stream 时延（`meanBitLifeTimePerPacket`）、抖动、收发差，达标（jitter<1us、0 丢包、时延符合规划）才算通过。docx 门窗对账退为**辅助信号**（规划正确性交叉验证），不当通过闸。允许"等价而非逐字"——同约束可能多组合法解或整体相位平移，对账不做逐字比对。

**流是单表 + class 判别器，不做类型分叉。** 一张流表用 `class`（ST/BE/RC）区分：ST=pcp7、BE=pcp0 只是 PCP 取值不同；RC 是 `redundant=true` + 推导出 A/B 两条不相交路径的变体。`redundant`/`paths` 槽为 FRER 预留，本期对 Qbv/BE 用例空置，克制不为它写逻辑（避免休眠死代码）。

**一条 bundle 生成器，不分叉。** 把 `src-tauri/src/inet_sim_bundle.rs` 的 `build_timesync_sim_bundle()` 抽成带 mode 的单一生成器，流量+TAS 作为 mode 下一段可选 `.ini`，复用同一个 `build_port_eth_map()`（门索引单一事实源，`(node,db_port)→ethN`）+ 同一传输 + 同一族解析。门映射是唯一会静默毁掉排程的东西，第二个生成器复制它必漂移。`ShaperFragment` 抽象接口延后——本期只有 TAS 一个整形，先把 TAS 段隔离成独立函数，等第二个整形（CBS/Qci/preemption）出现再提接口。

**路由从双平面链路推导，门窗锚定 ethN。** 流不持久化显式路径，声明 talker/listener（+双平面时的 plane），路由由 `topology_links` 结构列 + 最短路推导；宇航精简双平面下 (talker, listener, plane) 唯一确定路径。门窗一律锚定 `build_port_eth_map` 给的 ethN，杜绝 db_port 泄漏。数据模型留"可选显式路径覆盖推导"的口子但本期不实现。

**写入走单一插入 + 校验闸；本期只上 agent 入口，面板表单挪后续 PR。** 会话 agent（flow MCP 工具）录入本期落地，且从第一天就建成"单一插入助手 + 校验闸"这一承重共享核心，防"加写入路径漏列"的历史坑（对齐 `topology_links` 曾因 LinkAdd 漏写端口列致节点掉出时钟树的教训）。面板表单是独立 UI 面、不增加对 INET 闭环的验证覆盖，故挪到紧接的后续 PR，经同一插入助手接入。

## Actors

- A1. **用户/操作员** — 经对话或面板录入流、触发"规划"与"软仿"、读结果判据。
- A2. **会话 agent** — 把对话意图经 flow MCP 工具写入流表；无 shell，不直接跑仿真。
- A3. **写入层** — 本期 flow MCP 工具录入 + 共享插入/校验闸；面板表单为后续 PR，经同一插入助手接入。
- A4. **Rust 规划/软仿命令层** — 组装约束面、调 INET 配置器读回 GCL、生成 bundle、跑传输、解析结果判据。
- A5. **INET 门控表配置器** — Z3/Eager，综合 GCL（本产品调用，非本产品实现）。
- A6. **INET 软仿** — 实测 per-stream 时延/抖动/丢包。
- A7. **宿主机 HTTP 服务**（`services/inet-sim-http/`，100.104.38.106:19090）— 跑固定 opp_env 命令、返回原始 CSV（libz3 由 pinned nix env 已提供，服务不负责安装）。
- （外部）**T10 测试仪** — 硬件真机裁决者，在本产品之外；软仿实测数值不等于其判决。

## Key Flows

F1. **录入流。** **Trigger:** 本期用户在对话里描述流（面板表单录入为后续 PR，届时经同一校验闸）。→ 过同一校验闸（周期能否整除门控周期、报文长度是否超链路 MTU、PCP 是否冲突、talker/listener 在拓扑里是否连通）→ 校验通过写流表；不通过即拒并指出违规字段。**Covers R3, R4, R5, R6.**

F2. **TAS 规划。** **Trigger:** 用户在流量规划阶段触发"规划"。→ 由流集合 + 推导路由组装 INET `.ini` 约束面 → INET 配置器（Z3 主，退 Eager）综合 GCL → 读回每端口 `transmissionGate` durations/offset 落进 flow-plan artifact → 与 docx 期望门窗对账（等价即通过，仅辅助信号，不阻断）。求解不可行或求解器不可用时明确报因（哪条流/哪个约束）并判 FAIL，不落空表。**Covers R7, R8, R9, R10.**

F3. **软仿验证。** **Trigger:** 用户触发"软仿"。→ `build_sim_bundle` 带流量+TAS 段生成 bundle（复用门映射与传输，**pin 住 F2 综合出的 GCL：写死 `transmissionGate` durations/offset 并禁用配置器**）→ HTTP 跑 OMNeT++ → 解析 per-stream 时延/抖动/丢包 → 判 jitter<1us & 0 丢包 & 时延符合规划；ST+BE 混合时额外判 BE 不干扰 ST。空/短结果一律 FAIL 不染绿。**Covers R13, R14, R15, R16.**

F4. **（预留，本期不实现）CB 冗余。** RC 流填 `redundant` + 推导 A/B 两条投影 → 接 INET `StreamRedundancyConfigurator`。本期仅保证 schema 与路由已备好双路径，逻辑留下一周期。**Covers R17.**

## Requirements

**阶段解冻与路由**

R1. 解冻 `flow-template` 阶段作为一个可评审的原子改动，以下须同步接通：`src/agent/agent-adapter.ts` 的本地拦截、休眠 SKILL、`src/topology/topology-service.ts` 里的 flow MCP 工具名、硬编码 skill id（`["tsn-topology","tsn-time-sync","tsn-flow-planning"]`），**以及 agent-adapter.ts 的输出侧仿真守卫**（`sanitizeClaudeAssistantText` / `isUnsupportedSimulationClaim` / `mentionsFlowStageAsCurrent`——它们会把 agent 提"仿真/流量规划阶段"的话改写成"未接入 runner"，不同步改会让阶段跑得起仿真却被改写成否认，正是本条禁止的半活态）。落地后 main 上该阶段不得半活（模型放行但无工具，或有工具但路由拒）。

R2. 该阶段保留稳定 id `flow-template`；不新增 skill id、不改现有三阶段的 id 与 schemaVersion。

**流数据模型与录入**

R3. 流以单表 + `class` 判别器建模，`class ∈ {ST, BE, RC}`；ST/BE 以 PCP 取值区分（ST=pcp7、BE=pcp0）。字段至少含五元组、周期、报文长度、发送数量、PCP、talker、listener。

R4. 表结构含 `redundant`（bool）与 `paths`（A/B 可空）两个 FRER 预留槽；本期对 ST/BE 用例空置，不为其编写行为逻辑。面板表单仅在 `class=RC` 时显示这两个字段，ST/BE 下隐藏（避免为空置字段增加视觉噪声、也不误导 RC 已支持）。

R5. 本期流经会话 agent（flow MCP 工具）录入，写入走单一插入助手 + 单一校验闸；该共享核心本期即建成。面板表单录入为后续 PR，须经同一插入助手接入。任何写入路径（含后续面板）不得旁路端口/结构列。

R6. 录入校验闸在写入前拒绝非法流并指出具体违规字段：周期须整除门控周期、报文长度不超链路 MTU、同端口 ST/BE 的 PCP 不冲突、talker/listener 在当前拓扑中连通。面板路径被拒时表单保留、违规字段就地标红、无需重填其余字段（对话路径见 AE1）。

**TAS 规划（INET 求解器）**

R7. 规划由 INET 门控表配置器综合 GCL：App 组装 `.ini` 约束面（每流 pcp/gateIndex/source/destination/packetLength/packetInterval/maxLatency + gateCycleDuration；`maxLatency` 取值见 Dependencies 决策），调配置器后读回每端口 `transmissionGate` 的 durations/offset 落进 flow-plan，不由 App 自算门窗。验证阶段（F3/R15）须 **pin 住这张 GCL**：把读回的 durations/offset 写死进验证 bundle 并禁用配置器，使软仿跑的就是规划落库那张表，而非重跑配置器得到的另一组合法解——由此 flow-plan artifact 是承重事实源，R15"时延符合规划"比对的是验证真跑的表。

R8. 求解器阶梯：优先 `Z3GateScheduleConfigurator`（保证 maxLatency/maxJitter，宿主机已验证可用），Z3 求解失败时退 `EagerGateScheduleConfigurator`。所用求解器种类与是否带约束保证须随 GCL 记录（出处），供结果区分。

R9. 综合结果与 docx 期望门窗做对账，作为规划正确性的辅助信号；对账不阻断流程、不作通过闸。等价谓词须明确定义：两 GCL 等价 iff 对 `gateCycleDuration` 做一次全局循环相移后，每端口每门的开区间集合相同。真正不同的合法解（非单次全局相移可对齐）判"mismatch → 需排查"，不判"等价通过"；不做逐字比对。

R10. 规划不可行或求解器不可用时明确判 FAIL 并给出可读原因（哪条流、哪个约束/依赖），绝不产出空或半截 GCL 静默落库。

**路由与门映射**

R11. 流路由从 `topology_links` 结构列 + 最短路推导，不持久化显式路径；双平面下由 (talker, listener, plane) 唯一确定路径（该唯一性依赖"plane 标记=物理分区"这一前提）。路径唯一（R11）与 A/B 不相交（R17）是两个不同性质，最短路本身两者都不保证——推导期须断言当前拓扑下每平面路径唯一，否则响亮失败而非静默取一条。单平面拓扑（如 5 跳线性，链路无 plane 键）走"plane 缺省=单平面"分支。数据模型保留可选显式路径覆盖的口子，本期不实现覆盖逻辑。

R12. 一切门窗锚定 `build_port_eth_map()` 给出的 ethN；路由输出以 ethN 表达，db_port 不得泄漏到路由模块之外。

**INET 软仿 bundle 与执行**

R13. 流量+TAS 软仿复用现有单一 bundle 生成器（`build_timesync_sim_bundle` 抽为带 mode 的生成器）、同一 `build_port_eth_map` 门映射、同一 HTTP 传输与解析骨架，不新写第二个 bundle 生成器。TAS 段以独立函数隔离，不提前抽 `ShaperFragment` 接口。注意：per-stream 时延/抖动/丢包须录成 per-packet **向量**（`.vec`，如 `lifeTimePerPacket:vector`）由 app 侧归约——宿主机服务现只导 `results/*.vec`（`services/inet-sim-http/runner.py`），`meanBitLifeTimePerPacket` 这类**标量**只落 `.sca`、取回为空会误触 R16 的空=FAIL；若必须用标量则需拓宽服务导 `.sca`（属服务重部署，非 app 侧改动）。

R14. bundle 开启 TAS（`hasEgressTrafficShaping=true`），ST/BE 按 PCP 映射到对应门；BE 走互补/低优先门与 ST 混跑。

**验证与结果判据**

R15. 软仿验证以实测为准：解析 per-stream 时延（per-packet 向量归约，见 R13）、抖动、收发数量，判 jitter<1us、0 丢包、时延符合规划。**流量仿真须启用与时间同步仿真同款的非理想时钟模型（drift/PHY）**——否则理想时钟下抖动地板≈0、1us 闸永不区分好坏排程，绿仿只是"INET 仿真复验 INET 求解器的保证"。明确绿仿证明的是"排程在建模时序下可行且不碰撞"，非"Z3 的约束保证被独立复验"。ST+BE 混合场景额外断言 ST 指标不因 BE 存在而劣化，且 **BE 须灌满剩余带宽（发送率达额定链路率的约定阈值 + 达吞吐地板）**，使"不干扰 ST"在真实争用下成立而非被一个 BE 涓流空洞证明。

R16. 空结果 / 收不到包 / 节点数少于预期一律判 FAIL，不得渲染为全绿。结果默认以每流 plan-vs-actual 对账呈现，失败流可展开逐跳明细（逐跳数据靠 R13 的 per-packet 向量支持——即始终采集、按需展开，而非按条件决定采不采），偏差指向出错的流/跳，而非甩原始 CSV。

**CB/FRER 预留**

R17. 本期仅保证 802.1CB 的接入面已备好：单表 `redundant`/`paths` 槽、双平面 A/B 两条不相交路径可由路由推导得到（RC/双平面下推导期须断言 A/B 节点/链路不相交，否则响亮失败——因 FRER 逻辑本身延后，此断言是下一周期在已验证不相交路由上落地的前提）；不实现帧复制/消除逻辑、不接 `StreamRedundancyConfigurator`、不做故障注入。

**测试用例覆盖**

R18. 测试覆盖 docx 全部 8 用例的可达性：3 张拓扑（双平面单跳 6ES+2SW、双平面双跳 4ES+4SW、5 跳线性 2ES+5SW）× {AS, Qbv, (CB)}；其中 Qbv 用例（single/double/linear）须能录流→规划→软仿实测判通过。CB 用例本期以预留/占位期望存在（标 xfail 或等价），不算已通过。

R19. 新增一个 docx 之外的 ST+BE 混合测试场景，验证 R15 的"BE 不干扰 ST"。

R20. docx 的期望门窗与期望结果作为唯一落地事实源固化为夹具，供对账（R9）与验证（R16）共享，测试内禁止手写重复常量。

**结果呈现、诚实边界与回归保障**

R21. 结果 UI 须在**容器级**标注本次判定为"仿真实测·非 T10 硬件判决"（在用户读到任一条结果之前即可见），而非仅每条结果的角标；求解器出处（Z3 带保证 / Eager 无保证，见 R8）随判定一并呈现，Eager 兜底的排程不得与 Z3 保证的排程呈现为同等可信。诚实边界由此从散文承诺升为可测需求。

R22. 门控表综合是分钟级操作：面板触发"规划"后，触发键在综合期间禁用（防重复派发），UI 显示进行中状态（进度/步骤/转圈的具体形态由规划期定，但"必须有进行中反馈"是本条要求）。

R23. 重构 `build_timesync_sim_bundle` 为带 mode 的生成器前，先把当前 timesync 模式的 bundle 产物（`.ini`/NED）存为 golden fixture，重构后 CI 断言语义一致——这是"既有 time-sync 阶段回归全绿"这一成功判据的具体检测机制，避免真机才发现回退了历史时序坑。

R24. 至少一个"故意坏 GCL"对照用例：喂一个应导致碰撞/丢包的排程，软仿须判 FAIL——证明 jitter<1us/0 丢包闸能区分好坏排程，而非对任何无碰撞 GCL 自动放行。

## Acceptance Examples

AE1. **Covers R6.** 用户录入一条周期 700us 的 ST 流、门控周期为 1ms（700 不整除 1000）→ 校验闸在写入前拒绝，指出"周期须整除门控周期"，流不落表，不触发规划。

AE2. **Covers R8, R10.** 约束可满足 → Z3 综合出 GCL，出处记为 Z3(带保证)。约束下 Z3 求解失败 → 退 Eager 综合，出处记为 Eager(无保证)。两者皆失败 → 判 FAIL 并报"哪条流/哪个约束不可行"，不落空表。（宿主机 libz3 已验证可用，Z3 为常态路径。）

AE3. **Covers R9.** 双平面单跳 Qbv 用例综合出的 GCL 与 docx 窗口 [32,64]us/[64,96]us 整体相位一致但相位平移了一个常量 → 对账判为"等价通过"（辅助信号绿），不因非逐字相同而报错。

AE4. **Covers R15, R16.** 软仿跑完 512B×10000 的 ST 流，收=发=10000、抖动 0.3us、时延落在规划窗口 → 判 PASS。若某流收<发或抖动>1us → 该流判 FAIL 并高亮；若 CSV 空/节点数不足 → 整体判 FAIL 不染绿。

AE5. **Covers R15, R19.** ST+BE 混合场景：BE 灌满剩余带宽（发送率达约定阈值）、ST 收=发且抖动<1us → PASS。若 BE 灌满时 ST 出现丢包或抖动>1us → 判 FAIL（BE 干扰了 ST）。BE 仅涓流（吞吐>0 但未争用）不算通过——非干扰须在真实争用下证明。

AE6. **Covers R12.** 5 跳线性用例中路由推导出 6 个出口，全部经 `build_port_eth_map` 表达为 ethN；构造一个 db_port≠ethN 的端口，门窗仍锚正确 ethN 而非 `eth{db_port}`，软仿无幻象丢包。

AE7. **Covers R24.** 喂一个故意制造碰撞的 GCL（如两条 ST 在同端口同窗口开门）→ 软仿判 FAIL（丢包或抖动>1us）。若此对照用例被判 PASS，说明闸不区分好坏排程，验证机制本身失效。

AE8. **Covers R21.** 一次软仿 PASS 后，结果面板容器级可见"仿真实测·非 T10 硬件判决"标注、且显示求解器出处（Z3/Eager）。若判定徽章与硬件通过视觉无异 → 不满足 R21。

## Success Criteria

- 8 个 docx 用例中的 Qbv 用例（single/double/linear）可端到端跑通：录流 → INET 求解器出 GCL → 软仿实测判 jitter<1us & 0 丢包 & 时延符合规划。
- 至少一个 ST+BE 混合场景验证 BE 不干扰 ST。
- 求解器出的 GCL 能与 docx 门窗对账等价通过（辅助信号），据此**检出**约束翻译/参数漂移——不宣称"证明正确"：多组合法解下"等价"仅在 R9 的全局相移模型内成立。
- 解冻后 `flow-template` 阶段在 main 上完整可用，无半活状态；既有 topology/time-sync 阶段回归全绿。
- 诚实边界成立：软仿结果明确呈现为"仿真实测"而非"硬件通过"，空/短结果不染绿。

## Scope Boundaries

**Deferred for later（以后要做，非本期）**

- 802.1CB FRER 帧复制/消除逻辑、`StreamRedundancyConfigurator` 接入、单链路故障注入验证（本期仅留 schema 与双路径路由）。
- `TsnSchedGateScheduleConfigurator`（外部 ILP，另需安装）。
- CBS/Qci/frame-preemption 等其它整形，及为其抽 `ShaperFragment` 通用接口。
- 设备下发 JSON 导出（本期 flow-plan artifact 只投影出 INET `.ini`）。
- 显式路径覆盖推导的实现（本期只留数据模型口子）。
- flow-plan artifact 与验证结果契约本期仅做 **TAS 专用**实现；泛化到 gPTP/TAS 共用（想法 5）延后到独立周期，避免本期把既有 gPTP 结果系统拉进来做跨切面。
- 流的**面板表单录入入口**延后到紧接的后续 PR（本期只做 agent 会话录入 + 共享插入/校验闸；面板经同一插入助手接入，R4/R6 的面板行为已预先固化为其规格）。

**Outside this product's identity（定位决策，不做）**

- 本产品是 TSN 控制器：规划/配置/生成设备配置/监控。真机 offset/jitter/loss 的最终通过判决由外部 T10 测试仪给出，不在本产品内实现硬件级测量或裁决。
- 与独立的外部 `@tsn/sim` 服务（100.78.48.43:19080）对接不在本期；它与 INET 软仿 HTTP 服务是不同 host、不同契约，不混用。

## Dependencies / Assumptions

- **依赖（前置，已实地验证 2026-07-01）**：Z3 路径在宿主机（`zhang@100.104.38.106`）**已可用，无需再装**——pinned `opp_env inet-4.6.0` 环境的 `.oppfeaturestate` 里 `Z3GateSchedulingConfigurator enabled=true`，`libINET.so` 已链 `libz3.so.4.15`（nix store `z3-4.15.4-lib`），四个配置器（Eager/TSNsched/Z3/AlwaysOpen）NED 齐备，且 Z3 版 gatescheduling showcase（`showcases/tsn/gatescheduling/sat`，ST+BE 混流）端到端跑通（0.2s 仿真、70029 事件、干净 finish）。离线 nix 不影响 Z3——z3 已在本地 store。R8 阶梯的 Eager 兜底因此退为纯安全网，非常态路径。
- **假设**：软仿实测数值不等于 T10 硬件判决；采用软仿当通过判据是"逼近硬件标准的仿真验证"，此张力记为显式假设，UI 呈现须与硬件判决区分。
- **假设**：宇航精简双平面下 (talker, listener, plane) 唯一确定路径；一旦出现非最短路或同 plane 多路径拓扑，纯推导不足，需回退显式路径覆盖（已留口子）。
- **假设**：门控表综合是分钟级、随流数增长，反馈环慢；录入期 + 静态可行性的确定性预检可缓解，但不替代 INET 权威结论。
- **决策（boss 定）**：喂 Z3 的 per-flow `maxLatency` 从 docx 每跳窗口预算推导——让 Z3 在与 docx 同等的时延约束下求解，R9 对账才有意义（默认取周期会让 Z3 把门放在周期内任意处，对账在 docx 用例上系统性 mismatch）。无 docx 靶的计划外流集才回退取周期（隐式 deadline）。用户可覆盖。

## Outstanding Questions

**Resolve Before Planning（阻塞规划）**

- 无——分水岭决策均已定：求解器路线（Z3 主 + Eager 兜底）、软仿实测判据、BE 完整验证、本期 agent 单入口（面板挪后续 PR）；doc-review 追加三决策已并入正文（`maxLatency` 从 docx 窗口推导、验证 pin 住规划 GCL、SimVerdict 本期 TAS 专用）。

**Deferred to Planning（规划期解决）**

- 静态可行性预检（想法 6）本期是否落地，还是只做录入期校验闸（R6）先行——取决于分钟级反馈环的实际痛感。
- `maxLatency` 覆盖是否需要在录入面板/MCP 工具暴露为显式字段（默认取值方式见 Resolve Before Planning 待定项）。
- 求解器综合在宿主机上的触发方式（复用现有软仿 HTTP 端点带 mode，还是新增端点）——实现细节，规划期定。

## Sources / Research

- `docs/prototypes/TSN典型组网测试方案_20260527.docx` — 8 用例、3 拓扑、每跳门窗与通过标准的唯一事实源。
- `docs/ideation/2026-07-01-flow-tas-qbv-inet-verification-ideation.md` — 本需求的 7 方向 ideation 来源（本期聚焦想法 1-4，5-7 为配套）。
- `src-tauri/src/inet_sim_bundle.rs`(`build_timesync_sim_bundle`, `build_port_eth_map`)、`src-tauri/src/inet_sim_command.rs`(`run_timesync_sim`, `classify_and_compute`)、`services/inet-sim-http/` — 复用基座。
- `src/agent/agent-adapter.ts`、`src/topology/topology-service.ts`、`src-tauri/src/skill_files.rs` — 解冻 flow-template 的协同改点。
- INET 4.6 TSN 门控表配置器（`Z3GateScheduleConfigurator`/`EagerGateScheduleConfigurator`/`TsnSchedGateScheduleConfigurator`）与 TAS 模块（`Ieee8021qTimeAwareShaper`/`PeriodicGate`）、FRER（`StreamRedundancyConfigurator`）官方 showcase — 规划期 INET 侧模板参考。宿主机 `showcases/tsn/gatescheduling/sat`（Z3，ST+BE 混流，TsnDumbbellNetwork）与 `.../eager`、`.../tsnsched` 是最贴近本任务的现成 `.ini`/NED 模板。
- **宿主机能力实证（2026-07-01）**：`zhang@100.104.38.106` 上 `opp_env inet-4.6.0` 已带 Z3 编译（`libINET.so`→`libz3.so.4.15`）、四配置器 NED 齐备、SAT showcase 端到端跑通。规划期 INET 侧无 libz3 安装阻塞。
