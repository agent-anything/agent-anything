import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {SharedAcceptanceProposal} from "../activity/SharedAcceptance.js";
import {contextPreparationAcceptance} from "./ContextPreparationAcceptance.js";
import type {ContextPreparationMethodRequest} from "./ProtocolRepresentationMethod.js";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";

/** One short acceptance of a professional choice, finite B and an already checked exact input. */
export function contextPreparationAdoption<R extends ContextPreparationMethodRequest=RepresentationMethodRequest>(input:{
  readonly policy:Parameters<typeof contextPreparationAcceptance<R>>[0];
  readonly checkedInput:SharedAcceptanceProposal;
}):SharedAcceptanceProposal {
  const proposed=contextPreparationAcceptance(input.policy),decision=proposed.decision,checked=input.checkedInput;
  if(decision.foreground.kind!=="continue"||
    checked.id!==proposed.acceptance.id||checked.scope!==proposed.acceptance.scope||checked.actor!==proposed.acceptance.actor)
    throw new TypeError("context_adoption_decision_binding_invalid");
  const selections=checked.parts.filter(p=>p.owner==="context_selection"&&p.kind==="selection_input");
  if(selections.length!==1)throw new TypeError("context_adoption_input_ambiguous");
  const selection=selections[0]!.proposal as import("@agent-anything/context/selection").ContextSelectionProposal;
  const prepared=selection.input?.exactInput;
  if(selection.scopeId!==decision.scope.id||!prepared)
    throw new TypeError("context_adoption_input_mismatch");
  const originals=[input.policy.input.current,...input.policy.input.alternatives.map(a=>a.input)];
  const selectedId=decision.foreground.preparedInputId;
  if(!originals.some(value=>value.kind==="prepared"?
    value.prepared.encoded.id===selectedId&&modelInputValueDigest(value.prepared)===modelInputValueDigest(prepared):
    value.kind==="recipient_prepared"&&value.allowed&&value.inputId===selectedId&&selection.input?.id===selectedId&&
    value.exactInputDigest===modelInputValueDigest(prepared)&&modelInputValueDigest(value.scope)===modelInputValueDigest(input.policy.input.scope)&&
    selection.input.combinationJudgmentId===value.judgmentId))
    throw new TypeError("context_adoption_input_not_evaluated");
  return {...proposed.acceptance,parts:[...proposed.acceptance.parts,...checked.parts]};
}
