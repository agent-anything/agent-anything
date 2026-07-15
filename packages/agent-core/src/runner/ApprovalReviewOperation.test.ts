import { FakeApprovalReviewer } from "@agent-anything/testing";
import type {
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import {
  approvalReviewRetryClassifier,
  executeApprovalReviewAttempt,
} from "./ApprovalReviewOperation.js";

describe("approval reviewer operation", () => {
  it("normalizes thrown calls and miscorrelated decided outcomes", async () => {
    const thrown = reviewer(() => {
      throw new Error("secret provider detail");
    });
    await expect(executeApprovalReviewAttempt({
      reviewer: thrown,
      review: reviewInput(),
      interruption: interruptionContext(),
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "approval_review_failed",
        message: "Approval reviewer call failed.",
      },
    });

    const miscorrelated = reviewer(() => decided({ runId: "run.other" }));
    await expect(executeApprovalReviewAttempt({
      reviewer: miscorrelated,
      review: reviewInput(),
      interruption: interruptionContext(),
    })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "approval_review_malformed" },
    });
  });

  it("accepts only the exact active interruption", async () => {
    const ref: InvocationInterruptionRef = {
      kind: "run_cancellation",
      cancellation: { runId: "run.1", requestId: "cancel.1" },
    };
    const context = interruptionContext(ref);
    const automatic = reviewer((_input, callContext) => ({
      status: "interrupted",
      interruption: callContext.interruption!,
    }));

    await expect(executeApprovalReviewAttempt({
      reviewer: automatic,
      review: reviewInput(),
      interruption: context,
    })).resolves.toEqual({ status: "interrupted", interruption: ref });
  });

  it("classifies normalized failures for the shared Retry executor", () => {
    expect(approvalReviewRetryClassifier.classify({
      failure: {
        code: "approval_reviewer_unavailable",
        message: "Unavailable",
        retryable: true,
        metadata: {},
      },
      deadlineReason: null,
    })).toMatchObject({
      disposition: "retryable",
      failure: { category: "reviewer_unavailable" },
    });

    expect(approvalReviewRetryClassifier.classify({
      failure: {
        code: "approval_review_timeout",
        message: "Deadline",
        retryable: false,
        metadata: {},
      },
      deadlineReason: {
        kind: "retry_deadline_exceeded",
        operationId: "review.operation.1",
        deadlineAt: "2026-07-15T00:01:00.000Z",
      },
    })).toMatchObject({
      disposition: "deadline_exceeded",
      failure: { category: "reviewer_timeout" },
    });
  });
});

function reviewer(
  handler: ConstructorParameters<typeof FakeApprovalReviewer>[0]["handler"],
): FakeApprovalReviewer {
  return new FakeApprovalReviewer({
    descriptor: {
      id: "reviewer.auto",
      kind: "auto_review",
      displayName: "Automatic reviewer",
      source: "test",
      metadata: {},
    },
    handler,
  });
}

function decided(
  overrides: Partial<{ runId: string; requestId: string; pendingVersion: number }> = {},
): ApprovalReviewOutcome {
  return {
    status: "decided",
    submission: {
      submissionId: "submission.1",
      runId: overrides.runId ?? "run.1",
      requestId: overrides.requestId ?? "request.1",
      pendingVersion: overrides.pendingVersion ?? 1,
      optionId: "accept.action",
      grantedPermissions: null,
      reason: null,
    },
    rationale: null,
  };
}

function interruptionContext(
  interruption: InvocationInterruptionRef | null = null,
): InvocationInterruptionContext {
  const controller = new AbortController();
  if (interruption !== null) controller.abort();
  return Object.freeze({ signal: controller.signal, interruption });
}

function reviewInput(): ApprovalReviewInput {
  return {
    request: {
      id: "request.1",
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
