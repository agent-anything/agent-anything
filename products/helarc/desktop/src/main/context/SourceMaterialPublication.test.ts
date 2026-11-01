import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {ActivityHandoffProcessor,ActivityPurposeRegistry,activityStageEvidence,type ActivityHandoffPort,type ActivityPurposeHandler,type ActivityStageState,type ActivityPathState,type ActivityAuthorizationRefusal} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {SourceMaterialPublicationWork,validateSourceMaterialRequest,type SourceMaterialPublicationRequest} from "@agent-anything/agent-runtime/context-representation";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import type {ContextDeliveryPage} from "@agent-anything/context/selection";
import {ExecutionDatabase} from "../execution-storage/ExecutionDatabase.js";

const databases:ExecutionDatabase[]=[],directories:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const directory of directories.splice(0)) {
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("helarc-source-publication-"))throw new Error("Unsafe cleanup");
  rmSync(directory,{recursive:true,force:true});
}});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-source-publication-")),options:{authorize?:ActivityPurposeHandler["authorize"];now?:()=>string}={}) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const activities:ActivityHandoffPort={command:async command=>db.activityHandoffCommand(db.generation,command).activityValue};
  const materials:MaterialCustodyPort={command:async command=>db.materialCustodyCommand(db.generation,command).custodyValue};
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
  const now=options.now??(()=>"2026-10-30T00:00:00Z");
  const selections={command:async(command:Parameters<import("@agent-anything/context/selection").ContextSelectionPort["command"]>[0])=>db.selectionCommand(db.generation,command).selectionValue};
  const work=new SourceMaterialPublicationWork(activities,registry,{materials,selections,authorize:options.authorize??(async()=>({kind:"allowed"})),now});
  const executor={hostSession:"host",worker:`worker:${db.generation}`,generation:db.generation};
  const processor=new ActivityHandoffProcessor(activities,registry,executor,now);
  return {db,directory,activities,materials,work,processor,registry,executor};
}
function request(text="original source\nwith preserved order"):SourceMaterialPublicationRequest {
  const bytes=Buffer.from(text),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {kind:"source_material_publication",bytesBase64:bytes.toString("base64"),purpose:"task",target:"original-model",
    recipient:{runId:"root",recipient:"root-agent",purpose:"task"},intent:{id:"custody",instanceId:"instance",activityId:"source",owner:"material-source",maximumBytes:bytes.length,
      version:{ref:{materialId:"source-record",version:digest},origin:{runId:"root",owner:"interaction",recordId:"reply:1",revision:"1",occurredAt:"2026-10-30T00:00:00Z"},
        label:"Original reply",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest,capture:"complete",limitations:[]}}};
}
function submit(f:ReturnType<typeof open>,value=request(),deadlineAt="2030-01-01T00:00:00Z") {
  if(value.deliveryLifetime)f.db.activityHandoffCommand(f.db.generation,{kind:"register_fact_source",source:value.deliveryLifetime.source});
  const parts=f.work.prepareSubmission({id:"source",runId:"root",permissionBasis:"original-grant",resourceScope:"source",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt},value);
  expect(f.db.acceptShared(f.db.generation,{id:"source-submission",scope:"root",actor:"material-source",parts}).acceptanceValue.outcome).toBe("accepted");
}
async function drain(f:ReturnType<typeof open>,times=3) {for(let i=0;i<times;i++)await f.processor.drain("root",new AbortController().signal);}

