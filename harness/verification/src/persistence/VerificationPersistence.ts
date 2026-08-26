import type { VerificationAssessment, VerificationCurrentSnapshot } from "../assessment/index.js";
import type { CompletionGateRecord } from "../completion/index.js";
import type { VerificationRequirement, VerificationSpecification } from "../definition/index.js";
import type { CheckAttempt, CheckDefinition, CheckFinding, CheckResult } from "../execution/index.js";
import type { VerificationEvidence } from "../evidence/index.js";
import type { VerificationSubjectSnapshot } from "../subject/index.js";

export type VerificationPersistenceRecord =
  | { readonly kind: "specification"; readonly record: VerificationSpecification }
  | { readonly kind: "requirement"; readonly record: VerificationRequirement }
  | { readonly kind: "subject"; readonly record: VerificationSubjectSnapshot }
  | { readonly kind: "check_definition"; readonly record: CheckDefinition }
  | { readonly kind: "check_attempt"; readonly record: CheckAttempt }
  | { readonly kind: "check_finding"; readonly record: CheckFinding }
  | { readonly kind: "check_result"; readonly record: CheckResult }
  | { readonly kind: "evidence"; readonly record: VerificationEvidence }
  | { readonly kind: "assessment"; readonly record: VerificationAssessment }
  | { readonly kind: "completion_gate"; readonly record: CompletionGateRecord };

export interface VerificationPersistenceReceipt {
  readonly storeOwner: string;
  readonly recordKind: VerificationPersistenceRecord["kind"] | "current_snapshot";
  readonly recordId: string;
  readonly sequence: number;
  readonly storedAt: string;
}

export interface VerificationRecordStorePort {
  append(record: VerificationPersistenceRecord): Promise<VerificationPersistenceReceipt>;
  readAll(runId: string): Promise<readonly VerificationPersistenceRecord[]>;
}

export interface VerificationCurrentSnapshotStorePort {
  commit(
    snapshot: VerificationCurrentSnapshot,
    expectedRevision: number | null,
  ): Promise<VerificationPersistenceReceipt>;
  read(runId: string): Promise<VerificationCurrentSnapshot | null>;
}

export function snapshotVerificationPersistenceReceipt(
  input: VerificationPersistenceReceipt,
): VerificationPersistenceReceipt {
  strictRecord(input, "VerificationPersistenceReceipt", [
    "storeOwner", "recordKind", "recordId", "sequence", "storedAt",
  ]);
  if (!RECORD_KINDS.includes(input.recordKind)) {
    throw new TypeError("VerificationPersistenceReceipt.recordKind is unsupported.");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("VerificationPersistenceReceipt.sequence must be positive.");
  }
  return Object.freeze({
    storeOwner: token(input.storeOwner, "VerificationPersistenceReceipt.storeOwner"),
    recordKind: input.recordKind,
    recordId: token(input.recordId, "VerificationPersistenceReceipt.recordId"),
    sequence: input.sequence,
    storedAt: isoDateTime(input.storedAt, "VerificationPersistenceReceipt.storedAt"),
  });
}

const RECORD_KINDS: readonly VerificationPersistenceReceipt["recordKind"][] = [
  "specification", "requirement", "subject", "check_definition", "check_attempt",
  "check_finding", "check_result", "evidence", "assessment", "completion_gate", "current_snapshot",
];

function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path} must be a record.`);
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}
function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) throw new TypeError(`${path} must be a canonical token.`);
  return input;
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
