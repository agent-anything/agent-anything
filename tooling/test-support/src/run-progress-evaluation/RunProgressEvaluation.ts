import { createHash } from "node:crypto";
import { createAgentInstructions, type Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  createInteractionProtocolRegistrySnapshot,
} from "@agent-anything/interaction/coordination";
import {
  createOperationBindingResolverSnapshot,
} from "@agent-anything/operation-catalog/binding";
import {
  createOperationCatalogSnapshot,
} from "@agent-anything/operation-catalog/catalog";
import {
  resolvePermissionProfile,
} from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import {
  createFixedLocalToolSelection,
} from "@agent-anything/tools/selection";
import {
  createToolRegistrationSnapshot,
} from "@agent-anything/tools/registration";
import {
  CurrentVerificationCompletionGate,
} from "@agent-anything/verification/completion";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import {
  createControllerModelItems,
} from "@agent-anything/agent-runtime/controller";
import type {
  ModelCallRef,
  ModelToolCall,
} from "@agent-anything/model-interaction";
import {
  assessRunProgress,
  createInitialRunProgressState,
  createRunProgressBasis,
  createRunProgressSemanticFacts,
  type RunProgressBasisProjection,
  type RunProgressCommittedFactInput,
  type RunProgressDisposition,
  type RunProgressLimits,
  type RunProgressReasonCode,
  type RunProgressState,
} from "@agent-anything/agent-runtime/progress";
import type {
  PendingRunSubjectProjection,
  ResolvedRunPermissionConfig,
} from "@agent-anything/agent-runtime/run";
import {
  Runner,
  type RootRunConfig,
  type RunnerDependencies,
} from "@agent-anything/agent-runtime/runner";
import type {
  TaskFulfillmentEvaluationInput,
  TaskFulfillmentEvaluatorPort,
} from "@agent-anything/agent-runtime/completion";
import { createTestContextProjection } from "../TestContextProjectionConfiguration.js";
import { createTestVerificationExecutionFactory } from "../TestVerificationExecutionFactory.js";

const NOW = "2026-08-24T00:00:00.000Z";
const SECRET = "run-progress-evaluation-prohibited-payload";
const LIMITS: RunProgressLimits = Object.freeze({
  checkpointWindowSize: 6,
  nonAdvancingCheckpointThreshold: 2,
  maxCorrectionRounds: 2,
});

export interface RunProgressEvaluationAssessment {
  readonly checkpointSequence: number;
  readonly disposition: RunProgressDisposition;
  readonly reasonCode: RunProgressReasonCode;
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
}

export interface RunProgressEvaluationCaseResult {
  readonly id: string;
  readonly assessments: readonly RunProgressEvaluationAssessment[];
  readonly recovered: boolean;
}

export interface RunProgressRuntimeProbe {
  readonly status: "blocked";
  readonly code: "runtime_no_progress";
  readonly failure: null;
  readonly controllerTurns: number;
  readonly progressAssessments: number;
  readonly correctionRounds: number;
  readonly genericLimitAvoided: boolean;
}

export interface RunProgressEvaluationReport {
  readonly revision: "run-progress-deterministic-evaluation-v1";
  readonly cases: readonly RunProgressEvaluationCaseResult[];
  readonly runtimeProbe: RunProgressRuntimeProbe;
  readonly dispositionCounts: Readonly<Record<RunProgressDisposition, number>>;
  readonly recoveredCaseCount: number;
  readonly prohibitedDisclosureCount: 0;
  readonly digest: string;
}

interface EvaluationStep {
  readonly facts: readonly RunProgressCommittedFactInput[];
  readonly pending?: readonly PendingRunSubjectProjection[];
  readonly basis?: RunProgressBasisProjection;
  readonly activateCorrectionRound?: number;
}

interface TestOutput {
  readonly summary: string;
}

type RunnerOperationComposition = RunnerDependencies["operations"];

