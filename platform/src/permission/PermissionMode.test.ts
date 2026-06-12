import { describe, expect, it } from "vitest";
import { createPermissionRequest } from "./createPermissionRequest.js";
import { resolvePermissionDecision } from "./resolvePermissionDecision.js";

describe("Permission mode", () => {
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
      action: "tool.execute",
      toolCallId: "tool_call_001",
      toolName: "shell.runCommand",
      risk: "risky",
      reason: "This tool can execute a shell command.",
      target: {
        kind: "tool",
        name: "shell.runCommand",
        resource: "tool_call_001",
      },
      metadata: {
        source: "runtime",
        correlationId: "run_001",
      },
    });
  });

  it("trusted grants risky tool execution", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "trusted",
      request: createRiskyRequest(),
      decidedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(decision).toEqual({
      requestId: "permission_request_001",
      status: "granted",
      reason: "Granted by permissionMode: trusted.",
      decidedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("deny denies risky tool execution", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "deny",
      request: createRiskyRequest(),
      decidedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(decision).toEqual({
      requestId: "permission_request_001",
      status: "denied",
      code: "permission_mode_denied",
      reason: "Denied by permissionMode: deny.",
      decidedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("represents deny as a stop signal for the caller", () => {
    const decision = resolvePermissionDecision({
      permissionMode: "deny",
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
