import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { CompletionProposalRef } from "@agent-anything/verification/completion";

const MAX_TEXT_LENGTH = 8_192;

export interface RunStopReviewLimits {
  readonly maxRequiredFeedbackRounds: number;
  readonly maxAdvisoryFeedbackRounds: number;
}

export type RunStopReviewOwner =
  | "task_fulfillment"
  | "verification"
  | "plan";

export type RunStopCheckStatus = "passed" | "continue" | "wait" | "failed";

export interface RunStopCheck {
  readonly owner: RunStopReviewOwner;
  readonly severity: "required" | "advisory";
  readonly status: RunStopCheckStatus;
  readonly code: string;
  readonly message: string;
  readonly subjectId: string | null;
  readonly revision: string | null;
}

export interface RunStopLimitation {
  readonly owner: RunStopReviewOwner;
  readonly code: string;
  readonly message: string;
}

export interface RunStopReviewRef {
  readonly runId: string;
  readonly sequence: number;
}

export interface RunStopFeedback {
  readonly review: RunStopReviewRef;
  readonly owner: RunStopReviewOwner;
  readonly severity: "required" | "advisory";
  readonly round: number;
  readonly code: string;
  readonly message: string;
}

export type RunStopDecisionKind =
  | "allow_stop"
  | "continue_run"
  | "wait"
  | "failed";

export interface RunStopReviewRecord {
  readonly ref: RunStopReviewRef;
  readonly run: RunRef;
  readonly turn: ControllerTurnRef;
  readonly proposal: CompletionProposalRef;
  readonly decision: RunStopDecisionKind;
  readonly checks: readonly RunStopCheck[];
  readonly limitations: readonly RunStopLimitation[];
  readonly requiredFeedbackRounds: number;
  readonly advisoryFeedbackRounds: number;
  readonly reviewedAt: string;
}

export interface RunStopReviewState {
  readonly reviewSequence: number;
  readonly requiredFeedbackRounds: number;
  readonly advisoryFeedbackRounds: number;
  readonly latestReview: RunStopReviewRef | null;
  readonly limitations: readonly RunStopLimitation[];
}

export interface RunStopReviewProjection {
  readonly reviewSequence: number;
  readonly requiredFeedbackRounds: number;
  readonly advisoryFeedbackRounds: number;
  readonly latestReview: RunStopReviewRef | null;
  readonly limitations: readonly RunStopLimitation[];
}

export function createInitialRunStopReviewState(): RunStopReviewState {
  return Object.freeze({
    reviewSequence: 0,
    requiredFeedbackRounds: 0,
    advisoryFeedbackRounds: 0,
    latestReview: null,
    limitations: Object.freeze([]),
  });
}

export function assertRunStopReviewLimits(input: RunStopReviewLimits): void {
  nonNegative(input.maxRequiredFeedbackRounds, "RunStopReviewLimits.maxRequiredFeedbackRounds");
  nonNegative(input.maxAdvisoryFeedbackRounds, "RunStopReviewLimits.maxAdvisoryFeedbackRounds");
}

export function snapshotRunStopCheck(input: RunStopCheck): RunStopCheck {
  if (!["task_fulfillment", "verification", "plan"].includes(input.owner)) {
    throw new TypeError("RunStopCheck.owner is unsupported.");
  }
  if (input.severity !== "required" && input.severity !== "advisory") {
    throw new TypeError("RunStopCheck.severity is unsupported.");
  }
  if (!["passed", "continue", "wait", "failed"].includes(input.status)) {
    throw new TypeError("RunStopCheck.status is unsupported.");
  }
  return Object.freeze({
    owner: input.owner,
    severity: input.severity,
    status: input.status,
    code: token(input.code, "RunStopCheck.code"),
    message: text(input.message, "RunStopCheck.message"),
    subjectId: nullableToken(input.subjectId, "RunStopCheck.subjectId"),
    revision: nullableToken(input.revision, "RunStopCheck.revision"),
  });
}

export function snapshotRunStopFeedback(input: RunStopFeedback): RunStopFeedback {
  if (input.severity !== "required" && input.severity !== "advisory") {
    throw new TypeError("RunStopFeedback.severity is unsupported.");
  }
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw new TypeError("RunStopFeedback.round must be a positive safe integer.");
  }
  return Object.freeze({
    review: reviewRef(input.review, "RunStopFeedback.review"),
    owner: owner(input.owner, "RunStopFeedback.owner"),
    severity: input.severity,
    round: input.round,
    code: token(input.code, "RunStopFeedback.code"),
    message: text(input.message, "RunStopFeedback.message"),
  });
}

export function snapshotRunStopReviewRecord(
  input: RunStopReviewRecord,
): RunStopReviewRecord {
  if (!["allow_stop", "continue_run", "wait", "failed"].includes(input.decision)) {
    throw new TypeError("RunStopReviewRecord.decision is unsupported.");
  }
  nonNegative(input.requiredFeedbackRounds, "RunStopReviewRecord.requiredFeedbackRounds");
  nonNegative(input.advisoryFeedbackRounds, "RunStopReviewRecord.advisoryFeedbackRounds");
  return deepFreeze({
    ref: reviewRef(input.ref, "RunStopReviewRecord.ref"),
    run: Object.freeze({ id: token(input.run.id, "RunStopReviewRecord.run.id") }),
    turn: input.turn,
    proposal: Object.freeze({
      id: token(input.proposal.id, "RunStopReviewRecord.proposal.id"),
      revision: token(input.proposal.revision, "RunStopReviewRecord.proposal.revision"),
    }),
    decision: input.decision,
    checks: input.checks.map(snapshotRunStopCheck),
    limitations: input.limitations.map((limitation) => snapshotLimitation(limitation)),
    requiredFeedbackRounds: input.requiredFeedbackRounds,
    advisoryFeedbackRounds: input.advisoryFeedbackRounds,
    reviewedAt: iso(input.reviewedAt, "RunStopReviewRecord.reviewedAt"),
  });
}

export function projectRunStopReview(
  state: RunStopReviewState,
): RunStopReviewProjection {
  return deepFreeze({
    reviewSequence: state.reviewSequence,
    requiredFeedbackRounds: state.requiredFeedbackRounds,
    advisoryFeedbackRounds: state.advisoryFeedbackRounds,
    latestReview: state.latestReview,
    limitations: state.limitations,
  });
}

function snapshotLimitation(input: RunStopLimitation): RunStopLimitation {
  return Object.freeze({
    owner: owner(input.owner, "RunStopLimitation.owner"),
    code: token(input.code, "RunStopLimitation.code"),
    message: text(input.message, "RunStopLimitation.message"),
  });
}

function owner(value: unknown, field: string): RunStopReviewOwner {
  if (value !== "task_fulfillment" && value !== "verification" && value !== "plan") {
    throw new TypeError(`${field} is unsupported.`);
  }
  return value;
}

function reviewRef(value: RunStopReviewRef, field: string): RunStopReviewRef {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new TypeError(`${field}.sequence must be a positive safe integer.`);
  }
  return Object.freeze({
    runId: token(value.runId, `${field}.runId`),
    sequence: value.sequence,
  });
}

function nonNegative(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /\s/u.test(value)) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
  return value;
}

function nullableToken(value: unknown, field: string): string | null {
  return value === null ? null : token(value, field);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${field} must be bounded non-empty text.`);
  }
  return value;
}

function iso(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be an ISO date-time.`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
