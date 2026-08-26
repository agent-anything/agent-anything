import { createHash } from "node:crypto";
import { createEvaluationTrial } from "@agent-anything/evaluation/trial";
import type { EvaluationDataValue, EvaluationRecordRef } from "@agent-anything/evaluation/definition";
import type { ProviderCallResult } from "@agent-anything/model-interaction";
import type { CreateHelarcAgentInput } from "@agent-anything/helarc/agent";

import {
  HELARC_EVALUATION_TIME,
  createHelarcEvaluationCorpus,
  type HelarcEvaluationCaseDefinition,
  type HelarcEvaluationCorpus,
} from "./HelarcEvaluationCorpus.js";
import {
  executeHelarcEvaluationCase,
  type HelarcEvaluationExecutableCase,
  type HelarcEvaluationRunMaterial,
} from "./HelarcEvaluationTarget.js";
import type {
  HelarcProductEffectivenessDiagnostics,
  HelarcProductEffectivenessEvidenceBundle,
  HelarcProductEffectivenessTrialStatus,
} from "./HelarcProductEffectivenessEvidence.js";

export const HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION =
  "helarc-agent-instruction-evaluation-v1";

type HelarcMainInstructionTarget = CreateHelarcAgentInput["target"];

export type HelarcAgentInstructionEvaluationDisposition =
  | { readonly status: "comparable" }
  | {
      readonly status: "unavailable" | "excluded" | "failed" | "incomparable";
      readonly code: string;
      readonly reason: string;
    };

export interface HelarcAgentInstructionTargetIdentity {
  readonly instructionTarget: HelarcMainInstructionTarget;
  readonly agent: EvaluationRecordRef;
  readonly instructionBinding: EvaluationRecordRef;
  readonly instructions: EvaluationRecordRef;
  readonly release: EvaluationRecordRef;
  readonly resolverRevision: string;
  readonly contentDigest: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly blockSources: readonly EvaluationRecordRef[];
}

export interface HelarcAgentInstructionTrialMetrics {
  readonly outcomeCorrect: boolean;
  readonly outcomeComplete: boolean;
  readonly invalidOrUnsafeActionAttempts: number;
  readonly unnecessaryRepetition: number;
  readonly toolCalls: number;
  readonly objectiveDrift: number;
  readonly clarificationEvents: number;
  readonly planUpdates: number;
  readonly correctionEvents: number;
  readonly delegationCalls: number;
  readonly verificationObserved: boolean;
  readonly terminalTruth: boolean;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly humanAttentionEvents: number;
}

export interface HelarcAgentInstructionConformancePair {
  readonly caseId: string;
  readonly behavior: readonly HelarcInstructionBehavior[];
  readonly disposition: HelarcAgentInstructionEvaluationDisposition;
  readonly minimal: {
    readonly target: HelarcAgentInstructionTargetIdentity;
    readonly metrics: HelarcAgentInstructionTrialMetrics;
  };
  readonly production: {
    readonly target: HelarcAgentInstructionTargetIdentity;
    readonly metrics: HelarcAgentInstructionTrialMetrics;
  };
  readonly nonInstructionInputFingerprint: string;
  readonly nonInstructionInputsEquivalent: boolean;
  readonly semanticOutcomeEquivalent: boolean;
  readonly harnessSemanticsEquivalent: boolean;
  readonly safeProjectionExcludedFullInstructions: boolean;
}

export type HelarcInstructionBehavior =
  | "read"
  | "edit"
  | "command"
  | "clarification"
  | "planning"
  | "correction"
  | "delegation"
  | "verification"
  | "completion";

export interface HelarcAgentInstructionConformanceReport {
  readonly schemaVersion: 1;
  readonly kind: "helarc_agent_instruction_conformance";
  readonly revision: typeof HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION;
  readonly claim: "harness_instruction_independence";
  readonly disposition: HelarcAgentInstructionEvaluationDisposition;
  readonly pairs: readonly HelarcAgentInstructionConformancePair[];
  readonly behaviorCoverage: readonly HelarcInstructionBehavior[];
  readonly limitations: readonly string[];
}

