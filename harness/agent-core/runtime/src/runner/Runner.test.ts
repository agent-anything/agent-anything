import { describe, expect, it, vi } from "vitest";
import {
  createAgentInstructions,
  type Agent,
  type AgentRevisionRef,
} from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  createInteractionProtocolRegistrySnapshot,
} from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequest,
  type InteractionProtocolRef,
} from "@agent-anything/interaction/protocol";
import {
  createOperationBindingResolverSnapshot,
  snapshotResolvedOperationBinding,
  type OperationBindingKind,
} from "@agent-anything/operation-catalog/binding";
import {
  createOperationCatalogSnapshot,
  type OperationRequestOrigin,
} from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingResolutionInput,
  ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import {
  createOperationResult,
  type OperationResult,
} from "@agent-anything/operation-catalog/result";
import {
  snapshotCompositeDefinition,
} from "@agent-anything/operation-composition/definition";
import {
  createFixedLocalToolSelection,
} from "@agent-anything/tools/selection";
import type { ToolBindingRef } from "@agent-anything/tools/identity";
import {
  createToolRegistrationSnapshot,
  type ToolRegistrationInput,
} from "@agent-anything/tools/registration";
import {
  resolvePermissionProfile,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { RunTrace } from "@agent-anything/observability/tracing";
import { createCanonicalWorkspaceIdentity } from "@agent-anything/canonical-action/subject";
import {
  createActionRegistrationSnapshot,
  type ActionAdapterDescriptor,
  type ActionExecutorDescriptor,
} from "@agent-anything/canonical-action/registration";
import {
  createPreparedAction,
  type OperationActionAdapter,
} from "@agent-anything/action-execution/registration";
import type { PhysicalAttemptOutcome } from "@agent-anything/action-execution/execution";
import { createSandboxExecutionGateway } from "@agent-anything/action-execution/sandbox";
import type { ActionExecutionNotification } from "@agent-anything/action-execution/enforcement";
import { createAllowAllActionPolicyPort } from "@agent-anything/governance/policy";
import {
  createTestContextProjection,
  createTestVerificationExecutionFactory,
} from "@agent-anything/test-support";
import {
  CurrentVerificationCompletionGate,
  type CompletionGateInput,
  type CompletionGatePort,
} from "@agent-anything/verification/completion";
import {
  createVerificationFailure,
  type VerificationOwnerRef,
} from "@agent-anything/verification/definition";
import {
  DefaultVerificationExecutionFactory,
  type CheckDefinition,
  type CheckResult,
  type VerificationCheckInterpretation,
  type VerificationExecutionPort,
} from "@agent-anything/verification/execution";
import type { VerificationSubjectSnapshot } from "@agent-anything/verification/subject";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "../controller/index.js";
import { createControllerModelItems } from "../controller/index.js";
import type {
  ModelCallRef,
  ModelJsonValue,
  ModelToolCall,
} from "@agent-anything/model-interaction";
import type { RootRunConfig, RunConfig } from "./RunConfig.js";
import type {
  InternalOperationHandler,
  RunnerDelegationComposition,
  RunnerDependencies,
  RunnerOperationComposition,
} from "./RunnerDependencies.js";
import {
  createDelegationContextPlan,
  createDelegationLimits,
  createDelegationResultExpectation,
} from "../delegation/index.js";
import { Runner } from "./Runner.js";
import { createStaticOperationToolAvailabilityParticipant } from "./RunToolExposureCoordinator.js";
import type {
  TaskFulfillmentEvaluationInput,
  TaskFulfillmentEvaluatorPort,
} from "../completion/index.js";

interface TestOutput {
  readonly summary: string;
}

type ControllerStep =
  | ControllerDecision<TestOutput>
  | ((
      input: ControllerInput<TestOutput>,
      context: ControllerCallContext,
    ) => ControllerDecision<TestOutput> | Promise<ControllerDecision<TestOutput>>);

class ScriptedController implements Controller<TestOutput> {
  readonly resourceMetering: Controller<TestOutput>["resourceMetering"];
  readonly calls: ControllerInput<TestOutput>[] = [];

  constructor(
    private readonly steps: ControllerStep[],
    resourceMetering: Controller<TestOutput>["resourceMetering"] = {
      modelInputTokens: "not_applicable",
      modelOutputTokens: "not_applicable",
      costUnits: "not_applicable",
    },
  ) {
    this.resourceMetering = Object.freeze({ ...resourceMetering });
  }

  async next(
    input: ControllerInput<TestOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TestOutput>> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("ScriptedController has no remaining decision.");
    return typeof step === "function" ? step(input, context) : step;
  }
}

describe("Runner semantic integration", () => {
  it("completes one Run through the single Controller loop", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([complete("Done")]);
    const events: RuntimeEvent[] = [];

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_001", revision: "1" },
      status: "succeeded",
      finalOutput: { summary: "Done" },
    });
    expect(result.items.map(({ payload }) => payload.kind)).toEqual([
      "verification_feedback",
      "controller_turn",
      "task_fulfillment_assessment",
      "verification_feedback",
      "stop_review",
      "terminal_transition",
    ]);
    expect(result.items.map(({ ref }) => ref.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0]?.instructionBinding).toMatchObject({
      run: { id: "run_001" },
      agent: { id: "agent_001", revision: "1" },
      effectiveFromRunRevision: 0,
      supersedes: null,
    });
    expect(result.startingInstructionBinding).toEqual(
      controller.calls[0]?.instructionBinding.ref,
    );
    expect(result.finalInstructionBinding).toEqual(result.startingInstructionBinding);
    const turn = result.items.find(({ payload }) => payload.kind === "controller_turn");
    expect(turn?.payload).toMatchObject({
      kind: "controller_turn",
      toolExposure: {
        controllerRequestId: "run_001:controller_turn:1",
        manifestId: "run_001:context-projection:1:manifest",
        exposedToolCount: 0,
        omittedToolCount: 0,
      },
    });
    expect(events.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "context.projection.completed",
      "controller.started",
      "run.item.appended",
      "controller.tool_exposure.resolved",
      "controller.finished",
    ]));
    expect(events.findIndex(({ name }) => name === "controller.tool_exposure.resolved"))
      .toBeGreaterThan(events.findIndex(({ name }) => name === "run.item.appended"));
  });

  it("flushes the exact private Transcript before Run completion is observed", async () => {
    const operations = createOperationFixture([]);
    const records: Array<{ readonly sequence: number; readonly item: { readonly ref: { readonly sequence: number } } }> = [];

    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      {
        runTranscriptPort: {
          async append(record) {
            await Promise.resolve();
            records.push(record);
            return { status: "stored" };
          },
        },
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(records.map(({ sequence }) => sequence)).toEqual(
      result.items.map(({ ref }) => ref.sequence),
    );
    expect(records.map(({ item }) => item.ref.sequence)).toEqual(
      result.items.map(({ ref }) => ref.sequence),
    );
    expect(records.at(-1)?.item).toEqual(result.items.at(-1));
  });

  it("continues from a non-fulfilled completion and succeeds only after reassessment", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      complete("Explained what should be done", "model_complete_1"),
      complete("Performed the requested work", "model_complete_2"),
    ]);
    const ref = Object.freeze({ owner: "test-product", id: "task-fulfillment", revision: "1" });
    let assessmentCount = 0;
    const evaluator: TaskFulfillmentEvaluatorPort = Object.freeze({
      ref,
      async evaluate(input: TaskFulfillmentEvaluationInput) {
        assessmentCount += 1;
        return createTaskAssessmentResult(
          input,
          ref,
          assessmentCount === 1 ? "incomplete" : "fulfilled",
        );
      },
    });

    const result = await createRunner(controller, operations, {
      completion: { taskFulfillment: evaluator, maximumDurationMs: 5_000 },
    }).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Performed the requested work" },
    });
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "task_fulfillment_assessment"
    ).map(({ payload }) => payload.kind === "task_fulfillment_assessment"
      ? payload.assessment.status
      : null)).toEqual(["incomplete", "fulfilled"]);
    expect(result.items.some(({ payload }) =>
      payload.kind === "verification_feedback" &&
      payload.verification.gate !== null
    )).toBe(true);
  });

  it("fails closed when Task Fulfillment evaluation fails", async () => {
    const operations = createOperationFixture([]);
    const evaluator: TaskFulfillmentEvaluatorPort = Object.freeze({
      ref: Object.freeze({ owner: "test-product", id: "task-fulfillment", revision: "1" }),
      async evaluate() {
        return Object.freeze({
          kind: "failed" as const,
          failure: Object.freeze({
            code: "task_fulfillment_provider_failed",
            message: "The evaluator could not assess the original Task.",
            retryable: true,
            metadata: Object.freeze({}),
          }),
        });
      },
    });

    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      { completion: { taskFulfillment: evaluator, maximumDurationMs: 5_000 } },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "task_fulfillment_failed",
      failure: {
        kind: "task_fulfillment",
        failure: { code: "task_fulfillment_provider_failed" },
      },
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "stop_review",
        review: expect.objectContaining({ decision: "failed" }),
      }),
    }));
  });

  it("rejects evaluator cancellation that is not backed by accepted Run cancellation", async () => {
    const operations = createOperationFixture([]);
    const evaluator: TaskFulfillmentEvaluatorPort = Object.freeze({
      ref: Object.freeze({ owner: "test-product", id: "task-fulfillment", revision: "1" }),
      async evaluate(input) {
        return Object.freeze({
          kind: "cancelled" as const,
          cancellation: Object.freeze({ runId: input.run.id, requestId: "unattributed" }),
        });
      },
    });

    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      { completion: { taskFulfillment: evaluator, maximumDurationMs: 5_000 } },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "task_fulfillment_failed",
      failure: {
        kind: "task_fulfillment",
        failure: { code: "task_fulfillment_cancellation_unattributed" },
      },
    });
  });

  it("finalizes required Run-owned resources before terminal settlement", async () => {
    const operations = createOperationFixture([]);
    const finalized: string[] = [];
    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      {
        resourceFinalizers: [Object.freeze({
          async finalize(context) {
            finalized.push(context.runId);
            return null;
          },
        })],
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(finalized).toEqual([result.runId]);
  });

  it("fails terminal settlement when required Run resource cleanup is unconfirmed", async () => {
    const operations = createOperationFixture([]);
    const result = await createRunner(
      new ScriptedController([complete("Must not remain successful")]),
      operations,
      {
        resourceFinalizers: [Object.freeze({
          async finalize() {
            throw new Error("Process cleanup was not confirmed.");
          },
        })],
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "failed",
      code: "required_finalization_failed",
      finalOutput: null,
      failure: {
        kind: "runtime",
        failure: { code: "runtime_resource_finalization_failed" },
      },
    });
  });

  it("blocks completion when one mandatory Requirement remains unassessed", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const result = await createRunner(
      new ScriptedController([complete("Not yet eligible")]),
      operations,
      { runtimeEventPublisher: { publish: (event) => events.push(event) } },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { verification: createMandatoryVerificationConfig("block") }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "blocked",
      code: "verification_blocked",
    });
    expect(result.items.some((item) => item.payload.kind === "verification_feedback")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      name: "verification.gate.evaluated",
      payload: expect.objectContaining({ status: "blocked_unassessed", disposition: "block" }),
    }));
  });

  it("satisfies a mandatory Requirement through a pure automatic Check without fabricating action state", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const verification = createVerificationScenario({ kind: "pure_automatic" });
    const result = await createRunner(
      new ScriptedController([complete("Validated")]),
      operations,
      {
        verification,
        runtimeEventPublisher: { publish: (event) => events.push(event) },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { verification: createMandatoryVerificationConfig("block") }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(0);
    expect(observations(result)).toHaveLength(0);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "terminal_transition" && payload.status === "succeeded"))
      .toHaveLength(1);
    expect(events.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "verification.check.started",
      "verification.check.finished",
      "verification.assessment.committed",
      "verification.gate.evaluated",
    ]));
  });

  it("routes a trusted automatic effectful Check through one ordinary Operation RunAction", async () => {
    const operation = operationRef("verification-check");
    const actionExecution = createVerificationActionExecutionFixture(operation);
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {
        requestOrigins: ["automatic_stage"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], { actionExecution: actionExecution.dependencies });
    const result = await createRunner(
      new ScriptedController([complete("Validated")]),
      operations,
      { verification: createVerificationScenario({ kind: "effectful_automatic", operation }) },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createVerificationActionExecutionConfig(),
        verification: createMandatoryVerificationConfig("block"),
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(actionExecution.execute, JSON.stringify(result, null, 2)).toHaveBeenCalledTimes(1);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toEqual([expect.objectContaining({
        payload: expect.objectContaining({
          action: expect.objectContaining({
            provenance: expect.objectContaining({ kind: "automatic" }),
          }),
        }),
      })]);
    expect(observations(result).filter(({ payload }) => payload.kind === "operation"))
      .toHaveLength(1);
  });

  it("interprets one settled Controller Operation as a Check without replaying its effect", async () => {
    const operation = operationRef("controller-verification-check");
    const actionExecution = createVerificationActionExecutionFixture(operation);
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {
        requestOrigins: ["controller_protocol"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], { actionExecution: actionExecution.dependencies });
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      advance([operationCandidate(operation, { target: "workspace" })], "model_operation"),
      complete("The admitted check supports completion.", "model_complete"),
    ]);
    const result = await createRunner(controller, operations, {
      verification: createVerificationScenario({ kind: "controller", operation }),
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createVerificationActionExecutionConfig(),
        verification: createMandatoryVerificationConfig("block"),
      }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "succeeded",
      code: null,
    });
    expect(actionExecution.execute).toHaveBeenCalledTimes(1);
    const actions = result.items.filter(({ payload }) => payload.kind === "run_action");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.payload).toMatchObject({
      kind: "run_action",
      action: { provenance: { kind: "controller" } },
    });
    expect(observations(result).filter(({ payload }) => payload.kind === "operation"))
      .toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      name: "verification.check.started",
      payload: expect.objectContaining({ origin: "controller" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      name: "verification.gate.evaluated",
      payload: expect.objectContaining({ status: "completion_eligible" }),
    }));
  });

  it("rejects a previously satisfied Requirement after its subject becomes stale", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const result = await createRunner(
      new ScriptedController([complete("Stale completion")]),
      operations,
      {
        verification: createVerificationScenario({ kind: "pure_automatic", stale: true }),
        runtimeEventPublisher: { publish: (event) => events.push(event) },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { verification: createMandatoryVerificationConfig("block") }),
    );

    expect(result).toMatchObject({ status: "blocked", code: "verification_blocked" });
    expect(events).toContainEqual(expect.objectContaining({
      name: "verification.gate.evaluated",
      payload: expect.objectContaining({ status: "blocked_stale", disposition: "block" }),
    }));
  });

  it("waits for exact active mandatory Verification work without another Controller request", async () => {
    const operations = createOperationFixture([]);
    const settlement = deferred<VerificationCheckInterpretation>();
    const processed = deferred<void>();
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      complete("Premature completion", "model_complete_1"),
      async () => {
        await processed.promise;
        return complete("Completion after current Verification", "model_complete_2");
      },
    ]);
    const handle = createRunner(controller, operations, {
      verification: createVerificationScenario({
        kind: "pure_pending",
        settlement: settlement.promise,
        onProcessed(error) {
          if (error === null) processed.resolve();
          else processed.reject(error);
        },
      }),
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { verification: createMandatoryVerificationConfig("wait") }),
    );

    await waitUntil(() => events.some((event) =>
      event.name === "verification.gate.evaluated" &&
      event.payload.disposition === "wait"
    ));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handle.getSnapshot().status).toBe("waiting");
    expect(handle.getSnapshot().stopReview.latestReview).not.toBeNull();
    expect(controller.calls).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      name: "run.stop.reviewed",
      payload: expect.objectContaining({ decision: "wait" }),
    }));
    settlement.resolve(completedVerificationInterpretation());
    const result = await handle.wait();

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Completion after current Verification" },
    });
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "pending_transition" &&
      payload.pending.kind === "verification_check"
    ).map(({ payload }) => payload.kind === "pending_transition" ? payload.transition : null))
      .toEqual(["opened", "resolved"]);
  });

  it("lets cancellation terminate exact mandatory Verification waiting", async () => {
    const operations = createOperationFixture([]);
    const neverSettles = deferred<VerificationCheckInterpretation>();
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([complete("Premature completion")]);
    const handle = createRunner(controller, operations, {
      verification: createVerificationScenario({
        kind: "pure_pending",
        settlement: neverSettles.promise,
        onProcessed() {},
      }),
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { verification: createMandatoryVerificationConfig("wait") }),
    );
    await waitUntil(() => events.some((event) =>
      event.name === "verification.gate.evaluated" && event.payload.disposition === "wait"
    ));

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "pending_transition" &&
      payload.pending.kind === "verification_check" &&
      payload.transition === "cancelled"
    )).toHaveLength(1);
  });

  it("bounds required Stop Review feedback without bypassing the Completion Gate", async () => {
    const operations = createOperationFixture([]);
    const gate: CompletionGatePort = {
      async evaluate(input) {
        return {
          invocation: input.invocation,
          verificationSnapshot: input.verificationSnapshot,
          status: "blocked_unassessed",
          disposition: "continue",
          reasons: [{
            owner: "verification",
            code: "completion_not_yet_established",
            message: "Completion is not yet established.",
            requirement: null,
          }],
          failure: null,
          decidedAt: NOW,
        };
      },
    };
    const controller = new ScriptedController([
      complete("Not ready", "model_complete_1"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        return complete("Not ready", "model_complete_2");
      },
    ]);
    const result = await createRunner(controller, operations, {
      verification: {
        executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
        completionGate: gate,
        preparation: null,
        settledOperationResults: null,
        checkResults: null,
      },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          maxIterations: 2,
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "blocked",
      code: "runtime_stop_feedback_exhausted",
    });
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(({ payload }) => payload.kind === "stop_review"))
      .toHaveLength(2);
    expect(result.items.filter(({ payload }) => payload.kind === "stop_feedback"))
      .toHaveLength(1);
    expect(result.items.at(-1)?.payload).toMatchObject({
      kind: "terminal_transition",
      status: "blocked",
      code: "runtime_stop_feedback_exhausted",
    });
  });

  it("preserves a nested Verification Failure when Completion Gate execution fails", async () => {
    const operations = createOperationFixture([]);
    const gate: CompletionGatePort = {
      async evaluate(input) {
        return {
          invocation: input.invocation,
          verificationSnapshot: input.verificationSnapshot,
          status: "invalid",
          disposition: "fail",
          reasons: [],
          failure: createVerificationFailure({
            code: "verification_gate_provider_failed",
            stage: "completion_gate",
            message: "Gate policy owner failed.",
            retryable: true,
            cause: input.policy,
          }),
          decidedAt: NOW,
        };
      },
    };
    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      {
        verification: {
          executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
          completionGate: gate,
          preparation: null,
          settledOperationResults: null,
          checkResults: null,
        },
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "verification_failed",
      failure: {
        kind: "verification",
        failure: { code: "verification_gate_provider_failed", stage: "completion_gate" },
      },
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "stop_review",
        review: expect.objectContaining({ decision: "failed" }),
      }),
    }));
  });

  it("fails closed when a Completion Gate requests waiting without exact active work", async () => {
    const operations = createOperationFixture([]);
    const gate: CompletionGatePort = {
      async evaluate(input) {
        return {
          invocation: input.invocation,
          verificationSnapshot: input.verificationSnapshot,
          status: "blocked_pending",
          disposition: "wait",
          reasons: [{
            owner: "verification",
            code: "verification_requirement_pending",
            message: "Mandatory Verification work is pending.",
            requirement: null,
          }],
          failure: null,
          decidedAt: NOW,
        };
      },
    };
    const result = await createRunner(
      new ScriptedController([complete("Cannot wait")]),
      operations,
      {
        verification: {
          executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
          completionGate: gate,
          preparation: null,
          settledOperationResults: null,
          checkResults: null,
        },
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "verification_failed",
      failure: {
        kind: "verification",
        failure: { code: "verification_gate_wait_without_pending_work" },
      },
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "stop_review",
        review: expect.objectContaining({ decision: "failed" }),
      }),
    }));
  });

  it("does not turn Controller failure into completion-recovery feedback", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const result = await createRunner(
      new ScriptedController([() => { throw new Error("controller unavailable"); }]),
      operations,
      { runtimeEventPublisher: { publish: (event) => events.push(event) } },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result.status).toBe("failed");
    expect(events.filter((event) => event.name === "verification.gate.evaluated"))
      .toHaveLength(0);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "verification_feedback" && payload.verification.gate !== null
    )).toHaveLength(0);
  });

  it("lets accepted cancellation outrank an in-flight eligible gate decision", async () => {
    const operations = createOperationFixture([]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const gate: CompletionGatePort = {
      async evaluate(input) {
        entered.resolve();
        await release.promise;
        return eligibleGateDecision(input);
      },
    };
    const handle = createRunner(
      new ScriptedController([complete("Late completion")]),
      operations,
      {
        verification: {
          executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
          completionGate: gate,
          preparation: null,
          settledOperationResults: null,
          checkResults: null,
        },
      },
    ).start(createAgent(), createRunInput(), createRunConfig(operations));
    await entered.promise;

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    release.resolve();
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(result.items.filter((item) =>
      item.payload.kind === "terminal_transition" && item.payload.status === "succeeded"))
      .toHaveLength(0);
  });

  it("discards a gate decision whose Run basis was invalidated by steering", async () => {
    const operations = createOperationFixture([]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: RuntimeEvent[] = [];
    let gateCalls = 0;
    const gate: CompletionGatePort = {
      async evaluate(input) {
        gateCalls += 1;
        if (gateCalls === 1) {
          entered.resolve();
          await release.promise;
        }
        return eligibleGateDecision(input);
      },
    };
    const handle = createRunner(
      new ScriptedController([
        complete("Stale completion", "model_complete_1"),
        complete("Fresh completion", "model_complete_2"),
      ]),
      operations,
      {
        verification: {
          executionFactory: createTestVerificationExecutionFactory({ now: () => NOW }),
          completionGate: gate,
          preparation: null,
          settledOperationResults: null,
          checkResults: null,
        },
        runtimeEventPublisher: { publish: (event) => events.push(event) },
      },
    ).start(createAgent(), createRunInput(), createRunConfig(operations));
    await entered.promise;
    const expectedRunRevision = handle.getSnapshot().runRevision;
    expect(handle.steer({
      commandId: "gate-steering",
      expectedRunRevision,
      instruction: "Re-evaluate completion against current state.",
      attribution: { origin: "user", actorId: "user-1" },
      submittedAt: NOW,
    }).status).toBe("accepted_for_application");
    release.resolve();

    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Fresh completion" },
    });
    expect(gateCalls).toBe(2);
    expect(events.filter((event) => event.name === "verification.gate.evaluated"))
      .toHaveLength(2);
  });

  it("publishes committed Context transitions only after Runner state commits", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([complete("Done")]);

    await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(createAgent(), createRunInput(), createRunConfig(operations));

    const transitions = events.filter(
      (event) => event.name === "context.transition.committed",
    );
    expect(transitions.map((event) => event.payload.operationKinds)).toEqual([
      ["add"],
      ["add", "add"],
    ]);
    expect(transitions[0]?.payload).not.toHaveProperty("contribution");
    const projections = events.filter(
      (event) => event.name === "context.projection.completed",
    );
    expect(projections).toHaveLength(1);
    expect(projections[0]?.payload).toMatchObject({
      outcome: "projected",
      code: null,
    });
    expect(projections[0]?.payload).not.toHaveProperty("records");
    expect(events.findIndex((event) => event.name === "context.transition.committed"))
      .toBeGreaterThan(events.findIndex((event) => event.name === "run.started"));
  });

  it("publishes a safe blocked Manifest summary before Context projection failure", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([complete("must not run")]);
    const baseProjection = createTestContextProjection();

    const result = await createRunner(controller, operations, {
      contextProjection: Object.freeze({
        ...baseProjection,
        allocate(input) {
          const allocation = baseProjection.allocate(input);
          return Object.freeze({
            ...allocation,
            budget: Object.freeze({ unit: allocation.budget.unit, maximum: 0 }),
          });
        },
      }),
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "context_projection_failed",
    });
    expect(controller.calls).toHaveLength(0);
    const projection = events.find(
      (event) => event.name === "context.projection.completed",
    );
    expect(projection?.payload).toMatchObject({
      outcome: "blocked",
      code: "context_projection_mandatory_overflow",
      budgetMaximum: 0,
      projectedAmount: 0,
    });
    expect(projection?.payload.blockedCount).toBeGreaterThan(0);
    expect(events.findIndex((event) => event.name === "context.projection.completed"))
      .toBeLessThan(events.findIndex((event) => event.name === "run.failed"));
  });

  it("persists only a safe Projection Manifest without making persistence authoritative", async () => {
    const operations = createOperationFixture([]);
    const baseProjection = createTestContextProjection();
    const persistManifest = vi.fn(async () => ({
      kind: "failed" as const,
      code: "test_manifest_store_unavailable",
      message: "Manifest Store is unavailable.",
    }));

    const result = await createRunner(
      new ScriptedController([complete("Done")]),
      operations,
      {
        contextProjection: Object.freeze({
          ...baseProjection,
          manifestPersistence: { persistManifest },
        }),
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result.status).toBe("succeeded");
    expect(persistManifest).toHaveBeenCalledTimes(1);
    const persisted = persistManifest.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      outcome: "projected",
      code: null,
    });
    expect(persisted).not.toHaveProperty("records");
  });

  it("executes one exposed Tool through its exact internal Operation binding", async () => {
    const operation = operationRef("read-file");
    const handler = internalHandler("handler.read-file", "code-workspace", {
      content: "hello",
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: handler.id,
      }),
    ], [handler]);
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      (input) => advance([{
        kind: "tool_request",
        tool: {
          name: "codeAgent.readFile",
          revision: "1",
          input: { path: "README.md" },
          origin: "model",
          controllerRequestId: input.toolExposure.controllerRequestId,
        },
      }], "model_tool_1"),
      complete("Read complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    const observation = observations(result).find(
      ({ payload }) => payload.kind === "operation",
    );
    expect(observation?.payload).toMatchObject({
      kind: "operation",
      result: {
        status: "succeeded",
        semanticOwner: "code-workspace",
        output: { content: "hello" },
      },
      toolResult: {
        status: "succeeded",
        output: { content: "hello" },
      },
    });
    expect(observation?.lowerRefs.map(({ kind }) => kind)).toEqual([
      "operation_result",
      "tool_result",
    ]);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(1);
  });

  it("omits an owner-proven unavailable Operation Tool before the model request", async () => {
    const operation = operationRef("controlled-operation");
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: "handler.controlled-operation",
      }),
    ], [], {
      availability: [Object.freeze({
        binding: { operation, revision: "binding-1" },
        assess: () => Object.freeze({
          basisRefs: Object.freeze([Object.freeze({
            owner: "test-resource-owner",
            kind: "eligible_subjects",
            id: "run-subjects",
            revision: "0",
          })]),
          disposition: "unavailable" as const,
          reason: "no_eligible_subject" as const,
        }),
      })],
    });
    const tools = createToolSelection(operations, operation, "ControlledOperation");
    const controller = new ScriptedController([
      (input) => {
        expect(input.toolExposure.catalog.tools).toEqual([]);
        return complete("No current controlled subject");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(1);
  });

  it("keeps an available Tool exposed under ask and deny approval policies", async () => {
    const operation = operationRef("effectful-operation");
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {
        requestOrigins: ["tool_request"],
        actionAdapterId: "adapter.effectful-operation",
      }),
    ]);
    const tools = createToolSelection(operations, operation, "EffectfulOperation");

    for (const approvalPolicy of ["on-request", "never"] as const) {
      const controller = new ScriptedController([
        (input) => {
          expect(input.toolExposure.catalog.tools.map(({ name }) => name))
            .toEqual(["EffectfulOperation"]);
          return complete(`Exposure preserved for ${approvalPolicy}`);
        },
      ]);
      const config = createRunConfig(operations, { tools });
      const result = await createRunner(controller, operations).run(
        createAgent(),
        createRunInput(`task_${approvalPolicy}`),
        {
          ...config,
          permissions: Object.freeze({
            ...config.permissions,
            approvalPolicy,
            reviewer: approvalPolicy === "on-request"
              ? Object.freeze({
                  bindingId: "test-user-reviewer",
                  kind: "user" as const,
                  descriptor: Object.freeze({
                    id: "test-user-reviewer",
                    kind: "user" as const,
                    displayName: "Test User",
                    source: "test",
                    metadata: Object.freeze({}),
                  }),
                })
              : null,
          }),
        },
      );
      expect(result.status).toBe("succeeded");
    }
  });

  it("discards a Controller response when its owner exposure basis becomes stale", async () => {
    const operation = operationRef("read-file");
    let ownerRevision = 1;
    const entered = deferred<void>();
    const release = deferred<void>();
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: "handler.read-file",
      }),
    ], [], {
      availability: [Object.freeze({
        binding: { operation, revision: "binding-1" },
        assess: () => Object.freeze({
          basisRefs: Object.freeze([Object.freeze({
            owner: "test-resource-owner",
            kind: "read-path",
            id: "workspace",
            revision: String(ownerRevision),
          })]),
          disposition: "available" as const,
          reason: null,
        }),
      })],
    });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      async (input) => {
        entered.resolve();
        await release.promise;
        return advance([toolCandidate(
          "codeAgent.readFile",
          { path: "README.md" },
          input.toolExposure.controllerRequestId,
        )], "stale-model-item");
      },
      complete("Fresh response accepted", "fresh-model-item"),
    ]);
    const pending = createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );
    await entered.promise;
    ownerRevision += 1;
    release.resolve();

    const result = await pending;

    expect(result.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(2);
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "controller_turn",
        status: "interrupted",
        modelItems: [],
      }),
    }));
    expect(JSON.stringify(result.items)).not.toContain("stale-model-item");
  });

  it("invalidates later candidates after an earlier candidate changes owner availability basis", async () => {
    const operation = operationRef("read-file");
    let ownerRevision = 1;
    const handler = internalHandler("handler.read-file", "code-workspace", { content: "hello" });
    handler.execute.mockImplementation(async (context) => {
      ownerRevision += 1;
      return createOperationResult({
        ref: { invocation: context.binding.invocation, id: `${context.binding.invocation.id}:result` },
        binding: context.binding.binding,
        semanticOwner: "code-workspace",
        status: "succeeded",
        output: { content: "hello" },
        failure: null,
        startedAt: NOW,
        finishedAt: NOW,
        lowerRefs: [],
        metadata: {},
      });
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: handler.id,
      }),
    ], [handler], {
      availability: [Object.freeze({
        binding: { operation, revision: "binding-1" },
        assess: () => Object.freeze({
          basisRefs: Object.freeze([Object.freeze({
            owner: "test-resource-owner",
            kind: "read-path",
            id: "workspace",
            revision: String(ownerRevision),
          })]),
          disposition: "available" as const,
          reason: null,
        }),
      })],
    });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      (input) => advance([
          toolCandidate("codeAgent.readFile", { path: "one.txt" }, input.toolExposure.controllerRequestId),
          toolCandidate("codeAgent.readFile", { path: "two.txt" }, input.toolExposure.controllerRequestId),
        ], ["model_tool_1", "model_tool_2"]),
      complete("Only the first candidate executed"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(result.items.flatMap(({ payload }) =>
      payload.kind === "model_call_settlement" ? [payload.result] : []
    )).toMatchObject([
      { modelCallRef: { id: "model_tool_1" }, settlement: "succeeded" },
      { modelCallRef: { id: "model_tool_2" }, settlement: "invalidated" },
    ]);
  });

  it("attributes availability participant failure without requesting the Controller", async () => {
    const operation = operationRef("read-file");
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: "handler.read-file",
      }),
    ], [], {
      availability: [Object.freeze({
        binding: { operation, revision: "binding-1" },
        assess() {
          throw new Error("availability source unavailable");
        },
      })],
    });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([complete("Must not be requested")]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "failed",
      code: "tool_exposure_failed",
      failure: {
        kind: "tool",
        failure: { code: "tool_availability_participant_failed" },
      },
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("routes an exposed interaction Tool directly through its Interaction protocol", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const tools = createSemanticToolSelection(
      operations,
      "AskUserQuestion",
      {
        kind: "interaction",
        protocol: interaction.ref,
        blockingScope: "run",
        revision: "interaction-binding-1",
      },
    );
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "AskUserQuestion",
        { question: "Continue?" },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "interaction",
          status: "resolved",
          value: { accepted: true },
          toolResult: {
            status: "succeeded",
            output: { accepted: true },
          },
        });
        return complete("Clarification complete", "model_complete_2");
      },
    ]);
    const handle = createRunner(controller, operations, {
      interactions: interaction.registry,
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );
    const pending = await waitForPendingInteraction(handle);

    expect(pending.envelope.presentation).toEqual({ question: "Continue?" });
    expect(handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    }).status).toBe("accepted_for_resolution");

    const result = await handle.wait();
    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(observations(result).some(({ payload }) => payload.kind === "operation"))
      .toBe(false);
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "run_action",
        action: expect.objectContaining({
          subject: expect.objectContaining({ kind: "tool" }),
        }),
      }),
    }));
  });

  it("routes an exposed Agent Tool directly to one bounded descendant Run", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let operations!: OperationFixture;
    let tools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Inspect the contracts." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      (input) => {
        expect(input.agent).toMatchObject({ id: childAgent.id, revision: childAgent.revision });
        return complete("Child complete", "model_child_complete");
      },
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "succeeded",
          output: { summary: "Child complete" },
          toolResult: {
            status: "succeeded",
            output: { summary: "Child complete" },
          },
        });
        return complete("Parent complete", "model_parent_complete");
      },
    ]);
    operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    tools = createSemanticToolSelection(
      operations,
      "Agent",
      {
        kind: "descendant_agent",
        agent: { id: childAgent.id, revision: childAgent.revision },
        revision: "descendant-binding-1",
      },
    );

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "descendant_run",
        status: "succeeded",
        output: expect.objectContaining({ summary: "Child complete" }),
      }),
    }));
    expect(observations(result).some(({ payload }) => payload.kind === "operation"))
      .toBe(false);
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_001",
    ]);
  });

  it("launches contiguous Agent calls as concurrent siblings and commits Parent outcomes in candidate order", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const enteredChildren: string[] = [];
    const controllerCalls: ControllerInput<TestOutput>[] = [];
    const events: RuntimeEvent[] = [];
    let rootTurn = 0;
    let releaseFirstChild!: () => void;
    const secondChildEntered = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    const controller: Controller<TestOutput> = {
      resourceMetering: Object.freeze({
        modelInputTokens: "not_applicable" as const,
        modelOutputTokens: "not_applicable" as const,
        costUnits: "not_applicable" as const,
      }),
      async next(input) {
        controllerCalls.push(input);
        if (input.runId === "run_002") {
          enteredChildren.push(input.runId);
          await secondChildEntered;
          return complete("Child one", "model_child_1_complete");
        }
        if (input.runId === "run_003") {
          enteredChildren.push(input.runId);
          releaseFirstChild();
          return complete("Child two", "model_child_2_complete");
        }
        if (input.runId !== "run_001") {
          throw new Error(`Unexpected Run '${input.runId}'.`);
        }
        rootTurn += 1;
        if (rootTurn === 1) {
          return advance([
            toolCandidate(
              "Agent",
              { prompt: "Inspect the contracts." },
              input.toolExposure.controllerRequestId,
            ),
            toolCandidate(
              "Agent",
              { prompt: "Inspect the runtime." },
              input.toolExposure.controllerRequestId,
            ),
          ], ["model_agent_1", "model_agent_2"]);
        }
        const descendantObservations = projectedObservations(input.context)
          .filter(({ payload }) => payload.kind === "descendant_run");
        expect(descendantObservations.map(({ payload }) =>
          isRecord(payload.output) ? payload.output.summary : null
        )).toEqual(["Child one", "Child two"]);
        return complete("Parent complete", "model_parent_complete");
      },
    };
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: {
        publish(event) {
          events.push(event);
        },
      },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(
      enteredChildren,
      JSON.stringify(events.filter(({ name }) => name.startsWith("run.descendant.")), null, 2),
    ).toEqual(["run_002", "run_003"]);
    expect(controllerCalls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_003",
      "run_001",
    ]);
    const descendantEvents = events.filter(({ name }) =>
      name.startsWith("run.descendant."));
    expect(descendantEvents.map(({ name }) => name)).toEqual([
      "run.descendant.reserved",
      "run.descendant.reserved",
      "run.descendant.started",
      "run.descendant.started",
      "run.descendant.settled",
      "run.descendant.settled",
    ]);
    expect(descendantEvents.slice(0, 4).map(({ payload }) => ({
      requestedDispatchForm: payload.requestedDispatchForm,
      siblingIndex: payload.siblingIndex,
      siblingCount: payload.siblingCount,
    }))).toEqual([
      { requestedDispatchForm: "concurrent_sibling", siblingIndex: 0, siblingCount: 2 },
      { requestedDispatchForm: "concurrent_sibling", siblingIndex: 1, siblingCount: 2 },
      { requestedDispatchForm: "concurrent_sibling", siblingIndex: 0, siblingCount: 2 },
      { requestedDispatchForm: "concurrent_sibling", siblingIndex: 1, siblingCount: 2 },
    ]);
    expect(descendantEvents.slice(4).map(({ payload }) => payload.childRunId).sort())
      .toEqual(["run_002", "run_003"]);
    expect(observations(result)
      .filter(({ payload }) => payload.kind === "descendant_run")
      .map(({ payload }) => isRecord(payload.output) ? payload.output.summary : null))
      .toEqual(["Child one", "Child two"]);
  });

  it("keeps mixed concurrent sibling outcomes independent and lets the Parent continue", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let rootTurn = 0;
    const controller: Controller<TestOutput> = {
      resourceMetering: Object.freeze({
        modelInputTokens: "not_applicable" as const,
        modelOutputTokens: "not_applicable" as const,
        costUnits: "not_applicable" as const,
      }),
      async next(input) {
        if (input.runId === "run_002") {
          return complete("Useful child result", "model_child_1_complete");
        }
        if (input.runId === "run_003") {
          throw new Error("Child controller failed.");
        }
        if (input.runId !== "run_001") {
          throw new Error(`Unexpected Run '${input.runId}'.`);
        }
        rootTurn += 1;
        if (rootTurn === 1) {
          return advance([
            toolCandidate(
              "Agent",
              { prompt: "Inspect the contracts." },
              input.toolExposure.controllerRequestId,
            ),
            toolCandidate(
              "Agent",
              { prompt: "Inspect the runtime." },
              input.toolExposure.controllerRequestId,
            ),
          ], ["model_agent_1", "model_agent_2"]);
        }
        expect(projectedObservations(input.context)
          .filter(({ payload }) => payload.kind === "descendant_run")
          .map(({ payload }) => payload.status)).toEqual(["succeeded", "failed"]);
        return complete("Parent incorporated the available result", "model_parent_complete");
      },
    };
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });
    const runner = createRunner(controller, operations);
    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(observations(result)
      .filter(({ payload }) => payload.kind === "descendant_run")
      .map(({ payload }) => payload.status)).toEqual(["succeeded", "failed"]);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId, status }) => ({ runId, status })))
      .toEqual([
        { runId: "run_001", status: "succeeded" },
        { runId: "run_002", status: "succeeded" },
        { runId: "run_003", status: "failed" },
      ]);
    expect(handle.getSnapshot().runTree.settlement.complete).toBe(true);
  });

  it("rejects a concurrent Agent group when action capacity cannot admit the requested shape", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      (input) => advance([
        toolCandidate(
          "Agent",
          { prompt: "Inspect the contracts." },
          input.toolExposure.controllerRequestId,
        ),
        toolCandidate(
          "Agent",
          { prompt: "Inspect the runtime." },
          input.toolExposure.controllerRequestId,
        ),
      ], ["model_agent_1", "model_agent_2"]),
      complete("Parent continued without serial fallback", "model_parent_complete"),
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools, limits: { maxActions: 1 } }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual(["run_001", "run_001"]);
    expect(events.some(({ name }) => name.startsWith("run.descendant."))).toBe(false);
    expect(result.items.flatMap(({ payload }) =>
      payload.kind === "model_call_settlement" ? [payload.result] : []
    )).toMatchObject([
      { modelCallRef: { id: "model_agent_1" }, settlement: "invalidated" },
      { modelCallRef: { id: "model_agent_2" }, settlement: "invalidated" },
    ]);
  });

  it("keeps resource-limited concurrent branches independent and settles every reservation", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      (input) => advance([
        toolCandidate(
          "Agent",
          { prompt: "Inspect the contracts." },
          input.toolExposure.controllerRequestId,
        ),
        toolCandidate(
          "Agent",
          { prompt: "Inspect the runtime." },
          input.toolExposure.controllerRequestId,
        ),
      ], ["model_agent_1", "model_agent_2"]),
      complete("Second branch completed", "model_child_complete"),
      (input) => {
        expect(projectedObservations(input.context)
          .filter(({ payload }) => payload.kind === "descendant_run")
          .map(({ payload }) => payload.status)).toEqual(["unavailable", "succeeded"]);
        return complete("Parent accepted independent outcomes", "model_parent_complete");
      },
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });
    const resources = testRunTreeResources();
    const runner = createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    });
    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeResources: Object.freeze({
          ...resources,
          modelInputTokens: Object.freeze({
            maximum: 1,
            minimumChildGrant: 1,
            enforcement: "hard" as const,
          }),
        }),
      }),
    );

    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_001",
    ]);
    expect(events.filter(({ name }) => name === "run.descendant.rejected")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          requestedDispatchForm: "concurrent_sibling",
          siblingIndex: 0,
          siblingCount: 2,
          code: "delegation_resource_limit_exceeded",
        }),
      }),
    ]);
    expect(events.filter(({ name }) => name === "run.descendant.started")
      .map(({ payload }) => ({ childRunId: payload.childRunId, siblingIndex: payload.siblingIndex })))
      .toEqual([{ childRunId: "run_002", siblingIndex: 1 }]);
    expect(handle.getSnapshot().runTree.settlement.complete).toBe(true);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId, status }) => ({ runId, status })))
      .toEqual([
        { runId: "run_001", status: "succeeded" },
        { runId: "run_002", status: "succeeded" },
      ]);
  });

  it("cancels admitted concurrent reservations before launch without starting a Child", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const events: RuntimeEvent[] = [];
    let cancelOnReservation: (() => void) | null = null;
    const controller = new ScriptedController([
      (input) => advance([
        toolCandidate(
          "Agent",
          { prompt: "Inspect the contracts." },
          input.toolExposure.controllerRequestId,
        ),
        toolCandidate(
          "Agent",
          { prompt: "Inspect the runtime." },
          input.toolExposure.controllerRequestId,
        ),
      ], ["model_agent_1", "model_agent_2"]),
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });
    const runner = createRunner(controller, operations, {
      runtimeEventPublisher: {
        publish(event) {
          events.push(event);
          if (event.name === "run.descendant.reserved" && cancelOnReservation !== null) {
            const cancel = cancelOnReservation;
            cancelOnReservation = null;
            cancel();
          }
        },
      },
    });
    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );
    cancelOnReservation = () => {
      expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
        .toBe("accepted");
    };

    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(controller.calls.map(({ runId }) => runId)).toEqual(["run_001"]);
    expect(events.filter(({ name }) => name === "run.descendant.started")).toHaveLength(0);
    expect(events.filter(({ name }) => name === "run.descendant.rejected"))
      .toHaveLength(2);
    expect(events.filter(({ name }) => name === "run.descendant.rejected")
      .map(({ payload }) => payload.code))
      .toEqual(["descendant_run_start_cancelled", "descendant_run_start_cancelled"]);
    expect(handle.getSnapshot().runTree.settlement.complete).toBe(true);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId, status }) => ({ runId, status })))
      .toEqual([
        { runId: "run_001", status: "cancelled" },
        { runId: "run_002", status: "cancelled" },
      ]);
  });

  it("starts a dependent child Run with the exact trusted dependency result", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let dependency: TestDelegationResultRef | null = null;
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Inspect the contracts." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Initial child result", "model_child_initial"),
      (input) => {
        const output = projectedObservations(input.context).at(-1)?.payload.output;
        expect(isRecord(output)).toBe(true);
        dependency = projectedDelegationResultRef(output);
        return advance([toolCandidate(
          "Agent",
          {
            prompt: "Continue from the accepted result.",
            dependency_result: dependency,
          },
          input.toolExposure.controllerRequestId,
        )], "model_tool_2");
      },
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.instructionRole === "data" &&
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "delegation_result" &&
          isRecord(block.payload.value.result) &&
          block.payload.value.result.id === dependency?.id &&
          block.payload.value.result.revision === dependency?.revision
        )).toBe(true);
        return complete("Continuation child result", "model_child_continuation");
      },
      complete("Parent complete", "model_parent_complete"),
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeLimits: {
          maxTotalDescendantRuns: 2,
          maxActiveDescendantRuns: 1,
          maxDescendantDepth: 1,
        },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_001",
      "run_003",
      "run_001",
    ]);
    const settled = events.filter((event) => event.name === "run.descendant.settled");
    expect(settled).toHaveLength(2);
    expect(settled[0]?.payload.dependencyResultId).toBeNull();
    expect(settled[1]?.payload).toMatchObject({
      childRunId: "run_003",
      dependencyResultId: dependency?.id,
      replacedResultId: null,
      contextSourceCount: 1,
    });
    expect(settled[1]?.payload.requestId).not.toBe(settled[0]?.payload.requestId);
    expect(settled[1]?.payload.resultId).not.toBe(settled[0]?.payload.resultId);
    expect(events.filter((event) => event.name === "run.descendant.reserved")
      .map(({ payload }) => ({
        requestedDispatchForm: payload.requestedDispatchForm,
        candidateIndex: payload.candidateIndex,
        siblingIndex: payload.siblingIndex,
        siblingCount: payload.siblingCount,
      }))).toEqual([
        { requestedDispatchForm: "single", candidateIndex: 0, siblingIndex: 0, siblingCount: 1 },
        { requestedDispatchForm: "single", candidateIndex: 0, siblingIndex: 0, siblingCount: 1 },
      ]);
  });

  it("continues one settled child context once through SendMessage", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let continuationTargetId = "";
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Inspect the contracts." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Child context retained", "model_child_complete"),
      (input) => {
        expect(input.descendants.continuations).toHaveLength(1);
        const target = input.descendants.continuations[0]!;
        continuationTargetId = target.ref.id;
        expect(target).toMatchObject({
          sourceChild: { id: "run_002" },
          agent: { id: childAgent.id, revision: childAgent.revision },
        });
        expect(JSON.stringify(target)).not.toContain("Child context retained");
        expect(input.toolExposure.catalog.tools.map(({ name }) => name))
          .toContain("SendMessage");
        return advance([{
          kind: "state_transition",
          transition: "plan_update",
          input: {
            explanation: "Record the settled child before continuing it.",
            plan: [{ step: "Inspect child result", status: "completed" }],
          },
        }, toolCandidate(
          "SendMessage",
          {
            target: { kind: "continuation", id: continuationTargetId },
            message: "Refine the retained finding.",
          },
          input.toolExposure.controllerRequestId,
        )], ["model_plan_1", "model_send_message_1"]);
      },
      (input) => {
        expect(input.runId).toBe("run_003");
        expect(input.interaction.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({
            role: "user",
            content: [expect.objectContaining({
              kind: "text",
              text: "Refine the retained finding.",
            })],
          }),
        ]));
        return complete("Continuation complete", "model_continuation_complete");
      },
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "succeeded",
          output: { summary: "Continuation complete" },
        });
        expect(input.descendants.continuations.some(
          ({ ref }) => ref.id === continuationTargetId,
        )).toBe(false);
        return advance([toolCandidate(
          "SendMessage",
          {
            target: { kind: "continuation", id: continuationTargetId },
            message: "Attempt to consume the same continuation again.",
          },
          input.toolExposure.controllerRequestId,
        )], "model_send_message_2");
      },
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "failed",
        });
        return complete("Parent complete", "model_parent_complete");
      },
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelectionSet(operations, [
      {
        name: "Agent",
        binding: {
          kind: "descendant_agent",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-binding-1",
        },
      },
      {
        name: "SendMessage",
        binding: {
          kind: "descendant_message",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-message-binding-1",
        },
      },
    ]);

    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeLimits: {
          maxTotalDescendantRuns: 2,
          maxActiveDescendantRuns: 1,
          maxDescendantDepth: 1,
        },
      }),
    );
    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_001",
      "run_003",
      "run_001",
      "run_001",
    ]);
    expect(handle.getSnapshot().runTree.nodes.flatMap(({ relationKind }) =>
      relationKind === null ? [] : [relationKind]
    ))
      .toEqual(["delegation", "continuation"]);
  });

  it("preserves child-local model history across successive continuation Runs", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let firstContinuationId = "";
    let secondContinuationId = "";
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Establish one child-local finding." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Original child finding", "model_child_complete"),
      (input) => {
        firstContinuationId = input.descendants.continuations[0]!.ref.id;
        return advance([toolCandidate(
          "SendMessage",
          {
            target: { kind: "continuation", id: firstContinuationId },
            message: "Refine the original finding.",
          },
          input.toolExposure.controllerRequestId,
        )], "model_send_message_1");
      },
      (input) => {
        expect(JSON.stringify(input.interaction.messages)).toContain("Original child finding");
        expect(JSON.stringify(input.interaction.messages)).toContain("Refine the original finding.");
        return complete("First continuation finding", "model_continuation_1");
      },
      (input) => {
        expect(input.descendants.continuations.some(
          ({ ref }) => ref.id === firstContinuationId,
        )).toBe(false);
        secondContinuationId = input.descendants.continuations[0]!.ref.id;
        return advance([toolCandidate(
          "SendMessage",
          {
            target: { kind: "continuation", id: secondContinuationId },
            message: "Refine the finding one final time.",
          },
          input.toolExposure.controllerRequestId,
        )], "model_send_message_2");
      },
      (input) => {
        const history = JSON.stringify(input.interaction.messages);
        expect(history).toContain("Original child finding");
        expect(history).toContain("Refine the original finding.");
        expect(history).toContain("First continuation finding");
        expect(history).toContain("Refine the finding one final time.");
        return complete("Second continuation finding", "model_continuation_2");
      },
      complete("Parent complete", "model_parent_complete"),
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelectionSet(operations, [
      {
        name: "Agent",
        binding: {
          kind: "descendant_agent",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-binding-1",
        },
      },
      {
        name: "SendMessage",
        binding: {
          kind: "descendant_message",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-message-binding-1",
        },
      },
    ]);

    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeLimits: {
          maxTotalDescendantRuns: 3,
          maxActiveDescendantRuns: 1,
          maxDescendantDepth: 1,
        },
      }),
    );
    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_001",
      "run_003",
      "run_001",
      "run_004",
      "run_001",
    ]);
    expect(handle.getSnapshot().runTree.nodes.flatMap(({ relationKind }) =>
      relationKind === null ? [] : [relationKind]
    )).toEqual(["delegation", "continuation", "continuation"]);
  });

  it("routes steering only through the exact active delegation relation", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Inspect the contracts." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      async () => {
        entered.resolve();
        await release.promise;
        return complete("Stale child result", "model_child_stale");
      },
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.instructionRole === "user" &&
          block.payload.kind === "text" &&
          block.payload.text === "Focus on the public contracts."
        )).toBe(true);
        return complete("Steered child result", "model_child_steered");
      },
      complete("Parent complete", "model_parent_complete"),
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });
    const handle = createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );
    await entered.promise;

    const active = handle.getSnapshot().activeDelegations[0]!;
    const route = {
      request: active.request,
      relation: active.relation,
      child: active.child,
      steering: {
        commandId: "child-steering-1",
        expectedRunRevision: active.childRunRevision,
        instruction: "Focus on the public contracts.",
        attribution: { origin: "user" as const, actorId: "user-1" },
        submittedAt: NOW,
      },
    };
    expect(handle.steerDescendant({
      ...route,
      relation: { id: "relation-unknown" },
    })).toMatchObject({ status: "rejected", code: "delegation_relation_unknown" });
    expect(handle.steerDescendant({
      ...route,
      request: { ...route.request, id: "request-wrong" },
    })).toMatchObject({ status: "rejected", code: "delegation_route_mismatch" });
    const routed = handle.steerDescendant(route);
    expect(routed).toMatchObject({
      status: "routed",
      submission: { status: "accepted_for_application" },
    });
    release.resolve();

    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handle.getSnapshot().activeDelegations).toEqual([]);
    expect(handle.steerDescendant(route)).toMatchObject({
      status: "rejected",
      code: "delegation_child_settled",
    });
    expect(events.find((event) => event.name === "run.descendant.started")?.payload)
      .toMatchObject({
        requestId: active.request.id,
        childAgentId: childAgent.id,
        contextSourceCount: 0,
      });
  });

  it("omits the descendant Agent Tool when Run Tree depth capacity is exhausted", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "descendant-binding-1",
    });
    const controller = new ScriptedController([
      (input) => {
        expect(input.toolExposure.catalog.tools).toEqual([]);
        return complete("Depth capacity is exhausted");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeLimits: { maxDescendantDepth: 0 },
      }),
    );

    expect(result.status).toBe("succeeded");
  });

  it("executes recursive descendants through one Runner and one inherited tree", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let operations!: OperationFixture;
    let childTools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Delegate once." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Delegate again." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Grandchild complete", "model_grandchild_complete"),
      complete("Child complete", "model_child_complete"),
      complete("Root complete", "model_root_complete"),
    ]);
    operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    childTools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "grandchild-binding-1",
    });
    const rootTools = childTools;

    const events: RuntimeEvent[] = [];
    const traces: RunTrace[] = [];
    const rootSnapshots: import("./RunHandle.js").RunOperationSnapshot[] = [];
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools: rootTools,
        runTreeLimits: {
          maxTotalDescendantRuns: 2,
          maxActiveDescendantRuns: 2,
          maxDescendantDepth: 2,
        },
      }),
      {
        runtimeEventPublisher: {
          publish(event) {
            events.push(event);
            if (event.runId === "run_003" && event.name === "run.started") {
              throw new Error("A listener cannot interrupt descendant execution.");
            }
          },
        },
        runTraceObserver: {
          observe(trace) {
            traces.push(trace);
            if (trace.runId === "run_003" && trace.status === "active") {
              throw new Error("A Trace observer cannot interrupt descendant execution.");
            }
          },
        },
      },
    );
    handle.subscribe((snapshot) => rootSnapshots.push(snapshot));
    const result = await handle.wait();


    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_003",
      "run_002",
      "run_001",
    ]);
    const firstEventByRun = new Map<string, RuntimeEvent>();
    for (const event of events) {
      if (!firstEventByRun.has(event.runId)) firstEventByRun.set(event.runId, event);
    }
    expect(firstEventByRun.get("run_001")?.lineage).toEqual({
      kind: "root",
      root: { id: "run_001" },
      depth: 0,
    });
    expect(firstEventByRun.get("run_002")?.lineage).toMatchObject({
      kind: "descendant",
      root: { id: "run_001" },
      parent: { id: "run_001" },
      depth: 1,
    });
    expect(firstEventByRun.get("run_003")?.lineage).toMatchObject({
      kind: "descendant",
      root: { id: "run_001" },
      parent: { id: "run_002" },
      depth: 2,
    });
    for (const runId of ["run_001", "run_002", "run_003"]) {
      expect(events.filter((event) => event.runId === runId).map((event) => event.sequence))
        .toEqual(events.filter((event) => event.runId === runId).map((_, index) => index + 1));
    }
    expect(events.filter((event) => event.runId === "run_001" &&
      event.name.startsWith("run.descendant.")).map((event) => event.name)).toEqual([
      "run.descendant.reserved",
      "run.descendant.started",
      "run.descendant.settled",
    ]);
    expect(events.filter((event) => event.runId === "run_002" &&
      event.name.startsWith("run.descendant.")).map((event) => event.name)).toEqual([
      "run.descendant.reserved",
      "run.descendant.started",
      "run.descendant.settled",
    ]);
    const terminalTraces = traces.filter((trace) => trace.status !== "active");
    expect(terminalTraces.map((trace) => [trace.runId, trace.lineage.kind, trace.lineage.depth]))
      .toEqual(expect.arrayContaining([
        ["run_001", "root", 0],
        ["run_002", "descendant", 1],
        ["run_003", "descendant", 2],
      ]));
    expect(rootSnapshots.at(-1)?.runTree).toMatchObject({
      rootRunId: "run_001",
      totalDescendantRuns: 2,
      activeDescendantRuns: 0,
      nodes: [
        { runId: "run_001", status: "succeeded", depth: 0 },
        { runId: "run_002", status: "succeeded", depth: 1 },
        { runId: "run_003", status: "succeeded", depth: 2 },
      ],
    });
  });

  it("composes nested partial replacement under narrowed authority and conserved tree resources", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let replacedResult: TestDelegationResultRef | null = null;
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Own one bounded child objective." },
        input.toolExposure.controllerRequestId,
      )], "model_root_delegate"),
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Produce an initial nested contribution." },
        input.toolExposure.controllerRequestId,
      )], "model_child_delegate"),
      complete("Partial nested contribution", "model_grandchild_partial"),
      (input) => {
        const observation = projectedObservations(input.context).at(-1);
        expect(observation?.payload).toMatchObject({
          kind: "descendant_run",
          status: "partial",
          output: { summary: "Partial nested contribution" },
        });
        const output = observation?.payload.output;
        expect(isRecord(output)).toBe(true);
        replacedResult = projectedDelegationResultRef(output);
        expect(input.toolExposure.catalog.tools.map(({ name }) => name))
          .toEqual(["Agent"]);
        return advance([toolCandidate(
          "Agent",
          {
            prompt: "Replace the partial nested contribution.",
            replaced_result: replacedResult,
          },
          input.toolExposure.controllerRequestId,
        )], "model_child_replace");
      },
      complete("Replacement contribution", "model_replacement_complete"),
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "succeeded",
          output: { summary: "Replacement contribution" },
        });
        expect(input.toolExposure.catalog.tools.map(({ name }) => name))
          .not.toContain("SendMessage");
        return complete("Child synthesis complete", "model_child_complete");
      },
      (input) => {
        expect(input.toolExposure.catalog.tools.map(({ name }) => name))
          .toContain("SendMessage");
        return complete("Root synthesis complete", "model_root_complete");
      },
    ]);
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent, {
        narrowToolAuthority: true,
        partialSummary: "Partial nested contribution",
      }),
    });
    const tools = createSemanticToolSelectionSet(operations, [
      {
        name: "Agent",
        binding: {
          kind: "descendant_agent",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-binding-1",
        },
      },
      {
        name: "SendMessage",
        binding: {
          kind: "descendant_message",
          agent: { id: childAgent.id, revision: childAgent.revision },
          revision: "descendant-message-binding-1",
        },
      },
    ]);
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools,
        runTreeLimits: {
          maxTotalDescendantRuns: 3,
          maxActiveDescendantRuns: 2,
          maxDescendantDepth: 2,
        },
      }),
    );
    const result = await handle.wait();
    const tree = handle.getSnapshot().runTree;

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.finalOutput).toEqual({ summary: "Root synthesis complete" });
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      "run_003",
      "run_002",
      "run_004",
      "run_002",
      "run_001",
    ]);
    expect(tree).toMatchObject({
      rootRunId: "run_001",
      totalDescendantRuns: 3,
      activeDescendantRuns: 0,
      settlement: {
        complete: true,
        unsettledDescendantRuns: 0,
        pendingResultTransfers: 0,
      },
    });
    expect(tree.nodes.map(({ runId, parentRunId, relationKind, status }) => ({
      runId,
      parentRunId,
      relationKind,
      status,
    })), JSON.stringify(tree, null, 2)).toEqual([
      { runId: "run_001", parentRunId: null, relationKind: null, status: "succeeded" },
      { runId: "run_002", parentRunId: "run_001", relationKind: "delegation", status: "succeeded" },
      { runId: "run_003", parentRunId: "run_002", relationKind: "delegation", status: "succeeded" },
      { runId: "run_004", parentRunId: "run_002", relationKind: "replacement", status: "succeeded" },
    ]);
    expect(tree.resources.controllerTurns).toMatchObject({
      enforcement: "hard",
      capacity: 256,
      activeReserved: 0,
    });
    expect(tree.nodes.every(({ resources }) => resources.settled)).toBe(true);
  });

  it("inherits the root invocation Action observer into descendant execution", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const verificationOperation = operationRef("verification-check");
    const actionExecution = createVerificationActionExecutionFixture(verificationOperation);
    let operations!: OperationFixture;
    let rootTools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Delegate verification." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Child complete", "model_child_complete"),
      complete("Root complete", "model_root_complete"),
    ]);
    operations = createOperationFixture([
      operationSpec(verificationOperation, "direct", {
        requestOrigins: ["automatic_stage"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], {
      actionExecution: actionExecution.dependencies,
      delegation: createTestDelegation(childAgent),
    });
    rootTools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "child-binding-1",
    });
    const notifications: ActionExecutionNotification[] = [];

    const result = await createRunner(controller, operations, {
      verification: createVerificationScenario({
        kind: "effectful_automatic",
        operation: verificationOperation,
      }),
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools: rootTools,
        actionExecution: createVerificationActionExecutionConfig(),
        verification: createMandatoryVerificationConfig("block"),
      }),
      {
        actionExecutionObserver: {
          observe(notification) {
            notifications.push(notification);
            if (notification.runId === "run_002") {
              throw new Error("A descendant Action observer cannot interrupt execution.");
            }
          },
        },
      },
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(notifications.some((notification) => notification.runId === "run_002"))
      .toBe(true);
    expect(notifications.some((notification) => notification.runId === "run_001"))
      .toBe(true);
  });

  it("settles invalid descendant startup with an exact operation failure", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    let operations!: OperationFixture;
    let tools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Start an invalid child." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "invalid",
          failure: { code: "delegation_context_invalid" },
          toolResult: {
            status: "failed",
            error: { code: "delegation_context_invalid" },
          },
        });
        return complete("Parent recovered", "model_parent_complete");
      },
    ]);
    operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent, {
        mandatoryUnsupportedContext: true,
      }),
    });
    tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "invalid-child-binding-1",
    });

    const events: RuntimeEvent[] = [];
    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
      { runtimeEventPublisher: { publish: (event) => events.push(event) } },
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_001",
    ]);
    expect(events.filter((event) => event.name.startsWith("run.descendant.")).map((event) => ({
      name: event.name,
      payload: event.payload,
    }))).toEqual([{
      name: "run.descendant.rejected",
      payload: expect.objectContaining({
        relationId: null,
        childRunId: null,
        depth: 1,
        code: "delegation_context_invalid",
        treeRevision: expect.any(Number),
      }),
    }]);
  });

  it("maps a workflow Tool Call to a trusted-workflow Operation request", async () => {
    const operation = operationRef("create-file");
    const handler = internalHandler("handler.create-file", "code-workspace", {
      created: true,
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["trusted_workflow"],
        handlerId: handler.id,
      }),
    ], [handler]);
    const tools = createToolSelection(
      operations,
      operation,
      "codeAgent.createFile",
      "workflow",
    );
    const controller = new ScriptedController([
      advance([{
        kind: "tool_request",
        tool: {
          name: "codeAgent.createFile",
          revision: "1",
          input: { path: "created.txt", content: "" },
          origin: "workflow",
          controllerRequestId: null,
        },
      }], "workflow_tool_1"),
      complete("Create complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "operation",
        result: expect.objectContaining({ status: "succeeded" }),
      }),
    }));
  });

  it("rejects a retired Operation before trusted resolution or execution", async () => {
    const operation = operationRef("retired-operation");
    const base = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["controller_protocol"],
        handlerId: "handler.retired",
      }),
    ]);
    const operations: OperationFixture = {
      ...base,
      catalog: createOperationCatalogSnapshot({
        ...base.catalog,
        entries: base.catalog.entries.map((entry) => ({
          ...entry,
          retirement: {
            retiredAt: NOW,
            reasonCode: "superseded",
          },
        })),
      }),
    };
    const controller = new ScriptedController([
      advance([operationCandidate(operation, {})], "model_operation"),
      complete("Handled retirement", "model_complete"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "operation_rejected",
        owner: "operation-catalog",
        code: "operation_retired",
      }),
    }));
  });

  it("rejects a request origin outside the exact admitted set", async () => {
    const operation = operationRef("workflow-only-operation");
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["trusted_workflow"],
        handlerId: "handler.workflow-only",
      }),
    ]);
    const controller = new ScriptedController([
      advance([operationCandidate(operation, {})], "model_operation"),
      complete("Handled origin rejection", "model_complete"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "operation_rejected",
        owner: "operation-catalog",
        code: "operation_request_origin_denied",
      }),
    }));
  });

  it("commits Plan state as an ordinary in-loop transition", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "Inspect before completing.",
          plan: [{ step: "Inspect state", status: "in_progress" }],
        },
      }], "model_plan_1"),
      (input) => {
        expect(input.plan).toMatchObject({
          version: 1,
          status: "active",
          steps: [{ step: "Inspect state", status: "in_progress" }],
        });
        return complete("Planned", "model_complete_2");
      },
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        return complete("Planned after advisory feedback", "model_complete_3");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.items.some(({ payload }) =>
      payload.kind === "state_transition" && payload.transition === "plan"
    )).toBe(true);
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ kind: "plan_update" }),
    }));
    expect(result.items.filter(({ payload }) => payload.kind === "stop_feedback"))
      .toHaveLength(1);
    expect(result.items.find(({ payload }) =>
      payload.kind === "stop_review" && payload.review.decision === "allow_stop"
    )?.payload).toMatchObject({
      kind: "stop_review",
      review: {
        limitations: [{ code: "plan_reconciliation_feedback_exhausted" }],
      },
    });
  });

  it("does not invent a no-progress terminal state for ordinary Plan churn", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const planCandidate = () => ({
      kind: "state_transition" as const,
      transition: "plan_update" as const,
      input: {
        explanation: "Inspect before completing.",
        plan: [{ step: "Inspect state", status: "in_progress" }],
      },
    });
    const controller = new ScriptedController([
      advance([planCandidate()], "model_plan_1"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(false);
        return advance([planCandidate()], "model_plan_2");
      },
      complete("Plan work is complete", "model_complete_3"),
      complete("Plan work remains complete", "model_complete_4"),
    ]);

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          maxIterations: 4,
          maxActions: 4,
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "succeeded",
      code: null,
    });
    expect(controller.calls).toHaveLength(4);
    const stopItems = result.items.filter(({ payload }) =>
      payload.kind === "stop_review" || payload.kind === "stop_feedback"
    );
    expect(stopItems.slice(0, 2).map(({ payload }) => payload.kind)).toEqual([
      "stop_review",
      "stop_feedback",
    ]);
    expect(stopItems[0]?.committedInRevision).toBe(stopItems[1]?.committedInRevision);
    expect(events.filter((event) => event.name.startsWith("run.stop.")).map(
      (event) => event.name,
    )).toEqual([
      "run.stop.reviewed",
      "run.stop.feedback_requested",
      "run.stop.reviewed",
    ]);
    expect(result.items.at(-1)?.payload).toMatchObject({
      kind: "terminal_transition",
      status: "succeeded",
      code: null,
      failure: null,
    });
  });

  it("continues the ordinary Loop when Stop feedback is followed by a new owner result", async () => {
    const operation = operationRef("inspect-new-snapshot");
    const handler = internalHandler(
      "handler.inspect-new-snapshot",
      "code-workspace",
      { inspected: true },
      [{
        owner: "code-workspace",
        kind: "workspace_snapshot",
        id: "workspace-snapshot-2",
        revision: "2",
      }],
    );
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["controller_protocol"],
        handlerId: handler.id,
      }),
    ], [handler]);
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "Start with a declaration.",
          plan: [{ step: "Inspect", status: "in_progress" }],
        },
      }], "model_plan_1"),
      complete("Completion before the inspection", "model_complete_2"),
      advance([operationCandidate(operation, {})], "model_operation"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        return complete("Recovered", "model_complete");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.items.some(({ payload }) =>
      payload.kind === "observation" && payload.observation.kind === "operation"
    )).toBe(true);
    expect(result.items.some(({ payload }) => payload.kind === "stop_feedback"))
      .toBe(true);
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" &&
      payload.code === "runtime_stop_feedback_exhausted"
    )).toBe(false);
  });

  it("lets cancellation outrank Stop Review while advisory feedback is active", async () => {
    const operations = createOperationFixture([]);
    const correctionTurnStarted = deferred<void>();
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "Start with a declaration.",
          plan: [{ step: "Inspect", status: "in_progress" }],
        },
      }], "model_plan_1"),
      complete("Completion before Plan reconciliation", "model_complete_2"),
      (input, context) => new Promise<ControllerDecision<TestOutput>>((resolve) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        correctionTurnStarted.resolve();
        context.cancellation.signal.addEventListener("abort", () => {
          resolve(complete("Too late", "model_late"));
        }, { once: true });
      }),
    ]);
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );
    await correctionTurnStarted.promise;

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
    });
    expect(result.items.some(({ payload }) =>
      payload.kind === "stop_feedback"
    )).toBe(true);
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" &&
      payload.code === "runtime_stop_feedback_exhausted"
    )).toBe(false);
  });

  it("lets the Run deadline outrank Stop Review while advisory feedback is active", async () => {
    const operations = createOperationFixture([]);
    let currentNow = NOW;
    const expiredNow = new Date(Date.parse(NOW) + 20_000).toISOString();
    const planCandidate = () => ({
      kind: "state_transition" as const,
      transition: "plan_update" as const,
      input: {
        explanation: "Keep declaring the same work.",
        plan: [{ step: "Inspect", status: "in_progress" as const }],
      },
    });
    const controller = new ScriptedController([
      advance([planCandidate()], "model_plan_1"),
      complete("Completion before Plan reconciliation", "model_complete_2"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        currentNow = expiredNow;
        return advance([planCandidate()], "model_plan_2");
      },
    ]);

    const result = await createRunner(controller, operations, {
      now: () => currentNow,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_deadline_exceeded",
    });
    expect(result.items.some(({ payload }) =>
      payload.kind === "stop_feedback"
    )).toBe(true);
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" &&
      payload.code === "runtime_stop_feedback_exhausted"
    )).toBe(false);
  });

  it("lets an unknown Operation effect outrank Stop Review feedback", async () => {
    const operation = operationRef("unknown-effect-after-correction");
    const actionExecution = createVerificationActionExecutionFixture(operation, {
      status: "failed",
      effectState: "unknown",
      failure: {
        code: "executor_connection_lost",
        message: "The executor connection ended before settlement was confirmed.",
        metadata: {},
        retryable: false,
      },
    });
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {
        requestOrigins: ["controller_protocol"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], { actionExecution: actionExecution.dependencies });
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "Start with a declaration.",
          plan: [{ step: "Inspect", status: "in_progress" }],
        },
      }], "model_plan_1"),
      complete("Completion before Plan reconciliation", "model_complete_2"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_stop_feedback"
        )).toBe(true);
        return advance([operationCandidate(operation, { target: "workspace" })], "model_operation");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createVerificationActionExecutionConfig(),
        limits: {
          stopReview: {
            maxRequiredFeedbackRounds: 1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "failed",
      code: "unknown_effect",
    });
    expect(actionExecution.execute).toHaveBeenCalledTimes(1);
    expect(result.items.some(({ payload }) =>
      payload.kind === "stop_feedback"
    )).toBe(true);
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" &&
      payload.code === "runtime_stop_feedback_exhausted"
    )).toBe(false);
    const settlementIndex = result.items.findIndex(({ payload }) =>
      payload.kind === "model_call_settlement" &&
      payload.result.modelCallRef.id === "model_operation"
    );
    const terminalIndex = result.items.findIndex(({ payload }) =>
      payload.kind === "terminal_transition" && payload.code === "unknown_effect"
    );
    expect(settlementIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(settlementIndex);
  });

  it("waits on a blocking generic Interaction and resumes the same Run", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const controller = new ScriptedController([
      advance([interactionCandidate("run")], "model_interaction_1"),
      (input) => {
        expect(input.pending).toEqual([]);
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "interaction",
          status: "resolved",
          value: { accepted: true },
        });
        return complete("Interaction resolved", "model_complete_2");
      },
    ]);
    const runner = createRunner(controller, operations, {
      interactions: interaction.registry,
    });
    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );
    const pending = await waitForPendingInteraction(handle);

    expect(handle.getSnapshot().status).toBe("waiting");
    expect(handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    }).status).toBe("accepted_for_resolution");

    const result = await handle.wait();
    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handle.getSnapshot().pendingInteractions).toEqual([]);
  });

  it("keeps Interaction cancellation identity separate from its semantic settlement code", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const controller = new ScriptedController([
      advance([interactionCandidate("run")], "model_interaction_1"),
    ]);
    const handle = createRunner(controller, operations, {
      interactions: interaction.registry,
    }).start(createAgent(), createRunInput(), createRunConfig(operations));
    await waitForPendingInteraction(handle);

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: {
        kind: "interaction",
        owner: "test-owner",
        status: "cancelled",
        contentDigest: null,
        toolResult: null,
        value: { code: "interaction_cancelled" },
      },
    }));
  });

  it("waits for a non-blocking Interaction settlement before the next Controller decision", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const controller = new ScriptedController([
      advance([interactionCandidate("none")], "model_interaction_1"),
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "interaction",
          status: "resolved",
        });
        return complete("Fresh decision", "model_complete_3");
      },
    ]);
    const handle = createRunner(controller, operations, {
      interactions: interaction.registry,
    }).start(createAgent(), createRunInput(), createRunConfig(operations));
    const pending = await waitForPendingInteraction(handle);
    expect(controller.calls).toHaveLength(1);

    handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    });
    await Promise.resolve();
    await waitUntil(() => controller.calls.length === 2);

    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Fresh decision" },
    });
    expect(controller.calls).toHaveLength(2);
  });

  it("applies accepted steering at a safe point and discards the stale Controller decision", async () => {
    const operations = createOperationFixture([]);
    const staleDecision = deferred<ControllerDecision<TestOutput>>();
    const controller = new ScriptedController([
      () => staleDecision.promise,
      (input) => {
        expect(input.plan).toBeNull();
        expect(input.context.blocks.find((block) =>
          block.instructionRole === "user" &&
          block.payload.kind === "text" &&
          block.payload.text === "Inspect the failing tests first."
        )).toBeDefined();
        return complete("Fresh decision", "model_complete_2");
      },
    ]);
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );
    await waitUntil(() => controller.calls.length === 1);
    const expectedRunRevision = handle.getSnapshot().runRevision;
    const command = {
      commandId: "steering-1",
      expectedRunRevision,
      instruction: "Inspect the failing tests first.",
      attribution: { origin: "user" as const, actorId: "user-1" },
      submittedAt: NOW,
    };

    expect(handle.steer(command)).toMatchObject({ status: "accepted_for_application" });
    expect(handle.steer(command)).toMatchObject({ status: "duplicate_identical" });
    expect(handle.steer({ ...command, instruction: "Conflicting instruction." })).toMatchObject({
      status: "rejected",
      code: "steering_command_conflict",
    });
    expect(handle.steer({
      ...command,
      commandId: "steering-stale",
      expectedRunRevision: expectedRunRevision + 1,
    })).toMatchObject({
      status: "rejected",
      code: "steering_revision_stale",
    });

    staleDecision.resolve(complete("Stale decision", "model_stale_1"));
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Fresh decision" },
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "state_transition",
        transition: "steering",
        steering: expect.objectContaining({ status: "applied" }),
      }),
    }));
    expect(controller.calls).toHaveLength(2);
  });

  it("applies a same-Run handoff without replacing Run or Task identity", async () => {
    const operations = createOperationFixture([]);
    const specialist = createAgent("agent_specialist", "2", "Specialist");
    const resolver = {
      async resolve(ref: AgentRevisionRef) {
        return ref.id === specialist.id && ref.revision === specialist.revision
          ? {
              status: "admitted" as const,
              agent: specialist,
              admissionEvidenceRef: "agent-admission-1",
              code: null,
            }
          : {
              status: "unavailable" as const,
              agent: null,
              admissionEvidenceRef: null,
              code: "agent_unavailable",
            };
      },
    };
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "handoff",
        input: {
          expectedRunRevision: 3,
          currentAgent: { id: "agent_001", revision: "1" },
          targetAgent: { id: specialist.id, revision: specialist.revision },
          reason: "Use specialist instructions.",
          transferPolicy: "all_context",
          admissionEvidenceRef: "agent-admission-1",
        },
      }], "model_handoff_1"),
      (input) => {
        expect(input.runId).toBe("run_001");
        expect(input.task.id).toBe("task_001");
        expect(input.agent).toMatchObject({ id: specialist.id, revision: specialist.revision });
        expect(input.instructionBinding).toMatchObject({
          agent: { id: specialist.id, revision: specialist.revision },
          instructions: specialist.instructions.ref,
          effectiveFromRunRevision: 6,
        });
        expect(input.instructionBinding.supersedes).not.toBeNull();
        return complete("Specialist complete", "model_complete_2");
      },
    ]);

    const result = await createRunner(controller, operations, { agents: resolver }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_specialist", revision: "2" },
      status: "succeeded",
    });
    expect(result.finalInstructionBinding).not.toEqual(result.startingInstructionBinding);
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "state_transition",
        transition: "active_agent",
        previousInstructionBinding: result.startingInstructionBinding,
        activeInstructionBinding: result.finalInstructionBinding,
      }),
    }));
  });

  it("rejects a previously observed Agent revision with different instructions", async () => {
    const operations = createOperationFixture([]);
    const specialist = createAgent("agent_specialist", "2", "Specialist");
    const bridge = createAgent("agent_bridge", "1", "Bridge");
    const conflictingSpecialist: Agent<TestOutput> = {
      ...specialist,
      instructions: createAgentInstructions({
        id: specialist.instructions.ref.id,
        release: specialist.instructions.release,
        model: specialist.instructions.model,
        resolverRevision: specialist.instructions.resolverRevision,
        blocks: [{
          id: "behavior",
          source: {
            owner: "test",
            kind: "instruction_source",
            id: `${specialist.id}.behavior`,
            revision: "2",
          },
          content: "Conflicting instructions for the same Agent revision.",
        }],
      }),
    };
    let specialistResolutions = 0;
    const resolver = {
      async resolve(ref: AgentRevisionRef) {
        if (ref.id === bridge.id && ref.revision === bridge.revision) {
          return {
            status: "admitted" as const,
            agent: bridge,
            admissionEvidenceRef: "agent-admission-bridge",
            code: null,
          };
        }
        if (ref.id === specialist.id && ref.revision === specialist.revision) {
          specialistResolutions += 1;
          return {
            status: "admitted" as const,
            agent: specialistResolutions === 1 ? specialist : conflictingSpecialist,
            admissionEvidenceRef: `agent-admission-specialist-${specialistResolutions}`,
            code: null,
          };
        }
        return {
          status: "unavailable" as const,
          agent: null,
          admissionEvidenceRef: null,
          code: "agent_unavailable",
        };
      },
    };
    const handoff = (
      expectedRunRevision: number,
      currentAgent: Agent<TestOutput>,
      targetAgent: Agent<TestOutput>,
      admissionEvidenceRef: string,
      modelCallId: string,
    ) => advance([{
      kind: "state_transition",
      transition: "handoff",
      input: {
        expectedRunRevision,
        currentAgent: { id: currentAgent.id, revision: currentAgent.revision },
        targetAgent: { id: targetAgent.id, revision: targetAgent.revision },
        reason: `Use ${targetAgent.name}.`,
        transferPolicy: "all_context",
        admissionEvidenceRef,
      },
    }], modelCallId);
    const controller = new ScriptedController([
      (input) => handoff(
        Number(input.interaction.revision),
        createAgent(),
        specialist,
        "agent-admission-specialist-1",
        "model_handoff_1",
      ),
      (input) => handoff(
        Number(input.interaction.revision),
        specialist,
        bridge,
        "agent-admission-bridge",
        "model_handoff_2",
      ),
      (input) => handoff(
        Number(input.interaction.revision),
        bridge,
        specialist,
        "agent-admission-specialist-2",
        "model_handoff_3",
      ),
      (input) => {
        expect(input.agent).toMatchObject({ id: bridge.id, revision: bridge.revision });
        expect(input.instructionBinding.instructions).toEqual(bridge.instructions.ref);
        return complete("Bridge complete", "model_complete_4");
      },
    ]);

    const result = await createRunner(controller, operations, { agents: resolver }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.finalActiveAgent).toEqual({ id: bridge.id, revision: bridge.revision });
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: {
        kind: "handoff",
        status: "rejected",
        code: "handoff_agent_revision_conflict",
      },
    }));
  });

  it("rejects descendant startup outside the model Agent Tool path", async () => {
    const delegate = operationRef("delegate-review");
    let operations!: OperationFixture;
    const controller = new ScriptedController([
      advance([operationCandidate(delegate, { topic: "contracts" })], "model_operation"),
      complete("Parent complete", "model_parent_complete"),
    ]);
    const descendantAgent = createAgent("agent_child", "1", "Child Agent");
    operations = createOperationFixture([
      operationSpec(delegate, "descendant_agent", {
        requestOrigins: ["controller_protocol"],
        agentRef: { id: descendantAgent.id, revision: descendantAgent.revision },
      }),
    ], [], { delegation: createTestDelegation(descendantAgent) });

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    const descendant = observations(result).find(({ payload }) =>
      payload.kind === "operation" && payload.result.semanticOwner === "code-agent"
    );
    expect(descendant?.payload).toMatchObject({
      kind: "operation",
      result: {
        status: "invalid",
        output: null,
        failure: { code: "delegation_requires_agent_tool" },
      },
    });
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_001",
    ]);
  });

  it("executes a bounded Composite through trusted child Operation RunActions", async () => {
    const composite = operationRef("inspect-workspace");
    const child = operationRef("read-metadata");
    const childHandler = internalHandler("handler.read-metadata", "code-workspace", {
      files: 3,
    });
    const definition = snapshotCompositeDefinition({
      ref: { id: "composite.inspect-workspace", revision: "1" },
      inputSchemaRevision: "input-1",
      resultSchemaRevision: "result-1",
      graphRevision: "graph-1",
      nodes: [{
        id: "read-metadata",
        operation: child,
        allowedBindings: ["internal"],
        dependencies: [],
        transformId: "identity-transform",
        conditionId: null,
        resourceClaims: [],
        required: true,
      }],
      join: { kind: "all_required_succeeded" },
      reducerId: "collect-results",
      conflictPolicyRevision: "conflict-1",
      limits: { maxNodes: 4, maxParallel: 1 },
      cancellationPolicy: "cancel_unstarted_and_signal_active",
      sensitivity: "internal",
      retiredAt: null,
    });
    const operations = createOperationFixture([
      operationSpec(composite, "composite", {
        requestOrigins: ["controller_protocol"],
        compositeDefinitionRef: "composite.inspect-workspace.v1",
      }),
      operationSpec(child, "internal", {
        requestOrigins: ["trusted_workflow"],
        handlerId: childHandler.id,
      }),
    ], [childHandler], {
      composite: {
        resolve(ref) {
          if (ref !== "composite.inspect-workspace.v1") return null;
          return {
            definition,
            execution: {
              transforms: [{
                id: "identity-transform",
                transform({ compositeInput }) {
                  return compositeInput;
                },
              }],
              conditions: [],
              reducer: {
                id: "collect-results",
                reduce({ children }) {
                  return { childStatuses: children.map(({ status }) => status) };
                },
              },
              conflicts: null,
            },
          };
        },
      },
    });
    const controller = new ScriptedController([
      advance([operationCandidate(composite, { path: "." })], "model_operation"),
      complete("Composite complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(childHandler.execute).toHaveBeenCalledTimes(1);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(2);
    expect(observations(result).filter(({ payload }) => payload.kind === "operation"))
      .toHaveLength(2);
  });

  it("cancels an active Controller boundary and does not commit its late decision", async () => {
    const operations = createOperationFixture([]);
    const started = deferred<void>();
    const controller = new ScriptedController([
      (_input, context) => new Promise<ControllerDecision<TestOutput>>((resolve) => {
        started.resolve();
        context.cancellation.signal.addEventListener("abort", () => {
          resolve(complete("Too late", "model_late"));
        }, { once: true });
      }),
    ]);
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );
    await started.promise;

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: { origin: "user", reasonCode: "user_requested" },
    });
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" && payload.status === "succeeded"
    )).toBe(false);
  });

  it("maps an explicit Controller stop to a blocked Run", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([{
      kind: "propose_stop",
      reason: "No safe path remains.",
      modelItems: modelTextItems("model_stop_1", "No safe path remains."),
    }]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      status: "blocked",
      code: "runtime_no_safe_path",
    });
  });

  it("rejects invalid config and incomplete Action composition before creating a Run", () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([complete("unused")]);
    const runner = createRunner(controller, operations);
    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { limits: { maxIterations: 0 } }),
    )).toThrow("RunLimits.maxIterations must be a positive safe integer");

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          stopReview: {
            maxRequiredFeedbackRounds: -1,
            maxAdvisoryFeedbackRounds: 1,
          },
        },
      }),
    )).toThrow(
      "RunStopReviewLimits.maxRequiredFeedbackRounds must be a non-negative safe integer",
    );

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: {
          policySnapshotId: "policy-1",
          securityContext: {
            workspace: canonicalWorkspace(),
            actor: { identityId: "user_001", kind: "user" },
            environment: canonicalEnvironment(),
          },
          enforcement: "disabled",
          metadata: {},
        },
      }),
    )).toThrow("must be configured together");
  });

  it("rejects hard model metering when the Controller path cannot measure it", async () => {
    const operations = createOperationFixture([]);
    const metering = {
      modelInputTokens: "unavailable" as const,
      modelOutputTokens: "unavailable" as const,
      costUnits: "unavailable" as const,
    };
    const runner = createRunner(new ScriptedController([complete("unused")], metering), operations);

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    )).toThrow("Hard Run Tree modelInputTokens enforcement");

    const observationalResources = Object.freeze(Object.fromEntries(
      Object.entries(testRunTreeResources()).map(([dimension, limit]) => [
        dimension,
        dimension === "modelInputTokens" || dimension === "modelOutputTokens" ||
            dimension === "costUnits"
          ? Object.freeze({
              enforcement: "observational" as const,
              threshold: limit.enforcement === "hard" ? limit.maximum : limit.threshold,
            })
          : limit,
      ]),
    )) as RootRunConfig["runTreeResources"];
    const result = await createRunner(
      new ScriptedController([complete("observed")], metering),
      operations,
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { runTreeResources: observationalResources }),
    );
    expect(result).toMatchObject({ status: "succeeded", finalOutput: { summary: "observed" } });
  });

  it("fails before the first Controller turn when initial Context exceeds the tree envelope", async () => {
    const operations = createOperationFixture([]);
    const resources = Object.freeze({
      ...testRunTreeResources(),
      contextBytes: Object.freeze({
        enforcement: "hard" as const,
        maximum: 1,
        minimumChildGrant: 1,
      }),
    });
    const controller = new ScriptedController([complete("must not run")]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { runTreeResources: resources }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_limit_exceeded",
      failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "contextBytes" },
        },
      },
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("accounts Context Contributions admitted after Run initialization", async () => {
    const operations = createOperationFixture([]);
    const input = createRunInput();
    const initialContextBytes = new TextEncoder().encode(JSON.stringify({
      task: input.task,
      items: input.items,
    })).byteLength;
    const resources = Object.freeze({
      ...testRunTreeResources(),
      contextBytes: Object.freeze({
        maximum: initialContextBytes,
        enforcement: "hard" as const,
        minimumChildGrant: 1,
      }),
    });
    const controller = new ScriptedController([complete("must not run")]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      input,
      createRunConfig(operations, { runTreeResources: resources }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_limit_exceeded",
      failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "contextBytes" },
        },
      },
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("cannot report success when the terminal result exceeds the tree envelope", async () => {
    const operations = createOperationFixture([]);
    const resources = Object.freeze({
      ...testRunTreeResources(),
      resultBytes: Object.freeze({
        enforcement: "hard" as const,
        maximum: 1,
        minimumChildGrant: 1,
      }),
    });

    const result = await createRunner(
      new ScriptedController([complete("result exceeds one byte")]),
      operations,
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { runTreeResources: resources }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_limit_exceeded",
      failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "resultBytes" },
        },
      },
    });
  });
});

