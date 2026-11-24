import {it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,bindModelAgentComposition} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,type ProtocolEvidenceRevision,type ProtocolExecutionJournal} from "@agent-anything/agent-runtime/model-access";
import {encodeNativeWorkIndexEntryMetadata,type NativeWorkIndexEntry} from "@agent-anything/provider-integrations/native";
import {readHelarcNativeGenerationPlanning} from "./HelarcNativeGenerationPlanning.js";

const ref=(id:string)=>({id,revision:"1"}),participant=(id:string)=>({implementation:ref(id),protocol:OPENAI_RESPONSES});
const composition=bindModelAgentComposition({agent:ref("agent"),protocol:OPENAI_RESPONSES,
  configuration:{configuration:ref("configuration"),protocol:OPENAI_RESPONSES,model:"model",connectionBinding:ref("connection")},
  adapter:participant("adapter"),task:{purpose:ref("task"),interpreter:participant("interpreter"),input:participant("input")},auxiliary:[]});
const activity=bindProtocolModelActivity({composition,scope:{runId:"root",activityId:"current",recipientId:"root-recipient",purpose:ref("task"),compositionDigest:composition.digest},
  conditions:{input:ref("input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
function evidence(id:string,output:number,patch:Partial<Omit<NativeWorkIndexEntry,"revision">>={}):ProtocolEvidenceRevision{
  const value:Omit<NativeWorkIndexEntry,"revision">={workId:id,usageRevision:`${id}:usage`,protocol:OPENAI_RESPONSES,runId:"root",purpose:"task",
    operation:"generation",beneficiaries:["root"],usageState:"observed",finality:"terminal",profileKey:"profile",inputTokens:100,inputState:"known",
    outputTokens:output,outputState:"known",cacheReadTokens:0,cacheReadState:"known",cacheWriteTokens:null,cacheWriteState:"not_applicable",
    exposure:"reconciled",localReleased:false,reconciliationOwner:"adapter",heldReservations:0,costRevision:null,costCoverage:"unknown",pricedSubtotals:{},...patch};
  return {scopeId:`${id}:usage`,kind:"usage",key:id,owner:"adapter",activityId:id,revision:0,
    content:{id:`${id}:body`,activityId:id,bytes:1,digest:digest(id)},references:[],dependencies:[],memberships:value.beneficiaries,
    metadata:encodeNativeWorkIndexEntryMetadata({...value,revision:digest(value)})};
}
function journal(entries:ProtocolEvidenceRevision[],next:string|null=null):ProtocolExecutionJournal{return {command:async command=>{
  expect(command).toEqual({kind:"usage_samples",runId:"root",recipientId:"root-recipient",compositionDigest:composition.digest,purpose:ref("task"),limit:32});
  return {entries,next,version:null};
}};}
it("freezes scoped native output observations as an estimate, not a request cap",async()=>{
  const planning=await readHelarcNativeGenerationPlanning(journal([evidence("one",40),evidence("two",90),evidence("count",900,{operation:"count"})],"more"),activity);
  expect(planning.reservation.quantity).toMatchObject({kind:"estimate",value:90});
  expect(planning.samples.map(s=>s.workId)).toEqual(["one","two"]);
  expect(planning.sampleWindowComplete).toBe(false);
  expect(planning.excluded).toContainEqual({activityId:"count",key:"count",reason:"not_generation"});
  expect(await readHelarcNativeGenerationPlanning(journal([evidence("one",40),evidence("two",90),evidence("count",900,{operation:"count"})],"more"),activity)).toEqual(planning);
});
it("keeps missing, nonterminal and conflicting evidence unknown",async()=>{
  const planning=await readHelarcNativeGenerationPlanning(journal([evidence("one",40,{finality:"partial"}),
    evidence("two",90),evidence("two",91)]),activity);
  expect(planning.samples).toEqual([]);
  expect(planning.reservation.quantity).toEqual({kind:"unknown",reason:"no_applicable_terminal_generation_samples"});
});
it("does not accept Parent or another purpose's observations as Child evidence",async()=>{
  await expect(readHelarcNativeGenerationPlanning(journal([evidence("child",40,{runId:"child"})]),activity)).rejects.toThrow("scope_changed");
  await expect(readHelarcNativeGenerationPlanning(journal([evidence("aux",40,{purpose:"summary"})]),activity)).rejects.toThrow("scope_changed");
});
