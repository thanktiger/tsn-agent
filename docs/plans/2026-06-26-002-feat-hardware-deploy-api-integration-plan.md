---
type: feat
origin: docs/ideation/2026-06-26-hardware-deploy-api-integration-ideation.md
title: "feat: 硬件部署接口对接（tsn-sim HTTP 全链路 + 实时曲线）"
date: 2026-06-26
depth: deep
---

# feat: 硬件部署接口对接（tsn-sim HTTP 全链路 + 实时曲线）

时间同步阶段「硬件部署」子 tab 从占位空态接通 tsn-sim HTTP 服务，跑通 **探活 → 环境检查 → 组装参数 → 校验 → 启动 → 确认 → 实时曲线观测 → 停止** 全链路。所有决策已由 boss 在 ideation 阶段拍板（见 origin），本计划只定 HOW。

---

## 问题框架

硬件部署子 tab 现在是空态（`HardDeployEmptyState`，只有一个"先用软件仿真验证"按钮）。要把它接到真实的 tsn-sim 服务（`http://100.78.48.43:19080/sim/*`），让用户点「开始硬件部署」后自动走完整条链路，并实时看到从节点的时钟偏移曲线。

**最大简化点**：数据库表与 API 任务请求体在「列」层面一一对应——所有字段（mac/ip/port_count/queue_count/port_ptp_enabled/report_enable/mean_link_delay_thresh 等）库里都有。但软仿的 `load_topology` / `load_timing` 只读了其中一个子集（`load_topology` 仅 SELECT `mid/name/node_type`，`SimNodeTiming` 无 port_ptp_enabled/report_enable/mean_link_delay_thresh），不能直接复用。所以 U2 需新写一个读全列的查询（`timesync_sidecar_routes.rs` 已有读这些列的现成 SQL 可参照），复用的是 `parse_i64_array` 这类工具而非那两个读函数。硬件对接 = 读全列 SQL + 一层 JSON 序列化 + 一个 reqwest HTTP 调用器。reqwest 0.13.3 已是依赖（sidecar 在用），不新增 Rust 依赖。唯一新增依赖是前端 `echarts ^6.1.0`（boss 已批，cherry-pick 自 PR #68）。

---

## 范围边界

### 本期做
- 新建 `task` 表（`type` 列区分 hardware/simulation，session 多 task，应用生成 task_id）。
- DB→API JSON 序列化器（复用软仿读库函数）。
- reqwest HTTP 调用器，封装 8 个端点（healthz / version / task_check / task_validate / task_start / task_query / task_metrics_query / task_stop）。
- 独立硬件 API 配置（与软仿 SSH 配置解耦），进设置面板。
- 前端硬件部署状态机：check → validate → start → confirm → observe → stop。
- cherry-pick PR #68 的 echarts 曲线组件，画 metrics_query series 实时曲线（1s 轮询）。
- `scripts/` 沉淀服务端接口连通性 + 版本回归 e2e 脚本。
- 删除 API 文档 HTML 里的 `offset_ns_max`。

### Deferred to Follow-Up Work
- 软仿/硬件两套图表统一（boss 选两套并存）。
- `sync_period` 硬件可用值映射/校验（本期直接发库里的 128，靠 task_validate 兜底）。
- 历史 task 选择 UI（本期只展示最新创建的 task）。
- `task_metrics_query` 的 latest / stats / samples 模式（本期只用 series）。
- 硬件 task 跑完后的结果归档 / 裁决落库。

### 非目标
- 不改时间同步阶段的拓扑 / 时钟树配置逻辑——硬件部署只读取已确认的配置。
- 不做通用任务调度框架——硬编码这一条硬件部署链路。

---

## 关键技术决策

**KTD1 · 参数组装读全列（不直接复用软仿读函数）。** `build_task_request(session_id, task_row)` 新写读全列的 SQL：topology_nodes 取 `mid/node_type/mac/ip/port_count/queue_count`、timesync_nodes 取 `mid/master_port/slave_port/port_ptp_enabled/sync_period/measure_period/report_enable/mean_link_delay_thresh/offset_threshold`、topology_links + timesync_domain 同理（参照 `timesync_sidecar_routes.rs` 已有读这些列的 SQL）。软仿的 `load_topology`/`load_timing` 只读子集，**不复用**；复用的是 `parse_i64_array`（把库里 JSON 字符串端口数组转真数组，API 要求 `[1,2]` 而非 `"[1,2]"`）。`task.type` ← 表 `type` 列（hardware）、`task.scope` 固定 `time_sync`、`task.offset_ns_max` 不传。

**KTD2 · HTTP 调用器用 reqwest + trait。** 新模块 `hardware_api.rs`，定义 `HardwareApiClient` trait（8 个端点方法），真实现 `ReqwestHardwareClient` + 测试替身 `FakeHardwareClient`，镜像 `inet_remote.rs` 的 `RemoteRunner` 模式。reqwest 已是依赖，不新增。

