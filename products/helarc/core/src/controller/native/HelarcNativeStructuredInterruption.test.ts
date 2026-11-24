import {describe,it,expect,vi} from "vitest";
import {HelarcNativeStructuredExecution,type HelarcNativeStructuredExecutionPorts,type HelarcNativeStructuredRequest} from "./HelarcNativeStructuredExecution.js";

describe("native auxiliary interruption ownership",()=>{
  function fixture(){
    const execution=new HelarcNativeStructuredExecution({} as HelarcNativeStructuredExecutionPorts);
    const abort=new AbortController(),error=new Error("original driver stopped");
    const request={source:{id:"source",revision:"1"},activity:{scope:{activityId:"method-original"}}} as HelarcNativeStructuredRequest;
    const run=vi.spyOn(execution as any,"executeOriginal").mockImplementation(async()=>{abort.abort(error);throw error;});
    const interrupt=vi.spyOn(execution,"interrupt").mockResolvedValue({kind:"native_interruption"});
    return {execution,abort,error,request,run,interrupt,context:{signal:abort.signal,
      interruption:{kind:"run_cancellation" as const,cancellation:{runId:"root",requestId:"accepted-cancel"}}}};
  }
  it("hands off only after the aborted driver stops, without accepting a method result",async()=>{
    const f=fixture();await expect(f.execution.execute(f.request,f.context)).rejects.toBe(f.error);
    expect(f.interrupt).toHaveBeenCalledTimes(1);
    expect(f.interrupt.mock.calls[0]?.slice(0,2)).toEqual(["method-original",f.request.source]);
    expect(f.interrupt.mock.calls[0]?.[2].signal.aborted).toBe(false);
    expect(f.run.mock.invocationCallOrder[0]!).toBeLessThan(f.interrupt.mock.invocationCallOrder[0]!);
  });
  it("leaves failed interruption persistence recoverable",async()=>{
    const f=fixture(),cause=new Error("handoff not saved");f.interrupt.mockRejectedValue(cause);
    await expect(f.execution.execute(f.request,f.context)).rejects.toMatchObject({name:"ActivityCheckpointError",key:"method-original:native-interruption",cause});
  });
  it("does not turn an ordinary provider failure into cancellation",async()=>{
    const f=fixture();f.run.mockRejectedValue(f.error);
    await expect(f.execution.execute(f.request,f.context)).rejects.toBe(f.error);expect(f.interrupt).not.toHaveBeenCalled();
  });
  it("keeps Host shutdown recoverable rather than inventing accepted cancellation",async()=>{
    const f=fixture();await expect(f.execution.execute(f.request,{...f.context,interruption:null})).rejects.toBe(f.error);
    expect(f.abort.signal.aborted).toBe(true);expect(f.interrupt).not.toHaveBeenCalled();
  });
});