export interface HelarcAgentInstructionEffectivenessComparison {
  readonly schemaVersion: 1;
  readonly kind: "helarc_agent_instruction_effectiveness_comparison";
  readonly revision: typeof HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION;
  readonly claim: "product_instruction_effectiveness";
  readonly disposition: HelarcAgentInstructionEvaluationDisposition;
  readonly requiredPairCount: number;
  readonly comparablePairCount: number;
  readonly minimalOutcomeMean: number | null;
  readonly productionOutcomeMean: number | null;
  readonly outcomeDelta: number | null;
  readonly diagnostics: {
    readonly minimal: HelarcProductEffectivenessDiagnostics;
    readonly production: HelarcProductEffectivenessDiagnostics;
  };
  readonly limitations: readonly string[];
}

export async function runHelarcAgentInstructionConformance(): Promise<
  HelarcAgentInstructionConformanceReport
> {
  const corpus = createHelarcEvaluationCorpus();
  const cases = createInstructionConformanceCases(corpus);
  const pairs: HelarcAgentInstructionConformancePair[] = [];
  for (const profile of cases) {
    const trial = createTrial(corpus, profile.caseDefinition, profile.id);
    const [minimal, production] = await Promise.all([
      executeHelarcEvaluationCase({
        trial,
        caseDefinition: profile.caseDefinition,
        instructionTarget: "minimal",
        signal: new AbortController().signal,
        ...profile.options,
      }),
      executeHelarcEvaluationCase({
        trial,
        caseDefinition: profile.caseDefinition,
        instructionTarget: "production",
        signal: new AbortController().signal,
        ...profile.options,
      }),
    ]);
    pairs.push(compareConformancePair(profile, minimal, production));
  }
  const behaviorCoverage = Object.freeze([
    ...new Set(pairs.flatMap((pair) => pair.behavior)),
  ].sort()) as readonly HelarcInstructionBehavior[];
  const failed = pairs.find((pair) => pair.disposition.status !== "comparable");
  return deepFreeze({
    schemaVersion: 1,
    kind: "helarc_agent_instruction_conformance",
    revision: HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION,
    claim: "harness_instruction_independence",
    disposition: failed?.disposition ?? { status: "comparable" },
    pairs,
    behaviorCoverage,
    limitations: [
      "Scripted Provider output proves deterministic Harness conformance, not model quality.",
      "Product instruction effectiveness requires separately admitted real-Provider evidence.",
    ],
  });
}

export function compareHelarcAgentInstructionEffectiveness(input: {
  readonly minimal: HelarcProductEffectivenessEvidenceBundle;
  readonly production: HelarcProductEffectivenessEvidenceBundle;
}): HelarcAgentInstructionEffectivenessComparison {
  const nonInstructionInputsEquivalent = nonInstructionManifestFingerprint(
    input.minimal.targetSnapshot.manifest,
  ) === nonInstructionManifestFingerprint(input.production.targetSnapshot.manifest);
  const targetPair = instructionTargetFromBundle(input.minimal) === "minimal" &&
    instructionTargetFromBundle(input.production) === "production";
  const minimalByPair = new Map(input.minimal.trials.map((trial) => [trial.pairingKey, trial]));
  const productionByPair = new Map(
    input.production.trials.map((trial) => [trial.pairingKey, trial]),
  );
  const pairingKeys = [...new Set([...minimalByPair.keys(), ...productionByPair.keys()])].sort();
  const completedPairs = pairingKeys.flatMap((pairingKey) => {
    const minimal = minimalByPair.get(pairingKey);
    const production = productionByPair.get(pairingKey);
    return minimal?.status === "completed" && production?.status === "completed"
      ? [{ minimal, production }]
      : [];
  });
  const requiredPairCount = pairingKeys.length;
  const disposition = effectivenessDisposition({
    nonInstructionInputsEquivalent,
    targetPair,
    requiredPairCount,
    completedPairCount: completedPairs.length,
    statuses: [
      ...input.minimal.trials.map((trial) => trial.status),
      ...input.production.trials.map((trial) => trial.status),
    ],
  });
  const minimalOutcomeMean = average(completedPairs.map((pair) => pair.minimal.outcomeScore));
  const productionOutcomeMean = average(
    completedPairs.map((pair) => pair.production.outcomeScore),
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: "helarc_agent_instruction_effectiveness_comparison",
    revision: HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION,
    claim: "product_instruction_effectiveness",
    disposition,
    requiredPairCount,
    comparablePairCount: completedPairs.length,
    minimalOutcomeMean,
    productionOutcomeMean,
    outcomeDelta: minimalOutcomeMean === null || productionOutcomeMean === null
      ? null
      : productionOutcomeMean - minimalOutcomeMean,
    diagnostics: {
      minimal: summarizeDiagnostics(input.minimal),
      production: summarizeDiagnostics(input.production),
    },
    limitations: [
      "The comparison applies only to the exact paired Suite, target snapshots, model, and environment.",
      "No score is inferred for unavailable, excluded, failed, or incomparable Trials.",
    ],
  });
}