type ControllerStep =
  | ControllerDecision<TestOutput>
  | ((
      input: ControllerInput<TestOutput>,
      context: ControllerCallContext,
    ) => ControllerDecision<TestOutput> | Promise<ControllerDecision<TestOutput>>);

export async function runRunProgressDeterministicEvaluation(): Promise<RunProgressEvaluationReport> {
  const cases = Object.freeze([
    await evaluateCase("equivalent-calls-ignore-volatile-identities", [
      { facts: [operationFact("read", "call-1", ownerOutcome("read-state", "new_information"))] },
      { facts: [operationFact("read", "call-2", ownerOutcome("read-state", "new_information"))] },
    ]),
    await evaluateCase("repeated-missing-target-stagnates", [
      { facts: [{ kind: "operation_rejected", owner: "workspace", code: "target_missing" }] },
      { facts: [{ kind: "operation_rejected", owner: "workspace", code: "target_missing" }] },
    ]),
    await evaluateCase("repeated-invalid-input-stagnates", [
      { facts: [{ kind: "tool_rejected", code: "tool_input_invalid" }] },
      { facts: [{ kind: "tool_rejected", code: "tool_input_invalid" }] },
    ]),
    await evaluateCase("identical-successful-read-is-not-advancement", [
      { facts: [operationFact("read", "read-1", null)] },
      { facts: [operationFact("read", "read-2", null)] },
    ]),
    await evaluateCase("no-op-mutation-is-not-advancement", [
      { facts: [operationFact("write", "write-1", ownerOutcome("same-file", "no_change"))] },
      { facts: [operationFact("write", "write-2", ownerOutcome("same-file", "no_change"))] },
    ]),
    await evaluateCase("correction-recovers-on-new-owner-fact", [
      { facts: [planFact("plan-a", 1)] },
      {
        activateCorrectionRound: 1,
        facts: [operationFact("inspect", "inspect-1", ownerOutcome("snapshot-2", "new_information"))],
      },
    ]),
    await evaluateCase("plan-text-churn-does-not-advance", [
      { facts: [planFact("plan-one", 1)] },
      { facts: [planFact("plan-two-with-different-text", 99)] },
    ]),
    await evaluateCase("required-interaction-defers-assessment", [
      { facts: [runActionFact()] },
      { facts: [], pending: [pending("interaction", "approval-1")] },
    ]),
    await evaluateCase("accepted-steering-clears-current-streak", [
      { facts: [runActionFact()] },
      {
        activateCorrectionRound: 1,
        basis: basis({ steeringFingerprint: digest("steering-basis") }),
        facts: [steeringFact()],
      },
    ]),
    await evaluateCase("active-agent-cycle-cannot-manufacture-novelty", [
      { facts: [activeAgentFact("agent-a", "agent-b")] },
      { facts: [activeAgentFact("agent-b", "agent-a")] },
      { facts: [activeAgentFact("agent-a", "agent-b")] },
    ]),
    await evaluateCase("slow-novel-investigation-remains-advancing", [
      { facts: [operationFact("inspect", "inspect-1", ownerOutcome("snapshot-1", "new_information"))] },
      { facts: [operationFact("inspect", "inspect-2", ownerOutcome("snapshot-2", "new_information"))] },
      { facts: [operationFact("inspect", "inspect-3", ownerOutcome("snapshot-3", "new_information"))] },
    ]),
    await evaluateCase("parent-wait-defers-until-child-settlement", [
      { facts: [], pending: [pending("descendant_run", "child-1")] },
      { facts: [descendantSettlementFact("child-1")] },
    ]),
  ]);
  const runtimeProbe = await runBoundedPlanChurnProbe();
  const dispositionCounts: Record<RunProgressDisposition, number> = {
    advanced: 0,
    unchanged: 0,
    repeated: 0,
    deferred: 0,
  };
  for (const result of cases) {
    for (const assessment of result.assessments) dispositionCounts[assessment.disposition] += 1;
  }
  const material = deepFreeze({
    revision: "run-progress-deterministic-evaluation-v1" as const,
    cases,
    runtimeProbe,
    dispositionCounts: deepFreeze(dispositionCounts),
    recoveredCaseCount: cases.filter(({ recovered }) => recovered).length,
    prohibitedDisclosureCount: 0 as const,
  });
  const serialized = stableJson(material);
  if (serialized.includes(SECRET)) {
    throw new TypeError("Run Progress Evaluation disclosed prohibited source payload.");
  }
  return deepFreeze({ ...material, digest: sha256(serialized) });
}

