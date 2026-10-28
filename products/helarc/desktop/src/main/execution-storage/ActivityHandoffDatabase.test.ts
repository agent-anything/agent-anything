import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {ActivityPurposeRegistry, type ActivityHandoffCommand, type ActivityStageState, type ActivityProcessingReceipt} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ExecutionDatabase} from "./ExecutionDatabase.js";

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
function seed(send:ReturnType<typeof open>["send"]) {
  send({kind:"open_path",intent}); send({kind:"submit",request}); send({kind:"admit",requestId:request.id,expectedControlRevision:0});
  send({kind:"dispatch",attempt,expectedControlRevision:0});
}
function claim(send:ReturnType<typeof open>["send"]) {
  send({kind:"claim_processing",claim:{id:"claim:1",requestId:request.id,previousClaimId:null,executor},expectedControlRevision:0});
}
describe("durable activity handoff", () => {
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
  it("rejects changed intents and does not merge distinct identities sharing bytes", () => {
    const {send} = open(); send({kind:"open_path",intent}); send({kind:"submit",request});
    expect(() => send({kind:"submit",request:{...request,input:"changed"}})).toThrow("identity_conflict");
    send({kind:"submit",request:{...request,id:"same-content-new-intent"}});
    expect(send({kind:"pending",runId:"child",after:0,limit:10})).toHaveLength(2);
  });
});
