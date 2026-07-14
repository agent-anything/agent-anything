import { describe, expect, it } from "vitest";
import { ToolExecutionBoundary } from "@agent-anything/agent-core";
import { EvidenceBuilder } from "@agent-anything/evidence";
import { FakePermissionService, FakePolicyPort } from "@agent-anything/testing";
import {
  FakeMcpConnectionPort,
} from "../testing/index.js";
import { ToolRegistry } from "@agent-anything/tools";
import { McpToolAdapter } from "./McpToolAdapter.js";
import type { McpServerDefinition } from "./McpServerDefinition.js";
import type { McpToolDefinition } from "./McpToolDefinition.js";

describe("McpToolAdapter", () => {
  it("maps MCP call result to platform ToolResult", async () => {
    const connectionPort = new FakeMcpConnectionPort((input) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: {
        ok: true,
      },
      metadata: {
        server: input.serverId,
      },
    }));
    const adapter = createMcpToolAdapter(connectionPort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      toolCallId: "tool_call_001",
      toolName: "mcp.lookup",
      status: "succeeded",
      output: {
        ok: true,
      },
      metadata: {
        server: "mcp_server_001",
        mcpServerId: "mcp_server_001",
      },
    });
    expect(connectionPort.calls[0]).toMatchObject({
      serverId: "mcp_server_001",
      toolName: "mcp.lookup",
      toolCallId: "tool_call_001",
      input: {
        hostname: "example.com",
      },
    });
  });

  it("maps MCP unavailable errors to tool_mcp_unavailable", async () => {
    const connectionPort = new FakeMcpConnectionPort(() => {
      throw Object.assign(new Error("MCP server unavailable."), {
        code: "tool_mcp_unavailable",
      });
    });
    const adapter = createMcpToolAdapter(connectionPort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_mcp_unavailable",
        message: "MCP server unavailable.",
      },
    });
  });

  it("maps MCP timeout errors to tool_timeout", async () => {
    const connectionPort = new FakeMcpConnectionPort(() => {
      throw Object.assign(new Error("MCP call timed out."), {
        code: "tool_timeout",
      });
    });
    const adapter = createMcpToolAdapter(connectionPort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "timeout",
      error: {
        code: "tool_timeout",
        message: "MCP call timed out.",
      },
    });
  });

  it("maps unknown MCP failures to tool_mcp_call_failed", async () => {
    const connectionPort = new FakeMcpConnectionPort(() => {
      throw new Error("MCP call failed.");
    });
    const adapter = createMcpToolAdapter(connectionPort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_mcp_call_failed",
        message: "MCP call failed.",
      },
    });
  });

  it("runs MCP tools through ToolRegistry and ToolExecutionBoundary", async () => {
    const connectionPort = new FakeMcpConnectionPort((input) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: {
        ok: true,
      },
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createMcpToolAdapter(connectionPort).toToolDefinition());
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
    });

    const result = await boundary.execute({
      task: createTask(),
      toolCall: createToolCall(),
      config: createConfig(),
      invocation: createInvocationContext(),
    });

    expect(result.status).toBe("succeeded");
    expect(connectionPort.calls).toHaveLength(1);
  });

  it("blocks MCP execution before connection call when policy denies", async () => {
    const connectionPort = new FakeMcpConnectionPort((input) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: {},
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createMcpToolAdapter(connectionPort, {
      risk: "risky",
    }).toToolDefinition());
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_denied",
        reason: "MCP denied.",
        decidedAt: "2026-06-13T00:00:00.000Z",
      })),
    });

    const result = await boundary.execute({
      task: createTask(),
      toolCall: createToolCall({ risk: "risky" }),
      config: createConfig(),
      invocation: createInvocationContext(),
    });

    expect(result.status).toBe("blocked");
    expect(connectionPort.calls).toHaveLength(0);
  });

  it("blocks MCP execution before connection call when permission denies", async () => {
    const connectionPort = new FakeMcpConnectionPort((input) => ({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: {},
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createMcpToolAdapter(connectionPort, {
      risk: "risky",
    }).toToolDefinition());
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
      permissionService: new FakePermissionService((request) => ({
        requestId: request.id,
        status: "denied",
        code: "permission_denied",
        reason: "Permission denied.",
        decidedAt: "2026-06-13T00:00:00.000Z",
      })),
    });

    const result = await boundary.execute({
      task: createTask(),
      toolCall: createToolCall({ risk: "risky" }),
      config: createConfig(),
      invocation: createInvocationContext(),
    });

    expect(result.status).toBe("blocked");
    expect(connectionPort.calls).toHaveLength(0);
  });
});

function createMcpToolAdapter(
  connectionPort: FakeMcpConnectionPort,
  options: {
    risk?: "safe" | "risky";
  } = {},
): McpToolAdapter {
  return new McpToolAdapter({
    server: createServer(),
    tool: createToolDefinition(options),
    connectionPort,
  });
}

function createServer(): McpServerDefinition {
  return {
    id: "mcp_server_001",
    name: "MCP Server 001",
    transport: "stdio",
    tools: [],
    metadata: {},
  };
}

function createToolDefinition(
  options: {
    risk?: "safe" | "risky";
  } = {},
): McpToolDefinition {
  return {
    name: "mcp.lookup",
    description: "Lookup via MCP.",
    inputSchema: {
      type: "object",
    },
    risk: options.risk ?? "safe",
    metadata: {},
  };
}

function createToolCall(options: {
  risk?: "safe" | "risky";
} = {}) {
  return {
    id: "tool_call_001",
    toolName: "mcp.lookup",
    input: {
      hostname: "example.com",
    },
    risk: options.risk ?? "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}

function createTask() {
  return {
    id: "task_001",
    kind: "test.mcp",
    input: {},
    createdAt: "2026-06-13T00:00:00.000Z",
    metadata: {},
  };
}

function createConfig() {
  return {
    permissionMode: "trusted" as const,
    audit: "optional" as const,
    telemetry: "optional" as const,
  };
}

function createInvocationContext() {
  return {
    interruption: {
      signal: new AbortController().signal,
      interruption: null,
    },
    processTermination: {
      gracePeriodMs: 50,
      forceKillTimeoutMs: 250,
    },
  };
}
