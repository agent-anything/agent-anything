import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {SharedAcceptanceProposal} from "../activity/SharedAcceptance.js";
import {contextPreparationAcceptance} from "./ContextPreparationAcceptance.js";

/** One short acceptance of a professional choice, finite B and an already checked exact input. */
export function contextPreparationAdoption(input:{
  readonly policy:Parameters<typeof contextPreparationAcceptance>[0];
  readonly checkedInput:SharedAcceptanceProposal;
}):SharedAcceptanceProposal {
  const proposed=contextPreparationAcceptance(input.policy),decision=proposed.decision,checked=input.checkedInput;
  if(decision.foreground.kind!=="continue"||decision.investment.kind==="propose"||
    checked.id!==proposed.acceptance.id||checked.scope!==proposed.acceptance.scope||checked.actor!==proposed.acceptance.actor)
    throw new TypeError("context_adoption_decision_binding_invalid");
  const selections=checked.parts.filter(p=>p.owner==="context_selection"&&p.kind==="selection_input");
  if(selections.length!==1)throw new TypeError("context_adoption_input_ambiguous");
  const selection=selections[0]!.proposal as import("@agent-anything/context/selection").ContextSelectionProposal;
  const prepared=selection.input?.exactInput as import("./ContextInputPreparation.js").PreparedContextInput|undefined;
  if(selection.scopeId!==decision.scope.id||!prepared||prepared.encoded.id!==decision.foreground.preparedInputId)
    throw new TypeError("context_adoption_input_mismatch");
  const originals=[input.policy.input.current,...input.policy.input.alternatives.map(a=>a.input)];
  if(!originals.some(value=>value.kind==="prepared"&&modelInputValueDigest(value.prepared)===modelInputValueDigest(prepared)))
    throw new TypeError("context_adoption_input_not_evaluated");
  return {...proposed.acceptance,parts:[...proposed.acceptance.parts,...checked.parts]};
}
