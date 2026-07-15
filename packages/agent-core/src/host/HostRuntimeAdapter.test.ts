import { describe, expect, it } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission";
import {
  Runner,
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createRunCancellationController,
  createSucceededRunResult,
  type ResolvedRunPermissionConfig,
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
        permissions: createTestPermissionConfig(),
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
          retry: {
            providerRequest: {
              maxRetries: 0,
              delay: {
                kind: "exponential_jitter",
                baseDelayMs: 0,
                maxDelayMs: 0,
                multiplier: 2,
                jitterRatio: 0.1,
              },
              retryableCategories: [],
              serverDelay: { mode: "ignore" },
            },
            structuredOutput: {
              maxRetries: 0,
              delay: {
                kind: "exponential_jitter",
                baseDelayMs: 0,
                maxDelayMs: 0,
                multiplier: 2,
                jitterRatio: 0.1,
              },
              retryableCategories: [],
              serverDelay: { mode: "ignore" },
            },
            approvalsReviewer: {
              maxRetries: 0,
              delay: {
                kind: "exponential_jitter",
                baseDelayMs: 0,
                maxDelayMs: 0,
                multiplier: 2,
                jitterRatio: 0.1,
              },
              retryableCategories: [],
              serverDelay: { mode: "ignore" },
            },
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

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "host-adapter-managed",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "host-adapter-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace-1", path: "C:/workspace" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    managedConstraints,
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

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
