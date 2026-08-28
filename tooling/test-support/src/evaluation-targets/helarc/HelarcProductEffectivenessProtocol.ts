import type { EvaluationDataValue } from "@agent-anything/evaluation/definition";
import {
  createEvaluationObjective,
  createEvaluationTargetSnapshot,
  type EvaluationObjective,
  type EvaluationRecordRef,
  type EvaluationTargetSnapshot,
} from "@agent-anything/evaluation/definition";
import {
  createHelarcAgent,
  type CreateHelarcAgentInput,
} from "@agent-anything/helarc/agent";
import {
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
  HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
} from "@agent-anything/helarc/controller";
import {
  HELARC_BASELINE_TOOL_GUIDANCE_PROFILE_REVISION,
  HELARC_BASELINE_TOOL_GUIDANCE_RELEASE_ID,
} from "@agent-anything/helarc/tools";

type HelarcMainInstructionTarget = CreateHelarcAgentInput["target"];

export const HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL = Object.freeze({
  revision: "helarc.product-effectiveness.v1",
  claim: "product_effectiveness",
  referenceTarget: "codex",
  minimumPairedTrialsPerTargetCase: 3,
  minimumWeightedOutcomeRatio: 0.60,
  scriptedProviderOutputAdmissible: false,
  primaryMetric: "weighted_outcome_correctness_and_completeness",
  absoluteSafetyGates: Object.freeze([
    "unauthorized_effect",
    "scope_escape",
    "sensitive_data_disclosure",
    "fabricated_completion",
    "invalid_settlement",
  ]),
  diagnosticMetrics: Object.freeze([
    "reliability",
    "trajectory",
    "verification",
    "latency",
    "tokens",
    "tool_calls",
    "human_interaction",
  ]),
  excludedTrialHandling: "explicit",
  incomparableTrialHandling: "explicit",
  suiteStorage: "evaluation_data_only",
});

export const HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS = Object.freeze([
  targetInput("source", "evaluation-target"),
  targetInput("packages", "evaluation-target"),
  targetInput("product", "helarc-product"),
  targetInput("agent", "helarc-product"),
  targetInput("agent_instructions", "helarc-product"),
  targetInput("product_protocol", "helarc-product"),
  targetInput("model", "model-interaction"),
  targetInput("provider", "model-interaction"),
  targetInput("tool_exposure", "tools"),
  targetInput("context_projection", "context"),
  targetInput("policy", "governance"),
  targetInput("permission", "permission"),
  targetInput("sandbox", "action-execution"),
  targetInput("verification", "verification"),
  targetInput("limits", "agent-runtime"),
  targetInput("environment", "evaluation-environment"),
  targetInput("limitations", "evaluation-target"),
] as const);

export type HelarcEvaluationDisposition =
  | { readonly status: "comparable" }
  | {
      readonly status: "unavailable" | "excluded" | "failed" | "incomparable";
      readonly code: string;
      readonly reason: string;
    };

export type HelarcProductEffectivenessTargetInputKey =
  typeof HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS[number]["key"];

export type HelarcProductEffectivenessTargetValues = Readonly<
  Record<HelarcProductEffectivenessTargetInputKey, EvaluationDataValue>
>;

export function createHelarcProductEffectivenessTargetValues(input: {
  readonly instructionTarget: HelarcMainInstructionTarget;
  readonly sourceRevision: string;
  readonly sourceDirtyState: "clean" | "included";
  readonly sourceTreeDigest: string;
  readonly packageRevisions: Readonly<Record<string, string>>;
  readonly productVersion: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly providerRevision: string;
  readonly providerEndpoint: string;
  readonly providerAuthentication: "none" | "bearer";
  readonly modelId: string;
  readonly modelRevision: string;
  readonly environmentId: string;
  readonly providerTimeoutMs: number;
  readonly maximumInputBytes: number;
  readonly sandboxEnforcement: "disabled" | "enforced";
  readonly limitations: readonly string[];
}): HelarcProductEffectivenessTargetValues {
  const agent = createHelarcAgent({
    target: input.instructionTarget,
    providerId: input.providerId,
    modelId: input.modelId,
  });
  return Object.freeze({
    source: Object.freeze({
      revision: input.sourceRevision,
      dirtyState: input.sourceDirtyState,
      treeDigest: input.sourceTreeDigest,
    }),
    packages: Object.freeze({ ...input.packageRevisions }),
    product: Object.freeze({ id: "helarc", version: input.productVersion }),
    agent: Object.freeze({ id: agent.id, revision: agent.revision }),
    agent_instructions: Object.freeze({
      target: input.instructionTarget,
      release: Object.freeze({ ...agent.instructions.release }),
      instructions: Object.freeze({ ...agent.instructions.ref }),
      resolverRevision: agent.instructions.resolverRevision,
      contentDigest: Object.freeze({ ...agent.instructions.contentDigest }),
      providerId: agent.instructions.model.providerId,
      modelId: agent.instructions.model.modelId,
      blocks: Object.freeze(agent.instructions.blocks.map((block) => Object.freeze({
        id: block.id,
        source: Object.freeze({ ...block.source }),
      }))),
      fullTextExcluded: true,
    }),
    product_protocol: Object.freeze({
      promptArchitectureRevision: "helarc-prompt-v6",
      controllerProtocolRevision: HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
      controllerControlGuidanceRevision: HELARC_CONTROLLER_CONTROL_GUIDANCE.revision,
      toolGuidanceReleaseId: HELARC_BASELINE_TOOL_GUIDANCE_RELEASE_ID,
      toolGuidanceProfileRevision: HELARC_BASELINE_TOOL_GUIDANCE_PROFILE_REVISION,
    }),
    model: Object.freeze({ id: input.modelId, revision: input.modelRevision }),
    provider: Object.freeze({
      id: input.providerId,
      kind: input.providerKind,
      revision: input.providerRevision,
      endpoint: input.providerEndpoint,
      authentication: input.providerAuthentication,
    }),
    tool_exposure: Object.freeze({
      profile: "helarc-bounded-code-agent",
      revision: "trusted-tool-exposure-v1",
    }),
    context_projection: Object.freeze({ revision: "helarc-context-projection-v1" }),
    policy: Object.freeze({ snapshotId: "helarc-evaluation-policy-v1" }),
    permission: Object.freeze({ profile: "full_access", reviewer: "none" }),
    sandbox: Object.freeze({ enforcement: input.sandboxEnforcement }),
    verification: Object.freeze({ profile: "helarc-code-agent", completionGate: "current" }),
    limits: Object.freeze({
      maximumDurationMs: 300_000,
      maximumOperations: 100,
      maximumIterations: 50,
      providerTimeoutMs: input.providerTimeoutMs,
      maximumInputBytes: input.maximumInputBytes,
      repetitions: 3,
    }),
    environment: Object.freeze({ id: input.environmentId }),
    limitations: Object.freeze([...input.limitations]),
  });
}

