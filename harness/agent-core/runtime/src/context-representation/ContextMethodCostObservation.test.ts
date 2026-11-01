import {describe,it,expect,vi} from "vitest";
import type {ActivityHandoffFact,ActivityHandoffCommand} from "../activity/index.js";
import {readContextMethodCostObservation} from "./ContextMethodCostObservation.js";

function fact(sequence:number,usage:unknown=null):ActivityHandoffFact {
  return {sequence,runId:"child",pathId:"method",requestId:`stage:${sequence}`,kind:"raw_saved",occurredAt:"2026-10-30T00:00:00.000Z",
    details:{resultId:`result:${sequence}`,attemptId:`attempt:${sequence}`,outcome:"returned",completeness:"complete",usage}};
}
const signal=new AbortController().signal;
describe("bounded original method cost facts",()=>{
  it("restores a cursor and never counts recovered results twice",async()=>{
    const all=[fact(2,{providerElapsedMs:25,inputTokens:400,outputTokens:100}),fact(9,{localMs:3})];
    const activities={command:vi.fn(async(command:ActivityHandoffCommand)=>{
      if(command.kind!=="facts")throw new Error("Only fact queries");return all.filter(f=>f.sequence>command.after);
    })};
    const input={runId:"child",pathId:"method",activities,previous:null};
    const first=await readContextMethodCostObservation(input,signal);
    expect(first).toMatchObject({through:9,rawResults:2,reported:{providerElapsedMs:{total:25,samples:1},inputTokens:{total:400,samples:1},localMs:{total:3,samples:1}}});
    expect(await readContextMethodCostObservation({...input,previous:JSON.parse(JSON.stringify(first))},signal)).toEqual(first);
    expect(activities.command).toHaveBeenLastCalledWith({kind:"facts",runId:"child",pathId:"method",after:9,limit:256});
  });
  it("retains failure, partial and unknown outcomes without assigning absent usage zero",async()=>{
    const failure={...fact(1),details:{...fact(1).details,outcome:"failed",usage:{providerElapsedMs:9,inputTokens:null}}};
    const unknown={...fact(2),details:{...fact(2).details,outcome:"unknown",completeness:"partial",usage:{localMs:-1,outputTokens:"unknown"}}};
    const activities={command:vi.fn(async()=>[failure,unknown])};
    const result=await readContextMethodCostObservation({runId:"child",pathId:"method",activities,previous:null},signal);
    expect(result).toMatchObject({rawResults:2,outcomes:{returned:0,failed:1,unknown:1},partialResults:1,reported:{providerElapsedMs:{total:9,samples:1}}});
    expect(result.reported.inputTokens).toBeUndefined();expect(result.reported.outputTokens).toBeUndefined();
  });
  it("stops after a bounded page and preserves incomplete coverage",async()=>{
    const activities={command:vi.fn(async()=>Array.from({length:256},(_,i)=>fact(i+1)))};
    const result=await readContextMethodCostObservation({runId:"child",pathId:"method",activities,previous:null},signal);
    expect(result).toMatchObject({through:256,caughtUpAtRead:false,rawResults:256,reported:{}});
    expect(result.limitations).toContain("cost_fact_read_incomplete");expect(activities.command).toHaveBeenCalledTimes(1);
  });
  it("rejects reordered, foreign, or duplicated facts and observes cancellation",async()=>{
    for(const facts of [[fact(2),fact(1)],[fact(1),fact(1)],[{...fact(1),runId:"parent"}]]) {
      const activities={command:vi.fn(async()=>facts)};
      await expect(readContextMethodCostObservation({runId:"child",pathId:"method",activities,previous:null},signal)).rejects.toThrow("fact_scope_invalid");
    }
    const controller=new AbortController();controller.abort(new Error("cancelled"));const activities={command:vi.fn(async()=>[])};
    await expect(readContextMethodCostObservation({runId:"child",pathId:"method",activities,previous:null},controller.signal)).rejects.toThrow("cancelled");
    expect(activities.command).not.toHaveBeenCalled();
  });
});
