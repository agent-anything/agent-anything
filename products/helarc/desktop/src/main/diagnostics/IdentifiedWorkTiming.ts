import {AsyncLocalStorage} from "node:async_hooks";
import {randomUUID} from "node:crypto";
import {executionPerformanceClock,type ExecutionPerformanceEvent} from "./ExecutionPerformance.js";

export type WorkSubject={owner:string;kind:"model-activity"|"contribution"|"event"|"run";id:string;runId:string};
export type WorkBoundary={work:WorkSubject;phase:string;awaited?:WorkSubject};
export interface WorkSample extends WorkBoundary {
  invocation:string;enclosingInvocation:string|null;boundary:"started"|"returned"|"threw";at:string;clock:ReturnType<typeof executionPerformanceClock>;
  durationMs:number|null;generation:number;omitted:number;
  stages:{phase:string;domain:string;started:number;finished:number;unknown:number;inclusiveMs:number|null}[];
}
const context=new AsyncLocalStorage<string>();
export const diagnosticInvocation=()=>context.getStore();
type Group=WorkSample["stages"][number];

/** Observation windows belong to individual invocations, not to a process-wide slowest-N list. */
export class IdentifiedWorkTiming {
  private readonly groups=new Map<string,{stages:Map<string,Group>;omitted:number}>();
  constructor(private readonly publish:(s:WorkSample)=>void){}
  observe(event:ExecutionPerformanceEvent):void{
    const id=event.context.workInvocation;
    if(typeof id!=="string"||!event.stage.startsWith("storage."))return;
    const group=this.groups.get(id);if(!group)return;
    const domain=String(event.context.clockDomain??"unavailable"),key=domain+":"+event.stage;
    let g=group.stages.get(key);
    if(!g){if(group.stages.size>=64){group.omitted++;return;}
      g={phase:event.stage,domain,started:0,finished:0,unknown:0,inclusiveMs:null};group.stages.set(key,g);}
    if(event.kind==="started"){g.started++;return;}
    g.finished++;if(event.outcome==="unknown"||domain==="unavailable")g.unknown++;else g.inclusiveMs=(g.inclusiveMs??0)+event.durationMs;
  }
  async measure<T>(generation:number,basis:WorkBoundary,fn:()=>Promise<T>):Promise<T>{
    const invocation=randomUUID(),enclosingInvocation=diagnosticInvocation()??null,start=executionPerformanceClock(),group={stages:new Map<string,Group>(),omitted:0};
    const tracked=this.groups.size<128;if(tracked)this.groups.set(invocation,group);
    const emit=(boundary:WorkSample["boundary"])=>{try{
      const clock=executionPerformanceClock();
      this.publish({...basis,invocation,enclosingInvocation,generation,at:new Date().toISOString(),clock:boundary==="started"?start:clock,boundary,
        durationMs:boundary==="started"?null:clock.monotonicMs-start.monotonicMs,
        omitted:tracked?group.omitted:1,stages:[...group.stages.values()]});
    }catch{/* An observer does not control a wait or a return. */}};
    emit("started");let boundary:"returned"|"threw"="threw";
    try{const result=await context.run(invocation,fn);boundary="returned";return result;}
    finally{this.groups.delete(invocation);emit(boundary);}
  }
}
export function measureIdentifiedWork<T>(store:{generation?:number;workTiming?:IdentifiedWorkTiming},basis:WorkBoundary,fn:()=>Promise<T>):Promise<T>{
  return store.workTiming?store.workTiming.measure(store.generation!,basis,fn):fn();
}
export const protocolWork=(runId:string,id:string):WorkSubject=>({owner:"protocol-execution",kind:"model-activity",id,runId});
/** Measures the actual fetch-to-headers wait, not the subsequent body stream or remote CPU. */
export function measuredFetch(store:{generation?:number;workTiming?:IdentifiedWorkTiming},work:WorkSubject,operationId:string):typeof fetch|undefined {
  if(!store.workTiming)return undefined;
  const awaited:WorkSubject={owner:"provider-transport",kind:"event",id:operationId,runId:work.runId};
  return (input,init)=>measureIdentifiedWork(store,{work,phase:"http_headers",awaited},()=>globalThis.fetch(input,init));
}
