import type {
  ArtifactRef,
  EvidenceRef,
  Metadata,
} from "@agent-anything/foundation";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunItem } from "./RunItem.js";
import type {
  RunBlockedCode,
  RunCancelledCode,
  RunFailureCode,
} from "./RunStatus.js";

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
  readonly code: RunCancelledCode;
  readonly finalOutput: null;
  readonly cancellation: RunCancellationSummary;
  readonly failure: null;
  readonly relatedFailures: readonly [];
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
    failure: null,
    relatedFailures: Object.freeze([]) as readonly [],
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
    failure: null,
    relatedFailures: Object.freeze([]) as readonly [],
  });
}

export function createFailedRunResult<TOutput = never>(
  input: CreateRunResultBaseInput<TOutput>,
  code: RunFailureCode,
  failure: RunFailureCause,
  relatedFailures: readonly RunFailureCause[] = [],
  cancellation: RunCancellationSummary | null = null,
): FailedRunResult<TOutput> {
  assertRunFailureCause(failure, "failure");
  relatedFailures.forEach((relatedFailure, index) => {
    assertRunFailureCause(relatedFailure, `relatedFailures[${index}]`);
  });
  return Object.freeze({
    ...createBase(input),
    status: "failed" as const,
    code,
    finalOutput: null,
    cancellation,
    failure,
    relatedFailures: Object.freeze([...relatedFailures]),
  });
}

function assertRunFailureCause(
  cause: RunFailureCause,
  field: string,
): void {
  if (
    cause === null ||
    typeof cause !== "object" ||
    typeof cause.kind !== "string" ||
    cause.failure === null ||
    typeof cause.failure !== "object" ||
    typeof cause.failure.code !== "string" ||
    cause.failure.code.trim().length === 0
  ) {
    throw new TypeError(`${field} must be a valid RunFailureCause.`);
  }
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
    failure: null,
    relatedFailures: Object.freeze([]) as readonly [],
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