interface OperationSpec {
  readonly ref: OperationRevisionRef;
  readonly kind: OperationBindingKind;
  readonly requestOrigins: readonly OperationRequestOrigin[];
  readonly handlerId?: string;
  readonly actionAdapterId?: string;
  readonly hostedEndpointRef?: string;
  readonly compositeDefinitionRef?: string;
  readonly agentRef?: AgentRevisionRef;
}

interface OperationFixture extends RunnerOperationComposition {
  readonly specs: readonly OperationSpec[];
}

function operationSpec(
  ref: OperationRevisionRef,
  kind: OperationBindingKind,
  options: Omit<OperationSpec, "ref" | "kind">,
): OperationSpec {
  return { ref, kind, ...options };
}

function createOperationFixture(
  specs: readonly OperationSpec[],
  internalHandlers: readonly InternalOperationHandler[] = [],
  extensions: Partial<Pick<RunnerOperationComposition, "composite" | "delegation" | "actionExecution" | "availability">> = {},
): OperationFixture {
  const catalog = createOperationCatalogSnapshot({
    id: "operation-catalog-1",
    revision: "1",
    entries: specs.map((spec) => ({
      admissionId: `operation-admission-${spec.ref.operation.name}`,
      operation: {
        ref: spec.ref,
        semanticOwner: spec.kind === "descendant_agent" ? "code-agent" : "code-workspace",
        requestSchemaRevision: "request-1",
        resultSchemaRevision: "result-1",
        roles: {
          requestOrigins: spec.requestOrigins,
          exposure: spec.requestOrigins.includes("tool_request") ? "eager_tool" : "non_tool",
          runControl: spec.kind,
          trust: spec.kind === "direct" || spec.kind === "hosted"
            ? "canonical_external_effect"
            : "effect_free",
          participation: spec.kind === "composite"
            ? "composite_coordinator"
            : spec.kind === "descendant_agent"
              ? "descendant_adapter"
              : "semantic_owner",
          domainPurpose: `test.${spec.ref.operation.name}`,
        },
      },
      binding: {
        ref: { operation: spec.ref, revision: "binding-1" },
        kind: spec.kind,
        resolverId: `resolver.${spec.ref.operation.name}`,
        resolverRevision: "1",
      },
      sourceRevision: "source-1",
      allowedRequestOrigins: spec.requestOrigins,
      admittedAt: NOW,
      retirement: null,
    })),
  });
  const bindings = createOperationBindingResolverSnapshot(
    "bindings-1",
    specs.map((spec) => ({
      resolver: {
        id: `resolver.${spec.ref.operation.name}`,
        revision: "1",
        async resolve(input: OperationBindingResolutionInput<unknown, unknown>) {
          return {
            status: "resolved" as const,
            binding: snapshotResolvedOperationBinding(
              resolvedBinding(spec, input),
              snapshotUnknown,
            ),
          };
        },
      },
    })),
  );
  return Object.freeze({
    specs: Object.freeze([...specs]),
    catalog,
    bindings,
    validateToolInput: () => true,
    internalHandlers: Object.freeze([...internalHandlers]),
    availability: extensions.availability ?? Object.freeze(
      catalog.entries.map((entry) =>
        createStaticOperationToolAvailabilityParticipant(entry.binding.ref, "test")
      ),
    ),
    ...(extensions.composite === undefined ? {} : { composite: extensions.composite }),
    ...(extensions.actionExecution === undefined ? {} : { actionExecution: extensions.actionExecution }),
    ...(extensions.delegation === undefined ? {} : { delegation: extensions.delegation }),
  });
}

