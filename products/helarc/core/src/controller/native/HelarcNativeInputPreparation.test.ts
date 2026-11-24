import {describe,it,expect,vi} from "vitest";
import {assessInputCapacity,modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {HelarcNativeInputPreparation,type HelarcNativePreparationSupply} from "./HelarcNativeInputPreparation.js";

function fixture(){
  const scope={id:"scope",runId:"root",recipient:"task",purpose:"task",target:"config:1",owner:"context-representation",continuity:"root",authorityBasis:"authority"};
  const inputNeed={needId:"need",scope},prepared={sourceDigest:"boundary",workingSources:{groups:[]}},activity={scope:{runId:"root"}};
  const source={request:{id:"source",pathId:"demand"},result:{recordedAt:"2026-11-16T00:00:00Z"}};
  const inputSupply={needId:"need",consumerPathId:"demand",source:{requestDigest:digest(source.request)}};
  const demand={kind:"needed",plan:{inputNeed,prepared,activity},need:{id:"need"},source,path:{intent:{id:"demand"},cancelled:true}};
  const measurements=[{id:"bytes",encodedInputId:"input",targetRevision:scope.target,methodRevision:"wire:1",dimension:"request_bytes" as const,
    coverage:"complete" as const,quantity:{kind:"exact" as const,value:10},basis:"full",uncovered:[]}];
  const limits=[{id:"limit",targetRevision:scope.target,dimension:"request_bytes" as const,maximum:1000,source:"host"}];
  const capacity={inputId:"input",measurements,limits,assessment:assessInputCapacity({encodedInputId:"input",targetRevision:scope.target,purpose:"task",evidence:measurements,limits,
    reservations:[],policy:{id:"capacity",revision:"1",purpose:"task",basis:"exact bytes",allowUnknown:true,allowEstimatedFit:false}})};
  const readiness={kind:"recipient_prepared",scope,inputId:"input",bodyDigest:"body",exactInputDigest:"exact",judgmentId:"judgment",allowed:true,risks:[],capacity,
    evidence:{id:"original",owner:scope.owner,revision:"1",kind:"fact"}};
  const original={result:async()=>({kind:"prepared",stage:{request:{input:{plan:{inputSupply,history:{id:"history"}}}}},value:{preparation:{scope,capacity},readiness}})};
  const history:any[]=[],methods={describe:async()=>({state:"active",revision:1,used:{stages:1,attempts:1,readBytes:null,storedBytes:null,modelCalls:null},remaining:{},allowance:{reserved:{}},limitations:[]}),prepareSubmission:vi.fn(),prepareClosure:vi.fn()};
  const activities={command:vi.fn(async(c:any)=>c.kind==="read_path"?{intent:{id:c.pathId,purpose:{digest:"receiver"}}}:[])},
    decisions={query:async()=>null,investments:async()=>history},responsibilities={query:vi.fn(async()=>null)};
  const work=new HelarcNativeInputPreparation({activities,decisions,responsibilities,methods,original,selections:{command:async()=>null}} as never);
  const origin={activityDigest:digest(activity),preparedDigest:digest(prepared),inputNeedDigest:digest(inputNeed),inputSupplyDigest:digest(inputSupply),historyDigest:digest({id:"history"})};
  const family=(id:string)=>({id,origin,owns:()=>false,ownsReception:()=>false,collect:vi.fn(async()=>({offers:[],reuseOptions:[],receptions:[],
    report:{owner:id,revision:"1",sourceBoundary:"boundary",enumeration:{complete:true,eligible:0,returned:0},unavailable:[],offers:[],originalWork:[]},
    receptionReport:{complete:true,examined:0,conflicts:0,returned:[],restored:[]}}))}) as HelarcNativePreparationSupply;
  const suppliers=[family("account"),family("compact")];
  const b={demand,originalPathId:"original",inputSupply,observation:{settingsRevision:"fixed",sequence:0,inputRevision:0,representationContinuity:"original"},
    autoPrepare:true,rejectedInputs:[],supplies:suppliers,execution:vi.fn()};
  const snapshot={state:{subscription:{id:"subscription",owner:scope.owner,runId:"root",binding:{kind:"input_need",id:"need"}},observedSources:[],revision:0},through:0,facts:[]};
  const run=()=>work.prepare(b as never,snapshot as never,new AbortController().signal);
  const addProducer=()=>history.push({input:{scope,boundary:prepared.sourceDigest,requirementsDigest:digest([]),explorationHistory:[],options:[{id:"old",request:{method:"protocol",execution:{owner:"native"}},stableScope:{owner:"native"}}]},
    decision:{scope,id:"old-decision",investment:{kind:"propose",optionId:"old",reason:"necessary"}},investment:{pathId:"original-work",workId:"original-work",schedulingScopeId:"root"}});
  return {run,b,suppliers,history,addProducer,activities,methods};
}
describe("native input preparation collection",()=>{
  it("collects independent supplies into one policy acceptance without starting their work",async()=>{
    const f=fixture(),value=await f.run();
    expect(value.participants.filter(p=>p.owner==="context_preparation_policy"&&p.kind==="decision")).toHaveLength(1);
    for(const s of f.suppliers)expect(s.collect).toHaveBeenCalledTimes(1);
    expect(f.methods.prepareSubmission).not.toHaveBeenCalled();expect(value.close).toBe(true);
  });
  it("rejects another demand or history even if its supply is otherwise valid",async()=>{
    const f=fixture();f.b.supplies=[{...f.suppliers[0]!,origin:{...f.suppliers[0]!.origin,preparedDigest:"different"}}];
    await expect(f.run()).rejects.toThrow("supply_origin_changed");
    expect(f.suppliers[0]!.collect).not.toHaveBeenCalled();
  });
  it.each(["none","two"])("rejects %s owners for original work before collecting new opportunities",async mode=>{
    const f=fixture();f.addProducer();if(mode==="two")f.b.supplies=f.suppliers.map(s=>({...s,owns:()=>true}));
    await expect(f.run()).rejects.toThrow("supply_owner_not_unique");
    expect(f.suppliers[0]!.collect).not.toHaveBeenCalled();
  });
  it("does not let bounded new enumeration erase an accepted producer",async()=>{
    const f=fixture();f.addProducer();f.b.supplies=[{...f.suppliers[0]!,owns:()=>true}];
    await expect(f.run()).rejects.toThrow("supply_evidence_incomplete");
  });
});
