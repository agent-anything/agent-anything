import {describe,it,expect,vi} from "vitest";
import type {ActivityReconsiderationSnapshot,ActivityPathState,ActivityHandoffPort} from "../activity/index.js";
import {ContextMethodInputConsumer} from "./ContextMethodInputConsumer.js";
import type {ContextMethodInputPlan,ContextMethodInputSupply,ContextMethodInputSupplyResult} from "./ContextMethodInputSupply.js";

function fixture() {
  // Supply validation is tested separately; this boundary only owns routing and durable continuation.
  const plan={revision:"5",scheduling:null,producers:[{pathId:"producer",candidateIds:["candidate"]}],scope:{runId:"child",owner:"context-representation"},materialization:{intent:{id:"materialize"},request:{preparationIntent:{id:"organize"}}},
    check:{intent:{id:"check"}},materialAdmissions:[{hold:{id:"consumer-hold"}}]} as ContextMethodInputPlan;
  const result:ContextMethodInputSupplyResult={conditions:[],kind:"waiting",observeSources:["producer-progress"],participants:[
    {owner:"activity",kind:"path_opening",proposal:{id:"materialize"}},{owner:"activity",kind:"stage_submission",proposal:{id:"first"}}]};
  const supply={prepare:vi.fn<ContextMethodInputSupply["prepare"]>().mockResolvedValue(result),readPlan:vi.fn<ContextMethodInputSupply["readPlan"]>().mockResolvedValue(plan)};
  const subscription={id:"consumer",runId:"child",owner:"context-representation",binding:{kind:"activity_path" as const,id:"materialize"},sources:["producer-progress"]};
  const snapshot={state:{subscription},facts:[]} as unknown as ActivityReconsiderationSnapshot;
  const path={intent:{id:"materialize",runId:"child",owner:"context-representation"},cancelled:false,controlRevision:0,progressRevision:1} as ActivityPathState;
  const paths=new Map<string,ActivityPathState>([["materialize",path]]),pending=new Set<string>();
  let scheduling:import("../activity/index.js").ActivitySchedulingAcceptance|null=null;
  const activities={command:vi.fn<ActivityHandoffPort["command"]>().mockImplementation(async command=>{
    if(command.kind==="read_path")return paths.get(command.pathId)??null;
    if(command.kind==="pending")return pending.has(command.pathId!)?[{pathId:command.pathId!,sequence:1,requestId:"stage",kind:"settlement"}]:[];
    if(command.kind==="read_schedule")return scheduling;
    throw new Error(command.kind);
  })};
  const methods={prepareInputRelease:vi.fn().mockResolvedValue([{owner:"context_selection",kind:"input_retirement",proposal:{}}])};
  return {plan,supply,snapshot,path,paths,pending,activities,methods,consumer:new ContextMethodInputConsumer(supply,{activities,methods}),signal:new AbortController().signal,
    ownSchedule(){
      const intent={id:"recipient:schedule",workId:"recipient",runId:"child",scopeId:"tree",owner:"context-representation",decisionId:"accepted-policy",policyRevision:"1",
        reason:"opportunity" as const,delayImpact:"recipient input",timing:{kind:"unknown" as const},resources:[{poolId:"model",capability:"model-access",units:1}],allowedPathIds:["materialize","organize","check"]};
      scheduling={intent,revision:2,closed:false,pathsSealed:false,settlementConfirmed:false,service:"guaranteed",eligibilitySequence:1,acceptedAt:"2026-10-31T00:00:00.000Z"};
      const child=(id:string)=>({id,runId:"child",scheduledWorkId:"recipient"});
      const owned={...plan,scheduling:intent,materialization:{...plan.materialization,intent:child("materialize"),request:{...plan.materialization.request,preparationIntent:child("organize")}},check:{...plan.check,intent:child("check")}} as ContextMethodInputPlan;
      supply.readPlan.mockResolvedValue(owned);paths.set("materialize",{...path,intent:{...path.intent,scheduledWorkId:"recipient"},cancelled:true});
      return {owned,setScheduling:(next:typeof scheduling)=>{scheduling=next;},getScheduling:()=>scheduling!};
    }};
}
describe("independent method input consumer",()=>{
  it("accepts its original path, plan stage and subscription in one boundary",async()=>{
    const f=fixture(),parts=await f.consumer.prepareStart(f.plan,f.signal);
    expect(parts.map(p=>p.kind)).toEqual(["path_opening","stage_submission","reconsideration_subscription"]);
    expect(parts[2]?.proposal).toMatchObject({runId:"child",owner:"context-representation",binding:{kind:"activity_path",id:"materialize"},
      sources:["activity-source:control:materialize","producer-progress"]});
  });
  it("requires ready original production before opening recipient work",async()=>{
    const f=fixture();f.supply.prepare.mockResolvedValue({conditions:[],kind:"waiting",participants:[],observeSources:["producer-progress"]});
    await expect(f.consumer.prepareStart(f.plan,f.signal)).rejects.toThrow("requires_ready_producer");
  });
  it("restores the original plan and hands subsequent work off without closing its subscription",async()=>{
    const f=fixture(),result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(f.supply.readPlan).toHaveBeenCalledWith("materialize");expect(f.supply.prepare).toHaveBeenCalledWith(f.plan,f.signal);
    expect(result).toMatchObject({close:false,decision:{kind:"method_input_waiting"},observeSources:["activity-source:control:materialize","producer-progress"]});
  });
  it.each(["materialization","check"] as const)("publishes a retained %s failure without pretending adoption or cancel settlement",async stage=>{
    const f=fixture();f.supply.prepare.mockResolvedValue({conditions:[],kind:"unavailable",stage,reason:"cancelled",observeSources:["producer-progress"]});
    const first=await f.consumer.prepare(f.snapshot,f.signal),second=await f.consumer.prepare(f.snapshot,f.signal);
    expect(first).toEqual(second);expect(first.close).toBe(false);
    expect(first.participants.some(p=>p.kind==="path_cancellation")).toBe(true);
    expect(first.participants.some(p=>p.kind==="holds")).toBe(false);
    expect(first.decision.kind).toBe("method_input_unavailable");
  });
  it("publishes a checked input without selecting it or acknowledging Parent delivery",async()=>{
    const f=fixture();f.supply.prepare.mockResolvedValue({conditions:[],kind:"checked",checkPathId:"check",prepared:{},progress:{},observeSources:["check-progress"]} as ContextMethodInputSupplyResult);
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result).toMatchObject({close:false,decision:{kind:"method_input_checked",id:"check"},observeSources:["activity-source:control:materialize"]});
    expect(result.participants.map(p=>p.kind)).toEqual(["path_condition","fact_publication"]);
    expect(result.participants[1]?.proposal).toMatchObject({sourceId:"activity-source:progress:materialize",ref:{kind:"method_input_checked",id:"check"}});
  });
  it("rejects missing original plans, foreign recipients and wrong bindings",async()=>{
    const f=fixture();f.supply.readPlan.mockResolvedValue(null);
    await expect(f.consumer.prepare(f.snapshot,f.signal)).rejects.toThrow("original_plan_missing");
    f.supply.readPlan.mockResolvedValue({...f.plan,scope:{...f.plan.scope,runId:"parent"}});
    await expect(f.consumer.prepare(f.snapshot,f.signal)).rejects.toThrow("original_plan_missing");
    await expect(f.consumer.prepare({...f.snapshot,state:{...f.snapshot.state,subscription:{...f.snapshot.state.subscription,binding:{kind:"input_need",id:"need"}}}},f.signal)).rejects.toThrow("binding_missing");
    const aborted=new AbortController();aborted.abort(new Error("cancelled"));
    await expect(f.consumer.prepare(f.snapshot,aborted.signal)).rejects.toThrow("cancelled");
    expect(f.supply.prepare).not.toHaveBeenCalled();
  });
  it("closes only the original consumer paths and waits for in-flight settlement",async()=>{
    const f=fixture();f.paths.set("materialize",{...f.path,cancelled:true,controlRevision:1});
    f.paths.set("check",{...f.path,intent:{...f.path.intent,id:"check"}});f.pending.add("check");
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(false);expect(result.decision.kind).toBe("method_input_closing");
    expect(result.participants.filter(p=>p.kind==="path_cancellation").map(p=>(p.proposal as {pathId:string}).pathId)).toEqual(["check"]);
    expect(result.observeSources).toContain("activity-source:progress:check");
    expect(f.supply.prepare).not.toHaveBeenCalled();expect(f.methods.prepareInputRelease).not.toHaveBeenCalled();
  });
  it("atomically retires auxiliary inputs and releases only its original recipient holds",async()=>{
    const f=fixture();f.paths.set("materialize",{...f.path,cancelled:true,controlRevision:1});
    f.paths.set("check",{...f.path,intent:{...f.path.intent,id:"check"},cancelled:true,controlRevision:1});
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(true);expect(result.decision.kind).toBe("method_input_closed");
    expect(f.methods.prepareInputRelease).toHaveBeenCalledWith("check");
    expect(result.participants.find(p=>p.kind==="holds")?.proposal).toEqual({acquire:[],release:["consumer-hold"],basis:"materialize:closed"});
    expect(result.participants.filter(p=>p.kind==="path_condition").map(p=>(p.proposal as {requireSettled:boolean}).requireSettled)).toEqual([true,true,true]);
    expect(result.participants.find(p=>p.kind==="path_condition"&&(p.proposal as {pathId:string}).pathId==="organize")?.proposal).toMatchObject({expected:null});
  });
  it("retains protection while a cancelled path still has an unknown outcome",async()=>{
    const f=fixture();f.paths.set("materialize",{...f.path,cancelled:true,controlRevision:1});f.pending.add("materialize");
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(false);expect(result.participants.some(p=>p.owner!=="activity")).toBe(false);
  });
  it("records explicit closure separately from checked output and rejects foreign subordinate paths",async()=>{
    const f=fixture();const parts=await f.consumer.prepareClosure("materialize","adoption-acceptance",f.signal);
    expect(parts.map(p=>p.kind)).toEqual(["path_condition","path_cancellation","fact_publication"]);
    expect(parts[2]?.proposal).toMatchObject({ref:{id:"adoption-acceptance",kind:"method_input_closure"}});
    f.paths.set("materialize",{...f.path,cancelled:true});f.paths.set("check",{...f.path,intent:{...f.path.intent,id:"check",runId:"parent"}});
    await expect(f.consumer.prepare(f.snapshot,f.signal)).rejects.toThrow("path_binding_changed");
  });
  it("accepts the original exclusive schedule together with the recipient plan",async()=>{
    const f=fixture(),{owned}=f.ownSchedule(),parts=await f.consumer.prepareStart(owned,f.signal);
    expect(parts[0]).toMatchObject({kind:"scheduling_acceptance",proposal:{expectedRevision:0,intent:owned.scheduling}});
    expect(parts.map(p=>p.kind)).toEqual(["scheduling_acceptance","path_opening","stage_submission","reconsideration_subscription"]);
  });
  it("closes owned scheduling with settled paths and holds, accepting a legitimate treatment revision",async()=>{
    const f=fixture(),{getScheduling,setScheduling}=f.ownSchedule(),work=getScheduling();
    setScheduling({...work,intent:{...work.intent,id:"necessary",reason:"necessary"},revision:3});
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(true);
    expect(result.participants.find(p=>p.kind==="scheduling_path_seal")?.proposal).toEqual({kind:"seal_scheduled_paths",workId:"recipient",expectedRevision:3,basis:"materialize:closing"});
    expect(result.participants.find(p=>p.kind==="scheduling_closure")?.proposal).toEqual({kind:"close_scheduled_work",workId:"recipient",expectedRevision:4,basis:"materialize:closed",requireSettled:true});
    expect(result.participants.filter(p=>p.kind==="path_condition")).toHaveLength(3);
    expect(result.participants.find(p=>p.kind==="holds")).toBeDefined();
  });
  it("does not close owned scheduling or release retention while settlement is unknown",async()=>{
    const f=fixture();f.ownSchedule();f.pending.add("materialize");
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(false);expect(result.participants.some(p=>p.kind==="scheduling_closure"||p.kind==="holds")).toBe(false);
    expect(result.participants.find(p=>p.kind==="scheduling_path_seal")?.proposal).toMatchObject({workId:"recipient",expectedRevision:2});
  });
  it("reuses an accepted admission seal while retaining original settlement responsibility",async()=>{
    const f=fixture(),{getScheduling,setScheduling}=f.ownSchedule();
    setScheduling({...getScheduling(),pathsSealed:true,revision:4});
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(true);expect(result.participants.some(p=>p.kind==="scheduling_path_seal")).toBe(false);
    expect(result.participants.find(p=>p.kind==="scheduling_closure")?.proposal).toMatchObject({expectedRevision:4,requireSettled:true});
  });
  it.each([null,"changed"])("refuses unconfirmed original scheduling: %s",async change=>{
    const f=fixture(),{setScheduling,getScheduling}=f.ownSchedule(),work=getScheduling();
    setScheduling(change===null?null:{...work,intent:{...work.intent,allowedPathIds:[...work.intent.allowedPathIds!,"foreign"]}});
    await expect(f.consumer.prepare(f.snapshot,f.signal)).rejects.toThrow("schedule_changed");
  });
  it("never infers ownership from shared work and rejects a falsely claimed scope",async()=>{
    const f=fixture(),{owned}=f.ownSchedule();
    f.supply.readPlan.mockResolvedValue({...owned,scheduling:null});
    const result=await f.consumer.prepare(f.snapshot,f.signal);
    expect(result.close).toBe(true);expect(result.participants.some(p=>p.kind==="scheduling_closure")).toBe(false);
    for(const scheduling of [undefined,{...owned.scheduling!,allowedPathIds:["materialize"]},{...owned.scheduling!,owner:"another"},{...owned.scheduling!,delegatedPathOwners:["other"]}])
      await expect(f.consumer.prepareStart({...owned,scheduling} as ContextMethodInputPlan,f.signal)).rejects.toThrow("scheduling_");
  });
});
