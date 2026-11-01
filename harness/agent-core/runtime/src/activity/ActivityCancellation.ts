import type {InvocationInterruptionRef} from "@agent-anything/agent-core/control";
import type {ActivityPathState} from "./ActivityHandoff.js";

/** Emitted only after shared execution observes an accepted cancellation. */
export class ActivityCancellationError extends Error {
  readonly interruption:Extract<InvocationInterruptionRef,{kind:"activity_cancellation"}>;
  constructor(path:ActivityPathState) {
    super("activity_cancelled");
    if(!path.cancelled||!Number.isSafeInteger(path.controlRevision)||path.controlRevision<1)
      throw new TypeError("activity_cancellation_not_accepted");
    this.name="ActivityCancellationError";
    this.interruption=Object.freeze({kind:"activity_cancellation",cancellation:Object.freeze({
      runId:path.intent.runId,requestId:`${path.intent.id}:cancellation:${path.controlRevision}`,
      activityId:path.intent.id,controlRevision:path.controlRevision,
    })});
  }
}

export function activityInvocationInterruption(signal:AbortSignal,path:ActivityPathState):InvocationInterruptionRef|null {
  if(!signal.aborted||!(signal.reason instanceof ActivityCancellationError))return null;
  const interruption=signal.reason.interruption;
  return interruption.cancellation.runId===path.intent.runId&&interruption.cancellation.activityId===path.intent.id&&
    interruption.cancellation.controlRevision>=path.controlRevision?interruption:null;
}
