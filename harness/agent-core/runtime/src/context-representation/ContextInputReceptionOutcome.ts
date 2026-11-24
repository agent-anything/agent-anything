import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "../activity/index.js";
import type {ContextInputReceptionBinding} from "./ContextInputReceptionBinding.js";
import type {ContextInputPreparationGap} from "./ContextInputPreparation.js";
import type {ContextRecipientInputReadiness} from "./ContextPreparationPolicy.js";

/** Accepted receiver evidence, independent of its private native organization plan. */
export interface ContextInputReceptionOutcome {
  readonly kind:"context_input_reception_outcome";
  readonly revision:"1";
  readonly bindingDigest:string;
  readonly result:
    | {readonly kind:"checked";readonly input:ContextRecipientInputReadiness}
    | {readonly kind:"gap";readonly gap:ContextInputPreparationGap};
}

export function readContextInputReceptionOutcome(binding:ContextInputReceptionBinding,path:ActivityPathState,stage:ActivityStageState):ContextInputReceptionOutcome {
  const outcome=(stage.receipt?.progress as {inputReceptionOutcome?:ContextInputReceptionOutcome}|null)?.inputReceptionOutcome;
  const {scope}=binding;
  if(path.intent.id!==binding.pathId||path.intent.runId!==scope.runId||path.intent.owner!==scope.owner||
    path.intent.permissionBasis!==scope.authorityBasis||path.intent.scheduledWorkId!==binding.workId||
    stage.request.pathId!==path.intent.id||stage.status!=="accepted"||stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||
    stage.receipt?.resultId!==stage.result.id||stage.receipt.requestId!==stage.request.id||stage.receipt.owner!==scope.owner||
    stage.receipt.expectedProgressRevision+1!==path.progressRevision||digest(stage.receipt.progress)!==digest(path.progress)||
    !outcome||outcome.kind!=="context_input_reception_outcome"||outcome.revision!=="1"||outcome.bindingDigest!==digest(binding))
    throw new TypeError("input_reception_outcome_unconfirmed");
  if(outcome.result.kind==="checked"){
    if(outcome.result.input.kind!=="recipient_prepared"||digest(outcome.result.input.scope)!==digest(scope))
      throw new TypeError("input_reception_outcome_scope_changed");
  }else if(outcome.result.kind!=="gap"||outcome.result.gap.targetRevision!==scope.target)
    throw new TypeError("input_reception_outcome_scope_changed");
  return outcome;
}
