import type {
  ApprovalCategory,
  ApprovalReviewInput,
  ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { SandboxEnforcement } from "@agent-anything/agent-core/action-execution";
import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core/events";
import type { PlanProjection } from "@agent-anything/agent-core/plan";
import type {
  RunCancellationSummary,
  RunResult,
  RunResultCode,
  RuntimeErrorOwner,
} from "@agent-anything/agent-core/run";

export const HOST_RETRY_EVENT_LIMIT = 16;

export type HostRunProjectionStatus =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type HostPlanProjection = PlanProjection;

export interface HostPendingApprovalProjection {
  readonly runId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly category: ApprovalCategory;
  readonly pendingVersion: number;
  readonly reviewer: "user" | "auto_review";
  readonly phase: "reviewing" | "submitted_for_resolution";
  readonly requestedAt: ISODateTimeString;
  readonly review: ApprovalReviewInput | null;
}

export type HostRetryEventName = Extract<
  RuntimeEventName,
  | "retry.attempt.started"
  | "retry.attempt.finished"
  | "retry.scheduled"
  | "retry.fallback.selected"
  | "retry.exhausted"
  | "retry.cancelled"
>;

export type HostRetryOwner =
  | "provider_request"
  | "response_stream"
  | "approvals_reviewer"
  | "structured_output";

export interface HostRetryEventProjection {
  readonly event: HostRetryEventName;
  readonly operationId: string;
  readonly owner: HostRetryOwner;
  readonly occurredAt: ISODateTimeString;
  readonly attemptNumber: number | null;
  readonly delayMs: number | null;
  readonly outcome: string | null;
  readonly code: string | null;
}

export interface HostRetryProjection {
  readonly attemptCount: number;
  readonly scheduledCount: number;
  readonly fallbackCount: number;
  readonly exhaustedCount: number;
  readonly cancellationCount: number;
  readonly omittedEventCount: number;
  readonly recentEvents: readonly HostRetryEventProjection[];
}

export type HostCancellationProjection = RunCancellationSummary;

export type HostEnforcementStatus =
  | "not_exercised"
  | "unisolated"
  | "enforced"
  | "unavailable"
  | "denied"
  | "interrupted"
  | "failed";

export interface HostSandboxAttemptProjection {
  readonly attemptId: string;
  readonly actionId: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: SandboxEnforcement;
  readonly outcome:
    | "running"
    | "executed"
    | "sandbox_denied"
    | "sandbox_unavailable"
    | "interrupted"
    | "failed";
  readonly code: string | null;
}

export interface HostEnforcementProjection {
  readonly selected: SandboxEnforcement;
  readonly status: HostEnforcementStatus;
  readonly attemptCount: number;
  readonly escalationCount: number;
  readonly latestAttempt: HostSandboxAttemptProjection | null;
}

export interface HostTerminalErrorProjection {
  readonly owner: RuntimeErrorOwner;
  readonly code: string;
  readonly retryable: boolean;
}

export interface HostTerminalRunProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly status: "completed" | "blocked" | "failed" | "cancelled";
  readonly code: RunResultCode | null;
  readonly completedAt: ISODateTimeString;
  readonly durationMs: number | null;
  readonly iterations: number | null;
  readonly actions: number | null;
  readonly itemCount: number;
  readonly evidenceCount: number;
  readonly artifactCount: number;
  readonly errors: readonly HostTerminalErrorProjection[];
  readonly cancellation: HostCancellationProjection | null;
}

export interface HostRunProjection {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly status: HostRunProjectionStatus;
  readonly startedAt: ISODateTimeString;
  readonly plan: HostPlanProjection | null;
  readonly approval: HostPendingApprovalProjection | null;
  readonly retry: HostRetryProjection | null;
  readonly cancellation: HostCancellationProjection | null;
  readonly enforcement: HostEnforcementProjection;
  readonly terminal: HostTerminalRunProjection | null;
}

export interface CreateHostRunProjectionInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly startedAt: ISODateTimeString;
  readonly enforcement: SandboxEnforcement;
}

export interface CreateHostTerminalRunProjectionInput<TOutput = unknown> {
  readonly runResult: RunResult<TOutput>;
  readonly completedAt?: ISODateTimeString;
}

interface HostRunProjectionUpdateBase<TKind extends string> {
  readonly kind: TKind;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: ISODateTimeString;
}

export interface HostRuntimeEventProjectionUpdate
  extends HostRunProjectionUpdateBase<"runtime_event"> {
  readonly event: RuntimeEvent;
}

export interface HostApprovalReviewProjectionUpdate
  extends HostRunProjectionUpdateBase<"approval_review_available"> {
  readonly review: ApprovalReviewInput;
}

export interface HostApprovalSubmissionProjectionUpdate
  extends HostRunProjectionUpdateBase<"approval_submission_accepted"> {
  readonly receipt: Extract<
    ApprovalSubmissionReceipt,
    { readonly status: "accepted_for_resolution" }
  >;
}

