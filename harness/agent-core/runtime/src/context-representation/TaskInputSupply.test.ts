import {describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ProviderRequest} from "@agent-anything/model-interaction";
import {ActivityPurposeRegistry,type ActivityHandoffPort,type ActivityHandoffCommand,type ActivityPathState,type ActivityStageState,
  type ActivityReconsiderationSnapshot,type ActivityReconsiderationPreparation,type ActivityInputNeed} from "../activity/index.js";
import {TASK_MODEL_RESPONSE_PURPOSE} from "../decision/TaskModelResponsePath.js";
import {retainTaskDecisionSource} from "../decision/TaskDecisionSourceRecord.js";
import type {TaskDecisionInputSources} from "../decision/TaskDecisionActivity.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE,type ContextInputPreparationRequest} from "./ContextInputPreparation.js";
import {TaskInputSupply,type TaskInputSupplyBinding,type TaskInputSourcePublication} from "./TaskInputSupply.js";
import {OriginalInputSupply} from "./OriginalInputSupply.js";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE} from "./SourceMaterialPublication.js";
import type {InputSupplyResponsibilityStore} from "./InputSupplyResponsibility.js";

// Only handoff ownership is under test; full request encoding is covered by the Worker fixtures.
function fixture(count=2) {
  const registry=new ActivityPurposeRegistry<null>(),taskPurpose=registry.register(TASK_MODEL_RESPONSE_PURPOSE,null);
  const inputPurpose=registry.register(CONTEXT_INPUT_PREPARATION_PURPOSE,null);
  const sourcePurpose=registry.register(SOURCE_MATERIAL_PUBLICATION_PURPOSE,null);
  const template={requestId:"original"} as ProviderRequest;
  const record=retainTaskDecisionSource({runId:"root",agent:{id:"agent",revision:"1",output:{validate:()=>({valid:true,output:{}})}},
    toolExposure:{controllerRequestId:"request"}} as unknown as TaskDecisionInputSources);
  const consumer={intent:{id:"task",runId:"root",purpose:taskPurpose,permissionBasis:"original"},cancelled:false,controlRevision:0} as ActivityPathState;
  const need:ActivityInputNeed={id:"need",supplier:"context-representation",stage:{id:"task:model",pathId:"task",stageKind:"model",capabilities:["model-request"],dependencies:[]},
    unavailableStage:{id:"task:input-unavailable",pathId:"task",stageKind:"input-unavailable",capabilities:[],dependencies:[]}};
  const sourceStage={request:{id:"task:source",pathId:"task",input:{kind:"task_model_source",record,request:template}},status:"accepted",
    result:{id:"source-raw",completeness:"complete",outcome:"returned"},
    receipt:{requestId:"task:source",resultId:"source-raw",owner:"task-decision"}} as ActivityStageState;
  const paths=new Map<string,ActivityPathState>([["task",consumer]]),stages=new Map<string,ActivityStageState>([["task:source",sourceStage]]);
  const activities:ActivityHandoffPort={command:async(command:ActivityHandoffCommand)=>{
    if(command.kind==="read_input_need")return need;
    if(command.kind==="read_path")return paths.get(command.pathId)??null;
    if(command.kind==="read_stage")return stages.get(command.requestId)??null;
    throw new Error(`Unexpected mutating operation: ${command.kind}`);
  }};
  const publications=Array.from({length:count},(_,index)=>({pathId:`material:${index}`,state:"new",published:null,
    request:{recipient:{runId:"root"},intent:{activityId:`material:${index}`}}})) as TaskInputSourcePublication[];
  const binding:TaskInputSupplyBinding={configuration:{id:"original",revision:"1"},schedule:{id:"schedule",workId:"supply",runId:"root",owner:"context-representation",delegatedPathOwners:["material-source"]} as TaskInputSupplyBinding["schedule"],
    publications,preparation:{id:"prepare",runId:"root",permissionBasis:"original",resourceScope:"prepare",scheduledWorkId:"supply",
      maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
    input:{kind:"context_input_preparation",demand:{id:"demand",runId:"root",recipient:"agent",purpose:"task",targetRevision:"target",historyBoundary:"H"},template} as ContextInputPreparationRequest};
  const snapshot={state:{subscription:{id:"need:supply",runId:"root",owner:"context-representation",binding:{kind:"input_need",id:"need"}}}} as ActivityReconsiderationSnapshot;
  const publication=vi.fn((identity:{id:string})=>[{owner:"activity",kind:"path_opening",proposal:{...identity,purpose:sourcePurpose,owner:"material-source"}}]);
  const preparation=vi.fn(()=>[{owner:"activity",kind:"path_opening",proposal:{...binding.preparation,purpose:inputPurpose,owner:"context-representation"}}]);
  const decision:ActivityReconsiderationPreparation={acceptanceId:"selected-input",decision:{owner:"context-representation",kind:"input",id:"prepared",revision:"1"},participants:[],close:true};
  const decide=vi.fn<ConstructorParameters<typeof TaskInputSupply>[0]["decide"]>(async()=>decision);
  const resolve=vi.fn(async()=>binding),authorize=vi.fn(async()=>{});
  const responsibilities={query:vi.fn<InputSupplyResponsibilityStore["query"]>(async query=>{
    const known=publications.filter(p=>p.state!=="new");if(!known.length)return null;
    const head={binding:{needId:"need",runId:"root",owner:need.supplier,consumerPathId:"task",source:{stageId:sourceStage.request.id,requestDigest:modelInputValueDigest(sourceStage.request)},configuration:binding.configuration},revision:1,acceptanceId:"previous"};
    return query.kind==="head"?head:{kind:"page",head,entries:known.map(p=>({target:{pathId:p.pathId}})),next:null,complete:true} as never;
  })};
  const ports={activities,responsibilities,publications:{prepareSubmission:publication},preparation:{prepareSubmission:preparation},resolve,authorize,decide};
  const supply=new TaskInputSupply(ports);
  const prepare=()=>supply.prepare(snapshot,new AbortController().signal);
  const preparedPath=()=>{
    paths.set("prepare",{intent:{...binding.preparation,purpose:inputPurpose,owner:"context-representation"},progress:null,progressRevision:0,controlRevision:0,cancelled:false} as ActivityPathState);
    stages.set("prepare:stage:1",{request:{id:"prepare:stage:1",pathId:"prepare",input:{request:binding.input}}} as ActivityStageState);
  };
  const acceptedGap=()=>{
    const progress={state:"gap",reason:"capacity",stageRequestId:"prepare:stage:1",rawResultId:"raw",
      gap:{reason:"capacity",demandId:"demand",targetRevision:"target",information:[],capacity:[],untested:false,responsibility:"request_owner"}};
    Object.assign(paths.get("prepare")!,{progress,progressRevision:1});
    Object.assign(stages.get("prepare:stage:1")!,{status:"accepted",result:{id:"raw",completeness:"complete",outcome:"returned"},
      receipt:{id:"receipt",resultId:"raw",requestId:"prepare:stage:1",owner:"context-representation",expectedProgressRevision:0,progress}});
  };
  return {prepare,ports,binding,paths,stages,snapshot,consumer,publication,preparation,acceptedGap,decide,resolve,authorize,preparedPath,decision,responsibilities,sourcePurpose};
}
describe("task input supply handoffs",()=>{
  it("returns the original source unavailability without acquiring a failed dependency or restarting work",async()=>{
    const f=fixture(1),pathId="material:0",bytes=Buffer.from("original"),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const limitation={kind:"deadline" as const,deadlineAt:"2000-01-01T00:00:00Z",observedAt:"2026-10-31T00:00:00Z"};
    const progress={kind:"source_material_unavailable",pathId,stopAcceptanceId:"original-stop",limitation};
    const request={kind:"source_material_publication",bytesBase64:bytes.toString("base64"),target:"target",purpose:"task",recipient:{runId:"root",recipient:"agent",purpose:"task"},
      intent:{id:"custody",instanceId:"instance",activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
        version:{capture:"complete",bytes:bytes.length,digest,origin:{runId:"root"}}}};
    Object.assign(f.binding.publications[0]!,{state:"unavailable",published:null,unavailable:progress,request});
    f.paths.set(pathId,{intent:{id:pathId,runId:"root",owner:"material-source",purpose:f.sourcePurpose},cancelled:true,progress} as ActivityPathState);
    f.stages.set(`${pathId}:capture`,{request:{id:`${pathId}:capture`,pathId,stageKind:"capture",input:request},status:"stopped",stop:{id:"original-stop",progress,limitation}} as unknown as ActivityStageState);
    f.responsibilities.query.mockResolvedValue(null);
    const outcome=await f.prepare();
    expect(outcome.decision).toMatchObject({owner:"context-representation",kind:"input_source_unavailable"});
    expect(outcome.participants).toContainEqual(expect.objectContaining({kind:"stage_submission",proposal:expect.objectContaining({id:"task:input-unavailable",
      input:expect.objectContaining({reason:"original_source_unavailable",evidence:[{owner:"shared_acceptance",kind:"professional_stop",id:"original-stop",revision:"1"}]})})}));
    expect(outcome.participants.at(-1)).toMatchObject({kind:"register",proposal:{responsibilities:[]}});
    expect(f.publication).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
    Object.assign(f.stages.get(`${pathId}:capture`)!,{stop:null});
    await expect(f.prepare()).rejects.toThrow("source_publication_stop_invalid");
  });
  it("returns bounded original-source work and its durable reconsideration together",async()=>{
    const f=fixture(40),proposal=await f.prepare();
    expect(f.publication).toHaveBeenCalledTimes(16);expect(f.preparation).not.toHaveBeenCalled();
    expect(proposal.close).toBe(false);
    expect(proposal.participants[0]).toMatchObject({kind:"input_need_condition",proposal:{needId:"need",expectedControlRevision:0}});
    expect(proposal.participants.some(part=>part.kind==="reconsideration_subscription")).toBe(false);
    expect(proposal.observeSources).toHaveLength(35);
    expect(proposal.observeSources).toContain("activity-source:control:task");
    expect(proposal.participants.at(-1)).toMatchObject({owner:"context_input_supply",kind:"register",proposal:{responsibilities:expect.arrayContaining([expect.objectContaining({role:"source_publication",relation:"dependency"})])}});
  });
  it("waits on accepted producers without republishing or consuming their results",async()=>{
    const f=fixture();f.binding.publications.forEach(p=>Object.assign(p,{state:"pending"}));
    const first=await f.prepare();
    Object.assign(f.snapshot.state,{observedSources:first.observeSources});const next=await f.prepare();
    expect(next.close).toBe(false);expect(next.participants).toHaveLength(3);
    expect(next.observeSources).toEqual(first.observeSources);
    expect(f.publication).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
  });
  it("prepares exact input only after every source publication is accepted",async()=>{
    const f=fixture();f.binding.publications.forEach(p=>Object.assign(p,{state:"published",published:{representation:{id:p.pathId}}}));
    const proposal=await f.prepare();expect(f.publication).not.toHaveBeenCalled();
    expect(f.preparation).toHaveBeenCalledWith(f.binding.preparation,f.binding.input);
    expect(proposal.observeSources).toEqual(["activity-source:control:prepare","activity-source:control:task","activity-source:progress:prepare","activity-source:progress:task","input-supply:need"]);
  });
  it("hands a recovered preparation result to CRM, not directly to the consumer",async()=>{
    const f=fixture();f.preparedPath();f.acceptedGap();
    const proposal=await f.prepare();expect(proposal.acceptanceId).toBe("selected-input");
    expect(f.decide).toHaveBeenCalledOnce();expect(f.publication).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled();
    expect(f.decide.mock.calls[0]![2]).toMatchObject({kind:"available",current:{kind:"gap",evidence:{owner:"activity",id:"prepare:stage:1"}},origin:{receiptId:"receipt"}});
    expect(proposal.participants[0]).toEqual({owner:"activity",kind:"input_need_condition",proposal:{needId:"need",expectedControlRevision:0}});
    expect(proposal.participants.at(-1)).toMatchObject({owner:"context_input_supply",kind:"register"});
    expect(proposal.close).toBe(false);
  });
  it("rejects replacement preparation input rather than reusing work under a changed binding",async()=>{
    const f=fixture();f.preparedPath();
    f.stages.set("prepare:stage:1",{request:{input:{request:{...f.binding.input,template:{requestId:"replacement"}}}}} as ActivityStageState);
    await expect(f.prepare()).rejects.toThrow("input_supply_preparation_binding_changed");expect(f.decide).not.toHaveBeenCalled();
  });
  it("keeps original consumer control while a method consumer changes its observed producers",async()=>{
    const f=fixture();f.preparedPath();f.acceptedGap();
    Object.assign(f.decision,{close:false,observeSources:["activity-source:progress:method"]});
    const proposal=await f.prepare();
    expect(proposal.observeSources).toEqual(["activity-source:control:task","activity-source:progress:method","activity-source:progress:task","input-supply:need"]);
    expect(proposal.close).toBe(false);expect(f.publication).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled();
  });
  it("retains the consumer condition on a professional rejection replacement",async()=>{
    const f=fixture();f.preparedPath();f.acceptedGap();
    const revised={...f.decision,acceptanceId:"revised-input",observeSources:["activity-source:progress:other"],participants:[{owner:"context_preparation",kind:"decision",proposal:{limitation:"known"}}]};
    Object.assign(f.decision,{rejected:async()=>revised});
    const proposed=await f.prepare();
    const replacement=await proposed.rejected!({id:"selected-input",digest:"original",sequence:1,scope:"root",outcome:"rejected",rejection:{owner:"context_preparation",code:"changed"}});
    expect(replacement).toMatchObject({acceptanceId:"revised-input",participants:[
      {owner:"activity",kind:"input_need_condition",proposal:{needId:"need",expectedControlRevision:0}},{owner:"activity",kind:"scheduling_acceptance"},...revised.participants,
      {owner:"context_input_supply",kind:"register"},
    ]});
    expect(replacement?.observeSources).toEqual(["activity-source:control:task","activity-source:progress:other","activity-source:progress:task","input-supply:need"]);
  });
  it("starts durable exit after supplied input without another decision or producer",async()=>{
    const f=fixture();f.stages.set("task:model",{request:{id:"task:model"},status:"submitted"} as ActivityStageState);
    expect(await f.prepare()).toMatchObject({decision:{kind:"input_supply_exit_started"},participants:[{kind:"exit",proposal:{kind:"begin",expectedMembershipRevision:0,basis:{kind:"returned",stageId:"task:model"}}}],close:false});
    expect(f.resolve).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
  });
  it("registers reused dependencies in bounded batches before admitting new work",async()=>{
    const f=fixture(40);f.responsibilities.query.mockResolvedValue(null);
    for(const publication of f.binding.publications) {
      Object.assign(publication,{state:"pending"});
      f.paths.set(publication.pathId,{intent:{...f.binding.preparation,id:publication.pathId,purpose:f.sourcePurpose,owner:"material-source"}} as ActivityPathState);
    }
    const proposal=await f.prepare();expect(proposal.decision.kind).toBe("input_supply_dependencies");
    expect((proposal.participants.at(-1)!.proposal as {responsibilities:unknown[]}).responsibilities).toHaveLength(32);
    expect(proposal.observeSources).toContain("input-supply:need");expect(proposal.close).toBe(false);
    expect(f.publication).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled();
  });
  it("leaves cancellation settlement to the original recovery responsibility",async()=>{
    const f=fixture();Object.assign(f.consumer,{cancelled:true,controlRevision:1});
    expect(await f.prepare()).toMatchObject({decision:{kind:"input_supply_exit_started"},participants:[{kind:"exit",proposal:{basis:{kind:"cancelled",controlRevision:1}}}],close:false});expect(f.resolve).not.toHaveBeenCalled();
  });
  it("does not restart supply after an unavailable result was submitted",async()=>{
    const f=fixture();f.stages.set("task:input-unavailable",{request:{id:"task:input-unavailable"},status:"submitted"} as ActivityStageState);
    expect(await f.prepare()).toMatchObject({decision:{kind:"input_supply_exit_started"},close:false});
    expect(f.resolve).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();
  });
  it("rejects changed original source or template before admitting work",async()=>{
    const f=fixture();Object.assign(f.binding.input,{template:{requestId:"different"}});
    await expect(f.prepare()).rejects.toThrow("input_supply_original_binding_changed");expect(f.publication).not.toHaveBeenCalled();
    const g=fixture();Object.assign(g.stages.get("task:source")!.request.input as object,{record:{id:modelInputValueDigest("forged"),version:1,source:{runId:"root"}}});
    await expect(g.prepare()).rejects.toThrow("task_decision_source_binding_invalid");expect(g.resolve).not.toHaveBeenCalled();
  });
});

describe("original input supply across consumer purposes",()=>{
  it("shares handoffs without task source data or a task interpretation contract",async()=>{
    const f=fixture(),contract={...TASK_MODEL_RESPONSE_PURPOSE,ref:{id:"fixture.stop",revision:"1"},acceptanceOwner:"product-stop"};
    Object.assign(f.consumer.intent,{purpose:new ActivityPurposeRegistry<null>().register(contract,null)});
    const stage=f.stages.get("task:source")!;
    const source={kind:"stop_fixture" as const,request:f.binding.input.template};
    Object.assign(stage.request,{input:source});Object.assign(stage.receipt!,{owner:"product-stop"});
    const checked=vi.fn();
    const supply=new OriginalInputSupply<typeof source>({...f.ports,resolve:async()=>f.binding,decide:async()=>f.decision,authorize:async()=>{},
      source:{stageId:()=>"task:source",validate:(value):asserts value is typeof source=>{
        checked(value);if((value as typeof source).kind!=="stop_fixture")throw new TypeError("stop_source_invalid");
      }}});
    const proposal=await supply.prepare(f.snapshot,new AbortController().signal);
    expect(checked).toHaveBeenCalledWith(source);expect(f.publication).toHaveBeenCalledTimes(2);
    expect(proposal.participants[0]).toMatchObject({kind:"input_need_condition"});
    await expect(f.prepare()).rejects.toThrow("task_input_original_source_missing");
  });
  it.each(["path","receipt_owner","receipt_result","raw_completeness"])("rejects unconfirmed source evidence: %s",async field=>{
    const f=fixture(),stage=f.stages.get("task:source")!;
    if(field==="path")Object.assign(stage.request,{pathId:"other"});
    if(field==="receipt_owner")Object.assign(stage.receipt!,{owner:"other"});
    if(field==="receipt_result")Object.assign(stage.receipt!,{resultId:"other"});
    if(field==="raw_completeness")Object.assign(stage.result!,{completeness:"partial"});
    await expect(f.prepare()).rejects.toThrow("input_supply_original_source_unconfirmed");
    expect(f.authorize).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();expect(f.publication).not.toHaveBeenCalled();
  });
});
