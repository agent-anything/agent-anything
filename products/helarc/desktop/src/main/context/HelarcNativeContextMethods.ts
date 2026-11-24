import {RepresentationMethodWork,type RepresentationMethodModelParticipant} from "@agent-anything/agent-runtime/context-representation";
import {HelarcResponsesCompactWork,HelarcNativePreparationMethods,type HelarcResponsesCompactWorkPorts} from "@agent-anything/helarc/controller";
import type {ActivityPurposeRegistry,ActivityPurposeHandler,ActivityPathState,ActivityReconsiderationHandler,ActivityReconsiderationSubscription} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {runActivityLifetime} from "../execution-storage/RunActivityLifetime.js";

/** Native participants use the shared professional path and Host, never the legacy Provider. */
export function bindHelarcNativeContextMethods(input:{
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly model:RepresentationMethodModelParticipant;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
  readonly compact?:Omit<HelarcResponsesCompactWorkPorts,"activities"|"materials"|"representations"|"authorize"|"now"|"productionLifetime">;
}){
  const {store,registry,authorize,now}=input;
  const productionLifetime={scope:runActivityLifetime,responsibilities:store.inputSupplies};
  const methods=new RepresentationMethodWork({nativeModel:input.model,activities:store.activityHandoffs,materials:store.materialCustody,
    representations:store.representations,selections:store.contextSelections,authorize,now,
    productionLifetime},registry);
  const compact=input.compact?new HelarcResponsesCompactWork({...input.compact,activities:store.activityHandoffs,
    materials:store.materialCustody,representations:store.representations,authorize,now,productionLifetime},registry):null;
  const lifecycle:ActivityReconsiderationHandler={prepare:async(snapshot,signal)=>{
    signal.throwIfAborted();const subscription=snapshot.state.subscription,binding=subscription.binding;
    if(binding?.kind!=="activity_path")throw new TypeError("native_method_lifecycle_binding_invalid");
    const path=await store.activityHandoffs.command({kind:"read_path",pathId:binding.id}) as ActivityPathState|null;
    const work=[methods,compact].find(value=>value&&value.purpose.digest===path?.intent.purpose.digest);
    if(!work?.lifecycle)throw new TypeError("native_method_lifecycle_owner_unavailable");
    return work.lifecycle.prepare(snapshot,signal);
  }};
  const preparationMethods=new HelarcNativePreparationMethods({activities:store.activityHandoffs,local:methods,compact});
  return {methods,compact,preparationMethods,purposeIds:[methods.purpose.contract.ref.id,...compact?[compact.purpose.contract.ref.id]:[]],
    reconsideration:(owner:string,subscription:ActivityReconsiderationSubscription)=>
      owner===methods.purpose.contract.acceptanceOwner&&subscription.binding?.kind==="activity_path"?lifecycle:null};
}
