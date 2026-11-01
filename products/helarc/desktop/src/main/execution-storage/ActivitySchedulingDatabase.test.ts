import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import SqliteDatabase from "better-sqlite3";
import {ActivityPurposeRegistry,type ActivityHandoffCommand,type ActivitySchedulingIntent,type ActivityStageState,type ActivityDispatchReceipt,type ActivitySchedulingAcceptance} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ExecutionDatabase} from "./ExecutionDatabase.js";

const roots:string[]=[],databases:ExecutionDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const root of roots.splice(0)){
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith("helarc-scheduling-"))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true});
}});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-scheduling-"))) {
  if(!roots.includes(directory))roots.push(directory);const db=new ExecutionDatabase(directory);databases.push(db);
  const send=(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue;
  send({kind:"bind_resource_pool",pool:{id:"model",revision:"1",authority:"test-host",capacity:1}});
  const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"test-schedule",revision:"1"},inputOwner:"method",executionOwner:"provider",interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["model","local"],capabilities:["model"],continuationKinds:["stage_request"]},null);
  const intent=(id:string,runId=id,reason:ActivitySchedulingIntent["reason"]="opportunity"):ActivitySchedulingIntent=>({id:`${id}:schedule:1`,workId:id,runId,scopeId:runId,owner:"method",decisionId:`${id}:decision`,policyRevision:"1",reason,delayImpact:"next input may need this result",timing:{kind:"unknown"},resources:[{poolId:"model",capability:"model",units:1}]});
  const work=(id:string,runId=id,reason:ActivitySchedulingIntent["reason"]="opportunity")=>{
    send({kind:"schedule_work",intent:intent(id,runId,reason),expectedRevision:0});
    send({kind:"open_path",intent:{id:`${id}:path`,runId,owner:"method",purpose,permissionBasis:"test",resourceScope:id,maximumStages:100,maximumAttempts:100,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z",scheduledWorkId:id}});
  };
  const stage=(id:string,index=0,model=true)=>{
    const request={id:`${id}:stage:${index}`,pathId:`${id}:path`,stageKind:model?"model":"local",input:{index},capabilities:model?["model"]:[],dependencies:[]};
    send({kind:"submit",request});send({kind:"admit",requestId:request.id,expectedControlRevision:0});return request;
  };
  const dispatch=(id:string)=>{
    const stage=send({kind:"read_stage",requestId:id}) as ActivityStageState;
    return send({kind:"dispatch",attempt:{id:`${id}:attempt`,requestId:id,executor:{hostSession:"test",worker:"test",generation:db.generation},inputDigest:modelInputValueDigest(stage.request.input),startedAt:new Date().toISOString()},expectedControlRevision:0}) as ActivityDispatchReceipt;
  };
  const finish=(requestId:string)=>{send({kind:"save_raw",result:{id:`${requestId}:raw`,attemptId:`${requestId}:attempt`,completeness:"complete",outcome:"returned",value:"done",usage:null,recordedAt:new Date().toISOString()}});};
  const candidates=()=>send({kind:"scheduling_candidates",limit:256}) as readonly {requestId:string;workId:string}[];
  return {db,directory,send,work,stage,intent,dispatch,finish,candidates};
}

describe("durable shared activity scheduling",()=>{
  it("includes accepted work before its first path exists, without inventing a purpose or execution",()=>{
    const f=open();f.send({kind:"schedule_work",intent:f.intent("before-path","tree"),expectedRevision:0});
    const view=f.send({kind:"read_work_view",scopeId:"tree",limit:8});
    expect(view).toMatchObject({scopeId:"tree",hasMore:false,items:[{workId:"before-path",runId:"tree",pathId:null,purpose:null,
      owner:"method",closed:false,pathsSealed:false,settlementConfirmed:false,stages:[],pendingInputs:0}]});
    expect(f.send({kind:"read_work_view",scopeId:"tree",limit:8})).toEqual(view);
  });
  it("reads bounded work metadata and recorded queues without dispatching, hydrating inputs or changing facts",()=>{
    const f=open();f.work("a","tree","task");f.work("b","tree","opportunity");
    const a=f.stage("a"),b=f.stage("b");f.dispatch(a.id);
    expect(()=>f.dispatch(b.id)).toThrow();
    const view=f.send({kind:"read_work_view",scopeId:"tree",limit:8}) as import("@agent-anything/agent-runtime/activity").ActivityWorkView;
    expect(view.items).toHaveLength(2);expect(view.hasMore).toBe(false);
    expect(view.items[0]).toMatchObject({workId:"a",runId:"tree",reason:"task",purpose:{id:"test-schedule",revision:"1"},
      stages:[{requestId:a.id,status:"dispatched",capabilities:["model"],schedulingWait:null}]});
    expect(view.items[1]).toMatchObject({workId:"b",stages:[{status:"admitted",schedulingWait:"resource_occupied"}]});
    expect(view.items.every(item=>item.stages.every(stage=>!("input" in stage)))).toBe(true);
    expect(f.send({kind:"read_work_view",scopeId:"tree",limit:8})).toEqual(view);
    expect(f.send({kind:"read_work_view",scopeId:"tree",limit:1})).toMatchObject({hasMore:true,items:[{workId:"a"}]});
    expect(f.send({kind:"read_work_view",scopeId:"other",limit:8})).toMatchObject({items:[],hasMore:false});
    f.finish(a.id);
    const received=f.send({kind:"read_work_view",scopeId:"tree",limit:8}) as import("@agent-anything/agent-runtime/activity").ActivityWorkView;
    expect(received.revision).toBeGreaterThan(view.revision);expect(received.items[0]!.stages[0]!.status).toBe("raw_result");
    expect(()=>f.send({kind:"read_work_view",scopeId:"tree",limit:129})).toThrow("bound_invalid");
  });
  it("jointly creates, admits and seals original work, retaining the same acceptance across reopen",()=>{
    const f=open();f.work("template");
    const original=f.send({kind:"read_path",pathId:"template:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    const intent={...f.intent("a"),allowedPathIds:["a:path"]};
    const proposal={id:"joint-admission",scope:"a",actor:"method",parts:[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent,expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:{...original.intent,id:"a:path",runId:"a",scheduledWorkId:"a"}},
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"fixed original scope"}}]};
    const accepted=f.db.acceptShared(f.db.generation,proposal).acceptanceValue;expect(accepted.outcome).toBe("accepted");
    expect(f.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:true,closed:false,revision:2});
    f.db.close();const restored=open(f.directory);
    expect(restored.db.acceptShared(restored.db.generation,proposal).acceptanceValue).toEqual(accepted);
    expect(()=>restored.send({kind:"open_path",intent:{...original.intent,id:"a:foreign",runId:"a",scheduledWorkId:"a"}})).toThrow();
  });
  it.each(["missing","foreign","stale"] as const)("does not use a proposed creation to bypass actual sealing scope (%s)",mode=>{
    const f=open();if(mode==="foreign")f.work("a");
    const actor=mode==="foreign"?"intruder":"method";
    const parts:import("@agent-anything/agent-runtime/activity").SharedAcceptancePart[]=[];
    if(mode!=="missing")parts.push({owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:{...f.intent("a"),owner:actor},expectedRevision:0}});
    parts.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:"a",expectedRevision:mode==="stale"?2:1,basis:"bad creation"}});
    expect(f.db.acceptShared(f.db.generation,{id:`reject-${mode}`,scope:"a",actor,parts}).acceptanceValue.outcome).toBe("rejected");
    expect(f.send({kind:"read_schedule",workId:"a"})).toEqual(mode==="foreign"?expect.objectContaining({pathsSealed:false,revision:1}):null);
  });
  it("durably confirms late settlement after service was closed, without reopening or duplicate facts",()=>{
    const f=open();f.work("a");const request=f.stage("a");f.dispatch(request.id);
    f.send({kind:"close_scheduled_work",workId:"a",expectedRevision:1,basis:"no-new-service"});
    expect(f.send({kind:"read_schedule",workId:"a"})).toMatchObject({closed:true,pathsSealed:false,settlementConfirmed:false,revision:2});
    f.send({kind:"seal_scheduled_paths",workId:"a",expectedRevision:2,basis:"freeze-existing-closure"});
    const close={kind:"close_scheduled_work" as const,workId:"a",expectedRevision:3,basis:"finally-settled",requireSettled:true};
    expect(()=>f.send(close)).toThrow("responsibility_unsettled");
    f.send({kind:"cancel",pathId:"a:path",expectedControlRevision:0});f.finish(request.id);
    f.send({kind:"settle",receipt:{id:"settled",requestId:request.id,resultId:`${request.id}:raw`,owner:"method",disposition:{kind:"retained"}},
      executor:{hostSession:"test",worker:"recovery",generation:f.db.generation},expectedControlRevision:1});
    expect(()=>f.send({...close,expectedRevision:2})).toThrow("revision_conflict");
    expect(f.send(close)).toMatchObject({closed:true,pathsSealed:true,settlementConfirmed:true,revision:4});
    f.db.close();const reopened=open(f.directory);
    expect(reopened.send(close)).toMatchObject({settlementConfirmed:true,revision:4});
    const facts=reopened.send({kind:"facts",runId:"a",after:0,limit:256}) as readonly import("@agent-anything/agent-runtime/activity").ActivityHandoffFact[];
    expect(facts.filter(f=>f.kind==="scheduling_closed").map(f=>f.details.settlementChecked)).toEqual([false,true]);
    expect(reopened.candidates()).toEqual([]);
  });
  it.each(["need-first","close-first"])("rolls back a closure competing with input delegation (%s)",order=>{
    const f=open();f.work("a");
    const stage={id:"input",pathId:"a:path",stageKind:"local",capabilities:[],dependencies:[]};
    const need={id:"need",supplier:"method",stage,unavailableStage:{...stage,id:"unavailable"}};
    const registration={owner:"activity",kind:"input_need",proposal:need};
    const closing=[{owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"exit"}},
      {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:"a",expectedRevision:2,basis:"settled",requireSettled:true}}];
    expect(f.db.acceptShared(f.db.generation,{id:order,scope:"a",actor:"method",parts:order==="need-first"?[registration,...closing]:[...closing,registration]}).acceptanceValue).toMatchObject({outcome:"rejected"});
    f.db.close();const restored=open(f.directory);
    expect(restored.send({kind:"read_input_need",id:need.id})).toBeNull();
    expect(restored.send({kind:"pending_reconsiderations",runId:"a",afterId:null,limit:16})).toEqual([]);
    expect(restored.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:false,closed:false,revision:1});
  });
  it("retains an unanswered need until its own consumer is cancelled, preserving registration replay",()=>{
    const f=open();f.work("a");
    const stage={id:"input",pathId:"a:path",stageKind:"local",capabilities:[],dependencies:[]};
    const need={id:"need",supplier:"method",stage,unavailableStage:{...stage,id:"unavailable"}};
    f.send({kind:"register_input_need",need});f.send({kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"exit"});
    const close={kind:"close_scheduled_work" as const,workId:"a",expectedRevision:2,basis:"settled",requireSettled:true};
    expect(()=>f.send(close)).toThrow("responsibility_unsettled");
    f.send({kind:"cancel",pathId:"a:path",expectedControlRevision:0});f.send(close);
    expect(f.send({kind:"register_input_need",need})).toEqual(need);
    expect(f.send({kind:"read_stage",requestId:"unavailable"})).toBeNull();
    expect(()=>f.send({kind:"register_input_need",need:{...need,id:"late",stage:{...stage,id:"late-input"},unavailableStage:{...stage,id:"late-unavailable"}}})).toThrow("path_binding_invalid");
  });
  it("checks mixed-owner settlement without granting authority over delegated source paths",()=>{
    const f=open();f.work("sample");
    const base=f.send({kind:"read_path",pathId:"sample:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    const purpose=new ActivityPurposeRegistry<null>().register({...base.intent.purpose.contract,ref:{id:"source",revision:"1"},inputOwner:"material-source",
      executionOwner:"material-source",interpretationOwner:"material-source",acceptanceOwner:"material-source",recoveryOwner:"material-source"},null);
    f.send({kind:"schedule_work",intent:{...f.intent("mixed","root"),owner:"crm",delegatedPathOwners:["material-source"]},expectedRevision:0});
    f.send({kind:"open_path",intent:{...base.intent,id:"source:path",runId:"root",owner:"material-source",purpose,scheduledWorkId:"mixed"}});
    const request=f.stage("source",0,false);
    const close={owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:"mixed",expectedRevision:2,basis:"settled",requireSettled:true}};
    const shared=(id:string,parts:readonly {owner:string;kind:string;proposal:unknown}[])=>f.db.acceptShared(f.db.generation,{id,scope:"root",actor:"crm",parts}).acceptanceValue;
    f.send({kind:"seal_scheduled_paths",workId:"mixed",expectedRevision:1,basis:"exit"});
    expect(shared("not-settled",[close])).toMatchObject({outcome:"rejected",rejection:{code:"activity_schedule_responsibility_unsettled"}});
    expect(shared("no-cancel-right",[{owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:"source:path",expectedControlRevision:0}}])).toMatchObject({outcome:"rejected",rejection:{code:"activity_cancellation_scope_invalid"}});
    f.dispatch(request.id);f.finish(request.id);
    const executor={hostSession:"test",worker:"source",generation:f.db.generation};
    f.send({kind:"claim_processing",claim:{id:"source-claim",requestId:request.id,previousClaimId:null,executor},expectedControlRevision:0});
    f.send({kind:"accept",receipt:{id:"source-accepted",requestId:request.id,resultId:`${request.id}:raw`,owner:"material-source",expectedProgressRevision:0,progress:{published:true},next:[]},executor,expectedControlRevision:0});
    expect(shared("settled",[close])).toMatchObject({outcome:"accepted"});
    expect(f.send({kind:"read_path",pathId:"source:path"})).toMatchObject({cancelled:false,progress:{published:true}});
  });
  it("seals only path admission, preserving original dispatch, successors and treatment changes",()=>{
    const f=open();f.work("a");const first=f.stage("a");
    const original=f.send({kind:"read_path",pathId:"a:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    expect(()=>f.send({kind:"seal_scheduled_paths",workId:"a",expectedRevision:0,basis:"exit"})).toThrow("revision_conflict");
    const seal={kind:"seal_scheduled_paths" as const,workId:"a",expectedRevision:1,basis:"exit"};
    expect(f.send(seal)).toMatchObject({pathsSealed:true,closed:false,revision:2});
    expect(f.send(seal)).toMatchObject({revision:2});
    f.send({kind:"open_path",intent:original.intent});
    expect(()=>f.send({kind:"open_path",intent:{...original.intent,id:"late"}})).toThrow("paths_sealed");
    f.dispatch(first.id);f.finish(first.id);f.stage("a",1);
    const intent={...f.intent("a"),id:"a:promote",reason:"necessary" as const};
    expect(f.send({kind:"schedule_work",intent,expectedRevision:2})).toMatchObject({pathsSealed:true,revision:3});
    f.db.close();const restored=open(f.directory);
    expect(restored.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:true,closed:false});
    expect(()=>restored.send({kind:"open_path",intent:{...original.intent,id:"late"}})).toThrow("paths_sealed");
    expect(restored.dispatch("a:stage:1").granted).toBe(true);
    restored.send({kind:"close_scheduled_work",workId:"a",expectedRevision:3,basis:"no-new-service"});
    restored.send({kind:"submit",request:first});
    expect(()=>restored.stage("a",2)).toThrow("path_binding_invalid");
  });
  it("enumerates sealed membership by indexed work scope beyond shared-acceptance part limits",()=>{
    const f=open();f.work("a");f.work("other","a");
    const original=f.send({kind:"read_path",pathId:"a:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    for(let i=0;i<270;i++)f.send({kind:"open_path",intent:{...original.intent,id:`a:path:${String(i).padStart(3,"0")}`}});
    const query={kind:"scheduled_paths" as const,workId:"a",expectedRevision:1,afterId:null,limit:64};
    expect(()=>f.send(query)).toThrow("paths_not_sealed");
    f.send({kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"freeze"});
    expect(()=>f.send(query)).toThrow("revision_conflict");
    let afterId:string|null=null;const ids:string[]=[];
    do {
      const page=f.send({...query,expectedRevision:2,afterId}) as import("@agent-anything/agent-runtime/activity").ActivityScheduledPathPage;
      expect(page.paths.length).toBeLessThanOrEqual(64);ids.push(...page.paths.map(path=>path.id));afterId=page.nextAfterId;
    } while(afterId!==null);
    expect(ids).toHaveLength(271);expect(new Set(ids).size).toBe(271);expect(ids.includes("other:path")).toBe(false);
    const reader=new SqliteDatabase(join(f.directory,"execution.sqlite"),{readonly:true});
    try {
      const page=reader.prepare("EXPLAIN QUERY PLAN SELECT id,intent,digest FROM activity_paths WHERE json_extract(intent,'$.scheduledWorkId')=? AND id>? ORDER BY id LIMIT ?").all("a","",65) as {detail:string}[];
      expect(page.some(row=>row.detail.includes("USING INDEX activity_paths_scheduled_work"))).toBe(true);
      expect(page.some(row=>row.detail.includes("TEMP B-TREE"))).toBe(false);
      const settled=reader.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM activity_paths p WHERE json_extract(p.intent,'$.scheduledWorkId')=? AND EXISTS (SELECT 1 FROM activity_handoffs h WHERE h.path_id=p.id AND h.pending=1) LIMIT 1").all("a") as {detail:string}[];
      expect(settled.some(row=>row.detail.startsWith("SCAN "))).toBe(false);
      expect(settled.some(row=>row.detail.includes("activity_handoff_path_pending"))).toBe(true);
    } finally {reader.close();}
    expect(f.send({kind:"close_scheduled_work",workId:"a",expectedRevision:2,basis:"settled",requireSettled:true})).toMatchObject({closed:true});
  });
  it("does not equate sealing, a saved response, cancellation or unknown occupancy with settlement",()=>{
    const f=open();f.work("a");const stage=f.stage("a");f.dispatch(stage.id);
    const close={kind:"close_scheduled_work" as const,workId:"a",expectedRevision:2,basis:"exit",requireSettled:true};
    expect(()=>f.send({...close,expectedRevision:1})).toThrow("paths_not_sealed");
    f.send({kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"exit"});
    f.send({kind:"cancel",pathId:"a:path",expectedControlRevision:0});
    f.send({kind:"save_raw",result:{id:"unknown",attemptId:`${stage.id}:attempt`,completeness:"complete",outcome:"unknown",value:null,usage:null,recordedAt:new Date().toISOString()}});
    expect(()=>f.send(close)).toThrow("responsibility_unsettled");
    f.finish(stage.id);expect(()=>f.send(close)).toThrow("responsibility_unsettled");
    const current=f.send({kind:"read_stage",requestId:stage.id}) as ActivityStageState;
    f.send({kind:"settle",receipt:{id:"settled",requestId:stage.id,resultId:current.result!.id,owner:"method",disposition:{kind:"retained"}},
      executor:{hostSession:"test",worker:"recovery",generation:f.db.generation},expectedControlRevision:1});
    expect(f.send(close)).toMatchObject({closed:true,pathsSealed:true,revision:3});
    expect(f.send({kind:"read_stage",requestId:stage.id})).toMatchObject({result:{value:"done"},settlement:{id:"settled"}});
  });
  it("jointly closes the original scope without granting a caller foreign path control",()=>{
    const f=open();f.work("a");const original=f.send({kind:"read_path",pathId:"a:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    const shared=(id:string,parts:readonly {owner:string;kind:string;proposal:unknown}[],actor="method")=>f.db.acceptShared(f.db.generation,{id,scope:"a",actor,parts}).acceptanceValue;
    const seal={owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:"a",expectedRevision:1,basis:"exit"}};
    expect(shared("foreign",[seal],"other")).toMatchObject({outcome:"rejected",rejection:{code:"activity_closure_scope_invalid"}});
    expect(shared("late-opening",[seal,{owner:"activity",kind:"path_opening",proposal:{...original.intent,id:"late"}}])).toMatchObject({outcome:"rejected"});
    expect(f.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:false,revision:1});
    const close={owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:"a",expectedRevision:2,basis:"settled",requireSettled:true}};
    const submit={owner:"activity",kind:"stage_submission",proposal:{id:"late-stage",pathId:"a:path",stageKind:"local",input:{},capabilities:[],dependencies:[]}};
    expect(shared("late-stage",[seal,close,submit])).toMatchObject({outcome:"rejected"});
    expect(f.send({kind:"read_stage",requestId:"late-stage"})).toBeNull();
    expect(f.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:false,closed:false,revision:1});
    expect(shared("closed",[seal,close])).toMatchObject({outcome:"accepted"});
    f.db.close();const recovered=open(f.directory);
    expect(recovered.send({kind:"read_schedule",workId:"a"})).toMatchObject({pathsSealed:true,closed:true,revision:3});
  });
  it("serves opportunity preparation before obstruction under continuous task traffic",()=>{
    const f=open();f.work("task","root","task");f.work("prepare","root");
    const a=f.stage("task"),b=f.stage("prepare");
    expect(f.candidates().map(c=>c.workId)).toEqual(["task","prepare"]);
    f.dispatch(a.id);expect(f.candidates()).toEqual([]);
    f.finish(a.id);const a2=f.stage("task",1);
    expect(f.candidates().map(c=>c.workId)).toEqual(["prepare"]);
    expect(()=>f.dispatch(a2.id)).toThrow("not_ready");
    expect(f.dispatch(b.id).scheduling).toMatchObject({workId:"prepare",round:1});
    f.finish(b.id);expect(f.candidates()[0]?.workId).toBe("task");
  });
  it("interleaves recipient scopes then original works without letting arrivals extend a round",()=>{
    const f=open();f.work("root-task","root","task");f.work("root-prepare","root");f.work("child-task","child","task");
    const a=f.stage("root-task"),b=f.stage("root-prepare"),c=f.stage("child-task");
    expect(f.candidates().map(c=>c.workId)).toEqual(["root-task","child-task","root-prepare"]);
    f.dispatch(a.id);f.finish(a.id);f.stage("root-task",1);
    f.work("new-child","another","task");f.stage("new-child");
    expect(f.candidates().map(c=>c.workId)).toEqual(["child-task"]);
    f.dispatch(c.id);f.finish(c.id);
    expect(f.candidates().map(c=>c.workId)).toEqual(["new-child","root-prepare"]);
    f.dispatch("new-child:stage:0");f.finish("new-child:stage:0");f.dispatch(b.id);
  });
  it("keeps original dispatch and unconsumed service order across process-generation recovery",()=>{
    const first=open();first.work("a");first.work("b");const a=first.stage("a"),b=first.stage("b");
    const original=first.dispatch(a.id);first.finish(a.id);first.stage("a",1);first.db.close();
    const recovered=open(first.directory);
    expect(recovered.candidates()[0]?.workId).toBe("b");
    expect(recovered.send({kind:"read_stage",requestId:a.id})).toMatchObject({result:{value:"done"}});
    const replay=recovered.send({kind:"dispatch",attempt:original.stage.attempt!,expectedControlRevision:0}) as ActivityDispatchReceipt;
    expect(replay).toMatchObject({granted:false,scheduling:original.scheduling});
    expect(recovered.dispatch(b.id).scheduling?.round).toBe(2);
  });
  it("does not free real occupancy on cancellation, unknown results or a query while occupied",()=>{
    const f=open();f.work("optional","old","optional");const old=f.stage("optional");f.dispatch(old.id);
    f.work("opportunity");const next=f.stage("opportunity");
    f.send({kind:"cancel",pathId:"optional:path",expectedControlRevision:0});
    f.send({kind:"save_raw",result:{id:"unknown",attemptId:`${old.id}:attempt`,completeness:"complete",outcome:"unknown",value:null,usage:null,recordedAt:new Date().toISOString()}});
    expect(f.candidates()).toEqual([]);expect(f.candidates()).toEqual([]);
    f.finish(old.id);expect(f.candidates()[0]?.workId).toBe("opportunity");
    expect(f.dispatch(next.id).scheduling?.ticket).not.toBeNull();
  });
  it("retains guaranteed eligibility on necessary promotion and records a new spare promotion",()=>{
    const f=open();f.work("a");f.work("b","root","optional");f.stage("a");f.stage("b");f.candidates();
    const before=f.send({kind:"read_schedule",workId:"a"}) as ActivitySchedulingAcceptance;
    const after=f.send({kind:"schedule_work",intent:{...before.intent,id:"a:necessary",reason:"necessary"},expectedRevision:1}) as ActivitySchedulingAcceptance;
    expect(after.eligibilitySequence).toBe(before.eligibilitySequence);
    const spare=f.send({kind:"read_schedule",workId:"b"}) as ActivitySchedulingAcceptance;
    const promoted=f.send({kind:"schedule_work",intent:{...spare.intent,id:"b:opportunity",reason:"opportunity"},expectedRevision:1}) as ActivitySchedulingAcceptance;
    expect(promoted.eligibilitySequence).toBeGreaterThan(spare.eligibilitySequence);
    expect(f.candidates().map(c=>c.workId)).toEqual(["a"]);
  });
  it("does not change resource binding or recipient identity with a treatment change",()=>{
    const f=open();f.work("a");
    expect(()=>f.send({kind:"schedule_work",intent:{...f.intent("a"),id:"bad",scopeId:"other"},expectedRevision:1})).toThrow("work_identity_conflict");
    expect(()=>f.send({kind:"bind_resource_pool",pool:{id:"model",revision:"1",authority:"test-host",capacity:2}})).toThrow("identity_conflict");
    expect(()=>f.send({kind:"schedule_work",intent:{...f.intent("a"),id:"bad-resource",resources:[{poolId:"model",capability:"model",units:2}]},expectedRevision:1})).toThrow("resource_unavailable");
  });
  it("freezes a bounded path delegation across treatment changes, closure and restart",()=>{
    const f=open();f.work("source");
    const source=f.send({kind:"read_path",pathId:"source:path"}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
    const intent={...f.intent("recipient","root"),allowedPathIds:["materialize","organize","check"]};
    f.send({kind:"schedule_work",intent,expectedRevision:0});
    const path=(id:string)=>({...source.intent,id,runId:"root",scheduledWorkId:"recipient"});
    f.send({kind:"open_path",intent:path("materialize")});
    expect(()=>f.send({kind:"open_path",intent:path("unrelated")})).toThrow("path_not_delegated");
    for(const allowedPathIds of [undefined,[],["materialize"],[...intent.allowedPathIds,"unrelated"]])
      expect(()=>f.send({kind:"schedule_work",intent:{...intent,id:"changed",allowedPathIds},expectedRevision:1})).toThrow();
    f.send({kind:"schedule_work",intent:{...intent,id:"necessary",reason:"necessary",allowedPathIds:[...intent.allowedPathIds].reverse()},expectedRevision:1});
    f.db.close();const restored=open(f.directory);
    restored.send({kind:"open_path",intent:path("organize")});
    expect(()=>restored.send({kind:"open_path",intent:path("unrelated")})).toThrow("path_not_delegated");
    restored.send({kind:"close_scheduled_work",workId:"recipient",expectedRevision:2,basis:"recipient-closed"});
    expect(()=>restored.send({kind:"open_path",intent:path("check")})).toThrow("path_binding_invalid");
    expect(restored.send({kind:"read_schedule",workId:"source"})).toMatchObject({closed:false});
  });
  it("does not let spare work overtake ready guaranteed work and closes future service without losing responses",()=>{
    const f=open();f.work("optional","root","optional");f.work("prepare");const spare=f.stage("optional"),needed=f.stage("prepare");
    expect(f.candidates().map(c=>c.workId)).toEqual(["prepare"]);
    f.dispatch(needed.id);f.finish(needed.id);
    f.send({kind:"close_scheduled_work",workId:"prepare",expectedRevision:1,basis:"consumer ended"});
    expect(()=>f.stage("prepare",1)).toThrow("path_binding_invalid");expect(f.candidates().map(c=>c.workId)).toEqual(["optional"]);
    expect(f.dispatch(spare.id).scheduling?.ticket).toBeNull();
    expect(f.send({kind:"read_stage",requestId:needed.id})).toMatchObject({result:{value:"done"}});
  });
  it("removes an unauthorized stage from competition without discarding its original work",()=>{
    const f=open();f.work("blocked");f.work("other");const first=f.stage("blocked"),second=f.stage("other");f.candidates();
    f.send({kind:"restrict_dispatch",requestId:first.id,expectedControlRevision:0,restriction:{code:"permission_changed",message:"Access revoked"}});
    expect(f.candidates().map(c=>c.workId)).toEqual(["other"]);
    expect(()=>f.dispatch(first.id)).toThrow("dispatch_restricted");
    f.dispatch(second.id);f.finish(second.id);
    f.send({kind:"restrict_dispatch",requestId:first.id,expectedControlRevision:0,restriction:null});
    expect(f.dispatch(first.id).scheduling?.workId).toBe("blocked");
  });
  it("discovers an overdue review even without an admitted stage and restores its publication",()=>{
    const f=open();const intent={...f.intent("review"),timing:{kind:"review_at" as const,at:"2020-01-01T00:00:00Z",basis:"opportunity evidence"}};
    f.send({kind:"schedule_work",intent,expectedRevision:0});
    expect(f.send({kind:"review_scheduling"})).toMatchObject({due:["review"],nextReviewAt:null});
    f.db.close();const reopened=open(f.directory);
    expect(reopened.send({kind:"review_scheduling"})).toMatchObject({due:[],nextReviewAt:null});
    const facts=reopened.send({kind:"facts",runId:"review",after:0,limit:256}) as readonly {kind:string;details:Record<string,unknown>}[];
    expect(facts.filter(fact=>fact.kind==="scheduling_limited")).toHaveLength(1);
  });
  it("does not multiply a scope's service share by creating many original works",()=>{
    const f=open();for(let i=0;i<4;i++){f.work(`many-${i}`,"large");f.stage(`many-${i}`);}
    f.work("task","small","task");let task=f.stage("task");
    for(let i=0;i<4;i++) {
      expect(f.candidates()[0]?.workId).toBe(`many-${i}`);
      f.dispatch(`many-${i}:stage:0`);f.finish(`many-${i}:stage:0`);
      expect(f.candidates()[0]?.workId).toBe("task");
      f.dispatch(task.id);f.finish(task.id);task=f.stage("task",i+1);
    }
  });
  it("does not let newly arriving scopes extend an accepted outer round",()=>{
    const f=open();f.work("a","a");f.work("b","b");const a=f.stage("a"),b=f.stage("b");
    const first=f.dispatch(a.id);f.finish(a.id);
    for(let i=0;i<10;i++){f.work(`late-${i}`,`late-${i}`);f.stage(`late-${i}`);}
    expect(f.candidates().map(c=>c.workId)).toEqual(["b"]);
    expect(f.dispatch(b.id).scheduling?.scopeRound).toBe(first.scheduling?.scopeRound);
  });
  it("allows at most one optional stage in a shared pool even when its physical capacity is larger",()=>{
    const f=open();f.send({kind:"bind_resource_pool",pool:{id:"wide",revision:"1",authority:"test-host",capacity:3}});
    for(const id of ["x","y"]) {
      f.work(id,id,"optional");
      // Use a separate explicitly bound work so an existing resource binding is not rewritten.
      const intent={...f.intent(`${id}-wide`,id,"optional"),resources:[{capability:"model",poolId:"wide",units:1}]};
      f.send({kind:"schedule_work",intent,expectedRevision:0});
      const original=f.send({kind:"read_path",pathId:`${id}:path`}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
      f.send({kind:"open_path",intent:{...original.intent,id:`${id}-wide:path`,scheduledWorkId:`${id}-wide`}});f.stage(`${id}-wide`);
    }
    f.dispatch("x-wide:stage:0");expect(f.candidates()).toEqual([]);
    f.finish("x-wide:stage:0");expect(f.candidates()[0]?.workId).toBe("y-wide");
  });
});
