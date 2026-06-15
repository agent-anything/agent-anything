import { describe, expect, it } from "vitest";
import { createDenyPermissionService } from "./createDenyPermissionService.js";
import { createPermissionServiceFromMode } from "./createPermissionServiceFromMode.js";
import { createTrustedPermissionService } from "./createTrustedPermissionService.js";
import type { PermissionRequest } from "./PermissionRequest.js";

describe("permission service defaults", () => {
  it("creates a trusted permission service", async () => {
    const service = createTrustedPermissionService();

    const decision = await service.request(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "granted",
      reason: "Granted by permissionMode: trusted.",
    });
  });

  it("creates a deny permission service", async () => {
    const service = createDenyPermissionService();

    const decision = await service.request(createRequest());

    expect(decision).toMatchObject({
      requestId: "permission_request_001",
      status: "denied",
      code: "permission_mode_denied",
      reason: "Denied by permissionMode: deny.",
    });
  });

  it("selects trusted and deny services from permission mode", async () => {
    await expect(createPermissionServiceFromMode("trusted").request(createRequest()))
      .resolves.toMatchObject({
        status: "granted",
      });

    await expect(createPermissionServiceFromMode("deny").request(createRequest()))
      .resolves.toMatchObject({
        status: "denied",
        code: "permission_mode_denied",
      });
  });

  it("returns unavailable for ask mode without a host prompt service", async () => {
    const service = createPermissionServiceFromMode("ask");

    await expect(service.request(createRequest())).resolves.toMatchObject({
      status: "denied",
      code: "permission_unavailable",
      reason: "Denied because permissionMode: ask requires a host-provided prompt service.",
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
