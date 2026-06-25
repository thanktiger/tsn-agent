---
title: INET 时钟同步软仿对接
date: 2026-06-25
status: ready-for-planning
origin: docs/ideation/2026-06-25-inet-timesync-soft-sim-ideation.md
---

# INET 时钟同步软仿对接

## 摘要

在时钟同步阶段，让用户能把当前拓扑图 + 时钟树组装成一个 INET gPTP 软仿，在远端 INET 机器上 batch 跑完，**验证生成的 gPTP 配置能装配、跑起来、并收敛**，把各节点相对 GM 的时钟收敛偏差取回展示（偏差量级作参考）。触发入口放在拓扑侧底部弹出框重构后的「时钟同步」tab 下。配套：删掉从未启用的 INET 加载验证死代码、把远端主机从写死改成 UI 可编辑、**把 `topology_links` 端口/速率收正为「列是事实源、styles_json 纯显示」**（软仿组装依赖干净的端口源，见 R22-R26）。

**定位（doc-review 校正）**：软仿验证的是「这套生成的 gPTP 配置能不能在 INET 里装配运行并收敛」+ 收敛后偏差量级，**不承诺评估「时钟树设计质量」**——因为漂移参数是全局合成默认（库无逐节点振荡器数据），偏差主要反映合成默认 + 树结构/同步周期的综合作用，不是真实晶振下的设计优劣。

硬仿本期只留占位按钮。

---

## 问题背景

时钟同步阶段现在能生成时钟树（GM + master/slave 端口角色），但**生成的 gPTP 配置从没在仿真里真正装配运行过**——不知道这套配置喂给 INET 能不能跑起来、能不能收敛。

项目早建了 INET 远端执行套件（`inet_remote.rs` ssh/scp），但只做过「拓扑能不能加载」的冒烟（`build_inet_bundle`/`verify_inet`，从未接进任何 UI/agent，是死代码）。INET 当初因「拓扑阶段只能验加载、区分不出好坏」被移出拓扑阶段。本特性与那次的区别：**消费真实的收敛/偏差数值（不只是 exit 0 的布尔加载结果）**，且诚实定位为「配置能跑通 + 收敛」的验证，不重复「拿加载冒烟当质量判定」的老路。

拓扑侧弹出框现在是「节点详情/链路详情」两个纯只读 tab，实际没什么用，正好借这次重构成承载软仿入口的容器。

---

## 角色

- **A1 工程师（用户）**：在时钟同步阶段，确认时钟树后想验证这套 gPTP 配置能不能跑通收敛。手动点软仿、看结果。
- **A2 远端 INET 机器**：用户自己的 Linux 机（开发期 `100.104.38.106`），装了 INET，跑 batch 仿真。
- **A3 TSN Agent 应用（Rust 侧）**：组装仿真工程、ssh 传输触发、取回解析结果。agent(worker) **不参与**触发——它没有 shell/ssh 通道。

---

## 需求

### 仿真组装与运行

