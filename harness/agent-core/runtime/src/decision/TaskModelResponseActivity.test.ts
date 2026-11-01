import {describe, expect, it, vi} from "vitest";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort, ActivityPathState, ActivityStageState} from "../activity/ActivityHandoff.js";
import type {SharedAcceptancePort, SharedAcceptanceReceipt} from "../activity/SharedAcceptance.js";
import type {AgentActivityExecutionContext, TaskDecisionInputSources} from "./TaskDecisionActivity.js";
import {retainTaskDecisionSource} from "./TaskDecisionSourceRecord.js";
import {TASK_MODEL_RESPONSE_PURPOSE, type TaskModelResponseWork, type TaskModelSource} from "./TaskModelResponsePath.js";
import {TaskModelResponseActivity, type TaskModelResponseSubmission} from "./TaskModelResponseActivity.js";

function fixture() {
  const input = {runId: "root", agent: {id: "agent", revision: "1", output: {validate: () => ({valid: true})}},
    toolExposure: {controllerRequestId: "request"}} as unknown as TaskDecisionInputSources;
  const source = {kind: "task_model_source", record: retainTaskDecisionSource(input),
    request: {correlation: {controllerRequestId: "request"}}, protocol: {kind: "native_tool_turn"}} as TaskModelSource;
  const purpose = {contract: TASK_MODEL_RESPONSE_PURPOSE, digest: modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)};
  const proposal = {kind: "propose_completion", candidates: [], completionSource: {kind: "controller"}, output: {summary: "Original"}, modelItems: []};
  const progress = {kind: "task_model_response", sourceStageId: "task:source", rawResultId: "raw", inputId: "task:model:input", state: "interpreted", proposal, failure: null};
  const path = {intent: {id: "task", runId: "root", owner: "task-decision", purpose}, controlRevision: 0, cancelled: false} as ActivityPathState;
  const original = {request: {id: "task:source", pathId: "task", stageKind: "source", input: source}, status: "accepted"} as ActivityStageState;
  let stage: ActivityStageState | null = {request: {id: "task:model", pathId: "task", stageKind: "model"}, status: "accepted",
    result: {id: "raw", completeness: "complete", outcome: "returned"}, receipt: {id: "acceptance", requestId: "task:model", resultId: "raw", owner: "task-decision", progress}} as ActivityStageState;
  let unavailable:ActivityStageState|null=null;
  const listeners = new Set<() => void>(), records = new Map<string, unknown>(), order: string[] = [];
  let receipt: SharedAcceptanceReceipt | null = null;
  const changed = () => {for (const listener of listeners) listener();};
  const activities: ActivityHandoffPort = {command: vi.fn(async command => {
    order.push(command.kind);
    if (command.kind === "read_path") return structuredClone(path);
    if(command.kind==="read_input_need")return {id:"task:input-need",supplier:"context-representation",
      stage:{id:"task:model",pathId:"task"},unavailableStage:{id:"task:input-unavailable",pathId:"task"}};
    if (command.kind === "read_stage") return structuredClone(command.requestId === "task:source" ? original : command.requestId==="task:model"?stage:command.requestId==="task:input-unavailable"?unavailable:null);
    if (command.kind === "cancel") {Object.assign(path, {cancelled: true, controlRevision: path.controlRevision + 1}); changed(); return structuredClone(path);}
    throw new Error("Consumer must not execute producer work");
  })};
  const acceptance: SharedAcceptancePort = {query: vi.fn(async () => receipt), accept: vi.fn(async value => {
    expect(records.size).toBe(1); order.push("accept");
    const digest = modelInputValueDigest(value);
    if (receipt && receipt.digest !== digest) throw new Error("acceptance_identity_conflict");
    receipt ??= {id: value.id, digest, sequence: 1, scope: value.scope, outcome: "accepted", rejection: null};
    return receipt;
  })};
  const cancellation = new AbortController();
  const context = {checkpoints: {read: (key: string) => structuredClone(records.get(key) ?? null),
    commit: vi.fn(async (key: string, value: unknown) => {order.push("checkpoint"); records.set(key, structuredClone(value));})},
    cancellation: {signal: cancellation.signal, request: null}, retry: {deadlineAt: new Date(Date.now() + 10000).toISOString()}} as unknown as AgentActivityExecutionContext;
  const work = {purpose, prepareSubmission: vi.fn((identity, value) => [
    {owner: "activity", kind: "path_opening", proposal: {...identity, purpose, owner: "task-decision"}},
    {owner: "activity", kind: "stage_submission", proposal: {...original.request, input: value}},
  ])} as unknown as TaskModelResponseWork;
  const ports = {work, activities, acceptance, resourceMetering: {modelInputTokens: "not_applicable", modelOutputTokens: "not_applicable", costUnits: "not_applicable"} as const,
    prepare: vi.fn(async () => ({identity: {id: "task", runId: "root", scheduledWorkId: "task-work"}, source,
      schedule: {workId: "task-work", owner: "task-decision", runId: "root"}} as TaskModelResponseSubmission)),
    host: {assertAvailable: vi.fn(), subscribe: (listener: () => void) => {order.push("subscribe"); listeners.add(listener); return () => {listeners.delete(listener);};}, wake: changed},
    rediscoveryMs: 5, settlementWaitMs: 100};
  return {input, context, source, path, proposal, progress, records, listeners, order, activities, acceptance, ports, cancellation,
    activity: new TaskModelResponseActivity(ports), setStage: (value: ActivityStageState | null, notify = true) => {stage = value; if (notify) changed();},
    stage: stage!, setUnavailable:(value:ActivityStageState)=>{stage=null;unavailable=value;changed();},setReceipt: (value: SharedAcceptanceReceipt) => {receipt = value;}};
}

