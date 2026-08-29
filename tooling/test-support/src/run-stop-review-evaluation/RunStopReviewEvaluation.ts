import {
  assertRunStopReviewLimits,
  createInitialRunStopReviewState,
  snapshotRunStopFeedback,
  snapshotRunStopReviewRecord,
} from "@agent-anything/agent-runtime/stop";

const NOW = "2026-08-29T00:00:00.000Z";

export interface RunStopReviewEvaluationReport {
  readonly revision: "run-stop-review-deterministic-evaluation-v1";
  readonly requiredFeedbackRounds: number;
  readonly advisoryFeedbackRounds: number;
  readonly requiredExhaustionCode: "runtime_stop_feedback_exhausted";
  readonly advisoryExhaustionAllowsStop: true;
  readonly exactActivityKinds: readonly ["stop_review", "stop_feedback", "stop_review"];
}

export function runRunStopReviewDeterministicEvaluation(): RunStopReviewEvaluationReport {
  const limits = Object.freeze({
    maxRequiredFeedbackRounds: 2,
    maxAdvisoryFeedbackRounds: 1,
  });
  assertRunStopReviewLimits(limits);
  const initial = createInitialRunStopReviewState();
  const review = snapshotRunStopReviewRecord({
    ref: { runId: "run-stop-review-evaluation", sequence: 1 },
    run: { id: "run-stop-review-evaluation" },
    turn: {
      run: { id: "run-stop-review-evaluation" },
      id: "turn-1",
      sequence: 1,
    },
    proposal: { id: "proposal-1", revision: "1" },
    decision: "continue_run",
    checks: [{
      owner: "task_fulfillment",
      severity: "required",
      status: "continue",
      code: "task_fulfillment_incomplete",
      message: "Continue the Run before proposing completion again.",
      subjectId: "assessment-1",
      revision: "1",
    }],
    limitations: [],
    requiredFeedbackRounds: 1,
    advisoryFeedbackRounds: 0,
    reviewedAt: NOW,
  });
  const feedback = snapshotRunStopFeedback({
    review: review.ref,
    owner: "task_fulfillment",
    severity: "required",
    round: 1,
    code: "task_fulfillment_incomplete",
    message: "Continue the Run before proposing completion again.",
  });
  if (
    initial.reviewSequence !== 0 ||
    review.decision !== "continue_run" ||
    feedback.round !== 1
  ) {
    throw new TypeError("Stop Review deterministic contract probe failed.");
  }
  return deepFreeze({
    revision: "run-stop-review-deterministic-evaluation-v1" as const,
    requiredFeedbackRounds: limits.maxRequiredFeedbackRounds,
    advisoryFeedbackRounds: limits.maxAdvisoryFeedbackRounds,
    requiredExhaustionCode: "runtime_stop_feedback_exhausted" as const,
    advisoryExhaustionAllowsStop: true as const,
    exactActivityKinds: ["stop_review", "stop_feedback", "stop_review"] as const,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
