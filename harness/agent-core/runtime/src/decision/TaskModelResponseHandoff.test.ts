import {describe, expect, it} from "vitest";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffCommand, ActivityHandoffPort, ActivityStageState} from "../activity/ActivityHandoff.js";
import {TASK_MODEL_RESPONSE_PURPOSE, type TaskModelSource} from "./TaskModelResponsePath.js";
import {createTaskModelResponseHandoff, readTaskModelResponseHandoff} from "./TaskModelResponseHandoff.js";

function fixture() {
  const body = {version: 1, source: {runId: "root", agent: {id: "agent", revision: "1"}, toolExposure: {controllerRequestId: "request"}}};
  const source = {kind: "task_model_source", record: {...body, id: `task-source:${modelInputValueDigest(body)}`},
    request: {correlation: {controllerRequestId: "request"}}, protocol: {kind: "native_tool_turn"}} as unknown as TaskModelSource;
  const handoff = createTaskModelResponseHandoff("task", source);
  const progress = {kind: "task_model_response", sourceStageId: "task:source", rawResultId: "raw", inputId: "task:model:input",
    state: "interpreted", proposal: {kind: "propose_completion", output: {summary: "Original"}}, failure: null};
  const path = {intent: {id: "task", runId: "root", owner: "task-decision",
    purpose: {contract: TASK_MODEL_RESPONSE_PURPOSE, digest: modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)}},
    controlRevision: 0, cancelled: false, progress: {kind: "some_later_progress"}};
  const original = {request: {id: "task:source", pathId: "task", stageKind: "source", input: source}, status: "accepted"};
  const stage = {request: {id: "task:model", pathId: "task", stageKind: "model"}, status: "accepted", result: {id: "raw", completeness: "complete", outcome: "returned"},
    receipt: {id: "accepted-result", requestId: "task:model", resultId: "raw", owner: "task-decision", progress}};
  const commands: ActivityHandoffCommand[] = [];
  const activities: ActivityHandoffPort = {async command(command) {
    commands.push(command);
    if (command.kind === "read_path") return structuredClone(path);
    if(command.kind==="read_input_need")return {id:"task:input-need",supplier:"context-representation",
      stage:{id:"task:model",pathId:"task"},unavailableStage:{id:"task:input-unavailable",pathId:"task"}};
    if (command.kind === "read_stage") return structuredClone(command.requestId.endsWith(":source") ? original : command.requestId==="task:model"?stage:null);
    throw new Error("Result observation cannot issue work");
  }};
  return {source, handoff, path, original, stage, progress, commands, activities};
}

