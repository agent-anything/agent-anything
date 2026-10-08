import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveRunHandle } from "./RunHandle.js";
const recordedFlows: import("@agent-anything/observability/execution-flow").ExecutionFlowObservation[] = [];
function recordedFailureCounts(): unknown[] {
  return recordedFlows.flatMap(fact => fact.kind === "constraint" && fact.checkId === "numeric_limits"
    ? [fact.basis.consecutiveActionFailures] : []);
}
afterEach(() => {
  vi.restoreAllMocks();
  const facts = recordedFlows.splice(0);
  const definitions = new Map(facts.flatMap(fact=>fact.kind === "definition" ? [[fact.definition.contentDigest,fact.definition] as const] : []));
  for (const fact of facts) {
    if (fact.kind === "definition") continue;
    const definition = definitions.get(fact.definition.contentDigest)!;
    if (fact.kind === "step_entered" || fact.kind === "step_exited") expect(definition.steps.some(step=>step.id === fact.stepId),JSON.stringify(fact)).toBe(true);
    if (fact.kind === "link" && fact.relation === "next") expect(definition.transitions.some(edge=>edge.id === fact.transitionId),JSON.stringify(fact)).toBe(true);
    if (fact.kind === "constraint") expect(definition.steps.find(step=>step.id === fact.stepId)?.checks,JSON.stringify(fact)).toContain(fact.checkId);
    if (fact.kind === "step_entered" && fact.definition.id === "descendant-result-transfer" && fact.stepId === "receive") {
      const childTerminal = facts.find(entry => entry.kind === "step_entered" &&
        entry.definition.id === "run-execution" && entry.runId === fact.basis.childRunId && entry.stepId === "terminal");
      expect(childTerminal?.kind).toBe("step_entered");
      if (childTerminal?.kind !== "step_entered") continue;
      expect(facts.filter(entry => entry.kind === "link" && entry.relation === "join" &&
        entry.from.stepExecutionId === childTerminal.stepExecutionId &&
        entry.to.stepExecutionId === fact.stepExecutionId)).toHaveLength(1);
    }
  }
});
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
import {createTestContextProjection} from "@agent-anything/test-support";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "../controller/index.js";
import { ControllerError, createControllerModelItems } from "../controller/index.js";
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
import type { ActiveDelegationProjection, RunHandle } from "./RunHandle.js";
import { createStaticOperationToolAvailabilityParticipant } from "./RunToolExposureCoordinator.js";
import type { RunInputNotification } from "./RunInputNotifications.js";

function captureRunHandles(): Map<string, ActiveRunHandle<TestOutput>> {
  const handles = new Map<string, ActiveRunHandle<TestOutput>>();
  const original = ActiveRunHandle.prototype.bindSuspend;
  vi.spyOn(ActiveRunHandle.prototype, "bindSuspend").mockImplementation(function (binding) {
    handles.set(this.runId, this as ActiveRunHandle<TestOutput>);
    original.call(this, binding);
  });
  return handles;
}

