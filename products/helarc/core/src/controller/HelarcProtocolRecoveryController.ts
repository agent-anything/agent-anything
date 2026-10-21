import {
  ControllerCheckpointError, ControllerError,
  type Controller, type ControllerCallContext, type ControllerDecision, type ControllerInput,
} from "@agent-anything/agent-runtime/controller";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { HELARC_NATIVE_TOOL_PROTOCOL_REVISION } from "./HelarcController.js";
import { HELARC_PROTOCOL_RECOVERY_EXECUTION_FLOW } from "./HelarcControllerExecutionFlow.js";
import { HELARC_PROTOCOL_RECOVERY_POLICY } from "./HelarcControllerProtocolComposition.js";
const CHECKPOINT_KEY = HELARC_PROTOCOL_RECOVERY_POLICY.id;
const MISSING_SIGNAL = "helarc_ending_signal_missing";

interface RecoveryState {
  readonly version: 1;
  readonly policyRevision: string;
  readonly maximumConsecutiveMissing: number;
  readonly runId: string;
  readonly requestId: string;
  readonly iteration: number;
  readonly turnId: string;
  readonly consecutiveMissing: number;
  readonly disposition: "feedback" | "reset" | "exhausted";
}

/** Product protocol correction, separate from Provider Retry and Stop Hooks. */
export class HelarcProtocolRecoveryController<TOutput> implements Controller<TOutput> {
  private readonly states = new Map<string, RecoveryState>();

  constructor(private readonly inner: Controller<TOutput>) {}

  get resourceMetering(): Controller<TOutput>["resourceMetering"] {
    return this.inner.resourceMetering;
  }

  next(input: ControllerInput<TOutput>, context: ControllerCallContext): Promise<ControllerDecision<TOutput>> {
    return this.execute(input, context, false);
  }

  recover(input: ControllerInput<TOutput>, context: ControllerCallContext): Promise<ControllerDecision<TOutput>> {
    return this.execute(input, context, true);
  }

