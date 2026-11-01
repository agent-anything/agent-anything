import type {ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {MaterialRecipient} from "@agent-anything/context/custody";
import type {ProviderResponse} from "@agent-anything/model-interaction";
import {modelInputValueDigest,modelInputSectionLocations,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import {validatePreparedContextInput,type PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import {inputNotificationDigest,retainInputPresentation,snapshotInputPresentation,type ControllerInputDeliveryBatch,type ControllerInputDeliveryReceipt} from "./DecisionInputDelivery.js";
import type {RunInputNotification} from "../execution-coordinator/RunInputNotifications.js";
import {validateTaskModelResponseRejectionRaw, type TaskModelResponseRejection} from "./TaskModelResponseRejection.js";
import {recipientContextDeliveryId} from "../context-representation/ContextDeliveryFacts.js";

export interface SelectedInputDeliveryBasis {
  readonly revision:"2";
  readonly inputId:string;
  readonly selectionId:string;
  readonly inputAcceptanceId:string;
  readonly responseAcceptanceId:string;
  readonly rawResultId:string;
  readonly encodedInputId:string;
  readonly recipient:MaterialRecipient;
  readonly mapping:readonly {readonly sequence:number;readonly notificationId:string;readonly deliveryId:string;readonly sectionIds:readonly string[]}[];
  readonly digest:string;
}

export function inputNotificationDeliveryId(entry:RunInputNotification):string {
  return `${entry.runId}:addressed-input:${entry.sequence}:${inputNotificationDigest(entry)}`;
}

/** Called by the original consumer in the same acceptance that confirms receipt of the saved response. */
export function createSelectedInputDeliveryReceipt(input:{
  readonly batch:ControllerInputDeliveryBatch|null|undefined;
  readonly binding:ContextSelectionSnapshot;
  readonly response:ProviderResponse;
  readonly rawResultId:string;
  readonly responseAcceptanceId:string;
  readonly responseRejection?:TaskModelResponseRejection|null;
}):ControllerInputDeliveryReceipt|null {
  const {batch,binding}=input;
  if(!batch)return null;
  const prepared=binding.input.exactInput as PreparedContextInput;
  validatePreparedContextInput(prepared);
  const rejected=input.responseRejection;
  if(rejected) {
    validateTaskModelResponseRejectionRaw(rejected,input.response,prepared.request);
    if(rejected.runId!==batch.runId||rejected.requestId!==prepared.request.requestId||rejected.controllerRequestId!==prepared.request.correlation.controllerRequestId||
      rejected.rawResultId!==input.rawResultId||rejected.responseAcceptanceId!==input.responseAcceptanceId)throw new TypeError("selected_input_delivery_binding_invalid");
  }
  if(binding.scope.runId!==batch.runId||prepared.demand.runId!==batch.runId||prepared.demand.recipient!==binding.scope.recipient||
    binding.input.selectionId!==binding.selection.id||binding.scope.purpose!==prepared.request.purpose||
    (!rejected&&(input.response.kind!=="native_tool_turn"||input.response.turn.responseRef.requestId!==prepared.request.requestId)))
    throw new TypeError("selected_input_delivery_binding_invalid");
  const requested=new Set<string>();
  const recipient={runId:binding.scope.runId,recipient:binding.scope.recipient,purpose:binding.scope.purpose};
  const mapping=batch.entries.map(entry=>{
    const notificationId=inputNotificationDeliveryId(entry),id=recipientContextDeliveryId(notificationId,recipient);
    const delivery=binding.deliveries.find(value=>value.id===id);
    const contribution=prepared.demand.contributions.find(value=>value.deliveryIds.includes(id));
    const option=contribution?.options.find(value=>value.id===prepared.choice[contribution.id]);
    if(!delivery||delivery.recipient.runId!==batch.runId||delivery.recipient.recipient!==binding.scope.recipient||
      delivery.recipient.purpose!==binding.scope.purpose||delivery.sourceId!==entry.source.id||!option||!prepared.deliveries.some(value=>value.id===id))
      throw new TypeError("selected_input_delivery_source_missing");
    const sectionIds=option.sections.filter(value=>value.section.provenance?.sources.some(ref=>sameSource(ref,entry.source)))
      .map(value=>value.section.id);
    if(!sectionIds.length)throw new TypeError("selected_input_delivery_source_missing");
    sectionIds.forEach(id=>requested.add(id));
    return {sequence:entry.sequence,notificationId,deliveryId:id,sectionIds};
  });
  const sections=prepared.request.composition.sections.filter(section=>requested.has(section.id));
  if(sections.length!==requested.size)throw new TypeError("selected_input_delivery_presentation_missing");
  const first=prepared.request.composition.sections.findIndex(section=>requested.has(section.id));
  if(prepared.request.composition.sections.slice(first).some(section=>section.role==="assistant"||section.role==="tool"))
    throw new TypeError("selected_input_delivery_order_invalid");
  const locations=modelInputSectionLocations(prepared.request.composition.sections);
  if(sections.some(section=>!locations.some(location=>location.sectionId===section.id&&location.jsonPointers.length>0)))
    throw new TypeError("selected_input_delivery_location_missing");
  const via={kind:"provider" as const,requestId:prepared.request.requestId,compositionId:prepared.request.composition.id,
    workingViewId:prepared.request.composition.workingView.id,sectionIds:sections.map(section=>section.id),presentations:sections.map(retainInputPresentation)};
  const basis={revision:"2" as const,inputId:binding.input.id,selectionId:binding.selection.id,inputAcceptanceId:binding.acceptanceId,
    responseAcceptanceId:input.responseAcceptanceId,rawResultId:input.rawResultId,encodedInputId:prepared.encoded.id,recipient,mapping};
  const receipt={batch:{id:batch.id,revision:batch.revision,runId:batch.runId},
    entries:batch.entries.map(entry=>({sequence:entry.sequence,digest:inputNotificationDigest(entry)})),
    via:{...via,selection:{...basis,digest:modelInputValueDigest({batch:{id:batch.id,revision:batch.revision,runId:batch.runId},via,basis})}}};
  return snapshotSelectedInputDeliveryReceipt(receipt,batch);
}

/** Validates the retained receipt; it never substitutes for the original shared acceptance. */
export function snapshotSelectedInputDeliveryReceipt(receipt:ControllerInputDeliveryReceipt,batch:ControllerInputDeliveryBatch):ControllerInputDeliveryReceipt {
  const via=receipt.via;
  if(via.kind!=="provider"||!via.selection)throw new TypeError("selected_input_delivery_basis_missing");
  const {selection,...base}=via,{digest,...basis}=selection;
  if(basis.revision!=="2")throw new TypeError("selected_input_delivery_revision_unavailable");
  if(!basis.recipient||basis.recipient.runId!==batch.runId)throw new TypeError("selected_input_delivery_recipient_invalid");
  recipientContextDeliveryId(batch.id,basis.recipient);
  for(const identity of [basis.inputId,basis.selectionId,basis.inputAcceptanceId,basis.responseAcceptanceId,basis.rawResultId,basis.encodedInputId,
    via.requestId,via.compositionId,via.workingViewId])if(typeof identity!=="string"||!identity.trim())throw new TypeError("selected_input_delivery_identity_invalid");
  if(digest!==modelInputValueDigest({batch:receipt.batch,via:base,basis})||basis.mapping.length!==batch.entries.length||
    !Array.isArray(via.presentations)||!via.presentations.length||new Set(via.sectionIds).size!==via.sectionIds.length||
    JSON.stringify(via.sectionIds)!==JSON.stringify(via.presentations.map(value=>value.section.id)))
    throw new TypeError("selected_input_delivery_receipt_changed");
  const presentations=via.presentations.map(snapshotInputPresentation),covered=new Set<string>();
  let previous=-1;
  for(const [index,entry] of batch.entries.entries()) {
    const mapped=basis.mapping[index]!;
    if(mapped.sequence!==entry.sequence||mapped.notificationId!==inputNotificationDeliveryId(entry)||
      mapped.deliveryId!==recipientContextDeliveryId(mapped.notificationId,basis.recipient)||!mapped.sectionIds.length||
      new Set(mapped.sectionIds).size!==mapped.sectionIds.length)throw new TypeError("selected_input_delivery_mapping_invalid");
    const positions=mapped.sectionIds.map(id=>via.sectionIds.indexOf(id));
    if(positions.some((value,index)=>value<0||(index>0&&value<=positions[index-1]!))||positions[0]!<previous)
      throw new TypeError("selected_input_delivery_order_invalid");
    previous=positions[0]!;
    for(const id of mapped.sectionIds) {
      const section=presentations.find(value=>value.section.id===id)!.section;
      if(section.role!=="user"||section.provenance?.recipientRunId!==batch.runId||!section.provenance.sources.some(ref=>sameSource(ref,entry.source)))
        throw new TypeError("selected_input_delivery_provenance_invalid");
      covered.add(id);
    }
  }
  if(covered.size!==presentations.length)throw new TypeError("selected_input_delivery_unmapped_content");
  return structuredClone({...receipt,via:{...via,presentations}});
}
function sameSource(a:ModelInputSourceRef,b:ModelInputSourceRef):boolean {return modelInputValueDigest(a)===modelInputValueDigest(b);}
