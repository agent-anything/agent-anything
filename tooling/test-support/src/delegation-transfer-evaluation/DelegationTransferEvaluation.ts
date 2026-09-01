import { createHash } from "node:crypto";
import type { Provider } from "@agent-anything/model-interaction";
import { createEvaluationTrial } from "@agent-anything/evaluation/trial";
import {
  FakeNativeToolProvider,
  fakeNativeModelOutput,
  type FakeNativeToolProviderStep,
} from "../provider/FakeNativeToolProvider.js";
import {
  HELARC_EVALUATION_TIME,
  createHelarcEvaluationCorpus,
  type HelarcEvaluationCaseDefinition,
} from "../evaluation-targets/helarc/HelarcEvaluationCorpus.js";
import {
  executeHelarcEvaluationCase,
  type HelarcEvaluationRunMaterial,
} from "../evaluation-targets/helarc/HelarcEvaluationTarget.js";

const ROOT_PURPOSE_MARKER = "Inspect src/index.ts and report the exported value.";
const DELEGATED_OBJECTIVE_MARKERS = Object.freeze([
  "Inspect src/index.ts and identify the exported value without changing files.",
  "Read src/index.ts and report the exported symbol and value without changing files.",
]);
const EXPECTED_DESCENDANTS = 2;

export interface DelegationTransferMetrics {
  readonly objectiveFidelityRate: number;
  readonly unnecessaryDelegationCount: number;
  readonly semanticDriftCount: number;
  readonly resultAttributionRate: number;
  readonly effectTruthRate: number;
  readonly completionRate: number;
  readonly toolCallCount: number;
  readonly modelTurnCount: number;
  readonly latencyMs: number;
  readonly humanInteractionEvents: number;
  readonly terminalOutcome: "succeeded" | "blocked" | "failed" | "cancelled";
}

export interface DelegationTransferInvariantSummary {
  readonly exactLifecycleCorrelation: boolean;
  readonly delegatedObjectivesIsolated: boolean;
  readonly ordinaryDelegationContextIsolated: boolean;
  readonly resultsAttributed: boolean;
  readonly effectsTruthful: boolean;
  readonly terminalTruthPreserved: boolean;
}

export interface DelegationTransferEvaluationReport {
  readonly revision: "delegation-transfer-deterministic-evaluation-v6";
  readonly metrics: DelegationTransferMetrics;
  readonly invariants: DelegationTransferInvariantSummary;
  readonly descendantRunCount: number;
  readonly settledResultCount: number;
  readonly prohibitedDisclosureCount: 0;
  readonly digest: string;
}

export interface DelegationTransferDiagnosticTargetSnapshot {
  readonly providerRevision: string;
  readonly modelRevision: string;
  readonly environmentRevision: string;
  readonly settingsRevision: string;
  readonly permissionRevision: string;
}

export type DelegationTransferModelDiagnostic =
  | {
      readonly status: "unavailable";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "incomparable";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "observed";
      readonly target: DelegationTransferDiagnosticTargetSnapshot;
      readonly metrics: DelegationTransferMetrics;
      readonly limitations: readonly string[];
    };

export async function runDelegationTransferDeterministicEvaluation(): Promise<
  DelegationTransferEvaluationReport
> {
  const material = await executeRecursiveCase(new FakeNativeToolProvider({
    descriptor: { id: "delegation-transfer-deterministic-provider" },
    steps: scriptedRecursiveSteps(),
  }));
  const metrics = projectMetrics(material);
  const invariants = projectInvariants(material, metrics);
  const started = descendantEvents(material, "run.descendant.started");
  const settled = descendantEvents(material, "run.descendant.settled");
  const materialized = deepFreeze({
    revision: "delegation-transfer-deterministic-evaluation-v6" as const,
    metrics,
    invariants,
    descendantRunCount: started.length,
    settledResultCount: settled.length,
    prohibitedDisclosureCount: 0 as const,
  });
  const serialized = stableJson(materialized);
  if (serialized.includes(ROOT_PURPOSE_MARKER)) {
    throw new TypeError("Delegation Transfer Evaluation disclosed source content.");
  }
  return deepFreeze({ ...materialized, digest: sha256(serialized) });
}

export async function runDelegationTransferModelDiagnostic(input: {
  readonly provider: Provider | null;
  readonly target: DelegationTransferDiagnosticTargetSnapshot | null;
  readonly unavailableReasons?: readonly string[];
}): Promise<DelegationTransferModelDiagnostic> {
  const unavailableReasons = [...new Set(input.unavailableReasons ?? [])];
  if (input.provider === null || unavailableReasons.length > 0) {
    return deepFreeze({
      status: "unavailable" as const,
      reasons: Object.freeze([
        ...(input.provider === null ? ["provider_unavailable"] : []),
        ...unavailableReasons,
      ]),
    });
  }
  if (input.target === null) {
    return deepFreeze({
      status: "incomparable" as const,
      reasons: Object.freeze(["exact_target_snapshot_unavailable"]),
    });
  }
  try {
    const material = await executeRecursiveCase(input.provider);
    return deepFreeze({
      status: "observed" as const,
      target: snapshotDiagnosticTarget(input.target),
      metrics: projectMetrics(material),
      limitations: Object.freeze([
        "diagnostic_only",
        "model_behavior_is_stochastic",
        "deterministic_contract_acceptance_remains_authoritative",
      ]),
    });
  } catch (error) {
    return deepFreeze({
      status: "unavailable" as const,
      reasons: Object.freeze([`diagnostic_execution_failed:${errorClass(error)}`]),
    });
  }
}

