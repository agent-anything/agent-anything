import type { ISODateTimeString } from "@agent-anything/shared";

export type PlanStatus = "active" | "completed" | "abandoned";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface Plan {
  readonly id: string;
  readonly version: number;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;
}

export interface PlanProjection {
  readonly id: string;
  readonly version: number;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
}

export interface UpdatePlanInput {
  readonly explanation?: string;
  readonly plan: readonly PlanStep[];
}

export interface PlanLimits {
  readonly maxSteps: number;
  readonly maxStepLength: number;
  readonly maxExplanationLength: number;
}

export type PlanUpdateObservation =
  | {
      readonly status: "applied";
      readonly transition: "created" | "updated" | "completed" | "reactivated";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "no_change";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "rejected";
      readonly code: "plan_invalid" | "plan_limit_exceeded";
      readonly message: string;
    };
