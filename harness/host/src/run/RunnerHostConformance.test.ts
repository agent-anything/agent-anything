import { describe, expect, it } from "vitest";
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
  createFixedLocalToolSelection,
} from "@agent-anything/tools/selection";
import {
  createToolRegistrationSnapshot,
} from "@agent-anything/tools/registration";
import {
  resolvePermissionProfile,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import type {
  Controller,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import { createControllerModelItems } from "@agent-anything/agent-runtime/controller";
import {
  Runner,
  type RunConfig,
  type RunnerOperationComposition,
} from "@agent-anything/agent-runtime/runner";
import type {
  TaskFulfillmentEvaluationInput,
  TaskFulfillmentEvaluatorPort,
} from "@agent-anything/agent-runtime/completion";
import {
  createTestContextProjection,
  createTestVerificationExecutionFactory,
} from "@agent-anything/test-support";
import { CurrentVerificationCompletionGate } from "@agent-anything/verification/completion";
import { createHostRunManager } from "./HostRunManager.js";

interface TestOutput {
  readonly summary: string;
}

describe("Runner and generic Host conformance", () => {
  it("preserves exact successful RunResult through the Host wrapper", async () => {
    const manager = createManager(new CompletionController());
    const active = manager.start(startInput());

    const outcome = await active.wait();

    expect(outcome).toMatchObject({
      runId: "run-host-conformance",
      terminal: { status: "completed", code: null },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Done" },
        startingAgent: { id: "agent-1", revision: "1" },
        finalActiveAgent: { id: "agent-1", revision: "1" },
      },
    });
    expect(outcome.terminal).toBe(active.getProjection().terminal);
    expect(active.getResult()).toBe(outcome);
  });

  it("preserves accepted cancellation through Runner and terminal Host projection", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller: Controller<TestOutput> = {
      resourceMetering: TEST_RESOURCE_METERING,
      async next(input) {
        entered.resolve();
        await release.promise;
        return completionDecision(input, "Discarded after cancellation");
      },
    };
    const active = createManager(controller).start(startInput());
    await entered.promise;

    const receipt = active.cancel({ origin: "user", reasonCode: "user_requested" });
    release.resolve();
    const outcome = await active.wait();

    expect(receipt).toMatchObject({
      status: "accepted",
      cancellation: { origin: "user", reasonCode: "user_requested" },
    });
    expect(outcome).toMatchObject({
      runResult: {
        status: "cancelled",
        code: "runtime_cancelled",
        cancellation: { origin: "user", reasonCode: "user_requested" },
      },
      terminal: { status: "cancelled", code: "runtime_cancelled" },
    });
    expect(outcome.terminal).toBe(active.getProjection().terminal);
  });
});

class CompletionController implements Controller<TestOutput> {
  readonly resourceMetering = TEST_RESOURCE_METERING;

  async next(input: ControllerInput<TestOutput>): Promise<ControllerDecision<TestOutput>> {
    return completionDecision(input, "Done");
  }
}

const TEST_RESOURCE_METERING = Object.freeze({
  modelInputTokens: "not_applicable" as const,
  modelOutputTokens: "not_applicable" as const,
  costUnits: "not_applicable" as const,
});

function createManager(controller: Controller<TestOutput>) {
  const runner = new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    operations: emptyOperations(),
    completion: {
      taskFulfillment: fulfilledEvaluator(),
      maximumDurationMs: 5_000,
    },
    verification: createTestVerificationComposition(),
    interactions: createInteractionProtocolRegistrySnapshot("interaction-registry-1", []),
    createRunId: () => "run-host-conformance",
    now: () => NOW,
  });
  return createHostRunManager({ runner, now: () => NOW });
}

function fulfilledEvaluator(): TaskFulfillmentEvaluatorPort {
  const ref = Object.freeze({ owner: "test-product", id: "host-task-fulfillment", revision: "1" });
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
          rationale: "Host conformance uses an explicitly fulfilled test Task.",
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
    id: "operation-catalog-1",
    revision: "1",
    entries: [],
  });
  return Object.freeze({
    catalog,
    bindings: createOperationBindingResolverSnapshot("operation-bindings-1", []),
    validateToolInput: () => true,
    internalHandlers: Object.freeze([]),
    availability: Object.freeze([]),
  });
}

function startInput() {
  const operations = emptyOperations();
  const registrations = createToolRegistrationSnapshot(operations.catalog, []);
  return {
    sessionId: "session-1",
    agent: createAgent(),
    runInput: createRunInput(),
    runConfig: createRunConfig(
      createFixedLocalToolSelection(registrations, operations.catalog, []),
    ),
  };
}

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent-1",
    revision: "1",
    name: "Host Conformance Agent",
    instructions: testAgentInstructions("agent-1"),
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" && candidate !== null &&
          "summary" in candidate && typeof candidate.summary === "string"
        ) return { valid: true, output: { summary: candidate.summary } };
        return { valid: false, message: "Output requires summary." };
      },
    },
    metadata: {},
  };
}

