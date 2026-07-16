import type {
  AppliedPolicyAmendmentRecord,
  ExecPolicyRule,
  ManagedPermissionConstraints,
  NetworkPolicyRule,
  PolicyDecision,
} from "@agent-anything/governance";
import type {
  ActionApprovalCoverage,
  ApprovalPolicy,
  ApprovalRequirement,
  ResolvedPermissionProfile,
  RunPermissionGrant,
  SessionAuthorityContext,
  SessionAuthorityRecord,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { RuntimeError } from "../runner/RuntimeError.js";
import type { ActionRuleOutcome } from "@agent-anything/governance/policy";
import type { CanonicalEffectivePermissions } from "./CanonicalEffectivePermissions.js";
import type { PreparedExternalAction } from "./PreparedExternalAction.js";

declare const actionDispatchAuthorizationBrand: unique symbol;

export type ActionAuthoritySourceKind =
  | "profile"
  | "run_grant"
  | "session_authority"
  | "policy_amendment"
  | "action_coverage"
  | "rule";

export interface ActionAuthoritySource {
  readonly kind: ActionAuthoritySourceKind;
  readonly id: string;
}

export interface ActionDispatchAuthorization {
  readonly [actionDispatchAuthorizationBrand]: true;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly authoritySnapshotId: string;
  readonly policyCheckId: string;
  readonly ruleOutcome: ActionRuleOutcome;
  readonly authoritySources: readonly ActionAuthoritySource[];
  readonly actionCoverageIdToConsume: string | null;
  readonly effectivePermissions: CanonicalEffectivePermissions;
  readonly authorizedAt: ISODateTimeString;
}

export interface ActionAssessmentAuthoritySnapshot {
  readonly profile: ResolvedPermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly managedConstraints: ManagedPermissionConstraints;
  readonly execRules: readonly ExecPolicyRule[];
  readonly networkRules: readonly NetworkPolicyRule[];
  readonly runPermissionGrants: readonly RunPermissionGrant[];
  readonly sessionAuthorityContext: SessionAuthorityContext | null;
  readonly sessionAuthorityRecords: readonly SessionAuthorityRecord[];
  readonly appliedPolicyAmendments: readonly AppliedPolicyAmendmentRecord[];
  readonly actionCoverage: readonly ActionApprovalCoverage[];
  readonly approvalDeadlineAt: ISODateTimeString;
}

export interface AssessPreparedActionInput {
  readonly prepared: PreparedExternalAction;
  readonly authority: ActionAssessmentAuthoritySnapshot;
  readonly interruption: InvocationInterruptionContext;
}

export type ActionAssessment =
  | { readonly status: "authorized"; readonly authorization: ActionDispatchAuthorization }
  | { readonly status: "approval_required"; readonly requirement: ApprovalRequirement }
  | {
      readonly status: "denied";
      readonly owner: "policy" | "permission" | "tool";
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | { readonly status: "failed"; readonly error: RuntimeError }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export function snapshotActionAssessmentAuthority(
  input: ActionAssessmentAuthoritySnapshot,
): ActionAssessmentAuthoritySnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Action assessment authority must be an object.");
  }
  if (typeof input.approvalDeadlineAt !== "string" ||
    Number.isNaN(Date.parse(input.approvalDeadlineAt)) ||
    new Date(input.approvalDeadlineAt).toISOString() !== input.approvalDeadlineAt) {
    throw new TypeError("Action assessment approval deadline is invalid.");
  }
  return cloneFrozen(input, new WeakSet<object>());
}

const authorizationBrand: unique symbol = Symbol("ActionDispatchAuthorization");

export function createActionDispatchAuthorization(input: {
  readonly prepared: PreparedExternalAction;
  readonly authoritySnapshotId: string;
  readonly policyDecision: PolicyDecision;
  readonly ruleOutcome: ActionRuleOutcome;
  readonly authoritySources: readonly ActionAuthoritySource[];
  readonly actionCoverageIdToConsume: string | null;
  readonly effectivePermissions: CanonicalEffectivePermissions;
  readonly authorizedAt: ISODateTimeString;
}): ActionDispatchAuthorization {
  return deepFreeze({
    [authorizationBrand]: true as const,
    runId: input.prepared.action.runId,
    actionId: input.prepared.action.id,
    actionFingerprint: input.prepared.actionFingerprint,
    authoritySnapshotId: input.authoritySnapshotId,
    policyCheckId: input.policyDecision.checkId,
    ruleOutcome: input.ruleOutcome,
    authoritySources: [...input.authoritySources],
    actionCoverageIdToConsume: input.actionCoverageIdToConsume,
    effectivePermissions: input.effectivePermissions,
    authorizedAt: input.authorizedAt,
  }) as unknown as ActionDispatchAuthorization;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new TypeError("Action assessment authority cannot contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    const cloned = value.map((item) => cloneFrozen(item, seen));
    seen.delete(value);
    return Object.freeze(cloned) as unknown as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Action assessment authority must contain plain data only.");
  }
  const output: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError("Action assessment authority cannot contain accessors.");
    }
    output[key] = cloneFrozen(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(output) as T;
}
