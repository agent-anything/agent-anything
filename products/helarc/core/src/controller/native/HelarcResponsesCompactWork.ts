import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPurposeContract,type ActivityPurposeBinding,
  type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityStageRequest,type ActivityRawResult,
  type ActivityHandoffPort,type SharedAcceptancePart,type ActivityResourceAllowance,type ActivitySchedulingAcceptance} from "@agent-anything/agent-runtime/activity";
import {RepresentationProductionLifecycle,type RepresentationProductionLifetime,type ProtocolRepresentationMethodRequest,type ContextPreparationMethodProgress,type ContextPreparationWorkEvidence} from "@agent-anything/agent-runtime/context-representation";
import type {MaterialCustodyPort,MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment,TransformationFinding} from "@agent-anything/context/representation";
import type {ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import {RESPONSES_COMPACT_METHOD,restoreResponsesCompactedWindow,type ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";
import {assertHelarcResponsesCompactSource,quoteHelarcResponsesCompact,assessHelarcResponsesCompact,
  type HelarcResponsesCompactSource,type HelarcResponsesCompactAssessment} from "./HelarcResponsesCompaction.js";

const stages=["source","input","compact","assessment","publication"] as const;
type Stage=typeof stages[number];
export const HELARC_RESPONSES_COMPACT_PURPOSE:ActivityPurposeContract={
  ref:{id:"helarc.responses-compact",revision:"1"},inputOwner:"context-representation",executionOwner:RESPONSES_COMPACT_METHOD.id,
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:RESPONSES_COMPACT_METHOD.id,
  stageKinds:stages,capabilities:["material-read","model-access","material-write"],continuationKinds:["stage_request"],
};
export interface HelarcResponsesCompactOutcome {
  readonly candidate:ResponsesCompactedWindow;
  readonly evidence:ModelPurposeEvidence;
}
export interface HelarcResponsesCompactUnavailable {
  readonly kind:"unavailable";
  readonly reason:string;
  readonly evidence:readonly string[];
}
/** A local admission disposition, not a quality finding or a remote response. */
export interface HelarcCompactAssessmentNotStarted {
  readonly kind:"assessment_not_started";
  readonly reason:"original_assessment_input_admission_missing";
  readonly stageId:string;readonly attemptId:string;readonly sourceDigest:string;readonly candidateDigest:string;
  readonly compositionDigest:string;readonly inputParticipant:{readonly id:string;readonly revision:string};
  readonly compactAcceptance:ModelPurposeEvidence["acceptance"];
  readonly checkedNativeActivities:readonly string[];
}
interface CompactProgress extends ContextPreparationMethodProgress<ProtocolRepresentationMethodRequest> {
  readonly request:ProtocolRepresentationMethodRequest;
  readonly phase:Stage;
  readonly state:"working"|"ready"|"gap";
  readonly input:null|{readonly allowed:boolean;readonly requestDigest:string;readonly basis:string;readonly limitations:readonly string[]};
  readonly compact:HelarcResponsesCompactOutcome|null;
  readonly assessment:HelarcResponsesCompactAssessment|null;
  readonly publication:null|{readonly representation:RepresentationRecord["ref"];readonly judgmentId:string};
  readonly limitation:string|null;
}
type StepContext={readonly path:ActivityPathState;readonly stage:ActivityStageState;readonly signal:AbortSignal;readonly recover:boolean};
export interface HelarcResponsesCompactWorkPorts {
  readonly productionLifetime?:RepresentationProductionLifetime;
  readonly activities:ActivityHandoffPort;
  readonly materials:MaterialCustodyPort;
  readonly representations:RepresentationCatalogPort;
  readonly now:()=>string;
  readonly probeRequired:boolean;
  readonly authorize:ActivityPurposeHandler["authorize"];
  /** Native input/count evidence, including explicit policy for unknown measurement. */
  readonly prepareInput:(source:HelarcResponsesCompactSource,context:StepContext)=>Promise<NonNullable<CompactProgress["input"]>|null>;
  /** Recover queries only the original compact operation. Null retains unresolved work. */
  readonly compact:(source:HelarcResponsesCompactSource,context:StepContext)=>Promise<HelarcResponsesCompactOutcome|HelarcResponsesCompactUnavailable|null>;
  readonly assess:(source:HelarcResponsesCompactSource,outcome:HelarcResponsesCompactOutcome,context:StepContext)=>Promise<readonly TransformationFinding[]|HelarcCompactAssessmentNotStarted|null>;
  /** Idempotent publication preserves complete native output and original source holds. */
  readonly publish:(source:HelarcResponsesCompactSource,outcome:HelarcResponsesCompactOutcome,assessment:HelarcResponsesCompactAssessment,
    context:StepContext)=>Promise<NonNullable<CompactProgress["publication"]>|null>;
  readonly interrupt?:(source:HelarcResponsesCompactSource,context:StepContext)=>Promise<readonly unknown[]>;
}

/** Professional compact orchestration; shared execution does not choose or interpret this method. */
export class HelarcResponsesCompactWork implements ActivityPurposeHandler {
  readonly purpose:ActivityPurposeBinding;
  readonly lifecycle:RepresentationProductionLifecycle|null;
  constructor(private readonly ports:HelarcResponsesCompactWorkPorts,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(HELARC_RESPONSES_COMPACT_PURPOSE,this);
    this.lifecycle=ports.productionLifetime?new RepresentationProductionLifecycle(ports.activities,ports.productionLifetime):null;
  }
  prepareSubmission(intent:Omit<ActivityPathIntent,"owner"|"purpose">,request:ProtocolRepresentationMethodRequest):readonly [SharedAcceptancePart,SharedAcceptancePart,...SharedAcceptancePart[]]{
    const source=this.source(request),quote=quoteHelarcResponsesCompact({source,bounds:request.bounds,probeRequired:this.ports.probeRequired,materialAccesses:request.materialAccesses});
    if(digest(quote.request)!==digest(request)||intent.runId!==request.recipient.runId||quote.quotation.gaps.length||
      intent.maximumStages<quote.quotation.minimum.stages||intent.maximumAttempts<quote.quotation.minimum.attempts)
      throw new TypeError("responses_compact_delegation_invalid");
    const resourceLimits={readBytes:request.bounds.readBytes,storedBytes:request.bounds.storedBytes,modelCalls:request.bounds.modelCalls,measurementCalls:source.assessmentInput?.maximumMeasurements??1};
    if(intent.resourceLimits&&digest(intent.resourceLimits)!==digest(resourceLimits))throw new TypeError("responses_compact_resource_binding_changed");
    const method:CompactProgress={request,phase:"source",state:"working",input:null,compact:null,assessment:null,publication:null,limitation:null};
    const path={...intent,resourceLimits,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose};
    const first=this.stage(intent.id,method,null);
    return [{owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{...first,input:{...first.input as object,
        ...(this.lifecycle&&intent.scheduledWorkId?{inputSupplyProduction:this.lifecycle.declaration(path,first.id)}:{})}}},
      ...(this.lifecycle&&intent.scheduledWorkId?[this.lifecycle.subscription(path)]:[])];
  }
  async result(pathId:string):Promise<CompactProgress|null>{
    const path=await this.path(pathId);
    return (path.progress as {method?:CompactProgress}|null)?.method??null;
  }
  async describe(pathId:string):Promise<ContextPreparationWorkEvidence>{
    const path=await this.path(pathId),progress=(path.progress as {method?:CompactProgress}|null)?.method;
    let unknown=false,initial:CompactProgress|undefined;
    for(let index=0;index<stages.length;index++){
      const stage=await this.ports.activities.command({kind:"read_stage",requestId:`${pathId}:stage:${index+1}`}) as ActivityStageState|null;
      if(!stage)break;
      const method=this.method(path,stage);
      if(index===0)initial=method;
      if(stage.result?.outcome==="unknown"||path.cancelled&&stage.attempt&&!stage.result)unknown=true;
    }
    const method=progress??initial;
    if(!method)throw new TypeError("responses_compact_progress_unavailable");
    this.source(method.request);
    const allowance=await this.ports.activities.command({kind:"resource_allowance",pathId}) as ActivityResourceAllowance;
    const remaining=(name:"readBytes"|"storedBytes"|"modelCalls")=>{
      const limit=allowance.limits[name];
      if(limit!==method.request.bounds[name])throw new TypeError("responses_compact_resource_binding_changed");
      return limit-(allowance.reserved[name]??0);
    };
    return {state:unknown?"unknown":path.cancelled?"cancelled":method.state==="gap"?"failed":method.state==="ready"?"ready":path.progressRevision?"active":"accepted",
      ...(method.state==="gap"&&method.limitationEvidence?{limitationEvidence:method.limitationEvidence}:{}),
      ...(method.state==="gap"&&method.assessment?{assessmentIssues:[...new Set(method.assessment.findings.flatMap(f=>f.assessmentIssue?[f.assessmentIssue.category]:[]))]}:{}),
      revision:path.progressRevision,used:{stages:path.resourceUse.admittedStages,attempts:path.resourceUse.dispatchedAttempts,
        readBytes:null,storedBytes:null,modelCalls:null},
      remaining:{stages:path.intent.maximumStages-path.resourceUse.admittedStages,attempts:path.intent.maximumAttempts-path.resourceUse.dispatchedAttempts,
        readBytes:remaining("readBytes"),storedBytes:remaining("storedBytes"),modelCalls:remaining("modelCalls")},allowance,
      limitations:["compact_resource_reservations_are_not_confirmed_consumption","compact_read_store_and_prepared_input_totals_unknown",
        "native_usage_is_observed_separately",...(method.limitation?[method.limitation]:[])]};
  }
  async prepareClosure(pathId:string,basis:string):Promise<readonly SharedAcceptancePart[]>{
    if(!basis)throw new TypeError("responses_compact_closure_basis_missing");
    const path=await this.path(pathId),parts:SharedAcceptancePart[]=[];
    if(!path.cancelled)parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId,expectedControlRevision:path.controlRevision}});
    if(path.intent.scheduledWorkId){
      const work=await this.ports.activities.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as ActivitySchedulingAcceptance|null;
      if(!work)throw new TypeError("responses_compact_original_schedule_unavailable");
      if(!work.closed)parts.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,expectedRevision:work.revision,basis}});
    }
    return parts;
  }
  private async path(pathId:string):Promise<ActivityPathState>{
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path||path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("responses_compact_original_path_unavailable");
    return path;
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    const method=this.method(path,stage);this.source(method.request);
    const authorization=await this.ports.authorize(path,stage,signal,action);
    if(authorization.kind!=="allowed")return authorization;
    // Reconciliation/settlement must still retain an already executed outcome after revocation.
    if(action==="admission"||action==="execution")for(const access of method.request.materialAccesses){
      const value=await this.ports.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription;
      if(value.hold.range.materialId!==access.range.materialId||value.hold.range.version!==access.range.version||
        value.hold.range.start>access.range.start||value.hold.range.end<access.range.end)throw new TypeError("responses_compact_source_access_changed");
    }
    return authorization;
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,_attempt:Parameters<ActivityPurposeHandler["execute"]>[2],signal:AbortSignal):Promise<ActivityRawResult>{
    const result=await this.perform(path,stage,signal,false);
    if(!result)throw new TypeError("responses_compact_execution_without_outcome");
    return result;
  }
  reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){return this.perform(path,stage,signal,true);}
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();const previous=this.method(path,stage),result=stage.result;
    if(!result||result.outcome!=="returned"||result.completeness!=="complete")throw new TypeError("responses_compact_result_unresolved");
    const method=result.value as CompactProgress;
    if(digest(method.request)!==digest(previous.request)||method.phase!==previous.phase)throw new TypeError("responses_compact_progress_changed");
    const index=stages.indexOf(method.phase),next=method.state==="working"?[this.stage(path.intent.id,{...method,phase:stages[index+1]!},stage.request.id)]:[];
    return {progress:{method},next};
  }
  async handleLimitation(path:ActivityPathState,stage:ActivityStageState,limitation:Parameters<NonNullable<ActivityPurposeHandler["handleLimitation"]>>[2],signal:AbortSignal){
    signal.throwIfAborted();const method=this.method(path,stage);
    if(path.cancelled||stage.attempt)return {kind:"wait" as const};
    return {kind:"stop" as const,progress:{method:{...method,state:"gap",limitation:`${limitation.kind}: no new compact work admitted`},limitation}};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();this.method(path,stage);
    if(!stage.result||stage.result.outcome==="unknown")throw new TypeError("responses_compact_cancel_unresolved");
    return {disposition:{kind:"compact_result_retained",resultId:stage.result.id,selection:"not_adopted",sourceProtection:"unchanged"}};
  }
  private method(path:ActivityPathState,stage:ActivityStageState):CompactProgress{
    const method=(stage.request.input as {method?:CompactProgress})?.method;
    if(!method||path.intent.purpose.digest!==this.purpose.digest||stage.request.pathId!==path.intent.id||
      stage.request.stageKind!==method.phase||method.request.recipient.runId!==path.intent.runId||method.state!=="working")
      throw new TypeError("responses_compact_stage_binding_invalid");
    return method;
  }
  private source(request:ProtocolRepresentationMethodRequest):HelarcResponsesCompactSource{
    if(request.method!=="protocol"||request.execution.owner!==RESPONSES_COMPACT_METHOD.id||request.execution.protocol.id!=="openai.responses")
      throw new TypeError("responses_compact_method_owner_invalid");
    const s=request.execution.request as HelarcResponsesCompactSource;
    assertHelarcResponsesCompactSource(s);
    return s;
  }
  private stage(pathId:string,method:CompactProgress,previous:string|null):ActivityStageRequest{
    if(!stages.includes(method.phase))throw new TypeError("responses_compact_phase_invalid");
    return {id:`${pathId}:stage:${stages.indexOf(method.phase)+1}`,pathId,stageKind:method.phase,input:{method},
      capabilities:method.phase==="compact"||method.phase==="input"||method.phase==="assessment"?["model-access"]:
        method.phase==="source"?["material-read"]:["material-write"],dependencies:previous?[{requestId:previous,condition:"accepted"}]:[]};
  }
  private async perform(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,recover:boolean):Promise<ActivityRawResult|null>{
    signal.throwIfAborted();let method=this.method(path,stage);
    const source=this.source(method.request),context={path,stage,signal,recover};
    if(path.cancelled){
      if(!this.ports.interrupt)throw new TypeError("responses_compact_interruption_owner_unavailable");
      const evidence=await this.ports.interrupt(source,context);
      return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
        value:{...method,state:"gap",limitation:"Original production cancelled",interruption:evidence},usage:{},recordedAt:this.ports.now()};
    }
    const reserve=async(amounts:Record<string,number>)=>this.ports.activities.command({kind:"reserve_resources",reservation:{
      id:`${stage.request.id}:allowance`,pathId:path.intent.id,requestId:stage.request.id,amounts},expectedControlRevision:path.controlRevision});
    if(!recover){
      if(method.phase==="source")await reserve({readBytes:Buffer.byteLength(source.methodRequest.encoded)});
      if(method.phase==="compact")await reserve({modelCalls:1});
      if(method.phase==="assessment"&&this.ports.probeRequired)await reserve({modelCalls:source.assessmentModelCalls??1});
    }
    if(method.phase==="input"){
      const input=await this.ports.prepareInput(source,context);if(!input)return null;
      if(input.requestDigest!==source.methodRequest.digest||!input.basis)throw new TypeError("responses_compact_input_basis_changed");
      method={...method,input,...(!input.allowed?{state:"gap" as const,limitation:"compact_input_unavailable"}:{})};
    }else if(method.phase==="compact"){
      if(!method.input?.allowed)throw new TypeError("responses_compact_input_not_ready");
      const compact=await this.ports.compact(source,context);if(!compact)return null;
      if("kind" in compact){
        if(!compact.reason||!compact.evidence.length)throw new TypeError("responses_compact_disposition_evidence_missing");
        method={...method,state:"gap",limitation:compact.reason};
        return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
          value:{...method,unavailable:compact},usage:{},recordedAt:this.ports.now()};
      }
      if(digest(restoreResponsesCompactedWindow(compact.candidate.raw))!==digest(compact.candidate)||
        compact.evidence.scope.runId!==path.intent.runId||digest(compact.evidence.scope.purpose)!==digest(source.methodRequest.purpose)||
        compact.evidence.scope.compositionDigest!==source.manifest.scope.compositionDigest||!compact.evidence.sources.length)
        throw new TypeError("responses_compact_outcome_binding_changed");
      method={...method,compact};
    }else if(method.phase==="assessment"){
      if(!method.compact)throw new TypeError("responses_compact_outcome_missing");
      const findings=await this.ports.assess(source,method.compact,context);if(!findings)return null;
      if("kind" in findings){
        if(findings.stageId!==stage.request.id||findings.attemptId!==stage.attempt!.id||findings.sourceDigest!==source.sourceDigest||
          findings.candidateDigest!==method.compact.candidate.digest||findings.compositionDigest!==source.manifest.scope.compositionDigest||
          digest(findings.compactAcceptance)!==digest(method.compact.evidence.acceptance))throw new TypeError("compact_assessment_disposition_unbound");
        const id=stage.attempt!.id+":raw";
        return {id,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",usage:{},recordedAt:this.ports.now(),
          value:{...method,state:"gap",limitation:findings.reason,assessmentDisposition:findings,
            limitationEvidence:{owner:"context-representation",kind:"fact",id,revision:"1"}}};
      }
      const assessment=assessHelarcResponsesCompact({source,candidate:method.compact.candidate,findings});
      method={...method,assessment,...(!assessment.quality.allowed?{state:"gap" as const,limitation:"compact_preservation_not_established",
        limitationEvidence:{owner:"context-representation",kind:"judgment" as const,id:assessment.id,revision:"1"}}:{})};
    }else if(method.phase==="publication"){
      if(!method.compact||!method.assessment?.quality.allowed)throw new TypeError("responses_compact_publication_not_ready");
      if(!recover)await reserve({storedBytes:Buffer.byteLength(JSON.stringify(method.compact.candidate.items))});
      const publication=await this.ports.publish(source,method.compact,method.assessment,context);if(!publication)return null;
      const record=await this.ports.representations.command({kind:"read",ref:publication.representation}) as RepresentationRecord|null;
      const judgment=await this.ports.representations.command({kind:"read_judgment",id:publication.judgmentId}) as RepresentationJudgment|null;
      if(!record||record.form!=="native"||record.runId!==path.intent.runId||record.target!==method.request.targetRevision||
        record.method?.id!==RESPONSES_COMPACT_METHOD.id||record.method.acceptanceId!==method.compact.evidence.acceptance.id||
        !judgment||judgment.id!==method.assessment.id||judgment.conclusion!=="supported"||!judgment.subjects.some(r=>digest(r)===digest(record.ref)))
        throw new TypeError("responses_compact_publication_unconfirmed");
      method={...method,publication,state:"ready"};
    }
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",value:method,usage:{},recordedAt:this.ports.now()};
  }
}
