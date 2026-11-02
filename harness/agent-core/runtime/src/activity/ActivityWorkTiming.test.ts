import {expect,it,vi} from "vitest";
import {createActivityWorkTiming,measureActivityWork,type ActivityTimingObservation} from "./ActivityWorkTiming.js";
import type {ActivityPathState,ActivityStageState} from "./ActivityHandoff.js";
const path={intent:{id:"path",runId:"child",owner:"method",scheduledWorkId:"work",purpose:{digest:"original-purpose"}}} as ActivityPathState;
const stage={request:{id:"stage",pathId:"path"},attempt:{id:"attempt"}} as ActivityStageState;

it("retains original work scope and separate nested intervals without adding them",async()=>{
  const events:ActivityTimingObservation[]=[],timing=createActivityWorkTiming(path,stage,event=>events.push(event))!;
  expect(await timing.measure("execution",()=>timing.measure("provider",async()=>42))).toBe(42);
  expect(events.map(e=>[e.phase,e.kind])).toEqual([["execution","started"],["provider","started"],["provider","finished"],["execution","finished"]]);
  expect(new Set(events.map(e=>e.clock.domain)).size).toBe(1);
  for(const event of events)expect(event.scope).toEqual({runId:"child",pathId:"path",stageId:"stage",attemptId:"attempt",workId:"work",owner:"method",purposeDigest:"original-purpose"});
  expect(events[0]!.durationMs).toBeNull();
  expect(events[3]!.durationMs).toBeGreaterThanOrEqual(events[2]!.durationMs!);
  expect(events[0]!.id).toBe(events[3]!.id);expect(events[1]!.id).not.toBe(events[0]!.id);
});
it("does not retry or replace errors when timing observation throws",async()=>{
  const error=new Error("original"),work=vi.fn(async()=>{throw error;});
  const timing=createActivityWorkTiming(path,stage,()=>{throw new Error("observer");});
  await expect(measureActivityWork(timing,"execution",work)).rejects.toBe(error);expect(work).toHaveBeenCalledTimes(1);
});
it("preserves disabled and incomplete observation without reporting a zero result",async()=>{
  expect(createActivityWorkTiming(path,stage,undefined)).toBeUndefined();
  const work=vi.fn(async()=>undefined);await measureActivityWork(undefined,"execution",work);expect(work).toHaveBeenCalledTimes(1);
  const events:ActivityTimingObservation[]=[];let finish!:()=>void;
  const promise=createActivityWorkTiming(path,stage,event=>events.push(event))!.measure("provider",()=>new Promise<void>(resolve=>{finish=resolve;}));
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:"started",durationMs:null,outcome:null});
  finish();await promise;expect(events[1]).toMatchObject({kind:"finished",outcome:"returned"});
});
