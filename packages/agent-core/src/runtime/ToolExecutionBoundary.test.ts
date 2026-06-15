import { describe, expect, it } from "vitest";
import { EvidenceBuilder } from "@agent-anything/evidence";
import type { PolicyPort } from "@agent-anything/governance";
import type { PermissionService } from "@agent-anything/permission";
import {
  FakePermissionService,
  FakePolicyPort,
} from "@agent-anything/testing";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@agent-anything/tools";
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
          permissionMode: "deny",
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_mode_denied",
        },
      ],
    });
    expect(executed).toBe(false);
  });

  it("blocks risky tools when policy denies before permission and execution", async () => {
    let executed = false;
    let permissionRequested = false;
    const boundary = createBoundary(createToolResult("succeeded"), {
      onExecute: () => {
        executed = true;
      },
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_denied",
        reason: "Policy denies risky tool.",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
      permissionService: new FakePermissionService((request) => {
        permissionRequested = true;
        return {
          requestId: request.id,
          status: "granted",
          reason: "Allowed by test service.",
          decidedAt: "2026-06-12T00:00:00.000Z",
        };
      }),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "policy_denied",
          message: "Policy denies risky tool.",
        },
      ],
    });
    expect(permissionRequested).toBe(false);
    expect(executed).toBe(false);
  });

  it("runs policy before permission and execution on allow path", async () => {
    const order: string[] = [];
    const boundary = createBoundary(createToolResult("succeeded"), {
      onExecute: () => {
        order.push("execute");
      },
      policyPort: new FakePolicyPort((input) => {
        order.push("policy");
        return {
          checkId: input.id,
          status: "allowed",
          decidedAt: "2026-06-12T00:00:00.000Z",
        };
      }),
      permissionService: new FakePermissionService((request) => {
        order.push("permission");
        return {
          requestId: request.id,
          status: "granted",
          reason: "Allowed by test service.",
          decidedAt: "2026-06-12T00:00:00.000Z",
        };
      }),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(order).toEqual(["policy", "permission", "execute"]);
  });

  it("blocks risky tools when policy requires review", async () => {
    const boundary = createBoundary(createToolResult("succeeded"), {
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "requires_review",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "policy_review_required",
        },
      ],
    });
  });

  it("maps policy port failure to structured runtime error", async () => {
    const boundary = createBoundary(createToolResult("succeeded"), {
      policyPort: new FakePolicyPort(() => {
        throw new Error("Policy service failed.");
      }),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "policy_check_failed",
          message: "Policy service failed.",
        },
      ],
    });
  });

  it("uses injected permission service to allow risky tools", async () => {
    let executed = false;
    const boundary = createBoundary(createToolResult("succeeded"), {
      onExecute: () => {
        executed = true;
      },
      permissionService: new FakePermissionService((request) => ({
        requestId: request.id,
        status: "granted",
        reason: "Allowed by test service.",
        decidedAt: "2026-06-07T00:00:00.000Z",
      })),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
        options: {
          ...createOptions(),
          permissionMode: "deny",
        },
      }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(executed).toBe(true);
  });

  it("blocks risky tools when permission service denies", async () => {
    let executed = false;
    const boundary = createBoundary(createToolResult("succeeded"), {
      onExecute: () => {
        executed = true;
      },
      permissionService: new FakePermissionService((request) => ({
        requestId: request.id,
        status: "denied",
        code: "permission_denied",
        reason: "Denied by test service.",
        decidedAt: "2026-06-12T00:00:00.000Z",
      })),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_denied",
          message: "Denied by test service.",
        },
      ],
    });
    expect(executed).toBe(false);
  });

  it("blocks ask mode when no host permission service is available", async () => {
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
          permissionMode: "ask",
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      errors: [
        {
          code: "permission_unavailable",
        },
      ],
    });
    expect(executed).toBe(false);
  });

  it("maps permission service failure to structured runtime error", async () => {
    const boundary = createBoundary(createToolResult("succeeded"), {
      permissionService: new FakePermissionService(() => {
        throw new Error("Permission UI failed.");
      }),
    });

    const outcome = await boundary.execute(
      createExecuteInput({
        toolCall: createToolCall({
          risk: "risky",
        }),
      }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "permission_check_failed",
          message: "Permission UI failed.",
        },
      ],
    });
  });
});

function createBoundary(
  toolResult: ToolResult,
  options: {
    onExecute?: () => void;
    policyPort?: PolicyPort;
    permissionService?: PermissionService;
  } = {},
): ToolExecutionBoundary {
  const registry = new ToolRegistry();
  registry.register(createFakeTool(toolResult, options));

  return new ToolExecutionBoundary({
    toolRegistry: registry,
    evidenceBuilder: new EvidenceBuilder(),
    policyPort: options.policyPort,
    permissionService: options.permissionService,
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
    permissionMode: "trusted",
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
