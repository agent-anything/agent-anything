import {afterEach,describe,expect,it} from "vitest";
import {createRequire} from "node:module";
import type {DatabaseSync as SqliteDatabase} from "node:sqlite";
import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {decideContextPreparation,contextPreparationWorkKey,type ContextPreparationPolicyInput,type ContextPreparationOption,
  quoteRepresentationMethod,REPRESENTATION_METHOD_PURPOSE,type RepresentationMethodRequest,
  type ContextPreparationDecisionRecord,type ContextMethodInputPlan,type ContextInputReceptionBinding} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathState,ActivityStageState,SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {ContextFoundationRecords,CONTEXT_FOUNDATION_FACT_SCHEMA} from "./ContextFoundationRecords.js";
import {ContextPreparationDecisionDatabase,CONTEXT_PREPARATION_DECISION_SCHEMA} from "./ContextPreparationDecisionDatabase.js";

const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const opened:SqliteDatabase[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();});
function fixture() {
  const db=new DatabaseSync(":memory:");opened.push(db);db.exec(CONTEXT_FOUNDATION_FACT_SCHEMA+CONTEXT_PREPARATION_DECISION_SCHEMA);
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"target",continuity:"task",owner:"context-representation",authorityBasis:"host"};
  const fact=(id:string)=>({id,owner:scope.owner,kind:"fact" as const,revision:"1"});
  const records=new ContextFoundationRecords(db as never),paths=new Map<string,ActivityPathState>();
  const options=["a","b"].map(id=>({id,request:{kind:"representation_method",recipient:{runId:scope.runId},targetRevision:scope.target,sourceBoundary:id},
    limits:{maximumStages:8,maximumAttempts:8}} as ContextPreparationOption));
  for(const option of options) {
    const pathId=`path-${option.id}`,workId=`work-${option.id}`;
    const record={input:{scope,options:[option]},decision:{id:`decision-${option.id}`,scope,investment:{kind:"propose",optionId:option.id}},
      investment:{workId,pathId,schedulingScopeId:"tree"},acceptanceId:`accept-${option.id}`} as unknown as ContextPreparationDecisionRecord;
    db.prepare("INSERT INTO context_policy_decisions VALUES (?,?,?,?,?,?)").run(record.decision.id,scope.id,scope.runId,record.acceptanceId,JSON.stringify({value:record}),digest(record));
    db.prepare("INSERT INTO context_policy_investments VALUES (?,?,?,?,?)").run(workId,pathId,scope.id,record.decision.id,null);
    paths.set(pathId,{intent:{id:pathId,runId:scope.runId,owner:scope.owner,permissionBasis:scope.authorityBasis,scheduledWorkId:workId},cancelled:false,
      progress:{method:{state:"ready",request:option.request}}} as unknown as ActivityPathState);
  }
  const members=options.map(o=>({pathId:`path-${o.id}`,workId:`work-${o.id}`,requestDigest:digest(o.request)}));
  const input:ContextPreparationPolicyInput={scope,boundary:"boundary",requirementsDigest:"requirements",
    current:{kind:"gap",gap:{reason:"capacity",targetRevision:scope.target,demandId:"original",information:[],capacity:[],untested:false,responsibility:"request_owner"},evidence:fact("gap")},
    currentRejectedInputId:null,alternatives:[],pressure:[],options:[],reuseOptions:options.map((option,i)=>({...members[i]!,option})),
    inFlight:options.map((o,i)=>({...members[i]!,preparationKey:contextPreparationWorkKey(scope,o.request),producerState:"ready",evidence:fact(o.id)})),
    explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true,
    receptionOptions:[{id:"receiver",members,addresses:["gap"],comparisons:[],evidence:fact("legal-combination")}]};
  const plan={revision:"5",scope,producers:members.map(m=>({pathId:m.pathId,candidateIds:[m.pathId+":candidate"]})),
    materialization:{intent:{id:"receiver",scheduledWorkId:"receiver-work"},request:{demand:{historyBoundary:input.boundary,
      dependencies:Object.fromEntries(members.map((m,i)=>[`representationProducer:${i}:producerRequest`,m.requestDigest]))}}}} as unknown as ContextMethodInputPlan;
  const stages=new Map<string,ActivityStageState>(),confirmedNativeInputs=new Set<string>();
  const reopen=()=>new ContextPreparationDecisionDatabase(records,value=>({value}) as never,root=>(root as unknown as {value:unknown}).value,
    ()=>({scope,control:{revision:0,allowed:true}}) as never,id=>paths.get(id)??null,()=>true,()=>({}) as never,()=>true,()=>null,
    id=>stages.get(id)??(id==="receiver:stage:1"?{request:{input:{methodInputPlan:plan}}} as never:null),
    input=>confirmedNativeInputs.has(digest(input)),input=>confirmedNativeInputs.has(digest(input)));
  const accept=(basis=input,changed:ContextMethodInputPlan|ContextInputReceptionBinding=plan,afterApply?:()=>void)=>{
    const decision=decideContextPreparation(basis),store=reopen();
    const acceptance:SharedAcceptanceProposal={id:"joint-accept",scope:scope.runId,actor:scope.owner,parts:[
      {owner:"activity",kind:"stage_submission",proposal:{id:"receiver:stage:1",input:"materialization" in changed?{methodInputPlan:changed}:{inputReception:changed,nativeOrganization:{owner:"original-recipient"}}}},
      {owner:"activity",kind:"scheduling_acceptance",proposal:{intent:{workId:"receiver-work",decisionId:decision.id,
        reason:decision.investment.kind==="prepare_input"?decision.investment.reason:"necessary"}}}]};
    const participant=store.participant(),part={owner:"context_preparation_policy",kind:"decision",proposal:{input:basis,policyRevision:decision.policy.revision,decisionId:decision.id,investment:null,expectedDecisionId:null,expectedControlRevision:0}};
    db.exec("SAVEPOINT reception_decision");
    try {
      const prepared=participant.prepare(part,acceptance);participant.apply(prepared,acceptance);afterApply?.();participant.validate?.(prepared,acceptance);
      db.exec("RELEASE reception_decision");return decision;
    }catch(error){db.exec("ROLLBACK TO reception_decision");db.exec("RELEASE reception_decision");throw error;}
  };
  const reception:ContextInputReceptionBinding={revision:"1",pathId:"receiver",workId:"receiver-work",scope,boundary:input.boundary,
    requirementsDigest:input.requirementsDigest,members};
  return {db,scope,records,paths,stages,input,plan,reopen,accept,reception,confirmedNativeInputs};
}

