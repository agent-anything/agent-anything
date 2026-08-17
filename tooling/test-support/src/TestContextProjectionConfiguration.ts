import type { RunnerContextProjection } from "@agent-anything/agent-runtime/runner";
import type { ContextProjectionEstimationInput } from "@agent-anything/context/projection";

export function createTestContextProjection(): RunnerContextProjection {
  const estimator = Object.freeze({
    ref: Object.freeze({
      id: "test-context-utf8",
      revision: "1",
      unit: "bytes" as const,
      accuracy: "exact" as const,
    }),
    estimate(input: ContextProjectionEstimationInput) {
      return new TextEncoder().encode(JSON.stringify({
        contribution: input.contribution,
        instructionRole: input.instructionRole,
        payload: input.payload,
      })).byteLength;
    },
  });
  return Object.freeze({
    purpose: "test_controller_input",
    profile: Object.freeze({
      ref: Object.freeze({ id: "test-context-projection", revision: "1" }),
      ordering: "precedence_desc_created_at_asc_id_asc" as const,
      allowedTransformations: Object.freeze([]),
    }),
    policy: Object.freeze({
      ref: Object.freeze({ id: "test-context-policy", revision: "1" }),
      decide: () => Object.freeze({ kind: "allow" as const }),
    }),
    audiences: Object.freeze(["model"]),
    maxContributionPayloadBytes: 1 * 1_024 * 1_024,
    allocate: () => Object.freeze({
      budget: Object.freeze({ unit: "bytes" as const, maximum: 4 * 1_024 * 1_024 }),
      estimator,
    }),
  });
}
