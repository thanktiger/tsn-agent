---
title: "feat: tsn-sim 接口契约/回归测试套件"
type: feat
date: 2026-06-26
origin: docs/brainstorms/2026-06-26-sim-interface-contract-tests-requirements.md
depth: Standard
---

# feat: tsn-sim 接口契约/回归测试套件

## Summary

在 `scripts/sim-contract/` 建一套独立 vitest project（不进主 vitest、不进 tauri，`npm run test:sim` 触发），用一份手写 zod 契约 schema 当唯一「预期值」基准，对 tsn-sim 接口的确定性面做断言：L1 契约层（healthz/version/task_check + 错误响应）、L2 校验层（`task_validate` 好/坏配置）、版本哨兵（version + schema 内容指纹）。schema 必须 `.strict()`/`z.enum` 且配反向自测证明它能挡漂移；首次落地前必须对真机验真。本轮全连真机、不启动任务、零硬件副作用。

## Problem Frame

tsn-agent 未来要把时钟同步配置下发给独立 HTTP 服务 tsn-sim（`http://100.78.48.43:19080/sim`，内网，8 端点）跑仿真+硬件。仓库现在零调用。需先有一套测试，**保证接口每个版本都返回预期结果值**，再在其上建集成。接口分两面：确定的（schema 形状、枚举、错误码、`task_validate` 裁决）和不确定的（真实 `offset_ns`）。本轮只做确定性面——不确定面（指标/生命周期/录制回放）推迟。

「预期值」分层含义（贯穿全计划）：L1 保证形状+枚举域符合（漂移检测，**非数值正确**）；精确预期值断言只在 L2（`task_validate` 对固定 fixture 的 verdict/issues）。

## Requirements（trace to origin）

- **R1** 隔离骨架：`scripts/sim-contract/`，独立 vitest project，不进主 vitest/tauri/CI。
- **R2** zod 契约 schema 是唯一「预期值」源：本轮 5 端点（healthz/version/task_check/task_validate/task_query），`.strict()` + `z.enum`，配反向自测。
- **R3** L1 契约层：healthz/version/task_check live 解析 + 枚举断言 + 错误响应结构（task_query 未知 id）。
- **R4** L2 校验层：`task_validate` 好配置→PASS，坏配置（全部列出的违规类型）→verdict≠PASS + issues。
- **R5** 版本哨兵：钉 version/api_version + schema 文件内容 hash；漂移即 fail。
- **R6** 零硬件副作用：不调 `task_start`。
- **R7** 连不上服务要诚实：**不可达 → FAIL（非零退出）**，绝不假绿。
- **R8** schema 必须先对真机验真（首次落地闸）。

## Key Technical Decisions

- **KTD1 — Runner = 独立 vitest config 文件**。`scripts/sim-contract/vitest.config.ts`，`test.environment: 'node'`，`test.include` 只指向 `scripts/sim-contract/**/*.test.ts`，**不引 React/vite 插件链**（避免继承根 `vite.config.ts` 的 jsdom/React 开销，feasibility FYI）。`npm run test:sim` = `vitest run -c scripts/sim-contract/vitest.config.ts`。根 `vitest.config.ts` 的 include 只覆盖 `src/`+`src-node/`，天然不吸入本套件——U1 加一个守卫测试钉死这条隔离。
- **KTD2 — HTTP 用 Node 原生 `fetch`**，零新依赖（仓库 Node v24，原生支持 global fetch）。沿用 `scripts/*.mjs` 的纯 node 零依赖文化，但本套件用 TS + vitest（boss 已定，因契约/断言更顺手）。
- **KTD3 — 不可达 = FAIL（boss 定）**。一个 reachability 预检（GET healthz 带短超时）；连不上 → 抛错使整体非零退出 + 清晰信息（`SIM_BASE_URL` 不可达）。**不用 skip**（vitest skip 退出 0，会被误读成通过，违背 R7「绝不假绿」）。
- **KTD4 — 精确 issue code 留执行期钉**。文档没列每条违规对应的确切 `issues[].code`。计划层只定「断 verdict≠PASS + issues[] 含对应条目」；**每条违规的精确 code/category 在首次真机捕获后钉死**（Execution note，见 U4）。同理 R3 错误码（task_query 未知 id 期望 `not_found`）首次捕获后钉。
- **KTD5 — schema 指纹 = schema 文件内容 sha256，硬编码成哨兵测试里的常量**。哨兵测试运行时重算 hash 与常量比对；不符即 fail，逼人工复核后更新常量（这就是 R5 的人工确认闸）。**不**只比版本号字符串（否则空转）。
- **KTD6 — base url 经 env 覆盖**：`SIM_BASE_URL` 默认 `http://100.78.48.43:19080`（注意服务在 :19080，文档站点在 :19081，别混）。

