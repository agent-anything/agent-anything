import type {
  ApprovalReviewFailure,
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/control";
import type { RetryAttemptContext } from "../retry/index.js";
import type { RetryEventSink } from "../retry/index.js";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import type { RetryPolicy } from "../retry/index.js";
import type { CancellationContext } from "../run/index.js";
import type { ApprovalReviewerBinding } from "../run/index.js";
import {
  approvalReviewRetryClassifier,
  executeApprovalReviewAttempt,
  type ApprovalReviewAttemptError,
} from "./ApprovalReviewOperation.js";

export type ApprovalReviewerExecutionResult =
  | {
      readonly kind: "decided";
      readonly outcome: Extract<ApprovalReviewOutcome, { readonly status: "decided" }>;
    }
  | { readonly kind: "failed"; readonly failure: ApprovalReviewFailure }
  | { readonly kind: "cancelled" };

export interface ExecuteApprovalReviewerInput {
  readonly reviewer: Extract<ApprovalReviewerBinding, { readonly kind: "auto_review" }>;
  readonly review: ApprovalReviewInput;
  readonly operationId: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly retryPolicy: RetryPolicy<string>;
  readonly retryExecutor: RetryExecutor;
  readonly cancellation: CancellationContext;
  readonly events: RetryEventSink;
  readonly now: () => string;
}

export function executeApprovalReviewer(
  input: ExecuteApprovalReviewerInput,
): Promise<ApprovalReviewerExecutionResult> {
  return executeAutomaticReviewer(input);
}

async function executeAutomaticReviewer(
  input: ExecuteApprovalReviewerInput,
): Promise<ApprovalReviewerExecutionResult> {
  const result = await input.retryExecutor.execute<
    Extract<ApprovalReviewOutcome, { readonly status: "decided" }>,
    ApprovalReviewAttemptError,
    string
  >({
    operation: {
      operationId: input.operationId,
      owner: "approvals_reviewer",
      runId: input.review.request.runId,
      subject: {
        kind: "approval_review",
        approvalRequestId: input.review.request.id,
      },
      startedAt: input.startedAt,
      deadlineAt: input.deadlineAt,
    },
    budgetId: `${input.operationId}:primary`,
    priorProgress: { completedAttempts: 0, totalRetryDelayMs: 0 },
    policy: input.retryPolicy,
    classifier: approvalReviewRetryClassifier,
    cancellation: input.cancellation,
    events: input.events,
  }, async (attempt) => {
    const outcome = await executeApprovalReviewAttempt({
      reviewer: input.reviewer.reviewer,
      review: input.review,
      interruption: retryInterruptionContext(attempt),
    });
    if (outcome.status === "decided") {
      return { kind: "succeeded" as const, value: outcome };
    }
    if (outcome.status === "failed") {
      return {
        kind: "failed" as const,
        error: { failure: outcome.failure, deadlineReason: attempt.deadlineReason },
      };
    }
    if (outcome.interruption.kind === "run_cancellation") {
      const request = input.cancellation.request;
      if (
        request !== null &&
        request.id === outcome.interruption.cancellation.requestId
      ) {
        return {
          kind: "cancelled" as const,
          attribution: {
            requestId: request.id,
            runId: request.runId,
            operation: "approval_reviewer" as const,
            observedAt: input.now(),
          },
        };
      }
    }
    return {
      kind: "failed" as const,
      error: {
        failure: reviewFailure(
          attempt.deadlineReason === null
            ? "approval_review_malformed"
            : "approval_review_timeout",
          attempt.deadlineReason === null
            ? "Approval reviewer returned an unattributed interruption."
            : "Approval review exceeded its deadline.",
          false,
        ),
        deadlineReason: attempt.deadlineReason,
      },
    };
  });

  switch (result.kind) {
    case "succeeded":
      return { kind: "decided", outcome: result.value };
    case "failed":
      return { kind: "failed", failure: result.error.failure };
    case "cancelled":
      return { kind: "cancelled" };
    case "budget_exhausted":
      return { kind: "failed", failure: reviewFailure(
        "approval_review_retry_exhausted",
        "Approval reviewer Retry budget was exhausted.",
        false,
      ) };
    case "deadline_exhausted":
      return { kind: "failed", failure: reviewFailure(
        "approval_review_timeout",
        "Approval review exceeded its deadline.",
        false,
      ) };
  }
}

function retryInterruptionContext(
  attempt: RetryAttemptContext,
): InvocationInterruptionContext {
  return Object.freeze({
    signal: attempt.signal,
    get interruption(): InvocationInterruptionRef | null {
      if (attempt.deadlineReason !== null) {
        return Object.freeze({
          kind: "operation_deadline" as const,
          deadline: Object.freeze({
            operationId: attempt.deadlineReason.operationId,
            deadlineAt: attempt.deadlineReason.deadlineAt,
          }),
        });
      }
      const request = attempt.cancellation.request;
      return request === null || !attempt.cancellation.signal.aborted
        ? null
        : Object.freeze({
            kind: "run_cancellation" as const,
            cancellation: Object.freeze({
              runId: request.runId,
              requestId: request.id,
            }),
          });
    },
  });
}

function reviewFailure(
  code: ApprovalReviewFailure["code"],
  message: string,
  retryable: boolean,
): ApprovalReviewFailure {
  return Object.freeze({
    code,
    message,
    retryable,
    metadata: Object.freeze({}),
  });
}