function extensionFixture(){
  const f=fixture(),ref=(id:string)=>({id,revision:"1"}),protocol=OPENAI_RESPONSES;
  const participant=(id:string)=>({purpose:ref(id),input:{implementation:ref(`${id}:input`),protocol},interpreter:{implementation:ref(`${id}:interpret`),protocol}});
  const nativeComposition=bindModelAgentComposition({agent:ref("agent"),protocol,configuration:{protocol,configuration:ref("config"),connectionBinding:ref("connection"),model:"controlled"},
    adapter:{implementation:ref("native"),protocol},task:participant("task"),auxiliary:[participant("method")]});
  const recipient={runId:f.scope.runId,recipient:"context-representation",purpose:"method"};
  const request:RepresentationMethodRequest={kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"Preserve original findings",
    sources:[{alias:"source",role:"source",access:{id:"source",holdId:"hold",recipient,range:{materialId:"material",version:"1",coordinate:"bytes",start:0,end:1}},
      representation:null,order:0,label:"Original",originalRole:"evidence",indivisibleGroup:"source"}],requirements:[],relationships:[],sourceBoundary:"extension",deliveryIds:[],
    combinationDigest:null,combine:"keep",omission:null,search:null,nativeComposition,targetRevision:f.scope.target,
    capacity:{limits:[],reservations:[],policy:{id:"policy",revision:"1",purpose:"method",basis:"Explicit unknown policy",allowEstimatedFit:false,allowUnknown:true},maximumCombinations:1,maximumMeasurements:0},
    bounds:{readBytes:1024,storedBytes:1024,modelCalls:4,repairs:0,levels:1,pageBytes:1024,ranges:1}};
  const assessment=assessInputCapacity({encodedInputId:"native-input",targetRevision:f.scope.target,purpose:"task",reservations:[],
    policy:{...request.capacity.policy,purpose:"task"},limits:[{id:"bytes",targetRevision:f.scope.target,dimension:"request_bytes",maximum:100,source:"fixture bound"}],
    evidence:[{id:"bytes",encodedInputId:"native-input",targetRevision:f.scope.target,methodRevision:"exact:1",dimension:"request_bytes",coverage:"complete",
      quantity:{kind:"exact",value:200},basis:"Exact oversized fixture",uncovered:[]}]});
  const gap={reason:"capacity",demandId:"native-input",targetRevision:f.scope.target,information:[],capacity:[assessment],untested:false,responsibility:"request_owner"} as const;
  const evidence={owner:"activity",id:"receiver:outcome",revision:"1",kind:"fact" as const};
  const progress={inputReceptionOutcome:{kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(f.reception),result:{kind:"gap",gap}}};
  f.paths.set("receiver",{intent:{id:"receiver",runId:f.scope.runId,owner:f.scope.owner,permissionBasis:f.scope.authorityBasis,scheduledWorkId:"receiver-work"},
    progressRevision:1,controlRevision:0,cancelled:false,progress} as unknown as ActivityPathState);
  f.stages.set("receiver:stage:1",{request:{input:{inputReception:f.reception}}} as unknown as ActivityStageState);
  f.stages.set(evidence.id,{request:{id:evidence.id,pathId:"receiver"},status:"accepted",result:{id:"raw",completeness:"complete",outcome:"returned"},
    receipt:{resultId:"raw",requestId:evidence.id,owner:f.scope.owner,expectedProgressRevision:0,progress}} as unknown as ActivityStageState);
  const quote=quoteRepresentationMethod(request),option:ContextPreparationOption={id:"extension",request,extendsReception:{optionId:"receiver",evidence},stableScope:evidence,
    addresses:[f.input.current.evidence.id],entries:quote.phases.map(p=>({phase:p.kind,state:"supported",evidence})),capability:[],comparisons:[],limits:{maximumStages:16,maximumAttempts:16}};
  const input={...f.input,options:[option],inputReceptions:[{optionId:"receiver",pathId:"receiver",workId:"receiver-work",state:"unavailable",reason:"capacity",
    evidence:{owner:"activity",kind:"fact",id:"receiver",revision:"1:0"},outcomeEvidence:evidence,inputGap:{kind:"gap",gap,evidence}}]} as ContextPreparationPolicyInput;
  const decision=decideContextPreparation(input);expect(decision.investment.kind).toBe("propose");
  const acceptance:SharedAcceptanceProposal={id:"extension-accept",scope:f.scope.runId,actor:f.scope.owner,parts:[
    {owner:"activity",kind:"path_opening",proposal:{id:"extension-path",runId:f.scope.runId,owner:f.scope.owner,scheduledWorkId:"extension-work",
      purpose:{contract:REPRESENTATION_METHOD_PURPOSE,digest:digest(REPRESENTATION_METHOD_PURPOSE)}}},
    {owner:"activity",kind:"stage_submission",proposal:{id:"extension-path:stage:1",pathId:"extension-path",input:{method:{request}}}},
    {owner:"activity",kind:"scheduling_acceptance",proposal:{expectedRevision:0,intent:{workId:"extension-work",runId:f.scope.runId,scopeId:"tree",owner:f.scope.owner,
      decisionId:decision.id,reason:"necessary"}}}]};
  const part={owner:"context_preparation_policy",kind:"decision",proposal:{input,policyRevision:decision.policy.revision,decisionId:decision.id,expectedDecisionId:null,expectedControlRevision:0,
    investment:{workId:"extension-work",pathId:"extension-path",schedulingScopeId:"tree"}}};
  const accept=(afterApply?:()=>void)=>{
    const participant=f.reopen().participant();f.db.exec("SAVEPOINT extension");
    try{const prepared=participant.prepare(part,acceptance);participant.apply(prepared,acceptance);afterApply?.();participant.validate?.(prepared,acceptance);f.db.exec("RELEASE extension");}
    catch(error){f.db.exec("ROLLBACK TO extension");f.db.exec("RELEASE extension");throw error;}
  };
  return {...f,evidence,progress,accept};
}