| ID | 需求 |
|----|------|
| R1 | 软仿把当前 session 的拓扑（节点/链路）+ 时钟树（GM、master/slave 端口）+ 时钟同步参数（sync_period→syncInterval、measure_period→pdelayInterval）组装成一个可跑的 INET gPTP 仿真工程（NED + omnetpp.ini） |
| R2 | 仿真工程必须满足这些 gPTP 硬性前提：`simtime-resolution = fs`；每节点挂时钟振荡器；GM 与生成树的 master/slave 端口显式指定（INET 无 BMCA）；设 `**.referenceClock = "<GM>.clock"`（让各 clock 能对齐 GM 算偏差）；显式开 clock 模块 vector recording（`result-recording-modes`，否则结果为空）；设固定随机 seed（`seed-set`，结果可复现） |
| R2a | **端口号→接口名映射（feasibility blocker，planning 必须解决）**：DB 的 master/slave 端口号（来自 `topology_links.src_port/dst_port` 列——本特性已把端口改为以列为事实源，见「数据流清理」）与 INET 的 `ethN` 接口名不保证一致——现有 bundle 用 `ethg++` 按连线顺序分配门号。必须建一张 `(节点, 库端口号) → NED 门号/ethN` 的显式映射作单一事实源，让落库端口角色、NED 门号、INET `masterPorts=["ethN"]` 三者由同一映射派生。直接 `eth{db_port}` 会接错线/接到不存在的口 |
| R3 | 缺失仿真参数分两层：**(a) 场景预设固定默认（不暴露）**：tickLength 10ns、链路 length 10m、`simtime-resolution=fs`、随机 seed；**(b) 覆盖表单可配**：振荡器类型、漂移率、sim 时长。预设默认取自 INET clockdrift showcase（RandomDriftOscillator、driftRate `uniform(-100ppm,100ppm)`、sim-time 1s） |
| R4 | 软仿按钮旁提供轻量覆盖表单，暴露 3 个参数：振荡器类型（Constant/Random）、漂移幅度（ppm）、sim 时长。表单形态：tab 内可折叠区域（默认收起，展开后填，值随软仿一并提交）。R3(a) 的固定默认不暴露 |
| R5 | 软仿触发只能走「前端按钮 → Rust Tauri 命令」。复用 `inet_remote.rs` 的 ssh/scp 远端执行（超时排空、进程组杀），在远端 batch 跑 INET，跑完读结果 |
| R6 | `one_step_mode` 忽略（INET gPTP 只支持 two-step）；`offset_threshold`/`mean_link_delay_thresh` 不作 INET 输入，仅作结果展示的参考线 |

### 结果取回与展示

| ID | 需求 |
|----|------|
| R7 | 仿真跑完后取核心指标 **`timeChanged:vector`（module =~ "**.clock"，各节点本地时钟时间序列）**（注：本版 INET 已删除 timeDifference 信号，必须走 clock 模块路径）。偏差 = 该节点 timeChanged − GM 节点 timeChanged（对齐两条 vector 相减，等价 showcase 的 `lineartrend(-1)`）。用远端 `opp_scavetool` 导 CSV，只回传所需数据 |
| R8 | 对每个 slave，算**稳态段**（收敛窗口之后，首发取「sim 后半程」）的 `max/mean |offset|`，并标注是否在该节点 `offset_threshold` 参考线内。判定语义是「收敛 / 未收敛」+ 偏差量级，**不是「设计质量达标」** |
| R9 | 软仿结果结构化（每节点 max/mean offset + 是否收敛 + 总判定），新增区别于 `loadability_only` 的 caliber（如 `timesync_simulated`） |
| R10 | 错误/异常分型在现有 unreachable / load_failed 之外，再加两类：**(a) 结果为空**（scavetool 成功但导出 0 条 timeChanged——通常是模块路径/recording 配置问题，文案指向配置而非笼统失败）；**(b) 结果解析失败**。**空结果绝不渲染成「全部收敛/全绿」**——slave 行数为 0 或少于预期节点数 → 判为失败 |
| R11 | 结果用汇总表展示：每个 slave 一行（节点名 / 稳态 max|offset| / mean|offset| / 收敛徽标 + 是否在阈值参考线内）+ 顶部总判定（如「N 个节点收敛 / M 个未收敛」）。表格有三态：初始（未运行，引导文案「点软仿运行后在此查看」）/ 运行中（见 R5a）/ 有结果。不做时序折线图（排后续） |
| R12 | 结果量小（<1MB），不用大模型解析原始数据 |
| R13 | 仅当有节点未收敛/超参考线时，可把汇总（不是原始数据 + 带「漂移为合成默认」上下文）喂大模型生成解释。软仿是**诊断性**的：结果指引用户回时钟同步阶段调 GM/链路/参数，面板本身不改树 |

### 运行态与门控

| ID | 需求 |
|----|------|
| R5a | 软仿是远端 batch（数秒~数十秒）。必须有运行中态：软仿按钮置灰 + loading；表格区显示「仿真进行中…」；运行中可切 tab，切回仍见运行态。不做实时进度条（batch 无流式） |
| R17 | 阶段到 time-sync 且时钟树已确认（GM 已设 + `verify_time_sync` 通过）后，用户可手动展开面板、切到「时钟同步」tab，看到软仿/硬仿按钮 |
| R18 | 软仿**触发时**（不只按钮 enable 时）先同步重跑 `verify_time_sync`；ok=false → 拒绝软仿、提示「时钟树已变更，请重新确认」。复用现有 SNAPSHOT_DRIFT/确认闸语义，防确认后改拓扑/GM 拿陈旧树跑仿真 |
| R19 | 硬仿按钮：占位，点击提示「待接入真实硬件」，本期不做实 |