describe("TaskModelResponseActivity", () => {
  it("recovers the original input limitation without re-preparing or claiming a Provider failure",async()=>{
    const f=fixture(),limitation={kind:"context_input_unavailable",needId:"task:input-need",supplier:"context-representation",boundary:"H",reason:"original_reception_unsupported",
      evidence:[{owner:"context-representation",kind:"decision",id:"decision",revision:"4"}]};
    f.setUnavailable({request:{id:"task:input-unavailable",pathId:"task",stageKind:"input-unavailable",capabilities:[],dependencies:[],input:limitation},status:"accepted",
      result:{id:"limitation-raw",completeness:"complete",outcome:"returned",value:{kind:"input_limitation_recorded",digest:modelInputValueDigest(limitation)}},
      receipt:{id:"limitation-accepted",owner:"task-decision",requestId:"task:input-unavailable",resultId:"limitation-raw",
        progress:{kind:"task_input_unavailable",sourceStageId:"task:source",rawResultId:"limitation-raw",limitation}}} as unknown as ActivityStageState);
    const expected={operationSettlement:"settled_failure",failure:{kind:"input_preparation",failure:{code:"context_input_unavailable",retryable:false,
      metadata:{rawResultId:"limitation-raw",acceptanceId:"limitation-accepted",limitation}}}};
    await expect(f.activity.next(f.input,f.context)).rejects.toMatchObject(expected);
    f.ports.prepare.mockRejectedValue(new Error("Source must not be rebuilt"));
    await expect(new TaskModelResponseActivity(f.ports).recover(f.input,f.context)).rejects.toMatchObject(expected);
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);expect(f.acceptance.accept).toHaveBeenCalledTimes(2);expect(f.listeners.size).toBe(0);
    expect(vi.mocked(f.acceptance.accept).mock.calls[0]).toEqual(vi.mocked(f.acceptance.accept).mock.calls[1]);
    expect(await f.activity.interrupt(f.input,f.context)).toBeNull();expect(f.path.cancelled).toBe(true);
  });
  it("retains before admission and reads accepted original work after restart without preparing again", async () => {
    const f = fixture();
    expect(await f.activity.next(f.input, f.context)).toEqual(f.proposal);
    expect(f.order.indexOf("checkpoint")).toBeLessThan(f.order.indexOf("accept"));
    expect(f.order.indexOf("subscribe")).toBeLessThan(f.order.indexOf("read_path"));
    f.ports.prepare.mockRejectedValue(new Error("Current source construction is forbidden"));
    expect(await new TaskModelResponseActivity(f.ports).recover(f.input, f.context)).toEqual(f.proposal);
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    expect(f.activities.command).not.toHaveBeenCalledWith(expect.objectContaining({kind: "dispatch"}));
  });
  it("does not submit when the delegation checkpoint acknowledgement is lost", async () => {
    const f = fixture();
    const commit = f.context.checkpoints!.commit;
    const context = {...f.context, checkpoints: {...f.context.checkpoints!, commit: async (key: string, value: unknown) => {await commit(key, value); throw new Error("lost checkpoint acknowledgement");}}};
    await expect(f.activity.next(f.input, context)).rejects.toThrow("lost checkpoint");
    expect(f.acceptance.accept).not.toHaveBeenCalled();
    expect(await f.activity.recover(f.input, f.context)).toEqual(f.proposal);
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  });
  it("replays exactly the same admission after a lost acceptance acknowledgement", async () => {
    const f = fixture(), accept = f.acceptance.accept;
    let lost = false;
    f.acceptance.accept = vi.fn(async value => {const receipt = await accept(value); if (!lost) {lost = true; throw new Error("lost admission");} return receipt;});
    await expect(f.activity.next(f.input, f.context)).rejects.toThrow("lost admission");
    expect(await f.activity.recover(f.input, f.context)).toEqual(f.proposal);
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  });
  it("rediscovers a result without a notification and releases its listener", async () => {
    const f = fixture(); f.setStage(null);
    const received = f.activity.next(f.input, f.context);
    await vi.waitFor(() => expect(f.listeners.size).toBe(1));
    f.setStage(f.stage, false);
    expect(await received).toEqual(f.proposal);
    expect(f.listeners.size).toBe(0);
  });
  it("does not create work when interrupted before admission", async () => {
    const f = fixture();
    expect(await f.activity.interrupt(f.input, f.context)).toBeNull();
    expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.acceptance.accept).not.toHaveBeenCalled();
  });
  it("closes original work but still delivers the response accepted before cancellation", async () => {
    const f = fixture(); await f.activity.next(f.input, f.context);
    expect(await f.activity.interrupt(f.input, f.context)).toEqual(f.proposal);
    expect(f.path.cancelled).toBe(true); expect(f.acceptance.accept).toHaveBeenCalledTimes(1);
  });
  it("waits only for known local settlement and receives it without professional advancement", async () => {
    const f = fixture(); await f.activity.next(f.input, f.context);
    f.setStage({...f.stage, status: "raw_result", receipt: null});
    const received = f.activity.interrupt(f.input, f.context);
    await vi.waitFor(() => expect(f.listeners.size).toBe(1));
    f.setStage({...f.stage, status: "settled", receipt: null, settlement: {id: "settled", requestId: "task:model", resultId: "raw", owner: "task-decision",
      disposition: {kind: "retained_task_result", resultId: "raw", decisionAccepted: false, response: f.progress}}});
    expect(await received).toEqual(f.proposal); expect(f.listeners.size).toBe(0);
  });
  it("does not wait for or fabricate an unknown remote response after closing", async () => {
    const f = fixture(); await f.activity.next(f.input, f.context);
    f.setStage({...f.stage, status: "dispatched", receipt: null, result: null});
    expect(await f.activity.interrupt(f.input, f.context)).toBeNull();
    expect(f.path.cancelled).toBe(true); expect(f.acceptance.accept).toHaveBeenCalledTimes(1);
  });
  it("cannot recover against changed original sources", async () => {
    const f = fixture(); await f.activity.next(f.input, f.context);
    await expect(f.activity.recover({...f.input, iteration: 99}, f.context)).rejects.toThrow("checkpoint_binding_changed");
    expect(f.acceptance.accept).toHaveBeenCalledTimes(1);
  });
  it("cleans observation resources after a bounded wait without resending", async () => {
    const f = fixture(); f.setStage(null);
    await expect(f.activity.next(f.input, {...f.context, retry: {...f.context.retry, deadlineAt: new Date(Date.now() + 40).toISOString()}}))
      .rejects.toMatchObject({failure: {failure: {code: "model_operation_deadline_exceeded"}}});
    expect(f.listeners.size).toBe(0); expect(f.acceptance.accept).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["provider_context_window_exceeded", "invalid_request", "provider_context_window_exceeded"],
    ["request_timed_out", "timeout", "provider_timeout"],
    ["connection_lost", "transport", "provider_request_failed"],
  ])("preserves transport attribution for %s", async (code, category, expected) => {
    const f = fixture();
    f.setStage({...f.stage, receipt: {...f.stage.receipt!, progress: {...f.progress, state: "transport_result", proposal: null,
      failure: {kind: "failed", failure: {code, category, message: "Original transport failure", metadata: {attempt: "original"}}}}}});
    await expect(f.activity.next(f.input, f.context)).rejects.toMatchObject({operationSettlement: "settled_failure",
      failure: {kind: "provider", failure: {code: expected, category, message: "Original transport failure", metadata: {originalCode: code, attempt: "original"}}}});
    expect(f.acceptance.accept).toHaveBeenCalledTimes(1);
  });
  it("does not label one incomplete response as an exhausted recovery allowance", async () => {
    const f = fixture();
    f.setStage({...f.stage, receipt: {...f.stage.receipt!, progress: {...f.progress, state: "response_incomplete", proposal: null, failure: null}}});
    await expect(f.activity.next(f.input, f.context)).rejects.toMatchObject({failure: {kind: "model", failure: {code: "model_output_incomplete"}}});
  });
});
