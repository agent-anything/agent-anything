import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ProtocolObservationUnavailable,ProtocolObservationWork,readProtocolContent,type ProtocolExecutionState,type ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import {ActivityChangeWait,ActivityObservationCursor,ActivityCheckpointError,type ActivityPurposeRegistry,type ActivityPurposeHandler,
  type ActivityPathIntent,type ActivitySchedulingIntent,type ActivityStateObservation,type ActivityChangeInterest} from "@agent-anything/agent-runtime/activity";
import type {AgentActivityExecutionContext} from "@agent-anything/agent-runtime/decision";
import type {HelarcNativeRunTask,HelarcNativeStructuredRequest} from "@agent-anything/helarc/controller";
import type {HelarcNativePreviewObserver} from "@agent-anything/helarc/run";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {measureIdentifiedWork,protocolWork} from "../diagnostics/IdentifiedWorkTiming.js";

type Request=HelarcNativeRunTask|HelarcNativeStructuredRequest;
interface WaitContext {readonly signal:AbortSignal;readonly deadlineAt:string}
interface Ports {
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly host:{assertAvailable():void;wake():void;subscribe(listener:()=>void,interest?:ActivityChangeInterest):()=>void};
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly arrange:(state:ProtocolExecutionState)=>Promise<{
    identity:Omit<ActivityPathIntent,"owner"|"purpose">;schedule:ActivitySchedulingIntent;
  }>;
  readonly observe:(state:ProtocolExecutionState,request:Request,mode:"execute"|"recover",signal:AbortSignal,preview?:HelarcNativePreviewObserver)=>Promise<ProtocolJournalRecord|null>;
  readonly interrupt:(state:ProtocolExecutionState,request:Request)=>Promise<void>;
  readonly now:()=>string;
  readonly rediscoveryMs:number;
  readonly settlementWaitMs:number;
}

