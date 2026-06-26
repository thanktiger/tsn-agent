# tsn-sim 硬件下发接口：契约/回归测试脚本 ideation

- 日期：2026-06-26
- 模式：仓库内分析（repo-grounded），接口契约来自外部文档
- 焦点：给「时钟同步硬件下发接口」（tsn-sim，`http://100.78.48.43:19080/sim`，8 个端点）建一套**独立于 tauri、放在 `scripts/` 下新文件夹**的测试脚本，保证接口每个版本都返回预期结果值
- 接口文档：`tsn-sim_前端调用接口文档.html`（v0.1.0，已通读）
- 产出：7 条排序方向 + 否决清单（说人话版，不堆术语）

## 一句话结论

**别想着「调接口然后断言 offset 等于某个值」——硬件/仿真跑出来的数值天生不确定，那样测必然假阳性。** 正解是按「确不确定」把测试分三层，每层用**不同方式定义「预期值」**：确定的部分（schema 形状、枚举、错误码、`task_validate` 裁决）精确断言；不确定的部分（真实 offset）只断结构、不变量和 SLO 通过位。把一份机器可读的契约（zod，仓库已在用）当地基，live 响应对它做一致性检查，版本漂移就有了哨兵。真机昂贵路径（启动真任务、跑 30 分钟）靠录制 fixture + 回放，不在每次 CI 真跑。

## 接口的关键事实（决定怎么测）

| 事实 | 对测试的含义 |
|---|---|
| `task_start` 返回 **202 异步**，要 `task_query` 轮询到 done/failed/timeout/stopped | 没有「一次调用拿结果」，测的是**状态机**不是单次返回 |
| 运行时长可达 30 分钟（`sim_time_us`/`duration_sec`） | CI 不可能每次真跑；昂贵路径必须录制回放或最小化时长 |
| `task_validate` **不启动运行**，纯配置逻辑，返回 verdict(PASS/WARN/FAIL)+issues[] | 这是**完全确定**的一块——「预期值」最硬最稳的金矿 |
| `offset_ns` 等指标来自真实硬件/仿真 | 绝对数值不可断言；只能断结构 + 不变量 + `pass`/`threshold` |
| 有 `/sim/version`（`tsn_sim_version` + `api_version`） | 版本可探测——天然的漂移哨兵锚点 |
| 错误响应统一 `{error:{code,message}}`，码有 invalid_config/not_found/queue_full/internal_error | 错误契约可枚举、可精确断言 |
| 配置约束极多且明确（端口范围、gm_mid 必须等于某 hcp_mid、master/slave 端口不重叠、sync_period∈-10..3…） | 每条约束 = 一个可构造的「坏配置→预期 FAIL」用例 |
| 仓库里**零现有调用**，zod 已是依赖，scripts/ 是纯 node 零依赖风格 | 全新建；技术选型自由，但贴合 zod + 纯 node 文化最省事 |

## 拆解的 5 个轴

- **A. 测什么层** — 纯契约 / 校验逻辑 / 任务生命周期 / 指标语义
- **B.「预期值」怎么定义** — 精确等值 / 结构契约 / 不变量 / SLO 带 / 黄金快照
- **C. 抗版本漂移** — version 端点 / schema 快照 / 漂移哨兵
- **D. 怎么跑、跑哪** — 纯 node vs vitest project、真机 vs 离线、副作用清理、env 闸
- **E. 与仓库的边界** — 独立到什么程度、产物放哪、要不要进 CI

---

## 排序后的方向

### 1. 按「确定性」分三层组织测试，每层定义不同的「预期值」（地基，先定这个）

- **轴**：A + B　**信心**：高　**复杂度**：M
- **是什么**：
  - **L1 契约层（确定，不跑任务）**：healthz/version/task_check 的响应形状 + 全部枚举域（status/verdict/severity/error.code）+ 错误响应结构。预期值 = **精确断言**。
  - **L2 校验层（确定，不跑任务）**：`task_validate` 喂各种好/坏配置，断 verdict + issues[].code/category。预期值 = **精确断言**（见 #3）。
  - **L3 生命周期 + 指标层（不确定，要跑任务）**：`task_start`→`task_query` 状态机合法迁移、终态结构；`task_metrics_query` 各 mode 的结构 + 不变量。预期值 = **结构契约 + 不变量 + SLO 通过位，不是绝对数值**（见 #7）。
