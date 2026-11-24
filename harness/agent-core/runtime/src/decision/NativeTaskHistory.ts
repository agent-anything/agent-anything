import {modelCallRefKey, snapshotModelToolResult, type ModelToolResult} from "@agent-anything/model-interaction";
import {snapshotModelPurposeEvidence, nativeModelSourceKey, sameRevisionRef, type ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import type {RunItem} from "../run/RunItem.js";
import type {ModelInteractionProjection, TaskDecisionInputSources,TaskModelCallCorrelation} from "./TaskDecisionActivity.js";
import {snapshotTaskModelCallCorrelation,sameTaskProviderCall} from "./TaskDecisionModelItems.js";
import {projectModelInteraction, ModelInteractionProjectionError} from "./ModelInteractionProjection.js";
import {snapshotInputDeliveryReceipt, type ControllerInputDeliveryBatch, type ControllerInputDeliveryReceipt} from "./DecisionInputDelivery.js";
import {isNativeTaskSeed,snapshotTaskInteractionSeed,type NativeTaskHistorySeed,type TaskInteractionSeed} from "./TaskInteractionSeed.js";

export type NativeTaskHistoryEntry =
  | {readonly kind:"purpose";readonly itemId:string;readonly sequence:number;readonly evidence:ModelPurposeEvidence;readonly calls:readonly TaskModelCallCorrelation[]}
  | {readonly kind:"settlement";readonly itemId:string;readonly sequence:number;readonly result:ModelToolResult}
  | {readonly kind:"delivery";readonly itemId:string;readonly sequence:number;readonly batch:ControllerInputDeliveryBatch;readonly receipt:ControllerInputDeliveryReceipt};
export interface NativeTaskHistory {
  readonly kind:"native_evidence";
  readonly id:string;
  readonly revision:string;
  readonly entries:readonly NativeTaskHistoryEntry[];
  readonly unsettledCalls:readonly TaskModelCallCorrelation[];
  readonly settledCallCount:number;
  readonly seed:NativeTaskHistorySeed|null;
}

/** The coordinator checks local execution facts; only the Protocol owner reads native bodies. */
export function projectNativeTaskHistory(input:{runId:string;runRevision:number;items:readonly RunItem[];seed?:NativeTaskHistorySeed|null}):NativeTaskHistory {
  const entries:NativeTaskHistoryEntry[]=[],pending=new Map<string,TaskModelCallCorrelation>(),calls=new Set<string>(),accepted=new Set<string>();
  let settled=0,protocol:ModelPurposeEvidence["sources"][number]["protocol"]|null=null;
  const fail=(code:string):never=>{throw new ModelInteractionProjectionError(code,"Native task history has inconsistent source or settlement relationships.");};
  for(const [index,item] of input.items.entries()) {
    const p=item.payload,source={itemId:item.ref.id,sequence:item.ref.sequence};
    if(p.kind==="controller_turn") {
      if(!p.modelItems.length)continue;
      if(pending.size)fail("model_call_unsettled_before_next_decision");
      const proofs=p.modelItems.filter(m=>m.kind==="native_purpose_evidence");
      if(proofs.length!==1||p.modelItems.some(m=>m.kind!=="native_purpose_evidence"&&m.kind!=="model_tool_call"&&m.kind!=="native_rejected_call"))fail("native_history_interpreter_mismatch");
      const evidence=snapshotModelPurposeEvidence(proofs[0]!.evidence),key=JSON.stringify(evidence.acceptance);
      if(evidence.scope.runId!==input.runId||accepted.has(key))fail("native_history_acceptance_mismatch");
      accepted.add(key);
      for(const s of evidence.sources) {
        if(protocol&&!sameRevisionRef(protocol,s.protocol))fail("native_history_protocol_changed");
        protocol=s.protocol;
      }
      const sources=new Set(evidence.sources.map(nativeModelSourceKey));
      const requested=p.modelItems.flatMap(m=>m.kind==="model_tool_call"||m.kind==="native_rejected_call"?[snapshotTaskModelCallCorrelation(m.call)]:[]);
      for(const call of requested) {
        const key=modelCallRefKey(call.modelCallRef);
        if(call.modelCallRef.turnId!==null||!sameRevisionRef(call.modelCallRef.purposeAcceptance,evidence.acceptance)||
          !sources.has(nativeModelSourceKey(call.modelCallRef.nativeSource))||calls.has(key))fail("native_history_call_source_mismatch");
        calls.add(key);pending.set(key,call);
      }
      entries.push({kind:"purpose",...source,evidence,calls:requested});
    } else if(p.kind==="model_call_settlement") {
      const result=snapshotModelToolResult(p.result),key=modelCallRefKey(result.modelCallRef),call=pending.get(key);
      if(!call||call.name!==result.name||!sameTaskProviderCall(call.providerCallRef,result.providerCallRef))fail("model_call_settlement_uncorrelated");
      pending.delete(key);settled++;entries.push({kind:"settlement",...source,result});
    } else if(p.kind==="input_delivery") {
      const next=input.items[index+1],receipt=snapshotInputDeliveryReceipt(p.receipt,p.batch)!;
      if(pending.size||p.batch.runId!==input.runId||next?.payload.kind!=="controller_turn"||
        next.payload.turn.id!==p.turn.id||next.committedInRevision!==item.committedInRevision||receipt.via.kind!=="protocol")fail("native_delivery_history_invalid");
      const proof=next!.payload.kind==="controller_turn"?next!.payload.modelItems.find(m=>m.kind==="native_purpose_evidence"):null;
      if(!proof||receipt.via.kind!=="protocol"||!sameRevisionRef(proof.evidence.acceptance,receipt.via.evidence.acceptance))fail("native_delivery_acceptance_mismatch");
      entries.push({kind:"delivery",...source,batch:p.batch,receipt});
    }
  }
  return Object.freeze({kind:"native_evidence",id:`${input.runId}:native-history`,revision:String(input.runRevision),
    entries:Object.freeze(entries),unsettledCalls:Object.freeze([...pending.values()]),settledCallCount:settled,
    seed:input.seed?snapshotTaskInteractionSeed(input.seed) as NativeTaskHistorySeed:null});
}

export function projectTaskInteraction(input:Omit<Parameters<typeof projectModelInteraction>[0],"seed">&{kind?:"turn_messages"|"native_evidence";seed?:TaskInteractionSeed|null}):ModelInteractionProjection|NativeTaskHistory {
  if(input.kind!=="native_evidence"){
    if(input.seed&&isNativeTaskSeed(input.seed))throw new TypeError("native_import_participant_required");
    return projectModelInteraction({...input,seed:input.seed});
  }
  if(input.seed&&!isNativeTaskSeed(input.seed))throw new ModelInteractionProjectionError("native_history_seed_contract_required","A Turn-message seed cannot be imported as native history.");
  return projectNativeTaskHistory({...input,seed:input.seed});
}

export function requireTurnTaskInput<T extends Pick<TaskDecisionInputSources,"interaction">>(input:T):asserts input is T&{interaction:ModelInteractionProjection} {
  if(input.interaction.kind==="native_evidence")throw new TypeError("turn_task_input_participant_mismatch");
}

/** Closed historical imports retain correlations without turning them into new execution requests. */
export function snapshotNativeTaskHistoryEntries(runId:string,entries:readonly NativeTaskHistoryEntry[]) {
  const pending=new Map<string,TaskModelCallCorrelation>(),calls=new Set<string>(),purposes=new Set<string>(),ids=new Set<string>();
  let sequence=-1,protocol:ModelPurposeEvidence["sources"][number]["protocol"]|null=null;
  const checked=entries.map((entry,index):NativeTaskHistoryEntry=>{
    if(!entry.itemId||ids.has(entry.itemId)||!Number.isSafeInteger(entry.sequence)||entry.sequence<=sequence)throw new TypeError("native_import_order_invalid");
    ids.add(entry.itemId);sequence=entry.sequence;
    if(entry.kind==="purpose"){
      const evidence=snapshotModelPurposeEvidence(entry.evidence),key=JSON.stringify(evidence.acceptance);
      if(evidence.scope.runId!==runId||pending.size||purposes.has(key))throw new TypeError("native_import_purpose_invalid");
      purposes.add(key);const sources=new Set(evidence.sources.map(nativeModelSourceKey));
      for(const s of evidence.sources){if(protocol&&!sameRevisionRef(protocol,s.protocol))throw new TypeError("native_import_protocol_changed");protocol=s.protocol;}
      const requested=entry.calls.map(snapshotTaskModelCallCorrelation);
      for(const call of requested){const id=modelCallRefKey(call.modelCallRef);
        if(call.modelCallRef.turnId!==null||calls.has(id)||!sameRevisionRef(call.modelCallRef.purposeAcceptance,evidence.acceptance)||
          !sources.has(nativeModelSourceKey(call.modelCallRef.nativeSource)))throw new TypeError("native_import_call_invalid");
        pending.set(id,call);calls.add(id);
      }
      return {...entry,evidence,calls:requested};
    }
    if(entry.kind==="settlement"){
      const result=snapshotModelToolResult(entry.result),key=modelCallRefKey(result.modelCallRef),call=pending.get(key);
      if(!call||call.name!==result.name||!sameTaskProviderCall(call.providerCallRef,result.providerCallRef))throw new TypeError("native_import_settlement_invalid");
      pending.delete(key);return {...entry,result};
    }
    if(entry.kind!=="delivery")throw new TypeError("native_import_entry_invalid");
    const receipt=snapshotInputDeliveryReceipt(entry.receipt,entry.batch)!,next=entries[index+1];
    if(pending.size||entry.batch.runId!==runId||receipt.via.kind!=="protocol"||next?.kind!=="purpose"||
      !sameRevisionRef(receipt.via.evidence.acceptance,next.evidence.acceptance))throw new TypeError("native_import_delivery_invalid");
    return {...entry,receipt};
  });
  return {entries:checked,unsettledCalls:[...pending.values()]};
}