/** Task waiting delegates occupancy to the shared Host; auxiliary callers already hold their own admission. */
export class HelarcNativeObservation {
  readonly work:ProtocolObservationWork;
  private readonly previews=new Map<string,HelarcNativePreviewObserver>();
  constructor(private readonly ports:Ports){
    for(const bound of [ports.rediscoveryMs,ports.settlementWaitMs])if(!Number.isSafeInteger(bound)||bound<1)throw new TypeError("native_observation_wait_bound_invalid");
    this.work=new ProtocolObservationWork({journal:ports.store.protocolJournal,activities:ports.store.activityHandoffs,acceptance:ports.store.sharedAcceptance,
      generation:ports.store.generation,authorize:ports.authorize,now:ports.now,observe:async(state,mode,signal)=>{
        const id=state.activity.scope.activityId;
        const request=JSON.parse((await readProtocolContent(ports.store.protocolJournal,state.input,id,32*1024*1024)).toString()) as Request;
        const scope=request?.format==="helarc.native-prepared-task.v1"?request.binding.scope:
          request?.format==="helarc.native-structured-request.v1"?request.activity.scope:null;
        if(!scope||digest(scope)!==digest(state.activity.scope))
          throw new TypeError("native_observation_original_task_changed");
        // Cancellation reconciliation may retain evidence but cannot start a new generation.
        if(state.cancelled)return await ports.store.protocolJournal.command({kind:"record",activityId:id,ref:observationRef(request)}) as ProtocolJournalRecord|null;
        return ports.observe(state,request,mode,signal,this.previews.get(id));
      }},ports.registry);
  }
  async observe(state:ProtocolExecutionState,request:HelarcNativeRunTask,mode:"execute"|"recover"|"interrupt",
    context:AgentActivityExecutionContext,preview?:HelarcNativePreviewObserver):Promise<ProtocolJournalRecord|null>{
    return this.observeRequest(state,request,mode,{signal:context.cancellation.signal,deadlineAt:context.retry.deadlineAt},preview);
  }
  async observeStructured(state:ProtocolExecutionState,request:HelarcNativeStructuredRequest,mode:"execute"|"recover"|"interrupt",
    context:WaitContext):Promise<ProtocolJournalRecord|null>{
    return this.observeRequest(state,request,mode,context);
  }
  private async observeRequest(state:ProtocolExecutionState,request:Request,mode:"execute"|"recover"|"interrupt",
    context:WaitContext,preview?:HelarcNativePreviewObserver):Promise<ProtocolJournalRecord|null>{
    const p=this.ports,id=state.activity.scope.activityId,arrangement=await p.arrange(state),pathId=arrangement.identity.id;
    if(preview)this.previews.set(id,preview);
    try{
      if(mode==="interrupt"){
        const observed=await p.store.activityHandoffs.command({kind:"observe_state",pathId,requestIds:[`${pathId}:observe`],inputNeedIds:[]}) as ActivityStateObservation;
        if(observed.path){
          if(observed.path.intent.runId!==state.activity.scope.runId||observed.path.intent.purpose.digest!==this.work.purpose.digest)
            throw new TypeError("native_observation_cancel_scope_changed");
          if(!observed.path.cancelled)await p.store.activityHandoffs.command({kind:"cancel",pathId,expectedControlRevision:observed.path.controlRevision});
          p.host.wake();
        }
        await p.interrupt(state,request);
        if(observed.path)await this.wait(pathId,context,true);
        return await p.store.protocolJournal.command({kind:"record",activityId:id,ref:observationRef(request)}) as ProtocolJournalRecord|null;
      }
      p.host.assertAvailable();context.signal.throwIfAborted();
      const proposal={id:`${pathId}:submission`,scope:state.activity.scope.runId,actor:this.work.purpose.contract.acceptanceOwner,
        parts:this.work.prepareSubmission(arrangement.identity,state,arrangement.schedule)};
      const accepted=await p.store.sharedAcceptance.accept(proposal);
      if(accepted.outcome!=="accepted")throw new TypeError(`native_observation_submission_rejected:${accepted.rejection?.code}`);
      p.host.wake();
      const work=protocolWork(state.activity.scope.runId,id);
      return await measureIdentifiedWork(p.store,{work,phase:"observation_receipt",
        awaited:{owner:"activity",kind:"contribution",id:pathId+":observe",runId:work.runId}},()=>this.wait(pathId,context,false));
    }finally{this.previews.delete(id);}
  }
  private async wait(pathId:string,context:WaitContext,settling:boolean):Promise<ProtocolJournalRecord|null>{
    const p=this.ports,deadline=settling?Date.now()+p.settlementWaitMs:Date.parse(context.deadlineAt);
    if(!Number.isFinite(deadline))throw new TypeError("native_observation_deadline_invalid");
    const wake=new ActivityChangeWait(p.host,settling?null:context.signal,{pathIds:[pathId]}),cursor=new ActivityObservationCursor(p.store.activityHandoffs,[pathId]);
    try{for(;;){
      const version=wake.version;
      if(await cursor.changed()){
        const state=await p.store.activityHandoffs.command({kind:"observe_state",pathId,requestIds:[`${pathId}:observe`],inputNeedIds:[]}) as ActivityStateObservation;
        if(!state.path||state.path.intent.purpose.digest!==this.work.purpose.digest)throw new TypeError("native_observation_original_path_missing");
        const stage=state.stages[0];
        if(settling){
          if(!stage||["submitted","admitted","accepted","settled","stopped"].includes(stage.status))return null;
        }else if(stage&&["accepted","settled","stopped"].includes(stage.status)){
          const result=await this.work.result(pathId);
          if(result.kind==="protocol_observation_unavailable")throw new ProtocolObservationUnavailable(result);
          if(result.kind==="observed")return result.record;
          if(result.kind==="cancelled")return null;
          if(result.kind==="limited")throw new TypeError(`native_observation_limited:${result.reason}`);
        }
      }
      p.host.assertAvailable();if(!settling)context.signal.throwIfAborted();
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new ActivityCheckpointError(`${pathId}:observation-wait`,{cause:new Error("Original observation remains unsettled; no repeated dispatch")});
      await wake.wait(version,Math.min(remaining,p.rediscoveryMs));
    }}finally{wake.close();}
  }
}
function observationRef(request:Request){return request.format==="helarc.native-prepared-task.v1"?request.binding.record:request.observation;}
