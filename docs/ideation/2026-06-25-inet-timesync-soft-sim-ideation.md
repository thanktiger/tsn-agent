# INET 时钟同步软仿对接 — ideation

Created: 2026-06-25
范围：在时钟同步阶段，把当前拓扑图 + 时钟树组装成一个可跑的 INET gPTP 软仿，从拓扑侧底部弹出框触发，把同步偏差结果取回展示。不含真实硬件硬仿的落地（只为它留入口）。

---

## 一、接地先把事实问清楚（boss 的问题，逐条有答案）

这次最大的价值在这——下面每条都对过 `../inet` 源码、现有 `inet_*.rs` 集成、`timesync_nodes` 表、web 研究。

- **振荡器能作输入吗**：能。agent 现在生成的节点就是 `TsnSwitch`/`TsnDevice`/`TsnClock`，clock + gPTP 已预接好。`ConstantDriftOscillator`（`driftRate @ppm`）和 `RandomDriftOscillator`（`initialDriftRate` + `changeInterval` + `driftRateChange` + 上下限）都在 `../inet/src/inet/clock/oscillator/`。但**数据库没有任何振荡器/漂移列**，这部分参数得新找来源。
- **组装还缺哪些参数**：`timesync_nodes` 已有 GM、master/slave 端口、`sync_period`→`syncInterval`、`measure_period`→`pdelayInterval`、`port_ptp_enabled`。**缺**：①每节点振荡器类型 + 漂移率（ppm）②`nominalTickLength`（典型 10ns）③链路传播时延（`EthernetLink.length`，默认 10m≈50ns）④`sim-time-limit`（仿多久）⑤`simtime-resolution = fs`（gPTP 硬性前提，不设 pdelay 精度不够）。
- **坑**：`one_step_mode` 库里有，但 INET 的 gPTP **只支持 two-step**——这个字段喂不进去，得忽略或告知。`offset_threshold`/`mean_link_delay_thresh` 不是 INET 输入，是**事后判定阈值**。
- **能否实时取数**：不能。INET/OMNeT++ Cmdenv 是 batch，跑到 `sim-time-limit` 结束才出 `results/*.sca` + `*.vec`，没有官方流式输出（OMNeT++ 6.4 的实时 MCP 接口只在 GUI Qtenv，不适用远端 headless）。进度感只能靠 `cmdenv-express-mode` 的进度行。
- **结果格式**：核心是 `.vec` 里的 **`timeDifference:vector`**（gPTP 模块算出的「本节点时钟 vs GM」偏差时间序列，`module =~ "**.gptp"`）。另有 `timeChanged:vector`（clock 原始时钟时间）、`pdelay:vector`、`gmRateRatio:vector`。
- **太多要不要大模型解析**：不要。典型 gPTP 软仿（sim=1s、syncInterval=125ms、十几个节点）`.vec` <1MB、几百行。正解：远端用 `opp_scavetool export -F CSV` 抽 `timeDifference`（或直接行解析），算每个 slave 的 `max/mean |offset|`，对 `offset_threshold` 判定。只有「超阈值了，为什么」这种异常解释才值得喂大模型。

**一句话结论**：软仿 = 现有拓扑骨架 + 每节点振荡器漂移 + gPTP master/slave 端口（来自时钟树）+ `simtime-resolution=fs`，跑完抽 `timeDifference` 算偏差汇总。现有 ssh/scp 远端执行器整套可复用，`inet_bundle` 需要从「能加载」扩成「带时钟配置的真仿真」。

---

## 二、关键约束（不是选项，是地基）

