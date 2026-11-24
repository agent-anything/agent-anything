import { ActivityCheckpointError } from "@agent-anything/agent-runtime/activity";
import { TaskDecisionActivityError, type TaskDecisionActivity, type AgentActivityExecutionContext, type TaskDecisionProposal, type TaskDecisionInputSources } from "@agent-anything/agent-runtime/decision";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { HELARC_NATIVE_TOOL_PROTOCOL_REVISION } from "./HelarcController.js";
import { HELARC_PROTOCOL_RECOVERY_EXECUTION_FLOW } from "./HelarcControllerExecutionFlow.js";
import { HELARC_PROTOCOL_RECOVERY_POLICY } from "./HelarcControllerProtocolComposition.js";
import {snapshotTaskModelExchange, type TaskModelExchange} from "@agent-anything/agent-runtime/decision";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
const CHECKPOINT_KEY = HELARC_PROTOCOL_RECOVERY_POLICY.id;
const MISSING_SIGNAL = "helarc_ending_signal_missing";

interface RecoveryState {
  readonly version: 3;
  readonly policyRevision: string;
  readonly maximumConsecutiveMissing: number;
  readonly runId: string;
  readonly requestId: string;
  readonly iteration: number;
  readonly responseIdentity: string;
  readonly responseDigest: string;
  readonly consecutiveMissing: number;
  readonly disposition: "feedback" | "reset" | "exhausted";
  readonly exchange: TaskModelExchange | null;
}

/** Product protocol correction, separate from Provider Retry and Stop Hooks. */
export class HelarcProtocolRecoveryController<TOutput> implements TaskDecisionActivity<TOutput> {
  private readonly states = new Map<string, RecoveryState>();

  constructor(private readonly inner: TaskDecisionActivity<TOutput>) {}

  get historyKind() { return this.inner.historyKind ?? "turn_messages"; }

  get resourceMetering(): TaskDecisionActivity<TOutput>["resourceMetering"] {
    return this.inner.resourceMetering;
  }

  next(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    return this.execute(input, context, false);
  }

  recover(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    return this.execute(input, context, true);
  }

