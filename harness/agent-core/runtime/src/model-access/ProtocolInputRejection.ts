import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {SharedAcceptancePort} from "../activity/SharedAcceptance.js";
import type {ProtocolContentRef,ProtocolExecutionJournal,ProtocolExecutionState,ProtocolJournalRecord} from "./ProtocolExecutionJournal.js";
import {retainProtocolContent,readProtocolContent} from "./ProtocolContentAccess.js";

/** A native owner's capacity conclusion, not a generic interpretation of its response. */
export interface ProtocolInputRejection {
  readonly kind:"protocol_input_rejection";
  readonly revision:"1";
  readonly scope:ContextUseScope;
  readonly boundary:string;
  readonly inputId:string;
  readonly exactInputDigest:string;
  readonly bodyDigest:string;
  readonly originalInput:ProtocolContentRef;
  readonly observation:ProtocolRevisionRef;
  readonly reason:"input_capacity_exceeded";
}

/** Small reference used by CRM; it does not carry native request/response bodies. */
export interface ProtocolInputRejectionEvidence {
  readonly kind:"recipient";
  readonly activityId:string;
  readonly scopeId:string;
  readonly boundary:string;
  readonly inputId:string;
  readonly exactInputDigest:string;
  readonly targetRevision:string;
  readonly bodyDigest:string;
  readonly evidence:{readonly owner:string;readonly id:string;readonly revision:string;readonly kind:"fact"};
}

export const PROTOCOL_INPUT_REJECTION_MAXIMUM_BYTES=16384;

/** Recover a previously accepted classification without opening a Provider connection. */
export async function readProtocolInputRejection(journal:ProtocolExecutionJournal,state:ProtocolExecutionState):Promise<{
  proof:ProtocolInputRejection;observation:ProtocolJournalRecord;
}|null>{
  const evidence=state.inputRefusal;if(!evidence)return null;
  const {activity}=state,scope=activity.scope,configuration=activity.composition.composition.configuration.configuration;
  const record=await journal.command({kind:"record",activityId:scope.activityId,ref:evidence.evidence}) as ProtocolJournalRecord|null;
  if(!record||record.kind!=="owner_checkpoint"||record.activityId!==scope.activityId||record.content.activityId!==scope.activityId||
    evidence.activityId!==scope.activityId||evidence.evidence.owner!==activity.composition.composition.adapter.implementation.id||
    state.contextInput?.id!==evidence.inputId||state.contextInput.digest!==evidence.exactInputDigest)
    throw new TypeError("protocol_input_rejection_original_missing");
  const proof=JSON.parse((await readProtocolContent(journal,record.content,scope.activityId,PROTOCOL_INPUT_REJECTION_MAXIMUM_BYTES)).toString()) as ProtocolInputRejection;
  if(proof.kind!=="protocol_input_rejection"||proof.revision!=="1"||proof.reason!=="input_capacity_exceeded"||
    proof.scope.id!==evidence.scopeId||proof.scope.runId!==scope.runId||proof.scope.recipient!==scope.recipientId||proof.scope.purpose!==scope.purpose.id||
    proof.scope.target!==`${configuration.id}:${configuration.revision}`||evidence.targetRevision!==proof.scope.target||
    proof.boundary!==evidence.boundary||proof.inputId!==evidence.inputId||proof.exactInputDigest!==evidence.exactInputDigest||
    proof.bodyDigest!==evidence.bodyDigest||modelInputValueDigest(proof.originalInput)!==modelInputValueDigest(state.input)||
    !record.dependencies.some(ref=>ref.id===proof.observation.id&&ref.revision===proof.observation.revision))
    throw new TypeError("protocol_input_rejection_original_changed");
  const observation=await journal.command({kind:"record",activityId:scope.activityId,ref:proof.observation}) as ProtocolJournalRecord|null;
  if(!observation||observation.kind!=="observation"||!observation.source||observation.activityId!==scope.activityId||
    observation.operationId!==record.operationId||modelInputValueDigest(observation.source.scope)!==modelInputValueDigest(scope))
    throw new TypeError("protocol_input_rejection_observation_changed");
  return {proof,observation};
}