export interface HostCancellationProjectionUpdate
  extends HostRunProjectionUpdateBase<"cancellation_accepted"> {
  readonly cancellation: RunCancellationSummary;
}

export interface HostTerminalProjectionUpdate
  extends HostRunProjectionUpdateBase<"terminal_result"> {
  readonly terminal: HostTerminalRunProjection;
}

export type HostRunProjectionUpdate =
  | HostRuntimeEventProjectionUpdate
  | HostApprovalReviewProjectionUpdate
  | HostApprovalSubmissionProjectionUpdate
  | HostCancellationProjectionUpdate
  | HostTerminalProjectionUpdate;

export type HostRunProjectionRejectionCode =
  | "stale_sequence"
  | "run_identity_mismatch"
  | "invalid_transition"
  | "invalid_update"
  | "approval_correlation_mismatch"
  | "plan_version_regression"
  | "terminal_projection_mismatch";

export type HostRunProjectionReduction =
  | { readonly status: "applied"; readonly projection: HostRunProjection }
  | {
      readonly status: "rejected";
      readonly code: HostRunProjectionRejectionCode;
      readonly projection: HostRunProjection;
    };

export type HostRunProjectionListener = (projection: HostRunProjection) => void;

export interface HostRunProjectionListenerFailure {
  readonly runId: string;
  readonly sequence: number;
  readonly error: unknown;
}

export interface HostRunProjectionStore {
  getProjection(): HostRunProjection;
  apply(update: HostRunProjectionUpdate): HostRunProjectionReduction;
  subscribe(listener: HostRunProjectionListener): () => void;
}

export interface CreateHostRunProjectionStoreInput {
  readonly initial: HostRunProjection;
  readonly onListenerFailure?: (
    failure: HostRunProjectionListenerFailure,
  ) => void;
}

export function createHostRunProjection(
  input: CreateHostRunProjectionInput,
): HostRunProjection {
  assertIdentity(input.sessionId, "sessionId");
  assertIdentity(input.taskId, "taskId");
  assertIdentity(input.runId, "runId");
  assertDateTime(input.startedAt, "startedAt");
  assertEnforcement(input.enforcement);

  return Object.freeze({
    sessionId: input.sessionId,
    taskId: input.taskId,
    runId: input.runId,
    sequence: 0,
    status: "starting" as const,
    startedAt: input.startedAt,
    plan: null,
    approval: null,
    retry: null,
    cancellation: null,
    enforcement: Object.freeze({
      selected: input.enforcement,
      status: "not_exercised" as const,
      attemptCount: 0,
      escalationCount: 0,
      latestAttempt: null,
    }),
    terminal: null,
  });
}

export function createHostTerminalRunProjection<TOutput>(
  input: CreateHostTerminalRunProjectionInput<TOutput>,
): HostTerminalRunProjection {
  const completedAt = input.completedAt ?? readDateTimeMetadata(
    input.runResult.metadata.completedAt,
  ) ?? new Date().toISOString();
  assertDateTime(completedAt, "completedAt");

  return Object.freeze({
    runId: input.runResult.runId,
    taskId: input.runResult.taskId,
    status: terminalStatus(input.runResult.status),
    code: input.runResult.code,
    completedAt,
    durationMs: readNonNegativeNumber(input.runResult.metadata.durationMs),
    iterations: readNonNegativeInteger(input.runResult.metadata.iterations),
    actions: readNonNegativeInteger(input.runResult.metadata.actions),
    itemCount: input.runResult.items.length,
    evidenceCount: input.runResult.evidenceRefs.length,
    artifactCount: input.runResult.artifactRefs.length,
    errors: Object.freeze(input.runResult.errors.map((error) => Object.freeze({
      owner: error.owner,
      code: error.code,
      retryable: error.retryable,
    }))),
    cancellation: snapshotCancellation(input.runResult.cancellation),
  });
}

export function snapshotHostCancellation(
  cancellation: RunCancellationSummary,
): HostCancellationProjection {
  return snapshotCancellation(cancellation)!;
}

function terminalStatus(
  status: RunResult["status"],
): HostTerminalRunProjection["status"] {
  return status === "succeeded" ? "completed" : status;
}

function snapshotCancellation(
  cancellation: RunCancellationSummary | null,
): HostCancellationProjection | null {
  if (cancellation === null) return null;
  assertIdentity(cancellation.requestId, "cancellation.requestId");
  assertDateTime(cancellation.requestedAt, "cancellation.requestedAt");
  return Object.freeze({
    requestId: cancellation.requestId,
    origin: cancellation.origin,
    reasonCode: cancellation.reasonCode,
    requestedAt: cancellation.requestedAt,
  });
}

function readDateTimeMetadata(value: unknown): ISODateTimeString | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function assertEnforcement(value: SandboxEnforcement): void {
  if (value !== "managed" && value !== "external" && value !== "disabled") {
    throw new TypeError("enforcement is unsupported.");
  }
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function assertDateTime(value: string, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}