**KTD3 · 独立硬件 API 配置。** `HardwareApiConfig { base_url }` 落 `app_state`（key `hardware_api_config`），`get/set_hardware_api_config` 命令 + env>UI>默认 resolve，完全镜像 `get/set_inet_host_config`（`inet_sim_command.rs:99-145`）。与软仿 SSH 配置解耦。base_url 是自用工具信任输入，仅校验非空 + 简单 URL 形态。

**KTD4 · task_id 应用生成。** 在 `hardware_start` 命令里生成，格式 `hw-<session_id 前 8 位>-<unix 毫秒>`（用毫秒而非秒，避免同会话同秒连点两次生成相同 id 撞 PK），满足 API 正则 `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`。生成后立即 insert `task` 行；insert 撞 PK 时映射成中文错误（不静默）。

**KTD5 · `task` 表设计（boss 定）。** 表名 `task`（非 hardware 专属——将来软仿也能进同表）。业务列 `task_id`（id）、`duration`、`type`；表必需键 `session_id`（FK + 归属）、`created_at`（定位"当前 task = 最新创建"）。**`type` 列是任务类型区分列，本期值 `hardware`**（将来 simulation/both）。`type` 列与 API 的 `task.type` 语义一致，直接映射。API 的 `task.scope` 另用固定常量 `time_sync`（不来自表）。

**KTD6 · 两套图表并存。** 硬件 tab 用 echarts（PR #68 组件），软仿保留自绘 SVG。boss 已接受。

**KTD7 · sync_period 直发不映射。** 库里 128 直接进请求体，不做硬件可用值（1000/500/250/125）映射。真撞 task_validate FAIL 时，前端如实展示 `issues[]`（见 Risks）。

**KTD8 · 双定时器轮询（终态权威源 = task_query）。** 进入 observing 后两个定时器并行：`task_metrics_query` 每 **1s** 拉曲线；`task_query` 每 **5s** 读 status 作终态权威源。原因：`task_metrics_query` 的 `metrics_status` 只有 collecting/ready/failed/no_data，**没有** done/timeout，单靠它学不到任务结束；而 task_start 返回 202 异步，必须靠 task_query 轮询到终态（API 文档明示）。终态规则：
- task_query.status ∈ {done, failed, timeout, stopped} → 停两个定时器、按 status 落到对应终态。
- `created`（受理后的合法瞬时态）→ **不判 error**，继续等下一次 task_query（有限重试 / 软超时），直到 queued/running 或终态。
- 软超时兜底：elapsed > `task.duration` + 余量仍无终态 → 停轮询并提示「任务时长已到」。
轮询生命周期随 会话切换 / 手动停 / 任意终态 清理两个定时器（防泄漏，sessionId 守卫）。

**KTD9 · 状态机持 App 级 + 并发规则。** 新增 `HardwareUiState` 镜像 `simState`（App.tsx:77），经 workspace-pane 下钻 TimeSyncPanel，切 tab/子 tab 不丢、不取消进行中的轮询。随 sessionId 重置（防 PR#23 id 污染）。**并发/孤儿规则**（boss 定：启动不加二步确认守卫，但需防误产生孤儿）：① 非 idle/终态时「开始硬件部署」按钮禁用——防连点产生第二个远端 task 把第一个静默抛弃；② observing 中切会话：状态随会话重置、清轮询，但远端 task 仍在跑——切走前对当前 task best-effort 调一次 `hardware_stop`（失败不阻塞切换），并接受「切会话 = 尽力停、停不掉则由服务端 duration 超时回收」。

**KTD10 · HTTP 超时。** `ReqwestHardwareClient` 显式设连接 + 读超时（参照软仿 `RemoteConfig` 的 120s 口径，按端点取更短值如 10-30s），避免服务端 hang 时同步命令卡住 UI 的 invoke。

**KTD11 · metrics 原样透传 snake_case。** 本仓库命令出参铁律是 serde camelCase，但 PR #68 的 echarts 组件读 **snake_case**（`node_id/latest_offset_ns/avg_offset_ns/max_abs_offset_ns/bucket_start_ns`）。故 `hardware_metrics` 命令**例外**：用 `serde_json::Value` 把 task_metrics_query 的 series 原样透传（不加 `rename_all=camelCase`），否则字段名变 camelCase → 组件读全落空 → 图表静默空曲线。这是 U8「静默空图」的最可能成因，必须钉死 + 端到端断言。

**KTD12 · issues[] / 服务端文案纯文本渲染（防 XSS）。** `issues[].message`、`error.message` 等服务端返回的字符串用 JSX text node（`{msg}`）渲染，**不走 react-markdown**（chat-pane 用 react-markdown 渲染任意串，硬件错误不可借用——服务端可控字符串经 markdown 会引入 `<a href=javascript:>`/`<img onerror>` 注入面）。与现有 `time-sync-panel` 里 `{simState.message}` 裸 text 渲染一致。

---

## 高层设计

### 硬件部署状态机

「开始」按钮仅在 idle/终态(stopped/done/error) 可点；checking..observing 期间禁用（KTD9 防孤儿）。

