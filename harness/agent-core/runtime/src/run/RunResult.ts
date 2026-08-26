import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ArtifactRef, RunRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunItem } from "./RunItem.js";
import type { RunBlockedCode, RunFailureCode } from "./RunStatus.js";
import {
  snapshotAgentInstructionBindingRef,
  type AgentInstructionBindingRef,
} from "../instructions/index.js";

interface RunResultBase<TOutput> {
  readonly run: RunRef;
  readonly runId: string;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly finalActiveAgent: AgentRevisionRef;
  readonly startingInstructionBinding: AgentInstructionBindingRef;
  readonly finalInstructionBinding: AgentInstructionBindingRef;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly items: readonly RunItem<TOutput>[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type SucceededRunResult<TOutput> = RunResultBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: TOutput;
  readonly cancellation: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
};
export type BlockedRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly cancellation: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
};
export type FailedRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly cancellation: RunCancellationSummary | null;
  readonly failure: RunFailureCause;
  readonly relatedFailures: readonly RunFailureCause[];
};
export type CancelledRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: "runtime_cancelled";
  readonly finalOutput: null;
  readonly cancellation: RunCancellationSummary;
  readonly failure: null;
  readonly relatedFailures: readonly [];
};
export type RunResult<TOutput = unknown> = SucceededRunResult<TOutput> | BlockedRunResult<TOutput> | FailedRunResult<TOutput> | CancelledRunResult<TOutput>;

