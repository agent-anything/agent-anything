import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunFailureCause } from "./RunFailure.js";

export interface RunSettlementCauseRef {
  readonly run: RunRef;
  readonly id: string;
  readonly revision: string;
}

export interface RunCauseSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
  readonly run: RunRef | null;
}

export interface RunCausalLink {
  readonly relation: "caused_by" | "required_dependency" | "terminalization_failure";
  readonly source: RunCauseSourceRef;
}

export type RunSettlementCauseRecord =
  | {
      readonly ref: RunSettlementCauseRef;
      readonly kind: "completion";
      readonly code: "completion_accepted";
      readonly source: RunCauseSourceRef;
      readonly underlying: readonly RunCausalLink[];
      readonly omittedUnderlyingCount: number;
      readonly recordedAt: string;
    }
  | {
      readonly ref: RunSettlementCauseRef;
      readonly kind: "failure";
      readonly failure: RunFailureCause;
      readonly source: RunCauseSourceRef;
      readonly underlying: readonly RunCausalLink[];
      readonly omittedUnderlyingCount: number;
      readonly recordedAt: string;
    }
  | {
      readonly ref: RunSettlementCauseRef;
      readonly kind: "cancellation";
      readonly code: "runtime_cancelled";
      readonly cancellation: RunCancellationSummary;
      readonly source: RunCauseSourceRef;
      readonly underlying: readonly RunCausalLink[];
      readonly omittedUnderlyingCount: number;
      readonly recordedAt: string;
    };

export type RunSettlement<TOutput = unknown> =
  | {
      readonly status: "succeeded";
      readonly completedAt: string;
      readonly cause: RunSettlementCauseRef;
      readonly output: TOutput;
    }
  | {
      readonly status: "failed";
      readonly completedAt: string;
      readonly cause: RunSettlementCauseRef;
    }
  | {
      readonly status: "cancelled";
      readonly completedAt: string;
      readonly cause: RunSettlementCauseRef;
    };

const MAX_CAUSAL_LINKS = 8;

export function snapshotRunCauseSourceRef(
  input: RunCauseSourceRef,
  field = "source",
): RunCauseSourceRef {
  assertRecord(input, field);
  token(input.owner, `${field}.owner`);
  token(input.kind, `${field}.kind`);
  token(input.id, `${field}.id`);
  if (input.revision !== null) token(input.revision, `${field}.revision`);
  if (input.run !== null) token(input.run.id, `${field}.run.id`);
  return Object.freeze({
    owner: input.owner,
    kind: input.kind,
    id: input.id,
    revision: input.revision,
    run: input.run === null ? null : Object.freeze({ id: input.run.id }),
  });
}

export function snapshotRunSettlementCauseRecord(
  input: RunSettlementCauseRecord,
): RunSettlementCauseRecord {
  assertRecord(input, "cause");
  const ref = snapshotCauseRef(input.ref);
  const source = snapshotRunCauseSourceRef(input.source);
  const underlying = snapshotCausalLinks(input.underlying, ref, source);
  if (!Number.isSafeInteger(input.omittedUnderlyingCount) || input.omittedUnderlyingCount < 0) {
    throw new TypeError("cause.omittedUnderlyingCount must be a non-negative safe integer.");
  }
  dateTime(input.recordedAt, "cause.recordedAt");
  if (input.kind === "completion") {
    if (input.code !== "completion_accepted") {
      throw new TypeError("Completion settlement cause code is invalid.");
    }
    return deepFreeze({ ...input, ref, source, underlying });
  }
  if (input.kind === "cancellation") {
    if (input.code !== "runtime_cancelled") {
      throw new TypeError("Cancellation settlement cause code is invalid.");
    }
    token(input.cancellation.requestId, "cause.cancellation.requestId");
    token(input.cancellation.reasonCode, "cause.cancellation.reasonCode");
    dateTime(input.cancellation.requestedAt, "cause.cancellation.requestedAt");
    return deepFreeze({ ...input, ref, source, underlying });
  }
  assertRecord(input.failure, "cause.failure");
  token(input.failure.kind, "cause.failure.kind");
  assertRecord(input.failure.failure, "cause.failure.failure");
  token(input.failure.failure.code, "cause.failure.failure.code");
  token(input.failure.failure.message, "cause.failure.failure.message");
  return deepFreeze({ ...input, ref, source, underlying });
}