function createTestDelegation(
  agent: Agent<TestOutput>,
  options: {
    readonly mandatoryUnsupportedContext?: boolean;
    readonly narrowToolAuthority?: boolean;
    readonly partialSummary?: string;
  } = {},
): RunnerDelegationComposition {
  return Object.freeze({
    preparation: Object.freeze({
      assessAvailability(input) {
        const admitted = input.targetAgent.id === agent.id &&
          input.targetAgent.revision === agent.revision;
        return Object.freeze({
          basisRefs: Object.freeze([Object.freeze({
            owner: "test",
            kind: "descendant_agent_admission",
            id: `${agent.id}@${agent.revision}`,
            revision: admitted ? "admitted" : "not_admitted",
          })]),
          disposition: admitted ? "available" as const : "unavailable" as const,
          reason: admitted ? null : "no_eligible_subject" as const,
        });
      },
      async prepare(input) {
        if (input.targetAgent.id !== agent.id ||
            input.targetAgent.revision !== agent.revision) {
          throw new TypeError("Test descendant Agent is not admitted.");
        }
        const candidate = input.toolCall.input as {
          readonly prompt?: unknown;
          readonly dependency_result?: unknown;
          readonly replaced_result?: unknown;
        };
        if (typeof candidate.prompt !== "string" || candidate.prompt.length === 0) {
          throw new TypeError("Test delegation requires a prompt.");
        }
        const dependencyResult = candidate.dependency_result === undefined
          ? null
          : testDelegationResultRef(candidate.dependency_result);
        const replacedResult = candidate.replaced_result === undefined
          ? null
          : testDelegationResultRef(candidate.replaced_result);
        const limits = createDelegationLimits({
          maxControllerTurns: input.limitCeiling.maxControllerTurns,
          maxActions: input.limitCeiling.maxActions,
          maxDurationMs: input.limitCeiling.maxDurationMs,
          maxContextBytes: input.limitCeiling.maxContextBytes,
          maxResultBytes: input.limitCeiling.maxResultBytes,
          maxModelInputTokens: input.limitCeiling.maxModelInputTokens,
          maxModelOutputTokens: input.limitCeiling.maxModelOutputTokens,
          maxCostUnits: input.limitCeiling.maxCostUnits,
        });
        return Object.freeze({
          agent,
          contextMaterials: Object.freeze([]),
          preparation: Object.freeze({
            schemaVersion: 1 as const,
            childAgent: Object.freeze({ id: agent.id, revision: agent.revision }),
            task: Object.freeze({
              kind: "test.delegated",
              input: Object.freeze({ prompt: candidate.prompt }),
              metadata: Object.freeze({ product: "test" }),
            }),
            objective: Object.freeze({
              text: candidate.prompt,
              constraints: Object.freeze([]),
            }),
            expectedResult: createDelegationResultExpectation({
              requirements: Object.freeze([Object.freeze({
                form: "narrative" as const,
                required: true,
                maxItems: 1,
              })]),
              maxNarrativeCharacters: 4_096,
            }),
            contextPlan: createDelegationContextPlan({
              entries: Object.freeze([
                ...(options.mandatoryUnsupportedContext
                  ? [Object.freeze({
                      role: "parent_fact" as const,
                      material: Object.freeze({
                        owner: "test",
                        kind: "parent_fact",
                        id: "unavailable-parent-fact",
                        revision: "1",
                      }),
                      necessity: "mandatory" as const,
                    })]
                  : []),
              ]),
              maxContextBytes: limits.maxContextBytes,
            }),
            authorityRestriction: options.narrowToolAuthority
              ? Object.freeze(input.authorityCeiling.map((dimension) =>
                  Object.freeze({
                    kind: dimension.kind,
                    allowed: Object.freeze(
                      dimension.kind === "tool"
                        ? dimension.allowed.slice(0, 1)
                        : [...dimension.allowed],
                    ),
                    required: Object.freeze([...dimension.required]),
                  })))
              : null,
            allocationRequest: limits,
            dependencyResult,
            replacedResult,
          }),
        });
      },
    }),
    continuation: Object.freeze({
      async prepare(input) {
        if (
          input.targetAgent.id !== agent.id ||
          input.targetAgent.revision !== agent.revision
        ) {
          throw new TypeError("Test descendant continuation is not admitted.");
        }
        const limits = createDelegationLimits({
          maxControllerTurns: input.limitCeiling.maxControllerTurns,
          maxActions: input.limitCeiling.maxActions,
          maxDurationMs: input.limitCeiling.maxDurationMs,
          maxContextBytes: input.limitCeiling.maxContextBytes,
          maxResultBytes: input.limitCeiling.maxResultBytes,
          maxModelInputTokens: input.limitCeiling.maxModelInputTokens,
          maxModelOutputTokens: input.limitCeiling.maxModelOutputTokens,
          maxCostUnits: input.limitCeiling.maxCostUnits,
        });
        return Object.freeze({
          agent,
          contextMaterials: Object.freeze([]),
          preparation: Object.freeze({
            schemaVersion: 1 as const,
            childAgent: Object.freeze({ id: agent.id, revision: agent.revision }),
            task: input.sourceRequest.task,
            objective: input.sourceRequest.objective,
            expectedResult: input.sourceRequest.expectedResult,
            contextPlan: createDelegationContextPlan({
              entries: Object.freeze([]),
              maxContextBytes: limits.maxContextBytes,
            }),
            authorityRestriction: null,
            allocationRequest: limits,
            dependencyResult: null,
            replacedResult: null,
          }),
        });
      },
    }),
    narrativeProjection: Object.freeze({
      project({ childResult }) {
        const finalOutput = childResult.finalOutput;
        if (
          finalOutput !== null &&
          typeof finalOutput === "object" &&
          !Array.isArray(finalOutput) &&
          typeof (finalOutput as { readonly summary?: unknown }).summary === "string"
        ) {
          return (finalOutput as { readonly summary: string }).summary;
        }
        return null;
      },
    }),
    resultProjection: Object.freeze({
      project(result) {
        const output = Object.freeze({
          summary: result.narrative?.text ?? "",
          result_ref: Object.freeze({
            kind: "delegation_result" as const,
            id: result.ref.id,
            revision: result.ref.revision,
          }),
        });
        if (
          result.terminal.status === "succeeded" &&
          result.narrative?.text === options.partialSummary
        ) {
          return Object.freeze({
            status: "partial" as const,
            output,
            failure: operationFailure("agent-runtime", "descendant_partial"),
          });
        }
        return result.terminal.status === "succeeded"
          ? Object.freeze({
              status: "succeeded" as const,
              output,
              failure: null,
            })
          : Object.freeze({
              status: "failed" as const,
              output: null,
              failure: operationFailure("agent-runtime", "descendant_failed"),
            });
      },
    }),
  });
}

