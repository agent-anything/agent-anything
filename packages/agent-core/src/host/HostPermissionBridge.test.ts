import { describe, expect, it } from "vitest";
import {
  createHostPermissionService,
  mapHostPermissionBridgeResult,
} from "./HostPermissionBridge.js";
import type { PermissionRequest } from "@agent-anything/permission";
import type { HostEvent } from "./HostEvent.js";

describe("HostPermissionBridge", () => {
  it("maps granted bridge result to granted permission decision", () => {
    const decision = mapHostPermissionBridgeResult({
      request: createPermissionRequest(),
      result: {
        status: "granted",
      },
      decidedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(decision).toMatchObject({
      requestId: "permission-1",
      status: "granted",
    });
  });

  it("maps denied bridge result to permission_denied", () => {
    const decision = mapHostPermissionBridgeResult({
      request: createPermissionRequest(),
      result: {
        status: "denied",
        reason: "User denied.",
      },
      decidedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(decision).toMatchObject({
      requestId: "permission-1",
      status: "denied",
      code: "permission_denied",
      reason: "User denied.",
    });
  });

  it("maps unavailable bridge result to permission_unavailable", () => {
    const decision = mapHostPermissionBridgeResult({
      request: createPermissionRequest(),
      result: {
        status: "unavailable",
      },
      decidedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "denied",
      code: "permission_unavailable",
    });
  });

  it("adapts bridge failures to permission_prompt_failed", async () => {
    const service = createHostPermissionService({
      sessionId: "session-1",
      bridge: async () => {
        throw new Error("Prompt failed.");
      },
      now: () => "2026-06-15T00:00:00.000Z",
    });

    await expect(service.request(createPermissionRequest())).resolves.toMatchObject({
      status: "denied",
      code: "permission_prompt_failed",
      reason: "Prompt failed.",
    });
  });

  it("emits host permission requested and resolved events", async () => {
    const events: HostEvent[] = [];
    const service = createHostPermissionService({
      sessionId: "session-1",
      bridge: async () => ({
        status: "granted",
      }),
      eventSink: (event) => {
        events.push(event);
      },
      now: () => "2026-06-15T00:00:00.000Z",
    });

    await service.request(createPermissionRequest());

    expect(events.map((event) => event.name)).toEqual([
      "host.permission.requested",
      "host.permission.resolved",
    ]);
  });
});

function createPermissionRequest(): PermissionRequest {
  return {
    id: "permission-1",
    taskId: "task-1",
    action: "tool.execute",
    risk: "high",
    reason: "Run risky tool.",
    metadata: {},
  };
}
