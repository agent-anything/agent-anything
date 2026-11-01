import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {TaskModelResponseLifecycle} from "./TaskModelResponseLifecycle.js";
import {TASK_MODEL_RESPONSE_PURPOSE as purpose} from "./TaskModelResponsePath.js";
import type {ActivityHandoffPort,ActivityReconsiderationSnapshot} from "../activity/index.js";

function fixture() {
  const path={intent:{id:"task",runId:"root",owner:purpose.acceptanceOwner,purpose:{contract:purpose,digest:digest(purpose)},scheduledWorkId:"work",maximumStages:8},
    controlRevision:0,progressRevision:2,cancelled:false};
  const work={intent:{workId:"work",runId:"root",owner:purpose.acceptanceOwner,allowedPathIds:["task"]},pathsSealed:true,revision:2};
  const need={id:"task:input-need",supplier:purpose.inputOwner,stage:{id:"task:model",pathId:"task"},unavailableStage:{id:"task:input-unavailable",pathId:"task"}};
  const stages=new Map<string,{request:{pathId:string;stageKind:string};status:string}>([
    ["task:source",{request:{pathId:"task",stageKind:"source"},status:"accepted"}],
    ["task:model",{request:{pathId:"task",stageKind:"model"},status:"accepted"}]]);
  const settlement:{revision:number;remaining:unknown}={revision:2,remaining:null};
  const activities={async command(command:{kind:string;requestId?:string}) {
    if(command.kind==="read_path")return path;
    if(command.kind==="read_schedule")return work;
    if(command.kind==="read_input_need")return need;
    if(command.kind==="read_stage")return stages.get(command.requestId!)??null;
    if(command.kind==="scheduled_settlement")return settlement;
    throw new Error(command.kind);
  }} as ActivityHandoffPort;
  const snapshot={state:{subscription:{id:"task:response-lifecycle",runId:"root",owner:purpose.acceptanceOwner,binding:{kind:"activity_path",id:"task"}}}} as ActivityReconsiderationSnapshot;
  const run=()=>new TaskModelResponseLifecycle(activities).prepare(snapshot,new AbortController().signal);
  return {path,work,stages,settlement,snapshot,run};
}

describe("independent task response lifecycle",()=>{
  it("closes settled model work without completing the task or modifying its accepted response",async()=>{
    const f=fixture(),original=structuredClone(f.stages),result=await f.run();
    expect(result.close).toBe(true);expect(result.decision.kind).toBe("task_response_work_closed");
    expect(result.participants.map(p=>p.kind)).toEqual(["path_condition","scheduling_closure","fact_publication"]);
    expect(result.participants[1]!.proposal).toMatchObject({workId:"work",expectedRevision:2,requireSettled:true});
    expect(f.stages).toEqual(original);
  });
  it.each(["stage","input_need","occupancy"])("retains its responsibility while %s remains unsettled",async kind=>{
    const f=fixture();f.settlement.remaining={kind};const result=await f.run();
    expect(result.close).toBe(false);expect(result.participants).toHaveLength(1);
  });
  it("does not close merely because the source was accepted and no request has dispatched",async()=>{
    const f=fixture();f.stages.delete("task:model");expect((await f.run()).close).toBe(false);
  });
  it("closes cancelled work only after settlement, not just after a cancellation request",async()=>{
    const f=fixture();f.path.cancelled=true;f.stages.delete("task:model");f.settlement.remaining={kind:"occupancy"};
    expect((await f.run()).close).toBe(false);f.settlement.remaining=null;expect((await f.run()).close).toBe(true);
  });
  it.each(["source","stage","outcomes","owner","schedule"])("rejects changed %s ownership or outcomes",async change=>{
    const f=fixture();
    if(change==="source")f.stages.delete("task:source");
    if(change==="stage")f.stages.get("task:model")!.request.stageKind="other";
    if(change==="outcomes")f.stages.set("task:input-unavailable",{request:{pathId:"task",stageKind:"input-unavailable"},status:"accepted"});
    if(change==="owner")f.path.intent.owner="other";
    if(change==="schedule")f.work.intent.allowedPathIds.push("unrelated");
    await expect(f.run()).rejects.toThrow("task_response_lifecycle_");
  });
});