type TestDelegationResultRef = Readonly<{
  readonly kind: "delegation_result";
  readonly id: string;
  readonly revision: string;
}>;

function projectedDelegationResultRef(input: unknown): TestDelegationResultRef {
  if (!isRecord(input) || !isRecord(input.result_ref)) {
    throw new TypeError("Projected descendant output must contain result_ref.");
  }
  const ref = input.result_ref;
  if (
    Object.keys(ref).some((key) => key !== "kind" && key !== "id" && key !== "revision") ||
    ref.kind !== "delegation_result" ||
    typeof ref.id !== "string" || ref.id.length === 0 ||
    typeof ref.revision !== "string" || ref.revision.length === 0
  ) {
    throw new TypeError("Projected descendant result_ref is invalid.");
  }
  return Object.freeze({
    kind: "delegation_result",
    id: ref.id,
    revision: ref.revision,
  });
}

function testDelegationResultRef(
  input: unknown,
): Readonly<{ readonly id: string; readonly revision: string }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Test delegation source result must be an object.");
  }
  const ref = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(ref).some((key) => key !== "kind" && key !== "id" && key !== "revision") ||
    ref.kind !== "delegation_result" ||
    typeof ref.id !== "string" || ref.id.length === 0 ||
    typeof ref.revision !== "string" || ref.revision.length === 0
  ) {
    throw new TypeError("Test delegation source result ref is invalid.");
  }
  return Object.freeze({ id: ref.id, revision: ref.revision });
}

