import {describe,it,expect} from "vitest";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {helarcNativeAccountScopes} from "./HelarcNativeAccountScopes.js";
import {helarcNativeAccountCombinations,validateHelarcNativeAccountMembers} from "./HelarcNativeAccountCombinations.js";
import type {HelarcNativeAccountReceptionMember} from "./HelarcNativeAccountReception.js";

function fixture(){
  const w=new HelarcNativeWorkingInput();
  for(const id of ["first","second"])w.append([{role:"assistant",content:id}],{id,originRunId:"root",
    sources:[{source:{owner:"native",kind:"fact",id,revision:"1"},position:""}],duties:["continuity"],
    preservation:{obligations:[{id,requirement:"account",basis:`Keep ${id}`}],relationships:[]},exchangeId:null,
    protection:[],representations:[],acceptedBy:{runId:"root",activityId:id,acceptance:{id,revision:"1"}}});
  const basis={runId:"root",items:w.items,sources:w.snapshot()};
  const scopes=helarcNativeAccountScopes({...basis,maximum:16,backgroundGroupIds:[]}).scopes;
  const members=scopes.map((scope,i)=>({methodPathId:`producer-${i}`,candidateId:`candidate-${i}`,supply:{scope}} as HelarcNativeAccountReceptionMember));
  return {...basis,members,maximum:16,maximumInspections:128};
}
describe("native account reception alternatives",()=>{
  it("accepts disjoint scopes together but retains overlapping accounts as alternatives",()=>{
    const input=fixture(),result=helarcNativeAccountCombinations(input);
    expect(result.complete).toBe(true);expect(result.conflicts).toBeGreaterThan(0);
    expect(result.combinations.map(c=>c.map(m=>m.methodPathId))).toEqual([
      ["producer-0"],["producer-1","producer-2"],["producer-1"],["producer-2"]]);
    for(const members of result.combinations)expect(()=>validateHelarcNativeAccountMembers(input,members)).not.toThrow();
  });
  it("reports bounds without making original receiver validation depend on enumeration",()=>{
    const input=fixture(),original=input.members.slice(1);
    const limited=helarcNativeAccountCombinations({...input,maximum:1});
    expect(limited.complete).toBe(false);expect(limited.combinations).toHaveLength(1);
    expect(()=>validateHelarcNativeAccountMembers(input,original)).not.toThrow();
    expect(helarcNativeAccountCombinations({...input,maximumInspections:1})).toMatchObject({complete:false,examined:1,combinations:[]});
  });
  it("rejects duplicate producers, changed source and overlapping original membership",()=>{
    const input=fixture();
    expect(()=>validateHelarcNativeAccountMembers(input,[input.members[0]!,input.members[0]!])).toThrow("members_invalid");
    expect(()=>validateHelarcNativeAccountMembers(input,input.members)).toThrow("replacement_overlap");
    expect(()=>validateHelarcNativeAccountMembers({...input,items:[{role:"assistant",content:"changed"}]},input.members.slice(1))).toThrow();
  });
});
