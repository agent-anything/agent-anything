import {afterEach,describe,expect,it,vi} from "vitest";
import {createRequire} from "node:module";
import type {DatabaseSync as SqliteDatabase} from "node:sqlite";
import type Database from "better-sqlite3";
import {ActivityPurposeRegistry,type ActivityHandoffCommand,type ActivityPathState,type ActivityRawResult,
  type ActivityStageState,type SharedAcceptancePart,type SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {acceptedModelInputUsage} from "@agent-anything/agent-runtime/model-access";
import {createAcceptedInputUsage,modelInputValueDigest,type AcceptedInputUsage,type InputAccountingFootprint,type InputUsageQuery} from "@agent-anything/model-interaction/input";
import type {PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import type {ModelTurnFinish,ProviderCallResult,ProviderUsage} from "@agent-anything/model-interaction";
import {ActivityHandoffDatabase,ACTIVITY_HANDOFF_SCHEMA} from "./ActivityHandoffDatabase.js";
import {ContextFoundationRecords,CONTEXT_FOUNDATION_FACT_SCHEMA} from "./ContextFoundationRecords.js";
import {ModelInputUsageDatabase,MODEL_INPUT_USAGE_SCHEMA} from "./ModelInputUsageDatabase.js";
import {SharedAcceptanceDatabase,SharedAcceptanceRejection,SHARED_ACCEPTANCE_SCHEMA,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";

const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases:SqliteDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const at="2026-11-01T00:00:00Z";
const executor={hostSession:"usage-tests",worker:"original-worker",generation:1};
const footprint:InputAccountingFootprint={basisKey:"accounting:1",schemaDigest:"tools:1",bytes:400,inputUsage:"complete"};
const reportedUsage=(inputTokens=100):ProviderUsage=>({inputTokens,outputTokens:20,totalTokens:inputTokens+20,costUnits:null,metadata:{}});
function native(usage:ProviderUsage|null=reportedUsage(),finish:ModelTurnFinish={kind:"normal"}):ProviderCallResult {
  return {kind:"succeeded",response:{kind:"native_tool_turn",continuation:null,metadata:{},turn:{turnId:"turn:original",
    assistant:{role:"assistant",content:[{kind:"text",text:"The report claims 999999 input tokens; this is not usage evidence."}]},
    finish,usage,responseRef:{providerId:"provider",requestId:"provider-request",responseId:"provider-response"}}}};
}
function queryOf(value:AcceptedInputUsage):InputUsageQuery {
  return {runId:value.runId,purpose:value.purpose,targetRevision:value.targetRevision,basisKey:value.footprint.basisKey,schemaDigest:value.footprint.schemaDigest};
}
function reseal(value:AcceptedInputUsage,changes:Partial<Omit<AcceptedInputUsage,"id">>):AcceptedInputUsage {
  const {id:_,...body}=value,next={...body,...changes};return {...next,id:modelInputValueDigest(next)};
}

function fixture() {
  const sql=new DatabaseSync(":memory:");databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(ACTIVITY_HANDOFF_SCHEMA+CONTEXT_FOUNDATION_FACT_SCHEMA+MODEL_INPUT_USAGE_SCHEMA+SHARED_ACCEPTANCE_SCHEMA);
  let depth=0,savepoint=0;
  // Adapt only the driver API. All owners and nested rollback boundaries use real SQLite.
  const db={prepare:sql.prepare.bind(sql),get inTransaction(){return depth>0;},transaction:<T>(action:()=>T)=>()=>{
    const name=`usage_test_${++savepoint}`;sql.exec(`SAVEPOINT ${name}`);depth++;
    try {const result=action();sql.exec(`RELEASE ${name}`);return result;}
    catch(error){sql.exec(`ROLLBACK TO ${name}`);sql.exec(`RELEASE ${name}`);throw error;}
    finally {depth--;}
  }} as unknown as Database.Database;
  function owners(extra:readonly SharedAcceptanceParticipant[]=[]) {
    const activities=new ActivityHandoffDatabase(db,value=>({value}) as never,root=>(root as unknown as {value:unknown}).value,()=>1);
    const send=(command:ActivityHandoffCommand)=>activities.command(command).activityValue;
    const stage=(id:string)=>send({kind:"read_stage",requestId:id}) as ActivityStageState|null;
    const records=new ContextFoundationRecords(db);
    const usage=new ModelInputUsageDatabase(records,stage,id=>send({kind:"read_path",pathId:id}) as ActivityPathState|null);
    const shared=new SharedAcceptanceDatabase(db,[activities.acceptanceParticipant(),usage.participant(),...extra]);
    return {activities,send,stage,records,usage,shared};
  }
  const original=owners();
  const purpose=new ActivityPurposeRegistry<null>().register({ref:{id:"usage-test",revision:"1"},inputOwner:"input-owner",executionOwner:"model",
    interpretationOwner:"professional",acceptanceOwner:"professional",recoveryOwner:"professional",stageKinds:["model"],capabilities:["model-request"],continuationKinds:["stage_request"]},null);
  function seed(id="one",options:{runId?:string;purpose?:string;targetRevision?:string;accounting?:InputAccountingFootprint;
    result?:ProviderCallResult;completeness?:ActivityRawResult["completeness"];outcome?:ActivityRawResult["outcome"];recordedAt?:string}={}) {
    const runId=options.runId??"root",accounting=options.accounting??footprint;
    const prepared={kind:"prepared_context_input",demand:{runId,purpose:options.purpose??"task"},
      encoded:{id:`encoded:${id}`,targetDigest:options.targetRevision??"target:1"},accounting} as unknown as PreparedContextInput;
    const intent={id:`path:${id}`,runId,owner:"professional",purpose,permissionBasis:"original-grant",resourceScope:`resources:${id}`,
      maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2099-01-01T00:00:00Z"};
    const request={id:`stage:${id}`,pathId:intent.id,stageKind:"model",input:prepared,capabilities:["model-request"],dependencies:[]};
    original.send({kind:"open_path",intent});original.send({kind:"submit",request});
    original.send({kind:"admit",requestId:request.id,expectedControlRevision:0});
    original.send({kind:"dispatch",attempt:{id:`attempt:${id}`,requestId:request.id,executor,inputDigest:modelInputValueDigest(prepared),startedAt:at},expectedControlRevision:0});
    const raw:ActivityRawResult={id:`raw:${id}`,attemptId:`attempt:${id}`,completeness:options.completeness??"complete",outcome:options.outcome??"returned",
      value:options.result??native(),usage:{inputTokens:9999},recordedAt:options.recordedAt??at};
    original.send({kind:"save_raw",result:raw});
    if(original.stage(request.id)?.status==="raw_result")original.send({kind:"claim_processing",claim:{id:`claim:${id}`,requestId:request.id,executor,previousClaimId:null},expectedControlRevision:0});
    const acceptanceId=`accept:${id}`;
    const value=createAcceptedInputUsage({runId,purpose:prepared.demand.purpose,targetRevision:prepared.encoded.targetDigest,encodedInputId:prepared.encoded.id,
      stageId:request.id,rawResultId:raw.id,acceptanceId,recordedAt:raw.recordedAt,footprint:accounting},reportedUsage())!;
    const command={kind:"accept" as const,executor,expectedControlRevision:0,receipt:{id:acceptanceId,requestId:request.id,resultId:raw.id,owner:intent.owner,
      expectedProgressRevision:0,progress:{resultRetained:true},next:[]}};
    const professional:SharedAcceptancePart={owner:"activity",kind:"professional_acceptance",proposal:command};
    const propose=(usageValue:AcceptedInputUsage=value,usageFirst=true):SharedAcceptanceProposal=>{
      const measurement={owner:"model_input_usage",kind:"accepted_usage",proposal:usageValue};
      return {id:acceptanceId,scope:runId,actor:intent.owner,parts:usageFirst?[measurement,professional]:[professional,measurement]};
    };
    return {intent,request,prepared,raw,acceptanceId,value,professional,command,propose};
  }
  const count=()=>Number((sql.prepare("SELECT COUNT(*) AS n FROM model_input_usage").get() as {n:number}).n);
  return {sql,...original,seed,reopen:owners,count};
}

describe("accepted usage from original complete responses",()=>{
  it.each([true,false])("jointly accepts usage and the original professional result (usage first=%s)",usageFirst=>{
    const f=fixture(),s=f.seed(),proposal=s.propose(s.value,usageFirst);
    expect(acceptedModelInputUsage(f.stage(s.request.id)!,s.acceptanceId)).toEqual(s.value);
    expect(f.usage.latest(queryOf(s.value))).toBeNull();
    expect(f.shared.accept(proposal).outcome).toBe("accepted");
    expect(f.stage(s.request.id)).toMatchObject({status:"accepted",result:s.raw,receipt:{id:s.acceptanceId,resultId:s.raw.id}});
    expect(f.usage.latest(queryOf(s.value))).toEqual(s.value);
    expect(f.records.facts("root",0,16)).toMatchObject([{kind:"input_usage_accepted",subject:s.value.id,details:{usage:s.value}}]);
    const evidence=f.records.facts("root",0,16)[0]!.evidence!;
    expect(evidence.category).toBe("measurement");
    expect(evidence.relationships.map(edge=>[edge.kind,edge.to.owner,edge.to.id])).toEqual([
      ["observes","model-input",s.prepared.encoded.id],["observes","activity",s.request.id],
      ["observes","activity",s.raw.id],["observes","shared_acceptance",s.acceptanceId],
    ]);
    expect(f.reopen().records.facts("root",0,16)[0]!.evidence).toEqual(evidence);
    expect(s.value.inputTokens).toBe(100);
  });
  it.each(["text_generation","structured_generation"] as const)("reads %s response usage, not the activity usage summary",kind=>{
    const result:ProviderCallResult={kind:"succeeded",response:kind==="text_generation"
      ? {kind,output:"text",responseId:"original",usage:reportedUsage(),continuation:null,metadata:{}}
      : {kind,output:{message:"text"},responseId:"original",usage:reportedUsage(),continuation:null,metadata:{}}};
    const f=fixture(),s=f.seed("structured",{result});
    expect(f.shared.accept(s.propose()).outcome).toBe("accepted");
    expect(f.usage.latest(queryOf(s.value))?.inputTokens).toBe(100);
  });
  it.each([
    ["missing",native(null)],
    ["inconsistent",native({...reportedUsage(),metadata:{accountingConsistent:false}})],
    ["input truncated",native({...reportedUsage(),metadata:{inputTruncated:true}})],
    ["output limit",native(reportedUsage(),{kind:"output_limit"})],
    ["unknown finish",native(reportedUsage(),{kind:"unknown",safeCode:null})],
    ["refusal",native(reportedUsage(),{kind:"refusal",reason:null})],
    ["content filter",native(reportedUsage(),{kind:"content_filter"})],
    ["protocol pause",native(reportedUsage(),{kind:"protocol_pause"})],
    ["failed call",{kind:"failed",failure:{category:"transport",code:"failed",message:"No original response",metadata:{}}} as ProviderCallResult],
  ] as const)("does not attach %s usage to an accepted measurement",(_label,result)=>{
    const f=fixture(),s=f.seed("excluded",{result});
    expect(acceptedModelInputUsage(f.stage(s.request.id)!,s.acceptanceId)).toBeNull();
    expect(f.shared.accept(s.propose())).toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(s.request.id)?.receipt).toBeNull();
  });
  it.each([{completeness:"partial" as const},{outcome:"unknown" as const},{outcome:"failed" as const}])("does not accept non-original-complete raw evidence: %j",rawOptions=>{
    const f=fixture(),s=f.seed("incomplete",rawOptions);
    expect(acceptedModelInputUsage(f.stage(s.request.id)!,s.acceptanceId)).toBeNull();
    expect(f.shared.accept(s.propose())).toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.records.facts("root",0,16)).toEqual([]);
  });
  it("rejects replacement complete-accounting claims when the original input coverage was unknown",()=>{
    const f=fixture(),s=f.seed("unqualified",{accounting:{...footprint,inputUsage:"unknown"}});
    const value=createAcceptedInputUsage({runId:"root",purpose:"task",targetRevision:"target:1",encodedInputId:s.prepared.encoded.id,
      stageId:s.request.id,rawResultId:s.raw.id,acceptanceId:s.acceptanceId,recordedAt:at,footprint},reportedUsage())!;
    expect(f.shared.accept(s.propose(value))).toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);
  });
});

describe("usage common acceptance and durable recovery",()=>{
  it("requires the same acceptance to contain the original professional acceptance",()=>{
    const f=fixture(),s=f.seed();
    expect(f.shared.accept({...s.propose(),parts:s.propose().parts.slice(0,1)}))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(s.request.id)?.status).toBe("raw_result");
  });
  it("does not borrow another original stage's professional acceptance",()=>{
    const f=fixture(),a=f.seed("a"),b=f.seed("b");
    const borrowed={...b.command,receipt:{...b.command.receipt,id:a.acceptanceId}};
    expect(f.shared.accept({...a.propose(),parts:[a.propose().parts[0]!,{owner:"activity",kind:"professional_acceptance",proposal:borrowed}]}))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(a.request.id)?.receipt).toBeNull();expect(f.stage(b.request.id)?.receipt).toBeNull();
  });
  it.each(["runId","purpose","targetRevision","encodedInputId","stageId","rawResultId","acceptanceId"] as const)("rejects rehashed replacement %s",key=>{
    const f=fixture(),s=f.seed(),value=reseal(s.value,{[key]:"replacement"});
    expect(f.shared.accept(s.propose(value))).toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(s.request.id)?.receipt).toBeNull();
  });
  it.each([
    {inputTokens:999999},
    {recordedAt:"2026-11-02T00:00:00Z"},
    {footprint:{...footprint,bytes:1}},
  ])("rejects validly rehashed measurements not present in the original exchange: %j",change=>{
    const f=fixture(),s=f.seed();
    expect(f.shared.accept(s.propose(reseal(s.value,change))))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(s.request.id)?.result).toEqual(s.raw);
  });
  it.each(["scope","actor"] as const)("rejects a foreign acceptance %s",key=>{
    const f=fixture(),s=f.seed();
    expect(f.shared.accept({...s.propose(),[key]:"foreign"})).toMatchObject({outcome:"rejected"});
    expect(f.count()).toBe(0);
  });
  it("does not derive measurement acceptance from cancellation settlement",()=>{
    const f=fixture(),s=f.seed();f.send({kind:"cancel",pathId:s.intent.id,expectedControlRevision:0});
    const settlement={owner:"activity",kind:"result_settlement",proposal:{kind:"settle",executor,expectedControlRevision:1,
      receipt:{id:s.acceptanceId,requestId:s.request.id,resultId:s.raw.id,owner:s.intent.owner,disposition:{retained:true}}}};
    expect(f.shared.accept({...s.propose(),parts:[s.propose().parts[0]!,settlement]}))
      .toMatchObject({outcome:"rejected",rejection:{code:"input_usage_original_exchange_mismatch"}});
    expect(f.count()).toBe(0);expect(f.stage(s.request.id)?.result).toEqual(s.raw);
  });
  it("rolls back usage, its fact and professional progress after another owner's postcondition rejects",()=>{
    const f=fixture(),s=f.seed();
    const restored=f.reopen([{owner:"late",kinds:["check"],prepare:()=>null,apply:()=>{},validate:()=>{
      expect(f.count()).toBe(1);expect(f.stage(s.request.id)?.status).toBe("accepted");
      throw new SharedAcceptanceRejection("late","condition_changed");
    }}]);
    const receipt=restored.shared.accept({...s.propose(),parts:[...s.propose().parts,{owner:"late",kind:"check",proposal:null}]});
    expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:"condition_changed"}});
    expect(f.count()).toBe(0);expect(f.records.facts("root",0,16)).toEqual([]);
    expect(f.stage(s.request.id)).toMatchObject({status:"raw_result",receipt:null,result:s.raw});
    expect(f.reopen().shared.query(s.acceptanceId)).toEqual(receipt);
  });
  it("rechecks the actual acceptance after every participant applies",()=>{
    const f=fixture(),s=f.seed(),owners=f.reopen([{owner:"late",kinds:["change"],prepare:()=>null,apply:()=>{
      f.sql.prepare("UPDATE activity_stages SET status='raw_result' WHERE id=?").run(s.request.id);
    }}]);
    expect(owners.shared.accept({...s.propose(),parts:[...s.propose().parts,{owner:"late",kind:"change",proposal:null}]})).toMatchObject({outcome:"rejected"});
    expect(f.count()).toBe(0);expect(f.records.facts("root",0,16)).toEqual([]);
    expect(f.stage(s.request.id)).toMatchObject({status:"raw_result",receipt:null});
  });
  it("does not record a known rejection or partial evidence for an unclassified storage failure",()=>{
    const f=fixture(),s=f.seed(),owners=f.reopen([{owner:"late",kinds:["fail"],prepare:()=>null,apply:()=>{throw new Error("storage failure");}}]);
    expect(()=>owners.shared.accept({...s.propose(),parts:[...s.propose().parts,{owner:"late",kind:"fail",proposal:null}]})).toThrow("storage failure");
    expect(f.count()).toBe(0);expect(owners.shared.query(s.acceptanceId)).toBeNull();
    expect(f.stage(s.request.id)).toMatchObject({status:"raw_result",receipt:null,result:s.raw});
  });
  it("replays lost acknowledgements without duplicate rows or facts after reconstructing the owners",()=>{
    const f=fixture(),s=f.seed(),proposal=s.propose(),receipt=f.shared.accept(proposal);
    expect(receipt.outcome).toBe("accepted");
    const restored=f.reopen();
    expect(restored.shared.query(s.acceptanceId)).toEqual(receipt);
    expect(restored.shared.accept(proposal)).toEqual(receipt);
    expect(restored.usage.latest(queryOf(s.value))).toEqual(s.value);
    expect(f.count()).toBe(1);expect(f.records.facts("root",0,16)).toHaveLength(1);
    expect(()=>restored.shared.accept({...proposal,actor:"replacement"})).toThrow("acceptance_identity_conflict");
  });
  it("deduplicates repeated identical usage participants without advancing the latest observation",()=>{
    const f=fixture(),s=f.seed(),proposal=s.propose();
    expect(f.shared.accept({...proposal,parts:[proposal.parts[0]!,...proposal.parts]}).outcome).toBe("accepted");
    expect(f.count()).toBe(1);expect(f.records.facts("root",0,16)).toHaveLength(1);
  });
});