### 弹出框 tab 重构

| ID | 需求 |
|----|------|
| R14 | 拓扑侧底部弹出框的 tab 从「节点详情/链路详情」重构成**两个**：「节点属性 / 时钟同步」。（流量规划是真实阶段但本期下线无内容，等该阶段有内容再加，不本期造空 tab） |
| R15 | 点拓扑图节点 → 展开弹出框并切到「节点属性」tab；点链路 → 无响应（移除链路选中） |
| R16 | 默认打开 app 不展开弹出框。面板显隐与「是否选中节点」解耦——面板能在无选中节点时打开。展开触发器：底部边缘一条常驻可点击的 handle 条（收起后仍可见），点它展开/收起 |

### 主机配置与清理

| ID | 需求 |
|----|------|
| R20 | 远端 INET 主机从写死改成 UI 单主机可编辑：host / user / inet 路径，放在应用全局设置面板（settings drawer），持久化（落现有 `app_state` KV 表，key 如 `inet_host_config`，value=JSON），初始播种为当前写死值（`100.104.38.106`/`zhang`/`/home/zhang/.local/bin/inet`）。inet 路径自由输入（boss 接受：自用工具、信任用户）。**注意 UX**：换新主机首次 ssh 因 known_hosts 无记录 + StrictHostKeyChecking 会 unreachable，需提示用户先手动建立 host key 信任 |
| R21 | 删除从未启用的 INET 加载验证死代码，连带清全：`build_inet_bundle` 函数 + 其 8 个测试；`verify_inet` 命令 + `lib.rs` 注册行及「勿删/2026-09 复审」注释；`agent-adapter.test.ts` 两处「verify_inet 未被调用」断言 + mock 分支；更新 memory（plan-2026-06-17-003 / mvp-residue-audit）中「verify_inet 流量规划备用」描述——该路径已被本特性替代。新 timesync sim bundle 生成 + 新软仿命令替换它们；`inet_remote.rs`（ssh/scp 套件）保留复用 |

### topology_links 数据流清理（折入本特性，同 PR；非软仿核心阻塞）

当前 `topology_links` 端口/速率是「显示数据当结构事实源」：端口存在 `styles_json.leftLabel/rightLabel`、列只是写时 parse 出来的副本（PR #55 的治标解析），同一端口号两处存放、有漂移风险（上次「新增节点掉出时钟树」即此类）。本特性顺带把它收正。

**排期说明（doc-review round2 校正）**：列**现在已经填好**（PR #55 解析路径已回填），软仿读列即可跑通——**R22-R26 不是软仿核心的硬前置**，是同 PR 的质量改进。R23/R24 是纯画布 display 改造、与软仿主路径零文件交集，**排在实施最后、带独立 AE**，避免画布 regression 阻塞软仿验收。

