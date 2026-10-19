import type { InspectionSubjectRef } from "./InspectionRecord.js";

export type InspectionAdmissionReason = "record_capacity" | "structure_capacity" | "content_capacity" | "invalid_input" | "record_oversized";
export interface InspectionAdmissionIssue {
  readonly reason: InspectionAdmissionReason;
  readonly count: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly samples: readonly {sequence: number | null; subject: InspectionSubjectRef | null}[];
  readonly coalesced: boolean;
}
export interface InspectionIngressHealth {
  readonly revision: number;
  readonly accepted: number;
  readonly dropped: number;
  readonly rejected: number;
  readonly issues: readonly InspectionAdmissionIssue[];
  readonly highWater: {readonly records: number; readonly structureBytes: number; readonly contentBytes: number};
  readonly timings: {readonly admissionMaxMs: number; readonly queueMaxMs: number; readonly acknowledgementMaxMs: number};
}
export interface InspectionBatchReceipt {
  readonly id: string;
  readonly digest: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly persisted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly watermark: number;
  readonly nativeWatermark: number;
  readonly precommitMs: number;
  readonly rejectedOffers: readonly {readonly sequence: number; readonly recordId: string; readonly code: string}[];
}
export type InspectionProjectionReason = "missing_start" | "duplicate_start" | "pairing_capacity" | "export_capacity" |
  "serialization_failed" | "export_failed" | "open_at_closure" | "context_capacity";
export interface InspectionProjectionIssue {
  readonly reason: InspectionProjectionReason;
  readonly count: number;
  readonly recordIds: readonly string[];
  readonly coalesced: boolean;
}
export interface InspectionRecordingProgress {
  readonly ingress: InspectionIngressHealth;
  readonly native: {readonly persisted: number; readonly duplicates: number; readonly rejected: number;
    readonly lastReceipt: InspectionBatchReceipt | null; readonly target: number; readonly transactionMaxMs: number};
  readonly projection: {readonly cursor: number; readonly status: "active" | "failed" | "closed";
    readonly code: string | null; readonly issues: readonly InspectionProjectionIssue[]; readonly sliceMaxMs: number};
  readonly lastFlush?: {readonly id: number; readonly accepted: number; readonly healthRevision: number;
    readonly nativeTarget: number; readonly projectionCursor: number; readonly projection: "settled" | "failed"};
}
export interface InspectionFlushResult {
  readonly barrier: {readonly accepted: number; readonly healthRevision: number};
  readonly native: "settled" | "pending" | "failed" | "unknown";
  readonly projection: "settled" | "pending" | "failed" | "unknown";
  readonly watermark: number | null;
  readonly projectionCursor: number | null;
  readonly unpersisted: number;
  readonly unconfirmed: number;
  readonly code: string | null;
}
export function initialInspectionProgress(): InspectionRecordingProgress {
  return {ingress: {revision: 0, accepted: 0, dropped: 0, rejected: 0, issues: [],
    highWater: {records: 0, structureBytes: 0, contentBytes: 0}, timings: {admissionMaxMs: 0, queueMaxMs: 0, acknowledgementMaxMs: 0}},
    native: {persisted: 0, duplicates: 0, rejected: 0, lastReceipt: null, target: 0, transactionMaxMs: 0},
    projection: {cursor: 0, status: "active", code: null, issues: [], sliceMaxMs: 0}};
}