async function evaluateCase(
  id: string,
  steps: readonly EvaluationStep[],
): Promise<RunProgressEvaluationCaseResult> {
  let state = createInitialRunProgressState();
  let priorDisposition: RunProgressDisposition | null = null;
  let recovered = false;
  const assessments: RunProgressEvaluationAssessment[] = [];
  for (const step of steps) {
    if (step.activateCorrectionRound !== undefined) {
      state = activateCorrection(state, step.activateCorrectionRound);
    }
    const facts = Object.freeze((await Promise.all(
      step.facts.map(createRunProgressSemanticFacts),
    )).flat());
    const result = assessRunProgress({
      runId: "evaluation-run",
      previousState: state,
      basis: await createRunProgressBasis(step.basis ?? basis()),
      committedFacts: facts,
      requiredPending: step.pending ?? [],
      limits: LIMITS,
    });
    assessments.push(deepFreeze({
      checkpointSequence: result.assessment.ref.checkpointSequence,
      disposition: result.assessment.disposition,
      reasonCode: result.assessment.reasonCode,
      consecutiveNonAdvancingCheckpoints:
        result.assessment.consecutiveNonAdvancingCheckpoints,
      correctionRounds: result.assessment.correctionRounds,
      activeCorrectionRound: result.assessment.activeCorrectionRound,
    }));
    recovered ||= priorDisposition !== "advanced" &&
      result.assessment.disposition === "advanced" &&
      state.activeCorrectionRound !== null;
    priorDisposition = result.assessment.disposition;
    state = result.state;
  }
  return deepFreeze({ id, assessments: Object.freeze(assessments), recovered });
}

async function runBoundedPlanChurnProbe(): Promise<RunProgressRuntimeProbe> {
  const operations = emptyOperations();
  const controller = new ScriptedController([
    advance([planCandidate("model-plan-1", 1)], "model-plan-1"),
    advance([planCandidate("model-plan-2", 2)], "model-plan-2"),
  ]);
  const result = await new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    operations,
    completion: {
      taskFulfillment: fulfilledEvaluator(),
      maximumDurationMs: 5_000,
    },
    verification: {
      executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
      completionGate: new CurrentVerificationCompletionGate(() => NOW),
      preparation: null,
      settledOperationResults: null,
      checkResults: null,
    },
    interactions: createInteractionProtocolRegistrySnapshot("progress-evaluation-interactions", []),
    now: () => NOW,
    createRunId: () => "progress-evaluation-run",
  }).run(testAgent(), runInput(), runConfig(operations));
  const assessments = result.items.flatMap(({ payload }) =>
    payload.kind === "progress_assessment" ? [payload.assessment] : []
  );
  const correctionRounds = assessments.reduce(
    (maximum, assessment) => Math.max(maximum, assessment.correctionRounds),
    0,
  );
  if (result.status !== "blocked" || result.code !== "runtime_no_progress") {
    throw new TypeError(
      `Bounded Plan-churn probe settled as '${result.status}/${result.code ?? "none"}': ${JSON.stringify(result.failure)}.`,
    );
  }
  return deepFreeze({
    status: result.status,
    code: result.code,
    failure: result.failure,
    controllerTurns: controller.calls.length,
    progressAssessments: assessments.length,
    correctionRounds,
    genericLimitAvoided: controller.calls.length < 20,
  });
}