export function snapshotRunSettlement<TOutput>(
  input: RunSettlement<TOutput>,
  cause: RunSettlementCauseRecord,
): RunSettlement<TOutput> {
  assertRecord(input, "settlement");
  dateTime(input.completedAt, "settlement.completedAt");
  const causeRef = snapshotCauseRef(input.cause);
  if (!sameCauseRef(causeRef, cause.ref)) {
    throw new TypeError("Run settlement does not reference its cause record.");
  }
  if (input.status !== causeKindStatus(cause.kind)) {
    throw new TypeError("Run settlement status disagrees with its cause record.");
  }
  return deepFreeze({ ...input, cause: causeRef });
}

export function runSettlementCauseCode(cause: RunSettlementCauseRecord): string {
  return cause.kind === "failure" ? cause.failure.failure.code : cause.code;
}

export function runSettlementFailure(
  cause: RunSettlementCauseRecord,
): RunFailureCause | null {
  return cause.kind === "failure" ? cause.failure : null;
}

function snapshotCauseRef(input: RunSettlementCauseRef): RunSettlementCauseRef {
  assertRecord(input, "cause.ref");
  assertRecord(input.run, "cause.ref.run");
  token(input.run.id, "cause.ref.run.id");
  token(input.id, "cause.ref.id");
  token(input.revision, "cause.ref.revision");
  return Object.freeze({
    run: Object.freeze({ id: input.run.id }),
    id: input.id,
    revision: input.revision,
  });
}

function snapshotCausalLinks(
  input: readonly RunCausalLink[],
  cause: RunSettlementCauseRef,
  directSource: RunCauseSourceRef,
): readonly RunCausalLink[] {
  if (!Array.isArray(input) || input.length > MAX_CAUSAL_LINKS) {
    throw new TypeError(`Settlement cause supports at most ${MAX_CAUSAL_LINKS} causal links.`);
  }
  const seen = new Set<string>();
  return Object.freeze(input.map((link, index) => {
    if (typeof link !== "object" || link === null) {
      throw new TypeError(`cause.underlying[${index}] must be an object.`);
    }
    if (!["caused_by", "required_dependency", "terminalization_failure"].includes(link.relation)) {
      throw new TypeError(`cause.underlying[${index}].relation is invalid.`);
    }
    const source = snapshotRunCauseSourceRef(link.source, `cause.underlying[${index}].source`);
    const key = `${link.relation}\0${sourceKey(source)}`;
    if (seen.has(key)) throw new TypeError("Settlement cause contains duplicate causal links.");
    if (sourceKey(source) === sourceKey(directSource)) {
      throw new TypeError("Settlement cause cannot repeat its direct source as an underlying link.");
    }
    if (source.run?.id === cause.run.id && source.id === cause.id && source.revision === cause.revision) {
      throw new TypeError("Settlement cause cannot reference itself.");
    }
    seen.add(key);
    return Object.freeze({ relation: link.relation, source });
  }));
}

function causeKindStatus(kind: RunSettlementCauseRecord["kind"]): RunSettlement["status"] {
  return kind === "completion" ? "succeeded" : kind === "failure" ? "failed" : "cancelled";
}

function sameCauseRef(left: RunSettlementCauseRef, right: RunSettlementCauseRef): boolean {
  return left.run.id === right.run.id && left.id === right.id && left.revision === right.revision;
}

function sourceKey(source: RunCauseSourceRef): string {
  return `${source.owner}\0${source.kind}\0${source.id}\0${source.revision ?? ""}\0${source.run?.id ?? ""}`;
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function token(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty canonical string.`);
  }
}

function dateTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
