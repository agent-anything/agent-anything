import { describe, expect, it, vi } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import {
  resolvePermissionProfile,
  type ApprovalDecisionSubmission,
  type ApprovalReviewInput,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type { Agent } from "@agent-anything/agent-core/agent";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import { RuntimeEventEmitter } from "@agent-anything/agent-core/events";
import {
  createRunCancellationController,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/agent-core/run";
import {
  Runner,
  type RunConfig,
} from "@agent-anything/agent-core/runner";
import {
  createHostRuntime,
  type HostRunOutcome,
  type HostRunResult,
  type HostRunStartInput,
} from "./HostRuntime.js";
import {
  createUserApprovalReviewBridge,
  type UserApprovalReviewBridge,
} from "./UserApprovalReviewBridge.js";

interface TestOutput {
  readonly summary: string;
}

const now = "2026-07-17T00:00:00.000Z";

describe("HostRuntime", () => {
  it("owns one invocation from running projection through exact terminal result", async () => {
    const controller = new DeferredController();
    const runner = new Runner({ controller, now: () => now });
    const run = vi.spyOn(runner, "run");
    const runtime = createHostRuntime({
      runner,
      now: () => now,
    });
    const active = runtime.start(createStartInput());
    const snapshots: string[] = [];
    const unsubscribe = active.subscribe((projection) => snapshots.push(projection.status));

    expect(active.sessionId).toBe("session-1");
    expect(active.runId).toBe("run-1");
    expect(active.getProjection().status).toBe("running");
    expect(run).toHaveBeenCalledOnce();

    await controller.entered;
    controller.complete("Host active Run complete");
    const outcome = await active.result;
    const result = requireRunResult(outcome);
    unsubscribe();

    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Host active Run complete" },
    });
    expect(result.terminal).toBe(active.getProjection().terminal);
    expect(active.getProjection()).toMatchObject({
      status: "completed",
      terminal: { status: "completed", code: null },
    });
    expect(JSON.stringify(active.getProjection())).not.toContain("Host active Run complete");
    expect(snapshots).toContain("completed");
  });

  it("sends accepted cancellation to the original controller and rejects duplicates", async () => {
    const startInput = createStartInput();
    const runtime = createHostRuntime({
      runner: new Runner({ controller: new DeferredController(), now: () => now }),
      now: () => now,
    });
    const active = runtime.start(startInput);

    const accepted = active.cancel({
      origin: "user",
      reasonCode: "user_requested",
      reason: "private cancellation text",
    });
    const duplicate = active.cancel({
      origin: "host",
      reasonCode: "host_requested",
    });

    expect(accepted).toMatchObject({
      status: "accepted",
      cancellation: {
        requestId: "run-1:cancellation",
        origin: "user",
        reasonCode: "user_requested",
      },
    });
    expect(duplicate).toEqual({
      status: "already_requested",
      cancellation: accepted.cancellation,
    });
    expect(startInput.runConfig.cancellation.context.signal.aborted).toBe(true);
    expect(startInput.runConfig.cancellation.context.request?.reason).toBe(
      "private cancellation text",
    );
    expect(JSON.stringify(active.getProjection())).not.toContain("private cancellation text");

    const result = requireRunResult(await active.result);
    expect(result.runResult.status).toBe("cancelled");
    expect(active.getProjection().status).toBe("cancelled");
  });

  it("does not let late cancellation change a settled Run", async () => {
    const controller = new DeferredController();
    const runtime = createHostRuntime({
      runner: new Runner({ controller, now: () => now }),
      now: () => now,
    });
    const active = runtime.start(createStartInput());
    await controller.entered;
    controller.complete("Already settled");
    await active.result;
    const sequence = active.getProjection().sequence;

    expect(active.cancel({ origin: "host", reasonCode: "host_requested" })).toEqual({
      status: "run_settled",
      cancellation: null,
    });
    expect(active.getProjection().sequence).toBe(sequence);
    expect(active.getProjection().status).toBe("completed");
  });

  it("returns an explicit start failure without fabricating a RunResult or terminal projection", async () => {
    const invalidAgent = {
      ...createAgent(),
      instructions: 42,
    } as unknown as Agent<TestOutput>;
    const runtime = createHostRuntime({
      runner: new Runner({ controller: new DeferredController(), now: () => now }),
      now: () => now,
    });
    const active = runtime.start(createStartInput({ agent: invalidAgent }));

    expect(await active.result).toEqual({
      kind: "start_failure",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      code: "host_runner_start_failed",
      occurredAt: now,
    });
    expect(active.getProjection()).toMatchObject({
      status: "starting",
      terminal: null,
    });
    expect(active.cancel({ origin: "host", reasonCode: "host_requested" })).toEqual({
      status: "start_failed",
      cancellation: null,
    });
  });

  it("rejects invalid handle identities before invoking Runner", () => {
    const runtime = createHostRuntime({
      runner: new Runner({ controller: new DeferredController(), now: () => now }),
      now: () => now,
    });

    expect(() => runtime.start(createStartInput({ sessionId: " " }))).toThrow(
      "sessionId must be a non-empty string",
    );
  });

  it("requires the exact Run-bound user reviewer before invoking Runner", () => {
    const controller = new DeferredController();
    const runner = new Runner({ controller, now: () => now });
    const run = vi.spyOn(runner, "run");
    const runtime = createHostRuntime({ runner, now: () => now });
    const configuredBridge = createApprovalBridge("run-1");
    const otherBridge = createApprovalBridge("run-1");
    const configured = createUserReviewStartInput(configuredBridge);

    expect(() => runtime.start({
      ...configured,
      userApprovalReviewBridge: null,
    })).toThrow("requires an explicit approval review bridge");
    expect(() => runtime.start({
      ...configured,
      userApprovalReviewBridge: createApprovalBridge("run-other"),
    })).toThrow("Run identity does not match");
    expect(() => runtime.start({
      ...configured,
      userApprovalReviewBridge: otherBridge,
    })).toThrow("does not match the configured user reviewer");
    expect(run).not.toHaveBeenCalled();
  });

  it("correlates one versioned user submission with the active Host Run", async () => {
    const bridge = createApprovalBridge("run-1");
    const controller = new DeferredController();
    const runtime = createHostRuntime({
      runner: new Runner({ controller, now: () => now }),
      now: () => now,
    });
    const active = runtime.start(createUserReviewStartInput(bridge));
    await controller.entered;
    const pendingReview = bridge.review(
      createApprovalReviewInput(),
      interruptionContext(),
    );
    await flushMicrotasks();

    const pending = active.getProjection();
    expect(pending).toMatchObject({
      status: "waiting_for_approval",
      approval: {
        requestId: "request-1",
        pendingVersion: 1,
        phase: "reviewing",
      },
    });
    expect(active.getProjection()).toBe(pending);
    expect(active.submitApprovalDecision(approvalSubmission({
      runId: "run-other",
      submissionId: "cross-run",
    }))).toMatchObject({ code: "approval_not_pending" });
    expect(active.submitApprovalDecision(approvalSubmission({
      pendingVersion: 2,
      submissionId: "stale-version",
    }))).toMatchObject({ code: "approval_version_mismatch" });

    const accepted = active.submitApprovalDecision(approvalSubmission());
    expect(accepted).toMatchObject({
      status: "accepted_for_resolution",
      runId: "run-1",
      requestId: "request-1",
      pendingVersion: 1,
    });
    expect(active.getProjection().approval?.phase).toBe("submitted_for_resolution");
    const submittedSequence = active.getProjection().sequence;
    expect(active.submitApprovalDecision(approvalSubmission())).toBe(accepted);
    expect(active.getProjection().sequence).toBe(submittedSequence);
    await expect(pendingReview).resolves.toMatchObject({ status: "decided" });

    controller.complete("Approved Run complete");
    expect(requireRunResult(await active.result).runResult.status).toBe("succeeded");
    expect(active.submitApprovalDecision(approvalSubmission({
      submissionId: "late-submission",
    }))).toMatchObject({ code: "approval_not_pending" });
  });

  it("rejects post-cancellation approval without settling weaker authority", async () => {
    const bridge = createApprovalBridge("run-1");
    const controller = new DeferredController();
    const startInput = createUserReviewStartInput(bridge);
    const runtime = createHostRuntime({
      runner: new Runner({ controller, now: () => now }),
      now: () => now,
    });
    const active = runtime.start(startInput);
    await controller.entered;
    const pendingReview = bridge.review(
      createApprovalReviewInput(),
      runInterruptionContext(startInput.runConfig),
    );
    await flushMicrotasks();

    expect(active.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    await expect(pendingReview).resolves.toMatchObject({
      status: "interrupted",
      interruption: { kind: "run_cancellation" },
    });
    expect(active.submitApprovalDecision(approvalSubmission({
      submissionId: "post-cancel",
    }))).toMatchObject({ code: "approval_not_pending" });
    expect(requireRunResult(await active.result).runResult.cancellation).toMatchObject({
      origin: "user",
      reasonCode: "user_requested",
    });
  });

  it("isolates a failing global event publisher from invocation projection", async () => {
    const controller = new DeferredController();
    const globalEvents = new RuntimeEventEmitter();
    const observed: string[] = [];
    globalEvents.subscribe((event) => {
      observed.push(event.name);
      event.payload.runId = "mutated-by-global-observer";
      throw new Error("global observer failed");
    });
    const runtime = createHostRuntime({
      runner: new Runner({
        controller,
        eventEmitter: globalEvents,
        now: () => now,
      }),
      now: () => now,
    });
    const active = runtime.start(createStartInput());
    await controller.entered;
    controller.complete("Still completes");

    expect(requireRunResult(await active.result).runResult.status).toBe("succeeded");
    expect(observed).toContain("run.started");
    expect(active.getProjection().status).toBe("completed");
  });
});

class DeferredController implements Controller {
  private resolveEntered!: () => void;
  private resolveDecision!: (decision: ControllerDecision) => void;
  readonly entered = new Promise<void>((resolve) => {
    this.resolveEntered = resolve;
  });

  next(input: ControllerInput, _context: ControllerCallContext): Promise<ControllerDecision> {
    this.resolveEntered();
    return new Promise((resolve) => {
      this.resolveDecision = resolve;
    }).then((decision) => ({
      ...decision,
      modelItems: [{
        id: `${input.runId}:model:1`,
        kind: "assistant_action" as const,
        content: { action: "complete" },
        metadata: {},
      }],
    }));
  }

  complete(summary: string): void {
    this.resolveDecision({
      kind: "final_output",
      output: { summary },
      modelItems: [{
        id: "placeholder",
        kind: "assistant_action",
        content: {},
        metadata: {},
      }],
    });
  }
}

function createStartInput(input: {
  readonly sessionId?: string;
  readonly agent?: Agent<TestOutput>;
} = {}): HostRunStartInput<TestOutput> {
  const cancellation = createRunCancellationController({
    runId: "run-1",
    now: () => now,
  });
  return {
    sessionId: input.sessionId ?? "session-1",
    agent: input.agent ?? createAgent(),
    runInput: {
      runId: "run-1",
      task: {
        id: "task-1",
        kind: "test.task",
        input: {},
        createdAt: now,
        metadata: {},
      },
      conversationItems: [],
      metadata: {},
    },
    runConfig: createRunConfig(cancellation),
  };
}

function createUserReviewStartInput(
  bridge: UserApprovalReviewBridge,
): HostRunStartInput<TestOutput> {
  const input = createStartInput();
  return {
    ...input,
    userApprovalReviewBridge: bridge,
    runConfig: {
      ...input.runConfig,
      permissions: {
        ...input.runConfig.permissions,
        approvalPolicy: "on-request",
        reviewer: {
          bindingId: "reviewer-user-binding",
          kind: "user",
          reviewer: bridge,
          descriptor: bridge.descriptor,
          reviewTimeoutMs: null,
        },
      },
    },
  };
}

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent-1",
    name: "Test Agent",
    instructions: "Complete the task.",
    tools: [],
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "summary" in candidate &&
          typeof candidate.summary === "string"
        ) {
          return { valid: true, output: { summary: candidate.summary } };
        }
        return { valid: false, message: "Output requires summary." };
      },
    },
    metadata: {},
  };
}