class ScriptedController implements Controller<TestOutput> {
  readonly calls: ControllerInput<TestOutput>[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

  async next(
    input: ControllerInput<TestOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TestOutput>> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("Progress Evaluation Controller exhausted its script.");
    return typeof step === "function" ? step(input, context) : step;
  }
}

function fulfilledEvaluator(): TaskFulfillmentEvaluatorPort {
  const ref = Object.freeze({ owner: "evaluation", id: "run-progress-task-fulfillment", revision: "1" });
  return Object.freeze({
    ref,
    async evaluate(input: TaskFulfillmentEvaluationInput) {
      return Object.freeze({
        kind: "assessed" as const,
        assessment: Object.freeze({
          ref: input.assessment,
          evaluator: ref,
          run: input.run,
          turn: input.turn,
          objective: input.objective,
          proposal: input.proposal,
          status: "fulfilled" as const,
          rationale: "The deterministic progress probe accepts its scripted completion.",
          findings: Object.freeze([]),
          feedback: null,
          assessedAt: NOW,
        }),
      });
    },
  });
}

function emptyOperations(): RunnerOperationComposition {
  const catalog = createOperationCatalogSnapshot({
    id: "progress-evaluation-operation-catalog",
    revision: "1",
    entries: [],
  });
  return Object.freeze({
    catalog,
    bindings: createOperationBindingResolverSnapshot(
      "progress-evaluation-operation-bindings",
      [],
    ),
    validateToolInput: () => true,
    internalHandlers: Object.freeze([]),
    availability: Object.freeze([]),
  });
}

function runConfig(operations: RunnerOperationComposition): RootRunConfig {
  const registrations = createToolRegistrationSnapshot(operations.catalog, []);
  return deepFreeze({
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Evaluation workspace",
        rootRef: "workspace://evaluation",
        trustState: "trusted",
        source: "evaluation",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
    identity: {
      id: "evaluation-user",
      kind: "user",
      displayName: "Evaluation User",
      metadata: {},
    },
    permissions: permissionConfig(),
    tools: createFixedLocalToolSelection(registrations, operations.catalog, []),
    actionExecution: null,
    verification: emptyVerificationConfig(),
    limits: {
      maxIterations: 20,
      maxActions: 20,
      maxConsecutiveActionFailures: 4,
      maxDurationMs: 10_000,
      maxPendingInteractions: 2,
      plan: {
        maxSteps: 4,
        maxStepLength: 200,
        maxExplanationLength: 500,
      },
      progress: {
        checkpointWindowSize: 4,
        nonAdvancingCheckpointThreshold: 1,
        maxCorrectionRounds: 1,
      },
    },
    runTreeLimits: {
      maxTotalDescendantRuns: 2,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    },
    audit: "optional",
    telemetry: "optional",
    cancellationLimits: {
      operationSettlementTimeoutMs: 1_000,
      processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500,
      finalizationTimeoutMs: 1_000,
    },
    retry: {
      providerRequest: disabledRetryPolicy(),
      structuredOutput: disabledRetryPolicy(),
      action: { maxAttempts: 1 },
    },
    metadata: {},
  });
}

function testAgent(): Agent<TestOutput> {
  return deepFreeze({
    id: "progress-evaluation-agent",
    revision: "1",
    name: "Progress Evaluation Agent",
    instructions: testAgentInstructions("progress-evaluation-agent"),
    output: {
      validate(candidate) {
        return typeof candidate === "object" && candidate !== null &&
            "summary" in candidate && typeof candidate.summary === "string"
          ? { valid: true as const, output: { summary: candidate.summary } }
          : { valid: false as const, message: "Output requires summary." };
      },
    },
    metadata: {},
  });
}

function testAgentInstructions(agentId: string) {
  return createAgentInstructions({
    id: `${agentId}.instructions`,
    release: { id: `${agentId}.release`, revision: "1" },
    model: { providerId: "deterministic-evaluation", modelId: "scripted" },
    resolverRevision: "test-resolver.v1",
    blocks: [{
      id: "behavior",
      source: { owner: "test-support", kind: "instruction_source", id: `${agentId}.behavior`, revision: "1" },
      content: "Exercise deterministic Run Progress behavior.",
    }],
  });
}

function runInput(): RunInput {
  return deepFreeze({
    task: {
      id: "progress-evaluation-task",
      kind: "evaluation.run-progress",
      input: {},
      createdAt: NOW,
      metadata: {},
    },
    items: [{
      id: "progress-evaluation-message",
      kind: "message",
      role: "user",
      content: "Exercise deterministic Run Progress behavior.",
      createdAt: NOW,
      metadata: {},
    }],
    metadata: {},
  });
}

function planCandidate(modelItemId: string, version: number) {
  return {
    kind: "state_transition" as const,
    transition: "plan_update" as const,
    input: {
      explanation: `Volatile declaration ${version}`,
      plan: [{ step: `Inspect state ${version}`, status: "in_progress" as const }],
    },
    modelCallRef: modelCallRef(modelItemId),
  };
}

function advance(
  candidates: Extract<ControllerDecision<TestOutput>, { readonly kind: "advance" }>["candidates"],
  modelItemId: string,
): ControllerDecision<TestOutput> {
  const candidate = candidates[0];
  const call = modelToolCall(
    modelItemId,
    candidate.kind === "state_transition" ? candidate.input : {},
  );
  return deepFreeze({
    kind: "advance",
    candidates,
    modelItems: createControllerModelItems({
      turnId: call.modelCallRef.turnId,
      assistant: {
        role: "assistant",
        content: [{ kind: "model_tool_call", call }],
      },
      finish: { kind: "normal" },
      usage: null,
      responseRef: {
        providerId: "deterministic-evaluation",
        requestId: call.modelCallRef.providerRequestId,
        responseId: `${modelItemId}:response`,
      },
    }),
  });
}

function modelCallRef(id: string): ModelCallRef {
  return Object.freeze({
    id,
    providerRequestId: `${id}:request`,
    controllerRequestId: `${id}:controller`,
    turnId: `${id}:turn`,
    contentBlockOrdinal: 0,
    branchId: "progress-evaluation-run:main",
  });
}

function modelToolCall(
  id: string,
  input: unknown,
): ModelToolCall {
  return Object.freeze({
    modelCallRef: modelCallRef(id),
    providerCallRef: null,
    name: "update_plan",
    input: input as ModelToolCall["input"],
    ordinal: 0,
  }) as ModelToolCall;
}

function emptyVerificationConfig(): RootRunConfig["verification"] {
  const ref = (id: string) => ({ owner: "evaluation", kind: "verification", id, revision: "1" });
  const source = { ...ref("profile-source"), sourceKind: "run_invocation" as const };
  return deepFreeze({
    profile: {
      ref: ref("empty-profile"),
      specification: { id: "empty-specification", revision: "1" },
      source,
      admittedBy: ref("profile-admission"),
      requirements: [],
    },
    completion: {
      policy: ref("completion-policy"),
      outputContract: ref("output-contract"),
      conditions: [],
      maximumDurationMs: 1_000,
    },
  });
}

function permissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "progress-evaluation-managed",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  return deepFreeze({
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "progress-evaluation-environment",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace-1", path: "D:/evaluation" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 2,
      maxRequestsPerActionFingerprint: 1,
      maxConsecutiveDeclines: 1,
      maxConsecutiveReviewFailures: 1,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  });
}

