import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRevisionRef } from "@agent-anything/agent-core/agent";
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
import { createSandboxExecutionGateway } from "@agent-anything/action-execution/sandbox";
import type { ActionExecutionNotification } from "@agent-anything/action-execution/enforcement";
import { createAllowAllActionPolicyPort } from "@agent-anything/governance/policy";
import {
  createTestContextProjection,
  createTestValidationExecutionFactory,
} from "@agent-anything/test-support";
import {
  CurrentValidationCompletionGate,
  type CompletionGateInput,
  type CompletionGatePort,
} from "@agent-anything/validation/completion";
import {
  createValidationFailure,
  type ValidationOwnerRef,
} from "@agent-anything/validation/definition";
import {
  DefaultValidationExecutionFactory,
  type CheckDefinition,
  type CheckResult,
  type ValidationCheckInterpretation,
  type ValidationExecutionPort,
} from "@agent-anything/validation/execution";
import type { ValidationSubjectSnapshot } from "@agent-anything/validation/subject";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "../controller/index.js";
import type { RootRunConfig, RunConfig } from "./RunConfig.js";
import type {
  InternalOperationHandler,
  RunnerDependencies,
  RunnerOperationComposition,
} from "./RunnerDependencies.js";
import { Runner } from "./Runner.js";

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
  readonly calls: ControllerInput<TestOutput>[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

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

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_001", revision: "1" },
      status: "succeeded",
      finalOutput: { summary: "Done" },
    });
    expect(result.items.map(({ payload }) => payload.kind)).toEqual([
      "validation_feedback",
      "controller_turn",
      "validation_feedback",
      "terminal_transition",
    ]);
    expect(result.items.map(({ ref }) => ref.sequence)).toEqual([1, 2, 3, 4]);
    expect(controller.calls).toHaveLength(1);
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

    expect(result.status).toBe("succeeded");
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

    expect(result).toMatchObject({
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
      createRunConfig(operations, { validation: createMandatoryValidationConfig("block") }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "blocked",
      code: "validation_blocked",
    });
    expect(result.items.some((item) => item.payload.kind === "validation_feedback")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      name: "validation.gate.evaluated",
      payload: expect.objectContaining({ status: "blocked_unassessed", disposition: "block" }),
    }));
  });

  it("satisfies a mandatory Requirement through a pure automatic Check without fabricating action state", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const validation = createValidationScenario({ kind: "pure_automatic" });
    const result = await createRunner(
      new ScriptedController([complete("Validated")]),
      operations,
      {
        validation,
        runtimeEventPublisher: { publish: (event) => events.push(event) },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { validation: createMandatoryValidationConfig("block") }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(0);
    expect(observations(result)).toHaveLength(0);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "terminal_transition" && payload.status === "succeeded"))
      .toHaveLength(1);
    expect(events.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "validation.check.started",
      "validation.check.finished",
      "validation.assessment.committed",
      "validation.gate.evaluated",
    ]));
  });

  it("routes a trusted automatic effectful Check through one ordinary Operation RunAction", async () => {
    const operation = operationRef("validation-check");
    const actionExecution = createValidationActionExecutionFixture(operation);
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {
        requestOrigins: ["automatic_stage"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], { actionExecution: actionExecution.dependencies });
    const result = await createRunner(
      new ScriptedController([complete("Validated")]),
      operations,
      { validation: createValidationScenario({ kind: "effectful_automatic", operation }) },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createValidationActionExecutionConfig(),
        validation: createMandatoryValidationConfig("block"),
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
    const operation = operationRef("controller-validation-check");
    const actionExecution = createValidationActionExecutionFixture(operation);
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
      validation: createValidationScenario({ kind: "controller", operation }),
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createValidationActionExecutionConfig(),
        validation: createMandatoryValidationConfig("block"),
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
      name: "validation.check.started",
      payload: expect.objectContaining({ origin: "controller" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      name: "validation.gate.evaluated",
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
        validation: createValidationScenario({ kind: "pure_automatic", stale: true }),
        runtimeEventPublisher: { publish: (event) => events.push(event) },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { validation: createMandatoryValidationConfig("block") }),
    );

    expect(result).toMatchObject({ status: "blocked", code: "validation_blocked" });
    expect(events).toContainEqual(expect.objectContaining({
      name: "validation.gate.evaluated",
      payload: expect.objectContaining({ status: "blocked_stale", disposition: "block" }),
    }));
  });

  it("bounds repeated non-eligible completion proposals without bypassing the Completion Gate", async () => {
    const operations = createOperationFixture([]);
    const gate: CompletionGatePort = {
      async evaluate(input) {
        return {
          invocation: input.invocation,
          validationSnapshot: input.validationSnapshot,
          status: "blocked_unassessed",
          disposition: "continue",
          reasons: [{
            owner: "validation",
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
      complete("Not ready", "model_complete_2"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_progress_correction"
        )).toBe(true);
        return complete("Not ready", "model_complete_3");
      },
    ]);
    const result = await createRunner(controller, operations, {
      validation: {
        executionFactory: createTestValidationExecutionFactory({ now: () => NOW }),
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
          maxIterations: 3,
          progress: {
            checkpointWindowSize: 4,
            nonAdvancingCheckpointThreshold: 1,
            maxCorrectionRounds: 1,
          },
        },
      }),
    );

    expect(result).toMatchObject({ status: "blocked", code: "runtime_no_progress" });
    expect(controller.calls).toHaveLength(3);
    expect(result.items.filter(({ payload }) => payload.kind === "validation_feedback"))
      .toHaveLength(4);
    expect(result.items.at(-1)?.payload).toMatchObject({
      kind: "terminal_transition",
      status: "blocked",
      code: "runtime_no_progress",
    });
  });

  it("preserves a nested Validation Failure when Completion Gate execution fails", async () => {
    const operations = createOperationFixture([]);
    const gate: CompletionGatePort = {
      async evaluate(input) {
        return {
          invocation: input.invocation,
          validationSnapshot: input.validationSnapshot,
          status: "failed",
          disposition: "fail",
          reasons: [],
          failure: createValidationFailure({
            code: "validation_gate_provider_failed",
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
        validation: {
          executionFactory: createTestValidationExecutionFactory({ now: () => NOW }),
          completionGate: gate,
          preparation: null,
          settledOperationResults: null,
          checkResults: null,
        },
      },
    ).run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "failed",
      code: "validation_failed",
      failure: {
        kind: "validation",
        failure: { code: "validation_gate_provider_failed", stage: "completion_gate" },
      },
    });
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
        validation: {
          executionFactory: createTestValidationExecutionFactory({ now: () => NOW }),
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
        validation: {
          executionFactory: createTestValidationExecutionFactory({ now: () => NOW }),
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
    expect(events.filter((event) => event.name === "validation.gate.evaluated"))
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
      ["add"],
      ["add", "add"],
      ["replace"],
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
        modelItemId: "model_tool_1",
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
      descendants: {
        async prepare({ delegatedInput }) {
          return {
            agent: childAgent,
            input: createRunInput("task_child", delegatedInput),
            config: createDescendantRunConfig(operations, { tools }),
            contextManifestRef: "context-manifest-1",
            visibility: "parent_and_host" as const,
            mapResult(result) {
              return result.status === "succeeded"
                ? { status: "succeeded" as const, output: result.finalOutput, failure: null }
                : {
                    status: "failed" as const,
                    output: null,
                    failure: operationFailure("agent-runtime", "descendant_failed"),
                  };
            },
          };
        },
      },
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
        output: { summary: "Child complete" },
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

  it("executes recursive descendants through one Runner and one inherited tree", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const grandchildAgent = createAgent("agent_grandchild", "1", "Grandchild Agent");
    let operations!: OperationFixture;
    let childTools!: RunConfig["tools"];
    let grandchildTools!: RunConfig["tools"];
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
      descendants: {
        async prepare({ targetAgent, delegatedInput }) {
          const isChild = targetAgent.id === childAgent.id;
          const agent = isChild ? childAgent : grandchildAgent;
          return {
            agent,
            input: createRunInput(`task_${agent.id}`, delegatedInput),
            config: createDescendantRunConfig(operations, {
              tools: isChild ? childTools : grandchildTools,
            }),
            contextManifestRef: `context-${agent.id}`,
            visibility: "parent_and_host" as const,
            mapResult(result) {
              return result.status === "succeeded"
                ? { status: "succeeded" as const, output: result.finalOutput, failure: null }
                : {
                    status: "failed" as const,
                    output: null,
                    failure: operationFailure("agent-runtime", "descendant_failed"),
                  };
            },
          };
        },
      },
    });
    childTools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: grandchildAgent.id, revision: grandchildAgent.revision },
      revision: "grandchild-binding-1",
    });
    grandchildTools = emptyToolSelection(operations);
    const rootTools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "child-binding-1",
    });

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

  it("inherits the root invocation Action observer into descendant execution", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const validationOperation = operationRef("validation-check");
    const actionExecution = createValidationActionExecutionFixture(validationOperation);
    let operations!: OperationFixture;
    let rootTools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Delegate validation." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      complete("Child complete", "model_child_complete"),
      complete("Root complete", "model_root_complete"),
    ]);
    operations = createOperationFixture([
      operationSpec(validationOperation, "direct", {
        requestOrigins: ["automatic_stage"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], {
      actionExecution: actionExecution.dependencies,
      descendants: {
        async prepare({ delegatedInput }) {
          return {
            agent: childAgent,
            input: createRunInput("task_child", delegatedInput),
            config: createDescendantRunConfig(operations, {
              tools: emptyToolSelection(operations),
              actionExecution: createValidationActionExecutionConfig(),
              validation: createMandatoryValidationConfig("block"),
            }),
            contextManifestRef: "context-child",
            visibility: "parent_and_host" as const,
            mapResult(result) {
              return result.status === "succeeded"
                ? { status: "succeeded" as const, output: result.finalOutput, failure: null }
                : {
                    status: "failed" as const,
                    output: null,
                    failure: operationFailure("agent-runtime", "descendant_failed"),
                  };
            },
          };
        },
      },
    });
    rootTools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent",
      agent: { id: childAgent.id, revision: childAgent.revision },
      revision: "child-binding-1",
    });
    const notifications: ActionExecutionNotification[] = [];

    const result = await createRunner(controller, operations, {
      validation: createValidationScenario({
        kind: "effectful_automatic",
        operation: validationOperation,
      }),
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools: rootTools,
        actionExecution: createValidationActionExecutionConfig(),
        validation: createMandatoryValidationConfig("block"),
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
          status: "failed",
          failure: { code: "descendant_run_start_failed" },
          toolResult: {
            status: "failed",
            error: { code: "descendant_run_start_failed" },
          },
        });
        return complete("Parent recovered", "model_parent_complete");
      },
    ]);
    operations = createOperationFixture([], [], {
      descendants: {
        async prepare({ delegatedInput }) {
          const config = createDescendantRunConfig(operations, { tools });
          return {
            agent: childAgent,
            input: createRunInput("task_invalid_child", delegatedInput),
            config: {
              ...config,
              limits: { ...config.limits, maxDurationMs: 0 },
            },
            contextManifestRef: "context-invalid-child",
            visibility: "parent_and_host" as const,
            mapResult() {
              throw new Error("An invalid descendant must not start.");
            },
          };
        },
      },
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
        code: "descendant_run_start_failed",
        treeRevision: 1,
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
        modelItemId: "workflow_tool_1",
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
        modelItemId: "model_plan_1",
      }], "model_plan_1"),
      (input) => {
        expect(input.plan).toMatchObject({
          version: 1,
          status: "active",
          steps: [{ step: "Inspect state", status: "in_progress" }],
        });
        return complete("Planned", "model_complete_2");
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
  });

  it("feeds back bounded correction and blocks repeated Plan churn before generic limits", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const planCandidate = (modelItemId: string) => ({
      kind: "state_transition" as const,
      transition: "plan_update" as const,
      input: {
        explanation: "Inspect before completing.",
        plan: [{ step: "Inspect state", status: "in_progress" }],
      },
      modelItemId,
    });
    const controller = new ScriptedController([
      advance([planCandidate("model_plan_1")], "model_plan_1"),
      (input) => {
        expect(input.context.blocks, JSON.stringify(input.context.blocks, null, 2)).toContainEqual(expect.objectContaining({
          instructionRole: "data",
          payload: expect.objectContaining({
            kind: "structured",
            value: expect.objectContaining({
              kind: "run_progress_correction",
              correctionRound: 1,
              reasonCode: "plan_declaration_only",
            }),
          }),
        }));
        return advance([planCandidate("model_plan_2")], "model_plan_2");
      },
    ]);

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          maxIterations: 2,
          maxActions: 2,
          progress: {
            checkpointWindowSize: 3,
            nonAdvancingCheckpointThreshold: 1,
            maxCorrectionRounds: 1,
          },
        },
      }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "blocked",
      code: "runtime_no_progress",
    });
    expect(controller.calls).toHaveLength(2);
    const correctionItems = result.items.filter(({ payload }) =>
      payload.kind === "progress_assessment" || payload.kind === "progress_correction"
    );
    expect(correctionItems.slice(0, 2).map(({ payload }) => payload.kind)).toEqual([
      "progress_assessment",
      "progress_correction",
    ]);
    expect(correctionItems[0]?.committedInRevision).toBe(correctionItems[1]?.committedInRevision);
    expect(events.filter((event) => event.name.startsWith("run.progress.")).map(
      (event) => event.name,
    )).toEqual([
      "run.progress.assessed",
      "run.progress.correction_requested",
      "run.progress.assessed",
    ]);
    expect(result.items.at(-1)?.payload).toMatchObject({
      kind: "terminal_transition",
      status: "blocked",
      code: "runtime_no_progress",
      failure: null,
    });
  });

  it("recovers in the ordinary Loop when a correction is followed by a new owner-confirmed result", async () => {
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
        modelItemId: "model_plan_1",
      }], "model_plan_1"),
      advance([operationCandidate(operation, {})], "model_operation"),
      (input) => {
        expect(input.context.blocks.some((block) =>
          block.payload.kind === "structured" &&
          isRecord(block.payload.value) &&
          block.payload.value.kind === "run_progress_correction"
        )).toBe(false);
        return complete("Recovered", "model_complete");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          progress: {
            checkpointWindowSize: 4,
            nonAdvancingCheckpointThreshold: 1,
            maxCorrectionRounds: 1,
          },
        },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "progress_assessment",
        assessment: expect.objectContaining({
          disposition: "advanced",
          activeCorrectionRound: null,
        }),
      }),
    }));
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" && payload.code === "runtime_no_progress"
    )).toBe(false);
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

  it("queues a non-blocking Interaction settlement and discards a stale Controller decision", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const staleDecision = deferred<ControllerDecision<TestOutput>>();
    const controller = new ScriptedController([
      advance([interactionCandidate("none")], "model_interaction_1"),
      () => staleDecision.promise,
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
    await waitUntil(() => controller.calls.length === 2);

    handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    });
    await Promise.resolve();
    staleDecision.resolve(complete("Stale decision", "model_stale_2"));

    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Fresh decision" },
    });
    expect(controller.calls).toHaveLength(3);
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
        modelItemId: "model_handoff_1",
      }], "model_handoff_1"),
      (input) => {
        expect(input.runId).toBe("run_001");
        expect(input.task.id).toBe("task_001");
        expect(input.agent).toMatchObject({ id: specialist.id, revision: specialist.revision });
        return complete("Specialist complete", "model_complete_2");
      },
    ]);

    const result = await createRunner(controller, operations, { agents: resolver }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_specialist", revision: "2" },
      status: "succeeded",
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "state_transition",
        transition: "active_agent",
      }),
    }));
  });

  it("executes a descendant Agent as a child Run with explicit result mapping", async () => {
    const delegate = operationRef("delegate-review");
    let operations!: OperationFixture;
    const controller = new ScriptedController([
      advance([operationCandidate(delegate, { topic: "contracts" })], "model_operation"),
      complete("Child complete", "model_child_complete"),
      complete("Parent complete", "model_parent_complete"),
    ]);
    const descendantAgent = createAgent("agent_child", "1", "Child Agent");
    operations = createOperationFixture([
      operationSpec(delegate, "descendant_agent", {
        requestOrigins: ["controller_protocol"],
        agentRef: { id: descendantAgent.id, revision: descendantAgent.revision },
      }),
    ], [], {
      descendants: {
        async prepare({ delegatedInput }) {
          return {
            agent: descendantAgent,
            input: createRunInput("task_child", delegatedInput),
            config: createDescendantRunConfig(operations),
            contextManifestRef: "context-manifest-1",
            visibility: "parent_and_host" as const,
            mapResult(result) {
              return result.status === "succeeded"
                ? { status: "succeeded" as const, output: result.finalOutput, failure: null }
                : {
                    status: "failed" as const,
                    output: null,
                    failure: operationFailure("agent-runtime", "descendant_failed"),
                  };
            },
          };
        },
      },
    });

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
        status: "succeeded",
        output: { summary: "Child complete" },
        metadata: {
          contextManifestRef: "context-manifest-1",
          visibility: "parent_and_host",
        },
      },
    });
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
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
      modelItems: [modelItem("model_stop_1")],
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
          progress: {
            checkpointWindowSize: 2,
            nonAdvancingCheckpointThreshold: 3,
            maxCorrectionRounds: 1,
          },
        },
      }),
    )).toThrow("cannot exceed checkpointWindowSize");

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
  extensions: Partial<Pick<RunnerOperationComposition, "composite" | "descendants" | "actionExecution">> = {},
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
    ...extensions,
  });
}

