import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type {
  AppliedPolicyAmendmentRecord,
  TrustedPolicyAmendment,
} from "./PolicyAmendment.js";

export interface PersistentPolicyAmendmentCommit {
  readonly commitId: string;
  readonly recordId: string;
  readonly proposalRef: string;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly amendment: TrustedPolicyAmendment;
  readonly appliedAt: string;
}

export type PersistentPolicyAmendmentCommitFailureCode =
  | "policy_amendment_invalid"
  | "policy_amendment_conflict"
  | "policy_amendment_storage_failed";

export type PersistentPolicyAmendmentCommitResult =
  | {
      readonly kind: "applied";
      readonly record: AppliedPolicyAmendmentRecord;
    }
  | {
      readonly kind: "not_applied";
      readonly code: PersistentPolicyAmendmentCommitFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | {
      readonly kind: "outcome_unknown";
      readonly code: "policy_amendment_commit_outcome_unknown";
      readonly message: string;
    };

export interface PersistentPolicyAmendmentPort {
  commit(
    input: PersistentPolicyAmendmentCommit,
    context: InvocationInterruptionContext,
  ): Promise<PersistentPolicyAmendmentCommitResult>;
}
