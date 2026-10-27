import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/control";
import type { ApprovalCategory } from "../approval/ApprovalCategory.js";
import type {
  CanonicalAdditionalPermissions,
  GrantedPermissions,
} from "../approval/PermissionDelta.js";

export interface ApprovalApplicabilityKey {
  readonly category: ApprovalCategory;
  readonly value: string;
}

export interface ValidatedActionAuthorizationBasis {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly sourceRequestId: string;
  readonly grantedPermissions: GrantedPermissions | null;
  readonly validatedAt: string;
}

export interface ActionApprovalCoverage {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly sourceRequestId: string;
  readonly grantedPermissions: GrantedPermissions | null;
  readonly status: "available" | "consumed" | "invalidated";
  readonly createdAt: string;
}

export interface RunPermissionGrant {
  readonly id: string;
  readonly runId: string;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly permissions: GrantedPermissions;
  readonly createdAt: string;
}

export interface SessionAuthorizationScope {
  readonly hostSessionId: string;
  readonly authorityContextKey: string;
  readonly workspaceId: string | null;
  readonly identityId: string | null;
  readonly environmentId: string;
}

export interface SessionAuthorizationProposal {
  readonly proposalRef: string;
  readonly context: SessionAuthorizationScope;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly [
    ApprovalApplicabilityKey,
    ...ApprovalApplicabilityKey[],
  ];
  readonly defaultGrantedPermissions: CanonicalAdditionalPermissions | null;
}

export interface SessionAuthorizationBasis extends SessionAuthorizationScope {
  readonly id: string;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly [
    ApprovalApplicabilityKey,
    ...ApprovalApplicabilityKey[],
  ];
  readonly grantedPermissions: GrantedPermissions | null;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly createdAt: string;
}

export interface SessionAuthorizationBasisInput extends SessionAuthorizationScope {
  readonly id: string;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
  readonly grantedPermissions: CanonicalAdditionalPermissions | null;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly createdAt: string;
}

export interface SessionAuthorizationLookup {
  readonly context: SessionAuthorizationScope;
  readonly category: ApprovalCategory | null;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
}

export interface SessionAuthorizationCommit {
  readonly commitId: string;
  readonly record: SessionAuthorizationBasis;
}

export type SessionAuthorizationCommitFailureCode =
  | "session_authority_invalid"
  | "session_authority_conflict"
  | "session_authority_storage_failed";

export type SessionAuthorizationCommitResult =
  | { readonly kind: "applied"; readonly record: SessionAuthorizationBasis }
  | {
      readonly kind: "not_applied";
      readonly code: SessionAuthorizationCommitFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | {
      readonly kind: "outcome_unknown";
      readonly code: "session_authority_commit_outcome_unknown";
      readonly message: string;
    };

export interface SessionAuthorizationStore {
  listApplicable(
    input: SessionAuthorizationLookup,
    context: InvocationInterruptionContext,
  ): Promise<readonly SessionAuthorizationBasis[]>;

  commit(
    input: SessionAuthorizationCommit,
    context: InvocationInterruptionContext,
  ): Promise<SessionAuthorizationCommitResult>;
}

export function createActionApprovalCoverage(
  authority: ValidatedActionAuthorizationBasis,
): ActionApprovalCoverage {
  return deepFreeze({
    id: authority.id,
    runId: authority.runId,
    actionId: authority.actionId,
    actionFingerprint: authority.actionFingerprint,
    sourceRequestId: authority.sourceRequestId,
    grantedPermissions: authority.grantedPermissions,
    status: "available",
    createdAt: authority.validatedAt,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
