import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityHandoffProcessor,ActivityPurposeRegistry,ActivityReconsiderationProcessor,activityFactSourceId,
  type ActivityHandoffPort,type ActivityHandoffFact,type ActivityPurposeHandler,type ActivityPathIntent,type ActivityStageState,
  type ActivitySchedulingIntent,type ActivityReconsiderationReceipt,type ActivityReconsiderationSnapshot,
  type SharedAcceptancePort,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {SourceMaterialPublicationWork,type SourceMaterialPublicationRequest} from "@agent-anything/agent-runtime/context-representation";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import {ExecutionDatabase} from "../execution-storage/ExecutionDatabase.js";

const databases:ExecutionDatabase[]=[],directories:string[]=[];
const RUN="root",PATH="source",WORK="source-work",SUBSCRIPTION="source:source-lifecycle";
afterEach(()=>{
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0)) {
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("helarc-source-lifecycle-"))throw new Error("Unsafe cleanup");
    rmSync(directory,{recursive:true,force:true});
  }
});

function open(directory=mkdtempSync(join(tmpdir(),"helarc-source-lifecycle-")),options:{
  authorize?:ActivityPurposeHandler["authorize"];loseClosureReply?:boolean;
}={}) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const activities:ActivityHandoffPort={command:async command=>db.activityHandoffCommand(db.generation,command).activityValue};
  const materials:MaterialCustodyPort={command:async command=>db.materialCustodyCommand(db.generation,command).custodyValue};
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>(),now=()=>"2026-10-31T00:00:00Z";
  const work=new SourceMaterialPublicationWork(activities,registry,{materials,authorize:options.authorize??(async()=>({kind:"allowed"})),now});
  const executor={hostSession:"lifecycle-test",worker:`worker:${db.generation}`,generation:db.generation};
  const processor=new ActivityHandoffProcessor(activities,registry,executor,now);
  const proposals:SharedAcceptanceProposal[]=[];
  let loseClosureReply=options.loseClosureReply??false;
  const acceptance:SharedAcceptancePort={
    accept:async proposal=>{
      proposals.push(structuredClone(proposal));
      const receipt=db.acceptShared(db.generation,proposal).acceptanceValue;
      if(loseClosureReply&&receipt.outcome==="accepted"&&closure(proposal)) {
        loseClosureReply=false;throw new Error("source_closure_reply_lost");
      }
      return receipt;
    },
    query:async id=>db.querySharedAcceptance(db.generation,id),
  };
  const reconsideration=new ActivityReconsiderationProcessor(activities,acceptance,(owner,subscription)=>
    owner==="material-source"&&subscription.id===SUBSCRIPTION?work.lifecycle:null);
  return {db,directory,activities,materials,work,executor,processor,acceptance,reconsideration,proposals};
}
type Fixture=ReturnType<typeof open>;

