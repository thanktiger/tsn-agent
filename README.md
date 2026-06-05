# TSN Agent

## 诊断日志

应用提供按会话归属的诊断日志，用于排查 Claude 交互、会话保存和导出文件刷新问题。点击顶部“日志”按钮可以查看当前会话的日志时间线。

日志只保存脱敏后的摘要，例如 run id、是否 resume、chunk 统计、session 保存状态、artifact 文件路径和错误摘要。不要把日志当作项目交付产物；`.ned`、`omnetpp.ini`、React Flow JSON、`flow_plan_1.json` 和 manifest 仍然是独立文件边界。详细契约见 `docs/diagnostics-log-contract.md`。

TSN Agent 是一个 Tauri + React 桌面应用 MVP，面向了解 TSN 概念但不熟悉参数配置的新手用户。当前纵向闭环支持输入一句网络规模描述，例如“我需要 4 个交换机，每个交换机连接 5 个端系统”。应用默认按“拓扑、时间同步、流量规划、模拟仿真”四个用户可见阶段推进，每个关键阶段会展示摘要并等待用户确认。稳定阶段 ID 为 `topology`、`time-sync`、`flow-template`、`planning-export`。

> **Phase A 状态（2026-06-04）**：`flow-template`（流量规划）和 `planning-export`（模拟仿真）阶段在 Phase A → Phase B 周期内 **UI 灰掉**（aria-disabled + tooltip + inline banner），项目导出整条链路暂时下线，Phase B 回归。当前可用闭环到“拓扑 + 时间同步”。下文“项目导出文件”为 Phase B 目标。

拓扑阶段不再把结果合成进会话内嵌的 canonical project；智能助手通过 `tsn_topology` MCP（所有工具走本机 axum sidecar HTTP）将拓扑写入 SQLite P0 表，UI 通过 `session_db_changed` event + `query_topology` Tauri command 实时读取并刷新画布、节点详情和链路详情。详见 `docs/topology-mcp.md`。

Phase B 回归后，“模拟仿真”阶段会生成拓扑草案、1 条控制流模板和项目导出文件：

- `tsnagent/generated/network.ned`：面向 INET/OMNeT++ 的最小 NED 网络文件，路径与 `tsnagent.generated` package 匹配。
- `omnetpp.ini`：最小 Cmdenv 运行配置，用于加载生成的 NED 网络。
- `react-flow-topology.json`：给 React Flow 展示用的拓扑 JSON。
- `flow_plan_1.json`：兼容现有规划器输入样例的 `base + stream_info` 结构。
- `manifest.json`：导出文件清单。

`flow_plan_result_1.json` 不由 MVP 默认生成；如果外置规划器后续写入该文件，应用只把它识别为外部规划器输出，不解析 GCL/interface 摘要。导出会拒绝 repo 根目录、home 根目录、应用配置目录、根目录和 symlink 目标。`omnetpp.ini` 只承诺能让 INET/OMNeT++ 加载并运行基础拓扑；gPTP、TAS/GCL、调度器选择、业务流应用和规划结果回写仍放在后续 `inet-export` skill 中扩展。

当前版本仅在 Tauri 桌面版可用：通过本机 Node worker 调用官方 `@anthropic-ai/claude-agent-sdk`，复用用户本机 Claude Code 配置。非 Tauri（Web 浏览器预览 / E2E）环境 fail-closed，返回「需要桌面版」提示，不再有 fake agent 兜底。执行步骤面板会显示阶段 skill、工具可用状态摘要和 artifact 事件；真实 `tool_use/tool_result` 解析仍是后续工作。会话支持新建、切换、复制、删除；Tauri 运行时使用 SQLite 保存会话恢复状态与拓扑 P0 表，Web/测试环境使用浏览器 `localStorage` 回退。

## 开发

```bash
npm install
npm run dev
```

Tauri 开发入口：

```bash
npm run tauri dev
```

## 测试

```bash
npm test
npm run build
npm run e2e
npm run cargo:test
```

测试范围说明见 `docs/testing.md`。

真实 Claude 对接要求本机已安装 Node.js，并且 Claude Code 已完成登录。应用不会读取或保存 Claude Code 凭证，SQLite 只保存脱敏后的会话文本、agent event 摘要、canonical state 和导出清单。

## 目录边界

`tsn-topology/` 是已有的独立 skill 仓库，当前存在未提交修改。根目录应用把它作为只读迁移参考，不纳入根 Git 管理，也不会在本 MVP 中修改其中内容。
