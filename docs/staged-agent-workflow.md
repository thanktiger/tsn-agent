# TSN Agent 分阶段工作流

> **Phase A 状态更新（2026-06-04）**
>
> Plan v3 `docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md`
> 落地后：`flow-template` 和 `planning-export` 阶段在 Phase A → Phase B 完整周期间
> **UI 灰掉**（aria-disabled + tooltip + inline banner "流量规划与规划导出在当前
> 版本暂时下线，预计 v0.X 回归"），boss 在 P1 重新构建。阶段 ID 不变以保证
> 历史 session 兼容。

## 阶段

TSN Agent 当前使用四个稳定阶段 ID：

- `topology`：Project/Agent 层解析自然语言拓扑规模，调用 `tsn_topology` MCP（Phase A 起所有工具走 axum sidecar HTTP → SQLite P0 表），UI 通过 `query_topology` Tauri command 读 P0 表 hydrate。
- `time-sync`：展示时间同步默认假设，后续再细化 gPTP、GM 和端口关系。
- `flow-template`（**Phase A 灰掉**）：用户可见为"流量规划"，基于当前拓扑准备 ST 控制流/视频流等流量输入。Phase B 回归。
- `planning-export`（**Phase A 灰掉**）：用户可见为"模拟仿真"，刷新项目导出文件，并可启动真实规划任务。Phase B 回归。

阶段完成后进入 `waiting_confirmation`，用户点击"确认并继续"才进入下一阶段。Phase A 期间确认拓扑后停留在 `time-sync`，无法继续推进后两阶段。

## 事件

执行步骤面板显示用户可理解的事件摘要：

- `stage-start` / `stage-result`：阶段开始和阶段结果。新拓扑主链路使用 `WorkflowStageResult`，来源由 `producer` 标识。
- `skill-result`：旧会话/旧 fixture 中的本地阶段 skill 结果事件，仅作为兼容读取，不作为新拓扑成功事件。
- `tool-availability`：当前工具/MCP 可用状态摘要。
- `confirmation-required`：等待用户确认的提示。
- `artifact`：导出清单或规划器输入已刷新。
- 规划任务事件：启动、轮询、busy、停止、读取结果和刷新 artifact，诊断只保存 plan id、状态、耗时、错误和文件摘要。

当前执行步骤中的 `tool-availability` 会展示 `tsn_topology` 的 available / unavailable / call_failed 摘要。Phase A 起 MCP response 已是结构化领域响应（`responseMode` / `topologyFullAllowed` 字段已删除）；`topology.initialize` / `topology.apply_operations` 默认带 `full.topology`，其余工具默认 summary。完整 artifact、端口表、MAC 表和完整 changeSet 不进入对话或诊断日志。诊断日志保存脱敏后的 run id、耗时、chunk 统计、工具可用状态和错误摘要；存储改为 `<app-config>/logs/sess-<id>/agent-run-<runId>.jsonl` 文件（sqlite `diagnostic_logs` 表已 DROP）。

## Topology MCP 边界

拓扑阶段有两条路径：

- 从 0 初始化：Project/Agent 层选择模板和结构化参数，`topology.initialize` 通过 sidecar 计算并整表重建 P0 表，返回 `summary.mutationId`（不回传 full topology；查询持久化结果用 `topology.inspect`）。UI 通过 `session_db_changed` event + `query_topology` Tauri command hydrate。
- 已有拓扑编辑：调用 `topology.inspect`（无参数）拿到全部持久化 rows，在 rows 中按 `imac`/`linkSeq` 定位目标节点/链路，再用 `topology.apply_operations` 处理 `link_delete`、`node_add`、`link_add` 等原子操作。

`tsn_topology` 不做自然语言理解、不保存 topology handle、不生成 project、不推进 workflow，也不导出 `network.ned`、`omnetpp.ini` 或 `flow_plan_1.json`。这些仍属于 Project/Export 层（Phase A 期间 flow / planning 导出被 UI 灰掉，Phase B 回归）。

> Phase A 边界：`dual-plane-redundant` 模板在 sidecar 返 `INVALID_TEMPLATE_PARAM`（含 `phase: "A"` + `deferredTo: "Phase B"`），完整 dual-plane Rust 端 port 是 Phase B polish 子任务。

## ScenarioConfig

`ScenarioConfig` 是轻量应用场景配置模型，负责场景显示名、阶段文案、默认拓扑值、同步说明、流模板和术语映射。核心阶段引擎只依赖稳定阶段 ID，不复制舰载/箭载等场景流程。

第一版内置：

- `generic-tsn`：默认通用 TSN 配置。
- `aerospace-onboard`：箭载/舰载 TSN 典型场景占位配置。

session/workflow state 只保存 scenario config id。未知 id 会回退到 `generic-tsn`，避免旧会话无法打开。

## 导出边界

拓扑、时间同步和流量规划阶段可以存在 project 草案，但 UI 不显示“仿真已执行”或“导出已完成”。只有到 `planning-export` 阶段后，用户才看到仿真输入文件和保存/导出动作。

`planner/flow_plan_1.json` 是规划器输入，不是规划器运行结果。真实规划任务成功并读取结果后，应用才会生成 `planner/flow_plan_result_1.json`，并标记为 `planner-output` / `observedExternal=true`。

成功结果还会追加 `simulation/inet/planner-gcl.json` 和 `simulation/inet/planner-gcl-notes.md`。这两个文件是从真实 `solution_json` 派生的 INET/GCL 可追溯中间产物，保留 link id、stream id、state 和 interval 原值；当前不声明为完整可运行的 TAS gate schedule。
