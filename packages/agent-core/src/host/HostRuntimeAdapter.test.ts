import { describe, expect, it } from "vitest";
import {
  Runner,
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createRunCancellationController,
  createSucceededRunResult,
} from "../runner/index.js";
import type { Controller, ControllerDecision } from "../controller/index.js";
import {
  createHostRunResult,
  createHostRuntimeAdapter,
} from "./HostRuntimeAdapter.js";

describe("HostRuntimeAdapter", () => {
  it.each([
    ["succeeded", "completed"],
    ["blocked", "blocked"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("projects %s RunResult to %s without replacing it", (status, hostStatus) => {
    const runResult = createRunResult(status);
    const result = createHostRunResult({
      sessionId: "session-1",
      runResult,
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    expect(result.state.status).toBe(hostStatus);
    expect(result.runResult).toBe(runResult);
    expect(result.state.runResult).toBe(runResult);
    expect(result.runId).toBe("run-1");
  });

  it("invokes Runner once and preserves its succeeded RunResult", async () => {
    const controller = new CountingController();
    const adapter = createHostRuntimeAdapter({
      runner: new Runner({ controller }),
      now: () => "2026-06-15T00:00:00.000Z",
    });
    const cancellation = createRunCancellationController({ runId: "run-1" });

    const result = await adapter.run({
      sessionId: "session-1",
      agent: {
        id: "agent-1",
        name: "Test Agent",
        instructions: "Complete the task.",
        tools: [],
        output: {
          validate(candidate) {
            return candidate !== null && typeof candidate === "object"
              ? { valid: true, output: candidate as { ok: true } }
              : { valid: false, message: "Output must be an object." };
          },
        },
        metadata: {},
      },
      runInput: {
        runId: "run-1",
        task: {
          id: "task-1",
          kind: "test.task",
          input: {},
          createdAt: "2026-06-15T00:00:00.000Z",
          metadata: {},
        },
        conversationItems: [],
        metadata: {},
      },
      runConfig: {
        workspace: {
          id: "workspace-1",
          name: "Workspace",
          rootRef: "workspace://test",
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
        identity: {
          id: "identity-1",
          kind: "anonymous",
          displayName: "Test identity",
          metadata: {},
        },
        limits: {
          maxIterations: 1,
          maxActions: 0,
          maxConsecutiveActionFailures: 0,
          maxDurationMs: 1_000,
          plan: {
            maxSteps: 4,
            maxStepLength: 100,
            maxExplanationLength: 200,
          },
        },
        audit: "optional",
        telemetry: "optional",
        cancellation,
        cancellationLimits: {
          boundarySettlementTimeoutMs: 1_000,
          processGracePeriodMs: 100,
          processForceKillTimeoutMs: 500,
          finalizationTimeoutMs: 1_000,
        },
        metadata: {},
      },
      metadata: { surface: "test-host" },
    });

    expect(controller.calls).toBe(1);
    expect(result).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      state: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { ok: true },
      },
      metadata: { surface: "test-host" },
    });
  });
});

class CountingController implements Controller {
  calls = 0;

  async next(): Promise<ControllerDecision> {
    this.calls += 1;
    return {
      kind: "final_output",
      output: { ok: true },
      modelItems: [{
        id: "model-1",
        kind: "assistant_output",
        content: { ok: true },
        metadata: {},
      }],
    };
  }
}

function createRunResult(
  status: "succeeded" | "blocked" | "failed" | "cancelled",
) {
  const base = { runId: "run-1", taskId: "task-1" };
  switch (status) {
    case "succeeded":
      return createSucceededRunResult(base, { ok: true });
    case "blocked":
      return createBlockedRunResult(base, "runtime_no_safe_path");
    case "failed":
      return createFailedRunResult(base, "runtime_limit_exceeded", [{
        owner: "runtime",
        code: "runtime_limit_exceeded",
        message: "Limit exceeded.",
        retryable: false,
        metadata: {},
      }]);
    case "cancelled":
      return createCancelledRunResult(base, {
        requestId: "run-1:cancellation",
        origin: "host",
        reasonCode: "host_requested",
        requestedAt: "2026-06-15T00:00:00.000Z",
      });
  }
}