describe("isolated indexed input usage queries",()=>{
  it("selects the latest accepted row only within the full run/purpose/target/basis/schema scope",()=>{
    const f=fixture(),first=f.seed();expect(f.shared.accept(first.propose()).outcome).toBe("accepted");
    const changes=[{runId:"child"},{purpose:"context_generation"},{targetRevision:"target:2"},
      {accounting:{...footprint,basisKey:"accounting:2"}},{accounting:{...footprint,schemaDigest:"tools:2"}}];
    for(const [i,change] of changes.entries()) {
      const other=f.seed(`other:${i}`,change);expect(f.shared.accept(other.propose()).outcome).toBe("accepted");
      expect(f.usage.latest(queryOf(first.value))).toEqual(first.value);
      expect(f.usage.latest(queryOf(other.value))).toEqual(other.value);
    }
    const latest=f.seed("last",{recordedAt:"2026-10-01T00:00:00Z"});expect(f.shared.accept(latest.propose()).outcome).toBe("accepted");
    expect(f.usage.latest(queryOf(first.value))).toEqual(latest.value);
    expect(f.usage.latest({...queryOf(first.value),runId:"root' OR 1=1 --"})).toBeNull();
  });
  it.each(["runId","purpose","targetRevision","basisKey","schemaDigest"] as const)("rejects malformed query %s",key=>{
    const f=fixture(),s=f.seed(),query=queryOf(s.value);
    for(const value of ["","x".repeat(4097),42])expect(()=>f.usage.latest({...query,[key]:value} as InputUsageQuery)).toThrow("input_usage_query_invalid");
  });
  it.each(["digest","body","scope","row identity","replacement identity"])("rejects corrupt %s without falling back to older usage",changed=>{
    const f=fixture(),old=f.seed("old"),s=f.seed();f.shared.accept(old.propose());f.shared.accept(s.propose());
    let query=queryOf(s.value);
    if(changed==="digest")f.sql.prepare("UPDATE model_input_usage SET digest='changed' WHERE id=?").run(s.value.id);
    if(changed==="body")f.sql.prepare("UPDATE model_input_usage SET value=? WHERE id=?").run(JSON.stringify({...s.value,inputTokens:200}),s.value.id);
    if(changed==="scope") {f.sql.prepare("UPDATE model_input_usage SET run_id='foreign' WHERE id=?").run(s.value.id);query={...query,runId:"foreign"};}
    if(changed==="row identity")f.sql.prepare("UPDATE model_input_usage SET id='replacement' WHERE id=?").run(s.value.id);
    if(changed==="replacement identity") {
      const value=reseal(s.value,{acceptanceId:"different-acceptance"});
      f.sql.prepare("UPDATE model_input_usage SET value=?,digest=? WHERE id=?").run(JSON.stringify(value),modelInputValueDigest(value),s.value.id);
    }
    expect(()=>f.reopen().usage.latest(query)).toThrow();
  });
  it("uses the complete scope index with a bounded latest-row seek",()=>{
    const f=fixture(),s=f.seed();f.shared.accept(s.propose());
    const queries:string[]=[],sql=f.records.sql.bind(f.records);
    vi.spyOn(f.records,"sql").mockImplementation(query=>{queries.push(query);return sql(query);});
    expect(f.usage.latest(queryOf(s.value))).toEqual(s.value);
    expect(queries).toHaveLength(1);
    const query=queryOf(s.value),plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${queries[0]!}`)
      .all(query.runId,query.purpose,query.targetRevision,query.basisKey,query.schemaDigest) as {detail:string}[];
    expect(plan.map(row=>row.detail).join("\n")).toMatch(/SEARCH model_input_usage USING INDEX model_input_usage_scope/);
    expect(plan.map(row=>row.detail).join("\n")).not.toMatch(/SCAN|TEMP B-TREE/);
    expect(queries[0]).toContain("LIMIT 1");
  });
});