  private async execute(input: ControllerInput<TOutput>, context: ControllerCallContext, recovering: boolean): Promise<ControllerDecision<TOutput>> {
    const flow = new ExecutionFlowPath(HELARC_PROTOCOL_RECOVERY_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId);
    const step = flow.advance("assess", {controllerRequestId: input.toolExposure.controllerRequestId},
      [{owner: "runtime", kind: "request", id: input.toolExposure.controllerRequestId, revision: null}]);
    try {
      if (recovering && !context.runCheckpoints) throw new ControllerCheckpointError(CHECKPOINT_KEY);
      const saved = this.read(input, context);
      if (saved?.disposition === "exhausted") {
        step.check("correction_allowance", "not_satisfied", {...saved, replayed: true});
        throw exhausted(saved);
      }
      const invoke = recovering ? this.inner.recover : this.inner.next;
      if (!invoke) throw new ControllerCheckpointError("underlying_controller_recovery_unavailable");
      const decision = await invoke.call(this.inner, input, {...context, executionFlow: flow.callContext});
      const missing = isMissingSignal(decision);
      // Other feedback has a different owner; it must not spend or clear this allowance.
      if (!missing && decision.kind === "continue_with_feedback") {
        step.check("correction_allowance", "not_applicable", {reason: "other_feedback_owner"});
        flow.advance("return", {decision: decision.kind});
        flow.close("returned");
        return decision;
      }
      if (!missing && !saved?.consecutiveMissing) {
        step.check("correction_allowance", "not_applicable", {reason: "no_active_correction"});
        flow.advance("return", {decision: decision.kind});
        flow.close("returned");
        return decision;
      }

      const requestId = input.toolExposure.controllerRequestId;
      const turnId = decision.modelItems.find(item => item.kind === "model_turn_finish")?.turnId;
      if (!turnId) throw new ControllerCheckpointError("helarc_protocol_recovery_turn_missing");
      const replayed = saved?.requestId === requestId;
      let state: RecoveryState;
      if (replayed) {
        if (saved.iteration !== input.iteration || saved.turnId !== turnId ||
            (saved.disposition === "feedback") !== missing) {
          throw new ControllerCheckpointError("helarc_protocol_recovery_response_changed");
        }
        state = saved;
      } else {
        const consecutiveMissing = missing ? (saved?.consecutiveMissing ?? 0) + 1 : 0;
        state = Object.freeze({
          version: 1, policyRevision: HELARC_PROTOCOL_RECOVERY_POLICY.revision,
          maximumConsecutiveMissing: HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing,
          runId: input.runId, requestId, iteration: input.iteration, turnId, consecutiveMissing,
          disposition: !missing ? "reset" : consecutiveMissing >= HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing ? "exhausted" : "feedback",
        });
        // Do not expose a new allowance or failure until its recovery fact is durable.
        try { await context.runCheckpoints?.commit(CHECKPOINT_KEY, state); }
        catch (cause) { throw new ControllerCheckpointError(CHECKPOINT_KEY, {cause}); }
        this.states.set(input.runId, state);
      }
      step.check("correction_allowance", state.disposition === "exhausted" ? "not_satisfied" : "passed", {...state, replayed});
      step.output(flow.material("Protocol recovery state", "retained", state));
      if (state.disposition === "exhausted") throw exhausted(state);
      flow.advance("return", {decision: decision.kind, disposition: state.disposition});
      flow.close("returned");
      return decision;
    } catch (error) {
      flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  private read(input: ControllerInput<TOutput>, context: ControllerCallContext): RecoveryState | null {
    const value = context.runCheckpoints
      ? context.runCheckpoints.read(CHECKPOINT_KEY) : this.states.get(input.runId) ?? null;
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControllerCheckpointError(CHECKPOINT_KEY);
    const state = value as RecoveryState;
    const maximum = HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing;
    if (state.version !== 1 || state.policyRevision !== HELARC_PROTOCOL_RECOVERY_POLICY.revision ||
        state.maximumConsecutiveMissing !== maximum || state.runId !== input.runId ||
        typeof state.requestId !== "string" || !state.requestId || typeof state.turnId !== "string" || !state.turnId ||
        !Number.isSafeInteger(state.iteration) || state.iteration < 1 || state.iteration > input.iteration ||
        !Number.isSafeInteger(state.consecutiveMissing) || state.consecutiveMissing > state.iteration ||
        !(state.disposition === "reset" && state.consecutiveMissing === 0 ||
          state.disposition === "feedback" && state.consecutiveMissing >= 1 && state.consecutiveMissing < maximum ||
          state.disposition === "exhausted" && state.consecutiveMissing === maximum) ||
        state.iteration === input.iteration && state.requestId !== input.toolExposure.controllerRequestId) {
      throw new ControllerCheckpointError(CHECKPOINT_KEY);
    }
    return Object.freeze({...state});
  }
}

function isMissingSignal<T>(decision: ControllerDecision<T>): boolean {
  return decision.kind === "continue_with_feedback" && decision.feedback.code === MISSING_SIGNAL &&
    decision.feedback.source.owner === "helarc" && decision.feedback.source.kind === "controller_protocol" &&
    decision.feedback.source.id === HELARC_NATIVE_TOOL_PROTOCOL_REVISION;
}

function exhausted(state: RecoveryState): ControllerError {
  return new ControllerError({kind: "model", failure: {
    code: "model_protocol_recovery_exhausted", retryable: false,
    message: `The model returned ${state.maximumConsecutiveMissing} consecutive responses without an ending signal or a callable request. The Run could not continue under the Helarc response protocol.`,
    metadata: {owner: "helarc", protocol: HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
      feedbackCode: MISSING_SIGNAL, policyId: CHECKPOINT_KEY, ...state},
  }}, "settled_failure");
}
