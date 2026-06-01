import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTopologyToolRegistry } from "./topology-tools";

export const TSN_TOPOLOGY_MCP_SERVER_NAME = "tsn_topology" as const;

export function createTsnTopologyMcpServer(): McpServer {
  const server = new McpServer({
    name: TSN_TOPOLOGY_MCP_SERVER_NAME,
    version: "0.1.0",
  });

  for (const tool of createTopologyToolRegistry()) {
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
