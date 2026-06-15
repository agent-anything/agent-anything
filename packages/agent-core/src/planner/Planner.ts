import type { PlannerInput } from "./PlannerInput.js";
import type { PlanStep } from "./PlanStep.js";

export interface Planner {
  plan(input: PlannerInput): Promise<PlanStep>;
}
