import {describe,it,expect,vi} from "vitest";
import {ActivityCheckpointError} from "@agent-anything/agent-runtime/activity";
import type {AgentActivityExecutionContext,TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {HelarcNativeTaskExecution,type HelarcNativeTaskExecutionPorts} from "./HelarcNativeTaskExecution.js";

describe("native task consumer interruption ownership",()=>{
  it("reaches original preparation before any native activity was created",async()=>{
    const interruptPreparation=vi.fn(),journal={command:vi.fn(async()=>null)};
    const execution=new HelarcNativeTaskExecution({metering:{},journal,interruptPreparation} as unknown as HelarcNativeTaskExecutionPorts);
    const input={runId:"root",iteration:1,agent:{id:"agent",revision:"1"},interaction:{kind:"native_evidence",items:[]},toolExposure:{controllerRequestId:"decision"}} as unknown as TaskDecisionInputSources<HelarcAgentOutput>;
    const context={cancellation:{signal:new AbortController().signal,request:null}} as AgentActivityExecutionContext;
    await (execution as any).run(input,context,"interrupt");
    expect(journal.command).toHaveBeenCalledWith({kind:"state",activityId:"decision:native-task"});
    expect(interruptPreparation).toHaveBeenCalledWith(input,context);
  });
  function fixture(){
    const abort=new AbortController(),original=new Error("driver stopped");
    const input={runId:"root",iteration:1,toolExposure:{controllerRequestId:"decision"}} as TaskDecisionInputSources<HelarcAgentOutput>;
    const context={cancellation:{signal:abort.signal,request:null},runCheckpoints:{read:()=>null,commit:async()=>{}}} as unknown as AgentActivityExecutionContext;
    const execution=new HelarcNativeTaskExecution({metering:{}} as HelarcNativeTaskExecutionPorts);
    const run=vi.spyOn(execution as any,"run").mockImplementation(async(_input,_context,mode)=>{
      if(mode==="interrupt")return null;abort.abort(original);throw original;
    });
    return {abort,original,input,context,execution,run};
  }
  it.each(["next","recover"] as const)("hands off the original activity after cancelled %s returns, not during its driver",async method=>{
    const f=fixture();await expect(f.execution[method](f.input,f.context)).rejects.toBe(f.original);
    expect(f.run.mock.calls.map(c=>c[2])).toEqual([method==="next"?"execute":"recover","interrupt"]);
    expect(f.run.mock.calls.every(c=>c[0]===f.input&&(c[1] as AgentActivityExecutionContext).cancellation===f.context.cancellation)).toBe(true);
  });
  it("does not interpret an ordinary failure as accepted cancellation",async()=>{
    const f=fixture();f.run.mockRejectedValue(f.original);
    await expect(f.execution.next(f.input,f.context)).rejects.toBe(f.original);expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("preserves handoff failure as a recoverable checkpoint rather than completing cancellation",async()=>{
    const f=fixture(),failure=new Error("handoff save failed");
    f.run.mockImplementation(async(_input,_context,mode)=>{if(mode==="interrupt")throw failure;f.abort.abort(f.original);throw f.original;});
    await expect(f.execution.next(f.input,f.context)).rejects.toMatchObject({name:ActivityCheckpointError.name,key:"decision:native-interruption",cause:failure});
  });
});