---

## Output Structure

```
scripts/sim-contract/
  vitest.config.ts          # 独立 project：node 环境、自有 include、无 React 插件
  client.ts                 # fetch 封装：base url(env)、JSON post/get、reachability 预检
  schema.ts                 # zod 契约：5 端点请求/响应 + 全枚举域，.strict()/z.enum
  fixtures/
    valid-config.ts         # 合法 task_validate 配置（type=simulation）
    invalid-configs.ts      # 各违规类型配置 + 期望（verdict≠PASS）
  contract.test.ts          # L1：healthz/version/task_check live 解析 + 错误响应
  validate.test.ts          # L2：好/坏配置 verdict+issues
  schema-teeth.test.ts      # 反向自测：schema 拒绝漂移响应
  version-sentinel.test.ts  # 版本哨兵：version/api_version + schema 内容 hash
  README.md                 # 怎么跑、env、触发纪律、R8 验真步骤
```

`package.json` 加一个 script：`"test:sim": "vitest run -c scripts/sim-contract/vitest.config.ts"`。

---

## Implementation Units

### U1. 隔离骨架 + HTTP client + 不可达预检

**Goal**：建 `scripts/sim-contract/` 独立 vitest project、`test:sim` 脚本、`client.ts`（fetch 封装 + reachability 预检），并守卫「不进主 vitest」这条隔离。

**Requirements**：R1、R7、KTD1/2/3/6。

**Dependencies**：无。

**Files**：
- 建 `scripts/sim-contract/vitest.config.ts`
- 建 `scripts/sim-contract/client.ts`
- 改 `package.json`（加 `test:sim` script）
- 建 `scripts/sim-contract/isolation.test.ts`（隔离守卫）
- 建 `scripts/sim-contract/README.md`

**Approach**：
- `vitest.config.ts`：`environment: 'node'`，`include: ['scripts/sim-contract/**/*.test.ts']`，不声明 React 插件、root 指向该目录或显式空 plugins。
- `client.ts`：`simBaseUrl()`（读 `SIM_BASE_URL`，默认 19080）；`get(path)`/`postJson(path, body)`（原生 fetch，返回 `{status, json}`）；`assertReachable()`（GET `/sim/healthz`，短超时，连不上抛带 base url 的清晰错误）。
- 隔离守卫：断言根 `vitest.config.ts` 的 include 不含 `scripts/`（读文件字符串断言），证明 `npm test` 不会吸入本套件。

**Patterns to follow**：`scripts/*.mjs` 的纯 node 零依赖风格（错误信息清晰、单点失败）；根 `vitest.config.ts` 的结构。

**Test scenarios**：
- isolation：读根 `vitest.config.ts`，断言其 `test.include` 不匹配 `scripts/sim-contract/`（防回归——本套件被主 vitest 吸入）。
- client：`simBaseUrl()` 默认返回 19080；`SIM_BASE_URL` 设置后返回覆盖值。
- `assertReachable()` 对一个必然连不上的 base url（如 `http://127.0.0.1:1`）抛错且错误信息含 base url。
- Test expectation：reachability 对真机 200 的 happy path 归入 U3 的 live 测试（U1 只测 client 逻辑，不强依赖真机）。

