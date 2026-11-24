import type {SharedAcceptancePort,SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {retainProtocolContent,readProtocolContent,type ProtocolExecutionJournal,type ProtocolExecutionFence,type ProtocolEvidenceScope,
  type ProtocolEvidenceRevision,type ProtocolContentRef,type ProtocolContentWork,type ProtocolJournalRecord,type ProtocolExecutionState,
  type ProtocolJournalPart,type ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ResponsesCompactStore,ResponsesCompactState,ResponsesCompactSegment,ResponsesCompactSession} from "@agent-anything/provider-integrations/native";
import {retainHelarcNativeDispatchUsage} from "./HelarcNativeUsageObservation.js";

export interface HelarcResponsesCompactCustody {
  readonly id:string;readonly journal:ProtocolExecutionJournal;readonly acceptance:SharedAcceptancePort;
  readonly scope:ProtocolEvidenceScope;readonly fence:ProtocolExecutionFence;readonly original:readonly ProtocolContentRef[];
  readonly maximumBytes:number;readonly observe?:(work:ProtocolContentWork)=>void;
}
export function helarcResponsesCompactEvidenceScope(activity:ProtocolModelActivity):ProtocolEvidenceScope {
  const s=activity.scope;
  return {id:`responses-compact:${digest({runId:s.runId,recipientId:s.recipientId,purpose:s.purpose,compositionDigest:s.compositionDigest})}`,
    runId:s.runId,recipientId:s.recipientId,purpose:s.purpose,compositionDigest:s.compositionDigest,
    owner:activity.composition.composition.adapter.implementation.id};
}
/** Required execution custody. Inspector consumes its references and bounded heads independently. */
export class HelarcResponsesCompactStore implements ResponsesCompactStore {
  constructor(readonly custody:HelarcResponsesCompactCustody){}
  private ref(index:number){return {id:`${this.custody.id}:compact-segment:${index}`,revision:"1"};}
  async observe():Promise<ProtocolEvidenceRevision|null>{
    const c=this.custody;return c.journal.command({kind:"evidence",activityId:c.fence.activityId,scopeId:c.scope.id,evidenceKind:"transformation",key:c.id}) as Promise<ProtocolEvidenceRevision|null>;
  }
  async load():Promise<ResponsesCompactState|null>{
    const value=await this.observe();if(!value)return null;
    const c=this.custody,body=await readProtocolContent(c.journal,value.content,c.fence.activityId,65536,c.observe),state=JSON.parse(body.toString()) as ResponsesCompactState;
    if(state.revision!==value.revision||state.bindingDigest!==value.metadata.bindingDigest)throw new TypeError("compact_head_mismatch");
    const dispatch=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:{id:`${c.id}:compact:intent`,revision:"1"}}) as ProtocolJournalRecord|null;
    if(dispatch){
      const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState;
      await retainHelarcNativeDispatchUsage({journal:c.journal,acceptance:c.acceptance,state:execution,record:dispatch,
        operation:"compact",endpoint:null,submittedAt:null});
    }
    return state;
  }
  async retainTerminal(session:ResponsesCompactSession,ref:ProtocolJournalRecord["ref"]):Promise<ProtocolJournalRecord>{
    const c=this.custody,state=session.snapshot(),candidate=session.candidate(),head=await this.observe();
    if(session.binding.id!==c.id||head?.revision!==state.revision||!candidate||state.status!=="observed")throw new TypeError("compact_result_not_retained");
    const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState;
    const operationId=`${c.id}:compact`,content=await this.content(`${c.id}:terminal`,candidate.raw);
    const record:ProtocolJournalRecord={ref,activityId:c.fence.activityId,operationId,kind:"observation",content,
      source:{scope:execution.activity.scope,protocol:execution.activity.composition.composition.protocol,
        interpretation:execution.activity.composition.composition.adapter.implementation,operationId,record:ref,
        position:{format:"json-pointer",value:""},nativeIdentity:{kind:"response.compaction",id:candidate.resourceId}},
      dependencies:[{id:`${operationId}:intent`,revision:"1"},this.ref(state.segments)]};
    const receipt=await c.acceptance.accept({id:`compact-terminal:${digest(record)}`,scope:c.scope.runId,actor:c.scope.owner,
      parts:[{owner:"protocol_execution",kind:"record",proposal:{record,fence:null}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`compact_terminal_not_retained:${receipt.rejection?.code}`);
    return record;
  }
  async *segments(count:number):AsyncIterable<ResponsesCompactSegment>{
    const c=this.custody;
    for(let i=1;i<=count;i++){
      const record=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:this.ref(i)}) as ProtocolJournalRecord|null;
      if(!record)throw new TypeError("compact_segment_missing");
      const bytes=await readProtocolContent(c.journal,record.content,c.fence.activityId,c.maximumBytes,c.observe);
      yield JSON.parse(bytes.toString()) as ResponsesCompactSegment;
    }
  }
  private content(id:string,value:unknown){
    const c=this.custody,bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length>c.maximumBytes)throw new TypeError("compact_custody_limit");
    return retainProtocolContent(c.journal,`${id}:${digest(value)}`,c.fence.activityId,bytes,c.observe);
  }
  async commit(expected:number|null,state:ResponsesCompactState,segment:ResponsesCompactSegment|null):Promise<void>{
    if(state.revision!==(expected===null?0:expected+1))throw new TypeError("compact_revision_invalid");
    const c=this.custody,parts:ProtocolJournalPart[]=[],content=await this.content(`${c.id}:head:${state.revision}`,state),references=[...c.original];
    const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState|null;
    if(!execution)throw new TypeError("compact_activity_missing");
    const dependencies:ProtocolEvidenceRevision["dependencies"][number][]=[];
    let record:ProtocolJournalRecord|null=null;
    if(segment){
      const bytes=await this.content(`${c.id}:segment:${state.segments}`,segment),ref=this.ref(state.segments),operationId=`${c.id}:compact`;
      const intent={id:`${operationId}:intent`,revision:"1"};
      const source=(record:ProtocolJournalRecord["ref"])=>({scope:execution.activity.scope,protocol:execution.activity.composition.composition.protocol,
        interpretation:execution.activity.composition.composition.adapter.implementation,operationId,record,position:{format:"json-pointer" as const,value:""},
        nativeIdentity:state.resourceId?{kind:"response.compaction",id:state.resourceId}:null});
      if(segment.kind==="dispatch")parts.push({owner:"protocol_execution",kind:"record",proposal:{fence:c.fence,
        record:{ref:intent,activityId:c.fence.activityId,operationId,kind:"dispatch_intent",content:bytes,source:source(intent),dependencies:[]}}});
      if(segment.kind==="cancel"&&!execution.cancelled)throw new TypeError("compact_cancel_not_accepted");
      const observation=["chunk","observation","failure"].includes(segment.kind);
      record={ref,activityId:c.fence.activityId,operationId,kind:observation?"observation":"owner_checkpoint",
        content:bytes,source:source(ref),dependencies:observation?[intent]:[]};
      parts.push({owner:"protocol_execution",kind:"record",proposal:{fence:c.fence,record}});
      dependencies.push({activityId:c.fence.activityId,ref});references.push(bytes);
    }
    const previous=segment?.kind!=="observation"&&state.observationDigest!==null?await this.observe():null;
    const transportTimes:ProtocolEvidenceRevision["metadata"]=segment?.kind==="observation"?{transportStartedAt:segment.observation.work.startedAt??null,
      transportCompletedAt:segment.observation.work.completedAt??null}:previous?{
      transportStartedAt:previous.metadata.transportStartedAt??null,transportCompletedAt:previous.metadata.transportCompletedAt??null}:{};
    const evidence:ProtocolEvidenceRevision={scopeId:c.scope.id,kind:"transformation",key:c.id,owner:c.scope.owner,activityId:c.fence.activityId,
      revision:state.revision,content,references,dependencies,memberships:[],metadata:{stage:"standalone_compact",bindingDigest:state.bindingDigest,
        segments:state.segments,status:state.status,cancelled:state.cancelled,bytes:state.bytes,resourceId:state.resourceId,candidateDigest:state.candidateDigest,
        observationDigest:state.observationDigest,failure:state.failure,
        ...transportTimes}};
    parts.push({owner:"protocol_execution",kind:"evidence",proposal:{fence:c.fence,expectedRevision:expected,evidence}});
    const matched=async()=>{
      const saved=await c.journal.command({kind:"evidence",activityId:c.fence.activityId,scopeId:c.scope.id,evidenceKind:"transformation",key:c.id,revision:state.revision});
      if(saved&&digest(saved)!==digest(evidence))throw new TypeError("compact_revision_conflict");return Boolean(saved);
    };
    const registerDispatch=async()=>{
      if(segment?.kind!=="dispatch")return;
      const record=await c.journal.command({kind:"record",activityId:c.fence.activityId,ref:{id:`${c.id}:compact:intent`,revision:"1"}}) as ProtocolJournalRecord;
      await retainHelarcNativeDispatchUsage({journal:c.journal,acceptance:c.acceptance,state:execution,record,
        operation:"compact",endpoint:null,submittedAt:null});
    };
    if(await matched()){await registerDispatch();return;}
    const proposal:SharedAcceptanceProposal={id:`compact-checkpoint:${digest({parts,scope:c.scope})}`,scope:c.scope.runId,actor:c.scope.owner,parts};
    try{
      const receipt=await c.acceptance.accept(proposal);
      if(receipt.outcome!=="accepted")throw new TypeError(`compact_not_retained:${receipt.rejection?.code}`);
    }catch(error){
      if(await matched()){await registerDispatch();return;}
      const current=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState|null;
      if(record?.kind==="observation"&&current&&digest(current.fence)!==digest(c.fence)){
        const ref={id:`${c.id}:late:${digest(record)}`,revision:"1"};
        const late={...record,ref,source:record.source?{...record.source,record:ref}:null};
        const receipt=await c.acceptance.accept({id:`compact-late:${digest(late)}`,scope:c.scope.runId,actor:c.scope.owner,
          parts:[{owner:"protocol_execution",kind:"record",proposal:{record:late,fence:null}}]});
        if(receipt.outcome!=="accepted")throw new TypeError(`compact_late_not_retained:${receipt.rejection?.code}`);
      }
      throw error;
    }
    await registerDispatch();
  }
}
