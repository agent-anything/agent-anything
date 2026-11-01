import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import SqliteDatabase from "better-sqlite3";
import {ActivityPurposeRegistry,activityStageEvidence, type ActivityHandoffCommand, type ActivityStageState, type ActivityProcessingReceipt} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ExecutionDatabase} from "./ExecutionDatabase.js";
import {ActivityHandoffDatabase} from "./ActivityHandoffDatabase.js";
import {SharedAcceptanceDatabase} from "./SharedAcceptanceDatabase.js";

const databases:ExecutionDatabase[] = [], directories:string[] = [];
afterEach(() => {for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) {
  if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith("helarc-activity-handoff-"))throw new Error("Unsafe cleanup");
  rmSync(dir,{recursive:true,force:true});
}});
function open(directory = mkdtempSync(join(tmpdir(),"helarc-activity-handoff-"))) {
  if (!directories.includes(directory)) directories.push(directory);
  const db = new ExecutionDatabase(directory); databases.push(db);
  return {db,directory,send:(command:ActivityHandoffCommand) => db.activityHandoffCommand(db.generation,command).activityValue};
}
const registry = new ActivityPurposeRegistry<null>();
const purpose = registry.register({ref:{id:"generate",revision:"1"},inputOwner:"context",executionOwner:"model",interpretationOwner:"method",
  acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["generate","check"],capabilities:[],continuationKinds:["stage_request"]},null);
