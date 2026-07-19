import type { ArtifactRef, EvidenceRef, Metadata } from "@agent-anything/shared";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunItem } from "./RunItem.js";
import type { RuntimeError } from "./RuntimeError.js";
import type {
  RunBlockedCode,
  RunCancelledCode,
  RunFailureCode,
} from "./RunStatus.js";
export type {
  RunBlockedCode,
  RunCancelledCode,
  RunFailureCode,
  RunResultCode,
  RunResultStatus,
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
