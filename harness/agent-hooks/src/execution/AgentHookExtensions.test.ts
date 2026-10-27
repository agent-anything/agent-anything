import { describe, expect, it, vi } from "vitest";
import type {
  TaskDecisionActivity,
  AgentActivityExecutionContext,
  TaskDecisionProposal,
  TaskDecisionInputSources,
} from "@agent-anything/agent-runtime/decision";
import {
  createAgentHookComposition,
  createEmptyAgentHookComposition,
  type AgentHookBinding,
  type AgentHookRegistration,
  type AgentStopHandler,
  type AgentStopObserver,
  type AgentStopFailureObserver,
} from "../composition/index.js";
import { AgentHookExtensions } from "./AgentHookExtensions.js";
import { AgentHookExecutionStore } from "./AgentHookExecution.js";
import { validateAgentHookCheckpoint, type AgentHookRecordPort, type AgentHookInvocationCheckpoint } from "./AgentHookRecordPort.js";
import { ActivityCheckpointError, type ActivityCheckpointPort } from "@agent-anything/agent-runtime/activity";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";

const NOW = "2026-09-04T00:00:00.000Z";

class HookExecutionFixture extends AgentHookExtensions<TestOutput> {
  constructor(private readonly fixture: import("./AgentHookExtensions.js").AgentHookExtensionsOptions<TestOutput> & {
    controller: TaskDecisionActivity<TestOutput>;
  }) {super({...fixture, prior: fixture.controller as TaskDecisionActivity<TestOutput> & import("@agent-anything/agent-runtime/execution-coordinator").AgentExecutionExtensions<TestOutput>});}
  async next(input: TaskDecisionInputSources<TestOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TestOutput>> {
    let decision: TaskDecisionProposal<TestOutput>;
    try {decision = await this.fixture.controller.next(input, context);}
    catch (error) {await this.onDecisionFailure(input, error, context); throw error;}
    await this.afterDecision(input, decision, context);
    return decision;
  }
}

interface TestOutput {
  readonly summary: string;
}

class FakeController implements TaskDecisionActivity<TestOutput> {
  readonly resourceMetering = Object.freeze({
    modelInputTokens: "not_applicable" as const,
    modelOutputTokens: "not_applicable" as const,
    costUnits: "not_applicable" as const,
  });

  constructor(
    private readonly execute: (
      input: TaskDecisionInputSources<TestOutput>,
      context: AgentActivityExecutionContext,
    ) => Promise<TaskDecisionProposal<TestOutput>> | TaskDecisionProposal<TestOutput>,
  ) {}