- **依据**：`direct:` 文档明确 task_validate 不启动运行、task_start 是 202 异步、offset 来自真实硬件。
- **为什么是地基**：把「能精确断的」和「只能断结构的」从一开始分开，是这套测试不出假阳性的根本。后面每条 idea 都挂在某一层上。

### 2. 把 8 个端点的契约固化成一份 zod schema，live 响应对它做一致性检查

- **轴**：B + C　**信心**：高　**复杂度**：M
- **是什么**：手写一份覆盖 8 端点请求/响应的 zod schema（仓库 `src-node/mcp/topology-tools.ts` 已经这么用 zod）。「每个版本返回预期值」的最朴素定义 = **live 响应能被这份 schema 成功 parse**。schema 改动本身是一次 reviewable 的 diff。
- **依据**：`direct:` zod 已是 repo 依赖、已有 zod 用法；`external:` 消费者驱动契约测试（Pact）的核心思路——消费方写下期望，提供方按期望被验证。
- **为什么**：一份 schema 同时服务三件事：① live 一致性测试 ② 请求体构造/校验 ③ **未来 tauri 真集成层直接复用类型**。是这次投入里复利最高的资产。zod 能纯 node 跑，不绑 tauri。

### 3. 拿 `task_validate` 当「确定性预期值」的金矿——构造好/坏配置断言 verdict + issues

- **轴**：A + B　**信心**：高　**复杂度**：S–M
- **是什么**：建一个 fixtures 库：一份合法配置 → 期望 PASS；再针对文档列出的每条约束造一个违规配置，断期望的 verdict 和 issues[].code：
  - `src_port >= port_num`（端口越界）
  - `gm_mid` 不等于任何节点的 `hcp_mid`
  - master_port / slave_port 端口位重叠
  - `sync_period` 超出 -10..3、传了 0x/A-F
  - `type=simulation` 却缺 `sim_time_us`
  - topo_feature 引用了 config.node 里不存在的节点
  - task_id 不匹配 `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`
- **依据**：`direct:` 文档把约束写得非常细，每条都能直接翻译成一个用例。
- **为什么**：这是「每版本都返回我预期结果值」里**最硬、最稳、最不会假阳性**的部分——纯配置逻辑、零硬件依赖、可在 CI 每次跑。优先把这块做厚。

### 4. 昂贵/非确定路径用「录制真实响应当黄金 fixture + 回放」（VCR / approval 模式）

- **轴**：B + D　**信心**：中　**复杂度**：M
- **是什么**：对 `task_start`→`task_query`→`task_metrics_query` 这条要真跑的链路，**录一次**真实交互存成 JSON fixture。CI 默认 **回放 fixture** 跑结构/契约断言；真机 smoke 单独 `SIM_LIVE=1` opt-in，重录时和旧 fixture 做 diff——**版本漂移就在 diff 里现形**。
- **依据**：`external:` VCR/nock（录制回放）、approvaltests（黄金主对账）是成熟套路；`direct:` 文档说运行可达 30 分钟、202 异步——CI 真跑不现实。
- **为什么**：直接化解「硬件非确定 + CI 不能每次跑半小时真任务」这个核心矛盾。fixture 既是回归基线，也是漂移检测的对照物。

### 5. `/sim/version` + schema 指纹做「版本漂移哨兵」

- **轴**：C　**信心**：中　**复杂度**：S
- **是什么**：测试里钉住当前已知的 `tsn_sim_version` / `api_version`。把契约 schema 的指纹（内容 hash）绑在这个版本上：**版本号变了、但 schema 没人复核**就直接 fail，逼一次人工确认。
- **依据**：`direct:` 文档有 version/api_version 两个字段，专为版本探测存在。
- **为什么**：直接命中你「保证**每个版本**返回预期值」的诉求——版本升级不再是悄悄发生、等出问题才发现，而是有个闸主动拦一下。

### 6. 隔离运行：纯 node + 零依赖，独立 npm script，不进主 vitest

