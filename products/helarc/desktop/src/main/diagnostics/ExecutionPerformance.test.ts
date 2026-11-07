import {expect,it,vi} from "vitest";
import {beginExecutionTiming,type ExecutionPerformanceEvent} from "./ExecutionPerformance.js";

it("keeps the original interval identity and thread resource basis when another request starts",()=>{
  const events:ExecutionPerformanceEvent[]=[],sink={performance:(event:ExecutionPerformanceEvent)=>events.push(event)};
  const first=beginExecutionTiming(sink,"storage.worker.command",{requestId:1,workerThreadId:999});
  const second=beginExecutionTiming(sink,"storage.worker.command",{requestId:2});
  second();first();first();
  expect(events).toHaveLength(4);
  expect(events[3]).toMatchObject({id:events[0]!.id,kind:"finished",context:{requestId:1,clockDomain:expect.any(String),workerThreadId:999,measuredThreadId:expect.any(Number)},
    counters:{"loop.activeUs":expect.any(Number),"loop.idleUs":expect.any(Number)}});
  expect(events[3]!.context.cpuBasis).toMatch(/current_thread|unavailable/);
  expect(events[3]!.context.measuredThreadId).not.toBe(999);
});
it("does not make diagnostic failure an execution failure",()=>{
  const sink={performance:vi.fn(()=>{throw new Error("unavailable");})};
  expect(()=>beginExecutionTiming(sink,"test")()).not.toThrow();
});
