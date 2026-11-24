import type { ModelCallableRequest } from "@agent-anything/model-interaction";
import type { ModelPurposeEvidence, NativeModelSourceRef, ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import type { ProtocolModelActivity } from "./ProtocolModelActivity.js";
import type { ProtocolEvidenceCommand, ProtocolEvidencePart, ProtocolEvidenceScope, ProtocolEvidenceRevision, ProtocolEvidencePage,
  ProtocolUsageMerge, ProtocolUsageRetirement } from "./ProtocolEvidenceIndex.js";

/** Immutable bytes, addressed separately from observation and acceptance records. */
export interface ProtocolContentRef {
  readonly id: string;
  readonly activityId: string;
  readonly bytes: number;
  readonly digest: string;
}
export interface ProtocolJournalRecord {
  readonly ref: ProtocolRevisionRef;
  readonly activityId: string;
  readonly operationId: string;
  readonly kind: "dispatch_intent" | "reconciliation_intent" | "owner_checkpoint" | "observation" | "history_disposition" | "native_checkpoint";
  readonly content: ProtocolContentRef;
  readonly source: NativeModelSourceRef | null;
  readonly dependencies: readonly ProtocolRevisionRef[];
}
export interface ProtocolExecutionFence {
  readonly activityId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly controlRevision: number;
}
export interface ProtocolEffectIntent {
  readonly call: ModelCallableRequest;
  readonly owner: string;
}
export interface ProtocolRunCallResponsibility {
  readonly runId:string;
  readonly acceptedIn:ProtocolRevisionRef;
  readonly settledIn:ProtocolRevisionRef|null;
}
export interface ProtocolPendingDelivery {
  readonly id: string;
  readonly recipient: { readonly runId: string; readonly id: string; readonly purpose: string };
  readonly content: ProtocolContentRef;
}
export interface ProtocolPurposeAcceptance {
  readonly evidence: ModelPurposeEvidence;
  readonly result: ProtocolContentRef;
  readonly effects: readonly ProtocolEffectIntent[];
  readonly deliveries: readonly ProtocolPendingDelivery[];
}
export interface ProtocolReconciliationHandoff {
  readonly id:string;
  readonly activityId:string;
  readonly receiver:string;
  readonly checkpoint:ProtocolRevisionRef;
  readonly dependencies:readonly ProtocolContentRef[];
  readonly dueAt:number;
  readonly expiresAt:number;
  readonly disposition:null|{readonly basis:ProtocolRevisionRef;readonly outcome:"resolved"|"unresolved"};
}
/** Shared acceptance orders facts. Native operation policy remains with the Adapter. */
export interface ProtocolObservationReceipt {
  readonly stageId:string;
  readonly receiptId:string;
  readonly limitation:import("./ProtocolObservationWork.js").ProtocolObservationLimitation;
}
export interface ProtocolConnectionRelease {
  readonly bindingId:string;
  readonly observation:ProtocolObservationReceipt;
}
export type ProtocolJournalPart = ProtocolEvidencePart | { readonly owner: "protocol_execution" } & (
  | { readonly kind: "prepare"; readonly proposal: {readonly activity: ProtocolModelActivity; readonly input: ProtocolContentRef;readonly contextInput?:{readonly id:string;readonly digest:string}} }
  | { readonly kind: "claim"; readonly proposal: {readonly activityId:string; readonly expectedEpoch:number} }
  | { readonly kind: "control"; readonly proposal: {readonly activityId:string; readonly expectedRevision:number; readonly cancelled:boolean} }
  | { readonly kind: "require_active"; readonly proposal: {readonly activityId:string;readonly controlRevision:number;readonly record:ProtocolRevisionRef} }
  | { readonly kind: "require_accepted_result"; readonly proposal: {readonly activityId:string;readonly controlRevision:number;readonly record:ProtocolRevisionRef;readonly acceptance:ProtocolRevisionRef} }
  | { readonly kind: "record"; readonly proposal: {readonly record:ProtocolJournalRecord; readonly fence:ProtocolExecutionFence|null} }
  | { readonly kind:"input_refusal"; readonly proposal:{readonly fence:ProtocolExecutionFence;readonly proof:import("./ProtocolInputRejection.js").ProtocolInputRejection;readonly evidence:import("./ProtocolInputRejection.js").ProtocolInputRejectionEvidence} }
  | { readonly kind: "purpose"; readonly proposal: {readonly fence:ProtocolExecutionFence; readonly acceptance:ProtocolPurposeAcceptance} }
  | { readonly kind: "effect_dispatch"; readonly proposal: {readonly fence:ProtocolExecutionFence; readonly callId:string} }
  | { readonly kind: "effect_confirmation"; readonly proposal: {readonly activityId:string; readonly callId:string; readonly dispatchBasis:"intent_recorded"|"not_started"; readonly confirmation:ProtocolRevisionRef; readonly result:ProtocolContentRef; readonly deliveries:readonly ProtocolPendingDelivery[]} }
  | { readonly kind: "received"; readonly proposal: {readonly activityId:string; readonly deliveryId:string; readonly receipt:ProtocolRevisionRef; readonly recipient:ProtocolPendingDelivery["recipient"]} }
  | { readonly kind: "release_retention"; readonly proposal: {readonly fence:ProtocolExecutionFence;readonly nativeBasis:ProtocolRevisionRef} }
  | { readonly kind:"release_connection";readonly proposal:{readonly fence:ProtocolExecutionFence;readonly release:ProtocolConnectionRelease} }
  | { readonly kind:"settle_input_use"; readonly proposal:{readonly activityId:string;readonly input:{readonly id:string;readonly digest:string};readonly nativeBasis:ProtocolRevisionRef} }
  | { readonly kind:"reconciliation_handoff"; readonly proposal:{readonly fence:ProtocolExecutionFence;readonly handoff:ProtocolReconciliationHandoff} }
  | { readonly kind:"reconciliation_close"; readonly proposal:{readonly fence:ProtocolExecutionFence;readonly id:string;readonly disposition:NonNullable<ProtocolReconciliationHandoff["disposition"]>} }
);
export interface ProtocolExecutionState {
  readonly activity: ProtocolModelActivity;
  readonly input: ProtocolContentRef;
  readonly contextInput?:{readonly id:string;readonly digest:string};
  readonly inputRefusal?:import("./ProtocolInputRejection.js").ProtocolInputRejectionEvidence;
  readonly fence: ProtocolExecutionFence;
  readonly cancelled: boolean;
  readonly accepted: ProtocolRevisionRef | null;
  readonly retentionReleased:boolean;
  readonly retentionBasis?:ProtocolRevisionRef;
  readonly connectionRelease?:ProtocolConnectionRelease;
  /** Original Protocol owner closed this input use without claiming receipt or task acceptance. */
  readonly inputUseSettlement?:{readonly basis:ProtocolRevisionRef;readonly acceptanceId:string};
}
export interface ProtocolRetentionStatus {
  readonly state:ProtocolExecutionState;
  readonly pendingEffects:number;
  readonly pendingDeliveries:number;
  readonly pendingHandoffs:number;
  readonly unavailableObservation?:ProtocolObservationReceipt;
}
/** Pre-acceptance identity and a monotone fence, not permission to dispatch. */
export interface ProtocolAdmissionReservation {
  readonly activity:ProtocolModelActivity;
  readonly status:"reserved"|"closed";
  readonly closedBy:ProtocolRevisionRef|null;
}
export interface ProtocolJournalFact {
  readonly sequence:number;
  readonly runId:string;
  readonly activityId:string;
  readonly kind:string;
  readonly identity:string;
  readonly occurredAt:string;
  readonly value:unknown;
}
export interface ProtocolUsageCursor {
  readonly entries:{readonly scopeId:string;readonly key:string}|null;
  readonly entriesComplete:boolean;
  readonly dispatches:{readonly activityId:string;readonly id:string;readonly revision:string}|null;
  readonly dispatchesComplete:boolean;
}
export interface ProtocolUsageSnapshot {
  readonly runId:string;
  readonly boundary:number;
  readonly complete:boolean;
  readonly entries:readonly ProtocolEvidenceRevision[];
  readonly dispatches:readonly ProtocolJournalRecord[];
  readonly next?:ProtocolUsageCursor|null;
}
export type ProtocolJournalCommand =
  | ProtocolEvidenceCommand
  | {readonly kind:"reserve_admission";readonly activity:ProtocolModelActivity}
  | {readonly kind:"admission_reservation";readonly activityId:string;readonly closeIfInactive?:boolean}
  | {readonly kind:"content_begin"; readonly content:ProtocolContentRef}
  | {readonly kind:"content_append"; readonly content:ProtocolContentRef; readonly offset:number; readonly bytesBase64:string}
  | {readonly kind:"content_complete"; readonly content:ProtocolContentRef}
  | {readonly kind:"content_read"; readonly content:ProtocolContentRef; readonly activityId:string; readonly offset:number; readonly length:number}
  | {readonly kind:"state"; readonly activityId:string}
  | {readonly kind:"retention_status"; readonly activityId:string}
  | {readonly kind:"retention_page";readonly runId:string;readonly after:string|null;readonly limit:number}
  | {readonly kind:"usage_snapshot";readonly runId:string;readonly limit:number;readonly ifBoundary?:number;
      readonly expectedBoundary?:number;readonly after?:ProtocolUsageCursor}
  | {readonly kind:"measurement_candidates";readonly runId:string;readonly recipientId:string;readonly compositionDigest:string;readonly key:string;readonly limit:number}
  | {readonly kind:"usage_samples";readonly runId:string;readonly recipientId:string;readonly compositionDigest:string;readonly purpose:ProtocolRevisionRef;readonly limit:number}
  | {readonly kind:"record"; readonly activityId:string; readonly ref:ProtocolRevisionRef}
  | {readonly kind:"acceptance"; readonly activityId:string}
  | {readonly kind:"effect"; readonly activityId:string; readonly callId:string}
  | {readonly kind:"delivery"; readonly activityId:string; readonly id:string}
  | {readonly kind:"facts"; readonly runId:string; readonly after:number; readonly limit:number}
  | {readonly kind:"reconciliation";readonly activityId:string;readonly id:string}
  | {readonly kind:"activity_reconciliation";readonly activityId:string}
  | {readonly kind:"reconciliation_list";readonly receiver:string;readonly after:string|null;readonly limit:number};
export type ProtocolJournalValue = ProtocolContentRef | ProtocolExecutionState | ProtocolRetentionStatus | ProtocolAdmissionReservation | ProtocolUsageSnapshot | {readonly unchangedBoundary:number} | {readonly changedBoundary:number} | ProtocolJournalRecord | ProtocolPurposeAcceptance |
  ProtocolEvidenceScope | ProtocolEvidenceRevision | ProtocolEvidencePage | ProtocolUsageMerge | ProtocolUsageRetirement |
  {readonly bytesBase64:string;readonly next:number|null} |
  {readonly intent:ProtocolEffectIntent;readonly dispatched:boolean;readonly confirmationBasis:"intent_recorded"|"not_started"|"run_execution"|null;readonly confirmation:ProtocolRevisionRef|null;readonly result:ProtocolContentRef|null;readonly deliveries:readonly ProtocolPendingDelivery[];readonly coordination?:ProtocolRunCallResponsibility} |
  {readonly delivery:ProtocolPendingDelivery;readonly receipt:ProtocolRevisionRef|null} |
  readonly ProtocolJournalFact[] | ProtocolReconciliationHandoff | readonly ProtocolReconciliationHandoff[] |
  {readonly states:readonly ProtocolExecutionState[];readonly next:string|null} | null;
export interface ProtocolExecutionJournal { command(command:ProtocolJournalCommand):Promise<ProtocolJournalValue>; }
export interface ProtocolJournalObserver { observe(fact:ProtocolJournalFact):void; }
