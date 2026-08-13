import type { OperationBindingRevisionRef, OperationInvocationRef } from "../identity/index.js";

export interface OperationResultRef {
  readonly invocation: OperationInvocationRef;
  readonly id: string;
}

export interface OperationFailure {
  readonly owner: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface OperationResultBase {
  readonly ref: OperationResultRef;
  readonly binding: OperationBindingRevisionRef;
  readonly semanticOwner: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lowerRefs: readonly OperationLowerResultRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OperationLowerResultRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export type OperationResult<TOutput = unknown> =
  | (OperationResultBase & {
      readonly status: "succeeded";
      readonly output: TOutput;
      readonly failure: null;
    })
  | (OperationResultBase & {
      readonly status: "partial";
      readonly output: TOutput;
      readonly failure: OperationFailure;
    })
  | (OperationResultBase & {
      readonly status:
        | "failed"
        | "unavailable"
        | "denied"
        | "cancelled"
        | "timed_out"
        | "invalid"
        | "unknown_effect";
      readonly output: null;
      readonly failure: OperationFailure;
    });

export function createOperationResult<TOutput>(
  input: OperationResult<TOutput>,
): OperationResult<TOutput> {
  requireToken(input.ref.id, "OperationResult.ref.id");
  requireToken(input.semanticOwner, "OperationResult.semanticOwner");
  requireDateTime(input.startedAt, "OperationResult.startedAt");
  requireDateTime(input.finishedAt, "OperationResult.finishedAt");
  if (Date.parse(input.finishedAt) < Date.parse(input.startedAt)) {
    throw new TypeError("OperationResult cannot finish before it starts.");
  }
  if (input.status !== "succeeded" && input.failure === null) {
    throw new TypeError("A non-succeeded OperationResult requires its owner Failure.");
  }
  if (input.status === "partial" && input.output === null) {
    throw new TypeError("A partial OperationResult requires validated usable output.");
  }
  return deepFreeze({
    ...input,
    lowerRefs: [...input.lowerRefs],
    metadata: { ...input.metadata },
  }) as OperationResult<TOutput>;
}

function requireToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}

function requireDateTime(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be an ISO date-time.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
