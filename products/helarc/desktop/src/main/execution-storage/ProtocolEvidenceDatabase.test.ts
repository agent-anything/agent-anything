import {afterEach,describe,expect,it} from "vitest";
import Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {bindProtocolModelActivity,type ProtocolContentRef,type ProtocolEvidenceRevision,type ProtocolEvidenceScope,
  type ProtocolExecutionState,type ProtocolJournalPart,type ProtocolJournalRecord,type ProtocolEvidencePage,
  type ProtocolUsageMerge,type ProtocolUsageRetirement,type ProtocolUsageSnapshot} from "@agent-anything/agent-runtime/model-access";
import {HelarcResponsesCompactStore} from "@agent-anything/helarc/controller";
import {ResponsesCompactSession,prepareResponsesCompact} from "@agent-anything/provider-integrations/native";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {ProtocolExecutionDatabase,PROTOCOL_EXECUTION_SCHEMA,PROTOCOL_RECONCILIATION_SCHEMA,PROTOCOL_ADMISSION_SCHEMA} from "./ProtocolExecutionDatabase.js";
import {PROTOCOL_EVIDENCE_SCHEMA,PROTOCOL_USAGE_ACCESS_SCHEMA} from "./ProtocolEvidenceDatabase.js";
import {SharedAcceptanceDatabase,SHARED_ACCEPTANCE_SCHEMA} from "./SharedAcceptanceDatabase.js";

