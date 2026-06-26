# tsn-sim 接口契约/回归测试脚本 — Requirements

- 日期：2026-06-26
- 来源：ce-ideate `docs/ideation/2026-06-26-sim-interface-contract-tests-ideation.md`
- 范围：Standard（独立测试套件，不碰 tauri / 不碰主 vitest）
- 接口文档：`tsn-sim_前端调用接口文档.html`（@tsn/sim v0.1.0，已通读）

## Outcome（一句话）

在 `scripts/sim-contract/` 建一套**独立、连真机、不进 tauri 也不进主 vitest** 的测试脚本：用一份手写 zod 契约 schema 当唯一「预期值」基准，对 tsn-sim 接口的**确定性面**（契约形状 + 枚举域 + 错误码 + `task_validate` 校验裁决）做精确断言，并加一个版本哨兵，使得 tsn-sim 任何一版改了响应形状/枚举/版本号时，本地一跑 `npm run test:sim` 就能立刻发现漂移。

## Problem & Context

- tsn-sim 是一个独立 HTTP 服务（`http://100.78.48.43:19080/sim`，内网 Tailscale），8 个端点：healthz / version / task_check / task_validate / task_start / task_query / task_metrics_query / task_stop。tsn-agent 未来要把时钟同步配置下发给它跑仿真+硬件。
- 仓库里**现在没有任何代码调过这个接口**（全新）。boss 要先有一套测试，**保证接口每个版本都返回预期结果值**，再在其上建真正的集成。
- 接口有两种性质完全不同的面：**确定的**（schema 形状、枚举、错误码、`task_validate` 裁决——同输入同输出）和**不确定的**（真实硬件/仿真跑出的 `offset_ns`——数值天生抖动）。把两面混测必出假阳性。**本轮只做确定性面**。

## Users & Value

- 用户：单人（boss/开发者）。
- 价值：tsn-sim 升级时，本地一条命令就能确认「接口契约没破、校验逻辑没变味、版本没偷偷动」，把「集成层建在流沙上」的风险前移到一个廉价、确定、可每次跑的闸。

## Functional Requirements

- **R1 隔离骨架**：测试脚本放 `scripts/sim-contract/`（新文件夹）。用**独立 vitest project**（自带配置，**不**进根 `vitest.config.ts` 的 include），独立命令 `npm run test:sim` 触发。**不进 tauri 逻辑、不进主 vitest 套件、不进 CI**（本轮）。
- **R2 zod 契约 schema 是唯一「预期值」源**：手写覆盖 8 端点的请求/响应 zod schema（仓库 `src-node/mcp/topology-tools.ts` 已用 zod，风格可循）。包含全部枚举域：task status（created/queued/running/done/failed/timeout/stopped）、verdict（PASS/WARN/FAIL/ERROR）、issue severity（ERROR/WARN/INFO）、error.code（invalid_config/not_found/queue_full/internal_error）、metrics mode/status 等。schema 改动本身是一次可 review 的 diff。schema 与未来 tauri 集成层共用同一份类型（复利）。
- **R3 L1 契约层（连真机、不启动任务）**：对 healthz / version / task_check 的 live 响应做 schema 一致性断言 + 枚举域断言；对错误响应结构断言（用一个可稳定触发的错误，如 `task_query` 查不存在的 task_id → `{error:{code,message}}`，code 属已知集合）。这些端点不启动仿真/硬件，无副作用。
- **R4 L2 校验层（连真机、不启动任务）**：`task_validate` 喂 fixtures——
  - 一份**合法配置**（用 `type=simulation` 以避开真实硬件 MID 耦合，保持稳定）→ 断 verdict=PASS 及 `task_start_compatible`/`ready` 的预期。
  - 一批**违规配置**，每条断期望的 verdict 与 `issues[].code`/`category`，覆盖文档列出的约束：端口越界（`src_port>=port_num`）、`gm_mid` 不等于任何 `hcp_mid`、master/slave 端口位重叠、`sync_period` 越界或传了 0x/A-F、`type=simulation` 缺 `sim_time_us`、topo_feature 引用不存在的节点、task_id 不匹配命名正则。
  - 具体覆盖哪几条违规、断到 code 还是 category 粒度，planning 定。
