import type { McpServerRegistration } from "./McpServerRegistration.js";
import type { McpToolRegistration } from "./McpToolRegistration.js";

export class McpRegistry {
  private readonly servers = new Map<string, McpServerRegistration>();
  private readonly toolNames = new Set<string>();

  register(server: McpServerRegistration): void {
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

  listServers(): McpServerRegistration[] {
    return [...this.servers.values()];
  }

  listTools(): Array<{ server: McpServerRegistration; tool: McpToolRegistration }> {
    return this.listServers().flatMap((server) =>
      server.tools.map((tool) => ({
        server,
        tool,
      })),
    );
  }
}

function validateServer(server: McpServerRegistration): void {
  if (server.id.trim() === "" || server.name.trim() === "" || server.transport.trim() === "") {
    throw createMcpRegistryError(
      "mcp_invalid_registration",
      "MCP server id, name, and transport must not be empty.",
    );
  }

  for (const tool of server.tools) {
    if (tool.name.trim() === "") {
      throw createMcpRegistryError(
        "mcp_invalid_registration",
        "MCP tool name must not be empty.",
      );
    }
  }
}

function createMcpRegistryError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