describe("source material publication",()=>{
  const addressed=():SourceMaterialPublicationRequest=>({...request(),deliveries:[{id:"delivery:1",sourceId:"original-notification"}],
    deliveryLifetime:{source:{id:"run-lifetime:root",runId:"root",owner:"runtime"},closedFactId:"run-lifetime:root:closed"}});
  const pending=(f:ReturnType<typeof open>)=>f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:request().recipient,
    after:0,through:null,limit:10}).selectionValue as ContextDeliveryPage;
  it("publishes explicit recipient delivery and its protection with the original source, without selecting or accepting it",async()=>{
    const f=open(),value=addressed();submit(f,value);await drain(f,2);
    expect(pending(f).entries).toEqual([]);
    const raw=await f.activities.command({kind:"read_stage",requestId:"source:capture"}) as ActivityStageState;
    f.db.close();const recovered=open(f.directory);await drain(recovered,1);
    const entries=pending(recovered).entries;expect(entries).toHaveLength(1);
    const delivery=entries[0]!.delivery;
    expect(entries[0]!.selectedInputId).toBeNull();
    expect(delivery).toMatchObject({id:"delivery:1",sourceRunId:"root",sourceId:"original-notification",recipient:value.recipient,
      material:{...value.intent.version.ref,start:0,end:value.intent.version.bytes,coordinate:"bytes"},instanceId:"instance",detailHoldId:null});
    expect(await recovered.materials.command({kind:"describe",holdId:delivery.holdId,recipient:value.recipient})).toMatchObject({
      hold:{responsibility:"delivery",basis:delivery.id,consumer:value.recipient}});
    await expect(recovered.materials.command({kind:"release",holdId:delivery.holdId,basis:"not-yet-received"})).rejects.toThrow();
    expect(await recovered.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"accepted",attempt:raw.attempt,result:raw.result});
    expect(await recovered.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({dispatchedAttempts:1});
    const published=await recovered.work.result("source");
    if(published?.kind!=="published_source_material")throw new Error("Original publication missing");
    expect(await recovered.materials.command({kind:"read",access:published.access,offset:0,length:1024})).toMatchObject({bytesBase64:value.bytesBase64});
    submit(recovered,value);await drain(recovered,1);expect(pending(recovered).entries).toEqual(entries);
    const facts=recovered.db.contextFoundationFacts("root",0,256).contextFacts;
    expect(facts.filter(fact=>fact.owner==="context_delivery").map(fact=>fact.kind)).toEqual(["published"]);
  });
  it("rolls back material, delivery and protection when a later participant refuses the shared publication",async()=>{
    const f=open(),value=addressed();submit(f,value);await drain(f,2);
    const activities:ActivityHandoffPort={command:async command=>f.activities.command(command.kind!=="accept"?command:{...command,
      receipt:{...command.receipt,id:`${command.receipt.id}:rejected-delivery`},participants:[...command.participants??[],
        {owner:"context_delivery",kind:"dispose",proposal:{deliveryId:"delivery:1",recipient:{...value.recipient,runId:"other"},reason:"unavailable",basis:"wrong-recipient"}}]})};
    const processor=new ActivityHandoffProcessor(activities,f.registry,f.executor,()=>"2026-10-30T00:00:00Z");
    await expect(processor.drain("root",new AbortController().signal)).rejects.toMatchObject({errors:[{code:"delivery_disposition_invalid"}]});
    expect(pending(f).entries).toEqual([]);
    expect(await f.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"complete"});
    await expect(f.materials.command({kind:"describe",holdId:`custody:delivery-hold:${modelInputValueDigest("delivery:1")}`,recipient:value.recipient})).rejects.toMatchObject({code:"material_unavailable"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"raw_result",receipt:null});
    expect(await f.work.result("source")).toBeNull();
    f.db.close();const recovered=open(f.directory);await drain(recovered,1);expect(pending(recovered).entries).toHaveLength(1);
    expect(await recovered.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({dispatchedAttempts:1});
  });
  it("does not publish a delivery for a cancelled original capture",async()=>{
    const f=open();submit(f,addressed());await drain(f,2);
    await f.activities.command({kind:"cancel",pathId:"source",expectedControlRevision:0});await drain(f,1);
    expect(pending(f).entries).toEqual([]);
    expect(await f.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"deleted"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"settled",receipt:null});
  });
  it("rejects publication without jointly registering the original delivery responsibility",async()=>{
    const f=open();submit(f,addressed());await drain(f,2);
    const activities:ActivityHandoffPort={command:async command=>f.activities.command(command.kind!=="accept"?command:{...command,
      participants:command.participants?.filter(part=>part.kind!=="reconsideration_subscription")})};
    const processor=new ActivityHandoffProcessor(activities,f.registry,f.executor,()=>"2026-10-30T00:00:00Z");
    await expect(processor.drain("root",new AbortController().signal)).rejects.toMatchObject({errors:[{code:"delivery_lifecycle_subscription_missing"}]});
    expect(pending(f).entries).toEqual([]);
    expect(await f.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"complete"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"raw_result",receipt:null});
  });
  it("rejects ambiguous or missing original delivery identities",()=>{
    const value=addressed(),delivery=value.deliveries![0]!;
    for(const deliveries of [[delivery,delivery],[{...delivery,id:" "}],[{...delivery,sourceId:""}]])
      expect(()=>validateSourceMaterialRequest({...value,deliveries})).toThrow("source_publication_delivery_invalid");
  });
  const denied:ActivityAuthorizationRefusal={kind:"denied",code:"source_publication_denied",message:"Original source grant revoked",
    decision:{owner:"permission",id:"source-grant:denial",revision:"2"}};
  it("accepts an expired undispatched source as unavailable without fabricating execution",async()=>{
    const f=open();submit(f,request(),"2000-01-01T00:00:00Z");await drain(f,1);
    const result=await f.work.result("source");expect(result).toMatchObject({kind:"source_material_unavailable",limitation:{kind:"deadline"}});
    const stage=await f.activities.command({kind:"read_stage",requestId:"source:capture"}) as ActivityStageState;
    expect(stage).toMatchObject({status:"stopped",attempt:null,result:null,receipt:null,settlement:null});
    expect(await f.materials.command({kind:"state",intentId:"custody"})).toBeNull();
    expect(await f.activities.command({kind:"pending",runId:"root",after:0,limit:10})).toEqual([]);
    const stop=stage.stop!;expect(f.db.querySharedAcceptance(f.db.generation,stop.id)?.outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);await drain(restored,1);
    expect(await restored.work.result("source")).toEqual(result);
    expect(await restored.activities.command({kind:"stop_professional_path",receipt:stop})).toMatchObject({stop,status:"stopped"});
    const facts=await restored.activities.command({kind:"facts",runId:"root",after:0,limit:64}) as import("@agent-anything/agent-runtime/activity").ActivityHandoffFact[];
    expect(facts.filter(f=>f.kind==="professional_stopped")).toHaveLength(1);
    expect(facts.some(f=>["dispatched","raw_saved","settled"].includes(f.kind))).toBe(false);
  });
  it("retains terminal original denial through restart rather than consulting a new permissive default",async()=>{
    const f=open();submit(f);
    const stage=await f.activities.command({kind:"read_stage",requestId:"source:capture"}) as ActivityStageState;
    await f.activities.command({kind:"record_authorization_restriction",requestId:stage.request.id,expectedControlRevision:0,
      expectedStageEvidence:activityStageEvidence(stage),action:"admission",refusal:denied});
    f.db.close();let authorizationCalls=0;
    const recovered=open(f.directory,{authorize:async()=>{authorizationCalls++;return {kind:"allowed"};}});await drain(recovered,1);
    expect(authorizationCalls).toBe(0);
    expect(await recovered.work.result("source")).toMatchObject({kind:"source_material_unavailable",limitation:{kind:"authorization",action:"admission",refusal:denied}});
  });
  it("permits temporary authorization recovery without inventing a terminal outcome",async()=>{
    let allowed=false;
    const f=open(undefined,{authorize:async()=>allowed?{kind:"allowed"}:{kind:"temporary",code:"grant_pending",message:"Await original authority"}});
    submit(f);await drain(f,1);expect(await f.work.result("source")).toBeNull();
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"submitted",attempt:null,stop:null});
    allowed=true;await drain(f,3);
    expect(await f.work.result("source")).toMatchObject({kind:"published_source_material"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({authorizationRestrictions:{},stop:null});
  });
  it("stops publication of a captured result but separately authorizes and resumes cleanup",async()=>{
    let allowCleanup=false;const actions:string[]=[];
    const f=open(undefined,{authorize:async(_path,_stage,_signal,action)=>{
      actions.push(action);if(action==="interpretation")return denied;
      if(action==="settlement"&&!allowCleanup)return {kind:"temporary",code:"cleanup_grant_pending",message:"Cleanup authority pending"};
      return {kind:"allowed"};
    }});submit(f);await drain(f,2);
    const original=await f.activities.command({kind:"read_stage",requestId:"source:capture"}) as ActivityStageState;
    await drain(f,1);expect(await f.work.result("source")).toMatchObject({kind:"source_material_unavailable"});
    await drain(f,1);expect(await f.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"complete"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"raw_result",result:original.result,settlement:null});
    f.db.close();allowCleanup=true;const restored=open(f.directory);await drain(restored,1);
    expect(await restored.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"deleted"});
    expect(await restored.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"settled",result:original.result,attempt:original.attempt});
    expect(await restored.work.result("source")).toMatchObject({kind:"source_material_unavailable"});
    expect(actions).toContain("settlement");
  });
  it("does not invalidate a complete original result or successful publication at a later deadline",async()=>{
    let now="2026-10-30T00:00:00Z";const f=open(undefined,{now:()=>now});submit(f);await drain(f,2);
    now="2031-01-01T00:00:00Z";await drain(f,1);
    const published=await f.work.result("source");expect(published).toMatchObject({kind:"published_source_material"});
    await drain(f,2);expect(await f.work.result("source")).toEqual(published);
    expect(await f.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({cancelled:false,progressRevision:1});
  });
  it("rejects stale authorization observation when an original dispatch won the race",async()=>{
    let f:ReturnType<typeof open>;
    f=open(undefined,{authorize:async(_path,stage,_signal,action)=>{
      if(action!=="execution")return {kind:"allowed"};
      await f.activities.command({kind:"dispatch",expectedControlRevision:0,attempt:{id:"original-attempt",requestId:stage.request.id,
        executor:f.executor,inputDigest:modelInputValueDigest(stage.request.input),startedAt:"2026-10-30T00:00:00Z"}});
      return denied;
    }});submit(f);await drain(f,1);
    const result=await f.processor.scan("root",new AbortController().signal);
    expect(result.failures).toEqual([]);expect(result.pending).toContainEqual({requestId:"source:capture",reason:"stage_evidence_changed"});
    expect(await f.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"dispatched",attempt:{id:"original-attempt"},result:null,stop:null});
    expect(await f.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({cancelled:false,progressRevision:0});
  });
  it("publishes original material, independent owner/consumer protection and representation together",async()=>{
    const f=open();submit(f);await drain(f);
    const result=await f.work.result("source");if(result?.kind!=="published_source_material")throw new Error("Original publication missing");expect(result.representation.form).toBe("original");
    expect(result?.representation.losses).toEqual([]);
    expect(result?.access.recipient).toEqual(request().recipient);
    expect(await f.materials.command({kind:"read",access:result!.access,offset:0,length:1024})).toMatchObject({bytesBase64:request().bytesBase64});
    expect(await f.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({progressRevision:1,dispatchedAttempts:1});
    expect(f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:request().recipient,after:0,through:null,limit:10}).selectionValue).toMatchObject({entries:[]});
  });
  it("reopens captured raw work and publishes without capturing again",async()=>{
    const f=open();submit(f);await drain(f,2);
    const stage=await f.activities.command({kind:"read_stage",requestId:"source:capture"}) as ActivityStageState;
    expect(stage.result?.value).toMatchObject({kind:"captured"});f.db.close();
    const recovered=open(f.directory);await drain(recovered,1);
    expect(await recovered.work.result("source")).not.toBeNull();
    expect(await recovered.activities.command({kind:"read_path",pathId:"source"})).toMatchObject({dispatchedAttempts:1,progressRevision:1});
  });
  it("disposes cancelled unpublished capture independently without publishing or advancing",async()=>{
    const f=open();submit(f);await drain(f,2);
    await f.activities.command({kind:"cancel",pathId:"source",expectedControlRevision:0});f.db.close();
    const recovered=open(f.directory);await drain(recovered,1);
    expect(await recovered.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"deleted"});
    const path=await recovered.activities.command({kind:"read_path",pathId:"source"}) as ActivityPathState;
    expect(path.progressRevision).toBe(0);expect(await recovered.work.result("source")).toBeNull();
    expect(await recovered.activities.command({kind:"read_stage",requestId:"source:capture"})).toMatchObject({status:"settled"});
  });
  it("rejects mismatched original bytes, cross-Run implicit transfer and changed original capture identity",async()=>{
    const f=open(),value=request();
    expect(()=>validateSourceMaterialRequest({...value,bytesBase64:Buffer.from("changed").toString("base64")})).toThrow("content_invalid");
    expect(()=>validateSourceMaterialRequest({...value,recipient:{...value.recipient,runId:"child"}})).toThrow("request_invalid");
    submit(f);await drain(f,2);
    expect(()=>submit(f,request("different source"))).toThrow();
  });
});
