import { describe, expect, it } from "vitest";
import { createPermissionServiceFromMode } from "./createPermissionServiceFromMode.js";
import type { PermissionRequest } from "./PermissionRequest.js";

describe("createPermissionServiceFromMode", () => {
  it("preserves allowAll behavior", async () => {
    const service = createPermissionServiceFromMode("allowAll");

    const decision = await service.decide(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "allowed",
      reason: "Allowed by Phase1 permissionMode: allowAll.",
    });
  });

  it("preserves denyAll behavior", async () => {
    const service = createPermissionServiceFromMode("denyAll");

    const decision = await service.decide(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "denied",
      reason: "Denied by Phase1 permissionMode: denyAll.",
    });
  });
});

function createRequest(): PermissionRequest {
  return {
    id: "permission_request_001",
    taskId: "task_001",
    toolCallId: "tool_call_001",
    toolName: "shell.runCommand",
    risk: "risky",
    reason: "Risky tool.",
    metadata: {},
  };
}
