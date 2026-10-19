import type { Agent } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { modelCallRefKey, type ModelCallRef } from "@agent-anything/model-interaction";
import type { ControllerDecision, ControllerInput } from "../controller/index.js";
import { assertAgentInstructionBindingMatches } from "../instructions/index.js";
import type { RunState } from "../run/index.js";
import type { PreparedControllerOperation } from "./ControllerOperation.js";
import { sameRunCommitValue as same } from "./RunCommitValue.js";

export type RetainedControllerOperation = Omit<PreparedControllerOperation<unknown>, "input"> & {
  readonly input: Omit<ControllerInput, "agent"> & {readonly agent: Omit<Agent, "output">};
};

export interface RunDecisionCallProgress {
  readonly candidateIndex: number;
  readonly call: ModelCallRef;
  readonly action: RunActionRef | null;
  readonly observationIds: readonly string[];
  readonly settlementItemId: string | null;
}

export interface RunDecisionCheckpoint {
  readonly status: "active" | "retired";
  readonly turn: ControllerTurnRef;
  readonly basisRevision: number;
  readonly value: ControllerDecision<unknown>;
  readonly prepared: RetainedControllerOperation;
  readonly calls: readonly RunDecisionCallProgress[];
}

/** Loading Call progress never grants permission to replay unfinished effects. */
export function validateDecisionCheckpoint(decision: RunDecisionCheckpoint, state: RunState): void {
  if (decision.status !== "active" && decision.status !== "retired") throw new TypeError("Invalid decision lifecycle.");
  const turns = state.items.filter(item => item.payload.kind === "controller_turn" &&
    item.payload.turn.id === decision.turn.id && item.payload.status === "decided");
  if (turns.length !== 1 || !same(decision.calls, retainDecisionCallProgress(decision, state)) ||
      decision.basisRevision >= turns[0]!.committedInRevision ||
      decision.prepared.input.runId !== state.run.id) {
    throw new TypeError("Decision checkpoint does not match committed Run history.");
  }
}

export function retainControllerOperation<T>(prepared: PreparedControllerOperation<T>): RetainedControllerOperation {
  const {output: _output, ...agent} = prepared.input.agent;
  return structuredClone({...prepared, input: {...prepared.input, agent}});
}

/** Rebind only executable validation; do not reproject Context or reselect Tools. */
export function restoreControllerOperation<T>(
  retained: RetainedControllerOperation,
  agent: Agent<T>,
): PreparedControllerOperation<T> {
  const {output, ...definition} = agent;
  if (!same(definition, retained.input.agent)) throw new TypeError("Retained Controller Agent definition is unavailable.");
  assertAgentInstructionBindingMatches({binding: retained.input.instructionBinding, run: {id: retained.input.runId}, agent});
  const manifest = retained.manifest;
  const summary: ControllerInput["contextManifest"] = {
    id: manifest.id, projectionId: manifest.projectionId, requestId: manifest.requestId,
    activeContext: manifest.activeContext, profile: manifest.profile, policy: manifest.policy,
    estimator: manifest.estimator, budget: manifest.budget, accounting: manifest.accounting,
  };
  if (!same(retained.context, retained.input.context) ||
      !same(summary, retained.input.contextManifest) ||
      retained.context.id !== manifest.projectionId ||
      retained.manifest.activeContext.runId !== retained.input.runId ||
      !Number.isFinite(Date.parse(retained.deadlineAt))) {
    throw new TypeError("Retained Controller Context basis is inconsistent.");
  }
  const copy = structuredClone(retained);
  return {...copy, input: {...copy.input, agent: {...copy.input.agent, output}}};
}

/** References are facts, not permission to redispatch an unfinished operation. */
export function retainDecisionCallProgress(
  decision: Pick<RunDecisionCheckpoint, "turn" | "value">,
  state: RunState,
): readonly RunDecisionCallProgress[] {
  if (decision.turn.run.id !== state.run.id) throw new TypeError("Decision progress belongs to another Run.");
  if (decision.value.kind === "continue_with_feedback") return [];
  return decision.value.candidates.map((candidate, candidateIndex) => {
    const key = modelCallRefKey(candidate.modelCallRef);
    const actions = state.items.flatMap(({payload}) => payload.kind === "run_action" &&
      payload.action.provenance.kind === "controller" &&
      payload.action.provenance.turn.id === decision.turn.id &&
      modelCallRefKey(payload.action.provenance.modelCallRef) === key ? [payload.action] : []);
    if (actions.length > 1 || actions.some(action => action.provenance.kind !== "controller" ||
      action.provenance.candidateIndex !== candidateIndex)) {
      throw new TypeError("Decision Call has conflicting RunAction identities.");
    }
    const action = actions[0]?.ref ?? null;
    const settlements = state.items.filter(({payload}) => payload.kind === "model_call_settlement" &&
      modelCallRefKey(payload.result.modelCallRef) === key);
    if (settlements.length > 1) throw new TypeError("Decision Call has conflicting native settlements.");
    return {candidateIndex, call: candidate.modelCallRef, action,
      observationIds: state.items.flatMap(({payload}) => payload.kind === "observation" &&
        payload.observation.runAction.id === action?.id ? [payload.observation.id] : []),
      settlementItemId: settlements[0]?.ref.id ?? null};
  });
}

