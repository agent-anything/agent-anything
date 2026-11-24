import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,requireModelPurpose,type ModelAgentCompositionBinding,type ModelPurposeParticipants,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,readProtocolContent,type ProtocolModelActivity,type ProtocolExecutionState,type ProtocolJournalRecord,type ProtocolEvidenceRevision,type ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import type {ProtocolRepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import {containsMaterialRange,type MaterialAccessDescription,type MaterialHold} from "@agent-anything/context/custody";
import type {RepresentationRecord} from "@agent-anything/context/representation";
import {HelarcResponsesCompactExecution,HELARC_RESPONSES_COMPACT_INTERPRETER,HelarcNativeStructuredExecution,HELARC_NATIVE_STRUCTURED_INTERPRETER,
  prepareHelarcResponsesStructured,assessHelarcResponsesCompactByProbe,retainHelarcResponsesCompactMaterial,retainHelarcResponsesCompactAssessment,helarcResponsesCompactEvidenceScope,
  type HelarcResponsesCompactWorkPorts,type HelarcResponsesCompactSource,type HelarcNativeStructuredRequest} from "@agent-anything/helarc/controller";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "../provider/ProviderConfigurationService.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {HelarcResponsesCompactConnection} from "../provider/HelarcResponsesCompactConnection.js";
import {HelarcResponsesPurposeObserver} from "../provider/HelarcResponsesPurposeObserver.js";
import {compactAssessmentRevisions,compactAssessmentVersion,currentCompactAssessmentRevision} from "./HelarcCompactAssessmentVersion.js";
import {confirmUnstartedCompactAssessment} from "./HelarcCompactAssessmentFootprint.js";
import {recordHelarcNativeUsage,hasHelarcNativeUsage} from "../provider/HelarcNativeUsage.js";
import {prepareHelarcNativeStructuredInput,HelarcNativeStructuredInputUnavailable} from "@agent-anything/helarc/controller";
import type {HelarcResponsesInputMeasurements} from "./HelarcResponsesInputMeasurement.js";

export const HELARC_NATIVE_COMPACT_PURPOSE={id:"context_compaction",revision:"1"} as const;
const assessmentPurpose={id:"context_compaction_assessment",revision:"1"} as const;
type Context=Parameters<HelarcResponsesCompactWorkPorts["compact"]>[1];
type CompactPorts=Omit<HelarcResponsesCompactWorkPorts,"activities"|"materials"|"representations"|"authorize"|"now"|"productionLifetime">;

/** Purpose composition for one original Run tree, using its shared professional stage admissions. */
export function bindHelarcResponsesCompactMethods(p:{
  readonly store:HelarcExecutionStore;readonly configuration:ProviderConfiguration;readonly providers:ProviderConfigurationService;
  readonly carrier:HelarcResponsesPurposeObserver;readonly now:()=>string;
  readonly composition:(runId:string)=>Promise<ModelAgentCompositionBinding>;
  readonly conditions:(source:HelarcResponsesCompactSource)=>ProtocolModelActivity["conditions"];
  readonly check:(activity:ProtocolModelActivity,signal:AbortSignal,dispatch?:boolean)=>Promise<void>;
  readonly allowUnknownCapacity:boolean;
  readonly measurement:HelarcResponsesInputMeasurements;
}){
  const {store,configuration,carrier}=p,n=configuration.native;
  if(configuration.protocol!=="openai.responses"||n.protocol!=="openai.responses")throw new TypeError("compact_protocol_not_bound");
  const participants:readonly ModelPurposeParticipants[]=[
    {purpose:HELARC_NATIVE_COMPACT_PURPOSE,input:{implementation:{id:"helarc.responses-compact-input",revision:"1"},protocol:OPENAI_RESPONSES},
      interpreter:{implementation:HELARC_RESPONSES_COMPACT_INTERPRETER,protocol:OPENAI_RESPONSES}},
    {purpose:assessmentPurpose,input:{implementation:{id:"helarc.responses-compact-assessment-input",revision:currentCompactAssessmentRevision},protocol:OPENAI_RESPONSES},
      interpreter:{implementation:HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol:OPENAI_RESPONSES}}];
  const current=participants[1]!,legacy=compactAssessmentRevisions.filter(r=>r!==currentCompactAssessmentRevision)
    .map(revision=>({...current,input:{...current.input,implementation:{...current.input.implementation,revision}}}));
  const supports=(value:ModelPurposeParticipants)=>[...participants,...legacy].some(v=>digest(v)===digest(value));
  function assessmentVersion(composition:ModelAgentCompositionBinding){
    const participant=requireModelPurpose(composition,assessmentPurpose);
    if(!supports(participant))throw new TypeError("compact_original_composition_changed");
    return compactAssessmentVersion(participant.input.implementation.revision);
  }
  const connection=new HelarcResponsesCompactConnection(store,p.providers);
  const execution=new HelarcResponsesCompactExecution({journal:store.protocolJournal,acceptance:store.sharedAcceptance,generation:store.generation,
    authorize:async(request,mode,signal)=>{connection.checkOriginal(request);await p.check(request.activity,signal,mode==="dispatch");},
    dispatch:(...args)=>connection.dispatch(...args)});
  const assessment=new HelarcNativeStructuredExecution({journal:store.protocolJournal,acceptance:store.sharedAcceptance,generation:store.generation,now:p.now,
    authorize:async(request,ctx)=>{
      if(digest(request.activity.scope.purpose)!==digest(assessmentPurpose)||!supports(requireModelPurpose(request.activity.composition,request.activity.scope.purpose)))
        throw new TypeError("compact_assessment_original_purpose_changed");
      await p.check(request.activity,ctx.signal);
    },observe:(state,request,ctx)=>carrier.observe(state,request,ctx.signal,()=>p.check(state.activity,ctx.signal,true)),
    unavailable:(state,request)=>carrier.retainedLimitation(state,request),
    interrupt:(state,request)=>carrier.interrupt(state,request,`${state.activity.scope.activityId}:cancel`)});
  async function activity(source:HelarcResponsesCompactSource,id:string,purpose:ProtocolRevisionRef){
    const s=source.manifest.scope,composition=await p.composition(s.runId);
    if(composition.digest!==s.compositionDigest||!supports(requireModelPurpose(composition,purpose)))
      throw new TypeError("compact_original_composition_changed");
    return bindProtocolModelActivity({composition,scope:{runId:s.runId,activityId:id,recipientId:"context-representation",purpose,compositionDigest:composition.digest},
      conditions:p.conditions(source)});
  }
  function request(source:HelarcResponsesCompactSource,ctx:Context):ProtocolRepresentationMethodRequest{
    const value=(ctx.stage.request.input as {method?:{request?:ProtocolRepresentationMethodRequest}}).method?.request;
    if(!value||value.method!=="protocol"||digest(value.execution.request)!==digest(source)||value.recipient.runId!==ctx.path.intent.runId)
      throw new TypeError("compact_original_stage_changed");
    return value;
  }
  async function sourceRecords(source:HelarcResponsesCompactSource,ctx:Context){
    const declared=request(source,ctx),holds:MaterialHold[]=[];
    for(const access of declared.materialAccesses){
      ctx.signal.throwIfAborted();
      const description=await store.materialCustody.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription;
      if(!containsMaterialRange(description.hold.range,access.range))throw new TypeError("compact_source_access_changed");
      holds.push(description.hold);
    }
    const sources:{record:RepresentationRecord;holds:readonly MaterialHold[]}[]=[];
    for(const group of source.manifest.groups.slice(0,source.groups.length)){
      const record=await store.representations.command({kind:"read",ref:group.representation}) as RepresentationRecord|null;
      if(!record||record.runId!==ctx.path.intent.runId||[record.body,...record.details].some(range=>!holds.some(h=>containsMaterialRange(h.range,range))))
        throw new TypeError("compact_source_protection_unavailable");
      sources.push({record,holds:holds.filter(h=>[record.body,...record.details].some(range=>containsMaterialRange(h.range,range)))});
    }
    return sources;
  }
  async function account(id:string){
    const state=await store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
    const record=await store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${id}:response`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(!state||!record||await hasHelarcNativeUsage(store,record))return;
    const response=JSON.parse((await readProtocolContent(store.protocolJournal,record.content,id,32*1024*1024)).toString());
    const head=await store.protocolJournal.command({kind:"evidence",activityId:id,scopeId:helarcResponsesCompactEvidenceScope(state.activity).id,
      evidenceKind:"transformation",key:`${id}:compact`}) as ProtocolEvidenceRevision|null;
    const submittedAt=head?.metadata.transportStartedAt,receivedAt=head?.metadata.transportCompletedAt;
    // Dispatch/receipt times are supplied by the native observation, never inferred from purpose acceptance.
    await recordHelarcNativeUsage(store,state,record,{operationId:`${id}:compact:compact`,operation:"compact",response,
      endpoint:null,submittedAt:typeof submittedAt==="string"?submittedAt:null,receivedAt:typeof receivedAt==="string"?receivedAt:null,channel:"create"});
  }
  const work:CompactPorts={probeRequired:true,
    prepareInput:async(source,ctx)=>{
      await sourceRecords(source,ctx);
      const frozen=await p.composition(source.manifest.scope.runId);
      if(frozen.digest!==source.manifest.scope.compositionDigest)throw new TypeError("compact_original_composition_changed");
      const version=assessmentVersion(frozen);
      if(version.requiresInputAdmission!==Boolean(source.assessmentInput)||
        (source.assessmentModelCalls!==3&&!(version.procedure==="source_and_use.v3"&&source.assessmentModelCalls===4)))
        return {allowed:false,requestDigest:source.methodRequest.digest,basis:"Frozen assessment input obligation does not match the admitted work",
          limitations:["compact_assessment_original_admission_changed"]};
      return {allowed:p.allowUnknownCapacity,requestDigest:source.methodRequest.digest,
        basis:"Original complete compact input retained; native compact capacity has no established count equivalence",
        limitations:["compact_input_token_capacity_unknown",...(p.allowUnknownCapacity?["original_policy_accepts_unknown_capacity"]:[])]};
    },compact:async(source,ctx)=>{
      const id=`${ctx.path.intent.id}:native-compact`;
      let result=await execution.recover(id,ctx.signal);
      if(!result){
        if(request(source,ctx).bounds.storedBytes<1)return {kind:"unavailable",reason:"compact_output_storage_allowance_exhausted",evidence:[ctx.stage.request.id]};
        const a=await activity(source,id,HELARC_NATIVE_COMPACT_PURPOSE);
        const prepared=await connection.prepare({activity:a,source,configuration,startedAt:Date.parse(ctx.stage.attempt!.startedAt),
          maximumBytes:request(source,ctx).bounds.storedBytes});
        result=await execution.execute(prepared,ctx.signal);
      }
      await account(id);
      return result.kind==="produced"?result.result.outcome:{kind:"unavailable",reason:`compact_${result.kind}:${result.state.failure??result.state.status}`,
        evidence:[id,`${id}:compact:revision:${result.state.revision}`]};
    },assess:async(source,outcome,ctx)=>{
      await sourceRecords(source,ctx);
      const composition=await p.composition(source.manifest.scope.runId);
      if(composition.digest!==source.manifest.scope.compositionDigest)throw new TypeError("compact_original_composition_changed");
      const version=assessmentVersion(composition);
      if(version.requiresInputAdmission&&!source.assessmentInput){
        const pathId=ctx.path.intent.id,attempt=ctx.stage.attempt;
        if(!attempt||ctx.stage.request.stageKind!=="assessment")throw new TypeError("compact_assessment_attempt_missing");
        const compact=await store.protocolJournal.command({kind:"acceptance",activityId:pathId+":native-compact"}) as ProtocolPurposeAcceptance|null;
        if(!compact||digest(compact.evidence)!==digest(outcome.evidence))throw new TypeError("compact_assessment_original_outcome_changed");
        const checkedNativeActivities=await confirmUnstartedCompactAssessment(pathId,ctx.signal,{
          native:id=>store.protocolJournal.command({kind:"state",activityId:id}),preparation:id=>store.sharedAcceptance.query(id),
          connection:id=>p.providers.readPin(id)},version.procedure==="source_and_use.v3");
        return {kind:"assessment_not_started",reason:"original_assessment_input_admission_missing",stageId:ctx.stage.request.id,attemptId:attempt.id,
          sourceDigest:source.sourceDigest,candidateDigest:outcome.candidate.digest,compositionDigest:composition.digest,
          inputParticipant:requireModelPurpose(composition,assessmentPurpose).input.implementation,compactAcceptance:outcome.evidence.acceptance,checkedNativeActivities};
      }
      try{return await assessHelarcResponsesCompactByProbe({source,outcome,procedure:version.procedure,execute:async(step,items,schema,basis)=>{
        const id=`${ctx.path.intent.id}:compact-assessment:${step}`,context={signal:ctx.signal,interruption:null};
        const recovered=await assessment.recover(id,context);
        if(recovered){
          if(recovered.source.id!==basis)throw new TypeError("compact_assessment_original_basis_changed");
          return recovered;
        }
        const a=await activity(source,id,assessmentPurpose);
        const prepared=prepareHelarcResponsesStructured({activity:a,source:{id:basis,revision:"1"}},
          {input:items,textSchema:schema,store:n.store,stream:false,background:false,transport:"http",
            ...(n.reasoningEffort?{reasoning:{effort:n.reasoningEffort}}:{})});
        const admission=source.assessmentInput;
        if(version.requiresInputAdmission!==Boolean(admission))
          throw new TypeError("compact_assessment_original_admission_changed");
        let request=prepared;
        if(admission){
          const capacity=admission.capacity,local=prepareHelarcNativeStructuredInput(prepared,capacity);
          const measured=!local.assessment.decisions.some(d=>d.conclusion==="violated")&&admission.maximumMeasurements>0?await p.measurement.measureStructured(prepared,{
            runId:a.scope.runId,activityId:id,recipientId:a.scope.recipientId,source:prepared.source,
            measurement:{kind:"compact_assessment_input",pathId:ctx.path.intent.id,stageId:ctx.stage.request.id,maximumCalls:admission.maximumMeasurements}},ctx.signal):null;
          request={...prepared,inputPreparation:measured?prepareHelarcNativeStructuredInput(prepared,capacity,measured.evidence,measured.refusals):local};
          if(!request.inputPreparation!.assessment.allowed)return assessment.execute(request,context);
        }
        return assessment.execute(await carrier.prepare(a,request,configuration,{transport:"http",continuity:"native_replay"}),context);
      }});}catch(error){
        if(!(error instanceof HelarcNativeStructuredInputUnavailable))throw error;
        return source.duties.map(d=>({id:`compact-input-unavailable:${digest([error.preparation.id,d])}`,dutyId:d.id,dutyRevision:d.revision,
          kind:"continuation_probe",conclusion:"unknown",subject:outcome.candidate.digest,dependencies:source.dependencies,evidence:[error.preparation.id],
          limitations:["Complete assessment input was denied; no generation dispatched."],
          probe:{candidateDigest:outcome.candidate.digest,independentOracle:source.sourceDigest,answerBearingBackground:false}}));
      }
    },publish:async(source,outcome,quality,ctx)=>{
      const sources=await sourceRecords(source,ctx),e=outcome.evidence,observation=e.sources[0];
      if(!observation||e.sources.length!==1)throw new TypeError("compact_publication_original_observation_missing");
      const result=await retainHelarcResponsesCompactMaterial({materials:store.materialCustody,representations:store.representations,acceptance:store.sharedAcceptance,
        source,candidate:outcome.candidate,owner:"context-representation",purpose:source.methodRequest.purpose.id,activityId:e.scope.activityId,
        observationId:observation.record.id,occurredAt:ctx.stage.attempt!.startedAt,
        confirmation:{rawRevision:observation.record.revision,acceptanceId:e.acceptance.id,acceptanceRevision:e.acceptance.revision},sources});
      const dep=ctx.stage.request.dependencies[0],prior=dep?await store.activityHandoffs.command({kind:"read_stage",requestId:dep.requestId}) as
        import("@agent-anything/agent-runtime/activity").ActivityStageState|null:null;
      if(!prior?.result||prior.status!=="accepted"||prior.request.pathId!==ctx.path.intent.id||prior.request.stageKind!=="assessment"||
        (prior.result.value as {assessment?:{id:string}})?.assessment?.id!==quality.id)throw new TypeError("compact_assessment_result_unconfirmed");
      const judgment=await retainHelarcResponsesCompactAssessment({catalog:store.representations,assessment:quality,record:result.record,observationId:observation.record.id,
        ...(source.assessmentInput?{assessmentResultId:prior.result.id}:{})});
      return {representation:result.record.ref,judgmentId:judgment.id};
    },interrupt:async(source,ctx)=>{
      const evidence:unknown[]=[],id=`${ctx.path.intent.id}:native-compact`;
      const compact=await execution.interrupt(id,ctx.signal);
      if(compact)evidence.push({activityId:id,revision:compact.revision,disposition:compact.status});
      const version=assessmentVersion(await p.composition(source.manifest.scope.runId));
      for(const step of ["oracle",...(version.procedure==="source_and_use.v3"?["plan-ownership"]:[]),"probe","judgment"]){
        const activityId=`${ctx.path.intent.id}:compact-assessment:${step}`;
        if(source.assessmentInput?.maximumMeasurements)await p.measurement.interruptStructured({activityId},ctx.signal);
        const state=await store.protocolJournal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
        if(!state)continue;
        const original=JSON.parse((await readProtocolContent(store.protocolJournal,state.input,activityId,32*1024*1024)).toString()) as HelarcNativeStructuredRequest;
        if(original.activity.scope.runId!==source.manifest.scope.runId||original.activity.scope.compositionDigest!==source.manifest.scope.compositionDigest)
          throw new TypeError("compact_assessment_interruption_scope_changed");
        const disposition=await assessment.interrupt(activityId,original.source,{signal:ctx.signal,interruption:null});
        evidence.push({activityId,disposition});
      }
      return evidence;
    }};
  const assessmentModelCalls=(composition:ModelAgentCompositionBinding,methodCalls:number)=>assessmentVersion(composition).procedure==="source_and_use.v3"&&methodCalls>=5?4:3;
  return {participants,supports,work,purpose:HELARC_NATIVE_COMPACT_PURPOSE,assessmentPurpose,assessmentVersion,assessmentModelCalls};
}
