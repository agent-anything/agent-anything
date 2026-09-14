import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import type { AgentHookComposition } from "../composition/index.js";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { AGENT_HOOK_EXECUTION_FLOW } from "./AgentHookExecutionFlow.js";
import { createAgentStopEvent, createAgentStopFailureEvent } from "../events/index.js";
import {
  AgentHookExecutionStore,
  dispatchAgentStopFailureHooks,
  dispatchAgentStopHooks,
} from "./AgentHookExecution.js";

export interface AgentHookControllerInput<TOutput = unknown> {
  readonly controller: Controller<TOutput>;
  readonly composition?: AgentHookComposition;
  readonly rootRunId: string;
  readonly maxConsecutiveContinuations?: number;
  readonly store?: AgentHookExecutionStore;
  readonly now?: () => string;
}

export class AgentHookController<TOutput = unknown> implements Controller<TOutput> {
  readonly resourceMetering;
  readonly store: AgentHookExecutionStore;
  private readonly now: () => string;
  private readonly maxConsecutiveContinuations: number;
  private readonly eventSequences = new Map<string, number>();
  private readonly continuationCounts = new Map<string, number>();

  constructor(private readonly input: AgentHookControllerInput<TOutput>) {
    this.resourceMetering = input.controller.resourceMetering;
    this.store = input.store ?? new AgentHookExecutionStore();
    this.now = input.now ?? (() => new Date().toISOString());
    this.maxConsecutiveContinuations = input.maxConsecutiveContinuations ?? 2;
    if (!Number.isSafeInteger(this.maxConsecutiveContinuations) || this.maxConsecutiveContinuations < 0 || this.maxConsecutiveContinuations > 32) {
      throw new TypeError("Agent Hook continuation limit is outside the supported range.");
    }
  }

  async next(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    const flow = new ExecutionFlowPath(AGENT_HOOK_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId, []);
    try {
      const decision = await this.nextWithFlow(input, context, flow);
      flow.advance("result", {decision:decision.kind}).output(flow.material("Hook-adjusted Controller decision", "returned", decision));
      flow.close("returned");
      return decision;
    } catch (error) { flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed"); throw error; }
  }

  private async nextWithFlow(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
    flow: ExecutionFlowPath,
  ): Promise<ControllerDecision<TOutput>> {
    let decision: ControllerDecision<TOutput>;
    const controllerStep = flow.advance("controller", {}, [{owner: "runtime", kind: "request", id: input.toolExposure.controllerRequestId, revision: null}]);
    try {
      decision = await this.input.controller.next(input, {...context, executionFlow:flow.callContext});
    } catch (error) {
      if (this.input.composition !== undefined) {
        flow.advance("failure", {registeredCount:this.input.composition.registrations.length});
        const event = createAgentStopFailureEvent({
          sequence: this.nextSequence(input.runId),
          runKind: this.runKind(input.runId),
          controllerInput: input,
          error,
          emittedAt: this.now(),
        });
        flow.current?.output(flow.material("Agent StopFailure event", "emitted", event));
        await dispatchAgentStopFailureHooks({
          executionFlow: flow.callContext,
          composition: this.input.composition,
          event,
          interruption: interruptionContext(context),
          deadlineAt: context.retry.deadlineAt,
          store: this.store,
          now: this.now,
        });
      }
      throw error;
    }

    const decisionRef = flow.material("Controller candidate", "received", decision);
    controllerStep.output(decisionRef);
    const candidateStep = flow.advance("candidate", {decision:decision.kind}, [decisionRef]);
    candidateStep.check("normal_completion", decision.kind === "propose_completion" ? "passed" : "not_applicable");
    if (decision.kind !== "propose_completion") {
      candidateStep.check("registered_handlers", "not_applicable", {reason: "not_a_completion_candidate"});
      candidateStep.check("continuation_allowance", "not_applicable", {reason: "not_a_completion_candidate"});
      this.continuationCounts.delete(input.runId);
      return decision;
    }
    candidateStep.check("registered_handlers", this.input.composition?.registrations.length ? "passed" : "not_applicable", {registeredCount:this.input.composition?.registrations.length ?? 0});
    if (this.input.composition === undefined || this.input.composition.registrations.length === 0) {
      candidateStep.check("continuation_allowance", "not_applicable", {reason: "no_registered_handlers"});
      this.continuationCounts.delete(input.runId);
      return decision;
    }

    candidateStep.check("continuation_allowance", (this.continuationCounts.get(input.runId) ?? 0) >= this.maxConsecutiveContinuations ? "not_satisfied" : "passed", {used:this.continuationCounts.get(input.runId) ?? 0, maximum:this.maxConsecutiveContinuations});
    if ((this.continuationCounts.get(input.runId) ?? 0) >= this.maxConsecutiveContinuations) {
      this.store.recordDisposition({runId: input.runId, controllerRequestId: input.toolExposure.controllerRequestId,
        disposition: "continuation_limit_reached", feedbackCount: this.continuationCounts.get(input.runId) ?? 0,
        recordedAt: this.now()});
      return decision;
    }

    const event = createAgentStopEvent({
      sequence: this.nextSequence(input.runId),
      runKind: this.runKind(input.runId),
      controllerInput: input,
      decision,
      emittedAt: this.now(),
    });
    const eventRef = flow.material("Agent Stop event", "emitted", event);
    candidateStep.output(eventRef);
    const handlersStep = flow.advance("handlers", {eventId:event.ref.id}, [eventRef]);
    const result = await dispatchAgentStopHooks({
      executionFlow: flow.callContext,
      composition: this.input.composition,
      event,
      interruption: interruptionContext(context),
      deadlineAt: context.retry.deadlineAt,
      store: this.store,
      now: this.now,
    });
    handlersStep.output(flow.material("Stop dispatch result", "settled", result));
    if (result.disposition === "allow") {
      this.continuationCounts.delete(input.runId);
      return decision;
    }
    const count = (this.continuationCounts.get(input.runId) ?? 0) + 1;
    this.continuationCounts.set(input.runId, count);
    return Object.freeze({
      kind: "continue_with_feedback" as const,
      feedback: Object.freeze({
        source: Object.freeze({
          owner: "agent-hooks",
          kind: "stop",
          id: event.ref.id,
          revision: event.ref.revision,
        }),
        code: result.codes.join("+") || "agent_stop_continuation_requested",
        message: result.message ?? "Agent Stop Handler requested another turn.",
      }),
      modelItems: decision.modelItems,
    });
  }

  private nextSequence(runId: string): number {
    const next = (this.eventSequences.get(runId) ?? 0) + 1;
    this.eventSequences.set(runId, next);
    return next;
  }

  private runKind(runId: string): "root" | "descendant" {
    return runId === this.input.rootRunId ? "root" : "descendant";
  }
}

function interruptionContext(context: ControllerCallContext): import("@agent-anything/agent-core/control").InvocationInterruptionContext {
  return Object.freeze({ signal: context.cancellation.signal, interruption: null });
}
