import {
  snapshotApprovalReviewInput,
  type ApprovalCategory,
  type ApprovalReviewInput,
} from "@agent-anything/permission";
import type { Metadata } from "@agent-anything/shared";
import type { RuntimeEvent } from "../events/index.js";
import type { PlanProjection, PlanStepStatus } from "../plan/index.js";
import { projectRuntimeEventForHost } from "./HostRuntimeProjection.js";
import {
  HOST_RETRY_EVENT_LIMIT,
  snapshotHostCancellation,
  type CreateHostRunProjectionStoreInput,
  type HostEnforcementProjection,
  type HostPendingApprovalProjection,
  type HostPlanProjection,
  type HostRetryEventName,
  type HostRetryEventProjection,
  type HostRetryOwner,
  type HostRetryProjection,
  type HostRunProjection,
  type HostRunProjectionReduction,
  type HostRunProjectionRejectionCode,
  type HostRunProjectionStore,
  type HostRunProjectionUpdate,
  type HostSandboxAttemptProjection,
} from "./HostRunProjection.js";

const approvalCategories: readonly ApprovalCategory[] = [
  "commandExecution",
  "fileChange",
  "permissions",
  "mcpToolCall",
  "skill",
  "networkAccess",
];
const retryOwners: readonly HostRetryOwner[] = [
  "provider_request",
  "response_stream",
  "approvals_reviewer",
  "structured_output",
];
const planStepStatuses: readonly PlanStepStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

export function reduceHostRunProjection(
  current: HostRunProjection,
  update: HostRunProjectionUpdate,
): HostRunProjectionReduction {
  if (!Number.isSafeInteger(update.sequence) || update.sequence <= current.sequence) {
    return rejected(current, "stale_sequence");
  }
  if (update.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }
  if (!isDateTime(update.occurredAt)) {
    return rejected(current, "invalid_update");
  }
  if (isTerminal(current.status)) {
    return rejected(current, "invalid_transition");
  }

  try {
    switch (update.kind) {
      case "runtime_event":
        return applyRuntimeEvent(current, update.sequence, update.event);
      case "approval_review_available":
        return applyApprovalReview(current, update.sequence, update.review);
      case "approval_submission_accepted":
        return applyApprovalSubmission(current, update.sequence, update.receipt);
      case "cancellation_accepted":
        if (
          current.status !== "starting" &&
          current.status !== "running" &&
          current.status !== "waiting_for_approval"
        ) {
          return rejected(current, "invalid_transition");
        }
        return applied(current, update.sequence, {
          status: "cancelling",
          approval: null,
          cancellation: snapshotHostCancellation(update.cancellation),
        });
      case "terminal_result":
        if (
          update.terminal.runId !== current.runId ||
          update.terminal.taskId !== current.taskId
        ) {
          return rejected(current, "terminal_projection_mismatch");
        }
        return applied(current, update.sequence, {
          status: update.terminal.status,
          approval: null,
          cancellation: update.terminal.cancellation ?? current.cancellation,
          terminal: update.terminal,
        });
    }
  } catch {
    return rejected(current, "invalid_update");
  }
}