1. **触发只能走前端按钮 → Rust Tauri 命令**。agent(worker) 只有 MCP 白名单工具，没有 Bash/ssh，无法触发远端仿真。这恰好和你「按钮放面板里」的设计一致。
2. **现有 INET 三模块全部可复用、且 memory 标了「勿删、2026-09 复审」**——本特性正是它们的启用契机：`inet_remote.rs`（ssh/scp + 超时排空 + unreachable/load_failed 分类）拿来即用；`inet_verify_command.rs` 的命令骨架照搬；只有 `inet_bundle.rs` 要扩。
3. **复用 unreachable vs load_failed 的错误分型**（code-review P1，别合并）：ssh 255/无退出码→环境问题「工程保持原状」；exit 1..254→拓扑/配置跑不起来。软仿再加一类：跑成功但结果取回/解析失败。
4. **远端主机当前写死** `100.104.38.106` / `zhang` / inet at `/home/zhang/.local/bin/inet`（env 可覆盖），多主机/UI 配置是 deferred。

---

## 三、Topic axes（6 个轴）

1. 仿真参数来源（缺的那几类参数从哪来）
2. bundle 生成扩展（inet_bundle 从「能加载」→「带时钟配置」）
3. 结果取回与解析（timeDifference 抽取 + 偏差汇总）
4. 结果展示（面板「时钟同步」tab 里怎么呈现）
5. 面板重构 + 触发 UX（三 tab + 阶段门控 + 软/硬仿按钮）
6. 软仿 vs 硬仿 + 主机配置（边界与留口）

---

## 四、设计方向（按轴，已排序，带依据）

### 轴 1 — 仿真参数来源 ⭐ 最该先定

**A1（推荐）场景预设 + 全局默认，先不做逐节点 UI。** 振荡器类型/漂移率/链路时延/sim-time 这些缺失参数，先给一套合理默认（如全节点 `RandomDriftOscillator`、`driftRate=uniform(-100ppm,100ppm)`、`nominalTickLength=10ns`、链路 `length=10m`、`sim-time-limit=1s`、`simtime-resolution=fs`），按场景（箭载/通用）可有不同预设。软仿按钮旁给一个「仿真参数」轻量表单覆盖全局值。
*依据*：direct——库无振荡器列；clockdrift showcase 正是用全局 `**.oscillator.driftRate = uniform(...)`。*为何*：最快能跑出第一个结果，避免一上来就做逐节点参数 UI 的大工程。

**A2 逐节点振荡器参数落库 + UI。** 给 `timesync_nodes` 加 `oscillator_type`/`drift_rate`/`tick_length` 列，节点属性 tab 里可编辑。
*依据*：reasoned——真实场景不同晶振漂移不同。*为何*：更真，但是 schema 变更 + UI 大改，应作 A1 之后的增量，不首发。

**A3 agent 经对话设漂移。** 让大模型在时钟同步阶段经 MCP 工具给节点设振荡器参数。
*否决（搁置）*：agent 没有「仿真参数」的领域工具，且和你「软仿要手动触发、不自动」的意图相反；A1 的表单已够。

### 轴 2 — bundle 生成扩展

**B1（推荐）新增 `build_timesync_sim_bundle`，与现有 `build_inet_bundle` 并存。** 现有的只产 loadability ini（写死 1000us、无时钟）。新函数读 `timesync_nodes` + 拓扑 + 轴 1 的参数，产带 `simtime-resolution=fs` / `**.oscillator.*` / `*.gptp.masterPorts=[...]`（从 master_port 列映射）/ `bitrate`（styles_json speed）的真仿真 ini。
*依据*：direct——`inet_bundle.rs` 当前 omnetpp.ini 只有 `[General]`+express，无任何 clock/gptp。*为何*：软仿和加载验证是两种 caliber，分开比给老函数加 flag 干净（符合「单路径不双轨」）。

**B2 复用同一 bundle 函数加 `mode` 参数。** 一个函数按 mode 产 loadability 或 sim ini。
*否决*：两种产物的字段差异大（sim 多十几项时钟配置），塞一个函数会变成 if-mode 双轨，违背项目「拒绝冗余兼容」原则。B1 更清爽。

### 轴 3 — 结果取回与解析

