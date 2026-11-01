import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import type Database from "better-sqlite3";
import {ActivityHandoffProcessor,ActivityReconsiderationProcessor,ActivityPurposeRegistry,
  type ActivityHandoffPort,type ActivityHandoffCommand,type ActivityPurposeHandler,type ActivityReconsiderationSnapshot,
  type SharedAcceptancePort,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {SourceMaterialPublicationWork,SOURCE_MATERIAL_PUBLICATION_PURPOSE,recipientContextDeliveryId,
  type SourceMaterialPublicationRequest,type PublishedSourceMaterial} from "@agent-anything/agent-runtime/context-representation";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort,MaterialRecipient,MaterialHold} from "@agent-anything/context/custody";
import type {ContextDeliveryState,ContextSelectionPort,ContextSelectionProposal} from "@agent-anything/context/selection";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import {ExecutionDatabase} from "../execution-storage/ExecutionDatabase.js";
import {SharedAcceptanceDatabase} from "../execution-storage/SharedAcceptanceDatabase.js";
import type {ContextSelectionDatabase} from "../execution-storage/ContextSelectionDatabase.js";
import type {ActivityHandoffDatabase} from "../execution-storage/ActivityHandoffDatabase.js";

const databases:ExecutionDatabase[]=[],directories:string[]=[];
const signal=()=>new AbortController().signal,now=()=>"2026-11-01T00:00:00Z";
const lifetime={source:{id:"run-lifetime:root",runId:"root",owner:"runtime"},closedFactId:"run-lifetime:root:closed"};
const recipient={runId:"root",recipient:"agent",purpose:"task"};
afterEach(()=>{
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0)) {
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("helarc-delivery-lifecycle-"))throw new Error("Unsafe cleanup");
    rmSync(directory,{recursive:true,force:true});
  }
});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-delivery-lifecycle-"))) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const a=(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue;
  const activities:ActivityHandoffPort={command:async command=>a(command)};
  const materials:MaterialCustodyPort={command:async command=>db.materialCustodyCommand(db.generation,command).custodyValue};
  const selections:ContextSelectionPort={command:async command=>db.selectionCommand(db.generation,command).selectionValue};
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
  const work=new SourceMaterialPublicationWork(activities,registry,{materials,selections,authorize:async()=>({kind:"allowed"}),now});
  const executor={hostSession:"fixture",worker:`worker:${db.generation}`,generation:db.generation};
  const processor=new ActivityHandoffProcessor(activities,registry,executor,now);
  const proposals:SharedAcceptanceProposal[]=[];
  const acceptance:SharedAcceptancePort={accept:async proposal=>{proposals.push(structuredClone(proposal));return db.acceptShared(db.generation,proposal).acceptanceValue;},
    query:async id=>db.querySharedAcceptance(db.generation,id)};
  const reconsideration=new ActivityReconsiderationProcessor(activities,acceptance,()=>work.deliveries);
  a({kind:"register_fact_source",source:lifetime.source});
  return {db,directory,a,activities,materials,selections,work,processor,executor,acceptance,reconsideration,proposals};
}
type Fixture=ReturnType<typeof open>;
function request(target=recipient):SourceMaterialPublicationRequest {
  const bytes=Buffer.from("Original notification, not a new execution."),hash=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const pathId=`source:${digest(target)}`;
  return {kind:"source_material_publication",bytesBase64:bytes.toString("base64"),recipient:target,purpose:target.purpose,target:"model",
    deliveries:[{id:recipientContextDeliveryId("original-notification",target),sourceId:"notification-record"}],deliveryLifetime:lifetime,
    intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
      version:{ref:{materialId:"notification-body",version:"1"},origin:{runId:"root",owner:"host",recordId:"notification-record",revision:"1",occurredAt:now()},
        label:"Original notification",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:hash,capture:"complete",limitations:[]}}};
}
async function publish(f:Fixture,target:MaterialRecipient=recipient) {
  const value=request(target),id=value.intent.activityId;
  const parts=f.work.prepareSubmission({id,runId:"root",permissionBasis:"original-host",resourceScope:id,maximumStages:1,maximumAttempts:1,
    maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},value);
  expect(await f.acceptance.accept({id:`${id}:submission`,scope:"root",actor:"material-source",parts})).toMatchObject({outcome:"accepted"});
  for(let i=0;i<3;i++)await f.processor.drain("root",signal());
  const result=await f.work.result(id);expect(result?.kind).toBe("published_source_material");
  return {value,published:result as PublishedSourceMaterial,id:value.deliveries![0]!.id};
}
function state(f:Fixture,id:string) {return f.db.selectionCommand(f.db.generation,{kind:"delivery_state",id}).selectionValue as ContextDeliveryState;}
function snapshot(f:Fixture,id:string) {return f.a({kind:"read_reconsideration",subscriptionId:`${id}:lifecycle`,limit:64}) as ActivityReconsiderationSnapshot;}
function end(f:Fixture) {f.a({kind:"publish_fact",fact:{id:lifetime.closedFactId,sourceId:lifetime.source.id,
  ref:{owner:"runtime",kind:"scope_closed",id:"root",revision:"terminal-1"}}});}
