import {describe,it,expect,vi} from "vitest";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPathState,type ActivityStageState,type ActivityReconsiderationSnapshot} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {nativeInputBodyDigest} from "@agent-anything/agent-runtime/context-representation";
import {HelarcNativeAccountReceptionWork,type HelarcNativeAccountReceptionPlan} from "./HelarcNativeAccountReceptionWork.js";

function fixture(){
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"original:1",continuity:"task",owner:"context-representation",authorityBasis:"authority"};
  const request={requirements:[],sources:[],recipient:{purpose:"method"}},protocol={id:"openai.responses",revision:"1"};
  const intent={id:"receiver",runId:scope.runId,permissionBasis:scope.authorityBasis,resourceScope:"receiver",scheduledWorkId:"receiver-work",
    maximumStages:4,maximumAttempts:4,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
  const plan={revision:"1",binding:{revision:"1",pathId:intent.id,workId:intent.scheduledWorkId,scope,boundary:"original",requirementsDigest:digest(request.requirements),
    members:[{pathId:"producer",workId:"producer-work",requestDigest:digest(request)}]},
    input:{scope,members:[{methodPathId:"producer",candidateId:"candidate",supply:{request}}],prepared:{sourceDigest:"original",workingSources:{groups:[]}},
      activity:{scope:{activityId:"native-task"},composition:{digest:"composition",composition:{protocol}}}},
    inputNeed:{kind:"native_input_need",revision:"1",needId:"need",scope,consumer:{activityId:"native-task",protocol,compositionDigest:"composition"}},
    check:{...intent,id:"check"},checkConditions:{capacity:{policy:{purpose:"method"}},bounds:{}}} as unknown as HelarcNativeAccountReceptionPlan;
  const paths=new Map<string,ActivityPathState>(),stages=new Map<string,ActivityStageState>();
  const command=vi.fn(async(c:any)=>c.kind==="read_snapshot"?structuredClone({path:paths.get(c.pathId)??null,stages:c.requestIds.map((id:string)=>stages.get(id)??null),inputNeeds:[]}):
    c.kind==="read_path"?paths.get(c.pathId)??null:c.kind==="read_stage"?stages.get(c.requestId)??null:
    c.kind==="pending"?[]:c.kind==="read_schedule"?{intent:{workId:"receiver-work",runId:"root",owner:"context-representation",allowedPathIds:["receiver","check"]},revision:0,pathsSealed:false,closed:false}:null);
  const result=vi.fn(),materials=vi.fn(),representations=vi.fn(),authorize=vi.fn(async()=>({kind:"allowed" as const}));
  const work=new HelarcNativeAccountReceptionWork({activities:{command},methods:{result,prepareSubmission:vi.fn(),prepareInputRelease:vi.fn(async()=>[])},materials:{command:materials},
    representations:{command:representations},authorize,now:()=>"2026-11-16T00:00:00Z"},new ActivityPurposeRegistry<ActivityPurposeHandler>());
  const parts=work.prepareSubmission(intent,plan);
  const path={intent:parts[0]!.proposal,controlRevision:0,progressRevision:0,cancelled:false,progress:null,admittedStages:1,dispatchedAttempts:0,
    resourceUse:{admittedStages:1,dispatchedAttempts:0}} as ActivityPathState;
  const first={request:parts[1]!.proposal,status:"submitted",attempt:null,result:null,receipt:null,processing:null} as ActivityStageState;
  paths.set(intent.id,path);stages.set(first.request.id,first);
  const subscription=parts[2]!.proposal as ActivityReconsiderationSnapshot["state"]["subscription"];
  const snapshot={state:{subscription,revision:0,consumedThrough:0,closed:false,observedSources:subscription.sources},through:0,facts:[],more:false};
  function accept(value:unknown,progress:unknown){
    first.status="accepted";first.result={id:"realized",attemptId:"attempt",outcome:"returned",completeness:"complete",value,usage:{},recordedAt:"2026-11-16T00:00:00Z"};
    first.receipt={id:"receipt",requestId:first.request.id,resultId:first.result.id,owner:scope.owner,expectedProgressRevision:0,progress,next:[]};
    path.progressRevision=1;path.progress=progress;
  }
  return {scope,plan,intent,paths,stages,command,result,materials,representations,authorize,work,path,first,parts,snapshot,accept,signal:new AbortController().signal};
}

