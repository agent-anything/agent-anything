import {describe,expect,it,vi} from "vitest";
import {readContextPreparationHistory,type ContextPreparationCurrentEvidence} from "./ContextPreparationHistory.js";
import {contextPreparationApplicabilityKey,type ContextPreparationOption} from "./ContextPreparationPolicy.js";
import type {ContextPreparationDecisionRecord,ContextPreparationDecisionStore} from "./ContextPreparationDecisionStore.js";

function fixture(count=1) {
  const current:ContextPreparationCurrentEvidence={scope:{id:"scope",runId:"root",recipient:"agent",purpose:"task",continuity:"main",
    owner:"context-representation",target:"original-target",authorityBasis:"original-authority"},boundary:"H",requirementsDigest:"requirements",
    current:{kind:"gap",gap:{reason:"input missing",demandId:"demand",targetRevision:"original-target",information:[],capacity:[],untested:true,responsibility:"request_owner"},
      evidence:{id:"prepared",revision:"1",owner:"context-representation",kind:"fact"}},currentRejectedInputId:null,
    alternatives:[],pressure:[],options:[],autoPrepare:true,consumerActive:true};
  const key=contextPreparationApplicabilityKey(current);
  Object.assign(current,{options:[{id:"method",request:{kind:"representation_method",sourceBoundary:"stable-original"}} as ContextPreparationOption]});
  const records:ContextPreparationDecisionRecord[]=Array.from({length:count},(_,i)=>({
    decision:{id:`decision:${i}`,scope:current.scope,applicabilityKey:key,investment:{kind:"propose",optionId:"method",reason:"optional",explorationKey:"explored"}},
    input:{...current,explorationHistory:[{key:"older",decisionId:"original-decision"}]},
    acceptanceId:`accepted:${i}`,investment:{workId:`work:${String(i).padStart(3,"0")}`,pathId:`path:${i}`,schedulingScopeId:"tree"},
  } as ContextPreparationDecisionRecord));
  const query=vi.fn(async()=>records.at(-1)??null);
  const investments=vi.fn(async(input:{scopeId:string;afterWorkId:string|null;limit:number})=>{
    expect(input.scopeId).toBe(current.scope.id);
    const start=input.afterWorkId===null?0:records.findIndex(r=>r.investment!.workId===input.afterWorkId)+1;
    return records.slice(start,start+input.limit);
  });
  const decisions:ContextPreparationDecisionStore={query,investments};
  const describe=vi.fn(async(_pathId:string)=>({state:"active" as "active"|"ready"|"unknown"|"failed",revision:3}));
  const controller=new AbortController();
  const read=()=>readContextPreparationHistory({current,decisions,methods:{describe}},controller.signal);
  return {current,records,query,investments,describe,read,controller};
}

describe("accepted context preparation history",()=>{
  it("reads every page and preserves identities while deduplicating repeated evidence references",async()=>{
    const f=fixture(65),result=await f.read();
    expect(f.investments.mock.calls.map(([input])=>input.afterWorkId)).toEqual([null,"work:063"]);
    expect(f.describe).toHaveBeenCalledTimes(65);
    expect(result.basis.inFlight).toHaveLength(65);expect(result.basis.optionalInFlight).toBe(65);
    expect(result.basis.explorationHistory).toHaveLength(66);
    expect(result.basis.explorationHistory.filter(e=>e.key==="older")).toEqual([{key:"older",decisionId:"original-decision"}]);
    expect(result.previous).toBe(f.records[64]);expect(result.producers[0]!.record).toBe(f.records[0]);
  });
  it("retains original work across an input boundary; policy must separately establish current applicability",async()=>{
    const f=fixture();Object.assign(f.current,{boundary:"new-H"});f.describe.mockResolvedValue({state:"unknown",revision:4});
    const result=await f.read();expect(result.basis.inFlight).toHaveLength(1);expect(result.basis.optionalInFlight).toBe(1);
    expect(result.basis.explorationHistory).toContainEqual({key:"explored",decisionId:"decision:0"});
  });
  it("reports ready, failed and unknown producers without adopting, restarting or dropping them",async()=>{
    const f=fixture(3);f.describe.mockResolvedValueOnce({state:"ready",revision:8}).mockResolvedValueOnce({state:"failed",revision:9}).mockResolvedValueOnce({state:"unknown",revision:10});
    const result=await f.read();expect(result.basis.inFlight.map(p=>p.producerState)).toEqual(["ready","failed","unknown"]);
    expect(result.basis.optionalInFlight).toBe(1);expect(result.basis.current).toBe(f.current.current);
  });
  it.each(["runId","recipient","purpose","target","authorityBasis"] as const)("rejects another %s instead of borrowing its history",async field=>{
    const f=fixture();Object.assign(f.records[0]!,{decision:{...f.records[0]!.decision,scope:{...f.current.scope,[field]:"other"}}});
    await expect(f.read()).rejects.toThrow("context_preparation_history_scope_changed");expect(f.describe).not.toHaveBeenCalled();
  });
  it("retains original rejection evidence and refuses contradictory content under the same identity",async()=>{
    const f=fixture(),limitation={optionId:"option",conditionsDigest:"original",acceptanceId:"rejection",code:"activity_schedule_resource_unavailable"};
    Object.assign(f.records[0]!.input,{admissionLimitations:[limitation]});Object.assign(f.current,{admissionLimitations:[limitation]});
    expect((await f.read()).basis.admissionLimitations).toEqual([limitation]);
    Object.assign(f.current,{admissionLimitations:[{...limitation,conditionsDigest:"changed"}]});
    await expect(f.read()).rejects.toThrow("context_preparation_history_limitation_changed");
  });
  it("propagates unavailable original work rather than supplying empty history",async()=>{
    const f=fixture();f.describe.mockRejectedValue(new Error("original path unavailable"));
    await expect(f.read()).rejects.toThrow("original path unavailable");
  });
  it("stops on cancellation and rejects non-progressing pages",async()=>{
    const f=fixture(65);f.describe.mockImplementation(async()=>{f.controller.abort(new Error("cancel read"));return {state:"active",revision:1};});
    await expect(f.read()).rejects.toThrow("cancel read");expect(f.describe).toHaveBeenCalledOnce();
    const g=fixture(64);g.investments.mockImplementation(async()=>g.records);
    await expect(g.read()).rejects.toThrow("context_policy_original_investment_invalid");expect(g.investments).toHaveBeenCalledTimes(2);
  });
  it("keeps the zero-work case explicit without manufacturing preparation facts",async()=>{
    const f=fixture(0),result=await f.read();expect(result.previous).toBeNull();expect(result.producers).toEqual([]);
    expect(result.basis).toMatchObject({inFlight:[],explorationHistory:[],optionalInFlight:0});expect(f.describe).not.toHaveBeenCalled();
  });
});
