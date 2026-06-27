# 硬件部署接口对接 · ideation

日期：2026-06-26
范围：时间同步阶段「硬件部署」子 tab，从占位空态接通 tsn-sim HTTP 服务（`http://100.78.48.43:19080/sim/*`），跑通 探活→环境检查→组装参数→校验→启动→轮询→实时曲线 全链路。

这不是开放式头脑风暴——boss 已经把要做的事说得很细（8 条）。这份文档干两件事：把**落地时真正的决策点和坑**摆出来，把已经拍板的决策记下来，好让下一步 ce-brainstorm / ce-plan 直接接。

---

## 一句话结论（先说最省事的那条路）

**数据库表和 API 任务请求体几乎一一对应**，所以"组装参数"不是新逻辑，而是复用软仿现成的读库函数 + 加一层 JSON 序列化。

| API 任务请求体字段 | 数据来源（已在库里） |
|---|---|
| `task.task_id` | 应用生成，存进新建的 `task` 表 |
| `task.type` | 新表 `task.type` 列（值 `hardware`，boss 用 type 列区分任务类型，将来 simulation 同表） |
| `task.scope` | 固定常量 `time_sync`（不来自表） |
| `task.duration` | 新表 `task.duration` 列 |
| `task.offset_ns_max` | **不传**（boss 定，连文档里这字段也删掉） |
| `topology_nodes[]` | `topology_nodes` 表：mid / node_type / mac / ip / port_count / queue_count 全有 |
| `topology_links[]` | `topology_links` 表：src/dst_node / src/dst_port / speed 全有 |
| `timesync_domain[]` | `timesync_domain` 表：gm_mid / one_step_mode / fre_switch 全有 |
| `timesync_nodes[]` | `timesync_nodes` 表：master/slave/ptp_enabled port、sync/measure_period、report_enable、mean_link_delay_thresh、offset_threshold 全有 |

软仿 `inet_sim_command.rs` 的 `load_topology` / `load_timing` 已经把这些表读成 Rust 结构体了，端口数组的 `parse_i64_array`（把 `"[1,2]"` 字符串解析成真数组）也现成。硬件对接 = **复用这套读库 + 新写一个序列化成 API JSON 的函数 + 一个 reqwest HTTP 调用器**。reqwest 0.13.3 已经是依赖（sidecar 在用），不新增。

---

## 已拍板的决策（boss 2026-06-26 确认）

1. **曲线图表**：用 PR #68 的 echarts 组件。引入 `echarts ^6.1.0` 新依赖。硬件 tab 用 echarts，软仿保留现有自绘 SVG，**两套图表并存**（boss 接受）。
2. **API 配置**：独立硬件配置项，与软仿的 SSH 配置（`InetHostConfig`）解耦，单独一套命令 + app_state 字段持久化。
3. **探活**：两层——先 `GET /sim/healthz` 确认服务活着，再 `POST /sim/task_check` 查硬件环境可用性。
4. **PR #68 不直接合并**：从 PR #68 cherry-pick 图表组件 + `echarts` 依赖到合适位置，**不动它附带的 SKILL.md / package.json 等无关改动**，弄完把线上 PR #68 关闭。
5. **sync_period 暂用 128**：不做特殊处理、不做映射，直接发库里的值（128）。硬冲突风险先搁置，真撞到 task_validate FAIL 再回头考虑。
6. **手动停任务要做**：观测中能停任务，接 `POST /sim/task_stop`。
7. **轮询节奏**：`task_query` 只在 `task_start` 之后确认一次（拿到 queued/running 就进观测）；`task_metrics_query` **每 1s 轮询一次**画实时曲线。
8. **当前 task = 最新创建的那个**：同 session 多 task 时，硬件 tab 展示 `task` 表里 created_at 最新的。历史 task 选择本期不做。
9. **task_check 只看 `hardware.available`**：返回里的 `simulation.*` 字段忽略。

---

## ⚠️ 落地前必须知道的硬冲突（最高优先级风险）

**软仿默认的 `sync_period` 是硬件不接受的值。**

- 应用现在补的推荐默认 `syncPeriod = 128 ms`（见 SKILL.md，2 的幂）。
- 但 API 文档明确：硬件侧 `sync_period` **当前可用值只有 `1000 / 500 / 250 / 125 ms`**。`128` 不在其中。
- `measure_period` 要求 `2^n ms`，`1024` 没问题；但 sync_period 这个会直接撞墙。

也就是说：一个用默认参数跑通软仿的 session，直接发硬件 task 很可能被 `task_validate` 判 WARN/FAIL。

**boss 决定（2026-06-26）**：暂时直接发库里的 128，不做映射、不做特殊提示。靠 `task_validate` 兜底——真撞到 FAIL 再回头处理。前端把 `issues[]` 如实展示即可。

**次要约束**（同样靠 task_validate 兜底）：`task.type=hardware` 当前硬件验证只支持 **2 个 switch + 3 个 endSystem**，且 `timesync_nodes[].mid` 必须与 `topology_nodes[].mid` 一一匹配。拓扑不符会校验失败。

---

## 实现动作（survivors，按依赖顺序）