export function createHostRunProjectionStore(
  input: CreateHostRunProjectionStoreInput,
): HostRunProjectionStore {
  let projection = input.initial;
  const listeners = new Set<(projection: HostRunProjection) => void>();

  return Object.freeze({
    getProjection() {
      return projection;
    },
    apply(update: HostRunProjectionUpdate) {
      const result = reduceHostRunProjection(projection, update);
      if (result.status === "rejected") return result;
      projection = result.projection;
      for (const listener of listeners) {
        try {
          listener(projection);
        } catch (error) {
          try {
            input.onListenerFailure?.({
              runId: projection.runId,
              sequence: projection.sequence,
              error,
            });
          } catch {
            // Listener-failure reporting cannot affect projection delivery.
          }
        }
      }
      return result;
    },
    subscribe(listener: (projection: HostRunProjection) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("Host Run projection listener must be a function.");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function applyRuntimeEvent(
  current: HostRunProjection,
  sequence: number,
  candidate: RuntimeEvent,
): HostRunProjectionReduction {
  const event = projectRuntimeEventForHost(candidate);
  if (event.taskId !== current.taskId) {
    return rejected(current, "run_identity_mismatch");
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (typeof payload.runId === "string" && payload.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }

  switch (event.name) {
    case "run.started":
      return current.status === "starting"
        ? applied(current, sequence, { status: "running" })
        : rejected(current, "invalid_transition");
    case "plan.created":
    case "plan.updated":
    case "plan.completed":
    case "plan.abandoned":
      return applyPlan(current, sequence, readPlan(payload.plan));
    case "approval.requested":
      return applyApprovalRequested(current, sequence, event, payload);
    case "approval.resolved":
      return applyApprovalResolved(current, sequence, payload);
    case "retry.attempt.started":
    case "retry.attempt.finished":
    case "retry.scheduled":
    case "retry.fallback.selected":
    case "retry.exhausted":
    case "retry.cancelled":
      return applied(current, sequence, {
        retry: appendRetry(current.retry, event.name, payload, event.timestamp),
      });
    case "sandbox.attempt.started":
      return applySandboxStarted(current, sequence, payload);
    case "sandbox.attempt.resolved":
      return applySandboxResolved(current, sequence, payload);
    case "sandbox.escalation.proposed":
      return applied(current, sequence, {
        enforcement: Object.freeze({
          ...current.enforcement,
          escalationCount: current.enforcement.escalationCount + 1,
        }),
      });
    default:
      return applied(current, sequence, {});
  }
}

function applyPlan(
  current: HostRunProjection,
  sequence: number,
  plan: HostPlanProjection,
): HostRunProjectionReduction {
  if (current.plan !== null) {
    if (plan.id !== current.plan.id) {
      return rejected(current, "invalid_update");
    }
    if (plan.version < current.plan.version) {
      return rejected(current, "plan_version_regression");
    }
    if (plan.version === current.plan.version && !samePlan(plan, current.plan)) {
      return rejected(current, "invalid_update");
    }
  }
  return applied(current, sequence, { plan });
}

function applyApprovalRequested(
  current: HostRunProjection,
  sequence: number,
  event: RuntimeEvent,
  payload: Metadata,
): HostRunProjectionReduction {
  if (current.status !== "running" && current.status !== "waiting_for_approval") {
    return rejected(current, "invalid_transition");
  }
  const approval = approvalFromRuntimeEvent(event, payload);
  if (current.approval !== null && !sameApproval(current.approval, approval)) {
    return rejected(current, "approval_correlation_mismatch");
  }
  return applied(current, sequence, {
    status: "waiting_for_approval",
    approval: current.approval === null
      ? approval
      : Object.freeze({ ...approval, review: current.approval.review }),
  });
}

function applyApprovalReview(
  current: HostRunProjection,
  sequence: number,
  candidate: ApprovalReviewInput,
): HostRunProjectionReduction {
  if (current.status !== "running" && current.status !== "waiting_for_approval") {
    return rejected(current, "invalid_transition");
  }
  const review = snapshotApprovalReviewInput(candidate);
  const approval = Object.freeze({
    runId: review.request.runId,
    requestId: review.request.id,
    actionId: review.request.actionId,
    category: review.request.category,
    pendingVersion: review.pendingVersion,
    reviewer: "user" as const,
    phase: current.approval?.phase ?? "reviewing" as const,
    requestedAt: review.request.createdAt,
    review,
  });
  if (approval.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }
  if (current.approval !== null && !sameApproval(current.approval, approval)) {
    return rejected(current, "approval_correlation_mismatch");
  }
  return applied(current, sequence, {
    status: "waiting_for_approval",
    approval,
  });
}

function applyApprovalSubmission(
  current: HostRunProjection,
  sequence: number,
  receipt: {
    readonly runId: string;
    readonly requestId: string;
    readonly pendingVersion: number;
  },
): HostRunProjectionReduction {
  if (
    current.status !== "waiting_for_approval" ||
    current.approval === null ||
    receipt.runId !== current.runId ||
    receipt.requestId !== current.approval.requestId ||
    receipt.pendingVersion !== current.approval.pendingVersion
  ) {
    return rejected(current, "approval_correlation_mismatch");
  }
  return applied(current, sequence, {
    approval: Object.freeze({
      ...current.approval,
      phase: "submitted_for_resolution" as const,
    }),
  });
}

function applyApprovalResolved(
  current: HostRunProjection,
  sequence: number,
  payload: Metadata,
): HostRunProjectionReduction {
  if (current.status !== "waiting_for_approval" || current.approval === null) {
    return rejected(current, "invalid_transition");
  }
  if (
    readString(payload.requestId) !== current.approval.requestId ||
    readPositiveInteger(payload.pendingVersion) !== current.approval.pendingVersion
  ) {
    return rejected(current, "approval_correlation_mismatch");
  }
  return applied(current, sequence, {
    status: "running",
    approval: null,
  });
}

function applySandboxStarted(
  current: HostRunProjection,
  sequence: number,
  payload: Metadata,
): HostRunProjectionReduction {
  const attempt = readSandboxAttempt(payload, "running", null);
  if (attempt.enforcement !== current.enforcement.selected) {
    return rejected(current, "invalid_update");
  }
  return applied(current, sequence, {
    enforcement: Object.freeze({
      ...current.enforcement,
      attemptCount: current.enforcement.attemptCount + 1,
      latestAttempt: attempt,
    }),
  });
}

function applySandboxResolved(
  current: HostRunProjection,
  sequence: number,
  payload: Metadata,
): HostRunProjectionReduction {
  const outcome = readSandboxOutcome(payload.outcome);
  const attempt = readSandboxAttempt(payload, outcome, readNullableString(payload.code));
  if (attempt.enforcement !== current.enforcement.selected) {
    return rejected(current, "invalid_update");
  }
  return applied(current, sequence, {
    enforcement: Object.freeze({
      ...current.enforcement,
      status: enforcementStatus(attempt.enforcement, outcome),
      latestAttempt: attempt,
    }),
  });
}

function appendRetry(
  current: HostRetryProjection | null,
  event: HostRetryEventName,
  payload: Metadata,
  timestamp: string,
): HostRetryProjection {
  const projection = retryEvent(event, payload, timestamp);
  const prior = current ?? Object.freeze({
    attemptCount: 0,
    scheduledCount: 0,
    fallbackCount: 0,
    exhaustedCount: 0,
    cancellationCount: 0,
    omittedEventCount: 0,
    recentEvents: Object.freeze([]),
  });
  const all = [...prior.recentEvents, projection];
  const omitted = Math.max(0, all.length - HOST_RETRY_EVENT_LIMIT);
  return Object.freeze({
    attemptCount: prior.attemptCount + (event === "retry.attempt.started" ? 1 : 0),
    scheduledCount: prior.scheduledCount + (event === "retry.scheduled" ? 1 : 0),
    fallbackCount: prior.fallbackCount + (event === "retry.fallback.selected" ? 1 : 0),
    exhaustedCount: prior.exhaustedCount + (event === "retry.exhausted" ? 1 : 0),
    cancellationCount: prior.cancellationCount + (event === "retry.cancelled" ? 1 : 0),
    omittedEventCount: prior.omittedEventCount + omitted,
    recentEvents: Object.freeze(all.slice(omitted)),
  });
}

function retryEvent(
  event: HostRetryEventName,
  payload: Metadata,
  timestamp: string,
): HostRetryEventProjection {
  const owner = readRetryOwner(payload.owner);
  return Object.freeze({
    event,
    operationId: readString(payload.operationId),
    owner,
    occurredAt: isDateTime(payload.occurredAt) ? payload.occurredAt : timestamp,
    attemptNumber: readNullablePositiveInteger(
      payload.attemptNumber ?? payload.nextAttemptNumber,
    ),
    delayMs: readNullableNonNegativeNumber(payload.delayMs),
    outcome: readNullableString(payload.outcome ?? payload.next ?? payload.reason),
    code: readNullableString(
      payload.failureCode ?? payload.lastFailureCode ?? payload.reasonCode,
    ),
  });
}

function approvalFromRuntimeEvent(
  event: RuntimeEvent,
  payload: Metadata,
): HostPendingApprovalProjection {
  return Object.freeze({
    runId: readString(payload.runId),
    requestId: readString(payload.requestId),
    actionId: readString(payload.actionId),
    category: readApprovalCategory(payload.category),
    pendingVersion: readPositiveInteger(payload.pendingVersion),
    reviewer: readReviewer(payload.reviewer),
    phase: "reviewing" as const,
    requestedAt: event.timestamp,
    review: null,
  });
}

function readPlan(value: unknown): HostPlanProjection {
  if (!isRecord(value)) throw new TypeError("Plan projection is required.");
  const id = readString(value.id);
  const version = readPositiveInteger(value.version);
  if (value.status !== "active" && value.status !== "completed" && value.status !== "abandoned") {
    throw new TypeError("Plan projection status is invalid.");
  }
  if (!Array.isArray(value.steps)) throw new TypeError("Plan projection steps are invalid.");
  const steps = value.steps.map((candidate) => {
    if (!isRecord(candidate)) throw new TypeError("Plan step is invalid.");
    const step = readString(candidate.step);
    if (!planStepStatuses.includes(candidate.status as PlanStepStatus)) {
      throw new TypeError("Plan step status is invalid.");
    }
    return Object.freeze({ step, status: candidate.status as PlanStepStatus });
  });
  return Object.freeze({
    id,
    version,
    status: value.status,
    steps: Object.freeze(steps),
  });
}

function readSandboxAttempt(
  payload: Metadata,
  outcome: HostSandboxAttemptProjection["outcome"],
  code: string | null,
): HostSandboxAttemptProjection {
  const ordinal = readPositiveInteger(payload.ordinal);
  if (ordinal !== 1 && ordinal !== 2) throw new TypeError("Sandbox ordinal is invalid.");
  const enforcement = payload.enforcement;
  if (enforcement !== "managed" && enforcement !== "external" && enforcement !== "disabled") {
    throw new TypeError("Sandbox enforcement is invalid.");
  }
  return Object.freeze({
    attemptId: readString(payload.attemptId),
    actionId: readString(payload.actionId),
    ordinal,
    enforcement,
    outcome,
    code,
  });
}

function enforcementStatus(
  enforcement: HostSandboxAttemptProjection["enforcement"],
  outcome: Exclude<HostSandboxAttemptProjection["outcome"], "running">,
): HostEnforcementProjection["status"] {
  switch (outcome) {
    case "executed": return enforcement === "disabled" ? "unisolated" : "enforced";
    case "sandbox_denied": return "denied";
    case "sandbox_unavailable": return "unavailable";
    case "interrupted": return "interrupted";
    case "failed": return "failed";
  }
}

function applied(
  current: HostRunProjection,
  sequence: number,
  changes: Partial<HostRunProjection>,
): HostRunProjectionReduction {
  return Object.freeze({
    status: "applied" as const,
    projection: Object.freeze({ ...current, ...changes, sequence }),
  });
}

function rejected(
  current: HostRunProjection,
  code: HostRunProjectionRejectionCode,
): HostRunProjectionReduction {
  return Object.freeze({ status: "rejected" as const, code, projection: current });
}

function sameApproval(
  left: HostPendingApprovalProjection,
  right: HostPendingApprovalProjection,
): boolean {
  return left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.actionId === right.actionId &&
    left.pendingVersion === right.pendingVersion &&
    left.reviewer === right.reviewer;
}

function samePlan(left: PlanProjection, right: PlanProjection): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.status === right.status &&
    left.steps.length === right.steps.length &&
    left.steps.every((step, index) =>
      step.step === right.steps[index]?.step && step.status === right.steps[index]?.status
    );
}

function isTerminal(status: HostRunProjection["status"]): boolean {
  return status === "completed" || status === "blocked" ||
    status === "failed" || status === "cancelled";
}

function readApprovalCategory(value: unknown): ApprovalCategory {
  if (!approvalCategories.includes(value as ApprovalCategory)) {
    throw new TypeError("Approval category is invalid.");
  }
  return value as ApprovalCategory;
}

function readReviewer(value: unknown): "user" | "auto_review" {
  if (value !== "user" && value !== "auto_review") {
    throw new TypeError("Approval reviewer is invalid.");
  }
  return value;
}

function readRetryOwner(value: unknown): HostRetryOwner {
  if (!retryOwners.includes(value as HostRetryOwner)) {
    throw new TypeError("Retry owner is invalid.");
  }
  return value as HostRetryOwner;
}

function readSandboxOutcome(
  value: unknown,
): Exclude<HostSandboxAttemptProjection["outcome"], "running"> {
  if (
    value !== "executed" && value !== "sandbox_denied" &&
    value !== "sandbox_unavailable" && value !== "interrupted" && value !== "failed"
  ) {
    throw new TypeError("Sandbox outcome is invalid.");
  }
  return value;
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("A non-empty string is required.");
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value);
}

function readPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("A positive integer is required.");
  }
  return value;
}

function readNullablePositiveInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : readPositiveInteger(value);
}

function readNullableNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("A non-negative number is required.");
  }
  return value;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