- **R5 版本哨兵**：钉住当前已知 `tsn_sim_version` + `api_version`（现 v0.1.0），并钉住契约 schema 的指纹（内容 hash）。**版本号变了、或 schema 指纹变了但没人复核** → 测试 fail，逼一次人工确认「接口是不是真变了、schema 要不要跟」。直接服务「保证每个版本」这个核心诉求。
- **R6 零硬件副作用**：本轮**不调用 `task_start`**（不启动任何真实仿真/硬件运行），因此无需 task_stop 清理纪律、无 30 分钟等待、无非确定数值。所有断言都落在确定性响应上。
- **R7 连不上服务要诚实**：脚本依赖真机 19080 可达（内网）。服务不可达时必须**清晰报错或显式跳过**，绝不能假绿（否则「保证预期值」失效）。具体「fail 还是 skip」由 planning 定。

## Scope Boundaries

**本轮做**：R1–R7 —— 隔离骨架 + zod 契约 schema + L1 契约层 + L2 校验层 + 版本哨兵，全连真机、不启动任务。

**推迟到下一轮（硬件结果面）**：
- `task_start`→`task_query` 任务生命周期状态机测试
- `task_metrics_query` 的指标不变量断言（p99≥p95、sync_rate∈[0,1]、GM offset≈0 等）
- 录制真实响应当黄金 fixture + 回放
- 真机 smoke（启动真实任务）及其副作用纪律（唯一 task_id + 最小 sim_time + 必 task_stop 清理）

**身份外（不做）**：
- 把测试写进 `src/**/*.test.ts`（主 vitest）或任何 tauri 代码路径
- 把离线层接进 CI gate（CI 连不到内网真机；要接需先解决「CI 能否连服务 / 或纯 mock」，本轮 defer）
- 用自动生成（从文档/响应）替代手写 zod schema
- 断言绝对 `offset_ns` 数值、写死实验台硬件 MID（0..4，文档明说非固定规则）

## Success Criteria

- 在内网、tsn-sim 可达时，`npm run test:sim` 全绿。
- tsn-sim 出一版改了某响应形状/枚举/版本号 → 本套件 fail，并能指向漂移点（schema 不符 或 版本哨兵）。
- `task_validate` 的好/坏配置 fixtures 按预期精确断 verdict + issues。
- 套件完全独立：不在主 `vitest run` 里、不在 tauri 构建里、`npm run test:sim` 单独可跑。
- 服务不可达时清晰报错/跳过，不假绿。

## Dependencies / Assumptions

- **已核实**：接口文档完整通读（8 端点请求/响应字段、枚举、约束、错误码）；仓库零现有调用；zod 已是依赖；根 `vitest.config.ts` include 只覆盖 `src/`+`src-node/`，独立 project 不会被主套件吸入；`scripts/` 现为纯 node 零依赖脚本（本轮改用独立 vitest project，是有意偏离，因契约/快照断言更顺手——boss 已定）。
- **假设**：`task_validate` 对**配置结构**的 verdict/issues 是稳定的（不依赖真实硬件状态）；但其 env 相关字段（如 `ready`、依赖 task_check 的环境可用性）可能随实验台状态变——这类字段断言要谨慎或单独处理，planning 定。
- **假设**：合法配置 fixture 用 `type=simulation` 可避开 `hcp_mid` 必须对应真实设备的硬件耦合，从而版本稳定。若 `task_validate` 对 simulation 仍校验硬件 MID，planning 需调整 fixture 策略。
- **约束**：测试连真机、本地手动跑；不进 CI。
- **服务地址**：sim 服务在 `:19080`（注意接口**文档**站点是 `:19081`，别混）。base url 应可经 env（如 `SIM_BASE_URL`）覆盖，默认指向 19080。

## Open Questions（留给 planning）

- 服务不可达时：整体 fail 还是 skip（带醒目提示）？
- R4 违规配置具体覆盖哪几条、断到 `code` 还是 `category` 粒度。
- R3 错误响应：哪个错误最可稳定触发用来断 `{error:{code,message}}`（`not_found` via 未知 task_id 是候选）。
- 版本哨兵的 schema 指纹怎么钉（单测里硬编码 hash？单独 fixture 文件？）。
- 独立 vitest project 的接法：单独 `vitest.sim.config.ts` + `vitest run -c` 还是 workspace/projects 配置——planning 选。