```
idle ─[点「开始硬件部署」]→ checking ── GET healthz + POST task_check（只看 hardware.available）
                              ├─不可用→ error（显示 reason；按钮变「重试」回 idle）
                              └─可用→ validating ── 生成 task_id + insert task 行 + build_task_request + POST task_validate
                                          ├─FAIL/ready=false→ error（展示 issues[]；命中 sync_period 不可用值给专门引导，见 R1）
                                          └─PASS/WARN & task_start_compatible→ starting ── POST task_start
                                                      ├─accepted=false→ error
                                                      └─accepted→ confirming ── POST task_query
                                                                  ├─created→ 有限重试/软超时（不判 error）
                                                                  ├─failed/timeout→ failed
                                                                  └─queued/running→ observing
   observing（两定时器并行）：
     ├─ 每 1s  POST task_metrics_query(series, snake_case 原样透传) → 喂 echarts；collecting→采集中骨架 / no_data→暂无数据
     ├─ 每 5s  POST task_query → 读 status（终态权威源）
     │           └─ done/failed/timeout/stopped → 停两定时器 + 落对应终态（done≠stopped，文案区分）
     ├─ 软超时 elapsed>duration+余量 → 停轮询 +「任务时长已到」
     ├─[点「停止任务」]→ POST task_stop → 按返回 status 分流（stopped/done/failed/timeout，不硬编码 stopped）
     └─ 会话切换 → best-effort hardware_stop + 清两定时器 + 状态随会话重置
   终态 done/stopped/failed/error：保留最后一帧曲线；「开始」按钮可重新部署
```

### DB → API 请求体映射

| 请求体 | 来源 |
|---|---|
| `task.task_id` | 应用生成（KTD4），存 `task` 表 |
| `task.type` | `task.type` 列（值 `hardware`，KTD5） |
| `task.scope` | 固定常量 `time_sync`（不来自表） |
| `task.duration` | `task.duration` 列 |
| `task.offset_ns_max` | 不传 |
| `topology_nodes[]` | U2 新写 SQL 读 topology_nodes（mid/node_type/mac/ip/port_count/queue_count）——`load_topology` 只读 mid/name/node_type，不够用 |
| `topology_links[]` | U2 新写 SQL 读 topology_links（src/dst_node/port/speed） |
| `timesync_domain[]` | U2 新写 SQL 读 timesync_domain（gm_mid/one_step_mode/fre_switch） |
| `timesync_nodes[]` | U2 新写 SQL 读 timesync_nodes（master/slave/ptp_enabled port、sync/measure_period、report_enable、mean_link_delay_thresh、offset_threshold）——`SimNodeTiming` 缺 ptp_enabled/report_enable/mean_link_delay_thresh，不够用。参照 `timesync_sidecar_routes.rs` 已读这些列的 SQL |

---

## 实现单元

### U1. task 表 + 迁移 + 访问函数

**Goal**：建 `task` 表，提供 insert 一行、查会话最新 task 的访问函数。

**Dependencies**：无。

**Files**：
- `src-tauri/src/db.rs`（改：加表 DDL 常量 + `ensure_task_table` 启动迁移函数，照 `ensure_topology_nodes_name_column` 守卫风格）
- `src-tauri/src/task_store.rs`（新：`insert_task` / `latest_task`）
- 测试同文件 `#[tokio::test]`

**Approach**：表列 `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`、`task_id TEXT NOT NULL`、`duration INTEGER NOT NULL`、`type TEXT NOT NULL`、`created_at TEXT NOT NULL`，PRIMARY KEY `(session_id, task_id)`。`type` 列是任务类型区分列，本期 insert 时写 `hardware`（KTD5）。迁移在应用启动处调用（找现有 `ensure_*` 的调用点一并挂上）。

**Patterns to follow**：`db.rs` 的 `SESSION_SCHEMA_SQL` 常量 + `ensure_topology_nodes_name_column`（命令式守卫迁移，非 migrations 向量）。

**Test scenarios**：
- insert 一行后 `latest_task` 返回它（含 type 字段往返）。
- 同 session 两行不同 created_at → 返回 created_at 较晚的。
- 无记录 → `latest_task` 返回 None。
- 删 session → 行随 CASCADE 删除。
- 老库（无此表）跑 `ensure_task_table` 后表存在且可写；重复跑幂等。

**Verification**：cargo test 该模块绿；老 dev db 启动不报错、表自动建出。

---

### U2. DB→API 请求体序列化器

**Goal**：把会话的拓扑 + 时钟树数据组装成 tsn-sim 任务请求体 JSON。

**Dependencies**：U1（要 task 行的 task_id/duration/type）。**不复用** `load_topology`/`load_timing`（它们只读子集，见 KTD1），新写读全列 SQL。

**Files**：
- `src-tauri/src/task_request.rs`（新：serde 结构体 `TaskRequest` 等 + 读全列查询 + `build_task_request`）
- 测试同文件