function disabledRetryPolicy() {
  return deepFreeze({
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  });
}

function basis(
  overrides: Partial<RunProgressBasisProjection> = {},
): RunProgressBasisProjection {
  return deepFreeze({
    runId: "evaluation-run",
    taskId: "evaluation-task",
    activeAgent: { id: "agent-a", revision: "1" },
    workspaceFingerprint: digest("workspace"),
    toolSelectionRevision: "tool-selection-1",
    permissionFingerprint: digest("permission"),
    steeringFingerprint: null,
    verificationSnapshotRevision: 0,
    ...overrides,
  });
}

function activateCorrection(state: RunProgressState, round: number): RunProgressState {
  return deepFreeze({
    ...state,
    correctionRounds: round,
    activeCorrectionRound: round,
  });
}

function planFact(planId: string, version: number): RunProgressCommittedFactInput {
  return {
    kind: "plan_update",
    result: { status: "applied", transition: "updated", planId, version },
  };
}

function runActionFact(): RunProgressCommittedFactInput {
  return { kind: "run_action", actionKind: "operation", requestOrigin: "controller_protocol" };
}

function activeAgentFact(previous: string, active: string): RunProgressCommittedFactInput {
  return {
    kind: "active_agent",
    previousAgent: { id: previous, revision: "1" },
    activeAgent: { id: active, revision: "1" },
  };
}

