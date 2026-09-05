import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import type { AgentHookComposition } from "../composition/index.js";
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
    let decision: ControllerDecision<TOutput>;
    try {
      decision = await this.input.controller.next(input, context);
    } catch (error) {
      if (this.input.composition !== undefined) {
        const event = createAgentStopFailureEvent({
          sequence: this.nextSequence(input.runId),
          runKind: this.runKind(input.runId),
          controllerInput: input,
          error,
          emittedAt: this.now(),
        });
        await dispatchAgentStopFailureHooks({
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

    if (decision.kind !== "propose_completion" && decision.kind !== "propose_stop") {
      this.continuationCounts.delete(input.runId);
      return decision;
    }
    if (this.input.composition === undefined || this.input.composition.registrations.length === 0) {
      this.continuationCounts.delete(input.runId);
      return decision;
    }

    const event = createAgentStopEvent({
      sequence: this.nextSequence(input.runId),
      runKind: this.runKind(input.runId),
      controllerInput: input,
      decision,
      emittedAt: this.now(),
    });
    const result = await dispatchAgentStopHooks({
      composition: this.input.composition,
      event,
      interruption: interruptionContext(context),
      deadlineAt: context.retry.deadlineAt,
      store: this.store,
      now: this.now,
    });
    if (result.disposition === "allow") {
      this.continuationCounts.delete(input.runId);
      return decision;
    }
    const count = (this.continuationCounts.get(input.runId) ?? 0) + 1;
    this.continuationCounts.set(input.runId, count);
    if (count > this.maxConsecutiveContinuations) {
      this.continuationCounts.delete(input.runId);
      return Object.freeze({
        kind: "propose_stop" as const,
        reason: "Agent Stop continuation limit exhausted.",
        modelItems: decision.modelItems,
      });
    }
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
