import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {resolveResponsesInputContinuity,responsesInputStore,nativeInputSettings,type NativeInputManifest} from "@agent-anything/provider-integrations/native";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";

/** Realizes the selected native content, without choosing a representation or changing policy. */
export function realizeHelarcNativeInput(manifest:NativeInputManifest,wire:HelarcRetainedNativeInput["wire"],
  continuity:HelarcRetainedNativeInput["continuity"]):Pick<HelarcRetainedNativeInput,"wire"|"prefixGroups"|"predecessor"|"continuity"> {
  const body=JSON.parse(wire.body);
  if(digest(body)!==wire.digest||digest(nativeInputSettings(body))!==digest(manifest.settings))
    throw new TypeError("native_input_realization_settings_changed");
  if(continuity.kind==="explicit"){
    if(manifest.protocol.id==="openai.responses"||body.previous_response_id||body.conversation)
      throw new TypeError("native_input_realization_protocol_changed");
    return {wire,prefixGroups:0,predecessor:null,continuity};
  }
  const plan=resolveResponsesInputContinuity(manifest,continuity);
  if(body.store!==responsesInputStore(continuity)||body.conversation)
    throw new TypeError("native_input_realization_storage_changed");
  const {previous_response_id:_,...request}=body;
  const realized={...request,input:manifest.groups.slice(plan.prefixGroups).flatMap(g=>g.items),
    ...(plan.predecessor?{previous_response_id:plan.predecessor}:{})};
  return {wire:{body:JSON.stringify(realized),digest:digest(realized)},prefixGroups:plan.prefixGroups,predecessor:plan.predecessor,continuity};
}
