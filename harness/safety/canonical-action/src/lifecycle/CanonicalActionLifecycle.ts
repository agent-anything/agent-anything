import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { CanonicalActionSettlement } from "../settlement/index.js";
import type {
  ActionAttemptRef,
  ActionSubjectRevisionRef,
  CanonicalActionRef,
  CanonicalActionSubjectRevision,
} from "../subject/index.js";

export type CanonicalActionLifecycle =
  | "reserved"
  | "preparing"
  | "prepared"
  | "assessing"
  | "awaiting_approval"
  | "ready"
  | "revalidating"
  | "attempting"
  | "retry_delay"
  | "settled";

export interface ActionDispatchClaim {
  readonly id: string;
  readonly subject: ActionSubjectRevisionRef;
  readonly attempt: ActionAttemptRef;
  readonly planFingerprint: string;
  readonly claimedAt: string;
}

export interface CanonicalActionState<TPayload = unknown> {
  readonly revision: number;
  readonly action: CanonicalActionRef;
  readonly parentRunAction: RunActionRef | null;
  readonly lifecycle: CanonicalActionLifecycle;
  readonly subjects: readonly CanonicalActionSubjectRevision[];
  readonly currentSubject: ActionSubjectRevisionRef | null;
  readonly attempts: readonly ActionAttemptRef[];
  readonly activeDispatchClaim: ActionDispatchClaim | null;
  readonly settlement: CanonicalActionSettlement<TPayload> | null;
}

export type CanonicalActionTransitionKind =
  | "begin_preparation"
  | "record_subject"
  | "begin_assessment"
  | "await_approval"
  | "mark_ready"
  | "begin_revalidation"
  | "begin_retry_delay";

export interface CanonicalActionTransitionProposal {
  readonly expectedRevision: number;
  readonly kind: CanonicalActionTransitionKind;
  readonly subject?: CanonicalActionSubjectRevision;
}

export interface ActionDispatchClaimInput {
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly attemptId: string;
  readonly planFingerprint: string;
  readonly claimedAt: string;
}

export interface CanonicalActionCommitReceipt {
  readonly action: CanonicalActionRef;
  readonly previousRevision: number;
  readonly revision: number;
  readonly lifecycle: CanonicalActionLifecycle;
}

export interface CanonicalActionCommitPort<TPayload = unknown> {
  transition(proposal: CanonicalActionTransitionProposal): Promise<CanonicalActionCommitReceipt>;
  claimDispatch(input: ActionDispatchClaimInput): Promise<CanonicalActionCommitReceipt>;
  settle(input: {
    readonly expectedRevision: number;
    readonly settlement: CanonicalActionSettlement<TPayload>;
  }): Promise<CanonicalActionCommitReceipt>;
}