async function executeRecursiveCase(provider: Provider): Promise<HelarcEvaluationRunMaterial> {
  const corpus = createHelarcEvaluationCorpus();
  const source = corpus.cases.find(({ scenario }) => scenario === "inspect_and_complete");
  if (source === undefined) throw new TypeError("Delegation Evaluation source Case is unavailable.");
  const caseDefinition: HelarcEvaluationCaseDefinition = deepFreeze({
    ...source,
    definition: {
      ...source.definition,
      ref: { id: "helarc.case.delegation-transfer", revision: "v1" },
      name: "Recursive delegation transfer",
      targetInput: { taskText: ROOT_PURPOSE_MARKER },
      pairingKey: "delegation-transfer",
    },
    expectedClaim: {
      ...source.expectedClaim,
      agentSummary: "Root reports that src/index.ts exports phase26Value with value 42.",
    },
  });
  const trial = createEvaluationTrial({
    ref: { id: "helarc.case.delegation-transfer.trial", revision: "v1" },
    campaignRef: corpus.campaign.ref,
    targetSnapshotRef: corpus.targetSnapshot.ref,
    caseRef: caseDefinition.definition.ref,
    repetitionOrdinal: 1,
    seed: "delegation-transfer-seed",
    pairingKey: caseDefinition.definition.pairingKey,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
  });
  return executeHelarcEvaluationCase({
    trial,
    caseDefinition,
    provider,
    signal: new AbortController().signal,
    runTreeLimits: {
      maxTotalDescendantRuns: 2,
      maxActiveDescendantRuns: 2,
      maxDescendantDepth: 2,
    },
  });
}

function scriptedRecursiveSteps(): readonly FakeNativeToolProviderStep[] {
  return Object.freeze([
    scriptedSuccess({
      kind: "tool_call",
      toolName: "Agent",
      reason: "Delegate a bounded inspection.",
      input: {
        prompt: "Inspect src/index.ts and identify the exported value without changing files.",
        description: "Inspect the declared source file",
      },
    }, 1),
    scriptedSuccess({
      kind: "tool_call",
      toolName: "Agent",
      reason: "Delegate the exact source read.",
      input: {
        prompt: "Read src/index.ts and report the exported symbol and value without changing files.",
        description: "Read the exact source",
      },
    }, 2),
    scriptedSuccess({
      kind: "completion",
      summary: "src/index.ts exports phase26Value with value 42.",
    }, 3),
    scriptedSuccess({
      kind: "completion",
      summary: "The delegated inspection found phase26Value with value 42.",
    }, 4),
    scriptedSuccess({
      kind: "completion",
      summary: "Root reports that src/index.ts exports phase26Value with value 42.",
    }, 5),
  ]);
}

function projectMetrics(material: HelarcEvaluationRunMaterial): DelegationTransferMetrics {
  const started = descendantEvents(material, "run.descendant.started");
  const settled = descendantEvents(material, "run.descendant.settled");
  const controllerRequestMaterials = initialControllerRequestMaterials(material);
  const objectiveMarkers = [ROOT_PURPOSE_MARKER, ...DELEGATED_OBJECTIVE_MARKERS];
  const faithful = controllerRequestMaterials.filter((request) =>
    objectiveMarkers.filter((marker) => request.includes(marker)).length === 1
  ).length;
  const drifted = material.providerResults.filter((result) =>
    result.kind === "succeeded" &&
    result.response.kind === "native_tool_turn" &&
    modelTurnCallCount(result.response.turn.assistant.content) === 0 &&
    !modelTurnText(result.response.turn.assistant.content).includes("42")
  ).length;
  const attributed = settled.filter((event) =>
    tokenField(event, "requestId") !== null &&
    tokenField(event, "resultId") !== null &&
    tokenField(event, "childRunId") !== null
  ).length;
  const truthfulEffects = settled.filter((event) =>
    tokenField(event, "effectStatus") === "none"
  ).length;
  const toolCallCount = material.providerResults.filter((result) =>
    result.kind === "succeeded" &&
    result.response.kind === "native_tool_turn" &&
    modelTurnCallCount(result.response.turn.assistant.content) > 0
  ).length;
  return deepFreeze({
    objectiveFidelityRate: ratio(faithful, controllerRequestMaterials.length),
    unnecessaryDelegationCount: Math.max(0, started.length - EXPECTED_DESCENDANTS),
    semanticDriftCount: drifted,
    resultAttributionRate: ratio(attributed, settled.length),
    effectTruthRate: ratio(truthfulEffects, settled.length),
    completionRate: material.runResult.status === "succeeded" && material.product.status === "completed"
      ? 1
      : 0,
    toolCallCount,
    modelTurnCount: material.providerRequests.length,
    latencyMs: traceDuration(material),
    humanInteractionEvents: material.interactionSubmissionCount,
    terminalOutcome: material.runResult.status,
  });
}

