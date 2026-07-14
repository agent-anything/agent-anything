import type { ISODateTimeString } from "@agent-anything/shared";
import type { CancellationAttribution } from "../runner/RunCancellation.js";
import type { RetryDelay } from "./RetryFailure.js";
import type { RetryExhausted } from "./RetryExecution.js";
import type { RetryOwner } from "./RetryOperation.js";

export type RetryEvent =
  | RetryScheduledEvent
  | RetryAttemptStartedEvent
  | RetryAttemptFinishedEvent
  | RetryFallbackSelectedEvent
  | RetryExhaustedEvent
  | RetryCancelledEvent;

export interface RetryEventBase {
  readonly runId: string;
  readonly operationId: string;
  readonly owner: RetryOwner;
  readonly occurredAt: ISODateTimeString;
}

export interface RetryScheduledEvent extends RetryEventBase {
  readonly type: "retry_scheduled";
  readonly afterAttemptId: string;
  readonly budgetId: string;
  readonly retryNumber: number;
  readonly nextAttemptNumber: number;
  readonly nextBudgetAttemptNumber: number;
  readonly delayMs: number;
  readonly delaySource: RetryDelay["source"];
  readonly nextAttemptAt: ISODateTimeString;
  readonly failureCategory: string;
  readonly failureCode: string;
}

export interface RetryAttemptStartedEvent extends RetryEventBase {
  readonly type: "retry_attempt_started";
  readonly attemptId: string;
  readonly budgetId: string;
  readonly attemptNumber: number;
  readonly budgetAttemptNumber: number;
  readonly maxBudgetAttempts: number;
}

export interface RetryAttemptFinishedEvent extends RetryEventBase {
  readonly type: "retry_attempt_finished";
  readonly attemptId: string;
  readonly budgetId: string;
  readonly attemptNumber: number;
  readonly budgetAttemptNumber: number;
  readonly durationMs: number;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly failureCategory?: string;
  readonly failureCode?: string;
  readonly next:
    | "retry_scheduled"
    | "budget_exhausted"
    | "deadline_exhausted"
    | "return_to_owner"
    | "cancelled";
}

export interface RetryFallbackSelectedEvent extends RetryEventBase {
  readonly type: "retry_fallback_selected";
  readonly fromLegId: string;
  readonly toLegId: string;
  readonly fromBudgetId: string;
  readonly toBudgetId: string;
  readonly fromTransport: string;
  readonly toTransport: string;
  readonly fallbackNumber: number;
  readonly reasonCode: string;
  readonly nextAttemptNumber: number;
}

export interface RetryExhaustedEvent extends RetryEventBase {
  readonly type: "retry_exhausted";
  readonly finalBudgetId: string;
  readonly reason: RetryExhausted["reason"];
  readonly totalAttempts: number;
  readonly totalRetryDelayMs: number;
  readonly lastFailureCategory: string | null;
  readonly lastFailureCode: string | null;
}

export interface RetryCancelledEvent extends RetryEventBase {
  readonly type: "retry_cancelled";
  readonly phase: "before_attempt" | "attempt" | "backoff";
  readonly budgetId: string;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly attribution: CancellationAttribution;
}

export interface RetryEventSink {
  emit(event: RetryEvent): void | Promise<void>;
}

