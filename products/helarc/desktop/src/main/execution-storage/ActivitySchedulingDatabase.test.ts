import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
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
  it("does not let spare work overtake ready guaranteed work and closes future service without losing responses",()=>{
    const f=open();f.work("optional","root","optional");f.work("prepare");const spare=f.stage("optional"),needed=f.stage("prepare");
    expect(f.candidates().map(c=>c.workId)).toEqual(["prepare"]);
    f.dispatch(needed.id);f.finish(needed.id);
    f.send({kind:"close_scheduled_work",workId:"prepare",expectedRevision:1,basis:"consumer ended"});
    f.stage("prepare",1);expect(f.candidates().map(c=>c.workId)).toEqual(["optional"]);
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