function modelTurnCallCount(
  content: Extract<
    import("@agent-anything/model-interaction").ModelMessage,
    { readonly role: "assistant" }
  >["content"],
): number {
  return content.filter((block) => block.kind === "model_tool_call").length;
}

function modelTurnText(
  content: Extract<
    import("@agent-anything/model-interaction").ModelMessage,
    { readonly role: "assistant" }
  >["content"],
): string {
  return content.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
}

function projectInvariants(
  material: HelarcEvaluationRunMaterial,
  metrics: DelegationTransferMetrics,
): DelegationTransferInvariantSummary {
  const started = descendantEvents(material, "run.descendant.started");
  const settled = descendantEvents(material, "run.descendant.settled");
  const startedRelations = new Set(started.map((event) => tokenField(event, "relationId")));
  const settledRelations = new Set(settled.map((event) => tokenField(event, "relationId")));
  const controllerRequestMaterials = initialControllerRequestMaterials(material);
  const delegatedRequestMaterials = controllerRequestMaterials.filter((request) =>
    DELEGATED_OBJECTIVE_MARKERS.some((marker) => request.includes(marker))
  );
  const representedDelegatedObjectives = new Set(DELEGATED_OBJECTIVE_MARKERS.filter((marker) =>
    delegatedRequestMaterials.some((request) => request.includes(marker))
  ));
  return deepFreeze({
    exactLifecycleCorrelation: started.length === EXPECTED_DESCENDANTS &&
      settled.length === EXPECTED_DESCENDANTS &&
      startedRelations.size === EXPECTED_DESCENDANTS &&
      [...startedRelations].every((relation) => relation !== null && settledRelations.has(relation)),
    delegatedObjectivesIsolated: metrics.objectiveFidelityRate === 1 &&
      representedDelegatedObjectives.size === EXPECTED_DESCENDANTS &&
      delegatedRequestMaterials.every((request) => !request.includes(ROOT_PURPOSE_MARKER)),
    ordinaryDelegationContextIsolated: started.every((event) =>
      numberField(event, "contextSourceCount") === 0
    ),
    resultsAttributed: metrics.resultAttributionRate === 1,
    effectsTruthful: metrics.effectTruthRate === 1,
    terminalTruthPreserved: metrics.terminalOutcome === "succeeded" && metrics.completionRate === 1,
  });
}

function descendantEvents(
  material: HelarcEvaluationRunMaterial,
  name: "run.descendant.started" | "run.descendant.settled",
): readonly Readonly<Record<string, unknown>>[] {
  return material.runtimeEvents.flatMap((event) =>
    event.name === name && isRecord(event.payload)
      ? [event.payload]
      : []
  );
}

function initialControllerRequestMaterials(
  material: HelarcEvaluationRunMaterial,
): readonly string[] {
  const firstByRunId = new Map<string, string>();
  for (const request of material.providerRequests) {
    if (request.purpose !== "helarc.code-agent.turn") continue;
    const runId = tokenField(request.metadata, "runId");
    if (runId !== null && !firstByRunId.has(runId)) {
      firstByRunId.set(runId, JSON.stringify(request));
    }
  }
  return Object.freeze([...firstByRunId.values()]);
}

function traceDuration(material: HelarcEvaluationRunMaterial): number {
  return material.trace.startedAt === null || material.trace.completedAt === null
    ? 0
    : Math.max(0, Date.parse(material.trace.completedAt) - Date.parse(material.trace.startedAt));
}

function tokenField(value: Readonly<Record<string, unknown>>, field: string): string | null {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function numberField(value: Readonly<Record<string, unknown>>, field: string): number {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function snapshotDiagnosticTarget(
  input: DelegationTransferDiagnosticTargetSnapshot,
): DelegationTransferDiagnosticTargetSnapshot {
  const fields = [
    input.providerRevision,
    input.modelRevision,
    input.environmentRevision,
    input.settingsRevision,
    input.permissionRevision,
  ];
  if (fields.some((value) => value.length === 0 || value !== value.trim())) {
    throw new TypeError("Delegation diagnostic Target Snapshot fields must be non-empty tokens.");
  }
  return deepFreeze({ ...input });
}

function scriptedSuccess(output: unknown, sequence: number): FakeNativeToolProviderStep {
  return fakeNativeModelOutput(output, {
    usage: {
      inputTokens: 10 + sequence,
      outputTokens: 4 + sequence,
      totalTokens: 14 + (sequence * 2),
      costUnits: null,
      metadata: { source: "delegation-transfer-evaluation" },
    },
    metadata: { scriptSequence: sequence },
  });
}

function errorClass(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
