import {afterEach,describe,expect,it,vi} from "vitest";
import {closeHelarcHost} from "./HelarcHostShutdown.js";

afterEach(()=>vi.useRealTimers());
describe("Host shutdown boundaries",()=>{
  it("drains execution before closing observation so late Worker timing is retained",async()=>{
    const order:string[]=[];
    const result=await closeHelarcHost({activities:async()=>{order.push("activities");},
      inspection:async()=>{order.push("inspection");},storage:async()=>{order.push("storage");},diagnostics:async()=>{order.push("diagnostics");}});
    expect(order).toEqual(["activities","storage","inspection","diagnostics"]);
    expect(result).toEqual({incomplete:[],failed:[]});
  });
  it("does not give each blocked stage another full shutdown budget",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
    const began=performance.now(),called:string[]=[];
    const unknown=(stage:string)=>()=>{called.push(stage);return new Promise(()=>{});};
    const result=closeHelarcHost({timeoutMs:50,activities:unknown("activities"),inspection:unknown("inspection"),storage:unknown("storage")});
    await vi.runAllTimersAsync();
    expect(await result).toEqual({incomplete:["activities","storage","inspection"],failed:[]});
    expect(performance.now()-began).toBe(50);
    expect(called).toEqual(["activities","storage","inspection"]);
  });
  it("reports a failed boundary without skipping later cleanup",async()=>{
    const error=new Error("write unavailable"),inspection=vi.fn(async()=>{});
    const result=await closeHelarcHost({storage:async()=>{throw error;},inspection});
    expect(result.failed).toEqual([{stage:"storage",error}]);expect(inspection).toHaveBeenCalledOnce();
  });
});
