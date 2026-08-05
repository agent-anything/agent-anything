

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
  readonly createdAt: string;
  readonly updatedAt: string;
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
