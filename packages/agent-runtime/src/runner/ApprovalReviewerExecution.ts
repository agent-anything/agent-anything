import type {
  ApprovalReviewFailure,
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { RetryAttemptContext } from "@agent-anything/agent-core/retry";
import type { RetryEventSink } from "@agent-anything/agent-core/retry";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import type { RetryPolicy } from "@agent-anything/agent-core/retry";
import type { CancellationContext } from "@agent-anything/agent-core/run";
import type { ApprovalReviewerBinding } from "@agent-anything/agent-core/run";
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
  readonly reviewer: ApprovalReviewerBinding;
  readonly review: ApprovalReviewInput;
  readonly operationId: string;
  readonly startedAt: ISODateTimeString;
  readonly deadlineAt: ISODateTimeString;
  readonly retryPolicy: RetryPolicy<string>;
  readonly retryExecutor: RetryExecutor;
  readonly cancellation: CancellationContext;
  readonly events: RetryEventSink;
  readonly now: () => ISODateTimeString;
}

export function executeApprovalReviewer(
  input: ExecuteApprovalReviewerInput,
): Promise<ApprovalReviewerExecutionResult> {
  return input.reviewer.kind === "user"
    ? executeUserReviewer(input)
    : executeAutomaticReviewer(input);
}

async function executeUserReviewer(
  input: ExecuteApprovalReviewerInput,
): Promise<ApprovalReviewerExecutionResult> {
  const interruption = createUserReviewInterruption(input);
  try {
    const outcome = await executeApprovalReviewAttempt({
      reviewer: input.reviewer.reviewer,
      review: input.review,
      interruption: interruption.context,
    });
    return mapReviewOutcome(outcome);
  } finally {
    interruption.dispose();
  }
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

function mapReviewOutcome(
  outcome: ApprovalReviewOutcome,
): ApprovalReviewerExecutionResult {
  if (outcome.status === "decided") return { kind: "decided", outcome };
  if (outcome.status === "failed") return { kind: "failed", failure: outcome.failure };
  return outcome.interruption.kind === "run_cancellation"
    ? { kind: "cancelled" }
    : { kind: "failed", failure: reviewFailure(
        "approval_review_timeout",
        "Approval review exceeded its deadline.",
        false,
      ) };
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

function createUserReviewInterruption(input: ExecuteApprovalReviewerInput): {
  readonly context: InvocationInterruptionContext;
  dispose(): void;
} {
  const controller = new AbortController();
  let interruption: InvocationInterruptionRef | null = null;
  const abortFromCancellation = (): void => {
    const request = input.cancellation.request;
    if (request === null || interruption !== null) return;
    interruption = Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({ runId: request.runId, requestId: request.id }),
    });
    controller.abort(interruption);
  };
  input.cancellation.signal.addEventListener("abort", abortFromCancellation, { once: true });
  const delayMs = Math.max(0, Date.parse(input.deadlineAt) - Date.parse(input.now()));
  const timer = setTimeout(() => {
    if (interruption !== null) return;
    interruption = Object.freeze({
      kind: "operation_deadline" as const,
      deadline: Object.freeze({
        operationId: input.operationId,
        deadlineAt: input.deadlineAt,
      }),
    });
    controller.abort(interruption);
  }, delayMs);
  if (input.cancellation.signal.aborted) abortFromCancellation();

  return Object.freeze({
    context: Object.freeze({
      signal: controller.signal,
      get interruption() {
        return interruption;
      },
    }),
    dispose() {
      clearTimeout(timer);
      input.cancellation.signal.removeEventListener("abort", abortFromCancellation);
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
