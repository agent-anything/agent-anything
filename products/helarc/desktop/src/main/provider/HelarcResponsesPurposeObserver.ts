import {setTimeout as wait} from "node:timers/promises";
import {measureIdentifiedWork,measuredFetch,protocolWork} from "../diagnostics/IdentifiedWorkTiming.js";
import {ActivityCheckpointError} from "@agent-anything/agent-runtime/activity";
import {ProtocolObservationUnavailable,readProtocolContent,type ProtocolExecutionState,type ProtocolModelActivity,type ProtocolJournalRecord,type ProtocolEvidenceScope,type ProtocolReconciliationHandoff} from "@agent-anything/agent-runtime/model-access";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ResponsesSession,restoreResponsesInputTokenCount,type ResponsesSessionBinding} from "@agent-anything/provider-integrations/native";
import {HelarcResponsesSessionStore,HelarcResponsesCompactStore,helarcResponsesCompactEvidenceScope,handoffHelarcResponses,closeHelarcResponsesHandoff,
  validateHelarcResponsesCompactionAgreement,type HelarcRetainedNativeInput,
  type HelarcNativeRunTask,type HelarcNativeStructuredRequest,type HelarcResponsesCompactRequest,type HelarcResponsesCountRequest} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {providerCompactionTarget,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import {ProviderConnectionRetention,type RetainedConnection} from "./ProviderConnectionRetention.js";
import {HelarcResponsesTransport,helarcResponsesSessionBinding} from "./HelarcResponsesTransport.js";
import {claimHelarcNativeRetirement,releaseHelarcNativeRetention,readHelarcNativeDischarge,settleHelarcNativeInputUse,type HelarcNativeDeliveryResolution} from "./HelarcNativeRetention.js";
import type {ProtocolObservationReceipt} from "@agent-anything/agent-runtime/model-access";
import {hasHelarcNativeUsage,recordHelarcNativeUsage,registerHelarcNativeUsage} from "./HelarcNativeUsage.js";
import {HelarcResponsesCompactConnection} from "./HelarcResponsesCompactConnection.js";

interface ResponsesPurposeTransport {
  readonly protocol:"openai.responses";
  readonly connection:RetainedConnection;
  readonly session:ResponsesSessionBinding;
}
type Request=HelarcNativeRunTask|HelarcNativeStructuredRequest;
type BoundRequest=Request&{readonly responsesTransport:ResponsesPurposeTransport};
type Authorize=(operation:"create"|"retrieve"|"resume"|"cancel")=>Promise<void>;

/** Host custody and bounded driving of the original Responses session, not task interpretation. */
export class HelarcResponsesPurposeObserver {
  private readonly carriers=new Map<string,HelarcResponsesTransport>();
  private readonly retention:ProviderConnectionRetention;
  constructor(private readonly store:HelarcExecutionStore,private readonly providers:ProviderConfigurationService){
    this.retention=new ProviderConnectionRetention(providers,{read:async pin=>{
      const accepted=await store.sharedAcceptance.query(pin.acceptanceId);
      return accepted?.outcome==="accepted"?"accepted":"unknown";
    }});
  }
  async prepare<T extends Request>(activity:ProtocolModelActivity,request:T,configuration:ProviderConfiguration,
    arrangement?:Parameters<typeof helarcResponsesSessionBinding>[0]["arrangement"]):Promise<T&{readonly responsesTransport:ResponsesPurposeTransport}>{
    const c=activity.composition.composition.configuration,id=activity.scope.activityId;
    if(configuration.protocol!=="openai.responses"||c.configuration.id!==configuration.id||c.configuration.revision!==configuration.revision||
      c.connectionBinding.id!==configuration.connectionBindingId||c.model!==configuration.model)throw new TypeError("responses_purpose_configuration_changed");
    const body=JSON.parse(request.wire.body),n=configuration.native;
    if(body.context_management!==undefined){
      if(n.protocol!=="openai.responses"||!n.allowInRequestCompaction||!("selectedInputId" in request)||!request.selectedInputId)
        throw new TypeError("responses_in_request_admission_missing");
      const selection=await this.store.contextSelections.command({kind:"binding",inputId:request.selectedInputId,checkCurrentControl:true}) as
        import("@agent-anything/context/selection").ContextSelectionSnapshot|null;
      const selected=selection?.input.exactInput as HelarcRetainedNativeInput|undefined,agreement=selected?.compactionAgreement;
      if(!selected||!agreement?.useEvidence||selection?.input.activityId!==id||selection.scope.runId!==activity.scope.runId||
        selected.wire.digest!==request.wire.digest||digest(agreement.useEvidence.use)!==digest({enabled:n.allowInRequestCompaction,
          target:providerCompactionTarget(configuration),policy:configuration.inRequestCompaction??null,transport:n.transport,continuity:n.continuity,background:n.background}))
        throw new TypeError("responses_in_request_original_policy_changed");
      validateHelarcResponsesCompactionAgreement(agreement,selected.manifest,body);
    }
    const pin={id:`${id}:connection`,bindingId:configuration.connectionBindingId,acceptanceId:`${id}:prepare`,
      owner:activity.composition.composition.adapter.implementation.id,purpose:activity.scope.purpose.id,state:"provisional" as const};
    await this.store.protocolJournal.command({kind:"reserve_admission",activity});
    await this.providers.pin(pin);
    const connection:RetainedConnection={kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId};
    const scopeId=this.scope(activity).id,carrier=this.carrier(scopeId,connection);
    const session=helarcResponsesSessionBinding({configuration,id:`${id}:responses`,scopeId,
      connectionIncarnation:configuration.native.protocol==="openai.responses"&&configuration.native.transport==="websocket"?carrier.connectionIncarnation:null,
      prepared:{body,encoded:request.wire.body,digest:request.wire.digest},createdAt:Date.now(),arrangement,
      maximumBytes:32*1024*1024,maximumFrameBytes:8*1024*1024,maximumEvents:20000});
    return {...request,responsesTransport:{protocol:"openai.responses",connection,session}};
  }
  async observe(state:ProtocolExecutionState,request:Request,signal:AbortSignal,
    authorize:(operation:"create"|"retrieve"|"resume"|"cancel")=>Promise<void>,preview?:import("@agent-anything/helarc/run").HelarcNativePreviewObserver):Promise<ProtocolJournalRecord>{
    const id=state.activity.scope.activityId;
    try{return await this.observeOriginal(state,request,signal,authorize,preview);}
    catch(cause){if(cause instanceof ProtocolObservationUnavailable||cause instanceof ActivityCheckpointError)throw cause;throw new ActivityCheckpointError(`${id}:responses-observation`,{cause});}
  }
  private async observeOriginal(state:ProtocolExecutionState,request:Request,signal:AbortSignal,
    authorize:Authorize,preview?:import("@agent-anything/helarc/run").HelarcNativePreviewObserver):Promise<ProtocolJournalRecord>{
    const work=protocolWork(state.activity.scope.runId,state.activity.scope.activityId);
    const {custody,session,carrier,observation,connection}=await measureIdentifiedWork(this.store,{work,phase:"restore_and_validate"},()=>this.openOriginal(state,request,preview));
    const saved=await this.store.protocolJournal.command({kind:"record",activityId:state.activity.scope.activityId,ref:observation}) as ProtocolJournalRecord|null;
    if(saved){await this.usage(state,saved,session);return saved;}
    await this.drive(state,session,carrier,connection,signal,authorize,false);
    const refusal=await custody.retainCapacityRefusal(session,observation);
    if(refusal){await this.usage(state,refusal,session);return refusal;}
    const head=session.snapshot();
    if(head.disposition==="unresolved"){
      const limitation=await this.retainedLimitation(state,request,false);
      if(!limitation||limitation.basis.revision!==head.revision||limitation.reason!==head.reason)
        throw new TypeError("responses_observation_disposition_unconfirmed");
      throw new ProtocolObservationUnavailable(limitation);
    }
    if(head.disposition!=="terminal")throw new TypeError("responses_observation_not_settled");
    return measureIdentifiedWork(this.store,{work,phase:"commit_observation"},async()=>{
      const record=await custody.retainTerminal(session,observation);
      await this.usage(state,record,session);return record;
    });
  }
  /** The frozen native head is the authority; inspecting it cannot create or drive a session. */
  async retainedLimitation(state:ProtocolExecutionState,request:Request,requireNoFollowUp=true){
    const id=state.activity.scope.activityId,t=(request as BoundRequest).responsesTransport;
    if(!t)return null;
    const scope=this.scope(state.activity);
    if(t.session.scopeId!==scope.id||t.session.id!==id+":responses"||t.session.prepared.encoded!==request.wire.body||
       t.connection.bindingId!==state.activity.composition.composition.configuration.connectionBinding.id)
      throw new TypeError("responses_limitation_original_binding_changed");
    const custody=new HelarcResponsesSessionStore({id:t.session.id,journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,
      scope,fence:state.fence,original:[state.input],maximumSegmentBytes:32*1024*1024});
    const e=await custody.observe();
    if(!e)return null;
    const head=JSON.parse((await readProtocolContent(this.store.protocolJournal,e.content,id,65536)).toString()) as ReturnType<ResponsesSession["snapshot"]>;
    if(e.activityId!==id||e.owner!==scope.owner||!e.references.some(r=>digest(r)===digest(state.input))||
       head.bindingDigest!==digest(t.session)||head.revision!==e.revision||e.metadata.disposition!==head.disposition||e.metadata.reason!==head.reason)
      throw new TypeError("responses_observation_disposition_unconfirmed");
    if(head.disposition!=="unresolved"||!head.reason||requireNoFollowUp&&(head.pending||head.followUp||head.head.responseId))return null;
    return {kind:"protocol_observation_unavailable" as const,activityId:id,reason:head.reason,
      basis:{scopeId:e.scopeId,kind:e.kind,key:e.key,revision:e.revision,digest:e.content.digest}};
  }
  /** Called after shared cancellation and interruption of the previous driver. No network wait here. */
  async interrupt(state:ProtocolExecutionState,request:Request,identity:string):Promise<ProtocolReconciliationHandoff|null>{
    if(!state.cancelled)throw new TypeError("responses_purpose_cancellation_not_accepted");
    const {custody,session}=await this.openOriginal(state,request);
    if(session.snapshot().head.terminal||session.snapshot().creation==="rejected")return null;
    await session.cancel(identity);
    const expiresAt=Math.min(session.binding.deadlineAt,session.snapshot().cancelEpisode?.deadlineAt??Infinity);
    if(expiresAt<=Date.now()){
      await session.step({now:Date.now,jitter:()=>0,target:session.binding.target,headers:{},baseUrl:"http://unused.invalid",
        signal:new AbortController().signal,authorize:async()=>{throw new TypeError("responses_expired_dispatch_forbidden");}});
      return null;
    }
    // Accepting this handoff advances the fence. The receiver reopens with that new fence.
    return handoffHelarcResponses(custody.custody,session.snapshot(),expiresAt);
  }
  /** Host-owned, restartable follow-up; never interprets a task result or dispatches returned calls. */
  async reconcile(handoff:ProtocolReconciliationHandoff,signal:AbortSignal,authorize:Authorize,maximumSteps=Number.POSITIVE_INFINITY){
    const id=handoff.activityId;
    let state=await this.store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
    const accepted=await this.store.protocolJournal.command({kind:"reconciliation",activityId:id,id:handoff.id}) as ProtocolReconciliationHandoff|null;
    if(!state?.cancelled||!accepted||accepted.receiver!==state.activity.composition.composition.adapter.implementation.id||
      digest({...accepted,disposition:null})!==digest({...handoff,disposition:null}))throw new TypeError("responses_original_handoff_changed");
    if(accepted.disposition)return accepted.disposition;
    if(state.fence.generation!==this.store.generation){
      const receipt=await this.store.sharedAcceptance.accept({id:`${id}:follow-up-claim:${this.store.generation}:${state.fence.epoch}`,
        scope:state.activity.scope.runId,actor:accepted.receiver,parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`responses_follow_up_claim_rejected:${receipt.rejection?.code}`);
      state=await this.store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState;
    }
    const request=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,id,32*1024*1024)).toString()) as Request;
    const {custody,session,carrier,connection}=await this.openOriginal(state,request);
    await session.followUp(accepted.id,accepted.expiresAt);
    await this.drive(state,session,carrier,connection,signal,authorize,true,maximumSteps);
    if(session.snapshot().disposition==="active")return null;
    if(session.snapshot().head.terminal&&session.response()){
      const record=await custody.retainTerminal(session,{id:`${accepted.id}:terminal-response`,revision:"1"});
      await this.usage(state,record,session);
    }
    await closeHelarcResponsesHandoff(custody.custody,session.snapshot());
    return (await this.store.protocolJournal.command({kind:"reconciliation",activityId:id,id:handoff.id}) as ProtocolReconciliationHandoff).disposition!;
  }
  private async openOriginal(state:ProtocolExecutionState,request:Request,preview?:import("@agent-anything/helarc/run").HelarcNativePreviewObserver){
    const id=state.activity.scope.activityId,bound=request as BoundRequest,t=bound.responsesTransport;
    const original=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,id,32*1024*1024)).toString());
    if(!t||t.protocol!=="openai.responses"||digest(original)!==digest(request)||t.session.id!==`${id}:responses`||
      t.session.scopeId!==this.scope(state.activity).id||t.session.prepared.encoded!==request.wire.body||t.session.prepared.digest!==request.wire.digest)
      throw new TypeError("responses_purpose_original_transport_changed");
    const c=state.activity.composition.composition.configuration;
    if(t.connection.bindingId!==c.connectionBinding.id||t.connection.pinId!==`${id}:connection`||t.connection.acceptanceId!==`${id}:prepare`||
      t.session.target!==digest({configuration:c.configuration.id,revision:c.configuration.revision,connection:c.connectionBinding.id,protocol:c.protocol.id,model:c.model}))
      throw new TypeError("responses_purpose_original_configuration_changed");
    const observation=request.format==="helarc.native-prepared-task.v1"?request.binding.record:request.observation;
    const operationId=request.format==="helarc.native-prepared-task.v1"?request.binding.operationId:request.operationId;
    if(operationId!==`${t.session.id}:operation:1`)throw new TypeError("responses_purpose_original_operation_changed");
    const scope=this.scope(state.activity);
    const accepted=await this.store.sharedAcceptance.accept({id:`${id}:responses-scope`,scope:state.activity.scope.runId,actor:"execution-coordinator",
      parts:[{owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId:id,scope}}]});
    if(accepted.outcome!=="accepted")throw new TypeError(`responses_purpose_scope_rejected:${accepted.rejection?.code}`);
    const custody=new HelarcResponsesSessionStore({id:t.session.id,journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,
      scope,fence:state.fence,original:[state.input],maximumSegmentBytes:32*1024*1024,
      observedSegment:preview&&request.format==="helarc.native-prepared-task.v1"?(segment,head)=>{
        const frames=segment.kind==="http"&&"frames" in segment.part?segment.part.frames.map(f=>f.data):
          segment.kind==="body"||segment.kind==="websocket"?[segment.data]:[];
        for(const [i,data]of frames.entries()){
          try{const value=JSON.parse(data);if(value&&typeof value==="object")preview({binding:request.binding,sequence:head.segments*100000+i,value});}
          catch{/* Non-JSON frames remain original transport evidence. */}
        }
      }:undefined});
    const session=await ResponsesSession.open(t.session,custody),carrier=this.carrier(scope.id,t.connection);
    const dispatched=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:intent`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(dispatched){
      const source=JSON.parse((await readProtocolContent(this.store.protocolJournal,dispatched.content,id,32*1024*1024)).toString());
      if(source.kind!=="dispatch"||source.operation!=="create"||source.operationId!==operationId)throw new TypeError("responses_usage_dispatch_changed");
      await registerHelarcNativeUsage(this.store,state,dispatched,{operationId,endpoint:source.url,
        submittedAt:typeof source.startedAt==="number"?new Date(source.startedAt).toISOString():null});
    }
    return {custody,session,carrier,observation,connection:t.connection};
  }
  private async drive(state:ProtocolExecutionState,session:ResponsesSession,carrier:HelarcResponsesTransport,connection:RetainedConnection,signal:AbortSignal,
    authorize:Authorize,reconciling:boolean,maximumSteps=Number.POSITIVE_INFINITY){
    const id=state.activity.scope.activityId;
    let steps=0;
    while(session.snapshot().disposition==="active"){
      signal.throwIfAborted();
      if(steps++>=maximumSteps)return;
      if(Date.now()>=Math.min(session.binding.deadlineAt,session.snapshot().followUpDeadlineAt??Infinity)){
        await session.step({now:Date.now,jitter:()=>0,target:session.binding.target,headers:{},baseUrl:"http://unused.invalid",signal,
          authorize:async()=>{throw new TypeError("responses_expired_dispatch_forbidden");}});
        continue;
      }
      const due=session.snapshot().dueAt;
      if(Number.isFinite(maximumSteps)&&due&&due>Date.now())return;
      if(due&&due>Date.now())await wait(Math.min(due-Date.now(),Math.max(1,session.binding.deadlineAt-Date.now())),undefined,{signal});
      await this.retention.recover(connection);
      const work=protocolWork(state.activity.scope.runId,id);
      await measureIdentifiedWork(this.store,{work,phase:"transport_step"},()=>carrier.step(session,signal,async operation=>{
        const current=await this.store.protocolJournal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
        if(!current||digest(current.fence)!==digest(state.fence)||current.cancelled&&!reconciling||reconciling&&(!current.cancelled||operation==="create"))
          throw new TypeError("responses_purpose_current_control_changed");
        await authorize(operation);
      },connection,measuredFetch(this.store,work,session.binding.id)));
    }
  }
  private scope(activity:ProtocolModelActivity):ProtocolEvidenceScope {
    const s=activity.scope;
    return {id:`responses-purpose:${digest({runId:s.runId,recipientId:s.recipientId,purpose:s.purpose,composition:s.compositionDigest})}`,
      runId:s.runId,recipientId:s.recipientId,purpose:s.purpose,compositionDigest:s.compositionDigest,owner:activity.composition.composition.adapter.implementation.id};
  }
  connectionIncarnation(activity:ProtocolModelActivity,connection:RetainedConnection):string {
    if(activity.composition.composition.configuration.connectionBinding.id!==connection.bindingId)
      throw new TypeError("responses_continuity_connection_changed");
    return this.carrier(this.scope(activity).id,connection).connectionIncarnation;
  }
  private async usage(state:ProtocolExecutionState,record:ProtocolJournalRecord,session:ResponsesSession){
    if(await hasHelarcNativeUsage(this.store,record))return;
    const id=state.activity.scope.activityId,operationId=`${session.binding.id}:operation:1`;
    const dispatch=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:intent`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(!dispatch||dispatch.kind!=="dispatch_intent")throw new TypeError("responses_usage_dispatch_missing");
    const original=JSON.parse((await readProtocolContent(this.store.protocolJournal,dispatch.content,id,32*1024*1024)).toString());
    if(original.kind!=="dispatch"||original.operationId!==operationId||original.operation!=="create")throw new TypeError("responses_usage_dispatch_changed");
    const response=JSON.parse((await readProtocolContent(this.store.protocolJournal,record.content,id,32*1024*1024)).toString());
    const head=session.snapshot();
    await recordHelarcNativeUsage(this.store,state,record,{operationId,response,endpoint:original.url,
      submittedAt:typeof original.startedAt==="number"?new Date(original.startedAt).toISOString():null,
      receivedAt:new Date(head.lastAt).toISOString(),channel:head.polls>0?"get":session.binding.profile.stream?"stream":"create"});
  }
  async retire(state:ProtocolExecutionState,observation?:ProtocolObservationReceipt):Promise<boolean>{
    if(!state.accepted&&!state.cancelled&&!observation)return false;
    const id=state.activity.scope.activityId;
    const request=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,id,32*1024*1024)).toString()) as BoundRequest|HelarcResponsesCompactRequest|HelarcResponsesCountRequest;
    if(observation&&(request.format!=="helarc.native-prepared-task.v1"||observation.limitation.reason!=="original_response_unavailable"))return false;
    if(request.format==="helarc.responses-compact-request.v1")return this.retireCompact(state,request);
    if(request.format==="helarc.responses-count-request.v1")return this.retireCount(state,request);
    const t=request.responsesTransport;
    if(!t||t.protocol!=="openai.responses"||t.session.id!==`${id}:responses`||t.session.scopeId!==this.scope(state.activity).id||
      t.connection.bindingId!==state.activity.composition.composition.configuration.connectionBinding.id||t.session.prepared.encoded!==request.wire.body)
      throw new TypeError("responses_retirement_original_changed");
    const custody=new HelarcResponsesSessionStore({id:t.session.id,journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,
      scope:this.scope(state.activity),fence:state.fence,original:[state.input],maximumSegmentBytes:32*1024*1024});
    const head=await custody.load(),evidence=await custody.observe();
    if(!head){
      if(!state.cancelled)return false;
      return releaseHelarcNativeRetention(this.store,state,{operationId:`${id}:local-discharge`,dependencies:[],
        value:{kind:"responses_dependency_discharge",originalInput:state.input,disposition:"not_started",history:"retained"}});
    }
    if(!evidence||head.bindingDigest!==digest(t.session)||head.revision!==evidence.revision)
      throw new TypeError("responses_retirement_head_changed");
    if(observation){
      const {limitation}=observation;
      if(limitation.activityId!==id||head.reason!==limitation.reason||digest(limitation.basis)!==digest({
        scopeId:evidence.scopeId,kind:evidence.kind,key:evidence.key,revision:evidence.revision,digest:evidence.content.digest})||
        t.connection.pinId!==id+":connection"||t.connection.acceptanceId!==id+":prepare")
        throw new TypeError("responses_connection_release_basis_changed");
      if(head.disposition!=="unresolved"||head.creation!=="possibly_sent"||head.head.responseId!==null||head.pending||head.followUp)return false;
      const original=await claimHelarcNativeRetirement(this.store,state);
      const release={bindingId:t.connection.bindingId,observation},proposal={scope:original.activity.scope.runId,
        actor:original.activity.composition.composition.adapter.implementation.id,parts:[{owner:"protocol_execution" as const,
          kind:"release_connection" as const,proposal:{fence:original.fence,release}}]};
      const receipt=await this.store.sharedAcceptance.accept({id:`native-connection-release:${digest(proposal)}`,...proposal});
      if(receipt.outcome!=="accepted")throw new TypeError(`responses_connection_release_rejected:${receipt.rejection?.code}`);
      return true;
    }
    if(head.disposition==="active"||head.pending)return false;
    return releaseHelarcNativeRetention(this.store,state,{operationId:`${id}:local-discharge`,dependencies:evidence.dependencies.map(d=>d.ref),
      value:{kind:"responses_dependency_discharge",originalInput:state.input,head:evidence.content,revision:head.revision,
        disposition:head.disposition,reason:head.reason,remoteStatus:head.head.status,history:"retained"}});
  }
  async deliveryResolution(state:ProtocolExecutionState):Promise<HelarcNativeDeliveryResolution|null>{
    const value=await readHelarcNativeDischarge(this.store,state);if(!value)return null;
    if(value.kind!=="responses_dependency_discharge"||state.activity.composition.composition.protocol.id!=="openai.responses")
      throw new TypeError("responses_delivery_resolution_original_changed");
    return {basis:state.retentionBasis!,resolved:["not_started","unsent","terminal"].includes(String(value.disposition))};
  }
  async settleInputUse(state:ProtocolExecutionState):Promise<HelarcNativeDeliveryResolution|null>{
    const resolution=await this.deliveryResolution(state);
    if(resolution)await settleHelarcNativeInputUse(this.store,state,resolution);
    return resolution;
  }
  private carrier(scopeId:string,connection:RetainedConnection){
    const key=digest({scopeId,bindingId:connection.bindingId});let carrier=this.carriers.get(key);
    if(!carrier){carrier=new HelarcResponsesTransport(this.providers,connection);this.carriers.set(key,carrier);}return carrier;
  }
  private async retireCount(state:ProtocolExecutionState,request:HelarcResponsesCountRequest):Promise<boolean>{
    restoreResponsesInputTokenCount(request.count);
    if(digest(state.activity)!==digest(request.activity))throw new TypeError("count_retirement_original_changed");
    const id=state.activity.scope.activityId,operationId=`${id}:count`;
    const dispatch=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:dispatch`,revision:"1"}}) as ProtocolJournalRecord|null;
    const outcome=await this.store.protocolJournal.command({kind:"record",activityId:id,ref:{id:`${operationId}:outcome`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(!outcome&&!state.cancelled)return false;
    return releaseHelarcNativeRetention(this.store,state,{operationId:`${id}:local-discharge`,dependencies:[...dispatch?[dispatch.ref]:[],...outcome?[outcome.ref]:[]],
      value:{kind:"responses_count_dependency_discharge",originalInput:state.input,disposition:outcome?"outcome_retained":dispatch?"remote_outcome_unknown":"not_dispatched",
        outcome:outcome?.content??null,reconciliation:"Counting has no response continuation or task effects",history:"retained"}});
  }
  private async retireCompact(state:ProtocolExecutionState,request:HelarcResponsesCompactRequest):Promise<boolean>{
    new HelarcResponsesCompactConnection(this.store,this.providers).checkOriginal(request);
    if(digest(state.activity)!==digest(request.activity))throw new TypeError("compact_retirement_original_changed");
    const id=state.activity.scope.activityId;
    const custody=new HelarcResponsesCompactStore({id:request.binding.id,journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,
      scope:helarcResponsesCompactEvidenceScope(state.activity),fence:state.fence,original:[state.input],maximumBytes:Math.max(65536,request.binding.maximumBytes*2+65536)});
    const head=await custody.load(),evidence=await custody.observe();
    if(!head){
      if(!state.cancelled)return false;
      return releaseHelarcNativeRetention(this.store,state,{operationId:`${id}:local-discharge`,dependencies:[],
        value:{kind:"responses_compact_dependency_discharge",originalInput:state.input,disposition:"not_started",history:"retained"}});
    }
    if(!evidence||head.bindingDigest!==digest(request.binding)||head.revision!==evidence.revision)
      throw new TypeError("compact_retirement_head_changed");
    if(head.status==="dispatched"||head.status==="prepared"&&!state.cancelled)return false;
    return releaseHelarcNativeRetention(this.store,state,{operationId:`${id}:local-discharge`,dependencies:evidence.dependencies.map(d=>d.ref),
      value:{kind:"responses_compact_dependency_discharge",originalInput:state.input,head:evidence.content,revision:head.revision,
        disposition:head.status==="unknown"?"remote_outcome_unknown":head.status,reason:head.failure,
        reconciliation:"No native retrieval or cancellation by compact resource identity",history:"retained"}});
  }
  async close(){for(const carrier of this.carriers.values())await carrier.close();this.carriers.clear();}
}