interface ConformanceCaseProfile {
  readonly id: string;
  readonly behavior: readonly HelarcInstructionBehavior[];
  readonly caseDefinition: HelarcEvaluationExecutableCase;
  readonly options: {
    readonly interactionAnswers?: Readonly<Record<string, string>>;
    readonly runTreeLimits?: {
      readonly maxTotalDescendantRuns: number;
      readonly maxActiveDescendantRuns: number;
      readonly maxDescendantDepth: number;
    };
  };
}

function createInstructionConformanceCases(
  corpus: HelarcEvaluationCorpus,
): readonly ConformanceCaseProfile[] {
  const base = corpus.cases.map((caseDefinition) => Object.freeze({
    id: caseDefinition.scenario,
    behavior: scenarioBehavior(caseDefinition.scenario),
    caseDefinition,
    options: Object.freeze({}),
  }));
  const inspect = requireCase(corpus, "inspect_and_complete");
  const write = requireCase(corpus, "controlled_file_write");
  return Object.freeze([
    ...base,
    Object.freeze({
      id: "planning",
      behavior: Object.freeze(["planning", "read", "completion"] as const),
      caseDefinition: scriptedCase(inspect, "planning", [
        {
          kind: "plan_update",
          plan: [
            { step: "Inspect the declared source.", status: "in_progress" },
            { step: "Summarize the result.", status: "pending" },
          ],
        },
        {
          kind: "tool_call",
          toolName: "Read",
          input: { file_path: "src/index.ts" },
        },
        {
          kind: "plan_update",
          plan: [
            { step: "Inspect the declared source.", status: "completed" },
            { step: "Summarize the result.", status: "in_progress" },
          ],
        },
        { kind: "completion", summary: inspect.expectedClaim.agentSummary },
      ], ["Read"]),
      options: Object.freeze({}),
    }),
    Object.freeze({
      id: "clarification",
      behavior: Object.freeze(["clarification", "edit", "completion"] as const),
      caseDefinition: scriptedCase(write, "clarification", [
        {
          kind: "tool_call",
          toolName: "AskUserQuestion",
          input: {
            questions: [{
              id: "content",
              prompt: "Which content should be written?",
              allow_multiple: false,
            }],
          },
        },
        {
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: "src/generated.txt", content: "phase26\n" },
        },
        { kind: "completion", summary: write.expectedClaim.agentSummary },
      ], ["AskUserQuestion", "Write"]),
      options: Object.freeze({ interactionAnswers: Object.freeze({ content: "phase26" }) }),
    }),
    Object.freeze({
      id: "delegation",
      behavior: Object.freeze(["delegation", "completion"] as const),
      caseDefinition: scriptedCase(inspect, "delegation", [
        {
          kind: "tool_call",
          toolName: "Agent",
          input: { prompt: "Inspect the declared source.", description: "Inspect source" },
        },
        { kind: "completion", summary: "Child inspection complete." },
        { kind: "completion", summary: inspect.expectedClaim.agentSummary },
      ], ["Agent"]),
      options: Object.freeze({
        runTreeLimits: Object.freeze({
          maxTotalDescendantRuns: 1,
          maxActiveDescendantRuns: 1,
          maxDescendantDepth: 1,
        }),
      }),
    }),
  ]);
}

