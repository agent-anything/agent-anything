import type {
  ApprovalDecisionSubmission,
  ApprovalReviewInput,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import {
  createUserApprovalReviewBridge,
  type UserApprovalNotificationFailure,
} from "./UserApprovalReviewBridge.js";

describe("UserApprovalReviewBridge", () => {
  it("keeps one immutable pending projection and accepts one submission", async () => {
    const bridge = createBridge();
    const source = reviewInput();
    const pending = bridge.review(source, interruptionContext());

    const firstProjection = bridge.getPendingProjection();
    expect(firstProjection).toEqual(source);
    expect(firstProjection).not.toBe(source);
    expect(bridge.getPendingProjection()).toBe(firstProjection);
    expect(Object.isFrozen(firstProjection?.request)).toBe(true);

    const receipt = bridge.submitDecision(submission());
    expect(receipt).toEqual({
      status: "accepted_for_resolution",
      submissionId: "submission.1",
      runId: "run.1",
      requestId: "request.1",
      pendingVersion: 1,
    });
    await expect(pending).resolves.toMatchObject({
      status: "decided",
      submission: { optionId: "accept.action" },
    });
    expect(bridge.getPendingProjection()).toBeNull();

    expect(bridge.submitDecision(submission())).toBe(receipt);
    expect(bridge.submitDecision(submission({ optionId: "decline" }))).toEqual({
      status: "rejected",
      submissionId: "submission.1",
      code: "approval_submission_invalid",
    });
    expect(bridge.submitDecision(submission({ submissionId: "submission.2" })))
      .toMatchObject({ code: "approval_already_resolved" });
  });

  it("rejects wrong correlation, stale versions, and concurrent reviews", async () => {
    const bridge = createBridge();
    const first = bridge.review(reviewInput(), interruptionContext());
    await expect(bridge.review(reviewInput({ requestId: "request.2" }), interruptionContext()))
      .resolves.toMatchObject({
        status: "failed",
        failure: { code: "approval_reviewer_unavailable" },
      });

    expect(bridge.submitDecision(submission({ runId: "run.other" })))
      .toMatchObject({ code: "approval_not_pending" });
    expect(bridge.submitDecision(submission({ requestId: "request.other" })))
      .toMatchObject({ code: "approval_not_pending" });
    expect(bridge.submitDecision(submission({ pendingVersion: 2 })))
      .toMatchObject({ code: "approval_version_mismatch" });

    bridge.submitDecision(submission());
    await first;
  });

  it("cleans up on interruption and rejects late submissions", async () => {
    const bridge = createBridge();
    const interruption = controllableInterruption();
    const pending = bridge.review(reviewInput(), interruption.context);
    interruption.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run.1", requestId: "cancel.1" },
    });

    await expect(pending).resolves.toEqual({
      status: "interrupted",
      interruption: {
        kind: "run_cancellation",
        cancellation: { runId: "run.1", requestId: "cancel.1" },
      },
    });
    expect(bridge.getPendingProjection()).toBeNull();
    expect(bridge.submitDecision(submission({ submissionId: "late.1" })))
      .toMatchObject({ code: "approval_already_resolved" });
  });

  it("uses the shared operation deadline interruption without a Host timer", async () => {
    const bridge = createBridge();
    const interruption = controllableInterruption();
    const pending = bridge.review(reviewInput(), interruption.context);
    interruption.abort({
      kind: "operation_deadline",
      deadline: {
        operationId: "review.operation.1",
        deadlineAt: "2026-07-15T00:01:00.000Z",
      },
    });

    await expect(pending).resolves.toMatchObject({
      status: "interrupted",
      interruption: { kind: "operation_deadline" },
    });
    expect(bridge.getPendingProjection()).toBeNull();
  });

  it("isolates notification failure from the canonical pending Promise", async () => {
    const failures: UserApprovalNotificationFailure[] = [];
    const bridge = createBridge({
      async onProjectionChanged() {
        throw new Error("renderer unavailable");
      },
      onNotificationFailure(failure) {
        failures.push(failure);
      },
    });
    const pending = bridge.review(reviewInput(), interruptionContext());
    await flushMicrotasks();

    expect(bridge.getPendingProjection()?.request.id).toBe("request.1");
    expect(failures).toEqual([expect.objectContaining({
      code: "approval_notification_failed",
      phase: "pending",
      requestId: "request.1",
    })]);

    bridge.submitDecision(submission());
    await pending;
  });
});

function createBridge(overrides: Record<string, unknown> = {}) {
  return createUserApprovalReviewBridge({
    runId: "run.1",
    descriptor: {
      id: "reviewer.user",
      kind: "user",
      displayName: "User",
      source: "host",
      metadata: {},
    },
    ...overrides,
  });
}

function submission(
  overrides: Partial<ApprovalDecisionSubmission> = {},
): ApprovalDecisionSubmission {
  return {
    submissionId: "submission.1",
    runId: "run.1",
    requestId: "request.1",
    pendingVersion: 1,
    optionId: "accept.action",
    grantedPermissions: null,
    reason: null,
    ...overrides,
  };
}

function reviewInput(
  overrides: { requestId?: string; pendingVersion?: number } = {},
): ApprovalReviewInput {
  const requestId = overrides.requestId ?? "request.1";
  return {
    request: {
      id: requestId,
      runId: "run.1",
      actionId: "action.1",
      actionFingerprint: "sha256:action.1",
      category: "mcpToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run.1",
        actionId: "action.1",
        actionFingerprint: "sha256:action.1",
        environmentId: "local",
        applicabilityKeyCount: 0,
      },
      payload: {
        serverId: "server.1",
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
        id: "accept.action",
        kind: "accept",
        scope: "action",
        label: "Accept",
        description: null,
      }],
      createdAt: "2026-07-15T00:00:00.000Z",
      deadlineAt: "2026-07-15T00:01:00.000Z",
    },
    pendingVersion: overrides.pendingVersion ?? 1,
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

function interruptionContext(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

function controllableInterruption() {
  const controller = new AbortController();
  let current: InvocationInterruptionRef | null = null;
  return {
    context: Object.freeze({
      signal: controller.signal,
      get interruption() {
        return current;
      },
    }),
    abort(interruption: InvocationInterruptionRef) {
      current = interruption;
      controller.abort();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