export interface CreateRunResultBaseInput<TOutput = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly finalActiveAgent: AgentRevisionRef;
  readonly startingInstructionBinding: AgentInstructionBindingRef;
  readonly finalInstructionBinding: AgentInstructionBindingRef;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly items?: readonly RunItem<TOutput>[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createSucceededRunResult<TOutput>(input: CreateRunResultBaseInput<TOutput>, finalOutput: TOutput): SucceededRunResult<TOutput> {
  return deepFreeze({ ...base(input), status: "succeeded", code: null, finalOutput, cancellation: null, failure: null, relatedFailures: [] });
}
export function createBlockedRunResult<TOutput = never>(input: CreateRunResultBaseInput<TOutput>, code: RunBlockedCode): BlockedRunResult<TOutput> {
  if (
    code !== "runtime_no_safe_path" &&
    code !== "runtime_no_progress" &&
    code !== "validation_blocked"
  ) {
    throw new TypeError("Blocked RunResult code is invalid.");
  }
  return deepFreeze({ ...base(input), status: "blocked", code, finalOutput: null, cancellation: null, failure: null, relatedFailures: [] });
}
export function createFailedRunResult<TOutput = never>(input: CreateRunResultBaseInput<TOutput>, code: RunFailureCode, failure: RunFailureCause, relatedFailures: readonly RunFailureCause[] = [], cancellation: RunCancellationSummary | null = null): FailedRunResult<TOutput> {
  assertFailureCode(code);
  assertRunFailureCause(failure, "failure");
  if (!Array.isArray(relatedFailures)) {
    throw new TypeError("relatedFailures must be an array.");
  }
  relatedFailures.forEach((related, index) => {
    assertRunFailureCause(related, `relatedFailures[${index}]`);
  });
  if (cancellation !== null) assertCancellation(cancellation);
  return deepFreeze({ ...base(input), status: "failed", code, finalOutput: null, cancellation, failure, relatedFailures: [...relatedFailures] });
}
export function createCancelledRunResult<TOutput = never>(input: CreateRunResultBaseInput<TOutput>, cancellation: RunCancellationSummary): CancelledRunResult<TOutput> {
  assertCancellation(cancellation);
  return deepFreeze({ ...base(input), status: "cancelled", code: "runtime_cancelled", finalOutput: null, cancellation, failure: null, relatedFailures: [] });
}

function base<TOutput>(input: CreateRunResultBaseInput<TOutput>): RunResultBase<TOutput> {
  if (!isRecord(input)) throw new TypeError("RunResult input must be an object.");
  token(input.runId, "runId");
  token(input.taskId, "taskId");
  const startingAgent = snapshotAgentRef(input.startingAgent, "startingAgent");
  const finalActiveAgent = snapshotAgentRef(input.finalActiveAgent, "finalActiveAgent");
  const startingInstructionBinding = snapshotAgentInstructionBindingRef(
    input.startingInstructionBinding,
  );
  const finalInstructionBinding = snapshotAgentInstructionBindingRef(
    input.finalInstructionBinding,
  );
  const startedAtMs = dateTime(input.startedAt, "startedAt");
  const completedAtMs = dateTime(input.completedAt, "completedAt");
  if (completedAtMs < startedAtMs) {
    throw new TypeError("RunResult cannot complete before it starts.");
  }
  const items = snapshotItems(input.items ?? [], input.runId);
  const evidenceRefs = snapshotStringRefs(input.evidenceRefs ?? [], "evidenceRefs");
  const artifactRefs = snapshotStringRefs(input.artifactRefs ?? [], "artifactRefs");
  if (!isRecord(input.metadata ?? {})) {
    throw new TypeError("metadata must be an object.");
  }
  return {
    run: Object.freeze({ id: input.runId }),
    runId: input.runId,
    taskId: input.taskId,
    startingAgent,
    finalActiveAgent,
    startingInstructionBinding,
    finalInstructionBinding,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    items,
    evidenceRefs,
    artifactRefs,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };
}

function snapshotAgentRef(value: AgentRevisionRef, field: string): AgentRevisionRef {
  if (!isRecord(value)) throw new TypeError(`${field} must be an Agent revision.`);
  token(value.id as string, `${field}.id`);
  token(value.revision as string, `${field}.revision`);
  return Object.freeze({ id: value.id as string, revision: value.revision as string });
}

function snapshotItems<TOutput>(
  values: readonly RunItem<TOutput>[],
  runId: string,
): readonly RunItem<TOutput>[] {
  if (!Array.isArray(values)) throw new TypeError("items must be an array.");
  let priorRevision = 0;
  return Object.freeze(values.map((item, index) => {
    const raw = item as unknown;
    if (!isRecord(raw) || !isRecord(raw.ref) || !isRecord(raw.ref.run)) {
      throw new TypeError(`items[${index}] must be a RunItem.`);
    }
    const ref = raw.ref;
    const run = ref.run as Record<string, unknown>;
    if (run.id !== runId) {
      throw new TypeError(`RunItem ${String(ref.id)} does not belong to Run ${runId}.`);
    }
    token(ref.id as string, `items[${index}].ref.id`);
    const expectedSequence = index + 1;
    if (ref.sequence !== expectedSequence) {
      throw new TypeError(`RunItem sequence must be contiguous at items[${index}].`);
    }
    const committedInRevision = raw.committedInRevision;
    if (
      !Number.isSafeInteger(committedInRevision) ||
      (committedInRevision as number) < 1 ||
      (committedInRevision as number) < priorRevision
    ) {
      throw new TypeError("RunItem committed revisions must be positive and non-decreasing.");
    }
    dateTime(raw.createdAt as string, `items[${index}].createdAt`);
    priorRevision = committedInRevision as number;
    return item;
  }));
}

function snapshotStringRefs<TRef extends string>(
  values: readonly TRef[],
  field: string,
): readonly TRef[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array.`);
  const seen = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    token(value, `${field}[${index}]`);
    if (seen.has(value)) throw new TypeError(`${field} contains duplicate '${value}'.`);
    seen.add(value);
    return value;
  }));
}

function assertRunFailureCause(value: RunFailureCause, field: string): void {
  const kinds = new Set([
    "runtime", "model", "provider", "operation", "interaction", "approval",
    "permission", "policy", "action_execution", "sandbox", "tool", "composite",
    "descendant", "context", "audit", "telemetry", "validation",
  ]);
  if (!isRecord(value) || !kinds.has(String(value.kind)) || !isRecord(value.failure)) {
    throw new TypeError(`${field} must be a valid RunFailureCause.`);
  }
  token(value.failure.code as string, `${field}.failure.code`);
  token(value.failure.message as string, `${field}.failure.message`);
  if (value.kind === "validation") {
    token(value.failure.stage as string, `${field}.failure.stage`);
    if (typeof value.failure.retryable !== "boolean") {
      throw new TypeError(`${field}.failure.retryable must be boolean.`);
    }
    return;
  }
  if (!isRecord(value.failure.metadata)) {
    throw new TypeError(`${field}.failure.metadata must be an object.`);
  }
}

function assertCancellation(value: RunCancellationSummary): void {
  if (!isRecord(value)) throw new TypeError("cancellation must be valid.");
  token(value.requestId as string, "cancellation.requestId");
  if (!["user", "host", "approval", "parent_run", "runner"].includes(String(value.origin))) {
    throw new TypeError("cancellation.origin is invalid.");
  }
  token(value.reasonCode as string, "cancellation.reasonCode");
  dateTime(value.requestedAt as string, "cancellation.requestedAt");
}

function assertFailureCode(code: RunFailureCode): void {
  if (![
    "runtime_execution_failed", "runtime_limit_exceeded", "runtime_deadline_exceeded",
    "context_projection_failed", "controller_failed", "operation_failed",
    "interaction_failed", "required_finalization_failed", "validation_failed",
    "tool_exposure_failed",
    "unknown_effect",
  ].includes(code)) {
    throw new TypeError("Failed RunResult code is invalid.");
  }
}

function dateTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
  return parsed;
}

function token(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