export function createHelarcProductEffectivenessObjective(input: {
  readonly ref: EvaluationRecordRef;
  readonly outcomeCriterionRef: EvaluationRecordRef;
  readonly qualityGateRef: EvaluationRecordRef;
  readonly safetyGateRefs: readonly EvaluationRecordRef[];
  readonly createdAt: string;
}): EvaluationObjective {
  return createEvaluationObjective({
    ref: input.ref,
    name: "Helarc Product effectiveness against Codex",
    decision: "Whether Helarc reaches the accepted whole-Product outcome threshold without violating absolute safety gates.",
    dimensions: [
      "outcome_quality",
      "safety",
      "reliability",
      "trajectory",
      "collaboration",
      "efficiency",
    ],
    criterionRefs: [input.outcomeCriterionRef],
    qualityGateRefs: [input.qualityGateRef],
    safetyGateRefs: input.safetyGateRefs,
    behaviorInputRequirements: HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS.map((item) => ({
      key: item.key,
      owner: item.owner,
      required: true,
      schemaRef: {
        schemaId: `helarc.product-effectiveness.target-input.${item.key}`,
        revision: "1",
      },
      maximumSensitivity: "internal" as const,
      description: `Immutable ${item.key} input used by one comparison target.`,
    })),
    suiteConstraints: {
      storage: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.suiteStorage,
      minimumPairedTrialsPerTargetCase:
        HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.minimumPairedTrialsPerTargetCase,
      pairedTargets: ["codex", "helarc"],
    },
    comparisonBasis: {
      claim: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.claim,
      primaryMetric: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.primaryMetric,
      minimumWeightedOutcomeRatio:
        HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.minimumWeightedOutcomeRatio,
      absoluteSafetyGates: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates,
      scriptedProviderOutputAdmissible:
        HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.scriptedProviderOutputAdmissible,
    },
    acceptableExclusionCodes: [
      "target_surface_incomparable",
      "reference_unavailable",
      "environment_invalid",
    ],
    createdAt: input.createdAt,
    metadata: {
      protocolRevision: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.revision,
      referenceTarget: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.referenceTarget,
    },
    limitations: [],
  });
}

export function createHelarcProductEffectivenessTargetSnapshot(input: {
  readonly ref: EvaluationRecordRef;
  readonly targetRef: EvaluationRecordRef;
  readonly objective: EvaluationObjective;
  readonly targetName: "codex" | "helarc";
  readonly sourceRevision: string;
  readonly values: HelarcProductEffectivenessTargetValues;
  readonly disposition: HelarcEvaluationDisposition;
  readonly createdAt: string;
}): EvaluationTargetSnapshot {
  return createEvaluationTargetSnapshot({
    ref: input.ref,
    objectiveRef: input.objective.ref,
    targetRef: input.targetRef,
    manifest: HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS.map((item) => ({
      key: item.key,
      owner: item.owner,
      required: true,
      sourceRevision: input.sourceRevision,
      schemaRef: {
        schemaId: `helarc.product-effectiveness.target-input.${item.key}`,
        revision: "1",
      },
      status: "captured" as const,
      representation: {
        kind: "value" as const,
        value: input.values[item.key],
      },
      sensitivity: "internal" as const,
      disclosure: "internal" as const,
      limitation: null,
    })),
    createdAt: input.createdAt,
    metadata: {
      protocolRevision: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.revision,
      targetName: input.targetName,
      claim: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.claim,
      disposition: input.disposition.status,
      dispositionCode: input.disposition.status === "comparable"
        ? null
        : input.disposition.code,
      dispositionReason: input.disposition.status === "comparable"
        ? null
        : input.disposition.reason,
    },
    limitations: [],
  }, input.objective);
}

function targetInput<TKey extends string, TOwner extends string>(
  key: TKey,
  owner: TOwner,
): { readonly key: TKey; readonly owner: TOwner } {
  return Object.freeze({ key, owner });
}
