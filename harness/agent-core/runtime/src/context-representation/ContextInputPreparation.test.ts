import {describe,expect,it,vi} from "vitest";
import type {Provider} from "@agent-anything/model-interaction";
import {RemoteInputMeasurementNotDispatchedError,modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import type {ActivityPathState,ActivityStageState,ActivityAttempt} from "../activity/ActivityHandoff.js";
import {ContextInputPreparationHandler,CONTEXT_INPUT_PREPARATION_PURPOSE} from "./ContextInputPreparation.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";

describe("input preparation authorization",()=>{
  it.each(["allowed","temporary","denied"] as const)("propagates %s from local, measurement and settlement paths",async kind=>{
    const result=kind==="allowed"?{kind}:kind==="temporary"?{kind,code:"pending",message:"Await authority"}:
      {kind,code:"denied",message:"Authority revoked",decision:{owner:"host",id:"denial",revision:"1"}};
    const authorize=vi.fn<ActivityPurposeHandler["authorize"]>(async()=>result),verifyEncodedInput=vi.fn();
    const provider={descriptor:{id:"provider"},modelContext:{target:{model:"model"}},encodeInput:vi.fn(),verifyEncodedInput,
      inputMeasurement:{revision:"count:1"}} as unknown as Provider;
    const handler=new ContextInputPreparationHandler({provider,materials:{} as MaterialCustodyPort,authorize,now:()=>"2026-10-31T00:00:00Z"});
    const path={intent:{runId:"run",purpose:{contract:CONTEXT_INPUT_PREPARATION_PURPOSE,digest:modelInputValueDigest(CONTEXT_INPUT_PREPARATION_PURPOSE)}}} as ActivityPathState;
    const input={request:{kind:"context_input_preparation",demand:{runId:"run",purpose:"task",targetRevision:"target"},
      template:{purpose:"task",composition:{providerId:"provider",model:"model"}},materialAccesses:[]},progress:{},
      pending:{request:{},encoded:{id:"encoded"},remote:{methodRevision:"count:1",encodedInputId:"encoded",targetRevision:"target"}}};
    const signal=new AbortController().signal;
    for(const stageKind of ["organize","measure"])for(const action of ["admission","execution","reconciliation","interpretation","settlement"] as const) {
      const stage={request:{stageKind,input}} as ActivityStageState;
      expect(await handler.authorize(path,stage,signal,action)).toBe(result);
      expect(authorize).toHaveBeenLastCalledWith(path,stage,signal,action);
    }
    expect(authorize).toHaveBeenCalledTimes(10);expect(verifyEncodedInput).toHaveBeenCalledTimes(4);
    expect(provider.encodeInput).not.toHaveBeenCalled();
  });
});

describe("remote input measurement dispatch facts",()=>{
  function fixture(error:Error) {
    const send=vi.fn(async()=>{throw error;}),interpret=vi.fn();
    const provider={inputMeasurement:{revision:"original",send,interpret}} as unknown as Provider;
    const handler=new ContextInputPreparationHandler({provider,materials:{} as MaterialCustodyPort,authorize:async()=>({kind:"allowed"}),now:()=>"2026-10-30T00:00:00Z"});
    const stage={request:{id:"measure",stageKind:"measure",input:{request:{kind:"context_input_preparation"},progress:{externalMeasurements:1},pending:{remote:{id:"original-measurement"}}}},result:null} as unknown as ActivityStageState;
    const path={} as ActivityPathState,attempt={id:"attempt"} as ActivityAttempt,signal=new AbortController().signal;
    return {handler,stage,path,attempt,signal,send,interpret};
  }
  it("retains a known pre-dispatch dependency failure without reporting an external measurement",async()=>{
    const f=fixture(new RemoteInputMeasurementNotDispatchedError("provider_credential_missing","original_credential"));
    const raw=await f.handler.execute(f.path,f.stage,f.attempt,f.signal);
    expect(raw).toMatchObject({outcome:"returned",completeness:"complete",usage:{externalMeasurements:0},value:{kind:"remote_not_dispatched"}});
    const accepted=await f.handler.interpret(f.path,{...f.stage,result:raw},f.signal);
    expect(accepted).toMatchObject({progress:{state:"gap",reason:"remote_measurement_dependency_unavailable",failure:{transportDispatched:false}},next:[]});
    expect(f.interpret).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not label a generic transport failure as unsent or retry an unknown remote attempt",async()=>{
    const error=new Error("connection lost"),f=fixture(error);
    await expect(f.handler.execute(f.path,f.stage,f.attempt,f.signal)).rejects.toBe(error);
    expect(await f.handler.reconcile(f.path,{...f.stage,attempt:f.attempt},f.signal)).toBeNull();
    expect(f.send).toHaveBeenCalledTimes(1);expect(f.interpret).not.toHaveBeenCalled();
  });
});