function scriptedCase(
  source: HelarcEvaluationCaseDefinition,
  id: string,
  outputs: readonly unknown[],
  requiredActionNames: readonly string[],
): HelarcEvaluationExecutableCase {
  return Object.freeze({
    ...source,
    scenario: id,
    script: Object.freeze({
      ...source.script,
      ref: Object.freeze({ id: `${source.script.ref.id}.${id}`, revision: source.script.ref.revision }),
      responses: Object.freeze(outputs.map((output, index) => scriptedSuccess(output, index + 1))),
    }),
    expectedClaim: Object.freeze({
      ...source.expectedClaim,
      ref: Object.freeze({
        id: `${source.expectedClaim.ref.id}.${id}`,
        revision: source.expectedClaim.ref.revision,
      }),
      requiredActionNames: Object.freeze([...requiredActionNames].sort()),
      retryCount: 0,
    }),
    verificationTargets: Object.freeze([]),
  });
}

function compareConformancePair(
  profile: ConformanceCaseProfile,
  minimal: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
  production: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): HelarcAgentInstructionConformancePair {
  const minimalMetrics = trialMetrics(minimal);
  const productionMetrics = trialMetrics(production);
  const nonInstructionInputFingerprint = nonInstructionRequestFingerprint(minimal);
  const nonInstructionInputsEquivalent = nonInstructionInputFingerprint ===
    nonInstructionRequestFingerprint(production);
  const semanticOutcomeEquivalent = semanticOutcomeFingerprint(minimal) ===
    semanticOutcomeFingerprint(production);
  const harnessSemanticsEquivalent = nonInstructionInputsEquivalent &&
    semanticOutcomeEquivalent;
  const safeProjectionExcludedFullInstructions = instructionsAreAbsentFromSafeProjection(minimal) &&
    instructionsAreAbsentFromSafeProjection(production);
  const disposition: HelarcAgentInstructionEvaluationDisposition =
    harnessSemanticsEquivalent && safeProjectionExcludedFullInstructions &&
      minimalMetrics.outcomeCorrect && productionMetrics.outcomeCorrect
      ? { status: "comparable" }
      : {
          status: "failed",
          code: "harness_instruction_conformance_failed",
          reason: "Instruction-only target variation changed deterministic Harness semantics or safe disclosure.",
        };
  return deepFreeze({
    caseId: profile.id,
    behavior: profile.behavior,
    disposition,
    minimal: { target: targetIdentity(minimal), metrics: minimalMetrics },
    production: { target: targetIdentity(production), metrics: productionMetrics },
    nonInstructionInputFingerprint,
    nonInstructionInputsEquivalent,
    semanticOutcomeEquivalent,
    harnessSemanticsEquivalent,
    safeProjectionExcludedFullInstructions,
  });
}

function targetIdentity(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): HelarcAgentInstructionTargetIdentity {
  const request = material.providerRequests[0];
  if (request === undefined) throw new TypeError("Instruction Evaluation requires a model request.");
  const lineage = request.composition.lineage;
  return deepFreeze({
    instructionTarget: material.instructionTarget,
    agent: asRecordRef(lineage.agent),
    instructionBinding: asRecordRef(lineage.instructionBinding),
    instructions: asRecordRef(lineage.instructions),
    release: asRecordRef(lineage.instructionRelease),
    resolverRevision: requireRevision(lineage.instructionResolver.revision),
    contentDigest: requireRevision(lineage.instructionContent.revision),
    providerId: lineage.instructionModel.providerId,
    modelId: lineage.instructionModel.model,
    blockSources: lineage.instructionBlocks.map(asRecordRef),
  });
}