| ID | 需求 |
|----|------|
| R22 | **列是唯一事实源**：`topology_links` 的 `src_node/dst_node/src_port/dst_port/speed` 列为结构权威；`styles_json` 收敛为**纯显示**（只留 plane 配色、role 角色）。端口号/速率不再进 styles_json |
| R23 | **删 leftLabel/rightLabel/speed**（从 styles_json 与画布 edge data）。「左/右」是 Qunee 几何遗留、会随节点拖动变；端口属于**首/尾节点**（src_port 在 src_node、dst_port 在 dst_node）。**消费者迁移清单（漏一个就破功能）**：①画布 `topology-flow.ts` + `tsn-floating-edge.tsx`（R24）②**`topology_verify.rs` 的 `link_ports_paired` 端口配对校验**——它现读 styles_json 的 leftLabel/rightLabel，删键后会对每条正常链路误报 `PORT_UNPAIRED`、压在确认闸/`topology.validate` 上；必须改读 src_port/dst_port 列（两列非 NULL=配对）③`inet_bundle.rs` 读 speed 从 styles_json（随 R21 删）④MCP `inspect` 工具描述里提 leftLabel/rightLabel 的措辞 |
| R24 | **画布端口标签改读列、按首尾锚定**：source 端点渲染 src_port、target 端点渲染 dst_port（React Flow 的 sourceX/Y、targetX/Y），几何无关。**含 Rust 查询层改动（别漏）**：`query_topology` 现在不向前端暴露 src_port/dst_port——需 `TopologyLinkRow` 加这两列（serde camelCase → srcPort/dstPort）、SELECT 加列、前端 TS 类型同步；否则删 leftLabel 后画布拿不到端口、标签全消失。改 `topology_query_command.rs` + `topology-flow.ts` + `tsn-floating-edge.tsx`。自环链路（src==dst）source/target 端点重合时给小偏移避免标签叠压 |
| R25 | **写入直写列**：`LinkAddArgs` + MCP `link_add` 工具加显式 `srcPort/dstPort/speed` 字段，直写列；更新 SKILL.md/工具指引让 agent 传显式字段。**不能与唯一 NULL 守卫同步删**：保留「显式字段缺省时 parse leftLabel 兜底 + deprecation 痕迹」过渡，**或** link_add 对 NULL 端口硬校验拒绝——绝不让「agent 漏传 + 无兜底 → 列 NULL → 时钟树又断」重演本帖起因的 bug。initialize 路径用其结构化 port_id 直写列（已是结构源） |
| R26 | 存量迁移：`ensure_topology_rekey_mid_and_ports` 的回填已一次性跑过（has_mid 守卫）。**删 leftLabel 前必须先审计**：查 `src_port/dst_port IS NULL 但 styles_json 有 leftLabel` 的行（非数字 label 当年 parse→NULL），重新回填或提示，**条件性删除**（零不可恢复行才删 leftLabel），不无条件删。dual-plane 旧库（boss 定不迁移）与本清理对账：plane 留显示不受影响，但其端口若来自旧 leftLabel 需纳入同一审计 |

---

## 关键流程

**F1 软仿主流程**：time-sync 阶段确认时钟树 → 点底部 handle 展开弹出框 → 切「时钟同步」tab →（可选）展开覆盖表单调参 → 点软仿 → 触发时重跑 verify_time_sync（R18）→ 前端 invoke Rust 命令 → 按钮置灰+loading、表格显示运行中（R5a）→ Rust 读库组装 gPTP 工程（含 R2/R2a 的端口映射、referenceClock、recording、seed）→ ssh/scp 远端 batch 跑 → scavetool 抽 timeChanged → 对齐 GM 算稳态偏差 → 回传 → 汇总表 + 收敛徽标。（覆盖 R1-R11）

**F2 异常分型**：远端连不上 → unreachable「校验暂时无法运行，工程保持原状」；INET 跑不起来(exit≠0) → load_failed + 输出尾部；跑成功但结果为空 → 「结果为空」（指向配置）；结果解析失败 → 「解析失败」。空结果不渲染成收敛。（覆盖 R10）

**F3 门控未满足 / 陈旧树**：阶段不在 time-sync 或时钟树没确认 → 软仿按钮置灰 + 提示；确认后改了拓扑/GM → 触发时 verify 重跑 fail → 拒绝并提示重新确认。（覆盖 R17/R18）

---

## 验收示例