function suspendHandle(handle: ActiveRunHandle<TestOutput>): void {
  expect(handle.suspend({id: `pause-${handle.getSnapshot().runRevision}`,
    expectedRunRevision: handle.getSnapshot().runRevision, origin: "host", reason: "Host awaits updated direction."})).toMatchObject({status: "accepted"});
}

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
  it.each(["provider_request", "structured_output"] as const)("attributes an elapsed Run deadline during %s and retains its original cause", async owner => {
    const operations = createOperationFixture([]);
    let now = NOW;
    const code = owner === "provider_request" ? "provider_operation_deadline_exceeded" : "model_operation_deadline_exceeded";
    const controller = new ScriptedController([(_input, context) => {
      now = context.retry.deadlineAt;
      throw new ControllerError(owner === "provider_request"
        ? {kind: "provider", failure: {category: "deadline", code, message: "Operation deadline", metadata: {lastFailure: {code: "transport_interrupted"}}}}
        : {kind: "model", failure: {code, message: "Operation deadline", retryable: false, metadata: {}}},
      "settled_failure", {owner, operationId: "operation-deadline", deadlineAt: now, exhaustedAt: now});
    }]);
    const result = await createRunner(controller, operations, {now: () => now})
      .run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status).toBe("failed");
    expect(result.cause).toMatchObject({kind: "failure", source: {owner: "runtime", kind: "run_deadline"},
      failure: {kind: "runtime", failure: {code: "runtime_deadline_exceeded", metadata: {
        scope: "run_tree", interruptedOperation: {owner, operationId: "operation-deadline"},
        interruptedFailure: {failure: {code}},
      }}}, underlying: [{source: {owner, kind: "retry_operation", id: "operation-deadline"}}]});
    expect(controller.calls).toHaveLength(1);
  });

  it.each(["timeout", "retry_budget", "foreign_deadline", "early_deadline"] as const)("does not relabel %s as an elapsed Run deadline", async mode => {
    const operations = createOperationFixture([]);
    const code = mode === "timeout" ? "provider_timeout" : mode === "retry_budget" ? "provider_retry_exhausted" : "provider_operation_deadline_exceeded";
    let now = NOW;
    const controller = new ScriptedController([(_input, context) => {
      if (mode !== "early_deadline") now = context.retry.deadlineAt;
      throw new ControllerError({kind: "provider", failure: {
        category: mode, code, message: mode, metadata: {},
      }}, "settled_failure", mode === "foreign_deadline" || mode === "early_deadline"
        ? {owner: "provider_request", operationId: "operation", deadlineAt: mode === "early_deadline" ? context.retry.deadlineAt : NOW, exhaustedAt: now}
        : null);
    }]);
    const result = await createRunner(controller, operations, {now: () => now})
      .run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.cause).toMatchObject({kind: "failure", failure: {kind: "provider", failure: {code}}});
    expect(controller.calls).toHaveLength(1);
  });

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
      status: "completed",
      finalOutput: { summary: "Done" },
    });
    expect(result.items.map(({ payload }) => payload.kind)).toEqual([
      "controller_turn",
      "completion_acceptance",
      "settlement_cause",
      "terminal_transition",
    ]);
    expect(result.items.map(({ ref }) => ref.sequence)).toEqual([1, 2, 3, 4]);
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
      .toBeLessThan(events.findIndex(({ name }) => name === "controller.finished"));
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

  it("commits generic Controller feedback and continues to a later decision", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      Object.freeze({
        kind: "continue_with_feedback" as const,
        feedback: Object.freeze({
          source: Object.freeze({ owner: "test-controller", kind: "assessment", id: "assessment-1", revision: "1" }),
          code: "work_incomplete",
          message: "Perform the requested work.",
        }),
        modelItems: modelTextItems("model_continue_1", "Continue."),
      }),
      complete("Performed the requested work", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations)
      .run(createAgent(), createRunInput(), createRunConfig(operations));

    expect(result).toMatchObject({
      status: "completed",
      finalOutput: { summary: "Performed the requested work" },
    });
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(({ payload }) => payload.kind === "controller_feedback"))
      .toHaveLength(1);
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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
      finalOutput: null,
      cause: {
        kind: "failure",
        failure: {
        kind: "runtime",
        failure: { code: "runtime_resource_finalization_failed" },
        },
      },
    });
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
      cause: {
        kind: "failure",
        failure: {
          kind: "context",
          failure: { code: "context_projection_contract_invalid" },
        },
      },
    });
    expect(controller.calls).toHaveLength(0);
    expect(recordedFlows.some(fact => fact.kind === "material" && fact.name === "Controller input")).toBe(false);
    expect(recordedFlows.some(fact => fact.kind === "step_entered" && fact.definition.id === "controller-execution" && fact.stepId === "controller")).toBe(false);
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

    expect(result.status).toBe("completed");
    expect(persistManifest).toHaveBeenCalledTimes(1);
    const persisted = persistManifest.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      outcome: "projected",
      code: null,
    });
    expect(persisted).not.toHaveProperty("records");
  });

  it("keeps Tool execution and model input unchanged under throwing diagnostic observers", async () => {
    const execute = async (observed: boolean) => {
      const operation = operationRef("read-file");
      const handler = internalHandler("handler.read-file", "code-workspace", { content: "hello" });
      const operations = createOperationFixture([operationSpec(operation, "internal", { requestOrigins: ["tool_request"], handlerId: handler.id })], [handler]);
      const tools = createToolSelection(operations, operation, "codeAgent.readFile");
      const controller = new ScriptedController([(input) => advance([{
        kind: "tool_request", tool: { name: "codeAgent.readFile", revision: "1", input: { path: "README.md" }, origin: "model", controllerRequestId: input.toolExposure.controllerRequestId },
      }], "model_tool_1"), complete("Done", "model_complete_2")]);
      const agent = { ...createAgent(), instructions: createAgentInstructions({ id: "empty", release: { id: "empty", revision: "1" }, model: { providerId: "test-provider", modelId: "test-model" }, resolverRevision: "1", blocks: [] }) };
      const transitions: import("./RunObserver.js").RunTransitionObservation[] = [];
      const facts: import("./RunExecutionObserver.js").RunExecutionObservation[] = [];
      const transcript: unknown[] = [];
      const flowFacts: import("@agent-anything/observability/execution-flow").ExecutionFlowObservation[] = [];
      let clockTicks = 0;
      const result = await createRunner(controller, operations, { now: () => new Date(Date.parse(NOW) + clockTicks++).toISOString(), ...(observed ? {
        executionFlow: {observer:{observe(value) {flowFacts.push(value);throw new Error("flow observer unavailable");}}},
        runObserver: { observe() { throw new Error("recorder unavailable"); }, transition(value) { transitions.push(value); throw new Error("transition observer failed"); } },
        executionObserver: { observe(value) { facts.push(value); throw new Error("execution observer failed"); } },
        runTranscriptObserver: { observe(value) { transcript.push(value.item); throw new Error("transcript observer failed"); } },
      } : {executionFlow:undefined}) }).run(agent, createRunInput(), createRunConfig(operations, { tools }));
      return { result, calls: controller.calls, transitions, facts, transcript, flowFacts, clockTicks, dispatches: handler.execute.mock.calls.length };
    };
    const baseline = await execute(false);
    const captured = await execute(true);
    expect(captured.result).toEqual(baseline.result);
    expect(captured.clockTicks).toBe(baseline.clockTicks);
    // Agent output validators are separate closures; compare the published input data.
    expect(JSON.stringify(captured.calls)).toBe(JSON.stringify(baseline.calls));
    expect(captured.dispatches).toBe(1);
    expect(captured.transcript).toEqual(captured.result.items);
    expect(captured.transitions.at(-1)?.status).toBe("completed");
    expect(captured.transitions.every((transition) => transition.revision > transition.previousRevision)).toBe(true);
    expect(captured.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(["tool_exposure", "context_projection", "context_committed", "scheduling"]));
    const definitions = new Map(captured.flowFacts.flatMap(fact => fact.kind === "definition" ? [[fact.definition.id,fact.definition] as const] : []));
    expect([...definitions.keys()]).toEqual(expect.arrayContaining(["run-execution","controller-execution","model-call-execution","operation-dispatch"]));
    for (const fact of captured.flowFacts) {
      if (fact.kind === "definition") continue;
      const definition = definitions.get(fact.definition.id)!;
      if (fact.kind === "link" && fact.relation === "next") expect(definition.transitions.some(edge => edge.id === fact.transitionId),JSON.stringify(fact)).toBe(true);
      if (fact.kind === "constraint") expect(definition.steps.find(step => step.id === fact.stepId)?.checks,JSON.stringify(fact)).toContain(fact.checkId);
    }
    const coreSteps = captured.flowFacts.filter(fact => fact.kind === "step_entered" && fact.definition.id === "run-execution");
    expect(coreSteps.filter(fact => "stepId" in fact && fact.stepId === "controller")).toHaveLength(2);
    expect(coreSteps.filter(fact => "stepId" in fact && fact.stepId === "terminal")).toHaveLength(1);
    const materials = captured.flowFacts.filter(fact => fact.kind === "material");
    const controllerInputs = materials.filter(fact => fact.name === "Controller input");
    expect(controllerInputs).toHaveLength(captured.calls.length);
    for (const [index, material] of controllerInputs.entries()) {
      const actual = captured.calls[index]!;
      const {output: _validator, ...agentData} = actual.agent;
      expect(material.value).toEqual({
        input: JSON.parse(JSON.stringify({...actual, agent: agentData})),
        excludedExecutableFields: ["input.agent.output.validate"],
      });
      expect(captured.flowFacts.find(fact => fact.kind === "step_exited" && fact.invocationId === material.invocationId && fact.stepId === "context"))
        .toMatchObject({outputs: expect.arrayContaining([material.subject])});
      expect(captured.flowFacts.find(fact => fact.kind === "step_entered" && fact.invocationId === material.invocationId && fact.stepId === "controller"))
        .toMatchObject({inputs: expect.arrayContaining([material.subject])});
    }
    expect(controllerInputs[0]!.subject.id).not.toBe(controllerInputs[1]!.subject.id);
    for (const entry of coreSteps.filter(fact => fact.kind === "step_entered" && fact.stepId === "controller")) {
      if (entry.kind !== "step_entered") continue;
      expect(entry.inputs[0]).toMatchObject({owner: "runtime", id: `${captured.result.runId}:input`, revision: "1"});
      expect(entry.inputs.slice(1).map(ref => materials.find(fact => fact.subject.id === ref.id)?.name))
        .toEqual(["Decision preparation state", "Decision preparation settings"]);
    }
    const states = materials.filter(fact => fact.name === "Decision preparation state");
    expect(states).toHaveLength(2);
    expect(states[0]!.value).toMatchObject({counters: {controllerTurns: 0}});
    expect(states[1]!.value).toMatchObject({
      counters: {controllerTurns: 1},
      history: {items: expect.arrayContaining([expect.objectContaining({kind: "controller_turn"}), expect.objectContaining({kind: "observation"})])},
    });
    for (const material of materials.filter(fact => fact.name === "Decision preparation settings")) {
      expect(material.value).not.toHaveProperty("agent.output");
      expect(material.value).not.toHaveProperty("permissions.persistentPolicyAmendments");
      expect(material.value).not.toHaveProperty("permissions.reviewer.reviewer");
      expect(material.value).not.toHaveProperty("permissions.sessionAuthority.port");
    }
    const controls = materials.filter(fact => fact.name === "Controller invocation controls");
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.value).toMatchObject({
        cancellationRequest: null,
        retry: {providerRequest: disabledRetryPolicy(), structuredOutput: disabledRetryPolicy(), deadlineAt: expect.any(String)},
      });
      expect(control.value).not.toHaveProperty("retry.waitControl");
      expect(control.value).not.toHaveProperty("retry.events");
    }
    for (const entry of coreSteps) {
      if (entry.kind !== "step_entered") continue;
      const declared = definitions.get("run-execution")!.steps.find(step => step.id === entry.stepId)!.checks;
      const checks = captured.flowFacts.filter(fact => fact.kind === "constraint" && fact.stepExecutionId === entry.stepExecutionId);
      expect(checks.map(fact => fact.kind === "constraint" ? fact.checkId : null)).toEqual(expect.arrayContaining(declared));
    }
    expect(captured.facts.filter(fact => fact.kind === "controller_decision")).toHaveLength(2);
    expect(captured.facts.filter(fact => fact.kind === "scheduling").every(fact => fact.occurredAt !== null)).toBe(true);
    expect(captured.facts.find(fact => fact.kind === "operation_result")).toMatchObject({result: {status: "succeeded", output: {content: "hello"}}});
    const decisionOutputs = captured.flowFacts.filter(fact => fact.kind === "step_exited" && fact.definition.id === "run-execution" && fact.stepId === "controller");
    expect(decisionOutputs.every(fact => fact.kind === "step_exited" && fact.outputs.length === 1)).toBe(true);
    expect(captured.flowFacts.find(fact => fact.kind === "constraint" && fact.checkId === "numeric_limits")).toMatchObject({
      configuration: {id: `${captured.result.runId}:configuration`, revision: "1"},
      basis: {controllerTurns: 0, runActions: 0},
    });
  });

  it("records preparation data without inspecting executable permission services", async () => {
    const operations = createOperationFixture([]);
    const config = createRunConfig(operations);
    const service = {commit: vi.fn(), toJSON: vi.fn(() => {throw new Error("Executable service must not be serialized");})};
    const result = await createRunner(new ScriptedController([complete("Done")]), operations).run(
      createAgent(), createRunInput(), {
        ...config,
        permissions: {...config.permissions, persistentPolicyAmendments: service},
      },
    );
    expect(result.status).toBe("completed");
    expect(service.toJSON).not.toHaveBeenCalled();
    const settings = recordedFlows.find(fact => fact.kind === "material" && fact.name === "Decision preparation settings");
    expect(settings).toMatchObject({value: {
      permissions: {approvalPolicy: config.permissions.approvalPolicy},
      excludedExecutableFields: expect.arrayContaining(["permissions.persistentPolicyAmendments"]),
    }});
    expect(recordedFlows.some(fact => fact.kind === "material" && fact.name === "Controller input")).toBe(true);
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(handler.execute, JSON.stringify(result, null, 2)).toHaveBeenCalledTimes(1);
    const settlement = result.items.find(item => item.payload.kind === "model_call_settlement");
    expect(settlement?.payload).toMatchObject({ result: { settlement: "succeeded" } });
    if (settlement?.payload.kind === "model_call_settlement") {
      expect(settlement.payload.result.content).not.toHaveProperty("effectCertainty");
      expect(settlement.payload.result.content).not.toHaveProperty("completionExtent");
    }
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

    expect(result.status).toBe("completed");
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
      expect(result.status).toBe("completed");
    }
  });

  it.each((["advance", "plan_request", "propose_completion"] as const).flatMap(kind =>
    [false, true].map(revoked => [kind, revoked] as const)
  ))("retains a %s response across availability changes (revoked=%s)", async (decisionKind, revoked) => {
    const operation = operationRef("read-file");
    let ownerRevision = 1;
    const entered = deferred<void>();
    const release = deferred<void>();
    const handler = internalHandler("handler.read-file", "code-workspace", { content: "hello" });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: "handler.read-file",
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
          disposition: revoked && ownerRevision > 1 ? "unavailable" as const : "available" as const,
          reason: revoked && ownerRevision > 1 ? "binding_inactive" as const : null,
        }),
      })],
    });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      async (input) => {
        entered.resolve();
        await release.promise;
        if (decisionKind === "propose_completion") return { candidates: [], completionSource: {kind: "controller" as const},
          kind: "propose_completion",
          output: {summary: "Valid ending proposal"},
          modelItems: modelTextItems("retained-model-item", "Stop now"),
        };
        if (decisionKind === "plan_request") return updateState({
          plan: [{ step: "Retain Plan update", status: "in_progress" }],
        }, "retained-model-item");
        return advance([toolCandidate(
          "codeAgent.readFile",
          { path: "README.md" },
          input.toolExposure.controllerRequestId,
        )], "retained-model-item");
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

    expect(result.status).toBe("completed");
    expect(controller.calls).toHaveLength(decisionKind === "propose_completion" ? 1 : 2);
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "controller_turn",
        status: "decided",
      }),
    }));
    expect(JSON.stringify(result.items)).toContain("retained-model-item");
    expect(handler.execute).toHaveBeenCalledTimes(decisionKind === "advance" && !revoked ? 1 : 0);
    if (decisionKind === "advance") {
      expect(result.items.flatMap(({ payload }) =>
        payload.kind === "model_call_settlement" ? [payload.result] : []
      )).toMatchObject([{ settlement: revoked ? "invalid" : "succeeded" }]);
    }
  });

  it.each([false, true])("revalidates only selected availability after owner revision changes (revoked=%s)", async (revoked) => {
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
          disposition: revoked && ownerRevision > 1 ? "unavailable" as const : "available" as const,
          reason: revoked && ownerRevision > 1 ? "binding_inactive" as const : null,
        }),
      })],
    });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      (input) => advance([
          toolCandidate("codeAgent.readFile", { path: "one.txt" }, input.toolExposure.controllerRequestId),
          toolCandidate("codeAgent.readFile", { path: "two.txt" }, input.toolExposure.controllerRequestId),
        ], ["model_tool_1", "model_tool_2"]),
      complete("Call outcomes collected"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(handler.execute).toHaveBeenCalledTimes(revoked ? 1 : 2);
    expect(result.items.flatMap(({ payload }) =>
      payload.kind === "model_call_settlement" ? [payload.result] : []
    )).toMatchObject([
      { modelCallRef: { id: "model_tool_1" }, settlement: "succeeded" },
      { modelCallRef: { id: "model_tool_2" }, settlement: revoked ? "invalid" : "succeeded" },
    ]);
  });

  it.each([false, true])("schedules trusted overlap without changing source result order (concurrent=%s)", async (concurrent) => {
    const operation = operationRef("read-file");
    const handler = internalHandler("handler.read-file", "code-workspace", {});
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    handler.execute.mockImplementation(async (context) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) release();
      if (concurrent) await bothStarted;
      else await Promise.resolve();
      active -= 1;
      return createOperationResult({
        ref: { invocation: context.binding.invocation, id: `${context.binding.invocation.id}:result` },
        binding: context.binding.binding, semanticOwner: "code-workspace",
        status: "succeeded", output: {}, failure: null,
        startedAt: NOW, finishedAt: NOW, lowerRefs: [], metadata: {},
      });
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", { requestOrigins: ["tool_request"], handlerId: handler.id }),
    ], [handler], { availability: [{
      binding: { operation, revision: "binding-1" },
      scheduling: concurrent ? { group: "independent-test-reads", maxParallel: 2 } : undefined,
      assess: () => ({ basisRefs: [{ owner: "test", kind: "path", id: "read", revision: "1" }],
        disposition: "available", reason: null }),
    }] });
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      (input) => advance([
        toolCandidate("codeAgent.readFile", {}, input.toolExposure.controllerRequestId),
        toolCandidate("codeAgent.readFile", {}, input.toolExposure.controllerRequestId),
      ], ["model_tool_1", "model_tool_2"]), complete("Done"),
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations, { tools }));
    expect(result.status).toBe("completed");
    expect(peak).toBe(concurrent ? 2 : 1);
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(({ payload }) => payload.kind === "model_call_settlement")).toHaveLength(2);
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
      cause: {
        kind: "failure",
        failure: {
        kind: "tool",
        failure: { code: "tool_availability_participant_failed" },
        },
      },
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("continues an independent serial call after an ordinary execution failure", async () => {
    const operation = operationRef("read-file");
    const handler = internalHandler("reader", "code-workspace", {});
    handler.execute.mockRejectedValueOnce(new Error("first operation failed"));
    const operations = createOperationFixture([operationSpec(operation, "internal", {
      requestOrigins: ["tool_request"], handlerId: handler.id,
    })], [handler]);
    const tools = createToolSelection(operations, operation, "Read");
    const controller = new ScriptedController([
      (input) => advance([toolCandidate("Read", {}, input.toolExposure.controllerRequestId),
        toolCandidate("Read", {}, input.toolExposure.controllerRequestId)], ["first", "second"]),
      complete("Done"),
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations, { tools }));
    expect(result.status).toBe("completed");
    expect(handler.execute).toHaveBeenCalledTimes(2);
    expect(result.items.flatMap(({ payload }) => payload.kind === "model_call_settlement" ? [payload.result.settlement] : []))
      .toEqual(["failed", "succeeded"]);
  });

  it.each(["plan_success", "plan_failure", "interaction", "protocol_rejection", "unknown_callable"])(
    "does not spend or reset execution recovery on %s", async mode => {
      const operation = operationRef("failing-inspection");
      const handler = internalHandler("failing-inspection", "code-workspace", {});
      handler.execute.mockRejectedValue(new Error("Inspection failed"));
      const operations = createOperationFixture([operationSpec(operation, "internal", {
        requestOrigins: ["controller_protocol"], handlerId: handler.id,
      })], [handler]);
      const interaction = testInteractionProtocol();
      const tools = createSemanticToolSelection(operations, "Question", {
        kind: "interaction", protocol: interaction.ref, blockingScope: "run", revision: "1",
      });
      const controller = new ScriptedController([
        advance([operationCandidate(operation, {})], "failure-1"),
        mode === "interaction"
          ? input => advance([toolCandidate("Question", {question: "Which target?"}, input.toolExposure.controllerRequestId)], "question")
          : mode === "protocol_rejection" || mode === "unknown_callable"
          ? advance([{kind: "model_call_rejection", name: mode === "protocol_rejection" ? "final_result" : "unknown",
              code: "call_invalid", message: "Invalid model call."}], "protocol")
          : updateState({plan: [{step: "Inspect", status: mode === "plan_success" ? "in_progress" : "invalid"}]}, "plan"),
        advance([operationCandidate(operation, {})], "failure-2"),
        complete("Must not be requested"),
      ]);
      const handle = createRunner(controller, operations, {interactions: interaction.registry}).start(
        createAgent(), createRunInput(), createRunConfig(operations, {tools, limits: {maxConsecutiveActionFailures: 1}}),
      );
      if (mode === "interaction") {
        const pending = await waitForPendingInteraction(handle);
        expect(handle.submitInteraction({request: pending.envelope.request, submissionId: "answer",
          contentDigest: "sha256:answer", payload: {accepted: true}, receivedAt: NOW}).status).toBe("accepted_for_resolution");
      }
      const result = await handle.wait();
      expect(result.cause).toMatchObject({kind: "failure", failure: {kind: "runtime", failure: {code: "runtime_limit_exceeded"}}});
      expect(controller.calls).toHaveLength(3);
      expect(recordedFailureCounts()).toEqual([0, 1, 1, 2]);
    },
  );

  it("resets execution recovery only after a successful execution request", async () => {
    const operation = operationRef("inspection");
    const handler = internalHandler("inspection", "code-workspace", {});
    handler.execute.mockRejectedValueOnce(new Error("first failure"));
    const operations = createOperationFixture([operationSpec(operation, "internal", {
      requestOrigins: ["controller_protocol"], handlerId: handler.id,
    })], [handler]);
    const controller = new ScriptedController([
      advance([operationCandidate(operation, {})], "first"),
      advance([operationCandidate(operation, {})], "second"),
      () => {
        handler.execute.mockRejectedValueOnce(new Error("next failure"));
        return advance([operationCandidate(operation, {})], "third");
      },
      complete("Done"),
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(),
      createRunConfig(operations, {limits: {maxConsecutiveActionFailures: 1}}));
    expect(result.status).toBe("completed");
    expect(recordedFailureCounts()).toEqual([0, 1, 0, 1]);
  });

  it.each([false, true])("accounts concurrent execution in candidate order (reverse=%s)", async reverse => {
    const operation = operationRef("parallel-inspection");
    const handler = internalHandler("parallel-inspection", "code-workspace", {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    handler.execute.mockImplementation(async context => {
      const first = context.binding.request.index === 0;
      if (first === reverse) await gate;
      else setTimeout(release, 10);
      if (first) throw new Error("first candidate failed");
      return createOperationResult({ref: {invocation: context.binding.invocation, id: `${context.binding.invocation.id}:result`},
        binding: context.binding.binding, semanticOwner: "code-workspace", status: "succeeded", output: {}, failure: null,
        startedAt: NOW, finishedAt: NOW, lowerRefs: [], metadata: {}});
    });
    const operations = createOperationFixture([operationSpec(operation, "internal", {
      requestOrigins: ["tool_request"], handlerId: handler.id,
    })], [handler], {availability: [{binding: {operation, revision: "binding-1"},
      scheduling: {group: "independent-inspections", maxParallel: 2},
      assess: () => ({basisRefs: [{owner: "test", kind: "independence", id: "inspection", revision: "1"}], disposition: "available", reason: null}),
    }]});
    const tools = createToolSelection(operations, operation, "Inspect");
    const controller = new ScriptedController([
      input => advance([toolCandidate("Inspect", {index: 0}, input.toolExposure.controllerRequestId),
        toolCandidate("Inspect", {index: 1}, input.toolExposure.controllerRequestId)], ["first", "second"]),
      complete("Done"),
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(),
      createRunConfig(operations, {tools, limits: {maxConsecutiveActionFailures: 0}}));
    expect(result.status).toBe("completed");
    expect(recordedFailureCounts()).toEqual([0, 0]);
    expect(result.items.flatMap(({payload}) => payload.kind === "model_call_settlement" ? [payload.result.settlement] : []))
      .toEqual(reverse ? ["succeeded", "failed"] : ["failed", "succeeded"]);
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
    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

  it.each(["Work delivered", "No further progress is possible"])("transfers a normal Child final reply without inventing success or failure: %s", async (childSummary) => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const delegation = createTestDelegation(childAgent);
    const childResults: RunResult[] = [];
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
        return complete(childSummary, "model_child_complete");
      },
      (input) => {
        expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
          kind: "descendant_run",
          status: "succeeded",
          output: { summary: childSummary },
          toolResult: {
            status: "succeeded",
            output: { summary: childSummary },
          },
        });
        return complete("Parent complete", "model_parent_complete");
      },
    ]);
    operations = createOperationFixture([], [], {
      delegation: {
        ...delegation,
        narrativeProjection: {
          project(input) {
            childResults.push(input.childResult);
            return delegation.narrativeProjection.project(input);
          },
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

    expect(childResults[0]?.status, JSON.stringify(childResults[0]?.cause)).toBe("completed");
    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "descendant_run",
        status: "succeeded",
        output: expect.objectContaining({ summary: childSummary }),
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

  it.each([false, true])("recovers a suspended Child without abandoning it for Parent Stop (stop=%s)", async (tryParentStop) => {
    const handles = captureRunHandles();
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const childMayComplete = deferred<void>();
    const childSettled = deferred<void>();
    const events: RuntimeEvent[] = [];
    const controllerCalls: ControllerInput<TestOutput>[] = [];
    let rootTurn = 0;
    let childTurn = 0;
    const controller: Controller<TestOutput> = {
      resourceMetering: Object.freeze({
        modelInputTokens: "not_applicable" as const,
        modelOutputTokens: "not_applicable" as const,
        costUnits: "not_applicable" as const,
      }),
      async next(input) {
        controllerCalls.push(input);
        if (input.runId === "run_002") {
          childTurn += 1;
          if (childTurn === 1) {
            suspendHandle(handles.get(input.runId)!);
            return Object.freeze({ candidates: [], completionSource: {kind: "controller" as const},
              kind: "propose_completion" as const,
              output: { summary: "The Child needs Parent direction." },
              modelItems: modelTextItems(
                "model_child_stop",
                "The Child needs Parent direction.",
              ),
            });
          }
          await childMayComplete.promise;
          expect(input.context.blocks.some((block) =>
            block.instructionRole === "user" &&
            block.payload.kind === "text" &&
            block.payload.text === "Continue with the focused check."
          )).toBe(true);
          return complete("Child completed after same-Run recovery", "model_child_complete");
        }
        if (input.runId !== "run_001") {
          throw new Error(`Unexpected Run '${input.runId}'.`);
        }
        rootTurn += 1;
        if (rootTurn === 1) {
          return advance([toolCandidate(
            "Agent",
            { prompt: "Inspect the contracts and stop if direction is needed." },
            input.toolExposure.controllerRequestId,
          )], "model_agent_1");
        }
        if (rootTurn === 2 && tryParentStop) return { candidates: [], completionSource: {kind: "controller" as const},
          kind: "propose_completion",
          output: {summary: "Parent proposes stopping before Child settlement"},
          modelItems: modelTextItems("model_parent_stop", "Stop now"),
        };
        const progressionTurn = rootTurn - (tryParentStop ? 1 : 0);
        if (progressionTurn === 2) {
          const active = input.descendants.active[0];
          expect(active).toMatchObject({
            target: { kind: "active", id: "run_002" },
            relationKind: "delegation",
            status: "suspended",
          });
          expect(projectedObservations(input.context).at(-1)?.payload).toMatchObject({
            kind: "descendant_progress",
            progress: {
              childRun: { id: "run_002" },
              suspension: { code: "run_suspension_requested" },
            },
            output: { agent_id: "run_002", status: "suspended" },
            toolResult: { status: "succeeded" },
          });
          return advance([toolCandidate(
            "SendMessage",
            {
              agent_id: active!.target.id,
              prompt: "Continue with the focused check.",
            },
            input.toolExposure.controllerRequestId,
          )], "model_send_message_1");
        }
        if (progressionTurn === 3) {
          childMayComplete.resolve();
          await childSettled.promise;
          return complete("Parent attempted completion before transfer", "model_parent_stale");
        }
        expect(input.descendants.active).toEqual([]);
        expect(projectedObservations(input.context).some(({ payload }) =>
          payload.kind === "descendant_result_transfer" &&
          payload.childRunId === "run_002" &&
          payload.status === "succeeded"
        )).toBe(true);
        return complete("Parent consumed the transferred Child result", "model_parent_complete");
      },
    };
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

    const handle = createRunner(controller, operations, {
      runtimeEventPublisher: {
        publish(event) {
          events.push(event);
          if (event.name === "run.descendant.settled" && event.payload.childRunId === "run_002") {
            childSettled.resolve();
          }
        },
      },
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools, limits: { } }),
    );
    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(controllerCalls.map(({ runId }) => runId)).toEqual([
      "run_001",
      "run_002",
      ...(tryParentStop ? ["run_001"] : []),
      "run_001",
      "run_002",
      "run_001",
      "run_001",
    ]);
    expect(observations(result).filter(({ payload }) =>
      payload.kind === "descendant_progress" && payload.progress.childRun.id === "run_002"
    )).toHaveLength(1);
    expect(observations(result).filter(({ payload }) =>
      payload.kind === "descendant_result_transfer" && payload.childRunId === "run_002"
    )).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "model_call_settlement"))
      .toHaveLength(2);
    expect(events.filter(({ name }) => name === "run.descendant.started")).toHaveLength(1);
    expect(events.filter(({ name }) => name === "run.descendant.settled")).toHaveLength(1);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId }) => runId))
      .toEqual(["run_001", "run_002"]);
    expect(handle.getSnapshot().runTree.settlement).toMatchObject({
      complete: true,
      pendingResultTransfers: 0,
    });
  });

  it("reports each later suspension once while Host recovery resumes the same Child", async () => {
    const handles = captureRunHandles();
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const parentControllerEntered = deferred<void>();
    const releaseParentDecision = deferred<void>();
    const firstSuspension = deferred<ReturnType<RunHandle["getSnapshot"]>["activeDelegations"][number]>();
    const secondSuspension = deferred<ReturnType<RunHandle["getSnapshot"]>["activeDelegations"][number]>();
    const childTransferred = deferred<void>();
    const observedSuspensions = new Set<string>();
    let rootTurn = 0;
    let childTurn = 0;
    const controller: Controller<TestOutput> = {
      resourceMetering: Object.freeze({
        modelInputTokens: "not_applicable" as const,
        modelOutputTokens: "not_applicable" as const,
        costUnits: "not_applicable" as const,
      }),
      async next(input) {
        if (input.runId === "run_002") {
          childTurn += 1;
          if (childTurn <= 2) {
            suspendHandle(handles.get(input.runId)!);
            return Object.freeze({ candidates: [], completionSource: {kind: "controller" as const},
              kind: "propose_completion" as const,
              output: { summary: `Child suspension ${childTurn}.` },
              modelItems: modelTextItems(
                `model_child_stop_${childTurn}`,
                `Child suspension ${childTurn}.`,
              ),
            });
          }
          return complete("Child completed after two recoveries", "model_child_complete");
        }
        rootTurn += 1;
        if (rootTurn === 1) {
          return advance([toolCandidate(
            "Agent",
            { prompt: "Inspect and suspend twice for direction." },
            input.toolExposure.controllerRequestId,
          )], "model_agent_1");
        }
        if (rootTurn === 2) {
          parentControllerEntered.resolve();
          await releaseParentDecision.promise;
          return complete("Parent decision computed while Child progressed", "model_parent_stale");
        }
        expect(input.descendants.active).toEqual([]);
        return complete("Parent consumed the final Child transfer", "model_parent_complete");
      },
    };
    const operations = createOperationFixture([], [], {
      delegation: createTestDelegation(childAgent),
    });
    const tools = createSemanticToolSelectionSet(operations, [{
      name: "Agent",
      binding: {
        kind: "descendant_agent",
        agent: { id: childAgent.id, revision: childAgent.revision },
        revision: "descendant-binding-1",
      },
    }]);
    const handle = createRunner(controller, operations, { }).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools, limits: { } }),
    );
    handle.subscribe((snapshot) => {
      const active = snapshot.activeDelegations[0];
      if (active !== undefined && active.suspension !== null) {
        const key = `${active.suspension.ref.id}@${active.suspension.ref.revision}`;
        if (!observedSuspensions.has(key)) {
          observedSuspensions.add(key);
          (observedSuspensions.size === 1 ? firstSuspension : secondSuspension).resolve(active);
        }
      }
      if (
        snapshot.activeDelegations.length === 0 &&
        snapshot.runTree.nodes.some((node) => node.runId === "run_002") &&
        snapshot.runTree.settlement.pendingResultTransfers === 0
      ) childTransferred.resolve();
    });

    const first = await firstSuspension.promise;
    await parentControllerEntered.promise;
    const currentFirst = handle.getSnapshot().activeDelegations.find(active => active.child.id === first.child.id)!;
    const firstReceipt = handle.resumeDescendant(hostResumeRoute(currentFirst, "host-resume-1"));
    expect(firstReceipt, JSON.stringify(firstReceipt)).toMatchObject({
      status: "routed",
      resume: { status: "accepted" },
    });
    expect(handle.resumeDescendant(hostResumeRoute(first, "host-resume-duplicate"))).toMatchObject({
      status: "routed",
      resume: { status: "rejected" },
    });
    const second = await secondSuspension.promise;
    expect(second.child.id).toBe(first.child.id);
    expect(second.suspension?.ref.id).not.toBe(first.suspension?.ref.id);
    await Promise.resolve();
    const currentSecond = handle.getSnapshot().activeDelegations.find(active => active.child.id === second.child.id)!;
    expect(handle.resumeDescendant(hostResumeRoute(currentSecond, "host-resume-2"))).toMatchObject({
      status: "routed",
      resume: { status: "accepted" },
    });
    await childTransferred.promise;
    releaseParentDecision.resolve();
    const result = await handle.wait();

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(observations(result).filter(({ payload }) =>
      payload.kind === "descendant_progress" && payload.progress.childRun.id === "run_002"
    )).toHaveLength(2);
    expect(observations(result).filter(({ payload }) =>
      payload.kind === "descendant_result_transfer" && payload.childRunId === "run_002"
    )).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "model_call_settlement"))
      .toHaveLength(1);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId }) => runId))
      .toEqual(["run_001", "run_002"]);
    expect(handle.resumeDescendant(hostResumeRoute(second, "host-resume-terminal"))).toMatchObject({
      status: "rejected",
      code: "delegation_child_settled",
    });
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(observations(result)
      .filter(({ payload }) => payload.kind === "descendant_run")
      .map(({ payload }) => payload.status)).toEqual(["succeeded", "failed"]);
    expect(handle.getSnapshot().runTree.nodes.map(({ runId, status }) => ({ runId, status })))
      .toEqual([
        { runId: "run_001", status: "completed" },
        { runId: "run_002", status: "completed" },
        { runId: "run_003", status: "failed" },
      ]);
    expect(handle.getSnapshot().runTree.settlement.complete).toBe(true);
  });

  it("delivers failed descendant diagnostics to the Parent's next model interaction", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const message = "Model output was truncated at the configured 2048-token limit after 3 generation attempts.";
    let rootTurn = 0;
    const controller: Controller<TestOutput> = {
      resourceMetering: { modelInputTokens: "not_applicable", modelOutputTokens: "not_applicable", costUnits: "not_applicable" },
      async next(input) {
        if (input.runId !== "run_001") {
          throw new ControllerError({ kind: "model", failure: {
            code: "model_output_limit_exhausted", message, retryable: false, metadata: {},
          } }, "settled_failure");
        }
        if (++rootTurn === 1) {
          return advance([toolCandidate("Agent", { prompt: "Inspect." }, input.toolExposure.controllerRequestId)], ["model_agent_1"]);
        }
        const results = input.interaction.messages.flatMap(entry => entry.role === "tool" ? entry.content : []);
        expect(results).toMatchObject([{ kind: "model_tool_result", result: {
          settlement: "failed", content: {
            kind: "descendant_run", status: "failed",
            output: { summary: "", diagnostic: { message, messageTruncated: false } },
            failure: { code: "model_output_limit_exhausted", message },
          },
        } }]);
        return complete("Parent received the diagnostic", "model_parent_complete");
      },
    };
    const delegation: RunnerDelegationComposition = {
      ...createTestDelegation(childAgent),
      resultProjection: { project({ result }) {
        expect(result.terminal.status).toBe("failed");
        expect(result.narrative).toBeNull();
        return {
          status: "failed", output: { summary: "", diagnostic: result.terminal.failureDiagnostic },
          failure: { owner: "test", code: result.terminal.code,
            message: result.terminal.failureDiagnostic!.message, retryable: false, metadata: {} },
        };
      } },
    };
    const operations = createOperationFixture([], [], { delegation });
    const tools = createSemanticToolSelection(operations, "Agent", {
      kind: "descendant_agent", agent: { id: childAgent.id, revision: childAgent.revision }, revision: "descendant-binding-1",
    });
    const result = await createRunner(controller, operations).run(
      createAgent(), createRunInput(), createRunConfig(operations, { tools }),
    );
    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(rootTurn).toBe(2);
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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
        { runId: "run_001", status: "completed" },
        { runId: "run_002", status: "completed" },
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
        expect(projectedObservations(input.context).at(-1)?.payload.output).toMatchObject({
          summary: "Child context retained",
          agent_id: continuationTargetId,
        });
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
            agent_id: continuationTargetId,
            prompt: "Refine the retained finding.",
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
        const continuation = projectedObservations(input.context).find(({ payload }) =>
          payload.kind === "descendant_run" && payload.childRunId === "run_003"
        );
        expect(continuation?.payload).toMatchObject({
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
            agent_id: continuationTargetId,
            prompt: "Attempt to consume the same continuation again.",
          },
          input.toolExposure.controllerRequestId,
        )], "model_send_message_2");
      },
      (input) => {
        const staleTarget = projectedObservations(input.context).find(({ payload }) =>
          payload.kind === "descendant_run" &&
          payload.status === "unavailable" &&
          payload.failure?.code === "agent_target_stale"
        );
        expect(staleTarget?.payload).toMatchObject({
          kind: "descendant_run",
          status: "unavailable",
          failure: { code: "agent_target_stale" },
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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
            agent_id: firstContinuationId,
            prompt: "Refine the original finding.",
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
            agent_id: secondContinuationId,
            prompt: "Refine the finding one final time.",
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status).toBe("completed");
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


    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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
        { runId: "run_001", status: "completed", depth: 0 },
        { runId: "run_002", status: "completed", depth: 1 },
        { runId: "run_003", status: "completed", depth: 2 },
      ],
    });
  });

  it("inherits the root invocation Action observer into descendant execution", async () => {
    const childAgent = createAgent("agent_child", "1", "Child Agent");
    const readOperation = operationRef("read-file");
    const actionExecution = createDirectActionExecutionFixture(readOperation);
    let operations!: OperationFixture;
    let rootTools!: RunConfig["tools"];
    const controller = new ScriptedController([
      (input) => advance([toolCandidate(
        "Agent",
        { prompt: "Read the workspace file." },
        input.toolExposure.controllerRequestId,
      )], "model_tool_1"),
      (input) => advance([toolCandidate("Read", {}, input.toolExposure.controllerRequestId)], "model_read_child"),
      complete("Child complete", "model_child_complete"),
      (input) => advance([toolCandidate("Read", {}, input.toolExposure.controllerRequestId)], "model_read_root"),
      complete("Root complete", "model_root_complete"),
    ]);
    operations = createOperationFixture([
      operationSpec(readOperation, "direct", {
        requestOrigins: ["tool_request"],
        actionAdapterId: actionExecution.adapterId,
      }),
    ], [], {
      actionExecution: actionExecution.dependencies,
      delegation: createTestDelegation(childAgent),
    });
    rootTools = createSemanticToolSelectionSet(operations, [{ name: "Agent", binding: {
      kind: "descendant_agent", agent: { id: childAgent.id, revision: childAgent.revision }, revision: "child-binding-1",
    } }, { name: "Read", binding: { kind: "operation", operation: readOperation, revision: "binding-1" } }]);
    const notifications: ActionExecutionNotification[] = [];

    const result = await createRunner(controller, operations, {
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        tools: rootTools,
        actionExecution: createDirectActionExecutionConfig(),
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

  it.each([false, true])("settles same-turn Plan state before completion notification (final first: %s)", async finalFirst => {
    const operations = createOperationFixture([]);
    const decision = completionWithCalls([{kind: "state_transition", transition: "plan_update", input: {
      plan: [{step: "Inspect state", status: "completed"}],
    }}], "Done", "same-turn", finalFirst);
    const controller = new ScriptedController([decision]);
    const beforeCompletion = vi.fn((notification: import("../controller/index.js").ControllerCompletionInput<TestOutput>) => {
      expect(notification.current.plan).toMatchObject({status: "completed", steps: [{status: "completed"}]});
      expect(notification.settlements).toHaveLength(1);
      expect(notification.settlements[0]?.settlement).toBe("succeeded");
      return Promise.resolve({kind: "allow" as const});
    });
    Object.assign(controller, {beforeCompletion});
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(controller.calls).toHaveLength(1);
    expect(beforeCompletion).toHaveBeenCalledTimes(1);
    const settlements = result.items.filter(item => item.payload.kind === "model_call_settlement");
    expect(settlements).toHaveLength(2);
    expect(settlements.at(-1)?.payload).toMatchObject({result: {name: "final_result", settlement: "succeeded"}});
    expect(result.items.some(item => item.payload.kind === "run_action" && item.payload.action.provenance.kind === "controller" &&
      item.payload.action.provenance.modelCallRef.id === "same-turn:final")).toBe(false);
    expect(result.items.some(item => item.payload.kind === "completion_acceptance" && item.payload.completionSource.kind === "model_call")).toBe(true);
  });

  it.each(["completed", "pending", "in_progress"])("applies an embedded %s Plan and settles the ending call exactly once", async status => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([completionWithPlan([{step: "Inspect", status}], "Final", "embedded")]);
    Object.assign(controller, {beforeCompletion: async (input: import("../controller/index.js").ControllerCompletionInput<TestOutput>) => {
      expect(input.current.plan?.steps).toEqual([{step: "Inspect", status}]);
      expect(input.current.interaction.unsettledCalls).toHaveLength(1);
      expect(input.settlements).toEqual([]);
      return {kind: "allow"};
    }});
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(controller.calls).toHaveLength(1);
    const settlements = result.items.flatMap(item => item.payload.kind === "model_call_settlement" ? [item.payload.result] : []);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({name: "final_result", settlement: "succeeded",
      content: {code: "completion_candidate_accepted", stateUpdate: {settlement: "succeeded", content: {kind: "plan_update"}}}});
    expect(settlements[0]?.sourceRefs.map(ref => ref.kind)).toEqual(["run_action", "run_observation", "run_completion_acceptance"]);
    const plans = result.items.flatMap(item => item.payload.kind === "state_transition" && item.payload.transition === "plan" ? [item.payload.plan] : []);
    expect(plans.at(-1)).toMatchObject({status: status === "completed" ? "completed" : "abandoned", steps: [{step: "Inspect", status}]});
  });

  it.each([
    {plan: []},
    {plan: [{step: "", status: "completed"}]},
    {plan: [{step: "Inspect", status: "unknown"}]},
    {plan: [{step: "A", status: "in_progress"}, {step: "B", status: "in_progress"}]},
  ])("returns invalid embedded Plan facts before accepting a corrected final: $plan", async ({plan}) => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      completionWithPlan(plan, "Invalid", "invalid-embedded"),
      input => {
        expect(input.plan).toBeNull();
        expect(input.interaction.unsettledCalls).toEqual([]);
        expect(input.interaction.messages.filter(message => message.role === "tool")).toMatchObject([
          {content: [{result: {settlement: "invalidated", content: {code: "completion_state_update_failed", stateUpdate: {settlement: "invalid"}}}}]},
        ]);
        return completionWithPlan([{step: "Inspect", status: "pending"}], "Cannot finish", "corrected-embedded");
      },
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.finalOutput).toEqual({summary: "Cannot finish"});
    expect(result.items.flatMap(item => item.payload.kind === "model_call_settlement" ? [item.payload.result.settlement] : []))
      .toEqual(["invalidated", "succeeded"]);
  });

  it("retains the embedded Plan when completion feedback requests another turn, without replay", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      completionWithPlan([{step: "Inspect", status: "pending"}], "First", "embedded-feedback"),
      input => {
        expect(input.plan).toMatchObject({version: 1, steps: [{step: "Inspect", status: "pending"}]});
        expect(input.interaction.unsettledCalls).toEqual([]);
        return completionWithPlan([{step: "Inspect", status: "pending"}], "Unchanged", "embedded-unchanged");
      },
    ]);
    let calls = 0;
    Object.assign(controller, {beforeCompletion: async () => ++calls === 1
      ? {kind: "continue_with_feedback", feedback: {source: {owner: "test", kind: "ending", id: "feedback", revision: "1"}, code: "continue", message: "Consider current results."}}
      : {kind: "allow"}});
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const results = result.items.flatMap(item => item.payload.kind === "model_call_settlement" ? [item.payload.result] : []);
    expect(results.map(item => item.settlement)).toEqual(["invalidated", "succeeded"]);
    expect(results[1]?.content).toMatchObject({stateUpdate: {content: {result: {status: "no_change"}}}});
    expect(result.items.filter(item => item.payload.kind === "state_transition" && item.payload.transition === "plan")).toHaveLength(2);
  });

  it("cancels the ending call after applying its Plan without a premature success result", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([completionWithPlan([{step: "Inspect", status: "completed"}], "Final", "cancel-embedded")]);
    const entered = deferred<void>(), release = deferred<void>();
    Object.assign(controller, {beforeCompletion: async () => {entered.resolve(); await release.promise; return {kind: "allow"};}});
    const handle = createRunner(controller, operations).start(createAgent(), createRunInput(), createRunConfig(operations));
    await entered.promise;
    handle.cancel({origin: "user", reasonCode: "user_requested"});
    release.resolve();
    const result = await handle.wait();
    expect(result.status).toBe("cancelled");
    const settlements = result.items.flatMap(item => item.payload.kind === "model_call_settlement" ? [item.payload.result] : []);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({settlement: "cancelled", content: {stateUpdate: {settlement: "succeeded"}}});
    expect(result.items.some(item => item.payload.kind === "completion_acceptance")).toBe(false);
  });

  it.each([false, true])("does not accept an embedded final when an accompanying call fails (final first: %s)", async finalFirst => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      completionWithPlan([{step: "Inspect", status: "completed"}], "Premature", "embedded-co-failure", [
        {kind: "model_call_rejection", name: "unavailable", code: "unknown", message: "Unavailable call."},
      ], finalFirst),
      completionWithCalls([], "Limitations acknowledged", "embedded-co-corrected"),
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.finalOutput).toEqual({summary: "Limitations acknowledged"});
    const settlements = result.items.flatMap(item => item.payload.kind === "model_call_settlement" ? [item.payload.result] : []);
    expect(settlements.map(item => item.settlement)).toEqual(["invalid", "invalidated", "succeeded"]);
    expect(settlements[1]?.content).toMatchObject({stateUpdate: {settlement: "succeeded"}});
  });

  it("returns failed co-calls before a new final proposal without making historical failures an ending gate", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      completionWithCalls([{kind: "state_transition", transition: "plan_update", input: {plan: [{step: "Invalid", status: "unknown"}]}}], "Premature", "invalid-final"),
      input => {
        expect(input.interaction.unsettledCalls).toEqual([]);
        expect(input.interaction.settledCallCount).toBe(2);
        return completionWithCalls([], "Acknowledged limitation", "later-final");
      },
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.finalOutput).toEqual({summary: "Acknowledged limitation"});
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result.settlement))
      .toEqual(["invalid", "invalidated", "succeeded"]);
  });

  it("retains the accepted final call but not a final output when required finalization fails", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([completionWithCalls([], "Candidate", "finalizer-failure")]);
    const beforeCompletion = vi.fn(async () => ({kind: "allow" as const}));
    Object.assign(controller, {beforeCompletion});
    const result = await createRunner(controller, operations, {
      resourceFinalizers: [{async finalize() {throw new Error("Cleanup failed");}}],
    }).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result).toMatchObject({status: "failed", finalOutput: null,
      cause: {failure: {failure: {code: "runtime_resource_finalization_failed"}}}});
    expect(controller.calls).toHaveLength(1);
    expect(beforeCompletion).toHaveBeenCalledTimes(1);
    expect(result.items.filter(item => item.payload.kind === "completion_acceptance")).toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result))
      .toMatchObject([{name: "final_result", settlement: "succeeded"}]);
  });

  it("cancels an in-flight completion notification without accepting or reentering it", async () => {
    const operations = createOperationFixture([]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new ScriptedController([completionWithCalls([], "Candidate", "cancel-final")]);
    const beforeCompletion = vi.fn(async () => {entered.resolve(); await release.promise; return {kind: "allow" as const};});
    Object.assign(controller, {beforeCompletion});
    const handle = createRunner(controller, operations).start(createAgent(), createRunInput(), createRunConfig(operations));
    await entered.promise;
    handle.cancel({origin: "user", reasonCode: "user_requested"});
    release.resolve();
    const result = await handle.wait();
    expect(result).toMatchObject({status: "cancelled", finalOutput: null});
    expect(result.items.filter(item => item.payload.kind === "completion_acceptance")).toHaveLength(0);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result))
      .toMatchObject([{name: "final_result", settlement: "cancelled"}]);
    expect(beforeCompletion).toHaveBeenCalledTimes(1);
    expect(controller.calls).toHaveLength(1);
  });

  it("settles declined output before the next ordinary turn and never replays its Plan update", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      completionWithCalls([{kind: "state_transition", transition: "plan_update", input: {plan: [{step: "Open item", status: "in_progress"}]}}], "First", "feedback-final"),
      input => {
        expect(input.plan?.version).toBe(1);
        expect(input.interaction.unsettledCalls).toEqual([]);
        return completionWithCalls([], "Second", "accepted-final");
      },
    ]);
    let notifications = 0;
    Object.assign(controller, {beforeCompletion: async () => ++notifications === 1
      ? {kind: "continue_with_feedback", feedback: {source: {owner: "test", kind: "completion", id: "check", revision: "1"}, code: "one_more_turn", message: "Use the current results."}}
      : {kind: "allow"}});
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(notifications).toBe(2);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement")).toHaveLength(3);
    expect(result.items.filter(item => item.payload.kind === "state_transition" && item.payload.transition === "plan").at(-1)?.payload)
      .toMatchObject({plan: {status: "abandoned", steps: [{status: "in_progress"}]}});
  });

  it("delivers asynchronous facts before accepting a new ending proposal with no Hook registered", async () => {
    const operations = createOperationFixture([]);
    const facts: RunInputNotification[] = [];
    const controller = new ScriptedController([
      () => {
        facts.push({runId: "run_001", sequence: 1, occurredAt: NOW,
          source: {owner: "execution", kind: "command_completed", id: "command-1", revision: "5"},
          data: {exitCode: 1, output: "Build failed."}});
        return completionWithPlan([{step: "Inspect", status: "completed"}], "Stale result", "stale-async-final");
      },
      input => {
        expect(JSON.stringify(input.context)).toContain("Build failed.");
        expect(input.interaction.unsettledCalls).toEqual([]);
        expect(input.plan?.version).toBe(1);
        return completionWithCalls([], "Command failure acknowledged", "fresh-async-final");
      },
    ]);
    const source = {read: (runId: string, after: number) => facts.filter(fact => fact.runId === runId && fact.sequence > after)};
    const result = await createRunner(controller, operations, {inputNotifications: source}).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.finalOutput).toEqual({summary: "Command failure acknowledged"});
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(item => item.payload.kind === "input_notification")).toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "completion_acceptance")).toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "state_transition" && item.payload.transition === "plan"))
      .toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result.settlement))
      .toEqual(["invalidated", "succeeded"]);
  });

  it("does not invalidate or replay ordinary calls when new execution facts arrive during their decision", async () => {
    const operation = operationRef("read-file");
    const handler = internalHandler("handler.read-file", "code-workspace", {content: "hello"});
    const operations = createOperationFixture([operationSpec(operation, "internal", {
      requestOrigins: ["tool_request"], handlerId: handler.id,
    })], [handler]);
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const facts: RunInputNotification[] = [];
    const controller = new ScriptedController([
      input => {
        facts.push({runId: "run_001", sequence: 1, occurredAt: NOW,
          source: {owner: "execution", kind: "command_completed", id: "background", revision: "3"}, data: {exitCode: 0}});
        return advance([{kind: "tool_request", tool: {name: "codeAgent.readFile", revision: "1", input: {path: "README.md"},
          origin: "model", controllerRequestId: input.toolExposure.controllerRequestId}}], "read-while-notified");
      },
      input => {
        expect(JSON.stringify(input.context)).toContain("command_completed");
        return completionWithCalls([], "Both results consumed", "read-and-background-final");
      },
    ]);
    const result = await createRunner(controller, operations, {
      inputNotifications: {read: (runId, after) => facts.filter(fact => fact.runId === runId && fact.sequence > after)},
    }).run(createAgent(), createRunInput(), createRunConfig(operations, {tools}));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(item => item.payload.kind === "controller_feedback")).toHaveLength(0);
  });

  it("rechecks notifications immediately after an asynchronous beforeCompletion callback", async () => {
    const operations = createOperationFixture([]);
    const facts: RunInputNotification[] = [];
    const controller = new ScriptedController([
      completionWithCalls([], "Before asynchronous check", "before-check-final"),
      input => {
        expect(JSON.stringify(input.context)).toContain("resource cleanup failed");
        return completionWithCalls([], "New fact acknowledged", "after-check-final");
      },
    ]);
    let checks = 0;
    Object.assign(controller, {beforeCompletion: async () => {
      await Promise.resolve();
      if (++checks === 1) facts.push({runId: "run_001", sequence: 1, occurredAt: NOW,
        source: {owner: "execution", kind: "resource_failure", id: "scope-1", revision: "6"}, data: {message: "resource cleanup failed"}});
      return {kind: "allow"};
    }});
    const result = await createRunner(controller, operations, {
      inputNotifications: {read: (runId, after) => facts.filter(fact => fact.runId === runId && fact.sequence > after)},
    }).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(checks).toBe(2);
    expect(controller.calls).toHaveLength(2);
    expect(result.items.filter(item => item.payload.kind === "completion_acceptance")).toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement").map(item => item.payload.result.settlement))
      .toEqual(["invalidated", "succeeded"]);
  });

  it("delivers preexisting facts once without requiring a redundant ending turn", async () => {
    const operations = createOperationFixture([]);
    const fact: RunInputNotification = {runId: "run_001", sequence: 3, occurredAt: NOW,
      source: {owner: "execution", kind: "command_completed", id: "command-1", revision: "9"}, data: {exitCode: 0}};
    const controller = new ScriptedController([input => {
      expect(JSON.stringify(input.context)).toContain("command_completed");
      return completionWithCalls([], "Already current", "current-final");
    }]);
    const result = await createRunner(controller, operations, {
      inputNotifications: {read: (runId, after) => runId === fact.runId && after < fact.sequence ? [fact] : []},
    }).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter(item => item.payload.kind === "input_notification")).toHaveLength(1);
  });

  it("fails rather than accepting an ending proposal when its notification source is unavailable", async () => {
    const operations = createOperationFixture([]);
    let failed = false;
    const controller = new ScriptedController([() => {failed = true; return completionWithCalls([], "Candidate", "unavailable-final");}]);
    const result = await createRunner(controller, operations, {
      inputNotifications: {read: () => {if (failed) throw new Error("execution source lost"); return [];}},
    }).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status).toBe("failed");
    expect(result.items.filter(item => item.payload.kind === "completion_acceptance")).toHaveLength(0);
  });

  it("processes Plan-only calls through shared admission without Tool execution or feedback", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      updateState({
        explanation: "Inspect before completing.",
        plan: [{ step: "Inspect state", status: "in_progress" }],
      }, "model_plan_1"),
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.items.filter(item => item.payload.kind === "controller_turn").map(item =>
      item.payload.kind === "controller_turn" ? item.payload.decisionKind : null,
    )).toEqual(["advance", "propose_completion"]);
    expect(result.items.some(item => item.payload.kind === "controller_feedback")).toBe(false);
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement")).toHaveLength(1);
    const coreSteps = recordedFlows.filter(fact => fact.kind === "step_entered" && fact.definition.id === "run-execution");
    expect(coreSteps.some(fact => "stepId" in fact && fact.stepId === "dispatch")).toBe(true);
    const capturedInputs = recordedFlows.filter(fact => fact.kind === "material" && fact.name === "Controller input");
    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0]!.value).toMatchObject({input: {plan: null}});
    expect(capturedInputs[1]!.value).toMatchObject({input: {plan: controller.calls[1]!.plan, interaction: controller.calls[1]!.interaction}});
    expect(capturedInputs[1]!.value).toMatchObject({input: {plan: {status: "active"}}});
    expect(result.items.some(({ payload }) =>
      payload.kind === "state_transition" && payload.transition === "plan"
    )).toBe(true);
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ kind: "plan_update" }),
    }));
    expect(result.items.filter(({ payload }) =>
      payload.kind === "state_transition" && payload.transition === "plan"
    ).map(({ payload }) => payload.kind === "state_transition" && payload.transition === "plan"
      ? payload.plan.status
      : null)).toEqual(["active", "abandoned"]);
  });

  it("settles an invalid standalone Plan update without losing the call or fabricating completion", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      updateState({ plan: [{ step: "Invalid status", status: "unknown" }] }, "invalid_plan"),
      (input) => {
        expect(input.plan).toBeNull();
        expect(input.interaction.unsettledCalls).toEqual([]);
        expect(input.interaction.settledCallCount).toBe(1);
        return complete("Handled rejected update", "after_invalid_plan");
      },
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result.status).toBe("completed");
    expect(result.items.filter(item => item.payload.kind === "model_call_settlement")).toHaveLength(1);
    expect(result.items.some(item => item.payload.kind === "state_transition" && item.payload.transition === "plan")).toBe(false);
    expect(result.items.some(item => item.payload.kind === "controller_feedback")).toBe(false);
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
      updateState(planCandidate().input, "model_plan_1"),
      updateState(planCandidate().input, "model_plan_2"),
      complete("Plan work is complete", "model_complete_3"),
    ]);

    const result = await createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => events.push(event) },
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
          maxIterations: 3,
          maxActions: 4,
        },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(controller.calls).toHaveLength(3);
    expect(result.items.filter(({ payload }) =>
      payload.kind === "state_transition" && payload.transition === "plan"
    )).toHaveLength(2);
    expect(result.items.at(-1)?.payload).toMatchObject({
      kind: "terminal_transition",
      status: "completed",
    });
  });

  it("continues the ordinary Loop after Plan state and a new owner result", async () => {
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
      updateState({
        explanation: "Start with a declaration.",
        plan: [{ step: "Inspect", status: "in_progress" }],
      }, "model_plan_1"),
      advance([operationCandidate(operation, {})], "model_operation"),
      complete("Completed after inspection", "model_complete"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        limits: {
        },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.items.some(({ payload }) =>
      payload.kind === "observation" && payload.observation.kind === "operation"
    )).toBe(true);
    expect(result.finalOutput).toEqual({ summary: "Completed after inspection" });
  });

  it("lets an unknown Operation effect determine settlement after advisory Plan state", async () => {
    const operation = operationRef("unknown-effect-after-correction");
    const actionExecution = createDirectActionExecutionFixture(operation, {
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
      updateState({
        explanation: "Start with a declaration.",
        plan: [{ step: "Inspect", status: "in_progress" }],
      }, "model_plan_1"),
      advance([operationCandidate(operation, { target: "workspace" })], "model_operation"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: createDirectActionExecutionConfig(),
        limits: {
        },
      }),
    );

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      status: "failed",
      cause: {
        kind: "failure",
        failure: {
          kind: "operation",
          failure: { owner: "executor", code: "executor_connection_lost" },
        },
      },
    });
    expect(actionExecution.execute).toHaveBeenCalledTimes(1);
    const settlementIndex = result.items.findIndex(({ payload }) =>
      payload.kind === "model_call_settlement" &&
      payload.result.modelCallRef.id === "model_operation"
    );
    const terminalIndex = result.items.findIndex(({ payload }) =>
      payload.kind === "terminal_transition" &&
      payload.cause.kind === "failure" &&
      payload.cause.failure.kind === "operation" &&
      payload.cause.failure.failure.code === "executor_connection_lost"
    );
    expect(settlementIndex).toBeGreaterThanOrEqual(0);
    expect(result.items[settlementIndex]?.payload).toMatchObject({
      kind: "model_call_settlement",
      result: { settlement: "failed", content: {
        status: "unknown_effect", effectCertainty: "unknown", completionExtent: "unknown",
      } },
    });
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
    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(handle.getSnapshot().pendingInteractions).toEqual([]);
  });

  it("preserves later work from the same decision after Interaction settlement", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const tools = createSemanticToolSelection(operations, "AskUserQuestion", {
      kind: "interaction", protocol: interaction.ref, blockingScope: "run", revision: "interaction-binding-1",
    });
    const controller = new ScriptedController([
      (input) => advance([
        toolCandidate("AskUserQuestion", { question: "First?" }, input.toolExposure.controllerRequestId),
        toolCandidate("AskUserQuestion", { question: "Second?" }, input.toolExposure.controllerRequestId),
      ], ["ask", "after"]),
      complete("Done"),
    ]);
    const handle = createRunner(controller, operations, { interactions: interaction.registry })
      .start(createAgent(), createRunInput(), createRunConfig(operations, { tools }));
    let previous = "";
    for (let index = 0; index < 2; index += 1) {
      await waitUntil(() => handle.getSnapshot().pendingInteractions.some((entry) => entry.envelope.request.id !== previous));
      const pending = handle.getSnapshot().pendingInteractions.find((entry) => entry.envelope.request.id !== previous)!;
      previous = pending.envelope.request.id;
      handle.submitInteraction({ request: pending.envelope.request, submissionId: `answer-${index}`,
        contentDigest: `sha256:answer-${index}`, payload: { accepted: true }, receivedAt: NOW });
    }
    const result = await handle.wait();
    expect(result.status).toBe("completed");
    expect(controller.calls).toHaveLength(2);
    expect(result.items.flatMap(({ payload }) => payload.kind === "model_call_settlement" ? [payload.result.settlement] : []))
      .toEqual(["succeeded", "succeeded"]);
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
      status: "completed",
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
      status: "completed",
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
      (input) => advance([{
        kind: "state_transition",
        transition: "handoff",
        input: {
          expectedRunRevision: Number(input.interaction.revision),
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
          effectiveFromRunRevision: expect.any(Number),
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_specialist", revision: "2" },
      status: "completed",
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
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

  it.each(["operation", "tool", "composite"] as const)("returns actual approval quota rejection through %s feedback without redispatch", async route => {
    const operation = operationRef("approval-limited-write");
    const actionExecution = createDirectActionExecutionFixture(operation, undefined, {
      category: "fileChange", environmentId: "test-local", applicabilityKeys: [], reason: "Review file change.",
      payload: {changes: [{operation: "update", canonicalPath: "D:/workspace/README.md", displayPath: "README.md",
        destinationCanonicalPath: null, destinationDisplayPath: null, baselineFingerprint: SHA_A}],
        baselineFingerprint: SHA_A, additionalPermissions: null},
      decisionOptions: [{id: "accept.action", kind: "accept", scope: "action", label: "Approve once",
        description: null, trustedProposalRef: null, metadata: {}}],
      trustedProposals: [], deadlineAt: "2026-08-13T00:01:00.000Z", metadata: {},
    });
    const compositeOperation = operationRef("approval-limited-composite");
    const definition = snapshotCompositeDefinition({
      ref: {id: "approval-limited-composite", revision: "1"}, inputSchemaRevision: "input-1",
      resultSchemaRevision: "result-1", graphRevision: "graph-1",
      nodes: [{id: "write", operation, allowedBindings: ["direct"], dependencies: [], transformId: "identity",
        conditionId: null, resourceClaims: [], required: true}],
      join: {kind: "all_required_succeeded"}, reducerId: "collect", conflictPolicyRevision: "conflict-1",
      limits: {maxNodes: 1, maxParallel: 1}, cancellationPolicy: "cancel_unstarted_and_signal_active",
      sensitivity: "internal", retiredAt: null,
    });
    const operations = createOperationFixture([
      operationSpec(operation, "direct", {requestOrigins: ["tool_request", "controller_protocol", "trusted_workflow"],
        actionAdapterId: actionExecution.adapterId}),
      operationSpec(compositeOperation, "composite", {requestOrigins: ["controller_protocol"], compositeDefinitionRef: "approval-limited-composite"}),
    ], [], {actionExecution: actionExecution.dependencies, composite: {resolve: () => ({definition, execution: {
      transforms: [{id: "identity", transform: ({compositeInput}) => compositeInput}], conditions: [],
      reducer: {id: "collect", reduce: () => ({status: "succeeded", output: {written: true}, failure: null})}, conflicts: null,
    }})}});
    const tools = createToolSelection(operations, operation, "LimitedWrite");
    const request = (input: ControllerInput, id: string) => advance([route === "tool"
      ? toolCandidate("LimitedWrite", {}, input.toolExposure.controllerRequestId)
      : operationCandidate(route === "composite" ? compositeOperation : operation, {})], id);
    const assertRejection = (input: ControllerInput) => {
      const last = input.interaction.messages.filter(message => message.role === "tool").at(-1);
      const detail = {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
        limit: {name: "equivalent_operation_requests", count: 1, maximum: 1}, dispatch: "never_dispatched",
        description: expect.stringContaining("Retrying does not reset this cumulative quota.")};
      const failure = {owner: "agent-runtime", code: "approval_tree_operation_limit_exceeded", detail};
      expect(last).toMatchObject({content: [{result: {content: route === "composite"
        ? {status: "failed", composite: {children: [{nodeId: "write", effectCertainty: "none", completionExtent: "none", failure}]}}
        : {status: "failed", effectCertainty: "none", completionExtent: "none", failure},
      }}]});
    };
    let reviews = 0;
    const controller = new ScriptedController([
      input => request(input, "first-approved"),
      input => request(input, "quota-rejected"),
      input => { assertRejection(input); return request(input, "quota-still-rejected"); },
      input => { assertRejection(input); return complete("Capacity rejection observed", "done"); },
    ]);
    const config = createRunConfig(operations, {tools, actionExecution: createDirectActionExecutionConfig()});
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(), {
      ...config, runTreeApprovals: {...config.runTreeApprovals, maxTotalRequests: null, maxRequestsPerOperationFingerprint: 1},
      permissions: {...config.permissions, approvalPolicy: "on-request", reviewer: {
        kind: "auto_review", bindingId: "quota-test-reviewer", reviewTimeoutMs: 1_000,
        descriptor: {id: "quota-test-reviewer", kind: "auto_review", displayName: "Test reviewer", source: "test", metadata: {}},
        reviewer: {async review(input: import("@agent-anything/permission").ApprovalReviewInput) {
          reviews += 1;
          return {status: "decided", submission: {submissionId: "approved", runId: input.request.runId,
            requestId: input.request.id, pendingVersion: input.pendingVersion, optionId: "accept.action",
            grantedPermissions: null, reason: null}, rationale: null};
        }},
      }},
    });
    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(reviews).toBe(1);
    expect(actionExecution.execute).toHaveBeenCalledTimes(1);
    expect(controller.calls).toHaveLength(4);
  });

  it.each([false, true])("projects bounded limit detail into operation and Tool results (tool=%s)", async throughTool => {
    const operation = operationRef("limit-detail-projection");
    const handler = internalHandler("limit-detail-projection", "code-workspace", {});
    const detail = {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
      limit: {name: "total_requests", count: 8, maximum: 8}, dispatch: "never_dispatched",
      description: "Approval capacity reached; action was never dispatched."} as const;
    handler.execute.mockImplementation(async context => createOperationResult({
      ref: {invocation: context.binding.invocation, id: "quota-rejection"}, binding: context.binding.binding,
      semanticOwner: "code-workspace", status: "failed", output: null,
      failure: {owner: "agent-runtime", code: "approval_tree_total_limit_exceeded", message: detail.description,
        detail: {...detail, private: "not-for-model"}, retryable: false, metadata: {secret: "not-for-model"}},
      startedAt: NOW, finishedAt: NOW,
      lowerRefs: [{owner: "canonical-action", kind: "action_settlement", id: "not-dispatched", revision: "1"}],
      metadata: {effectCertainty: "none", completionExtent: "none"},
    }));
    const operations = createOperationFixture([operationSpec(operation, "internal", {
      requestOrigins: ["tool_request", "controller_protocol"], handlerId: handler.id,
    })], [handler]);
    const tools = createToolSelection(operations, operation, "LimitedTool");
    const controller = new ScriptedController([
      input => advance([throughTool
        ? toolCandidate("LimitedTool", {}, input.toolExposure.controllerRequestId)
        : operationCandidate(operation, {})], "limit-request"),
      input => {
        const messages = input.interaction.messages.filter(message => message.role === "tool");
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({content: [{result: {content: {
          status: "failed", effectCertainty: "none", completionExtent: "none",
          failure: {owner: "agent-runtime", code: "approval_tree_total_limit_exceeded", detail},
        }}}]});
        expect(JSON.stringify(messages)).not.toContain("not-for-model");
        return complete("Rejection observed", "complete-after-limit");
      },
    ]);
    const result = await createRunner(controller, operations).run(createAgent(), createRunInput(),
      createRunConfig(operations, {tools}));
    expect(result.status).toBe("completed");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    if (throughTool) {
      expect(observations(result).find(item => item.payload.kind === "operation")?.payload)
        .toMatchObject({toolResult: {status: "failed", error: {detail}}});
    }
  });

  it.each([false, true])("returns Composite settlement details to the next turn (child rejected: %s)", async rejected => {
    const composite = operationRef("inspect-workspace");
    const child = operationRef("read-metadata");
    const childHandler = internalHandler("handler.read-metadata", "code-workspace", {
      files: 3,
    });
    if (rejected) childHandler.execute.mockImplementation(async context => createOperationResult({
      ref: {invocation: context.binding.invocation, id: "rejected-result"}, binding: context.binding.binding,
      semanticOwner: "code-workspace", status: "invalid", output: null,
      failure: {owner: "permission", code: "interaction_expired", message: "Approval expired before dispatch.", retryable: false, metadata: {private: "not-for-model"}},
      startedAt: NOW, finishedAt: NOW,
      lowerRefs: [{owner: "canonical-action", kind: "action_settlement", id: "not-dispatched", revision: "1"}],
      metadata: {effectCertainty: "none", completionExtent: "none"},
    }));
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
      }, {
        id: "consume-metadata", operation: child, allowedBindings: ["internal"],
        dependencies: [{ nodeId: "read-metadata", requirement: "succeeded" }],
        transformId: "consume-result", conditionId: null, resourceClaims: [], required: true,
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
              }, {
                id: "consume-result",
                transform({ dependencies }) {
                  expect(dependencies["read-metadata"]?.result?.output).toEqual({ files: 3 });
                  return dependencies["read-metadata"]!.result!.output;
                },
              }],
              conditions: [],
              reducer: {
                id: "collect-results",
                reduce({ children }) {
                  return { status: "succeeded", output: { childStatuses: children.map(({ status }) => status) }, failure: null };
                },
              },
              conflicts: null,
            },
          };
        },
      },
    });
    const controller = new ScriptedController([
      ...Array.from({length: 5}, (_, index) => advance([operationCandidate(composite, { path: "." })], `model_operation_${index}`)),
      input => {
        const results = input.interaction.messages.filter(message => message.role === "tool");
        expect(results).toHaveLength(5);
        expect(results.at(-1)).toMatchObject({content: [{result: {content: {
          status: rejected ? "failed" : "succeeded",
          composite: {childCount: 2, omittedChildCount: 0, children: expect.arrayContaining([
            expect.objectContaining(rejected ? {nodeId: "read-metadata", status: "invalid", effectCertainty: "none", completionExtent: "none",
              failure: expect.objectContaining({owner: "permission", code: "interaction_expired"})} : {nodeId: "read-metadata", status: "succeeded"}),
          ])},
        }}}]});
        expect(JSON.stringify(results)).not.toContain("not-for-model");
        return complete("Composite complete", "model_complete_2");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {limits: {maxConsecutiveActionFailures: 5}}),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(childHandler.execute).toHaveBeenCalledTimes(rejected ? 5 : 10);
    expect(controller.calls).toHaveLength(6);
    expect(recordedFailureCounts()).toEqual(rejected ? [0, 1, 2, 3, 4, 5] : [0, 0, 0, 0, 0, 0]);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(rejected ? 10 : 15);
    expect(observations(result).filter(({ payload }) => payload.kind === "operation"))
      .toHaveLength(rejected ? 10 : 15);
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
      cause: {
        kind: "cancellation",
        code: "runtime_cancelled",
        cancellation: { origin: "user", reasonCode: "user_requested" },
      },
    });
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" && payload.status === "completed"
    )).toBe(false);
  });

  it("normally ends an honest limitation reply without creating a suspension or claiming success", async () => {
    const operations = createOperationFixture([]);
    const events: RuntimeEvent[] = [];
    const controller = new ScriptedController([{ candidates: [], completionSource: {kind: "controller" as const},
      kind: "propose_completion",
      output: {summary: "No useful continuation remains."},
      modelItems: modelTextItems("model_stop_1", "No useful continuation remains."),
    }]);
    const handle = createRunner(controller, operations, {
      runtimeEventPublisher: { publish: (event) => { events.push(event); } },
    }).start(createAgent(), createRunInput(), createRunConfig(operations));
    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "completed", finalOutput: { summary: "No useful continuation remains." },
      cause: { kind: "completion", code: "completion_accepted" },
    });
    expect(handle.getSnapshot()).toMatchObject({ status: "completed", suspension: null });
    expect(handle.getSnapshot().runTree.settlement.complete).toBe(true);
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "terminal_transition")).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "suspension_transition")).toHaveLength(0);
    expect(events.filter(({ name }) => name === "run.completed")).toHaveLength(1);
    expect(events.filter(({ name }) => name === "run.failed")).toHaveLength(0);
    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status).toBe("run_settled");
    expect(handle.getResult()).toBe(result);
  });

  it.each(["Work delivered", "No useful work remains."])("accepts cancellation during finalization without returning to Controller: %s", async (summary) => {
    const operations = createOperationFixture([]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new ScriptedController([complete(summary)]);
    const handle = createRunner(controller, operations, {
      resourceFinalizers: [{ async finalize() { entered.resolve(); await release.promise; return null; } }],
    }).start(createAgent(), createRunInput(), createRunConfig(operations));
    await entered.promise;
    expect(handle.steer({
      commandId: "late-steering",
      expectedRunRevision: handle.getSnapshot().runRevision,
      instruction: "Reopen progression",
      attribution: { origin: "user", actorId: null },
      submittedAt: NOW,
    })).toMatchObject({ status: "rejected", code: "run_settling" });
    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status).toBe("accepted");
    release.resolve();
    const result = await handle.wait();
    expect(result.status).toBe("cancelled");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "terminal_transition")).toHaveLength(1);
  });

  it("settles finalization failure after an accepted stop without another Controller turn", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([{ candidates: [], completionSource: {kind: "controller" as const},
      kind: "propose_completion", output: {summary: "No useful work remains."},
      modelItems: modelTextItems("model_stop", "No useful work remains."),
    }]);
    const result = await createRunner(controller, operations, {
      resourceFinalizers: [{ async finalize() { throw new Error("Cleanup failed"); } }],
    }).run(createAgent(), createRunInput(), createRunConfig(operations));
    expect(result).toMatchObject({ status: "failed", cause: { failure: { failure: { code: "runtime_resource_finalization_failed" } } } });
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter(({ payload }) => payload.kind === "terminal_transition")).toHaveLength(1);
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
    expect(result).toMatchObject({ status: "completed", finalOutput: { summary: "observed" } });
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
      cause: {
        kind: "failure",
        failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "contextBytes" },
        },
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
      cause: {
        kind: "failure",
        failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "contextBytes" },
        },
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
      cause: {
        kind: "failure",
        failure: {
        kind: "runtime",
        failure: {
          code: "runtime_tree_resource_limit_exceeded",
          metadata: { dimension: "resultBytes" },
        },
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
    toolInputSemanticValidators: Object.freeze([]),
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
        const candidate = input.toolCall.input as { readonly prompt?: unknown };
        if (typeof candidate.prompt !== "string" || candidate.prompt.length === 0) {
          throw new TypeError("Test delegation requires a prompt.");
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
            authorityRestriction: null,
            allocationRequest: limits,
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
    progressProjection: Object.freeze({
      project({ progress }) {
        return Object.freeze({
          status: "succeeded" as const,
          output: Object.freeze({
            agent_id: progress.childRun.id,
            status: "suspended",
            child_run_revision: progress.childRunRevision,
          }),
          failure: null,
        });
      },
    }),
    resultProjection: Object.freeze({
      project({ result, continuation }) {
        const output = Object.freeze({
          summary: result.narrative?.text ?? "",
          ...(continuation === null ? {} : { agent_id: continuation.id }),
        });
        return result.terminal.status === "completed"
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
    readonly binding: ToolBindingRef;
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
    interactions: createInteractionProtocolRegistrySnapshot("interaction-registry-1", []),
    now: () => NOW,
    createRunId: () => `run_${String(++runSequence).padStart(3, "0")}`,
    executionFlow: {observer:{observe:fact=>{recordedFlows.push(fact);}}},
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
  return { candidates: [], completionSource: {kind: "controller" as const},
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
      candidate.kind === "tool_request" && isRecord(candidate.tool) &&
          typeof candidate.tool.controllerRequestId === "string"
        ? candidate.tool.controllerRequestId
        : `${turnId}:controller`,
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

function updateState(input: unknown, modelCallId: string): ControllerDecision<TestOutput> {
  return advance([{ kind: "state_transition", transition: "plan_update", input }], modelCallId);
}

function completionWithCalls(candidates: readonly Readonly<Record<string, unknown>>[], summary: string, id: string, finalFirst = false): ControllerDecision<TestOutput> {
  const turnId = `${id}:turn`, providerRequestId = `${id}:request`;
  const normalized = candidates.map((candidate, index) => ({...candidate,
    modelCallRef: testModelCallRef(`${id}:call:${index}`, turnId, providerRequestId, index + (finalFirst ? 1 : 0), `${turnId}:controller`)}));
  const ordinal = finalFirst ? 0 : candidates.length;
  const final = {name: "final_result", input: {response: summary}, ordinal, providerCallRef: null,
    modelCallRef: testModelCallRef(`${id}:final`, turnId, providerRequestId, ordinal, `${turnId}:controller`)};
  const calls = normalized.map(candidate => candidateModelToolCall(candidate, candidate.modelCallRef.contentBlockOrdinal));
  const ordered = finalFirst ? [final, ...calls] : [...calls, final];
  return {kind: "propose_completion", candidates: normalized as unknown as import("../controller/index.js").ProgressionCandidate[],
    completionSource: {kind: "model_call", modelCallRef: final.modelCallRef}, output: {summary},
    modelItems: createControllerModelItems({turnId, assistant: {role: "assistant", content: ordered.map(call => ({kind: "model_tool_call", call}))},
      finish: {kind: "normal"}, usage: null, responseRef: {providerId: "scripted-controller", requestId: providerRequestId, responseId: `${id}:response`}})};
}

function completionWithPlan(
  plan: readonly {step: string; status: string}[], summary: string, id: string,
  coCalls: readonly Readonly<Record<string, unknown>>[] = [], finalFirst = false,
): ControllerDecision<TestOutput> {
  const decision = completionWithCalls(coCalls, summary, id, finalFirst);
  if (decision.kind !== "propose_completion" || decision.completionSource.kind !== "model_call") throw new Error("Expected model completion.");
  const ref = decision.completionSource.modelCallRef;
  return {...decision, candidates: [...decision.candidates, {
    kind: "state_transition" as const, transition: "plan_update" as const, input: {plan}, modelCallRef: ref,
  }].sort((left, right) => left.modelCallRef.contentBlockOrdinal - right.modelCallRef.contentBlockOrdinal),
  modelItems: decision.modelItems.map(item => item.kind === "model_tool_call" && item.call.modelCallRef.id === ref.id
    ? {...item, call: {...item.call, input: {response: summary, plan: plan.map(step => ({...step}))}}} : item)};
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
  controllerRequestId: string,
): ModelCallRef {
  return Object.freeze({
    id,
    providerRequestId,
    controllerRequestId,
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
  if (candidate.kind === "model_call_rejection") {
    return scriptedModelToolCall(candidate.modelCallRef, String(candidate.name), {}, ordinal);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hostResumeRoute(active: ActiveDelegationProjection, id: string) {
  if (active.suspension === null) {
    throw new TypeError("The active descendant is not suspended.");
  }
  return {
    request: active.request,
    relation: active.relation,
    child: active.child,
    resume: {
      id,
      expectedRunRevision: active.childRunRevision,
      suspension: active.suspension.ref,
      origin: "host" as const,
      reason: "Resume the suspended Child from the Host.",
    },
  };
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

function createDirectActionExecutionFixture(
  operation: OperationRevisionRef,
  physicalOutcome: PhysicalAttemptOutcome<{ passed: boolean }> = {
    status: "completed",
    effectState: "settled",
    payload: { passed: true },
  },
  approval: import("@agent-anything/permission/approval").ApprovalRequirementDraft | null = null,
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
    executionLifetime: "invocation",
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
              operation: approval === null ? "read" : "write",
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
          approval,
          safeSummary: {
            kind: "file_system",
            headline: "Validate workspace state",
            operations: [{
              operation: approval === null ? "read" : "update",
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
              message: settlement.failureDetail?.description ?? settlement.causeRef ?? settlement.status,
              ...(settlement.failureDetail === undefined ? {} : {detail: settlement.failureDetail}),
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

function createDirectActionExecutionConfig(): NonNullable<RunConfig["actionExecution"]> {
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