  async interrupt(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput> | null> {
    const saved = this.read(input, context);
    if (saved?.disposition === "exhausted" && saved.requestId === input.toolExposure.controllerRequestId) throw exhausted(saved, input);
    return this.inner.interrupt ? this.inner.interrupt(input, context) : null;
  }

  private async execute(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext, recovering: boolean): Promise<TaskDecisionProposal<TOutput>> {
    const flow = new ExecutionFlowPath(HELARC_PROTOCOL_RECOVERY_EXECUTION_FLOW, context.executionFlow ?? {}, input.runId);
    const step = flow.advance("assess", {controllerRequestId: input.toolExposure.controllerRequestId},
      [{owner: "runtime", kind: "request", id: input.toolExposure.controllerRequestId, revision: null}]);
    try {
      if (recovering && !context.runCheckpoints) throw new ActivityCheckpointError(CHECKPOINT_KEY);
      const saved = this.read(input, context);
      if (saved?.disposition === "exhausted") {
        step.check("correction_allowance", "not_satisfied", {...recoveryFacts(saved), replayed: true});
        throw exhausted(saved, input);
      }
      const invoke = recovering ? this.inner.recover : this.inner.next;
      if (!invoke) throw new ActivityCheckpointError("underlying_controller_recovery_unavailable");
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
      const native = decision.modelItems.find(item => item.kind === "native_purpose_evidence");
      const turn = decision.modelItems.find(item => item.kind === "model_turn_finish");
      if ((!native && !turn) || (native && turn)) throw new ActivityCheckpointError("helarc_protocol_recovery_response_missing");
      const responseIdentity = native ? modelInputValueDigest(native.evidence) : turn!.turnId;
      const responseDigest = modelInputValueDigest(decision);
      const replayed = saved?.requestId === requestId;
      let state: RecoveryState;
      if (replayed) {
        if (saved.iteration !== input.iteration || saved.responseIdentity !== responseIdentity || saved.responseDigest !== responseDigest ||
            (saved.disposition === "feedback") !== missing) {
          throw new ActivityCheckpointError("helarc_protocol_recovery_response_changed");
        }
        state = saved;
      } else {
        const consecutiveMissing = missing ? (saved?.consecutiveMissing ?? 0) + 1 : 0;
        state = Object.freeze({
          version: 3, policyRevision: HELARC_PROTOCOL_RECOVERY_POLICY.revision,
          maximumConsecutiveMissing: HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing,
          runId: input.runId, requestId, iteration: input.iteration, responseIdentity, responseDigest, consecutiveMissing,
          disposition: !missing ? "reset" : consecutiveMissing >= HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing ? "exhausted" : "feedback",
          exchange: missing && consecutiveMissing >= HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing ? snapshotTaskModelExchange(decision, input) : null,
        });
        // Do not expose a new allowance or failure until its recovery fact is durable.
        try { await context.runCheckpoints?.commit(CHECKPOINT_KEY, state); }
        catch (cause) { throw new ActivityCheckpointError(CHECKPOINT_KEY, {cause}); }
        this.states.set(input.runId, state);
      }
      step.check("correction_allowance", state.disposition === "exhausted" ? "not_satisfied" : "passed", {...recoveryFacts(state), replayed});
      step.output(flow.material("Protocol recovery state", "retained", state));
      if (state.disposition === "exhausted") throw exhausted(state, input);
      flow.advance("return", {decision: decision.kind, disposition: state.disposition});
      flow.close("returned");
      return decision;
    } catch (error) {
      flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  private read(input: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): RecoveryState | null {
    const value = context.runCheckpoints
      ? context.runCheckpoints.read(CHECKPOINT_KEY) : this.states.get(input.runId) ?? null;
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActivityCheckpointError(CHECKPOINT_KEY);
    const state = value as RecoveryState;
    const maximum = HELARC_PROTOCOL_RECOVERY_POLICY.maximumConsecutiveMissing;
    if (state.version !== 3 || state.policyRevision !== HELARC_PROTOCOL_RECOVERY_POLICY.revision ||
        state.maximumConsecutiveMissing !== maximum || state.runId !== input.runId ||
        typeof state.requestId !== "string" || !state.requestId || typeof state.responseIdentity !== "string" || !state.responseIdentity ||
        typeof state.responseDigest !== "string" || !state.responseDigest ||
        !Number.isSafeInteger(state.iteration) || state.iteration < 1 || state.iteration > input.iteration ||
        !Number.isSafeInteger(state.consecutiveMissing) || state.consecutiveMissing > state.iteration ||
        !(state.disposition === "reset" && state.consecutiveMissing === 0 ||
          state.disposition === "feedback" && state.consecutiveMissing >= 1 && state.consecutiveMissing < maximum ||
          state.disposition === "exhausted" && state.consecutiveMissing === maximum) ||
        state.iteration === input.iteration && state.requestId !== input.toolExposure.controllerRequestId ||
        (state.disposition === "exhausted" ? !state.exchange : state.exchange !== null)) {
      throw new ActivityCheckpointError(CHECKPOINT_KEY);
    }
    return Object.freeze({...state});
  }
}

function isMissingSignal<T>(decision: TaskDecisionProposal<T>): boolean {
  if (decision.kind !== "continue_with_feedback" || decision.feedback.code !== MISSING_SIGNAL || decision.feedback.source.owner !== "helarc") return false;
  const source = decision.feedback.source;
  if (source.kind === "controller_protocol") return source.id === HELARC_NATIVE_TOOL_PROTOCOL_REVISION;
  return source.kind === "native_task_acceptance" && decision.modelItems.some(item =>
    item.kind === "native_purpose_evidence" && item.evidence.acceptance.id === source.id && item.evidence.acceptance.revision === source.revision);
}

function recoveryFacts(state: RecoveryState) {
  const {exchange, ...facts} = state;
  return {...facts, exchangeRecorded: exchange !== null};
}

function exhausted<T>(state: RecoveryState, input: TaskDecisionInputSources<T>): TaskDecisionActivityError {
  return new TaskDecisionActivityError({kind: "model", failure: {
    code: "model_protocol_recovery_exhausted", retryable: false,
    message: `The model returned ${state.maximumConsecutiveMissing} consecutive responses without an ending signal or a callable request. The Run could not continue under the Helarc response protocol.`,
    metadata: {owner: "helarc", protocol: HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
      feedbackCode: MISSING_SIGNAL, policyId: CHECKPOINT_KEY, version: state.version, policyRevision: state.policyRevision,
      maximumConsecutiveMissing: state.maximumConsecutiveMissing, runId: state.runId, requestId: state.requestId,
      iteration: state.iteration, responseIdentity: state.responseIdentity, consecutiveMissing: state.consecutiveMissing, disposition: state.disposition},
  }}, "settled_failure", null, state.requestId === input.toolExposure.controllerRequestId && state.exchange ?
    {exchange: snapshotTaskModelExchange(state.exchange, input)} : undefined);
}
