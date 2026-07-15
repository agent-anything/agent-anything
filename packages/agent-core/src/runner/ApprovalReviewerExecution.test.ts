import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalReviewerPort,
  ApprovalReviewInput,
} from "@agent-anything/permission";
import { createSystemRetryExecutor } from "../retry/index.js";
import { createRunCancellationController } from "./RunCancellation.js";
import { executeApprovalReviewer } from "./ApprovalReviewerExecution.js";

describe("Approval reviewer execution", () => {
  it("treats user waiting as one pending operation rather than a Retry attempt", async () => {
    const events = vi.fn();
    const reviewer: ApprovalReviewerPort = {
      async review(input) {
        return {
          status: "decided",
          submission: {
            submissionId: "submission.1",
            runId: input.request.runId,
            requestId: input.request.id,
            pendingVersion: input.pendingVersion,
            optionId: "accept.action",
            grantedPermissions: null,
            reason: null,
          },
          rationale: null,
        };
      },
    };
    const result = await executeApprovalReviewer({
      reviewer: {
        bindingId: "binding.user",
        kind: "user",
        reviewer,
        descriptor: {
          id: "reviewer.user",
          kind: "user",
          displayName: "User",
          source: "test",
          metadata: {},
        },
        reviewTimeoutMs: null,
      },
      review: reviewInput(),
      operationId: "operation.review.1",
      startedAt: "2026-07-15T00:00:00.000Z",
      deadlineAt: "2026-07-15T00:01:00.000Z",
      retryPolicy: {
        maxRetries: 3,
        delay: {
          kind: "exponential_jitter",
          baseDelayMs: 0,
          maxDelayMs: 0,
          multiplier: 2,
          jitterRatio: 0.1,
        },
        retryableCategories: ["reviewer_failure"],
        serverDelay: { mode: "ignore" },
      },
      retryExecutor: createSystemRetryExecutor({
        now: () => new Date("2026-07-15T00:00:00.000Z"),
      }),
      cancellation: createRunCancellationController({ runId: "run.1" }).context,
      events: { emit: events },
      now: () => "2026-07-15T00:00:00.000Z",
    });

    expect(result.kind).toBe("decided");
    expect(events).not.toHaveBeenCalled();
  });
});

function reviewInput(): ApprovalReviewInput {
  return {
    request: {
      id: "request.1",
      runId: "run.1",
      actionId: "action.1",
      actionFingerprint: "fingerprint.1",
      category: "mcpToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run.1",
        actionId: "action.1",
        actionFingerprint: "fingerprint.1",
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