**Approach**：serde 结构镜像 API「任务请求体」全字段，`#[serde(rename_all = "snake_case")]`（API 用 snake_case，注意与前端 camelCase IPC 不同——这是发往外部 HTTP 服务的体，按服务端契约）。新写读全列 SQL：topology_nodes 取 `mid/node_type/mac/ip/port_count/queue_count`、timesync_nodes 取 `mid/master_port/slave_port/port_ptp_enabled/sync_period/measure_period/report_enable/mean_link_delay_thresh/offset_threshold`、topology_links 取 `src/dst_node、src/dst_port、speed`、timesync_domain 取 `gm_mid/one_step_mode/fre_switch`（参照 `timesync_sidecar_routes.rs` 已读这些列的 SQL）。端口数组字段用 `parse_i64_array` 把库里 JSON 字符串转成 `Vec<i64>`。`build_task_request` 入参带上 `task` 行（含 task_id/duration/type）：**`api.task.type` ← 行的 `type` 列（hardware）**，`api.task.scope` ← 常量 `time_sync`，`api.task.duration` ← 行的 duration，`offset_ns_max` 字段直接不定义（不序列化）。`node_type` 库里可空但 API 必填，序列化出 null 由 task_validate 兜底报错（见 R2）。

**Patterns to follow**：`timesync_sidecar_routes.rs` 读 port_ptp_enabled/report_enable/mean_link_delay_thresh 的 SQL；`inet_sim_command.rs` 的 `parse_i64_array`。

**Test scenarios**：
- 给定一份完整会话数据，组装出的 JSON 含全部 5 段，`task.type`=hardware（来自 type 列）、`task.scope`=time_sync（常量）、无 `offset_ns_max` 键。
- **API 必填字段齐全**：topology_nodes 带 port_count/queue_count、timesync_nodes 带 port_ptp_enabled/report_enable/mean_link_delay_thresh（断言这些字段都在、值正确——这是「读全列」的核心保护）。
- 端口数组从库里 `"[0,1]"` 字符串正确变成 JSON 数组 `[0,1]`（master_port/slave_port/port_ptp_enabled 三个数组都验）。
- gm_mid / one_step_mode / fre_switch 正确落到 `timesync_domain[0]`。
- 缺 mac/ip（NULL）时序列化成 `null` 不报错。
- 节点/链路顺序稳定（按既有 ORDER BY）。

**Verification**：序列化结果与 API 文档「请求体示例」结构对齐（字段名、嵌套、数组类型）；必填字段无遗漏。

---

### U3. reqwest HTTP 调用器

**Goal**：封装 tsn-sim 的 8 个端点为可测的 Rust trait。

**Dependencies**：U2（task_validate/start 要请求体）。

**Files**：
- `src-tauri/src/hardware_api.rs`（新：`HardwareApiClient` trait + `ReqwestHardwareClient` + 响应 serde 结构 + 错误映射）
- 测试同文件（测试替身在各 test 模块内局部定义，镜像 `inet_sim_command.rs` 的 `MockRunner`——`cfg(test)` 类型不能跨文件引用，故 hardware_api.rs 与 hardware_command.rs 各自定义自己的 fake）

**Approach**：trait 方法对应 8 端点：`healthz`、`version`、`task_check`、`task_validate(req)`、`task_start(req)`、`task_query(task_id)`、`task_metrics_query(params)`、`task_stop(task_id)`。响应结构按 API 文档出参建模（task_check 只需建到 `hardware.available`/`reason`；task_validate 建 verdict/ready/task_start_compatible/issues[]；task_start 建 status/accepted；task_query 建 status/verdict/summary + hardware.*；task_stop 同 task_query 形状含 status；metrics 走 KTD11 `serde_json::Value` 原样透传不强类型化）。`ReqwestHardwareClient` 显式设连接/读超时（KTD10）。网络错误/非 2xx/反序列化失败/超时统一映射成带中文说明的错误枚举。base_url 由调用方注入（来自 U4 配置）。

**Patterns to follow**：`inet_remote.rs` 的 `RemoteRunner` trait + 替身测试模式；reqwest json feature 用法（sidecar 现有调用）。

**Test scenarios**：
- `FakeHardwareClient` 注入预设响应，各方法解析正确（happy path 每端点一例）。
- task_check 返回 `hardware.available=false` + reason → 调用方拿到 reason。
- task_validate 返回 verdict=FAIL + issues[] → issues 完整带回。
- 非 2xx（如 500 + error.code）→ 映射成错误枚举含 code/message。
- metrics 返回的 series 原样透传（snake_case 字段名保留，不被改写）。
- 反序列化失败（残缺 JSON）→ 错误而非 panic。
- 超时（KTD10）→ 映射成错误枚举（中文说明），不挂死。

**Verification**：cargo test 绿；trait 边界清晰可被命令层注入替身。

---

### U4. 独立硬件 API 配置

**Goal**：硬件 API base_url 的持久化 + 读写命令 + resolve 优先级。

**Dependencies**：无（U5 命令会用到）。

