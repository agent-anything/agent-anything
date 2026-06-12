import { describe, expect, it } from "vitest";
import { createPermissionServiceFromMode } from "./createPermissionServiceFromMode.js";
import type { PermissionRequest } from "./PermissionRequest.js";

describe("createPermissionServiceFromMode", () => {
  it("preserves trusted behavior", async () => {
    const service = createPermissionServiceFromMode("trusted");

    const decision = await service.request(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "granted",
      reason: "Granted by permissionMode: trusted.",
    });
  });

  it("preserves deny behavior", async () => {
    const service = createPermissionServiceFromMode("deny");

    const decision = await service.request(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "denied",
      code: "permission_mode_denied",
      reason: "Denied by permissionMode: deny.",
    });
  });
});

function createRequest(): PermissionRequest {
  return {
    id: "permission_request_001",
    taskId: "task_001",
    action: "tool.execute",
    toolCallId: "tool_call_001",
    toolName: "shell.runCommand",
    risk: "risky",
    reason: "Risky tool.",
    metadata: {},
  };
}
