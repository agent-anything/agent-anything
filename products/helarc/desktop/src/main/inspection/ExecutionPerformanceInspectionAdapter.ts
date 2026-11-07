import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ExecutionPerformanceEvent} from "../diagnostics/ExecutionPerformance.js";
import {safeExecutionPerformanceEvent} from "../diagnostics/HelarcPerformanceDiagnostics.js";
import {randomUUID} from "node:crypto";

type Finished=Extract<ExecutionPerformanceEvent,{kind:"finished"}>;
interface Batch {samples:Finished[];bytes:number}

/** Request envelopes and startup, not a second copy of every nested timing sample. */
export class ExecutionPerformanceInspectionAdapter {
  private readonly batches=new Map<string|null,Batch>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  constructor(private readonly recorder:InspectionRecorder) {}
  performance(input:ExecutionPerformanceEvent):void {
    if(this.closed||input.kind!=="finished"||!Number.isFinite(input.durationMs)||input.durationMs<0||
      !["storage.host.request","storage.worker.command","storage.host.startup","storage.worker.entry",
        "storage.worker.load_database","storage.worker.open_database"].includes(input.stage))return;
    const event=safeExecutionPerformanceEvent(input) as Finished;
    const runId=typeof event.context.runId==="string"?event.context.runId:null;
    const bytes=Buffer.byteLength(JSON.stringify(event));
    let batch=this.batches.get(runId);
    if(batch&&batch.bytes+bytes>48*1024){this.write(runId);batch=undefined;}
    if(!batch){
      if(this.batches.size>=16)this.write(this.batches.keys().next().value!);
      batch={samples:[],bytes:0};this.batches.set(runId,batch);
    }
    batch.samples.push(event);batch.bytes+=bytes;
    if(batch.samples.length>=32)this.write(runId);
    if(!this.timer){this.timer=setTimeout(()=>this.flush(),250);this.timer.unref();}
  }
  flush():void {
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    for(const runId of this.batches.keys())this.write(runId);
  }
  close():void {this.flush();this.closed=true;}
  private write(runId:string|null):void {
    const batch=this.batches.get(runId);if(!batch)return;
    this.batches.delete(runId);
    const r=this.recorder,subject=r.ref("execution-performance","event",randomUUID(),runId);
    const paths=[...new Set(batch.samples.flatMap(event=>typeof event.context.pathId==="string"?[event.context.pathId]:[]))];
    const links=runId?paths.map(id=>inspectionLink("observes",subject,r.ref("activity","contribution",id,runId))):[];
    if(runId)links.push(inspectionLink("observes",subject,r.ref("runtime","run",runId,runId)));
    r.offer({subject,occurredAt:batch.samples.at(-1)!.occurredAt,payload:{kind:"event",name:"execution.performance_batch",sequence:null,code:null},links,
      contents:[{name:"Execution performance and correlation",class:"execution",stage:"timing",mediaType:"application/json",
        value:JSON.parse(JSON.stringify({version:1,samples:batch.samples}))}]});
  }
}