- **AE1**：4 交换机 + 若干 ES 的时钟树（GM=ES-1）确认后点软仿 → 表格列出每个 slave 稳态 max|offset|，多数收敛、在阈值参考线内，总判定「N 个收敛」。
- **AE2**：某 slave 稳态偏差超参考线/未收敛 → 该行标红，可点「解释」让大模型（带「漂移为合成默认」上下文）给说明。
- **AE3**：远端主机关机 → unreachable，文案「校验暂时无法运行，工程保持原状」，不报「拓扑错误」。
- **AE4**：拓扑阶段（非 time-sync）打开弹出框 → 软仿按钮置灰，提示「先确认时钟树」。
- **AE5**：点拓扑节点 → 弹出框展开停在「节点属性」tab；点链路 → 无反应。
- **AE6**：设置里把主机改成另一台已建立 host key 信任的 IP+用户 → 下次软仿走新主机；重启 app 配置仍在。
- **AE7（stale 拦截）**：确认时钟树后回拓扑改一条链路 → 点软仿 → 触发时 verify 重跑 fail → 被拒「时钟树已变更，请重新确认」，不跑出结果。
- **AE8（空结果）**：bundle 漏配 recording 导致 scavetool 导出 0 行 → 报「结果为空」，**不**渲染成全绿收敛。
- **AE9（端口标签按首尾）**：一条 src_port=2、dst_port=3 的链路，画布在 src_node 那端标 2、dst_node 那端标 3；拖动节点让两端在屏幕上左右互换 → 标签仍跟节点走（不随屏幕左右变）。删 leftLabel 后端口标签不消失（query_topology 已暴露列）。
- **AE10（清理不重开断链）**：删 parse 路径后，agent 仍按旧习惯只在 styles_json 填 leftLabel、漏传显式端口 → 兜底/硬校验生效，端口列不为 NULL（或被拒并提示），时钟树不断、`topology_verify` 不误报 PORT_UNPAIRED。

---

## 范围边界

**本期做**：R1-R26 全部（R22-R26 是同 PR 的 topology_links 清理，R23/R24 显示改造排最后、不阻塞软仿核心）。

**Deferred for later（明确推迟）**：
- offset-over-time 时序折线图（D2）
- 逐节点振荡器参数落库 + 编辑 UI（A2）——本期全局默认 + 3 参数覆盖
- 让漂移随设计属性变（使偏差能区分树好坏）——本期诚实定位为「配置能跑通+收敛」，不做这层
- 硬仿做实（真实硬件对接）
- 多主机列表 + 选活动（本期单主机可编辑）
- 流量规划 tab（等该阶段有内容再加）

**Outside this product's identity**：
- agent 自动触发软仿——明确不要，且 agent 无 shell 通道
- 实时/在线流式取数——INET headless 不支持，只能 batch
- 大模型解析原始 .vec——结果量小，只在异常解释用大模型

**身份边界说明**：软仿走「前端按钮→Rust 命令」而非对话 agent，是因为 agent 无 shell——这是所有「需要 shell 的能力」（软仿、未来硬仿/INET 工作）的既定模式：**对话 agent 负责「搭树」，面板按钮负责「执行」**。不是临时妥协，是有意分工。

---

## 依赖与假设

- **PR #55（已合并）→ R25 改造，保留兜底**：PR #55 让 LinkAdd 从 styles_json parse 端口填列（治标，**且是当前唯一的 NULL 端口兜底**）。R25 改为 link_add 优先显式传端口直写列，但**过渡期保留 parse-leftLabel 兜底或加 NULL 硬校验**——不能删了兜底又没新守卫，否则重开时钟树断链 bug。软仿读列得到的端口因此干净。
- **假设**：远端机已装 INET 且 `opp_scavetool` 在 PATH；ssh 免密已配（ssh-agent/authorized_keys，无密码存储）；换主机需用户先建立 host key 信任（R20）。
- **复用**：`inet_remote.rs` 的 RemoteRunner/SshRunner、超时排空、unreachable vs load_failed 分型（过过 code-review，别重写）。
- **启用契机**：本特性是项目第一个「INET 真结果消费者」，替换删除 build_inet_bundle/verify_inet，启用 inet_remote 套件。

---

## 待澄清（留给 planning）

- **端口号→ethN 映射的确定性规则**（R2a，feasibility blocker）——planning 必须先定，否则接线必错。建议 planning 期先在远端用 gptp showcase 实跑一次，确认 .vec 里实际出哪些 `name`/module 路径，再定 scavetool filter 与端口映射。
- 稳态「收敛窗口」具体取法——首发取「sim 后半程」，避免自适应判稳的过度工程。
- 覆盖表单「漂移幅度」单值 vs 范围——倾向单值映射成对称 uniform。
- sim 工程远端清理时机——沿用 inet_remote 现有 best-effort 清理。