**Files**：
- `src-tauri/src/hardware_api_config.rs`（新：`HardwareApiConfig { base_url }`、`load`/`resolve`、`get_hardware_api_config`/`set_hardware_api_config` 命令）
- `src-tauri/src/lib.rs`（改：注册两命令）
- `src/app/hardware-api-config.ts`（新：前端契约 + invoke 包装，镜像 `src/app/inet-host-config.ts`）
- `src/app/components/workspace-tools/index.tsx`（改：在软仿远端配置区之后并排加硬件 API 地址输入项；契约见上）
- 测试：Rust 同文件 + `src/app/components/workspace-tools/workspace-tools.test.tsx`

**Approach**：完全镜像 `inet_sim_command.rs:99-145` 的 `get/set_inet_host_config`：app_state key `hardware_api_config`，JSON 序列化，env (`TSN_AGENT_HARDWARE_API_URL`) > UI 持久值 > dev 默认（`http://100.78.48.43:19080`）。`set` 时校验 base_url 非空 + 基本 URL 形态（http/https 前缀），不做严格字符集校验（自用工具信任输入，同 base_dir 口径）。

**Patterns to follow**：`get/set_inet_host_config` + `load_host_config` + `INET_HOST_CONFIG_KEY`；前端设置面板软仿配置项。

**Test scenarios**：
- set 后 get 取回同值。
- 无 UI 值时 get 返回 dev 默认。
- env 变量存在时 resolve 覆盖 UI 值。
- base_url 空 → set 报错。
- base_url 非 http(s) 前缀 → set 报错。
- 设置面板：输入并保存调 set_hardware_api_config、回显持久值。

**Verification**：设置面板能改硬件地址并持久；env 覆盖生效。

---

### U5. Tauri 命令层（编排全链路）

**Goal**：把 U1-U4 串成前端可调的命令：check / start（含 validate）/ query / metrics / stop。

**Dependencies**：U1、U2、U3、U4。

**Files**：
- `src-tauri/src/hardware_command.rs`（新：5 个 `#[tauri::command]`）
- `src-tauri/src/lib.rs`（改：注册到 invoke_handler）
- 测试同文件（FakeHardwareClient 在本文件 test 模块内局部定义，镜像 `inet_sim_command.rs` 的 MockRunner，不跨文件引用 cfg(test) 类型 + 内存 db）

**Approach**：
- `hardware_check`：resolve 配置 → healthz → task_check，返回 `{ healthzOk, hardwareAvailable, reason }`（camelCase IPC）。
- `hardware_start`：生成 task_id（KTD4）→ insert `task` 行（`type` 列写 `hardware`，KTD5）→ `build_task_request` → task_validate → 启动门 = `ready && task_start_compatible`（两个布尔含义不同：ready=满足本次 type 启动前条件、task_start_compatible=满足 task_start 条件，两者都真才启动）→ task_start，返回 `{ taskId, validate: {...}, start: {...} }`；validate 不过则返回 validate 结果不启动。
- `hardware_query`：取会话最新 task_id → task_query，返回 status + verdict + summary。前端用它两处：confirming 确认 + observing 态每 5s 探终态（KTD8）。
- `hardware_metrics`：取最新 task_id → task_metrics_query `{source:"hardware", mode:"series", bucket:"1s", only_synced:false}`，**用 `serde_json::Value` 原样透传 series（snake_case，不加 camelCase rename，KTD11）**。
- `hardware_stop`：取最新 task_id → task_stop，**返回体含 status（可能是 stopped 也可能是 done/failed/timeout），原样带回让前端按 status 分流**，不硬编码 stopped。
- 除 `hardware_metrics`（透传）外，命令用 camelCase serde 出参，错误返回带中文说明的 `Err(String)`。客户端注入用 trait（生产用 ReqwestHardwareClient）。

**Patterns to follow**：`run_timesync_sim` 命令的结构（resolve→组装→远端→返回）；lib.rs invoke_handler 注册段。

**Test scenarios**：
- `hardware_check`：fake 返回 healthz ok + hardware.available → 命令返回可用。
- `hardware_check`：hardware.available=false → 返回 reason、不往下走。
- `hardware_start`：validate PASS → 生成 task_id、insert 行、调 task_start、返回 accepted。
- `hardware_start`：validate FAIL → 不调 task_start、返回 issues。
- `hardware_start`：ready=true 但 task_start_compatible=false → 不启动（启动门两布尔都要真）。
- `hardware_start`：task_id 满足正则、且 `task` 表出现该行（type=hardware）。
- `hardware_query`/`hardware_metrics`/`hardware_stop`：取到最新 task_id 并正确转调。
- `hardware_metrics`：fake 返回 snake_case series → 命令透传后字段名仍是 snake_case（断言没被改写成 camelCase）。
- `hardware_stop`：fake 返回 status=done（任务恰好跑完）→ 命令带回 done 而非 stopped。
- 无 task 时 `hardware_metrics`/`hardware_query`/`hardware_stop` → 明确错误而非 panic。

**Verification**：cargo test 绿；命令契约（camelCase 字段）与前端约定一致。

---

### U6. cherry-pick echarts 曲线组件（不合 PR #68）

