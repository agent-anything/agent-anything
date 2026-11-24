import {describe,it,expect} from "vitest";
import {HelarcNativeWorkingInput,type HelarcNativeWorkingGroupBasis} from "./HelarcNativeWorkingSources.js";
import {helarcNativeAccountScopes,helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import {realizeHelarcNativeAccount,realizeHelarcNativeAccounts} from "./HelarcNativeAccountRealization.js";
import {helarcNativeSourceBytes} from "./HelarcNativeSourcePublications.js";
const ref=(id:string)=>({id,revision:"1"});
function fixture(){
  const working=new HelarcNativeWorkingInput();
  const basis=(id:string,extra:Partial<HelarcNativeWorkingGroupBasis>={}):HelarcNativeWorkingGroupBasis=>({id,originRunId:"prior-run",sources:[{source:{owner:"native",kind:"fact",...ref(id)},position:""}],
    duties:["continuity"],preservation:{obligations:[{id:"keep",requirement:"account",basis:`Retain ${id} and uncertainty`}],relationships:[]},
    exchangeId:null,protection:[],acceptedBy:{runId:"prior-run",activityId:"old",acceptance:ref("accepted")},representations:[],...extra});
  working.append([{role:"user",content:"Original goal"}],basis("goal",{preservation:{obligations:[{id:"exact",requirement:"exact",basis:"Unchanged goal"}],relationships:[]}}));
  working.append([{type:"function_call",call_id:"call",name:"Read",arguments:"{}"}],basis("call",{exchangeId:"exchange"}));
  working.append([{type:"function_call_output",call_id:"call",output:"Unconfirmed code: 7391"}],basis("outcome",{exchangeId:"exchange",representations:[ref("earlier")] }));
  working.append([{role:"user",content:"New information, not yet received"}],basis("pending",{originRunId:"root",protection:["first_delivery"],acceptedBy:null}));
  const original={runId:"root",items:working.items,sources:working.snapshot()};
  const scope=helarcNativeAccountScopes({...original,maximum:8,backgroundGroupIds:["goal"]}).scopes[0]!;
  return {...original,scope,account:{text:"The Read outcome reported unconfirmed code 7391.",representation:ref("account")}};
}
describe("native historical account realization",()=>{
  it("replaces a complete exchange at its original position, retaining the goal and pending input",()=>{
    const f=fixture(),r=realizeHelarcNativeAccount(f);
    expect(r.items).toHaveLength(3);expect(r.items[0]).toEqual(f.items[0]);expect(r.items[2]).toEqual(f.items[3]);
    expect(r.items[1]!.content).toContain("not a new user instruction");
    expect(r.sources.groups[2]).toMatchObject({id:"pending",protection:["first_delivery"],acceptedBy:null});
    expect(r.replacement).toMatchObject({start:1,end:3,count:1});
    const g=r.sources.groups[1]!;
    expect(g.derivedFrom).toEqual(f.sources.groups.slice(1,3).map(g=>({groupId:g.id,originRunId:g.originRunId,revision:helarcNativeWorkingGroupRevision(g)})));
    expect(g.preservation.obligations.map(o=>o.id)).toEqual(["call:keep","outcome:keep"]);
    expect(g.representations).toEqual([ref("earlier"),ref("account")]);
    expect(g.acceptedBy).toBeNull();expect(g.exchangeId).toBeNull();
    expect(JSON.parse(helarcNativeSourceBytes(g,r.items).toString()).derivedFrom).toEqual(g.derivedFrom);
  });
  it("retains previous lineage and preservation responsibilities through another proposed conversion",()=>{
    const f=fixture(),first=realizeHelarcNativeAccount(f);
    const scope=helarcNativeAccountScopes({runId:f.runId,items:first.items,sources:first.sources,maximum:8,backgroundGroupIds:["goal"]}).scopes[0]!;
    const next=realizeHelarcNativeAccount({runId:f.runId,items:first.items,sources:first.sources,scope,account:{text:"Read: unconfirmed 7391.",representation:ref("shorter")}});
    const g=next.sources.groups[1]!;
    expect(g.derivedFrom).toEqual(expect.arrayContaining(first.sources.groups[1]!.derivedFrom!));
    expect(g.derivedFrom).toHaveLength(3);expect(g.preservation.obligations).toHaveLength(2);
    expect(g.representations).toEqual([ref("earlier"),ref("account"),ref("shorter")]);
    expect(next.items[0]).toEqual(f.items[0]);expect(next.items[2]).toEqual(f.items[3]);
  });
  it.each(["empty","source","partial-exchange","protection"])("rejects %s instead of silently broadening conversion",change=>{
    const f=fixture();
    const changed=change==="empty"?{...f,account:{...f.account,text:" "}}:
      change==="source"?{...f,items:f.items.map((i,n)=>n===2?{...i,output:"changed"}:i)}:
      change==="partial-exchange"?{...f,scope:{...f.scope,groups:f.scope.groups.filter(g=>g.id!=="outcome")}}:
      {...f,sources:{...f.sources,groups:f.sources.groups.map(g=>g.id==="outcome"?{...g,protection:["active_exchange" as const]}:g)}};
    expect(()=>realizeHelarcNativeAccount(changed)).toThrow();
  });
  it("combines disjoint original scopes in source order, not producer completion order",()=>{
    const f=fixture(),working=new HelarcNativeWorkingInput();
    for(const g of f.sources.groups){const {occurrence,...basis}=g;working.append(f.items.slice(occurrence.start,occurrence.start+occurrence.count),basis);}
    working.append([{role:"assistant",content:"An independent later investigation"}],{...f.sources.groups[1]!,id:"later",exchangeId:null,representations:[]});
    const original={runId:f.runId,items:working.items,sources:working.snapshot()};
    const scopes=helarcNativeAccountScopes({...original,maximum:8,backgroundGroupIds:["goal"]}).scopes;
    const r=realizeHelarcNativeAccounts({...original,members:[{scope:scopes[1]!,account:{text:"Later account",representation:ref("later-account")}},
      {scope:scopes[0]!,account:f.account}]});
    expect(r.items).toHaveLength(4);expect(r.items[0]).toEqual(f.items[0]);expect(r.items[2]).toEqual(f.items[3]);
    expect(r.items[1]!.content).toContain(f.account.text);expect(r.items[3]!.content).toContain("Later account");
    expect(r.replacements.map(r=>[r.start,r.end])).toEqual([[1,3],[4,5]]);
    expect(r.sources.groups[2]!.protection).toEqual(["first_delivery"]);
  });
  it("rejects overlapping accounts even when both individual scopes are legal",()=>{
    const f=fixture();expect(()=>realizeHelarcNativeAccounts({...f,members:[{scope:f.scope,account:f.account},
      {scope:f.scope,account:{text:"Another version",representation:ref("alternative")}}]})).toThrow("replacement_overlap");
  });
});
