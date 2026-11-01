import {describe,it,expect} from "vitest";
import {MODEL_ATTEMPT_RETRY,prepareProviderAttemptRetry} from "./ProviderAttemptRecovery.js";
import type {ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";

const now="2026-11-01T00:00:00.000Z";
function fixture(category="transport",code="connection_lost") {
  const path={intent:{id:"path",purpose:{contract:{executionOwner:"model",attemptRetry:MODEL_ATTEMPT_RETRY}},maximumAttempts:10,
    deadlineAt:"2026-11-01T00:01:00.000Z"},cancelled:false,resourceUse:{dispatchedAttempts:1}} as ActivityPathState;
  const stage={request:{id:"stage",stageKind:"model"},status:"raw_result",attempt:{id:"attempt"},processing:null,attemptCount:1,
    result:{id:"raw",completeness:"complete",outcome:"returned",value:{kind:"failed",failure:{category,code,message:"original failure",metadata:{}}}}} as ActivityStageState;
  return {path,stage};
}
describe("original Provider attempt recovery",()=>{
  it.each(["transport","timeout","rate_limit","server_error"])("accepts bounded technical %s recovery without professional progress",category=>{
    const {path,stage}=fixture(category);const receipt=prepareProviderAttemptRetry(path,stage,now);
    expect(receipt).toMatchObject({attemptId:"attempt",resultId:"raw",requestId:"stage",notBefore:"2026-11-01T00:00:00.500Z",policy:MODEL_ATTEMPT_RETRY.ref});
    expect(stage.attemptCount).toBe(1);expect(path.progress).toBeUndefined();
  });
  it.each(["authentication","invalid_request","response","cancellation","deadline","unknown"])("does not retry %s",category=>{
    const {path,stage}=fixture(category);expect(prepareProviderAttemptRetry(path,stage,now)).toBeNull();
  });
  it.each(["provider_context_window_exceeded","provider_attempt_interrupted","provider_cancellation_unconfirmed","provider_response_too_large"])("never treats %s as transport recovery",code=>{
    const {path,stage}=fixture("transport",code);expect(prepareProviderAttemptRetry(path,stage,now)).toBeNull();
  });
  it("retains server minimum waiting and rejects a wait beyond the original horizon",()=>{
    const {path,stage}=fixture();const failure=(stage.result!.value as any).failure;
    failure.retryAfterMs=5000;expect(prepareProviderAttemptRetry(path,stage,now)?.notBefore).toBe("2026-11-01T00:00:05.000Z");
    failure.retryAfterMs=10001;expect(prepareProviderAttemptRetry(path,stage,now)).toBeNull();
    failure.retryAfterMs=0;expect(prepareProviderAttemptRetry({...path,intent:{...path.intent,deadlineAt:"2026-11-01T00:00:00.400Z"}},stage,now)).toBeNull();
  });
  it("rejects partial, unknown, cancelled, exhausted and already interpreted results",()=>{
    const {path,stage}=fixture();
    expect(prepareProviderAttemptRetry(path,{...stage,result:{...stage.result!,outcome:"unknown"}},now)).toBeNull();
    expect(prepareProviderAttemptRetry(path,{...stage,result:{...stage.result!,completeness:"partial"}},now)).toBeNull();
    expect(prepareProviderAttemptRetry({...path,cancelled:true},stage,now)).toBeNull();
    expect(prepareProviderAttemptRetry(path,{...stage,attemptCount:3},now)).toBeNull();
    expect(prepareProviderAttemptRetry({...path,resourceUse:{...path.resourceUse,dispatchedAttempts:10}},stage,now)).toBeNull();
    expect(prepareProviderAttemptRetry(path,{...stage,processing:{id:"claimed"} as any},now)).toBeNull();
  });
});
