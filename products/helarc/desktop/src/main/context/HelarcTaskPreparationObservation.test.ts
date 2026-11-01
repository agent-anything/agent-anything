import {describe,expect,it,vi} from "vitest";
import type {ContextPreparationDecisionRecord,ContextPreparationPolicyInput,PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcOriginalInputSupplyPorts} from "./HelarcOriginalInputSupply.js";
import type {TaskModelSource} from "@agent-anything/agent-runtime/decision";

vi.mock("./HelarcOriginalInputSupply.js",()=>({createHelarcOriginalInputSupply:(ports:HelarcOriginalInputSupplyPorts<TaskModelSource>)=>ports,
  supplyHelarcOriginalInputRepresentationMethods:()=>({offers:[],report:{owner:"test",revision:"1",sourceBoundary:"H",enumeration:{complete:true,eligible:0,returned:0},unavailable:[],offers:[]}})}));
vi.mock("@agent-anything/helarc/prompt",async original=>({...await original<object>(),createHelarcTaskInputSources:()=>({})}));
vi.mock("@agent-anything/agent-runtime/context-representation",async original=>{
  const actual=await original<typeof import("@agent-anything/agent-runtime/context-representation")>();
  return {...actual,readContextPreparationHistory:async()=>({producers:[]}),decideContextPreparation:()=>({investment:{kind:"none"},foreground:{kind:"limited"}}),
    originalInputReceptionTemplate:()=>({}),originalInputReceptionCombinations:()=>({combinations:[],complete:true,examined:0,conflicts:0}),
    contextPreparationReconsideration:(ports:{resolve:()=>Promise<{policy:ContextPreparationPolicyInput}>})=>({prepare:async()=>({
      participants:[{owner:"context_preparation_policy",kind:"decision",proposal:{input:(await ports.resolve()).policy}}],close:true})})};
});
import {createHelarcTaskPreparation} from "./HelarcTaskPreparation.js";

const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"target",continuity:"task",owner:"context-representation",authorityBasis:"host"};
describe("task preparation observation wiring",()=>{
  it("observes baselines only, restores across gaps, and marks accepted rather than pending representations",async()=>{
    let latest:ContextPreparationDecisionRecord|null=null,observation:ContextPreparationDecisionRecord|null=null;
    const decisions={query:vi.fn(async(q:{kind:string})=>q.kind==="latest_observation"?observation:latest),investments:async()=>[]};
    const ports={activities:{command:vi.fn()},decisions,selections:{command:async()=>null},responsibilities:{query:async()=>null},materials:{},methods:{},methodInputs:{},methodConsumers:{},
      binding:async()=>({context:{id:"settings",policy:{},settings:{settings:{autoRepresentation:true}}},treeScopeId:"tree",localPoolId:"local",modelPoolId:"model"})};
    const supply=createHelarcTaskPreparation(ports as never) as unknown as Pick<HelarcOriginalInputSupplyPorts<TaskModelSource>,"decide"|"describe">;
    const ordinary={opening:null,historyPresentations:[],workingForms:[],workingAccounts:[]};
    const accepted={...ordinary,historyPresentations:[{section:{id:"root:history:1",provenance:{presenter:{owner:"agent-runtime",kind:"result_presentation_receipt",id:"accepted-receipt",revision:"1"}}}}]};
    const step=async(sequence:number,prepared:boolean,interaction=ordinary as unknown)=>{
      const current=prepared?{kind:"prepared",prepared:{encoded:{id:`baseline:${sequence}`},demand:{...scope,targetRevision:scope.target},measurement:[],limits:[],capacity:{reservations:[]}} as unknown as PreparedContextInput,
        evidence:{id:`prepare:${sequence}`,owner:"activity",kind:"fact",revision:"1"}}:
        {kind:"gap",gap:{targetRevision:scope.target},evidence:{id:`gap:${sequence}`,owner:"activity",kind:"fact",revision:"1"}};
      const basis={source:{record:{source:{iteration:sequence,interaction,agent:{id:"agent"}}},request:{purpose:"task"}},sourceStage:{request:{id:"source",input:{}},result:{recordedAt:`2026-10-31T00:00:0${sequence}Z`}},
        consumer:{cancelled:false,intent:{runId:"root",deadlineAt:"2030-01-01T00:00:00Z"}},need:{id:"need",supplier:"context-representation",unavailableStage:{}}};
      const proposal=await supply.decide(basis as never,
        {scope,sources:{boundary:"H",groups:[]},input:{},rejectedInputs:[],observation:supply.describe(basis as never).observation} as never,
        {kind:"available",current} as never,{} as never,new AbortController().signal);
      const policy=(proposal.participants.find(p=>p.owner==="context_preparation_policy")!.proposal as {input:ContextPreparationPolicyInput}).input;
      expect(policy.current).toBe(current);
      expect(policy.alternatives).toEqual([]);
      latest={input:policy} as ContextPreparationDecisionRecord;
      if(policy.observationReport)observation=latest;
      return policy;
    };
    await step(1,true);
    const before=observation;
    for(let reconsideration=0;reconsideration<3;reconsideration++) {
      expect((await step(2,false)).observationReport).toBeUndefined();
      expect(observation).toBe(before);
    }
    expect(decisions.query).toHaveBeenCalledTimes(1);
    const later=await step(3,true,accepted),window=later.observationReport!.window;
    expect(window.inputs.map(i=>i.inputId)).toEqual(["baseline:1","baseline:3"]);
    expect(window.inputs[0]!.representationContinuity).toBe("original");
    expect(window.inputs[1]!.representationContinuity).toMatch(/^accepted-representations:/);
    const next=await step(4,true,accepted);
    expect(next.observationReport!.window.inputs.at(-1)!.representationContinuity).toBe(window.inputs[1]!.representationContinuity);
    expect(decisions.query.mock.calls.every(([q])=>q.kind==="latest_observation")).toBe(true);
  });
});