function request(text="Original retained source\nSecond line remains intact."):SourceMaterialPublicationRequest {
  const bytes=Buffer.from(text),contentDigest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {kind:"source_material_publication",bytesBase64:bytes.toString("base64"),purpose:"task",target:"original-model",
    recipient:{runId:RUN,recipient:"root-agent",purpose:"task"},intent:{id:"custody",instanceId:"instance",activityId:PATH,owner:"material-source",maximumBytes:bytes.length,
      version:{ref:{materialId:"original-source",version:contentDigest},origin:{runId:RUN,owner:"interaction",recordId:"reply:1",revision:"1",occurredAt:"2026-10-31T00:00:00Z"},
        label:"Original report",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:contentDigest,capture:"complete",limitations:[]}}};
}
function intent():Omit<ActivityPathIntent,"purpose"|"owner"> {
  return {id:PATH,runId:RUN,scheduledWorkId:WORK,permissionBasis:"original-grant",resourceScope:PATH,
    maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2099-01-01T00:00:00Z"};
}
function scheduling():ActivitySchedulingIntent {
  return {id:"source-schedule",workId:WORK,runId:RUN,scopeId:"tree",owner:"material-source",allowedPathIds:[PATH],
    decisionId:"original-source",policyRevision:"1",reason:"necessary",delayImpact:"Retain the original report",timing:{kind:"unknown"},
    resources:[{poolId:"local",capability:"material-write",units:1}]};
}
async function submit(f:Fixture,value=request()) {
  await f.activities.command({kind:"bind_resource_pool",pool:{id:"local",revision:"1",authority:"host",capacity:1}});
  const parts=f.work.prepareIndependentSubmission(intent(),value,scheduling());
  expect(await f.acceptance.accept({id:"source-admission",scope:RUN,actor:"material-source",parts})).toMatchObject({outcome:"accepted"});
  return parts;
}
function closure(proposal:SharedAcceptanceProposal):ActivityReconsiderationReceipt|undefined {
  const part=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="reconsideration_acceptance");
  const receipt=part?.proposal as ActivityReconsiderationReceipt|undefined;
  return receipt?.close?receipt:undefined;
}
async function snapshot(f:Fixture) {
  return await f.activities.command({kind:"read_reconsideration",subscriptionId:SUBSCRIPTION,limit:256}) as ActivityReconsiderationSnapshot;
}
async function scan(f:Fixture) {
  const cycle=await f.reconsideration.scan(RUN,new AbortController().signal);
  expect(cycle.failures).toEqual([]);expect(cycle.rejected).toEqual([]);
  return cycle;
}
async function handoffs(f:Fixture,times:number) {
  for(let i=0;i<times;i++)await f.processor.drain(RUN,new AbortController().signal);
}
async function drive(f:Fixture,times=5) {
  for(let i=0;i<times;i++){await handoffs(f,1);await scan(f);}
}
async function expectOpen(f:Fixture) {
  expect(await f.activities.command({kind:"read_schedule",workId:WORK})).toMatchObject({pathsSealed:true,closed:false,settlementConfirmed:false});
  expect((await snapshot(f)).state.closed).toBe(false);
}
async function expectClosed(f:Fixture) {
  expect(await f.activities.command({kind:"read_schedule",workId:WORK})).toMatchObject({pathsSealed:true,closed:true,settlementConfirmed:true});
  expect((await snapshot(f)).state.closed).toBe(true);
  expect(await f.activities.command({kind:"scheduled_settlement",workId:WORK})).toMatchObject({remaining:null});
}
async function expectJointClosure(f:Fixture) {
  const proposal=f.proposals.find(p=>closure(p)&&f.db.querySharedAcceptance(f.db.generation,p.id)?.outcome==="accepted");
  expect(proposal).toBeDefined();
  expect(proposal!.actor).toBe("material-source");
  expect(proposal!.parts).toEqual(expect.arrayContaining([
    expect.objectContaining({owner:"activity",kind:"path_condition",proposal:expect.objectContaining({pathId:PATH,requireSettled:true})}),
    expect.objectContaining({owner:"activity",kind:"scheduling_closure",proposal:expect.objectContaining({workId:WORK,requireSettled:true})}),
    expect.objectContaining({owner:"activity",kind:"reconsideration_acceptance",proposal:expect.objectContaining({id:proposal!.id,subscriptionId:SUBSCRIPTION,close:true,
      decision:expect.objectContaining({owner:"material-source",kind:"source_publication_closed",id:PATH})})}),
  ]));
  await expectClosed(f);
  return proposal!;
}

