import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {requireModelPurpose,snapshotModelPurposeEvidence,type ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import {assertProtocolModelActivityOriginal,readProtocolContent,retainProtocolContent,
  type ProtocolModelActivity,type ProtocolExecutionState,type ProtocolExecutionJournal,type ProtocolPurposeAcceptance,
  type ProtocolEvidenceScope,type ProtocolContentWork,type ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import type {SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import {OPENAI_RESPONSES_ADAPTER,ResponsesCompactSession,restoreResponsesCompactedWindow,
  type ResponsesCompactBinding,type ResponsesCompactState} from "@agent-anything/provider-integrations/native";
import {assertHelarcResponsesCompactSource,type HelarcResponsesCompactSource} from "./HelarcResponsesCompaction.js";
import {HelarcResponsesCompactStore,helarcResponsesCompactEvidenceScope} from "./HelarcResponsesCompactStore.js";
import type {HelarcResponsesCompactOutcome} from "./HelarcResponsesCompactWork.js";

export const HELARC_RESPONSES_COMPACT_INTERPRETER={id:"helarc.responses-compact-result",revision:"1"} as const;
export interface HelarcResponsesCompactRequest {
  readonly format:"helarc.responses-compact-request.v1";
  readonly activity:ProtocolModelActivity;
  readonly source:HelarcResponsesCompactSource;
  readonly binding:ResponsesCompactBinding;
}
export interface HelarcResponsesCompactResult {
  readonly format:"helarc.responses-compact-result.v1";
  readonly requestDigest:string;
  readonly sourceDigest:string;
  readonly outcome:HelarcResponsesCompactOutcome;
}
interface CompactDisposition {
  readonly format:"helarc.responses-compact-disposition.v1";
  readonly requestDigest:string;
  readonly sourceDigest:string;
  readonly evidence:ModelPurposeEvidence;
  readonly kind:"rejected"|"unresolved";
  readonly state:ResponsesCompactState;
}
export type HelarcResponsesCompactExecutionOutcome =
  | {readonly kind:"produced";readonly result:HelarcResponsesCompactResult}
  | {readonly kind:"unresolved"|"rejected"|"cancelled";readonly state:ResponsesCompactState};

export function validateHelarcResponsesCompactRequest(request:HelarcResponsesCompactRequest):void {
  const {activity,source,binding}=request,c=activity.composition.composition;
  assertProtocolModelActivityOriginal(activity,activity);
  assertHelarcResponsesCompactSource(source);
  const participant=requireModelPurpose(activity.composition,activity.scope.purpose);
  if(request.format!=="helarc.responses-compact-request.v1"||c.protocol.id!=="openai.responses"||
    digest(c.adapter.implementation)!==digest(OPENAI_RESPONSES_ADAPTER)||
    digest(participant.interpreter.implementation)!==digest(HELARC_RESPONSES_COMPACT_INTERPRETER)||
    digest(c.task.purpose)===digest(activity.scope.purpose)||
    activity.scope.runId!==source.manifest.scope.runId||activity.scope.compositionDigest!==source.manifest.scope.compositionDigest||
    digest(activity.scope.purpose)!==digest(source.methodRequest.purpose)||binding.id!==`${activity.scope.activityId}:compact`||
    binding.sourceDigest!==source.sourceDigest||binding.disclosure!==source.dependencies.authority||
    digest(binding.prepared)!==digest(source.methodRequest)||c.configuration.model!==source.manifest.target.model||
    source.manifest.target.configuration!==`${c.configuration.configuration.id}:${c.configuration.configuration.revision}`||
    source.manifest.target.connection!==c.configuration.connectionBinding.id)
    throw new TypeError("responses_compact_original_request_invalid");
}
export interface HelarcResponsesCompactExecutionPorts {
  readonly journal:ProtocolExecutionJournal;
  readonly acceptance:SharedAcceptancePort;
  readonly generation:number;
  readonly contentWork?:(work:ProtocolContentWork)=>void;
  /** Local restoration checks identity/authority but never resolves a credential. */
  readonly authorize:(request:HelarcResponsesCompactRequest,action:"local"|"dispatch",signal:AbortSignal)=>Promise<void>;
  readonly dispatch:(request:HelarcResponsesCompactRequest,session:ResponsesCompactSession,signal:AbortSignal,
    authorize:()=>Promise<boolean>)=>Promise<unknown>;
}

/** Native generation result only. Preservation findings, publication and adoption have other owners. */
export class HelarcResponsesCompactExecution {
  constructor(private readonly ports:HelarcResponsesCompactExecutionPorts){}
  async execute(request:HelarcResponsesCompactRequest,signal:AbortSignal):Promise<HelarcResponsesCompactExecutionOutcome>{
    validateHelarcResponsesCompactRequest(request);
    const p=this.ports,id=request.activity.scope.activityId,scope=this.scope(request);
    await p.authorize(request,"local",signal);
    let state=await p.journal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
    if(!state){
      signal.throwIfAborted();
      const input=await retainProtocolContent(p.journal,`${id}:prepared:${digest(request)}`,id,Buffer.from(JSON.stringify(request)),p.contentWork);
      const receipt=await p.acceptance.accept({id:`${id}:prepare`,scope:request.activity.scope.runId,actor:"execution-coordinator",parts:[
        {owner:"protocol_execution",kind:"prepare",proposal:{activity:request.activity,input}},
        {owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId:id,scope}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`responses_compact_prepare_rejected:${receipt.rejection?.code}`);
      state=await this.state(id);
    }
    const original=await this.original(state);
    assertProtocolModelActivityOriginal(state.activity,request.activity);
    if(digest(original)!==digest(request))throw new TypeError("responses_compact_original_request_changed");
    const accepted=await p.journal.command({kind:"acceptance",activityId:id}) as ProtocolPurposeAcceptance|null;
    if(accepted)return this.accepted(original,accepted);
    signal.throwIfAborted();
    state=await this.claim(state);
    const custody=new HelarcResponsesCompactStore({id:original.binding.id,journal:p.journal,acceptance:p.acceptance,
      scope,fence:state.fence,original:[state.input],maximumBytes:Math.max(65536,original.binding.maximumBytes*2+65536),observe:p.contentWork});
    const session=await ResponsesCompactSession.open(original.binding,custody);
    if(state.cancelled){
      if(!session.snapshot().cancelled)await session.cancel(`original-control:${state.fence.controlRevision}`);
      return {kind:"cancelled",state:session.snapshot()};
    }
    if(session.snapshot().status==="dispatched")await session.reconcileInterrupted();
    if(session.snapshot().status==="prepared")await p.dispatch(original,session,signal,async()=>{
      signal.throwIfAborted();
      const current=await this.state(id);
      if(current.cancelled||digest(current.fence)!==digest(state.fence))throw new TypeError("responses_compact_current_control_changed");
      await p.authorize(original,"dispatch",signal);
      return true;
    });
    const snapshot=session.snapshot();
    if(snapshot.status==="rejected"||snapshot.status==="unknown")return this.disposition(original,state,snapshot);
    if(snapshot.status!=="observed")return {kind:"unresolved",state:snapshot};
    const observation=await custody.retainTerminal(session,{id:`${id}:response`,revision:"1"});
    const current=await this.state(id);
    if(current.cancelled)return {kind:"cancelled",state:snapshot};
    if(digest(current.fence)!==digest(state.fence))throw new TypeError("responses_compact_current_control_changed");
    const evidence=snapshotModelPurposeEvidence({scope:state.activity.scope,interpreter:HELARC_RESPONSES_COMPACT_INTERPRETER,
      acceptance:{id:`${id}:accepted`,revision:"1"},sources:[observation.source!]});
    const result:HelarcResponsesCompactResult={format:"helarc.responses-compact-result.v1",requestDigest:digest(original),
      sourceDigest:original.source.sourceDigest,outcome:{candidate:session.candidate()!,evidence}};
    const content=await retainProtocolContent(p.journal,`${id}:result:${digest(result)}`,id,Buffer.from(JSON.stringify(result)),p.contentWork);
    const receipt=await p.acceptance.accept({id:`${id}:purpose:${state.fence.generation}:${state.fence.epoch}`,scope:state.activity.scope.runId,
      actor:evidence.interpreter.id,parts:[{owner:"protocol_execution",kind:"purpose",proposal:{fence:state.fence,
        acceptance:{evidence,result:content,effects:[],deliveries:[]}}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_compact_purpose_rejected:${receipt.rejection?.code}`);
    return {kind:"produced",result};
  }
  async recover(activityId:string,signal:AbortSignal):Promise<HelarcResponsesCompactExecutionOutcome|null>{
    const state=await this.ports.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    return state?this.execute(await this.original(state),signal):null;
  }
  async interrupt(activityId:string,signal:AbortSignal):Promise<ResponsesCompactState|null>{
    let state=await this.ports.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!state)return null;
    const request=await this.original(state),p=this.ports;
    await p.authorize(request,"local",signal);
    signal.throwIfAborted();
    if(state.accepted||state.retentionReleased){
      // A closed native obligation is evidence for the outer interruption,
      // never a reason to mutate its sealed session or claim a fresh fence.
      const accepted=await p.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
      if(digest(state.accepted)!==digest(accepted?.evidence.acceptance??null))throw new TypeError("compact_interruption_acceptance_missing");
      const outcome=accepted?await this.accepted(request,accepted):null,input=state.input;
      let discharge:{disposition:string;head?:unknown;revision?:number}|null=null;
      if(state.retentionReleased){
        const record=state.retentionBasis&&await p.journal.command({kind:"record",activityId,ref:state.retentionBasis}) as ProtocolJournalRecord|null;
        if(!record||record.kind!=="native_checkpoint"||record.activityId!==activityId)throw new TypeError("compact_retirement_basis_missing");
        const value=JSON.parse((await readProtocolContent(p.journal,record.content,activityId,65536)).toString());
        if(value.kind!=="responses_compact_dependency_discharge"||digest(value.originalInput)!==digest(input))throw new TypeError("compact_retirement_basis_changed");
        discharge=value;
      }
      const custody=new HelarcResponsesCompactStore({id:request.binding.id,journal:p.journal,acceptance:p.acceptance,
        scope:this.scope(request),fence:state.fence,original:[state.input],maximumBytes:Math.max(65536,request.binding.maximumBytes*2+65536)});
      const e=await custody.observe();
      if(!e&&!accepted&&state.cancelled&&discharge?.disposition==="not_started")return null;
      if(!e||e.activityId!==activityId||e.owner!==this.scope(request).owner||!e.references.some(r=>digest(r)===digest(input)))
        throw new TypeError("compact_interruption_disposition_missing");
      const head=JSON.parse((await readProtocolContent(p.journal,e.content,activityId,65536)).toString()) as ResponsesCompactState;
      if(head.revision!==e.revision||head.bindingDigest!==digest(request.binding)||head.status==="dispatched"||
        outcome?.kind==="produced"&&head.status!=="observed"||
        discharge&&(discharge.revision!==head.revision||!discharge.head||digest(discharge.head)!==digest(e.content)))
        throw new TypeError("compact_interruption_disposition_changed");
      return head;
    }
    state=await this.claim(state);
    if(!state.cancelled){
      const receipt=await p.acceptance.accept({id:`${activityId}:cancel:${state.fence.controlRevision}`,scope:state.activity.scope.runId,
        actor:"execution-coordinator",parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`responses_compact_cancel_rejected:${receipt.rejection?.code}`);
      state=await this.state(activityId);
    }
    const custody=new HelarcResponsesCompactStore({id:request.binding.id,journal:p.journal,acceptance:p.acceptance,scope:this.scope(request),
      fence:state.fence,original:[state.input],maximumBytes:Math.max(65536,request.binding.maximumBytes*2+65536),observe:p.contentWork});
    const session=await ResponsesCompactSession.open(request.binding,custody);
    if(!session.snapshot().cancelled)await session.cancel(`original-control:${state.fence.controlRevision}`);
    if(session.snapshot().status==="dispatched")await session.reconcileInterrupted();
    return session.snapshot();
  }
  private async disposition(request:HelarcResponsesCompactRequest,state:ProtocolExecutionState,snapshot:ResponsesCompactState):Promise<HelarcResponsesCompactExecutionOutcome>{
    const p=this.ports,id=state.activity.scope.activityId;
    const record=await p.journal.command({kind:"record",activityId:id,ref:{id:`${request.binding.id}:compact-segment:${snapshot.segments}`,revision:"1"}}) as import("@agent-anything/agent-runtime/model-access").ProtocolJournalRecord|null;
    if(!record?.source)throw new TypeError("responses_compact_disposition_evidence_missing");
    const current=await this.state(id);
    if(current.cancelled)return {kind:"cancelled",state:snapshot};
    if(digest(current.fence)!==digest(state.fence))throw new TypeError("responses_compact_current_control_changed");
    const evidence=snapshotModelPurposeEvidence({scope:state.activity.scope,interpreter:HELARC_RESPONSES_COMPACT_INTERPRETER,
      acceptance:{id:`${id}:accepted`,revision:"1"},sources:[record.source]});
    const result:CompactDisposition={format:"helarc.responses-compact-disposition.v1",requestDigest:digest(request),sourceDigest:request.source.sourceDigest,
      evidence,kind:snapshot.status==="rejected"?"rejected":"unresolved",state:snapshot};
    const content=await retainProtocolContent(p.journal,`${id}:result:${digest(result)}`,id,Buffer.from(JSON.stringify(result)),p.contentWork);
    const receipt=await p.acceptance.accept({id:`${id}:purpose:${state.fence.generation}:${state.fence.epoch}`,scope:state.activity.scope.runId,
      actor:evidence.interpreter.id,parts:[{owner:"protocol_execution",kind:"purpose",proposal:{fence:state.fence,acceptance:{evidence,result:content,effects:[],deliveries:[]}}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_compact_disposition_rejected:${receipt.rejection?.code}`);
    return {kind:result.kind,state:snapshot};
  }
  private async accepted(request:HelarcResponsesCompactRequest,acceptance:ProtocolPurposeAcceptance):Promise<HelarcResponsesCompactExecutionOutcome>{
    const id=request.activity.scope.activityId,result=JSON.parse((await readProtocolContent(this.ports.journal,acceptance.result,id,
      32*1024*1024,this.ports.contentWork)).toString()) as HelarcResponsesCompactResult|CompactDisposition;
    const evidence:ModelPurposeEvidence=acceptance.evidence;
    if(result.format==="helarc.responses-compact-disposition.v1"){
      if(result.requestDigest!==digest(request)||result.sourceDigest!==request.source.sourceDigest||digest(result.evidence)!==digest(evidence)||
        digest(evidence.interpreter)!==digest(HELARC_RESPONSES_COMPACT_INTERPRETER)||digest(evidence.scope)!==digest(request.activity.scope)||
        result.state.bindingDigest!==digest(request.binding)||!result.state.segments||acceptance.effects.length||acceptance.deliveries.length||
        !(result.kind==="rejected"&&result.state.status==="rejected"||result.kind==="unresolved"&&result.state.status==="unknown"))
        throw new TypeError("responses_compact_accepted_disposition_changed");
      return {kind:result.kind,state:result.state};
    }
    if(result.format!=="helarc.responses-compact-result.v1"||result.requestDigest!==digest(request)||result.sourceDigest!==request.source.sourceDigest||
      digest(result.outcome.evidence)!==digest(evidence)||digest(evidence.interpreter)!==digest(HELARC_RESPONSES_COMPACT_INTERPRETER)||
      digest(evidence.scope)!==digest(request.activity.scope)||digest(result.outcome.candidate)!==digest(restoreResponsesCompactedWindow(result.outcome.candidate.raw))||
      acceptance.effects.length||acceptance.deliveries.length)throw new TypeError("responses_compact_accepted_result_changed");
    return {kind:"produced",result};
  }
  private async original(state:ProtocolExecutionState):Promise<HelarcResponsesCompactRequest>{
    const request=JSON.parse((await readProtocolContent(this.ports.journal,state.input,state.activity.scope.activityId,
      32*1024*1024,this.ports.contentWork)).toString()) as HelarcResponsesCompactRequest;
    validateHelarcResponsesCompactRequest(request);assertProtocolModelActivityOriginal(state.activity,request.activity);return request;
  }
  private async state(activityId:string){
    const value=await this.ports.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!value)throw new TypeError("responses_compact_original_activity_missing");return value;
  }
  private async claim(state:ProtocolExecutionState){
    if(state.fence.generation===this.ports.generation&&state.fence.epoch>0)return state;
    const id=state.activity.scope.activityId,receipt=await this.ports.acceptance.accept({id:`${id}:claim:${this.ports.generation}:${state.fence.epoch}`,
      scope:state.activity.scope.runId,actor:state.activity.composition.composition.adapter.implementation.id,
      parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_compact_claim_rejected:${receipt.rejection?.code}`);
    return this.state(id);
  }
  private scope(request:HelarcResponsesCompactRequest):ProtocolEvidenceScope{
    return helarcResponsesCompactEvidenceScope(request.activity);
  }
}
