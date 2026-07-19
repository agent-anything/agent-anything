import { describe, expect, it } from "vitest";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/providers";
import { resolvePermissionProfile } from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import type { Agent } from "@agent-anything/agent-core/agent";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import {
  createSystemRetryExecutor,
  ProviderBackedController,
  Runner,
  type RunConfig,
} from "@agent-anything/agent-runtime";
import {
  createHostRuntime,
  type HostRunProjection,
  type HostRunResult,
  type HostRunStartInput,
  type HostRuntime,
} from "./index.js";
import type { RetryClock } from "@agent-anything/agent-core/retry";
import type { ActionCandidate } from "@agent-anything/agent-core/action";
import {
  createRunCancellationController,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/agent-core/run";

interface ConformanceOutput {
  readonly summary: string;
}

type ControllerStep = (
  input: ControllerInput,
  context: ControllerCallContext,
) => ControllerDecision | Promise<ControllerDecision>;

describe("Runner and generic Host conformance", () => {
  it("preserves direct completion through the generic Host adapter", async () => {
    const controller = new FakeController([
      (input) => finalDecision(input, "Direct completion"),
    ]);
    const harness = createHostHarness(controller);

    const result = await harness.run(createHostInput());

    expect(result).toMatchObject({
      terminal: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Direct completion" },
      },
    });
    expect(result.terminal).toBe(harness.projections.at(-1)?.terminal);
    expect(harness.projections[0]?.status).toBe("running");
    expect(harness.projections.at(-1)?.status).toBe("completed");
  });

  it("preserves Runner-owned Provider retry history through the generic Host", async () => {
    const controller = new FakeController([
      async (input, context) => {
        const operationId = `${input.runId}:controller:1:provider-request:1`;
        const budgetId = `${operationId}:budget:1`;
        const attemptId = `${operationId}:attempt:1`;
        await context.retry.events.emit({
          type: "retry_attempt_started",
          runId: input.runId,
          operationId,
          owner: "provider_request",
          occurredAt: "2026-07-14T00:00:00.000Z",
          attemptId,
          budgetId,
          attemptNumber: 1,
          budgetAttemptNumber: 1,
          maxBudgetAttempts: 1,
        });
        await context.retry.events.emit({
          type: "retry_attempt_finished",
          runId: input.runId,
          operationId,
          owner: "provider_request",
          occurredAt: "2026-07-14T00:00:00.000Z",
          attemptId,
          budgetId,
          attemptNumber: 1,
          budgetAttemptNumber: 1,
          durationMs: 0,
          outcome: "succeeded",
          next: "return_to_owner",
        });
        return finalDecision(input, "Completed with retry history");
      },
    ]);

    const harness = createHostHarness(controller);
    const result = await harness.run(createHostInput());

    expect(result.terminal).toBe(harness.projections.at(-1)?.terminal);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "model_output",
      "final_output",
    ]);
    expect(result.runResult.items[0]).toMatchObject({
      retry: {
        operationId: "run-conformance:controller:1:provider-request:1",
        attemptId: "run-conformance:controller:1:provider-request:1:attempt:1",
      },
    });
  });

  it("carries real Provider Retry through Controller, Runner, and the safe Host projection", async () => {
    const provider = new RetryOnceProvider();
    const clock = fixedRetryClock();
    const controller = new ProviderBackedController<ConformanceOutput>({
      provider,
      buildRequest: () => ({
        messages: [{ role: "user", content: "Complete the conformance task.", metadata: {} }],
        capability: "agent-control",
        metadata: {},
      }),
      parseResponse: (_response, input) => finalDecision(
        input,
        "Recovered through the generic Host",
      ),
      structuredOutputContractId: "conformance-output-v1",
      maxProviderOutputLength: 10_000,
      retryExecutor: createSystemRetryExecutor(clock),
      retryClock: clock,
    });
    const harness = createHostHarness(controller);
    const input = createHostInput({
      retry: {
        providerRequest: {
          maxRetries: 1,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: ["transport"],
          serverDelay: { mode: "ignore" },
        },
        structuredOutput: disabledRetryConfiguration().structuredOutput,
        approvalsReviewer: disabledRetryConfiguration().approvalsReviewer,
      },
    });

    const result = await harness.run(input);

    expect(result).toMatchObject({
      terminal: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Recovered through the generic Host" },
      },
    });
    expect(provider.requests).toHaveLength(2);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "retry_attempt_started",
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_attempt_finished",
      "model_output",
      "final_output",
    ]);

    const retryEvents = (
      harness.projections.at(-1)?.retry?.recentEvents ?? []
    ).filter((event) => event.owner === "provider_request");
    expect(retryEvents.map((event) => event.event)).toEqual([
      "retry.attempt.started",
      "retry.attempt.finished",
      "retry.scheduled",
      "retry.attempt.started",
      "retry.attempt.finished",
    ]);
    expect(JSON.stringify(retryEvents)).not.toContain("secret transport details");
    expect(retryEvents.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it("carries one Plan through creation, completion, reactivation, and terminal abandonment", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Start with inspection.",
          plan: [{ step: "Inspect resource", status: "in_progress" }],
        },
      }]),
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Inspection is complete.",
          plan: [{ step: "Inspect resource", status: "completed" }],
        },
      }]),
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "New work was discovered.",
          plan: [
            { step: "Inspect resource", status: "completed" },
            { step: "Verify discovery", status: "in_progress" },
          ],
        },
      }]),
      (input) => finalDecision(input, "Plan lifecycle complete"),
    ]);

    const harness = createHostHarness(controller);
    const result = await harness.run(createHostInput());

    expect(result.runResult.status).toBe("succeeded");
    expect(controller.calls.map((call) => call.context.plan?.status ?? null)).toEqual([
      null,
      "active",
      "completed",
      "active",
    ]);
    expect(controller.calls.map((call) => call.context.plan?.version ?? null)).toEqual([
      null,
      1,
      2,
      3,
    ]);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "plan_created",
      "observation",
      "model_output",
      "action",
      "plan_updated",
      "plan_completed",
      "observation",
      "model_output",
      "action",
      "plan_updated",
      "observation",
      "model_output",
      "plan_abandoned",
      "final_output",
    ]);
  });

  it("returns an invalid Plan update as a recoverable Observation", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          plan: [
            { step: "First concurrent step", status: "in_progress" },
            { step: "Second concurrent step", status: "in_progress" },
          ],
        },
      }]),
      (input) => {
        expect(input.context.plan).toBeNull();
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "plan_update",
          result: {
            status: "rejected",
            code: "plan_invalid",
          },
        });
        return finalDecision(input, "Recovered after invalid Plan");
      },
    ]);

    const harness = createHostHarness(controller);
    const result = await harness.run(createHostInput());

    expect(result).toMatchObject({
      terminal: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Recovered after invalid Plan" },
      },
    });
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "observation",
      "model_output",
      "final_output",
    ]);
  });

  it("projects Controller stop as blocked while preserving the exact RunResult", async () => {
    const controller = new FakeController([
      (input) => ({
        kind: "stop",
        reason: "No safe path remains.",
        modelItems: [modelItem(input, { action: "stop" })],
      }),
    ]);

    const harness = createHostHarness(controller);
    const result = await harness.run(createHostInput());

    expect(result).toMatchObject({
      terminal: { status: "blocked" },
      runResult: {
        status: "blocked",
        code: "runtime_no_safe_path",
      },
    });
    expect(result.terminal).toBe(harness.projections.at(-1)?.terminal);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "stop",
      "run_blocked",
    ]);
  });

});

