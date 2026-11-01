import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityHandoffPort,ActivityPathState,ActivityStageState} from "../activity/index.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE,validatePreparedContextInput,type ContextInputPreparationRequest,
  type PreparedContextInput,type ContextInputPreparationGap} from "./ContextInputPreparation.js";
import type {ContextCurrentInput} from "./ContextPreparationPolicy.js";

export interface ContextInputEvidenceOrigin {
  readonly pathId:string;
  readonly progressRevision:number;
  readonly stageId:string;
  readonly rawResultId:string;
  readonly receiptId:string;
}
export type ContextInputAssessment =
  | {readonly kind:"available";readonly current:ContextCurrentInput;readonly origin:ContextInputEvidenceOrigin}
  | {readonly kind:"unassessed";readonly reason:string;readonly origin:ContextInputEvidenceOrigin};
export type ContextInputEvidence = ContextInputAssessment
  | {readonly kind:"pending"|"changed"}
  | {readonly kind:"cancelled";readonly acceptedOutcome?:ContextInputAssessment};

/** Reads accepted preparation evidence. It neither predicts pressure nor authorizes adoption. */
export async function readContextInputEvidence(input:{
  readonly activities:ActivityHandoffPort;
  readonly pathId:string;
  readonly scope:Pick<ContextUseScope,"runId"|"recipient"|"purpose"|"target"|"owner">;
  readonly demandId:string;
  readonly boundary:string;
  /** Historical evidence only; cancellation still prevents treating this as a usable current input. */
  readonly includeCancelledOutcome?:boolean;
},signal:AbortSignal):Promise<ContextInputEvidence> {
  signal.throwIfAborted();
  const read=()=>input.activities.command({kind:"read_path",pathId:input.pathId}) as Promise<ActivityPathState|null>;
  const path=await read();
  if(!path||path.intent.id!==input.pathId||path.intent.runId!==input.scope.runId||path.intent.owner!==input.scope.owner||
    path.intent.purpose.digest!==modelInputValueDigest(CONTEXT_INPUT_PREPARATION_PURPOSE))throw new TypeError("context_input_evidence_path_mismatch");
  const first=await input.activities.command({kind:"read_stage",requestId:`${input.pathId}:stage:1`}) as ActivityStageState|null;
  const original=(first?.request.input as {request?:ContextInputPreparationRequest}|undefined)?.request;
  const demand=original?.demand;
  if(!first||first.request.pathId!==input.pathId||original?.kind!=="context_input_preparation"||!demand||
    demand.id!==input.demandId||demand.runId!==input.scope.runId||demand.recipient!==input.scope.recipient||
    demand.purpose!==input.scope.purpose||demand.targetRevision!==input.scope.target||demand.historyBoundary!==input.boundary)
    throw new TypeError("context_input_evidence_scope_mismatch");
  const unchanged=async()=>{
    signal.throwIfAborted();const latest=await read();signal.throwIfAborted();
    if(!latest)throw new TypeError("context_input_evidence_path_missing");
    return latest.controlRevision===path.controlRevision&&latest.progressRevision===path.progressRevision;
  };
  if(path.cancelled&&!input.includeCancelledOutcome)return await unchanged()?{kind:"cancelled"}:{kind:"changed"};
  const progress=path.progress as {state?:string;stageRequestId?:string;rawResultId?:string;prepared?:PreparedContextInput;gap?:ContextInputPreparationGap;reason?:string}|null;
  if(!progress)return await unchanged()?{kind:path.cancelled?"cancelled":"pending"}:{kind:"changed"};
  if(!progress.stageRequestId||!progress.rawResultId)throw new TypeError("context_input_evidence_origin_missing");
  const stage=await input.activities.command({kind:"read_stage",requestId:progress.stageRequestId}) as ActivityStageState|null;
  if(!stage||stage.request.pathId!==input.pathId||stage.status!=="accepted"||!stage.receipt||!stage.result||
    stage.result.completeness!=="complete"||stage.result.outcome!=="returned"||stage.result.id!==progress.rawResultId||
    stage.receipt.resultId!==stage.result.id||stage.receipt.requestId!==stage.request.id||stage.receipt.owner!==input.scope.owner||
    stage.receipt.expectedProgressRevision+1!==path.progressRevision||modelInputValueDigest(stage.receipt.progress)!==modelInputValueDigest(path.progress))
    throw new TypeError("context_input_evidence_acceptance_mismatch");
  const origin={pathId:input.pathId,progressRevision:path.progressRevision,stageId:stage.request.id,rawResultId:stage.result.id,receiptId:stage.receipt.id};
  const evidence={owner:"activity",kind:"fact" as const,id:stage.request.id,revision:String(path.progressRevision)};
  let result:ContextInputEvidence;
  if(progress.state==="prepared"&&progress.prepared){
    validatePreparedContextInput(progress.prepared);
    if(progress.prepared.preparationStageId!==stage.request.id||modelInputValueDigest(progress.prepared.demand)!==modelInputValueDigest(demand))
      throw new TypeError("context_input_evidence_prepared_mismatch");
    result={kind:"available",current:{kind:"prepared",prepared:progress.prepared,evidence},origin};
  }else if(progress.state==="gap"){
    if(!progress.reason)throw new TypeError("context_input_evidence_gap_invalid");
    if(progress.gap){
      if(progress.gap.demandId!==demand.id||progress.gap.targetRevision!==demand.targetRevision||progress.gap.reason!==progress.reason||
        progress.gap.responsibility!=="request_owner")throw new TypeError("context_input_evidence_gap_mismatch");
      result={kind:"available",current:{kind:"gap",gap:progress.gap,evidence},origin};
    }else result={kind:"unassessed",reason:progress.reason,origin};
  }else if(progress.state==="progressing")result={kind:"pending"};
  else throw new TypeError("context_input_evidence_progress_invalid");
  if(!await unchanged())return {kind:"changed"};
  return path.cancelled?{kind:"cancelled",...(result.kind==="available"||result.kind==="unassessed"?{acceptedOutcome:result}:{})}:result;
}