function createVerificationActionExecutionFixture(
  operation: OperationRevisionRef,
  physicalOutcome: PhysicalAttemptOutcome<{ passed: boolean }> = {
    status: "completed",
    effectState: "settled",
    payload: { passed: true },
  },
) {
  const adapterDescriptor: ActionAdapterDescriptor = {
    id: `adapter.${operation.operation.name}`,
    version: "1",
    requestSchemaRevision: "request-1",
  };
  const executorDescriptor: ActionExecutorDescriptor = {
    id: `executor.${operation.operation.name}`,
    version: "1",
    invocationContractVersion: "1",
    physicalPayloadSchemaRevision: "payload-1",
  };
  const registrations = createActionRegistrationSnapshot([{
    registrationId: `action-registration.${operation.operation.name}`,
    revision: "1",
    operation,
    binding: { operation, revision: "binding-1" },
    adapter: adapterDescriptor,
    executor: executorDescriptor,
    effectFamilies: ["filesystem"],
    sandboxRequirementRevision: "sandbox-requirement-1",
    maxInvocationBytes: 64 * 1024,
    maxPhysicalResultBytes: 64 * 1024,
  }]);
  const adapter: OperationActionAdapter = {
    descriptor: adapterDescriptor,
    async prepare(resolved, context) {
      return {
        status: "prepared" as const,
        prepared: await createPreparedAction(resolved, context, {
          effectSet: {
            kind: "effects",
            values: [{
              kind: "file_system",
              operation: "read",
              targets: [{
                platform: "win32",
                path: "D:/workspace/README.md",
                resolvedPath: "D:/workspace/README.md",
                workspaceRootId: "workspace_001",
                resolutionFingerprint: SHA_A,
              }],
            }],
          },
          requestedAuthority: null,
          targetAssertions: [],
          approval: null,
          safeSummary: {
            kind: "file_system",
            headline: "Validate workspace state",
            operations: [{
              operation: "read",
              sourceLabel: "README.md",
              destinationLabel: null,
            }],
          },
          preparedInvocation: {
            contractVersion: "1",
            executorId: executorDescriptor.id,
            executorVersion: executorDescriptor.version,
            payload: { target: "D:/workspace/README.md" },
          },
          replayBasis: "none",
          semanticBasis: { operation: "verification-read" },
        }),
      };
    },
    async revalidate() {
      return { status: "valid" as const, recordId: "verification-revalidation-1" };
    },
    async settle(_prepared, settlement) {
      const succeeded = settlement.status === "succeeded";
      return {
        operationInvocationId: settlement.operationInvocation.id,
        settlement,
        status: succeeded
          ? "succeeded" as const
          : settlement.status === "unknown_effect"
            ? "unknown_effect" as const
            : settlement.status === "denied"
              ? "denied" as const
              : "failed" as const,
        output: succeeded ? settlement.payload : null,
        failure: succeeded
          ? null
          : {
              owner: settlement.causeOwner ?? "action-execution",
              code: settlement.causeRef ?? settlement.status,
              message: settlement.causeRef ?? settlement.status,
            },
      };
    },
  };
  const execute = vi.fn(async () => physicalOutcome);
  const dependencies: NonNullable<RunnerOperationComposition["actionExecution"]> = {
    registrations,
    adapters: [{ adapter }],
    policy: createAllowAllActionPolicyPort(() => NOW),
    sandbox: createSandboxExecutionGateway({
      executors: [{
        descriptor: executorDescriptor,
        validatePayload(candidate): candidate is { passed: boolean } {
          return typeof candidate === "object" && candidate !== null &&
            "passed" in candidate && typeof candidate.passed === "boolean";
        },
        execute,
      }],
    }),
    records: {
      async recordPreEffect() {
        return { recordId: "verification-pre-effect-1" };
      },
      async recordPostEffect() {
        return { recordId: "verification-post-effect-1" };
      },
    },
    retry: {
      async decide() {
        return { status: "stop" as const, code: "verification_action_retry_disabled" };
      },
      async wait() {
        return "elapsed" as const;
      },
    },
    now: () => NOW,
  };
  return Object.freeze({ adapterId: adapterDescriptor.id, dependencies, execute });
}

