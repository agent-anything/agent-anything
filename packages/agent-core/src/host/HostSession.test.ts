import { describe, expect, it } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission";
import {
  createRunCancellationController,
  toRunCancellationSummary,
} from "../runner/index.js";
import type { ResolvedRunPermissionConfig } from "../runner/index.js";
import type { HostRunInput, HostSessionState } from "./HostSession.js";

describe("HostSession contracts", () => {
  it("represents active Host state separately from authoritative Run state", () => {
    const state: HostSessionState = {
      sessionId: "session-1",
      status: "running",
      taskId: "task-1",
      runId: "run-1",
      timestamp: "2026-06-15T00:00:00.000Z",
      metadata: {},
    };

    expect(state).toMatchObject({ status: "running", runId: "run-1" });
  });

  it("carries Agent, RunInput, and RunConfig as one Host invocation", () => {
    const cancellation = createRunCancellationController({ runId: "run-1" });
    const input: HostRunInput<{ ok: true }> = {
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
          kind: "example.task",
          input: { target: "example.com" },
          createdAt: "2026-06-15T00:00:00.000Z",
          metadata: {},
        },
        conversationItems: [],
        metadata: {},
      },
      runConfig: {
        workspace: {
          id: "workspace-1",
          name: "Example",
          rootRef: "file:///workspace",
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
        identity: {
          id: "identity-1",
          kind: "user",
          displayName: "Example User",
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
    };

    expect(input.runInput.runId).toBe(input.runConfig.cancellation.context.runId);
    expect(input.agent.id).toBe("agent-1");
    expect(input.metadata).toEqual({ surface: "test-host" });
  });

  it("projects an accepted cancellation request as non-terminal cancelling state", () => {
    const cancellation = createRunCancellationController({
      runId: "run-1",
      now: () => "2026-06-15T00:00:00.000Z",
    });
    const receipt = cancellation.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
      reason: "Host requested cancellation.",
    });
    const state: HostSessionState = {
      sessionId: "session-1",
      status: "cancelling",
      taskId: "task-1",
      runId: "run-1",
      timestamp: receipt.request.requestedAt,
      cancellation: toRunCancellationSummary(receipt.request),
      metadata: {},
    };

    expect(state.status).toBe("cancelling");
    expect(state.cancellation).toEqual({
      requestId: "run-1:cancellation",
      origin: "host",
      reasonCode: "host_requested",
      requestedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(JSON.stringify(state)).not.toContain("Host requested cancellation.");
  });
});

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "host-session-managed",
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
        environmentId: "host-session-local",
        platform: "posix",
        workspaceRoots: [{ rootId: "workspace-1", path: "/workspace" }],
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
