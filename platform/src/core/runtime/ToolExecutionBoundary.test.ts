import { describe, expect, it } from "vitest";
import { EvidenceBuilder } from "../../evidence/index.js";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../../tools/index.js";
import type { AgentTask } from "../task/index.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";
import type { RuntimeOptions } from "./RuntimeOptions.js";

describe("ToolExecutionBoundary", () => {
  it("executes a successful tool and creates evidence plus observation", async () => {
    const boundary = createBoundary(createToolResult("succeeded"));

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: [
        {
          id: "evidence_tool_call_001",
        },
      ],
      observation: {
        id: "observation_tool_call_001",
        evidenceRefs: ["evidence_tool_call_001"],
      },
    });
  });

  it("creates evidence from partial output", async () => {
    const boundary = createBoundary(createToolResult("partial"));

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: [
        {
          summary: "Partial evidence from net.lookupDns.",
        },
      ],
      observation: {
        metadata: {
          toolResultStatus: "partial",
        },
      },
    });
  });

  it("does not create evidence or observation for skipped tools", async () => {
    const boundary = createBoundary({
      ...createToolResult("skipped"),
      output: null,
    });

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: [],
      observation: null,
    });
  });

  it("maps timeout to structured runtime error", async () => {
    const boundary = createBoundary({
      ...createToolResult("timeout"),
      output: null,
      error: {
        code: "tool_timeout",
        message: "DNS lookup timed out.",
      },
    });

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "tool_timeout",
          message: "DNS lookup timed out.",
          metadata: {
            toolResultStatus: "timeout",
          },
        },
      ],
    });
  });

  it("does not create evidence from failed tools", async () => {
    const boundary = createBoundary({
      ...createToolResult("failed"),
      output: null,
      error: {
        code: "dns_failed",
        message: "DNS lookup failed.",
      },
    });

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "tool_execution_failed",
          message: "DNS lookup failed.",
        },
      ],
    });
  });

  it("fails interrupted tools without usable output", async () => {
    const boundary = createBoundary({
      ...createToolResult("interrupted"),
      output: null,
    });

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "tool_interrupted",
        },
      ],
    });
  });

  it("uses interrupted partial output when available", async () => {
    const boundary = createBoundary(createToolResult("interrupted"));

    const outcome = await boundary.execute(createExecuteInput());

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: [
        {
          content: {
            records: ["93.184.216.34"],
          },
        },
      ],
      observation: {
        metadata: {
          toolResultStatus: "interrupted",
        },
      },
    });
  });

  it("denies risky tools before execution", async () => {
    let executed = false;
    const boundary = createBoundary(createToolResult("succeeded"), {
      onExecute: () => {
        executed = true;
      },
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
        options: {
          ...createOptions(),
          permissionMode: "denyAll",
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "permission_denied",
        },
      ],
    });
    expect(executed).toBe(false);
  });
});

function createBoundary(
  toolResult: ToolResult,
  options: {
    onExecute?: () => void;
  } = {},
): ToolExecutionBoundary {
  const registry = new ToolRegistry();
  registry.register(createFakeTool(toolResult, options));

  return new ToolExecutionBoundary({
    toolRegistry: registry,
    evidenceBuilder: new EvidenceBuilder(),
  });
}

function createFakeTool(
  result: ToolResult,
  options: {
    onExecute?: () => void;
  },
): ToolDefinition {
  return {
    name: "net.lookupDns",
    risk: "safe",
    async execute() {
      options.onExecute?.();
      return result;
    },
  };
}

function createExecuteInput(
  overrides: Partial<{
    task: AgentTask;
    toolCall: ToolCall;
    options: RuntimeOptions;
  }> = {},
) {
  return {
    task: createTask(),
    toolCall: createToolCall(),
    options: createOptions(),
    ...overrides,
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    metadata: {},
  };
}

function createToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool_call_001",
    toolName: "net.lookupDns",
    input: {},
    risk: "safe",
    metadata: {},
    ...overrides,
  };
}

function createOptions(): RuntimeOptions {
  return {
    limits: {
      maxToolCalls: 5,
      maxDurationMs: 30000,
      maxConsecutiveFailures: 1,
      maxIterations: 5,
    },
    permissionMode: "allowAll",
    metadata: {},
  };
}

function createToolResult(status: ToolResult["status"]): ToolResult {
  return {
    toolCallId: "tool_call_001",
    toolName: "net.lookupDns",
    status,
    output: {
      records: ["93.184.216.34"],
    },
    error: null,
    startedAt: "2026-06-07T00:00:00.000Z",
    finishedAt: "2026-06-07T00:00:01.000Z",
    metadata: {},
  };
}
