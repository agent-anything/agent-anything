import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,activityStageEvidence,type ActivityHandoffCommand,type ActivityPathIntent,type SharedAcceptancePart,
  type ActivityInputNeed,type ActivityReconsiderationSnapshot,type ActivitySchedulingIntent,type ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {TASK_MODEL_RESPONSE_PURPOSE} from "@agent-anything/agent-runtime/decision";
import {inputSupplyRegistration,inputSupplyResponsibility,inputSupplyExit,CONTEXT_INPUT_PREPARATION_PURPOSE,SOURCE_MATERIAL_PUBLICATION_PURPOSE,CONTEXT_INPUT_MATERIALIZATION_PURPOSE,REPRESENTATION_METHOD_PURPOSE,ContextInputMaterializationWork,
  type InputSupplyBinding,type InputSupplyHead,type InputSupplyResponsibilityQuery,type InputSupplyResponsibilityPage,type InputSupplyUsersPage,
  type InputSupplyExit,type InputSupplyExitBasis,type InputSupplyExitPending} from "@agent-anything/agent-runtime/context-representation";
import {ExecutionDatabase} from "./ExecutionDatabase.js";
import {SharedAcceptanceDatabase} from "./SharedAcceptanceDatabase.js";
import type {ActivityHandoffDatabase} from "./ActivityHandoffDatabase.js";
import type {InputSupplyResponsibilityDatabase} from "./InputSupplyResponsibilityDatabase.js";
import Database from "better-sqlite3";

const databases:ExecutionDatabase[]=[],directories:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const path of directories.splice(0)){
  if(dirname(resolve(path))!==resolve(tmpdir())||!basename(path).startsWith("helarc-supply-"))throw new Error("Unsafe cleanup");
  rmSync(path,{recursive:true,force:true});
}});
function open(directory=mkdtempSync(join(tmpdir(),"helarc-supply-"))) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const a=(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue;
  const query=(query:InputSupplyResponsibilityQuery)=>db.inputSupplyQuery(db.generation,query).inputSupplyValue;
  const registry=new ActivityPurposeRegistry<null>();
  const purpose=registry.register(TASK_MODEL_RESPONSE_PURPOSE,null),preparation=registry.register(CONTEXT_INPUT_PREPARATION_PURPOSE,null),publication=registry.register(SOURCE_MATERIAL_PUBLICATION_PURPOSE,null);
  function need(id="task"):InputSupplyBinding {
    const intent:ActivityPathIntent={id,runId:"root",owner:"task-decision",purpose,permissionBasis:"original",resourceScope:id,
      maximumStages:4,maximumAttempts:4,maximumConcurrent:1,deadlineAt:"2099-01-01T00:00:00Z"};
    const request={id:`${id}:source`,pathId:id,stageKind:"source",input:{original:id},capabilities:[],dependencies:[]};
    const executor={hostSession:"test",worker:"test",generation:db.generation};
    a({kind:"open_path",intent});a({kind:"submit",request});a({kind:"admit",requestId:request.id,expectedControlRevision:0});
    a({kind:"dispatch",attempt:{id:`${id}:attempt`,requestId:request.id,executor,inputDigest:digest(request.input),startedAt:new Date().toISOString()},expectedControlRevision:0});
    a({kind:"save_raw",result:{id:`${id}:result`,attemptId:`${id}:attempt`,completeness:"complete",outcome:"returned",value:{retained:true},usage:{},recordedAt:new Date().toISOString()}});
    a({kind:"claim_processing",claim:{id:`${id}:claim`,requestId:request.id,executor,previousClaimId:null},expectedControlRevision:0});
    a({kind:"accept",receipt:{id:`${id}:accepted`,requestId:request.id,resultId:`${id}:result`,owner:"task-decision",expectedProgressRevision:0,progress:{retained:true},next:[]},executor,expectedControlRevision:0});
    a({kind:"register_input_need",need:{id:`${id}:need`,supplier:"context-representation",stage:{id:`${id}:model`,pathId:id,stageKind:"model",capabilities:["model-request"],dependencies:[]},
      unavailableStage:{id:`${id}:unavailable`,pathId:id,stageKind:"input-unavailable",capabilities:[],dependencies:[]}}});
    return {needId:`${id}:need`,runId:"root",owner:"context-representation",consumerPathId:id,source:{stageId:request.id,requestDigest:digest(request)},configuration:{id:"fixed",revision:"1"}};
  }
  function work(id:string,source=false,scheduledWorkId?:string) {
    const intent:ActivityPathIntent={id,runId:"root",owner:source?"material-source":"context-representation",purpose:source?publication:preparation,
      permissionBasis:"original",resourceScope:id,maximumStages:2,maximumAttempts:2,maximumConcurrent:1,deadlineAt:"2099-01-01T00:00:00Z",
      ...(scheduledWorkId?{scheduledWorkId}:{})};
    const request={id:source?`${id}:capture`:`${id}:stage:1`,pathId:id,stageKind:source?"capture":"organize",input:{original:id},capabilities:[],dependencies:[]};
    const parts:SharedAcceptancePart[]=[{owner:"activity",kind:"path_opening",proposal:intent},{owner:"activity",kind:"stage_submission",proposal:request}];
    return {intent,request,parts,entry:inputSupplyResponsibility(source?"source_publication":"input_preparation",intent)};
  }
  const accept=(id:string,binding:InputSupplyBinding,entries:ReturnType<typeof work>["entry"][],parts:readonly SharedAcceptancePart[]=[],expectedRevision=0,scheduling?:ActivitySchedulingIntent|null)=>
    db.acceptShared(db.generation,{id,scope:"root",actor:binding.owner,parts:[inputSupplyRegistration({binding,expectedRevision,expectedConsumerControlRevision:0,responsibilities:entries,
      ...(scheduling===undefined?{}:{scheduling})}),...parts]}).acceptanceValue;
  return {db,directory,a,query,need,work,accept};
}