**C1（推荐）远端 `opp_scavetool` 导 CSV，只回传汇总。** 跑完在远端 `opp_scavetool export -f "module=~'**.gptp' AND name=~'timeDifference:vector'" -F CSV`，scp 回 CSV（或直接 ssh 管道拿 stdout），Rust 侧算每 slave 的 `max/mean |offset|`。
*依据*：external（web 研究确认 scavetool 是标准管道）+ direct（远端已装 INET，scavetool 必在 PATH）。*为何*：在源头过滤，不传整个 `.vec`；结果小、判定确定。

**C2 回传整个 `.vec` 在 app 内行解析。** `.vec` 数据段是文本（`<id> <event> <simtime> <value>`），可不依赖 scavetool 直接解析。
*依据*：external（.vec 文本格式可解析）。*为何*：少依赖 scavetool，但要自己处理 `.vci` 索引和 vector 声明行；作为 scavetool 不可用时的兜底，不首发。

**C3 新增 caliber `timesync_simulated` + 结构化结果。** `RemoteRunOutcome` 现在只有 `exit_code + output_tail`，扩出 `{per_node: [{mid, max_offset_ns, mean_offset_ns, converged}], overall}`。
*依据*：direct（现结构不取数值）。*为何*：这是「真结果消费」与现有「只看退出码」的本质区别，必须新建路径——和轴 4 展示直接对接。

### 轴 4 — 结果展示（面板「时钟同步」tab）

**D1（推荐）偏差汇总表 + 判定徽标，先不做时序图。** 每个 slave 一行：节点名 / max|offset| / mean|offset| / 是否 ≤ `offset_threshold`（绿/红）。顶部一句总判定「同步收敛 / N 个节点超阈值」。
*依据*：direct（`timesync_nodes.offset_threshold` 已有判定阈值）。*为何*：表 + 判定就能回答「这套时钟树同步得好不好」，是最小有用展示；时序图是增量。

**D2 offset-over-time 折线图。** 把 `timeDifference:vector` 画成每节点偏差随时间收敛曲线。
*依据*：external（gPTP showcase 的标准呈现就是这条曲线）。*为何*：直观、漂亮，但要引图表库 + 传时序数据，作 D1 之后的增量。

**D3 异常时喂大模型解释。** 仅当有节点超阈值，把汇总（不是原始 vec）给大模型生成「为什么 ES-3 没收敛 / 建议怎么调」。
*依据*：reasoned + external（OMNeT++ 6.4 有「诊断时钟同步异常」showcase）。*为何*：呼应你「太多要不要大模型解析」——答案是只在异常解释这一步用，不啃原始数据。

### 轴 5 — 面板重构 + 触发 UX（你已给得很具体，这里是落点确认 + 补缺）

**E1（地基，按你的描述实现）三 tab 重构。** `ConfigTabId` 从 `node-detail|link-detail` 改成 `node-props|time-sync|flow-planning`（节点属性/时钟同步/流量规划）。点节点→展开面板 + 切「节点属性」tab；点链路→无响应（移除 `onEdgeClick` 选中）；默认收起；阶段到 time-sync 且确认时钟树后，可打开面板切「时钟同步」tab 看到软/硬仿按钮。
*依据*：direct（`workspace-pane/index.tsx` 的 `CONFIG_TABS`/`activeConfigTab`；memory 记此面板「为流功能预留」）。*为何*：这是你点名要的，是其余轴的承载容器。

**E2 软仿按钮的门控（需要补的判断）。** 「时钟同步」tab 的软仿按钮，启用条件 = 阶段在 time-sync **且**时钟树已确认（GM 已设、`verify_time_sync` 过）。未满足时按钮置灰 + 提示「先确认时钟树」。面板默认收起，但确认时钟树后可由用户手动展开（不自动弹）。
*依据*：direct（你的描述「确认时钟树之后可以打开」）。*为何*：把「什么时候能软仿」用确定性条件钉死，避免没数据就触发。

