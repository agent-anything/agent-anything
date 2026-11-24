import {describe,it,expect,vi} from "vitest";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {retainTaskDecisionSource,type TaskDecisionInputSources,type AgentActivityExecutionContext} from "@agent-anything/agent-runtime/decision";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {HelarcNativeInputDemandWork,type HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import {HelarcNativeTaskInputWait} from "./HelarcNativeTaskInputWait.js";

function fixture(){
  const input={runId:"root",agent:{id:"agent",revision:"1"},toolExposure:{controllerRequestId:"decision"}} as TaskDecisionInputSources<HelarcAgentOutput>;
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"original:1",continuity:"task",owner:"context-representation",authorityBasis:"authority"};
  const protocol={id:"openai.responses",revision:"1"},nativeScope={runId:"root",recipientId:"agent",activityId:"decision:native-task",purpose:{id:"task",revision:"1"},compositionDigest:"composition"};
  const body={model:"original-model",input:[{role:"user",content:"Original task"}]};
  const plan={revision:"1",activity:{scope:nativeScope,composition:{digest:"composition",composition:{protocol,configuration:{configuration:{id:"original",revision:"1"}}}}},
    prepared:{format:"helarc.native-prepared-task.v1",binding:{scope:nativeScope,protocol},sourceDigest:retainTaskDecisionSource(input).id,
      wire:{body:JSON.stringify(body),digest:digest(body)},results:[]},
    inputNeed:{kind:"native_input_need",revision:"1",needId:"demand:need",scope,consumer:{activityId:"decision:native-task",protocol,compositionDigest:"composition"}},
    capacity:{limits:[],reservations:[],policy:{id:"unknown",revision:"1",purpose:"task",basis:"Unknown",allowUnknown:true,allowEstimatedFit:false},maximumCombinations:4,maximumMeasurements:0}
  } as unknown as HelarcNativeInputDemandPlan;
  const checkpoints=new Map(),receipts=new Map(),abort=new AbortController();
  const context={checkpoints:{read:(id:string)=>checkpoints.get(id)??null,commit:vi.fn(async(id:string,v:unknown)=>{checkpoints.set(id,structuredClone(v));})},
    cancellation:{runId:"root",signal:abort.signal,request:null},retry:{deadlineAt:new Date(Date.now()+10000).toISOString()}} as unknown as AgentActivityExecutionContext;
  let state:any=null,schedule:any=null,revision=0;
  const activityCommand=vi.fn(async(c:any)=>{
    if(c.kind==="observe_paths")return c.pathIds.map((pathId:string)=>state?{pathId,runId:"root",changeRevision:revision,controlRevision:state.path.controlRevision,progressRevision:state.path.progressRevision,cancelled:state.path.cancelled}:null);
    if(c.kind==="observe_state")return state;
    if(c.kind==="read_schedule")return schedule;
    if(c.kind==="cancel"){state.path.cancelled=true;state.path.controlRevision++;revision++;return;}
    throw new Error(`Unexpected body access: ${c.kind}`);
  });
  const accept=vi.fn(async(proposal:SharedAcceptanceProposal)=>{
    const receipt={id:proposal.id,digest:digest(proposal),scope:proposal.scope,outcome:"accepted",rejection:null};
    if(proposal.id==="demand:submission"){
      expect(context.checkpoints!.read("helarc.native-task-input-demand.v1")).not.toBeNull();
      const intent=proposal.parts.find(p=>p.kind==="path_opening")!.proposal;
      schedule??={intent:(proposal.parts[0]!.proposal as any).intent,revision:1,pathsSealed:false,settlementConfirmed:false};
      state??={path:{intent,controlRevision:0,progressRevision:2,cancelled:false},stages:[{requestId:"demand:stage:1",status:"accepted"},{requestId:"demand:ready",status:"accepted"}],inputNeeds:[{id:"demand:need"}]};
      revision++;
    }else {
      expect(proposal.parts.map(p=>p.kind)).toEqual(["path_condition","scheduling_path_seal","scheduling_closure"]);
      schedule.settlementConfirmed=true;
    }
    receipts.set(proposal.id,receipt);return receipt;
  });
  const demand=new HelarcNativeInputDemandWork({activities:{command:activityCommand},selections:{command:vi.fn()},authorize:vi.fn(),now:()=>new Date().toISOString()},new ActivityPurposeRegistry<ActivityPurposeHandler>());
  const result=vi.spyOn(demand,"result").mockImplementation(async()=>({kind:"ready",plan,value:{kind:"native_input_ready",inputId:"selected"}} as any));
  const arrange=vi.fn(async()=>({identity:{id:"demand",runId:"root",permissionBasis:"authority",resourceScope:"demand",scheduledWorkId:"waiting",
    maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},plan,
    schedule:{id:"waiting-schedule",workId:"waiting",runId:"root",scopeId:"root",owner:"context-representation",decisionId:"decision",policyRevision:"1",reason:"task" as const,
      delayImpact:"Task needs original input",timing:{kind:"unknown" as const},resources:[{capability:"material_read",poolId:"local",units:1}]}}));
  const adopt=vi.fn(async(original:any,_input:any,inputId:string)=>({...original,prepared:{...original.prepared,selectedInputId:inputId}}));
  const exit=vi.fn(async()=>({status:"closed"})),unsubscribe=vi.fn();
  const ports={activities:{command:activityCommand},acceptance:{accept,query:vi.fn(async(id:string)=>receipts.get(id)??null)},responsibilities:{query:exit},demand,
    host:{assertAvailable:vi.fn(),wake:vi.fn(),subscribe:vi.fn(()=>unsubscribe)},arrange,adopt,rediscoveryMs:1,settlementWaitMs:10};
  const wait=new HelarcNativeTaskInputWait(ports as any),arranged={activity:plan.activity,prepared:plan.prepared};
  return {input,plan,arranged,context,wait,ports,checkpoints,receipts,abort,result,arrange,adopt,accept,activityCommand,exit,unsubscribe,
    state:()=>state,schedule:()=>schedule};
}
describe("native task input waiting",()=>{
  it("retains original handoff before accepting runnable work and adopts only the ready input",async()=>{
    const f=fixture(),selected=await f.wait.select(f.arranged,f.input,f.context);
    expect(selected.prepared.selectedInputId).toBe("selected");expect(f.arrange).toHaveBeenCalledTimes(1);
    expect(f.result).toHaveBeenCalledTimes(1);expect(f.schedule().settlementConfirmed).toBe(true);
    expect(f.activityCommand.mock.calls.every(([c])=>!["read_path","read_stage","read_snapshot"].includes(c.kind))).toBe(true);
    expect(f.adopt).toHaveBeenCalledWith(f.arranged,f.input,"selected",f.plan);expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("restores after lost submission ACK without current binding, new source or another readiness decision",async()=>{
    const f=fixture(),originalAccept=f.accept.getMockImplementation()!;
    f.accept.mockImplementationOnce(async proposal=>{await originalAccept(proposal);throw new Error("ACK lost");});
    await expect(f.wait.select(f.arranged,f.input,f.context)).rejects.toThrow("ACK lost");
    const proposal=f.accept.mock.calls[0]![0];f.arrange.mockRejectedValue(new Error("Current settings must not be read"));
    const restarted=new HelarcNativeTaskInputWait(f.ports as any);
    expect((await restarted.restore(f.input,f.context))!.prepared.selectedInputId).toBe("selected");
    expect(f.arrange).toHaveBeenCalledOnce();expect(f.accept.mock.calls[1]![0]).toEqual(proposal);
    expect(f.context.checkpoints!.commit).toHaveBeenCalledOnce();
  });
  it("returns no restored demand before the original checkpoint",async()=>{
    const f=fixture();expect(await f.wait.restore(f.input,f.context)).toBeNull();await f.wait.interrupt(f.input,f.context);
    expect(f.accept).not.toHaveBeenCalled();expect(f.ports.host.wake).not.toHaveBeenCalled();
  });
  it("rejects changed task source and forged checkpoint before accepting or adopting",async()=>{
    const f=fixture();await f.wait.select(f.arranged,f.input,f.context);f.accept.mockClear();f.adopt.mockClear();
    await expect(f.wait.restore({...f.input,runId:"child"},f.context)).rejects.toThrow("checkpoint_changed");
    const retained=f.checkpoints.values().next().value;retained.proposal.parts[1].proposal.permissionBasis="other";
    await expect(f.wait.restore(f.input,f.context)).rejects.toThrow("checkpoint_changed");
    expect(f.accept).not.toHaveBeenCalled();expect(f.adopt).not.toHaveBeenCalled();
  });
  it("does not turn a wait deadline into cancellation, another demand or model dispatch",async()=>{
    const f=fixture(),originalAccept=f.accept.getMockImplementation()!;
    f.accept.mockImplementationOnce(async p=>{const receipt=await originalAccept(p);f.state().stages=[{requestId:"demand:stage:1",status:"accepted"}];return receipt;});
    f.context.retry={...f.context.retry,deadlineAt:new Date(0).toISOString()} as any;
    await expect(f.wait.select(f.arranged,f.input,f.context)).rejects.toMatchObject({name:"ActivityCheckpointError",key:"demand:input-wait"});
    expect(f.result).not.toHaveBeenCalled();expect(f.adopt).not.toHaveBeenCalled();expect(f.state().path.cancelled).toBe(false);
    expect(f.activityCommand.mock.calls.some(([c])=>c.kind==="cancel")).toBe(false);expect(f.checkpoints.size).toBe(1);
  });
  it("cancels the original pre-dispatch demand, waits for supply exit, and does not adopt its ready result",async()=>{
    const f=fixture();await f.wait.select(f.arranged,f.input,f.context);f.adopt.mockClear();f.result.mockClear();
    f.exit.mockResolvedValueOnce({status:"pending"});
    await new HelarcNativeTaskInputWait(f.ports as any).interrupt(f.input,f.context);
    expect(f.activityCommand.mock.calls.filter(([c])=>c.kind==="cancel").map(([c])=>c.pathId)).toEqual(["demand"]);
    expect(f.exit.mock.calls.length).toBeGreaterThan(1);expect(f.adopt).not.toHaveBeenCalled();expect(f.result).not.toHaveBeenCalled();
  });
  it("does not claim cancellation completed while supplier cleanup is unresolved",async()=>{
    const f=fixture();await f.wait.select(f.arranged,f.input,f.context);f.exit.mockResolvedValue(null as any);
    await expect(f.wait.interrupt(f.input,f.context)).rejects.toMatchObject({name:"ActivityCheckpointError",key:"demand:input-wait"});
    expect(f.state().path.cancelled).toBe(true);expect(f.arrange).toHaveBeenCalledOnce();
  });
  it("rejects another run's acceptance even when its original ID matches",async()=>{
    const f=fixture();await f.wait.select(f.arranged,f.input,f.context);f.receipts.get("demand:submission").scope="another";
    await expect(f.wait.interrupt(f.input,f.context)).rejects.toThrow("receipt_changed");
    expect(f.activityCommand.mock.calls.some(([c])=>c.kind==="cancel")).toBe(false);
  });
  it("reports accepted input unavailability without calling it a model response",async()=>{
    const f=fixture();f.result.mockResolvedValue({kind:"unavailable",value:{reason:"original_source_unavailable"}} as any);
    await expect(f.wait.select(f.arranged,f.input,f.context)).rejects.toMatchObject({name:"TaskDecisionActivityError"});
    expect(f.adopt).not.toHaveBeenCalled();expect(f.schedule().settlementConfirmed).toBe(true);
  });
});
