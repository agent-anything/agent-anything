import {describe,it,expect} from "vitest";
import {HelarcNativeWorkingInput,helarcNativeObservationContinuity,type HelarcNativeWorkingGroupBasis} from "./HelarcNativeWorkingSources.js";

const basis=(id:string):HelarcNativeWorkingGroupBasis=>({id,originRunId:"root",sources:[{source:{owner:"helarc",kind:"input",id,revision:"1"},position:""}],
  duties:["continuity"],preservation:{obligations:[{id:"meaning",requirement:"account",basis:"Retain source meaning"}],relationships:[]},
  exchangeId:null,protection:[],acceptedBy:null,representations:[]});
const key=(input:HelarcNativeWorkingInput)=>helarcNativeObservationContinuity(input.snapshot(),input.items);

describe("native capacity observation baseline",()=>{
  it("does not reset ordinary growth when a request, source or acceptance identity changes",()=>{
    const first=new HelarcNativeWorkingInput();first.append([{role:"user",content:"Objective"}],basis("prompt"));
    const next=new HelarcNativeWorkingInput();next.append(first.items,{...basis("prompt"),acceptedBy:{runId:"root",activityId:"a",acceptance:{id:"receipt",revision:"1"}}});
    next.append([{role:"assistant",content:"New fact"}],basis("reply"));
    expect(key(first)).toBe("original");expect(key(next)).toBe(key(first));
  });
  it("splits the baseline on an adopted account or result-body representation, not its input/selection custody",()=>{
    const original=new HelarcNativeWorkingInput();original.append([{role:"user",content:"Long evidence"}],basis("source"));
    const represented=new HelarcNativeWorkingInput();
    represented.append([{role:"user",content:"Working account"}],{...basis("source"),representations:[{id:"account",revision:"1"}],
      derivedFrom:[{groupId:"source",originRunId:"root",revision:"original"}]});
    const next=new HelarcNativeWorkingInput();next.append(represented.items,represented.snapshot().groups[0]!);
    next.append([{role:"assistant",content:"New work"}],basis("new"));
    expect(key(represented)).not.toBe(key(original));expect(key(next)).toBe(key(represented));
    const changed=new HelarcNativeWorkingInput();changed.append(represented.items,{...represented.snapshot().groups[0]!,representations:[{id:"account",revision:"2"}]});
    expect(key(changed)).not.toBe(key(represented));
  });
  it("retains opaque native conversion identity without inferring its hidden source coverage",()=>{
    const a=new HelarcNativeWorkingInput(),b=new HelarcNativeWorkingInput();
    a.append([{type:"compaction",id:"cmp",encrypted_content:"first"}],basis("response"));
    b.append([{type:"compaction",id:"cmp",encrypted_content:"second"}],basis("response"));
    expect(key(a)).not.toBe("original");expect(key(b)).not.toBe(key(a));
  });
  it("does not compare a source inventory against changed input items",()=>{
    const input=new HelarcNativeWorkingInput();input.append([{role:"user",content:"Original"}],basis("source"));
    expect(()=>helarcNativeObservationContinuity(input.snapshot(),[{role:"user",content:"Changed"}])).toThrow("native_working_sources_changed");
  });
});