const dbs:Database.Database[]=[],directories:string[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const ref=(id:string)=>({id,revision:"1"});
function original(activityId="a",overrides:Partial<{runId:string;recipientId:string;purpose:{id:string;revision:string}}>= {},configuration="configuration") {
  const participant=(id:string)=>({implementation:ref(id),protocol:OPENAI_RESPONSES});
  const composition=bindModelAgentComposition({agent:ref("agent"),protocol:OPENAI_RESPONSES,
    configuration:{configuration:ref(configuration),protocol:OPENAI_RESPONSES,model:"model",connectionBinding:ref("connection")},
    adapter:participant("adapter"),task:{purpose:ref("task"),interpreter:participant("interpreter"),input:participant("input")},
    auxiliary:[{purpose:ref("measure"),interpreter:participant("measure-interpreter"),input:participant("measure-input")}]});
  return bindProtocolModelActivity({composition,scope:{runId:"run",activityId,recipientId:"recipient",purpose:ref("task"),compositionDigest:composition.digest,...overrides},
    conditions:{input:ref(`${activityId}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
}
function fixture(path=":memory:",initialize=true,generation=1,trace:string[]=[],claimContextInput?:ConstructorParameters<typeof ProtocolExecutionDatabase>[2]){
  const db=new Database(path,{verbose:sql=>trace.push(String(sql))});dbs.push(db);
  if(initialize)db.exec(PROTOCOL_EXECUTION_SCHEMA+PROTOCOL_EVIDENCE_SCHEMA+PROTOCOL_RECONCILIATION_SCHEMA+PROTOCOL_ADMISSION_SCHEMA+PROTOCOL_USAGE_ACCESS_SCHEMA+SHARED_ACCEPTANCE_SCHEMA);
  const journal=new ProtocolExecutionDatabase(db,()=>generation,claimContextInput),shared=new SharedAcceptanceDatabase(db,[journal.participant()]);
  let sequence=0;
  const accept=(parts:readonly ProtocolJournalPart[],actor="adapter",scope="run",id=`${generation}:accept:${++sequence}`)=>shared.accept({id,scope,actor,parts});
  const body=(id:string,text:string,activityId="a",complete=true):ProtocolContentRef=>{
    const bytes=Buffer.from(text),content={id,activityId,bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`};
    journal.command({kind:"content_begin",content});
    for(let offset=0;offset<bytes.length;offset+=65536)journal.command({kind:"content_append",content,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
    if(complete)journal.command({kind:"content_complete",content});return content;
  };
  const prepare=(activity=original(),contextInput?:ProtocolExecutionState["contextInput"])=>{
    const activityId=activity.scope.activityId,input=body(`${activityId}:input`,"frozen input",activityId);
    expect(accept([{owner:"protocol_execution",kind:"prepare",proposal:{activity,input,...contextInput?{contextInput}:{}}}],"execution-coordinator",activity.scope.runId).outcome).toBe("accepted");
    expect(accept([{owner:"protocol_execution",kind:"claim",proposal:{activityId,expectedEpoch:0}}],"adapter",activity.scope.runId).outcome).toBe("accepted");
    return journal.command({kind:"state",activityId}) as ProtocolExecutionState;
  };
  const scope:ProtocolEvidenceScope={id:"sequence",runId:"run",recipientId:"recipient",purpose:ref("task"),compositionDigest:original().composition.digest,owner:"adapter"};
  const bind=(activityId="a",value=scope)=>accept([{owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId,scope:value}}],"execution-coordinator",value.runId);
  const evidence=(content:ProtocolContentRef,patch:Partial<ProtocolEvidenceRevision>={}):ProtocolEvidenceRevision=>({scopeId:scope.id,kind:"continuation",key:"head",owner:"adapter",activityId:content.activityId,
    revision:0,content,references:[],dependencies:[],metadata:{},memberships:[],...patch});
  const part=(value:ProtocolEvidenceRevision,expectedRevision:number|null=null):ProtocolJournalPart=>({owner:"protocol_execution",kind:"evidence",proposal:{
    fence:(journal.command({kind:"state",activityId:value.activityId}) as ProtocolExecutionState).fence,expectedRevision,evidence:value}});
  const read=(activityId="a",evidenceKind:ProtocolEvidenceRevision["kind"]="continuation",key="head",revision?:number)=>
    journal.command({kind:"evidence",activityId,scopeId:scope.id,evidenceKind,key,...revision===undefined?{}:{revision}});
  const page=(afterKey:string|null=null,expectedVersion?:number,limit=128)=>journal.command({kind:"evidence_list",activityId:"a",scopeId:scope.id,
    evidenceKind:"usage",afterKey,limit,membership:"tree",...expectedVersion===undefined?{}:{expectedVersion}}) as ProtocolEvidencePage;
  const merge=(survivor:ProtocolEvidenceRevision,expectedRevision:number|null,retired:readonly {key:string;expectedRevision:number|null;activityId?:string}[],mergeId="merge"):ProtocolJournalPart=>({
    owner:"protocol_execution",kind:"usage_merge",proposal:{scopeId:scope.id,mergeId,
      survivor:{fence:(journal.command({kind:"state",activityId:survivor.activityId}) as ProtocolExecutionState).fence,expectedRevision,evidence:survivor},
      retired:retired.map(({key,expectedRevision,activityId="a"})=>({key,expectedRevision,fence:(journal.command({kind:"state",activityId}) as ProtocolExecutionState).fence}))}});
  const retirement=(key:string)=>journal.command({kind:"usage_retirement",activityId:"a",scopeId:scope.id,key}) as ProtocolUsageRetirement|null;
  const merged=(mergeId="merge")=>journal.command({kind:"usage_merge",activityId:"a",scopeId:scope.id,mergeId}) as ProtocolUsageMerge|null;
  return {db,journal,shared,accept,body,prepare,scope,bind,evidence,part,read,trace,page,merge,retirement,merged};
}
describe("Protocol evidence index",()=>{
  it("pages dispatch and usage cursors independently at a fixed fact boundary without reading bodies",()=>{
    const f=fixture();
    expect(f.journal.command({kind:"usage_snapshot",runId:"run",limit:1})).toMatchObject({boundary:0,complete:true,entries:[],dispatches:[],next:null});
    const state=f.prepare();f.bind();
    for(const id of ["dispatch-a","dispatch-b"]){
      const record:ProtocolJournalRecord={ref:ref(id),activityId:"a",operationId:id,kind:"dispatch_intent",content:state.input,source:null,dependencies:[]};
      expect(f.accept([{owner:"protocol_execution",kind:"record",proposal:{record,fence:state.fence}}]).outcome).toBe("accepted");
    }
    const value=f.evidence(f.body("usage-body","original usage"),{kind:"usage",key:"usage",memberships:["run"]});
    expect(f.accept([f.part(value)]).outcome).toBe("accepted");f.trace.length=0;
    const first=f.journal.command({kind:"usage_snapshot",runId:"run",limit:1}) as ProtocolUsageSnapshot;
    expect(first.boundary).toBeGreaterThan(0);
    expect(first.dispatches.map(r=>r.ref.id)).toEqual(["dispatch-a"]);expect(first.entries.map(e=>e.key)).toEqual(["usage"]);
    expect(first.next).toMatchObject({entriesComplete:true,dispatchesComplete:false,dispatches:{activityId:"a",id:"dispatch-a",revision:"1"}});
    const second=f.journal.command({kind:"usage_snapshot",runId:"run",limit:1,expectedBoundary:first.boundary,after:first.next!}) as ProtocolUsageSnapshot;
    expect(second.dispatches.map(r=>r.ref.id)).toEqual(["dispatch-b"]);expect(second.entries).toEqual([]);expect(second.complete).toBe(true);expect(second.next).toBeNull();
    expect(f.journal.command({kind:"usage_snapshot",runId:"run",limit:1,ifBoundary:first.boundary})).toEqual({unchangedBoundary:first.boundary});
    expect(f.trace.some(sql=>/FROM protocol_content_chunks/i.test(sql))).toBe(false);
    expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId:"a",expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    expect(f.journal.command({kind:"usage_snapshot",runId:"run",limit:1,expectedBoundary:first.boundary,after:first.next!})).toHaveProperty("changedBoundary");
  });
  it("retains compact transport details in content and scalar timing indexes across observation recovery and cancellation",async()=>{
    const f=fixture(),state=f.prepare();f.bind();
    const custody={id:"compact",journal:{command:async(command:Parameters<typeof f.journal.command>[0])=>f.journal.command(command)},
      acceptance:{query:async(id:string)=>f.shared.query(id),accept:async(proposal:Parameters<typeof f.shared.accept>[0])=>f.shared.accept(proposal)},
      scope:f.scope,fence:state.fence,original:[state.input],maximumBytes:65536};
    const binding={id:"compact",prepared:prepareResponsesCompact({model:"model",purpose:ref("task"),input:[{role:"user",content:"Keep blue"}]}),
      sourceDigest:"source",target:"target",disclosure:"authority",startedAt:1,deadlineAt:100,maximumBytes:65536};
    const work={bytes:123,chunks:1,elapsedMs:25,startedAt:"2026-11-17T00:00:00.000Z",completedAt:"2026-11-17T00:00:00.025Z"};
    const observation={status:200,requestId:"request",frames:[],work,body:JSON.stringify({id:"cmp",object:"response.compaction",
      output:[{type:"compaction",id:"compact-item",encrypted_content:"opaque"}]})};
    const store=new HelarcResponsesCompactStore(custody),session=await ResponsesCompactSession.open(binding,store);
    await session.execute({now:2,authorize:async()=>true,dispatch:async()=>observation});
    expect((await store.observe())!.metadata).toMatchObject({status:"observed",transportStartedAt:work.startedAt,transportCompletedAt:work.completedAt});
    expect(Object.values((await store.observe())!.metadata).every(v=>v===null||["string","number","boolean"].includes(typeof v))).toBe(true);
    const restored=await ResponsesCompactSession.open(binding,new HelarcResponsesCompactStore(custody));
    expect(restored.observed()).toEqual(observation);
    expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId:"a",expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    const cancelled=f.journal.command({kind:"state",activityId:"a"}) as ProtocolExecutionState;
    const finalStore=new HelarcResponsesCompactStore({...custody,fence:cancelled.fence});
    const final=await ResponsesCompactSession.open(binding,finalStore);await final.cancel("original cancel");
    expect((await finalStore.observe())!.metadata).toMatchObject({cancelled:true,transportStartedAt:work.startedAt,transportCompletedAt:work.completedAt});
    expect(final.observed()).toEqual(observation);
  });
  it("requires the original owner's independent input disposition after connection discharge, including restart",()=>{
    const directory=mkdtempSync(join(tmpdir(),"protocol-input-use-"));directories.push(directory);const path=join(directory,"evidence.sqlite");
    const contextInput={id:"selected-input",digest:"original-input-digest"};
    const f=fixture(path,true,1,[],(_activity,input)=>expect(input).toEqual(contextInput));
    const state=f.prepare(original(),contextInput),consumer=f.journal.contextConsumer();
    const scope={id:"input-scope",runId:"run",recipient:"recipient",purpose:"task",owner:"input-owner",target:"configuration",
      continuity:"run",authorityBasis:"authority"};
    const input={id:contextInput.id,activityId:"a",stageRequestId:null,scopeId:scope.id,selectionId:"selection",target:scope.target,
      exactInputDigest:contextInput.digest,deliveries:[],holds:[],combinationJudgmentId:"judgment",
      nativeConsumer:{protocol:OPENAI_RESPONSES,compositionDigest:state.activity.composition.digest}};
    expect(consumer.describe(input,scope)).toMatchObject({claimed:true,settled:false});
    expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId:"a",expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    const cancelled=f.journal.command({kind:"state",activityId:"a"}) as ProtocolExecutionState;
    const basis:ProtocolJournalRecord={ref:ref("native-disposition"),activityId:"a",operationId:"discharge",kind:"native_checkpoint",
      content:f.body("native-disposition-content","original protocol-owned disposition"),source:null,dependencies:[]};
    const settlement:ProtocolJournalPart={owner:"protocol_execution",kind:"settle_input_use",proposal:{activityId:"a",input:contextInput,nativeBasis:basis.ref}};
    expect(f.accept([settlement]).rejection?.code).toContain("input_use_disposition_not_ready");
    expect(f.accept([{owner:"protocol_execution",kind:"record",proposal:{record:basis,fence:cancelled.fence}},
      {owner:"protocol_execution",kind:"release_retention",proposal:{fence:cancelled.fence,nativeBasis:basis.ref}}]).outcome).toBe("accepted");
    expect(consumer.describe(input,scope)).toMatchObject({settled:false});
    expect(f.accept([settlement],"input-owner").rejection?.code).toContain("adapter_owner_invalid");
    expect(f.accept([{...settlement,proposal:{...settlement.proposal,input:{...contextInput,digest:"changed"}}}]).outcome).toBe("rejected");
    const receipt=f.accept([settlement],"adapter","run","original-input-disposition");expect(receipt.outcome).toBe("accepted");
    expect(consumer.describe(input,scope)).toMatchObject({settled:true});
    f.db.close();const reopened=fixture(path,false,2);
    expect(reopened.accept([settlement],"adapter","run","original-input-disposition")).toEqual(receipt);
    expect(reopened.journal.contextConsumer().describe(input,scope)).toMatchObject({settled:true});
    expect(reopened.journal.command({kind:"state",activityId:"a"})).toMatchObject({accepted:null,cancelled:true,
      inputUseSettlement:{basis:basis.ref,acceptanceId:receipt.id}});
    expect(()=>reopened.journal.contextConsumer().describe(input,{...scope,runId:"child"})).toThrow("native_context_consumer_changed");
  });
  it("samples scoped usage publications without loading payload bytes or adopting another recipient",()=>{
    const f=fixture();f.prepare();f.bind();
    for(const key of ["first","second"]){
      const value=f.evidence(f.body(`${key}:body`,"retained usage"),{kind:"usage",key,memberships:["run"]});
      expect(f.accept([f.part(value)]).outcome).toBe("accepted");
    }
    const foreign=original("child-activity",{runId:"child",recipientId:"child-recipient"});f.prepare(foreign);
    const childScope={...f.scope,id:"child-scope",runId:"child",recipientId:"child-recipient"};
    expect(f.bind("child-activity",childScope).outcome).toBe("accepted");
    const child=f.evidence(f.body("child-body","child usage","child-activity"),{scopeId:childScope.id,kind:"usage",key:"child",memberships:["child"]});
    expect(f.accept([f.part(child)],"adapter","child").outcome).toBe("accepted");
    f.trace.length=0;
    const page=f.journal.command({kind:"usage_samples",runId:"run",recipientId:"recipient",purpose:ref("task"),compositionDigest:f.scope.compositionDigest,limit:1}) as ProtocolEvidencePage;
    expect(page.entries.map(e=>e.key)).toEqual(["second"]);expect(page.next).toBe("second");
    expect(f.trace.some(sql=>/FROM protocol_content_chunks/i.test(sql))).toBe(false);
    expect(f.journal.command({kind:"usage_samples",runId:"run",recipientId:"child-recipient",purpose:ref("task"),compositionDigest:f.scope.compositionDigest,limit:1}))
      .toEqual({entries:[],next:null,version:null});
  });
  it("accepts reconciliation after cancellation without reopening generation or dropping handoff responsibility",()=>{
    const f=fixture(),initial=f.prepare();f.bind();
    expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId:"a",expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    const state=f.journal.command({kind:"state",activityId:"a"}) as ProtocolExecutionState;
    const checkpoint:ProtocolJournalRecord={ref:ref("checkpoint"),activityId:"a",operationId:"local-control",kind:"owner_checkpoint",content:f.body("owner-state","native control"),source:null,dependencies:[]};
    const part=(record:ProtocolJournalRecord,fence=state.fence):ProtocolJournalPart=>({owner:"protocol_execution",kind:"record",proposal:{record,fence}});
    expect(f.accept([part({...checkpoint,kind:"dispatch_intent"})]).rejection?.code).toContain("fenced");
    expect(f.accept([part(checkpoint)]).outcome).toBe("accepted");
    expect(f.accept([part({...checkpoint,ref:ref("read-intent"),operationId:"retrieve-original",kind:"reconciliation_intent"})]).outcome).toBe("accepted");
    const handoff={id:"handoff",activityId:"a",receiver:"adapter",checkpoint:checkpoint.ref,dependencies:[initial.input],dueAt:1000,expiresAt:2000,disposition:null};
    expect(f.accept([{owner:"protocol_execution",kind:"reconciliation_handoff",proposal:{fence:state.fence,handoff:{...handoff,dependencies:[]}}}]).rejection?.code).toContain("dependencies");
    expect(f.accept([{owner:"protocol_execution",kind:"reconciliation_handoff",proposal:{fence:state.fence,handoff}}]).outcome).toBe("accepted");
    expect(f.journal.command({kind:"reconciliation_list",receiver:"adapter",after:null,limit:10})).toEqual([handoff]);
    expect(f.accept([part({...checkpoint,ref:ref("stale-owner")})]).rejection?.code).toContain("fenced");
    const current=f.journal.command({kind:"state",activityId:"a"}) as ProtocolExecutionState;
    const native={...checkpoint,ref:ref("native-end"),kind:"native_checkpoint" as const,operationId:"retrieve-original",dependencies:[ref("read-intent")]};
    expect(f.accept([part(native,current.fence)]).outcome).toBe("accepted");
    expect(f.accept([{owner:"protocol_execution",kind:"release_retention",proposal:{fence:current.fence,nativeBasis:native.ref}}]).rejection?.code).toContain("reconciliation_responsibility_pending");
    expect(f.accept([{owner:"protocol_execution",kind:"reconciliation_close",proposal:{fence:current.fence,id:"handoff",disposition:{basis:native.ref,outcome:"unresolved"}}}]).outcome).toBe("accepted");
    expect(f.journal.command({kind:"reconciliation_list",receiver:"adapter",after:null,limit:10})).toEqual([]);
    expect(f.accept([{owner:"protocol_execution",kind:"release_retention",proposal:{fence:current.fence,nativeBasis:native.ref}}]).outcome).toBe("accepted");
    expect(f.accept([part({...checkpoint,ref:ref("after-release")},current.fence)]).rejection?.code).toContain("retained_dependencies_released");
  });
  it("advances one explicitly bound cross-activity head, preserves history and original references across restart",()=>{
    const directory=mkdtempSync(join(tmpdir(),"protocol-evidence-"));directories.push(directory);const path=join(directory,"evidence.sqlite");
    const f=fixture(path);const a=f.prepare();expect(f.bind().outcome).toBe("accepted");
    const manifest=f.body("manifest",JSON.stringify({selected:["original"],holds:["hold-1"]}));
    const first=f.evidence(f.body("checkpoint-0","native checkpoint"),{references:[manifest,a.input]});
    const proposal={id:"original-cas",scope:"run",actor:"adapter",parts:[f.part(first)]};
    const receipt=f.shared.accept(proposal);expect(receipt.outcome).toBe("accepted");
    f.prepare(original("b"));expect(()=>f.read("b")).toThrow("activity_binding");
    expect(f.bind("b").outcome).toBe("accepted");expect(f.read("b")).toEqual(first);
    const next=f.evidence(f.body("checkpoint-1","next native checkpoint","b"),{revision:1,references:[manifest,a.input]});
    expect(f.accept([f.part(next,0)]).outcome).toBe("accepted");
    expect(f.read("a")).toEqual(next);expect(f.read("b","continuation","head",0)).toEqual(first);
    expect(f.accept([f.part({...next,revision:1},0)]).rejection?.code).toContain("revision_conflict");
    const stale=f.part({...next,revision:2},1);f.db.close();
    const reopened=fixture(path,false,2);
    expect(reopened.read("b")).toEqual(next);expect(reopened.shared.accept(proposal)).toEqual(receipt);
    expect(reopened.accept([stale]).rejection?.code).toContain("fenced");
    expect(reopened.accept([{owner:"protocol_execution",kind:"claim",proposal:{activityId:"b",expectedEpoch:1}}]).outcome).toBe("accepted");
    expect(reopened.accept([reopened.part({...next,revision:2},1)]).outcome).toBe("accepted");
  });
  it("rejects owner, scope, composition, purpose and reference mismatches without broadening access",()=>{
    const f=fixture();f.prepare();f.bind();const content=f.body("checkpoint","native"),value=f.evidence(content);
    expect(f.accept([f.part(value)],"stranger").rejection?.code).toContain("owner_invalid");
    expect(f.accept([f.part({...value,owner:"stranger"})]).rejection?.code).toContain("owner_invalid");
    expect(f.bind("a",{...f.scope,owner:"stranger"}).rejection?.code).toContain("scope_conflict");
    for(const activity of [original("other-recipient",{recipientId:"child"}),original("other-run",{runId:"child"}),
      original("other-purpose",{purpose:ref("measure")}),original("other-composition",{},"changed")]){
      f.prepare(activity);
      expect(f.bind(activity.scope.activityId).rejection?.code).toContain("activity_scope_invalid");
      expect(()=>f.read(activity.scope.activityId)).toThrow("activity_scope_invalid");
    }
    const foreign=f.body("foreign","body","other-recipient");
    expect(f.accept([f.part({...value,references:[foreign]})]).rejection?.code).toContain("activity_scope_invalid");
    const partial=f.body("partial","body","a",false);
    expect(f.accept([f.part({...value,content:partial})]).rejection?.code).toContain("content_incomplete");
    expect(f.accept([f.part({...value,dependencies:[{activityId:"a",ref:ref("missing")} ]})]).rejection?.code).toContain("dependency_missing");
    expect(f.read()).toBeNull();
  });
  it("atomically reconciles original usage and per-work reservation disposition; cancellation cannot accept continuation",()=>{
    const f=fixture();const state=f.prepare();f.bind();
    const dispatch:ProtocolJournalRecord={ref:ref("dispatch"),activityId:"a",operationId:"remote-work",kind:"dispatch_intent",content:state.input,source:null,dependencies:[]};
    expect(f.accept([{owner:"protocol_execution",kind:"record",proposal:{record:dispatch,fence:state.fence}}]).outcome).toBe("accepted");
    const observation:ProtocolJournalRecord={...dispatch,ref:ref("usage"),kind:"observation",content:f.body("usage","raw usage"),dependencies:[dispatch.ref]};
    const value=f.evidence(f.body("work","{\"usage\":10,\"reservation\":\"reconciled\"}"),{kind:"usage",key:"unique-work",dependencies:[{activityId:"a",ref:observation.ref}],metadata:{tokens:10},memberships:["tree","consumer"]});
    expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId:"a",expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    const recordPart:ProtocolJournalPart={owner:"protocol_execution",kind:"record",proposal:{record:observation,fence:null}};
    expect(f.accept([recordPart,f.part(value)]).outcome).toBe("accepted");
    expect(f.read("a","usage","unique-work")).toEqual(value);
    const late={...observation,ref:ref("later-usage")};
    expect(f.accept([{...recordPart,proposal:{record:late,fence:null}},f.part(value)]).rejection?.code).toContain("revision_conflict");
    expect(f.journal.command({kind:"record",activityId:"a",ref:late.ref})).toBeNull();
    expect(f.accept([f.part(f.evidence(value.content))]).rejection?.code).toContain("fenced");
  });
  it("pages exact measurement keys and unique usage memberships without reading content chunks",()=>{
    const f=fixture();f.prepare();f.bind();const content=f.body("large","raw content ".repeat(30000));
    const measurement=f.evidence(content,{kind:"measurement",key:"exact-complete-input-binding",metadata:{count:123}});
    expect(f.accept([f.part(measurement)]).outcome).toBe("accepted");
    expect(f.read("a","measurement",measurement.key)).toEqual(measurement);
    expect(f.read("a","measurement","changed-binding")).toBeNull();
    for(let n=0;n<40;n++)expect(f.accept([f.part(f.evidence(content,{kind:"usage",key:`work-${String(n).padStart(2,"0")}`,metadata:{tokens:n},memberships:n%2?["tree","other"]:["tree"]}))]).outcome).toBe("accepted");
    f.trace.length=0;
    const keys:string[]=[];let afterKey:string|null=null,expectedVersion:number|undefined;
    do{
      const page=f.page(afterKey,expectedVersion,7);
      expect(page.entries.length).toBeLessThanOrEqual(7);keys.push(...page.entries.map(value=>value.key));afterKey=page.next;expectedVersion=page.version!;
    }while(afterKey!==null);
    expect(keys).toHaveLength(40);expect(new Set(keys).size).toBe(40);
    expect(f.trace.some(sql=>sql.includes("protocol_content_chunks"))).toBe(false);
    const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT key FROM protocol_evidence_memberships WHERE scope_id=? AND membership=? AND key>? ORDER BY key LIMIT ?").all("sequence","tree","",7);
    expect(JSON.stringify(plan)).toContain("SEARCH");expect(JSON.stringify(plan)).not.toContain("SCAN");
    const originalValue=f.read("a","usage","work-01") as ProtocolEvidenceRevision;
    expect(f.accept([f.part({...originalValue,revision:1,memberships:["other"]},0)]).outcome).toBe("accepted");
    expect((f.journal.command({kind:"evidence_list",activityId:"a",scopeId:f.scope.id,evidenceKind:"usage",afterKey:null,limit:128,membership:"tree"}) as {entries:readonly ProtocolEvidenceRevision[]}).entries).toHaveLength(39);
    expect(f.read("a","usage","work-01",0)).toEqual(originalValue);
  });
  it("bounds metadata, rejects oversized pages, and detects damaged history/current indexes",()=>{
    const f=fixture();f.prepare();f.bind();const value=f.evidence(f.body("body","native"));
    expect(f.accept([f.part({...value,metadata:{payload:"x".repeat(1025)}})]).rejection?.code).toContain("metadata_invalid");
    expect(f.accept([f.part({...value,metadata:{payload:"\u4e2d".repeat(342)}})]).rejection?.code).toContain("metadata_invalid");
    expect(f.accept([f.part({...value,metadata:{a:"x".repeat(1024),b:"x".repeat(1024),c:"x".repeat(1024),d:"x".repeat(1024)}})]).rejection?.code).toContain("metadata_bound");
    expect(f.accept([f.part({...value,memberships:["tree"]})]).rejection?.code).toContain("memberships_invalid");
    expect(()=>f.journal.command({kind:"evidence_list",activityId:"a",scopeId:f.scope.id,evidenceKind:"continuation",afterKey:null,limit:129})).toThrow("bound_invalid");
    expect(f.accept([f.part(value)]).outcome).toBe("accepted");
    f.db.prepare("UPDATE protocol_evidence_slots SET revision=99").run();expect(()=>f.read()).toThrow("slot_corrupt");
    f.db.prepare("UPDATE protocol_evidence_slots SET revision=0").run();
    f.db.prepare("DELETE FROM protocol_evidence_history").run();expect(()=>f.read()).toThrow("slot_corrupt");
    expect(()=>f.journal.command({kind:"evidence_list",activityId:"a",scopeId:f.scope.id,evidenceKind:"continuation",afterKey:null,limit:1})).toThrow("slot_corrupt");
  });
  it("accepts bounded exact-cost summaries without lifting the total metadata budget",()=>{
    const f=fixture();f.prepare();f.bind();
    const summary=JSON.stringify({USD:`0.${"1".repeat(200)}`,EUR:`0.${"2".repeat(200)}`});
    const value=f.evidence(f.body("cost","original priced evidence"),{kind:"usage",key:"work",metadata:{pricedSubtotalsJson:summary}});
    expect(Buffer.byteLength(summary)).toBeGreaterThan(256);
    expect(f.accept([f.part(value)]).outcome).toBe("accepted");
    expect(f.read("a","usage","work")).toEqual(value);
  });
  it("atomically publishes one survivor, preserves retired originals and absent-key tombstones across restart",()=>{
    const directory=mkdtempSync(join(tmpdir(),"protocol-merge-"));directories.push(directory);const path=join(directory,"evidence.sqlite");
    const f=fixture(path);f.prepare();f.bind();
    const a=f.evidence(f.body("a-work","original work A"),{kind:"usage",key:"a",memberships:["tree"]});
    const b=f.evidence(f.body("b-work","original work B"),{kind:"usage",key:"b",memberships:["tree","child"]});
    expect(f.accept([f.part(a),f.part(b)]).outcome).toBe("accepted");expect(f.page().version).toBe(2);
    const survivor={...a,revision:1,content:f.body("merged-work","original A and B reservations and price bases"),references:[a.content,b.content],memberships:["tree","child"]};
    const proposal={id:"merge:accepted",scope:"run",actor:"adapter",parts:[f.merge(survivor,0,[{key:"b",expectedRevision:0},{key:"late-unpublished",expectedRevision:null}])]};
    const receipt=f.shared.accept(proposal);expect(receipt.outcome).toBe("accepted");
    expect(f.page()).toEqual({entries:[survivor],next:null,version:3});
    expect(f.read("a","usage","b")).toBeNull();expect(f.read("a","usage","b",0)).toEqual(b);
    expect(f.retirement("b")).toMatchObject({acceptanceId:proposal.id,previous:{revision:0,content:b.content},survivor:{key:"a",revision:1,content:survivor.content}});
    expect(f.retirement("late-unpublished")?.previous).toBeNull();
    expect(f.merged()).toMatchObject({version:3,acceptanceId:proposal.id,survivor,retired:[f.retirement("b"),f.retirement("late-unpublished")]});
    f.db.close();const next=fixture(path,false,2);
    expect(next.shared.accept(proposal)).toEqual(receipt);expect(next.page()).toEqual({entries:[survivor],next:null,version:3});
    expect(next.merged()?.retired).toHaveLength(2);
    const facts=next.db.prepare("SELECT value FROM protocol_facts ORDER BY sequence").all() as {value:string}[];
    expect(facts.map(row=>JSON.parse(row.value).kind).filter(kind=>kind==="usage_retired")).toHaveLength(2);
    expect(facts.map(row=>JSON.parse(row.value).kind).filter(kind=>kind==="usage_merge")).toHaveLength(1);
  });
  it("rolls back all slots, originals, aliases and version when any expected revision is stale or persistence fails",()=>{
    const f=fixture();const state=f.prepare();f.bind();
    const first=f.evidence(f.body("first","first"),{kind:"usage",key:"a",memberships:["tree"]});
    const second={...first,key:"b"};expect(f.accept([f.part(first),f.part(second)]).outcome).toBe("accepted");
    const survivor={...first,revision:1},record:ProtocolJournalRecord={ref:ref("merge-original"),activityId:"a",operationId:"merge",kind:"dispatch_intent",content:state.input,source:null,dependencies:[]};
    const original:ProtocolJournalPart={owner:"protocol_execution",kind:"record",proposal:{record,fence:state.fence}};
    for(const part of [f.merge(survivor,1,[{key:"b",expectedRevision:0}]),f.merge(survivor,0,[{key:"b",expectedRevision:1}])]){
      expect(f.accept([original,part]).outcome).toBe("rejected");expect(f.read("a","usage","a")).toEqual(first);
      expect(f.read("a","usage","b")).toEqual(second);expect(f.retirement("b")).toBeNull();expect(f.merged()).toBeNull();
      expect(f.page().version).toBe(2);expect(f.journal.command({kind:"record",activityId:"a",ref:record.ref})).toBeNull();
    }
    f.db.exec("CREATE TRIGGER interrupt_merge BEFORE INSERT ON protocol_evidence_retirements BEGIN SELECT RAISE(ABORT,'fixture_merge_interrupted'); END");
    expect(()=>f.accept([original,f.merge(survivor,0,[{key:"b",expectedRevision:0}])])).toThrow("fixture_merge_interrupted");
    expect(f.page()).toEqual({entries:[first,second],next:null,version:2});expect(f.retirement("b")).toBeNull();expect(f.merged()).toBeNull();
    expect(f.journal.command({kind:"record",activityId:"a",ref:record.ref})).toBeNull();
    f.db.exec("DROP TRIGGER interrupt_merge");
    expect(f.accept([original,f.merge(survivor,0,[{key:"b",expectedRevision:0}])]).outcome).toBe("accepted");
  });
  it("requires owner, each current fence and exact scope while allowing accounting-only cancellation reconciliation",()=>{
    const f=fixture();f.prepare();f.bind();f.prepare(original("b"));f.bind("b");
    const a=f.evidence(f.body("body-a","a"),{kind:"usage",key:"a"}),b=f.evidence(f.body("body-b","b","b"),{kind:"usage",key:"b"});
    expect(f.accept([f.part(a),f.part(b)]).outcome).toBe("accepted");
    const before=f.merge({...a,revision:1},0,[{key:"b",expectedRevision:0,activityId:"b"}]);
    expect(f.accept([before],"wrong-owner").rejection?.code).toContain("owner_invalid");
    expect(f.accept([{owner:"protocol_execution",kind:"claim",proposal:{activityId:"b",expectedEpoch:1}}]).outcome).toBe("accepted");
    expect(f.accept([before]).rejection?.code).toContain("fenced");
    f.prepare(original("child",{runId:"child",recipientId:"child"}));
    expect(f.accept([f.merge({...a,revision:1},0,[{key:"b",expectedRevision:0,activityId:"child"}])]).rejection?.code).toContain("activity_scope_invalid");
    for(const activityId of ["a","b"])expect(f.accept([{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:0,cancelled:true}}],"execution-coordinator").outcome).toBe("accepted");
    expect(f.accept([f.merge({...a,revision:1},0,[{key:"b",expectedRevision:0,activityId:"b"}])]).outcome).toBe("accepted");
    expect(()=>f.journal.command({kind:"usage_retirement",activityId:"child",scopeId:f.scope.id,key:"b"})).toThrow("activity_scope_invalid");
  });
  it("never revives a retired key and preserves explicit immutable alias chains",()=>{
    const f=fixture();f.prepare();f.bind();
    const a=f.evidence(f.body("body","raw"),{kind:"usage",key:"a",memberships:["tree"]}),b={...a,key:"b"};
    expect(f.accept([f.part(a),f.part(b)]).outcome).toBe("accepted");
    expect(f.accept([f.merge({...b,revision:1},0,[{key:"a",expectedRevision:0},{key:"not-written",expectedRevision:null}],"first")]).outcome).toBe("accepted");
    const alias=f.retirement("a");
    for(const part of [f.part(a),f.part({...a,revision:1},0),f.part({...a,key:"not-written"}),f.merge({...a,revision:1},0,[{key:"b",expectedRevision:1}])])
      expect(f.accept([part]).rejection?.code).toContain("key_retired");
    const c={...a,key:"c"};expect(f.accept([f.merge(c,null,[{key:"b",expectedRevision:1}],"second")]).outcome).toBe("accepted");
    expect(f.retirement("a")).toEqual(alias);expect(f.retirement("b")?.survivor.key).toBe("c");
    expect(f.read("a","usage","a")).toBeNull();expect(f.read("a","usage","b")).toBeNull();expect(f.page()).toEqual({entries:[c],next:null,version:4});
    expect(f.merged("first")?.survivor).toEqual({...b,revision:1});expect(f.merged("second")?.survivor).toEqual(c);
  });
  it("rejects mixed-version paging across updates and merges without hydrating original bodies",()=>{
    const trace:string[]=[],f=fixture(":memory:",true,1,trace);f.prepare();f.bind();
    const a=f.evidence(f.body("large","raw".repeat(50000)),{kind:"usage",key:"a",memberships:["tree"]}),b={...a,key:"b"};
    expect(f.accept([f.part(a),f.part(b)]).outcome).toBe("accepted");trace.length=0;
    const first=f.page(null,undefined,1);expect(first.next).toBe("a");expect(first.version).toBe(2);
    expect(()=>f.page(first.next,undefined,1)).toThrow("page_version_required");
    expect(f.page(first.next,first.version!,1).entries).toEqual([b]);
    expect(f.accept([f.part({...b,revision:1},0)]).outcome).toBe("accepted");
    expect(()=>f.page(first.next,first.version!,1)).toThrow("page_version_conflict");
    const second=f.page(null,undefined,1);expect(second.version).toBe(3);
    expect(f.accept([f.merge({...a,revision:1},0,[{key:"b",expectedRevision:1}])]).outcome).toBe("accepted");
    expect(()=>f.page(second.next,second.version!,1)).toThrow("page_version_conflict");
    expect(f.page().version).toBe(4);f.retirement("b");f.merged();
    expect(trace.some(sql=>sql.includes("protocol_content_chunks"))).toBe(false);
    f.db.prepare("UPDATE protocol_evidence_versions SET version=100").run();expect(()=>f.page()).toThrow("version_corrupt");
  });
  it("reads version and final-page rows in one WAL snapshot despite a concurrent valid connection commit",()=>{
    const directory=mkdtempSync(join(tmpdir(),"protocol-snapshot-"));directories.push(directory);const path=join(directory,"evidence.sqlite"),trace:string[]=[];
    const f=fixture(path,true,1,trace);f.db.pragma("journal_mode=WAL");f.prepare();f.bind();
    const a=f.evidence(f.body("body","native"),{kind:"usage",key:"a",memberships:["tree"]}),b={...a,key:"b"};
    expect(f.accept([f.part(a),f.part(b)]).outcome).toBe("accepted");
    const writer=fixture(path,false,1),updated={...b,revision:1,metadata:{late:true}};let interleaved=false;
    trace.push=(...sqls:string[])=>{
      if(!interleaved&&sqls.some(sql=>sql.startsWith("SELECT m.scope_id"))){
        interleaved=true;expect(writer.accept([writer.part(updated,0)],"adapter","run","other-connection-write").outcome).toBe("accepted");
      }
      return Array.prototype.push.apply(trace,sqls);
    };
    expect(f.page()).toEqual({entries:[a,b],next:null,version:2});expect(interleaved).toBe(true);
    expect(f.page()).toEqual({entries:[a,updated],next:null,version:3});
    expect(()=>f.page("a",2)).toThrow("page_version_conflict");
  });
});
