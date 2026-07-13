import type { ISODateTimeString } from "@agent-anything/shared";
import type {
  Plan,
  PlanLimits,
  PlanProjection,
  PlanStep,
  PlanStepStatus,
  PlanUpdateObservation,
} from "./Plan.js";

export type PlanLifecycleChange =
  | {
      readonly kind: "created";
      readonly plan: PlanProjection;
      readonly explanation: string | null;
    }
  | {
      readonly kind: "updated";
      readonly previousVersion: number;
      readonly plan: PlanProjection;
      readonly transition: "updated" | "reactivated";
      readonly explanation: string | null;
    }
  | {
      readonly kind: "completed";
      readonly plan: PlanProjection;
    }
  | {
      readonly kind: "abandoned";
      readonly plan: PlanProjection;
      readonly terminalStatus: "succeeded" | "blocked" | "failed" | "cancelled";
      readonly reasonCode: string | null;
    };

interface ApplyPlanUpdateBaseInput {
  readonly candidate: unknown;
  readonly limits: PlanLimits;
  readonly now: ISODateTimeString;
}

export type ApplyPlanUpdateInput =
  | (ApplyPlanUpdateBaseInput & {
      readonly currentPlan: null;
      readonly newPlanId: string;
    })
  | (ApplyPlanUpdateBaseInput & {
      readonly currentPlan: Plan;
      readonly newPlanId?: never;
    });

type AppliedObservation = Extract<PlanUpdateObservation, { readonly status: "applied" }>;
type NoChangeObservation = Extract<PlanUpdateObservation, { readonly status: "no_change" }>;
type RejectedObservation = Extract<PlanUpdateObservation, { readonly status: "rejected" }>;

export type ApplyPlanUpdateResult =
  | {
      readonly status: "applied";
      readonly plan: Plan;
      readonly observation: AppliedObservation;
      readonly lifecycle: readonly [PlanLifecycleChange, ...PlanLifecycleChange[]];
    }
  | {
      readonly status: "no_change";
      readonly plan: Plan;
      readonly observation: NoChangeObservation;
      readonly lifecycle: readonly [];
    }
  | {
      readonly status: "rejected";
      readonly plan: Plan | null;
      readonly observation: RejectedObservation;
      readonly lifecycle: readonly [];
    };

export interface AbandonPlanInput {
  readonly plan: Plan;
  readonly terminalStatus: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly reasonCode: string | null;
  readonly now: ISODateTimeString;
}

export type AbandonPlanResult =
  | {
      readonly status: "abandoned";
      readonly plan: Plan;
      readonly lifecycle: readonly [Extract<PlanLifecycleChange, { readonly kind: "abandoned" }>];
    }
  | {
      readonly status: "no_change";
      readonly plan: Plan;
      readonly lifecycle: readonly [];
    };

interface NormalizedPlanUpdate {
  readonly steps: readonly PlanStep[];
  readonly explanation: string | null;
}

type NormalizePlanUpdateResult =
  | {
      readonly valid: true;
      readonly update: NormalizedPlanUpdate;
    }
  | {
      readonly valid: false;
      readonly observation: RejectedObservation;
    };

const planStepStatuses: readonly PlanStepStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

export function applyPlanUpdate(input: ApplyPlanUpdateInput): ApplyPlanUpdateResult {
  assertValidPlanLimits(input.limits);
  assertNonEmpty(input.now, "now");

  if (input.currentPlan === null) {
    assertNonEmpty(input.newPlanId, "newPlanId");
  } else if (input.currentPlan.status === "abandoned") {
    return rejected(input.currentPlan, "plan_invalid", "An abandoned Plan cannot be updated.");
  }

  const normalized = normalizePlanUpdate(input.candidate, input.limits);
  if (!normalized.valid) {
    return Object.freeze({
      status: "rejected",
      plan: input.currentPlan,
      observation: normalized.observation,
      lifecycle: Object.freeze([]) as readonly [],
    });
  }

  if (input.currentPlan === null) {
    return createPlan(input.newPlanId, input.now, normalized.update);
  }

  return updatePlan(input.currentPlan, input.now, normalized.update);
}