export function snapshotRetryEvent(event: RetryEvent, runId: string): RetryEvent {
  if (!isRecord(event)) {
    throw new TypeError("RetryEvent must be an object.");
  }
  assertNonEmpty(event.runId, "RetryEvent.runId");
  if (event.runId !== runId) {
    throw new TypeError("RetryEvent.runId must match the active Run.");
  }
  assertNonEmpty(event.operationId, "RetryEvent.operationId");
  assertOwner(event.owner);
  assertDateTime(event.occurredAt, "RetryEvent.occurredAt");
  const base = {
    runId: event.runId,
    operationId: event.operationId,
    owner: event.owner,
    occurredAt: event.occurredAt,
  } as const;

  switch (event.type) {
    case "retry_attempt_started":
      assertNonEmpty(event.attemptId, "RetryEvent.attemptId");
      assertNonEmpty(event.budgetId, "RetryEvent.budgetId");
      assertPositiveInteger(event.attemptNumber, "RetryEvent.attemptNumber");
      assertPositiveInteger(event.budgetAttemptNumber, "RetryEvent.budgetAttemptNumber");
      assertPositiveInteger(event.maxBudgetAttempts, "RetryEvent.maxBudgetAttempts");
      return Object.freeze({
        ...base,
        type: event.type,
        attemptId: event.attemptId,
        budgetId: event.budgetId,
        attemptNumber: event.attemptNumber,
        budgetAttemptNumber: event.budgetAttemptNumber,
        maxBudgetAttempts: event.maxBudgetAttempts,
      });
    case "retry_attempt_finished":
      assertNonEmpty(event.attemptId, "RetryEvent.attemptId");
      assertNonEmpty(event.budgetId, "RetryEvent.budgetId");
      assertPositiveInteger(event.attemptNumber, "RetryEvent.attemptNumber");
      assertPositiveInteger(event.budgetAttemptNumber, "RetryEvent.budgetAttemptNumber");
      assertNonNegativeInteger(event.durationMs, "RetryEvent.durationMs");
      if (!["succeeded", "failed", "cancelled"].includes(event.outcome)) {
        throw new TypeError("RetryEvent.outcome is unsupported.");
      }
      if (![
        "retry_scheduled",
        "budget_exhausted",
        "deadline_exhausted",
        "return_to_owner",
        "cancelled",
      ].includes(event.next)) {
        throw new TypeError("RetryEvent.next is unsupported.");
      }
      if (event.failureCategory !== undefined) {
        assertNonEmpty(event.failureCategory, "RetryEvent.failureCategory");
      }
      if (event.failureCode !== undefined) {
        assertNonEmpty(event.failureCode, "RetryEvent.failureCode");
      }
      return Object.freeze({
        ...base,
        type: event.type,
        attemptId: event.attemptId,
        budgetId: event.budgetId,
        attemptNumber: event.attemptNumber,
        budgetAttemptNumber: event.budgetAttemptNumber,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.failureCategory === undefined
          ? {}
          : { failureCategory: event.failureCategory }),
        ...(event.failureCode === undefined ? {} : { failureCode: event.failureCode }),
        next: event.next,
      });
    case "retry_scheduled":
      assertNonEmpty(event.afterAttemptId, "RetryEvent.afterAttemptId");
      assertNonEmpty(event.budgetId, "RetryEvent.budgetId");
      assertPositiveInteger(event.retryNumber, "RetryEvent.retryNumber");
      assertPositiveInteger(event.nextAttemptNumber, "RetryEvent.nextAttemptNumber");
      assertPositiveInteger(
        event.nextBudgetAttemptNumber,
        "RetryEvent.nextBudgetAttemptNumber",
      );
      assertNonNegativeInteger(event.delayMs, "RetryEvent.delayMs");
      if (
        event.delaySource !== "calculated_backoff" &&
        event.delaySource !== "trusted_server_delay"
      ) {
        throw new TypeError("RetryEvent.delaySource is unsupported.");
      }
      assertDateTime(event.nextAttemptAt, "RetryEvent.nextAttemptAt");
      assertNonEmpty(event.failureCategory, "RetryEvent.failureCategory");
      assertNonEmpty(event.failureCode, "RetryEvent.failureCode");
      return Object.freeze({
        ...base,
        type: event.type,
        afterAttemptId: event.afterAttemptId,
        budgetId: event.budgetId,
        retryNumber: event.retryNumber,
        nextAttemptNumber: event.nextAttemptNumber,
        nextBudgetAttemptNumber: event.nextBudgetAttemptNumber,
        delayMs: event.delayMs,
        delaySource: event.delaySource,
        nextAttemptAt: event.nextAttemptAt,
        failureCategory: event.failureCategory,
        failureCode: event.failureCode,
      });
    case "retry_exhausted":
      assertNonEmpty(event.finalBudgetId, "RetryEvent.finalBudgetId");
      if (
        event.reason !== "retry_budget_exhausted" &&
        event.reason !== "deadline_exceeded"
      ) {
        throw new TypeError("RetryEvent.reason is unsupported.");
      }
      assertNonNegativeInteger(event.totalAttempts, "RetryEvent.totalAttempts");
      assertNonNegativeInteger(event.totalRetryDelayMs, "RetryEvent.totalRetryDelayMs");
      assertNullableText(event.lastFailureCategory, "RetryEvent.lastFailureCategory");
      assertNullableText(event.lastFailureCode, "RetryEvent.lastFailureCode");
      return Object.freeze({
        ...base,
        type: event.type,
        finalBudgetId: event.finalBudgetId,
        reason: event.reason,
        totalAttempts: event.totalAttempts,
        totalRetryDelayMs: event.totalRetryDelayMs,
        lastFailureCategory: event.lastFailureCategory,
        lastFailureCode: event.lastFailureCode,
      });
    case "retry_cancelled":
      if (!["before_attempt", "attempt", "backoff"].includes(event.phase)) {
        throw new TypeError("RetryEvent.phase is unsupported.");
      }
      assertNonEmpty(event.budgetId, "RetryEvent.budgetId");
      assertNullableText(event.attemptId, "RetryEvent.attemptId");
      if (event.attemptNumber !== null) {
        assertPositiveInteger(event.attemptNumber, "RetryEvent.attemptNumber");
      }
      if (
        (event.phase === "attempt" &&
          (event.attemptId === null || event.attemptNumber === null)) ||
        (event.phase !== "attempt" &&
          (event.attemptId !== null || event.attemptNumber !== null))
      ) {
        throw new TypeError("RetryEvent cancellation phase and attempt correlation disagree.");
      }
      assertNonEmpty(event.attribution.requestId, "RetryEvent.attribution.requestId");
      if (event.attribution.runId !== runId) {
        throw new TypeError("RetryEvent cancellation attribution has a mismatched Run.");
      }
      if (!["controller", "provider", "retry_wait", "tool", "process"].includes(
        event.attribution.boundary,
      )) {
        throw new TypeError("RetryEvent cancellation attribution boundary is unsupported.");
      }
      assertDateTime(event.attribution.observedAt, "RetryEvent.attribution.observedAt");
      return Object.freeze({
        ...base,
        type: event.type,
        phase: event.phase,
        budgetId: event.budgetId,
        attemptId: event.attemptId,
        attemptNumber: event.attemptNumber,
        attribution: Object.freeze({
          requestId: event.attribution.requestId,
          runId: event.attribution.runId,
          boundary: event.attribution.boundary,
          observedAt: event.attribution.observedAt,
        }),
      });
    case "retry_fallback_selected":
      assertNonEmpty(event.fromLegId, "RetryEvent.fromLegId");
      assertNonEmpty(event.toLegId, "RetryEvent.toLegId");
      assertNonEmpty(event.fromBudgetId, "RetryEvent.fromBudgetId");
      assertNonEmpty(event.toBudgetId, "RetryEvent.toBudgetId");
      assertNonEmpty(event.fromTransport, "RetryEvent.fromTransport");
      assertNonEmpty(event.toTransport, "RetryEvent.toTransport");
      assertPositiveInteger(event.fallbackNumber, "RetryEvent.fallbackNumber");
      assertNonEmpty(event.reasonCode, "RetryEvent.reasonCode");
      assertPositiveInteger(event.nextAttemptNumber, "RetryEvent.nextAttemptNumber");
      return Object.freeze({
        ...base,
        type: event.type,
        fromLegId: event.fromLegId,
        toLegId: event.toLegId,
        fromBudgetId: event.fromBudgetId,
        toBudgetId: event.toBudgetId,
        fromTransport: event.fromTransport,
        toTransport: event.toTransport,
        fallbackNumber: event.fallbackNumber,
        reasonCode: event.reasonCode,
        nextAttemptNumber: event.nextAttemptNumber,
      });
  }

  throw new TypeError("RetryEvent.type is unsupported.");
}

function assertOwner(owner: RetryOwner): void {
  if (![
    "provider_request",
    "response_stream",
    "approvals_reviewer",
    "structured_output",
  ].includes(owner)) {
    throw new TypeError("RetryEvent.owner is unsupported.");
  }
}

function assertNullableText(value: string | null, field: string): void {
  if (value !== null) {
    assertNonEmpty(value, field);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertDateTime(value: string, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
