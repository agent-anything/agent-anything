import type { OperationBindingRevisionRef, OperationInvocationRef } from "@agent-anything/operation-catalog/identity";
import type { ActionAttemptRef, ActionSettlementRef, ActionSubjectRevisionRef, CanonicalActionRef } from "../subject/index.js";

export type CanonicalActionSettlementStatus =
  | "invalid"
  | "invalidated"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "failed"
  | "partial"
  | "succeeded"
  | "unknown_effect";

export type ActionEffectCertainty = "none" | "confirmed" | "partial" | "unknown";

export interface CanonicalActionSettlement<TPayload = unknown> {
  readonly ref: ActionSettlementRef;
  readonly action: CanonicalActionRef;
  /** Null only when execution settles before a subject revision can be materialized. */
  readonly subject: ActionSubjectRevisionRef | null;
  readonly operationInvocation: OperationInvocationRef;
  readonly binding: OperationBindingRevisionRef;
  readonly status: CanonicalActionSettlementStatus;
  readonly attempts: readonly ActionAttemptRef[];
  readonly effectCertainty: ActionEffectCertainty;
  readonly completionExtent: "none" | "partial" | "complete" | "unknown";
  readonly payload: TPayload | null;
  readonly causeOwner: string | null;
  readonly causeRef: string | null;
  readonly reconciliationRequired: boolean;
  readonly settledAt: string;
}

export type ActionReplayBasis =
  | { readonly kind: "never_dispatched" }
  | { readonly kind: "confirmed_no_effect"; readonly evidenceRef: string }
  | { readonly kind: "revalidated_observation"; readonly observationRef: string }
  | { readonly kind: "external_idempotency"; readonly idempotencyKey: string };

export interface ActionReconciliationLink {
  readonly uncertainAction: CanonicalActionRef;
  readonly reconciliationOperationId: string;
}

export interface ActionCompensationLink {
  readonly settledAction: CanonicalActionRef;
  readonly compensationOperationId: string;
}

export interface CanonicalActionRecordPort {
  append(settlement: CanonicalActionSettlement): Promise<{ readonly recordId: string }>;
}

export interface ActionAuditPort {
  record(event: {
    readonly action: CanonicalActionRef;
    readonly eventKind: string;
    readonly recordRef: string;
    readonly occurredAt: string;
  }): Promise<void>;
}
