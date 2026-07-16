---
title: "fix: flow-tas 软仿暖机排除（延迟发流）"
date: 2026-07-16
type: fix
origin: docs/brainstorms/2026-07-16-flow-softsim-warmup-exclusion-requirements.md
---

# fix: flow-tas 软仿暖机排除（延迟发流）

## 摘要

flow-tas 软仿改「先让 gPTP 收敛、再发流」：在生成 bundle 时给所有流量源加统一启动延迟 W，`sim-time-limit` 与 RC 故障断链时刻同步加 W，评估窗天然落在时钟收敛之后，暖机丢包从源头不再产生。判定层与故障尾量守卫维持「相对产包起点」语义、零逻辑改动。W 随同步参数缩放，仅作用于软仿 bundle，真机 pin 部署包不动。

---

## 问题框架

flow-tas 软仿是一次 INET 运行：gPTP 从 t=0 收敛，流量源也从 t=0（INET 默认 `startTime=0`）产包。默认 `RandomDriftOscillator` 开局 `initialDriftRate` 在 ±100ppm 随机取，各节点时钟一上来就有偏差；gPTP 要经过若干 `syncInterval`（首次 pdelay 还要等 `pdelayInterval`）才拉齐。这段收敛期发出的头 ~3 个 ST 包踩空 TAS 门或晚到一个门周期被丢。

判定层 `flow_verify_verdict.rs::classify` 只兜尾巴不兜开头：`in_flight_tol` 只界定 sim 结束在途尾巴，`skip_first` 只跳首个 jitter 样本（晚到一周期的暖机包不是首样本）。结果 ST 因丢包超容差、抖动=一个整周期、latency_max 被拉高而全部误判「未达标」；BE 判据宽松（`received>0`）同丢 3 却放过——这是 ST/BE 判决分裂的真因。稳态本身正确（多条 ST jitter=0、gPTP 16/16 收敛），问题只在开头暖机段。

详见 origin: `docs/brainstorms/2026-07-16-flow-softsim-warmup-exclusion-requirements.md`。

---

## 关键技术决策

**W 只在 bundle 内注入，verify 侧全程「产包窗相对」。** `flow_sim_time_s`（产包窗 T）语义不变——判定层反推实发、故障尾量守卫都继续用它，天然正确。W 是单一来源，只在 `build_flow_tas_sim_bundle` 内叠加到三个写点：源 `startTime=W`、`sim-time-limit=W+T`、RC 断链 `t=W+t_break_ns`。判定层与故障编排零改动（`t_break_ns` 在 verify 侧仍表示「从产包起点的偏移」，只在写进绝对时间断链脚本那一处加 W）。

**W = max(N × syncInterval, 下限)，N=5、下限 500ms。** 真机 spike 实测（U1）：默认参数下从节点收敛到 <200ns 仅需 ≈250ms（=2×syncInterval），且在首次 pdelay(1000ms) 之前就收敛——**收敛由 syncInterval 驱动，pdelay 非驱动因子**（短链路初始 pdelay 估计够用）。故公式弃用原 `N×max(sync,pdelay)`（pdelay 进 max 会把 W 虚高到 2.5s，10× 过度）。N=5 给 2.5× 余量抗更大拓扑。syncInterval 取生效值——`SimNodeTiming.sync_period_ms` 为 None 时用 INET 默认 125ms，不得当 0；取全体节点 max。下限 500ms 兜 syncInterval 极小的情形。（见 origin R2/R3）

**故障断链事件随 W 平移。** RC 故障轮断链属于流量时间线的一部分；不平移则断链落在发流前，尾量守卫帧数失真。平移后尾量 math 保持产包窗相对、不受影响。

**N 与下限靠真机收敛数据标定。** 起点 N=2、下限 500ms，须真机 gPTP 收敛数据坐实 W ≥ 实际收敛时刻。实现用默认值不硬阻塞，spike 确认或微调后定死。

---

## 高层技术设计

延迟前后时间线（单次 INET 运行，绝对仿真时间）：

