import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readSidecarEnv } from "./sidecar-client";
import {
  createFlowToolRegistry,
  createTimesyncToolRegistry,
  createTopologyToolRegistry,
} from "./topology-tools";

export const TSN_TOPOLOGY_MCP_SERVER_NAME = "tsn_topology" as const;

export function createTsnTopologyMcpServer(): McpServer {
  const server = new McpServer({
    name: TSN_TOPOLOGY_MCP_SERVER_NAME,
    version: "0.1.0",
  });

  // topology + timesync + flow 工具同住一个 stdio server；按 stage 的放行由 worker 白名单做。
  for (const tool of [
    ...createTopologyToolRegistry(),
    ...createTimesyncToolRegistry(),
    ...createFlowToolRegistry(),
  ]) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => tool.handler(args ?? {}),
    );
  }

  return server;
}

export async function runTsnTopologyMcpServer(): Promise<void> {
  // Plan v3 U4b: 启动前必须校验 sidecar env；缺失直接 process.exit(1)，
  // 让 Agent SDK 看到 spawn 失败而不是后续 401 lockout。
  try {
    readSidecarEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const server = createTsnTopologyMcpServer();
  const transport = new StdioServerTransport();
  console.error("tsn_topology MCP server listening on stdio");
  await server.connect(transport);
}

if (isCliEntrypoint()) {
  runTsnTopologyMcpServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export function isCliEntrypoint(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(moduleUrl) === argvPath;
  }
}
