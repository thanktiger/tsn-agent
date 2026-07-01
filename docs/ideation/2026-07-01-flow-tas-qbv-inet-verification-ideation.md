---
date: 2026-07-01
topic: flow-tas-qbv-inet-verification
focus: 加流（ST/BE）→ 调用 INET 做 802.1Qbv TAS 规划生成 Qbv 结果 → INET 软仿验证；预留 802.1CB；测试用例覆盖 docx 8 用例
mode: repo-grounded
---

# Ideation：流量 + TAS/Qbv 规划 + INET 软仿验证

时间同步软仿这条路已经跑通（工程 DB → INET bundle → 宿主机 HTTP 服务跑 OMNeT++ → CSV → app 侧判收敛）。这一期是在同一条路上加一段：录几条流（ST、BE，后面 RC），让 INET 出 Qbv 门控表，再软仿看是否正常。下面 7 个方向，先是几个必须现在定的架构岔口，再是几个"现在很便宜、以后很贵"的埋点。

## Grounding Context（Codebase Context）

**现有 INET 软仿（复用，别重造）**
- `src-tauri/src/inet_sim_bundle.rs`：`build_timesync_sim_bundle()` 从工程 DB 生成 `network.ned` + `omnetpp.ini`。里面的 `build_port_eth_map()` 是 `(node, db_port) → ethN` 的**门索引单一事实源**——INET 按 NED 连线顺序用 `ethg++` 分配门号，DB 端口号 ≠ ethN，直接拿 `eth{db_port}` 会错位。
- `services/inet-sim-http/`（Python FastAPI，已部署 100.104.38.106:19090）：收 bundle → 跑固定 opp_env 命令 → 回原始 CSV+exit+stderr。**薄**，解析留 app 侧。
- `src-tauri/src/inet_sim_command.rs`：`run_timesync_sim()` + `classify_and_compute`（load_failed / scavetool_failed / empty / parse_failed / converged）。传输层是 `RemoteRunner`（HttpRunner + Mock，SSH 已删）。
- **软仿由前端按钮 → Rust 命令触发，agent 没有 shell**（"agent 搭树，面板执行"）。

**数据模型**：`topology_nodes{mid, name, nodeType, x, y}`、`topology_links{linkSeq, srcNode, dstNode, srcPort, dstPort, stylesJson{plane:A|B, role}}`。**列是结构事实源，styles_json 纯显示**（plane 颜色 / role）。双平面 = 宇航精简版（line backbone + 端系统双归，无跨平面 paired 链路）。

**阶段机**：`WORKFLOW_STEPS = ["topology", "time-sync", "flow-template"]`。`flow-template`（流量规划）是**刻意休眠的占位阶段，等 Phase B 重建——是解冻，不是新建**。`agent-adapter.ts` 现在本地拦截 flow-template 不放行给模型。skill id 硬编码 `["tsn-topology", "tsn-time-sync", "tsn-flow-planning"]`。MCP 工具按阶段定义在 `topology-service.ts`（flow 工具尚未定义）。

**职责边界（承重）**：本产品是 TSN **控制器**——规划 / 配置 / 生成设备下发 JSON / 监控。真机测试里 offset/jitter/loss/通过判据由外部 **T10 测试仪**测。但 INET 软仿本身**能**量出仿真里的时延/抖动/丢包——所以软仿的诚实承诺是"生成的配置能装配、能跑、在仿真里行为正常"，而非硬件通过判决。**空/短结果一律判 FAIL，绝不染绿。**

**INET TAS 能力（外部调研，关键）**：INET 4.6 自带门控表配置器，能**直接综合 GCL**（即 INET 自己会"规划"，不只是验证）：`EagerGateScheduleConfigurator`（贪心，快，可能失败）、`Z3GateScheduleConfigurator`（SAT 求解，保证 maxLatency/maxJitter，需 libz3）、`TsnSchedGateScheduleConfigurator`（外部 ILP）。三者共用 `.ini` 的 `configuration=[{pcp, gateIndex, application, source, destination, packetLength, packetInterval, maxLatency}]` + `gateCycleDuration`，产物是每端口的 `transmissionGate[n].durations`+`offset`。开 TAS：`hasEgressTrafficShaping=true`。ST=pcp7、BE=pcp0（流识别→PCP）。时延=`meanBitLifeTimePerPacket`，丢包=sent vs received。FRER 走 `StreamRedundancyConfigurator`+`FailureProtectionConfigurator`（自动算双路）或手动 splitter/merger + R-TAG。**另有一个独立的外部 `@tsn/sim` 服务（100.78.48.43:19080，task_validate/task_start/task_metrics_query），host 和契约都不同，别和 INET 软仿混为一谈。**

