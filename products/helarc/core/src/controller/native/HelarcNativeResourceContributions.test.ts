import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {encodeNativeWorkIndexEntryMetadata,type NativeWorkIndexEntry} from "@agent-anything/provider-integrations/native";
import type {ProtocolExecutionJournal,ProtocolJournalCommand,ProtocolJournalValue,ProtocolEvidenceRevision,ProtocolUsageCursor} from "@agent-anything/agent-runtime/model-access";
import {createHelarcNativeResourceContributions} from "./HelarcNativeResourceContributions.js";

function entry(id:string,inputTokens:number,outputTokens:number):ProtocolEvidenceRevision {
  const value:Omit<NativeWorkIndexEntry,"revision">={workId:id,usageRevision:`${id}:usage`,protocol:OPENAI_RESPONSES,runId:"root",purpose:"task",
    operation:"generation",beneficiaries:["root"],usageState:"observed",finality:"terminal",profileKey:"native-usage",
    inputTokens,inputState:"known",outputTokens,outputState:"known",cacheReadTokens:0,cacheReadState:"known",
    cacheWriteTokens:null,cacheWriteState:"not_applicable",exposure:"reconciled",localReleased:false,reconciliationOwner:"adapter",
    heldReservations:0,costRevision:null,costCoverage:"unknown",pricedSubtotals:{}};
  return {scopeId:`${id}:scope`,kind:"usage",key:id,owner:"adapter",activityId:id,revision:1,
    content:{id:`${id}:body`,activityId:id,digest:digest(id),bytes:1},references:[],dependencies:[],memberships:["root"],
    metadata:encodeNativeWorkIndexEntryMetadata({...value,revision:digest(value)})};
}
const cursor:ProtocolUsageCursor={entries:{scopeId:"a:scope",key:"a"},entriesComplete:false,dispatches:null,dispatchesComplete:true};
function journal(read:(command:ProtocolJournalCommand)=>ProtocolJournalValue):ProtocolExecutionJournal {
  return {command:async command=>read(command)};
}

describe("native cumulative resource contributions",()=>{
  it("collects all bounded pages under one boundary and restores the completed cursor",async()=>{
    const commands:ProtocolJournalCommand[]=[];
    const source=createHelarcNativeResourceContributions(journal(command=>{
      commands.push(command);
      if(command.kind!=="usage_snapshot")throw new Error("No body or participant reads are required");
      if(command.ifBoundary===7)return {unchangedBoundary:7};
      if(!command.after)return {runId:"root",boundary:7,complete:false,entries:[entry("a",20,4)],dispatches:[],next:cursor};
      expect(command.expectedBoundary).toBe(7);
      return {runId:"root",boundary:7,complete:true,entries:[entry("b",30,5)],dispatches:[],next:null};
    }));
    const first=await source.read("root",null);
    expect(first.usage.modelInputTokens).toEqual({knownValue:50,status:"measured"});
    expect(first.usage.modelOutputTokens).toEqual({knownValue:9,status:"measured"});
    expect(await source.read("root",structuredClone(first))).toEqual(first);
    expect(commands).toHaveLength(3);
  });

  it("never adopts a page subtotal when concurrent evidence invalidates collection",async()=>{
    const complete=createHelarcNativeResourceContributions(journal(()=>({runId:"root",boundary:4,complete:true,
      entries:[entry("known",100,25)],dispatches:[]})));
    const prior=await complete.read("root",null);
    const source=createHelarcNativeResourceContributions(journal(command=>{
      if(command.kind!=="usage_snapshot")throw new Error("Unexpected read");
      return command.after?{changedBoundary:8}:{runId:"root",boundary:7,complete:false,entries:[entry("partial",10,2)],dispatches:[],next:cursor};
    }));
    const deferred=await source.read("root",prior);
    expect(deferred.usage.modelInputTokens).toEqual({knownValue:100,status:"unknown"});
    expect(deferred.usage.modelOutputTokens).toEqual({knownValue:25,status:"unknown"});
    expect(deferred.sequence).toBe(prior.sequence+1);
    const refreshed=await createHelarcNativeResourceContributions(journal(command=>{
      expect(command.kind==="usage_snapshot"&&command.ifBoundary).toBeUndefined();
      return {runId:"root",boundary:8,complete:true,entries:[entry("known",100,25),entry("new",10,2)],dispatches:[]};
    })).read("root",structuredClone(deferred));
    expect(refreshed.usage.modelInputTokens).toEqual({knownValue:110,status:"measured"});
  });

  it("rejects a non-advancing cursor and never hydrates request or response bodies",async()=>{
    const source=createHelarcNativeResourceContributions(journal(command=>{
      expect(command.kind).toBe("usage_snapshot");
      return {runId:"root",boundary:7,complete:false,entries:[],dispatches:[],next:cursor};
    }));
    await expect(source.read("root",null)).rejects.toThrow("native_resource_page_incomplete");
  });
});
