import {snapshotExecutionEvidenceRef, executionEvidenceKey, type ExecutionEvidenceRef} from "./ExecutionEvidence.js";

/** An acknowledged metadata handoff, never a grant to read bytes or perform effects. */
export interface ExecutionReferenceTransfer {
  readonly id: string;
  readonly sourceRunId: string;
  readonly recipientRunId: string;
  readonly scope: {readonly kind: "public_run"} | {readonly kind: "references"; readonly references: readonly ExecutionEvidenceRef[]};
  readonly basis: {readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string};
  readonly acceptedAt: string;
}
export interface ExecutionReferenceTransferPort {
  commitExecutionReferenceTransfer(transfer: ExecutionReferenceTransfer): Promise<void>;
  readExecutionReferenceTransfers(recipientRunId: string): Promise<readonly ExecutionReferenceTransfer[]>;
  readRunExecutionReferences(runId: string, after: string | null, limit: number): Promise<ExecutionReferencePage>;
}
export interface ExecutionReferencePage {readonly references: readonly ExecutionEvidenceRef<"execution">[]; readonly next: string | null;}

export function snapshotExecutionReferenceTransfer(input: ExecutionReferenceTransfer): ExecutionReferenceTransfer {
  if (!input || Object.keys(input).length !== 6) invalid();
  for (const key of ["id", "sourceRunId", "recipientRunId", "acceptedAt"] as const) token(input[key]);
  if (input.sourceRunId === input.recipientRunId || new Date(input.acceptedAt).toISOString() !== input.acceptedAt) invalid();
  if (!input.basis || Object.keys(input.basis).length !== 4) invalid();
  for (const value of Object.values(input.basis)) token(value);
  const scope = input.scope;
  if (!scope || scope.kind !== "public_run" && scope.kind !== "references") invalid();
  if (Object.keys(scope).length !== (scope.kind === "public_run" ? 1 : 2)) invalid();
  if (scope.kind === "references" && !Array.isArray(scope.references)) invalid();
  const references = scope.kind === "references" ? scope.references.map(ref => snapshotExecutionEvidenceRef(ref)) : [];
  if (scope.kind === "references" && (!references.length || references.length > 16 || new Set(references.map(executionEvidenceKey)).size !== references.length)) invalid();
  return Object.freeze({...input, basis: Object.freeze({...input.basis}), scope: scope.kind === "public_run" ? Object.freeze({kind: "public_run"}) :
    Object.freeze({kind: "references", references: Object.freeze(references)})});
}
function token(value: unknown): void {if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) invalid();}
function invalid(): never {throw new TypeError("Invalid execution-reference transfer.");}