function steeringFact(): RunProgressCommittedFactInput {
  return {
    kind: "steering",
    steering: {
      command: {
        commandId: "steering-1",
        expectedRunRevision: 1,
        instruction: SECRET,
        attribution: { origin: "user", actorId: "evaluation-user" },
        submittedAt: NOW,
        ref: { run: { id: "evaluation-run" }, commandId: "steering-1" },
        acceptedRunRevision: 1,
      },
      status: "applied",
      appliedInRunRevision: 2,
      supersededByCommandId: null,
      reasonCode: null,
    },
  };
}

function pending(
  kind: "interaction" | "descendant_run",
  subjectId: string,
): PendingRunSubjectProjection {
  return deepFreeze({
    kind,
    branchId: "root",
    required: true,
    owner: kind === "interaction" ? "interaction" : "agent-runtime",
    subjectId,
    revision: "1",
  });
}

function descendantSettlementFact(childRunId: string): RunProgressCommittedFactInput {
  return {
    kind: "descendant_settlement",
    status: "succeeded",
    failureOwner: null,
    failureCode: null,
    lowerRefs: [{
      kind: "descendant_settlement",
      owner: "agent-runtime",
      subjectId: childRunId,
      revision: "settled-1",
    }],
    toolResult: {
      toolCall: { toolCallId: "child-call", toolRevision: "1" },
      settlement: {
        owner: "agent-runtime",
        kind: "descendant_run",
        id: childRunId,
        revision: "settled-1",
      },
      startedAt: NOW,
      finishedAt: NOW,
      metadata: {},
      status: "succeeded",
      output: { settled: true },
    } as never,
  };
}

function operationFact(
  operationName: string,
  volatileId: string,
  owner: ReturnType<typeof ownerOutcome> | null,
): RunProgressCommittedFactInput {
  return {
    kind: "operation_result",
    result: {
      ref: {
        invocation: {
          id: `invocation-${volatileId}`,
          operation: { operation: { namespace: "evaluation", name: operationName }, revision: "1" },
        },
        id: `result-${volatileId}`,
      },
      binding: {
        operation: { operation: { namespace: "evaluation", name: operationName }, revision: "1" },
        revision: "binding-1",
      },
      semanticOwner: "workspace",
      status: "succeeded",
      output: { prohibited: SECRET, volatileId },
      failure: null,
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs: [],
      metadata: { volatileId, prohibited: SECRET },
    } as never,
    toolResult: null,
    ownerOutcome: owner,
  };
}

function ownerOutcome(
  semanticRevision: string,
  disposition: "new_information" | "no_change",
) {
  return deepFreeze({
    owner: "workspace",
    subjectId: "workspace-subject",
    revision: semanticRevision,
    disposition,
    fingerprint: digest(semanticRevision),
  });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
