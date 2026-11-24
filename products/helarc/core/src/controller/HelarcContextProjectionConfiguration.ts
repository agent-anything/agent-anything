import type { DecisionSourceProjection } from "@agent-anything/agent-runtime/execution-coordinator";
import { selectConversationPresentations,requireTurnTaskInput } from "@agent-anything/agent-runtime/decision";
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

/** Bounds disclosed source payloads, not native tokens or complete wire capacity. */
export function createHelarcNativeContextProjectionConfiguration():DecisionSourceProjection {
  const estimator:ContextProjectionEstimator={ref:{id:"helarc.native-source-json",revision:"1",unit:"bytes",accuracy:"exact"},
    estimate:input=>new TextEncoder().encode(JSON.stringify({source:input.contribution,payload:input.payload})).byteLength};
  return {purpose:"native_task_sources",profile:{ref:{id:"helarc-native-task-sources",revision:"1"},
    ordering:"precedence_desc_created_at_asc_id_asc",allowedTransformations:[]},
    policy:{ref:{id:"helarc-native-source-disclosure",revision:"1"},decide:()=>({kind:"allow"})},audiences:["model"],maxContributionPayloadBytes:128*1024,
    allocate(input){
      if(input.interaction.kind!=="native_evidence")throw new TypeError("native_source_projection_requires_native_history");
      return {budget:{unit:"bytes",maximum:HELARC_MAXIMUM_CONTEXT_INPUT_BYTES},estimator};
    }};
}

export function createHelarcContextProjectionConfiguration(): DecisionSourceProjection {
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
    allocate(input: Parameters<DecisionSourceProjection["allocate"]>[0]) {
      requireTurnTaskInput(input);
      return Object.freeze({
        budget: Object.freeze({
          unit: "bytes" as const,
          maximum: HELARC_MAXIMUM_CONTEXT_INPUT_BYTES,
        }),
        estimator,
        retainedCoverage: Object.freeze(selectConversationPresentations(input.interaction).flatMap(presentation =>
          (presentation.section.provenance?.sources ?? []).filter(source => source.owner === "context" &&
            source.kind === "context_contribution" && (source.runId ?? presentation.section.provenance?.recipientRunId) === input.runId && source.revision !== null)
          .map(source => ({contribution: {id: source.id, revision: source.revision!},
            presentation: {id: presentation.section.id, revision: presentation.digest}})))),
      });
    },
  });
}
