import type { PolicyPort } from "./PolicyPort.js";

export function createAllowAllPolicyPort(): PolicyPort {
  return {
    async evaluate(input) {
      return {
        checkId: input.id,
        status: "allowed",
        decidedAt: new Date().toISOString(),
      };
    },
  };
}
