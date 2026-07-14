import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { ApprovalCategory } from "../approval/ApprovalCategory.js";
import type {
  CanonicalAdditionalPermissions,
  GrantedPermissions,
} from "../approval/PermissionDelta.js";

export interface ApprovalApplicabilityKey {
  readonly category: ApprovalCategory;
  readonly value: string;
}

export interface ValidatedActionAuthority {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly sourceRequestId: string;
  readonly grantedPermissions: GrantedPermissions | null;
  readonly validatedAt: ISODateTimeString;
}

export interface ActionApprovalCoverage {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly sourceRequestId: string;
  readonly grantedPermissions: GrantedPermissions | null;
  readonly status: "available" | "consumed" | "invalidated";
  readonly createdAt: ISODateTimeString;
}

export interface RunPermissionGrant {
  readonly id: string;
  readonly runId: string;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly permissions: GrantedPermissions;
  readonly createdAt: ISODateTimeString;
}

export interface SessionAuthorityContext {
  readonly hostSessionId: string;
  readonly authorityContextKey: string;
  readonly workspaceId: string;
  readonly identityId: string | null;
  readonly environmentId: string;
}

export interface SessionAuthorityProposal {
  readonly proposalRef: string;
  readonly context: SessionAuthorityContext;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly [
    ApprovalApplicabilityKey,
    ...ApprovalApplicabilityKey[],
  ];
  readonly defaultGrantedPermissions: CanonicalAdditionalPermissions | null;
}

export interface SessionAuthorityRecord extends SessionAuthorityContext {
  readonly id: string;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly [
    ApprovalApplicabilityKey,
    ...ApprovalApplicabilityKey[],
  ];
  readonly grantedPermissions: GrantedPermissions | null;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly createdAt: ISODateTimeString;
}

export interface SessionAuthorityRecordInput extends SessionAuthorityContext {
  readonly id: string;
  readonly category: ApprovalCategory;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
  readonly grantedPermissions: CanonicalAdditionalPermissions | null;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly createdAt: ISODateTimeString;
}

export interface SessionAuthorityLookup {
  readonly context: SessionAuthorityContext;
  readonly category: ApprovalCategory | null;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
}

export interface SessionAuthorityCommit {
  readonly commitId: string;
  readonly record: SessionAuthorityRecord;
}

export type SessionAuthorityCommitFailureCode =
  | "session_authority_invalid"
  | "session_authority_conflict"
  | "session_authority_storage_failed";

export type SessionAuthorityCommitResult =
  | { readonly kind: "applied"; readonly record: SessionAuthorityRecord }
  | {
      readonly kind: "not_applied";
      readonly code: SessionAuthorityCommitFailureCode;
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

export interface SessionAuthorityPort {
  listApplicable(
    input: SessionAuthorityLookup,
  ): Promise<readonly SessionAuthorityRecord[]>;

  commit(
    input: SessionAuthorityCommit,
    context: InvocationInterruptionContext,
  ): Promise<SessionAuthorityCommitResult>;
}

export function createActionApprovalCoverage(
  authority: ValidatedActionAuthority,
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
