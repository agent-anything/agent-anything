import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import type { PermissionResolutionEnvironmentInput } from "../profile/PermissionProfile.js";
import { validateGrantedPermissions } from "../approval/PermissionDelta.js";
import type {
  ActionApprovalCoverage,
  ApprovalApplicabilityKey,
  SessionAuthorityContext,
  SessionAuthorityLookup,
  SessionAuthorityRecord,
  SessionAuthorityRecordInput,
} from "./AuthorityContracts.js";

export type SessionAuthorityValidationCode =
  | "session_authority_invalid_identity"
  | "session_authority_context_mismatch"
  | "session_authority_category_mismatch"
  | "session_authority_applicability_invalid"
  | "session_authority_permissions_invalid";

export type ValidateSessionAuthorityRecordResult =
  | { readonly status: "valid"; readonly record: SessionAuthorityRecord }
  | {
      readonly status: "invalid";
      readonly code: SessionAuthorityValidationCode;
      readonly message: string;
    };

export interface ValidateSessionAuthorityRecordInput {
  readonly record: SessionAuthorityRecordInput;
  readonly expectedContext: SessionAuthorityContext;
  readonly cwd: string;
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly managedConstraints: ManagedPermissionConstraints;
}

export function validateSessionAuthorityRecord(
  input: ValidateSessionAuthorityRecordInput,
): ValidateSessionAuthorityRecordResult {
  const record = input.record;
  if (
    !nonEmpty(record.id) ||
    !nonEmpty(record.sourceRequestId) ||
    !nonEmpty(record.sourceActionFingerprint) ||
    !nonEmpty(record.createdAt)
  ) {
    return invalid(
      "session_authority_invalid_identity",
      "Session authority record identity is invalid.",
    );
  }
  if (!sameContext(record, input.expectedContext)) {
    return invalid(
      "session_authority_context_mismatch",
      "Session authority record does not match the active authority context.",
    );
  }
  if (record.applicabilityKeys.length === 0) {
    return invalid(
      "session_authority_applicability_invalid",
      "Session authority record has no applicability key.",
    );
  }
  const values = new Set<string>();
  for (const key of record.applicabilityKeys) {
    if (key.category !== record.category) {
      return invalid(
        "session_authority_category_mismatch",
        "Session authority applicability category does not match the record.",
      );
    }
    if (!nonEmpty(key.value) || values.has(key.value)) {
      return invalid(
        "session_authority_applicability_invalid",
        "Session authority applicability keys are invalid or duplicated.",
      );
    }
    values.add(key.value);
  }

  let grantedPermissions = null;
  if (record.grantedPermissions) {
    const validated = validateGrantedPermissions({
      requested: record.grantedPermissions,
      granted: record.grantedPermissions,
      cwd: input.cwd,
      environment: input.environment,
      managedConstraints: input.managedConstraints,
    });
    if (validated.status === "invalid") {
      return invalid(
        "session_authority_permissions_invalid",
        validated.message,
      );
    }
    grantedPermissions = validated.permissions;
  }

  return Object.freeze({
    status: "valid",
    record: deepFreeze({
      ...record,
      applicabilityKeys: record.applicabilityKeys.map((key) => ({ ...key })) as [
        ApprovalApplicabilityKey,
        ...ApprovalApplicabilityKey[],
      ],
      grantedPermissions,
    }),
  });
}

export function isSessionAuthorityApplicable(
  record: SessionAuthorityRecord,
  lookup: SessionAuthorityLookup,
): boolean {
  if (!sameContext(record, lookup.context)) return false;
  if (lookup.category !== null && lookup.category !== record.category) return false;
  const keys = new Set(
    lookup.applicabilityKeys.map((key) => `${key.category}:${key.value}`),
  );
  return record.applicabilityKeys.every((key) =>
    keys.has(`${key.category}:${key.value}`),
  );
}

export function isActionApprovalCoverageApplicable(
  coverage: ActionApprovalCoverage,
  input: {
    readonly runId: string;
    readonly actionId: string;
    readonly actionFingerprint: string;
  },
): boolean {
  return (
    coverage.status === "available" &&
    coverage.runId === input.runId &&
    coverage.actionId === input.actionId &&
    coverage.actionFingerprint === input.actionFingerprint
  );
}

function sameContext(
  left: SessionAuthorityContext,
  right: SessionAuthorityContext,
): boolean {
  return (
    left.hostSessionId === right.hostSessionId &&
    left.authorityContextKey === right.authorityContextKey &&
    left.workspaceId === right.workspaceId &&
    left.identityId === right.identityId &&
    left.environmentId === right.environmentId
  );
}

function invalid(
  code: SessionAuthorityValidationCode,
  message: string,
): Extract<ValidateSessionAuthorityRecordResult, { status: "invalid" }> {
  return Object.freeze({ status: "invalid", code, message });
}

function nonEmpty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