describe("recipient option joint acceptance",()=>{
  const arrangement=()=>{
    const f=fixture(),source={kind:"recipient_prepared" as const,scope:f.scope,inputId:"original",bodyDigest:"body",exactInputDigest:"exact",
      judgmentId:"identity",allowed:true,risks:[],evidence:{owner:"activity",kind:"fact" as const,id:"original:stage:1",revision:"1"}};
    f.confirmedNativeInputs.add(digest(source));
    const option={id:"receiver",members:[],sourceInput:source,addresses:[source.evidence.id],comparisons:[],evidence:source.evidence};
    const basis={...f.input,current:source,inFlight:[],reuseOptions:[],receptionOptions:[option],
      pressure:[{kind:"input_capacity_risk" as const,inputId:source.inputId,evidence:source.evidence}]};
    const binding:ContextInputReceptionBinding={...f.reception,revision:"2",members:[],sourceInput:source};
    return {...f,basis,binding};
  };
  it("accepts an exact original-input arrangement without a fictitious producer",()=>{
    const f=arrangement(),decision=f.accept(f.basis,f.binding);
    expect(decision.investment).toEqual({kind:"prepare_input",optionId:"receiver",reason:"opportunity"});
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})!.input.receptionOptions![0]!.sourceInput).toEqual(f.binding.sourceInput);
  });
  const checkedArrangement=()=>{
    const f=arrangement(),checked={...f.binding.sourceInput!,inputId:"checked-input",bodyDigest:"checked-body",
      exactInputDigest:"checked-exact",judgmentId:"checked-judgment"};
    f.confirmedNativeInputs.add(digest(checked));
    const evidence={owner:"activity",kind:"fact" as const,id:"receiver:stage:1",revision:"1"};
    const progress={inputReceptionOutcome:{kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(f.binding),result:{kind:"checked",input:checked}}};
    f.paths.set("receiver",{intent:{id:"receiver",runId:f.scope.runId,owner:f.scope.owner,permissionBasis:f.scope.authorityBasis,scheduledWorkId:"receiver-work"},
      progressRevision:1,controlRevision:0,cancelled:false,progress} as unknown as ActivityPathState);
    f.stages.set(evidence.id,{request:{id:evidence.id,pathId:"receiver",input:{inputReception:f.binding}},status:"accepted",
      result:{id:"raw",completeness:"complete",outcome:"returned"},receipt:{resultId:"raw",requestId:evidence.id,owner:f.scope.owner,
        expectedProgressRevision:0,progress}} as unknown as ActivityStageState);
    const basis:ContextPreparationPolicyInput={...f.basis,receptionOptions:f.basis.receptionOptions.map(option=>({...option,beforeUse:true})),
      alternatives:[{input:checked,comparisons:[]}],inputReceptions:[{optionId:"receiver",pathId:"receiver",workId:"receiver-work",state:"checked",reason:null,
        evidence:{owner:f.scope.owner,kind:"fact",id:"receiver",revision:"1:0"},outcomeEvidence:evidence,
        checkedInput:{inputId:checked.inputId,exactInputDigest:checked.exactInputDigest}}]};
    return {...f,basis,evidence};
  };
  it("accepts a checked before-use input only from its original receiver outcome",()=>{
    const f=checkedArrangement(),decision=f.accept(f.basis,f.binding);
    expect(decision.foreground).toMatchObject({kind:"continue",preparedInputId:"checked-input",adoption:"propose"});
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})!.input.inputReceptions).toEqual(f.basis.inputReceptions);
  });
  it.each([false,true])("uses the explicit later outcome stage and rejects a foreign path (%s)",foreign=>{
    const f=checkedArrangement(),first=f.stages.get(f.evidence.id)!,id="receiver:assess";
    f.stages.set(f.evidence.id,{...first,receipt:{...first.receipt!,progress:{inputReception:f.binding}}});
    f.stages.set(id,{...first,request:{...first.request,id,pathId:foreign?"other-receiver":"receiver",input:{planDigest:digest(f.binding)}},
      result:{...first.result!,id:"assessed-raw"},receipt:{...first.receipt!,requestId:id,resultId:"assessed-raw",expectedProgressRevision:1}});
    f.paths.set("receiver",{...f.paths.get("receiver")!,progressRevision:2});
    const basis={...f.basis,inputReceptions:f.basis.inputReceptions!.map(r=>({...r,evidence:{...r.evidence,revision:"2:0"},outcomeEvidence:{...f.evidence,id,revision:"2"}}))};
    if(foreign){
      expect(()=>f.accept(basis,f.binding)).toThrow("checked_reception_input_unconfirmed");
      expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
    }else expect(f.accept(basis,f.binding).foreground).toMatchObject({kind:"continue",preparedInputId:"checked-input",adoption:"propose"});
  });
  it.each(["unaccepted","digest","source","requirements","recipient","cancelled","control","progress","work"])(
    "rejects %s checked reception evidence without partial publication",kind=>{
      const f=checkedArrangement(),stage=f.stages.get(f.evidence.id)!,path=f.paths.get("receiver")!;
      if(kind==="unaccepted")f.stages.set(f.evidence.id,{...stage,status:"settled"});
      if(kind==="source")f.confirmedNativeInputs.delete(digest(f.binding.sourceInput));
      if(kind==="requirements"||kind==="recipient")f.stages.set(f.evidence.id,{...stage,request:{...stage.request,
        input:{inputReception:{...f.binding,...(kind==="requirements"?{requirementsDigest:"other"}:{scope:{...f.scope,recipient:"child"}})}}}});
      if(["cancelled","control","progress","work"].includes(kind))f.paths.set("receiver",{...path,
        ...(kind==="cancelled"?{cancelled:true}:{}),...(kind==="control"?{controlRevision:1}:{}),...(kind==="progress"?{progressRevision:2}:{}),
        ...(kind==="work"?{intent:{...path.intent,scheduledWorkId:"other"}}:{})});
      const basis=kind==="digest"?{...f.basis,inputReceptions:f.basis.inputReceptions!.map(r=>({...r,checkedInput:{...r.checkedInput!,exactInputDigest:"forged"}}))}:f.basis;
      expect(()=>f.accept(basis,f.binding)).toThrow();
      expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
    });
  it("rechecks receiver control at joint commit and rolls back decision and facts",()=>{
    const f=checkedArrangement();
    expect(()=>f.accept(f.basis,f.binding,()=>f.paths.set("receiver",{...f.paths.get("receiver")!,controlRevision:1})))
      .toThrow("checked_reception_input_unconfirmed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
  });
  it.each(["unconfirmed","changed","withdrawn","old-binding"])("rejects %s source input without accepting new work",kind=>{
    const f=arrangement();
    if(kind==="unconfirmed")f.confirmedNativeInputs.clear();
    const changed=kind==="changed"?{...f.binding,sourceInput:{...f.binding.sourceInput!,bodyDigest:"changed"}}:
      kind==="old-binding"?{...f.binding,revision:"1" as const}:f.binding;
    expect(()=>f.accept(f.basis,changed,kind==="withdrawn"?()=>f.confirmedNativeInputs.clear():undefined)).toThrow();
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();
  });
  it("accepts native reception extension from the accepted outcome without a generic organization plan",()=>{
    const f=extensionFixture();f.accept();expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})!.investment!.pathId).toBe("extension-path");
    const fact=f.records.facts(f.scope.runId,0,32).find(f=>f.kind==="decision_accepted")!;
    expect(fact.evidence!.relationships.some(r=>r.to.id===f.evidence.id)).toBe(true);
  });
  it.each(["receipt","boundary","producer","progress"])("rejects changed %s at native extension acceptance",kind=>{
    const f=extensionFixture();
    if(kind==="receipt")f.stages.set(f.evidence.id,{...f.stages.get(f.evidence.id)!,status:"settled"});
    if(kind==="boundary")f.stages.set("receiver:stage:1",{request:{input:{inputReception:{...f.reception,boundary:"changed"}}}} as never);
    if(kind==="producer")f.paths.set("path-b",{...f.paths.get("path-b")!,cancelled:true});
    if(kind==="progress")f.paths.set("receiver",{...f.paths.get("receiver")!,progressRevision:2});
    expect(()=>f.accept()).toThrow();expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();
  });
  it("rechecks accepted native outcome after other participants apply and rolls back the new investment",()=>{
    const f=extensionFixture();expect(()=>f.accept(()=>f.paths.set("receiver",{...f.paths.get("receiver")!,progress:{changed:true}}))).toThrow("outcome_unconfirmed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
  });
  it("accepts recipient-owned organization without a generic materialization plan",()=>{
    const f=fixture(),decision=f.accept(f.input,f.reception);
    expect(decision.investment).toEqual({kind:"prepare_input",optionId:"receiver",reason:"necessary"});
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})?.input.receptionOptions![0]!.members).toEqual(f.reception.members);
  });
  it.each(["requirements","boundary","scope","members","work"])("rejects changed native reception %s",kind=>{
    const f=fixture(),changed={...f.reception,
      ...(kind==="requirements"?{requirementsDigest:"other"}:{}),...(kind==="boundary"?{boundary:"other"}:{}),
      ...(kind==="scope"?{scope:{...f.scope,recipient:"child"}}:{}),...(kind==="members"?{members:f.reception.members.slice(0,1)}:{}),
      ...(kind==="work"?{workId:"other"}:{})};
    expect(()=>f.accept(f.input,changed)).toThrow(kind==="work"?"input_reception_handoff_changed":"input_reception_binding_changed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();
  });
  it("rechecks every native reception producer at the joint commit boundary",()=>{
    const f=fixture();
    expect(()=>f.accept(f.input,f.reception,()=>{f.paths.set("path-b",{...f.paths.get("path-b")!,cancelled:true});})).toThrow("producer_binding_changed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();
  });
  it("persists the full two-producer choice and reopens it without substituting the first producer",()=>{
    const f=fixture(),decision=f.accept();
    expect(decision.investment).toEqual({kind:"prepare_input",optionId:"receiver",reason:"necessary"});
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})?.input.receptionOptions![0]!.members).toEqual(f.input.receptionOptions![0]!.members);
    const fact=f.records.facts(f.scope.runId,0,32).find(f=>f.kind==="decision_accepted")!;
    expect(fact.details.receptionOptions).toEqual(f.input.receptionOptions);
    expect(fact.evidence).toMatchObject({revision:"1",category:"decision",subject:{owner:"context-representation",id:decision.id,runId:"root"},state:{phase:"settled",status:"decision_accepted"}});
    for(const id of ["path-a","path-b","work-a","work-b"])
      expect(fact.evidence!.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id})}));
    expect(fact.evidence!.relationships).toContainEqual(expect.objectContaining({kind:"observes",to:{owner:"context_preparation_policy",id:decision.id,runId:"root",revision:digest(f.reopen().query({kind:"latest",scopeId:f.scope.id}))}}));
    expect(new ContextFoundationRecords(f.db as never).facts(f.scope.runId,0,32)).toEqual(f.records.facts(f.scope.runId,0,32));
  });
  it.each(["cancelled","request_changed","work_changed","authority_changed"])("rejects the second producer when %s, atomically",kind=>{
    const f=fixture(),old=f.paths.get("path-b")!;
    f.paths.set("path-b",{...old,...(kind==="cancelled"?{cancelled:true}:{}),
      ...(kind==="request_changed"?{progress:{method:{state:"ready",request:{changed:true}}}}:{}),
      intent:{...old.intent,...(kind==="work_changed"?{scheduledWorkId:"another-work"}:{}),...(kind==="authority_changed"?{permissionBasis:"other"}:{})}});
    expect(()=>f.accept()).toThrow("producer_binding_changed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
  });
  it("rejects membership loss and falsely resupplied requests even when the policy input is internally consistent",()=>{
    const f=fixture();
    expect(()=>f.accept(f.input,{...f.plan,producers:f.plan.producers.slice(0,1)})).toThrow("input_reception_binding_changed");
    const changed={...f.input.reuseOptions![1]!.option,request:{...f.input.reuseOptions![1]!.option.request,sourceBoundary:"changed"}};
    const basis={...f.input,reuseOptions:[f.input.reuseOptions![0]!,{...f.input.reuseOptions![1]!,option:changed}],
      inFlight:f.input.inFlight.map(w=>w.pathId!=="path-b"?w:{...w,preparationKey:contextPreparationWorkKey(f.scope,changed.request)}),
      receptionOptions:f.input.receptionOptions!.map(o=>({...o,members:o.members.map(m=>m.pathId!=="path-b"?m:{...m,requestDigest:digest(changed.request)})}))};
    const plan={...f.plan,materialization:{...f.plan.materialization,request:{...f.plan.materialization.request,demand:{...f.plan.materialization.request.demand,
      dependencies:{...f.plan.materialization.request.demand.dependencies,"representationProducer:1:producerRequest":digest(changed.request)}}}}};
    expect(()=>f.accept(basis,plan)).toThrow("producer_binding_changed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();
  });
  it("rechecks the second member after later participants have applied, before commit",()=>{
    const f=fixture();
    expect(()=>f.accept(f.input,f.plan,()=>{f.paths.set("path-b",{...f.paths.get("path-b")!,cancelled:true});})).toThrow("producer_binding_changed");
    expect(f.reopen().query({kind:"latest",scopeId:f.scope.id})).toBeNull();expect(f.records.facts(f.scope.runId,0,32)).toEqual([]);
  });
  it("rejects a correctly hashed evidence descriptor bound to another Run",()=>{
    const f=fixture();f.accept();
    const fact=f.records.facts(f.scope.runId,0,32)[0]!;
    const {sequence,...value}=fact;
    const tampered={...value,evidence:{...fact.evidence!,subject:{...fact.evidence!.subject,runId:"child"}}};
    f.db.prepare("UPDATE context_foundation_facts SET value=?,digest=? WHERE sequence=?").run(JSON.stringify(tampered),digest(tampered),sequence);
    expect(()=>new ContextFoundationRecords(f.db as never).facts(f.scope.runId,0,32)).toThrow("context_fact_evidence_scope_invalid");
  });
});
