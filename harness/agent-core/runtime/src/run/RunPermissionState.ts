import {
  projectControllerPermissionProfile,
  type ActionApprovalCoverage,
  type ControllerPermissionProfileProjection,
  type RunPermissionGrant,
  type SessionAuthorityRecord,
} from "@agent-anything/permission";
import type { AppliedPolicyAmendmentRecord } from "@agent-anything/governance";
import type { ResolvedRunPermissionConfig } from "./RunPermissionConfig.js";

export interface RunPermissionState {
  readonly actionCoverage: readonly ActionApprovalCoverage[];
  readonly runPermissionGrants: readonly RunPermissionGrant[];
  readonly sessionAuthorityRecords: readonly SessionAuthorityRecord[];
  readonly appliedPolicyAmendments: readonly AppliedPolicyAmendmentRecord[];
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
    readonly reviewer: string | null;
    readonly pendingCount: number;
  };
}

export function createInitialRunPermissionState(config: ResolvedRunPermissionConfig): RunPermissionState {
  return deepFreeze({
    actionCoverage: [],
    runPermissionGrants: [],
    sessionAuthorityRecords: [...(config.sessionAuthority?.initialRecords ?? [])],
    appliedPolicyAmendments: [],
  });
}

export function deriveEffectivePermissionContext(
  config: ResolvedRunPermissionConfig,
  state: RunPermissionState,
): EffectivePermissionContext {
  return Object.freeze({
    profile: config.permissionProfile,
    runPermissionGrants: state.runPermissionGrants,
    sessionAuthorityRecords: state.sessionAuthorityRecords,
    appliedPolicyAmendments: state.appliedPolicyAmendments,
  });
}

export function projectPermissionContext(
  config: ResolvedRunPermissionConfig,
  state: RunPermissionState,
  pendingApprovalCount = 0,
): PermissionContextProjection {
  const permissionSets = [
    ...state.runPermissionGrants.map((grant) => grant.permissions),
    ...state.sessionAuthorityRecords.flatMap((record) =>
      record.grantedPermissions === null ? [] : [record.grantedPermissions]),
  ];
  const canRequest = config.reviewer !== null;
  return deepFreeze({
    profile: projectControllerPermissionProfile(config.permissionProfile, canRequest),
    authority: {
      hasAdditionalFileSystemRead: permissionSets.some((value) => (value.fileSystem?.read?.length ?? 0) > 0),
      hasAdditionalFileSystemWrite: permissionSets.some((value) => (value.fileSystem?.write?.length ?? 0) > 0),
      hasAdditionalNetwork: permissionSets.some((value) => value.network?.enabled === true),
      actionCoverageCount: state.actionCoverage.filter((value) => value.status === "available").length,
      runGrantCount: state.runPermissionGrants.length,
      sessionAuthorityCount: state.sessionAuthorityRecords.length,
      policyAmendmentCount: state.appliedPolicyAmendments.length,
    },
    approval: {
      canRequest,
      reviewer: config.reviewer?.kind ?? null,
      pendingCount: pendingApprovalCount,
    },
  });
}

export function assertRunPermissionStateInvariant(state: RunPermissionState): void {
  for (const field of ["actionCoverage", "runPermissionGrants", "sessionAuthorityRecords", "appliedPolicyAmendments"] as const) {
    if (!Array.isArray(state[field])) throw new TypeError(`RunPermissionState.${field} must be an array.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