**E3 面板显隐与选中解耦。** 现在面板「有选中项才渲染」。软仿入口要常驻「时钟同步」tab，得让面板能在「无选中节点」时也打开（一个独立的「展开/收起」状态，不再只由 `selectedTopologyItem` 驱动）。
*依据*：direct（`index.tsx:684` 现在 `{selectedTopologyItem && ...}`）。*为何*：这是你「默认不展开、确认后可打开」与现有「点节点才出」之间的真实差异，重构必须处理。

### 轴 6 — 软仿 vs 硬仿 + 主机配置

**F1（推荐）软仿先做实，硬仿留按钮占位。** 「时钟同步」tab 放两个按钮：软仿（本期做实，走远端 INET batch）+ 硬仿（占位，点了提示「待接入真实硬件」）。
*依据*：direct（你说「软/硬仿按钮即可」，软仿先做）。*为何*：硬仿涉及真实设备，边界大，先把软仿闭环跑通。

**F2 主机配置先沿用写死 + env。** 远端主机保持 `100.104.38.106`/env 覆盖，先不做 UI 多主机配置。
*依据*：direct（现状写死，多主机 deferred）。*为何*：你的开发机固定，UI 主机配置是新需求（且碰「外部主机配置」要先问你），不首发。**注意**：若软仿要在产品里给别人用，主机配置会变成必须项——这是要单独立项的 fork。

---

## 五、否决 / 搁置一览

- **agent 自动触发软仿（时钟树生成后即跑）**——你明确不要；且 agent 无 shell 通道。
- **实时/在线流式取数**——INET headless 不支持，按 batch 做。
- **大模型解析原始 `.vec`**——结果量小，只在异常解释用大模型。
- **逐节点振荡器 UI（A2）/ 时序折线图（D2）/ 多主机配置（F2 的反面）**——都是 A1/D1/F2 首发之后的增量，不是不做，是排后面。
- **给 `inet_bundle` 加 mode 双轨（B2）**——违背单路径原则，改用并存的新函数。

---

## 六、fork 决策（boss 2026-06-25 已定）

1. **参数来源** → **A1**（场景预设 + 全局默认，软仿按钮旁轻量表单覆盖）。
2. **首发展示深度** → **D1**（汇总表 + 判定徽标，时序图 D2 排后）。
3. **硬仿** → **F1**（占位按钮，点了提示待接入）。
4. **主机配置** → **现在就做 UI 多主机**（非默认；主机/用户/inet 路径可在 UI 配置并持久化，不再只靠写死+env）。
5. **build_inet_bundle 处置** → **移除/替换**。已核实 `verify_inet` 在 lib.rs 注册但前端/agent 从未调用（src 里只有测试断言它「未被调用」），`build_inet_bundle`（只产 loadability ini）是事实死代码。新 sim bundle **直接替换**它、新软仿命令替换 `verify_inet`；`inet_remote.rs`（ssh/scp 套件）留用。→ 轴 2 从「B1 并存」收紧为「替换 + 删 loadability 路径」，更合单路径原则。

---

## 七、下一步：进 ce-brainstorm

收敛范围（已纳入上面决策）：

> **A1（场景预设参数 + 覆盖表单）+ B1'（新 timesync sim bundle 替换并移除 loadability bundle/verify_inet，复用 inet_remote）+ C1/C3（scavetool 抽 timeDifference + 新 caliber 结构化结果）+ D1/D3（汇总表判定 + 异常才用大模型）+ E1/E2/E3（三 tab 重构「节点属性/时钟同步/流量规划」+ 软仿门控 + 面板显隐解耦）+ F1（硬仿占位）+ UI 多主机配置（替代 F2）**

落地后它会是项目第一个「INET 真结果消费者」，启用那三个标了「2026-09 复审」的 INET 模块（其中 build_inet_bundle/verify_inet 被替换），也是个强 `/ce-compound` 候选。
