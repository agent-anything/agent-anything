import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunItem } from "./RunItem.js";
import type { RuntimeError } from "./RuntimeError.js";

export type RunResultStatus = "succeeded" | "blocked" | "failed" | "cancelled";

export type RunBlockedCode =
  | "runtime_no_safe_path"
  | "approval_declined"
  | "approval_policy_disabled"
  | "approval_request_limit_exceeded"
  | "approval_decline_limit_exceeded"
  | "policy_rule_forbidden"
  | "policy_denied"
  | "sandbox_denied";

export type RunFailureCode =
  | "runtime_invalid_options"
  | "runtime_limit_exceeded"
  | "runtime_workspace_resolution_failed"
  | "runtime_identity_resolution_failed"
  | "runtime_cancellation_settlement_timeout"
  | "model_request_failed"
  | "model_output_invalid"
  | "model_structured_output_retry_exhausted"
  | "provider_request_failed"
  | "provider_timeout"
  | "provider_retry_exhausted"
  | "provider_stream_retry_exhausted"
  | "provider_stream_incomplete"
  | "provider_cancellation_unconfirmed"
  | "approval_reviewer_unavailable"
  | "approval_review_failed"
  | "approval_review_malformed"
  | "approval_review_timeout"
  | "approval_review_retry_exhausted"
  | "approval_review_failure_limit_exceeded"
  | "approval_cancellation_unconfirmed"
  | "granted_permissions_invalid"
  | "session_authority_commit_failed"
  | "session_authority_commit_unconfirmed"
  | "policy_amendment_invalid"
  | "policy_amendment_commit_failed"
  | "policy_amendment_commit_unconfirmed"
  | "sandbox_enforcement_failed"
  | "tool_sandbox_escalation_failed"
  | "tool_execution_failed"
  | "tool_timeout"
  | "tool_cancellation_unconfirmed"
  | "storage_write_failed"
  | "audit_required_failed"
  | "runtime_telemetry_required_failed";

export type RunCancelledCode = "runtime_cancelled";

export type RunResultCode = RunBlockedCode | RunFailureCode | RunCancelledCode;

interface RunResultBase<TOutput> {
  readonly runId: string;
  readonly taskId: string;
  readonly items: readonly RunItem<TOutput>[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Metadata;
}

export type SucceededRunResult<TOutput> = RunResultBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: NonNullable<TOutput>;
  readonly cancellation: null;
  readonly errors: readonly [];
};

export type BlockedRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly cancellation: null;
  readonly errors: readonly [];
};

export type FailedRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly cancellation: RunCancellationSummary | null;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
};

export type CancelledRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: RunCancelledCode;
  readonly finalOutput: null;
  readonly cancellation: RunCancellationSummary;
  readonly errors: readonly [];
};

export type RunResult<TOutput = unknown> =
  | SucceededRunResult<TOutput>
  | BlockedRunResult<TOutput>
  | FailedRunResult<TOutput>
  | CancelledRunResult<TOutput>;

export interface CreateRunResultBaseInput<TOutput = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly items?: readonly RunItem<TOutput>[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly metadata?: Metadata;
}

export function createSucceededRunResult<TOutput>(
  input: CreateRunResultBaseInput<TOutput>,
  finalOutput: NonNullable<TOutput>,
): SucceededRunResult<TOutput> {
  if (finalOutput === null || finalOutput === undefined) {
    throw new TypeError("A succeeded RunResult requires a non-null finalOutput.");
  }

  return Object.freeze({
    ...createBase(input),
    status: "succeeded" as const,
    code: null,
    finalOutput,
    cancellation: null,
    errors: Object.freeze([]) as readonly [],
  });
}

export function createBlockedRunResult<TOutput = never>(
  input: CreateRunResultBaseInput<TOutput>,
  code: RunBlockedCode,
): BlockedRunResult<TOutput> {
  return Object.freeze({
    ...createBase(input),
    status: "blocked" as const,
    code,
    finalOutput: null,
    cancellation: null,
    errors: Object.freeze([]) as readonly [],
  });
}

export function createFailedRunResult<TOutput = never>(
  input: CreateRunResultBaseInput<TOutput>,
  code: RunFailureCode,
  errors: readonly [RuntimeError, ...RuntimeError[]],
  cancellation: RunCancellationSummary | null = null,
): FailedRunResult<TOutput> {
  if (errors.length === 0) {
    throw new TypeError("A failed RunResult requires at least one RuntimeError.");
  }

  return Object.freeze({
    ...createBase(input),
    status: "failed" as const,
    code,
    finalOutput: null,
    cancellation,
    errors: Object.freeze([...errors]) as unknown as readonly [RuntimeError, ...RuntimeError[]],
  });
}

export function createCancelledRunResult<TOutput = never>(
  input: CreateRunResultBaseInput<TOutput>,
  cancellation: RunCancellationSummary,
): CancelledRunResult<TOutput> {
  assertNonEmpty(cancellation.requestId, "cancellation.requestId");
  return Object.freeze({
    ...createBase(input),
    status: "cancelled" as const,
    code: "runtime_cancelled" as const,
    finalOutput: null,
    cancellation,
    errors: Object.freeze([]) as readonly [],
  });
}

function createBase<TOutput>(input: CreateRunResultBaseInput<TOutput>): RunResultBase<TOutput> {
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.taskId, "taskId");

  const items = [...(input.items ?? [])];
  for (const item of items) {
    if (item.runId !== input.runId) {
      throw new TypeError(`RunItem ${item.id} does not belong to Run ${input.runId}.`);
    }
  }

  return {
    runId: input.runId,
    taskId: input.taskId,
    items: Object.freeze(items),
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
    artifactRefs: Object.freeze([...(input.artifactRefs ?? [])]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