  next(
    input: TaskDecisionInputSources<TestOutput>,
    context: AgentActivityExecutionContext,
  ): Promise<TaskDecisionProposal<TestOutput>> {
    return Promise.resolve(this.execute(input, context));
  }
}

describe("AgentHookExtensions", () => {
  it.each(["intent", "outcome", "aggregate"] as const)("recovers a Hook %s acknowledgement loss without replay or resetting feedback count", async stage => {
    const values = new Map<string, unknown>();
    let lose = true;
    const port: ActivityCheckpointPort = {read: key => structuredClone(values.get(key) ?? null), commit: async (key, value) => {
      values.set(key, structuredClone(value));
      const record = value as {outcome?: unknown; completion?: unknown};
      if (lose && (stage === "intent" && key.startsWith('["hook"') && record.outcome === null ||
          stage === "outcome" && key.startsWith('["hook"') && record.outcome != null ||
          stage === "aggregate" && key === "agent-hooks:state" && record.completion != null)) {
        lose = false;
        throw new ActivityCheckpointError(key);
      }
    }};
    const execute = vi.fn(() => ({disposition: "continue" as const, code: "check", message: "Check one result."}));
    const make = () => new HookExecutionFixture({controller: new FakeController(() => complete("Done")),
      composition: stopComposition([handler("stop", execute)]), rootRunId: "run-1", maxConsecutiveContinuations: 1, now: () => NOW});
    const context = {...callContext(), checkpoints: port, runCheckpoints: port};
    const notification = completionInput(controllerInput(), complete("Done"));
    await expect(make().beforeCompletion(notification, context)).rejects.toBeInstanceOf(ActivityCheckpointError);
    const resumed = make();
    const disposition = await resumed.recoverBeforeCompletion(notification, context);
    expect(execute).toHaveBeenCalledTimes(stage === "intent" ? 0 : 1);
    expect(disposition.kind).toBe(stage === "intent" ? "allow" : "continue_with_feedback");
    if (stage === "intent") expect(resumed.store.getProjection().recentInvocations[0]).toMatchObject({status: "failed", message: expect.stringContaining("not replayed")});
    if (stage !== "intent") {
      const nextContext = {...context, checkpoints: memoryCheckpoints()};
      const next = completionInput(controllerInput(2), complete("Done"));
      await expect(make().beforeCompletion({...next, turn: {...next.turn, id: "next-turn"}}, nextContext)).resolves.toEqual({kind: "allow"});
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("settles background observer records independently after the completion callback closes", async () => {
    const records = hookRecords();
    let release!: () => void;
    const done = new Promise<void>(resolve => {release = resolve;});
    const observe = vi.fn(() => done);
    const port = memoryCheckpoints();
    let invocationClosed = false;
    const context = {...callContext(), runCheckpoints: port, checkpoints: {read: port.read,
      commit: async (key: string, value: unknown) => {if (invocationClosed) throw new Error("Run is terminal"); await port.commit(key, value);}}};
    const controller = new HookExecutionFixture({controller: new FakeController(() => complete("Done")), rootRunId: "run-1",
      composition: stopComposition([backgroundObserver("observe", observe)]), invocationRecords: records, now: () => NOW});
    await expect(controller.beforeCompletion(completionInput(controllerInput(), complete("Done")), context)).resolves.toEqual({kind: "allow"});
    invocationClosed = true;
    expect([...records.values.values()][0]?.outcome).toBeNull();
    release();
    await vi.waitFor(() => expect([...records.values.values()][0]?.outcome?.status).toBe("completed"));
    expect(controller.store.getProjection().recentInvocations[0]?.status).toBe("completed");
  });

  it("retains invalid Handler output as output_invalid rather than a serialization failure", async () => {
    const records = hookRecords();
    const controller = new HookExecutionFixture({controller: new FakeController(() => complete("Done")), rootRunId: "run-1",
      composition: stopComposition([handler("invalid", () => ({disposition: "allow", nested: () => {}}) as unknown as {disposition: "allow"})]),
      invocationRecords: records, now: () => NOW});
    await expect(controller.beforeCompletion(completionInput(controllerInput(), complete("Done")), callContext())).resolves.toEqual({kind: "allow"});
    expect([...records.values.values()][0]?.outcome?.status).toBe("output_invalid");
  });
  it("binds Stop and StopFailure to Controller requests rather than Context projection requests", async () => {
    const stop = vi.fn((_event: Parameters<AgentStopHandler["handle"]>[0]) => ({disposition: "allow" as const}));
    const failure = vi.fn();
    const input = controllerInput();
    expect(input.toolExposure.controllerRequestId).not.toBe(input.contextManifest.requestId);
    const normal = new HookExecutionFixture({controller: new FakeController(() => complete("Done")), composition: stopComposition([handler("stop", stop)]), rootRunId: "run-1", now: () => NOW});
    await finish(normal, input, callContext());
    expect(stop.mock.calls[0]?.[0]).toMatchObject({controllerRequestId: input.toolExposure.controllerRequestId});
    const failed = new HookExecutionFixture({controller: new FakeController(() => {throw new Error("Failed");}), composition: stopFailureComposition(failure), rootRunId: "run-1", now: () => NOW});
    await expect(failed.next(input, callContext())).rejects.toThrow("Failed");
    expect(failure.mock.calls[0]?.[0]).toMatchObject({controllerRequestId: input.toolExposure.controllerRequestId});
  });
  it("records candidate short circuits and Handler material without adding Hook execution", async () => {
    for (const decision of [complete("Done"), {kind: "advance" as const, candidates: [], modelItems: []}]) {
      const facts: ExecutionFlowObservation[] = [];
      const controller = new HookExecutionFixture({controller: new FakeController(() => decision), rootRunId: "run-1"});
      const context = {...callContext(), executionFlow: {observer: {observe: (fact: ExecutionFlowObservation) => {facts.push(fact);}}}};
      expect(await controller.next(controllerInput(), context)).toBe(decision);
      expect(controller.store.getProjection().invocationCount).toBe(0);
      if (decision.kind === "propose_completion") await controller.beforeCompletion(completionInput(controllerInput(), decision), context);
      const checks = facts.filter(fact => fact.kind === "constraint" && fact.stepId === "candidate");
      expect(checks.map(check => check.checkId)).toEqual(decision.kind === "propose_completion" ? ["registered_handlers", "continuation_allowance"] : []);
      expect(facts.some(fact => fact.kind === "material" && fact.name === "Completion disposition")).toBe(decision.kind === "propose_completion");
      expect(controller.store.getProjection().invocationCount).toBe(0);
    }
  });
  it("preserves a normal completion after one actionable continuation and a later allow", async () => {
    let calls = 0;
    const decision = complete("No useful work remains.");
    const controller = new HookExecutionFixture({
      controller: new FakeController(() => decision),
      composition: stopComposition([handler("stop", () => ++calls === 1
        ? { disposition: "continue", code: "one_more_check", message: "Check the last settled result." }
        : { disposition: "allow" })]),
      rootRunId: "run-1", now: () => NOW,
    });
    await expect(finish(controller, controllerInput(), callContext())).resolves.toMatchObject({ kind: "continue_with_feedback" });
    await expect(finish(controller, controllerInput(2), callContext())).resolves.toEqual({kind: "allow"});
    expect(calls).toBe(2);
  });
  it("isolates projection listener failures from Agent execution", () => {
    const store = new AgentHookExecutionStore();

    expect(() => store.subscribe(() => {
      throw new Error("Projection consumer failed.");
    })).not.toThrow();
  });

  it("preserves exact no-Hook Controller behavior", async () => {
    const decision = complete("Done");
    const controller = new HookExecutionFixture({
      controller: new FakeController(() => decision),
      composition: createEmptyAgentHookComposition(),
      rootRunId: "run-1",
      now: () => NOW,
    });

    await expect(controller.next(controllerInput(), callContext())).resolves.toBe(decision);
    await expect(controller.beforeCompletion(completionInput(controllerInput(), decision), callContext())).resolves.toEqual({kind: "allow"});
    expect(controller.store.getProjection().invocationCount).toBe(0);
  });

  it("does not turn an invalid inherited completion disposition into allow", async () => {
    const underlying = Object.assign(new FakeController(() => complete("Done")), {
      beforeCompletion: async () => undefined as unknown as import("@agent-anything/agent-runtime/decision").RunCompletionDisposition,
    });
    const controller = new HookExecutionFixture({controller: underlying, rootRunId: "run-1"});
    await expect(controller.beforeCompletion(completionInput(controllerInput(), complete("Done")), callContext()))
      .rejects.toThrow("Controller completion disposition is invalid");
  });

  it("combines blocking Stop continuation results in registration order", async () => {
    const controller = new HookExecutionFixture({
      controller: new FakeController(() => complete("Premature")),
      composition: stopComposition([
        handler("first", () => ({
          disposition: "continue",
          code: "missing_write",
          message: "Write the requested file.",
        })),
        handler("allow", () => ({ disposition: "allow" })),
        handler("second", () => ({
          disposition: "continue",
          code: "missing_run",
          message: "Run the requested program.",
        })),
      ]),
      rootRunId: "run-1",
      now: () => NOW,
    });

    await expect(finish(controller, controllerInput(), callContext())).resolves.toMatchObject({
      kind: "continue_with_feedback",
      feedback: {
        code: "missing_write+missing_run",
        message: "[missing_write] Write the requested file.\n[missing_run] Run the requested program.",
      },
    });
    expect(controller.store.getProjection().recentInvocations.map(({ status }) => status))
      .toEqual(["continued", "allowed", "continued"]);
  });

  it("preserves the candidate at the continuation cap without another model request", async () => {
    const next = vi.fn(() => complete("Still premature"));
    const controller = new HookExecutionFixture({
      controller: new FakeController(next),
      composition: stopComposition([handler("continue", () => ({
        disposition: "continue",
        code: "not_done",
        message: "Continue.",
      }))]),
      rootRunId: "run-1",
      maxConsecutiveContinuations: 1,
      now: () => NOW,
    });

    await expect(finish(controller, controllerInput(), callContext())).resolves.toMatchObject({
      kind: "continue_with_feedback",
    });
    await expect(finish(controller, controllerInput(2), callContext())).resolves.toEqual({kind: "allow"});
    expect(next).toHaveBeenCalledTimes(2);
    expect(controller.store.getProjection().invocationCount).toBe(1);
    expect(controller.store.getProjection().recentDispositions).toMatchObject([{ disposition: "continuation_limit_reached" }]);
  });

  it("fails open and records blocking Handler failure and timeout", async () => {
    const failing = new HookExecutionFixture({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([handler("failure", () => {
        throw new Error("Handler failed.");
      })]),
      rootRunId: "run-1",
      now: () => NOW,
    });
    await expect(finish(failing, controllerInput(), callContext())).resolves.toMatchObject({
      kind: "allow",
    });
    expect(failing.store.getProjection().recentInvocations[0]?.status).toBe("failed");

    const timedOut = new HookExecutionFixture({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([handler("timeout", () => new Promise(() => {}), 1)]),
      rootRunId: "run-1",
      now: () => NOW,
    });
    await expect(finish(timedOut, controllerInput(), callContext())).resolves.toMatchObject({
      kind: "allow",
    });
    expect(timedOut.store.getProjection().recentInvocations[0]?.status).toBe("timed_out");
  });

  it("lets background Stop observers finish without decision authority", async () => {
    let release!: () => void;
    const observed = new Promise<void>((resolve) => { release = resolve; });
    const observer = vi.fn(() => observed);
    const controller = new HookExecutionFixture({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([backgroundObserver("observer", observer)]),
      rootRunId: "run-1",
      now: () => NOW,
    });

    await expect(finish(controller, controllerInput(), callContext())).resolves.toMatchObject({
      kind: "allow",
    });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(controller.store.getProjection().invocationCount).toBe(0);
    release();
    await observed;
    await vi.waitFor(() => {
      expect(controller.store.getProjection().recentInvocations[0]?.status).toBe("completed");
    });
  });

  it("notifies StopFailure observers and rethrows the exact Controller error", async () => {
    const failure = new Error("Controller failed.");
    const observer = vi.fn();
    const controller = new HookExecutionFixture({
      controller: new FakeController(() => { throw failure; }),
      composition: stopFailureComposition(observer),
      rootRunId: "run-1",
      now: () => NOW,
    });

    let thrown: unknown;
    try {
      await controller.next(controllerInput(), callContext());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(controller.store.getProjection().recentInvocations[0]).toMatchObject({
      point: "StopFailure",
      status: "completed",
    });
  });
});

function memoryCheckpoints(): ActivityCheckpointPort {
  const values = new Map<string, unknown>();
  return {read: key => structuredClone(values.get(key) ?? null), commit: async (key, value) => {values.set(key, structuredClone(value));}};
}

function hookRecords(): AgentHookRecordPort & {values: Map<string, AgentHookInvocationCheckpoint>} {
  const values = new Map<string, AgentHookInvocationCheckpoint>();
  return {values, readHookInvocation: async id => structuredClone(values.get(id) ?? null), commitHookInvocation: async value => {
    validateAgentHookCheckpoint(value, values.get(value.id) ?? null);
    values.set(value.id, structuredClone(value));
  }};
}

type StopTestBinding =
  | { readonly registration: AgentHookRegistration; readonly binding: AgentHookBinding };

function completionInput(current: TaskDecisionInputSources<TestOutput>, decision: TaskDecisionProposal<TestOutput>) {
  if (decision.kind !== "propose_completion") throw new Error("Expected completion fixture.");
  return {current, output: decision.output, completionSource: decision.completionSource, settlements: [], stateRevision: 10,
    turn: {run: {id: current.runId}, id: "controller-turn", sequence: current.iteration}};
}

async function finish(controller: HookExecutionFixture, current: TaskDecisionInputSources<TestOutput>, context: AgentActivityExecutionContext) {
  const decision = await controller.next(current, context);
  return controller.beforeCompletion(completionInput(current, decision), context);
}

function handler(
  id: string,
  handle: AgentStopHandler["handle"],
  timeoutMs = 1_000,
): StopTestBinding {
  const ref = Object.freeze({ id: `${id}-handler`, revision: "1" });
  return Object.freeze({
    registration: Object.freeze({
      ref: Object.freeze({ owner: "test", id, revision: "1" }),
      point: "Stop" as const,
      mode: "blocking" as const,
      runKinds: Object.freeze(["root" as const, "descendant" as const]),
      handler: ref,
      timeoutMs,
      maximumResultBytes: 8_192,
    }),
    binding: Object.freeze({
      ref,
      point: "Stop" as const,
      mode: "blocking" as const,
      handler: Object.freeze({ handle }),
    }),
  });
}

function backgroundObserver(
  id: string,
  observe: AgentStopObserver["observe"],
): StopTestBinding {
  const ref = Object.freeze({ id: `${id}-handler`, revision: "1" });
  return Object.freeze({
    registration: Object.freeze({
      ref: Object.freeze({ owner: "test", id, revision: "1" }),
      point: "Stop" as const,
      mode: "background" as const,
      runKinds: Object.freeze(["root" as const]),
      handler: ref,
      timeoutMs: 1_000,
      maximumResultBytes: 8_192,
    }),
    binding: Object.freeze({
      ref,
      point: "Stop" as const,
      mode: "background" as const,
      handler: Object.freeze({ observe }),
    }),
  });
}

function stopComposition(entries: readonly StopTestBinding[]) {
  return createAgentHookComposition({
    id: "test-stop-hooks",
    revision: "1",
    registrations: entries.map(({ registration }) => registration),
    bindings: entries.map(({ binding }) => binding),
  });
}

function stopFailureComposition(observe: AgentStopFailureObserver["observe"]) {
  const handlerRef = Object.freeze({ id: "failure-handler", revision: "1" });
  return createAgentHookComposition({
    id: "test-stop-failure-hooks",
    revision: "1",
    registrations: [Object.freeze({
      ref: Object.freeze({ owner: "test", id: "stop-failure", revision: "1" }),
      point: "StopFailure" as const,
      mode: "blocking" as const,
      runKinds: Object.freeze(["root" as const]),
      handler: handlerRef,
      timeoutMs: 1_000,
      maximumResultBytes: 8_192,
    })],
    bindings: [Object.freeze({
      ref: handlerRef,
      point: "StopFailure" as const,
      mode: "blocking" as const,
      handler: Object.freeze({ observe }),
    })],
  });
}

function complete(summary: string): TaskDecisionProposal<TestOutput> {
  return Object.freeze({ candidates: [], completionSource: {kind: "controller" as const},
    kind: "propose_completion" as const,
    output: Object.freeze({ summary }),
    modelItems: Object.freeze([]),
  });
}

function controllerInput(iteration = 1): TaskDecisionInputSources<TestOutput> {
  return {
    runId: "run-1",
    iteration,
    agent: { id: "agent-1", revision: "1" },
    task: {
      id: "task-1",
      kind: "test",
      input: {},
      createdAt: NOW,
      metadata: {},
    },
    contextManifest: {
      requestId: `context-projection-request-${iteration}`,
      projectionId: `projection-${iteration}`,
    },
    toolExposure: { controllerRequestId: `controller-request-${iteration}` },
    interaction: {
      id: "interaction-1",
      revision: "1",
      messages: [],
      unsettledCalls: [],
      settledCallCount: 0,
      latestTurn: null,
    },
    plan: null,
    pending: [],
  } as unknown as TaskDecisionInputSources<TestOutput>;
}

function callContext(): AgentActivityExecutionContext {
  const cancellation = new AbortController();
  return {
    cancellation: { signal: cancellation.signal },
    retry: { deadlineAt: "2026-09-04T00:01:00.000Z" },
  } as unknown as AgentActivityExecutionContext;
}
