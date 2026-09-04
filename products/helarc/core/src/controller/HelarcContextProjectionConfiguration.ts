import type { RunnerContextProjection } from "@agent-anything/agent-runtime/runner";
import type {
  ContextProjectionEstimationInput,
  ContextProjectionEstimator,
  ContextProjectionPolicy,
} from "@agent-anything/context/projection";
import {
  HELARC_CONTEXT_PROJECTION_FORMAT_VERSION,
  renderHelarcContextProjectionFragment,
} from "../prompt/HelarcPromptAssembly.js";

const HELARC_MAXIMUM_CONTEXT_INPUT_BYTES = 256 * 1_024;

export function createHelarcContextProjectionConfiguration(): RunnerContextProjection {
  const estimator: ContextProjectionEstimator = Object.freeze({
    ref: Object.freeze({
      id: `helarc.context-projection.utf8.${HELARC_CONTEXT_PROJECTION_FORMAT_VERSION}`,
      revision: "1",
      unit: "bytes" as const,
      accuracy: "exact" as const,
    }),
    estimate(input: ContextProjectionEstimationInput) {
      return new TextEncoder().encode(renderHelarcContextProjectionFragment(input)).byteLength;
    },
  });
  const policy: ContextProjectionPolicy = Object.freeze({
    ref: Object.freeze({ id: "helarc-context-policy", revision: "1" }),
    decide() {
      return Object.freeze({ kind: "allow" as const });
    },
  });
  return Object.freeze({
    purpose: "controller_model_input",
    profile: Object.freeze({
      ref: Object.freeze({ id: "helarc-controller-context", revision: "1" }),
      ordering: "precedence_desc_created_at_asc_id_asc" as const,
      allowedTransformations: Object.freeze([]),
    }),
    policy,
    audiences: Object.freeze(["model"]),
    maxContributionPayloadBytes: 128 * 1_024,
    allocate() {
      return Object.freeze({
        budget: Object.freeze({
          unit: "bytes" as const,
          maximum: HELARC_MAXIMUM_CONTEXT_INPUT_BYTES,
        }),
        estimator,
      });
    },
  });
}
