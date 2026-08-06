import { describe, expect, it, vi } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import {
  resolvePermissionProfile,
  type ApprovalDecisionSubmission,
  type ApprovalReviewInput,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/run";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { Controller, ControllerCallContext, ControllerDecision, ControllerInput } from "@agent-anything/agent-runtime/controller";
import {
  FakeRuntimeEventPublisher,
  createTestContextProjection,
} from "@agent-anything/test-support";
import type { CancellationContext, ResolvedRunPermissionConfig } from "@agent-anything/agent-runtime/run";
import { Runner, type RunConfig } from "@agent-anything/agent-runtime/runner";
import {
  createEmptyToolActionBindingSnapshot,
} from "@agent-anything/action-execution/registration";
import {
  createHostRunManager,
  type HostRunStartInput,
} from "./HostRunManager.js";
import {
  createUserApprovalReviewBridge,
  type UserApprovalReviewBridge,
} from "../authority/UserApprovalReviewBridge.js";

interface TestOutput {
  readonly summary: string;
}

const now = "2026-07-17T00:00:00.000Z";

describe("HostRunManager", () => {
  it("owns one invocation from running projection through exact terminal result", async () => {
    const controller = new DeferredController();
    const runner = createRunner(controller);
    const start = vi.spyOn(runner, "start");
    const manager = createHostRunManager({
      runner,
      now: () => now,
    });
    const active = manager.start(createStartInput());
    const snapshots: string[] = [];
    const unsubscribe = active.subscribe((projection) => snapshots.push(projection.status));

    expect(active.sessionId).toBe("session-1");
    expect(active.runId).toBe("run-1");
    expect(active).not.toHaveProperty("result");
    expect(active.getProjection().status).toBe("starting");
    expect(start).toHaveBeenCalledOnce();

    await controller.entered;
    controller.complete("Host active Run complete");
    expect(active.getResult()).toBeNull();
    const firstWait = active.wait();
    const secondWait = active.wait();
    expect(secondWait).toBe(firstWait);
    const result = await firstWait;
    unsubscribe();

    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Host active Run complete" },
    });
    expect(result.terminal).toBe(active.getProjection().terminal);
    expect(active.getResult()).toBe(result);
    expect(await active.wait()).toBe(result);
    expect(active.getProjection()).toMatchObject({
      status: "completed",
      terminal: { status: "completed", code: null },
    });
    expect(JSON.stringify(active.getProjection())).not.toContain("Host active Run complete");
    expect(snapshots).toContain("completed");
  });

  it("sends accepted cancellation to the original controller and rejects duplicates", async () => {
    const startInput = createStartInput();
    const controller = new DeferredController();
    const manager = createHostRunManager({
      runner: createRunner(controller),
      now: () => now,
    });
    const active = manager.start(startInput);
    await controller.entered;

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
        requestId: "run-1:run_cancellation_request:1",
        origin: "user",
        reasonCode: "user_requested",
      },
    });
    expect(duplicate).toEqual({
      status: "already_requested",
      cancellation: accepted.cancellation,
    });
    expect(controller.lastContext?.cancellation.signal.aborted).toBe(true);
    expect(controller.lastContext?.cancellation.request?.reason).toBe(
      "private cancellation text",
    );
    expect(JSON.stringify(active.getProjection())).not.toContain("private cancellation text");

    controller.complete("Discarded after cancellation");
    const result = await active.wait();
    expect(result.runResult.status).toBe("cancelled");
    expect(active.getProjection().status).toBe("cancelled");
  });

  it("does not let late cancellation change a settled Run", async () => {
    const controller = new DeferredController();
    const manager = createHostRunManager({
      runner: createRunner(controller),
      now: () => now,
    });
    const active = manager.start(createStartInput());
    await controller.entered;
    controller.complete("Already settled");
    await active.wait();
    const sequence = active.getProjection().sequence;

    expect(active.cancel({ origin: "host", reasonCode: "host_requested" })).toEqual({
      status: "run_settled",
      cancellation: null,
    });
    expect(active.getProjection().sequence).toBe(sequence);
    expect(active.getProjection().status).toBe("completed");
  });

  it("rejects invalid composition before creating a HostActiveRun", () => {
    const invalidAgent = {
      ...createAgent(),
      instructions: 42,
    } as unknown as Agent<TestOutput>;
    const manager = createHostRunManager({
      runner: createRunner(new DeferredController()),
      now: () => now,
    });
    expect(() => manager.start(createStartInput({ agent: invalidAgent })))
      .toThrow("Agent.instructions must be text.");
    expect(manager.listRuns()).toEqual([]);
  });

  it("rejects invalid handle identities before invoking Runner", () => {
    const manager = createHostRunManager({
      runner: createRunner(new DeferredController()),
      now: () => now,
    });

    expect(() => manager.start(createStartInput({ sessionId: " " }))).toThrow(
      "sessionId must be a non-empty string",
    );
  });

  it("requires the exact configured user reviewer before invoking Runner", () => {
    const controller = new DeferredController();
    const runner = createRunner(controller);
    const start = vi.spyOn(runner, "start");
    const manager = createHostRunManager({ runner, now: () => now });
    const configuredBridge = createApprovalBridge();
    const otherBridge = createApprovalBridge();
    const configured = createUserReviewStartInput(configuredBridge);
    const { userApprovalReviewBridge: _omitted, ...missingBridge } = configured;

    expect(() => manager.start(
      missingBridge as HostRunStartInput<TestOutput>,
    )).toThrow("must explicitly provide an approval review bridge or null");
    expect(() => manager.start({
      ...configured,
      userApprovalReviewBridge: null,
    })).toThrow("requires an explicit approval review bridge");
    expect(() => manager.start({
      ...configured,
      userApprovalReviewBridge: otherBridge,
    })).toThrow("does not match the configured user reviewer");
    expect(start).not.toHaveBeenCalled();
  });

  it("correlates one versioned user submission with the active Host Run", async () => {
    const bridge = createApprovalBridge();
    const controller = new DeferredController();
    const manager = createHostRunManager({
      runner: createRunner(controller),
      now: () => now,
    });
    const active = manager.start(createUserReviewStartInput(bridge));
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
    expect((await active.wait()).runResult.status).toBe("succeeded");
    expect(active.submitApprovalDecision(approvalSubmission({
      submissionId: "late-submission",
    }))).toMatchObject({ code: "approval_not_pending" });
  });

  it("rejects post-cancellation approval without settling weaker authority", async () => {
    const bridge = createApprovalBridge();
    const controller = new DeferredController();
    const startInput = createUserReviewStartInput(bridge);
    const manager = createHostRunManager({
      runner: createRunner(controller),
      now: () => now,
    });
    const active = manager.start(startInput);
    await controller.entered;
    const pendingReview = bridge.review(
      createApprovalReviewInput(),
      runInterruptionContext(requireControllerContext(controller).cancellation),
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
    expect((await active.wait()).runResult.cancellation).toMatchObject({
      origin: "user",
      reasonCode: "user_requested",
    });
  });

  it("isolates a failing global event publisher from invocation projection", async () => {
    const controller = new DeferredController();
    const globalEvents = new FakeRuntimeEventPublisher();
    const observed: string[] = [];
    globalEvents.subscribe((event) => {
      observed.push(event.name);
      Object.defineProperty(event.payload, "productTrace", {
        value: "mutated-by-global-observer",
      });
      throw new Error("global observer failed");
    });
    const manager = createHostRunManager({
      runner: new Runner({
        controller,
        contextProjection: createTestContextProjection(),
        createRunId: () => "run-1",
        runtimeEventPublisher: globalEvents,
        now: () => now,
      }),
      now: () => now,
    });
    const active = manager.start(createStartInput());
    await controller.entered;
    controller.complete("Still completes");

    expect((await active.wait()).runResult.status).toBe("succeeded");
    expect(observed).toContain("run.started");
    expect(active.getProjection().status).toBe("completed");
  });

  it("retains the original active wrapper for reconnect and releases only terminal entries", async () => {
    const controller = new DeferredController();
    const manager = createHostRunManager({
      runner: createRunner(controller),
      terminalRetentionLimit: 2,
      now: () => now,
    });
    const active = manager.start(createStartInput());

    expect(manager.getRun("run-1")).toBe(active);
    expect(manager.listRuns()).toEqual([{
      runId: "run-1",
      sessionId: "session-1",
      lifecycle: "active",
    }]);
    expect(manager.releaseRun("run-1")).toEqual({
      status: "run_active",
      runId: "run-1",
    });

    await controller.entered;
    controller.complete("Retained terminal result");
    await active.wait();

    expect(manager.getRun("run-1")).toBe(active);
    expect(manager.listRuns()[0]?.lifecycle).toBe("settled");
    expect(manager.releaseRun("run-1")).toEqual({
      status: "released",
      runId: "run-1",
    });
    expect(manager.getRun("run-1")).toBeNull();
    expect(manager.releaseRun("run-1")).toEqual({
      status: "not_found",
      runId: "run-1",
    });
  });

  it("evicts the oldest terminal wrapper at the configured retention limit", async () => {
    let sequence = 0;
    const controller: Controller<TestOutput> = {
      async next() {
        return {
          kind: "final_output",
          output: { summary: "Done" },
          modelItems: [],
        };
      },
    };
    const manager = createHostRunManager({
      runner: new Runner({
        controller,
        contextProjection: createTestContextProjection(),
        createRunId: () => {
          sequence += 1;
          return `run-${sequence}`;
        },
        now: () => now,
      }),
      terminalRetentionLimit: 1,
      now: () => now,
    });

    const first = manager.start(createStartInput());
    await first.wait();
    const second = manager.start(createStartInput());
    await second.wait();

    expect(manager.getRun("run-1")).toBeNull();
    expect(manager.getRun("run-2")).toBe(second);
    expect(manager.listRuns()).toEqual([{
      runId: "run-2",
      sessionId: "session-1",
      lifecycle: "settled",
    }]);
  });
});