- **轴**：D + E　**信心**：高　**复杂度**：S
- **是什么**：放 `scripts/sim-contract/`（你说的「script 文件夹下新建文件夹」；仓库现有目录是 `scripts/`）。用内置 **`node:test`**（贴合 scripts/ 纯 node 零依赖文化）或一个**独立 vitest project**，**不**进主 `vitest.config.ts` 的 include（那是 jsdom + app 代码），独立 `npm run test:sim` 触发。真机地址/开关用 env 闸（`SIM_BASE_URL`、`SIM_LIVE`），CI 默认只跑离线层（L1+L2+回放）。
- **依据**：`direct:` `vitest.config.ts` include 只覆盖 `src/`+`src-node/`、scripts/ 全是纯 node、playwright 是浏览器 e2e 不适配纯 HTTP API。
- **为什么**：正面满足你「不进 tauri 逻辑、独立分离」的硬要求。env 闸让同一套脚本既能 CI 离线跑、又能对真机做 smoke。

### 7. 指标层做「不变量/属性断言」，而不是断数值（非确定接口的正解）

- **轴**：B　**信心**：中　**复杂度**：M
- **是什么**：offset 绝对值不确定，但大量**不变量是确定的**，全部可断：
  - `p99_abs_offset_ns >= p95_abs_offset_ns >= avg_abs_offset_ns`
  - `sync_rate ∈ [0,1]`、`threshold_exceed_count >= 0`
  - `pass` 与 threshold/exceed 的关系自洽
  - series 的 bucket 时间单调递增、bucket_end > bucket_start
  - latest / stats / series / samples 四个 mode 之间节点集合一致
  - `is_gm` 节点 offset 应近 0（GM 自身）
- **依据**：`reasoned:` 从字段语义直接推出的恒等关系；`external:` 属性测试 / Schemathesis 对 API 做不变量校验的思路。
- **为什么**：这把「非确定接口」变成「可断言」——是 L3 指标层定义「预期值」的真正答案，比录死数值稳得多。

---

## 否决 / 合并的候选（附理由）

| 候选 | 处理 | 理由 |
|---|---|---|
| 直接断言 `offset_ns == 某固定值` | **否决** | 真实硬件/仿真非确定，必然假阳性——正是这次要劝退的反模式 |
| 把测试写进现有 `src/**/*.test.ts`（vitest） | 否决 | 违背「独立、不进 tauri」；且 jsdom 环境不适配纯 HTTP 契约测试 |
| 上 OpenAPI + Dredd/Schemathesis 全家桶 | 否决 | 接口是 TypeDoc 生成、非 OpenAPI；引入重依赖属过度工程，手写 zod 更贴合仓库 |
| 每次 CI 真跑 `task_start` + 等 30 分钟 | 合并入 #4 | 不可行，收敛到录制回放 + 真机 opt-in smoke |
| 用 Playwright e2e 测这个接口 | 否决 | e2e 是浏览器 UI 自动化，纯 HTTP JSON API 用不上浏览器 |
| 把硬件 MID（0..4 实验台）写死进断言 | 否决 | 文档明说「该范围不是接口固定规则」；写死会随实验台变动假阳性 |

## 落地次序（如果决定做）

1. **先定地基**：#1（三层分法）+ #6（独立运行骨架，`scripts/sim-contract/` + `npm run test:sim` + env 闸）。
2. **做厚最稳的一层**：#3（task_validate 好/坏配置库）+ #2（zod 契约 schema）——这两块确定、可 CI 每次跑、复利最高。
3. **接非确定层**：#7（指标不变量）+ #4（录制回放）解决硬件路径。
4. **加版本哨兵**：#5（version + schema 指纹闸）。

## 给 ce-brainstorm 的悬而未决问题

- 测试 runner 选 `node:test`（零依赖、贴 scripts/ 文化）还是独立 vitest project（断言/快照更顺手）？—— 影响骨架。
- 「预期值」的权威源放哪：手写 zod schema，还是从接口文档/真实响应自动生成 schema？
- 真机 smoke 的副作用纪律：每个 live 用例用唯一 task_id + 最小 sim_time + 必 `task_stop` 兜底清理——这条要不要做成硬约束。
- CI 接不接：离线层（L1/L2/回放）进 CI 卡点，还是先只做本地手动跑。