function createRunConfig(
  cancellation: ReturnType<typeof createRunCancellationController>,
): RunConfig {
  return {
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
    actionContext: null,
    permissions: createTestPermissionConfig(),
    limits: {
      maxIterations: 2,
      maxActions: 0,
      maxConsecutiveActionFailures: 0,
      maxDurationMs: 5_000,
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
      operationSettlementTimeoutMs: 1_000,
      processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500,
      finalizationTimeoutMs: 1_000,
    },
    retry: {
      providerRequest: disabledRetryPolicy(),
      structuredOutput: disabledRetryPolicy(),
      approvalsReviewer: disabledRetryPolicy(),
    },
    metadata: {},
  };
}

function disabledRetryPolicy() {
  return {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
}

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-managed",
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
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace-1", path: "C:/workspace" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    networkRules: [],
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

function requireRunResult(
  outcome: HostRunOutcome<TestOutput>,
): HostRunResult<TestOutput> {
  if (outcome.kind !== "run_result") {
    throw new Error(`Expected RunResult, received ${outcome.kind}.`);
  }
  return outcome as HostRunResult<TestOutput>;
}

function createApprovalBridge(runId: string): UserApprovalReviewBridge {
  return createUserApprovalReviewBridge({
    runId,
    descriptor: {
      id: "reviewer-user",
      kind: "user",
      displayName: "User",
      source: "host-runtime-test",
      metadata: {},
    },
  });
}

function createApprovalReviewInput(): ApprovalReviewInput {
  return {
    request: {
      id: "request-1",
      runId: "run-1",
      actionId: "action-1",
      actionFingerprint: "sha256:action-1",
      category: "mcpToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run-1",
        actionId: "action-1",
        actionFingerprint: "sha256:action-1",
        environmentId: "local",
        applicabilityKeyCount: 0,
      },
      payload: {
        serverId: "server-1",
        serverDisplayName: "Server",
        toolName: "read",
        safeArguments: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        supportsSessionAuthority: false,
      },
      decisionOptions: [{
        id: "accept-action",
        kind: "accept",
        scope: "action",
        label: "Accept",
        description: null,
      }],
      createdAt: now,
      deadlineAt: "2026-07-17T00:01:00.000Z",
    },
    pendingVersion: 1,
    context: {
      workspaceTrustState: "trusted",
      ruleOutcome: "prompt",
      currentAuthority: {
        fileSystemRead: true,
        fileSystemWrite: false,
        network: false,
      },
      annotations: {},
    },
  };
}

function approvalSubmission(
  overrides: Partial<ApprovalDecisionSubmission> = {},
): ApprovalDecisionSubmission {
  return {
    submissionId: "submission-1",
    runId: "run-1",
    requestId: "request-1",
    pendingVersion: 1,
    optionId: "accept-action",
    grantedPermissions: null,
    reason: null,
    ...overrides,
  };
}

function interruptionContext(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

function runInterruptionContext(runConfig: RunConfig): InvocationInterruptionContext {
  return Object.freeze({
    signal: runConfig.cancellation.context.signal,
    get interruption(): InvocationInterruptionRef | null {
      const request = runConfig.cancellation.context.request;
      return request === null
        ? null
        : {
            kind: "run_cancellation",
            cancellation: { runId: request.runId, requestId: request.id },
          };
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
