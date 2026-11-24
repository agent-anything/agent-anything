import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ExecutionPerformanceEvent} from "../diagnostics/ExecutionPerformance.js";
import {safeExecutionPerformanceEvent} from "../diagnostics/HelarcPerformanceDiagnostics.js";
import {randomUUID} from "node:crypto";
import type {WorkSample,WorkSubject} from "../diagnostics/IdentifiedWorkTiming.js";

type Finished=Extract<ExecutionPerformanceEvent,{kind:"finished"}>;
interface Batch {samples:Finished[];bytes:number}

/** Correlated bounded timing batches; inclusive substeps are not additive. */
export class ExecutionPerformanceInspectionAdapter {
  private readonly batches=new Map<string|null,Batch>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  private sampleWindow=performance.now();
  private retained=0;
  private unsampled=0;
  constructor(private readonly recorder:InspectionRecorder) {}
  workBoundary(s:WorkSample):void{
    if(this.closed)return;
    const r=this.recorder,ref=(x:WorkSubject)=>r.ref(x.owner,x.kind,x.id,x.runId);
    const subject=r.ref("work-timing","event",s.invocation,s.work.runId);
    r.offer({id:`work-timing:${s.invocation}:${s.boundary}`,subject,occurredAt:s.at,
      payload:{kind:"event",name:"work."+s.phase,code:s.boundary,sequence:null},
      links:[inspectionLink("observes",subject,ref(s.work)),...(s.awaited?[inspectionLink("prerequisite",ref(s.awaited),subject,{condition:"settled",operation:"awaited_by_this_invocation"})]:[])],
      contents:[{name:"Work, wait and measured stages",class:"execution",stage:s.phase,mediaType:"application/json",
        value:JSON.parse(JSON.stringify({...s,coverage:"observed stages only; no terminal boundary means unknown; inclusive intervals are not additive"}))}]});
  }
  performance(input:ExecutionPerformanceEvent):void {
    if(this.closed||input.kind!=="finished"||!Number.isFinite(input.durationMs)||input.durationMs<0||
      !input.stage.startsWith("storage."))return;
    if(performance.now()-this.sampleWindow>=10000){this.flush();this.sampleWindow=performance.now();this.retained=0;}
    if(this.retained>=128){this.unsampled++;return;}
    this.retained++;
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
    if(this.unsampled){const count=this.unsampled;this.unsampled=0;
      this.recorder.offer({subject:this.recorder.ref("execution-performance","event",randomUUID(),null),occurredAt:new Date().toISOString(),
        payload:{kind:"event",name:"execution.performance_sample_coverage",sequence:null,code:"raw_samples_not_retained"},
        contents:[{name:"Raw sample coverage",class:"execution",stage:"timing",mediaType:"application/json",value:{unsampled:count,
          reason:"bounded_raw_detail",scope:"process; not apportioned to work",maximumPerWindow:128,windowMs:10000}}]});}
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
