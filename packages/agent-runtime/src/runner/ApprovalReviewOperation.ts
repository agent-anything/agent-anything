import {
  snapshotApprovalDecisionSubmission,
  snapshotApprovalInterruption,
  snapshotApprovalReviewFailure,
  snapshotApprovalReviewInput,
  type ApprovalReviewerPort,
  type ApprovalReviewFailure,
  type ApprovalReviewInput,
  type ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import type { RetryDeadlineExceeded } from "@agent-anything/agent-core/retry";
import type { RetryClassification, RetryClassifier } from "@agent-anything/agent-core/retry";

export type ApprovalReviewRetryCategory =
  | "reviewer_unavailable"
  | "reviewer_failure"
  | "reviewer_malformed"
  | "reviewer_timeout";

export interface ApprovalReviewAttemptError {
  readonly failure: ApprovalReviewFailure;
  readonly deadlineReason: RetryDeadlineExceeded | null;
}

export interface ExecuteApprovalReviewAttemptInput {
  readonly reviewer: ApprovalReviewerPort;
  readonly review: ApprovalReviewInput;
  readonly interruption: InvocationInterruptionContext;
}

export const approvalReviewRetryClassifier: RetryClassifier<
  ApprovalReviewAttemptError,
  ApprovalReviewRetryCategory
> = Object.freeze({
  classify(
    error: ApprovalReviewAttemptError,
  ): RetryClassification<ApprovalReviewRetryCategory> {
    const failure = snapshotApprovalReviewFailure(error.failure);
    const category = retryCategory(failure.code);
    return Object.freeze({
      failure: Object.freeze({
        category,
        code: failure.code,
        message: failure.message,
      }),
      disposition: error.deadlineReason !== null
        ? "deadline_exceeded"
        : failure.retryable
          ? "retryable"
          : "non_retryable",
      reasonCode: failure.code,
    });
  },
});

export async function executeApprovalReviewAttempt(
  input: ExecuteApprovalReviewAttemptInput,
): Promise<ApprovalReviewOutcome> {
  if (!input.reviewer || typeof input.reviewer.review !== "function") {
    throw new TypeError("Approval review attempt requires a reviewer port.");
  }
  const review = snapshotApprovalReviewInput(input.review);
  let candidate: unknown;
  try {
    candidate = await input.reviewer.review(review, input.interruption);
  } catch {
    const interrupted = exactActiveInterruption(input.interruption);
    return interrupted === null
      ? failed("approval_review_failed", "Approval reviewer call failed.", true)
      : Object.freeze({ status: "interrupted", interruption: interrupted });
  }
  return normalizeApprovalReviewOutcome(candidate, review, input.interruption);
}

export function normalizeApprovalReviewOutcome(
  candidate: unknown,
  expected: ApprovalReviewInput,
  interruption: InvocationInterruptionContext,
): ApprovalReviewOutcome {
  try {
    if (!isRecord(candidate)) return malformed();
    if (candidate.status === "decided") {
      const submission = snapshotApprovalDecisionSubmission(
        candidate.submission as Parameters<typeof snapshotApprovalDecisionSubmission>[0],
      );
      if (
        submission.runId !== expected.request.runId ||
        submission.requestId !== expected.request.id ||
        submission.pendingVersion !== expected.pendingVersion ||
        (candidate.rationale !== null && typeof candidate.rationale !== "string")
      ) {
        return malformed();
      }
      return Object.freeze({
        status: "decided",
        submission,
        rationale: candidate.rationale,
      });
    }
    if (candidate.status === "failed") {
      return Object.freeze({
        status: "failed",
        failure: snapshotApprovalReviewFailure(
          candidate.failure as ApprovalReviewFailure,
        ),
      });
    }
    if (candidate.status === "interrupted") {
      const actual = snapshotApprovalInterruption(
        candidate.interruption as Parameters<typeof snapshotApprovalInterruption>[0],
      );
      const expectedInterruption = exactActiveInterruption(interruption);
      return expectedInterruption !== null && sameInterruption(actual, expectedInterruption)
        ? Object.freeze({ status: "interrupted", interruption: actual })
        : malformed();
    }
    return malformed();
  } catch {
    return malformed();
  }
}

function exactActiveInterruption(
  context: InvocationInterruptionContext,
): ReturnType<typeof snapshotApprovalInterruption> | null {
  if (!context.signal.aborted || context.interruption === null) return null;
  try {
    return snapshotApprovalInterruption(context.interruption);
  } catch {
    return null;
  }
}

function sameInterruption(
  left: ReturnType<typeof snapshotApprovalInterruption>,
  right: ReturnType<typeof snapshotApprovalInterruption>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "run_cancellation" && right.kind === "run_cancellation") {
    return left.cancellation.runId === right.cancellation.runId &&
      left.cancellation.requestId === right.cancellation.requestId;
  }
  if (left.kind === "operation_deadline" && right.kind === "operation_deadline") {
    return left.deadline.operationId === right.deadline.operationId &&
      left.deadline.deadlineAt === right.deadline.deadlineAt;
  }
  return false;
}

function retryCategory(
  code: ApprovalReviewFailure["code"],
): ApprovalReviewRetryCategory {
  switch (code) {
    case "approval_reviewer_unavailable":
      return "reviewer_unavailable";
    case "approval_review_timeout":
      return "reviewer_timeout";
    case "approval_review_malformed":
      return "reviewer_malformed";
    case "approval_review_failed":
    case "approval_review_retry_exhausted":
      return "reviewer_failure";
  }
}

function malformed(): ApprovalReviewOutcome {
  return failed(
    "approval_review_malformed",
    "Approval reviewer returned a malformed or miscorrelated outcome.",
    true,
  );
}

function failed(
  code: ApprovalReviewFailure["code"],
  message: string,
  retryable: boolean,
): ApprovalReviewOutcome {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      code,
      message,
      retryable,
      metadata: Object.freeze({}),
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
