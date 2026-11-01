import {describe,it,expect} from "vitest";
import {ActivityCancellationError,activityInvocationInterruption} from "./ActivityCancellation.js";
import type {ActivityPathState} from "./ActivityHandoff.js";

const path={intent:{id:"path",runId:"run"},cancelled:false,controlRevision:0} as ActivityPathState;
describe("accepted activity cancellation attribution",()=>{
  it("retains the exact accepted activity without cancelling its Run",()=>{
    const controller=new AbortController();
    expect(activityInvocationInterruption(controller.signal,path)).toBeNull();
    controller.abort(new ActivityCancellationError({...path,cancelled:true,controlRevision:1}));
    expect(activityInvocationInterruption(controller.signal,path)).toEqual({kind:"activity_cancellation",
      cancellation:{runId:"run",activityId:"path",controlRevision:1,requestId:"path:cancellation:1"}});
  });
  it("does not attribute Host interruption, unaccepted control or another activity",()=>{
    expect(()=>new ActivityCancellationError(path)).toThrow("activity_cancellation_not_accepted");
    const bare=new AbortController();bare.abort(new Error("activity_cancelled"));
    expect(activityInvocationInterruption(bare.signal,path)).toBeNull();
    const other=new AbortController();other.abort(new ActivityCancellationError({...path,cancelled:true,controlRevision:1}));
    expect(activityInvocationInterruption(other.signal,{...path,intent:{...path.intent,id:"other"}})).toBeNull();
    expect(activityInvocationInterruption(other.signal,{...path,controlRevision:2})).toBeNull();
  });
});
