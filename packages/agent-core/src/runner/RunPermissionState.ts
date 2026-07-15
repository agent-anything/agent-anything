import type { AppliedPolicyAmendmentRecord } from "@agent-anything/governance";
import {
  createApprovalRequest,
  projectControllerPermissionProfile,
  type ActionApprovalCoverage,
  type ApprovalRecord,
  type ApprovalRequirement,
  type ApprovalRequest,
  type ApprovalsReviewer,
  type ControllerPermissionProfileProjection,
  type RunPermissionGrant,
  type SessionAuthorityContext,
  type SessionAuthorityRecord,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { ResolvedRunPermissionConfig } from "./RunPermissionConfig.js";
import { isReviewCapablePolicy } from "./RunPermissionConfig.js";

export interface ApprovalFingerprintRequestCount {
  readonly actionFingerprint: string;
  readonly count: number;
}

export interface ApprovalCounters {
  readonly totalRequests: number;
  readonly requestsByActionFingerprint: readonly ApprovalFingerprintRequestCount[];
  readonly consecutiveDeclines: number;
  readonly consecutiveReviewFailures: number;
  readonly lastPendingVersion: number;
}

interface PendingApprovalBase {
  readonly request: ApprovalRequest;
  readonly reviewerBindingId: string;
  readonly reviewer: ApprovalsReviewer;
  readonly reviewOperationId: string;
  readonly version: number;
  readonly createdAt: ISODateTimeString;
}

export type PendingApproval =
  | (PendingApprovalBase & { readonly phase: "reviewing" })
  | (PendingApprovalBase & {
      readonly phase: "applying_authority";
      readonly validatedDecision: ValidatedApprovalDecision;
      readonly authorityOperationId: string;
    });

export interface RunPermissionState {
  readonly pendingApproval: PendingApproval | null;
  readonly approvalRecords: readonly ApprovalRecord[];
  readonly actionCoverage: readonly ActionApprovalCoverage[];
  readonly runPermissionGrants: readonly RunPermissionGrant[];
  readonly sessionAuthorityRecords: readonly SessionAuthorityRecord[];
  readonly appliedPolicyAmendments: readonly AppliedPolicyAmendmentRecord[];
  readonly counters: ApprovalCounters;
}

export interface EffectivePermissionContext {
  readonly profile: ResolvedRunPermissionConfig["permissionProfile"];
  readonly runPermissionGrants: readonly RunPermissionGrant[];
  readonly sessionAuthorityRecords: readonly SessionAuthorityRecord[];
  readonly appliedPolicyAmendments: readonly AppliedPolicyAmendmentRecord[];
}

export interface PermissionContextProjection {
  readonly profile: ControllerPermissionProfileProjection;
  readonly authority: {
    readonly hasAdditionalFileSystemRead: boolean;
    readonly hasAdditionalFileSystemWrite: boolean;
    readonly hasAdditionalNetwork: boolean;
    readonly actionCoverageCount: number;
    readonly runGrantCount: number;
    readonly sessionAuthorityCount: number;
    readonly policyAmendmentCount: number;
  };
  readonly approval: {
    readonly canRequest: boolean;
    readonly reviewer: ApprovalsReviewer | null;
    readonly pending: boolean;
    readonly requestsRemaining: number;
  };
}

export type RunPermissionLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export function createInitialRunPermissionState(
  config: ResolvedRunPermissionConfig,
): RunPermissionState & { readonly pendingApproval: null } {
  return deepFreeze({
    pendingApproval: null,
    approvalRecords: [],
    actionCoverage: [],
    runPermissionGrants: [],
    sessionAuthorityRecords: [
      ...(config.sessionAuthority?.initialRecords ?? []),
    ],
    appliedPolicyAmendments: [],
    counters: {
      totalRequests: 0,
      requestsByActionFingerprint: [],
      consecutiveDeclines: 0,
      consecutiveReviewFailures: 0,
      lastPendingVersion: 0,
    },
  });
}

export function deriveEffectivePermissionContext(
  config: ResolvedRunPermissionConfig,
  state: RunPermissionState,
): EffectivePermissionContext {
  const sessionAuthorityRecords = config.sessionAuthority === null
    ? []
    : state.sessionAuthorityRecords.filter((record) =>
      sameSessionContext(record, config.sessionAuthority!.context));
  return Object.freeze({
    profile: config.permissionProfile,
    runPermissionGrants: Object.freeze([...state.runPermissionGrants]),
    sessionAuthorityRecords: Object.freeze(sessionAuthorityRecords),
    appliedPolicyAmendments: Object.freeze([...state.appliedPolicyAmendments]),
  });
}

export function projectPermissionContext(
  config: ResolvedRunPermissionConfig,
  state: RunPermissionState,
): PermissionContextProjection {
  const effective = deriveEffectivePermissionContext(config, state);
  const permissionSets = [
    ...effective.runPermissionGrants.map((grant) => grant.permissions),
    ...effective.sessionAuthorityRecords.flatMap((record) =>
      record.grantedPermissions === null ? [] : [record.grantedPermissions]),
  ];
  const canRequest =
    config.reviewer !== null &&
    isReviewCapablePolicy(config.approvalPolicy) &&
    state.counters.totalRequests < config.approvalLimits.maxRequestsPerRun;

  return deepFreeze({
    profile: projectControllerPermissionProfile(
      config.permissionProfile,
      canRequest,
    ),
    authority: {
      hasAdditionalFileSystemRead: permissionSets.some(
        (permissions) => (permissions.fileSystem?.read?.length ?? 0) > 0,
      ),
      hasAdditionalFileSystemWrite: permissionSets.some(
        (permissions) => (permissions.fileSystem?.write?.length ?? 0) > 0,
      ),
      hasAdditionalNetwork: permissionSets.some(
        (permissions) => permissions.network?.enabled === true,
      ),
      actionCoverageCount: state.actionCoverage.filter(
        (coverage) => coverage.status === "available",
      ).length,
      runGrantCount: effective.runPermissionGrants.length,
      sessionAuthorityCount: effective.sessionAuthorityRecords.length,
      policyAmendmentCount: effective.appliedPolicyAmendments.length,
    },
    approval: {
      canRequest,
      reviewer: config.reviewer?.kind ?? null,
      pending: state.pendingApproval !== null,
      requestsRemaining: Math.max(
        0,
        config.approvalLimits.maxRequestsPerRun - state.counters.totalRequests,
      ),
    },
  });
}

export function assertRunPermissionStateInvariant(
  state: RunPermissionState,
  lifecycleStatus: RunPermissionLifecycleStatus,
): void {
  if (!state || typeof state !== "object") {
    throw new TypeError("RunPermissionState must be an object.");
  }
  if (lifecycleStatus === "waiting_for_approval") {
    if (state.pendingApproval === null) {
      throw new TypeError("A waiting Run requires exactly one PendingApproval.");
    }
    assertPendingApproval(state.pendingApproval);
    if (state.pendingApproval.version !== state.counters.lastPendingVersion) {
      throw new TypeError(
        "PendingApproval.version must equal ApprovalCounters.lastPendingVersion.",
      );
    }
  } else if (state.pendingApproval !== null) {
    throw new TypeError(
      `Run lifecycle '${lifecycleStatus}' cannot retain PendingApproval.`,
    );
  }
  assertCounters(state.counters);
  for (const field of [
    "approvalRecords",
    "actionCoverage",
    "runPermissionGrants",
    "sessionAuthorityRecords",
    "appliedPolicyAmendments",
  ] as const) {
    if (!Array.isArray(state[field])) {
      throw new TypeError(`RunPermissionState.${field} must be an array.`);
    }
  }
}

function assertPendingApproval(pending: PendingApproval): void {
  if (pending.phase !== "reviewing" && pending.phase !== "applying_authority") {
    throw new TypeError("PendingApproval.phase is unsupported.");
  }
  for (const [field, value] of [
    ["reviewerBindingId", pending.reviewerBindingId],
    ["reviewOperationId", pending.reviewOperationId],
    ["createdAt", pending.createdAt],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`PendingApproval.${field} must be non-empty.`);
    }
  }
  if (!Number.isSafeInteger(pending.version) || pending.version <= 0) {
    throw new TypeError("PendingApproval.version must be a positive integer.");
  }
  if (pending.reviewer !== "user" && pending.reviewer !== "auto_review") {
    throw new TypeError("PendingApproval.reviewer is unsupported.");
  }
  if (
    pending.phase === "applying_authority" &&
    (typeof pending.authorityOperationId !== "string" ||
      pending.authorityOperationId.trim().length === 0)
  ) {
    throw new TypeError(
      "An applying PendingApproval requires an authority operation id.",
    );
  }
  const request = pending.request;
  if (!request || typeof request !== "object") {
    throw new TypeError("PendingApproval.request must be a valid ApprovalRequest.");
  }
  createApprovalRequest({
    id: request.id,
    createdAt: request.createdAt,
    requirement: {
      category: request.category,
      subject: request.subject,
      reason: request.reason,
      payload: request.payload,
      decisionOptions: request.decisionOptions,
      trustedProposals: request.trustedProposals,
      deadlineAt: request.deadlineAt,
      metadata: request.metadata,
    } as ApprovalRequirement,
  });
}