describe("accepted input supply responsibilities",()=>{
  it.each([false,true])("jointly verifies actual receiver scheduling, not just its declaration (extra path=%s)",extra=>{
    const f=open(),binding=f.need(),producer=f.work("producer");f.a({kind:"open_path",intent:producer.intent});
    f.a({kind:"bind_resource_pool",pool:{id:"model",revision:"1",authority:"host",capacity:1}});
    const registered=new ActivityPurposeRegistry<null>().register(CONTEXT_INPUT_MATERIALIZATION_PURPOSE,null);
    const path={...f.work("materialize").intent,purpose:registered,scheduledWorkId:"receiver-work"};
    const {purpose:_,owner:__,...intent}=path;
    const scheduling={id:"receiver-schedule",workId:"receiver-work",runId:"root",scopeId:"tree",owner:binding.owner,decisionId:"decision",policyRevision:"1",
      reason:"opportunity" as const,delayImpact:"recipient input",timing:{kind:"unknown" as const},resources:[{poolId:"model",capability:"model-access",units:1}],allowedPathIds:["materialize","organize","check"]};
    // The professional binding validator is exercised here; execution semantics have separate real-Worker coverage.
    const request={kind:"context_input_materialization",demand:{contributions:[]},preparationIntent:{...intent,id:"organize"}} as unknown as import("@agent-anything/agent-runtime/context-representation").ContextInputMaterializationRequest;
    const plan={revision:"5",scheduling,inputSupply:binding,producers:[{pathId:"producer",candidateIds:["candidate"]}],scope:{runId:"root",owner:binding.owner},
      materialization:{intent,request},check:{intent:{...intent,id:"check"}}};
    const initial=ContextInputMaterializationWork.initialStage(path.id,request),entry=inputSupplyResponsibility("method_reception",path);
    const parts:SharedAcceptancePart[]=[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:{...scheduling,allowedPathIds:extra?[...scheduling.allowedPathIds,"foreign"]:scheduling.allowedPathIds},expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{...initial,input:{...initial.input as object,methodInputPlan:plan}}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:"materialize:consumer",runId:"root",owner:binding.owner,binding:{kind:"activity_path",id:path.id},
        sources:["producer",path.id].flatMap(id=>[`activity-source:control:${id}`,`activity-source:progress:${id}`])}}];
    const receipt=f.accept("receive",binding,[entry],parts);
    if(extra){
      expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_target_reception_unconfirmed"}});
      expect(f.a({kind:"read_path",pathId:path.id})).toBeNull();expect(f.a({kind:"read_stage",requestId:initial.id})).toBeNull();
      expect(f.a({kind:"read_schedule",workId:scheduling.workId})).toBeNull();
    } else expect(receipt.outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.query({kind:"head",needId:binding.needId})).toEqual(extra?null:expect.objectContaining({revision:1}));
    expect(restored.a({kind:"read_path",pathId:producer.intent.id})).toMatchObject({cancelled:false});
  });
  it("commits original binding, actual work and membership together, then resumes exact records",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    const receipt=f.accept("first",binding,[work.entry],work.parts);expect(receipt.outcome).toBe("accepted");
    expect(f.accept("first",binding,[work.entry],work.parts)).toEqual(receipt);
    f.db.close();const restored=open(f.directory);
    const head=restored.query({kind:"head",needId:binding.needId}) as InputSupplyHead;
    expect(head).toEqual({binding,revision:1,acceptanceId:"first",scheduling:null});
    expect(restored.query({kind:"page",needId:binding.needId,revision:1,afterId:null,limit:1})).toMatchObject({kind:"page",complete:true,next:null,
      entries:[{...work.entry,needId:binding.needId,acceptanceId:"first"}]});
  });
  it("rolls back a fictional target and a stale consumer together with new work",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("missing",binding,[work.entry]).outcome).toBe("rejected");
    expect(f.query({kind:"head",needId:binding.needId})).toBeNull();
    f.a({kind:"cancel",pathId:binding.consumerPathId,expectedControlRevision:0});
    expect(f.accept("cancelled",binding,[work.entry],work.parts)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_consumer_control_changed"}});
    expect(f.a({kind:"read_path",pathId:work.intent.id})).toBeNull();
    expect(f.db.contextFoundationFacts("root",0,128).contextFacts.filter(fact=>fact.owner==="context_input_supply")).toEqual([]);
  });
  it("refuses changed source, target and configuration identities",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("wrong-source",{...binding,source:{...binding.source,requestDigest:"not-original"}},[work.entry],work.parts).outcome).toBe("rejected");
    expect(f.accept("wrong-target",binding,[{...work.entry,target:{...work.entry.target,intentDigest:"different"}}],work.parts).outcome).toBe("rejected");
    expect(f.accept("correct",binding,[work.entry],work.parts).outcome).toBe("accepted");
    expect(f.accept("changed-settings",{...binding,configuration:{id:"replacement",revision:"1"}},[],[],1)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_binding_changed"}});
  });
  it("pages one accepted revision and reports changes instead of mixing membership",()=>{
    const f=open(),binding=f.need();
    const works=[f.work("A"),f.work("B"),f.work("C")];
    expect(f.accept("two",binding,works.slice(0,2).map(w=>w.entry),works.slice(0,2).flatMap(w=>w.parts)).outcome).toBe("accepted");
    const page=f.query({kind:"page",needId:binding.needId,revision:1,afterId:null,limit:1}) as Extract<InputSupplyResponsibilityPage,{kind:"page"}>;
    expect(page.complete).toBe(false);expect(page.next).toBe(page.entries[0]!.id);
    expect(f.accept("third",binding,[works[2]!.entry],works[2]!.parts,1).outcome).toBe("accepted");
    expect(f.query({kind:"page",needId:binding.needId,revision:1,afterId:page.next,limit:1})).toEqual({kind:"changed",revision:2});
    expect(f.query({kind:"page",needId:binding.needId,revision:2,afterId:null,limit:8})).toMatchObject({complete:true,entries:expect.any(Array)});
    expect(f.accept("stale",binding,[],[],1).outcome).toBe("rejected");
  });
  it("registers shared publication uses without acquiring cancellation authority",()=>{
    const f=open(),first=f.need("a"),second=f.need("c"),source=f.work("shared-source",true);
    f.a({kind:"open_path",intent:source.intent});f.a({kind:"submit",request:source.request});
    expect(f.accept("first-use",first,[source.entry]).outcome).toBe("accepted");expect(f.accept("second-use",second,[source.entry]).outcome).toBe("accepted");
    const page=f.query({kind:"users",target:source.entry.target,frontier:null,afterSequence:0,limit:1}) as InputSupplyUsersPage;
    expect(page.complete).toBe(false);expect(page.entries[0]!.binding.needId).toBe(first.needId);
    const later=f.need("b");expect(f.accept("later-use",later,[source.entry]).outcome).toBe("accepted");
    const rest=f.query({kind:"users",target:source.entry.target,frontier:page.frontier,afterSequence:page.next!,limit:8}) as InputSupplyUsersPage;
    expect(rest.entries.map(e=>e.binding.needId)).toEqual([second.needId]);expect(rest.complete).toBe(true);
    expect(f.db.acceptShared(f.db.generation,{id:"cannot-cancel-source",scope:"root",actor:first.owner,parts:[{owner:"activity",kind:"path_cancellation",
      proposal:{kind:"cancel",pathId:source.intent.id,expectedControlRevision:0}}]}).acceptanceValue.outcome).toBe("rejected");
    expect(f.a({kind:"read_path",pathId:source.intent.id})).toMatchObject({cancelled:false});
  });
  it("does not change membership or its revision when an existing reference is registered again",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("first",binding,[work.entry],work.parts).outcome).toBe("accepted");
    expect(f.accept("another-reconsideration",binding,[work.entry],[],1).outcome).toBe("accepted");
    expect(f.query({kind:"head",needId:binding.needId})).toMatchObject({revision:1,acceptanceId:"first"});
    const facts=f.db.contextFoundationFacts("root",0,128).contextFacts;
    expect(facts.filter(fact=>fact.kind==="responsibility_registered")).toHaveLength(1);
  });
  it("does not give a second need ownership of an already owned preparation",()=>{
    const f=open(),one=f.need("one"),two=f.need("two"),work=f.work("owned-preparation");
    expect(f.accept("own-one",one,[work.entry],work.parts).outcome).toBe("accepted");
    expect(f.accept("own-two",two,[work.entry])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_target_already_owned"}});
    expect(f.query({kind:"head",needId:two.needId})).toBeNull();
    const facts=f.a({kind:"facts",runId:"root",after:0,limit:128}) as ReadonlyArray<{kind:string;details:unknown}>;
    expect(facts.filter(fact=>fact.kind==="fact_published"&&JSON.stringify(fact.details).includes("input-supply:"))).toHaveLength(1);
  });
  it("allows closure and restatement of an accepted responsibility in one transaction",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("first",binding,[work.entry],work.parts).outcome).toBe("accepted");
    const close:SharedAcceptancePart={owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:work.intent.id,expectedControlRevision:0}};
    expect(f.accept("adopt-and-close",binding,[work.entry],[close],1).outcome).toBe("accepted");
    expect(f.a({kind:"read_path",pathId:work.intent.id})).toMatchObject({cancelled:true});
    expect(f.query({kind:"head",needId:binding.needId})).toMatchObject({revision:1,acceptanceId:"first"});
    const another=f.need("later");
    expect(f.accept("new-use-of-closed-path",another,[{...work.entry,role:"method_production",relation:"dependency"}]).outcome).toBe("rejected");
  });
  it("uses a bounded target/sequence range instead of scanning later registrations",()=>{
    const f=open(),binding=f.need(),source=f.work("source",true);
    f.a({kind:"open_path",intent:source.intent});f.a({kind:"submit",request:source.request});
    expect(f.accept("first",binding,[source.entry]).outcome).toBe("accepted");
    const sql=new Database(join(f.directory,"execution.sqlite"),{readonly:true});
    try {
      const plan=sql.prepare("EXPLAIN QUERY PLAN SELECT sequence,need_id,id,value,digest FROM context_input_supply_responsibilities WHERE path_id=? AND intent_digest=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
        .all(source.intent.id,source.entry.target.intentDigest,0,1,9) as {detail:string}[];
      expect(plan).toHaveLength(1);expect(plan[0]!.detail).toContain("USING INDEX context_input_supply_users");
      expect(plan[0]!.detail).toContain("sequence>? AND sequence<?");
    }finally{sql.close();}
  });
});

