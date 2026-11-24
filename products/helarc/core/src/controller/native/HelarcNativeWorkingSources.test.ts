import {describe,it,expect} from "vitest";
import type {ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import {HelarcNativeWorkingInput,validateHelarcNativeWorkingSources,substituteHelarcNativeWorkingSources,type HelarcNativeWorkingGroupBasis} from "./HelarcNativeWorkingSources.js";
const ref=(id:string)=>({id,revision:"1"});
const basis=(id:string):HelarcNativeWorkingGroupBasis=>({id,originRunId:"root",sources:[{source:{owner:"host",kind:"task",...ref("original")},position:"/task/input"}],
  duties:["objective"],preservation:{obligations:[{id:"objective",requirement:"account",basis:"Retain the objective and accepted corrections"}],relationships:[]},
  exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
function fixture(){const w=new HelarcNativeWorkingInput();w.append([{role:"user",content:"original objective"}],basis("objective"));
  w.append([{role:"assistant",content:"a"},{role:"tool",content:"outcome"}],{...basis("exchange"),exchangeId:"native-response",protection:["active_exchange"],duties:["continuity","evidence"]});return w;}
describe("native working input source custody",()=>{
  it("covers actual native occurrences without inventing normalized messages or Turns",()=>{
    const w=fixture(),s=w.snapshot();expect(s.groups.map(g=>g.occurrence)).toMatchObject([{start:0,count:1},{start:1,count:2}]);
    expect(()=>validateHelarcNativeWorkingSources(s,w.items)).not.toThrow();
  });
  it.each(["missing","overlap","content","source","obligation","protection"])("rejects %s source evidence",kind=>{
    const w=fixture(),s=structuredClone(w.snapshot()) as any;
    if(kind==="missing")s.groups.pop();if(kind==="overlap")s.groups[1].occurrence.start=0;
    if(kind==="content")s.groups[0].occurrence.digest="changed";if(kind==="source")s.groups[0].sources=[];
    if(kind==="obligation")s.groups[0].preservation.obligations=[];if(kind==="protection")s.groups[0].protection=["active_exchange"];
    expect(()=>validateHelarcNativeWorkingSources(s,w.items)).toThrow();
  });
  it("moves transient protection only across confirmed original recipient acceptance without losing obligations",()=>{
    const w=fixture(),original=w.snapshot(),next=new HelarcNativeWorkingInput(),evidence={scope:{runId:"root",activityId:"accepted-input"},acceptance:ref("accepted")} as ModelPurposeEvidence;
    next.inherit(w.items,original,evidence);next.append([{role:"user",content:"new correction"}],basis("new"));
    const s=next.snapshot();expect(s.groups[0]!.preservation).toEqual(original.groups[0]!.preservation);
    expect(s.groups[0]!.sources).toEqual(original.groups[0]!.sources);expect(s.groups[1]!.exchangeId).toBe("native-response");
    expect(s.groups[0]!.protection).toEqual([]);expect(s.groups[1]!.protection).toEqual([]);expect(s.groups[2]!.protection).toEqual(["first_delivery"]);
    expect(s.groups[0]!.acceptedBy?.activityId).toBe("accepted-input");expect(original.groups[0]!.protection).toEqual(["first_delivery"]);
  });
  it("retains source identity and prior representations across repeated declared substitutions",()=>{
    const w=fixture(),selected=[...w.items.slice(0,2),{role:"tool",content:"shorter"}];
    const first=substituteHelarcNativeWorkingSources({original:w.items,selected,sources:w.snapshot(),changes:[{index:2,representation:ref("account-1")}]});
    const second=substituteHelarcNativeWorkingSources({original:selected,selected:[...selected.slice(0,2),{role:"tool",content:"short"}],sources:first,changes:[{index:2,representation:ref("account-2")}]});
    expect(second.groups[1]!.representations).toEqual([ref("account-1"),ref("account-2")]);
    expect(second.groups[1]!.preservation).toEqual(w.snapshot().groups[1]!.preservation);expect(second.groups[1]!.sources).toEqual(w.snapshot().groups[1]!.sources);
  });
  it("rejects unrelated rewrites and position changes instead of guessing new coverage",()=>{
    const w=fixture(),input={original:w.items,selected:w.items,sources:w.snapshot(),changes:[{index:2,representation:ref("account")}]};
    expect(()=>substituteHelarcNativeWorkingSources({...input,selected:[{role:"user",content:"changed goal"},...w.items.slice(1)]})).toThrow("unrelated_content_changed");
    expect(()=>substituteHelarcNativeWorkingSources({...input,selected:w.items.slice(1)})).toThrow("shape_changed");
    expect(()=>substituteHelarcNativeWorkingSources({...input,changes:[{index:9,representation:ref("account")}]})).toThrow("position_invalid");
  });
});
