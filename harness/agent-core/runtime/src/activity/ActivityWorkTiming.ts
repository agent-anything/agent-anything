import {randomUUID} from "node:crypto";
import type {ActivityPathState,ActivityStageState} from "./ActivityHandoff.js";

export interface ActivityClockSample {readonly domain:string;readonly monotonicMs:number;}
export interface ActivityTimingObservation {
  readonly id:string;
  readonly scope:{readonly runId:string;readonly pathId:string;readonly stageId:string;readonly attemptId:string|null;
    readonly workId:string|null;readonly owner:string;readonly purposeDigest:string};
  readonly phase:string;
  readonly kind:"started"|"finished";
  readonly occurredAt:string;
  readonly clock:ActivityClockSample;
  readonly durationMs:number|null;
  readonly outcome:"returned"|"threw"|null;
}
export interface ActivityWorkTiming {measure<T>(phase:string,work:()=>Promise<T>):Promise<T>;}
const clockDomain=randomUUID();
export function captureActivityClock():ActivityClockSample {return {domain:clockDomain,monotonicMs:performance.now()};}

/** Observation cannot authorize work, change its result, or convert a rejected operation into success. */
export function createActivityWorkTiming(path:ActivityPathState,stage:ActivityStageState,
  observe:((event:ActivityTimingObservation)=>void)|undefined):ActivityWorkTiming|undefined {
  if(!observe)return undefined;
  const scope={runId:path.intent.runId,pathId:path.intent.id,stageId:stage.request.id,attemptId:stage.attempt?.id??null,
    workId:path.intent.scheduledWorkId??null,owner:path.intent.owner,purposeDigest:path.intent.purpose.digest};
  const emit=(event:ActivityTimingObservation)=>{try{observe(event);}catch{/* Observation has no execution authority. */}};
  return {async measure<T>(phase:string,work:()=>Promise<T>):Promise<T>{
    const id=randomUUID(),start=captureActivityClock();
    emit({id,scope,phase,kind:"started",occurredAt:new Date().toISOString(),clock:start,durationMs:null,outcome:null});
    let outcome:"returned"|"threw"="threw";
    try{const value=await work();outcome="returned";return value;}
    finally{const end=captureActivityClock();emit({id,scope,phase,kind:"finished",occurredAt:new Date().toISOString(),clock:end,
      durationMs:end.domain===start.domain?end.monotonicMs-start.monotonicMs:null,outcome});}
  }};
}
export function measureActivityWork<T>(timing:ActivityWorkTiming|undefined,phase:string,work:()=>Promise<T>):Promise<T>{
  return timing?timing.measure(phase,work):work();
}
