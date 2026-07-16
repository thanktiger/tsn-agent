---
date: 2026-07-16
topic: flow-softsim-warmup-exclusion
---

# flow-tas 软仿暖机排除需求

## 摘要

flow-tas 软仿改成「先让 gPTP 收敛、再发流」：同一次 INET 运行里，所有流量源延迟 W 启动、`sim-time-limit` 整体加 W，评估窗天然落在时钟收敛之后，暖机丢包从源头不再产生。仅作用于软仿验证，真机部署包不动。

## 问题背景

flow-tas 软仿是**一次** INET 运行——gPTP 从 t=0 开始收敛，流量源也从 t=0（INET 默认 `startTime=0`）就产包。默认振荡器是 `RandomDriftOscillator`，开局 `initialDriftRate` 在 ±100ppm 随机取，各节点时钟一上来就有偏差；gPTP 要经过若干个 `syncInterval`（且首次 pdelay 要等 `pdelayInterval` 才补偿链路延迟）才拉齐。这段收敛期内发出的头几个 ST 包踩空 TAS 门或晚到一个门周期，被丢弃。

后果：全部流启动时都固定丢 ~3 个暖机包（与流速率无关，是固定头包数非固定时窗）。判定层 `flow_verify_verdict.rs::classify` 只兜尾巴不兜开头——`in_flight_tol` 只界定 sim 结束时的在途尾巴，`skip_first` 只跳首个 jitter 样本（晚到一周期的暖机包不是首样本）。于是 ST 流因丢包超容差、抖动等于一个整周期、latency_max 被拉高而全部误判「未达标」；BE 判据宽松（只要 `received>0`）同样丢 3 却放过——这就是 ST/BE 判决分裂的真因，不是 BE 对暖机免疫。

稳态证据充分：多条 ST 流稳态 jitter=0（TAS 门控本身确定性正确）、gPTP 16/16 收敛。问题只在开头这段暖机期，方案本身没错。

## 关键决策

- **延迟发流治本，不在判定层估暖机窗**。给流量源设启动延迟 W，收敛后才发第一个包，暖机包根本不产生。相比在判定层按时间窗剔样本（原路线 A），本方案无需估计暖机窗边界（估短漏排、估长会掩盖真实早期丢包）。

- **同一次仿真内延迟，不跑两次**。真跑两次独立仿真解决不了问题——第二次流量仿真的 gPTP 仍从冷态重新收敛，暖机包照旧产生（INET 无法把第一次的时钟状态热启动带过来）。

- **sim 时长整体加 W，有效产包窗不变**。`sim-time-limit = W + flow_sim_time_s`，产包窗口仍是原来的 `flow_sim_time_s`，`flow_expected_sent` 公式不变，判定层几乎零改动。

- **W 随同步参数缩放**。`W = max(N × syncInterval, 下限)`，不写死绝对值——用户调大同步周期时 W 自动跟上。计算须用**生效值**（用户把 sync 留空时，用 INET 默认 125ms 算 W，不得当 0）。pdelay 经 U1 真机实测非收敛驱动，不进公式。

- **所有流统一延迟 W**。ST/RC/BE 一律延迟同一个 W，不做分类分支——单路径最简，BE/RC 也不受暖机伤害。

## 需求

**发流延迟**

R1. flow-tas 软仿 bundle 为每条流量源写入启动延迟 W（收敛后再产第一个包），ST/RC/BE 一律相同。

R2. W = max(N × syncInterval, 下限)，N=5、下限 500ms（U1 真机标定：实测收敛≈2×syncInterval，pdelay 非驱动故不进公式）。W 必须 ≥ 实际 gPTP 收敛时刻。

R3. 计算 W 时，syncInterval/pdelayInterval 取 bundle 实际生效值——用户留空则用 INET 默认，不得用 None 当 0。

**仿真时长与判据一致性**

R4. `sim-time-limit` 设为 `W + flow_sim_time_s`，保证延迟后有效产包窗口仍为 `flow_sim_time_s`。

R5. 判定层的实发数按有效产包窗口 `flow_sim_time_s` 反推（不含 W），与延迟后实际产包数一致；`flow_expected_sent` 公式不变。

**作用范围**

R6. 仅改 flow-tas 软仿 bundle。真机 pin 部署包不加延迟发流，行为不变。

## 验收示例

AE1. **Covers R1, R4, R5.** 一条 ST 流 period=500us、count=1000（`flow_sim_time_s`=0.5s），默认 W=0.625s。生成 ini：源 `initialProductionOffset`=0.625s、`sim-time-limit`=1.125s。判定层实发按 0.5s 窗口反推（floor(0.5/500us)+1=1001），收包≈1001（无暖机丢包），ST 判 PASS。

AE2. **Covers R2, R3.** 用户未设同步周期（sync 走 INET 默认 125ms）。W=max(N×125ms,500ms)=625ms（N=5，U1 真机标定；pdelay 非驱动不进公式），而非把 None 当 0 得下限 500ms。

AE3. **Covers R1.** 混合场景 ST+RC+BE：三类源的 startTime 全部为同一 W，无分类差异；BE 送达率仍按有效窗口计算、不受延迟影响。

## 范围边界

- 判定层按时间窗剔暖机样本（原路线 A：`parse_vec_csv` 补 vectime、按窗剔样本、expected 扣减）——被延迟发流取代，不做。
- 真机 pin 部署包的延迟发流——真实硬件要不要 hold ST 流量直到时钟锁定，是更大的独立系统行为决策，本期不碰。
- 动态收敛检测（跑一趟测收敛时刻、再据此设延迟）——需两趟运行，W 用固定预设值即可，不做。

## 依赖与假设

- 假设 gPTP 实际收敛时刻稳定落在 `max(N × syncInterval, 下限)` 之内。U1 真机已坐实默认场景收敛≈250ms < W=625ms；更大拓扑仍为待验假设。
- 假设延迟发流后，`flow_expected_sent(flow_sim_time_s, period)` 与 INET 在 `[W, W+flow_sim_time_s]` 窗口的实际产包数一致（源在 startTime 也产一个包，与 t=0 产一个包同构）。

## 待决问题

**Resolve Before Planning**：无。

**Deferred to Planning**
- N 与下限的最终值：起点 N=2、下限 500ms，真机收敛数据出来后定死。
- `flow_verify_verdict.rs` 是否需要任何改动，还是只需调用方传对有效窗口 `flow_sim_time_s`——由 plan 核对实发数据流的传参链坐实。
