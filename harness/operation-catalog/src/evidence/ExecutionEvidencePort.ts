import type { ExecutionEvidenceRecord, ExecutionEvidenceRef } from "./ExecutionEvidence.js";
import type { CompensationAssociation } from "./CompensationAssociation.js";

/** Host persistence of acknowledged capability facts, independent of Inspector. */
export interface ExecutionEvidenceRecordPort {
  commitExecutionEvidence(record: ExecutionEvidenceRecord): Promise<void>;
  readExecutionEvidence(reference: ExecutionEvidenceRef): Promise<ExecutionEvidenceRecord | null>;
  commitCompensationAssociation(association: CompensationAssociation): Promise<void>;
  readCompensationAssociation(invocationId: string): Promise<CompensationAssociation | null>;
}

/** Trusted delivery ownership, checked in addition to current resource authority. */
export interface ExecutionEvidenceAccessPort {
  canInspect(input: {readonly runId: string; readonly record: ExecutionEvidenceRecord; readonly reference: ExecutionEvidenceRef}): Promise<boolean>;
}

export type ExecutionEvidenceObservation =
  | {readonly kind: "references_transferred"; readonly transfer: import("./ExecutionReferenceTransfer.js").ExecutionReferenceTransfer}
  | {readonly kind: "evidence_committed"; readonly record: ExecutionEvidenceRecord}
  | {readonly kind: "compensation_intent_committed"; readonly association: CompensationAssociation};

export interface ExecutionEvidenceObserver { observe(value: ExecutionEvidenceObservation): void; }
