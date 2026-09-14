import { describe, expect, it, vi } from "vitest";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import {
  createAgentHookComposition,
  createEmptyAgentHookComposition,
  type AgentHookBinding,
  type AgentHookRegistration,
  type AgentStopHandler,
  type AgentStopObserver,
  type AgentStopFailureObserver,
} from "../composition/index.js";
import { AgentHookController } from "./AgentHookController.js";
import { AgentHookExecutionStore } from "./AgentHookExecution.js";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";

const NOW = "2026-09-04T00:00:00.000Z";

interface TestOutput {
  readonly summary: string;
}

class FakeController implements Controller<TestOutput> {
  readonly resourceMetering = Object.freeze({
    modelInputTokens: "not_applicable" as const,
    modelOutputTokens: "not_applicable" as const,
    costUnits: "not_applicable" as const,
  });

  constructor(
    private readonly execute: (
      input: ControllerInput<TestOutput>,
      context: ControllerCallContext,
    ) => Promise<ControllerDecision<TestOutput>> | ControllerDecision<TestOutput>,
  ) {}

  next(
    input: ControllerInput<TestOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TestOutput>> {
    return Promise.resolve(this.execute(input, context));
  }
}

describe("AgentHookController", () => {
  it("binds Stop and StopFailure to Controller requests rather than Context projection requests", async () => {
    const stop = vi.fn((_event: Parameters<AgentStopHandler["handle"]>[0]) => ({disposition: "allow" as const}));
    const failure = vi.fn();
    const input = controllerInput();
    expect(input.toolExposure.controllerRequestId).not.toBe(input.contextManifest.requestId);
    const normal = new AgentHookController({controller: new FakeController(() => complete("Done")), composition: stopComposition([handler("stop", stop)]), rootRunId: "run-1", now: () => NOW});
    await normal.next(input, callContext());
    expect(stop.mock.calls[0]?.[0]).toMatchObject({controllerRequestId: input.toolExposure.controllerRequestId});
    const failed = new AgentHookController({controller: new FakeController(() => {throw new Error("Failed");}), composition: stopFailureComposition(failure), rootRunId: "run-1", now: () => NOW});
    await expect(failed.next(input, callContext())).rejects.toThrow("Failed");
    expect(failure.mock.calls[0]?.[0]).toMatchObject({controllerRequestId: input.toolExposure.controllerRequestId});
  });
  it("records candidate short circuits and Handler material without adding Hook execution", async () => {
    for (const decision of [complete("Done"), {kind: "advance" as const, candidates: [], modelItems: []}]) {
      const facts: ExecutionFlowObservation[] = [];
      const controller = new AgentHookController({controller: new FakeController(() => decision), rootRunId: "run-1"});
      expect(await controller.next(controllerInput(), {...callContext(), executionFlow: {observer: {observe: fact => {facts.push(fact);}}}})).toBe(decision);
      const checks = facts.filter(fact => fact.kind === "constraint" && fact.stepId === "candidate");
      expect(checks.map(check => check.checkId)).toEqual(["normal_completion", "registered_handlers", "continuation_allowance"]);
      expect(checks[2]?.disposition).toBe("not_applicable");
      expect(facts.some(fact => fact.kind === "material" && fact.name === "Hook-adjusted Controller decision")).toBe(true);
      expect(controller.store.getProjection().invocationCount).toBe(0);
    }
  });
  it("preserves a normal completion after one actionable continuation and a later allow", async () => {
    let calls = 0;
    const decision = complete("No useful work remains.");
    const controller = new AgentHookController({
      controller: new FakeController(() => decision),
      composition: stopComposition([handler("stop", () => ++calls === 1
        ? { disposition: "continue", code: "one_more_check", message: "Check the last settled result." }
        : { disposition: "allow" })]),
      rootRunId: "run-1", now: () => NOW,
    });
    await expect(controller.next(controllerInput(), callContext())).resolves.toMatchObject({ kind: "continue_with_feedback" });
    await expect(controller.next(controllerInput(2), callContext())).resolves.toBe(decision);
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
    const controller = new AgentHookController({
      controller: new FakeController(() => decision),
      composition: createEmptyAgentHookComposition(),
      rootRunId: "run-1",
      now: () => NOW,
    });

    await expect(controller.next(controllerInput(), callContext())).resolves.toBe(decision);
    expect(controller.store.getProjection().invocationCount).toBe(0);
  });

  it("combines blocking Stop continuation results in registration order", async () => {
    const controller = new AgentHookController({
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

    await expect(controller.next(controllerInput(), callContext())).resolves.toMatchObject({
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
    const controller = new AgentHookController({
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

    await expect(controller.next(controllerInput(), callContext())).resolves.toMatchObject({
      kind: "continue_with_feedback",
    });
    await expect(controller.next(controllerInput(2), callContext())).resolves.toEqual({
      kind: "propose_completion",
      output: { summary: "Still premature" },
      modelItems: [],
    });
    expect(next).toHaveBeenCalledTimes(2);
    expect(controller.store.getProjection().invocationCount).toBe(1);
    expect(controller.store.getProjection().recentDispositions).toMatchObject([{ disposition: "continuation_limit_reached" }]);
  });

  it("fails open and records blocking Handler failure and timeout", async () => {
    const failing = new AgentHookController({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([handler("failure", () => {
        throw new Error("Handler failed.");
      })]),
      rootRunId: "run-1",
      now: () => NOW,
    });
    await expect(failing.next(controllerInput(), callContext())).resolves.toMatchObject({
      kind: "propose_completion",
    });
    expect(failing.store.getProjection().recentInvocations[0]?.status).toBe("failed");

    const timedOut = new AgentHookController({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([handler("timeout", () => new Promise(() => {}), 1)]),
      rootRunId: "run-1",
      now: () => NOW,
    });
    await expect(timedOut.next(controllerInput(), callContext())).resolves.toMatchObject({
      kind: "propose_completion",
    });
    expect(timedOut.store.getProjection().recentInvocations[0]?.status).toBe("timed_out");
  });

  it("lets background Stop observers finish without decision authority", async () => {
    let release!: () => void;
    const observed = new Promise<void>((resolve) => { release = resolve; });
    const observer = vi.fn(() => observed);
    const controller = new AgentHookController({
      controller: new FakeController(() => complete("Done")),
      composition: stopComposition([backgroundObserver("observer", observer)]),
      rootRunId: "run-1",
      now: () => NOW,
    });

    await expect(controller.next(controllerInput(), callContext())).resolves.toMatchObject({
      kind: "propose_completion",
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
    const controller = new AgentHookController({
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

type StopTestBinding =
  | { readonly registration: AgentHookRegistration; readonly binding: AgentHookBinding };

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

function complete(summary: string): ControllerDecision<TestOutput> {
  return Object.freeze({
    kind: "propose_completion" as const,
    output: Object.freeze({ summary }),
    modelItems: Object.freeze([]),
  });
}

function controllerInput(iteration = 1): ControllerInput<TestOutput> {
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
    },
    plan: null,
    pending: [],
  } as unknown as ControllerInput<TestOutput>;
}

function callContext(): ControllerCallContext {
  const cancellation = new AbortController();
  return {
    cancellation: { signal: cancellation.signal },
    retry: { deadlineAt: "2026-09-04T00:01:00.000Z" },
  } as unknown as ControllerCallContext;
}