```
现状：
  t=0 ─────────────────────────────────── sim-time-limit = T
  │ gPTP 冷启动收敛…                         │
  │ 流量源 t=0 就发 → 头~3包踩空门(暖机丢)      │
  └ 断链 t=t_break（可能落在收敛期）

延迟后：
  t=0 ───── W ──────────────────────────── sim-time-limit = W+T
  │ gPTP   │ 产包窗 T（全在收敛后，无暖机丢）    │
  │ 收敛期  │ 源 startTime=W                   │
           └ 断链 t=W+t_break（产包窗内偏移不变）

verify 侧（判定/尾量守卫）看到的仍是产包窗 [0, T]：
  flow_sim_time_s = T 不变、flow_expected_sent(T,·) 不变、frames_after_break(T, t_break, ·) 不变
```

---

## 需求追溯

- R1（源统一延迟 W，ST/RC/BE 一致）→ U2
- R2（W=N×max(sync,pdelay)+下限；真机标定 N/下限）→ U1（标定）、U2（公式）
- R3（sync/pdelay 取生效值，None 用 INET 默认非 0）→ U2
- R4（sim-time-limit = W + flow_sim_time_s）→ U2
- R5（判定层实发按产包窗 T 反推，公式不变）→ U3
- R6（仅软仿 bundle，真机 pin 部署包不动）→ U2（作用域）、U3（回归锁定）

---

## 实施单元

### U1. 真机 gPTP 收敛 spike，标定 N 与下限 ✅ 已完成

**Goal**：在宿主机 INET 软仿服务上实测代表性场景的 gPTP 收敛时刻，据此定死 N 与下限。

**Requirements**：R2

**结果（2026-07-16，宿主机 `http://100.125.25.12:19090`）**：dump ST(250us/count1万,sim2.5s)+BE bundle 投递跑通（exit 0）。解析各 clock `timeChanged` 相对 GM(es01) 的 offset：sw01/es02 均在 **t≈250ms（=2×syncInterval）收敛到 <200ns**（峰值 1108/3062ns，末值 10/0ns），且早于首次 pdelay(1000ms)。**收敛由 syncInterval 驱动、pdelay 非驱动**。据此定：`W = max(N × syncInterval, 500ms)`，**N=5**（2.5× 余量），去掉 pdelay。默认参数 W=625ms。

**Verification**：✅ t_conv≈250ms 已实测记录；W(默认)=625ms ≥ t_conv 且不过度。dump 手法沉淀于门控临时测试 `dump_flow_bundle_for_spike`（SPIKE_DUMP 门控，U2 复用后清理）。

---

### U2. bundle 内计算 W 并注入三处写点

**Goal**：在 `build_flow_tas_sim_bundle` 内以单一 W 计算延迟量，注入源 `startTime`、`sim-time-limit`、RC 断链时刻。

**Requirements**：R1, R2, R3, R4, R6

**Dependencies**：无（默认常量先行，U1 标定后回填）

**Files**：
- `src-tauri/src/inet_sim_bundle.rs`（新增 W 计算辅助 + 三处写点；改动集中在源 app 块 :1425-1442、`build_general_header` 调用处 :1279-1282、断链脚本 :1704-1714）

**Approach**：
- 新增 `pub(crate) fn flow_warmup_offset_s(timing: &[SimNodeTiming]) -> f64`：`max(N × effective_sync_ms/1000, floor_s)`，`effective_sync_ms` 在 None 时取 INET 默认 125ms（不得当 0），取全体节点 max。N、floor 定为模块常量（**N=5、floor=0.5s**，U1 标定），带注释。空 timing → 用默认 125ms。**pdelay 不进公式**（U1 实测非驱动）。
- 源 app 块：每条源加 `*.{tned}.app[{a}].source.initialProductionOffset = {W}s`（W 全流一致，含 ST/RC/BE）。用 `initialProductionOffset`（ActivePacketSource 的首包延迟），与现有 `productionInterval` 同族。
- `sim-time-limit`：`build_general_header` 收到的时长改为 `W + flow_sim_time_s(streams)`（仅 flow 路径；timesync 路径与 `SimOverrides.sim_time_s` 显式覆盖路径不受影响）。
- 断链脚本：`t='{}ns'` 的实参由 `f.t_break_ns` 改为 `W_ns + f.t_break_ns`。
- 仅改 flow-tas bundle，pin 部署包生成路径不碰（R6）。

**Patterns to follow**：源参数写法照 :1425-1442 现有 `productionInterval`/`packetLength` 行；常量定义照 :27-40 现有 `DEFAULT_*` ppm 常量；断链脚本照 :1704-1714。

