import {describe,it,expect,vi} from "vitest";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPathState,type ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {HelarcNativeInputDemandWork,type HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";

function fixture(){
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"original:1",continuity:"task",owner:"context-representation",authorityBasis:"authority"};
  const protocol={id:"openai.responses",revision:"1"},nativeScope={runId:"root",recipientId:"agent",activityId:"native-task",purpose:{id:"task",revision:"1"},compositionDigest:"composition"};
  const body={model:"original-model",input:[{role:"user",content:"Original task"}]};
  const plan={revision:"1",activity:{scope:nativeScope,composition:{digest:"composition",composition:{protocol,configuration:{configuration:{id:"original",revision:"1"}}}}},
    prepared:{format:"helarc.native-prepared-task.v1",binding:{scope:nativeScope,protocol},sourceDigest:"source",wire:{body:JSON.stringify(body),digest:digest(body)},results:[]},
    inputNeed:{kind:"native_input_need",revision:"1",needId:"demand:need",scope,consumer:{activityId:"native-task",protocol,compositionDigest:"composition"}},
    capacity:{limits:[],reservations:[],policy:{id:"unknown",revision:"1",purpose:"task",basis:"No assumed token capacity",allowUnknown:false,allowEstimatedFit:false},maximumCombinations:4,maximumMeasurements:0}
  } as unknown as HelarcNativeInputDemandPlan;
  const intent={id:"demand",runId:"root",permissionBasis:"authority",resourceScope:"demand",maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
  const stages=new Map<string,ActivityStageState>(),selection=vi.fn(),authorize=vi.fn(async()=>({kind:"allowed" as const}));
  const work=new HelarcNativeInputDemandWork({activities:{command:vi.fn(async(c:any)=>c.kind==="read_stage"?stages.get(c.requestId)??null:null)},
    selections:{command:selection},authorize,now:()=>"2026-11-16T00:00:00Z"},new ActivityPurposeRegistry<ActivityPurposeHandler>());
  const parts=work.prepareSubmission(intent,plan),path={intent:parts[0]!.proposal,cancelled:false,progress:null} as ActivityPathState;
  const first={request:parts[1]!.proposal,status:"submitted",result:null,receipt:null} as ActivityStageState;
  stages.set(first.request.id,first);
  return {scope,plan,intent,work,path,first,stages,selection,authorize,signal:new AbortController().signal};
}
describe("original native input demand",()=>{
  it("opens the original need from source acceptance, not a receiver or native request",async()=>{
    const f=fixture(),raw=await f.work.execute(f.path,f.first,{id:"attempt"} as never,f.signal);f.first.result=raw;
    const result=await f.work.interpret(f.path,f.first,f.signal,{id:"source-receipt"});
    expect(result.progress).toMatchObject({contextInputNeed:f.plan.inputNeed,demand:{sourceDigest:"source",capacity:{assessment:{allowed:false}}}});
    expect(result.next).toEqual([]);
    expect(result.participants).toEqual([{owner:"activity",kind:"input_need",proposal:expect.objectContaining({id:"demand:need",origin:{requestId:f.first.request.id,receiptId:"source-receipt"},
      stage:expect.objectContaining({stageKind:"ready",capabilities:[]})})}]);
    expect(f.selection).not.toHaveBeenCalled();expect(f.path.intent.purpose.contract.stageKinds).not.toContain("model");
  });
  it.each(["run","authority","configuration","protocol","composition","body","need"])("rejects changed %s before admission",change=>{
    const f=fixture(),plan=structuredClone(f.plan) as any;
    if(change==="run")plan.inputNeed.scope.runId="child";
    if(change==="authority")plan.inputNeed.scope.authorityBasis="changed";
    if(change==="configuration")plan.activity.composition.composition.configuration.configuration.revision="2";
    if(change==="protocol")plan.prepared.binding.protocol={id:"ollama.chat",revision:"1"};
    if(change==="composition")plan.inputNeed.consumer.compositionDigest="changed";
    if(change==="body")plan.prepared.wire.body='{"model":"different"}';
    if(change==="need")plan.inputNeed.needId="another";
    expect(()=>f.work.prepareSubmission(f.intent,plan)).toThrow("native_input_demand_binding_changed");
  });
  it("does not repeat the demand after receiving a selected input reference",async()=>{
    const f=fixture(),exactInput={kind:"native-input",original:true},input={kind:"native_input_ready",revision:"1",needId:"demand:need",inputId:"selected",inputDigest:digest(exactInput)};
    const stage={...f.first,request:{id:"demand:ready",pathId:"demand",stageKind:"ready",input,capabilities:[],dependencies:[]}} as ActivityStageState;
    f.selection.mockResolvedValue({scope:f.scope,input:{exactInput,activityId:"native-task",nativeConsumer:{protocol:f.plan.inputNeed.consumer.protocol,compositionDigest:"composition"}}});
    stage.result=await f.work.execute(f.path,stage,{id:"ready-attempt"} as never,f.signal);
    const result=await f.work.interpret(f.path,stage,f.signal,{id:"ready-receipt"});
    expect(result.progress).toMatchObject({returned:input});expect(result.participants).toBeUndefined();
    f.selection.mockResolvedValue({scope:{...f.scope,runId:"child"},input:{exactInput}});
    await expect(f.work.execute(f.path,stage,{id:"new"} as never,f.signal)).rejects.toThrow("native_input_demand_selection_changed");
  });
  it("cancellation settles without another source read, selection read or dispatch",async()=>{
    const f=fixture();f.path.cancelled=true;f.first.attempt={id:"original-attempt"} as never;
    const raw=await f.work.reconcile(f.path,f.first,f.signal);f.first.result=raw;
    expect(raw.value).toEqual({kind:"native_input_demand_cancelled"});
    expect(await f.work.settle(f.path,f.first,f.signal)).toMatchObject({disposition:{nativeDispatch:false}});
    expect(f.selection).not.toHaveBeenCalled();
  });
});