**Goal**：把 PR #68 的 `TimeSyncOffsetChart` 组件 + echarts 依赖落进本仓库；关闭线上 PR #68。

**Dependencies**：无。

**Files**：
- `src/app/components/time-sync-offset-chart.tsx`（新，取自 PR #68）
- `src/app/components/time-sync-offset-chart.css`（新，取自 PR #68）
- `src/app/components/time-sync-offset-chart.test.tsx`（新，取自 PR #68）
- `package.json`（改：加 `echarts ^6.1.0`）

**Approach**：只取这三个文件 + echarts 依赖，**不动** PR #68 附带的 SKILL.md / package 无关改动。落地后本地 `npm install` 装 echarts、跑组件自带测试确认通过。实现单元完成后由人执行 `gh pr close 68`（执行动作，记于 Verification，不在代码内）。**视觉对齐**（与软仿 SVG 图表同 tab 平级、用户来回切）：echarts 复用软仿图表的颜色 token（`CHART_COLORS` 同系）、轴线色（`#cbd5e1`）、文字色（`#64748b`）、字体（11-12px）、背景透明（与 `.sim-subpanel` 一致），不用 echarts 默认主题。

**Execution note**：从 PR #68 diff 取文件内容（`gh pr diff 68`），逐个 Write 到本仓库路径，核对 import 路径在本仓库成立。

**Test scenarios**：
- 组件自带 `time-sync-offset-chart.test.tsx` 全绿（喂 metrics payload 渲染曲线、空态、节点筛选）。
- **必做（防静默空图）**：用一份贴近 `task_metrics_query` 真实返回的 snake_case series payload 喂 `TimeSyncOffsetChart`，断言 echarts `option.series[].data` 非空。这条由 U8 集成测试承担，不是「二选一」可选项——KTD11 的 camelСase 风险只有真实形状端到端断言能拦住。

**Verification**：vitest 绿；echarts 进 lockfile；真实形状 series 喂入渲染非空曲线；PR #68 已关闭。

---

### U7. 前端硬件部署契约模块

**Goal**：硬件部署的 TS 类型 + invoke 包装 + 纯状态推进函数（可单测）。

**Dependencies**：U5（命令契约）。

**Files**：
- `src/app/components/workspace-pane/hardware-deploy.ts`（新：`HardwareUiState` 类型、`invokeHardwareCheck/Start/Query/Metrics/Stop` 包装、纯函数 `nextHardwareState`（按命令结果推进状态机））
- `src/app/components/workspace-pane/hardware-deploy.test.ts`（新）

**Approach**：沿用 `timesync-sim.ts` 的「判别联合 state + invoke 包装 + 纯函数可单测」原则（与 computeReveal 同样不依赖 Tauri、便于单测）；但 `nextHardwareState` 是本期新写的状态机迁移函数，timesync-sim.ts 里没有对应物（SimUiState 的推进逻辑目前内联在 App.tsx）。`HardwareUiState` 是判别联合：`idle | checking | validating | starting | confirming | observing(taskId, metrics) | stopped | done | error(message, issues?)`。`nextHardwareState(prev, event)` 纯函数承载状态迁移，单测不碰 Tauri。

**Patterns to follow**：`timesync-sim.ts` 的 SimUiState 判别联合 + invoke 包装 + 纯函数分离（含 sessionId 守卫教训）。

**Test scenarios**：
- check 可用 → checking→validating 推进。
- check 不可用 → error 带 reason。
- validate FAIL → error 带 issues。
- start accepted + query queued → observing。
- **confirming query 返回 created → 不进 error，停在等待态（再来一次 running → observing）**（KTD8 核心修正）。
- observing 的 5s task_query 返回 done → done（停轮询标志）；返回 failed → failed；返回 timeout → timeout。
- 软超时（elapsed>duration+余量）→ 停轮询态。
- 手动 stop 返回 status=stopped → stopped；**返回 status=done（恰好跑完）→ done 而非 stopped**。
- error/done/stopped 态收到「重新开始」事件 → 回 idle。
- 任一步错误事件 → error 态、携带中文 message。

**Verification**：vitest 绿；纯函数覆盖全状态迁移（含 created 重试、终态分流、stop 按 status 落点、重试回 idle）。

---

### U8. 硬件部署面板 UI + App 级状态机 + 轮询生命周期

**Goal**：把空态换成完整交互：开始按钮、各阶段反馈、实时曲线、停止按钮；轮询随会话切换/停止/终态清理。

**Dependencies**：U6（图表）、U7（契约）、U5（命令）。

**Files**：
- `src/app/App.tsx`（改：加 `hardwareState` state（镜像 simState）+ 随 sessionId 重置 + 下钻）
- `src/app/components/workspace-pane/index.tsx`（改：透传 hardwareState/onHardwareStateChange）
- `src/app/components/workspace-pane/time-sync-panel.tsx`（改：替换 `HardDeployEmptyState`——保留"无配置/未确认树"时的引导空态，有树时渲染部署 UI：开始按钮→分阶段状态→TimeSyncOffsetChart→停止按钮）
- `src/app/App.css`（改：硬件部署区样式，沿用 flex 防 WebKit 行塌）
- `src/app/components/workspace-pane/time-sync-panel.test.tsx`（改：硬件子 tab 交互）