function trialMetrics(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): HelarcAgentInstructionTrialMetrics {
  const items = material.runResult.items;
  const actionNames = material.actionNames;
  const usage = material.providerResults.reduce((result, current) => {
    const usageValue = current.kind === "succeeded" ? current.response.usage : null;
    return {
      inputTokens: result.inputTokens + (usageValue?.inputTokens ?? 0),
      outputTokens: result.outputTokens + (usageValue?.outputTokens ?? 0),
    };
  }, { inputTokens: 0, outputTokens: 0 });
  const outcomeCorrect = expectedOutcomeMatches(material);
  const verificationObserved = material.product.verification.status !== "not_required" ||
    items.some((item) => item.payload.kind === "verification_feedback");
  const invalidOrUnsafeActionAttempts = material.product.effects.filter((effect) =>
    effect.status !== "succeeded"
  ).length;
  return Object.freeze({
    outcomeCorrect,
    outcomeComplete: outcomeCorrect && material.product.incompleteWork.length === 0,
    invalidOrUnsafeActionAttempts,
    unnecessaryRepetition: actionNames.length - new Set(actionNames).size,
    toolCalls: actionNames.length,
    objectiveDrift: outcomeCorrect ? 0 : 1,
    clarificationEvents: material.interactionSubmissionCount,
    planUpdates: items.filter((item) =>
      item.payload.kind === "state_transition" && item.payload.transition === "plan"
    ).length,
    correctionEvents: material.retryCount + items.filter((item) =>
      item.payload.kind === "progress_correction"
    ).length,
    delegationCalls: actionNames.filter((name) => name === "Agent").length,
    verificationObserved: verificationObserved,
    terminalTruth: expectedTerminalMatches(material),
    latencyMs: Math.max(
      0,
      Date.parse(material.runResult.completedAt) - Date.parse(material.runResult.startedAt),
    ),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    humanAttentionEvents: material.interactionSubmissionCount +
      (material.approval.decision === null ? 0 : 1),
  });
}

function expectedOutcomeMatches(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): boolean {
  const expected = material.caseDefinition.expectedClaim;
  return expectedTerminalMatches(material) &&
    material.product.output.agentSummary === expected.agentSummary &&
    stableJson(material.after.files) === stableJson(expected.workspaceFiles) &&
    stableJson([...material.actionNames].sort()) === stableJson(expected.requiredActionNames) &&
    material.retryCount === expected.retryCount &&
    material.approval.decision === expected.approvalDecision;
}

function expectedTerminalMatches(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): boolean {
  const expected = material.caseDefinition.expectedClaim;
  return material.product.status === expected.productStatus &&
    material.runResult.status === expected.runStatus;
}

function nonInstructionRequestFingerprint(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): string {
  const nonInstructionMaterial = material.providerRequests.map((request) => ({
    capability: request.capability,
    outputFormat: request.outputFormat,
    sections: request.composition.sections
      .filter((section) => section.kind !== "agent_instruction")
      .map((section) => ({
        id: section.id,
        kind: section.kind,
        role: section.role,
        necessity: section.necessity,
      })),
  }));
  return digest({
    caseDefinition: {
      ref: material.caseDefinition.definition.ref,
      targetInput: material.caseDefinition.definition.targetInput,
      fixture: material.caseDefinition.fixture,
      script: material.caseDefinition.script,
    },
    requestShape: nonInstructionMaterial,
  });
}

