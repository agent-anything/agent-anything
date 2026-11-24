import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect,it} from "vitest";
import {HelarcInspection} from "./HelarcInspection.js";
import {contextProcessObject} from "@agent-anything/context/evidence";
import type {ContextFoundationFact} from "../execution-storage/ContextFoundationRecords.js";
import {contextProcessInspectionRecords} from "./ContextProcessInspectionProjection.js";

it("activates before history drains; confirms the frozen Root/Child ranges independently of later live work",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"helarc-history-"));
  const source=await HelarcInspection.create(join(dir,"settings"),join(dir,"inspection"));
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const reads:string[]=[];
  const fact=(runId:string,sequence:number):ContextFoundationFact=>({runId,sequence,owner:"representation",subject:"r",kind:"published",details:{},
    occurredAt:"2026-11-11T00:00:00Z",evidence:{revision:"1",category:"representation",subject:contextProcessObject("representation","r",runId),
      state:{phase:"settled",status:"published"},related:[],relationships:[]}});
  try{
    await source.registerExecutionRecording("root",true,{registerRecording:async current=>({current,previous:null}),
      recordingReplayBounds:async()=>({members:2,activity:0,context:7,material:0,protocol:0}),
      readRunTreeMembers:async(root,cursor)=>{expect(cursor).toEqual({rootRunId:root,through:2,after:0});return {runIds:["root","child"],next:null};},
      contextFoundationFacts:async(runId)=>{reads.push(runId);await gate;return [fact(runId,7),fact(runId,8)];}});
    // Live overlap with the frozen source fact must use the same derived identities.
    source.contextFoundationObserver!.observe(fact("root",7));
    source.contextFoundationObserver!.observe(fact("root",8));
    release();
    const result=await source.flushRecording();expect(result?.native).toBe("settled");
    const progress=source.recorder!.health().coverage!.recording!;
    expect(reads).toEqual(["root","child"]);
    expect(progress.ingress.history).toEqual({started:1,confirmed:1,incomplete:0});
    expect(progress.native.duplicates).toBe([...contextProcessInspectionRecords(fact("root",7),source.recorder!)].length);
    expect(progress.native.rejected).toBe(0);
    await source.registerExecutionRecording("root",true,{registerRecording:async current=>({current,previous:null}),
      recordingReplayBounds:async()=>({members:0,activity:0,context:7,material:0,protocol:0}),
      contextFoundationFacts:async()=>{throw Error("unavailable");}});
    await source.flushRecording();expect(source.recorder!.health().coverage!.recording!.ingress.history).toEqual({started:2,confirmed:1,incomplete:1});
  }finally{release();await source.close();await rm(dir,{recursive:true,force:true});}
},30000);
