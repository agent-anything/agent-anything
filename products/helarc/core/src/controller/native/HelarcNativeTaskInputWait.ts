import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityChangeWait,ActivityObservationCursor,ActivityCheckpointError,type ActivityHandoffPort,type ActivityPathIntent,
  type ActivitySchedulingIntent,type ActivitySchedulingAcceptance,type ActivityStateObservation,type ActivityChangeInterest,
  type SharedAcceptancePort,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {retainTaskDecisionSource,TaskDecisionActivityError,modelRequestInputFailure,type AgentActivityExecutionContext,type TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {InputSupplyResponsibilityStore,InputSupplyExit} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcAgentOutput} from "../HelarcController.js";
import type {HelarcNativeTaskExecutionPorts} from "./HelarcNativeTaskExecution.js";
import {bindProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {nativeTaskCatalog} from "./HelarcNativeTask.js";
import type {HelarcNativeInputReplacement} from "./HelarcNativeInputReplacement.js";
import {HelarcNativeInputDemandWork,type HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";

type Input=TaskDecisionInputSources<HelarcAgentOutput>;
type Context=AgentActivityExecutionContext;
type Arranged=Awaited<ReturnType<HelarcNativeTaskExecutionPorts["prepare"]>>;
export interface HelarcNativeTaskInputSubmission {
  readonly identity:Omit<ActivityPathIntent,"owner"|"purpose">;
  readonly plan:HelarcNativeInputDemandPlan;
  readonly schedule:ActivitySchedulingIntent;
}
interface Retained {
  readonly revision:"1";
  readonly pathId:string;
  readonly sourceDigest:string;
  readonly proposal:SharedAcceptanceProposal;
  readonly digest:string;
}
interface Ports {
  readonly activities:ActivityHandoffPort;
  readonly acceptance:SharedAcceptancePort;
  readonly responsibilities:InputSupplyResponsibilityStore;
  readonly demand:Pick<HelarcNativeInputDemandWork,"purpose"|"prepareSubmission"|"result">;
  readonly host:{assertAvailable():void;wake():void;subscribe(listener:()=>void,interest?:ActivityChangeInterest):()=>void};
  /** Local binding only. The supplier, not this callback, owns preparation. */
  readonly arrange:(arranged:Arranged,input:Input,context:Context,replacement?:{readonly progress:HelarcNativeInputReplacement;readonly basis:HelarcNativeInputDemandPlan})=>Promise<HelarcNativeTaskInputSubmission>;
  readonly adopt:(original:Arranged,input:Input,inputId:string,plan:HelarcNativeInputDemandPlan)=>Promise<Arranged>;
  readonly rediscoveryMs:number;
  readonly settlementWaitMs:number;
}
const CHECKPOINT="helarc.native-task-input-demand.v1";

/** A durable waiting consumer; no method selection, private pump or native dispatch. */
export class HelarcNativeTaskInputWait {
  constructor(private readonly ports:Ports){
    for(const n of [ports.rediscoveryMs,ports.settlementWaitMs])if(!Number.isSafeInteger(n)||n<1)throw new TypeError("native_input_wait_bound_invalid");
  }
  async select(arranged:Arranged,input:Input,context:Context,replacement?:Parameters<Ports["arrange"]>[3]):Promise<Arranged>{
    let retained=this.read(input,context,arranged.activity.scope.activityId);
    if(!retained){
      context.cancellation.signal.throwIfAborted();this.ports.host.assertAvailable();
      const submission=await this.ports.arrange(arranged,input,context,replacement),{identity,plan,schedule}=submission;
      if(digest(plan.activity)!==digest(arranged.activity)||digest(plan.prepared)!==digest(arranged.prepared)||
        plan.prepared.sourceDigest!==retainTaskDecisionSource(input).id||identity.runId!==input.runId||schedule.runId!==input.runId||
        schedule.owner!==this.ports.demand.purpose.contract.acceptanceOwner||identity.scheduledWorkId!==schedule.workId||
        schedule.delegatedPathOwners?.length||schedule.allowedPathIds&&(schedule.allowedPathIds.length!==1||schedule.allowedPathIds[0]!==identity.id))
        throw new TypeError("native_input_wait_submission_changed");
      const proposal:SharedAcceptanceProposal={id:`${identity.id}:submission`,scope:input.runId,actor:schedule.owner,parts:[
        {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:{...schedule,allowedPathIds:[identity.id]},expectedRevision:0}},
        ...this.ports.demand.prepareSubmission(identity,plan)]};
      retained=structuredClone({revision:"1",pathId:identity.id,sourceDigest:plan.prepared.sourceDigest,proposal,digest:digest(proposal)});
      await this.checkpoints(context).commit(this.key(input,arranged.activity.scope.activityId),retained);
    }
    return this.continue(retained,input,context);
  }
  async restore(input:Input,context:Context):Promise<Arranged|null>{
    const retained=this.read(input,context);return retained?this.continue(retained,input,context):null;
  }
  async replace(input:Input,context:Context,progress:HelarcNativeInputReplacement):Promise<Arranged>{
    const saved=this.read(input,context,progress.activityId);if(saved)return this.continue(saved,input,context);
    const original=this.read(input,context);if(!original)throw new TypeError("native_replacement_original_demand_missing");
    const source=original.proposal.parts.find(p=>p.owner==="activity"&&p.kind==="stage_submission")!.proposal as {input:{plan:HelarcNativeInputDemandPlan}};
    const basis=source.input.plan,activity=bindProtocolModelActivity({...basis.activity,scope:{...basis.activity.scope,activityId:progress.activityId}});
    const prior=basis.prepared.binding,id=progress.activityId;
    const binding={...prior,scope:activity.scope,acceptance:{id:`${id}:accepted`,revision:"1"},requestId:`${id}:request`,
      operationId:prior.protocol.id==="openai.responses"?`${id}:responses:operation:1`:`${id}:create`,record:{id:`${id}:response`,revision:"1"}};
    const prepared={...basis.prepared,binding:{...binding,catalogRevision:nativeTaskCatalog(binding).revision}};
    return this.select({activity,prepared},input,context,{progress,basis});
  }
  async interrupt(input:Input,context:Context,replacement?:HelarcNativeInputReplacement):Promise<void>{
    const retained=this.read(input,context,replacement?.activityId);if(!retained)return;
    const receipt=await this.ports.acceptance.query(retained.proposal.id);
    if(!receipt)return;
    if(receipt.digest!==retained.digest||receipt.scope!==input.runId)throw new TypeError("native_input_wait_receipt_changed");
    if(receipt.outcome!=="accepted")return;
    const state=await this.state(retained);
    if(!state.path!.cancelled)await this.ports.activities.command({kind:"cancel",pathId:retained.pathId,expectedControlRevision:state.path!.controlRevision});
    this.ports.host.wake();await this.wait(retained,context,true);
  }
  private async continue(retained:Retained,input:Input,context:Context):Promise<Arranged>{
    context.cancellation.signal.throwIfAborted();this.ports.host.assertAvailable();
    const receipt=await this.ports.acceptance.accept(retained.proposal);
    if(receipt.digest!==retained.digest||receipt.scope!==input.runId||receipt.outcome!=="accepted")
      throw new TypeError(`native_input_wait_submission_unaccepted:${receipt.rejection?.code??"binding"}`);
    this.ports.host.wake();
    const ready=await this.wait(retained,context,false);
    if(!ready||ready.kind!=="ready")throw new TypeError("native_input_wait_ready_missing");
    context.cancellation.signal.throwIfAborted();
    return this.ports.adopt({activity:ready.plan.activity,prepared:ready.plan.prepared},input,ready.value.inputId,ready.plan);
  }
  private async wait(retained:Retained,context:Context,settling:boolean){
    const p=this.ports,deadline=settling?Date.now()+p.settlementWaitMs:Date.parse(context.retry.deadlineAt);
    if(!Number.isFinite(deadline))throw new TypeError("native_input_wait_deadline_invalid");
    const wake=new ActivityChangeWait(p.host,settling?null:context.cancellation.signal,{pathIds:[retained.pathId]}),
      cursor=new ActivityObservationCursor(p.activities,[retained.pathId]);
    let state:ActivityStateObservation|null=null;
    try{for(;;){
      const version=wake.version;
      if(await cursor.changed())state=await this.state(retained);
      if(!state)throw new TypeError("native_input_wait_state_missing");
      if(settling){
        const stages=state.stages.filter(s=>s!==null);
        if(state.path!.cancelled&&stages.every(s=>["submitted","admitted","accepted","settled","stopped"].includes(s.status))){
          const need=state.inputNeeds[0];
          const exit=need?await p.responsibilities.query({kind:"exit",needId:need.id}) as InputSupplyExit|null:null;
          if(!need||exit?.status==="closed"){await this.closeSchedule(state);return null;}
        }
      }else if(state.path!.cancelled){
        throw new ActivityCheckpointError(`${retained.pathId}:input-cancelled`);
      }else if(state.stages.some(s=>s?.status==="accepted"&&s.requestId!==`${retained.pathId}:stage:1`)){
        const result=await p.demand.result(retained.pathId);
        if(result.kind==="ready"){await this.closeSchedule(state);return result;}
        if(result.kind==="unavailable"){
          await this.closeSchedule(state);
          throw new TaskDecisionActivityError(modelRequestInputFailure({pathId:retained.pathId,limitation:result.value}),"settled_failure");
        }
      }
      p.host.assertAvailable();if(!settling)context.cancellation.signal.throwIfAborted();
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new ActivityCheckpointError(`${retained.pathId}:input-wait`,{cause:new Error("Original input handoff remains unsettled; no resubmission or dispatch")});
      await wake.wait(version,Math.min(remaining,p.rediscoveryMs));
    }}finally{wake.close();}
  }
  private async closeSchedule(state:ActivityStateObservation){
    const path=state.path!,workId=path.intent.scheduledWorkId;
    if(!workId)throw new TypeError("native_input_wait_schedule_missing");
    const work=await this.ports.activities.command({kind:"read_schedule",workId}) as ActivitySchedulingAcceptance|null;
    if(!work||work.intent.allowedPathIds?.length!==1||work.intent.allowedPathIds[0]!==path.intent.id)throw new TypeError("native_input_wait_schedule_changed");
    if(work.settlementConfirmed)return;
    const receipt=await this.ports.acceptance.accept({id:`${path.intent.id}:waiting-settled:${work.revision}`,scope:path.intent.runId,actor:path.intent.owner,parts:[
      {owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:true}},
      ...work.pathsSealed?[]:[{owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId,expectedRevision:work.revision,basis:"native_input_wait_finished"}}],
      {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId,expectedRevision:work.revision+(work.pathsSealed?0:1),basis:"native_input_wait_finished",requireSettled:true}}]});
    if(receipt.outcome!=="accepted")throw new ActivityCheckpointError(`${path.intent.id}:waiting-settlement`,{cause:new Error(receipt.rejection?.code??"rejected")});
  }
  private async state(retained:Retained){
    const state=await this.ports.activities.command({kind:"observe_state",pathId:retained.pathId,
      requestIds:[`${retained.pathId}:stage:1`,`${retained.pathId}:ready`,`${retained.pathId}:unavailable`],
      inputNeedIds:[`${retained.pathId}:need`]}) as ActivityStateObservation;
    const original=retained.proposal.parts.find(p=>p.owner==="activity"&&p.kind==="path_opening")?.proposal;
    if(!state.path||digest(state.path.intent)!==digest(original))throw new TypeError("native_input_wait_original_path_changed");
    return state;
  }
  private checkpoints(context:Context){if(!context.checkpoints)throw new TypeError("native_input_wait_checkpoint_required");return context.checkpoints;}
  private key(input:Input,activityId=`${input.toolExposure.controllerRequestId}:native-task`){
    return activityId===`${input.toolExposure.controllerRequestId}:native-task`?CHECKPOINT:`${CHECKPOINT}:${activityId}`;
  }
  private read(input:Input,context:Context,activityId=`${input.toolExposure.controllerRequestId}:native-task`):Retained|null {
    const retained=this.checkpoints(context).read(this.key(input,activityId)) as Retained|null;if(!retained)return null;
    const path=retained.proposal?.parts.find(p=>p.owner==="activity"&&p.kind==="path_opening")?.proposal as ActivityPathIntent|undefined;
    const source=retained.proposal?.parts.find(p=>p.owner==="activity"&&p.kind==="stage_submission")?.proposal as {id:string;input:{plan:HelarcNativeInputDemandPlan}}|undefined;
    if(retained.revision!=="1"||retained.digest!==digest(retained.proposal)||retained.proposal.scope!==input.runId||
      retained.proposal.id!==`${retained.pathId}:submission`||retained.sourceDigest!==retainTaskDecisionSource(input).id||
      path?.id!==retained.pathId||path.runId!==input.runId||path.purpose.digest!==this.ports.demand.purpose.digest||
      source?.id!==`${retained.pathId}:stage:1`||source.input.plan.prepared.sourceDigest!==retained.sourceDigest||
      source.input.plan.activity.scope.activityId!==activityId)
      throw new TypeError("native_input_wait_checkpoint_changed");
    return retained;
  }
}