function testAgentInstructions(agentId: string) {
  return createAgentInstructions({
    id: `${agentId}.instructions`,
    release: { id: `${agentId}.release`, revision: "1" },
    model: { providerId: "test-provider", modelId: "test-model" },
    resolverRevision: "test-resolver.v1",
    blocks: [{
      id: "behavior",
      source: { owner: "test", kind: "instruction_source", id: `${agentId}.behavior`, revision: "1" },
      content: "Complete the task.",
    }],
  });
}

function createRunInput(): RunInput {
  return {
    task: {
      id: "task-1",
      kind: "test.host-conformance",
      input: {},
      createdAt: NOW,
      metadata: {},
    },
    items: [{
      id: "message-1",
      kind: "message",
      role: "user",
      content: "Complete the task.",
      createdAt: NOW,
      metadata: {},
    }],
    metadata: {},
  };
}

function createRunConfig(tools: RunConfig["tools"]): import("@agent-anything/agent-runtime/runner").RootRunConfig {
  return {
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Test workspace",
        rootRef: "workspace://root",
        trustState: "trusted",
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
    identity: {
      id: "user-1",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    permissions: permissionConfig(),
    tools,
    actionExecution: null,
    verification: createTestVerificationConfig(),
    limits: {
      maxIterations: 4,
      maxActions: 4,
      maxConsecutiveActionFailures: 2,
      maxDurationMs: 5_000,
      maxPendingInteractions: 2,
      plan: {
        maxSteps: 4,
        maxStepLength: 100,
        maxExplanationLength: 200,
      },
      stopReview: {
        maxRequiredFeedbackRounds: 2,
        maxAdvisoryFeedbackRounds: 1,
      },
    },
    runTreeLimits: {
      maxTotalDescendantRuns: 1,
      maxActiveDescendantRuns: 1,
      maxDescendantDepth: 1,
    },
    runTreeResources: {
      controllerTurns: { maximum: 32, minimumChildGrant: 1, enforcement: "hard" },
      actions: { maximum: 32, minimumChildGrant: 1, enforcement: "hard" },
      modelInputTokens: { threshold: 100_000, enforcement: "observational" },
      modelOutputTokens: { threshold: 100_000, enforcement: "observational" },
      costUnits: { threshold: 100_000, enforcement: "observational" },
      contextBytes: { maximum: 1_000_000, minimumChildGrant: 1, enforcement: "hard" },
      resultBytes: { maximum: 1_000_000, minimumChildGrant: 1, enforcement: "hard" },
    },
    runTreeApprovals: {
      maxTotalRequests: 4,
      maxRequestsPerOperationFingerprint: 2,
      maxConsecutiveDeclines: 2,
      maxConsecutiveReviewerFailures: 2,
      maxActiveReviews: 2,
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
  };
}

function createTestVerificationComposition() {
  return Object.freeze({
    executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
    completionGate: new CurrentVerificationCompletionGate(() => NOW),
    preparation: null,
    settledOperationResults: null,
    checkResults: null,
  });
}

function createTestVerificationConfig(): RunConfig["verification"] {
  const owner = (id: string) => Object.freeze({
    owner: "host-conformance",
    kind: "verification",
    id,
    revision: "1",
  });
  return Object.freeze({
    profile: Object.freeze({
      ref: owner("empty-profile"),
      specification: Object.freeze({ id: "empty-specification", revision: "1" }),
      source: Object.freeze({ ...owner("profile-source"), sourceKind: "run_invocation" as const }),
      admittedBy: owner("profile-admission"),
      requirements: Object.freeze([]),
    }),
    completion: Object.freeze({
      policy: owner("current-verification-gate"),
      outputContract: owner("test-output-contract"),
      conditions: Object.freeze([]),
      maximumDurationMs: 1_000,
    }),
  });
}

function permissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "host-conformance",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace-1", path: "D:/workspace" }],
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
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function disabledRetryPolicy() {
  return {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2,
      jitterRatio: 0.1,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
}

function completionDecision(
  input: ControllerInput<TestOutput>,
  summary: string,
): ControllerDecision<TestOutput> {
  const turnId = `${input.runId}:scripted-model-turn:${input.iteration}`;
  return {
    kind: "propose_completion",
    output: { summary },
    modelItems: createControllerModelItems({
      turnId,
      assistant: { role: "assistant", content: [{ kind: "text", text: summary }] },
      finish: { kind: "normal" },
      usage: null,
      responseRef: {
        providerId: "host-conformance-scripted-provider",
        requestId: `${turnId}:request`,
        responseId: `${turnId}:response`,
      },
    }, { source: "host-conformance-scripted-controller" }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const NOW = "2026-08-13T00:00:00.000Z";
