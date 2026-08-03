import { describe, expect, it } from "vitest";
import { McpRegistry } from "./McpRegistry.js";
import type { McpServerRegistration } from "./McpServerRegistration.js";

describe("McpRegistry", () => {
  it("registers MCP servers and lists declarative tools", () => {
    const registry = new McpRegistry();

    registry.register(createServer());

    expect(registry.listServers()).toHaveLength(1);
    expect(registry.listTools()).toMatchObject([
      {
        server: {
          id: "mcp_server_001",
        },
        tool: {
          name: "mcp.lookup",
        },
      },
    ]);
  });

  it("rejects duplicate server ids", () => {
    const registry = new McpRegistry();

    registry.register(createServer());

    expect(() => registry.register(createServer())).toThrow(
      "MCP server 'mcp_server_001' is already registered.",
    );
  });

  it("rejects duplicate tool names", () => {
    const registry = new McpRegistry();

    registry.register(createServer());

    expect(() => registry.register(createServer({
      id: "mcp_server_002",
      name: "MCP Server 002",
    }))).toThrow("MCP tool 'mcp.lookup' is already registered.");
  });

  it("rejects invalid registrations", () => {
    const registry = new McpRegistry();

    expect(() => registry.register(createServer({
      id: "",
    }))).toThrow("MCP server id, name, and transport must not be empty.");
  });
});

function createServer(
  overrides: Partial<McpServerRegistration> = {},
): McpServerRegistration {
  return {
    id: "mcp_server_001",
    name: "MCP Server 001",
    transport: "stdio",
    tools: [
      {
        name: "mcp.lookup",
        description: "Lookup via MCP.",
        inputSchema: {
          type: "object",
        },
        annotations: { readOnlyHint: true },
        metadata: {},
      },
    ],
    metadata: {},
    ...overrides,
  };
}
