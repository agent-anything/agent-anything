import type { ActionExecutionNotification } from "@agent-anything/action-execution/enforcement";
import type { SandboxEnforcement } from "@agent-anything/action-execution/sandbox";
import type { PlanProjection } from "@agent-anything/agent-runtime/plan";
import type {
  RunCancellationSummary,
  RunFailureCause,
  RunFailureKind,
  RunResult,
  RunResultCode,
} from "@agent-anything/agent-runtime/run";
import type {
  RunOperationSnapshot,
  RunRetryProjection,
} from "@agent-anything/agent-runtime/runner";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import type { InteractionTransportReceipt } from "@agent-anything/interaction/records";
import type { ValidationHostProjection } from "@agent-anything/validation/projection";

export type HostRunProjectionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "cancelling"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type HostPlanProjection = PlanProjection;

export interface HostPendingInteractionProjection {
  readonly request: InteractionRequestRef;
  readonly presentation: unknown;
  readonly disclosureClass: "public" | "internal" | "sensitive";
  readonly expiresAt: string | null;
  readonly blockingScope: "none" | "branch" | "run";
  readonly phase: "pending" | "submitted_for_resolution";
}

export type HostRetryEventName =
  | "retry_scheduled"
  | "retry_attempt_started"
  | "retry_attempt_finished"
  | "retry_fallback_selected"
  | "retry_exhausted"
  | "retry_cancelled";

export type HostRetryOwner =
  | "provider_request"
  | "response_stream"
  | "approvals_reviewer"
  | "structured_output";

export interface HostRetryEventProjection {
  readonly event: HostRetryEventName;
  readonly operationId: string;
  readonly owner: HostRetryOwner;
  readonly occurredAt: string;
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
  | "running"
  | "unisolated"
  | "enforced"
  | "unavailable"
  | "denied"
  | "interrupted"
  | "failed"
  | "unknown_effect";

export interface HostActionAttemptProjection {
  readonly attemptId: string;
  readonly actionId: string;
  readonly ordinal: number;
  readonly enforcement: SandboxEnforcement;
  readonly outcome:
    | "running"
    | "invalid"
    | "invalidated"
    | "denied"
    | "cancelled"
    | "timed_out"
    | "failed"
    | "partial"
    | "succeeded"
    | "unknown_effect";
  readonly code: string | null;
}

export interface HostEnforcementProjection {
  readonly selected: SandboxEnforcement;
  readonly status: HostEnforcementStatus;
  readonly attemptCount: number;
  readonly latestAttempt: HostActionAttemptProjection | null;
}

export interface HostTerminalFailureProjection {
  readonly kind: RunFailureKind;
  readonly code: string;
  readonly retryable: boolean | null;
}

export interface HostTerminalRunProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly status: "completed" | "blocked" | "failed" | "cancelled";
  readonly code: RunResultCode | null;
  readonly completedAt: string;
  readonly durationMs: number | null;
  readonly itemCount: number;
  readonly evidenceCount: number;
  readonly artifactCount: number;
  readonly failure: HostTerminalFailureProjection | null;
  readonly relatedFailures: readonly HostTerminalFailureProjection[];
  readonly cancellation: HostCancellationProjection | null;
}

export interface HostRunProjection {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly runOperationSequence: number;
  readonly runRevision: number;
  readonly status: HostRunProjectionStatus;
  readonly startedAt: string;
  readonly plan: HostPlanProjection | null;
  readonly pendingInteractions: readonly HostPendingInteractionProjection[];
  readonly retry: HostRetryProjection | null;
  readonly validation: ValidationHostProjection | null;
  readonly cancellation: HostCancellationProjection | null;
  readonly enforcement: HostEnforcementProjection;
  readonly terminal: HostTerminalRunProjection | null;
}

export interface CreateHostRunProjectionInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly enforcement: SandboxEnforcement;
}

export interface CreateHostTerminalRunProjectionInput<TOutput = unknown> {
  readonly runResult: RunResult<TOutput>;
  readonly completedAt?: string;
}

interface HostRunProjectionUpdateBase<TKind extends string> {
  readonly kind: TKind;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface HostRuntimeEventProjectionUpdate
  extends HostRunProjectionUpdateBase<"runtime_event"> {
  readonly event: RuntimeEvent;
}

export interface HostRunOperationProjectionUpdate
  extends HostRunProjectionUpdateBase<"run_operation"> {
  readonly snapshot: RunOperationSnapshot;
}

export interface HostActionExecutionProjectionUpdate
  extends HostRunProjectionUpdateBase<"action_execution"> {
  readonly notification: ActionExecutionNotification;
}

export interface HostInteractionSubmissionProjectionUpdate
  extends HostRunProjectionUpdateBase<"interaction_submission_accepted"> {
  readonly receipt: InteractionTransportReceipt;
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
  | HostRunOperationProjectionUpdate
  | HostActionExecutionProjectionUpdate
  | HostInteractionSubmissionProjectionUpdate
  | HostCancellationProjectionUpdate
  | HostTerminalProjectionUpdate;

export type HostRunProjectionRejectionCode =
  | "stale_sequence"
  | "run_identity_mismatch"
  | "invalid_transition"
  | "invalid_update"
  | "interaction_correlation_mismatch"
  | "run_operation_sequence_regression"
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
    runOperationSequence: 0,
    runRevision: 0,
    status: "starting" as const,
    startedAt: input.startedAt,
    plan: null,
    pendingInteractions: Object.freeze([]),
    retry: null,
    validation: null,
    cancellation: null,
    enforcement: Object.freeze({
      selected: input.enforcement,
      status: "not_exercised" as const,
      attemptCount: 0,
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
    status: input.runResult.status === "succeeded" ? "completed" : input.runResult.status,
    code: input.runResult.code,
    completedAt,
    durationMs: readNonNegativeNumber(input.runResult.metadata.durationMs),
    itemCount: input.runResult.items.length,
    evidenceCount: input.runResult.evidenceRefs.length,
    artifactCount: input.runResult.artifactRefs.length,
    failure: input.runResult.failure === null
      ? null
      : projectFailure(input.runResult.failure),
    relatedFailures: Object.freeze(
      input.runResult.relatedFailures.map(projectFailure),
    ),
    cancellation: snapshotCancellation(input.runResult.cancellation),
  });
}

function projectFailure(cause: RunFailureCause): HostTerminalFailureProjection {
  return Object.freeze({
    kind: cause.kind,
    code: cause.failure.code,
    retryable: "retryable" in cause.failure ? cause.failure.retryable : null,
  });
}

export function snapshotHostCancellation(
  cancellation: RunCancellationSummary,
): HostCancellationProjection {
  return snapshotCancellation(cancellation)!;
}

function snapshotCancellation(
  cancellation: RunCancellationSummary | null,
): HostCancellationProjection | null {
  if (cancellation === null) return null;
  assertIdentity(cancellation.requestId, "cancellation.requestId");
  assertDateTime(cancellation.requestedAt, "cancellation.requestedAt");
  return Object.freeze({ ...cancellation });
}

function readDateTimeMetadata(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
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
