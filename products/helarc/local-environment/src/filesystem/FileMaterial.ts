import type { ActionAttemptRef, FileBaseline } from "@agent-anything/canonical-action/subject";
import { createFileBaseline } from "@agent-anything/canonical-action/subject";
import { snapshotExecutionEvidenceRef, type ExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";
import { snapshotOperationInvocationRef, type OperationInvocationRef } from "@agent-anything/operation-catalog/identity";

export const FILE_MATERIAL_POLICY = Object.freeze({
  revision: "helarc.file-material.v1", maxFileBytes: 1_000_000, maxStoreBytes: 256 * 1024 * 1024,
  maxConcurrentCaptures: 4, maxManifests: 100_000, chunkBytes: 64 * 1024, readBytes: 64 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000, expiryBatchSize: 128,
});

/** Host/file-owner input, never a model-supplied storage path or read grant. */
export interface FileMaterialPreparation {
  readonly ref: ExecutionEvidenceRef<"material">;
  readonly policyRevision: string;
  readonly runId: string;
  readonly invocation: OperationInvocationRef;
  readonly attempt: ActionAttemptRef;
  readonly target: {readonly canonicalPath: string; readonly rootIdentity: string; readonly ancestryIdentity: string};
  readonly before: FileBaseline;
  readonly byteLength: number;
  readonly readAuthorityRef: string;
  readonly preparedAt: string;
}

export interface FileMaterialRecord {
  readonly preparation: FileMaterialPreparation;
  readonly state: "staging" | "available" | "aborted" | "expired";
  readonly digest: string | null;
  readonly finishedAt: string | null;
  readonly reason: string | null;
  readonly pins: readonly string[];
  readonly expiresAt: string | null;
}

export type FileMaterialReservation =
  | {readonly status: "reserved"; readonly record: FileMaterialRecord}
  | {readonly status: "unavailable"; readonly reason: "file_size_limit" | "store_capacity" | "capture_capacity" | "manifest_capacity"};

export interface FileMaterialRead {
  readonly reference: ExecutionEvidenceRef<"material">;
  readonly offset: number;
  /** Base64 preserves bytes across the existing JSON-safe owner transport. */
  readonly base64: string;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly digest: string;
}

export interface FileMaterialObservation {
  readonly kind: "reserved" | "published" | "aborted" | "pinned" | "released" | "expired";
  readonly record: FileMaterialRecord;
  readonly occurredAt: string;
}
export interface FileMaterialObserver {observe(value: FileMaterialObservation): void;}

/** Access and read authority are enforced by the calling capability, not this persistence port. */
export interface FileMaterialRecordPort {
  reserveFileMaterial(preparation: FileMaterialPreparation): Promise<FileMaterialReservation>;
  appendFileMaterial(reference: ExecutionEvidenceRef<"material">, offset: number, base64: string): Promise<void>;
  publishFileMaterial(reference: ExecutionEvidenceRef<"material">, digest: string, at: string): Promise<FileMaterialRecord>;
  readFileMaterialRecord(reference: ExecutionEvidenceRef<"material">): Promise<FileMaterialRecord | null>;
  readFileMaterialRange(reference: ExecutionEvidenceRef<"material">, offset: number, length: number): Promise<FileMaterialRead>;
  abortFileMaterial(reference: ExecutionEvidenceRef<"material">, reason: string, at: string): Promise<void>;
  pinFileMaterial(reference: ExecutionEvidenceRef<"material">, ownerId: string): Promise<void>;
  releaseFileMaterial(reference: ExecutionEvidenceRef<"material">, ownerId: string, at: string): Promise<void>;
  expireFileMaterials(at: string): Promise<number>;
}

export function snapshotFileMaterialPreparation(input: FileMaterialPreparation): FileMaterialPreparation {
  fields(input, ["ref", "policyRevision", "runId", "invocation", "attempt", "target", "before", "byteLength", "readAuthorityRef", "preparedAt"]);
  const ref = snapshotExecutionEvidenceRef(input.ref, "material");
  if (ref.owner !== "helarc-files" || input.policyRevision !== FILE_MATERIAL_POLICY.revision) invalid();
  fields(input.attempt, ["action", "id", "ordinal"]); fields(input.attempt.action, ["id"]);
  if (!Number.isSafeInteger(input.attempt.ordinal) || input.attempt.ordinal < 1) invalid();
  fields(input.target, ["canonicalPath", "rootIdentity", "ancestryIdentity"]);
  const before = createFileBaseline(input.before);
  if (before.kind === "present" && (before.entryKind !== "file" || !validFileDigest(before.contentDigest))) invalid();
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.before.kind === "absent" && input.byteLength !== 0) invalid();
  date(input.preparedAt);
  return Object.freeze({ref, policyRevision: input.policyRevision, runId: value(input.runId), invocation: snapshotOperationInvocationRef(input.invocation),
    attempt: Object.freeze({id: value(input.attempt.id), action: Object.freeze({id: value(input.attempt.action.id)}), ordinal: input.attempt.ordinal}),
    target: Object.freeze({canonicalPath: value(input.target.canonicalPath), rootIdentity: value(input.target.rootIdentity), ancestryIdentity: value(input.target.ancestryIdentity)}),
    before,
    byteLength: input.byteLength, readAuthorityRef: value(input.readAuthorityRef), preparedAt: input.preparedAt});
}

export function validFileDigest(input: unknown): input is string {return typeof input === "string" && /^sha256:[a-f0-9]{64}$/u.test(input);}
function fields(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) invalid();
}
function value(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.length > 4096 || input.includes("\0")) invalid();
  return input as string;
}
function date(input: string): void {if (!input || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) invalid();}
function invalid(): never {throw new TypeError("Invalid file material preparation.");}
