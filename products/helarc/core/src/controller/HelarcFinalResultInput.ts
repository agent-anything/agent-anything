import { validatePlanUpdate, type PlanLimits } from "@agent-anything/agent-runtime/plan";

export function finalResultInputError(
  value: unknown,
  hasPlan: boolean,
  limits: PlanLimits,
): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "final_result input must be an object containing response and, when required, plan.";
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "response" && key !== "plan")) {
    return "final_result accepts only response and plan; remove the other fields.";
  }
  if (typeof input.response !== "string") {
    return "final_result.response must be a string; an empty string is allowed.";
  }
  if (!("plan" in input)) {
    return hasPlan ? "final_result.plan is required because a Plan exists. Submit its complete final step/status array, even when unchanged; unfinished steps may remain." : null;
  }
  if (!Array.isArray(input.plan)) {
    return "final_result.plan must be an array of step/status objects.";
  }
  if (input.plan.length === 0) {
    return hasPlan ? "final_result.plan cannot be empty because a Plan exists. Retain its complete final step/status array; unfinished steps may remain." : null;
  }
  for (const [index, step] of input.plan.entries()) {
    if (step !== null && typeof step === "object" && !Array.isArray(step) &&
      Object.keys(step).some(key => key !== "step" && key !== "status")) {
      return `final_result.plan[${index}] accepts only step and status; remove the other fields.`;
    }
  }
  const rejection = validatePlanUpdate({plan: input.plan}, limits);
  return rejection === null ? null : `final_result.plan: ${rejection.message} Correct this snapshot using the request's final_result Schema; unfinished steps may remain.`;
}
