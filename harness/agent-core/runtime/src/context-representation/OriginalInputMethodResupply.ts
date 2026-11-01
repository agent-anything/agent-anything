import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources} from "./OriginalInputSources.js";
import {describeOriginalInputAccountScope} from "./OriginalInputAccountScopes.js";
import {describeOriginalInputResultTextScope} from "./OriginalInputResultTextScope.js";
import {supplyOriginalInputAccountMethod} from "./OriginalInputAccountMethodSupply.js";
import {supplyOriginalInputResultTextMethod} from "./OriginalInputResultTextMethod.js";
import {describeOriginalInputDataTextScope} from "./OriginalInputDataTextScope.js";
import {supplyOriginalInputDataTextMethod} from "./OriginalInputDataTextMethod.js";
import type {OriginalInputRepresentationSupply} from "./OriginalInputRepresentationPlan.js";
import type {ContextPreparationOption} from "./ContextPreparationPolicy.js";

type SupplyInput=Omit<Parameters<typeof supplyOriginalInputAccountMethod>[0],"scope">;
type Resupply={readonly kind:"available";readonly supply:OriginalInputRepresentationSupply}|
  {readonly kind:"unavailable";readonly reason:string};

/** Revalidates the exact original scope, independently of bounded new-opportunity enumeration. */
export function resupplyOriginalInputMethod(input:SupplyInput,original:ContextPreparationOption):Resupply {
  const {sources}=input;validateOriginalInputSources(sources);
  if(!original.stableScope||original.request.recipient.runId!==sources.runId||original.request.targetRevision!==input.target)
    return {kind:"unavailable",reason:"original_method_recipient_or_target_changed"};
  const groups=original.request.sources.map(source=>({source,group:sources.groups.find(g=>g.id===source.indivisibleGroup)}));
  if(groups.some(g=>!g.group||g.source.role==="candidate")||new Set(groups.map(g=>g.group!.id)).size!==groups.length)
    return {kind:"unavailable",reason:"original_method_source_unavailable"};
  const included=groups.map(g=>g.group!),selected=groups.filter(g=>g.source.role==="source").map(g=>g.group!);
  if(!selected.length)return {kind:"unavailable",reason:"original_method_source_unavailable"};
  try {
    let supply:OriginalInputRepresentationSupply|undefined;
    for(const declaration of selected.flatMap(g=>g.resultTexts??[])) {
      const scope=describeOriginalInputResultTextScope(sources,declaration,included.map(g=>g.id));
      if(scope.id===original.stableScope.id){supply=supplyOriginalInputResultTextMethod({...input,scope});break;}
    }
    if(!supply)for(const declaration of selected.flatMap(g=>g.dataTexts??[])) {
      const scope=describeOriginalInputDataTextScope(sources,declaration,included.map(g=>g.id));
      if(scope.id===original.stableScope.id){supply=supplyOriginalInputDataTextMethod({...input,scope});break;}
    }
    if(!supply&&selected.every(group=>group.occurrences.every(o=>o.section.preservation))) {
      const account=describeOriginalInputAccountScope(sources,selected,included);
      if(account.id===original.stableScope.id)supply=supplyOriginalInputAccountMethod({...input,scope:account});
    }
    if(!supply)return {kind:"unavailable",reason:"original_method_scope_changed"};
    if(supply.option.id!==original.id||modelInputValueDigest(supply.request)!==modelInputValueDigest(original.request))
      return {kind:"unavailable",reason:"original_method_binding_changed"};
    return {kind:"available",supply};
  } catch(error) {
    if(error instanceof TypeError&&[
      "original_account_companion_missing","original_account_scope_changed","original_account_scope_invalid",
      "original_result_text_companion_missing","original_result_text_authorization_missing","original_result_text_scope_changed",
      "original_data_text_authorization_missing","original_data_text_scope_changed","original_text_companion_missing","original_text_authorization_missing",
      "Account scope must be one ordered contiguous interval.","Account scope contains protected input.",
      "Account scope has an unavailable declared companion.","Account scope splits a native exchange."
    ].includes(error.message))return {kind:"unavailable",reason:error.message};
    throw error;
  }
}
