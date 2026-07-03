---
title: U10 flow+TAS 验收清单（docx 8 用例 + ST+BE 混合 + 坏 GCL 对照）
date: 2026-07-02
updated: 2026-07-03（三类流 ST/RC/BE：CB 用例 3/6 翻正 + 混跑/故障态条目 + 三类真机清单，
  见 docs/plans/2026-07-03-001-feat-flow-three-class-st-rc-be-plan.md U8）
module: flow-planning / inet_sim
plan: docs/plans/2026-07-01-002-feat-flow-tas-qbv-inet-plan.md
layer: 真机验收（不进 CI 门；CI 回归见各单元 mock 单测 + flow_verify_command e2e）
---

# U10 验收：两层分清

R18-R20/R24 的验证分两层（plan U10）：

- **CI 回归层（已落地，随各单元）**：`MockPlanClient`（U7 `flow_plan_command` 单测）/
  `MockRunner`（U8 `flow_verify_command` 单测）喂**冻结的** GCL/CSV 做确定性断言——录流校验闸
  （`flow_verify`）、路由推导（`flow_route`）、GCL 解析、对账谓词（`flow_reconcile`）、per-stream
  classify、坏 GCL 判 FAIL、以及 **plan→verify 端到端接缝**（`e2e_plan_then_verify_pipeline` /
  `e2e_bad_gcl_fails_verification`）。2026-07-03 三类流周期追加：**六组合矩阵夹具**
  （`flow_verify_command::tests::matrix`，plan→verify 管线逐行锁定进 Z3 流集合 / plan 产物 /
  轮次数与轮名 / judged 判据面）：`matrix_pure_st_single_round_st_criteria`、
  `matrix_st_be_single_round_complement_and_be_connectivity`、
  `matrix_st_rc_three_rounds_st_healthy_only`、`matrix_all_three_classes_full_criteria`、
  `matrix_pure_rc_three_rounds_all_gates_open`、
  `matrix_pure_be_single_round_connectivity_and_diag_line`。这些**不打宿主机**、进 CI 门。
- **真机验收层（本清单，人工，不进 CI 门）**：3 拓扑 × Qbv 端到端（录流→plan_tas→verify_tas
  PASS）+ ST+BE 混合 + 坏 GCL 对照 + 三类混跑/断链故障态（2026-07-03 起），真打宿主机
  `100.104.38.106:19090`。宿主机单运行锁把用例×分钟级 plan+verify 串行化（含 RC 的验证为
  三轮，墙钟 ×3），故不进 CI。

## docx 三个 Qbv 用例（唯一事实源，取自 `docs/prototypes/TSN典型组网测试方案_20260527.docx`）

8 个用例里 AS（案例 1/4/7）属时间同步阶段、CB（案例 3/6）**已支持（软仿，2026-07-03 三类流
周期翻正）**，**Qbv 三例（案例 2/5/8）是本阶段验收靶**。三例共享同一条 ST 流：

- 五元组：srcIP `192.168.1.1` / dstIP `192.168.1.2` / srcPort `1024` / dstPort `1024` / UDP。
- 流量周期 `1ms`（=门控周期）、报文 `512B`、发送数 `10000`；通过标准：收=发（0 丢包）、抖动<1us、
  端到端时延符合调度规划。门控周期恒 1ms。

| 案例 | 拓扑 | GM | ST 路径（平面 A） | 逐跳门窗（每跳 egress 开门 [start,end]，1ms 周期内） |
|---|---|---|---|---|
| 4.1.2 | 双平面单跳 6ES(E1-E6)+2SW(SW1/SW2) | E4 | E6→SW1→E3 | E6:[32us,64us]、SW1:[64us,96us] |
| 4.2.2 | 双平面双跳 4ES(E1-E4)+4SW(SW1-SW4) | E1 | E1→SW1→SW3→E3 | E1:[32us,64us]、SW1:[64us,96us]、SW3:[96us,128us] |
| 5.1.2 | 5 跳线性 2ES(E1/E2)+5SW(SW1-SW5) | E1 | E1→SW1→SW2→SW3→SW4→SW5→E2（6 跳） | E1:[32,64]、SW1:[64,96]、SW2:[96,128]、SW3:[128,160]、SW4:[160,192]、SW5:[192,224]（us） |

时钟同步：GM 如上，同步周期 `2^-3s`=125ms、链路测量周期 500ms（AS 案例）。

**门窗→GclEntry**：门窗 [a,b]us = 1ms 周期内 [a,b) 开、其余闭。对账（`flow_reconcile`）比的是「每
端口每门开区间集合，允许全局相移」——门窗即该门的开区间（如 E6 门 = 开区间 (32us,32us 长)）。

