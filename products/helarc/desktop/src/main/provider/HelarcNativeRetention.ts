import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {retainProtocolContent,type ProtocolExecutionState,type ProtocolJournalRecord,type ProtocolRetentionStatus} from "@agent-anything/agent-runtime/model-access";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {readProtocolContent} from "@agent-anything/agent-runtime/model-access";

export interface HelarcNativeDeliveryResolution {readonly basis:ProtocolJournalRecord["ref"];readonly resolved:boolean;}
/** Accept only the original owner's explicit known disposition, never connection release alone. */
export async function settleHelarcNativeInputUse(store:HelarcExecutionStore,state:ProtocolExecutionState,resolution:HelarcNativeDeliveryResolution):Promise<void>{
  if(!resolution.resolved||!state.contextInput||!state.cancelled||state.accepted||state.inputUseSettlement)return;
  const proposal={scope:state.activity.scope.runId,actor:state.activity.composition.composition.adapter.implementation.id,
    parts:[{owner:"protocol_execution" as const,kind:"settle_input_use" as const,
      proposal:{activityId:state.activity.scope.activityId,input:state.contextInput,nativeBasis:resolution.basis}}]};
  const receipt=await store.sharedAcceptance.accept({id:`native-input-use-settlement:${digest(proposal)}`,...proposal});
  if(receipt.outcome!=="accepted")throw new TypeError(`native_input_use_settlement_rejected:${receipt.rejection?.code}`);
}
export async function readHelarcNativeDischarge(store:HelarcExecutionStore,state:ProtocolExecutionState):Promise<Readonly<Record<string,unknown>>|null>{
  if(!state.retentionReleased||!state.retentionBasis)return null;
  const activityId=state.activity.scope.activityId;
  const record=await store.protocolJournal.command({kind:"record",activityId,ref:state.retentionBasis}) as ProtocolJournalRecord|null;
  if(!record||record.kind!=="native_checkpoint"||record.activityId!==activityId)throw new TypeError("native_retirement_original_basis_missing");
  const value=JSON.parse((await readProtocolContent(store.protocolJournal,record.content,activityId,64*1024)).toString());
  if(!value||typeof value!=="object"||digest(value.originalInput)!==digest(state.input))throw new TypeError("native_retirement_original_input_changed");
  return value;
}

/** The native owner supplies the disposition. Shared acceptance rechecks every pending consumer. */
export async function releaseHelarcNativeRetention(store:HelarcExecutionStore,original:ProtocolExecutionState,basis:{
  readonly operationId:string;readonly dependencies:ProtocolJournalRecord["dependencies"];readonly value:unknown;
}):Promise<boolean>{
  const id=original.activity.scope.activityId;
  const status=await store.protocolJournal.command({kind:"retention_status",activityId:id}) as ProtocolRetentionStatus|null;
  if(!status||digest(status.state.activity)!==digest(original.activity))throw new TypeError("native_retirement_original_changed");
  if(status.state.retentionReleased)return true;
  if(!status.state.accepted&&!status.state.cancelled||status.pendingEffects||status.pendingDeliveries||status.pendingHandoffs)return false;
  const state=await claimHelarcNativeRetirement(store,status.state);
  const ref={id:`${id}:dependency-discharge:${digest(basis)}`,revision:"1"};
  const content=await retainProtocolContent(store.protocolJournal,`${ref.id}:content`,id,Buffer.from(JSON.stringify(basis.value)));
  const record:ProtocolJournalRecord={ref,activityId:id,operationId:basis.operationId,kind:"native_checkpoint",content,source:null,dependencies:basis.dependencies};
  const proposal={scope:state.activity.scope.runId,actor:state.activity.composition.composition.adapter.implementation.id,
    parts:[{owner:"protocol_execution" as const,kind:"record" as const,proposal:{record,fence:state.fence}},
      {owner:"protocol_execution" as const,kind:"release_retention" as const,proposal:{fence:state.fence,nativeBasis:ref}}]};
  const receipt=await store.sharedAcceptance.accept({id:`native-retirement:${digest(proposal)}`,...proposal});
  if(receipt.outcome!=="accepted")throw new TypeError(`native_retirement_rejected:${receipt.rejection?.code}`);
  return true;
}

export async function claimHelarcNativeRetirement(store:HelarcExecutionStore,state:ProtocolExecutionState):Promise<ProtocolExecutionState>{
  const id=state.activity.scope.activityId;
  if(state.fence.generation!==store.generation||state.fence.epoch===0){
    const claim=await store.sharedAcceptance.accept({id:`${id}:retirement-claim:${store.generation}:${state.fence.epoch}`,
      scope:state.activity.scope.runId,actor:state.activity.composition.composition.adapter.implementation.id,
      parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]});
    if(claim.outcome!=="accepted")throw new TypeError(`native_retirement_claim_rejected:${claim.rejection?.code}`);
    state=await store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState;
  }
  return state;
}