describe("durable original input supply exit",()=>{
  type Fixture=ReturnType<typeof open>;
  function accept(f:Fixture,binding:InputSupplyBinding,id:string,parts:readonly SharedAcceptancePart[]) {
    return f.db.acceptShared(f.db.generation,{id,scope:binding.runId,actor:binding.owner,parts}).acceptanceValue;
  }
  function begin(binding:InputSupplyBinding,basis:InputSupplyExitBasis,membershipRevision=0):SharedAcceptancePart {
    const {configuration:_,...origin}=binding;
    return inputSupplyExit({kind:"begin",origin,subscriptionId:`${binding.needId}:supply`,expectedMembershipRevision:membershipRevision,
      expectedConsumerControlRevision:basis.kind==="cancelled"?basis.controlRevision:0,basis});
  }
  function state(f:Fixture,binding:InputSupplyBinding):InputSupplyExit|null {
    return f.query({kind:"exit",needId:binding.needId}) as InputSupplyExit|null;
  }
  function pending(f:Fixture,binding:InputSupplyBinding,revision:number,limit=1) {
    return f.query({kind:"exit_pending",needId:binding.needId,revision,limit}) as InputSupplyExitPending;
  }
  function cancelNeed(f:Fixture,binding:InputSupplyBinding):InputSupplyExitBasis {
    f.a({kind:"cancel",pathId:binding.consumerPathId,expectedControlRevision:0});
    return {kind:"cancelled",controlRevision:1};
  }
  function returned(f:Fixture,binding:InputSupplyBinding,kind:"supplied"|"unavailable"="unavailable"):Extract<InputSupplyExitBasis,{kind:"returned"}> {
    const need=f.a({kind:"read_input_need",id:binding.needId}) as ActivityInputNeed;
    const request={...(kind==="supplied"?need.stage:need.unavailableStage),input:{kind:kind==="supplied"?"original_input":"context_input_unavailable",
      needId:need.id,supplier:need.supplier,boundary:"original",reason:"fixture",evidence:[]}};
    expect(accept(f,binding,`return:${need.id}`,[{owner:"activity",kind:"stage_submission",proposal:request}]).outcome).toBe("accepted");
    return {kind:"returned",stageId:request.id,requestDigest:digest(request)};
  }
  function closeSubscription(f:Fixture,binding:InputSupplyBinding,id:string,subscriptionId=`${binding.needId}:supply`):SharedAcceptancePart {
    const snapshot=f.a({kind:"read_reconsideration",subscriptionId,limit:256}) as ActivityReconsiderationSnapshot;
    return {owner:"activity",kind:"reconsideration_acceptance",proposal:{id,subscriptionId,expectedRevision:snapshot.state.revision,
      through:snapshot.through,factIds:snapshot.facts.map(f=>f.id),decision:{owner:binding.owner,kind:"input_supply_exit",id:binding.needId,revision:"1"},close:true}};
  }
  function scheduling(f:Fixture,binding:InputSupplyBinding,workId=`${binding.needId}:supply`):ActivitySchedulingIntent {
    f.a({kind:"bind_resource_pool",pool:{id:"exit-local",revision:"1",authority:"host",capacity:2}});
    return {id:`${workId}:schedule`,workId,runId:binding.runId,owner:binding.owner,scopeId:"tree",decisionId:binding.needId,policyRevision:"1",
      reason:"necessary",delayImpact:"Original input supply",timing:{kind:"unknown"},resources:[{poolId:"exit-local",capability:"material-write",units:1}],
      delegatedPathOwners:["material-source"]};
  }
  function schedulePart(intent:ActivitySchedulingIntent):SharedAcceptancePart {
    return {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent,expectedRevision:0}};
  }
  function seal(intent:ActivitySchedulingIntent):SharedAcceptancePart {
    return {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:intent.workId,expectedRevision:1,basis:"original need exit"}};
  }
  function closeWork(intent:ActivitySchedulingIntent,strict=true):SharedAcceptancePart {
    return {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:intent.workId,expectedRevision:2,
      basis:"original need settled",requireSettled:strict}};
  }
  function withLateMutation(f:Fixture,binding:InputSupplyBinding,id:string,parts:readonly SharedAcceptancePart[],mutate:(sql:Database.Database)=>void) {
    const internal=f.db as unknown as {data:Database.Database;activityHandoffs:ActivityHandoffDatabase;inputSupplies:InputSupplyResponsibilityDatabase};
    const shared=new SharedAcceptanceDatabase(internal.data,[internal.activityHandoffs.acceptanceParticipant(),internal.inputSupplies.participant(),
      {owner:"fixture",kinds:["late_change"],prepare:()=>null,apply:()=>mutate(internal.data)}]);
    return shared.accept({id,scope:binding.runId,actor:binding.owner,parts:[...parts,{owner:"fixture",kind:"late_change",proposal:null}]});
  }
  function methodWork(f:Fixture,id:string,workId?:string) {
    const base=f.work(id,false,workId),purpose=new ActivityPurposeRegistry<null>().register(REPRESENTATION_METHOD_PURPOSE,null);
    const intent={...base.intent,purpose},request={...base.request,stageKind:"read"};
    const parts:SharedAcceptancePart[]=[{owner:"activity",kind:"path_opening",proposal:intent},{owner:"activity",kind:"stage_submission",proposal:request}];
    return {intent,request,parts,entry:inputSupplyResponsibility("method_production",intent)};
  }
  function readyProducer(f:Fixture,binding:InputSupplyBinding,id="independent-producer") {
    const schedule={...scheduling(f,binding,`${id}:work`),allowedPathIds:[id]},work=methodWork(f,id,schedule.workId);
    f.a({kind:"schedule_work",intent:schedule,expectedRevision:0});
    f.a({kind:"open_path",intent:work.intent});f.a({kind:"submit",request:work.request});
    const executor={hostSession:"test",worker:"producer",generation:f.db.generation},attemptId=`${id}:attempt`,rawId=`${id}:raw`;
    f.a({kind:"admit",requestId:work.request.id,expectedControlRevision:0});
    f.a({kind:"dispatch",attempt:{id:attemptId,requestId:work.request.id,executor,inputDigest:digest(work.request.input),startedAt:new Date().toISOString()},expectedControlRevision:0});
    f.a({kind:"save_raw",result:{id:rawId,attemptId,completeness:"complete",outcome:"returned",value:{candidate:"retained-result"},usage:{},recordedAt:new Date().toISOString()}});
    f.a({kind:"claim_processing",claim:{id:`${id}:claim`,requestId:work.request.id,executor,previousClaimId:null},expectedControlRevision:0});
    f.a({kind:"accept",executor,expectedControlRevision:0,receipt:{id:`${id}:ready`,requestId:work.request.id,resultId:rawId,
      owner:work.intent.owner,expectedProgressRevision:0,progress:{method:{state:"ready",resultIds:["retained-result"]}},next:[]}});
    const guard:SharedAcceptancePart={owner:"context_input_supply",kind:"producer_unreferenced",proposal:{workId:schedule.workId}};
    const accept=(id:string,parts:readonly SharedAcceptancePart[])=>f.db.acceptShared(f.db.generation,
      {id,scope:work.intent.runId,actor:work.intent.owner,parts}).acceptanceValue;
    return {...work,schedule,guard,accept};
  }
  function receiver(f:Fixture,binding:InputSupplyBinding,id:string,producerPathId:string,workId?:string) {
    const registry=new ActivityPurposeRegistry<null>(),purpose=registry.register(CONTEXT_INPUT_MATERIALIZATION_PURPOSE,null);
    const path={...f.work(id,false,workId).intent,purpose}, {purpose:_,owner:__,...intent}=path;
    const preparationIntent={...intent,id:`${id}:organize`,resourceScope:`${id}:organize`},checkIntent={...intent,id:`${id}:check`,resourceScope:`${id}:check`};
    // As in the existing receiver fixture, only the original durable ownership binding is exercised.
    const request={kind:"context_input_materialization",demand:{contributions:[]},preparationIntent} as unknown as import("@agent-anything/agent-runtime/context-representation").ContextInputMaterializationRequest;
    const plan={revision:"5",scheduling:null,inputSupply:binding,producers:[{pathId:producerPathId,candidateIds:["candidate"]}],scope:{runId:binding.runId,owner:binding.owner},
      materialization:{intent,request},check:{intent:checkIntent}};
    const initial=ContextInputMaterializationWork.initialStage(id,request);
    const paths=[path,{...preparationIntent,owner:binding.owner,purpose:registry.register(CONTEXT_INPUT_PREPARATION_PURPOSE,null)},
      {...checkIntent,owner:binding.owner,purpose:registry.register(REPRESENTATION_METHOD_PURPOSE,null)}];
    const parts:SharedAcceptancePart[]=[{owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{...initial,input:{...initial.input as object,methodInputPlan:plan}}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${id}:consumer`,runId:binding.runId,owner:binding.owner,
        binding:{kind:"activity_path",id},sources:[producerPathId,id].flatMap(pathId=>[`activity-source:control:${pathId}`,`activity-source:progress:${pathId}`])}}];
    return {paths,parts,entry:inputSupplyResponsibility("method_reception",path)};
  }

  it("producer unreferenced guard waits for completed need exit, not merely dependency withdrawal",()=>{
    const f=open(),binding=f.need(),producer=readyProducer(f,binding);
    expect(f.accept("register-producer-use",binding,[producer.entry]).outcome).toBe("accepted");
    expect(f.query({kind:"head",needId:binding.needId})).toMatchObject({scheduling:null});
    const closure=[producer.guard,seal(producer.schedule),closeWork(producer.schedule)];
    expect(producer.accept("active-consumer",closure)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_producer_in_use"}});
    expect(accept(f,binding,"begin-consumer-exit",[begin(binding,cancelNeed(f,binding),1)]).outcome).toBe("accepted");
    expect(accept(f,binding,"withdraw-producer-use",[inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,
      dispositions:[{responsibilityId:producer.entry.id,kind:"dependency_withdrawn"}]})]).outcome).toBe("accepted");
    expect(producer.accept("consumer-still-closing",closure)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_producer_in_use"}});
    expect(f.a({kind:"read_schedule",workId:producer.schedule.workId})).toMatchObject({revision:1,closed:false,pathsSealed:false});
    expect(accept(f,binding,"complete-consumer-exit",[inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:2}),
      closeSubscription(f,binding,"complete-consumer-exit")]).outcome).toBe("accepted");
    const closed=producer.accept("producer-close",closure);expect(closed.outcome).toBe("accepted");
    expect(f.a({kind:"read_schedule",workId:producer.schedule.workId})).toMatchObject({closed:true,pathsSealed:true,settlementConfirmed:true});
    expect(f.a({kind:"read_path",pathId:producer.intent.id})).toMatchObject({cancelled:false,progress:{method:{state:"ready",resultIds:["retained-result"]}}});
    expect(f.a({kind:"read_stage",requestId:producer.request.id})).toMatchObject({status:"accepted",result:{value:{candidate:"retained-result"}}});
    f.db.close();const restored=open(f.directory);
    expect(restored.db.acceptShared(restored.db.generation,{id:"producer-close",scope:binding.runId,actor:producer.intent.owner,parts:closure}).acceptanceValue).toEqual(closed);
    expect(restored.a({kind:"read_path",pathId:producer.intent.id})).toMatchObject({cancelled:false});
  });

  it.each([false,true])("producer unreferenced guard atomically rejects same-acceptance registration (guard first=%s)",guardFirst=>{
    const f=open(),binding=f.need(),producer=readyProducer(f,binding);
    const registration=inputSupplyRegistration({binding,expectedRevision:0,expectedConsumerControlRevision:0,responsibilities:[producer.entry]});
    const closure=[producer.guard,seal(producer.schedule),closeWork(producer.schedule)];
    const result=producer.accept("registration-vs-closure",guardFirst?[...closure,registration]:[registration,...closure]);
    expect(result).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_producer_in_use"}});
    expect(f.query({kind:"head",needId:binding.needId})).toBeNull();
    expect(f.query({kind:"work_users",workId:producer.schedule.workId,frontier:null,afterSequence:0,limit:1}))
      .toMatchObject({entries:[],complete:true});
    expect(f.a({kind:"read_schedule",workId:producer.schedule.workId})).toMatchObject({revision:1,closed:false,pathsSealed:false,settlementConfirmed:false});
    expect(f.a({kind:"read_path",pathId:producer.intent.id})).toMatchObject({cancelled:false,progress:{method:{state:"ready"}}});
    expect(f.db.contextFoundationFacts(binding.runId,0,128).contextFacts).toEqual([]);
  });

  it("producer unreferenced guard is scoped to the exact original work, not all work in the Run",()=>{
    const f=open(),binding=f.need(),one=readyProducer(f,binding,"unused-producer"),two=readyProducer(f,binding,"referenced-producer");
    expect(f.accept("other-producer-use",binding,[two.entry]).outcome).toBe("accepted");
    expect(one.accept("close-unused-producer",[one.guard,seal(one.schedule),closeWork(one.schedule)]).outcome).toBe("accepted");
    expect(two.accept("cannot-close-used-producer",[two.guard,seal(two.schedule),closeWork(two.schedule)]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_producer_in_use"}});
    expect(f.a({kind:"read_schedule",workId:two.schedule.workId})).toMatchObject({closed:false,pathsSealed:false});
    expect(f.a({kind:"read_path",pathId:two.intent.id})).toMatchObject({cancelled:false});
  });

  it.each(["scope","actor"] as const)("producer unreferenced guard rejects foreign %s ownership",field=>{
    const f=open(),binding=f.need(),producer=readyProducer(f,binding);
    const proposal={id:"foreign-producer-close",scope:binding.runId,actor:producer.intent.owner,parts:[producer.guard,seal(producer.schedule)],
      [field]:"foreign"};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue)
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_producer_owner_mismatch"}});
    expect(f.a({kind:"read_schedule",workId:producer.schedule.workId})).toMatchObject({revision:1,closed:false,pathsSealed:false});
  });

  it("exits a cancelled need without fabricating registration and replays after reopen",()=>{
    const f=open(),binding=f.need(),part=begin(binding,cancelNeed(f,binding));
    const started=accept(f,binding,"begin-empty",[part]);expect(started.outcome).toBe("accepted");
    expect(f.query({kind:"head",needId:binding.needId})).toBeNull();
    expect(state(f,binding)).toMatchObject({membershipRevision:0,scheduling:null,status:"closing",revision:1,acceptanceId:"begin-empty"});
    expect(pending(f,binding,1)).toMatchObject({kind:"exit_pending",entries:[],more:false});
    f.db.close();const restored=open(f.directory);
    expect(accept(restored,binding,"begin-empty",[part])).toEqual(started);
    const completion=[inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1}),closeSubscription(restored,binding,"complete-empty")];
    const completed=accept(restored,binding,"complete-empty",completion);expect(completed.outcome).toBe("accepted");
    restored.db.close();const again=open(f.directory);
    expect(accept(again,binding,"complete-empty",completion)).toEqual(completed);
    expect(state(again,binding)).toMatchObject({status:"closed",revision:2,acceptanceId:"complete-empty"});
    expect(again.query({kind:"head",needId:binding.needId})).toBeNull();
    const facts=again.db.contextFoundationFacts("root",0,128).contextFacts;
    expect(facts.filter(f=>f.kind==="exit_started")).toHaveLength(1);expect(facts.filter(f=>f.kind==="exit_completed")).toHaveLength(1);
  });

  it.each(["supplied","unavailable"] as const)("binds exit to the exact original %s return, not another stage or digest",kind=>{
    const f=open(),binding=f.need(),other=f.need("other");
    const absent:InputSupplyExitBasis={kind:"returned",stageId:`${binding.consumerPathId}:unavailable`,requestDigest:"missing"};
    expect(accept(f,binding,"missing-return",[begin(binding,absent)])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_return_unconfirmed"}});
    const foreign=returned(f,other,kind),basis=returned(f,binding,kind);
    expect(accept(f,binding,"foreign-return",[begin(binding,foreign)]).outcome).toBe("rejected");
    expect(accept(f,binding,"changed-return",[begin(binding,{...basis,requestDigest:"not-the-request"})]).outcome).toBe("rejected");
    expect(state(f,binding)).toBeNull();
    expect(accept(f,binding,"original-return",[begin(binding,basis)]).outcome).toBe("accepted");
    expect(state(f,binding)?.basis).toEqual(basis);
  });

  it("rejects invented cancellation and changed original source without leaving an exit",()=>{
    const f=open(),binding=f.need();
    expect(accept(f,binding,"not-cancelled",[begin(binding,{kind:"cancelled",controlRevision:0})]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_cancellation_unconfirmed"}});
    const basis=cancelNeed(f,binding);
    expect(accept(f,binding,"wrong-source",[begin({...binding,source:{...binding.source,requestDigest:"changed"}},basis)]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_original_need_unconfirmed"}});
    expect(state(f,binding)).toBeNull();
  });

  it.each([false,true])("requires a jointly sealed original schedule (seal first=%s)",sealFirst=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding);
    expect(f.accept("register-schedule",binding,[],[schedulePart(schedule)],0,schedule).outcome).toBe("accepted");
    const part=begin(binding,cancelNeed(f,binding),1);
    expect(accept(f,binding,"unsealed",[part])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_schedule_not_sealed"}});
    expect(state(f,binding)).toBeNull();expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({pathsSealed:false,closed:false,revision:1});
    expect(accept(f,binding,"sealed",sealFirst?[seal(schedule),part]:[part,seal(schedule)]).outcome).toBe("accepted");
    expect(state(f,binding)).toMatchObject({membershipRevision:1,scheduling:schedule});
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({pathsSealed:true,closed:false,revision:2});
  });

  it("jointly verifies the claimed schedule and preserves its unique original owner",()=>{
    const f=open(),one=f.need("one"),two=f.need("two"),schedule=scheduling(f,one);
    expect(f.accept("missing-schedule",one,[],[],0,schedule)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_schedule_unconfirmed"}});
    expect(f.query({kind:"head",needId:one.needId})).toBeNull();
    expect(f.accept("actual-schedule",one,[],[schedulePart(schedule)],0,schedule).outcome).toBe("accepted");
    expect(f.accept("duplicate-owner",two,[],[],0,schedule)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_schedule_already_owned"}});
    expect(f.query({kind:"head",needId:two.needId})).toBeNull();
    expect(f.accept("changed-binding",one,[],[],1,{...schedule,workId:"other"})).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_scheduling_changed"}});
    const treatment={...schedule,id:"higher-priority",decisionId:"new-treatment",timing:{kind:"review_at" as const,at:"2098-01-01T00:00:00Z",basis:"Original work remains owned"}};
    f.a({kind:"schedule_work",intent:treatment,expectedRevision:1});
    expect(f.accept("restate-original",one,[],[],1,schedule).outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.query({kind:"head",needId:one.needId})).toMatchObject({scheduling:schedule,revision:1});
    expect(restored.accept("still-not-owner",two,[],[],0,schedule).outcome).toBe("rejected");
  });

  it("freezes the final jointly registered membership and rejects later admissions atomically",()=>{
    const f=open(),binding=f.need(),first=f.work("first"),last=f.work("last");
    expect(f.accept("initial",binding,[first.entry],first.parts).outcome).toBe("accepted");
    const basis=returned(f,binding);
    expect(f.accept("last-and-begin",binding,[last.entry],[...last.parts,begin(binding,basis,2)],1).outcome).toBe("accepted");
    expect(state(f,binding)).toMatchObject({membershipRevision:2});
    expect(pending(f,binding,1,8)).toMatchObject({entries:expect.arrayContaining([expect.objectContaining(first.entry),expect.objectContaining(last.entry)]),more:false});
    const late=f.work("too-late");
    expect(f.accept("late-admission",binding,[late.entry],late.parts,2)).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_started"}});
    expect(f.a({kind:"read_path",pathId:late.intent.id})).toBeNull();
    expect(f.query({kind:"head",needId:binding.needId})).toMatchObject({revision:2});
  });

  it("withdraws only this need's shared source dependency and durably pages remaining duties",()=>{
    const f=open(),one=f.need("one"),two=f.need("two"),sources=[f.work("shared-a",true),f.work("shared-b",true)];
    for(const source of sources){f.a({kind:"open_path",intent:source.intent});f.a({kind:"submit",request:source.request});}
    expect(f.accept("use-one",one,sources.map(s=>s.entry)).outcome).toBe("accepted");
    expect(f.accept("use-two",two,[sources[0]!.entry]).outcome).toBe("accepted");
    expect(accept(f,one,"begin",[begin(one,cancelNeed(f,one),1)]).outcome).toBe("accepted");
    const page=pending(f,one,1);if(page.kind!=="exit_pending")throw new Error("Missing frozen exit page");
    expect(page.more).toBe(true);expect(page.entries).toHaveLength(1);
    const part=inputSupplyExit({kind:"dispose",needId:one.needId,expectedRevision:1,dispositions:[{responsibilityId:page.entries[0]!.id,kind:"dependency_withdrawn"}]});
    const withdrawn=accept(f,one,"withdraw-one",[part]);expect(withdrawn.outcome).toBe("accepted");
    expect(pending(f,one,1)).toEqual({kind:"changed",revision:2});
    expect(accept(f,one,"too-early",[inputSupplyExit({kind:"complete",needId:one.needId,expectedRevision:2}),closeSubscription(f,one,"too-early")]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_responsibilities_unsettled"}});
    f.db.close();const restored=open(f.directory);
    expect(accept(restored,one,"withdraw-one",[part])).toEqual(withdrawn);
    const rest=pending(restored,one,2);if(rest.kind!=="exit_pending")throw new Error("Missing remaining exit page");
    expect(rest.more).toBe(false);expect(rest.entries).toHaveLength(1);expect(rest.entries[0]!.id).not.toBe(page.entries[0]!.id);
    expect(accept(restored,one,"withdraw-rest",[inputSupplyExit({kind:"dispose",needId:one.needId,expectedRevision:2,
      dispositions:[{responsibilityId:rest.entries[0]!.id,kind:"dependency_withdrawn"}]})]).outcome).toBe("accepted");
    for(const source of sources)expect(restored.a({kind:"read_path",pathId:source.intent.id})).toMatchObject({cancelled:false,controlRevision:0});
    expect(restored.query({kind:"users",target:sources[0]!.entry.target,frontier:null,afterSequence:0,limit:8})).toMatchObject({entries:expect.arrayContaining([
      expect.objectContaining({binding:one}),expect.objectContaining({binding:two})])});
    expect(restored.query({kind:"exit",needId:two.needId})).toBeNull();
    expect(accept(restored,one,"finish",[inputSupplyExit({kind:"complete",needId:one.needId,expectedRevision:3}),closeSubscription(restored,one,"finish")]).outcome).toBe("accepted");
  });

  it.each(["partial","unknown","complete"] as const)("does not dispose cancelled owned preparation before its original %s result settles",mode=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("register",binding,[work.entry],work.parts).outcome).toBe("accepted");
    const executor={hostSession:"test",worker:"test",generation:f.db.generation},attemptId="prepare-attempt";
    f.a({kind:"admit",requestId:work.request.id,expectedControlRevision:0});
    f.a({kind:"dispatch",attempt:{id:attemptId,requestId:work.request.id,executor,inputDigest:digest(work.request.input),startedAt:new Date().toISOString()},expectedControlRevision:0});
    const raw={id:`prepare-${mode}`,attemptId,completeness:mode==="partial"?"partial" as const:"complete" as const,
      outcome:mode==="unknown"?"unknown" as const:"returned" as const,value:{original:mode},usage:{},recordedAt:new Date().toISOString()};
    f.a({kind:"save_raw",result:raw});
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1)]).outcome).toBe("accepted");
    const disposition=inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,dispositions:[{responsibilityId:work.entry.id,kind:"owned_settled"}]});
    expect(accept(f,binding,"still-active",[disposition])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_owned_exit_unconfirmed"}});
    f.a({kind:"cancel",pathId:work.intent.id,expectedControlRevision:0});
    expect(accept(f,binding,"not-settled",[disposition])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_owned_work_unsettled"}});
    expect(state(f,binding)).toMatchObject({revision:1});expect(pending(f,binding,1)).toMatchObject({entries:[expect.objectContaining(work.entry)]});
    const complete=mode==="complete"?raw:{...raw,id:"prepare-known",completeness:"complete" as const,outcome:"returned" as const};
    if(mode!=="complete")f.a({kind:"save_raw",result:complete});
    expect(accept(f,binding,"raw-not-settlement",[disposition]).outcome).toBe("rejected");
    f.a({kind:"settle",executor,expectedControlRevision:1,receipt:{id:"prepare-settled",requestId:work.request.id,resultId:complete.id,
      owner:binding.owner,disposition:{kind:"retained_input_preparation_result",resultId:complete.id,adopted:false}}});
    expect(accept(f,binding,"disposed",[disposition]).outcome).toBe("accepted");
    expect(f.a({kind:"read_stage",requestId:work.request.id})).toMatchObject({status:"settled",result:complete,receipt:null,rawEvidenceRevision:mode==="complete"?1:2});
    expect(pending(f,binding,2)).toMatchObject({entries:[],more:false});
  });

  it("does not use dependency withdrawal to dispose an owned preparation",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("register",binding,[work.entry],work.parts).outcome).toBe("accepted");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1)]).outcome).toBe("accepted");
    expect(accept(f,binding,"wrong-role",[inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,
      dispositions:[{responsibilityId:work.entry.id,kind:"dependency_withdrawn"}]})])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_disposition_role_invalid"}});
    expect(f.a({kind:"read_path",pathId:work.intent.id})).toMatchObject({cancelled:false});expect(state(f,binding)?.revision).toBe(1);
  });

  it("requires the original subscription to close jointly, not another need's subscription",()=>{
    const f=open(),binding=f.need(),other=f.need("other");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding))]).outcome).toBe("accepted");
    const complete=inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1});
    expect(accept(f,binding,"without-close",[complete])).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_subscription_closure_not_joint"}});
    expect(accept(f,binding,"wrong-subscription",[complete,closeSubscription(f,binding,"wrong-subscription",`${other.needId}:supply`)]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_subscription_closure_not_joint"}});
    expect(state(f,binding)).toMatchObject({status:"closing",revision:1});
    for(const b of [binding,other])expect(f.a({kind:"read_reconsideration",subscriptionId:`${b.needId}:supply`,limit:1})).toMatchObject({state:{closed:false}});
    expect(accept(f,binding,"closed",[complete,closeSubscription(f,binding,"closed")]).outcome).toBe("accepted");
  });

  it("requires strict original work closure and rolls back ordinary service close",()=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding);
    expect(f.accept("register",binding,[],[schedulePart(schedule)],0,schedule).outcome).toBe("accepted");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1),seal(schedule)]).outcome).toBe("accepted");
    const complete=inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1});
    expect(accept(f,binding,"ordinary-close",[complete,closeWork(schedule,false),closeSubscription(f,binding,"ordinary-close")]))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_schedule_not_settled"}});
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({closed:false,settlementConfirmed:false,revision:2});
    expect(state(f,binding)?.revision).toBe(1);
    expect(accept(f,binding,"strict-close",[complete,closeWork(schedule),closeSubscription(f,binding,"strict-close")]).outcome).toBe("accepted");
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({closed:true,settlementConfirmed:true});
    expect(state(f,binding)?.status).toBe("closed");
  });

  it("keeps mixed source service open after withdrawal until its professional owner settles it",()=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding),source=f.work("source",true,schedule.workId);
    expect(f.accept("register",binding,[source.entry],[schedulePart(schedule),...source.parts],0,schedule).outcome).toBe("accepted");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1),seal(schedule)]).outcome).toBe("accepted");
    expect(accept(f,binding,"withdraw",[inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,
      dispositions:[{responsibilityId:source.entry.id,kind:"dependency_withdrawn"}]})]).outcome).toBe("accepted");
    const complete=inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:2});
    expect(accept(f,binding,"source-pending",[complete,closeWork(schedule),closeSubscription(f,binding,"source-pending")]))
      .toMatchObject({outcome:"rejected",rejection:{code:"activity_schedule_responsibility_unsettled"}});
    expect(f.a({kind:"read_path",pathId:source.intent.id})).toMatchObject({cancelled:false});
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({pathsSealed:true,closed:false});
    const original=f.a({kind:"read_stage",requestId:source.request.id}) as ActivityStageState;
    const refusal={kind:"denied" as const,code:"source-denied",message:"Original source authority refused",decision:{owner:"permission",id:"denial",revision:"1"}};
    const restricted=f.a({kind:"record_authorization_restriction",requestId:source.request.id,expectedControlRevision:0,
      expectedStageEvidence:activityStageEvidence(original),action:"admission",refusal}) as ActivityStageState;
    f.a({kind:"stop_professional_path",receipt:{id:"source-stop",requestId:source.request.id,owner:source.intent.owner,
      expectedControlRevision:0,expectedProgressRevision:0,expectedStageEvidence:activityStageEvidence(restricted),
      limitation:{kind:"authorization",action:"admission",refusal},progress:{unavailable:true}}});
    expect(accept(f,binding,"source-settled",[complete,closeWork(schedule),closeSubscription(f,binding,"source-settled")]).outcome).toBe("accepted");
    expect(f.a({kind:"read_stage",requestId:source.request.id})).toMatchObject({status:"stopped",attempt:null,result:null,stop:{id:"source-stop"}});
  });

  it("rejects an unregistered original-scope path even when the whole work has no pending execution",()=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding),unregistered=f.work("unregistered",false,schedule.workId);
    expect(f.accept("register-work",binding,[],[schedulePart(schedule)],0,schedule).outcome).toBe("accepted");
    f.a({kind:"open_path",intent:unregistered.intent});
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1),seal(schedule)]).outcome).toBe("accepted");
    expect(f.a({kind:"scheduled_settlement",workId:schedule.workId})).toMatchObject({remaining:null});
    expect(pending(f,binding,1,16)).toMatchObject({entries:[],more:false,uncoveredPathId:unregistered.intent.id});
    const completion=[closeWork(schedule),inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1}),closeSubscription(f,binding,"missing-coverage")];
    const rejected=accept(f,binding,"missing-coverage",completion);
    expect(rejected).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_schedule_responsibility_missing"}});
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({pathsSealed:true,closed:false,settlementConfirmed:false,revision:2});
    expect(f.a({kind:"read_reconsideration",subscriptionId:`${binding.needId}:supply`,limit:1})).toMatchObject({state:{closed:false,revision:0}});
    expect(state(f,binding)).toMatchObject({status:"closing",revision:1});
    f.db.close();const restored=open(f.directory);
    expect(accept(restored,binding,"missing-coverage",completion)).toEqual(rejected);
    expect(pending(restored,binding,1,16)).toMatchObject({entries:[],uncoveredPathId:unregistered.intent.id});
  });

  it("retains coverage for every original role including all three frozen receiver paths",()=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding),source=f.work("source",true,schedule.workId),
      method=methodWork(f,"method",schedule.workId),preparation=f.work("prepare",false,schedule.workId),
      reception=receiver(f,binding,"receive",method.intent.id,schedule.workId);
    const entries=[source.entry,method.entry,preparation.entry,reception.entry];
    expect(f.accept("register-all",binding,entries,[schedulePart(schedule),...source.parts,...method.parts,...preparation.parts,...reception.parts,
      ...reception.paths.slice(1).map(proposal=>({owner:"activity",kind:"path_opening",proposal}))],0,schedule).outcome).toBe("accepted");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1),seal(schedule)]).outcome).toBe("accepted");
    expect(pending(f,binding,1,16)).toMatchObject({entries:expect.arrayContaining(entries.map(entry=>expect.objectContaining(entry))),uncoveredPathId:null});
    for(const work of [source,method]) {
      const original=f.a({kind:"read_stage",requestId:work.request.id}) as ActivityStageState;
      const refusal={kind:"denied" as const,code:"original-owner-stop",message:"Original owner declined further execution",
        decision:{owner:"permission",id:`${work.intent.id}:denial`,revision:"1"}};
      const restricted=f.a({kind:"record_authorization_restriction",requestId:work.request.id,expectedControlRevision:0,
        expectedStageEvidence:activityStageEvidence(original),action:"admission",refusal}) as ActivityStageState;
      f.a({kind:"stop_professional_path",receipt:{id:`${work.intent.id}:stop`,requestId:work.request.id,owner:work.intent.owner,
        expectedControlRevision:0,expectedProgressRevision:0,expectedStageEvidence:activityStageEvidence(restricted),
        limitation:{kind:"authorization",action:"admission",refusal},progress:{unavailable:true}}});
    }
    for(const path of [preparation.intent,...reception.paths])f.a({kind:"cancel",pathId:path.id,expectedControlRevision:0});
    const part=inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,dispositions:[
      {responsibilityId:source.entry.id,kind:"dependency_withdrawn"},{responsibilityId:method.entry.id,kind:"dependency_withdrawn"},
      {responsibilityId:preparation.entry.id,kind:"owned_settled"},{responsibilityId:reception.entry.id,kind:"reception_transferred"}]});
    const disposed=accept(f,binding,"dispose-all",[part]);expect(disposed.outcome).toBe("accepted");
    expect(pending(f,binding,2,16)).toMatchObject({entries:[],more:false,uncoveredPathId:null});
    f.db.close();const restored=open(f.directory);
    expect(accept(restored,binding,"dispose-all",[part])).toEqual(disposed);
    const sql=new Database(join(restored.directory,"execution.sqlite"),{readonly:true});
    try {
      const expected=new Map([[source.entry.id,[source.intent.id]],[method.entry.id,[method.intent.id]],
        [preparation.entry.id,[preparation.intent.id]],[reception.entry.id,reception.paths.map(path=>path.id)]]);
      for(const [id,paths] of expected) {
        const row=sql.prepare("SELECT value FROM context_input_supply_dispositions WHERE need_id=? AND id=?").get(binding.needId,id) as {value:string};
        const recorded=JSON.parse(row.value) as {coveredPathIds:readonly string[]};
        expect([...recorded.coveredPathIds].sort()).toEqual([...paths].sort());
      }
    }finally{sql.close();}
    expect(pending(restored,binding,2,16)).toMatchObject({entries:[],more:false,uncoveredPathId:null});
    expect(restored.a({kind:"scheduled_settlement",workId:schedule.workId})).toMatchObject({remaining:null});
    expect(accept(restored,binding,"complete-covered",[closeWork(schedule),inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:2}),
      closeSubscription(restored,binding,"complete-covered")]).outcome).toBe("accepted");
    expect(state(restored,binding)).toMatchObject({status:"closed"});
    expect(restored.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({closed:true,settlementConfirmed:true});
  });

  it("selects unprocessed duties beyond sixteen cancelled unknown preparations and recovers priorities from actual state",()=>{
    const f=open(),binding=f.need(),preparations=Array.from({length:22},(_,index)=>f.work(`prepare-${index}`))
      .sort((a,b)=>a.entry.id<b.entry.id?-1:a.entry.id>b.entry.id?1:0);
    const producer=methodWork(f,"independent-producer"),source=f.work("source",true),reception=receiver(f,binding,"receive",producer.intent.id);
    f.a({kind:"open_path",intent:producer.intent});f.a({kind:"open_path",intent:source.intent});f.a({kind:"submit",request:source.request});
    expect(f.accept("register-many",binding,[...preparations.map(p=>p.entry),source.entry,reception.entry],
      [...preparations.flatMap(p=>p.parts),...reception.parts]).outcome).toBe("accepted");
    const unknown=preparations.slice(0,16),settled=preparations.slice(16,18),untouched=preparations.slice(18);
    const executor={hostSession:"test",worker:"test",generation:f.db.generation};
    for(const work of unknown) {
      const attemptId=`${work.intent.id}:attempt`;
      f.a({kind:"admit",requestId:work.request.id,expectedControlRevision:0});
      f.a({kind:"dispatch",attempt:{id:attemptId,requestId:work.request.id,executor,inputDigest:digest(work.request.input),startedAt:new Date().toISOString()},expectedControlRevision:0});
      f.a({kind:"save_raw",result:{id:`${attemptId}:unknown`,attemptId,completeness:"complete",outcome:"unknown",value:{unconfirmed:true},usage:{},recordedAt:new Date().toISOString()}});
      f.a({kind:"cancel",pathId:work.intent.id,expectedControlRevision:0});
    }
    for(const work of settled)f.a({kind:"cancel",pathId:work.intent.id,expectedControlRevision:0});
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1)]).outcome).toBe("accepted");
    const unprocessedIds=[...untouched.map(p=>p.entry.id),source.entry.id,reception.entry.id].sort();
    const before=pending(f,binding,1,16);if(before.kind!=="exit_pending")throw new Error("Missing prioritized exit page");
    expect(before.entries).toHaveLength(16);expect(before.more).toBe(true);
    expect(before.entries.slice(0,unprocessedIds.length).map(e=>e.id).sort()).toEqual(unprocessedIds);
    expect(before.entries.slice(unprocessedIds.length,unprocessedIds.length+settled.length).map(e=>e.id).sort()).toEqual(settled.map(p=>p.entry.id).sort());
    expect(before).toMatchObject({uncoveredPathId:null});
    f.db.close();const restored=open(f.directory);
    const reopened=pending(restored,binding,1,16);if(reopened.kind!=="exit_pending")throw new Error("Missing recovered exit page");
    expect(reopened.entries.map(e=>e.id)).toEqual(before.entries.map(e=>e.id));
    for(const work of untouched)restored.a({kind:"cancel",pathId:work.intent.id,expectedControlRevision:0});
    const after=pending(restored,binding,1,16);if(after.kind!=="exit_pending")throw new Error("Missing changed-priority exit page");
    expect(after.entries.slice(0,2).map(e=>e.id).sort()).toEqual([source.entry.id,reception.entry.id].sort());
    expect(after.entries.slice(2,8).map(e=>e.id).sort()).toEqual([...settled,...untouched].map(p=>p.entry.id).sort());
    expect(state(restored,binding)?.revision).toBe(1);
    for(const work of unknown) {
      expect(restored.a({kind:"read_stage",requestId:work.request.id})).toMatchObject({status:"dispatched",result:null,settlement:null,rawEvidenceRevision:1});
      expect(restored.a({kind:"pending",runId:binding.runId,pathId:work.intent.id,after:0,limit:1})).toHaveLength(1);
    }
  });

  it("rechecks scope coverage after all participants before committing exit completion",()=>{
    const f=open(),binding=f.need(),schedule=scheduling(f,binding),outside=f.work("late-scope-path");
    expect(f.accept("register-work",binding,[],[schedulePart(schedule)],0,schedule).outcome).toBe("accepted");
    f.a({kind:"open_path",intent:outside.intent});
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1),seal(schedule)]).outcome).toBe("accepted");
    expect(pending(f,binding,1,16)).toMatchObject({entries:[],uncoveredPathId:null});
    const moved={...outside.intent,scheduledWorkId:schedule.workId};
    expect(withLateMutation(f,binding,"late-uncovered",[closeWork(schedule),inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1}),
      closeSubscription(f,binding,"late-uncovered")],sql=>{
      sql.prepare("UPDATE activity_paths SET intent=?,digest=? WHERE id=?").run(JSON.stringify(moved),digest(moved),moved.id);
    })).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_schedule_responsibility_missing"}});
    expect(state(f,binding)).toMatchObject({status:"closing",revision:1});
    expect(f.a({kind:"read_schedule",workId:schedule.workId})).toMatchObject({closed:false,settlementConfirmed:false,revision:2});
    expect(f.a({kind:"read_reconsideration",subscriptionId:`${binding.needId}:supply`,limit:1})).toMatchObject({state:{closed:false,revision:0}});
    expect(f.a({kind:"read_path",pathId:outside.intent.id})).toHaveProperty("intent",outside.intent);
    expect(pending(f,binding,1,16)).toMatchObject({entries:[],uncoveredPathId:null});
    expect(f.db.contextFoundationFacts("root",0,128).contextFacts.filter(f=>f.kind==="exit_completed")).toEqual([]);
  });

  it("rechecks original return evidence after all participants and rolls back exit facts",()=>{
    const f=open(),binding=f.need(),basis=returned(f,binding);
    const result=withLateMutation(f,binding,"reverse-return",[begin(binding,basis)],sql=>{
      // Reach the final evidence validator rather than failing at the handoff foreign key.
      sql.prepare("DELETE FROM activity_handoffs WHERE path_id=?").run(binding.consumerPathId);
      sql.prepare("DELETE FROM activity_stages WHERE id=?").run(basis.stageId);
    });
    expect(result).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_return_unconfirmed"}});
    expect(state(f,binding)).toBeNull();expect(f.a({kind:"read_stage",requestId:basis.stageId})).not.toBeNull();
    expect(f.db.contextFoundationFacts("root",0,128).contextFacts.filter(f=>f.kind==="exit_started")).toEqual([]);
    expect(f.a({kind:"read_fact",id:`input-supply:${binding.needId}:exit:1`})).toBeNull();
  });

  it("rechecks owned settlement after a later participant restores pending work",()=>{
    const f=open(),binding=f.need(),work=f.work("prepare");
    expect(f.accept("register",binding,[work.entry],work.parts).outcome).toBe("accepted");
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding),1)]).outcome).toBe("accepted");
    f.a({kind:"cancel",pathId:work.intent.id,expectedControlRevision:0});
    const disposition=inputSupplyExit({kind:"dispose",needId:binding.needId,expectedRevision:1,dispositions:[{responsibilityId:work.entry.id,kind:"owned_settled"}]});
    expect(withLateMutation(f,binding,"reverse-pending",[disposition],sql=>{
      sql.prepare("UPDATE activity_handoffs SET pending=1 WHERE path_id=? AND kind='admission'").run(work.intent.id);
    })).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_owned_work_unsettled"}});
    expect(state(f,binding)?.revision).toBe(1);expect(pending(f,binding,1)).toMatchObject({entries:[expect.objectContaining(work.entry)]});
    expect(f.a({kind:"pending",runId:"root",pathId:work.intent.id,after:0,limit:1})).toEqual([]);
    expect(accept(f,binding,"settled",[disposition]).outcome).toBe("accepted");
  });

  it("rechecks joint subscription closure after all participants",()=>{
    const f=open(),binding=f.need();
    expect(accept(f,binding,"begin",[begin(binding,cancelNeed(f,binding))]).outcome).toBe("accepted");
    expect(withLateMutation(f,binding,"reverse-close",[inputSupplyExit({kind:"complete",needId:binding.needId,expectedRevision:1}),
      closeSubscription(f,binding,"reverse-close")],sql=>{
      sql.prepare("UPDATE activity_reconsiderations SET closed=0 WHERE id=?").run(`${binding.needId}:supply`);
    })).toMatchObject({outcome:"rejected",rejection:{code:"input_supply_exit_subscription_closure_not_joint"}});
    expect(state(f,binding)).toMatchObject({status:"closing",revision:1});
    expect(f.a({kind:"read_reconsideration",subscriptionId:`${binding.needId}:supply`,limit:1})).toMatchObject({state:{closed:false,revision:0}});
    expect(f.db.contextFoundationFacts("root",0,128).contextFacts.filter(f=>f.kind==="exit_completed")).toEqual([]);
  });
});