const intent = {id:"path",runId:"child",owner:"method",purpose,permissionBasis:"grant:1",resourceScope:"preparation:1",maximumStages:4,
  maximumAttempts:4,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"};
const request = {id:"stage",pathId:"path",stageKind:"generate",input:{source:"exact original"},capabilities:[],dependencies:[]};
const executor = {hostSession:"host:1",worker:"worker:1",generation:1};
const attempt = {id:"attempt:1",requestId:request.id,executor,inputDigest:modelInputValueDigest(request.input),startedAt:"2026-10-28T00:00:00Z"};
const result = {id:"raw:1",attemptId:attempt.id,completeness:"complete" as const,outcome:"returned" as const,value:{text:"original answer"},usage:{tokens:7},recordedAt:"2026-10-28T00:00:01Z"};
function seed(send:ReturnType<typeof open>["send"],pathIntent=intent) {
  send({kind:"open_path",intent:pathIntent}); send({kind:"submit",request}); send({kind:"admit",requestId:request.id,expectedControlRevision:0});
  send({kind:"dispatch",attempt,expectedControlRevision:0});
}
function claim(send:ReturnType<typeof open>["send"]) {
  send({kind:"claim_processing",claim:{id:"claim:1",requestId:request.id,previousClaimId:null,executor},expectedControlRevision:0});
}
describe("durable activity handoff", () => {
  it("resumes a same-stage retry without replacing input, failure evidence or cumulative attempts",()=>{
    const f=open(),retryPurpose=registry.register({...purpose.contract,ref:{id:"retryable",revision:"1"},
      attemptRetry:{ref:{id:"technical",revision:"1"},stageKinds:["generate"],maximumAttempts:2}},null);
    seed(f.send,{...intent,purpose:retryPurpose});f.send({kind:"save_raw",result});
    const original=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    const receipt={id:"retry:1",requestId:request.id,attemptId:attempt.id,resultId:result.id,owner:"model",policy:{id:"technical",revision:"1"},
      expectedStageEvidence:activityStageEvidence(original),decidedAt:result.recordedAt,notBefore:"2026-10-28T00:00:02Z",reason:{category:"transport",code:"retryable"}};
    expect(f.send({kind:"retry_attempt",receipt,executor,expectedControlRevision:0})).toMatchObject({status:"admitted",attempt:null,result:null,attemptCount:1,retry:receipt});
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0,dispatchedAttempts:1});
    f.db.close();const restored=open(f.directory),current={...executor,generation:restored.db.generation};
    expect(restored.send({kind:"retry_attempt",receipt,executor:current,expectedControlRevision:0})).toMatchObject({retry:receipt});
    const second={...attempt,id:"attempt:2",executor:current,startedAt:receipt.notBefore};
    expect(()=>restored.send({kind:"dispatch",attempt:{...second,startedAt:receipt.decidedAt},expectedControlRevision:0})).toThrow("attempt_retry_waiting");
    expect(()=>restored.send({kind:"dispatch",attempt:{...second,inputDigest:"changed"},expectedControlRevision:0})).toThrow("input_mismatch");
    restored.send({kind:"dispatch",attempt:second,expectedControlRevision:0});
    restored.send({kind:"save_raw",result:{...result,id:"raw:2",attemptId:second.id}});
    const latest=restored.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    expect(latest).toMatchObject({request,attemptCount:2,result:{id:"raw:2"}});
    expect(restored.send({kind:"read_raw_result",resultId:result.id})).toEqual(result);
    expect(restored.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0,dispatchedAttempts:2});
    expect(()=>restored.send({kind:"retry_attempt",receipt:{...receipt,id:"retry:2",attemptId:second.id,resultId:"raw:2",expectedStageEvidence:activityStageEvidence(latest)},executor:current,expectedControlRevision:0})).toThrow("attempt_limit");
  });
  it.each(["policy","owner","evidence","cancel","authorization","generation"])("rejects retry with changed %s without discarding the original result",changed=>{
    const f=open(),bound=new ActivityPurposeRegistry<null>().register({...purpose.contract,ref:{id:"retry-guard",revision:"1"},attemptRetry:{ref:{id:"technical",revision:"1"},stageKinds:["generate"],maximumAttempts:2}},null);
    seed(f.send,{...intent,purpose:bound});f.send({kind:"save_raw",result});
    let stage=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    if(changed==="authorization")stage=f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:0,expectedStageEvidence:activityStageEvidence(stage),action:"interpretation",refusal}) as ActivityStageState;
    if(changed==="cancel")f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    const receipt={id:"retry",requestId:request.id,attemptId:attempt.id,resultId:result.id,owner:changed==="owner"?"other":"model",
      policy:{id:"technical",revision:changed==="policy"?"2":"1"},expectedStageEvidence:changed==="evidence"?"stale":activityStageEvidence(stage),
      decidedAt:result.recordedAt,notBefore:"2026-10-28T00:00:02Z",reason:{category:"transport",code:"retryable"}};
    expect(()=>f.send({kind:"retry_attempt",receipt,executor:changed==="generation"?{...executor,generation:2}:executor,expectedControlRevision:0})).toThrow();
    expect(f.send({kind:"read_stage",requestId:request.id})).toMatchObject({result,attempt,retry:null,attemptCount:1});
  });
  it.each(["interpretation","settlement"] as const)("rechecks %s authorization after all participants and rolls back conflicting acceptance",action=>{
    const f=open();seed(f.send);f.send({kind:"save_raw",result});
    if(action==="interpretation")claim(f.send);else f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    const internal=f.db as unknown as {data:SqliteDatabase.Database;activityHandoffs:ActivityHandoffDatabase};
    const shared=new SharedAcceptanceDatabase(internal.data,[internal.activityHandoffs.acceptanceParticipant(),{
      owner:"fixture",kinds:["restriction"],prepare:()=>null,apply:()=>{
        const value={[action]:{kind:"temporary",code:"concurrent_denial",message:"Changed in another participant"}};
        internal.data.prepare("UPDATE activity_stages SET authorization_restrictions=? WHERE id=?").run(JSON.stringify({value,digest:modelInputValueDigest(value)}),request.id);
      },
    }]);
    const command=action==="interpretation"?{kind:"accept",executor,expectedControlRevision:0,
      receipt:{id:"all-applied",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,progress:{complete:true},next:[]}}:
      {kind:"settle",executor,expectedControlRevision:1,receipt:{id:"all-applied",requestId:request.id,resultId:result.id,owner:"method",disposition:{retained:true}}};
    expect(shared.accept({id:"all-applied",scope:"child",actor:"method",parts:[{owner:"activity",kind:action==="interpretation"?"professional_acceptance":"result_settlement",proposal:command},
      {owner:"fixture",kind:"restriction",proposal:null}]})).toMatchObject({outcome:"rejected",rejection:{code:"activity_authorization_restricted"}});
    expect(f.send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"raw_result",receipt:null,settlement:null,authorizationRestrictions:{},result});
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0,dispatchedAttempts:1});
  });
  const refusal={kind:"denied" as const,code:"original_denial",message:"Denied for this original work",decision:{owner:"permission",id:"decision:1",revision:"1"}};
  function restriction(f:ReturnType<typeof open>,action:"reconciliation"|"interpretation") {
    const original=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    return f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:0,
      expectedStageEvidence:activityStageEvidence(original),action,refusal}) as ActivityStageState;
  }
  function stopProposal(stage:ActivityStageState,action:"reconciliation"|"interpretation",id="original-stop") {
    return {kind:"stop_professional_path" as const,receipt:{id,requestId:request.id,owner:"method",expectedControlRevision:0,expectedProgressRevision:0,
      expectedStageEvidence:activityStageEvidence(stage),limitation:{kind:"authorization" as const,action,refusal},progress:{unavailable:true}}};
  }
  it("stops professional progress without declaring an unknown attempt settled",()=>{
    const f=open();seed(f.send);const command=stopProposal(restriction(f,"reconciliation"),"reconciliation");
    expect(f.send(command)).toMatchObject({status:"dispatched",result:null,stop:command.receipt,settlement:null});
    expect(f.send({kind:"pending",runId:intent.runId,after:0,limit:16})).toMatchObject([{kind:"reconciliation"}]);
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:true,progressRevision:1,dispatchedAttempts:1});
    f.db.close();const restored=open(f.directory);
    expect(restored.send(command)).toMatchObject({status:"dispatched",result:null,stop:command.receipt});
    restored.send({kind:"save_raw",result});
    expect(restored.send({kind:"pending",runId:intent.runId,after:0,limit:16})).toMatchObject([{kind:"settlement"}]);
    restored.send({kind:"settle",receipt:{id:"late-cleanup",requestId:request.id,resultId:result.id,owner:"method",disposition:{retained:true}},
      executor:{...executor,generation:restored.db.generation},expectedControlRevision:1});
    expect(restored.send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"settled",result,stop:command.receipt});
    expect(restored.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:1});
  });
  it.each(["raw","partial","unknown","restriction"])("rejects stopping from stale %s evidence and retains the original outcome",changed=>{
    const f=open();seed(f.send);if(changed==="restriction")f.send({kind:"save_raw",result});
    const action=changed==="restriction"?"interpretation":"reconciliation",stage=restriction(f,action),command=stopProposal(stage,action);
    if(changed==="raw")f.send({kind:"save_raw",result});
    else if(changed==="partial"||changed==="unknown")f.send({kind:"save_raw",result:{...result,id:changed,completeness:changed==="partial"?"partial":"complete",outcome:changed==="unknown"?"unknown":"returned"}});
    else f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:0,expectedStageEvidence:activityStageEvidence(stage),action,refusal:null});
    expect(()=>f.send(command)).toThrow("stop_evidence_changed");
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:false,progressRevision:0});
    expect(f.send({kind:"read_stage",requestId:request.id})).toMatchObject({status:["partial","unknown"].includes(changed)?"dispatched":"raw_result",
      result:["partial","unknown"].includes(changed)?null:result,stop:null,rawEvidenceRevision:1});
  });
  it("guards normal admission and interpretation acceptance against later authorization denial",()=>{
    const f=open();f.send({kind:"open_path",intent});f.send({kind:"submit",request});
    let stage=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    stage=f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:0,expectedStageEvidence:activityStageEvidence(stage),action:"admission",refusal}) as ActivityStageState;
    expect(()=>f.send({kind:"admit",requestId:request.id,expectedControlRevision:0})).toThrow("authorization_restricted");
    f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:0,expectedStageEvidence:activityStageEvidence(stage),action:"admission",refusal:null});
    f.send({kind:"admit",requestId:request.id,expectedControlRevision:0});f.send({kind:"dispatch",attempt,expectedControlRevision:0});
    f.send({kind:"save_raw",result});claim(f.send);restriction(f,"interpretation");
    expect(()=>f.send({kind:"accept",executor,expectedControlRevision:0,receipt:{id:"stale-allowed-interpretation",requestId:request.id,resultId:result.id,
      owner:"method",expectedProgressRevision:0,progress:{published:true},next:[]}})).toThrow("authorization_restricted");
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:false,progressRevision:0});
  });
  it("guards cleanup authorization without blocking preservation of the original response",()=>{
    const f=open();seed(f.send);f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    let stage=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    f.send({kind:"record_authorization_restriction",requestId:request.id,expectedControlRevision:1,expectedStageEvidence:activityStageEvidence(stage),action:"settlement",refusal});
    f.send({kind:"save_raw",result});
    expect(()=>f.send({kind:"settle",executor,expectedControlRevision:1,receipt:{id:"denied-cleanup",requestId:request.id,resultId:result.id,owner:"method",disposition:{}}})).toThrow("authorization_restricted");
    stage=f.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    expect(stage.result).toEqual(result);expect(stage.settlement).toBeNull();
  });
  it("rejects foreign stop ownership and new work attached to a stop acceptance",()=>{
    const f=open();seed(f.send);const command=stopProposal(restriction(f,"reconciliation"),"reconciliation");
    const proposal={id:command.receipt.id,scope:intent.runId,actor:"method",parts:[{owner:"activity",kind:"professional_stop",proposal:command}]};
    expect(f.db.acceptShared(f.db.generation,{...proposal,id:"foreign",actor:"other",parts:[{owner:"activity",kind:"professional_stop",proposal:{...command,receipt:{...command.receipt,id:"foreign",owner:"other"}}}]}).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_stop_scope_invalid"}});
    expect(f.db.acceptShared(f.db.generation,{...proposal,parts:[...proposal.parts,{owner:"activity",kind:"stage_submission",proposal:{...request,id:"smuggled"}}]}).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_stop_scope_invalid"}});
    expect(f.send({kind:"read_stage",requestId:"smuggled"})).toBeNull();
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:false});
  });
  it("guards settled path state, rolls back stale closure and preserves it across reopen",()=>{
    const f=open();seed(f.send);
    const condition={owner:"activity",kind:"path_condition",proposal:{pathId:intent.id,expected:{controlRevision:0,progressRevision:0,cancelled:false},requireSettled:true}};
    const proposal={id:"close-while-in-flight",scope:intent.runId,actor:intent.owner,parts:[
      {owner:"activity",kind:"path_opening",proposal:{...intent,id:"must-rollback"}},condition]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_responsibility_unsettled"}});
    expect(f.send({kind:"read_path",pathId:"must-rollback"})).toBe(null);
    f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    expect(f.db.acceptShared(f.db.generation,{...proposal,id:"stale-control"}).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_condition_changed"}});
    f.db.close();const reopened=open(f.directory);
    expect(reopened.db.acceptShared(reopened.db.generation,proposal).acceptanceValue.outcome).toBe("rejected");
    expect(reopened.send({kind:"read_path",pathId:"must-rollback"})).toBe(null);
  });
  it("checks absent successors and refuses foreign ownership in closure conditions",()=>{
    const f=open();f.send({kind:"open_path",intent});
    const proposal={id:"absent-path",scope:intent.runId,actor:intent.owner,parts:[{owner:"activity",kind:"path_condition",proposal:{pathId:"later",expected:null,requireSettled:true}}]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    f.send({kind:"open_path",intent:{...intent,id:"later"}});
    expect(f.db.acceptShared(f.db.generation,{...proposal,id:"appeared"}).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_condition_changed"}});
    expect(f.db.acceptShared(f.db.generation,{...proposal,id:"foreign",actor:"other"}).acceptanceValue).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_condition_scope_invalid"}});
  });
  it("rechecks final closure conditions after all participants, rolling back later path openings",()=>{
    const f=open();
    const receipt=f.db.acceptShared(f.db.generation,{id:"same-acceptance-successor",scope:intent.runId,actor:intent.owner,parts:[
      {owner:"activity",kind:"path_condition",proposal:{pathId:"later",expected:null,requireSettled:true}},
      {owner:"activity",kind:"path_opening",proposal:{...intent,id:"later"}}]}).acceptanceValue;
    expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_condition_changed"}});
    expect(f.send({kind:"read_path",pathId:"later"})).toBeNull();
    f.db.close();const restored=open(f.directory);
    expect(restored.send({kind:"read_path",pathId:"later"})).toBeNull();
  });
  it("rechecks final settlement when a later participant submits work on an existing path",()=>{
    const f=open();f.send({kind:"open_path",intent});
    const receipt=f.db.acceptShared(f.db.generation,{id:"same-acceptance-submission",scope:intent.runId,actor:intent.owner,parts:[
      {owner:"activity",kind:"path_condition",proposal:{pathId:intent.id,expected:{controlRevision:0,progressRevision:0,cancelled:false},requireSettled:true}},
      {owner:"activity",kind:"stage_submission",proposal:request}]}).acceptanceValue;
    expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:"activity_path_responsibility_unsettled"}});
    expect(f.send({kind:"read_stage",requestId:request.id})).toBeNull();
  });
  it("checks path metadata without expanding retained professional progress inside acceptance",()=>{
    const f=open();seed(f.send);f.send({kind:"save_raw",result});claim(f.send);
    f.send({kind:"accept",executor,expectedControlRevision:0,receipt:{id:"accepted",requestId:request.id,resultId:result.id,owner:intent.owner,
      expectedProgressRevision:0,progress:{body:"Retained evidence ".repeat(1000)},next:[]}});
    expect(f.db.acceptShared(f.db.generation,{id:"condition-with-progress",scope:intent.runId,actor:intent.owner,parts:[
      {owner:"activity",kind:"path_condition",proposal:{pathId:intent.id,expected:{controlRevision:0,progressRevision:1,cancelled:false},requireSettled:true}},
    ]}).acceptanceValue.outcome).toBe("accepted");
  });
  it.each(["method","recovery"])("publishes original settlement by %s without advancing professional progress",recoveryOwner=>{
    const recoveryPurpose=registry.register({...purpose.contract,ref:{id:`recover:${recoveryOwner}`,revision:"1"},recoveryOwner},null);
    const f=open();seed(f.send,{...intent,purpose:recoveryPurpose});f.send({kind:"save_raw",result});f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    f.send({kind:"subscribe_reconsideration",subscription:{id:"closing-consumer",runId:intent.runId,owner:intent.owner,binding:{kind:"activity_path",id:intent.id},
      sources:["activity-source:control:path","activity-source:progress:path"]}});
    const receipt={id:"settlement",requestId:request.id,resultId:result.id,owner:recoveryOwner,disposition:{kind:"retained"}};
    const command={kind:"settle" as const,receipt,executor,expectedControlRevision:1};
    const settlement={id:receipt.id,scope:intent.runId,actor:recoveryOwner,parts:[{owner:"activity",kind:"result_settlement",proposal:command}]};
    expect(f.db.acceptShared(f.db.generation,settlement).acceptanceValue.outcome).toBe("accepted");
    expect(f.db.acceptShared(f.db.generation,settlement).acceptanceValue.outcome).toBe("accepted");
    const snapshot=f.send({kind:"read_reconsideration",subscriptionId:"closing-consumer",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    expect(snapshot.facts.filter(f=>f.ref.kind==="result_settled")).toMatchObject([{ref:{owner:intent.owner,id:request.id,revision:receipt.id}}]);
    expect(f.send({kind:"read_stage",requestId:request.id})).toMatchObject({settlement:receipt});
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0,progress:null});
    const proposal={id:"settled-condition",scope:intent.runId,actor:intent.owner,parts:[{owner:"activity",kind:"path_condition",proposal:{pathId:intent.id,expected:{controlRevision:1,progressRevision:0,cancelled:true},requireSettled:true}}]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    f.db.close();const reopened=open(f.directory);
    expect(reopened.send({kind:"read_reconsideration",subscriptionId:"closing-consumer",limit:16})).toEqual(snapshot);
  });
  it("reads finite original facts by path without expanding inputs or crossing Runs",()=>{
    const f=open();seed(f.send);f.send({kind:"save_raw",result});
    f.send({kind:"open_path",intent:{...intent,id:"other"}});
    const reader=new SqliteDatabase(join(f.directory,"execution.sqlite"),{readonly:true});
    try {
      const steps=reader.prepare("EXPLAIN QUERY PLAN SELECT sequence,value,digest FROM activity_facts WHERE run_id=? AND path_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(intent.runId,intent.id,0,256) as {detail:string}[];
      expect(steps.some(step=>step.detail.includes("USING INDEX activity_facts_path"))).toBe(true);
      expect(steps.some(step=>step.detail.includes("TEMP B-TREE"))).toBe(false);
      const closure=reader.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM activity_stages s JOIN activity_handoffs h ON h.request_id=s.id WHERE s.path_id=? AND h.pending=1 LIMIT 1").all(intent.id) as {detail:string}[];
      expect(closure.some(step=>step.detail.includes("USING INDEX activity_stages_path"))).toBe(true);
      expect(closure.some(step=>step.detail.startsWith("SCAN "))).toBe(false);
    } finally {reader.close();}
    const page=f.send({kind:"facts",runId:intent.runId,pathId:intent.id,after:0,limit:256}) as readonly import("@agent-anything/agent-runtime/activity").ActivityHandoffFact[];
    expect(page.every(f=>f.pathId===intent.id)).toBe(true);expect(page.some(f=>f.kind==="raw_saved")).toBe(true);
    expect(f.send({kind:"facts",runId:intent.runId,pathId:intent.id,after:page.at(-1)!.sequence,limit:256})).toEqual([]);
    expect(()=>f.send({kind:"facts",runId:"parent",pathId:intent.id,after:0,limit:256})).toThrow("fact_path_scope_invalid");
    f.db.close();const reopened=open(f.directory);
    expect(reopened.send({kind:"facts",runId:intent.runId,pathId:intent.id,after:0,limit:256})).toEqual(page);
  });
  it("accepts an independent owner path subscription atomically and restores its original binding",()=>{
    const f=open(),subscription={id:"method-consumer",runId:intent.runId,owner:intent.owner,
      binding:{kind:"activity_path" as const,id:intent.id},sources:["activity-source:control:path","activity-source:progress:path"]};
    const proposal={id:"consumer-start",scope:intent.runId,actor:intent.owner,parts:[
      {owner:"activity",kind:"path_opening",proposal:intent},
      {owner:"activity",kind:"reconsideration_subscription",proposal:subscription}]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.db.acceptShared(restored.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    expect(restored.send({kind:"read_reconsideration",subscriptionId:subscription.id,limit:16})).toMatchObject({state:{subscription,closed:false}});
    for(const change of [{owner:"another"},{runId:"parent"},{sources:["activity-source:progress:path"]}]) {
      expect(()=>restored.send({kind:"subscribe_reconsideration",subscription:{...subscription,...change,id:"foreign"}})).toThrow("subscription_binding_invalid");
    }
  });
  it.each(["supplied","unavailable"])("accepts exactly one input outcome and restores it after reopen (%s)",outcome=>{
    const f=open();f.send({kind:"open_path",intent});const {input:_,...stage}=request;
    const need={id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}};
    f.send({kind:"register_input_need",need});
    const first=outcome==="supplied"?{...stage,input:{value:"original"}}:{...need.unavailableStage,input:{reason:"no entry",evidence:["original"]}};
    const other=outcome==="supplied"?{...need.unavailableStage,input:{reason:"late"}}:{...stage,input:{value:"late"}};
    const proposal={id:"supply-outcome",scope:intent.runId,actor:"context",parts:[
      {owner:"activity",kind:"input_need_condition",proposal:{needId:need.id,expectedControlRevision:0}},
      {owner:"activity",kind:"stage_submission",proposal:first}]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.db.acceptShared(restored.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    expect(restored.send({kind:"read_stage",requestId:first.id})).toMatchObject({request:first,status:"submitted"});
    const late=restored.db.acceptShared(restored.db.generation,{id:"opposite",scope:intent.runId,actor:"context",parts:[{owner:"activity",kind:"stage_submission",proposal:other}]}).acceptanceValue;
    expect(late).toMatchObject({outcome:"rejected",rejection:{code:"activity_input_need_already_answered"}});
    expect(restored.send({kind:"read_stage",requestId:other.id})).toBeNull();
    expect(restored.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:false,admittedStages:0,dispatchedAttempts:0});
    expect(restored.send({kind:"facts",runId:intent.runId,after:0,limit:64})).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:"stage_submitted",details:expect.objectContaining({inputNeedId:need.id,inputOutcome:outcome})})]));
  });
  it("refuses an unavailable entry outside the original path or one shared by another need",()=>{
    const f=open();f.send({kind:"open_path",intent});const {input:_,...stage}=request;
    expect(()=>f.send({kind:"register_input_need",need:{id:"bad",supplier:"context",stage,unavailableStage:{...stage,id:"bad",pathId:"other"}}})).toThrow();
    f.send({kind:"register_input_need",need:{id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}}});
    expect(()=>f.send({kind:"register_input_need",need:{id:"colliding",supplier:"context",stage:{...stage,id:"new"},unavailableStage:{...stage,id:"stage"}}})).toThrow("input_need_conflict");
  });
  it.each(["together","later"])("prepares supplier reads when source progress is accepted %s with its input need", timing=>{
    const f=open();seed(f.send);f.send({kind:"save_raw",result});claim(f.send);
    const {input:_,...stage}={...request,id:"model-input"},need={id:"need-with-progress",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}};
    const receipt={id:"source-accepted",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,
      progress:{source:{id:"original-source",revision:"1"}},next:[]};
    const participant={owner:"activity",kind:"input_need",proposal:need};
    f.send({kind:"accept",receipt,executor,expectedControlRevision:0,...(timing==="together"?{participants:[participant]}:{})});
    if(timing==="later")f.send({kind:"register_input_need",need});
    f.send({kind:"subscribe_reconsideration",subscription:{id:"replacement-supply",runId:intent.runId,owner:"context",
      binding:{kind:"input_need",id:need.id},sources:["activity-source:control:path"]}});
    expect(f.db.acceptShared(f.db.generation,{id:"check-live-consumer",scope:intent.runId,actor:"context",parts:[
      {owner:"activity",kind:"input_need_condition",proposal:{needId:need.id,expectedControlRevision:0}},
    ]}).acceptanceValue.outcome).toBe("accepted");
    expect(f.send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:1,progress:receipt.progress});
    expect(f.send({kind:"read_input_need",id:need.id})).toEqual(need);
  });
  it.each(["cancelled","supplied","unavailable"])("rejects stale supply work when its original need is %s", state=>{
    const f=open();f.send({kind:"open_path",intent});const {input:_,...stage}=request;
    f.send({kind:"register_input_need",need:{id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}}});
    const snapshot=f.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    if(state==="cancelled")f.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    else f.send({kind:"submit",request:state==="unavailable"?{...request,id:"unavailable"}:request});
    const receipt=f.db.acceptShared(f.db.generation,{id:"stale-supply",scope:intent.runId,actor:"context",parts:[
      {owner:"activity",kind:"reconsideration_acceptance",proposal:{id:"stale-supply",subscriptionId:"need:supply",expectedRevision:0,through:snapshot.through,
        factIds:snapshot.facts.map(f=>f.id),decision:{owner:"context",kind:"supply",id:"decision",revision:"1"},close:true}},
      {owner:"activity",kind:"input_need_condition",proposal:{needId:"need",expectedControlRevision:0}},
    ]}).acceptanceValue;
    expect(receipt).toMatchObject({outcome:"rejected",rejection:{code:"activity_input_need_changed"}});
    expect(f.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16})).toMatchObject({state:{closed:false,revision:0}});
    f.db.close();const restored=open(f.directory);
    expect(restored.send({kind:"read_input_need",id:"need"})).toEqual({id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}});
    expect(restored.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16})).toMatchObject({state:{closed:false,revision:0}});
  });
  it("recovers a consumer input need without giving its supplier path control or permission to change the stage",()=>{
    const f=open();f.send({kind:"open_path",intent});
    const {input:_,...stage}=request,need={id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}};
    const accept=(id:string,actor:string,kind:string,proposal:unknown)=>f.db.acceptShared(f.db.generation,{id,scope:intent.runId,actor,parts:[{owner:"activity",kind,proposal}]}).acceptanceValue;
    expect(accept("forged-need","context","input_need",need).outcome).toBe("rejected");
    expect(accept("original-need","method","input_need",need).outcome).toBe("accepted");f.db.close();
    const restored=open(f.directory);
    expect(restored.send({kind:"read_input_need",id:need.id})).toEqual(need);
    expect(restored.send({kind:"pending_scopes",afterRunId:null,limit:10})).toEqual([{runId:intent.runId}]);
    expect(restored.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16})).toMatchObject({
      state:{subscription:{owner:"context",binding:{kind:"input_need",id:"need"}}},facts:[{ref:{kind:"input_need",id:"need"}}]});
    const supply=(id:string,actor:string,proposal:unknown)=>restored.db.acceptShared(restored.db.generation,{id,scope:intent.runId,actor,parts:[{owner:"activity",kind:"stage_submission",proposal}]}).acceptanceValue;
    expect(supply("wrong-supplier","other",request).outcome).toBe("rejected");
    expect(supply("wrong-kind","context",{...request,stageKind:"check"}).outcome).toBe("rejected");
    expect(supply("extra-stage","context",{...request,id:"other-stage"}).outcome).toBe("rejected");
    expect(supply("original-supply","context",request).outcome).toBe("accepted");
    expect(supply("original-supply","context",request).outcome).toBe("accepted");
    expect(supply("replace-input","context",{...request,input:"different"}).outcome).toBe("rejected");
    expect(restored.send({kind:"read_stage",requestId:request.id})).toMatchObject({request,status:"submitted"});
  });
  it("atomically replaces an input-need subscription with a producer subscription",()=>{
    const f=open();f.send({kind:"open_path",intent});const {input:_,...stage}=request;
    f.send({kind:"register_input_need",need:{id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}}});
    const snapshot=f.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    const producerPurpose=registry.register({...purpose.contract,ref:{id:"input",revision:"1"},interpretationOwner:"context",acceptanceOwner:"context",recoveryOwner:"context"},null);
    const producer={...intent,id:"input-producer",owner:"context",purpose:producerPurpose,resourceScope:"input-producer"};
    const subscription={id:"need:producer",runId:intent.runId,owner:"context",binding:{kind:"input_need" as const,id:"need"},
      sources:["activity-source:control:path","activity-source:progress:input-producer"]};
    const proposal={id:"accept-producer",scope:intent.runId,actor:"context",parts:[
      {owner:"activity",kind:"reconsideration_acceptance",proposal:{id:"accept-producer",subscriptionId:"need:supply",expectedRevision:0,through:snapshot.through,
        factIds:snapshot.facts.map(f=>f.id),decision:{owner:"context",kind:"input_producer",id:producer.id,revision:"1"},close:true}},
      {owner:"activity",kind:"path_opening",proposal:producer},
      {owner:"activity",kind:"reconsideration_subscription",proposal:subscription}]};
    expect(f.db.acceptShared(f.db.generation,proposal).acceptanceValue.outcome).toBe("accepted");
    f.db.close();const restored=open(f.directory);
    expect(restored.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16})).toMatchObject({state:{closed:true}});
    expect(restored.send({kind:"read_reconsideration",subscriptionId:"need:producer",limit:16})).toMatchObject({state:{subscription}});
    restored.send({kind:"cancel",pathId:"path",expectedControlRevision:0});
    expect(restored.send({kind:"read_reconsideration",subscriptionId:"need:producer",limit:16})).toMatchObject({facts:[{ref:{kind:"cancelled",id:"path"}}]});
    expect(()=>restored.send({kind:"subscribe_reconsideration",subscription:{...subscription,id:"forged",owner:"other"}})).toThrow("subscription_binding_invalid");
  });
  it("cannot remove the original consumer control while observing method results",()=>{
    const f=open();f.send({kind:"open_path",intent});const {input:_,...stage}=request;
    f.send({kind:"register_input_need",need:{id:"need",supplier:"context",stage,unavailableStage:{...stage,id:"unavailable"}}});
    const snapshot=f.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16}) as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSnapshot;
    expect(()=>f.send({kind:"accept_reconsideration",receipt:{id:"drop-control",subscriptionId:"need:supply",expectedRevision:0,through:snapshot.through,
      factIds:snapshot.facts.map(f=>f.id),decision:{owner:"context",kind:"waiting",id:"same-need",revision:"1"},close:false,
      observeSources:["activity-source:progress:path"]}})).toThrow("subscription_binding_invalid");
    expect(f.send({kind:"read_reconsideration",subscriptionId:"need:supply",limit:16})).toMatchObject({state:{revision:0},facts:snapshot.facts});
  });
  it("retains per-work resource claims across replacement paths and process loss without refunding unknown work",()=>{
    const first=open(),bound={...intent,resourceLimits:{modelCalls:2,readBytes:100}};
    first.send({kind:"open_path",intent:bound});first.send({kind:"submit",request});first.send({kind:"admit",requestId:request.id,expectedControlRevision:0});
    first.send({kind:"dispatch",attempt,expectedControlRevision:0});
    const reservation={id:"claim-call",pathId:intent.id,requestId:request.id,amounts:{modelCalls:1,readBytes:60}};
    first.send({kind:"reserve_resources",reservation,expectedControlRevision:0});first.db.close();
    const recovered=open(first.directory);recovered.send({kind:"reserve_resources",reservation,expectedControlRevision:0});
    expect(recovered.send({kind:"resource_allowance",pathId:intent.id})).toEqual({limits:bound.resourceLimits,reserved:{modelCalls:1,readBytes:60}});
    recovered.send({kind:"open_path",intent:{...bound,id:"replacement"}});
    expect(recovered.send({kind:"resource_allowance",pathId:"replacement"})).toMatchObject({reserved:{modelCalls:1,readBytes:60}});
    expect(()=>recovered.send({kind:"reserve_resources",reservation:{...reservation,id:"over-budget",amounts:{readBytes:41}},expectedControlRevision:0})).toThrow("resource_limit_exceeded");
    expect(()=>recovered.send({kind:"reserve_resources",reservation:{...reservation,amounts:{readBytes:1}},expectedControlRevision:0})).toThrow("resource_identity_conflict");
    expect(()=>recovered.send({kind:"open_path",intent:{...bound,id:"extended",deadlineAt:"2031-01-01T00:00:00Z"}})).toThrow("resource_scope_conflict");
    recovered.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    expect(()=>recovered.send({kind:"reserve_resources",reservation:{...reservation,id:"after-cancel"},expectedControlRevision:1})).toThrow("cancelled");
  });
  it("does not reset a shared execution allowance when a second path is created",()=>{
    const {send}=open();
    const bound={...intent,maximumStages:2,maximumAttempts:1};
    send({kind:"open_path",intent:bound});send({kind:"submit",request});send({kind:"admit",requestId:request.id,expectedControlRevision:0});
    send({kind:"dispatch",attempt,expectedControlRevision:0});send({kind:"save_raw",result});
    send({kind:"open_path",intent:{...bound,id:"another-path"}});
    send({kind:"submit",request:{...request,id:"second",pathId:"another-path"}});send({kind:"admit",requestId:"second",expectedControlRevision:0});
    expect(()=>send({kind:"dispatch",attempt:{...attempt,id:"another-attempt",requestId:"second"},expectedControlRevision:0})).toThrow("attempt_limit");
    expect(()=>send({kind:"open_path",intent:{...bound,id:"raised-budget",maximumAttempts:2}})).toThrow("resource_scope_conflict");
  });
  it("retains pending admission and a complete response across reopening without dispatching again", () => {
    const first = open(); seed(first.send); first.send({kind:"save_raw",result}); first.db.close();
    const second = open(first.directory);
    const retained = second.send({kind:"read_stage",requestId:request.id}) as ActivityStageState;
    expect(retained.result).toEqual(result);
    expect(second.send({kind:"pending",runId:"child",after:0,limit:10})).toMatchObject([{requestId:request.id,kind:"interpretation"}]);
    expect(second.send({kind:"dispatch",attempt,expectedControlRevision:0})).toEqual({kind:"dispatch",stage:retained,granted:false});
    expect(() => second.send({kind:"dispatch",attempt:{...attempt,id:"attempt:2"},expectedControlRevision:0})).toThrow("execution_owner_stale");
  });
  it("accepts professional progress and next handoffs atomically and idempotently", () => {
    const {send} = open(); seed(send); send({kind:"save_raw",result});
    claim(send);
    const next = {...request,id:"check",stageKind:"check",dependencies:[{requestId:request.id,condition:"accepted" as const}]};
    const receipt:ActivityProcessingReceipt = {id:"receipt",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,progress:{generated:true},next:[next]};
    send({kind:"accept",receipt,executor,expectedControlRevision:0});
    send({kind:"accept",receipt,executor,expectedControlRevision:0});
    expect(send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:1,dispatchedAttempts:1,progress:{generated:true}});
    expect(send({kind:"pending",runId:"child",after:0,limit:10})).toMatchObject([{requestId:"check",kind:"admission"}]);
    expect(() => send({kind:"accept",receipt:{...receipt,progress:{generated:false}},executor,expectedControlRevision:0})).toThrow("identity_conflict");
  });
  it("rolls back progress when a proposed continuation is invalid", () => {
    const {send} = open(); seed(send); send({kind:"save_raw",result});
    claim(send);
    const receipt = {id:"receipt",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,progress:{done:true},next:[{...request,id:"next",capabilities:["undelegated"]}]};
    expect(() => send({kind:"accept",receipt,executor,expectedControlRevision:0})).toThrow("not_delegated");
    expect(send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0,progress:null});
    expect(send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"raw_result",receipt:null});
  });
  it("shares prepared immutable content across progress and stage participants in one acceptance",()=>{
    const {send}=open();seed(send);send({kind:"save_raw",result});claim(send);
    const receipt={id:"joined",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,progress:{inputAccepted:true,nested:{value:"new immutable progress"}},next:[]};
    const next={...request,id:"accepted-input-dispatch",stageKind:"check",input:{exact:"frozen input"}};
    const command={kind:"accept" as const,receipt,executor,expectedControlRevision:0,participants:[{owner:"activity",kind:"stage_submission",proposal:next}]};
    send(command);send(command);
    expect(send({kind:"read_path",pathId:"path"})).toMatchObject({progressRevision:1,progress:receipt.progress});
    expect(send({kind:"read_stage",requestId:next.id})).toMatchObject({request:next,status:"submitted"});
  });
  it("shares newly accepted progress with a subsequent closure without reading unprepared bodies",()=>{
    const {send}=open();seed(send);send({kind:"save_raw",result});claim(send);
    const receipt={id:"accepted-and-closed",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,
      progress:{completed:true,evidence:"original result retained"},next:[]};
    send({kind:"accept",receipt,executor,expectedControlRevision:0,participants:[
      {owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:intent.id,expectedControlRevision:0}},
    ]});
    expect(send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:true,controlRevision:1,progressRevision:1,progress:receipt.progress});
    expect(send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"accepted",result,receipt});
  });
  it("preserves late evidence after cancellation without allowing stale advancement", () => {
    const {send} = open(); seed(send); send({kind:"cancel",pathId:intent.id,expectedControlRevision:0}); send({kind:"save_raw",result});
    expect(send({kind:"read_stage",requestId:request.id})).toMatchObject({result});
    expect(() => send({kind:"accept",receipt:{id:"receipt",requestId:request.id,resultId:result.id,owner:"method",expectedProgressRevision:0,progress:{},next:[]},executor,expectedControlRevision:0})).toThrow("cancelled");
  });
  it("keeps unknown/partial outcomes unresolved and does not consume slots on dependency waits", () => {
    const {send} = open(); seed(send);
    send({kind:"save_raw",result:{...result,id:"partial",completeness:"partial"}});
    send({kind:"save_raw",result:{...result,id:"unknown",outcome:"unknown"}});
    expect(send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"dispatched",result:null});
    const next = {...request,id:"next",dependencies:[{requestId:request.id,condition:"accepted" as const}]};
    send({kind:"submit",request:next}); send({kind:"admit",requestId:"next",expectedControlRevision:0});
    expect(() => send({kind:"dispatch",attempt:{...attempt,id:"attempt:next",requestId:"next"},expectedControlRevision:0})).toThrow("dependency_waiting");
    expect(send({kind:"read_path",pathId:intent.id})).toMatchObject({dispatchedAttempts:1});
  });
  it.each(["before", "after"])("settles a raw result cancelled %s persistence without advancing professional progress", timing => {
    const first=open();seed(first.send);
    if(timing==="before")first.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    first.send({kind:"save_raw",result});
    if(timing==="after")first.send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    expect(first.send({kind:"pending",runId:intent.runId,after:0,limit:10})).toMatchObject([{kind:"settlement",requestId:request.id}]);
    first.db.close();
    const recovered=open(first.directory),current={...executor,generation:recovered.db.generation};
    const receipt={id:"settlement",requestId:request.id,resultId:result.id,owner:"method",disposition:{retained:result.id}};
    const command={kind:"settle" as const,receipt,executor:current,expectedControlRevision:1};
    expect(()=>recovered.send({...command,executor})).toThrow("processing_owner_stale");
    expect(()=>recovered.send({...command,expectedControlRevision:0})).toThrow("settlement_conflict");
    // A rejected acceptance has its own identity, just as a lost successful receipt does.
    const accepted={...command,receipt:{...receipt,id:"settlement-accepted"}};
    recovered.send(accepted);recovered.send(accepted);
    expect(recovered.send({kind:"read_stage",requestId:request.id})).toMatchObject({status:"settled",result,settlement:accepted.receipt,receipt:null});
    expect(recovered.send({kind:"read_path",pathId:intent.id})).toMatchObject({cancelled:true,progressRevision:0,progress:null,dispatchedAttempts:1});
    expect(recovered.send({kind:"pending",runId:intent.runId,after:0,limit:10})).toEqual([]);
    expect(()=>recovered.send({...accepted,receipt:{...accepted.receipt,disposition:"changed"}})).toThrow();
  });
  it("cannot settle unknown effects or submit successors through settlement",()=>{
    const {send}=open();seed(send);send({kind:"cancel",pathId:intent.id,expectedControlRevision:0});
    send({kind:"save_raw",result:{...result,id:"unknown",outcome:"unknown"}});
    const command={kind:"settle" as const,receipt:{id:"unknown-settlement",requestId:request.id,resultId:"unknown",owner:"method",disposition:{}},executor,expectedControlRevision:1};
    expect(()=>send(command)).toThrow("settlement_conflict");
    expect(send({kind:"pending",runId:intent.runId,after:0,limit:10})).toMatchObject([{kind:"reconciliation"}]);
    send({kind:"save_raw",result});
    expect(()=>send({...command,receipt:{...command.receipt,id:"forbidden-successor",resultId:result.id},participants:[
      {owner:"activity",kind:"stage_submission",proposal:{...request,id:"new-work"}},
    ]})).toThrow("settlement_continuation_forbidden");
    expect(send({kind:"read_stage",requestId:"new-work"})).toBeNull();
    expect(send({kind:"read_path",pathId:intent.id})).toMatchObject({progressRevision:0});
  });
  it("rejects changed intents and does not merge distinct identities sharing bytes", () => {
    const {send} = open(); send({kind:"open_path",intent}); send({kind:"submit",request});
    expect(() => send({kind:"submit",request:{...request,input:"changed"}})).toThrow("identity_conflict");
    send({kind:"submit",request:{...request,id:"same-content-new-intent"}});
    expect(send({kind:"pending",runId:"child",after:0,limit:10})).toHaveLength(2);
  });
  it("waits on another professional path in the same Run without acquiring an attempt",()=>{
    const {send}=open();seed(send);
    send({kind:"open_path",intent:{...intent,id:"consumer",resourceScope:"consumer"}});
    const consumer={...request,id:"consumer-stage",pathId:"consumer",dependencies:[{requestId:request.id,condition:"raw_result" as const}]};
    send({kind:"submit",request:consumer});send({kind:"admit",requestId:consumer.id,expectedControlRevision:0});
    const consumerAttempt={...attempt,id:"consumer-attempt",requestId:consumer.id};
    expect(()=>send({kind:"dispatch",attempt:consumerAttempt,expectedControlRevision:0})).toThrow("dependency_waiting");
    expect(send({kind:"read_path",pathId:"consumer"})).toMatchObject({dispatchedAttempts:0});
    send({kind:"save_raw",result});
    expect(send({kind:"dispatch",attempt:consumerAttempt,expectedControlRevision:0})).toMatchObject({granted:true});
    send({kind:"open_path",intent:{...intent,id:"other-run",runId:"parent",resourceScope:"other-run"}});
    expect(()=>send({kind:"submit",request:{...consumer,id:"implicit-delivery",pathId:"other-run"}})).toThrow("dependency_scope_invalid");
    expect(()=>send({kind:"submit",request:{...request,id:"cycle-entry",dependencies:[{requestId:"not-created",condition:"accepted"}]}})).toThrow("stage_missing");
  });
});