describe("native account reception professional path",()=>{
  it("declares a separate recipient and shared source observations without subscribing to nonexistent work",()=>{
    const f=fixture();expect(f.parts[1]!.proposal).toMatchObject({input:{inputReception:f.plan.binding}});
    expect(f.snapshot.state.observedSources).toEqual(["activity-source:control:receiver","activity-source:progress:receiver","activity-source:control:producer","activity-source:progress:producer"]);
    expect(f.path.intent.purpose.contract.stageKinds).not.toContain("model");
  });
  it("binds each producer and its original request independently",()=>{
    const f=fixture(),plan=structuredClone(f.plan);
    const changed={...plan,binding:{...plan.binding,members:[...plan.binding.members,{...plan.binding.members[0]!,pathId:"second",workId:"second-work"}]},
      input:{...plan.input,members:[...plan.input.members,{...plan.input.members[0]!,methodPathId:"second"}]}};
    const parts=f.work.prepareSubmission(f.intent,changed);
    expect((parts[2]!.proposal as {sources:string[]}).sources).toContain("activity-source:progress:second");
    changed.binding.members[1]!.requestDigest="changed";
    expect(()=>f.work.prepareSubmission(f.intent,changed)).toThrow("plan_invalid");
  });
  it.each(["child","composition","producer","source","requirements","schedule","authority"])("rejects changed %s before admission",change=>{
    const f=fixture(),plan=structuredClone(f.plan) as any;
    if(change==="child")plan.binding.scope={...plan.binding.scope,runId:"child"};
    if(change==="composition")plan.inputNeed.consumer.compositionDigest="another";
    if(change==="producer")plan.binding.members[0].requestDigest="changed";
    if(change==="source")plan.binding.boundary="changed";
    if(change==="requirements")plan.binding.requirementsDigest="changed";
    if(change==="schedule")plan.binding.workId="other";
    if(change==="authority")plan.check.permissionBasis="other";
    expect(()=>f.work.prepareSubmission(f.intent,plan)).toThrow("native_account_reception_plan_invalid");
  });
  it("waits for accepted realization without dispatching a check or reading materials",async()=>{
    const f=fixture(),p=await f.work.prepare(f.snapshot,f.signal);
    expect(p.close).toBe(false);expect(p.participants.map(p=>p.kind)).toEqual(["path_condition"]);expect(f.materials).not.toHaveBeenCalled();expect(f.result).not.toHaveBeenCalled();
  });
  it("uses recorded unavailability without repeating realization",async()=>{
    const f=fixture();f.accept({kind:"unavailable",reason:"method_gap"},{inputReception:f.plan.binding});
    const p=await f.work.prepare(f.snapshot,f.signal),stage=p.participants.find(p=>p.kind==="stage_submission")!.proposal as ActivityStageState["request"];
    expect(stage.dependencies).toEqual([{requestId:f.first.request.id,condition:"accepted"}]);
    const actual=await f.work.execute(f.path,{...f.first,request:stage,status:"dispatched"},{id:"assess",requestId:stage.id} as never,f.signal);
    expect(actual.value).toMatchObject({judgmentId:null,outcome:{result:{kind:"gap",gap:{reason:"method_gap",untested:true}}}});
    expect(f.materials).not.toHaveBeenCalled();expect(f.result).not.toHaveBeenCalled();
  });
  it("does not call a model check when complete-input capacity is already disallowed",async()=>{
    const f=fixture(),body='{"input":[]}',capacity={inputId:"input",measurements:[],limits:[],assessment:assessInputCapacity({encodedInputId:"input",targetRevision:f.scope.target,
      purpose:f.scope.purpose,evidence:[],limits:[],reservations:[],policy:{id:"strict",revision:"1",purpose:f.scope.purpose,basis:"Unknown capacity is not admitted",allowUnknown:false,allowEstimatedFit:false}})};
    expect(capacity.assessment.allowed).toBe(false);
    const preparation={kind:"native_input_preparation",revision:"1",scope:f.scope,inputId:"input",exactInput:{original:true},projection:{owner:"native",revision:"1"},
      encoded:{mediaType:"application/json",body,bodyDigest:nativeInputBodyDigest(body)},capacity};
    f.accept({kind:"proposed",preparation},{nativeInputPreparation:preparation,contextInputNeed:f.plan.inputNeed});
    const p=await f.work.prepare(f.snapshot,f.signal),stage=p.participants.find(p=>p.kind==="stage_submission")!.proposal as ActivityStageState["request"];
    const actual=await f.work.execute(f.path,{...f.first,request:stage,status:"dispatched"},{id:"assess",requestId:stage.id} as never,f.signal);
    expect(actual.value).toMatchObject({outcome:{result:{kind:"gap",gap:{reason:"native_input_capacity_gap"}}}});expect(f.result).not.toHaveBeenCalled();
  });
  it("cancellation neither replays local reads nor starts further model work",async()=>{
    const f=fixture();f.path.cancelled=true;
    f.first.attempt={id:"attempt",requestId:f.first.request.id} as never;
    expect((await f.work.reconcile(f.path,f.first,f.signal)).value).toEqual({kind:"reception_cancelled"});
    expect(await f.work.result(f.intent.id)).toEqual({kind:"cancelled"});
    expect(f.command.mock.calls.map(([c])=>c.kind)).toEqual(["read_snapshot"]);
    expect((await f.work.prepare(f.snapshot,f.signal)).close).toBe(true);
    expect(f.materials).not.toHaveBeenCalled();expect(f.result).not.toHaveBeenCalled();
  });
  it("interpretation consumes retained realization without re-reading the original materials",async()=>{
    const f=fixture();f.first.result={outcome:"returned",completeness:"complete",value:{kind:"unavailable",reason:"bounded-gap"}} as never;
    expect(await f.work.interpret(f.path,f.first,f.signal)).toMatchObject({progress:{inputReception:f.plan.binding,contextInputNeed:f.plan.inputNeed},next:[]});
    expect(f.materials).not.toHaveBeenCalled();expect(f.result).not.toHaveBeenCalled();
  });
});
