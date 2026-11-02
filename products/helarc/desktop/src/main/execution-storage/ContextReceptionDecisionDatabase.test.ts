import {afterEach,describe,expect,it} from "vitest";
import {createRequire} from "node:module";
import type {DatabaseSync as SqliteDatabase} from "node:sqlite";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {decideContextPreparation,contextPreparationWorkKey,type ContextPreparationPolicyInput,type ContextPreparationOption,
  type ContextPreparationDecisionRecord,type ContextMethodInputPlan} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathState,SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
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
  const reopen=()=>new ContextPreparationDecisionDatabase(records,value=>({value}) as never,root=>(root as unknown as {value:unknown}).value,
    ()=>({scope,control:{revision:0,allowed:true}}) as never,id=>paths.get(id)??null,()=>true,()=>({}) as never,()=>true,()=>null,
    id=>id==="receiver:stage:1"?{request:{input:{methodInputPlan:plan}}} as never:null);
  const accept=(basis=input,changed=plan,afterApply?:()=>void)=>{
    const decision=decideContextPreparation(basis),store=reopen();
    const acceptance:SharedAcceptanceProposal={id:"joint-accept",scope:scope.runId,actor:scope.owner,parts:[
      {owner:"activity",kind:"stage_submission",proposal:{id:"receiver:stage:1",input:{methodInputPlan:changed}}},
      {owner:"activity",kind:"scheduling_acceptance",proposal:{intent:{workId:"receiver-work",decisionId:decision.id,reason:"necessary"}}}]};
    const participant=store.participant(),part={owner:"context_preparation_policy",kind:"decision",proposal:{input:basis,investment:null,expectedDecisionId:null,expectedControlRevision:0}};
    db.exec("SAVEPOINT reception_decision");
    try {
      const prepared=participant.prepare(part,acceptance);participant.apply(prepared,acceptance);afterApply?.();participant.validate?.(prepared,acceptance);
      db.exec("RELEASE reception_decision");return decision;
    }catch(error){db.exec("ROLLBACK TO reception_decision");db.exec("RELEASE reception_decision");throw error;}
  };
  return {db,scope,records,paths,input,plan,reopen,accept};
}

describe("recipient option joint acceptance",()=>{
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
