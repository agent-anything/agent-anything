import {ContextInputMaterializationWork,ContextMethodInputSupply,ContextMethodInputConsumer,type ContextInputPreparationWork,type RepresentationMethodWork} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPurposeRegistry,ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

/** Registers original recipient work; it neither selects a method nor owns its scheduling policy. */
export function bindHelarcMethodInputSupply(input:{
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly preparation:ContextInputPreparationWork;
  readonly methods:RepresentationMethodWork;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
}):{readonly materialization:ContextInputMaterializationWork;readonly supply:ContextMethodInputSupply;readonly consumer:ContextMethodInputConsumer} {
  const materialization=new ContextInputMaterializationWork(input.store.activityHandoffs,input.registry,{materials:input.store.materialCustody,
    preparation:input.preparation,authorize:input.authorize,now:input.now});
  const supply=new ContextMethodInputSupply({activities:input.store.activityHandoffs,materials:input.store.materialCustody,
    representations:input.store.representations,materialization,methods:input.methods});
  return {materialization,supply,consumer:new ContextMethodInputConsumer(supply,{activities:input.store.activityHandoffs,methods:input.methods})};
}