function createVerificationActionExecutionConfig(): NonNullable<RunConfig["actionExecution"]> {
  return Object.freeze({
    policySnapshotId: "policy-1",
    securityContext: Object.freeze({
      workspace: canonicalWorkspace(),
      actor: Object.freeze({ identityId: "user_001", kind: "user" as const }),
      environment: canonicalEnvironment(),
    }),
    enforcement: "disabled" as const,
    metadata: Object.freeze({}),
  });
}

function resolvedBinding(
  spec: OperationSpec,
  input: OperationBindingResolutionInput<unknown, unknown>,
): ResolvedOperationBinding {
  const base = {
    invocation: input.context.invocation,
    correlation: input.context.correlation,
    parentInvocation: input.context.parentInvocation,
    binding: input.registration.binding.ref,
    request: input.request,
    resolverRevision: "1",
    resolutionFingerprint: `resolution-${spec.ref.operation.name}`,
  };
  switch (spec.kind) {
    case "internal":
      return { ...base, kind: "internal", handlerId: spec.handlerId! };
    case "direct":
      return { ...base, kind: "direct", actionAdapterId: spec.actionAdapterId! };
    case "hosted":
      return {
        ...base,
        kind: "hosted",
        actionAdapterId: spec.actionAdapterId!,
        hostedEndpointRef: spec.hostedEndpointRef!,
      };
    case "composite":
      return {
        ...base,
        kind: "composite",
        compositeDefinitionRef: spec.compositeDefinitionRef!,
      };
    case "descendant_agent":
      return { ...base, kind: "descendant_agent", agentRef: spec.agentRef! };
  }
}