**Verification**：`npm run test:sim` 能独立跑起来；`npm test`（主 vitest）不包含本目录；隔离守卫测试绿。

---

### U2. zod 契约 schema + 反向自测（牙齿）

**Goal**：手写 5 端点请求/响应 zod schema + 全枚举域，`.strict()`/`z.enum`；配反向自测证明 schema 拒绝漂移响应。

**Requirements**：R2、R8、KTD5 依赖此 schema 文件。

**Dependencies**：U1。

**Files**：
- 建 `scripts/sim-contract/schema.ts`
- 建 `scripts/sim-contract/schema-teeth.test.ts`

**Approach**：
- 覆盖端点：healthz / version / task_check 响应；task_validate 请求+响应；task_query 请求+响应（含错误响应 `{error:{code,message}}`）。task_start/task_metrics_query/task_stop **本轮不写**。
- 枚举用 `z.enum`：task status（created/queued/running/done/failed/timeout/stopped）、verdict（PASS/WARN/FAIL/ERROR）、issue severity（ERROR/WARN/INFO）、error.code（invalid_config/not_found/queue_full/internal_error）。
- 对象 schema 用 `.strict()`（拒绝未知字段）。可空字段按文档（如 simulation.reason string/null）用 `.nullable()`，**不**滥用 `.optional()`。
- 复用仓库 zod 风格：`src-node/mcp/topology-tools.ts`。

**Execution note**：**R8 首次验真**——schema 写完后、提交前，必须对 live 服务把 U3/U4 的 live 测试跑绿一次，证明 schema round-trip 真机 v0.1.0（不只是 round-trip 文档）。这是 schema 可信的前提，在 README 记录该步骤。

**Patterns to follow**：`src-node/mcp/topology-tools.ts` 的 zod 用法。

**Test scenarios**（schema-teeth.test.ts，反向自测）：
- healthz 响应 schema **拒绝**多一个未知字段的对象（`.strict()` 生效）。
- verdict schema **拒绝**越域枚举值（如 `"MAYBE"`）。
- task status schema 接受 `"running"`、拒绝 `"paused"`。
- error.code schema 接受 `"not_found"`、拒绝 `"weird_code"`。
- 一份合法的样例响应（按文档示例构造）能被对应 schema 成功 parse（正向 sanity）。

**Verification**：schema-teeth 测试全绿（既证明 schema 接受合法、又证明它拒绝漂移）；schema 覆盖 5 端点全部字段与枚举。

---

### U3. L1 契约层（live 解析 + 错误响应）

**Goal**：对 healthz/version/task_check 的 live 响应做 schema 一致性 + 枚举域断言；对错误响应结构断言（task_query 未知 id）。

**Requirements**：R3、R6、R8。

**Dependencies**：U1、U2。

**Files**：
- 建 `scripts/sim-contract/contract.test.ts`

**Approach**：
- 每个测试先 `assertReachable()`（不可达 → 整体 FAIL，KTD3）。
- healthz：GET，断 200 + 响应 parse 过 schema + `status ∈ {ok,degraded}`。
- version：GET，断 200 + parse + `tsn_sim_version`/`api_version` 是非空 string。
- task_check：POST `{}`，断 200 + parse + `simulation.available`/`hardware.available` 是 boolean。
- 错误响应：POST task_query 一个不存在的 task_id，断响应体匹配 `{error:{code,message}}` 且 `code` 属已知集合。
- 不调 task_start（R6）。

**Execution note**：错误响应的精确 `error.code`（期望 `not_found`）**首次真机捕获后钉死**——若服务对未知 id 返回非预期结构/码，改用其它可稳定触发的错误并记录（KTD4）。

**Patterns to follow**：U1 的 client。