**Approach**：开始按钮触发 `checking`，进 observing 后**两个 `setInterval`**：metrics 1s 喂图表、task_query 5s 探终态（KTD8）。两个 interval 各自 ref + cleanup：会话切换（sessionId 守卫 + KTD9 best-effort stop）、手动停、任意终态、软超时都要 clear（参考 PR#23/软仿的 sessionId 守卫教训，别信切会话首帧）。

**主按钮状态表**（每个 HardwareUiState 对应主按钮 + 停止按钮）：

| 状态 | 主按钮 | 停止按钮 |
|---|---|---|
| idle | 「开始硬件部署」可点 | 隐 |
| checking/validating/starting/confirming | 「部署中…」禁用 | 隐 |
| observing | 隐 | 「停止任务」可点 |
| done | 「重新部署」可点 +「任务已完成」（绿，复用 `.sim-overall.converged` 色） | 隐 |
| stopped | 「重新部署」可点 +「任务已停止」（中性色） | 隐 |
| error | 「重试」可点（回 idle）+ 中文 message/issues | 隐 |

**issues[] 渲染**（KTD12 纯文本节点，不走 markdown）：每条 `{severity 徽章}{message}` 垂直列表，ERROR→`var(--error)`、WARN→warn 色（与 `.sim-overall.warn` 一致）；放全宽 error 区。**collecting vs no_data 区分**：`metrics_status=collecting`→「采集中」动态骨架（shimmer）；`no_data`→「暂无数据」静态文案（明确不是加载中），两者不同 CSS class。done/stopped/error 终态保留最后一帧曲线不清空。

**Patterns to follow**：软仿子 tab 的 `handleSoftSim` + simState 展示；App.tsx simState 下钻链；WebKit flex 布局约定（learnings：grid+overflow 行塌）；issues 裸 text 渲染同 `{simState.message}`。

**Test scenarios**：
- 无已确认时钟树 → 显示引导空态、开始按钮禁用/不显。
- 点开始 → 走 checking 文案；fake 链路到 observing 后渲染图表。
- **非 idle/终态时「开始」按钮禁用**（防连点产生孤儿，KTD9）。
- check 不可用 → 显示 reason、不进图表。
- validate FAIL → 以纯文本节点展示 issues[]（断言不经 markdown 渲染）。
- **validate FAIL 命中 sync_period 不可用值 → 显示专门引导文案**（R1：当前 128ms 硬件不支持，请回时间同步阶段改为 1000/500/250/125）。
- observing 态有「停止任务」按钮，点击 hardware_stop 返回 stopped → 「任务已停止」；返回 done → 「任务已完成」（区分两态文案）。
- observing 的 5s task_query 命中 done → 停两定时器、显示「任务已完成」、曲线保留。
- 切会话 → 两定时器清理、best-effort stop、硬件状态重置（不残留上个会话曲线）。
- 切 tab/子 tab 再回来 → observing 态与曲线不丢（App 级持有）。
- `metrics_status=collecting` → 采集中骨架；`no_data` → 暂无数据静态文案（两者 UI 不同）。
- error 态点「重试」→ 回 idle。

**Verification**：vitest 绿；真机（Safari 5173 / 打包）验证子 tab 无塌跳、曲线实时刷新、停止可用、切会话不串数据、终态文案区分、issues 纯文本展示。

---

### U9. 服务端接口 e2e 验证脚本

**Goal**：`scripts/` 下沉淀打 tsn-sim 服务的连通性 + 版本回归脚本，作 e2e 用例。

**Dependencies**：无（独立，可并行）。

**Files**：
- `scripts/verify-hardware-api.mjs`（新）

**Approach**：node 脚本（仿 `verify-skills.mjs`/`prepare-release.mjs` 风格），base_url 取 env `TSN_AGENT_HARDWARE_API_URL` 默认 `http://100.78.48.43:19080`。打 `GET /sim/healthz`（断言 status ok/degraded + 字段齐）、`GET /sim/version`（断言 tsn_sim_version/api_version 存在，记录当前版本用于回归比对）、`POST /sim/task_check`（断言返回结构含 hardware.available）。任一断言失败非零退出。网络不可达时给清晰提示。是否进 CI 由 boss 后定（脚本本身先沉淀）。

**Patterns to follow**：`scripts/verify-skills.mjs` / `scripts/prepare-release.mjs`。

**Test scenarios**：
- Test expectation: none —— 这是 e2e 验证脚本本身，靠对真实服务的断言生效；不为脚本再写单测。脚本内对响应结构做显式断言即为其测试逻辑。

**Verification**：服务在线时脚本 EXIT=0 并打印版本；服务离线时非零退出 + 明确提示。

---

### U10. 删 API 文档里的 offset_ns_max

**Goal**：从接口文档 HTML 移除 `offset_ns_max` 字段及相关介绍。

