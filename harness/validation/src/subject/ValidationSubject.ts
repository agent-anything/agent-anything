import type { RunRef } from "@agent-anything/agent-core/run";
import type {
  ValidationFailure,
  ValidationOwnerRef,
  ValidationRequirementRef,
  ValidationSensitivity,
} from "../definition/index.js";

export interface ValidationSubjectSnapshotRef {
  readonly id: string;
  readonly revision: string;
}

export interface ValidationSubjectStateRef extends ValidationOwnerRef {}

export interface ValidationSubjectScopeEntry {
  readonly key: string;
  readonly value: string;
}

export interface ValidationSubjectCoverage {
  readonly kind: "complete" | "partial";
  readonly ratio: number;
}

export interface ValidationSubjectFingerprint {
  readonly algorithm: string;
  readonly value: string;
  readonly basis: string;
}

export interface ValidationSubjectAdapterRef extends ValidationOwnerRef {}

export interface ValidationSubjectSnapshot {
  readonly ref: ValidationSubjectSnapshotRef;
  readonly run: RunRef;
  readonly owner: string;
  readonly kind: string;
  readonly stateRefs: readonly ValidationSubjectStateRef[];
  readonly capturedAt: string;
  readonly environment: ValidationOwnerRef | null;
  readonly scope: readonly ValidationSubjectScopeEntry[];
  readonly coverage: ValidationSubjectCoverage;
  readonly fingerprint: ValidationSubjectFingerprint;
  readonly sensitivity: ValidationSensitivity;
  readonly audiences: readonly string[];
  readonly adapter: ValidationSubjectAdapterRef;
}

export interface ValidationSubjectCaptureInput {
  readonly run: RunRef;
  readonly requirement: ValidationRequirementRef;
  readonly kind: string;
  readonly requestedSource: ValidationOwnerRef;
}

export type ValidationSubjectCaptureResult =
  | { readonly status: "captured"; readonly snapshot: ValidationSubjectSnapshot }
  | { readonly status: "unavailable" | "invalid" | "failed"; readonly failure: ValidationFailure };

export interface ValidationSubjectAdapter {
  readonly ref: ValidationSubjectAdapterRef;
  readonly subjectKinds: readonly string[];
  capture(input: ValidationSubjectCaptureInput): Promise<ValidationSubjectCaptureResult>;
  rehydrate(ref: ValidationSubjectSnapshotRef): Promise<ValidationSubjectCaptureResult>;
}

export type ValidationSubjectFreshnessOutcome =
  | { readonly status: "current"; readonly snapshot: ValidationSubjectSnapshotRef }
  | {
      readonly status: "stale";
      readonly snapshot: ValidationSubjectSnapshotRef;
      readonly current: ValidationSubjectSnapshotRef;
      readonly change: ValidationOwnerRef;
    }
  | {
      readonly status: "unavailable" | "invalid" | "failed";
      readonly snapshot: ValidationSubjectSnapshotRef;
      readonly failure: ValidationFailure;
    };

export interface ValidationSubjectFreshnessPort {
  checkFreshness(
    snapshot: ValidationSubjectSnapshotRef,
  ): Promise<ValidationSubjectFreshnessOutcome>;
}

export function snapshotValidationSubjectSnapshot(
  input: ValidationSubjectSnapshot,
): ValidationSubjectSnapshot {
  strictRecord(input, "ValidationSubjectSnapshot", [
    "ref", "run", "owner", "kind", "stateRefs", "capturedAt", "environment", "scope",
    "coverage", "fingerprint", "sensitivity", "audiences", "adapter",
  ]);
  strictRecord(input.ref, "ValidationSubjectSnapshot.ref", ["id", "revision"]);
  strictRecord(input.run, "ValidationSubjectSnapshot.run", ["id"]);
  strictRecord(input.coverage, "ValidationSubjectSnapshot.coverage", ["kind", "ratio"]);
  strictRecord(input.fingerprint, "ValidationSubjectSnapshot.fingerprint", [
    "algorithm", "value", "basis",
  ]);
  if (!Array.isArray(input.stateRefs) || input.stateRefs.length === 0) {
    throw new TypeError("ValidationSubjectSnapshot.stateRefs must not be empty.");
  }
  if (!Array.isArray(input.scope)) throw new TypeError("ValidationSubjectSnapshot.scope must be an array.");
  if (input.coverage.kind !== "complete" && input.coverage.kind !== "partial") {
    throw new TypeError("ValidationSubjectSnapshot.coverage.kind is unsupported.");
  }
  ratio(input.coverage.ratio, "ValidationSubjectSnapshot.coverage.ratio");
  if (input.coverage.kind === "complete" && input.coverage.ratio !== 1) {
    throw new TypeError("Complete Validation subject coverage requires ratio 1.");
  }
  if (!["public", "internal", "confidential", "restricted"].includes(input.sensitivity)) {
    throw new TypeError("ValidationSubjectSnapshot.sensitivity is unsupported.");
  }
  const snapshot: ValidationSubjectSnapshot = {
    ...input,
    ref: snapshotRef(input.ref, "ValidationSubjectSnapshot.ref"),
    run: { id: token(input.run.id, "ValidationSubjectSnapshot.run.id") },
    owner: token(input.owner, "ValidationSubjectSnapshot.owner"),
    kind: token(input.kind, "ValidationSubjectSnapshot.kind"),
    stateRefs: unique(
      input.stateRefs.map((item, index) => snapshotOwnerRef(item, `ValidationSubjectSnapshot.stateRefs[${index}]`)),
      (item) => `${item.owner}:${item.kind}:${item.id}@${item.revision}`,
      "ValidationSubjectSnapshot.stateRefs",
    ),
    capturedAt: isoDateTime(input.capturedAt, "ValidationSubjectSnapshot.capturedAt"),
    environment: input.environment === null
      ? null
      : snapshotOwnerRef(input.environment, "ValidationSubjectSnapshot.environment"),
    scope: unique(input.scope.map((item, index) => {
      strictRecord(item, `ValidationSubjectSnapshot.scope[${index}]`, ["key", "value"]);
      return {
        key: token(item.key, `ValidationSubjectSnapshot.scope[${index}].key`),
        value: nonEmpty(item.value, `ValidationSubjectSnapshot.scope[${index}].value`),
      };
    }), (item) => item.key, "ValidationSubjectSnapshot.scope"),
    fingerprint: {
      algorithm: token(input.fingerprint.algorithm, "ValidationSubjectSnapshot.fingerprint.algorithm"),
      value: token(input.fingerprint.value, "ValidationSubjectSnapshot.fingerprint.value"),
      basis: nonEmpty(input.fingerprint.basis, "ValidationSubjectSnapshot.fingerprint.basis"),
    },
    audiences: unique(
      input.audiences.map((item, index) => token(item, `ValidationSubjectSnapshot.audiences[${index}]`)),
      (item) => item,
      "ValidationSubjectSnapshot.audiences",
    ),
    adapter: snapshotOwnerRef(input.adapter, "ValidationSubjectSnapshot.adapter"),
  };
  return deepFreeze(snapshot);
}

function snapshotRef(input: ValidationSubjectSnapshotRef, path: string): ValidationSubjectSnapshotRef {
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotOwnerRef(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path} must be a record.`);
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}

function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) {
    throw new TypeError(`${path} must be a canonical token.`);
  }
  return input;
}

function nonEmpty(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}

function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) {
    throw new TypeError(`${path} must be an ISO date-time.`);
  }
  return input;
}

function ratio(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new TypeError(`${path} must be between 0 and 1.`);
  }
  return input;
}

function unique<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const values = input.map(key);
  if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
