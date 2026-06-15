import type { ToolDefinition } from "@agent-anything/tools";
import type { McpConnectionPort } from "./McpConnectionPort.js";
import type { McpServerDefinition } from "./McpServerDefinition.js";
import type { McpToolDefinition } from "./McpToolDefinition.js";
import { McpToolAdapter } from "./McpToolAdapter.js";

export class McpRegistry {
  private readonly servers = new Map<string, McpServerDefinition>();
  private readonly toolNames = new Set<string>();

  register(server: McpServerDefinition): void {
    validateServer(server);

    if (this.servers.has(server.id)) {
      throw createMcpRegistryError(
        "mcp_server_duplicate",
        `MCP server '${server.id}' is already registered.`,
      );
    }

    for (const tool of server.tools) {
      if (this.toolNames.has(tool.name)) {
        throw createMcpRegistryError(
          "mcp_tool_duplicate",
          `MCP tool '${tool.name}' is already registered.`,
        );
      }
    }

    this.servers.set(server.id, server);
    for (const tool of server.tools) {
      this.toolNames.add(tool.name);
    }
  }

  listServers(): McpServerDefinition[] {
    return [...this.servers.values()];
  }

  listTools(): Array<{ server: McpServerDefinition; tool: McpToolDefinition }> {
    return this.listServers().flatMap((server) =>
      server.tools.map((tool) => ({
        server,
        tool,
      })),
    );
  }

  toToolDefinitions(connectionPort: McpConnectionPort): ToolDefinition[] {
    return this.listTools().map(({ server, tool }) =>
      new McpToolAdapter({
        server,
        tool,
        connectionPort,
      }).toToolDefinition(),
    );
  }
}

function validateServer(server: McpServerDefinition): void {
  if (server.id.trim() === "" || server.name.trim() === "" || server.transport.trim() === "") {
    throw createMcpRegistryError(
      "mcp_invalid_definition",
      "MCP server id, name, and transport must not be empty.",
    );
  }

  for (const tool of server.tools) {
    if (tool.name.trim() === "") {
      throw createMcpRegistryError(
        "mcp_invalid_definition",
        "MCP tool name must not be empty.",
      );
    }
  }
}

function createMcpRegistryError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