**Dependencies**：无。

**Files**：
- `docs/prototypes/tsn-sim_前端调用接口文档.html`（改）

**Approach**：删 `task.offset_ns_max` 字段说明行 + 请求体示例里的 `"offset_ns_max": 200` + 任何提及该字段的介绍文字。纯机械删除，保持 HTML 其余渲染不变。

**Test scenarios**：
- Test expectation: none —— 纯文档删除，无行为变更。

**Verification**：文档内搜不到 `offset_ns_max`；浏览器打开渲染正常。

---

## 系统级影响

- **新依赖**：前端 `echarts ^6.1.0`（boss 已批）。Rust 无新增（reqwest 已在）。
- **DB schema**：新增 `task` 表，命令式守卫迁移，老库自动建表、不破坏既有数据。
- **设置面板**：新增硬件 API 地址项，与软仿远端配置并列。
- **外部契约**：本应用作为 tsn-sim 服务的 HTTP 客户端，按 origin 文档的请求/响应契约编码；服务端版本变化由 U9 脚本监测（目前为手动运行，CI 集成待 boss 后定，非自动化）。tsn-sim API 当前无认证，依赖 Tailscale 网络层隔离 + WireGuard 传输加密，plain HTTP 可接受；若 base_url 改指公网需补 token 认证 + HTTPS。

---

## 风险与依赖

**R1 · sync_period 128 撞硬件可用值（高，首用即触发）。** 应用默认 `syncPeriod=128ms`（`set_gm` 给每个默认会话无条件补），但硬件只接受 `1000/500/250/125ms`。所以**任何走默认流程的会话首次点硬件部署都会被 task_validate 判 WARN/FAIL**——这不是小概率边角，而是 happy path 对默认配置近乎必然失败。**缓解**：KTD7 不映射；但 U8 的 validate-FAIL 文案要专门处理这一条——命中 sync_period 不可用值时给明确引导（「当前 128ms 硬件不支持，请回时间同步阶段改为 1000/500/250/125」），避免用户/验收把「按设计暴露 issues」误读成「接口没接通、功能坏了」。boss 接受现行为，但首用观感靠这条文案兜住。

**R2 · 拓扑规模约束（中）。** `type=hardware` 当前只支持 2 switch + 3 endSystem，且 `timesync_nodes[].mid` 必须与 `topology_nodes[].mid` 一一匹配。不符会 validate 失败。**缓解**：task_validate 暴露，前端展示。

**R3 · 端口数组类型（中）。** 库里端口存 JSON 字符串 `"[1,2]"`，API 要求真数组。**缓解**：U2 用 `parse_i64_array` 转换 + 测试断言数组类型。

**R4 · 轮询泄漏（中）。** observing 两个 interval（metrics 1s + task_query 5s）若不随会话切换/停止/终态/软超时清理会泄漏、串数据。**缓解**：U8 两个 ref + sessionId 守卫 + cleanup，参考软仿/PR#23 教训。

**R5 · echarts 包体积（低）。** echarts ~1MB+。**缓解**：boss 已接受；后续可按需 tree-shake（deferred）。

**R6 · PR #68 来自 fork（低）。** 不直接 merge。**缓解**：U6 cherry-pick 文件内容、完成后 `gh pr close 68`。

**R7 · 远端孤儿任务（中）。** 切会话/关应用时远端硬件 task 仍在真设备上跑，UI 已丢失对它的引用。**缓解**：KTD9 切会话前 best-effort `hardware_stop`；停不掉的接受由服务端 `duration` 超时回收（本应用不做服务端侧自动回收，超出可控范围）。

**R8 · metrics camelCase 喂坏图表（中）。** 见 KTD11——若 `hardware_metrics` 误按仓库惯例加 camelCase，echarts 组件读 snake_case 全落空、静默空图。**缓解**：KTD11 强制 `serde_json::Value` 透传 + U6 必做的真实形状端到端断言。

---

## Deferred to Implementation（执行时再定）

- echarts 组件 props 的辅助字段喂入（`nodeLabels` 节点显示名、`masterNodeId` = GM 的 mid、阈值线取 `runs[].threshold_ns` 而非组件默认 200）——U8 对接时定。
- task_query 探终态的具体重试上限 / created 等待余量 / 软超时余量数值——U7/U8 实现时定（KTD8 给方向）。
- 各阶段错误文案的具体中文措辞（除 R1 的 sync_period 引导已点名）——U8 实现时定。
- U9 脚本是否进 CI——boss 后定。

---

## 来源

- origin ideation：`docs/ideation/2026-06-26-hardware-deploy-api-integration-ideation.md`
- API 契约：`docs/prototypes/tsn-sim_前端调用接口文档.html`
- 软仿参照：`src-tauri/src/inet_sim_command.rs`、`src-tauri/src/inet_remote.rs`、`src-tauri/src/inet_sim_bundle.rs`
- DB schema：`src-tauri/src/db.rs`
- 图表来源：PR #68（`thanktiger:codex/time-sync-offset-chart-component`）