**Test scenarios**（`src-tauri/src/inet_sim_bundle.rs` 内 `#[cfg(test)]`）：
- Covers AE1. ST 流 period=500us/count=1000（T=0.5s）、默认参数 W=625ms：生成 ini 含 `initialProductionOffset = 0.625s`、`sim-time-limit = 1.125s`。
- Covers AE2. timing 的 sync 均 None：W 用 INET 默认 sync=125ms 算得 max(5×125ms,500ms)=625ms，而非当 0 得 500ms 下限。
- Covers AE3. 混合 ST+RC+BE：三类源 `initialProductionOffset` 全等 W，无分类差异。
- RC 故障轮：`fault.t_break_ns` 给定值，断链脚本 `t` = W_ns + t_break_ns（断言平移）。
- 作用域：W 只在 flow-tas 路径注入，timesync bundle 不含 `initialProductionOffset`、时长不被 +W（回归现状 60s）。flow 路径统一加 W——`sim_time_s=Some` 覆盖的是产包窗（W 仍叠加、单路径不特判）；flow 验证恒不传 override，故语义偏差潜伏不触发。
- 更新既有 flow bundle golden/断言（凡断言 `sim-time-limit`、源参数、断链 `t` 的用例随之改）。

**Verification**：新增单测全绿；既有 flow bundle 快照按预期更新；timesync 路径 golden 不变。

---

### U3. 判定与故障尾量守卫不变量回归锁定 + 真机验收

**Goal**：确认判定层与故障尾量守卫无需改动（拿到的是产包窗 T 不是 W+T），加回归测试锁住不变量；真机端到端验证 ST 不再误判。

**Requirements**：R5, R6

**Dependencies**：U2

**Files**：
- `src-tauri/src/flow_verify_command.rs`（若需：仅确认 `sim_time_s = flow_sim_time_s(&specs)` :283 与 classify :416 传参链不受 U2 影响；预期零逻辑改动）
- `src-tauri/src/flow_verify_verdict.rs`（预期零改动；新增或增强单测锁 `flow_expected_sent` 按 T 反推）

**Approach**：核对 verify 编排：`sim_time_s`（:283）取 `flow_sim_time_s` 即产包窗 T，与 bundle 的 `sim-time-limit=W+T` 解耦——判定层实发数、`sim_window_ns`（:316）故障尾量守卫都按 T 计算，天然不含 W，无需改。加回归测试固化「W 变化不影响 expected_sent 与 frames_after_break」。真机复跑原误判会话，确认 ST 由全「未达标」转正常达标、BE 仍正常。

**Test scenarios**：
- Covers R5. `flow_expected_sent(flow_sim_time_s, period)` 在延迟发流下仍等于产包窗内实发数（不含 W 段）。
- 不变量：给定 T 固定、W 不同，`frames_after_break(T_ns, t_break_ns, period_ns)` 结果不变（守卫用 T 非 W+T）。
- 真机验收（手动）：原 ST-全失败会话复跑，ST 达标、稳态 jitter=0、BE 正常、gPTP 收敛。

**Verification**：回归单测绿；真机复跑 ST 误判消失，判定层无逻辑改动。

---

## 范围边界

- 判定层按时间窗剔暖机样本（原路线 A：`parse_vec_csv` 补 vectime、剔样本、扣 expected）——被延迟发流取代，不做。
- 真机 pin 部署包的延迟发流——真实硬件是否 hold ST 至时钟锁定是更大的独立系统行为决策，本期不碰。
- 动态收敛检测（跑一趟测收敛再设延迟）——需两趟运行，用固定预设 W 即可，不做。

### 延后到后续工作

- 若 U1 真机数据显示不同场景收敛时刻差异大到默认 W 不合适，再考虑把 N/下限做成可配置（当前定为模块常量）。

---

## 风险与依赖

- **W 偏小漏排风险**：W < 实际收敛时刻则仍有暖机丢包，ST 仍误判。缓解：U1 真机标定 + 默认取保守（2×max+500ms，默认场景 2.5s 远超首个 sync 125ms）。
- **`initialProductionOffset` 语义核对**：需确认 INET ActivePacketSource 的 `initialProductionOffset` 是「首包延迟到 W 后再按 interval 产」而非其它含义。缓解：U2 真机跑一轮看首包时刻，与 U1 spike 合并验证。
- **golden 测试面**：多处断言 `sim-time-limit`/源参数/断链 `t` 的既有用例需同步更新，遗漏会红。缓解：U2 test scenarios 已列全更新点。
