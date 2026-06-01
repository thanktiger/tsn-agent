# 测试说明

TSN Agent 的默认测试验证新手纵向闭环、本地确定性导出和规划服务客户端边界，不依赖真实 Agent 凭证、真实规划器或本机 INET 仿真工具。

## 默认测试

```bash
npm test
npm run build
npm run e2e
npm run cargo:test
```

- `npm test`：运行 Vitest，覆盖 canonical 拓扑、NED/`omnetpp.ini`/`traffic.ini`/React Flow/规划器导出、规划服务 mock 流程、项目快照、安全写盘、会话持久化、诊断日志、fake agent 和关键 React 行为。
- `npm run build`：执行 TypeScript 类型检查和 Vite 生产构建。
- `npm run e2e`：运行 Web smoke E2E，使用 fake agent 验证一句话拓扑输入、拓扑展示、导出文件列表、保存入口和诊断日志。
- `npm run cargo:test`：运行 Tauri/Rust 单元测试，覆盖会话数据库 schema、诊断日志、Agent bridge、规划服务 URL/响应边界和写盘安全校验。

## Topology MCP 测试

拓扑 MCP 的 P0 测试不依赖网络、模型、真实 Agent 会话或 Tauri：

```bash
npx vitest run src/topology src-node/mcp/topology-tools.test.ts
```

- `src/topology/*.test.ts`：覆盖 `IntermediateTopology` 契约、模板目录、初始化、校验、legacy JSON artifact、inspect、P0 operations 和 project bridge。
- `src-node/mcp/topology-tools.test.ts`：覆盖 MCP tool registry、allowedTools 映射、full topology 白名单边界、`FORBIDDEN_RESPONSE_MODE`、structured errors 和无 HTML artifact。
- `src-node/claude-agent-worker.test.mjs`：覆盖 worker 的 `tsn_topology` MCP server 配置、allowedTools、dev host fail-closed 和 stage runner fallback。
- `src-node/stage-skills/tsn-stage-runner.test.mjs`：覆盖旧 skill JSON artifact 兼容路径，确保只输出四份 JSON，不输出 HTML。

完整回归仍使用 `npm test` 和 `npm run build`。

## 当前不进默认测试

- 真实 Claude Agent SDK 流式输出。
- 桌面壳自动化和 `tauri-driver`。
- 真实 INET/OMNeT++ 编译或仿真不进入默认 CI；当前可在 devserver 上手动运行。
- Tauri 桌面文件选择器；当前 Tauri 写盘 command 由 Rust 单元测试覆盖，Web E2E 只验证保存入口状态。
- gate schedule configurator、GCL/TAS 回写、gPTP/CBS/FRER 和完整 TSN 行为配置。
- 真实规划服务执行不进入默认 CI；单测使用 mock 覆盖 start -> query -> get result -> artifact 刷新。默认服务地址为 `http://100.78.48.43:18080`，真实 smoke 需要手动触发。

这些内容属于 hardening 或后续专门 skill 的验收范围。默认导出仍不伪造规划结果；只有真实 planner result snapshot 存在时才生成 `planner/flow_plan_result_1.json`、`simulation/inet/planner-gcl.json` 和 `simulation/inet/planner-gcl-notes.md`。

## INET 手动验证

devserver 上已安装 INET 4.6.0 / OMNeT++ 6.4.0。导出目录按消费方分组后，INET 入口位于 `simulation/inet/omnetpp.ini`，同目录下的 `traffic.ini` 提供第一版 UDP source/sink 业务流。可用导出目录执行：

```bash
cd <export-dir>/simulation/inet
/home/zhang/.local/bin/inet -u Cmdenv -f omnetpp.ini -n .
```

当前手动验证分两层：

- 拓扑可加载：`tsnagent.generated.TsnAgentNetwork` 能加载并运行到 `sim-time-limit`。
- UDP traffic 可发包：`traffic.ini` 中的 `UdpSourceApp` / `UdpSinkApp` 能让 canonical flows 产生 packet。

这个验证不代表完整 TSN 确定性行为；`streams.ini`、`routing.ini`、`schedule.ini` 等完整 TSN 仿真输入属于后续计划，本期不生成占位文件。
