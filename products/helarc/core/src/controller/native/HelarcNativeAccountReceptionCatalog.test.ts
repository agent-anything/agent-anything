import {describe,it,expect,vi} from "vitest";
import type {ActivityHandoffPort,ActivityPathState} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {helarcNativeAccountScopes} from "./HelarcNativeAccountScopes.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import {HelarcNativeAccountReceptionCatalog,type HelarcNativeAccountReceptionBasis} from "./HelarcNativeAccountReceptionCatalog.js";
import type {HelarcNativeAccountReceptionWork,HelarcNativeAccountReceptionPlan} from "./HelarcNativeAccountReceptionWork.js";

function fixture(){
  const w=new HelarcNativeWorkingInput();
  for(const id of ["goal","history"])w.append([{role:"user",content:id}],{id,originRunId:"root",duties:[id==="goal"?"objective":"continuity"],
    sources:[{source:{owner:"native",kind:"record",id,revision:"1"},position:""}],preservation:{obligations:[{id,requirement:id==="goal"?"exact":"account",basis:`Retain ${id}`}],relationships:[]},
    exchangeId:null,protection:[],representations:[],acceptedBy:{runId:"root",activityId:"previous",acceptance:{id:"accepted",revision:"1"}}});
  const scope={id:"scope",runId:"root",owner:"context-representation",recipient:"agent",purpose:"task",target:"config:1",authorityBasis:"authority",continuity:"task"};
  const protocol={id:"openai.responses",revision:"1"},sourceScope=helarcNativeAccountScopes({runId:"root",items:w.items,sources:w.snapshot(),maximum:8,backgroundGroupIds:["goal"]}).scopes[0]!;
  const request={sources:[],requirements:sourceScope.requirements};
  const basis={input:{scope,activity:{scope:{activityId:"native-task"},composition:{digest:"composition",composition:{protocol}}},
    prepared:{wire:{body:JSON.stringify({input:w.items})},workingSources:w.snapshot(),sourceDigest:"source"},members:[{methodPathId:"producer",candidateId:"candidate",
      supply:{scope:sourceScope,request,option:{addresses:["original-pressure"]}}}]},
    inputNeed:{needId:"need",scope,consumer:{activityId:"native-task",compositionDigest:"composition",protocol}},
    inputSupply:{needId:"need",runId:"root",owner:scope.owner,configuration:{id:"config",revision:"1"}},checkConditions:{capacity:{},bounds:{}}} as unknown as HelarcNativeAccountReceptionBasis;
  const paths=new Map<string,ActivityPathState>([["producer",{intent:{id:"producer",runId:"root",owner:scope.owner,permissionBasis:"authority",scheduledWorkId:"producer-work"},
    progressRevision:2,controlRevision:0,cancelled:false} as ActivityPathState]]),plans=new Map<string,HelarcNativeAccountReceptionPlan>();
  const result=vi.fn(async()=>({kind:"pending"}));
  const work={readPlan:async(id:string)=>plans.get(id)??null,result,prepareSubmission:(intent:unknown,plan:HelarcNativeAccountReceptionPlan)=>[
    {owner:"activity",kind:"path_opening",proposal:intent},{owner:"activity",kind:"stage_submission",proposal:{plan}}]} as unknown as HelarcNativeAccountReceptionWork;
  const activities={command:vi.fn(async(c:any)=>paths.get(c.pathId)??null)} as ActivityHandoffPort;
  const catalog=new HelarcNativeAccountReceptionCatalog({activities,work}),id=catalog.id(basis);
  const arrangement={intent:{id,runId:"root",permissionBasis:"authority",resourceScope:id,scheduledWorkId:"receiver-work",maximumStages:128,maximumAttempts:128,
    maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},scheduling:{id:"schedule",workId:"receiver-work",runId:"root",scopeId:"tree",owner:scope.owner,
    reason:"necessary" as const,decisionId:"decision",policyRevision:"1",delayImpact:"Wait for usable input",resources:[],timing:{kind:"unknown" as const}}};
  return {basis,catalog,id,arrangement,paths,plans,result,signal:new AbortController().signal};
}
describe("native reception catalogue",()=>{
  it("keeps input identity independent of changing policy relevance evidence",()=>{
    const f=fixture(),changed=structuredClone(f.basis) as any;
    changed.input.members[0].supply.option.addresses=["new-pressure"];
    expect(f.catalog.id(changed)).toBe(f.id);
  });
  it("binds complete recipient requirements and separately bounded check work",async()=>{
    const f=fixture(),start=await f.catalog.prepareStart(f.basis,f.arrangement,f.signal);
    const plan=(start.participants.find(p=>p.kind==="stage_submission")!.proposal as {plan:HelarcNativeAccountReceptionPlan}).plan;
    expect(plan.binding.requirementsDigest).toBe(digest(helarcNativeInputRequirements(f.basis.input.prepared.workingSources!.groups)));
    expect(plan.binding.requirementsDigest).not.toBe(digest(f.basis.input.members[0]!.supply.request.requirements));
    expect(plan.check.resourceScope).not.toBe(f.arrangement.intent.resourceScope);
    expect(plan.check.scheduledWorkId).toBe(f.arrangement.intent.scheduledWorkId);
    expect(plan.input.members[0]!.supply).not.toHaveProperty("option");
  });
  it("restores the accepted plan without starting another receiver",async()=>{
    const f=fixture(),start=await f.catalog.prepareStart(f.basis,f.arrangement,f.signal);
    const plan=(start.participants.find(p=>p.kind==="stage_submission")!.proposal as {plan:HelarcNativeAccountReceptionPlan}).plan;
    f.plans.set(f.id,plan);f.paths.set(f.id,{...f.paths.get("producer")!,intent:{...f.paths.get("producer")!.intent,...f.arrangement.intent}});
    expect((await f.catalog.inspect(f.basis,f.signal)).kind).toBe("waiting");
    expect((await f.catalog.prepareStart(f.basis,f.arrangement,f.signal)).participants).toEqual([]);
    f.plans.set(f.id,{...plan,checkConditions:{...plan.checkConditions,bounds:{...plan.checkConditions.bounds,modelCalls:999}}});
    await expect(f.catalog.inspect(f.basis,f.signal)).rejects.toThrow("original_basis_changed");
  });
  it("refuses cross-Child or cancelled producer paths before accepting reception",async()=>{
    const f=fixture(),producer=f.paths.get("producer")!;
    f.paths.set("producer",{...producer,intent:{...producer.intent,runId:"child"}});
    await expect(f.catalog.prepareStart(f.basis,f.arrangement,f.signal)).rejects.toThrow("path_binding_changed");
    f.paths.set("producer",{...producer,cancelled:true});
    await expect(f.catalog.prepareStart(f.basis,f.arrangement,f.signal)).rejects.toThrow("producer_unavailable");
  });
});