**核对**：三例都是**单平面单路径**（ST 走平面 A 一条路径），不触发 U5「同 plane 等价多路径」歧义
（plan Open Question 消解——docx 双跳也是单条 E1→SW1→SW3→E3，非 A/B 同平面多路径）。CB（案例 3/6）
用双平面 A/B——**2026-07-03 已支持（软仿）**：RC 流按 802.1CB FRER 装配
（`StreamRedundancyConfigurator` + 显式 A/B trees，路径由 `derive_redundant_routes` pin），
验证跑健康+断A+断B 三轮（AE1/AE2）。

**落地建议**（真机验收 + 可选 CI 对账加固）：把上表写成 `src-tauri` 内一个共享 const（case→流集
+ 逐跳期望 GclEntry），U7 对账单测与本清单验收共用、grep 断言无重复硬编码（R20）；`flow_reconcile.rs`
已有基于本表案例 4.1.2 门窗的对账单测（docx_case1_gate_windows_reconcile）。

## 验收步骤（每用例）

前置：宿主机薄服务在跑（`/sim/healthz` 绿）；app 设置里配了软仿 HTTP 地址；工程处于
flow-template 阶段（U4 解冻后）。

1. **录流**：经会话 agent 的 flow 工具（U3）或直接 `/db/flow/add_stream` 录入该用例流集。
   校验闸拒绝非法流（周期∤门控周期 / 报文>MTU / talker 不在拓扑 / 同 pcp 异 class）。
2. **规划**：触发 `plan_tas`。期望 `status=ok`、`solver=Z3`（带保证）、`gateCount>0`；
   `flow_plans` 落库。不可行用例期望 `status=solver_failed` 且 flow_plans 空（R10）。
3. **对账（辅助）**：综合 GCL 与 docx 门窗跑 `flow_reconcile`——等价（全局相移）即绿；真正不同
   合法解记 mismatch→排查（不阻断）。
4. **验证**：触发 `verify_tas`。期望每流 `pass=true`：收=发（0 丢包）、jitter<1us、时延≤窗口。
   `status=ok`。空/短结果**绝不**渲染绿（R16）。

## 用例矩阵

| # | 拓扑 | 流 | 期望 |
|---|---|---|---|
| 1-N | docx Qbv 用例（双平面单跳 6ES+2SW / 双平面双跳 4ES+4SW / 5 跳线性 2ES+5SW） | docx 定 | plan ok + verify 每流 PASS |
| R19 | 5 跳线性 或 双跳 | **ST + BE 混合**（新增场景）：ST pcp7 + BE pcp0 灌满剩余带宽 | ST 收=发且 jitter<1us（BE 灌满下不劣化，互补关窗生效）；BE 仅涓流不算通过 |
| R24 | 任一 | **故意坏 GCL**（两 ST 同端口同窗开门碰撞） | verify 判 FAIL（证闸能区分好坏排程） |
| CB | 双平面 RC | 冗余流（802.1CB FRER） | **已支持（软仿，2026-07-03 翻正）**：健康轮去重后收=实发±在途容差且无重复帧（07-03 plan AE1）；断A/断B 故障轮零丢包（AE2）。CI 锚点：`matrix_st_rc_three_rounds_st_healthy_only` / `matrix_pure_rc_three_rounds_all_gates_open` |
| 混跑 | 双平面 | **ST+RC+BE 三类混跑**（07-03 plan AE4，2026-07-03 新增） | 健康轮三类各按各判据全绿（ST 三项 + RC 两态 + BE 连通/送达率随行）；ST 劣化判 FAIL 不被 RC/BE 绿灯掩盖。CI 锚点：`matrix_all_three_classes_full_criteria` |
| 故障态 | 双平面（含 RC） | **断链故障轮**（07-03 plan AE2/R9） | 含 RC 的验证恒三轮（健康+断A+断B）；故障轮只判被断链覆盖的 RC 流，ST/BE 报告态；断点落时钟树边/ST 路由时响亮标注；未覆盖 RC 标「未测容错」 |
| 纯 BE | 任一 | **纯 BE 流集**（07-03 plan AE5/R10） | 规划出「无需门控」（no_gating 清表）、验证单轮门全开照跑、BE 连通判；顶层 gPTP 诊断行在（R15）。CI 锚点：`matrix_pure_be_single_round_connectivity_and_diag_line` |

## 真机验收清单：三类流 ST/RC/BE（2026-07-03 plan U8，人工、不进 CI）

前置同上（`/sim/healthz` 绿、app 配好软仿 HTTP 地址、工程处于流量规划阶段），且时间同步阶段已设
GM。三个场景按序跑；含 RC 的验证是三轮顺序提交，墙钟按单轮分钟级 ×3 预估。

### 场景 1：三类混跑 + 断链故障态（07-03 plan AE1/AE2/AE4、R9/R14/R15）

