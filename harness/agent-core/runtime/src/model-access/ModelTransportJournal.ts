import type {ProviderRequest,ProviderCallResult} from "@agent-anything/model-interaction";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry} from "../activity/ActivityPurpose.js";
import {ActivityCheckpointError} from "../activity/ActivityCheckpoint.js";
import type {ActivityDispatchReceipt,ActivityStageState,ActivityPathState} from "../activity/ActivityHandoff.js";
import type {ModelActivityBinding} from "./ModelActivityBinding.js";
import {ModelActivityJournal,type ModelActivityJournalSupport} from "./ModelActivityJournal.js";

const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"model_transport",revision:"1"},inputOwner:"model_access",executionOwner:"model_access",interpretationOwner:"model_access",acceptanceOwner:"model_access",recoveryOwner:"model_access",stageKinds:["model_request"],capabilities:["model_request"],continuationKinds:[]},null);

/** Physical transport occupancy ends when its outcome is retained, not after retry backoff. */
export class ModelTransportJournal {
  private readonly dispatching:ModelActivityJournal;
  constructor(private readonly support:ModelActivityJournalSupport,private readonly now:()=>string){this.dispatching=new ModelActivityJournal(support,now);}
  async execute(request:ProviderRequest,activity:ModelActivityBinding,attemptId:string,deadlineAt:string,signal:AbortSignal,send:()=>Promise<ProviderCallResult>):Promise<ProviderCallResult> {
    if(!this.support.scheduling)return send();
    const pool=this.support.scheduling.pool,port=this.support.port;
    const workId=activity.owner.kind==="task_decision"?`task-work:${activity.runId}`:`auxiliary-work:${activity.runId}:${activity.activityId}`;
    const workOwner=["context_generation","context_assessment"].includes(activity.owner.kind)?"context-representation":activity.contract.contract.acceptanceOwner;
    await port.command({kind:"bind_resource_pool",pool});
    await port.command({kind:"schedule_work",intent:{id:`${workId}:schedule:1`,workId,runId:activity.runId,scopeId:activity.runId,
      owner:workOwner,delegatedPathOwners:["model_access"],decisionId:workId,policyRevision:"fair-work-rounds.v1",
      reason:activity.owner.kind==="task_decision"?"task":"necessary",delayImpact:"accepted caller is awaiting this model transport",timing:{kind:"unknown"},
      resources:[{poolId:pool.id,capability:"model_request",units:1}]},expectedRevision:0});
    const id=this.identity(request,activity,attemptId);
    await port.command({kind:"open_path",intent:{id,runId:activity.runId,owner:"model_access",purpose,permissionBasis:`model-target:${modelInputValueDigest({provider:request.composition.providerId,model:request.composition.model})}`,
      resourceScope:id,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt,scheduledWorkId:workId}});
    await port.command({kind:"submit",request:{id:`${id}:request`,pathId:id,stageKind:"model_request",input:request,capabilities:["model_request"],dependencies:[]}});
    const stage=await port.command({kind:"admit",requestId:`${id}:request`,expectedControlRevision:0}) as ActivityStageState;
    if(stage.result){this.assertReturned(stage);await this.accept(stage);return stage.result.value as ProviderCallResult;}
    let dispatched:ActivityDispatchReceipt;
    try {dispatched=await this.dispatching.dispatch(stage,signal,deadlineAt);}
    catch(error) {
      if(signal.aborted||error instanceof ActivityCheckpointError&&error.key==="activity_dispatch_deadline") {
        const current=await port.command({kind:"read_stage",requestId:stage.request.id}) as ActivityStageState;
        if(!current.attempt) {
          const path=await port.command({kind:"read_path",pathId:stage.request.pathId}) as ActivityPathState;
          await port.command({kind:"cancel",pathId:path.intent.id,expectedControlRevision:path.controlRevision});
        }
      }
      throw error;
    }
    if(!dispatched.granted) {
      const retained=await this.restore(request,activity,attemptId);
      if(retained)return retained;
      throw new ActivityCheckpointError("model_transport_original_result_unknown");
    }
    if(signal.aborted) {
      const notStarted:ProviderCallResult={kind:"failed",failure:{category:"cancellation",code:"model_transport_not_started",message:"The accepted transport was cancelled before sending.",metadata:{sent:false}}};
      await this.save(dispatched,notStarted);return notStarted;
    }
    let result:ProviderCallResult;
    try {result=await send();}
    catch(cause){
      await port.command({kind:"save_raw",result:{id:`${dispatched.stage.attempt!.id}:unknown`,attemptId:dispatched.stage.attempt!.id,completeness:"partial",outcome:"unknown",
        value:{name:cause instanceof Error?cause.name:"UnknownError",message:cause instanceof Error?cause.message:String(cause)},usage:null,recordedAt:this.now()}});
      throw new ActivityCheckpointError("model_transport_outcome_unconfirmed",{cause});
    }
    await this.save(dispatched,result);
    return result;
  }
  async restore(request:ProviderRequest,activity:ModelActivityBinding,attemptId:string):Promise<ProviderCallResult|null> {
    if(!this.support.scheduling)return null;
    const stage=await this.support.port.command({kind:"read_stage",requestId:`${this.identity(request,activity,attemptId)}:request`}) as ActivityStageState|null;
    if(stage?.attempt&&!stage.result)throw new ActivityCheckpointError("model_transport_original_result_unknown");
    if(!stage?.result)return null;
    this.assertReturned(stage);
    await this.accept(stage);return stage.result.value as ProviderCallResult;
  }
  private async save(dispatched:ActivityDispatchReceipt,result:ProviderCallResult):Promise<void> {
    const attempt=dispatched.stage.attempt!;
    const stage=await this.support.port.command({kind:"save_raw",result:{id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:result.kind==="cancellation_unconfirmed"?"unknown":"returned",value:result,usage:null,recordedAt:this.now()}}) as ActivityStageState;
    if(result.kind==="cancellation_unconfirmed")return;
    await this.accept(stage);
  }
  private assertReturned(stage:ActivityStageState):void {
    if(stage.result?.completeness!=="complete"||stage.result.outcome==="unknown")throw new ActivityCheckpointError("model_transport_original_result_unknown");
  }
  private async accept(stage:ActivityStageState):Promise<void> {
    if(stage.receipt)return;
    const path=await this.support.port.command({kind:"read_path",pathId:stage.request.pathId}) as ActivityPathState;
    const claimId=`${stage.request.id}:processing:${modelInputValueDigest(this.support.executor)}`;
    if(stage.processing?.id!==claimId)await this.support.port.command({kind:"claim_processing",claim:{id:claimId,requestId:stage.request.id,previousClaimId:stage.processing?.id??null,executor:this.support.executor},expectedControlRevision:path.controlRevision});
    await this.support.port.command({kind:"accept",receipt:{id:`${stage.request.id}:accepted`,requestId:stage.request.id,resultId:stage.result!.id,
      owner:"model_access",expectedProgressRevision:path.progressRevision,progress:{kind:"transport_result_retained"},next:[]},executor:this.support.executor,expectedControlRevision:path.controlRevision});
  }
  private identity(request:ProviderRequest,activity:ModelActivityBinding,attemptId:string):string{return `model-transport:${modelInputValueDigest({requestId:request.requestId,activity:activity.id,attemptId})}`;}
}
