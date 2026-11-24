import {describe,it,expect} from "vitest";
import {HelarcNativeWorkingInput,type HelarcNativeWorkingGroupBasis} from "./HelarcNativeWorkingSources.js";
import {helarcNativeAccountScopes,helarcNativeWorkingGroupRevision,validateHelarcNativeAccountScope} from "./HelarcNativeAccountScopes.js";
const source=(id:string)=>({owner:"native",kind:"original",id,revision:"1"});
const basis=(id:string,extra:Partial<HelarcNativeWorkingGroupBasis>={}):HelarcNativeWorkingGroupBasis=>({id,originRunId:"root",sources:[{source:source(id),position:""}],
  duties:["continuity"],preservation:{obligations:[{id,requirement:"account",basis:"Retain original facts and their limitations"}],relationships:[]},
  protection:[],exchangeId:null,representations:[],acceptedBy:{runId:"root",activityId:"accepted",acceptance:{id:"receipt",revision:"1"}},...extra});
function scopes(values:HelarcNativeWorkingGroupBasis[],maximum=32,backgroundGroupIds:string[]=[]){
  const w=new HelarcNativeWorkingInput();for(const v of values)w.append([{role:"user",content:v.id}],v);
  return helarcNativeAccountScopes({runId:"root",items:w.items,sources:w.snapshot(),maximum,backgroundGroupIds});
}
describe("native account scope eligibility",()=>{
  it("keeps a native response, interleaved notification and its outcomes together",()=>{
    const r=scopes([basis("response",{exchangeId:"exchange"}),basis("notification"),basis("result",{exchangeId:"exchange"}),basis("later")]);
    expect(r.scopes.map(s=>s.groups.filter(g=>g.role==="source").map(g=>g.id))).toEqual([
      ["response","notification","result","later"],["response","notification","result"],["later"]]);
  });
  it.each(["first_delivery","active_exchange"] as const)("does not transform %s or split its native companions",protection=>{
    const r=scopes([basis("response",{exchangeId:"exchange"}),basis("result",{exchangeId:"exchange",protection:[protection]}),basis("old")]);
    expect(r.scopes.map(s=>s.groups.map(g=>g.id))).toEqual([["old"]]);
    expect(r.exclusions).toContainEqual({groupId:"response",reasons:["native_exchange_companion_protected"]});
  });
  it("requires the original source and explicit companion as common evidence, without guessing meaning",()=>{
    const b=basis("fact"),fact={...b,preservation:{...b.preservation,relationships:[{kind:"qualifies" as const,source:source("correction")}]}};
    const r=scopes([fact,basis("correction",{protection:["first_delivery"]})]);
    expect(r.scopes[0]!.groups.map(g=>[g.id,g.role])).toEqual([["fact","source"],["correction","background"]]);
    expect(r.scopes[0]!.relationships[0]).toMatchObject({sources:["source_0","source_1"],requiresCommonEvidence:true});
    expect(scopes([fact]).scopes).toEqual([]);
  });
  it("does not treat a missing relation in background as evidence of independence",()=>{
    const b=basis("goal"),goal={...b,preservation:{...b.preservation,relationships:[{kind:"requires" as const,source:source("missing")}]}};
    const r=scopes([basis("old"),goal],32,["goal"]);expect(r.scopes).toEqual([]);
    expect(r.exclusions.every(e=>e.reasons.includes("declared_companion_unavailable"))).toBe(true);
  });
  it("reports incomplete bounded enumeration rather than silently claiming full supply",()=>{
    const r=scopes([basis("one"),basis("two"),basis("three")],1);
    expect(r.enumeration).toEqual({complete:false,eligible:4,returned:1});
  });
  it("keeps exact preservation out of semantic accounts and reuses stable capture versions",()=>{
    const b=basis("exact"),exact={...b,preservation:{obligations:[{id:"exact",requirement:"exact" as const,basis:"Exact access reference"}],relationships:[]}};
    expect(scopes([exact]).scopes).toEqual([]);
    const w=new HelarcNativeWorkingInput();w.append([{role:"user",content:"fact"}],basis("fact"));const g=w.snapshot().groups[0]!;
    expect(helarcNativeWorkingGroupRevision({...g,protection:["first_delivery"],occurrence:{...g.occurrence,start:3}})).toBe(helarcNativeWorkingGroupRevision(g));
    expect(helarcNativeWorkingGroupRevision({...g,representations:[{id:"summary",revision:"1"}]})).not.toBe(helarcNativeWorkingGroupRevision(g));
  });
  it("revalidates an accepted scope independently of bounded enumeration",()=>{
    const original=new HelarcNativeWorkingInput();original.append([{role:"user",content:"retained"}],basis("retained"));
    const scope=helarcNativeAccountScopes({runId:"root",items:original.items,sources:original.snapshot(),maximum:1,backgroundGroupIds:[]}).scopes[0]!;
    const current=new HelarcNativeWorkingInput();
    for(let i=0;i<140;i++)current.append([{role:"user",content:String(i)}],basis(`new-${i}`));
    current.append(original.items,basis("retained"));
    expect(helarcNativeAccountScopes({runId:"root",items:current.items,sources:current.snapshot(),maximum:128,backgroundGroupIds:[]}).scopes.some(s=>s.id===scope.id)).toBe(false);
    expect(()=>validateHelarcNativeAccountScope({runId:"root",items:current.items,sources:current.snapshot(),scope})).not.toThrow();
  });
});