function createValidationActionExecutionFixture(operation: OperationRevisionRef) {
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
          semanticBasis: { operation: "validation-read" },
        }),
      };
    },
    async revalidate() {
      return { status: "valid" as const, recordId: "validation-revalidation-1" };
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
  const execute = vi.fn(async () => ({
    status: "completed" as const,
    effectState: "settled" as const,
    payload: { passed: true },
  }));
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
        return { recordId: "validation-pre-effect-1" };
      },
      async recordPostEffect() {
        return { recordId: "validation-post-effect-1" };
      },
    },
    retry: {
      async decide() {
        return { status: "stop" as const, code: "validation_action_retry_disabled" };
      },
      async wait() {
        return "elapsed" as const;
      },
    },
    now: () => NOW,
  };
  return Object.freeze({ adapterId: adapterDescriptor.id, dependencies, execute });
}

function createValidationActionExecutionConfig(): NonNullable<RunConfig["actionExecution"]> {
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
  const toolName = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const registration: ToolRegistrationInput = {
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
  const registrations = createToolRegistrationSnapshot(operations.catalog, [registration]);
  return createFixedLocalToolSelection(registrations, operations.catalog, [{
    tool: registration.descriptor.ref,
    origins: ["model"],
  }]);
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
    validation: createTestValidationComposition(),
    interactions: createInteractionProtocolRegistrySnapshot("interaction-registry-1", []),
    now: () => NOW,
    createRunId: () => `run_${String(++runSequence).padStart(3, "0")}`,
    ...overrides,
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
    instructions: "Complete the task.",
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
    readonly validation?: RunConfig["validation"];
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
    readonly runTreeLimits?: Partial<RootRunConfig["runTreeLimits"]>;
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
    validation: overrides.validation ?? createTestValidationConfig(),
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
      progress: {
        checkpointWindowSize: 6,
        nonAdvancingCheckpointThreshold: 3,
        maxCorrectionRounds: 2,
      },
      ...overrides.limits,
    },
    runTreeLimits: {
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 4,
      maxDescendantDepth: 2,
      ...overrides.runTreeLimits,
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

function createDescendantRunConfig(
  operations: OperationFixture,
  overrides: Parameters<typeof createRunConfig>[1] = {},
): RunConfig {
  const rootConfig = createRunConfig(operations, overrides);
  const { runTreeLimits: _runTreeLimits, ...config } = rootConfig;
  return config;
}

function createTestValidationComposition(): RunnerDependencies["validation"] {
  return Object.freeze({
    executionFactory: createTestValidationExecutionFactory({ now: () => NOW }),
    completionGate: new CurrentValidationCompletionGate(() => NOW),
    preparation: null,
    settledOperationResults: null,
    checkResults: null,
  });
}

function createTestValidationConfig(): RunConfig["validation"] {
  const owner = (id: string) => Object.freeze({
    owner: "test-runtime",
    kind: "validation",
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
      policy: owner("current-validation-gate"),
      outputContract: owner("test-output-contract"),
      conditions: Object.freeze([]),
      maximumDurationMs: 1_000,
    }),
  });
}

