import {
  createActionApprovalCoverage,
  type ApprovalApplicationOutcome,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { RunPermissionState } from "./RunPermissionState.js";

export type ApplyImmediateApprovalAuthorityResult =
  | {
      readonly status: "applied";
      readonly permission: RunPermissionState;
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "applied" }>;
    }
  | {
      readonly status: "not_applicable";
      readonly permission: RunPermissionState;
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "not_applicable" }>;
    }
  | {
      readonly status: "deferred";
      readonly scope: "session" | "persistent";
    };

export function applyImmediateApprovalAuthority(input: {
  readonly permission: RunPermissionState;
  readonly decision: ValidatedApprovalDecision;
}): ApplyImmediateApprovalAuthorityResult {
  const { decision, permission } = input;
  if (decision.kind === "accept") {
    assertUniqueAuthorityId(permission, decision.actionAuthority.id);
    const coverage = createActionApprovalCoverage(decision.actionAuthority);
    return Object.freeze({
      status: "applied" as const,
      permission: Object.freeze({
        ...permission,
        actionCoverage: Object.freeze([...permission.actionCoverage, coverage]),
      }),
      application: applied("action_authority", coverage.id),
    });
  }
  if (decision.kind === "grantPermissions") {
    if (decision.authority.scope === "session") {
      return Object.freeze({ status: "deferred" as const, scope: "session" as const });
    }
    const grant = decision.authority.grant;
    assertUniqueAuthorityId(permission, grant.id);
    return Object.freeze({
      status: "applied" as const,
      permission: Object.freeze({
        ...permission,
        runPermissionGrants: Object.freeze([...permission.runPermissionGrants, grant]),
      }),
      application: applied("run_authority", grant.id),
    });
  }
  if (
    decision.kind === "acceptForSession"
  ) {
    return Object.freeze({ status: "deferred" as const, scope: "session" as const });
  }
  if (
    decision.kind === "acceptWithExecpolicyAmendment" ||
    decision.kind === "applyNetworkPolicyAmendment"
  ) {
    return Object.freeze({ status: "deferred" as const, scope: "persistent" as const });
  }
  return Object.freeze({
    status: "not_applicable" as const,
    permission,
    application: Object.freeze({ kind: "not_applicable" as const }),
  });
}

export type ConsumeActionApprovalCoverageResult =
  | { readonly status: "consumed"; readonly permission: RunPermissionState }
  | { readonly status: "not_found"; readonly permission: RunPermissionState };

export function consumeActionApprovalCoverage(input: {
  readonly permission: RunPermissionState;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
}): ConsumeActionApprovalCoverageResult {
  const index = input.permission.actionCoverage.findIndex((coverage) =>
    coverage.status === "available" &&
    coverage.runId === input.runId &&
    coverage.actionId === input.actionId &&
    coverage.actionFingerprint === input.actionFingerprint
  );
  if (index < 0) {
    return Object.freeze({ status: "not_found" as const, permission: input.permission });
  }
  const coverage = input.permission.actionCoverage[index]!;
  const next = input.permission.actionCoverage.map((candidate, candidateIndex) =>
    candidateIndex === index
      ? Object.freeze({ ...coverage, status: "consumed" as const })
      : candidate
  );
  return Object.freeze({
    status: "consumed" as const,
    permission: Object.freeze({
      ...input.permission,
      actionCoverage: Object.freeze(next),
    }),
  });
}

function applied(
  target: "action_authority" | "run_authority",
  authorityRecordId: string,
): Extract<ApprovalApplicationOutcome, { readonly kind: "applied" }> {
  return Object.freeze({
    kind: "applied" as const,
    target,
    authorityRecordIds: Object.freeze([authorityRecordId]) as readonly [string],
  });
}

function assertUniqueAuthorityId(state: RunPermissionState, id: string): void {
  const duplicate = [
    ...state.actionCoverage,
    ...state.runPermissionGrants,
    ...state.sessionAuthorityRecords,
    ...state.appliedPolicyAmendments,
  ].some((record) => record.id === id);
  if (duplicate) {
    throw new TypeError(`Approval authority id '${id}' is duplicated.`);
  }
}