class FakeController implements Controller {
  readonly calls: ControllerInput[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

  async next(
    input: ControllerInput,
    context: ControllerCallContext,
  ): Promise<ControllerDecision> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (!step) {
      throw new Error("FakeController has no remaining decision.");
    }
    return step(input, context);
  }
}

class InMemoryHostHarness {
  readonly projections: HostRunProjection[] = [];

  constructor(private readonly runtime: HostRuntime) {}

  async run(
    input: HostRunStartInput<ConformanceOutput>,
  ): Promise<HostRunResult<ConformanceOutput>> {
    const active = this.runtime.start(input);
    this.projections.push(active.getProjection());
    const unsubscribe = active.subscribe((projection) => {
      this.projections.push(projection);
    });
    const outcome = await active.result;
    unsubscribe();
    if (outcome.kind !== "run_result") {
      throw new Error(`Conformance Host failed to start: ${outcome.code}.`);
    }
    return outcome;
  }

}

function createHostHarness(
  controller: Controller,
): InMemoryHostHarness {
  const runner = new Runner({
    controller,
    now: () => "2026-07-14T00:00:00.000Z",
  });
  return new InMemoryHostHarness(createHostRuntime({
    runner,
    now: () => "2026-07-14T00:00:00.000Z",
  }));
}

