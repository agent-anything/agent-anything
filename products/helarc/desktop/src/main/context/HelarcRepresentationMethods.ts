import {RepresentationMethodWork,type RepresentationMethodDependencies} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPurposeRegistry,ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

export function bindHelarcRepresentationMethods(input:{store:HelarcExecutionStore;registry:ActivityPurposeRegistry<ActivityPurposeHandler>}&Pick<RepresentationMethodDependencies,"provider"|"authorize"|"now">):RepresentationMethodWork {
  return new RepresentationMethodWork({provider:input.provider,authorize:input.authorize,now:input.now,activities:input.store.activityHandoffs,materials:input.store.materialCustody,
    representations:input.store.representations,selections:input.store.contextSelections},input.registry);
}
