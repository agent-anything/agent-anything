import { describe, expect, it } from "vitest";
import { FakePermissionService, FakePolicyPort } from "@agent-anything/testing";
import { FakeRemoteToolPort } from "../testing/index.js";
import { ToolRegistry } from "@agent-anything/tools";
import { EvidenceBuilder } from "@agent-anything/evidence";
import { ToolExecutionBoundary } from "@agent-anything/agent-core";
import { RemoteToolAdapter } from "./RemoteToolAdapter.js";
import type { RemoteToolNode } from "./RemoteToolNode.js";

describe("RemoteToolAdapter", () => {
  it("maps a remote result to a platform ToolResult", async () => {
    const remotePort = new FakeRemoteToolPort((input) => ({
      remoteCallId: input.id,
      toolResult: createToolResult(input.toolCallId, input.toolName),
      metadata: {
        nodeId: input.remoteNodeId,
      },
    }));
    const adapter = createRemoteToolAdapter(remotePort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      toolCallId: "tool_call_001",
      toolName: "remote.lookup",
      status: "succeeded",
      output: {
        ok: true,
      },
    });
    expect(remotePort.calls[0]).toMatchObject({
      id: "remote_call_tool_call_001",
      toolCallId: "tool_call_001",
      toolName: "remote.lookup",
      remoteNodeId: "remote_node_001",
      input: {
        hostname: "example.com",
      },
      timeoutMs: 1000,
    });
  });

  it("maps remote unavailable errors to tool_remote_unavailable", async () => {
    const remotePort = new FakeRemoteToolPort(() => {
      throw Object.assign(new Error("Remote node is unavailable."), {
        code: "tool_remote_unavailable",
      });
    });
    const adapter = createRemoteToolAdapter(remotePort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_remote_unavailable",
        message: "Remote node is unavailable.",
      },
    });
  });

  it("maps remote timeout errors to tool_timeout", async () => {
    const remotePort = new FakeRemoteToolPort(() => {
      throw Object.assign(new Error("Remote call timed out."), {
        code: "tool_timeout",
      });
    });
    const adapter = createRemoteToolAdapter(remotePort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "timeout",
      error: {
        code: "tool_timeout",
        message: "Remote call timed out.",
      },
    });
  });

  it("maps unknown remote port failures to tool_remote_execution_failed", async () => {
    const remotePort = new FakeRemoteToolPort(() => {
      throw new Error("Remote execution failed.");
    });
    const adapter = createRemoteToolAdapter(remotePort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_remote_execution_failed",
        message: "Remote execution failed.",
      },
    });
  });

  it("rejects mismatched remote results", async () => {
    const remotePort = new FakeRemoteToolPort((input) => ({
      remoteCallId: input.id,
      toolResult: createToolResult("other_call", input.toolName),
      metadata: {},
    }));
    const adapter = createRemoteToolAdapter(remotePort);

    const result = await adapter.toToolDefinition().execute(createToolCall());

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_remote_result_mismatch",
      },
    });
  });

  it("runs remote tools through ToolRegistry and ToolExecutionBoundary", async () => {
    const remotePort = new FakeRemoteToolPort((input) => ({
      remoteCallId: input.id,
      toolResult: createToolResult(input.toolCallId, input.toolName),
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createRemoteToolAdapter(remotePort).toToolDefinition());
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
    });

    const result = await boundary.execute({
      task: createTask(),
      toolCall: createToolCall(),
      options: createOptions(),
    });

    expect(result.status).toBe("succeeded");
    expect(remotePort.calls).toHaveLength(1);
  });

  it("blocks remote execution before remote port call when policy denies", async () => {
    const remotePort = new FakeRemoteToolPort((input) => ({
      remoteCallId: input.id,
      toolResult: createToolResult(input.toolCallId, input.toolName),
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createRemoteToolAdapter(remotePort, { risk: "risky" }).toToolDefinition());
    const boundary = new ToolExecutionBoundary({
      toolRegistry: registry,
      evidenceBuilder: new EvidenceBuilder(),
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_denied",
        reason: "Remote tool denied.",
        decidedAt: "2026-06-13T00:00:00.000Z",
      })),
    });

    const result = await boundary.execute({
      task: createTask(),
      toolCall: createToolCall({ risk: "risky" }),
      options: createOptions(),
    });

    expect(result.status).toBe("blocked");
    expect(remotePort.calls).toHaveLength(0);
  });

  it("blocks remote execution before remote port call when permission denies", async () => {
    const remotePort = new FakeRemoteToolPort((input) => ({
      remoteCallId: input.id,
      toolResult: createToolResult(input.toolCallId, input.toolName),
      metadata: {},
    }));
    const registry = new ToolRegistry();
    registry.register(createRemoteToolAdapter(remotePort, { risk: "risky" }).toToolDefinition());
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
      options: createOptions(),
    });

    expect(result.status).toBe("blocked");
    expect(remotePort.calls).toHaveLength(0);
  });
});

function createRemoteToolAdapter(
  remoteToolPort: FakeRemoteToolPort,
  options: {
    risk?: "safe" | "risky";
  } = {},
): RemoteToolAdapter {
  return new RemoteToolAdapter({
    name: "remote.lookup",
    risk: options.risk ?? "safe",
    remoteNode: createRemoteNode(),
    remoteToolPort,
    timeoutMs: 1000,
    metadata: {
      product: "test",
    },
  });
}

function createRemoteNode(): RemoteToolNode {
  return {
    id: "remote_node_001",
    name: "Remote Node 001",
    capabilities: ["network.lookup"],
    metadata: {},
  };
}

function createToolCall(options: {
  risk?: "safe" | "risky";
} = {}) {
  return {
    id: "tool_call_001",
    toolName: "remote.lookup",
    input: {
      hostname: "example.com",
    },
    risk: options.risk ?? "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}

function createToolResult(toolCallId: string, toolName: string) {
  return {
    toolCallId,
    toolName,
    status: "succeeded" as const,
    output: {
      ok: true,
    },
    error: null,
    startedAt: "2026-06-13T00:00:00.000Z",
    finishedAt: "2026-06-13T00:00:01.000Z",
    metadata: {
      remote: true,
    },
  };
}

function createTask() {
  return {
    id: "task_001",
    kind: "test.remote",
    input: {},
    createdAt: "2026-06-13T00:00:00.000Z",
    metadata: {},
  };
}

function createOptions() {
  return {
    limits: {
      maxToolCalls: 5,
      maxDurationMs: 30000,
      maxConsecutiveFailures: 1,
      maxIterations: 5,
    },
    permissionMode: "trusted" as const,
    metadata: {},
  };
}