describe("TaskModelResponseHandoff", () => {
  it.each(["valid","source","supplier","evidence","response","both","settled","bad-settlement"])("observes a local input limitation without a model response (%s)",async change=>{
    const f=fixture(),limitation={kind:"context_input_unavailable",needId:"task:input-need",supplier:"context-representation",boundary:"H",reason:"no_supported_complete_path",
      evidence:[{owner:"context-representation",kind:"decision",id:"original",revision:"4"}]};
    const stage={request:{id:"task:input-unavailable",pathId:"task",stageKind:"input-unavailable",capabilities:[],dependencies:[],input:limitation},status:"accepted",
      result:{id:"limitation-raw",completeness:"complete",outcome:"returned",value:{kind:"input_limitation_recorded",digest:modelInputValueDigest(limitation)}},
      receipt:{id:"limitation-accepted",owner:"task-decision",requestId:"task:input-unavailable",resultId:"limitation-raw",
        progress:{kind:"task_input_unavailable",sourceStageId:"task:source",rawResultId:"limitation-raw",limitation:structuredClone(limitation)}}};
    if(change==="source")f.original.status="submitted";
    if(change==="supplier")limitation.supplier="sibling";
    if(change==="evidence")stage.receipt.progress.limitation.evidence[0]!.id="different";
    if(change==="response")stage.result.value.digest="different";
    if(change==="settled"||change==="bad-settlement")Object.assign(stage,{status:"settled",receipt:null,settlement:{id:"settlement",owner:change==="settled"?"task-decision":"wrong-owner",
      requestId:stage.request.id,resultId:stage.result.id,disposition:{kind:"retained_task_result",resultId:stage.result.id,decisionAccepted:false,response:null}}});
    const activities={command:async(c:ActivityHandoffCommand)=>c.kind==="read_stage"&&c.requestId==="task:input-unavailable"?stage:
      c.kind==="read_stage"&&c.requestId==="task:model"&&change!=="both"?null:f.activities.command(c)} as ActivityHandoffPort;
    if(change==="valid")expect(await readTaskModelResponseHandoff(activities,f.handoff)).toMatchObject({kind:"input_unavailable",progress:stage.receipt.progress});
    else if(change==="settled")expect(await readTaskModelResponseHandoff(activities,f.handoff)).toMatchObject({kind:"consumer_closed",stage:{status:"settled"}});
    else await expect(readTaskModelResponseHandoff(activities,f.handoff)).rejects.toThrow();
  });
  it("reads the original accepted stage, not a later path progress or the current control decision", async () => {
    const f = fixture();
    f.path.cancelled = true; f.path.controlRevision = 1;
    const result = await readTaskModelResponseHandoff(f.activities, JSON.parse(JSON.stringify(f.handoff)));
    expect(result).toMatchObject({kind: "accepted", control: {cancelled: true, revision: 1}, progress: f.progress});
    expect(f.commands.map(command => command.kind)).toEqual(["read_path", "read_stage", "read_input_need", "read_stage", "read_stage", "read_stage"]);
  });
  it.each([false, true])("distinguishes pending input from a closed consumer (cancelled=%s)", async cancelled => {
    const f = fixture(); f.path.cancelled = cancelled;
    const activities: ActivityHandoffPort = {async command(command) {
      if (command.kind === "read_stage" && command.requestId === "task:model") return null;
      return f.activities.command(command);
    }};
    expect(await readTaskModelResponseHandoff(activities, f.handoff))
      .toMatchObject({kind: cancelled ? "consumer_closed" : "pending", stage: null});
  });
  it("does not mistake cancellation for completed in-flight settlement", async () => {
    const f = fixture(); f.path.cancelled = true; f.stage.status = "raw_result";
    expect(await readTaskModelResponseHandoff(f.activities, f.handoff))
      .toMatchObject({kind: "consumer_closed", stage: {status: "raw_result", result: {id: "raw"}}});
  });
  it.each([false, true])("reads independent settlement without claiming professional acceptance (response=%s)", async hasResponse => {
    const f = fixture(); f.path.cancelled = true;
    const stage = f.stage as unknown as ActivityStageState;
    Object.assign(stage, {status: "settled", receipt: null, settlement: {id: "settled", requestId: stage.request.id,
      resultId: "raw", owner: "task-decision", disposition: {kind: "retained_task_result", resultId: "raw", decisionAccepted: false,
        response: hasResponse ? f.progress : null}}});
    expect(await readTaskModelResponseHandoff(f.activities, f.handoff)).toMatchObject({kind: hasResponse ? "settled_response" : "consumer_closed"});
    expect(stage.receipt).toBeNull();
  });
  it.each(["owner", "request", "result", "decision"])("rejects changed %s settlement even without a response", async changed => {
    const f = fixture();
    const settlement = {id: "settled", requestId: "task:model", resultId: "raw", owner: "task-decision",
      disposition: {kind: "retained_task_result", resultId: "raw", decisionAccepted: false, response: null}};
    if (changed === "owner") settlement.owner = "other";
    if (changed === "request") settlement.requestId = "other";
    if (changed === "result") settlement.resultId = "other";
    if (changed === "decision") settlement.disposition.decisionAccepted = true;
    Object.assign(f.stage, {status: "settled", receipt: null, settlement});
    await expect(readTaskModelResponseHandoff(f.activities, f.handoff)).rejects.toMatchObject({name: "TaskResponseBindingError"});
  });
  it.each(["run", "source", "request", "protocol", "body", "purpose", "stage", "owner", "raw", "partial", "input", "progress"])("rejects changed %s binding", async changed => {
    const f = fixture();
    if (changed === "run") f.path.intent.runId = "child";
    if (changed === "source") f.handoff = {...f.handoff, sourceId: "other-source"};
    if (changed === "request") f.handoff = {...f.handoff, controllerRequestId: "other-request"};
    if (changed === "protocol") f.original.request.input = {...f.source, protocol: {kind: "structured_output"}};
    if (changed === "body") f.original.request.input = {...f.source, request: {...f.source.request, requestId: "different-original-request"}};
    if (changed === "purpose") f.handoff = {...f.handoff, purposeDigest: "other-purpose"};
    if (changed === "stage") f.stage.request.pathId = "other-task";
    if (changed === "owner") f.stage.receipt.owner = "context-representation";
    if (changed === "raw") f.stage.receipt.resultId = "other-raw";
    if (changed === "partial") f.stage.result.completeness = "partial";
    if (changed === "input") f.progress.inputId = "other-input";
    if (changed === "progress") f.progress.state = "some_later_progress";
    await expect(readTaskModelResponseHandoff(f.activities, f.handoff)).rejects.toMatchObject({name: "TaskResponseBindingError"});
  });
});
