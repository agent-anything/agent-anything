import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { ApprovalRequirement } from "@agent-anything/permission";
import type { ActionRuleOutcome } from "@agent-anything/governance/policy";
import type { RuntimeError } from "@agent-anything/agent-core/run";
import type {
  ActionAssessmentAuthoritySnapshot,
  ActionAssessmentReviewContext,
  ActionAuthoritySource,
  ActionDispatchAuthorization,
} from "./ActionAssessment.js";
import type { ActionRegistration } from "./ActionRegistration.js";
import { createCanonicalSha256Digest } from "./CanonicalEncoding.js";
import type { CanonicalEffectivePermissions } from "./CanonicalEffectivePermissions.js";
import type { CanonicalEnvironmentIdentity } from "./CanonicalIdentity.js";
import type { ActionEffectSet } from "./CapabilityEffect.js";
import type { PreparedExternalAction } from "./PreparedExternalAction.js";
import type { TargetStateAssertion } from "./TargetStateAssertion.js";

const actionDispatchPlanBrand: unique symbol = Symbol("ActionDispatchPlan");
const actionDispatchPlanInstances = new WeakSet<object>();

export interface RevalidatePreparedActionInput {
  readonly prepared: PreparedExternalAction;
  readonly authorization: ActionDispatchAuthorization;
  readonly authority: ActionAssessmentAuthoritySnapshot;
  readonly interruption: InvocationInterruptionContext;
  readonly attemptOrdinal: 1 | 2;
}

export interface ActionDispatchPlan {
  readonly [actionDispatchPlanBrand]: true;
  readonly runId: string;
  readonly actionId: string;
  readonly actionName: string;
  readonly actionFingerprint: string;
  readonly preparedInvocationDigest: string;
  readonly authorizedEffects: ActionEffectSet;
  readonly allowedSecretReferences: readonly string[];
  readonly environment: CanonicalEnvironmentIdentity;
  readonly authoritySnapshotId: string;
  readonly policyCheckId: string;
  readonly ruleOutcome: ActionRuleOutcome;
  readonly authoritySources: readonly ActionAuthoritySource[];
  readonly actionCoverageIdToConsume: string | null;
  readonly effectivePermissions: CanonicalEffectivePermissions;
  readonly enforcement: CanonicalEffectivePermissions["enforcement"];
  readonly registration: ActionRegistration;
  readonly targetAssertions: readonly TargetStateAssertion[];
  readonly attemptOrdinal: 1 | 2;
  readonly authorizedAt: ISODateTimeString;
  readonly revalidatedAt: ISODateTimeString;
  readonly dispatchPlanFingerprint: string;
}

export type ActionRevalidationResult =
  | { readonly status: "ready"; readonly plan: ActionDispatchPlan }
  | {
      readonly status: "approval_required";
      readonly requirement: ApprovalRequirement;
      readonly reviewContext: ActionAssessmentReviewContext;
    }
  | {
      readonly status: "denied";
      readonly owner: "policy" | "permission" | "tool";
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | { readonly status: "failed"; readonly error: RuntimeError }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export async function createActionDispatchPlan(input: {
  readonly prepared: PreparedExternalAction;
  readonly authorization: ActionDispatchAuthorization;
  readonly registration: ActionRegistration;
  readonly attemptOrdinal: 1 | 2;
  readonly revalidatedAt: ISODateTimeString;
}): Promise<ActionDispatchPlan> {
  const fields = {
    runId: input.prepared.action.runId,
    actionId: input.prepared.action.id,
    actionName: input.prepared.action.name,
    actionFingerprint: input.prepared.actionFingerprint,
    preparedInvocationDigest: input.prepared.subject.preparedInvocationDigest,
    authorizedEffects: input.prepared.subject.effectSet,
    allowedSecretReferences: input.prepared.preparedInvocation.secretReferences,
    environment: input.prepared.subject.environment,
    authoritySnapshotId: input.authorization.authoritySnapshotId,
    policyCheckId: input.authorization.policyCheckId,
    ruleOutcome: input.authorization.ruleOutcome,
    authoritySources: input.authorization.authoritySources,
    actionCoverageIdToConsume: input.authorization.actionCoverageIdToConsume,
    effectivePermissions: input.authorization.effectivePermissions,
    enforcement: input.authorization.effectivePermissions.enforcement,
    registration: input.registration,
    targetAssertions: input.prepared.subject.targetAssertions,
    attemptOrdinal: input.attemptOrdinal,
    authorizedAt: input.authorization.authorizedAt,
    revalidatedAt: input.revalidatedAt,
  };
  const dispatchPlanFingerprint = await createCanonicalSha256Digest(
    "agent-anything.action-dispatch-plan.v1",
    fields,
  );
  const plan = deepFreeze({
    [actionDispatchPlanBrand]: true as const,
    ...fields,
    dispatchPlanFingerprint,
  });
  actionDispatchPlanInstances.add(plan);
  return plan;
}

export function assertActionDispatchPlan(input: ActionDispatchPlan): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input[actionDispatchPlanBrand] !== true ||
    !actionDispatchPlanInstances.has(input) ||
    !isDeeplyFrozen(input)
  ) {
    throw new TypeError("Action dispatch requires a factory-created immutable plan.");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isDeeplyFrozen(input: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof input !== "object" || input === null) return true;
  if (seen.has(input)) return true;
  seen.add(input);
  if (!Object.isFrozen(input)) return false;
  return Reflect.ownKeys(input).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined && descriptor.get === undefined &&
      descriptor.set === undefined && isDeeplyFrozen(descriptor.value, seen);
  });
}