**docx 关键约束**：8 个用例，3 张拓扑——双平面单跳（6ES+2SW）、双平面双跳（4ES+4SW）、5 跳线性（2ES+5SW）；single{AS,Qbv,CB}、double{AS,Qbv,CB}、linear{AS,Qbv}。Qbv 用例**已给死每跳门窗**（单跳 E6[32,64]us+SW1[64,96]us；双跳加 SW3[96,128]；5 跳 [32,64]…[192,224]），ST 流 UDP period 1ms、512B×10000、期望 0 丢包 + jitter<1us + 时延符合规划。CB：RC 流源端复制过 A/B、目的端消除、单链路故障 0 丢包。

## Topic Axes

- **A. 流建模与录入** — ST/BE/RC 流数据模型 + 录入（五元组、周期、PCP、talker/listener、DB 表、MCP 工具、agent 会话录入）
- **B. TAS 规划引擎** — GCL 由谁怎么算：INET 配置器 vs 外部 solver vs 自算 vs 逐字取计划窗口；规划在哪跑；Qbv 结果 artifact 是什么
- **C. INET 软仿执行与结果** — 扩 bundle 带流量+TAS、复用传输、解析时延/抖动/丢包、诚实边界、空=FAIL
- **D. 拓扑↔流 路由与门映射** — 流在 topology_links 上选路、双平面路径选择、`(node,port)→ethN` 门映射单一事实源
- **E. CB/FRER 预留 + 测试用例覆盖** — 结构上让 802.1CB 以后能插进来；覆盖 8 个用例的夹具/场景

## Ranked Ideas