function semanticOutcomeFingerprint(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): string {
  return digest({
    productStatus: material.product.status,
    runStatus: material.runResult.status,
    runCode: material.runResult.code,
    summary: material.product.output.agentSummary,
    workspace: material.after,
    actionNames: material.actionNames,
    approval: material.approval,
    retryCount: material.retryCount,
    interactions: material.interactionSubmissionCount,
    effects: material.product.effects.map((effect) => ({
      semanticOwner: effect.semanticOwner,
      status: effect.status,
      effectCertainty: effect.effectCertainty,
      completionExtent: effect.completionExtent,
    })),
    verification: {
      status: material.product.verification.status,
      counts: material.product.verification.counts,
      activeChecks: material.product.verification.activeChecks,
      gateStatus: material.product.verification.gateStatus,
      safeReasons: material.product.verification.safeReasons,
    },
    plans: material.runResult.items.flatMap((item) =>
      item.payload.kind === "state_transition" && item.payload.transition === "plan"
        ? [item.payload.plan]
        : []
    ),
    terminalKinds: material.runResult.items.map((item) => item.payload.kind),
  });
}

function instructionsAreAbsentFromSafeProjection(
  material: HelarcEvaluationRunMaterial<HelarcEvaluationExecutableCase>,
): boolean {
  const safe = JSON.stringify({
    host: material.hostProjection,
    product: material.productProjection,
  });
  return material.providerRequests.every((request) =>
    request.composition.sections
      .filter((section) => section.kind === "agent_instruction")
      .every((section) =>
        section.content.kind !== "text" || !safe.includes(section.content.text)
      )
  );
}

function scenarioBehavior(scenario: string): readonly HelarcInstructionBehavior[] {
  const map: Readonly<Record<string, readonly HelarcInstructionBehavior[]>> = {
    inspect_and_complete: ["read", "completion"],
    search: ["read", "completion"],
    controlled_file_write: ["edit", "completion"],
    denied_command: ["command", "completion"],
    malformed_output_retry: ["correction", "completion"],
    multi_file_mutation: ["edit", "verification", "completion"],
    ordinary_shell_validation: ["command", "verification", "completion"],
    failed_check_recovery: ["command", "correction", "verification", "completion"],
    stale_evidence: ["edit", "verification", "completion"],
    premature_completion: ["verification", "completion"],
  };
  return Object.freeze([...(map[scenario] ?? ["completion"])]);
}

function createTrial(
  corpus: HelarcEvaluationCorpus,
  caseDefinition: HelarcEvaluationExecutableCase,
  id: string,
) {
  return createEvaluationTrial({
    ref: {
      id: `helarc.agent-instruction-evaluation.${id}.trial`,
      revision: HELARC_AGENT_INSTRUCTION_EVALUATION_REVISION,
    },
    campaignRef: corpus.campaign.ref,
    targetSnapshotRef: corpus.targetSnapshot.ref,
    caseRef: caseDefinition.definition.ref,
    repetitionOrdinal: 1,
    seed: `helarc-agent-instruction-evaluation-${id}`,
    pairingKey: `helarc-agent-instruction-evaluation.${id}`,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { claim: "harness_instruction_independence" },
  });
}

function scriptedSuccess(output: unknown, sequence: number): ProviderCallResult {
  return Object.freeze({
    kind: "succeeded",
    response: Object.freeze({
      output,
      responseId: null,
      continuation: null,
      usage: Object.freeze({
        inputTokens: 10 + sequence,
        outputTokens: 4 + sequence,
        totalTokens: 14 + sequence * 2,
        metadata: Object.freeze({ source: "instruction-conformance" }),
      }),
      metadata: Object.freeze({ scriptSequence: sequence }),
    }),
  });
}

function requireCase(
  corpus: HelarcEvaluationCorpus,
  scenario: HelarcEvaluationCaseDefinition["scenario"],
): HelarcEvaluationCaseDefinition {
  const result = corpus.cases.find((item) => item.scenario === scenario);
  if (result === undefined) throw new TypeError(`Missing Evaluation Case '${scenario}'.`);
  return result;
}

function instructionTargetFromBundle(
  bundle: HelarcProductEffectivenessEvidenceBundle,
): HelarcMainInstructionTarget | null {
  const entry = bundle.targetSnapshot.manifest.find((candidate) =>
    candidate.key === "agent_instructions"
  );
  const value = entry?.representation?.kind === "value" ? entry.representation.value : null;
  if (!isEvaluationDataObject(value)) return null;
  return value.target === "minimal" || value.target === "production" ? value.target : null;
}