class DeferredController implements Controller {
  private resolveEntered!: () => void;
  private resolveDecision!: (decision: ControllerDecision) => void;
  readonly entered = new Promise<void>((resolve) => {
    this.resolveEntered = resolve;
  });
  lastContext: ControllerCallContext | null = null;

  next(input: ControllerInput, context: ControllerCallContext): Promise<ControllerDecision> {
    this.lastContext = context;
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
  return {
    sessionId: input.sessionId ?? "session-1",
    agent: input.agent ?? createAgent(),
    userApprovalReviewBridge: null,
    runInput: {
      task: {
        id: "task-1",
        kind: "test.task",
        input: {},
        createdAt: now,
        metadata: {},
      },
      items: [],
      metadata: {},
    },
    runConfig: createRunConfig(),
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

function createRunConfig(): RunConfig {
  return {
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Workspace",
        rootRef: "workspace://test",
        trustState: "trusted",
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
    identity: {
      id: "identity-1",
      kind: "anonymous",
      displayName: "Test identity",
      metadata: {},
    },
    actionContext: null,
    permissions: createTestPermissionConfig(),
    toolBindings: createEmptyToolActionBindingSnapshot(),
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

function createApprovalBridge(): UserApprovalReviewBridge {
  return createUserApprovalReviewBridge({
    descriptor: {
      id: "reviewer-user",
      kind: "user",
      displayName: "User",
      source: "host-run-manager-test",
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
      category: "remoteToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run-1",
        actionId: "action-1",
        actionFingerprint: "sha256:action-1",
        environmentId: "local",
        applicabilityKeyCount: 0,
      },
      payload: {
        source: {
          kind: "mcp",
          sourceId: "mcp.server-1",
          displayName: "MCP Server",
          sourceRevision: "1",
          activationEpoch: 1,
          capabilityId: "read",
        },
        server: {
          serverId: "server-1",
          displayName: "Server",
          registrationFingerprint: "sha256:server-1",
          transport: "stdio",
          endpoint: null,
        },
        tool: {
          name: "read",
          displayName: "Read",
        },
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

function runInterruptionContext(cancellation: CancellationContext): InvocationInterruptionContext {
  return Object.freeze({
    signal: cancellation.signal,
    get interruption(): InvocationInterruptionRef | null {
      const request = cancellation.request;
      return request === null
        ? null
        : {
            kind: "run_cancellation",
            cancellation: { runId: request.runId, requestId: request.id },
          };
    },
  });
}

function createRunner(controller: Controller): Runner {
  return new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    createRunId: () => "run-1",
    now: () => now,
  });
}

function requireControllerContext(controller: DeferredController): ControllerCallContext {
  if (controller.lastContext === null) {
    throw new Error("Controller call context was not captured.");
  }
  return controller.lastContext;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
