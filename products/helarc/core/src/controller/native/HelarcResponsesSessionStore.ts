import type { SharedAcceptancePort } from "@agent-anything/agent-runtime/activity";
import { retainProtocolContent,readProtocolContent,type ProtocolExecutionJournal,type ProtocolExecutionFence,type ProtocolEvidenceScope,
  type ProtocolEvidenceRevision,type ProtocolContentRef,type ProtocolContentWork,type ProtocolJournalRecord,type ProtocolExecutionState,
  type ProtocolReconciliationHandoff,type ProtocolJournalPart } from "@agent-anything/agent-runtime/model-access";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { modelInputValueDigest as digest } from "@agent-anything/model-interaction/input";
import {responsesInputCapacityRefused,type ResponsesSessionStore,type ResponsesSessionSegment,type ResponsesSessionState,type ResponsesSession } from "@agent-anything/provider-integrations/native";
import {retainHelarcNativeDispatchUsage,retainHelarcNativeUsageObservation} from "./HelarcNativeUsageObservation.js";

export interface HelarcResponsesSessionCustody {
  readonly id:string;readonly journal:ProtocolExecutionJournal;readonly acceptance:SharedAcceptancePort;
  readonly scope:ProtocolEvidenceScope;readonly fence:ProtocolExecutionFence;
  readonly original:readonly ProtocolContentRef[];
  readonly maximumSegmentBytes:number;
  readonly observe?:(work:ProtocolContentWork)=>void;
  readonly observedSegment?:(segment:ResponsesSessionSegment,state:ResponsesSessionState)=>void;
}

