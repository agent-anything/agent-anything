import { describe, expect, it } from "vitest";
import { createPermissionRequest } from "./createPermissionRequest.js";
import { resolvePermissionDecision } from "./resolvePermissionDecision.js";

describe("Phase1 permission mode", () => {
  it("creates a structured permission request from a risky tool call", () => {
    const request = createPermissionRequest({
      id: "permission_request_001",
      taskId: "task_001",
      toolCall: {
        id: "tool_call_001",
        toolName: "shell.runCommand",
        risk: "risky",
      },
      reason: "This tool can execute a shell command.",
      metadata: {
        source: "runtime",
        correlationId: "run_001",
      },
    });

    expect(request).toEqual({
      id: "permission_request_001",
      taskId: "task_001",
      toolCallId: "tool_call_001",
      toolName: "shell.runCommand",
      risk: "risky",
      reason: "This tool can execute a shell command.",
      metadata: {
        source: "runtime",
        correlationId: "run_001",
      },
    });
  });

  it("allowAll allows risky tool execution", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "allowAll",
      request: createRiskyRequest(),
      decidedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(decision).toEqual({
      requestId: "permission_request_001",
      status: "allowed",
      reason: "Allowed by Phase1 permissionMode: allowAll.",
      decidedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("denyAll denies risky tool execution", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "denyAll",
      request: createRiskyRequest(),
      decidedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(decision).toEqual({
      requestId: "permission_request_001",
      status: "denied",
      reason: "Denied by Phase1 permissionMode: denyAll.",
      decidedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("represents deny as a stop signal for the caller", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "denyAll",
      request: createRiskyRequest(),
      decidedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(decision.status).toBe("denied");
  });
});

function createRiskyRequest() {
  return createPermissionRequest({
    id: "permission_request_001",
    taskId: "task_001",
    toolCall: {
      id: "tool_call_001",
      toolName: "shell.runCommand",
      risk: "risky",
    },
    reason: "This tool can execute a shell command.",
    metadata: {
      source: "runtime",
    },
  });
}
