import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {replayInspectionRecords,type InspectionProjectionSink} from "./InspectionReplay.js";
import {recordContextProcessEvidence,contextProcessInspectionRecords} from "./ContextProcessInspectionProjection.js";
import type {ContextFoundationFact,ContextFoundationObserver} from "../execution-storage/ContextFoundationRecords.js";

/** Links only owner-declared relationships; an access is not a delivery or semantic support. */
export class ContextFoundationInspectionAdapter implements ContextFoundationObserver {
  constructor(private readonly recorder:InspectionRecorder) {}
  observe(fact:ContextFoundationFact,sink:InspectionProjectionSink=this.recorder):void {
    recordContextProcessEvidence(fact,sink);
  }
  async replay(runId:string,read:(runId:string,after:number,limit:number)=>Promise<readonly ContextFoundationFact[]>):Promise<void> {
    let after=0;
    while(true){const facts=await read(runId,after,128);
      for(const fact of facts)await replayInspectionRecords(this.recorder,contextProcessInspectionRecords(fact,this.recorder));
      if(facts.length<128)return;after=facts.at(-1)!.sequence;}
  }
}