async function scan(f:Fixture) {
  const cycle=await f.reconsideration.scan("root",signal());expect(cycle.failures).toEqual([]);expect(cycle.rejected).toEqual([]);return cycle;
}
async function proposal(f:Fixture,id:string,name:string) {
  const original=snapshot(f,id),prepared=await f.work.deliveries!.prepare(original,signal());
  return {id:name,scope:"root",actor:"material-source",parts:[...prepared.participants,{owner:"activity",kind:"reconsideration_acceptance",proposal:{
    id:name,subscriptionId:original.state.subscription.id,expectedRevision:original.state.revision,through:original.through,
    factIds:original.facts.map(f=>f.id),decision:prepared.decision,close:prepared.close,observeSources:prepared.observeSources}}]} satisfies SharedAcceptanceProposal;
}
function select(f:Fixture,p:Awaited<ReturnType<typeof publish>>) {
  const target=p.value.recipient,id=p.id,scope={...target,id:`scope:${id}`,continuity:"original",owner:target.recipient,target:"model",authorityBasis:"host"};
  f.db.selectionCommand(f.db.generation,{kind:"scope",scope});
  const exactInput={messages:[{role:"user",content:"Original notification, not a new execution."}],model:"model"};
  const inputId=`input:${id}`,pathId=`consumer:${id}`,requestId=`${pathId}:model`,selectionId=`selection:${id}`;
  const hold=(responsibility:"input"|"selection"):MaterialHold=>({id:`${responsibility}:${id}`,instanceId:p.value.intent.instanceId,consumer:target,
    responsibility,range:p.published.access.range,basis:responsibility==="input"?inputId:selectionId,releaseCondition:"original responsibility settles"});
  const judgment:RepresentationJudgment={id:`judgment:${id}`,owner:scope.owner,kind:"combination",subjects:[p.published.representation.ref],
    inputs:[p.published.access.range],purpose:target.purpose,target:"model",methodRevision:"fixture:1",dependencies:{inputDigest:digest(exactInput)},
    coverage:[p.published.access.range],conclusion:"supported",limitations:["Controlled input, not a semantic test"],basis:"Exact original notification"};
  f.db.representationCommand(f.db.generation,{kind:"judge",judgment});
  const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"fixture.task",revision:"1"},inputOwner:scope.owner,executionOwner:scope.owner,
    interpretationOwner:scope.owner,acceptanceOwner:scope.owner,recoveryOwner:scope.owner,stageKinds:["model"],capabilities:[],continuationKinds:[]},null);
  f.a({kind:"open_path",intent:{id:pathId,runId:"root",owner:scope.owner,purpose,permissionBasis:"host",resourceScope:pathId,
    maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
  const selection:ContextSelectionProposal={id:`select:${id}`,scopeId:scope.id,expectedSelectionId:null,expectedControlRevision:0,
    selection:{id:selectionId,representations:[p.published.representation.ref],judgmentIds:[judgment.id],holds:[hold("selection")]},
    input:{id:inputId,activityId:pathId,stageRequestId:requestId,scopeId:scope.id,selectionId,exactInput,target:"model",deliveries:[{id,position:"user:0"}],
      holds:[hold("input")],combinationJudgmentId:judgment.id},releaseHolds:[]};
  expect(f.db.acceptShared(f.db.generation,{id:selection.id,scope:"root",actor:scope.owner,parts:[
    {owner:"material_custody",kind:"holds",proposal:{acquire:[hold("input"),hold("selection")],release:[],basis:selection.id}},
    {owner:"context_selection",kind:"selection_input",proposal:selection},
    {owner:"context_delivery",kind:"select",proposal:{inputId,scopeId:scope.id,deliveryIds:[id]}},
    {owner:"activity",kind:"stage_submission",proposal:{id:requestId,pathId,stageKind:"model",input:exactInput,capabilities:[],dependencies:[]}},
  ]}).acceptanceValue).toMatchObject({outcome:"accepted"});
  return {inputId,pathId,requestId,exactInput,owner:scope.owner};
}
function dispatch(f:Fixture,s:ReturnType<typeof select>) {
  f.a({kind:"admit",requestId:s.requestId,expectedControlRevision:0});
  const attempt={id:`${s.requestId}:attempt`,requestId:s.requestId,executor:f.executor,inputDigest:digest(s.exactInput),startedAt:now()};
  f.a({kind:"dispatch",attempt,expectedControlRevision:0});
  f.db.selectionCommand(f.db.generation,{kind:"sent",inputId:s.inputId,attemptId:attempt.id});return attempt;
}
function receive(f:Fixture,s:ReturnType<typeof select>,holdId?:string) {
  const attempt=dispatch(f,s),resultId=`${attempt.id}:raw`,id=`${attempt.id}:accepted`;
  f.a({kind:"save_raw",result:{id:resultId,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{answer:"Received"},usage:null,recordedAt:now()}});
  f.a({kind:"claim_processing",claim:{id:`${id}:claim`,requestId:s.requestId,executor:f.executor,previousClaimId:null},expectedControlRevision:0});
  f.a({kind:"accept",receipt:{id,requestId:s.requestId,resultId,owner:s.owner,expectedProgressRevision:0,progress:{received:true},next:[]},
    executor:f.executor,expectedControlRevision:0,participants:[{owner:"context_delivery",kind:"accept",proposal:{inputId:s.inputId,responseId:resultId,detailHolds:[]}},
      ...(holdId?[{owner:"material_custody",kind:"holds",proposal:{acquire:[],release:[holdId],basis:id}}]:[])]});
  return {id,resultId};
}
function late(f:Fixture,original:SharedAcceptanceProposal,mutate:(db:Database.Database)=>void) {
  const internal=f.db as unknown as {data:Database.Database;activityHandoffs:ActivityHandoffDatabase;contextSelections:ContextSelectionDatabase};
  const shared=new SharedAcceptanceDatabase(internal.data,[internal.activityHandoffs.acceptanceParticipant(),...internal.contextSelections.participants(),
    {owner:"fixture",kinds:["late"],prepare:()=>null,apply:()=>mutate(internal.data)}]);
  return shared.accept({...original,parts:[...original.parts,{owner:"fixture",kind:"late",proposal:null}]});
}

describe("original delivery retention lifecycle",()=>{
  it("publishes responsibility atomically, waits while the recipient scope is open, and recovers the same notification",async()=>{
    const f=open(),p=await publish(f);expect(snapshot(f,p.id).state.closed).toBe(false);
    await scan(f);expect(state(f,p.id)).toMatchObject({selectedInputId:null,acceptedResponseId:null,disposition:null});
    expect(await f.materials.command({kind:"describe",holdId:state(f,p.id).delivery.holdId,recipient})).toBeDefined();
    f.db.close();const restored=open(f.directory);expect((await publish(restored)).id).toBe(p.id);
    expect(snapshot(restored,p.id).state.closed).toBe(false);
    expect(restored.db.contextFoundationFacts("root",0,256).contextFacts.filter(f=>f.owner==="context_delivery"&&f.kind==="published")).toHaveLength(1);
  });
  it("disposes only the unreceived delivery after the original end fact, retains source access, and replays a lost close confirmation",async()=>{
    const f=open(),p=await publish(f);end(f);
    const original=await proposal(f,p.id,"original-close"),accepted=await f.acceptance.accept(original);expect(accepted.outcome).toBe("accepted");
    expect(state(f,p.id)).toMatchObject({acceptedResponseId:null,disposition:{reason:"withdrawn",basis:lifetime.closedFactId}});
    const holdId=state(f,p.id).delivery.holdId;
    await expect(f.materials.command({kind:"describe",holdId,recipient})).rejects.toThrow("material_unavailable");
    expect(await f.materials.command({kind:"read",access:p.published.access,offset:0,length:1024})).toMatchObject({bytesBase64:p.value.bytesBase64});
    f.db.close();const restored=open(f.directory);
    expect(await restored.acceptance.accept(original)).toEqual(accepted);await scan(restored);
    expect(snapshot(restored,p.id).state.closed).toBe(true);
    expect(restored.db.contextFoundationFacts("root",0,256).contextFacts.filter(f=>f.subject===holdId&&f.kind==="hold_released")).toHaveLength(1);
  });
  it("keeps same-Run recipient and purpose deliveries independent without duplicating the original material",async()=>{
    const f=open(),a=await publish(f),b=await publish(f,{...recipient,purpose:"stop"}),c=await publish(f,{...recipient,recipient:"another-agent"});
    expect(new Set([a.id,b.id,c.id]).size).toBe(3);expect([a,b,c].map(p=>p.value.intent.version)).toEqual([a.value.intent.version,a.value.intent.version,a.value.intent.version]);
    const selected=select(f,a),original=state(f,a.id);receive(f,selected,original.delivery.holdId);await scan(f);
    expect(snapshot(f,a.id).state.closed).toBe(true);expect(state(f,a.id).disposition).toBeNull();
    for(const other of [b,c]) {
      expect(snapshot(f,other.id).state.closed).toBe(false);expect(state(f,other.id).acceptedResponseId).toBeNull();
      expect(await f.materials.command({kind:"describe",holdId:state(f,other.id).delivery.holdId,recipient:other.value.recipient})).toBeDefined();
    }
  });
  it("independently releases an accepted delivery when the consumer did not release its delivery hold",async()=>{
    const f=open(),p=await publish(f),selected=select(f,p);receive(f,selected);await scan(f);
    expect(snapshot(f,p.id).state.closed).toBe(true);expect(state(f,p.id).acceptedResponseId).not.toBeNull();
    await expect(f.materials.command({kind:"describe",holdId:state(f,p.id).delivery.holdId,recipient})).rejects.toThrow("material_unavailable");
  });
  it("does not release an unknown selected request after scope end or cancellation",async()=>{
    const f=open(),p=await publish(f),selected=select(f,p),attempt=dispatch(f,selected);end(f);
    f.a({kind:"save_raw",result:{id:"unknown",attemptId:attempt.id,completeness:"partial",outcome:"unknown",value:null,usage:null,recordedAt:now()}});
    f.a({kind:"cancel",pathId:selected.pathId,expectedControlRevision:0});await scan(f);
    expect(state(f,p.id)).toMatchObject({selectionSettled:false,disposition:null});expect(snapshot(f,p.id).state.closed).toBe(false);
    expect(await f.materials.command({kind:"describe",holdId:state(f,p.id).delivery.holdId,recipient})).toBeDefined();
    f.db.close();const restored=open(f.directory);await scan(restored);expect(snapshot(restored,p.id).state.closed).toBe(false);
    restored.a({kind:"save_raw",result:{id:"confirmed-cancel",attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{cancelled:true},usage:null,recordedAt:now()}});
    restored.a({kind:"settle",receipt:{id:"consumer-settled",requestId:selected.requestId,resultId:"confirmed-cancel",owner:selected.owner,disposition:{kind:"cancelled"}},
      executor:restored.executor,expectedControlRevision:1,participants:[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:selected.inputId,basis:"consumer-settled"}}]});
    await scan(restored);expect(snapshot(restored,p.id).state.closed).toBe(true);
    expect(state(restored,p.id)).toMatchObject({selectedInputId:null,acceptedResponseId:null,disposition:{reason:"withdrawn"}});
  });
  it("refuses a raw-only acknowledgement without the original professional acceptance",async()=>{
    const f=open(),p=await publish(f),selected=select(f,p),attempt=dispatch(f,selected);
    f.a({kind:"save_raw",result:{id:"raw-only",attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{answer:"received"},usage:null,recordedAt:now()}});
    expect(f.db.acceptShared(f.db.generation,{id:"invented-receipt",scope:"root",actor:selected.owner,
      parts:[{owner:"context_delivery",kind:"accept",proposal:{inputId:selected.inputId,responseId:"raw-only",detailHolds:[]}}]}).acceptanceValue)
      .toMatchObject({outcome:"rejected",rejection:{code:"delivery_professional_acceptance_missing"}});
    expect(state(f,p.id).acceptedResponseId).toBeNull();
  });
  it("rejects wrong owners and closure without the original subscription, rolling back release",async()=>{
    const f=open(),p=await publish(f);end(f);
    const original=await proposal(f,p.id,"wrong-owner");
    expect(await f.acceptance.accept({...original,actor:"another-agent"})).toMatchObject({outcome:"rejected"});
    expect(await f.acceptance.accept({...original,id:"missing-close",parts:original.parts.filter(part=>part.owner!=="activity")}))
      .toMatchObject({outcome:"rejected",rejection:{code:"delivery_lifecycle_closure_missing"}});
    expect(state(f,p.id).disposition).toBeNull();expect(snapshot(f,p.id).state.closed).toBe(false);
  });
  it.each(["pending","subscription","end-fact"] as const)("rechecks %s after all participants and preserves the original hold on rollback",async change=>{
    const f=open(),p=await publish(f),selected=select(f,p);
    f.a({kind:"cancel",pathId:selected.pathId,expectedControlRevision:0});end(f);
    const original=await proposal(f,p.id,`late-${change}`);
    const receipt=late(f,original,db=>{
      if(change==="pending")db.prepare("UPDATE activity_handoffs SET pending=1 WHERE path_id=? AND kind='admission'").run(selected.pathId);
      else if(change==="subscription")db.prepare("UPDATE activity_reconsiderations SET closed=0 WHERE id=?").run(`${p.id}:lifecycle`);
      else db.prepare("DELETE FROM activity_published_facts WHERE id=?").run(lifetime.closedFactId);
    });
    expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:change==="pending"?"delivery_disposition_unsettled":
      change==="subscription"?"delivery_lifecycle_release_incomplete":"delivery_lifecycle_scope_open"}});
    expect(state(f,p.id).disposition).toBeNull();expect(snapshot(f,p.id).state.closed).toBe(false);
    expect(await f.materials.command({kind:"describe",holdId:state(f,p.id).delivery.holdId,recipient})).toBeDefined();
  });
  it("rejects a stale close after the delivery has been selected by an original request",async()=>{
    const f=open(),p=await publish(f);end(f);const original=await proposal(f,p.id,"stale-close");select(f,p);
    expect(await f.acceptance.accept(original)).toMatchObject({outcome:"rejected"});
    expect(state(f,p.id).disposition).toBeNull();expect(snapshot(f,p.id).state.closed).toBe(false);
  });
  it("rejects the former publication purpose rather than silently adding delivery obligations",async()=>{
    const f=open(),value=request(),old={...SOURCE_MATERIAL_PUBLICATION_PURPOSE,ref:{...SOURCE_MATERIAL_PUBLICATION_PURPOSE.ref,revision:"2"}};
    const purpose=new ActivityPurposeRegistry<null>().register(old,null),id=value.intent.activityId;
    f.a({kind:"open_path",intent:{id,runId:"root",owner:"material-source",purpose,permissionBasis:"host",resourceScope:id,
      maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    f.a({kind:"submit",request:{id:`${id}:capture`,pathId:id,stageKind:"capture",input:value,capabilities:["material-write"],dependencies:[]}});
    await expect(f.work.result(id)).rejects.toThrow("source_publication_path_unavailable");
    expect(f.db.selectionCommand(f.db.generation,{kind:"delivery",id:value.deliveries![0]!.id}).selectionValue).toBeNull();
  });
});
