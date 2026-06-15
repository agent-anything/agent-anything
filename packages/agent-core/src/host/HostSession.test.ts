import { describe, expect, it } from "vitest";
import type { HostRunInput, HostRunResult, HostSessionState } from "./HostSession.js";

describe("HostSession types", () => {
  it("represents in-progress host states separately from runtime results", () => {
    const state: HostSessionState = {
      sessionId: "session-1",
      status: "running",
      taskId: "task-1",
      timestamp: "2026-06-15T00:00:00.000Z",
      metadata: {},
    };

    expect(state.status).toBe("running");
  });

  it("accepts workspace and identity context in host run input", () => {
    const input: HostRunInput<{ target: string }> = {
      sessionId: "session-1",
      task: {
        id: "task-1",
        kind: "example.task",
        input: { target: "example.com" },
        createdAt: "2026-06-15T00:00:00.000Z",
        metadata: {},
      },
      runtimeOptions: {
        limits: {
          maxIterations: 1,
          maxToolCalls: 1,
          maxDurationMs: 1_000,
          maxConsecutiveFailures: 1,
        },
        permissionMode: "trusted",
        metadata: {},
      },
      workspace: {
        id: "workspace-1",
        name: "Example",
        rootRef: "file:///workspace",
        policyRefs: [],
        metadata: {},
      },
      identity: {
        id: "identity-1",
        kind: "user",
        displayName: "Example User",
        metadata: {},
      },
      metadata: {},
    };

    expect(input.workspace?.id).toBe("workspace-1");
    expect(input.identity?.kind).toBe("user");
  });

  it("represents terminal host run results with the underlying runtime result", () => {
    const result: HostRunResult<{ ok: true }> = {
      sessionId: "session-1",
      taskId: "task-1",
      state: {
        sessionId: "session-1",
        status: "completed",
        taskId: "task-1",
        timestamp: "2026-06-15T00:00:00.000Z",
        runtimeResult: {
          taskId: "task-1",
          status: "succeeded",
          output: { ok: true },
          outputSpec: {
            format: "json",
            metadata: {},
          },
          evidenceRefs: [],
          artifactRefs: [],
          errors: [],
          metadata: {},
        },
        metadata: {},
      },
      runtimeResult: {
        taskId: "task-1",
        status: "succeeded",
        output: { ok: true },
        outputSpec: {
          format: "json",
          metadata: {},
        },
        evidenceRefs: [],
        artifactRefs: [],
        errors: [],
        metadata: {},
      },
      metadata: {},
    };

    expect(result.state.status).toBe("completed");
    expect(result.runtimeResult?.status).toBe("succeeded");
  });

  it("represents blocked host session states without collapsing them into failures", () => {
    const state: HostSessionState = {
      sessionId: "session-1",
      status: "blocked",
      taskId: "task-1",
      timestamp: "2026-06-15T00:00:00.000Z",
      runtimeResult: {
        taskId: "task-1",
        status: "blocked",
        output: null,
        outputSpec: {
          format: "json",
          metadata: {},
        },
        evidenceRefs: [],
        artifactRefs: [],
        errors: [
          {
            code: "permission_denied",
            message: "Permission denied.",
            metadata: {},
          },
        ],
        metadata: {},
      },
      metadata: {},
    };

    expect(state.status).toBe("blocked");
    expect(state.runtimeResult.status).toBe("blocked");
  });
});