describe("independent source publication lifecycle",()=>{
  it("jointly admits the exact single-path lifecycle and closes execution without releasing published material",async()=>{
    const f=open(),value=request(),parts=await submit(f,value);
    expect(parts.map(p=>p.kind)).toEqual(["scheduling_acceptance","path_opening","stage_submission","scheduling_path_seal","reconsideration_subscription"]);
    expect(await f.activities.command({kind:"read_stage",requestId:`${PATH}:capture`})).toMatchObject({request:{input:{...value,lifecycle:{revision:"1",scheduling:scheduling()}}}});
    expect((await snapshot(f)).state.subscription).toMatchObject({owner:"material-source",binding:{kind:"activity_path",id:PATH},
      sources:[activityFactSourceId("progress",PATH),activityFactSourceId("control",PATH),activityFactSourceId("scheduling",WORK)]});
    await expectOpen(f);
    expect(await f.activities.command({kind:"scheduled_paths",workId:WORK,expectedRevision:2,afterId:null,limit:1}))
      .toMatchObject({paths:[expect.objectContaining({id:PATH})],nextAfterId:null});
    await drive(f);await expectJointClosure(f);
    const published=await f.work.result(PATH);if(published?.kind!=="published_source_material")throw new Error("Original source not published");
    expect(published.representation).toMatchObject({form:"original",losses:[]});
    expect(await f.materials.command({kind:"read",access:published.access,offset:0,length:1024})).toMatchObject({bytesBase64:value.bytesBase64});
    expect(await f.materials.command({kind:"state",intentId:value.intent.id})).toMatchObject({state:"published"});
    expect(await f.activities.command({kind:"read_path",pathId:PATH})).toMatchObject({cancelled:false,progressRevision:1,dispatchedAttempts:1});
    expect(f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:value.recipient,after:0,through:null,limit:10}).selectionValue)
      .toMatchObject({entries:[]});
  });

  it("recovers cancellation before dispatch and closes without inventing raw evidence",async()=>{
    const f=open();await submit(f);
    await f.activities.command({kind:"cancel",pathId:PATH,expectedControlRevision:0});
    f.db.close();const restored=open(f.directory);
    expect(await restored.activities.command({kind:"pending_scopes",afterRunId:null,limit:16})).toContainEqual({runId:RUN});
    await scan(restored);await expectJointClosure(restored);
    expect(await restored.activities.command({kind:"read_stage",requestId:`${PATH}:capture`}))
      .toMatchObject({status:"submitted",attempt:null,result:null,receipt:null,settlement:null});
    expect(await restored.materials.command({kind:"state",intentId:"custody"})).toBeNull();
    expect(await restored.activities.command({kind:"pending",runId:RUN,after:0,limit:16})).toEqual([]);
  });

  it("retains cleanup responsibility while settlement authorization is temporary, then resumes it without a waiter",async()=>{
    const f=open(undefined,{authorize:async(_path,_stage,_signal,action)=>action==="settlement"?
      {kind:"temporary",code:"cleanup-pending",message:"Original cleanup authority is temporarily unavailable"}:{kind:"allowed"}});
    await submit(f);await handoffs(f,2);
    const original=await f.activities.command({kind:"read_stage",requestId:`${PATH}:capture`}) as ActivityStageState;
    expect(original).toMatchObject({status:"raw_result",result:{value:{kind:"captured"}}});
    await f.activities.command({kind:"cancel",pathId:PATH,expectedControlRevision:0});
    await drive(f,2);await expectOpen(f);
    expect(await f.activities.command({kind:"read_stage",requestId:original.request.id})).toMatchObject({status:"raw_result",result:original.result,settlement:null,
      authorizationRestrictions:{settlement:{kind:"temporary"}}});
    expect(await f.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"complete"});
    expect(f.proposals.some(p=>closure(p))).toBe(false);
    f.db.close();const restored=open(f.directory);
    await drive(restored,2);await expectJointClosure(restored);
    expect(await restored.activities.command({kind:"read_stage",requestId:original.request.id})).toMatchObject({status:"settled",result:original.result,attempt:original.attempt,receipt:null,
      settlement:{resultId:original.result!.id,disposition:{kind:"unpublished_capture_disposed",published:false}}});
    expect(await restored.materials.command({kind:"state",intentId:"custody"})).toMatchObject({state:"deleted"});
    expect(await restored.activities.command({kind:"read_path",pathId:PATH})).toMatchObject({cancelled:true,progressRevision:0,dispatchedAttempts:1});
  });

  it("keeps unknown dispatched work and its lifecycle open across restart",async()=>{
    const authorize:ActivityPurposeHandler["authorize"]=async(_path,_stage,_signal,action)=>action==="reconciliation"?
      {kind:"temporary",code:"reconciliation-pending",message:"Original work cannot yet be confirmed"}:{kind:"allowed"};
    const f=open(undefined,{authorize});await submit(f);
    const original=await f.activities.command({kind:"read_stage",requestId:`${PATH}:capture`}) as ActivityStageState;
    await f.activities.command({kind:"admit",requestId:original.request.id,expectedControlRevision:0});
    await f.activities.command({kind:"dispatch",expectedControlRevision:0,attempt:{id:"original-attempt",requestId:original.request.id,executor:f.executor,
      inputDigest:digest(original.request.input),startedAt:"2026-10-31T00:00:00Z"}});
    await f.activities.command({kind:"save_raw",result:{id:"unknown-result",attemptId:"original-attempt",completeness:"complete",outcome:"unknown",
      value:{unconfirmed:true},usage:null,recordedAt:"2026-10-31T00:00:01Z"}});
    await f.activities.command({kind:"cancel",pathId:PATH,expectedControlRevision:0});
    await drive(f,2);await expectOpen(f);
    f.db.close();const restored=open(f.directory,{authorize});await drive(restored,2);await expectOpen(restored);
    expect(await restored.activities.command({kind:"read_stage",requestId:original.request.id}))
      .toMatchObject({status:"dispatched",attempt:{id:"original-attempt"},rawEvidenceRevision:1,result:null,settlement:null});
    expect(await restored.activities.command({kind:"pending",runId:RUN,pathId:PATH,after:0,limit:16}))
      .toEqual([expect.objectContaining({kind:"reconciliation",requestId:original.request.id})]);
    expect(await restored.activities.command({kind:"scheduled_settlement",workId:WORK})).toMatchObject({remaining:expect.objectContaining({pathId:PATH})});
    expect(restored.proposals.some(p=>closure(p))).toBe(false);
  });

  it("discovers a captured publication after restart and finishes without report delivery polling",async()=>{
    const f=open(),value=request();await submit(f,value);await handoffs(f,2);
    const original=await f.activities.command({kind:"read_stage",requestId:`${PATH}:capture`}) as ActivityStageState;
    expect(original.status).toBe("raw_result");f.db.close();
    const restored=open(f.directory);
    expect(await restored.activities.command({kind:"pending_scopes",afterRunId:null,limit:16})).toContainEqual({runId:RUN});
    await drive(restored,3);await expectJointClosure(restored);
    const published=await restored.work.result(PATH);if(published?.kind!=="published_source_material")throw new Error("Recovered publication missing");
    expect(await restored.materials.command({kind:"read",access:published.access,offset:0,length:1024})).toMatchObject({bytesBase64:value.bytesBase64});
    expect(await restored.activities.command({kind:"read_stage",requestId:original.request.id})).toMatchObject({status:"accepted",attempt:original.attempt,result:original.result,rawEvidenceRevision:1});
    expect(await restored.activities.command({kind:"read_path",pathId:PATH})).toMatchObject({dispatchedAttempts:1});
  });

  it("replays a lost original closure confirmation after reopen without closing twice",async()=>{
    const f=open(undefined,{loseClosureReply:true});await submit(f);await handoffs(f,3);
    const cycle=await f.reconsideration.scan(RUN,new AbortController().signal);
    expect(cycle.failures).toHaveLength(1);expect(cycle.failures[0]!.error).toEqual(new Error("source_closure_reply_lost"));
    const proposal=await expectJointClosure(f),receipt=await f.acceptance.query(proposal.id);
    f.db.close();const restored=open(f.directory);
    expect(await restored.acceptance.query(proposal.id)).toEqual(receipt);
    expect(await restored.acceptance.accept(proposal)).toEqual(receipt);
    expect((await scan(restored)).accepted).toEqual([]);await expectClosed(restored);
    const facts=await restored.activities.command({kind:"facts",runId:RUN,after:0,limit:256}) as readonly ActivityHandoffFact[];
    expect(facts.filter(f=>f.kind==="scheduling_closed")).toHaveLength(1);
    expect(facts.filter(f=>f.kind==="reconsideration_accepted"&&(f.details.receipt as ActivityReconsiderationReceipt|undefined)?.close)).toHaveLength(1);
    const published=await restored.work.result(PATH);if(published?.kind!=="published_source_material")throw new Error("Original material was lost on replay");
    expect(await restored.materials.command({kind:"read",access:published.access,offset:0,length:1024})).toMatchObject({bytesBase64:request().bytesBase64});
  });

  it("rolls back schedule closure when the joint original subscription acceptance is stale",async()=>{
    const f=open();await submit(f);await handoffs(f,3);
    const stale:SharedAcceptancePort={query:f.acceptance.query,accept:async proposal=>{
      const id=`${proposal.id}:stale-subscription`;
      return f.acceptance.accept({...proposal,id,parts:proposal.parts.map(part=>{
        if(part.kind!=="reconsideration_acceptance")return part;
        const receipt=part.proposal as ActivityReconsiderationReceipt;
        return {...part,proposal:{...receipt,id,expectedRevision:receipt.expectedRevision+1}};
      })});
    }};
    const processor=new ActivityReconsiderationProcessor(f.activities,stale,()=>f.work.lifecycle);
    const rejected=await processor.scan(RUN,new AbortController().signal);
    expect(rejected.failures).toEqual([]);expect(rejected.rejected).toEqual([{subscriptionId:SUBSCRIPTION,code:"activity_reconsideration_acceptance_conflict"}]);
    await expectOpen(f);expect((await snapshot(f)).state.revision).toBe(0);
    const facts=await f.activities.command({kind:"facts",runId:RUN,after:0,limit:256}) as readonly ActivityHandoffFact[];
    expect(facts.filter(f=>f.kind==="scheduling_closed")).toEqual([]);
    await scan(f);await expectJointClosure(f);
  });

  it.each([
    ["owner",{owner:"context-representation"}],
    ["run",{runId:"other-run"}],
    ["work",{workId:"borrowed-work"}],
    ["extra path",{allowedPathIds:[PATH,"other-path"]}],
    ["wrong path",{allowedPathIds:["other-path"]}],
    ["delegated owner",{delegatedPathOwners:["context-representation"]}],
  ] satisfies readonly (readonly [string,Partial<ActivitySchedulingIntent>])[])("rejects independent admission with invalid %s",async(_name,change)=>{
    const f=open();
    expect(()=>f.work.prepareIndependentSubmission(intent(),request(),{...scheduling(),...change})).toThrow("source_lifecycle_scope_invalid");
    expect(await f.activities.command({kind:"read_path",pathId:PATH})).toBeNull();
    expect(await f.activities.command({kind:"read_schedule",workId:WORK})).toBeNull();
  });

  it("rejects independent ownership of an open scheduling scope",()=>{
    const f=open(),{allowedPathIds:_,...unbounded}=scheduling();
    expect(()=>f.work.prepareIndependentSubmission(intent(),request(),unbounded)).toThrow("source_lifecycle_scope_invalid");
  });

  it("rejects multi-stage ownership and lifecycle plans smuggled through either submission entry",()=>{
    const f=open(),bound={...request(),lifecycle:{revision:"1" as const,scheduling:scheduling()}};
    expect(()=>f.work.prepareIndependentSubmission({...intent(),maximumStages:2},request(),scheduling())).toThrow("source_lifecycle_scope_invalid");
    expect(()=>f.work.prepareIndependentSubmission(intent(),bound,scheduling())).toThrow("source_lifecycle_already_bound");
    expect(()=>f.work.prepareSubmission(intent(),bound)).toThrow("source_lifecycle_requires_independent_admission");
  });

  it("does not acquire lifecycle closure authority for a shared publication",async()=>{
    const f=open(),value=request(),{allowedPathIds:_,...sharedSchedule}=scheduling();
    await f.activities.command({kind:"bind_resource_pool",pool:{id:"local",revision:"1",authority:"host",capacity:1}});
    const parts=f.work.prepareSubmission(intent(),value);
    expect(parts.map(p=>p.kind)).toEqual(["path_opening","stage_submission"]);
    expect(await f.acceptance.accept({id:"shared-admission",scope:RUN,actor:"material-source",parts:[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:sharedSchedule,expectedRevision:0}},...parts]}))
      .toMatchObject({outcome:"accepted"});
    await drive(f,3);
    const stage=await f.activities.command({kind:"read_stage",requestId:`${PATH}:capture`}) as ActivityStageState;
    expect(stage.status).toBe("accepted");expect(stage.request.input).toEqual(value);
    await expect(snapshot(f)).rejects.toThrow("subscription_missing");
    expect(await f.activities.command({kind:"read_schedule",workId:WORK})).toMatchObject({closed:false,pathsSealed:false,settlementConfirmed:false});
    await f.activities.command({kind:"subscribe_reconsideration",subscription:{id:SUBSCRIPTION,runId:RUN,owner:"material-source",binding:{kind:"activity_path",id:PATH},
      sources:[activityFactSourceId("control",PATH),activityFactSourceId("progress",PATH),activityFactSourceId("scheduling",WORK)]}});
    const cycle=await f.reconsideration.scan(RUN,new AbortController().signal);
    expect(cycle.accepted).toEqual([]);expect(cycle.failures).toHaveLength(1);
    expect(cycle.failures[0]!.error).toEqual(new TypeError("source_lifecycle_original_binding_missing"));
    expect(await f.activities.command({kind:"read_schedule",workId:WORK})).toMatchObject({closed:false,pathsSealed:false});
    expect((await snapshot(f)).state.closed).toBe(false);
  });
});
