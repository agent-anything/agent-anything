import {describe,it,expect,vi} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityReconsiderationSnapshot} from "@agent-anything/agent-runtime/activity";
import {HelarcNativeInputSupply} from "./HelarcNativeInputSupply.js";

function fixture(){
  const need={id:"need",supplier:"context-representation",stage:{id:"ready",pathId:"demand"},unavailableStage:{id:"unavailable",pathId:"demand"}};
  const path={intent:{id:"demand",runId:"root",permissionBasis:"authority",deadlineAt:"2030-01-01T00:00:00Z"},controlRevision:0,cancelled:false};
  const source={request:{id:"source",pathId:"demand"}},scope={id:"scope",runId:"root",owner:need.supplier};
  const demand:any={kind:"needed",need,path,source,plan:{activity:{composition:{composition:{configuration:{configuration:{id:"configuration",revision:"1"}}}}},
    inputNeed:{scope},prepared:{sourceDigest:"original-source"}}};
  const origin={needId:"need",runId:"root",owner:need.supplier,consumerPathId:"demand",source:{stageId:"source",requestDigest:digest(source.request)},configuration:{id:"configuration",revision:"1"}};
  const intent={id:"preparation",runId:"root",permissionBasis:"authority",scheduledWorkId:"supply"};
  const preparation={intent,plan:{inputSupply:origin,scope}};
  const parts=[{owner:"activity",kind:"path_opening",proposal:{...intent,owner:need.supplier}},
    {owner:"activity",kind:"stage_submission",proposal:{id:"preparation:stage:1",pathId:"preparation",input:{plan:preparation.plan,inputSupplyPreparation:{kind:"input_supply_preparation"}}}}];
  const state:any={head:null,stages:new Map(),paths:new Map()};
  const activities={command:vi.fn(async(c:any)=>c.kind==="read_input_need"?need:c.kind==="read_stage"?state.stages.get(c.requestId)??null:
    c.kind==="read_path"?state.paths.get(c.pathId)??null:null)};
  const responsibilities={query:vi.fn(async(c:any)=>c.kind==="head"?state.head:c.kind==="page"?{kind:"page",entries:[],next:null}:null)};
  const arrangement:any={scheduling:{workId:"supply",runId:"root",owner:need.supplier,delegatedPathOwners:["material-source"]},publications:[],preparation};
  const resolve=vi.fn(async()=>arrangement),authorize=vi.fn(async()=>{}),decide=vi.fn(async()=>({decision:{id:"policy"},participants:[],close:true}));
  const publications={prepareSubmission:vi.fn((intent:any,request:any)=>[
    {owner:"activity",kind:"path_opening",proposal:{...intent,owner:"material-source"}},
    {owner:"activity",kind:"stage_submission",proposal:{id:intent.id+":capture",pathId:intent.id,input:request}}])};
  const original={prepareSubmission:vi.fn(()=>parts),result:vi.fn(async()=>({kind:"prepared"}))};
  const ports:any={activities,responsibilities,demand:{result:vi.fn(async()=>demand)},publications,original,receivers:{prepareClosure:vi.fn()},authorize,resolve,decide};
  const work=new HelarcNativeInputSupply(ports),snapshot={state:{subscription:{id:"supply-subscription",runId:"root",owner:need.supplier,binding:{kind:"input_need",id:need.id}}}} as ActivityReconsiderationSnapshot;
  return {need,path,source,scope,demand,origin,intent,parts,state,activities,responsibilities,arrangement,resolve,authorize,decide,publications,original,work,snapshot,
    run:()=>work.prepare(snapshot,new AbortController().signal)};
}
describe("native input supply responsibility",()=>{
  it("admits local preparation with its original need, schedule and public ownership declaration",async()=>{
    const f=fixture(),result=await f.run();
    expect(result.close).toBe(false);expect(f.decide).not.toHaveBeenCalled();
    expect(result.participants).toContainEqual({owner:"activity",kind:"input_need_condition",proposal:{needId:"need",expectedControlRevision:0}});
    expect(result.participants.at(-1)).toMatchObject({owner:"context_input_supply",kind:"register",proposal:{binding:f.origin,responsibilities:[{role:"input_preparation",relation:"owned"}]}});
  });
  it("invokes policy only after original local preparation is accepted",async()=>{
    const f=fixture();f.state.paths.set("preparation",{intent:f.parts[0]!.proposal,cancelled:false});
    f.state.stages.set("preparation:stage:1",{request:f.parts[1]!.proposal,status:"accepted"});
    const result=await f.run();expect(f.decide).toHaveBeenCalledOnce();expect(result.close).toBe(false);
  });
  it("keeps pending preparation observable without interpreting pending as usable",async()=>{
    const f=fixture();f.state.paths.set("preparation",{intent:f.parts[0]!.proposal,cancelled:false});
    f.state.stages.set("preparation:stage:1",{request:f.parts[1]!.proposal,status:"submitted"});f.original.result.mockResolvedValue({kind:"pending"});
    const result=await f.run();expect(f.decide).not.toHaveBeenCalled();expect(result.observeSources).toContain(activityFactSourceId("progress","preparation"));
  });
  it.each(["configuration","schedule","scope"])("rejects changed %s without another preparation",async change=>{
    const f=fixture();
    if(change==="configuration")f.state.head={binding:{...f.origin,configuration:{id:"configuration",revision:"2"}},scheduling:f.arrangement.scheduling};
    if(change==="schedule")f.arrangement.preparation.intent.scheduledWorkId="other";
    if(change==="scope")f.arrangement.preparation.plan.scope={...f.scope,runId:"child"};
    await expect(f.run()).rejects.toThrow(/native_supply_(binding|preparation)_changed/);expect(f.decide).not.toHaveBeenCalled();
  });
  it("cancellation uses the original exit path without resolving current settings or invoking policy",async()=>{
    const f=fixture();f.demand.kind="cancelled";f.path.cancelled=true;
    const result=await f.run();expect(result.participants).toContainEqual(expect.objectContaining({owner:"context_input_supply",kind:"exit"}));
    expect(f.resolve).not.toHaveBeenCalled();expect(f.authorize).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
  });
  it("a stopped local preparation returns explicit unavailability instead of waiting forever",async()=>{
    const f=fixture();f.state.paths.set("preparation",{intent:f.parts[0]!.proposal,cancelled:true,controlRevision:1,progressRevision:1});
    f.state.stages.set("preparation:stage:1",{request:f.parts[1]!.proposal,status:"stopped"});
    const result=await f.run();expect(result.participants).toContainEqual(expect.objectContaining({owner:"activity",kind:"stage_submission",
      proposal:expect.objectContaining({id:"unavailable",input:expect.objectContaining({kind:"context_input_unavailable",reason:"original_preparation_cancelled"})})}));
    expect(f.decide).not.toHaveBeenCalled();
  });
  it("admits a bounded batch of source publications under shared work before input preparation",async()=>{
    const f=fixture();f.arrangement.preparation=null;
    f.arrangement.publications=Array.from({length:20},(_,i)=>({pathId:`source:${i}`,state:"new",published:null,
      request:{intent:{activityId:`source:${i}`},recipient:{runId:"root"}}}));
    const result=await f.run();expect(f.publications.prepareSubmission).toHaveBeenCalledTimes(16);expect(f.original.prepareSubmission).not.toHaveBeenCalled();
    expect((result.participants.at(-1)!.proposal as any).responsibilities).toHaveLength(16);expect(f.decide).not.toHaveBeenCalled();
  });
  it("source reuse registers a dependency rather than repeating capture",async()=>{
    const f=fixture();f.arrangement.preparation=null;
    f.arrangement.publications=[{pathId:"capture",state:"published",published:{},request:{intent:{activityId:"capture"},recipient:{runId:"root"}}}];
    f.state.paths.set("capture",{intent:{id:"capture",runId:"root",owner:"material-source"}});
    const result=await f.run();expect(f.publications.prepareSubmission).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
    expect(result.participants.at(-1)).toMatchObject({proposal:{responsibilities:[{role:"source_publication",relation:"dependency"}]}});
  });
});
