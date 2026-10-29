import {ActivityHandoffProcessor,ActivityHandoffPump,ActivityReconsiderationProcessor,type ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityReconsiderationHandler} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

/** The host supplies original bindings and entrusted scopes; no Product timer dispatches model work. */
export function bindHelarcContextExecution(input:{
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly purposeIds:readonly string[];
  readonly now:()=>string;
  readonly reconsideration?:(owner:string,subscription:import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSubscription)=>ActivityReconsiderationHandler|null;
}):{readonly processor:ActivityHandoffProcessor;readonly pump:ActivityHandoffPump;close():void} {
  const processor=new ActivityHandoffProcessor(input.store.activityHandoffs,input.registry,
    input.store.activityJournal.executor,input.now,input.purposeIds);
  const reconsideration=input.reconsideration?new ActivityReconsiderationProcessor(input.store.activityHandoffs,input.store.sharedAcceptance,input.reconsideration):undefined;
  const pump=new ActivityHandoffPump(input.store.activityHandoffs,processor,reconsideration);
  const unsubscribe=input.store.onActivityChange(()=>pump.wake());
  return {processor,pump,close:unsubscribe};
}