function assertCounters(counters: ApprovalCounters): void {
  for (const field of [
    "totalRequests",
    "consecutiveDeclines",
    "consecutiveReviewFailures",
    "lastPendingVersion",
  ] as const) {
    if (!Number.isSafeInteger(counters[field]) || counters[field] < 0) {
      throw new TypeError(`ApprovalCounters.${field} must be non-negative.`);
    }
  }
  if (!Array.isArray(counters.requestsByActionFingerprint)) {
    throw new TypeError("Approval fingerprint counters must be an array.");
  }
  const fingerprints = new Set<string>();
  for (const entry of counters.requestsByActionFingerprint) {
    if (
      typeof entry.actionFingerprint !== "string" ||
      entry.actionFingerprint.length === 0 ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      fingerprints.has(entry.actionFingerprint)
    ) {
      throw new TypeError("Approval fingerprint counters are invalid.");
    }
    fingerprints.add(entry.actionFingerprint);
  }
}

function sameSessionContext(
  record: SessionAuthorityRecord,
  context: SessionAuthorityContext,
): boolean {
  return (
    record.hostSessionId === context.hostSessionId &&
    record.authorityContextKey === context.authorityContextKey &&
    record.workspaceId === context.workspaceId &&
    record.identityId === context.identityId &&
    record.environmentId === context.environmentId
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
