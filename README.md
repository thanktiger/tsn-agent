# HIBridge Agent

> 自然语言驱动的 TSN（时间敏感网络）拓扑规划桌面工具

HIBridge Agent 是一个 Tauri + React 桌面应用，面向了解 TSN 概念、但不熟悉具体参数配置的工程师。你用一句话描述网络规模——例如「我需要 4 个交换机，每个交换机连接 5 个端系统」——智能助手就会自动生成符合规范的 TSN 拓扑并落库，在画布上实时展示，供你确认和增量编辑。

整个规划按「拓扑 → 时间同步 → 流量规划 → 模拟仿真」四个用户可见阶段推进，每个关键阶段都会展示结构化摘要并等待你确认。

## 核心功能

- **自然语言生成拓扑** — 一句话描述网络规模，智能助手通过 MCP 工具调用本机服务生成拓扑并写入数据库，无需手动配置参数。
- **拓扑画布** — 基于 React Flow 的交互式画布，浮动连线、节点拖动持久化、按设备类型区分视觉、节点/链路详情面板。
- **四阶段工作流** — 拓扑、时间同步、流量规划、模拟仿真四个稳定阶段（ID：`topology`、`time-sync`、`flow-template`、`planning-export`），逐阶段确认推进。当前核心闭环聚焦拓扑的生成与增量编辑。
- **场景系统** — 会话可绑定行业语境（通用 TSN，以及箭载/舰载等专用场景），场景决定智能助手收到的领域 Reference 和可选模板；未知场景按通用场景回退。
- **可编辑 Skill 指引** — 领域语义、操作流程与推荐参数以可编辑指引形式注入，你可以在应用内修改，下次运行即生效；同时支持一键恢复出厂内容。
- **会话管理** — 新建、切换、复制、删除、导出、导入会话。导出为单会话 `.db` 切片（含已脱敏的对话、流程进度与拓扑工程），导入后可从原进度续走。
- **诊断日志** — 按会话归属的脱敏诊断时间线，用于排查智能助手交互、会话保存与文件刷新问题。
- **跨平台** — 提供 macOS、Windows、Linux 安装包。

## 工作原理

```
┌─────────────────────────────────────────────────┐
│  React UI  (拓扑画布 / 对话 / 会话抽屉)            │
└───────────────────────┬─────────────────────────┘
                        │ Tauri IPC（commands + events）
┌───────────────────────▼─────────────────────────┐
│  Rust / Tauri                                    │
│   · 会话与拓扑 SQLite      · axum sidecar (HTTP)  │
│   · 会话导入导出           · Skill 出厂播种/恢复   │
└───────────────────────┬─────────────────────────┘
                        │ spawn（本机 Node 进程）
┌───────────────────────▼─────────────────────────┐
│  Node worker  (@anthropic-ai/claude-agent-sdk)   │
└─────────┬───────────────────────────┬───────────┘
          │ query()                   │ MCP (stdio)
┌─────────▼────────┐        ┌─────────▼───────────┐
│  Claude binary   │        │  tsn_topology MCP    │
└──────────────────┘        └─────────┬───────────┘
                                      │ HTTP
                           ┌──────────▼───────────┐
                           │  axum sidecar → SQLite│
                           └──────────────────────┘
```

智能助手运行时由 Rust 拉起本机 Node worker，worker 通过官方 `@anthropic-ai/claude-agent-sdk` 调用 Claude，并以 `tsn_topology` MCP 工具操作拓扑——所有工具都走本机 axum sidecar 的 HTTP 接口读写 SQLite。拓扑写入后，UI 通过 `session_db_changed` 事件 + `query_topology` 命令实时刷新画布、节点详情与链路详情。

应用复用你本机的 Claude Code 配置，但不读取也不保存任何 Claude 凭证；SQLite 只保存入库时已脱敏的会话文本、agent 事件摘要与拓扑工程数据。

## 技术栈

- **前端**：React 19 · Vite · [@xyflow/react](https://reactflow.dev/)（React Flow）· react-markdown · zod
- **桌面与后端**：Tauri 2.9（Rust）· axum sidecar · SQLite
- **智能助手运行时**：Node worker · `@anthropic-ai/claude-agent-sdk` · `@modelcontextprotocol/sdk`
- **测试**：Vitest · Playwright · `cargo test`

## 安装与下载

从 [GitHub Releases](https://github.com/jarbozhang/tsn-agent/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS | `.dmg`（Apple Silicon / Intel） |
| Windows | `setup.exe`（NSIS）/ `.msi` |
| Linux | `.deb` / `.rpm` |

**前置要求**：本机需安装 [Claude Code](https://claude.com/claude-code) 并完成登录。应用通过本机 Claude Code 运行智能助手；未登录时会提示「需要桌面版」，不提供模拟兜底。

## 开发

```bash
npm install
npm run tauri dev      # 启动桌面开发环境
```

仅前端预览（智能助手在非桌面环境 fail-closed）：

```bash
npm run dev
```

### 测试

```bash
npm test               # 前端单元测试（Vitest）
npm run e2e            # 端到端测试（Playwright）
npm run cargo:test     # Rust 测试
npm run build          # 类型检查 + 构建
```

### 构建与发布

```bash
npm run build:worker   # 打包 Node worker + tsn_topology MCP + 内置 claude binary
npm run tauri build    # 构建桌面安装包
```

正式发布走 GitHub Actions（`.github/workflows/production-build.yml`）：推送 `release/**` 分支即触发全平台构建，版本号由 `scripts/prepare-release.mjs` 按 conventional commits 自动推算。

## 项目结构

```
src/             React 前端（topology 画布 / sessions / agent / skills / diagnostics …）
src-tauri/       Rust：Tauri commands、axum sidecar、SQLite、会话导入导出、Skill 出厂播种
src-node/        Node worker（claude-agent-sdk）与 tsn_topology MCP server
.claude/skills/  出厂 Skill 指引（tsn-topology、tsn-flow-planning）
docs/            文档（brainstorms / plans / solutions / adr）
scripts/         构建与发布脚本
```

## 路线图

「模拟仿真」阶段（Phase B）回归后将生成面向 INET/OMNeT++ 的项目导出文件：`network.ned`、`omnetpp.ini`、`react-flow-topology.json`、`flow_plan_1.json` 与导出清单 `manifest.json`。`omnetpp.ini` 仅承诺让 INET/OMNeT++ 加载运行基础拓扑；gPTP、TAS/GCL、调度器选择与业务流应用放在后续 `inet-export` skill 中扩展。

## 许可证

私有项目，暂未开源授权。