### M1 · 新建 `task` 表
表名 `task`（非 hardware 专属，将来软仿同表）。列：`session_id`（FK）、`task_id`、`duration`、`type`、`created_at`。boss 的三个业务列 id/duration/type——**`type` 列区分任务类型，存 `hardware`**（与 API 的 `task.type` 语义一致直接映射；API 的 `task.scope` 另用常量 `time_sync`）。session_id 做归属、created_at 排序定位"当前 task"。一个 session 多个 task。命令式 pragma 守卫迁移（沿用 PR #35 的做法，别用 migrations 向量）。
- 基础：`db.rs` 现有建表模式。

### M2 · DB→API JSON 序列化器
复用 `load_topology` / `load_timing` 读库，新写 `build_task_request(session_id, task_row)` 组装成 API 请求体结构体（serde）。端口数组用现成 `parse_i64_array`。
- 基础：`inet_sim_command.rs` 的 load 函数 + `parse_i64_array`。

### M3 · HTTP 调用器
新模块（如 `hardware_api.rs`），用 reqwest 封装 8 个端点：healthz / version / task_check / task_validate / task_start / task_query / task_metrics_query / **task_stop**。做成 trait 方便单测注入替身（仿 `RemoteRunner` 模式）。base URL 从独立硬件配置读。
- 基础：`inet_remote.rs` 的 trait + 替身测试模式；reqwest 已是依赖。

### M4 · 独立硬件 API 配置
新命令 `get/set_hardware_api_config` + app_state 字段（base URL）。设置面板加一项。环境变量可覆盖（仿软仿的 `resolve_remote_config` 优先级）。
- 基础：`get/set_inet_host_config` 模式。

### M5 · 前端硬件部署状态机
「开始硬件部署」按钮触发的多步流程，状态持 App 级（仿 `SimUiState`，切 tab / 切子 tab 不丢、不取消进行中的轮询）：
`idle → checking(healthz + task_check，只看 hardware.available) → validating(task_validate) → starting(task_start) → confirm(task_query 确认一次拿 queued/running) → observing(metrics_query 每 1s 轮询画曲线，可手动停) → stopped/done/failed`。
`task_query` 只确认一次，不持续轮询；持续轮询的是 metrics。每一步失败都有明确的中文提示与 `issues[]` 展示。轮询生命周期要随 session 切换 / 手动停 / 任务终态清理（别泄漏 poller——参考软仿/PR#23 的 sessionId 守卫教训）。观测中提供「停止任务」按钮接 task_stop。

### M6 · cherry-pick PR #68 echarts 曲线（不合 PR）
**不直接合并 PR #68**。从 PR #68（fork 分支 `thanktiger:codex/time-sync-offset-chart-component`）只取 `TimeSyncOffsetChart` 组件（`src/app/components/time-sync-offset-chart.tsx` + `.css` + `.test.tsx`）和 `echarts ^6.1.0` 依赖，落到本仓库合适位置，**不动它附带的 SKILL.md / 无关 package 改动**。弄完关闭线上 PR #68。组件 props `metrics: TimeSyncMetricsQueryResponse` 正好吃 `task_metrics_query` 的 series 返回。轮询参数固定 `{task_id, source:"hardware", mode:"series", bucket:"1s", only_synced:false}`。处理 `metrics_status = collecting / no_data` 的中间态（显示"采集中"）。

### M7 · 服务端接口验证脚本（e2e）
`scripts/` 下沉淀一个 node 脚本（仿现有 `verify-skills.mjs` / `prepare-release.mjs`），打 healthz / version / task_check，校验返回结构 + 版本号，做服务端接口连通性 + 版本回归的 e2e 用例。
- 基础：`scripts/*.mjs` 现有脚本风格。

### M8 · 删文档里的 offset_ns_max
`docs/prototypes/tsn-sim_前端调用接口文档.html` 里删掉 `task.offset_ns_max` 字段行 + 请求体示例里的 `"offset_ns_max": 200` + 相关介绍。纯机械。

---

## 开放问题（已全部由 boss 拍板，见「已拍板的决策」）

1. ~~sync_period 冲突怎么呈现~~ → 暂用 128，靠 task_validate 兜底（决策 5）
2. ~~task_stop 做不做~~ → 做（决策 6）
3. ~~轮询节奏~~ → task_query 确认一次、metrics_query 1s 一次（决策 7）
4. ~~"当前 task" 定义~~ → 最新创建的（决策 8）
5. ~~task_check 看不看 simulation~~ → 只看 hardware.available（决策 9）
6. ~~PR #68 集成方式~~ → cherry-pick 组件 + echarts，关闭线上 PR（决策 4）

留给 brainstorm 的细节（非阻塞）：metrics_status=collecting 时曲线区的文案与骨架；task_stop 后是否还能再启动同 session 新 task；探活/校验失败的具体错误展示形态。

---

## 不做的（划清边界）

- 不做软仿/硬件图表统一（boss 选了两套并存）。
- 不做 sync_period 静默映射（靠 task_validate 暴露）。
- 不提前抽象通用任务调度框架——硬编码这条硬件部署链路即可。
- task_metrics_query 的 latest/stats/samples 模式本期不接，只用 series 画实时曲线。

---

下一步：`/ce-brainstorm` 把上面 6 个开放问题定清楚，产出需求文档，再 `/ce-plan`。
