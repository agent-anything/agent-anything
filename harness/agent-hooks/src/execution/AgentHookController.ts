import type {
  Controller,
  ControllerCallContext,
  ControllerCompletionInput,
  ControllerCompletionDisposition,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import { ControllerCheckpointError } from "@agent-anything/agent-runtime/controller";
import { RetryCheckpointError } from "@agent-anything/agent-runtime/retry";
import type { AgentHookComposition } from "../composition/index.js";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { AGENT_HOOK_EXECUTION_FLOW } from "./AgentHookExecutionFlow.js";
import type { AgentHookRecordPort } from "./AgentHookRecordPort.js";
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
  readonly invocationRecords?: AgentHookRecordPort;
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
    return this.executeNext(input, context, false);
  }

  async recover(input: ControllerInput<TOutput>, context: ControllerCallContext): Promise<ControllerDecision<TOutput>> {
    return this.executeNext(input, context, true);
  }

  private async executeNext(input: ControllerInput<TOutput>, context: ControllerCallContext, recovering: boolean): Promise<ControllerDecision<TOutput>> {
    this.restoreState(input.runId, context);
    const flow = new ExecutionFlowPath(AGENT_HOOK_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId, []);
    try {
      const decision = await this.nextWithFlow(input, context, flow, recovering);
      await this.saveState(input.runId, context, null);
      flow.advance("result", {decision:decision.kind}).output(flow.material("Controller decision", "returned", decision));
      flow.close("returned");
      return decision;
    } catch (error) { flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed"); throw error; }
  }

  private async nextWithFlow(
    input: ControllerInput<TOutput>,
    context: ControllerCallContext,
    flow: ExecutionFlowPath,
    recovering: boolean,
  ): Promise<ControllerDecision<TOutput>> {
    let decision: ControllerDecision<TOutput>;
    const controllerStep = flow.advance("controller", {}, [{owner: "runtime", kind: "request", id: input.toolExposure.controllerRequestId, revision: null}]);
    try {
      const invoke = recovering ? this.input.controller.recover : this.input.controller.next;
      if (!invoke) throw new ControllerCheckpointError("underlying_controller_recovery_unavailable");
      decision = await invoke.call(this.input.controller, input, {...context, executionFlow:flow.callContext});
    } catch (error) {
      if (error instanceof ControllerCheckpointError || error instanceof RetryCheckpointError) throw error;
      if (this.input.composition !== undefined) {
        flow.advance("failure", {registeredCount:this.input.composition.registrations.length});
        const event = await this.eventOnce(context, "failure-event", () => createAgentStopFailureEvent({
          sequence: this.nextSequence(input.runId),
          runKind: this.runKind(input.runId),
          controllerInput: input,
          error,
          emittedAt: this.now(),
        }));
        flow.current?.output(flow.material("Agent StopFailure event", "emitted", event));
        await dispatchAgentStopFailureHooks({
          invocationRecords: this.input.invocationRecords,
          checkpoints: context.checkpoints,
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
    if (decision.kind !== "propose_completion") {
      this.continuationCounts.delete(input.runId);
    }
    return decision;
  }

  async beforeCompletion(
    notification: ControllerCompletionInput<TOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerCompletionDisposition> {
    return this.executeCompletion(notification, context, false);
  }

  async recoverBeforeCompletion(notification: ControllerCompletionInput<TOutput>, context: ControllerCallContext): Promise<ControllerCompletionDisposition> {
    return this.executeCompletion(notification, context, true);
  }

  private async executeCompletion(notification: ControllerCompletionInput<TOutput>, context: ControllerCallContext, recovering: boolean): Promise<ControllerCompletionDisposition> {
    const input = notification.current;
    const saved = this.restoreState(input.runId, context);
    if (saved?.completion?.turnId === notification.turn.id) return saved.completion.disposition;
    const flow = new ExecutionFlowPath(AGENT_HOOK_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId);
    try {
      flow.advance("before_completion", {stateRevision: notification.stateRevision}, [flow.material("Settled completion candidate", "received", notification)]);
      const inherited = await this.inheritedCompletion(notification, context, flow.callContext, recovering);
      if (inherited?.kind !== "allow" && inherited?.kind !== "continue_with_feedback") {
        throw new TypeError("Controller completion disposition is invalid.");
      }
      const result = inherited?.kind === "continue_with_feedback"
        ? inherited
        : await this.dispatchStop(notification, context, flow);
      await this.saveState(input.runId, context, {turnId: notification.turn.id, disposition: result});
      flow.advance("result", {disposition: result.kind}).output(flow.material("Completion disposition", "returned", result));
      flow.close("returned");
      return result;
    } catch (error) { flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed"); throw error; }
  }

  private async dispatchStop(
    notification: ControllerCompletionInput<TOutput>,
    context: ControllerCallContext,
    flow: ExecutionFlowPath,
  ): Promise<ControllerCompletionDisposition> {
    const input = notification.current;
    const candidateStep = flow.advance("candidate", {stateRevision: notification.stateRevision});
    candidateStep.check("registered_handlers", this.input.composition?.registrations.length ? "passed" : "not_applicable", {registeredCount:this.input.composition?.registrations.length ?? 0});
    if (this.input.composition === undefined || this.input.composition.registrations.length === 0) {
      candidateStep.check("continuation_allowance", "not_applicable", {reason: "no_registered_handlers"});
      this.continuationCounts.delete(input.runId);
      return {kind: "allow"};
    }

    candidateStep.check("continuation_allowance", (this.continuationCounts.get(input.runId) ?? 0) >= this.maxConsecutiveContinuations ? "not_satisfied" : "passed", {used:this.continuationCounts.get(input.runId) ?? 0, maximum:this.maxConsecutiveContinuations});
    if ((this.continuationCounts.get(input.runId) ?? 0) >= this.maxConsecutiveContinuations) {
      this.store.recordDisposition({runId: input.runId, controllerRequestId: input.toolExposure.controllerRequestId,
        disposition: "continuation_limit_reached", feedbackCount: this.continuationCounts.get(input.runId) ?? 0,
        recordedAt: this.now()});
      return {kind: "allow"};
    }

    const event = await this.eventOnce(context, "stop-event", () => createAgentStopEvent({
      sequence: this.nextSequence(input.runId),
      runKind: this.runKind(input.runId),
      controllerInput: input,
      output: notification.output,
      emittedAt: this.now(),
    }));
    const eventRef = flow.material("Agent Stop event", "emitted", event);
    candidateStep.output(eventRef);
    const handlersStep = flow.advance("handlers", {eventId:event.ref.id}, [eventRef]);
    const result = await dispatchAgentStopHooks({
      invocationRecords: this.input.invocationRecords,
      checkpoints: context.checkpoints,
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
      return {kind: "allow"};
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
    });
  }

  private nextSequence(runId: string): number {
    const next = (this.eventSequences.get(runId) ?? 0) + 1;
    this.eventSequences.set(runId, next);
    return next;
  }

  private async inheritedCompletion(notification: ControllerCompletionInput<TOutput>, context: ControllerCallContext,
    executionFlow: import("@agent-anything/observability/execution-flow").ExecutionFlowContext, recovering: boolean): Promise<ControllerCompletionDisposition> {
    if (!this.input.controller.beforeCompletion) return {kind: "allow"};
    const key = "agent-hooks:inherited-completion";
    const saved = context.checkpoints?.read(key) as {status: "pending"} | {status: "returned"; disposition: ControllerCompletionDisposition} | null;
    if (saved?.status === "returned") return saved.disposition;
    if (!saved) await context.checkpoints?.commit(key, {status: "pending"});
    const invoke = recovering && saved ? this.input.controller.recoverBeforeCompletion : this.input.controller.beforeCompletion;
    if (!invoke) throw new ControllerCheckpointError("inherited_completion_recovery_unavailable");
    const disposition = await invoke.call(this.input.controller, notification, {...context, executionFlow});
    await context.checkpoints?.commit(key, {status: "returned", disposition});
    return disposition;
  }

  private async eventOnce<T extends {readonly run: {readonly id: string}; readonly ref: {readonly sequence: number}}>(context: ControllerCallContext,
    key: string, create: () => T): Promise<T> {
    const saved = context.checkpoints?.read(`agent-hooks:${key}`) as T | null;
    const event = saved ?? create();
    if (!Number.isSafeInteger(event.ref.sequence) || event.ref.sequence < 1) throw new ControllerCheckpointError(key);
    this.eventSequences.set(event.run.id, Math.max(event.ref.sequence, this.eventSequences.get(event.run.id) ?? 0));
    if (!saved) await context.checkpoints?.commit(`agent-hooks:${key}`, event);
    return event;
  }

  private restoreState(runId: string, context: ControllerCallContext): HookControllerState | null {
    const saved = context.runCheckpoints?.read("agent-hooks:state") as HookControllerState | null;
    if (!saved) return null;
    if (saved.binding !== this.binding() || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 ||
        !Number.isSafeInteger(saved.continuations) || saved.continuations < 0 || saved.continuations > this.maxConsecutiveContinuations) {
      throw new ControllerCheckpointError("agent_hook_binding_or_state_invalid");
    }
    this.eventSequences.set(runId, saved.sequence);
    this.continuationCounts.set(runId, saved.continuations);
    return saved;
  }

  private async saveState(runId: string, context: ControllerCallContext, completion: HookControllerState["completion"]): Promise<void> {
    await context.runCheckpoints?.commit("agent-hooks:state", {binding: this.binding(), sequence: this.eventSequences.get(runId) ?? 0,
      continuations: this.continuationCounts.get(runId) ?? 0, completion} satisfies HookControllerState);
  }

  private binding(): string {
    return JSON.stringify({composition: this.input.composition ? {id: this.input.composition.id, revision: this.input.composition.revision,
      registrations: this.input.composition.registrations} : null, maximum: this.maxConsecutiveContinuations});
  }

  private runKind(runId: string): "root" | "descendant" {
    return runId === this.input.rootRunId ? "root" : "descendant";
  }
}

interface HookControllerState {
  readonly binding: string;
  readonly sequence: number;
  readonly continuations: number;
  readonly completion: {readonly turnId: string; readonly disposition: ControllerCompletionDisposition} | null;
}

function interruptionContext(context: ControllerCallContext): import("@agent-anything/agent-core/control").InvocationInterruptionContext {
  return Object.freeze({ signal: context.cancellation.signal, interruption: null });
}