**Test scenarios**：
- healthz live → 200 + schema parse 绿 + status 枚举合法。
- version live → 200 + schema parse 绿 + 两个版本字段非空。
- task_check live → 200 + schema parse 绿 + available 字段为 boolean。
- task_query 未知 id → 错误响应结构 `{error:{code,message}}`，code 属已知集合。
- 不可达路径：U1 已覆盖 `assertReachable` 抛错；此处确保每个 live 测试都先过预检（FAIL 而非静默跳过）。

**Verification**：内网真机可达时全绿；服务停掉时整体 FAIL 且信息清晰。

---

### U4. L2 校验层（task_validate 好/坏配置）

**Goal**：`task_validate` 喂好/坏配置 fixtures，好配置→PASS，坏配置（全部列出的违规类型）→verdict≠PASS + issues。

**Requirements**：R4、R6。

**Dependencies**：U1、U2。

**Files**：
- 建 `scripts/sim-contract/fixtures/valid-config.ts`
- 建 `scripts/sim-contract/fixtures/invalid-configs.ts`
- 建 `scripts/sim-contract/validate.test.ts`

**Approach**：
- 合法配置：`type=simulation`（避开真实硬件 MID 耦合，保持稳定，见 Assumptions），含最小合法 topo_feature/node/oss_cfg/slo/runtime（仿文档示例）。断 verdict=PASS + 响应 parse 过 schema。
- 违规配置：每条针对文档列出的一类约束，**最低覆盖全部类型**（KTD4，不得删减）：
  1. `src_port >= port_num`（端口越界）
  2. `gm_mid` 不等于任何节点 `hcp_mid`
  3. master/slave 端口位重叠
  4. `sync_period` 越界（如 99）
  5. `type=simulation` 缺 `sim_time_us`
  6. topo_feature 引用不存在的节点
  7. task_id 不匹配命名正则
- 每条断 verdict≠PASS，且 `issues[]` 非空、含一条 category/code 非空的条目。

**Execution note**：每条违规的**精确 `issues[].code`（或 category）首次真机捕获后钉死**——计划层不写死具体 code（文档未列每条对应码）。先断「verdict≠PASS + 有对应 issue」，跑一次真机拿到实际 code 再收紧到精确断言。

**Patterns to follow**：U2 schema、U1 client。

**Test scenarios**：
- 合法配置 → verdict=PASS + 响应 parse 绿 + `task_start_compatible`/`ready` 符合预期。
- 7 条违规配置各一个测试 → verdict≠PASS + issues[] 含对应条目（精确 code 执行期钉）。
- 响应整体过 task_validate 响应 schema（含 issues[] 结构）。
- 不调 task_start（R6）。

**Verification**：好配置稳定 PASS、7 条坏配置稳定非 PASS；真机捕获后精确 code 钉死。

---

### U5. 版本哨兵

**Goal**：钉住当前 version/api_version + schema 文件内容 hash；任一漂移即 fail，逼人工复核。

**Requirements**：R5。

**Dependencies**：U2、U3。

**Files**：
- 建 `scripts/sim-contract/version-sentinel.test.ts`

**Approach**：
- 版本钉：GET version，断 `tsn_sim_version`/`api_version` 等于硬编码的已知值（现 v0.1.0；实际值首次真机捕获后填）。变了 → fail，提示「tsn-sim 版本变了，复核 schema 后更新哨兵」。
- schema 指纹：运行时算 `schema.ts` 文件内容的 sha256，与硬编码常量比对；不符 → fail，提示「schema 改了，确认接口确实变了/没变后更新常量」（KTD5，人工确认闸）。
- 边界注释写进测试：哨兵只抓版本号/指纹漂移，**同版本静默破坏**靠 U3/U4 的 live 断言抓，哨兵绿≠接口没变。

**Execution note**：`tsn_sim_version`/`api_version` 的精确字符串与 schema sha256 常量在首次落地真机捕获后填入。

