import type { RunnerContextProjection } from "@agent-anything/agent-runtime/runner";
import type { ControllerPreProjectionInput } from "@agent-anything/agent-runtime/controller";
import type {
  ContextProjectionEstimationInput,
  ContextProjectionEstimator,
  ContextProjectionPolicy,
} from "@agent-anything/context/projection";
import {
  allocateModelInputContext,
  type ProviderModelInputAccounting,
} from "@agent-anything/model-interaction/input";
import {
  buildHelarcBasePromptAssembly,
  HELARC_CONTEXT_PROJECTION_FORMAT_VERSION,
  HELARC_MODEL_OUTPUT_RESERVE_BYTES,
  renderHelarcContextProjectionFragment,
} from "../prompt/HelarcPromptAssembly.js";
import { createHelarcControllerOutputFormat } from "./HelarcActionContract.js";

const HELARC_MAXIMUM_CONTEXT_INPUT_AMOUNT = 256 * 1_024;

export function createHelarcContextProjectionConfiguration(
  accounting: ProviderModelInputAccounting,
): RunnerContextProjection {
  const capability = requireSupportedAccounting(accounting);
  const estimator: ContextProjectionEstimator = Object.freeze({
    ref: Object.freeze({
      id: `${capability.estimator.id}.${HELARC_CONTEXT_PROJECTION_FORMAT_VERSION}`,
      revision: capability.estimator.revision,
      unit: capability.estimator.unit,
      accuracy: "exact" as const,
    }),
    estimate(input: ContextProjectionEstimationInput) {
      return accounting.estimateSection(Object.freeze({
        id: "helarc:model-input:context-projection-fragment",
        source: Object.freeze({
          owner: "context",
          kind: "context_contribution",
          id: input.contribution.id,
          revision: input.contribution.revision,
        }),
        kind: "context_projection_fragment",
        role: "user",
        necessity: "optional",
        content: Object.freeze({
          kind: "text",
          text: renderHelarcContextProjectionFragment(input),
        }),
      })).accounting.amount;
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
    allocate(input: ControllerPreProjectionInput) {
      const allocation = allocateModelInputContext({
        accounting,
        interaction: {
          kind: "structured_generation",
          outputFormat: createHelarcControllerOutputFormat(input.toolExposure),
        },
        outputReserve: Object.freeze({
          unit: capability.estimator.unit,
          amount: HELARC_MODEL_OUTPUT_RESERVE_BYTES,
        }),
        baseSections: buildHelarcBasePromptAssembly(input).sections,
        maximumContextAmount: HELARC_MAXIMUM_CONTEXT_INPUT_AMOUNT,
      });
      return Object.freeze({
        budget: Object.freeze({
          unit: allocation.unit,
          maximum: allocation.amount,
        }),
        estimator,
      });
    },
  });
}

function requireSupportedAccounting(
  accounting: ProviderModelInputAccounting,
): Extract<ProviderModelInputAccounting["capability"], { readonly supported: true }> {
  if (!accounting.capability.supported) {
    throw new TypeError("Helarc requires exact Provider Model Input Accounting.");
  }
  if (accounting.capability.estimator.unit !== "bytes") {
    throw new TypeError("Helarc currently requires byte-based Provider Model Input Accounting.");
  }
  return accounting.capability;
}