function createMandatoryValidationConfig(
  disposition: "continue" | "wait" | "block" | "fail",
): RunConfig["validation"] {
  const base = createTestValidationConfig();
  const source = Object.freeze({
    owner: "test-runtime",
    kind: "validation",
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
        claim: "The required Validation claim is satisfied.",
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

type ValidationScenario =
  | { readonly kind: "pure_automatic"; readonly stale?: boolean }
  | { readonly kind: "effectful_automatic"; readonly operation: OperationRevisionRef }
  | { readonly kind: "controller"; readonly operation: OperationRevisionRef };

function createValidationScenario(input: ValidationScenario): RunnerDependencies["validation"] {
  const requirement = Object.freeze({ id: "mandatory-requirement", revision: "1" });
  const subjectRef = Object.freeze({ id: "validation-subject", revision: "1" });
  const adapter = validationOwner("validation-subject-adapter", "subject_adapter");
  const evaluator = validationOwner("validation-pure-evaluator", "check_evaluator");
  const interpreter = validationOwner("validation-result-interpreter", "result_interpreter");
  const assessmentMethod = validationOwner("test-method", "assessment_method");
  const definition = validationScenarioDefinition(input, evaluator, interpreter);
  let identitySequence = 0;
  let capturedSubject: ValidationSubjectSnapshot | null = null;
  const executionFactory = new DefaultValidationExecutionFactory({
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
            stateRefs: Object.freeze([validationOwner("mandatory-source")]),
            capturedAt: NOW,
            environment: null,
            scope: Object.freeze([{ key: "workspace", value: "workspace_001" }]),
            coverage: Object.freeze({ kind: "complete" as const, ratio: 1 }),
            fingerprint: Object.freeze({
              algorithm: "sha256",
              value: "validation-subject-v1",
              basis: "test workspace state",
            }),
            sensitivity: "internal" as const,
            audiences: Object.freeze(["validation"]),
            adapter,
          });
          return { status: "captured" as const, snapshot: capturedSubject };
        },
        async rehydrate() {
          return capturedSubject === null
            ? {
                status: "unavailable" as const,
                failure: createValidationFailure({
                  code: "validation_subject_not_captured",
                  stage: "subject",
                  message: "Validation subject has not been captured.",
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
              current: Object.freeze({ id: "validation-subject", revision: "2" }),
              change: validationOwner("workspace-change", "subject_change"),
            }
          : { status: "current" as const, snapshot: subjectRef },
      }),
    },
    pureChecks: {
      resolve: (ref) => ref.id === evaluator.id ? {
        evaluate: async () => completedValidationInterpretation(),
      } : null,
    },
    operationChecks: { resolve: () => null },
    interpreters: {
      resolve: (ref) => ref.id === interpreter.id ? {
        interpret: async () => completedValidationInterpretation(),
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
  const composition: RunnerDependencies["validation"] = {
    executionFactory,
    completionGate: new CurrentValidationCompletionGate(() => NOW),
    settledOperationResults: null,
    checkResults: null,
    preparation: {
      async prepare({ execution, automaticEffectfulChecks }, interruption) {
        await execution.captureSubject({
          requirement,
          adapter,
          kind: "test_subject",
          requestedSource: validationOwner("mandatory-source"),
          expectedRevision: await validationRevision(execution),
        }, interruption);
        await execution.admitCheckDefinition({
          definition,
          expectedRevision: await validationRevision(execution),
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
        const result = input.kind === "effectful_automatic"
          ? await automaticEffectfulChecks.execute(checkRequest, interruption)
          : await execution.executeCheck({
              ...checkRequest,
              origin: "trusted_automatic",
              runAction: null,
              expectedRevision: await validationRevision(execution),
            }, interruption);
        await admitValidationResultAndAssess(execution, result, interruption);
        if (input.kind === "pure_automatic" && input.stale === true) {
          await execution.checkSubjectFreshness({
            requirement,
            snapshot: subjectRef,
            expectedRevision: await validationRevision(execution),
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
                expectedRevision: await validationRevision(settled.execution),
              }),
              settlement: settled.settlement,
            }, interruption);
            await admitValidationResultAndAssess(
              settled.execution,
              result,
              interruption,
            );
            return true;
          },
        },
      });
}

function validationScenarioDefinition(
  input: ValidationScenario,
  evaluator: ValidationOwnerRef,
  interpreter: ValidationOwnerRef,
): CheckDefinition {
  return Object.freeze({
    ref: Object.freeze({ id: "validation-check", revision: "1" }),
    owner: "test-runtime",
    family: "test_check",
    requirementKinds: Object.freeze(["test"]),
    subjectKinds: Object.freeze(["test_subject"]),
    acceptedOrigins: Object.freeze([
      input.kind === "controller" ? "controller" as const : "trusted_automatic" as const,
    ]),
    effect: input.kind === "pure_automatic"
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

function completedValidationInterpretation(): ValidationCheckInterpretation {
  return Object.freeze({
    status: "completed",
    findings: Object.freeze([Object.freeze({
      owner: "test-runtime",
      claim: "The required Validation Check completed successfully.",
      polarity: "supports" as const,
      severity: "info" as const,
      sourceRefs: Object.freeze([validationOwner("check-output", "check_output")]),
      limitations: Object.freeze([]),
    })]),
    coverage: Object.freeze({ ratio: 1, basis: "complete test Check" }),
    costUnits: null,
    limitations: Object.freeze([]),
    failure: null,
  });
}

async function admitValidationResultAndAssess(
  execution: ValidationExecutionPort,
  result: CheckResult,
  interruption: import("@agent-anything/agent-core/control").InvocationInterruptionContext,
): Promise<void> {
  if (result.status !== "completed" && result.status !== "partial") {
    throw new Error(`Test Validation Check did not produce eligible Evidence: ${JSON.stringify(result)}`);
  }
  const requirement = Object.freeze({ id: "mandatory-requirement", revision: "1" });
  const subject = Object.freeze({ id: "validation-subject", revision: "1" });
  const evidence = Object.freeze({ id: "validation-evidence", revision: "1" });
  await execution.admitEvidence({
    evidence: Object.freeze({
      ref: evidence,
      requirement,
      subject,
      source: Object.freeze({ kind: "check_result" as const, result: result.ref }),
      admission: Object.freeze({ status: "admitted" as const, failure: null }),
      coverage: result.coverage,
      sensitivity: "internal" as const,
      audiences: Object.freeze(["validation"]),
      limitations: result.limitations,
      createdAt: NOW,
    }),
    expectedRevision: await validationRevision(execution),
  }, interruption);
  await execution.assessRequirement({
    requirement,
    subject,
    evidenceRefs: Object.freeze([evidence]),
    expectedRevision: await validationRevision(execution),
  }, interruption);
}

async function validationRevision(execution: ValidationExecutionPort): Promise<number> {
  return (await execution.readCurrentSnapshot()).ref.revision;
}

function validationOwner(id: string, kind = "validation"): ValidationOwnerRef {
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
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function complete(summary: string, id = "model_complete_1"): ControllerDecision<TestOutput> {
  return {
    kind: "propose_completion",
    output: { summary },
    modelItems: [modelItem(id, { summary })],
  };
}

function advance(
  candidates: Extract<ControllerDecision<TestOutput>, { readonly kind: "advance" }>["candidates"],
  modelItemId: string,
): ControllerDecision<TestOutput> {
  return {
    kind: "advance",
    candidates,
    modelItems: [modelItem(modelItemId)],
  };
}

function operationCandidate(operation: OperationRevisionRef, request: unknown) {
  return {
    kind: "operation_request" as const,
    origin: "controller_protocol" as const,
    operation,
    request,
    modelItemId: "model_operation",
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
    modelItemId: "model_tool_1",
  };
}

function modelItem(id: string, content: unknown = {}) {
  return {
    id,
    kind: "assistant_message",
    content,
    metadata: {},
  };
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
    modelItemId: "model_interaction_1",
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
    validationSnapshot: input.validationSnapshot,
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