**Patterns to follow**：Node `crypto` 算 sha256（仓库 `src-node/eval/fingerprint.ts` 有 `sha256Hex` 可参照风格，但本套件零依赖、用 node:crypto 自实现，不跨目录 import）。

**Test scenarios**：
- version live → 等于钉住的已知版本（漂移即 fail）。
- `schema.ts` 内容 sha256 == 钉住常量（schema 改动未复核即 fail）。
- 反向 sanity：故意把比对常量改错时测试应失败（说明哨兵真在比，不空转）——以注释形式说明，不留真失败测试。

**Verification**：当前 v0.1.0 + 当前 schema 下全绿；改 schema 文件或版本变化时哨兵 fail。

---

## Scope Boundaries

**本轮做**：R1–R8（U1–U5）—— 隔离骨架 + zod schema（含牙齿）+ L1 契约 + L2 校验 + 版本哨兵 + 首次对真机验真。全连真机、不启动任务。

**推迟到下一轮（硬件结果面）**：
- task_start→task_query 生命周期状态机
- task_metrics_query 指标不变量（p99≥p95、sync_rate∈[0,1]、GM offset≈0）
- 录制真实响应当黄金 fixture + 回放
- 真机 smoke（启动真实任务）+ 副作用纪律（唯一 task_id + 最小 sim_time + 必 task_stop）
- 其余 3 端点（task_start/task_metrics_query/task_stop）的 schema
- 未来意图（非本轮）：zod schema 给 tauri 真集成层复用——本轮只服务一个消费者，不提前设计成共享库。

**身份外（不做）**：写进主 vitest/tauri；接 CI gate；自动生成 schema 替代手写；断绝对 offset 数值；写死实验台硬件 MID。

---

## Risks & Dependencies

- **R-1 schema 转录错误**：手写 schema 全靠人读 HTML，抄错枚举/字段/把必填写成 nullable → 测试假绿。缓解：R8 首次对真机验真（U2 Execution note）+ schema 牙齿反向自测（U3 实为 U2 的 schema-teeth）。
- **R-2 task_validate 对 simulation 仍校验硬件 MID**（假设：不会）。若假设破裂，合法配置 fixture 的 PASS 不稳定。缓解：U4 首次真机用 `type=simulation` 验证一次；若被硬件状态影响，调 fixture 策略并记录。
- **R-3 不可达=FAIL 的体验**：离线时 `npm run test:sim` 一定红。这是有意的（R7「绝不假绿」，boss 定）；README 说明这是预期，连不上内网时本就不该跑出绿。
- **R-4 触发纪律**：无 CI、无远端版本信号，「保证每个版本」依赖一条纪律——碰 tsn-sim 集成前先手动跑一遍。README 写明，避免误读成自动保证。
- **依赖**：Node 原生 fetch（v24 已确认）；zod（已在依赖）；vitest（已在依赖）。无新增外部依赖。

---

## Open Questions（执行期解决）

- 每条违规配置的精确 `issues[].code`/category：首次真机 task_validate 捕获后钉（U4）。
- 错误响应精确 `error.code`（期望 not_found）：首次真机 task_query 未知 id 捕获后钉（U3）。
- `tsn_sim_version`/`api_version` 精确字符串 + schema sha256 常量：首次落地填（U5）。
- 合法配置的最小字段集能否稳定过 task_validate（type=simulation）：首次真机验证（U4 / R8）。

---

## Verification（整体）

- `npm run test:sim` 在内网真机可达时全绿；服务停掉时整体 FAIL + 清晰信息。
- `npm test`（主 vitest）不包含 sim-contract 目录（隔离守卫绿）。
- schema 牙齿反向自测证明 schema 拒绝漂移响应。
- 7 条违规配置稳定非 PASS、合法配置稳定 PASS。
- 改 schema 文件或 tsn-sim 版本变化 → 版本哨兵 fail。
- 无新增依赖；不碰 tauri、不碰主 vitest、不进 CI。
