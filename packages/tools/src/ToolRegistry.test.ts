import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./ToolRegistry.js";
import type { ToolCall } from "./ToolCall.js";
import type { ToolDefinition } from "./ToolDefinition.js";

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

    const result = await registry.execute(createToolCall("net.lookupDns"));

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

    const result = await registry.execute(createToolCall("net.lookupDns"));

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

    const result = await registry.execute(createToolCall("net.lookupDns"));

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

    const result = await registry.execute(createToolCall("net.fail"));

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "tool_execution_failed",
      message: "DNS adapter failed.",
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