function createHostInput(input: {
  limits?: Partial<Omit<RunConfig["limits"], "plan">>;
  retry?: RunConfig["retry"];
} = {}): HostRunStartInput<ConformanceOutput> {
  const cancellation = createRunCancellationController({
    runId: "run-conformance",
    now: () => "2026-07-14T00:00:00.000Z",
  });
  return {
    sessionId: "session-conformance",
    agent: createAgent(),
    runInput: {
      runId: "run-conformance",
      task: {
        id: "task-conformance",
        kind: "conformance.task",
        input: { prompt: "Exercise generic Runner behavior." },
        createdAt: "2026-07-14T00:00:00.000Z",
        metadata: {},
      },
      conversationItems: [],
      metadata: {},
    },
    runConfig: {
      workspace: {
        id: "workspace-conformance",
        name: "Conformance workspace",
        rootRef: "workspace://conformance",
        trustState: "trusted",
        source: "conformance",
        policyRefs: [],
        metadata: {},
      },
      identity: {
        id: "identity-conformance",
        kind: "anonymous",
        displayName: "Conformance identity",
        metadata: {},
      },
      actionContext: null,
      permissions: createTestPermissionConfig(),
      limits: {
        maxIterations: 5,
        maxActions: 5,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: 5_000,
        ...input.limits,
        plan: {
          maxSteps: 5,
          maxStepLength: 100,
          maxExplanationLength: 200,
        },
      },
      audit: "optional",
      telemetry: "optional",
      cancellation,
      cancellationLimits: {
        operationSettlementTimeoutMs: 1_000,
        processGracePeriodMs: 100,
        processForceKillTimeoutMs: 500,
        finalizationTimeoutMs: 1_000,
      },
      retry: input.retry ?? disabledRetryConfiguration(),
      metadata: {},
    },
  };
}

function fixedRetryClock(): RetryClock {
  const value = "2026-07-14T00:00:00.000Z";
  return {
    now: () => new Date(value),
  };
}

function disabledRetryConfiguration(): RunConfig["retry"] {
  const policy = {
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
  };
  return {
    providerRequest: policy,
    structuredOutput: policy,
    approvalsReviewer: policy,
  };
}

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "conformance-managed",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "conformance-local",
        platform: "win32",
        workspaceRoots: [
          { rootId: "workspace-conformance", path: "C:/workspace" },
        ],
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
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function createAgent(): Agent<ConformanceOutput> {
  return {
    id: "agent-conformance",
    name: "Conformance Agent",
    instructions: "Complete the conformance task.",
    tools: [],
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "summary" in candidate &&
          typeof candidate.summary === "string"
        ) {
          return { valid: true, output: { summary: candidate.summary } };
        }
        return { valid: false, message: "Conformance output requires summary." };
      },
    },
    metadata: {},
  };
}

function finalDecision(
  input: ControllerInput,
  summary: string,
): ControllerDecision {
  return {
    kind: "final_output",
    output: { summary },
    modelItems: [modelItem(input, { action: "complete", summary })],
  };
}

function actionsDecision(
  input: ControllerInput,
  candidates: readonly Omit<ActionCandidate, "modelItemId">[],
): ControllerDecision {
  const model = modelItem(input, { action: "actions" });
  const actions = candidates.map((candidate) => ({
    ...candidate,
    modelItemId: model.id,
  })) as [ActionCandidate, ...ActionCandidate[]];
  return {
    kind: "actions",
    actions,
    modelItems: [model],
  };
}

function modelItem(input: ControllerInput, content: unknown) {
  return {
    id: `${input.runId}:model:${input.iteration}`,
    kind: "assistant_action",
    content,
    metadata: {},
  };
}

class RetryOnceProvider implements Provider {
  readonly descriptor = {
    id: "retry-once-conformance-provider",
    name: "Retry Once Conformance Provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  async send(request: ProviderRequest): Promise<ProviderCallResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        kind: "failed",
        failure: {
          category: "transport",
          code: "provider_unavailable",
          message: "secret transport details",
          metadata: { rawError: "secret transport details" },
        },
      };
    }
    return {
      kind: "succeeded",
      response: {
        output: { summary: "Recovered through the generic Host" },
        usage: null,
        metadata: {},
      },
    };
  }
}
