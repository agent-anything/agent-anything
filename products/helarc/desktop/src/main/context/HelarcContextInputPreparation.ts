import {ContextInputPreparationWork} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPurposeRegistry,ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import type {Provider} from "@agent-anything/model-interaction";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

/** Explicit host binding; switching default task-window policy is a separate product decision. */
export function bindHelarcContextInputPreparation(input:{
  store:HelarcExecutionStore;provider:Provider;registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  authorize:ActivityPurposeHandler["authorize"];now:()=>string;
}):ContextInputPreparationWork {
  return new ContextInputPreparationWork(input.store.activityHandoffs,input.registry,{provider:input.provider,materials:input.store.materialCustody,authorize:input.authorize,now:input.now});
}
