import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./ToolRegistry.js";
import type { ToolCall } from "./ToolCall.js";
import type { ToolDefinition } from "./ToolDefinition.js";
import type { ToolInvocationContext } from "./ToolInvocationContext.js";

describe("ToolRegistry", () => {
  it("registers and finds one tool", () => {
    const registry = new ToolRegistry();
    const tool = createFakeTool("net.lookupDns");

    registry.register(tool);

    expect(registry.has("net.lookupDns")).toBe(true);
    expect(registry.get("net.lookupDns")).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();

    registry.register(createFakeTool("net.lookupDns"));

    expect(() => registry.register(createFakeTool("net.lookupDns"))).toThrow(
      "Tool is already registered: net.lookupDns",
    );
  });

  it("returns a structured not-found result for unknown tools", async () => {
    const registry = new ToolRegistry();

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(),
    );

    expect(result.status).toBe("failed");
    expect(result.toolCallId).toBe("tool_call_001");
    expect(result.toolName).toBe("net.lookupDns");
    expect(result.output).toBeNull();
    expect(result.error).toEqual({
      code: "tool_not_found",
      message: "Tool is not registered: net.lookupDns",
    });
  });

  it("executes a fake tool and returns its ToolResult", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(),
    );

    expect(result).toMatchObject({
      toolCallId: "tool_call_001",
      toolName: "net.lookupDns",
      status: "succeeded",
      output: { records: ["93.184.216.34"] },
      error: null,
      metadata: {
        adapter: "fake",
        taskId: "task_001",
      },
    });
  });

  it("preserves metadata needed by evidence flow", async () => {
    const registry = new ToolRegistry();
    registry.register(createFakeTool("net.lookupDns"));

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(),
    );

    expect(result.toolCallId).toBe("tool_call_001");
    expect(result.toolName).toBe("net.lookupDns");
    expect(result.metadata).toEqual({
      adapter: "fake",
      taskId: "task_001",
    });
  });

  it("returns a structured failure when a tool throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "net.fail",
      risk: "safe",
      async execute() {
        throw new Error("DNS adapter failed.");
      },
    });

    const result = await registry.execute(
      createToolCall("net.fail"),
      createInvocationContext(),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "tool_execution_failed",
      message: "DNS adapter failed.",
    });
  });

  it("does not dispatch after an attributed Run cancellation", async () => {
    const registry = new ToolRegistry();
    let dispatched = false;
    registry.register({
      name: "net.lookupDns",
      risk: "safe",
      async execute() {
        dispatched = true;
        return createSucceededResult();
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(controller, {
        kind: "run_cancellation",
        cancellation: { runId: "run-001", requestId: "cancel-001" },
      }),
    );

    expect(dispatched).toBe(false);
    expect(result).toMatchObject({
      status: "cancelled",
      error: {
        code: "tool_cancelled",
        metadata: { runId: "run-001", requestId: "cancel-001" },
      },
    });
  });

  it("rejects an aborted invocation without trusted attribution", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    controller.abort(new Error("unknown interruption"));

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(controller, null),
    );

    expect(result).toMatchObject({
      status: "interrupted",
      error: { code: "tool_cancellation_unconfirmed" },
    });
  });

  it("maps an attributed operation deadline to timeout", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    controller.abort(new Error("deadline"));

    const result = await registry.execute(
      createToolCall("net.lookupDns"),
      createInvocationContext(controller, {
        kind: "operation_deadline",
        deadline: {
          operationId: "tool-attempt-001",
          deadlineAt: "2026-07-14T00:00:00.000Z",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "timeout",
      error: {
        code: "tool_timeout",
        metadata: { operationId: "tool-attempt-001" },
      },
    });
  });
});

function createFakeTool(name: string): ToolDefinition {
  return {
    name,
    risk: "safe",
    metadata: {
      adapter: "fake",
    },
    async execute(call) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "succeeded",
        output: {
          records: ["93.184.216.34"],
        },
        error: null,
        startedAt: "2026-06-03T00:00:00.000Z",
        finishedAt: "2026-06-03T00:00:01.000Z",
        metadata: {
          adapter: "fake",
          taskId: call.metadata.taskId,
        },
      };
    },
  };
}

function createToolCall(toolName: string): ToolCall {
  return {
    id: "tool_call_001",
    toolName,
    input: {
      hostname: "example.com",
      recordType: "A",
    },
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}

function createInvocationContext(
  controller = new AbortController(),
  interruption: ToolInvocationContext["interruption"]["interruption"] = null,
): ToolInvocationContext {
  return {
    interruption: {
      signal: controller.signal,
      interruption,
    },
    processTermination: {
      gracePeriodMs: 10,
      forceKillTimeoutMs: 10,
    },
  };
}

function createSucceededResult() {
  return {
    toolCallId: "tool_call_001",
    toolName: "net.lookupDns",
    status: "succeeded" as const,
    output: { records: ["93.184.216.34"] },
    error: null,
    startedAt: "2026-06-03T00:00:00.000Z",
    finishedAt: "2026-06-03T00:00:01.000Z",
    metadata: {},
  };
}