1. **建会话**：双平面单跳拓扑（docx 图 4-4 形态：6 ES(E1-E6)+2 SW(SW1/SW2)；最小可用
   4 节点双平面：2 ES 双宿 + 平面 A/B 各一台 SW）。设 GM（docx 案例 4.1.2 为 E4）。
2. **录流**（同一对端系统，E6→E3 型）：
   - ST：pcp7、周期 1ms、512B、count 10000、maxLatency 按 docx 门窗推导。
   - RC：pcp6、同 talker/listener——录入应成功且落 `redundant=1`/`paths`（非双平面拓扑录 RC
     应被 `NOT_DUAL_PLANE` 拒绝，AE3 反例可顺手核）。
   - BE：pcp0、灌满剩余带宽（短周期大帧，涓流不算数，R14）。
3. **规划**：期望 `status=ok`、`solver=Z3`、`gateCount>0`（只有 ST 进 Z3；RC/BE 不出现在
   综合工程里）。
4. **验证**：期望三轮 [健康轮、断A轮、断B轮] 全绿。**PASS 判读**：
   - 健康轮：ST 三项达标（收=实发±在途容差 / jitter<1us / 时延≤窗口）；RC 去重后收=实发
     ±在途容差且无重复帧；BE 有收包（送达率随行展示，不判）。
   - 断A/断B轮：被断链覆盖的 RC 流零丢包（±在途容差）；ST/BE 行显示「仅健康轮判」报告态。
   - 每轮 gPTP 诊断行可读且健康轮显示全节点收敛 ≤ 阈值（R10 判定：混合场景健康轮诊断行
     全收敛即通过；劣化 → 触发「gPTP 独立通道」备选评估，回报 boss，不自作主张实现）。
   - 断链轮标注：双平面单跳上断点链路**预期出现**「时钟树边」响亮标注（结构性避不开，
     KTD2）——标注在＝符合预期；断后下游时钟劣化在诊断行照实报告，不判 FAIL。
   - 多 RC 流时未被断点覆盖的流标「未测容错」（KTD8 口径）——单流场景不应出现。
   **FAIL 判读**：RC 收>实发（重复帧未消除）/缺口超容差（真丢包）；ST 任一项超标（不得靠
   放宽判据染绿，AE4）；任一轮 status 为 load_failed/empty（busy 是环境冲突，重试而非 FAIL）。

### 场景 2：纯 BE 灌流一轮（07-03 plan AE5、R10 必测）

1. 新会话（任一拓扑），只录 BE 灌流流（pcp0，灌满带宽量级）。
2. **规划**：期望 `status=no_gating`（「无需门控」），flow_plans 清空。
3. **验证**：期望单轮（无 rounds）、门全恒开跑。**PASS 判读**：BE 有收包；**顶层 gPTP 诊断行
   在**且显示时钟在 pcp0 队列争用下仍全节点收敛 ≤ 阈值（R10 的核心目的——gPTP 与 BE 共
   pcp0 门，此场景专测争用不拖垮时钟）。**FAIL 判读**：BE 零收包；诊断行显示节点未收敛
   （→ 触发 gPTP 独立通道备选评估，回报 boss）。

### 场景 3：纯 ST 回归（基线不劣化）

1. 既有纯 ST 会话（docx 案例 4.1.2 形态）重跑规划+验证。
2. **PASS 判读**：单轮全绿且时延维持 27us 量级（2026-07-02 真机基线，
   `enableImplicitGuardBand=false` 生效面）；纯 ST 不生成互补关窗、pin 工程与三类改造前
   位级一致（CI 已锁：`matrix_pure_st_single_round_st_criteria`）。**FAIL 判读**：时延量级
   劣化（如回到百 us 级）→ 互补关窗误伤纯 ST 路径，回查 KTD5 生成条件。

## 真机注意（承前 U1/U6 spike + timesync 教训）

- **丢包判据「发送数」**（plan Open Question）：本期 verify 以流 `count` 为期望发送数判收=发。
  真机若源按 productionInterval 连续发（非按 count 界定），需二选一并在此钉死：①给 pin bundle 的
  source 加发送上限（=count）；②服务 verify 补导 `.sca` 的 `packetSent:count`、verify 改比对它。
  先真机 dump 一次确认 sink 侧 `packetLifeTime:vector` 的真实样本数对 count 的关系。
- **向量真实 module 路径**：classify 按 `<listener_ned>.app[<j>].sink` 后缀匹配；真机确认 sink
  app 的 packetLifeTime/packetJitter module 路径与此一致（对齐 U1 spike `server*.app[N].sink`）。
- **非理想时钟**：flow bundle 复用 timesync gPTP 同步子栈（U6 `build_sync_block`）——首次组装后
  确认抖动地板非零且有界（漂移无同步会发散→假丢包；恒 0 说明用了理想时钟）。
- **ethg[N] 门向量声明**：真机跑前确认每节点 NED 有 `ethg[N];`（KTD3，golden fixture 已覆盖）。
