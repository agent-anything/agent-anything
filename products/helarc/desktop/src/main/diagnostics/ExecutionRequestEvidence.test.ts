import {expect,it} from "vitest";
import {ExecutionRequestEvidence} from "./ExecutionRequestEvidence.js";
import type {ExecutionPerformanceEvent} from "./ExecutionPerformance.js";

function event(requestId:number,stage:string,kind:"started"|"finished"="finished",durationMs=1):ExecutionPerformanceEvent {
  const common={id:`${requestId}:${stage}`,stage,context:{storageInstanceId:"store",generation:1,requestId},occurredAt:"2026-11-09T00:00:00Z"};
  return kind==="started"?{...common,kind}:{...common,kind,durationMs,outcome:"ok"};
}
it("keeps late Worker detail with its slow request when newer requests evict the recent window",()=>{
  const evidence=new ExecutionRequestEvidence({recent:1,slow:1,active:1,events:8});
  for(let id=1;id<=10;id++) {
    evidence.record(event(id,"storage.host.request","started"));
    evidence.record(event(id,"storage.worker.dispatch"));
    evidence.record(event(id,"storage.host.request","finished",id===1?100:1));
    evidence.record(event(id,"storage.worker.command"));
  }
  const result=evidence.snapshot();
  expect(result.evictedRequests).toBeGreaterThan(0);
  const slow=result.requests.find(request=>request.key==="store:1:1")!;
  expect(slow.complete).toBe(true);
  expect(slow.events.map(e=>e.stage)).toContain("storage.worker.command");
});
it("does not merge stores and reports incomplete bounded evidence",()=>{
  const evidence=new ExecutionRequestEvidence({recent:1,slow:1,active:1,events:2});
  evidence.record(event(1,"storage.host.request","started"));
  evidence.record(event(1,"storage.worker.dispatch"));
  evidence.record(event(1,"storage.host.request"));
  const other=event(1,"storage.host.request");
  evidence.record({...other,context:{...other.context,storageInstanceId:"other"}});
  expect(evidence.snapshot().requests).toMatchObject([
    {complete:false,droppedEvents:1,finished:true},{complete:false,started:false},
  ]);
});
it("does not certify complete evidence while a Worker interval has not arrived after the ACK",()=>{
  const evidence=new ExecutionRequestEvidence();
  evidence.record(event(1,"storage.host.request","started"));
  evidence.record(event(1,"storage.worker.command","started"));
  evidence.record(event(1,"storage.host.request","finished"));
  expect(evidence.snapshot().requests[0]).toMatchObject({finished:true,unfinishedSpans:1,complete:false});
  evidence.record(event(1,"storage.worker.command","finished"));
  expect(evidence.snapshot().requests[0]).toMatchObject({unfinishedSpans:0,complete:true});
});