/** The caller supplies a native-classified refusal. This handoff never classifies transport errors. */
export async function retainProtocolInputRejection(input:{
  readonly state:ProtocolExecutionState;
  readonly proof:ProtocolInputRejection;
  readonly observation:ProtocolJournalRecord;
  readonly journal:ProtocolExecutionJournal;
  readonly acceptance:SharedAcceptancePort;
}):Promise<ProtocolInputRejectionEvidence>{
  const {state,proof,observation,journal,acceptance}=input,scope=state.activity.scope,configuration=state.activity.composition.composition.configuration;
  if(proof.kind!=="protocol_input_rejection"||proof.revision!=="1"||proof.reason!=="input_capacity_exceeded"||!proof.boundary||!proof.bodyDigest||
    state.contextInput?.id!==proof.inputId||state.contextInput.digest!==proof.exactInputDigest||proof.scope.runId!==scope.runId||
    proof.scope.recipient!==scope.recipientId||proof.scope.purpose!==scope.purpose.id||proof.scope.target!==`${configuration.configuration.id}:${configuration.configuration.revision}`||
    modelInputValueDigest(proof.originalInput)!==modelInputValueDigest(state.input)||observation.kind!=="observation"||!observation.source||
    observation.activityId!==scope.activityId||modelInputValueDigest(observation.ref)!==modelInputValueDigest(proof.observation))
    throw new TypeError("protocol_input_rejection_binding_invalid");
  const bytes=Buffer.from(JSON.stringify(proof));
  if(bytes.length>PROTOCOL_INPUT_REJECTION_MAXIMUM_BYTES)throw new TypeError("protocol_input_rejection_bound");
  const ref={id:`${observation.ref.id}:input-rejection`,revision:observation.ref.revision};
  const content=await retainProtocolContent(journal,`${ref.id}:${ref.revision}:body`,scope.activityId,bytes);
  const record:ProtocolJournalRecord={ref,activityId:scope.activityId,operationId:observation.operationId,
    kind:"owner_checkpoint",content,source:null,dependencies:[observation.ref]};
  const actor=state.activity.composition.composition.adapter.implementation.id;
  const evidence:ProtocolInputRejectionEvidence={kind:"recipient",activityId:scope.activityId,scopeId:proof.scope.id,boundary:proof.boundary,inputId:proof.inputId,
    exactInputDigest:proof.exactInputDigest,targetRevision:proof.scope.target,bodyDigest:proof.bodyDigest,evidence:{...ref,owner:actor,kind:"fact"}};
  const original=await journal.command({kind:"record",activityId:scope.activityId,ref:observation.ref});
  if(modelInputValueDigest(original)!==modelInputValueDigest(observation))throw new TypeError("protocol_input_rejection_observation_changed");
  const saved=await journal.command({kind:"record",activityId:scope.activityId,ref});
  if(saved){
    if(modelInputValueDigest(saved)!==modelInputValueDigest(record))throw new TypeError("protocol_input_rejection_conflict");
  }
  if(!state.inputRefusal){
    const receipt=await acceptance.accept({id:`${ref.id}:${ref.revision}:retain`,scope:scope.runId,actor,
      parts:[{owner:"protocol_execution",kind:"record",proposal:{record,fence:state.fence}},
        {owner:"protocol_execution",kind:"input_refusal",proposal:{fence:state.fence,proof,evidence}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`protocol_input_rejection_not_retained:${receipt.rejection?.code}`);
  }else if(modelInputValueDigest(state.inputRefusal)!==modelInputValueDigest(evidence))throw new TypeError("protocol_input_refusal_changed");
  return evidence;
}
