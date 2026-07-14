import { describe, expect, it } from "vitest";
import type { ToolCall } from "../ToolCall.js";
import type { ToolInvocationContext } from "../ToolInvocationContext.js";
import { ToolRegistry } from "../ToolRegistry.js";
import { FunctionToolAdapter } from "./FunctionToolAdapter.js";
import { ToolAdapterRegistry } from "./ToolAdapterRegistry.js";

describe("FunctionToolAdapter", () => {
  it("adapts a simple function into a tool definition", async () => {
    const adapter = new FunctionToolAdapter({
      name: "example.echo",
      risk: "safe",
      description: "Echo input.",
      metadata: {
        product: "test",
      },
      inputSchema: {
        type: "object",
      },
      context: {
        now: () => "2026-06-09T00:00:00.000Z",
        metadata: {
          adapterRun: "test",
        },
      },
      handler(call) {
        return call.input;
      },
    });

    const definition = adapter.toToolDefinition();
    const result = await definition.execute(createToolCall({
      message: "hello",
    }));

    expect(definition).toMatchObject({
      name: "example.echo",
      risk: "safe",
      description: "Echo input.",
      metadata: {
        product: "test",
        adapter: "function",
        inputSchema: {
          type: "object",
        },
      },
    });
    expect(result).toEqual({
      toolCallId: "tool_call_001",
      toolName: "example.echo",
      status: "succeeded",
      output: {
        message: "hello",
      },
      error: null,
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:00.000Z",
      metadata: {
        taskId: "task_001",
        adapterRun: "test",
      },
    });
  });

  it("maps thrown errors to structured failed tool results", async () => {
    const adapter = new FunctionToolAdapter({
      name: "example.fail",
      risk: "risky",
      context: {
        now: () => "2026-06-09T00:00:00.000Z",
      },
      handler() {
        throw new Error("Handler exploded.");
      },
    });

    const result = await adapter.toToolDefinition().execute(createToolCall({}, "example.fail"));

    expect(result).toEqual({
      toolCallId: "tool_call_001",
      toolName: "example.fail",
      status: "failed",
      output: null,
      error: {
        code: "tool_adapter_handler_failed",
        message: "Handler exploded.",
      },
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:00.000Z",
      metadata: {
        taskId: "task_001",
      },
    });
  });

  it("rejects invalid adapter definitions", () => {
    expect(() => new FunctionToolAdapter({
      name: " ",
      risk: "safe",
      handler() {
        return {};
      },
    })).toThrow("Tool adapter name must not be empty.");
  });
});

describe("ToolAdapterRegistry", () => {
  it("registers adapters and exposes tool definitions for ToolRegistry", async () => {
    const adapterRegistry = new ToolAdapterRegistry();
    adapterRegistry.register(new FunctionToolAdapter({
      name: "example.echo",
      risk: "safe",
      handler(call) {
        return call.input;
      },
    }));
    const toolRegistry = new ToolRegistry();

    for (const definition of adapterRegistry.toToolDefinitions()) {
      toolRegistry.register(definition);
    }

    expect(adapterRegistry.has("example.echo")).toBe(true);
    await expect(toolRegistry.execute(
      createToolCall({ message: "hello" }),
      createInvocationContext(),
    )).resolves.toMatchObject({
      status: "succeeded",
      output: {
        message: "hello",
      },
    });
  });

  it("rejects duplicate adapter names", () => {
    const registry = new ToolAdapterRegistry();
    registry.register(new FunctionToolAdapter({
      name: "example.echo",
      risk: "safe",
      handler() {
        return {};
      },
    }));

    expect(() => registry.register(new FunctionToolAdapter({
      name: "example.echo",
      risk: "safe",
      handler() {
        return {};
      },
    }))).toThrow("Tool adapter is already registered: example.echo");
  });
});

function createToolCall(input: unknown, toolName = "example.echo"): ToolCall {
  return {
    id: "tool_call_001",
    toolName,
    input,
    risk: "safe",
    metadata: {
      taskId: "task_001",
    },
  };
}

function createInvocationContext(): ToolInvocationContext {
  return {
    interruption: {
      signal: new AbortController().signal,
      interruption: null,
    },
    processTermination: {
      gracePeriodMs: 10,
      forceKillTimeoutMs: 10,
    },
  };
}
