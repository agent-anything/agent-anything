import type { ValidationAssessment, ValidationCurrentSnapshot } from "../assessment/index.js";
import type { CompletionGateRecord } from "../completion/index.js";
import type { ValidationRequirement, ValidationSpecification } from "../definition/index.js";
import type { CheckAttempt, CheckDefinition, CheckFinding, CheckResult } from "../execution/index.js";
import type { ValidationEvidence } from "../evidence/index.js";
import type { ValidationSubjectSnapshot } from "../subject/index.js";

export type ValidationPersistenceRecord =
  | { readonly kind: "specification"; readonly record: ValidationSpecification }
  | { readonly kind: "requirement"; readonly record: ValidationRequirement }
  | { readonly kind: "subject"; readonly record: ValidationSubjectSnapshot }
  | { readonly kind: "check_definition"; readonly record: CheckDefinition }
  | { readonly kind: "check_attempt"; readonly record: CheckAttempt }
  | { readonly kind: "check_finding"; readonly record: CheckFinding }
  | { readonly kind: "check_result"; readonly record: CheckResult }
  | { readonly kind: "evidence"; readonly record: ValidationEvidence }
  | { readonly kind: "assessment"; readonly record: ValidationAssessment }
  | { readonly kind: "completion_gate"; readonly record: CompletionGateRecord };

export interface ValidationPersistenceReceipt {
  readonly storeOwner: string;
  readonly recordKind: ValidationPersistenceRecord["kind"] | "current_snapshot";
  readonly recordId: string;
  readonly sequence: number;
  readonly storedAt: string;
}

export interface ValidationRecordStorePort {
  append(record: ValidationPersistenceRecord): Promise<ValidationPersistenceReceipt>;
  readAll(runId: string): Promise<readonly ValidationPersistenceRecord[]>;
}

export interface ValidationCurrentSnapshotStorePort {
  commit(
    snapshot: ValidationCurrentSnapshot,
    expectedRevision: number | null,
  ): Promise<ValidationPersistenceReceipt>;
  read(runId: string): Promise<ValidationCurrentSnapshot | null>;
}

export function snapshotValidationPersistenceReceipt(
  input: ValidationPersistenceReceipt,
): ValidationPersistenceReceipt {
  strictRecord(input, "ValidationPersistenceReceipt", [
    "storeOwner", "recordKind", "recordId", "sequence", "storedAt",
  ]);
  if (!RECORD_KINDS.includes(input.recordKind)) {
    throw new TypeError("ValidationPersistenceReceipt.recordKind is unsupported.");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("ValidationPersistenceReceipt.sequence must be positive.");
  }
  return Object.freeze({
    storeOwner: token(input.storeOwner, "ValidationPersistenceReceipt.storeOwner"),
    recordKind: input.recordKind,
    recordId: token(input.recordId, "ValidationPersistenceReceipt.recordId"),
    sequence: input.sequence,
    storedAt: isoDateTime(input.storedAt, "ValidationPersistenceReceipt.storedAt"),
  });
}

const RECORD_KINDS: readonly ValidationPersistenceReceipt["recordKind"][] = [
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
