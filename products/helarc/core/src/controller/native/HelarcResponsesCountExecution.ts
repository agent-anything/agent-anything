import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {requireModelPurpose,snapshotModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import {assertProtocolModelActivityOriginal,readProtocolContent,retainProtocolContent,type ProtocolModelActivity,
  type ProtocolExecutionState,type ProtocolExecutionJournal,type ProtocolJournalRecord,type ProtocolPurposeAcceptance,type ProtocolEvidenceRevision} from "@agent-anything/agent-runtime/model-access";
import {ActivityCheckpointError,type SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import {retainHelarcNativeDispatchUsage,retainHelarcNativeUsageObservation} from "./HelarcNativeUsageObservation.js";
import {restoreResponsesInputTokenCount,restoreResponsesCountEvidence,interpretResponsesInputTokenCount,unknownResponsesInputTokenCount,
  type ResponsesInputTokenCountRequest,type ResponsesCountEvidence,type NativeHttpObservation} from "@agent-anything/provider-integrations/native";

export const HELARC_RESPONSES_COUNT_INTERPRETER={id:"helarc.responses-input-count",revision:"1"} as const;
export interface HelarcResponsesCountRequest {
  readonly format:"helarc.responses-count-request.v1";
  readonly activity:ProtocolModelActivity;
  readonly count:ResponsesInputTokenCountRequest;
  readonly allowance?:{readonly pathId:string;readonly stageId:string;readonly sourcePathId:string;readonly maximumCalls:number;
    readonly kind?:"method_input"|"auxiliary_input"|"compact_assessment_input"};
}
export interface HelarcResponsesCountExecutionPorts {
  readonly journal:ProtocolExecutionJournal;
  readonly acceptance:SharedAcceptancePort;
  readonly generation:number;
  readonly now:()=>string;
  readonly authorize:(request:HelarcResponsesCountRequest,action:"local"|"dispatch",signal:AbortSignal)=>Promise<void>;
  readonly reserve?:(request:HelarcResponsesCountRequest,signal:AbortSignal)=>Promise<boolean>;
  readonly dispatch:(request:HelarcResponsesCountRequest,signal:AbortSignal,authorize:()=>Promise<void>,
    retainChunk:(bytes:Uint8Array,offset:number)=>Promise<void>)=>Promise<NativeHttpObservation>;
}

/** A count is a separately accepted native operation, not a model Turn or task decision. */
export class HelarcResponsesCountExecution {
  constructor(private readonly ports:HelarcResponsesCountExecutionPorts){}
  async interrupt(activityId:string,signal:AbortSignal):Promise<void>{
    const state=await this.state(activityId);
    if(!state||state.accepted||state.cancelled)return;
    const request=JSON.parse((await readProtocolContent(this.ports.journal,state.input,activityId,32*1024*1024)).toString()) as HelarcResponsesCountRequest;
    assertProtocolModelActivityOriginal(state.activity,request.activity);
    await this.ports.authorize(request,"local",signal);signal.throwIfAborted();
    await this.accept(`${activityId}:cancel:${state.fence.controlRevision}`,state.activity.scope.runId,"execution-coordinator",
      [{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]);
  }
  async execute(request:HelarcResponsesCountRequest,signal:AbortSignal):Promise<ResponsesCountEvidence>{
    const p=this.ports,id=request.activity.scope.activityId,operationId=`${id}:count`,scope=request.activity.scope;
    const evidenceScope={id:`${id}:measurement`,runId:scope.runId,recipientId:scope.recipientId,purpose:scope.purpose,
      compositionDigest:scope.compositionDigest,owner:HELARC_RESPONSES_COUNT_INTERPRETER.id};
    const count=restoreResponsesInputTokenCount(request.count),participant=requireModelPurpose(request.activity.composition,scope.purpose);
    if(request.format!=="helarc.responses-count-request.v1"||request.activity.composition.composition.protocol.id!=="openai.responses"||
      digest(participant.interpreter.implementation)!==digest(HELARC_RESPONSES_COUNT_INTERPRETER)||
      count.binding.scope.runId!==scope.runId||count.binding.scope.recipient!==scope.recipientId||
      count.binding.targetRevision!==`${request.activity.composition.composition.configuration.configuration.id}:${request.activity.composition.composition.configuration.configuration.revision}`)
      throw new TypeError("responses_count_original_request_invalid");
    await p.authorize(request,"local",signal);
    let state=await this.state(id);
    if(!state){
      signal.throwIfAborted();
      const content=await retainProtocolContent(p.journal,`${id}:request:${digest(request)}`,id,Buffer.from(JSON.stringify(request)));
      await this.accept(`${id}:prepare`,scope.runId,"execution-coordinator",[
        {owner:"protocol_execution",kind:"prepare",proposal:{activity:request.activity,input:content}},
        {owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId:id,scope:evidenceScope}}]);
      state=(await this.state(id))!;
    }
    assertProtocolModelActivityOriginal(state.activity,request.activity);
    const original=JSON.parse((await readProtocolContent(p.journal,state.input,id,32*1024*1024)).toString());
    if(digest(original)!==digest(request))throw new TypeError("responses_count_original_request_changed");
    const accepted=await p.journal.command({kind:"acceptance",activityId:id}) as ProtocolPurposeAcceptance|null;
    if(accepted){
      const value=JSON.parse((await readProtocolContent(p.journal,accepted.result,id,2*1024*1024)).toString()) as ResponsesCountEvidence;
      if(digest(accepted.evidence.scope)!==digest(scope)||digest(accepted.evidence.interpreter)!==digest(HELARC_RESPONSES_COUNT_INTERPRETER)||
        accepted.effects.length||accepted.deliveries.length||value.operationId!==operationId)
        throw new TypeError("responses_count_accepted_result_changed");
      return restoreResponsesCountEvidence(count,value);
    }
    if(state.fence.generation!==p.generation||state.fence.epoch===0){
      await this.accept(`${id}:claim:${p.generation}:${state.fence.epoch}`,scope.runId,state.activity.composition.composition.adapter.implementation.id,
        [{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]);
      state=(await this.state(id))!;
    }
    const dispatchRef={id:`${operationId}:dispatch`,revision:"1"},outcomeRef={id:`${operationId}:outcome`,revision:"1"};
    let outcome=await p.journal.command({kind:"record",activityId:id,ref:outcomeRef}) as ProtocolJournalRecord|null;
    let result:ResponsesCountEvidence;
    if(outcome){
      result=restoreResponsesCountEvidence(count,JSON.parse((await readProtocolContent(p.journal,outcome.content,id,2*1024*1024)).toString()));
    }else{
      const dispatch=await p.journal.command({kind:"record",activityId:id,ref:dispatchRef}) as ProtocolJournalRecord|null;
      if(dispatch)await retainHelarcNativeDispatchUsage({...p,state,record:dispatch,operation:"count",endpoint:null,submittedAt:null});
      const unknown=(reason:Parameters<typeof unknownResponsesInputTokenCount>[1]["reason"],basis:string)=>
        unknownResponsesInputTokenCount(count,{operationId,measuredAt:p.now(),reason,basis});
      if(state.cancelled)result=unknown("cancelled","Original measurement activity was cancelled");
      else if(dispatch)result=unknown("outcome_unknown","Original dispatch was retained without a complete response; no new count was issued");
      else if(count.dispatchBlock)result=unknown(count.dispatchBlock,count.dispatchBlock);
      else{
        await p.authorize(request,"dispatch",signal);signal.throwIfAborted();
        if(request.allowance&&!p.reserve)throw new TypeError("responses_count_resource_owner_unavailable");
        if(p.reserve&&!await p.reserve(request,signal))result=unknown("resource_unavailable","Original shared measurement allowance is exhausted; no count was dispatched");
        else{
        let sent=false;
        try{
          const observation=await p.dispatch(request,signal,async()=>{
            await p.authorize(request,"dispatch",signal);signal.throwIfAborted();
            const current=await this.state(id);
            if(!current||current.cancelled||digest(current.fence)!==digest(state!.fence))throw new TypeError("responses_count_current_control_changed");
            const record:ProtocolJournalRecord={ref:dispatchRef,activityId:id,operationId,kind:"dispatch_intent",content:state!.input,source:null,dependencies:[]};
            await this.record(state!,record,true);
            await retainHelarcNativeDispatchUsage({...p,state:state!,record,operation:"count",endpoint:null,submittedAt:null});sent=true;
          },async(bytes,offset)=>{
            try{
              const content=await retainProtocolContent(p.journal,`${operationId}:chunk:${offset}`,id,Buffer.from(bytes));
              await this.record(state!,{ref:{id:`${operationId}:chunk:${offset}`,revision:"1"},activityId:id,operationId,kind:"observation",
                content,source:null,dependencies:[dispatchRef]},false);
            }catch(cause){throw new ActivityCheckpointError(`${operationId}:chunk:${offset}`,{cause});}
          });
          result=interpretResponsesInputTokenCount(count,observation,{operationId,measuredAt:p.now()});
        }catch(error){
          // Authority/configuration failures before dispatch remain blocked, not capacity evidence.
          if(!sent||error instanceof ActivityCheckpointError)throw error;
          result=unknown(signal.aborted?"cancelled":"transport_failure",signal.aborted?"Local observation interrupted after dispatch":"Original count did not yield a complete HTTP observation");
        }
        }
      }
      const content=await retainProtocolContent(p.journal,`${operationId}:result:${result.id}`,id,Buffer.from(JSON.stringify(result)));
      const didDispatch=Boolean(await p.journal.command({kind:"record",activityId:id,ref:dispatchRef}));
      outcome={ref:outcomeRef,activityId:id,operationId,kind:didDispatch?"observation":"owner_checkpoint",content,
        source:{scope,protocol:state.activity.composition.composition.protocol,interpretation:state.activity.composition.composition.adapter.implementation,
          operationId,record:outcomeRef,position:{format:"json-pointer",value:""},nativeIdentity:null},dependencies:didDispatch?[dispatchRef]:[]};
      await this.record(state,outcome,!didDispatch);
    }
    if(outcome.kind==="observation"){
      const c=state.activity.composition.composition;
      await retainHelarcNativeUsageObservation({...p,state,record:outcome,
        submission:{id:operationId,scope,protocol:c.protocol,operation:"count",endpoint:null,account:c.configuration.connectionBinding.id,
          submittedAt:null,model:c.configuration.model,requestedTier:null,reportedTier:null,region:null,modality:null,
          reconciliationOwner:c.adapter.implementation.id,beneficiaries:[...new Set([scope.runId,scope.recipientId,scope.purpose.id])],stage:scope.purpose.id},
        response:{},receivedAt:result.measuredAt,channel:"create",finality:"terminal"});
    }
    signal.throwIfAborted();
    const current=await this.state(id);
    if(!current||digest(current.fence)!==digest(state.fence))throw new TypeError("responses_count_current_control_changed");
    if(current.cancelled)return result;
    const evidence=snapshotModelPurposeEvidence({scope,interpreter:HELARC_RESPONSES_COUNT_INTERPRETER,
      acceptance:{id:`${id}:accepted`,revision:"1"},sources:[outcome.source!]});
    const measurement:ProtocolEvidenceRevision={scopeId:evidenceScope.id,kind:"measurement",key:count.id,owner:evidenceScope.owner,activityId:id,
      revision:0,content:outcome.content,references:[state.input,outcome.content],dependencies:[{activityId:id,ref:outcome.ref}],memberships:[],
      metadata:{stage:"native_input_count",operationId,inputId:count.binding.encodedInputId,requestId:count.id,
        generationDigest:count.generation.digest,bindingDigest:count.bindingDigest,status:result.status,
        inputTokens:result.status==="measured"?result.inputTokens:null,coverage:count.coverage,uncoveredCount:count.uncovered.length,
        targetValidityBasis:count.binding.targetValidity?.basis??null,targetValidUntil:count.binding.targetValidity?.validUntil??null,
        prefix:count.binding.prefix.kind,measuredAt:result.measuredAt,
        reason:result.status==="unknown"?result.reason:result.status==="refused"?result.category:null}};
    await this.accept(`${id}:purpose:${state.fence.generation}:${state.fence.epoch}`,scope.runId,HELARC_RESPONSES_COUNT_INTERPRETER.id,
      [{owner:"protocol_execution",kind:"evidence",proposal:{fence:state.fence,expectedRevision:null,evidence:measurement}},
        {owner:"protocol_execution",kind:"purpose",proposal:{fence:state.fence,acceptance:{evidence,result:outcome.content,effects:[],deliveries:[]}}}]);
    return result;
  }
  private state(activityId:string){return this.ports.journal.command({kind:"state",activityId}) as Promise<ProtocolExecutionState|null>;}
  private record(state:ProtocolExecutionState,record:ProtocolJournalRecord,fenced:boolean){
    return this.accept(`${record.ref.id}:retain`,state.activity.scope.runId,state.activity.composition.composition.adapter.implementation.id,
      [{owner:"protocol_execution",kind:"record",proposal:{fence:fenced?state.fence:null,record}}]);
  }
  private async accept(id:string,scope:string,actor:string,parts:Parameters<SharedAcceptancePort["accept"]>[0]["parts"]){
    const receipt=await this.ports.acceptance.accept({id,scope,actor,parts});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_count_acceptance_rejected:${receipt.rejection?.code}`);
  }
}
