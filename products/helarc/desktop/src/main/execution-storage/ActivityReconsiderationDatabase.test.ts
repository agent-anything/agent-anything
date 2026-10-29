import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {ActivityPurposeRegistry,ActivityReconsiderationProcessor,type ActivityHandoffCommand,type ActivityReconsiderationSnapshot,type ActivityReconsiderationReceipt} from "@agent-anything/agent-runtime/activity";
import {ExecutionDatabase} from "./ExecutionDatabase.js";

const roots:string[]=[],databases:ExecutionDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const root of roots.splice(0)){
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith("helarc-reconsideration-"))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true});
}});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-reconsideration-"))) {
  if(!roots.includes(directory))roots.push(directory);const db=new ExecutionDatabase(directory);databases.push(db);
  const send=(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue;
  send({kind:"register_fact_source",source:{id:"source",runId:"child",owner:"method"}});
  const publish=(id:string)=>send({kind:"publish_fact",fact:{id,sourceId:"source",ref:{owner:"method",kind:"result",id,revision:"1"}}});
  const subscribe=()=>send({kind:"subscribe_reconsideration",subscription:{id:"watch",runId:"child",owner:"crm",sources:["source"]}});
  const snapshot=(limit=256)=>send({kind:"read_reconsideration",subscriptionId:"watch",limit}) as ActivityReconsiderationSnapshot;
  const receipt=(value:ActivityReconsiderationSnapshot):ActivityReconsiderationReceipt=>({id:`accept:${value.state.revision}`,subscriptionId:"watch",expectedRevision:value.state.revision,through:value.through,
    factIds:value.facts.map(f=>f.id),decision:{owner:"crm",kind:"policy_decision",id:`decision:${value.state.revision}`,revision:"1"},close:false});
  return {directory,db,send,publish,subscribe,snapshot,receipt};
}
describe("durable reconsideration boundaries",()=>{
  it("routes independent subscriptions of the same owner without consuming an unbound recipient",async()=>{
    const f=open();f.subscribe();f.publish("f1");
    f.send({kind:"subscribe_reconsideration",subscription:{id:"other-watch",runId:"child",owner:"crm",sources:["source"]}});
    const seen:string[]=[];
    const processor=new ActivityReconsiderationProcessor({command:async c=>f.send(c)},
      {accept:async p=>f.db.acceptShared(f.db.generation,p).acceptanceValue,query:async id=>f.db.querySharedAcceptance(f.db.generation,id)},
      (owner,subscription)=>owner==="crm"&&subscription.id==="watch"?{prepare:async snapshot=>{
        seen.push(snapshot.state.subscription.id);
        return {decision:{owner:"crm",kind:"decision",id:"bound-decision",revision:"1"},participants:[],close:false};
      }}:null);
    expect((await processor.scan("child",new AbortController().signal)).accepted).toEqual(["watch"]);
    expect(seen).toEqual(["watch"]);
    expect(f.send({kind:"read_reconsideration",subscriptionId:"other-watch",limit:64})).toMatchObject({facts:[{id:"f1"}]});
  });
  it("delivers finite facts to the owner once, including publication during professional calculation",async()=>{
    const f=open();f.subscribe();f.publish("f1");const seen:string[][]=[];
    const processor=new ActivityReconsiderationProcessor({command:async c=>f.send(c)},
      {accept:async p=>f.db.acceptShared(f.db.generation,p).acceptanceValue,query:async id=>f.db.querySharedAcceptance(f.db.generation,id)},
      owner=>owner!=="crm"?null:{prepare:async snapshot=>{
        seen.push(snapshot.facts.map(f=>f.id));if(seen.length===1)f.publish("f2");
        return {decision:{owner:"crm",kind:"decision",id:`decision:${snapshot.state.revision}`,revision:"1"},participants:[],close:false};
      }});
    const signal=new AbortController().signal;
    expect((await processor.scan("child",signal)).accepted).toEqual(["watch"]);
    expect(f.snapshot().facts.map(f=>f.id)).toEqual(["f2"]);
    await processor.scan("child",signal);await processor.scan("child",signal);
    expect(seen).toEqual([["f1"],["f2"]]);expect(f.snapshot().facts).toEqual([]);
  });
  it("does not consume facts after professional failure or invent a handler on recovery",async()=>{
    const f=open();f.subscribe();f.publish("f1");
    const port={command:async(c:ActivityHandoffCommand)=>f.send(c)},acceptance={accept:async(p:import("@agent-anything/agent-runtime/activity").SharedAcceptanceProposal)=>f.db.acceptShared(f.db.generation,p).acceptanceValue,query:async(id:string)=>f.db.querySharedAcceptance(f.db.generation,id)};
    const absent=new ActivityReconsiderationProcessor(port,acceptance,()=>null);
    expect((await absent.scan("child",new AbortController().signal)).accepted).toEqual([]);
    const failed=new ActivityReconsiderationProcessor(port,acceptance,()=>({prepare:async()=>{throw new Error("original evidence unavailable");}}));
    expect((await failed.scan("child",new AbortController().signal)).failures).toHaveLength(1);
    expect(f.snapshot().facts).toHaveLength(1);
  });
  it("discovers only unconsumed facts in the entrusted Run and leaves unbound owners recoverable",()=>{
    const f=open();f.subscribe();
    const pending=(runId="child")=>f.send({kind:"pending_reconsiderations",runId,afterId:null,limit:16});
    expect(pending()).toEqual([]);f.publish("f1");expect(pending()).toMatchObject([{subscription:{id:"watch"}}]);
    expect(pending("parent")).toEqual([]);
    f.send({kind:"accept_reconsideration",receipt:f.receipt(f.snapshot())});expect(pending()).toEqual([]);
    f.publish("f2");expect(pending()).toHaveLength(1);
  });
  it.each([true,false])("does not lose publication before or after registration: %s",before=>{
    const f=open();if(before)f.publish("f1");f.subscribe();if(!before)f.publish("f1");f.publish("f1");
    expect(f.snapshot().facts.map(f=>f.id)).toEqual(["f1"]);
    const receipt=f.receipt(f.snapshot());f.send({kind:"accept_reconsideration",receipt});f.send({kind:"accept_reconsideration",receipt});
    expect(f.snapshot()).toMatchObject({state:{revision:1},facts:[]});
    expect(f.db.querySharedAcceptance(f.db.generation,receipt.id)).toMatchObject({outcome:"accepted"});
  });
  it("keeps later facts outside the accepted finite boundary across reopening",()=>{
    const f=open();f.subscribe();f.publish("f1");const receipt=f.receipt(f.snapshot());f.publish("f2");
    f.send({kind:"accept_reconsideration",receipt});f.db.close();const recovered=open(f.directory);
    expect(recovered.snapshot().facts.map(f=>f.id)).toEqual(["f2"]);
    expect(recovered.snapshot().state).toMatchObject({revision:1,consumedThrough:receipt.through});
  });
  it("does not consume facts if a successor acceptance fails",()=>{
    const f=open();f.subscribe();f.publish("f1");const receipt=f.receipt(f.snapshot());
    expect(()=>f.send({kind:"accept_reconsideration",receipt,participants:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{id:"schedule",workId:"work",runId:"child",scopeId:"child",owner:"crm",decisionId:receipt.decision.id,
      policyRevision:"1",reason:"opportunity",delayImpact:"needed soon",timing:{kind:"unknown"},resources:[{poolId:"missing",units:1,capability:"model"}]}}}]})).toThrow("pool_missing");
    expect(f.snapshot()).toMatchObject({state:{revision:0},facts:[{id:"f1"}]});
  });
  it("accepts an explicit decision and successor scheduling together",()=>{
    const f=open();f.subscribe();f.publish("f1");const receipt=f.receipt(f.snapshot());
    f.send({kind:"bind_resource_pool",pool:{id:"pool",revision:"1",authority:"host",capacity:1}});
    f.send({kind:"accept_reconsideration",receipt,participants:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{id:"schedule",workId:"work",runId:"child",scopeId:"child",owner:"crm",decisionId:receipt.decision.id,
      policyRevision:"1",reason:"opportunity",delayImpact:"needed soon",timing:{kind:"unknown"},resources:[{poolId:"pool",units:1,capability:"model"}]}}}]});
    expect(f.snapshot().facts).toEqual([]);expect(f.send({kind:"read_schedule",workId:"work"})).toMatchObject({service:"guaranteed"});
  });
  it("does not skip page facts, invent a producer or cross recipient scope",()=>{
    const f=open();f.subscribe();f.publish("f1");f.publish("f2");
    const page=f.snapshot(1);expect(page.more).toBe(true);
    expect(()=>f.send({kind:"accept_reconsideration",receipt:{...f.receipt(page),through:2}})).toThrow("boundary_mismatch");
    expect(()=>f.send({kind:"subscribe_reconsideration",subscription:{id:"parent",runId:"parent",owner:"crm",sources:["source"]}})).toThrow("source_scope_invalid");
    expect(()=>f.send({kind:"subscribe_reconsideration",subscription:{id:"missing",runId:"child",owner:"crm",sources:["absent"]}})).toThrow("source_scope_invalid");
  });
  it.each([true,false])("accepts delegated path and first stage with the decision, without partial handoffs: valid=%s",valid=>{
    const f=open();f.subscribe();f.publish("f1");const receipt=f.receipt(f.snapshot());
    f.send({kind:"bind_resource_pool",pool:{id:"pool",revision:"1",authority:"host",capacity:1}});
    const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"method",revision:"1"},inputOwner:"method",executionOwner:"model",interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["model"],capabilities:["model"],continuationKinds:[]},null);
    const schedule={kind:"schedule_work",expectedRevision:0,intent:{id:"schedule",workId:"work",runId:"child",scopeId:"child",owner:"crm",delegatedPathOwners:["method"],decisionId:receipt.decision.id,
      policyRevision:"1",reason:"opportunity",delayImpact:"next input",timing:{kind:"unknown"},resources:[{poolId:"pool",units:1,capability:"model"}]}};
    const path={id:"path",runId:"child",owner:"method",purpose,scheduledWorkId:"work",permissionBasis:"test",resourceScope:"work",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
    const command={kind:"accept_reconsideration" as const,receipt,participants:[{owner:"activity",kind:"scheduling_acceptance",proposal:schedule},
      {owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{id:"first",pathId:"path",stageKind:"model",input:"frozen source",capabilities:[valid?"model":"undelegated"],dependencies:[]}}]};
    if(!valid){expect(()=>f.send(command)).toThrow("not_delegated");expect(f.snapshot().facts).toHaveLength(1);expect(f.send({kind:"read_path",pathId:"path"})).toBeNull();expect(f.send({kind:"read_schedule",workId:"work"})).toBeNull();return;}
    f.send(command);f.send(command);f.db.close();const recovered=open(f.directory);
    expect(recovered.snapshot().facts).toEqual([]);
    expect(recovered.send({kind:"read_path",pathId:"path"})).toMatchObject({intent:{scheduledWorkId:"work",owner:"method"}});
    expect(recovered.send({kind:"pending",runId:"child",after:0,limit:10})).toMatchObject([{requestId:"first",kind:"admission"}]);
  });
});