export function abandonPlan(input: AbandonPlanInput): AbandonPlanResult {
  assertNonEmpty(input.now, "now");

  if (input.plan.status !== "active") {
    return Object.freeze({
      status: "no_change",
      plan: input.plan,
      lifecycle: Object.freeze([]) as readonly [],
    });
  }

  const plan = freezePlan({
    ...input.plan,
    version: input.plan.version + 1,
    status: "abandoned",
    updatedAt: input.now,
  });
  const change = Object.freeze({
    kind: "abandoned" as const,
    plan: projectPlan(plan),
    terminalStatus: input.terminalStatus,
    reasonCode: input.reasonCode,
  });

  return Object.freeze({
    status: "abandoned",
    plan,
    lifecycle: Object.freeze([change]) as readonly [typeof change],
  });
}

export function projectPlan(plan: Plan): PlanProjection {
  return Object.freeze({
    id: plan.id,
    version: plan.version,
    status: plan.status,
    steps: freezeSteps(plan.steps),
  });
}

export function assertValidPlanLimits(limits: PlanLimits): void {
  assertPositiveInteger(limits.maxSteps, "PlanLimits.maxSteps");
  assertPositiveInteger(limits.maxStepLength, "PlanLimits.maxStepLength");
  assertPositiveInteger(limits.maxExplanationLength, "PlanLimits.maxExplanationLength");
}

function createPlan(
  id: string,
  now: ISODateTimeString,
  update: NormalizedPlanUpdate,
): ApplyPlanUpdateResult {
  const plan = freezePlan({
    id,
    version: 1,
    status: derivePlanStatus(update.steps),
    steps: update.steps,
    createdAt: now,
    updatedAt: now,
  });
  const projection = projectPlan(plan);
  const created = Object.freeze({
    kind: "created" as const,
    plan: projection,
    explanation: update.explanation,
  });
  const lifecycle: PlanLifecycleChange[] = [created];

  if (plan.status === "completed") {
    lifecycle.push(Object.freeze({
      kind: "completed",
      plan: projection,
    }));
  }

  return Object.freeze({
    status: "applied",
    plan,
    observation: Object.freeze({
      status: "applied",
      transition: "created",
      planId: plan.id,
      version: plan.version,
    }),
    lifecycle: Object.freeze(lifecycle) as readonly [
      PlanLifecycleChange,
      ...PlanLifecycleChange[],
    ],
  });
}

function updatePlan(
  currentPlan: Plan,
  now: ISODateTimeString,
  update: NormalizedPlanUpdate,
): ApplyPlanUpdateResult {
  if (stepsEqual(currentPlan.steps, update.steps)) {
    return Object.freeze({
      status: "no_change",
      plan: currentPlan,
      observation: Object.freeze({
        status: "no_change",
        planId: currentPlan.id,
        version: currentPlan.version,
      }),
      lifecycle: Object.freeze([]) as readonly [],
    });
  }

  const nextStatus = derivePlanStatus(update.steps);
  const observationTransition = currentPlan.status === "active" && nextStatus === "completed"
    ? "completed"
    : currentPlan.status === "completed" && nextStatus === "active"
      ? "reactivated"
      : "updated";
  const plan = freezePlan({
    ...currentPlan,
    version: currentPlan.version + 1,
    status: nextStatus,
    steps: update.steps,
    updatedAt: now,
  });
  const projection = projectPlan(plan);
  const updated = Object.freeze({
    kind: "updated" as const,
    previousVersion: currentPlan.version,
    plan: projection,
    transition: observationTransition === "reactivated" ? "reactivated" as const : "updated" as const,
    explanation: update.explanation,
  });
  const lifecycle: PlanLifecycleChange[] = [updated];

  if (observationTransition === "completed") {
    lifecycle.push(Object.freeze({
      kind: "completed",
      plan: projection,
    }));
  }

  return Object.freeze({
    status: "applied",
    plan,
    observation: Object.freeze({
      status: "applied",
      transition: observationTransition,
      planId: plan.id,
      version: plan.version,
    }),
    lifecycle: Object.freeze(lifecycle) as readonly [
      PlanLifecycleChange,
      ...PlanLifecycleChange[],
    ],
  });
}

