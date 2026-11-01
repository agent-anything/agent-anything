import {describe,expect,it,vi} from "vitest";
import {ContextMethodInputSupply,type ContextMethodInputPlan} from "./ContextMethodInputSupply.js";
import {ContextInputMaterializationWork} from "./ContextInputMaterialization.js";

function fixture() {
  const scope={id:"scope",runId:"parent",recipient:"parent-agent",purpose:"task",target:"model",owner:"context-representation",continuity:"thread",authorityBasis:"permission"};
  const range={materialId:"report",version:"1",start:0,end:20,coordinate:"bytes"};
  const candidate={id:"candidate",representation:{id:"representation",revision:"1"},access:{id:"access",holdId:"hold",recipient:{runId:"parent",recipient:"context-representation",purpose:"method"},range}};
  const plan={revision:"5",scheduling:null,producers:[{pathId:"producer",candidateIds:[candidate.id]}],scope,check:{intent:{id:"check",runId:"parent",permissionBasis:"permission"},objective:"Check original requirements"},
    materialization:{intent:{id:"materialize",runId:"parent",permissionBasis:"permission"},request:{preparationIntent:{id:"prepare"},demand:{...scope,targetRevision:scope.target,contributions:[{options:[{sections:[{section:{source:{owner:"context-representation",kind:"representation",...candidate.representation},content:{kind:"retained_text",access:{...candidate.access,recipient:scope}}}}]}]}]}}}} as unknown as ContextMethodInputPlan;
  const paths=new Map<string,unknown>([["producer",{intent:{id:"producer",runId:"parent",owner:scope.owner,permissionBasis:scope.authorityBasis},cancelled:false,controlRevision:0,progressRevision:1}]]),stages=new Map<string,unknown>();
  const activities={command:vi.fn(async(command:{kind:string;pathId?:string;requestId?:string})=>command.kind==="read_path"?paths.get(command.pathId!)??null:stages.get(command.requestId!)??null)};
  const produced={kind:"ready",progress:{request:{targetRevision:"model"},candidates:[candidate],resultIds:[candidate.id]}};
  const methods={result:vi.fn(async()=>produced),prepareSubmission:vi.fn()};
  const materialization={prepareSubmission:vi.fn((intent:unknown,request:unknown)=>[{owner:"activity",kind:"path_opening",proposal:intent},
    {owner:"activity",kind:"stage_submission",proposal:{id:"materialize:stage:1",pathId:"materialize",input:{request,pages:[]}}}]),result:vi.fn(async()=>({kind:"pending"}))};
  const materials={command:vi.fn()},representations={command:vi.fn()};
  const supply=new ContextMethodInputSupply({activities,materials,representations,methods,materialization} as unknown as ConstructorParameters<typeof ContextMethodInputSupply>[0]);
  return {plan,supply,methods,materialization,materials,produced,paths,stages,signal:new AbortController().signal};
}
describe("method result input consumer",()=>{
  function jointFixture() {
    const f=fixture(),candidate=structuredClone(f.produced.progress.candidates[0]!);
    candidate.id="second-candidate";candidate.representation.id="second-representation";
    candidate.access.holdId="second-hold";candidate.access.range.materialId="second-report";
    const second={...f.produced,progress:{...f.produced.progress,candidates:[candidate],resultIds:[candidate.id]}};
    f.paths.set("second",{intent:{id:"second",runId:"parent",owner:f.plan.scope.owner,permissionBasis:f.plan.scope.authorityBasis},cancelled:false,controlRevision:2,progressRevision:5});
    Object.assign(f.plan,{producers:[...f.plan.producers,{pathId:"second",candidateIds:[candidate.id]}]});
    const section={source:{owner:"context-representation",kind:"representation",...candidate.representation},content:{kind:"retained_text",access:candidate.access}};
    Object.assign(f.plan.materialization.request.demand,{contributions:[...f.plan.materialization.request.demand.contributions,{options:[{sections:[{section}]}]}]});
    f.methods.result.mockImplementation(async(pathId?:string)=>pathId==="second"?second:f.produced);
    return {...f,second};
  }
  it("freezes both original producers, observes both and guards both control boundaries",async()=>{
    const f=jointFixture(),result=await f.supply.prepare(f.plan,f.signal);
    expect(result.kind).toBe("waiting");expect(result.conditions).toHaveLength(2);
    expect(result.conditions[1]!.proposal).toMatchObject({pathId:"second",expected:{controlRevision:2,progressRevision:5,cancelled:false}});
    expect(result.observeSources).toContain("activity-source:control:second");
    expect(f.methods.result.mock.calls.map(c=>c[0])).toEqual(["producer","second"]);
    expect(f.materialization.prepareSubmission).toHaveBeenCalledOnce();
  });
  it.each(["pending","cancelled","gap"])("never completes a smaller set when the second producer is %s",async kind=>{
    const f=jointFixture();f.methods.result.mockImplementation(async(pathId?:string)=>pathId==="second"?
      {kind,progress:{gap:{code:"preservation_unknown"}}} as never:f.produced);
    const result=await f.supply.prepare(f.plan,f.signal);
    expect(result.kind).toBe(kind==="pending"?"waiting":"unavailable");
    expect(result.observeSources).toContain("activity-source:progress:second");expect(f.materialization.prepareSubmission).not.toHaveBeenCalled();
  });
  it.each(["recipient","authority","owner","missing"])("rejects a second producer with changed %s",async change=>{
    const f=jointFixture(),path=f.paths.get("second") as {intent:Record<string,string>};
    if(change==="missing")f.paths.delete("second");else path.intent[change==="recipient"?"runId":change==="authority"?"permissionBasis":"owner"]="other";
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow("original_producer_unavailable");expect(f.materialization.prepareSubmission).not.toHaveBeenCalled();
  });
  it.each(["empty","duplicate","overlap"])("rejects an invalid %s producer set",async change=>{
    const f=jointFixture();Object.assign(f.plan,{producers:change==="empty"?[]:change==="duplicate"?[f.plan.producers[0],f.plan.producers[0]]:
      [{...f.plan.producers[0],pathId:"materialize"}]});
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow(change==="overlap"?"plan_scope_invalid":"producers_invalid");
    expect(f.methods.result).not.toHaveBeenCalled();
  });
  it.each(["valid","plan","need","configuration","intent","request","subscription","pages","stageKind","capabilities","dependencies","closed-new","closed-existing","sources"])("checks the frozen %s binding before registering an independent recipient",change=>{
    const f=fixture(),binding={needId:"need",runId:"parent",owner:"context-representation",consumerPathId:"task",source:{stageId:"source",requestDigest:"original"},configuration:{id:"fixed",revision:"1"}};
    Object.assign(f.plan,{inputSupply:binding});
    const path={...f.plan.materialization.intent,owner:binding.owner,purpose:{}} as import("../activity/index.js").ActivityPathIntent;
    const original=ContextInputMaterializationWork.initialStage(path.id,f.plan.materialization.request);
    const first={request:{...original,input:{...original.input as object,methodInputPlan:f.plan}}} as unknown as import("../activity/index.js").ActivityStageState;
    const subscription={id:`${path.id}:consumer`,runId:"parent",owner:binding.owner,binding:{kind:"activity_path" as const,id:path.id},
      sources:[path.id,...f.plan.producers.map(p=>p.pathId)].flatMap(id=>[`activity-source:control:${id}`,`activity-source:progress:${id}`])};
    const state={subscription,observedSources:subscription.sources,revision:0,consumedThrough:0,closed:change.startsWith("closed")};
    if(change==="plan")Object.assign(first.request,{input:{request:f.plan.materialization.request}});
    if(change==="need")Object.assign(f.plan,{inputSupply:{...binding,needId:"sibling"}});
    if(change==="configuration")Object.assign(f.plan,{inputSupply:{...binding,configuration:{id:"changed",revision:"2"}}});
    if(change==="intent")Object.assign(path,{permissionBasis:"different"});
    if(change==="request")Object.assign(first.request,{input:{methodInputPlan:f.plan,request:{different:true}}});
    if(change==="pages")Object.assign(first.request.input as object,{pages:[{unconfirmed:true}]});
    if(change==="stageKind")Object.assign(first.request,{stageKind:"unknown"});
    if(change==="capabilities")Object.assign(first.request,{capabilities:[]});
    if(change==="dependencies")Object.assign(first.request,{dependencies:[{requestId:"unrelated",condition:"accepted"}]});
    if(change==="sources")subscription.sources.length=0;
    const check=()=>ContextMethodInputSupply.validateInputSupply(binding,path,first,change==="subscription"?null:state,change!=="closed-existing",null);
    if(change==="valid"||change==="closed-existing")expect(check).not.toThrow();else expect(check).toThrow("method_input_supply_binding_unconfirmed");
  });
  function resultTextFixture() {
    const f=fixture(),option=f.plan.materialization.request.demand.contributions[0]!.options[0]!,section=option.sections[0]!.section;
    const slot={callId:"call",contentPath:["report"],resultDigest:"original-result",textDigest:"original-text"};
    const binding={sectionId:"native-result",slot,source:{owner:"result-owner",kind:"declaration",id:"source",revision:"1"},
      representation:{owner:"context-representation",kind:"representation",...f.produced.progress.candidates[0]!.representation}};
    Object.assign(section,{id:binding.sectionId,source:binding.source,content:{kind:"retained_result_text",replacements:[{...section.content,slot}]}});
    Object.assign(option,{resultTextBindings:[binding]});return {...f,option,binding};
  }
  it("uses the declared result text representation without replacing the original section's ownership",async()=>{
    const f=resultTextFixture();expect(await f.supply.prepare(f.plan,f.signal)).toMatchObject({kind:"waiting"});
    expect(f.materialization.prepareSubmission).toHaveBeenCalledOnce();expect(f.materials.command).not.toHaveBeenCalled();
  });
  it.each(["missing","slot","representation"])("rejects a %s result text binding before opening material work",async change=>{
    const f=resultTextFixture();
    if(change==="missing")Object.assign(f.option,{resultTextBindings:[]});
    if(change==="slot")Object.assign(f.binding,{slot:{...f.binding.slot,callId:"sibling"}});
    if(change==="representation")Object.assign(f.binding,{representation:{...f.binding.representation,id:"unrelated"}});
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow(change==="representation"?"candidate_declaration_missing":"result_slot_binding_missing");
    expect(f.materialization.prepareSubmission).not.toHaveBeenCalled();expect(f.materials.command).not.toHaveBeenCalled();
  });
  it.each([undefined,"1","2","3","4"])("rejects unavailable lifecycle revision %s on admission and recovery",async revision=>{
    const f=fixture();Object.assign(f.plan,{revision});
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow("plan_revision_unavailable");
    f.stages.set("materialize:stage:1",{request:{input:{methodInputPlan:f.plan}}});
    await expect(f.supply.readPlan("materialize")).rejects.toThrow("plan_revision_unavailable");
    expect(f.methods.result).not.toHaveBeenCalled();
  });
  function admittedFixture() {
    const f=fixture(),candidate=f.produced.progress.candidates[0]!;
    const recipient={runId:f.plan.scope.runId,recipient:f.plan.scope.recipient,purpose:f.plan.scope.purpose};
    const hold={id:"recipient-hold",instanceId:"instance",consumer:recipient,responsibility:"preparation" as const,
      range:candidate.access.range as import("@agent-anything/context/custody").MaterialRange,basis:"materialize",releaseCondition:"explicit settlement"};
    const grant={id:"recipient-grant",instanceId:"instance",recipient,range:hold.range,revision:0,allowed:true,basis:"permission"};
    const source=candidate.access as import("@agent-anything/context/custody").MaterialAccess;
    Object.assign(f.plan,{materialAdmissions:[{source,grant,hold}]});
    const section=f.plan.materialization.request.demand.contributions[0]!.options[0]!.sections[0]!.section;
    Object.assign(section,{content:{kind:"retained_text",access:{...source,id:"recipient-access",holdId:hold.id,recipient}}});
    return {...f,hold,grant};
  }
  it("admits candidate access with the original consumer plan, without an imperative grant",async()=>{
    const f=admittedFixture(),result=await f.supply.prepare(f.plan,f.signal);
    if(result.kind!=="waiting")throw new Error("fixture");
    expect(result.participants.map(p=>p.kind)).toEqual(["admit_access","path_opening","stage_submission"]);
    expect(f.materials.command).not.toHaveBeenCalled();
    f.paths.set("materialize",{intent:result.participants[1]!.proposal});
    f.stages.set("materialize:stage:1",{request:result.participants[2]!.proposal});
    expect(await f.supply.readPlan("materialize")).toEqual(f.plan);
    expect(await f.supply.prepare(f.plan,f.signal)).toMatchObject({kind:"waiting",participants:[]});
  });
  it.each(["source","authority","holder","recipient"])("rejects a changed %s in the candidate handoff",async field=>{
    const f=admittedFixture(),admission=f.plan.materialAdmissions![0]!;
    if(field==="authority")Object.assign(f.grant,{basis:"unrelated-authority"});
    if(field==="holder")Object.assign(f.hold,{basis:"other-consumer"});
    if(field==="recipient")Object.assign(f.grant,{recipient:{...f.grant.recipient,runId:"sibling"}});
    if(field==="source")Object.assign(admission,{source:{...admission.source,id:"unrelated"}});
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow("material_admission_mismatch");
    expect(f.materials.command).not.toHaveBeenCalled();
  });
  it("proposes retained-text work without reading materials, sending a request, or adopting a result",async()=>{
    const f=fixture(),result=await f.supply.prepare(f.plan,f.signal);expect(result.kind).toBe("waiting");
    if(result.kind!=="waiting")throw new Error("fixture");expect(result.participants).toHaveLength(2);
    expect(result.observeSources).toHaveLength(4);expect(f.materials.command).not.toHaveBeenCalled();expect(f.methods.prepareSubmission).not.toHaveBeenCalled();
    expect(result.participants[1]!.proposal).toMatchObject({input:{methodInputPlan:f.plan}});
  });
  it("restores the original consumer plan and rejects changed quality work before starting it",async()=>{
    const f=fixture(),result=await f.supply.prepare(f.plan,f.signal);if(result.kind!=="waiting")throw new Error("fixture");
    f.paths.set("materialize",{intent:result.participants[0]!.proposal});f.stages.set("materialize:stage:1",{request:result.participants[1]!.proposal});
    expect(await f.supply.readPlan("materialize")).toEqual(f.plan);
    await expect(f.supply.prepare({...f.plan,check:{...f.plan.check,objective:"changed"}},f.signal)).rejects.toThrow("original_binding_changed");
    expect(f.materialization.result).not.toHaveBeenCalled();
  });
  it.each(["pending","cancelled","gap"])("does not recreate a %s original producer",async kind=>{
    const f=fixture();f.methods.result.mockResolvedValue({kind,progress:{gap:{code:"unsupported_preservation"}}} as never);
    const result=await f.supply.prepare(f.plan,f.signal);
    expect(result.kind).toBe(kind==="pending"?"waiting":"unavailable");expect(f.materialization.prepareSubmission).not.toHaveBeenCalled();
    expect(f.methods.prepareSubmission).not.toHaveBeenCalled();
  });
  it("rejects candidate substitution, target substitution and unrelated recipients",async()=>{
    const f=fixture();
    await expect(f.supply.prepare({...f.plan,producers:[{pathId:"producer",candidateIds:["other"]}]},f.signal)).rejects.toThrow("unconfirmed_candidate");
    await expect(f.supply.prepare({...f.plan,scope:{...f.plan.scope,runId:"sibling"}},f.signal)).rejects.toThrow("plan_scope_invalid");
    f.methods.result.mockResolvedValue({...f.produced,progress:{...f.produced.progress,request:{targetRevision:"different-model"}}});
    await expect(f.supply.prepare(f.plan,f.signal)).rejects.toThrow("target_changed");
  });
});