function internalHandler(
  id: string,
  semanticOwner: string,
  output: unknown,
  lowerRefs: OperationResult["lowerRefs"] = [],
): InternalOperationHandler & { readonly execute: ReturnType<typeof vi.fn> } {
  return {
    id,
    execute: vi.fn(async (context) => createOperationResult({
      ref: {
        invocation: context.binding.invocation,
        id: `${context.binding.invocation.id}:result`,
      },
      binding: context.binding.binding,
      semanticOwner,
      status: "succeeded",
      output,
      failure: null,
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs,
      metadata: {},
    })),
  };
}

function createToolSelection(
  operations: OperationFixture,
  operation: OperationRevisionRef,
  name: string,
  origin: "model" | "workflow" = "model",
) {
  const keyName = operation.operation.name;
  const registration: ToolRegistrationInput = {
    admissionId: `tool-admission-${keyName}`,
    descriptor: {
      ref: { tool: { namespace: "code-agent", name: keyName }, revision: "1" },
      name,
      description: `Test Tool ${name}.`,
      inputSchema: { type: "object" },
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "input-1",
        output: null,
        translation: "native-1",
      },
      source: {
        kind: "product",
        sourceId: "helarc-code-agent",
        sourceRevision: "1",
        activationEpoch: null,
      },
      binding: { kind: "operation", operation, revision: "binding-1" },
    },
    allowedOrigins: [origin],
    admittedAt: NOW,
  };
  const registrations = createToolRegistrationSnapshot(operations.catalog, [registration]);
  return createFixedLocalToolSelection(registrations, operations.catalog, [{
    tool: registration.descriptor.ref,
    origins: [origin],
  }]);
}

function createSemanticToolSelection(
  operations: OperationFixture,
  name: string,
  binding: Exclude<ToolBindingRef, { readonly kind: "operation" }>,
) {
  return createSemanticToolSelectionSet(operations, [{ name, binding }]);
}

function createSemanticToolSelectionSet(
  operations: OperationFixture,
  entries: readonly {
    readonly name: string;
    readonly binding: Exclude<ToolBindingRef, { readonly kind: "operation" }>;
  }[],
) {
  const registrationsInput: ToolRegistrationInput[] = entries.map(({ name, binding }) => {
    const toolName = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    return {
      admissionId: `tool-admission-${toolName}`,
      descriptor: {
        ref: { tool: { namespace: "code-agent", name: toolName }, revision: "1" },
        name,
        description: `Test Tool ${name}.`,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        schemaRevisions: {
          dialect: "json-schema-2020-12",
          input: "input-1",
          output: "output-1",
          translation: "native-1",
        },
        source: {
          kind: "product",
          sourceId: "helarc-code-agent",
          sourceRevision: "1",
          activationEpoch: null,
        },
        binding,
      },
      allowedOrigins: ["model"],
      admittedAt: NOW,
    };
  });
  const registrations = createToolRegistrationSnapshot(
    operations.catalog,
    registrationsInput,
  );
  return createFixedLocalToolSelection(
    registrations,
    operations.catalog,
    registrationsInput.map((registration) => ({
      tool: registration.descriptor.ref,
      origins: ["model"],
    })),
  );
}

function emptyToolSelection(operations: OperationFixture) {
  const registrations = createToolRegistrationSnapshot(operations.catalog, []);
  return createFixedLocalToolSelection(registrations, operations.catalog, []);
}

function createRunner(
  controller: Controller<TestOutput>,
  operations: OperationFixture,
  overrides: Partial<RunnerDependencies> = {},
): Runner {
  let runSequence = 0;
  return new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    operations,
    completion: {
      taskFulfillment: createFulfilledTaskEvaluator(),
      maximumDurationMs: 5_000,
    },
    verification: createTestVerificationComposition(),
    interactions: createInteractionProtocolRegistrySnapshot("interaction-registry-1", []),
    now: () => NOW,
    createRunId: () => `run_${String(++runSequence).padStart(3, "0")}`,
    ...overrides,
  });
}

function createFulfilledTaskEvaluator(): TaskFulfillmentEvaluatorPort {
  const ref = Object.freeze({ owner: "test-product", id: "test-task-fulfillment", revision: "1" });
  return Object.freeze({
    ref,
    async evaluate(input: TaskFulfillmentEvaluationInput) {
      return createTaskAssessmentResult(input, ref, "fulfilled");
    },
  });
}

function createTaskAssessmentResult(
  input: TaskFulfillmentEvaluationInput,
  evaluator: TaskFulfillmentEvaluatorPort["ref"],
  status: "fulfilled" | "incomplete" | "uncertain",
) {
  const fulfilled = status === "fulfilled";
  return Object.freeze({
    kind: "assessed" as const,
    assessment: Object.freeze({
      ref: input.assessment,
      evaluator,
      run: input.run,
      turn: input.turn,
      objective: input.objective,
      proposal: input.proposal,
      status,
      rationale: fulfilled
        ? "The scripted test evaluator accepts the completion proposal."
        : "The scripted test evaluator found a requested outcome missing.",
      findings: fulfilled
        ? Object.freeze([])
        : Object.freeze([Object.freeze({
            kind: status === "incomplete" ? "missing_outcome" as const : "uncertainty" as const,
            code: status === "incomplete" ? "task_outcome_missing" : "task_fulfillment_uncertain",
            message: "Continue from the original Task objective.",
          })]),
      feedback: fulfilled
        ? null
        : "The original Task is not yet fulfilled. Continue from its requested outcomes.",
      assessedAt: NOW,
    }),
  });
}