function normalizePlanUpdate(
  candidate: unknown,
  limits: PlanLimits,
): NormalizePlanUpdateResult {
  if (!isRecord(candidate)) {
    return invalid("plan_invalid", "Plan update must be an object.");
  }

  const explanationResult = normalizeExplanation(candidate.explanation, limits);
  if (!explanationResult.valid) {
    return explanationResult;
  }

  if (!Array.isArray(candidate.plan) || candidate.plan.length === 0) {
    return invalid("plan_invalid", "Plan must contain at least one step.");
  }
  if (candidate.plan.length > limits.maxSteps) {
    return invalid("plan_limit_exceeded", "Plan exceeds the maximum number of steps.");
  }

  const steps: PlanStep[] = [];
  let inProgressCount = 0;

  for (const candidateStep of candidate.plan) {
    if (!isRecord(candidateStep)) {
      return invalid("plan_invalid", "Every Plan step must be an object.");
    }
    if (typeof candidateStep.step !== "string") {
      return invalid("plan_invalid", "Every Plan step must contain text.");
    }

    const step = candidateStep.step.trim();
    if (step.length === 0) {
      return invalid("plan_invalid", "Plan step text must not be empty.");
    }
    if (step.length > limits.maxStepLength) {
      return invalid("plan_limit_exceeded", "Plan step text exceeds the configured limit.");
    }
    if (!isPlanStepStatus(candidateStep.status)) {
      return invalid("plan_invalid", "Plan step status is not supported.");
    }

    if (candidateStep.status === "in_progress") {
      inProgressCount += 1;
      if (inProgressCount > 1) {
        return invalid("plan_invalid", "At most one Plan step may be in progress.");
      }
    }

    steps.push(Object.freeze({
      step,
      status: candidateStep.status,
    }));
  }

  return {
    valid: true,
    update: Object.freeze({
      steps: Object.freeze(steps),
      explanation: explanationResult.explanation,
    }),
  };
}

function normalizeExplanation(
  explanation: unknown,
  limits: PlanLimits,
):
  | { readonly valid: true; readonly explanation: string | null }
  | { readonly valid: false; readonly observation: RejectedObservation } {
  if (explanation === undefined) {
    return { valid: true, explanation: null };
  }
  if (typeof explanation !== "string") {
    return invalid("plan_invalid", "Plan explanation must be text.");
  }

  const normalized = explanation.trim();
  if (normalized.length > limits.maxExplanationLength) {
    return invalid("plan_limit_exceeded", "Plan explanation exceeds the configured limit.");
  }

  return {
    valid: true,
    explanation: normalized.length === 0 ? null : normalized,
  };
}

function rejected(
  plan: Plan | null,
  code: RejectedObservation["code"],
  message: string,
): ApplyPlanUpdateResult {
  return Object.freeze({
    status: "rejected",
    plan,
    observation: Object.freeze({ status: "rejected", code, message }),
    lifecycle: Object.freeze([]) as readonly [],
  });
}

function invalid(
  code: RejectedObservation["code"],
  message: string,
): { readonly valid: false; readonly observation: RejectedObservation } {
  return {
    valid: false,
    observation: Object.freeze({ status: "rejected", code, message }),
  };
}

function freezePlan(plan: Plan): Plan {
  return Object.freeze({
    ...plan,
    steps: freezeSteps(plan.steps),
  });
}

function freezeSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
  return Object.freeze(steps.map((step) => Object.freeze({ ...step })));
}

function derivePlanStatus(steps: readonly PlanStep[]): "active" | "completed" {
  return steps.every((step) => step.status === "completed") ? "completed" : "active";
}

function stepsEqual(left: readonly PlanStep[], right: readonly PlanStep[]): boolean {
  return left.length === right.length && left.every((step, index) => (
    step.step === right[index]?.step && step.status === right[index]?.status
  ));
}

function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && planStepStatuses.includes(value as PlanStepStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
