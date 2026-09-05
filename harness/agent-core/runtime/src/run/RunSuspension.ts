import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunCauseSourceRef } from "./RunSettlement.js";

export type RunSuspensionCode =
  | "controller_stop_requested"
  | "completion_gate_feedback_exhausted";

export interface RunSuspensionRef {
  readonly run: RunRef;
  readonly id: string;
  readonly revision: string;
}

export interface RunSuspension {
  readonly ref: RunSuspensionRef;
  readonly code: RunSuspensionCode;
  readonly source: RunCauseSourceRef;
  readonly reason: string;
  readonly runRevision: number;
  readonly suspendedAt: string;
}

export interface RunResumeRequestInput {
  readonly id: string;
  readonly expectedRunRevision: number;
  readonly suspension: RunSuspensionRef;
  readonly origin: "user" | "host" | "model";
  readonly reason: string;
}

export interface RunResumeRequest extends RunResumeRequestInput {
  readonly run: RunRef;
  readonly requestedAt: string;
}

export type RunResumeRejectionCode =
  | "resume_invalid"
  | "run_not_suspended"
  | "run_revision_stale"
  | "suspension_stale"
  | "run_cancelling"
  | "run_settled";

export type RunResumeReceipt =
  | {
      readonly status: "accepted";
      readonly request: RunResumeRequest;
      readonly currentRunRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly code: RunResumeRejectionCode;
      readonly requestId: string;
      readonly currentRunRevision: number;
    };

export function snapshotRunResumeRequestInput(
  input: RunResumeRequestInput,
): RunResumeRequestInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Run resume input must be an object.");
  }
  assertExactKeys(input, [
    "id",
    "expectedRunRevision",
    "suspension",
    "origin",
    "reason",
  ], "Run resume input");
  const id = identity(input.id, "id");
  if (!Number.isSafeInteger(input.expectedRunRevision) || input.expectedRunRevision < 0) {
    throw new TypeError("Run resume expectedRunRevision must be a non-negative integer.");
  }
  if (input.suspension === null || typeof input.suspension !== "object") {
    throw new TypeError("Run resume suspension must be an object.");
  }
  assertExactKeys(input.suspension, ["run", "id", "revision"], "Run resume suspension");
  if (input.suspension.run === null || typeof input.suspension.run !== "object") {
    throw new TypeError("Run resume suspension run must be an object.");
  }
  assertExactKeys(input.suspension.run, ["id"], "Run resume suspension run");
  if (input.origin !== "user" && input.origin !== "host" && input.origin !== "model") {
    throw new TypeError("Run resume origin is invalid.");
  }
  if (
    typeof input.reason !== "string" ||
    input.reason.trim().length === 0 ||
    input.reason.trim().length > 500
  ) {
    throw new TypeError("Run resume reason must be bounded non-empty text.");
  }
  return Object.freeze({
    id,
    expectedRunRevision: input.expectedRunRevision,
    suspension: Object.freeze({
      run: Object.freeze({ id: identity(input.suspension.run.id, "suspension.run.id") }),
      id: identity(input.suspension.id, "suspension.id"),
      revision: identity(input.suspension.revision, "suspension.revision"),
    }),
    origin: input.origin,
    reason: input.reason.trim(),
  });
}

export function sameRunSuspensionRef(left: RunSuspensionRef, right: RunSuspensionRef): boolean {
  return left.run.id === right.run.id && left.id === right.id && left.revision === right.revision;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError(`Run resume ${field} must be an identity.`);
  }
  return value;
}

function assertExactKeys(
  value: object,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} contains unsupported fields.`);
  }
}