function createAgent(
  id = "agent_001",
  revision = "1",
  name = "Test Agent",
): Agent<TestOutput> {
  return {
    id,
    revision,
    name,
    instructions: testAgentInstructions(id),
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
        return { valid: false, message: "Output requires a summary." };
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

function createRunInput(
  taskId = "task_001",
  taskInput: unknown = {},
): RunInput {
  return {
    task: {
      id: taskId,
      kind: "test.runner",
      input: taskInput,
      createdAt: NOW,
      metadata: {},
    },
    items: [{
      id: `${taskId}:message`,
      kind: "message",
      role: "user",
      content: "Complete the task.",
      createdAt: NOW,
      metadata: {},
    }],
    metadata: {},
  };
}

function createRunConfig(
  operations: OperationFixture,
  overrides: {
    readonly tools?: RunConfig["tools"];
    readonly actionExecution?: RunConfig["actionExecution"];
    readonly verification?: RunConfig["verification"];
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
    readonly runTreeLimits?: Partial<RootRunConfig["runTreeLimits"]>;
    readonly runTreeResources?: RootRunConfig["runTreeResources"];
  } = {},
): RootRunConfig {
  return {
    workspace: {
      primary: {
        id: "workspace_001",
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
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    permissions: createTestPermissionConfig(),
    tools: overrides.tools ?? emptyToolSelection(operations),
    actionExecution: overrides.actionExecution ?? null,
    verification: overrides.verification ?? createTestVerificationConfig(),
    limits: {
      maxIterations: 12,
      maxActions: 24,
      maxConsecutiveActionFailures: 4,
      maxDurationMs: 10_000,
      maxPendingInteractions: 4,
      plan: {
        maxSteps: 8,
        maxStepLength: 200,
        maxExplanationLength: 500,
      },
      stopReview: {
        maxRequiredFeedbackRounds: 2,
        maxAdvisoryFeedbackRounds: 1,
      },
      ...overrides.limits,
    },
    runTreeLimits: {
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 4,
      maxDescendantDepth: 2,
      ...overrides.runTreeLimits,
    },
    runTreeResources: overrides.runTreeResources ?? testRunTreeResources(),
    runTreeApprovals: testRunTreeApprovals(),
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

function testRunTreeResources(): RootRunConfig["runTreeResources"] {
  return Object.freeze({
    controllerTurns: Object.freeze({ maximum: 256, minimumChildGrant: 1, enforcement: "hard" as const }),
    actions: Object.freeze({ maximum: 256, minimumChildGrant: 1, enforcement: "hard" as const }),
    modelInputTokens: Object.freeze({ maximum: 1_000_000, minimumChildGrant: 1, enforcement: "hard" as const }),
    modelOutputTokens: Object.freeze({ maximum: 250_000, minimumChildGrant: 1, enforcement: "hard" as const }),
    costUnits: Object.freeze({ maximum: 1_000_000, minimumChildGrant: 1, enforcement: "hard" as const }),
    contextBytes: Object.freeze({ maximum: 8_000_000, minimumChildGrant: 1, enforcement: "hard" as const }),
    resultBytes: Object.freeze({ maximum: 2_000_000, minimumChildGrant: 1, enforcement: "hard" as const }),
  });
}

function testRunTreeApprovals(): RootRunConfig["runTreeApprovals"] {
  return Object.freeze({
    maxTotalRequests: 16,
    maxRequestsPerOperationFingerprint: 4,
    maxConsecutiveDeclines: 3,
    maxConsecutiveReviewerFailures: 3,
    maxActiveReviews: 4,
  });
}

function createTestVerificationComposition(): RunnerDependencies["verification"] {
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
    owner: "test-runtime",
    kind: "verification",
    id,
    revision: "1",
  });
  return Object.freeze({
    profile: Object.freeze({
      ref: owner("empty-profile"),
      specification: Object.freeze({ id: "empty-specification", revision: "1" }),
      source: Object.freeze({
        ...owner("empty-profile-source"),
        sourceKind: "run_invocation" as const,
      }),
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

function createMandatoryVerificationConfig(
  disposition: "continue" | "wait" | "block" | "fail",
): RunConfig["verification"] {
  const base = createTestVerificationConfig();
  const source = Object.freeze({
    owner: "test-runtime",
    kind: "verification",
    id: "mandatory-source",
    revision: "1",
    sourceKind: "run_invocation" as const,
  });
  return Object.freeze({
    ...base,
    profile: Object.freeze({
      ...base.profile,
      ref: Object.freeze({ ...base.profile.ref, id: "mandatory-profile" }),
      specification: Object.freeze({ id: "mandatory-specification", revision: "1" }),
      source,
      requirements: Object.freeze([Object.freeze({
        ref: Object.freeze({ id: "mandatory-requirement", revision: "1" }),
        source,
        kind: "test",
        claim: "The required Verification claim is satisfied.",
        purpose: "Protect successful completion.",
        necessity: "mandatory" as const,
        subjectKinds: Object.freeze(["test_subject"]),
        checkFamilies: Object.freeze(["test_check"]),
        assessmentMethod: Object.freeze({
          owner: "test-runtime", kind: "assessment_method", id: "test-method", revision: "1",
        }),
        freshness: Object.freeze({ required: true, maximumAgeMs: null }),
        coverage: Object.freeze({ kind: "complete" as const, minimumRatio: 1 }),
        evidence: Object.freeze({
          minimumAdmittedCount: 1,
          acceptedSourceKinds: Object.freeze(["check_result"]),
          conflictingEvidence: "inconclusive" as const,
        }),
        limits: Object.freeze({ maximumAttempts: 1, maximumDurationMs: 1_000, maximumCostUnits: null }),
        disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze(["runner"]) }),
        completionHandling: Object.freeze({
          unassessed: disposition,
          pending: disposition,
          violated: disposition,
          inconclusive: disposition,
          stale: disposition,
        }),
      })]),
    }),
  });
}

type VerificationScenario =
  | { readonly kind: "pure_automatic"; readonly stale?: boolean }
  | {
      readonly kind: "pure_pending";
      readonly settlement: Promise<VerificationCheckInterpretation>;
      readonly onProcessed: (error: unknown | null) => void;
    }
  | { readonly kind: "effectful_automatic"; readonly operation: OperationRevisionRef }
  | { readonly kind: "controller"; readonly operation: OperationRevisionRef };

function createVerificationScenario(input: VerificationScenario): RunnerDependencies["verification"] {
  const requirement = Object.freeze({ id: "mandatory-requirement", revision: "1" });
  const subjectRef = Object.freeze({ id: "verification-subject", revision: "1" });
  const adapter = verificationOwner("verification-subject-adapter", "subject_adapter");
  const evaluator = verificationOwner("verification-pure-evaluator", "check_evaluator");
  const interpreter = verificationOwner("verification-result-interpreter", "result_interpreter");
  const assessmentMethod = verificationOwner("test-method", "assessment_method");
  const definition = verificationScenarioDefinition(input, evaluator, interpreter);
  let identitySequence = 0;
  let capturedSubject: VerificationSubjectSnapshot | null = null;
  const executionFactory = new DefaultVerificationExecutionFactory({
    clock: { now: () => NOW },
    identities: { nextId: (kind) => `${kind}-${++identitySequence}` },
    subjectAdapters: {
      resolve: (ref) => ref.id === adapter.id ? {
        ref: adapter,
        subjectKinds: ["test_subject"],
        async capture({ run }) {
          capturedSubject = Object.freeze({
            ref: subjectRef,
            run,
            owner: "test-runtime",
            kind: "test_subject",
            stateRefs: Object.freeze([verificationOwner("mandatory-source")]),
            capturedAt: NOW,
            environment: null,
            scope: Object.freeze([{ key: "workspace", value: "workspace_001" }]),
            coverage: Object.freeze({ kind: "complete" as const, ratio: 1 }),
            fingerprint: Object.freeze({
              algorithm: "sha256",
              value: "verification-subject-v1",
              basis: "test workspace state",
            }),
            sensitivity: "internal" as const,
            audiences: Object.freeze(["verification"]),
            adapter,
          });
          return { status: "captured" as const, snapshot: capturedSubject };
        },
        async rehydrate() {
          return capturedSubject === null
            ? {
                status: "unavailable" as const,
                failure: createVerificationFailure({
                  code: "verification_subject_not_captured",
                  stage: "subject",
                  message: "Verification subject has not been captured.",
                  retryable: false,
                  cause: adapter,
                }),
              }
            : { status: "captured" as const, snapshot: capturedSubject };
        },
      } : null,
    },
    subjectFreshness: {
      resolve: () => ({
        checkFreshness: async () => input.kind === "pure_automatic" && input.stale === true
          ? {
              status: "stale" as const,
              snapshot: subjectRef,
              current: Object.freeze({ id: "verification-subject", revision: "2" }),
              change: verificationOwner("workspace-change", "subject_change"),
            }
          : { status: "current" as const, snapshot: subjectRef },
      }),
    },
    pureChecks: {
      resolve: (ref) => ref.id === evaluator.id ? {
        evaluate: async () => input.kind === "pure_pending"
          ? input.settlement
          : completedVerificationInterpretation(),
      } : null,
    },
    operationChecks: { resolve: () => null },
    interpreters: {
      resolve: (ref) => ref.id === interpreter.id ? {
        interpret: async () => completedVerificationInterpretation(),
      } : null,
    },
    assessmentMethods: {
      resolve: (ref) => ref.id === assessmentMethod.id ? {
        assess: async () => ({
          verdict: "satisfied" as const,
          basis: "The admitted Check Result satisfies the Requirement.",
          coverage: { ratio: 1, basis: "complete admitted Check Result" },
          limitations: [],
        }),
      } : null,
    },
  });
  const composition: RunnerDependencies["verification"] = {
    executionFactory,
    completionGate: new CurrentVerificationCompletionGate(() => NOW),
    settledOperationResults: null,
    checkResults: null,
    preparation: {
      async prepare({ execution, automaticEffectfulChecks }, interruption) {
        await execution.captureSubject({
          requirement,
          adapter,
          kind: "test_subject",
          requestedSource: verificationOwner("mandatory-source"),
          expectedRevision: await verificationRevision(execution),
        }, interruption);
        await execution.admitCheckDefinition({
          definition,
          expectedRevision: await verificationRevision(execution),
        }, interruption);
        if (input.kind === "controller") return;
        const checkRequest = {
          requirement,
          subject: subjectRef,
          definition: definition.ref,
          predecessor: null,
          environment: null,
          configuration: null,
          coverageTarget: 1,
        } as const;
        const resultPromise = input.kind === "effectful_automatic"
          ? automaticEffectfulChecks.execute(checkRequest, interruption)
          : execution.executeCheck({
              ...checkRequest,
              origin: "trusted_automatic",
              runAction: null,
              expectedRevision: await verificationRevision(execution),
            }, interruption);
        if (input.kind === "pure_pending") {
          await waitForVerificationState(execution, "pending");
          void resultPromise.then((result) =>
            admitVerificationResultAndAssess(execution, result, interruption)
          ).then(
            () => input.onProcessed(null),
            (error) => input.onProcessed(error),
          );
          return;
        }
        const result = await resultPromise;
        await admitVerificationResultAndAssess(execution, result, interruption);
        if (input.kind === "pure_automatic" && input.stale === true) {
          await execution.checkSubjectFreshness({
            requirement,
            snapshot: subjectRef,
            expectedRevision: await verificationRevision(execution),
          }, interruption);
        }
      },
    },
  };
  return input.kind !== "controller"
    ? Object.freeze(composition)
    : Object.freeze({
        ...composition,
        settledOperationResults: {
          async process(settled, interruption) {
            if (!sameOperationRef(settled.operation, input.operation)) return false;
            const request = Object.freeze({
              requirement,
              subject: subjectRef,
              definition: definition.ref,
              predecessor: null,
              environment: null,
              configuration: null,
              coverageTarget: 1,
            });
            const result = await settled.execution.interpretSettledOperationCheck({
              check: Object.freeze({
                ...request,
                origin: "controller" as const,
                runAction: settled.runAction,
                expectedRevision: await verificationRevision(settled.execution),
              }),
              settlement: settled.settlement,
            }, interruption);
            await admitVerificationResultAndAssess(
              settled.execution,
              result,
              interruption,
            );
            return true;
          },
        },
      });
}

function verificationScenarioDefinition(
  input: VerificationScenario,
  evaluator: VerificationOwnerRef,
  interpreter: VerificationOwnerRef,
): CheckDefinition {
  return Object.freeze({
    ref: Object.freeze({ id: "verification-check", revision: "1" }),
    owner: "test-runtime",
    family: "test_check",
    requirementKinds: Object.freeze(["test"]),
    subjectKinds: Object.freeze(["test_subject"]),
    acceptedOrigins: Object.freeze([
      input.kind === "controller" ? "controller" as const : "trusted_automatic" as const,
    ]),
    effect: input.kind === "pure_automatic" || input.kind === "pure_pending"
      ? Object.freeze({ kind: "pure" as const, evaluator, operationBinding: null })
      : Object.freeze({
          kind: "effectful" as const,
          evaluator: null,
          operationBinding: Object.freeze({
            operation: input.operation,
            revision: "binding-1",
          }),
        }),
    resultInterpreter: interpreter,
    environmentNeeds: Object.freeze([]),
    maximumDurationMs: 1_000,
    maximumAttempts: 1,
    maximumCostUnits: null,
    retryPolicy: "never",
    evidencePolicyRevision: "1",
  });
}

function completedVerificationInterpretation(): VerificationCheckInterpretation {
  return Object.freeze({
    status: "completed",
    findings: Object.freeze([Object.freeze({
      owner: "test-runtime",
      claim: "The required Verification Check completed successfully.",
      polarity: "supports" as const,
      severity: "info" as const,
      sourceRefs: Object.freeze([verificationOwner("check-output", "check_output")]),
      limitations: Object.freeze([]),
    })]),
    coverage: Object.freeze({ ratio: 1, basis: "complete test Check" }),
    costUnits: null,
    limitations: Object.freeze([]),
    failure: null,
  });
}

async function admitVerificationResultAndAssess(
  execution: VerificationExecutionPort,
  result: CheckResult,
  interruption: import("@agent-anything/agent-core/control").InvocationInterruptionContext,
): Promise<void> {
  if (result.status !== "completed" && result.status !== "partial") {
    throw new Error(`Test Verification Check did not produce eligible Evidence: ${JSON.stringify(result)}`);
  }
  const requirement = Object.freeze({ id: "mandatory-requirement", revision: "1" });
  const subject = Object.freeze({ id: "verification-subject", revision: "1" });
  const evidence = Object.freeze({ id: "verification-evidence", revision: "1" });
  await execution.admitEvidence({
    evidence: Object.freeze({
      ref: evidence,
      requirement,
      subject,
      source: Object.freeze({ kind: "check_result" as const, result: result.ref }),
      admission: Object.freeze({ status: "admitted" as const, failure: null }),
      coverage: result.coverage,
      sensitivity: "internal" as const,
      audiences: Object.freeze(["verification"]),
      limitations: result.limitations,
      createdAt: NOW,
    }),
    expectedRevision: await verificationRevision(execution),
  }, interruption);
  await execution.assessRequirement({
    requirement,
    subject,
    evidenceRefs: Object.freeze([evidence]),
    expectedRevision: await verificationRevision(execution),
  }, interruption);
}

async function verificationRevision(execution: VerificationExecutionPort): Promise<number> {
  return (await execution.readCurrentSnapshot()).ref.revision;
}

async function waitForVerificationState(
  execution: VerificationExecutionPort,
  status: "unassessed" | "pending" | "satisfied" | "violated" | "inconclusive" | "stale",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await execution.readCurrentSnapshot()).requirementStates[0]?.status === status) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for Verification state '${status}'.`);
}

function verificationOwner(id: string, kind = "verification"): VerificationOwnerRef {
  return Object.freeze({ owner: "test-runtime", kind, id, revision: "1" });
}

function sameOperationRef(left: OperationRevisionRef, right: OperationRevisionRef): boolean {
  return left.operation.namespace === right.operation.namespace &&
    left.operation.name === right.operation.name &&
    left.revision === right.revision;
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

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-managed",
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
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace_001", path: "D:/workspace" }],
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

function complete(summary: string, id = "model_complete_1"): ControllerDecision<TestOutput> {
  return {
    kind: "propose_completion",
    output: { summary },
    modelItems: modelTextItems(id, summary),
  };
}

function advance(
  candidates: readonly Readonly<Record<string, unknown>>[],
  modelCallIds: string | readonly string[],
): ControllerDecision<TestOutput> {
  const ids = typeof modelCallIds === "string" ? [modelCallIds] : [...modelCallIds];
  if (ids.length !== candidates.length || ids.length === 0) {
    throw new TypeError("Each scripted Controller candidate requires one Model Call id.");
  }
  const turnId = `${ids[0]}:turn`;
  const providerRequestId = `${ids[0]}:request`;
  const normalizedCandidates = candidates.map((candidate, ordinal) => ({
    ...candidate,
    modelCallRef: testModelCallRef(
      ids[ordinal]!,
      turnId,
      providerRequestId,
      ordinal,
    ),
  }));
  const calls = normalizedCandidates.map((candidate, ordinal) =>
    candidateModelToolCall(candidate, ordinal)
  );
  return {
    kind: "advance",
    candidates: normalizedCandidates as unknown as Extract<
      ControllerDecision<TestOutput>,
      { readonly kind: "advance" }
    >["candidates"],
    modelItems: createControllerModelItems({
      turnId,
      assistant: {
        role: "assistant",
        content: calls.map((call) => ({ kind: "model_tool_call" as const, call })),
      },
      finish: { kind: "normal" },
      usage: null,
      responseRef: {
        providerId: "scripted-controller",
        requestId: providerRequestId,
        responseId: `${turnId}:response`,
      },
    }),
  };
}

function operationCandidate(operation: OperationRevisionRef, request: unknown) {
  return {
    kind: "operation_request" as const,
    origin: "controller_protocol" as const,
    operation,
    request,
  };
}

function toolCandidate(
  name: string,
  input: unknown,
  controllerRequestId: string,
) {
  return {
    kind: "tool_request" as const,
    tool: {
      name,
      revision: "1",
      input,
      origin: "model" as const,
      controllerRequestId,
    },
  };
}

function modelTextItems(id: string, text: string) {
  return createControllerModelItems({
    turnId: `${id}:turn`,
    assistant: { role: "assistant", content: [{ kind: "text", text }] },
    finish: { kind: "normal" },
    usage: null,
    responseRef: {
      providerId: "scripted-controller",
      requestId: `${id}:request`,
      responseId: `${id}:response`,
    },
  });
}

function testModelCallRef(
  id: string,
  turnId: string,
  providerRequestId: string,
  ordinal: number,
): ModelCallRef {
  return Object.freeze({
    id,
    providerRequestId,
    controllerRequestId: `${turnId}:controller`,
    turnId,
    contentBlockOrdinal: ordinal,
    branchId: "run_001:main",
  });
}

function candidateModelToolCall(
  candidate: Readonly<Record<string, unknown>> & { readonly modelCallRef: ModelCallRef },
  ordinal: number,
): ModelToolCall {
  if (candidate.kind === "tool_request" && isRecord(candidate.tool)) {
    return scriptedModelToolCall(
      candidate.modelCallRef,
      String(candidate.tool.name),
      candidate.tool.input,
      ordinal,
    );
  }
  if (candidate.kind === "operation_request") {
    return scriptedModelToolCall(
      candidate.modelCallRef,
      "request_operation",
      { request: candidate.request as ModelJsonValue },
      ordinal,
    );
  }
  if (candidate.kind === "state_transition") {
    return scriptedModelToolCall(
      candidate.modelCallRef,
      candidate.transition === "plan_update" ? "update_plan" : "handoff",
      candidate.input,
      ordinal,
    );
  }
  if (candidate.kind === "interaction_request") {
    return scriptedModelToolCall(
      candidate.modelCallRef,
      "request_interaction",
      { subject: candidate.subject as ModelJsonValue },
      ordinal,
    );
  }
  throw new TypeError("Unsupported scripted Controller candidate.");
}

function scriptedModelToolCall(
  modelCallRef: ModelCallRef,
  name: string,
  input: unknown,
  ordinal: number,
): ModelToolCall {
  return Object.freeze({
    modelCallRef,
    providerCallRef: null,
    name,
    input: input as ModelToolCall["input"],
    ordinal,
  });
}

function operationRef(name: string): OperationRevisionRef {
  return { operation: { namespace: "test", name }, revision: "1" };
}

function testInteractionProtocol() {
  const ref: InteractionProtocolRef<"confirmation"> = Object.freeze({
    owner: "test-owner",
    kind: "confirmation",
    revision: "1",
  });
  const protocol = {
    ref,
    createRequest(input: any) {
      return snapshotInteractionRequest({
        ref: {
          id: input.requestId,
          protocol: ref,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        },
        subject: input.subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshotUnknown, snapshotUnknown);
    },
    validateSubmission(_request: unknown, candidate: unknown) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("accepted" in candidate) ||
        typeof candidate.accepted !== "boolean"
      ) throw new TypeError("Interaction submission requires accepted.");
      return Object.freeze({ accepted: candidate.accepted });
    },
    resolve({ submission }: any) {
      return submission;
    },
    apply({ resolution }: any) {
      return Object.freeze({ accepted: resolution.accepted });
    },
  };
  return {
    ref,
    registry: createInteractionProtocolRegistrySnapshot("test-interactions-1", [{
      ref,
      protocol,
    }]),
  };
}

function interactionCandidate(blockingScope: "none" | "branch" | "run") {
  return {
    kind: "interaction_request" as const,
    protocol: {
      owner: "test-owner",
      kind: "confirmation",
      revision: "1",
    },
    subject: { question: "Continue?" },
    subjectRef: {
      owner: "test-owner",
      kind: "confirmation-subject",
      id: "subject-1",
      revision: "1",
    },
    presentation: { title: "Continue" },
    requestVersion: 1,
    expiresAt: null,
    blockingScope,
  };
}

async function waitForPendingInteraction(handle: ReturnType<Runner["start"]>) {
  await waitUntil(() => handle.getSnapshot().pendingInteractions.length === 1);
  return handle.getSnapshot().pendingInteractions[0]!;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test state.");
}

function observations(result: Awaited<ReturnType<Runner["run"]>>) {
  return result.items.flatMap(({ payload }) =>
    payload.kind === "observation" ? [payload.observation] : []
  );
}

function operationFailure(owner: string, code: string) {
  return {
    owner,
    code,
    message: code,
    retryable: false,
    metadata: {},
  };
}

function snapshotUnknown<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function projectedObservations(
  projection: ControllerInput["context"],
): readonly RunObservation[] {
  return projection.blocks.flatMap((block) => {
    if (block.payload.kind !== "structured") return [];
    const value = block.payload.value;
    if (!isRecord(value) || value.kind !== "run_observation" || !isRecord(value.observation)) {
      return [];
    }
    return [value.observation as unknown as RunObservation];
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function eligibleGateDecision(input: CompletionGateInput) {
  return Object.freeze({
    invocation: input.invocation,
    verificationSnapshot: input.verificationSnapshot,
    status: "completion_eligible" as const,
    disposition: null,
    reasons: Object.freeze([]) as readonly [],
    failure: null,
    decidedAt: NOW,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalWorkspace() {
  return createCanonicalWorkspaceIdentity({
    workspaceId: "workspace_001",
    trustState: "trusted" as const,
    roots: [{
      rootId: "workspace_001",
      platform: "win32" as const,
      path: "D:/workspace",
      resolvedPath: "D:/workspace",
      resolutionFingerprint: SHA_A,
    }],
  });
}

function canonicalEnvironment() {
  return {
    environmentId: "test-local",
    platform: "win32" as const,
    configurationFingerprint: SHA_B,
  };
}

const NOW = "2026-08-13T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