/** Atomic raw segments and bounded native head. Ordinary observation never expands segment bodies. */
export class HelarcResponsesSessionStore implements ResponsesSessionStore {
  constructor(readonly custody:HelarcResponsesSessionCustody){}
  private ref(sequence:number){return {id:`${this.custody.id}:segment:${sequence}`,revision:"1"};}
  private async content(id:string,value:unknown){
    const bytes=Buffer.from(JSON.stringify(snapshotModelJsonValue(value,"Responses custody")));
    if(bytes.length>this.custody.maximumSegmentBytes)throw new TypeError("responses_custody_segment_limit");
    return retainProtocolContent(this.custody.journal,`${id}:${digest(value)}`,this.custody.fence.activityId,bytes,this.custody.observe);
  }
  async observe():Promise<ProtocolEvidenceRevision|null>{
    const c=this.custody;return c.journal.command({kind:"evidence",activityId:c.fence.activityId,scopeId:c.scope.id,evidenceKind:"transport",key:c.id}) as Promise<ProtocolEvidenceRevision|null>;
  }
  async load():Promise<ResponsesSessionState|null>{
    const evidence=await this.observe();if(!evidence)return null;
    const bytes=await readProtocolContent(this.custody.journal,evidence.content,this.custody.fence.activityId,65536,this.custody.observe);
    const state=JSON.parse(bytes.toString()) as ResponsesSessionState;
    if(state.revision!==evidence.revision||state.bindingDigest!==evidence.metadata.bindingDigest)throw new TypeError("responses_custody_head_mismatch");
    // Accounting follows a committed transport fact. Recover its lost acknowledgement
    // before another native operation, without replaying that operation.
    if(state.segments&&(state.pending||evidence.metadata.lastSegmentKind==="dispatch"||evidence.metadata.lastSegmentKind==="outcome")){
      const record=await this.custody.journal.command({kind:"record",activityId:this.custody.fence.activityId,ref:this.ref(state.segments)}) as ProtocolJournalRecord|null;
      if(!record)throw new TypeError("responses_custody_segment_missing");
      const segment=JSON.parse((await readProtocolContent(this.custody.journal,record.content,record.activityId,this.custody.maximumSegmentBytes,this.custody.observe)).toString()) as ResponsesSessionSegment;
      await this.accountOperation(segment,state,record);
    }
    return state;
  }
  private async accountOperation(segment:ResponsesSessionSegment,state:ResponsesSessionState,outcome:ProtocolJournalRecord|null):Promise<void>{
    const c=this.custody;
    const operationId="operationId" in segment?segment.operationId:state.pending?.id;
    if(!operationId)return;
    if(segment.kind!=="dispatch"&&segment.kind!=="outcome"&&!state.pending)return;
    const record=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:{id:`${operationId}:intent`,revision:"1"}}) as ProtocolJournalRecord|null;
    // Local recovery dispositions can exist without a new network operation.
    if(!record){if(state.pending||segment.kind==="dispatch")throw new TypeError("responses_usage_dispatch_missing");return;}
    const dispatch=segment.kind==="dispatch"?segment:JSON.parse((await readProtocolContent(c.journal,record.content,c.fence.activityId,c.maximumSegmentBytes,c.observe)).toString()) as ResponsesSessionSegment;
    if(dispatch.kind!=="dispatch"||dispatch.operationId!==operationId||!["create","retrieve","resume","cancel"].includes(dispatch.operation))
      throw new TypeError("responses_usage_dispatch_changed");
    const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState;
    const operation=dispatch.operation==="create"?"generation":dispatch.operation==="cancel"?"cancel":"read";
    const submittedAt=typeof dispatch.startedAt==="number"?new Date(dispatch.startedAt).toISOString():null;
    await retainHelarcNativeDispatchUsage({journal:c.journal,acceptance:c.acceptance,state:execution,record,operation,endpoint:dispatch.url,submittedAt});
    if(segment.kind!=="outcome"||operation==="generation")return;
    if(!outcome||outcome.kind!=="observation"||outcome.operationId!==operationId)throw new TypeError("responses_operation_outcome_missing");
    const a=execution.activity,composition=a.composition.composition;
    await retainHelarcNativeUsageObservation({journal:c.journal,acceptance:c.acceptance,state:execution,record:outcome,
      submission:{id:operationId,scope:a.scope,protocol:composition.protocol,operation,endpoint:dispatch.url,
        account:composition.configuration.connectionBinding.id,submittedAt,model:composition.configuration.model,
        requestedTier:null,reportedTier:null,region:null,modality:null,reconciliationOwner:composition.adapter.implementation.id,
        beneficiaries:[...new Set([a.scope.runId,a.scope.recipientId,a.scope.purpose.id])],stage:a.scope.purpose.id},
      // A GET/cancel can carry generation usage. Only the generation observer may
      // attribute it; this operation has no separately reported token bill.
      response:{},receivedAt:new Date(state.lastAt).toISOString(),channel:"get",finality:"terminal",
      work:{startedAt:submittedAt,completedAt:new Date(state.lastAt).toISOString(),reportedTier:null}});
  }
  async retainTerminal(session:ResponsesSession,ref:ProtocolJournalRecord["ref"]):Promise<ProtocolJournalRecord>{
    const c=this.custody,state=session.snapshot(),response=session.response(),head=await this.observe();
    if(session.binding.id!==c.id||head?.revision!==state.revision||!response||!state.head.terminal||state.head.unsupported||state.pending)
      throw new TypeError("responses_terminal_not_reconciled");
    const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState;
    const operationId=`${c.id}:operation:1`,content=await this.content(`${c.id}:terminal`,response);
    const record:ProtocolJournalRecord={ref,activityId:c.fence.activityId,operationId,kind:"observation",content,
      source:{scope:execution.activity.scope,protocol:execution.activity.composition.composition.protocol,
        interpretation:execution.activity.composition.composition.adapter.implementation,operationId,record:ref,
        position:{format:"json-pointer",value:""},nativeIdentity:{kind:"response",id:state.head.responseId!}},
      dependencies:[{id:`${operationId}:intent`,revision:"1"},this.ref(state.segments)]};
    const proposal={scope:c.scope.runId,actor:c.scope.owner,parts:[{owner:"protocol_execution",kind:"record",proposal:{record,fence:null}}]};
    const id=`responses-terminal:${digest(record)}`,receipt=await c.acceptance.accept({id,...proposal});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_terminal_not_retained:${receipt.rejection?.code}`);
    return record;
  }
  async retainCapacityRefusal(session:ResponsesSession,ref:ProtocolJournalRecord["ref"]):Promise<ProtocolJournalRecord|null>{
    const c=this.custody,state=session.snapshot(),head=await this.observe();
    if(session.binding.id!==c.id||head?.revision!==state.revision)throw new TypeError("responses_refusal_head_changed");
    if(state.creation!=="rejected"||state.pending||state.head.responseId)return null;
    const segmentRef=this.ref(state.segments),segmentRecord=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:segmentRef}) as ProtocolJournalRecord|null;
    if(!segmentRecord)throw new TypeError("responses_refusal_segment_missing");
    const segment=JSON.parse((await readProtocolContent(c.journal,segmentRecord.content,c.fence.activityId,c.maximumSegmentBytes,c.observe)).toString()) as ResponsesSessionSegment;
    if(segment.kind!=="outcome"||segment.status!==400||segment.operationId!==`${c.id}:operation:1`)return null;
    let value:unknown;try{value=JSON.parse(segment.code);}catch{return null;}
    if(!responsesInputCapacityRefused(value))return null;
    const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState;
    const operationId=segment.operationId,content=await this.content(`${c.id}:capacity-refusal`,value);
    const record:ProtocolJournalRecord={ref,activityId:c.fence.activityId,operationId,kind:"observation",content,
      source:{scope:execution.activity.scope,protocol:execution.activity.composition.composition.protocol,
        interpretation:execution.activity.composition.composition.adapter.implementation,operationId,record:ref,
        position:{format:"json-pointer",value:""},nativeIdentity:null},dependencies:[{id:`${operationId}:intent`,revision:"1"},segmentRef]};
    const receipt=await c.acceptance.accept({id:`responses-refusal:${digest(record)}`,scope:c.scope.runId,actor:c.scope.owner,
      parts:[{owner:"protocol_execution",kind:"record",proposal:{record,fence:null}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`responses_refusal_not_retained:${receipt.rejection?.code}`);
    return record;
  }
  async *segments(count:number):AsyncIterable<ResponsesSessionSegment>{
    if(!Number.isSafeInteger(count)||count<0)throw new TypeError("responses_custody_count_invalid");
    const c=this.custody;
    for(let i=1;i<=count;i++){
      const record=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:this.ref(i)}) as ProtocolJournalRecord|null;
      if(!record)throw new TypeError("responses_custody_segment_missing");
      const bytes=await readProtocolContent(c.journal,record.content,c.fence.activityId,c.maximumSegmentBytes,c.observe);
      yield JSON.parse(bytes.toString()) as ResponsesSessionSegment;
    }
  }
  async commit(expectedRevision:number|null,state:ResponsesSessionState,segment:ResponsesSessionSegment|null):Promise<void>{
    const c=this.custody,head=await this.content(`${c.id}:head:${state.revision}`,state),parts:ProtocolJournalPart[]=[],references=[...c.original];
    if(state.revision!==(expectedRevision===null?0:expectedRevision+1))throw new TypeError("responses_custody_revision_invalid");
    let record:ProtocolJournalRecord|null=null;
    if(segment){
      const content=await this.content(`${c.id}:segment-content:${state.segments}`,segment);references.push(content);
      const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState|null;
      if(!execution)throw new TypeError("responses_custody_activity_missing");
      if(segment.kind==="control"&&segment.action==="cancel"&&!execution.cancelled)throw new TypeError("responses_cancellation_not_accepted");
      if(segment.kind==="control"&&segment.action==="follow_up"){
        const handoff=await c.journal.command({kind:"reconciliation",activityId:c.fence.activityId,id:segment.identity}) as ProtocolReconciliationHandoff|null;
        if(!handoff||handoff.disposition||handoff.receiver!==c.scope.owner||state.followUpDeadlineAt!==handoff.expiresAt)throw new TypeError("responses_follow_up_not_accepted");
      }
      const operationId="operationId" in segment?segment.operationId:`${c.id}:control`;
      const intent={id:`${operationId}:intent`,revision:"1"};
      const source=(ref:ProtocolJournalRecord["ref"])=>({scope:execution.activity.scope,protocol:execution.activity.composition.composition.protocol,
        interpretation:execution.activity.composition.composition.adapter.implementation,operationId,record:ref,
        position:{format:"json-pointer" as const,value:""},nativeIdentity:state.head.responseId?{kind:"response",id:state.head.responseId}:null});
      if(segment.kind==="dispatch"){
        const original:ProtocolJournalRecord={ref:intent,activityId:c.fence.activityId,operationId,
          kind:segment.operation==="create"?"dispatch_intent":"reconciliation_intent",content,source:source(intent),dependencies:[]};
        parts.push({owner:"protocol_execution",kind:"record",proposal:{fence:c.fence,record:original}});
      }
      const control=segment.kind==="control"||segment.kind==="dispatch";
      record={ref:this.ref(state.segments),activityId:c.fence.activityId,operationId,kind:control?"owner_checkpoint":"observation",
        content,source:source(this.ref(state.segments)),dependencies:control?[]:[intent]};
      parts.push({owner:"protocol_execution",kind:"record",proposal:{fence:c.fence,record}});
    }
    const evidence:ProtocolEvidenceRevision={scopeId:c.scope.id,kind:"transport",key:c.id,owner:c.scope.owner,activityId:c.fence.activityId,
      revision:state.revision,content:head,references,dependencies:record?[{activityId:c.fence.activityId,ref:record.ref}]:[],memberships:[],
      metadata:{bindingDigest:state.bindingDigest,segments:state.segments,lastSegmentKind:segment?.kind??null,responseId:state.head.responseId,cursor:state.head.cursor,
        status:state.head.status,capture:state.head.capture,events:state.head.events,duplicates:state.head.duplicates,keepalives:state.head.keepalives,
        creation:state.creation,operation:state.pending?.kind??null,operations:state.operations,disposition:state.disposition,dueAt:state.dueAt,
        readFailures:state.readEpisode?.failures??0,cancelFailures:state.cancelEpisode?.failures??0,cancellation:state.cancellation,
        readEpisodeDeadlineAt:state.readEpisode?.deadlineAt??null,readEpisodeExhausted:state.readEpisode?.exhausted??false,
        cancelEpisodeDeadlineAt:state.cancelEpisode?.deadlineAt??null,cancelEpisodeExhausted:state.cancelEpisode?.exhausted??false,
        lastObservedAt:state.lastAt,operationStartedAt:state.pending?.startedAt??null,interpretMs:segment?.work?.interpretMs??null,
        socketQueueMs:segment?.work?.socket?.queueMs??null,socketBufferedBytes:segment?.work?.socket?.bufferedBytes??null,
        followUp:state.followUp,followUpDeadlineAt:state.followUpDeadlineAt,reason:state.reason}};
    parts.push({owner:"protocol_execution",kind:"evidence",proposal:{fence:c.fence,expectedRevision,evidence}});
    const committed=async()=>{
      const saved=await c.journal.command({kind:"evidence",activityId:c.fence.activityId,scopeId:c.scope.id,evidenceKind:"transport",key:c.id,revision:state.revision});
      if(!saved)return false;
      if(digest(saved)!==digest(evidence))throw new TypeError("responses_custody_revision_conflict");
      return true;
    };
    const registerDispatch=async()=>{
      if(segment?.kind==="dispatch"||segment?.kind==="outcome")await this.accountOperation(segment,state,record);
    };
    if(await committed()){await registerDispatch();return;}
    try{
      const proposal={scope:c.scope.runId,actor:c.scope.owner,parts};
      const receipt=await c.acceptance.accept({id:`responses-checkpoint:${digest(proposal)}`,...proposal});
      if(receipt.outcome!=="accepted")throw new TypeError(`responses_custody_not_accepted:${receipt.rejection?.code}`);
    }catch(error){
      if(await committed()){await registerDispatch();return;}
      const current=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState|null;
      if(record?.kind==="observation"&&current&&digest(current.fence)!==digest(c.fence)){
        const ref={id:`${c.id}:late:${digest(record)}`,revision:"1"};
        const late={...record,ref,source:record.source?{...record.source,record:ref}:null};
        const receipt=await c.acceptance.accept({id:`late-observation:${digest(late)}`,scope:c.scope.runId,actor:c.scope.owner,
          parts:[{owner:"protocol_execution",kind:"record",proposal:{record:late,fence:null}}]});
        if(receipt.outcome!=="accepted")throw new TypeError(`responses_late_observation_not_retained:${receipt.rejection?.code}`);
      }
      throw error;
    }
    await registerDispatch();
    if(segment){try{c.observedSegment?.(segment,state);}catch{/* Display cannot alter a committed native observation. */}}
  }
}
