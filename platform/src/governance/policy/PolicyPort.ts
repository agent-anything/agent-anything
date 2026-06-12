import type { PolicyCheckInput } from "./PolicyCheckInput.js";
import type { PolicyDecision } from "./PolicyDecision.js";

export interface PolicyPort {
  evaluate(input: PolicyCheckInput): Promise<PolicyDecision>;
}
