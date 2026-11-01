import {describe,expect,it,vi} from "vitest";
import {ActivityPurposeRegistry,activityFactSourceId,type ActivityHandoffCommand,type ActivityHandoffPort,type ActivityHandoffValue,
  type ActivityPathIntent,type ActivityPathState,type ActivityPublishedFact,type ActivityReconsiderationSnapshot,
  type ActivityReconsiderationSubscription,type ActivityScopeLifetime,type ActivitySchedulingAcceptance,type ActivityScheduledSettlement} from "../../activity/index.js";
import {inputSupplyFactSource,inputSupplyResponsibility,type InputSupplyBinding,type InputSupplyExit,
  type InputSupplyResponsibilityQuery,type InputSupplyResponsibilityValue,type InputSupplyUsersPage} from "../InputSupplyResponsibility.js";
import {REPRESENTATION_METHOD_PURPOSE} from "./RepresentationMethod.js";
import {RepresentationProductionLifecycle} from "./RepresentationProductionLifecycle.js";

const at="2026-11-01T00:00:00Z";
function fixture() {
  const purpose=new ActivityPurposeRegistry<null>().register(REPRESENTATION_METHOD_PURPOSE,null);
  const intent:ActivityPathIntent={id:"original-producer",runId:"root",owner:"context-representation",purpose,scheduledWorkId:"original-work",
    permissionBasis:"original-grant",resourceScope:"original-resources",maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2099-01-01T00:00:00Z"};
  const scope:ActivityScopeLifetime={source:{id:"run-scope:root",runId:"root",owner:"run-lifetime"},closedFactId:"run-scope:root:closed"};
  const closed:ActivityPublishedFact={id:scope.closedFactId,sourceId:scope.source.id,ref:{owner:scope.source.owner,kind:"run_scope_closed",id:"root",revision:"terminal:1"}};
  const state:{path:ActivityPathState|null;work:ActivitySchedulingAcceptance|null;closed:ActivityPublishedFact|null;
    settlement:ActivityScheduledSettlement;remainingPath:ActivityPathState|null;users:InputSupplyUsersPage[];exits:Map<string,InputSupplyExit|null>}={
    path:{intent,controlRevision:0,progressRevision:2,cancelled:false,progress:{method:{state:"working",resultIds:[]}},admittedStages:2,dispatchedAttempts:2,
      resourceUse:{admittedStages:2,dispatchedAttempts:2}},
    work:{intent:{id:"original-scheduling",workId:"original-work",runId:"root",scopeId:"tree:root",owner:intent.owner,
      decisionId:"original-investment",policyRevision:"1",reason:"opportunity",delayImpact:"Background method",timing:{kind:"unknown"},
      resources:[{poolId:"model",capability:"model-access",units:1}],allowedPathIds:[intent.id]},
      revision:3,service:"spare",eligibilitySequence:1,acceptedAt:at,closed:false,pathsSealed:false,settlementConfirmed:false},
    closed:null,settlement:{workId:"original-work",revision:3,remaining:null},remainingPath:null,
    users:[{kind:"users",frontier:0,entries:[],next:null,complete:true}],exits:new Map(),
  };
  const command=vi.fn(async (command:ActivityHandoffCommand):Promise<ActivityHandoffValue>=>{
    switch(command.kind) {
      case "read_path":return command.pathId===intent.id?state.path:state.remainingPath?.intent.id===command.pathId?state.remainingPath:null;
      case "read_schedule":expect(command.workId).toBe(intent.scheduledWorkId);return state.work;
      case "read_fact":expect(command.id).toBe(scope.closedFactId);return state.closed;
      case "scheduled_settlement":expect(command.workId).toBe(intent.scheduledWorkId);return state.settlement;
      default:throw new Error(`Unexpected mutation or read: ${command.kind}`);
    }
  });
  const query=vi.fn(async (query:InputSupplyResponsibilityQuery):Promise<InputSupplyResponsibilityValue>=>{
    if(query.kind==="exit")return state.exits.get(query.needId)??null;
    if(query.kind!=="work_users")throw new Error(`Unexpected responsibility query: ${query.kind}`);
    expect(query.workId).toBe(intent.scheduledWorkId);expect(query.limit).toBe(64);
    const index=query.afterSequence===0?0:state.users.findIndex(page=>page.next===query.afterSequence)+1;
    const page=state.users[index];if(!page)throw new Error("Unexpected work-users cursor");return page;
  });
  const lifecycle=new RepresentationProductionLifecycle({command} as ActivityHandoffPort,{scope:()=>scope,responsibilities:{query}});
  const subscription=lifecycle.subscription(intent).proposal as ActivityReconsiderationSubscription;
  const snapshot:ActivityReconsiderationSnapshot={state:{subscription,observedSources:subscription.sources,revision:7,consumedThrough:1,closed:false},through:3,facts:[],more:false};
  const run=(signal=new AbortController().signal)=>lifecycle.prepare(snapshot,signal);
  const user=(needId:string):InputSupplyUsersPage["entries"][number]=>{
    const binding:InputSupplyBinding={needId,runId:"root",owner:intent.owner,consumerPathId:`consumer:${needId}`,
      source:{stageId:`source:${needId}`,requestDigest:`digest:${needId}`},configuration:{id:"original",revision:"1"}};
    return {binding,responsibility:{...inputSupplyResponsibility("method_production",intent),needId,acceptanceId:`registered:${needId}`}};
  };
  function exited(entry:ReturnType<typeof user>,status:InputSupplyExit["status"]="closed"):InputSupplyExit {
    const {configuration:_,...origin}=entry.binding;
    return {origin,subscriptionId:`${origin.needId}:supply`,membershipRevision:1,scheduling:null,basis:{kind:"cancelled",controlRevision:1},
      revision:3,status,acceptanceId:`exit:${origin.needId}`};
  }
  return {state,scope,closed,intent,command,query,lifecycle,snapshot,run,user,exited};
}

describe("independent representation production lifecycle",()=>{
  it("subscribes under the original producer and its scope without transferring closure authority to a consumer",()=>{
    const f=fixture();
    expect(f.lifecycle.subscription(f.intent)).toEqual({owner:"activity",kind:"reconsideration_subscription",proposal:{
      id:"original-producer:production-lifecycle",runId:"root",owner:f.intent.owner,binding:{kind:"activity_path",id:f.intent.id},
      sources:[f.scope.source.id,activityFactSourceId("scheduling","original-work"),activityFactSourceId("progress",f.intent.id),activityFactSourceId("control",f.intent.id)]}});
    expect(()=>f.lifecycle.subscription({...f.intent,scheduledWorkId:undefined})).toThrow("representation_lifetime_scope_invalid");
    expect(()=>f.lifecycle.subscription({...f.intent,runId:"foreign"})).toThrow("representation_lifetime_scope_invalid");
  });
  it.each(["working","ready"])("does not seal a %s producer while its original scope remains open",async state=>{
    const f=fixture();f.state.path={...f.state.path!,progress:{method:{state,resultIds:["retained-result"]}}};
    const original=structuredClone(f.state.path),result=await f.run();
    expect(result).toMatchObject({decision:{kind:"representation_production_scope_open",id:"original-work",revision:"3"},participants:[],close:false});
    expect(f.query).not.toHaveBeenCalled();expect(f.command.mock.calls.some(([c])=>c.kind==="scheduled_settlement")).toBe(false);
    expect(f.state.path).toEqual(original);
  });
  it.each(["missing","closing"] as const)("waits for a %s consumer exit and observes its original responsibility source",async status=>{
    const f=fixture(),user=f.user("original-need");f.state.closed=f.closed;
    f.state.users=[{kind:"users",frontier:1,entries:[user],next:null,complete:true}];
    if(status==="closing")f.state.exits.set(user.binding.needId,f.exited(user,"closing"));
    const result=await f.run();
    expect(result).toMatchObject({decision:{kind:"representation_production_consumers_active"},participants:[],close:false});
    expect(result.observeSources).toContain(inputSupplyFactSource(user.binding).id);
    expect(f.command.mock.calls.some(([c])=>c.kind==="scheduled_settlement")).toBe(false);
  });
  it("freezes the users frontier across pages and notices an active consumer on a later page",async()=>{
    const f=fixture(),done=f.user("done"),active=f.user("later");f.state.closed=f.closed;f.state.exits.set("done",f.exited(done));
    f.state.users=[{kind:"users",frontier:90,entries:[done],next:64,complete:false},{kind:"users",frontier:90,entries:[active],next:null,complete:true}];
    const result=await f.run();
    expect(result.decision.kind).toBe("representation_production_consumers_active");
    expect(f.query.mock.calls.filter(([q])=>q.kind==="work_users").map(([q])=>q)).toEqual([
      {kind:"work_users",workId:"original-work",frontier:null,afterSequence:0,limit:64},
      {kind:"work_users",workId:"original-work",frontier:90,afterSequence:64,limit:64}]);
    expect(result.observeSources).toContain(inputSupplyFactSource(active.binding).id);
    expect(result.observeSources).not.toContain(inputSupplyFactSource(done.binding).id);
  });
  it("first seals unreferenced work, then checks actual settlement before requesting strict closure",async()=>{
    const f=fixture();f.state.closed=f.closed;
    const sealed=await f.run();
    expect(sealed.close).toBe(false);
    expect(sealed.participants).toEqual([
      {owner:"context_input_supply",kind:"producer_unreferenced",proposal:{workId:"original-work"}},
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:"original-work",expectedRevision:3,basis:f.closed.id}}]);
    expect(f.command.mock.calls.some(([c])=>c.kind==="scheduled_settlement")).toBe(false);
    f.state.work={...f.state.work!,pathsSealed:true,revision:4};f.state.settlement={...f.state.settlement,revision:4};
    const closed=await f.run();
    expect(closed).toMatchObject({decision:{kind:"representation_production_closed",id:"original-work",revision:"4"},close:true});
    expect(closed.participants).toEqual([
      {owner:"context_input_supply",kind:"producer_unreferenced",proposal:{workId:"original-work"}},
      {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:"original-work",expectedRevision:4,basis:f.closed.id,requireSettled:true}}]);
  });
  it("permits closure only after every registered consumer has actually exited",async()=>{
    const f=fixture(),user=f.user("closed-need");f.state.closed=f.closed;
    f.state.users=[{kind:"users",frontier:1,entries:[user],next:null,complete:true}];f.state.exits.set(user.binding.needId,f.exited(user));
    f.state.work={...f.state.work!,pathsSealed:true};
    expect((await f.run()).participants.map(p=>p.kind)).toEqual(["producer_unreferenced","scheduling_closure"]);
  });
  it("keeps a ready result readable by never cancelling its settled producer",async()=>{
    const f=fixture();f.state.closed=f.closed;f.state.work={...f.state.work!,pathsSealed:true};
    f.state.path={...f.state.path!,progress:{method:{state:"ready",candidates:[{id:"candidate"}],resultIds:["candidate"]}}};
    const original=structuredClone(f.state.path),result=await f.run();
    expect(result.close).toBe(true);expect(result.participants.some(p=>p.kind==="path_cancellation")).toBe(false);
    expect(f.state.path).toEqual(original);expect(f.state.path.cancelled).toBe(false);
  });
  it.each(["stage","input_need","occupancy"] as const)("cancels only the original pending %s path, then waits for genuine settlement",async kind=>{
    const f=fixture();f.state.closed=f.closed;f.state.work={...f.state.work!,pathsSealed:true};
    f.state.settlement={workId:"original-work",revision:3,remaining:{kind,pathId:f.intent.id,id:"original-pending"}};
    const first=await f.run();
    expect(first).toMatchObject({decision:{kind:"representation_production_settlement_pending"},close:false});
    expect(first.participants).toEqual([
      {owner:"context_input_supply",kind:"producer_unreferenced",proposal:{workId:"original-work"}},
      {owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:f.intent.id,expectedControlRevision:0}}]);
    expect(first.observeSources).toEqual(expect.arrayContaining([activityFactSourceId("progress",f.intent.id),activityFactSourceId("control",f.intent.id)]));
    f.state.path={...f.state.path!,cancelled:true,controlRevision:1};
    const waiting=await f.run();expect(waiting.close).toBe(false);expect(waiting.participants.map(p=>p.kind)).toEqual(["producer_unreferenced"]);
    f.state.settlement={...f.state.settlement,remaining:null};expect((await f.run()).close).toBe(true);
  });
  it("does not cancel a ready producer when another path in its work remains pending",async()=>{
    const f=fixture();f.state.closed=f.closed;f.state.work={...f.state.work!,pathsSealed:true,
      intent:{...f.state.work!.intent,allowedPathIds:[f.intent.id,"unfinished-sibling"]}};
    f.state.path={...f.state.path!,progress:{method:{state:"ready",resultIds:["retained"]}}};
    f.state.remainingPath={...f.state.path,intent:{...f.intent,id:"unfinished-sibling"},progress:{method:{state:"working"}}};
    f.state.settlement={workId:"original-work",revision:3,remaining:{kind:"stage",pathId:"unfinished-sibling",id:"pending-stage"}};
    const result=await f.run();
    expect(result.participants.find(p=>p.kind==="path_cancellation")?.proposal).toMatchObject({pathId:"unfinished-sibling"});
    expect(f.state.path.cancelled).toBe(false);expect(f.state.path.progress).toEqual({method:{state:"ready",resultIds:["retained"]}});
  });
  it("uses original work identity and current durable CAS revisions after scheduling treatment changes",async()=>{
    const f=fixture();f.state.closed=f.closed;
    f.state.work={...f.state.work!,intent:{...f.state.work!.intent,id:"revised-treatment",decisionId:"reconsideration",reason:"necessary",
      timing:{kind:"review_at",at:"2026-11-02T00:00:00Z",basis:"Original work continues"}},revision:8};
    const original=structuredClone(f.intent),result=await f.run();
    expect(result.participants.at(-1)?.proposal).toMatchObject({workId:"original-work",expectedRevision:8,basis:f.closed.id});
    f.state.work={...f.state.work,pathsSealed:true,revision:9};f.state.settlement={...f.state.settlement,revision:10};
    expect((await f.run()).participants.at(-1)?.proposal).toMatchObject({workId:"original-work",expectedRevision:10,requireSettled:true});
    expect(f.intent).toEqual(original);expect(f.snapshot.state.subscription.binding).toEqual({kind:"activity_path",id:original.id});
  });
  it("does not confuse service closure with confirmed settlement",async()=>{
    const f=fixture();f.state.closed=f.closed;f.state.work={...f.state.work!,closed:true,pathsSealed:true};
    f.state.path={...f.state.path!,cancelled:true,controlRevision:1};
    f.state.settlement={...f.state.settlement,remaining:{kind:"occupancy",pathId:f.intent.id,id:"unknown-attempt"}};
    expect(await f.run()).toMatchObject({close:false,decision:{kind:"representation_production_settlement_pending"}});
  });
  it("idempotently closes only its subscription after strict settlement was already confirmed",async()=>{
    const f=fixture();f.state.work={...f.state.work!,closed:true,pathsSealed:true,settlementConfirmed:true,revision:12};
    const first=await f.run(),replayed=await f.run();
    expect(first).toMatchObject({decision:{kind:"representation_production_already_closed",revision:"12"},participants:[],close:true});
    expect(replayed).toEqual(first);expect(f.query).not.toHaveBeenCalled();
    expect(f.command.mock.calls.every(([c])=>["read_path","read_schedule"].includes(c.kind))).toBe(true);
  });
  it.each(["binding","path","path owner","work","work run","fact source","fact owner","remaining work"])("rejects changed %s rather than closing borrowed work",async change=>{
    const f=fixture();f.state.closed=f.closed;f.state.work={...f.state.work!,pathsSealed:true};
    if(change==="binding") {
      const snapshot={...f.snapshot,state:{...f.snapshot.state,subscription:{...f.snapshot.state.subscription,binding:{kind:"input_need" as const,id:"other"}}}};
      await expect(f.lifecycle.prepare(snapshot,new AbortController().signal)).rejects.toThrow("representation_lifetime_binding_invalid");return;
    }
    if(change==="path")f.state.path=null;
    if(change==="path owner")f.state.path={...f.state.path!,intent:{...f.intent,owner:"other"}};
    if(change==="work")f.state.work=null;
    if(change==="work run")f.state.work={...f.state.work!,intent:{...f.state.work!.intent,runId:"other"}};
    if(change==="fact source")f.state.closed={...f.closed,sourceId:"foreign"};
    if(change==="fact owner")f.state.closed={...f.closed,ref:{...f.closed.ref,owner:"foreign"}};
    if(change==="remaining work") {
      f.state.remainingPath={...f.state.path!,intent:{...f.intent,id:"foreign-path",scheduledWorkId:"foreign-work"}};
      f.state.settlement={...f.state.settlement,remaining:{kind:"stage",pathId:"foreign-path",id:"foreign-stage"}};
    }
    await expect(f.run()).rejects.toThrow("representation_lifetime_");
  });
  it("does not mutate or read work after cancellation of the transient reconsideration attempt",async()=>{
    const f=fixture(),abort=new AbortController();abort.abort(new Error("attempt interrupted"));
    await expect(f.run(abort.signal)).rejects.toThrow("attempt interrupted");
    expect(f.command).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
});
