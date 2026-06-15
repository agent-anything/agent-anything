import { describe, expect, it } from "vitest";
import { FakeMcpConnectionPort } from "../testing/index.js";
import { McpRegistry } from "./McpRegistry.js";
import type { McpServerDefinition } from "./McpServerDefinition.js";

describe("McpRegistry", () => {
  it("registers MCP server definitions and lists tools", () => {
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

  it("rejects invalid definitions", () => {
    const registry = new McpRegistry();

    expect(() => registry.register(createServer({
      id: "",
    }))).toThrow("MCP server id, name, and transport must not be empty.");
  });

  it("adapts MCP tools into platform ToolDefinition instances", async () => {
    const registry = new McpRegistry();
    registry.register(createServer());
    const connectionPort = new FakeMcpConnectionPort((input) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: {
        ok: true,
      },
      metadata: {},
    }));

    const definitions = registry.toToolDefinitions(connectionPort);
    const result = await definitions[0]!.execute({
      id: "tool_call_001",
      toolName: "mcp.lookup",
      input: {
        hostname: "example.com",
      },
      risk: "safe",
      metadata: {},
    });

    expect(definitions[0]).toMatchObject({
      name: "mcp.lookup",
      risk: "safe",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        ok: true,
      },
    });
  });
});

function createServer(
  overrides: Partial<McpServerDefinition> = {},
): McpServerDefinition {
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
        risk: "safe",
        metadata: {},
      },
    ],
    metadata: {},
    ...overrides,
  };
}