跳转：[1 兑现给定门窗](#1-本期定位兑现给定门窗--inet-验证不自造排程器) · [2 单一流模型](#2-单一-stream-模型--class-判别器frer-作休眠槽位) · [3 一条 bundle](#3-一条-bundle-生成器--门映射复用绝不分叉) · [4 路由即投影](#4-流路由--双平面链路的投影门窗锚定-ethn) · [5 一份 artifact](#5-一份-flow-plan-权威-artifact--统一-simverdict-结果契约) · [6 确定性闸](#6-录入期--静态可行性两道确定性闸把慢仿真反馈环压到毫秒) · [7 8 用例夹具](#7-8-用例种子-fixture-即验收事实源)

### 1. 本期定位：INET 求解器综合门控表，docx 窗口作对账靶而非输入

**Description：**（boss 2026-07-01 定调）本期主路径就是**让 INET 的门控表配置器真正算出 Qbv 门控表**——App 把流集合翻译成 INET `.ini` 的约束面（`configuration=[{pcp, gateIndex, application, source, destination, packetLength, packetInterval, maxLatency}]` + `gateCycleDuration`），交给配置器综合，再从结果读回每端口的 `transmissionGate[n].durations+offset` 落进 flow-plan。**门窗是求解出来的，不是从 docx 抄进去的。** docx 里写死的那些窗口反过来当**对账靶**：用求解器跑 8 个用例，把综合出的 GCL 与文档窗口逐 (node,port) 对照——能 match 上就证明规划正确、参数选得对，对不上就暴露约束翻译或求解器的问题。求解器优先用 `Z3GateScheduleConfigurator`（SAT，保证 maxLatency/maxJitter），失败/不可用时按阶梯降到 `TsnSchedGateScheduleConfigurator`（ILP）或 `EagerGateScheduleConfigurator`（贪心）。综合出的 GCL 再进 INET 软仿验证（0 丢包 / jitter<1us / 时延=规划）。

**Axis：** B

**Basis：** `direct:` boss —"不要使用写死的参数，我们需要通过规划结果来 match 到这样的参数，所以还是需要 inet 的求解器"；grounding —"INET 4.6 自带配置器能直接综合 GCL……Z3 保证 maxLatency/maxJitter……需 libz3"。docx 窗口是期望结果（验收靶），不是规划输入。

**Rationale：** 这决定了整期的核心能力和依赖面。让 INET 求解器当规划引擎，App 就真正做到"调用 INET 做 TAS 规划生成 Qbv 结果"，而不是一个把文档窗口搬运一遍的翻译器；对计划外的新拓扑/新流集也能自动出表，能力不封顶。用 docx 的已知窗口当对账靶，等于给规划引擎一套带标准答案的回归——求解结果能复现文档窗口，才敢信它在没有标准答案的场景也对。这也把"静默产出自洽但错误的 GCL 落库"提前拦在对账这一步。

**Downsides：** 求解器进入**关键路径**，随之而来的必须在规划期解决：①~~`libz3` 要在宿主机上装稳~~ **已实地验证 2026-07-01 满足**——宿主机 `opp_env inet-4.6.0` 已带 Z3 编译（`libINET.so`→`libz3.so.4.15`，nix store），SAT gatescheduling showcase 端到端跑通，离线 nix 不阻塞；Eager 退为纯安全网；②门控表综合是分钟级、且随流数增长，反馈环慢（想法 6 的静态可行性闸能缓解，但不能替代）；③求解器输出与 docx 窗口未必逐窗一致——同一组约束可能有多组合法解，对账要允许"等价而非逐字相同"（比如整体相位平移），否则会把正确解误判成失败，对账口径本身要在 brainstorm 里定清。

**Confidence：** 74%

**Complexity：** Medium-High

```mermaid
flowchart LR
  P["流集合<br/>(五元组/周期/PCP/maxLatency)"] --> C["翻译成 INET 约束面<br/>configuration[] + gateCycleDuration"]
  C --> S["INET 配置器综合 GCL<br/>Z3 → TsnSched → Eager 阶梯"]
  S --> G["读回 transmissionGate<br/>durations + offset → flow-plan"]
  G --> X["对账靶: 与 docx 窗口比对<br/>(等价即通过, 非逐字)"]
  G --> I["INET 软仿验证<br/>0丢包/jitter<1us/时延=规划"]
  X -.证明参数选对.-> I
```

### 2. 单一 stream 模型 + class 判别器，FRER 作休眠槽位

**Description：** 流表设计成一张表、一个判别字段，而不是 ST/BE/RC 三种类型分叉：`{id, class: ST|BE|RC, five-tuple, periodUs, payloadBytes, count, pcp, talker, listener, redundant: bool, paths: [A?, B?]}`。ST 就是 pcp7、BE 就是 pcp0——本质只是 PCP 取值不同；RC/FRER 就是 `redundant=true` 且路由推导出 A/B 两条不相交路径。本期 `redundant`/`paths` 字段留着但对 Qbv/BE 用例为空，MCP 录入工具和 agent 会话录入都带上这个可空槽。这样 case1/case2 里的 CB 用例以后只需**填数据 + 接 `StreamRedundancyConfigurator`**，不动 schema。

**Axis：** A

**Basis：** `external:` INET `.ini` 把 ST/BE/RC 都当 pcp-tagged 流处理，FRER 是配置器开关（INET 4.6 FRER 文档）；`direct:` 用户诉求"预留需要 CB 的支持" + docx CB 用例"RC 流源端复制过 A/B、目的端消除"。

**Rationale：** 单表 + 判别器让 8 个用例（single/double/linear × AS/Qbv/CB）变成"同一份 JSON 填不同字段"，路由/发射/解析/UI 都只有一条代码路径，避免类型分叉引起的组合爆炸。而"以后加 CB 时改流表 schema"是迁移最痛的动作（对齐过 dual-plane 旧库不迁移的教训），现在流表还没数据、加这两个可空字段近乎零成本。

**Downsides：** 单表判别器要求 UI/校验按 class 条件显隐字段（RC 才显示 redundancy），比三张独立表稍微绕一点；`paths` 槽在本期空置，需要克制别提前为它写逻辑（否则就成了休眠死代码）。

**Confidence：** 82%

**Complexity：** Low-Medium

### 3. 一条 bundle 生成器 + 门映射复用，绝不分叉

**Description：** 不为流量另写第二个 bundle 生成器。把 `build_timesync_sim_bundle()` 抽成 `build_sim_bundle(mode)`，流量+TAS 作为 mode 开关下的一段可选 `.ini`（`hasEgressTrafficShaping=true`、apps 按 ST=pcp7/BE=pcp0、门控段），复用同一个 `build_port_eth_map()` 当门索引事实源、同一个 `run_*_sim()` 传输、同一族解析骨架。再往前一步：把每种整形协议做成 `ShaperFragment` 接口（`emit_ini(flow_plan) -> ini_lines`），bundle 生成器只负责把已注册的 fragment 折叠进去——以后加 CBS/Qci/preemption 就是注册一个 emitter，不改 bundle 生成器本体。

**Axis：** C

**Basis：** `direct:` grounding —"`build_port_eth_map()`……是门索引的单一事实源……DB 端口号 ≠ ethN"；`external:` INET 的 `.ini` 整形配置形状（pcp/gateIndex/gateCycleDuration）在各 shaper 间统一。

**Rationale：** 门映射是唯一会**静默**毁掉排程的东西（开错端口的门 → 幻象丢包），第二个生成器复制这段逻辑，几乎注定在 ethN 分配变动时漂移出一个"仿真说丢包但排程看着对"的诡异 bug。一条生成器 + fragment 折叠是整期真正的脊梁：brief 里点名的 CBS/Qci/preemption 以及 FRER 都骑这条脊梁，现在流量代码还没写、抽取成本最低。

**Downsides：** 抽 `ShaperFragment` 接口有过度设计风险——本期只有 TAS 一个 shaper，接口是为"未来的第二个"设计的；需要 boss 判断是先直接扩一段 `.ini`、还是当场立接口。折中：先扩一段、但把 TAS 那段物理隔离成一个函数，等第二个 shaper 出现时再提接口。

**Confidence：** 80%

**Complexity：** Medium

### 4. 流路由 = 双平面链路的投影，门窗锚定 ethN

**Description：** 流不持久化自己的显式路径，而是声明 talker/listener（+ 双平面时的 plane），路由由 `topology_links` 结构列 + 最短路（复用已验证的 `MacForwardingTableConfigurator` 纯拓扑最短路）推导。宇航精简双平面下，(talker, listener, plane) 唯一确定一条路径——case2 的 `E1→SW1→SW3→E3`(A) / `E1→SW2→SW4→E3`(B) 直接落出来。所有门窗一律锚定到 `build_port_eth_map` 给出的 **ethN**，路由模块的输出类型就设成 `Vec<(node, ethN)>`、只能经该映射构造，让"db_port 泄漏出路由模块"在类型上就不可能。CB 天然拿到 A/B 两条投影。

**Axis：** D

**Basis：** `direct:` docx case2 双路径 + 数据模型"无跨平面 paired 链路"（两条不相交路径无法只从端点推断，plane 是消歧键）；`external:` `MacForwardingTableConfigurator` 从纯拓扑最短路算转发表、无需流量。

**Rationale：** 手工逐跳录路径是最易错的一步，而双平面拓扑让路径可推导；把路由做成链路的投影而非独立数据，避免流路由和链路各存一份漂移（对齐 topology_links 是事实源、styles_json 纯显示的教训）。门窗锚 ethN 是提前干掉整期最难查的 bug——off-by-one 门映射在小用例过、到 5 跳线性用例才崩。同一套 derive() 供 TAS/CBS/FRER 共用，FRER 的 A/B 不相交路径从第一天就被路由跑通，不是以后补。

**Downsides：** "推导 vs 显式路径"有真实张力：一旦以后出现非最短路、或同 plane 内多路径的拓扑，纯推导会不够，需要回退到显式路径覆盖。本期宇航精简双平面无此问题，但要在数据模型上留"可选显式路径覆盖推导"的口子，别把推导焊死。

**Confidence：** 75%

**Complexity：** Medium

### 5. 一份 flow-plan 权威 artifact + 统一 SimVerdict 结果契约

**Description：** Qbv 结果就一份权威 DB artifact（`flow-plan`：流 + 推导路径 + 门控表 durations/offset + 出处 schedulerKind/guarantee），喂给 INET 的 `.ini` 和以后下发硬件的设备 JSON **都是它的纯投影函数**、按需生成、绝不各存一份真相——沿用"列是真相、显示是投影"的既有纪律。结果侧把 `classify_and_compute` 泛化成一个协议无关的 `SimVerdict{status, metrics:{latency?, jitter?, loss?, converged?}, evidence}`：gPTP 填收敛、TAS 填时延/抖动/丢包、FRER 填单故障丢包，共用同一个面板、同一条"空=红"规则、同一个 eval 采集 JSONL。结果按**流×跳的 plan-vs-actual 对账表**呈现（"计划窗口说这帧 [64,96]us 到，仿真 71us±0.2 → PASS"），偏差指向出错的那一跳，而不是甩一屏 CSV。

**Axis：** C

**Basis：** `reasoned:` 把既有 columns=truth/styles=display 纪律延伸到排程——改一个门窗只该改一处 DB 行，`.ini` 和设备 JSON 作为投影自动一致，避免"仿真跑的是 ini-A、下发的是 JSON-B"这类经典漂移；`direct:` grounding 点名的 `classify_and_compute` 状态集 + eval 采集管道已存在可复用，"空 sim=FAIL 不染绿"是承重规则。

**Rationale：** 一份 artifact 保证"软仿验的对象"就是"硬件将拿到的对象"，让 T10 硬件裁决成为公平对照而非重新编码。统一 SimVerdict 让 TAS/FRER 验证复用时间同步已建好的面板、失败分类学和 eval 存储，零新增管线——脊梁在于**不把结果界面重造三遍**。plan-vs-actual 对账让用户能区分"求解器 bug / 路由 bug / 真实时序违规"。

**Downsides：** 泛化 SimVerdict 要小心别把 gPTP 特有的收敛语义和 TAS 的时延语义硬塞进同一形状导致两边都别扭；投影函数要保证"改一处"真的只改一处，否则投影就名不副实。

**Confidence：** 76%

**Complexity：** Medium

### 6. 录入期 + 静态可行性两道确定性闸，把慢仿真反馈环压到毫秒

**Description：** 在花几分钟跑远端 INET 之前，加两道纯 Rust 确定性闸。①**录入期校验**（类似 topology.validate）：周期能否整除 gateCycleDuration、报文长度是否超链路 MTU、ST/BE 的 PCP 有没有撞、talker/listener 在拓扑里到底连没连——录入即拒、指出具体违规字段。②**静态可行性闸**：沿推导路由累加每跳传输时延 + 门窗对齐，判断 512B/period1ms 的 ST 流在给定门窗下理论上能否 0 丢包/jitter<1us/时延=规划；不可行直接红判并指出瓶颈跳，可行才付编译+运行代价。周期谐波化（hypercycle = 各流周期 LCM）的非谐波告警也并进这道闸。

**Axis：** A

**Basis：** `direct:` grounding —"编译+运行要几分钟" + 既有产品模式"慢仿真前先跑廉价确定性 validate"（topology.validate、apply 后 validate）；`reasoned:` 流量录入的数值陷阱（单位、周期、优先级）严格多于拓扑，等一个 60s 远端跑完才拿到一个空 CSV 是全 app 最差的反馈环。

**Rationale：** sim 往返是慢而贵的一步，每一个在录入/静态期拦下的错都省一次分钟级白跑和一屏看不懂的 CSV；给用户"为什么不可行"的可读理由而非空结果。这道闸也是弱模型/agent 录入时的确定性护栏。

**Downsides：** 静态可行性模型是"近似判死"——它能判明显不可行，但不能替代 INET 的权威结论（时钟漂移、排队细节它不建模），要明确它只做 pre-flight 淘汰、绿了仍必须跑 INET，别让用户误以为静态绿=通过。

**Confidence：** 72%

**Complexity：** Medium

### 7. 8 用例种子 fixture 即验收事实源

**Description：** 把 docx 的 8 个用例固化成可一键加载的确定性种子夹具：3 张拓扑（单跳 6ES+2SW、双跳 4ES+4SW、线性 2ES+5SW）各定义一次，再用矩阵展开器在共享拓扑上叠 {AS, Qbv, CB} 的流集 + 配置开关和**期望值**（每跳期望门窗、期望结果 0 丢包/jitter<1us/时延=规划，或 CB 单故障 0 丢包）。这份期望值是 docx 的唯一落地事实源，同时喂给三处：求解结果对账靶（想法 1——综合出的 GCL 与文档窗口比对）、静态可行性闸（想法 6）、INET 验证结果对账（想法 5）——测试里禁止手写重复常量。加未来的 CB profile = 加一行矩阵，不是加一个夹具文件。

**Axis：** E

**Basis：** `direct:` 用户诉求"测试用例至少需要支持 docx" + docx 8 用例 = 3 张可复用拓扑 × 小 profile 集；`reasoned:` 项目已有场景/种子模式（scenario system、app-data 播种），手工逐例搭 UI 与之矛盾且让本就慢的 sim 往返更难反复跑。

**Rationale：** 这个功能的验证**就是**跑这 8 个用例；设置若靠手搭，团队会很少跑、回归静默落地。种子夹具让"排程还灵不灵"从一下午变成一条命令，且每个未来 shaper（CBS/Qci/preemption）都白捡这 3 张拓扑当现成靶场。期望值单一事实源杜绝各处硬编码漂移。

**Downsides：** 夹具要跟着 topology_links 列变动自动更新（别写死 8 个文件），否则加一列就 8 处要改；CB 用例本期只能落成 `xfail`/占位期望（FRER 逻辑还没实现），要标清楚是"预留期望"而非"已通过"。

**Confidence：** 80%

**Complexity：** Low-Medium

## 执行前提（不是想法，是解冻这一阶段的现实）

解冻 `flow-template` 不是改一个文件：`agent-adapter.ts` 的本地拦截、占位 SKILL、`topology-service.ts` 里尚未定义的 flow MCP 工具名、硬编码 skill id 要**同步一起动**——漏一个就得到半死不活的阶段（模型放行了但没工具，或有工具但路由仍拒）。当作一个可评审的原子改动落地，保证 main 上这个阶段永不半活。

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | 把 flow 做成 topology 的子模式而非独立阶段（F3） | 与"解冻既有稳定 flow-template 阶段"冲突（skill id/session 快照形状硬编码），churn 大于价值；其"流需要链路图在场"的洞见并入路由/UI |
| 2 | DAW 钢琴卷帘式流量录入（F5） | 一期 UI 过度设计；hypercycle 量化告警的有用内核已并入想法 6 |
| 3 | Marey/甘特时间-距离门窗可视化（F5） | 有价值的调试视图但一期 scope 蔓延，延后；门冲突可先靠对账表暴露 |
| 4 | EXPLAIN FLOW 查询计划式 artifact（F5） | 与想法 5 的 plan-vs-actual 对账重叠，独立 EXPLAIN 延后 |
| 5 | 内容寻址的 sim 缓存（F5/F6） | 过早优化——sim 耗时尚未被证明是瓶颈，等验证瓶颈再做 |
| 6 | unsat-core / MaxSAT 松弛诊断（F5） | 仅在走 solver 路径且不可行时相关；轻量版并入想法 6，完整版延后 |
| 7 | 从门窗+跳数自动反推 maxLatency（F2） | 只在 solver 路径下才需要，并入想法 1 的可选 solver 分支，非独立 |
| 8 | 编译器 -O 档位 solver 升级（F5） | 并入想法 1 的降级/升级阶梯（Eager→Z3→verbatim） |
| 9 | FRER 混沌故障注入矩阵（F5） | CB 验证的正确形状，但 CB 是下一周期；期望并入想法 7 夹具，逻辑延后 |
| 10 | 门控表出处 provenance 独立想法（F3） | 并入想法 1/5（artifact 带 schedulerKind/guarantee 字段） |
