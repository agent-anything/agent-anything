import type { RunRef } from "@agent-anything/agent-core/run";
import type {
  VerificationFailure,
  VerificationOwnerRef,
  VerificationRequirementRef,
  VerificationSensitivity,
} from "../definition/index.js";

export interface VerificationSubjectSnapshotRef {
  readonly id: string;
  readonly revision: string;
}

export interface VerificationSubjectStateRef extends VerificationOwnerRef {}

export interface VerificationSubjectScopeEntry {
  readonly key: string;
  readonly value: string;
}

export interface VerificationSubjectCoverage {
  readonly kind: "complete" | "partial";
  readonly ratio: number;
}

export interface VerificationSubjectFingerprint {
  readonly algorithm: string;
  readonly value: string;
  readonly basis: string;
}

export interface VerificationSubjectAdapterRef extends VerificationOwnerRef {}

export interface VerificationSubjectSnapshot {
  readonly ref: VerificationSubjectSnapshotRef;
  readonly run: RunRef;
  readonly owner: string;
  readonly kind: string;
  readonly stateRefs: readonly VerificationSubjectStateRef[];
  readonly capturedAt: string;
  readonly environment: VerificationOwnerRef | null;
  readonly scope: readonly VerificationSubjectScopeEntry[];
  readonly coverage: VerificationSubjectCoverage;
  readonly fingerprint: VerificationSubjectFingerprint;
  readonly sensitivity: VerificationSensitivity;
  readonly audiences: readonly string[];
  readonly adapter: VerificationSubjectAdapterRef;
}

export interface VerificationSubjectCaptureInput {
  readonly run: RunRef;
  readonly requirement: VerificationRequirementRef;
  readonly kind: string;
  readonly requestedSource: VerificationOwnerRef;
}

export type VerificationSubjectCaptureResult =
  | { readonly status: "captured"; readonly snapshot: VerificationSubjectSnapshot }
  | { readonly status: "unavailable" | "invalid" | "failed"; readonly failure: VerificationFailure };

export interface VerificationSubjectAdapter {
  readonly ref: VerificationSubjectAdapterRef;
  readonly subjectKinds: readonly string[];
  capture(
    input: VerificationSubjectCaptureInput,
    interruption: import("@agent-anything/agent-core/control").InvocationInterruptionContext,
  ): Promise<VerificationSubjectCaptureResult>;
  rehydrate(
    ref: VerificationSubjectSnapshotRef,
    interruption: import("@agent-anything/agent-core/control").InvocationInterruptionContext,
  ): Promise<VerificationSubjectCaptureResult>;
}

export type VerificationSubjectFreshnessOutcome =
  | { readonly status: "current"; readonly snapshot: VerificationSubjectSnapshotRef }
  | {
      readonly status: "stale";
      readonly snapshot: VerificationSubjectSnapshotRef;
      readonly current: VerificationSubjectSnapshotRef;
      readonly change: VerificationOwnerRef;
    }
  | {
      readonly status: "unavailable" | "invalid" | "failed";
      readonly snapshot: VerificationSubjectSnapshotRef;
      readonly failure: VerificationFailure;
    };

export interface VerificationSubjectFreshnessPort {
  checkFreshness(
    snapshot: VerificationSubjectSnapshotRef,
    interruption: import("@agent-anything/agent-core/control").InvocationInterruptionContext,
  ): Promise<VerificationSubjectFreshnessOutcome>;
}

export function snapshotVerificationSubjectSnapshot(
  input: VerificationSubjectSnapshot,
): VerificationSubjectSnapshot {
  strictRecord(input, "VerificationSubjectSnapshot", [
    "ref", "run", "owner", "kind", "stateRefs", "capturedAt", "environment", "scope",
    "coverage", "fingerprint", "sensitivity", "audiences", "adapter",
  ]);
  strictRecord(input.ref, "VerificationSubjectSnapshot.ref", ["id", "revision"]);
  strictRecord(input.run, "VerificationSubjectSnapshot.run", ["id"]);
  strictRecord(input.coverage, "VerificationSubjectSnapshot.coverage", ["kind", "ratio"]);
  strictRecord(input.fingerprint, "VerificationSubjectSnapshot.fingerprint", [
    "algorithm", "value", "basis",
  ]);
  if (!Array.isArray(input.stateRefs) || input.stateRefs.length === 0) {
    throw new TypeError("VerificationSubjectSnapshot.stateRefs must not be empty.");
  }
  if (!Array.isArray(input.scope)) throw new TypeError("VerificationSubjectSnapshot.scope must be an array.");
  if (input.coverage.kind !== "complete" && input.coverage.kind !== "partial") {
    throw new TypeError("VerificationSubjectSnapshot.coverage.kind is unsupported.");
  }
  ratio(input.coverage.ratio, "VerificationSubjectSnapshot.coverage.ratio");
  if (input.coverage.kind === "complete" && input.coverage.ratio !== 1) {
    throw new TypeError("Complete Verification subject coverage requires ratio 1.");
  }
  if (!["public", "internal", "confidential", "restricted"].includes(input.sensitivity)) {
    throw new TypeError("VerificationSubjectSnapshot.sensitivity is unsupported.");
  }
  const snapshot: VerificationSubjectSnapshot = {
    ...input,
    ref: snapshotRef(input.ref, "VerificationSubjectSnapshot.ref"),
    run: { id: token(input.run.id, "VerificationSubjectSnapshot.run.id") },
    owner: token(input.owner, "VerificationSubjectSnapshot.owner"),
    kind: token(input.kind, "VerificationSubjectSnapshot.kind"),
    stateRefs: unique(
      input.stateRefs.map((item, index) => snapshotOwnerRef(item, `VerificationSubjectSnapshot.stateRefs[${index}]`)),
      (item) => `${item.owner}:${item.kind}:${item.id}@${item.revision}`,
      "VerificationSubjectSnapshot.stateRefs",
    ),
    capturedAt: isoDateTime(input.capturedAt, "VerificationSubjectSnapshot.capturedAt"),
    environment: input.environment === null
      ? null
      : snapshotOwnerRef(input.environment, "VerificationSubjectSnapshot.environment"),
    scope: unique(input.scope.map((item, index) => {
      strictRecord(item, `VerificationSubjectSnapshot.scope[${index}]`, ["key", "value"]);
      return {
        key: token(item.key, `VerificationSubjectSnapshot.scope[${index}].key`),
        value: nonEmpty(item.value, `VerificationSubjectSnapshot.scope[${index}].value`),
      };
    }), (item) => item.key, "VerificationSubjectSnapshot.scope"),
    fingerprint: {
      algorithm: token(input.fingerprint.algorithm, "VerificationSubjectSnapshot.fingerprint.algorithm"),
      value: token(input.fingerprint.value, "VerificationSubjectSnapshot.fingerprint.value"),
      basis: nonEmpty(input.fingerprint.basis, "VerificationSubjectSnapshot.fingerprint.basis"),
    },
    audiences: unique(
      input.audiences.map((item, index) => token(item, `VerificationSubjectSnapshot.audiences[${index}]`)),
      (item) => item,
      "VerificationSubjectSnapshot.audiences",
    ),
    adapter: snapshotOwnerRef(input.adapter, "VerificationSubjectSnapshot.adapter"),
  };
  return deepFreeze(snapshot);
}

function snapshotRef(input: VerificationSubjectSnapshotRef, path: string): VerificationSubjectSnapshotRef {
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotOwnerRef(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
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
