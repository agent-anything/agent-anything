import { contextPreparedInputAcceptance } from "@agent-anything/agent-runtime/context-representation";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { assertNativeInputManifest, nativeInputSettings, resolveResponsesInputContinuity, responsesInputStore, validateDeepSeekChatInputGroups, validateOllamaChatInputGroups } from "@agent-anything/provider-integrations/native";
import { OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT } from "@agent-anything/model-interaction/protocol";
import {validateHelarcResponsesCompactionAgreement} from "./HelarcResponsesCompaction.js";
import {validateHelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";

export type {HelarcRetainedNativeInput,HelarcNativeResultPresentation} from "./HelarcRetainedNativeInput.js";
import type {HelarcRetainedNativeInput} from "./HelarcRetainedNativeInput.js";

function selectedRepresentations(native:HelarcRetainedNativeInput) {
  return [...new Map([...native.manifest.groups.map(g=>g.representation),...(native.resultPresentations??[]).map(p=>p.representation)]
    .map(ref=>[modelInputValueDigest(ref),ref])).values()];
}

/** A body slot belongs to an actually transmitted group, not a remote prefix or another Call. */
export function validateHelarcNativeResultPositions(native:HelarcRetainedNativeInput):void {
  const path=native.manifest.protocol.id===OPENAI_RESPONSES.id?"input":"messages";
  const positions=new Map<string,string>();
  let index=0;
  for(const group of native.manifest.groups.slice(native.prefixGroups))for(const _item of group.items)positions.set(`/${path}/${index++}`,group.id);
  const slots=new Set<string>();
  for(const presentation of native.resultPresentations??[]){
    const identity=modelInputValueDigest([presentation.position,presentation.slot.contentPath]);
    if(positions.get(presentation.position)!==presentation.groupId||slots.has(identity))throw new TypeError("native_result_group_position_invalid");
    slots.add(identity);
  }
}

/** Product input collaboration hands one native realization to existing selection/custody acceptance. */
export function helarcNativeInputAcceptance(input: Omit<Parameters<typeof contextPreparedInputAcceptance>[0], "preparedValue" | "preparedScope" | "deliveries"> & {
  readonly native: HelarcRetainedNativeInput;
  readonly retainedSelection?: NonNullable<Parameters<typeof contextPreparedInputAcceptance>[0]["selection"]>;
}) {
  const { native, scope, selection, inputHolds } = input, { manifest } = native;
  assertNativeInputManifest(manifest);
  if(native.workingSources){
    const items=manifest.groups.flatMap(g=>g.items);
    validateHelarcNativeWorkingSources(native.workingSources,manifest.protocol.id!==OPENAI_RESPONSES.id&&items[0]?.role==="system"?items.slice(1):items);
  }
  validateHelarcNativeResultPositions(native);
  if(input.nativeConsumer&&(modelInputValueDigest(input.nativeConsumer.protocol)!==modelInputValueDigest(manifest.protocol)||
    input.nativeConsumer.compositionDigest!==manifest.scope.compositionDigest))throw new TypeError("helarc_native_input_consumer_changed");
  const body = JSON.parse(native.wire.body), valueDigest = modelInputValueDigest;
  if (native.wire.digest !== valueDigest(body) || valueDigest(nativeInputSettings(body)) !== valueDigest(manifest.settings) ||
    !Number.isSafeInteger(native.prefixGroups) || native.prefixGroups < 0 || native.prefixGroups > manifest.groups.length ||
    (native.prefixGroups > 0 && !native.predecessor) || (body.previous_response_id ?? null) !== native.predecessor ||
    valueDigest(body.input ?? body.messages) !== valueDigest(manifest.groups.slice(native.prefixGroups).flatMap(g => g.items)))
    throw new TypeError("helarc_native_realization_changed");
  if (manifest.protocol.id === OPENAI_RESPONSES.id) {
    if(body.context_management!==undefined){
      if(!native.compactionAgreement)throw new TypeError("helarc_native_compaction_agreement_missing");
      validateHelarcResponsesCompactionAgreement(native.compactionAgreement,manifest,body);
    }else if(native.compactionAgreement)throw new TypeError("helarc_native_compaction_options_missing");
    if (native.continuity.kind !== "responses") throw new TypeError("helarc_native_continuity_missing");
    const plan = resolveResponsesInputContinuity(manifest, native.continuity);
    if (plan.prefixGroups !== native.prefixGroups || plan.predecessor !== native.predecessor || body.store !== responsesInputStore(native.continuity))
      throw new TypeError("helarc_native_prefix_unproven");
  } else if (native.continuity.kind !== "explicit" || native.prefixGroups !== 0 || native.predecessor !== null) {
    throw new TypeError("helarc_native_continuity_invalid");
  } else if (manifest.protocol.id === DEEPSEEK_CHAT_COMPLETIONS.id) {
    validateDeepSeekChatInputGroups(manifest);
  } else if (manifest.protocol.id === OLLAMA_CHAT.id) {
    validateOllamaChatInputGroups(manifest);
  } else {
    throw new TypeError("helarc_native_input_protocol_unsupported");
  }
  const selected = selection ?? input.retainedSelection;
  if (!selected || (!selection && selected.id !== input.retainedSelectionId) || selected.id !== manifest.selection.id || scope.id !== manifest.scope.id || scope.runId !== manifest.scope.runId ||
    scope.recipient !== manifest.scope.recipientId || scope.purpose !== manifest.scope.purpose.id || scope.target !== manifest.target.configuration ||
    valueDigest(selected.representations) !== valueDigest(selectedRepresentations(native)) ||
    valueDigest(selected.judgmentIds) !== valueDigest(manifest.selection.judgments))
    throw new TypeError("helarc_native_selection_changed");
  for (const group of manifest.groups) for (const holdId of group.holds) {
    const hold = inputHolds.find(h => h.id === holdId);
    if (!hold || hold.consumer.runId !== scope.runId || hold.consumer.recipient !== scope.recipient || hold.consumer.purpose !== scope.purpose)
      throw new TypeError("helarc_native_input_hold_missing");
  }
  const deliveries = manifest.groups.flatMap((g, index) => g.deliveries.map(id => ({ id, position: `/manifest/groups/${index}` })));
  return contextPreparedInputAcceptance({ ...input, preparedValue: native,
    preparedScope: { runId: scope.runId, recipient: scope.recipient, purpose: scope.purpose, target: scope.target }, deliveries });
}
