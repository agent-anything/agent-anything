import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalReviewerPort,
  ApprovalReviewInput,
} from "@agent-anything/permission";
import { createSystemRetryExecutor } from "../retry/index.js";
import { createRunCancellationController } from "../run/index.js";
import { executeApprovalReviewer } from "./ApprovalReviewerExecution.js";

describe("Approval reviewer execution", () => {
  it("runs an automatic reviewer through the retry operation", async () => {
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
        bindingId: "binding.auto",
        kind: "auto_review",
        reviewer,
        descriptor: {
          id: "reviewer.auto",
          kind: "auto_review",
          displayName: "Automatic reviewer",
          source: "test",
          metadata: {},
        },
        reviewTimeoutMs: 60_000,
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
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls.map(([event]) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
  });
});

function reviewInput(): ApprovalReviewInput {
  return {
    request: {
      id: "request.1",
      runId: "run.1",
      actionId: "action.1",
      actionFingerprint: "fingerprint.1",
      category: "remoteToolCall",
      reason: "Review MCP call.",
      subject: {
        runId: "run.1",
        actionId: "action.1",
        actionFingerprint: "fingerprint.1",
        environmentId: "local",
        applicabilityKeyCount: 0,
      },
      payload: {
        source: {
          kind: "mcp",
          sourceId: "mcp.server.1",
          displayName: "MCP Server",
          sourceRevision: "1",
          activationEpoch: 1,
          capabilityId: "read",
        },
        server: {
          serverId: "server.1",
          displayName: "Server",
          registrationFingerprint: "sha256:server.1",
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