function nonInstructionManifestFingerprint(
  manifest: readonly {
    readonly key: string;
    readonly representation: { readonly kind: string; readonly value?: EvaluationDataValue } | null;
    readonly status: string;
  }[],
): string {
  return digest(manifest.filter((entry) =>
    entry.key !== "agent" && entry.key !== "agent_instructions"
  ));
}

function effectivenessDisposition(input: {
  readonly nonInstructionInputsEquivalent: boolean;
  readonly targetPair: boolean;
  readonly requiredPairCount: number;
  readonly completedPairCount: number;
  readonly statuses: readonly HelarcProductEffectivenessTrialStatus[];
}): HelarcAgentInstructionEvaluationDisposition {
  if (!input.targetPair) {
    return {
      status: "incomparable",
      code: "instruction_target_pair_invalid",
      reason: "The Evidence does not identify one minimal and one production target.",
    };
  }
  if (!input.nonInstructionInputsEquivalent) {
    return {
      status: "incomparable",
      code: "non_instruction_input_mismatch",
      reason: "A non-instruction target input differs between paired Evidence bundles.",
    };
  }
  if (input.statuses.includes("invalid")) {
    return {
      status: "failed",
      code: "instruction_trial_invalid",
      reason: "At least one instruction Evaluation Trial is invalid.",
    };
  }
  if (input.statuses.includes("incomparable")) {
    return {
      status: "incomparable",
      code: "instruction_trial_incomparable",
      reason: "At least one instruction Evaluation Trial is incomparable.",
    };
  }
  if (input.statuses.includes("excluded")) {
    return {
      status: "excluded",
      code: "instruction_trial_excluded",
      reason: "At least one instruction Evaluation Trial is explicitly excluded.",
    };
  }
  if (
    input.statuses.includes("unavailable") ||
    input.requiredPairCount === 0 ||
    input.completedPairCount !== input.requiredPairCount
  ) {
    return {
      status: "unavailable",
      code: "instruction_trial_coverage_unavailable",
      reason: "Complete paired real-Provider instruction Evidence is unavailable.",
    };
  }
  return { status: "comparable" };
}

function summarizeDiagnostics(
  bundle: HelarcProductEffectivenessEvidenceBundle,
): HelarcProductEffectivenessDiagnostics {
  const completed = bundle.trials.filter((trial) => trial.status === "completed");
  return Object.freeze({
    trajectoryScore: average(completed.map((trial) => trial.diagnostics.trajectoryScore)),
    verificationScore: average(completed.map((trial) => trial.diagnostics.verificationScore)),
    latencyMs: average(completed.map((trial) => trial.diagnostics.latencyMs)),
    inputTokens: average(completed.map((trial) => trial.diagnostics.inputTokens)),
    outputTokens: average(completed.map((trial) => trial.diagnostics.outputTokens)),
    toolCalls: average(completed.map((trial) => trial.diagnostics.toolCalls)),
    humanAttentionEvents: average(
      completed.map((trial) => trial.diagnostics.humanAttentionEvents),
    ),
  });
}

function average(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === values.length && present.length > 0
    ? present.reduce((sum, value) => sum + value, 0) / present.length
    : null;
}

function asRecordRef(input: { readonly id: string; readonly revision: string | null }): EvaluationRecordRef {
  return Object.freeze({ id: input.id, revision: requireRevision(input.revision) });
}

function requireRevision(value: string | null): string {
  if (value === null || value.length === 0) {
    throw new TypeError("Instruction lineage requires a concrete revision.");
  }
  return value;
}

function isEvaluationDataObject(
  value: unknown,
): value is Readonly<Record<string, EvaluationDataValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(input: unknown): string {
  return createHash("sha256").update(stableJson(input), "utf8").digest("hex");
}

function stableJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortJson);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, sortJson(value)]));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
