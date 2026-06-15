import { describe, expect, it } from "vitest";
import type { RuntimeResult, RuntimeStatus } from "../runtime/index.js";
import { createHostRunResult } from "./HostRuntimeAdapter.js";

describe("createHostRunResult", () => {
  it("maps succeeded runtime results to completed host state", () => {
    const result = createHostRunResult({
      sessionId: "session-1",
      runtimeResult: createRuntimeResult("succeeded"),
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    expect(result.state.status).toBe("completed");
    expect(result.runtimeResult?.status).toBe("succeeded");
  });

  it("maps failed runtime results to failed host state", () => {
    const result = createHostRunResult({
      sessionId: "session-1",
      runtimeResult: createRuntimeResult("failed"),
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    expect(result.state.status).toBe("failed");
    expect(result.runtimeResult?.status).toBe("failed");
  });

  it("maps blocked runtime results to blocked host state", () => {
    const result = createHostRunResult({
      sessionId: "session-1",
      runtimeResult: createRuntimeResult("blocked"),
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    expect(result.state.status).toBe("blocked");
    expect(result.runtimeResult?.status).toBe("blocked");
  });

  it("maps cancelled runtime results to cancelled host state", () => {
    const result = createHostRunResult({
      sessionId: "session-1",
      runtimeResult: createRuntimeResult("cancelled"),
      cancellation: {
        requested: true,
        reason: "user cancelled",
        requestedAt: "2026-06-15T00:00:00.000Z",
        metadata: {},
      },
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    expect(result.state.status).toBe("cancelled");
    expect(result.cancellation?.requested).toBe(true);
    expect(result.runtimeResult?.status).toBe("cancelled");
  });
});

function createRuntimeResult(status: RuntimeStatus): RuntimeResult<{ ok: boolean } | null> {
  return {
    taskId: "task-1",
    status,
    output: status === "succeeded" ? { ok: true } : null,
    outputSpec: {
      format: "json",
      metadata: {},
    },
    evidenceRefs: [],
    artifactRefs: [],
    errors: status === "succeeded"
      ? []
      : [
        {
          code: status === "blocked" ? "permission_denied" : "runtime_invalid_options",
          message: `${status} result`,
          metadata: {},
        },
      ],
    metadata: {},
  };
}
