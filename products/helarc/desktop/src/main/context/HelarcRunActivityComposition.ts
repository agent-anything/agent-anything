import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {Provider} from "@agent-anything/model-interaction";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPathState,type ActivityInputNeed,
  type ActivityReconsiderationHandler,type ActivitySchedulingIntent} from "@agent-anything/agent-runtime/activity";
import {SourceMaterialPublicationWork,ContextInputPreparationWork,RepresentationMethodWork} from "@agent-anything/agent-runtime/context-representation";
import {HELARC_STOP_MODEL_PURPOSE,HelarcStopModelWork,HelarcStopModelExecution,HelarcStopLifecycle} from "@agent-anything/helarc/task-fulfillment";
import type {HelarcTaskExecutionFactory} from "@agent-anything/helarc/composition";
import {HELARC_CONTROLLER_CAPABILITY} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {runActivityLifetime} from "../execution-storage/RunActivityLifetime.js";
import type {HelarcActivityBindings} from "./HelarcActivityBindings.js";
import type {HelarcActivityService} from "./HelarcActivityService.js";
import {validateHelarcContextRunBinding,type HelarcContextRunBinding} from "./HelarcContextRunBinding.js";
import {createHelarcTaskResponseExecution} from "./HelarcTaskResponseExecution.js";
import {createHelarcTaskPreparation} from "./HelarcTaskPreparation.js";
import {createHelarcStopPreparation} from "./HelarcStopPreparation.js";
import {bindHelarcMethodInputSupply} from "./HelarcMethodInputSupply.js";
import {createHelarcMaterialAccess,helarcMaterialRecipient} from "./HelarcMaterialAccess.js";
import {createHelarcReportMaterialHandoff,reportCaptureAuthorization} from "./HelarcReportMaterialHandoff.js";
import {createHelarcRunActivityScope} from "./HelarcRunActivityScope.js";

export interface HelarcActivityHost {
  readonly bindings:HelarcActivityBindings;
  readonly service:Pick<HelarcActivityService,"assertAvailable"|"wake">&Partial<Pick<HelarcActivityService,"scopeIdle"|"forgetIdleScope">>;
}
export const HELARC_RUN_ACTIVITY_COMPOSITION={id:"helarc.run-activities",revision:"2",
  modelPoolCapacity:1,localPoolCapacity:2,maximumResponseStages:8,maximumResponseAttempts:8,maximumReportBytes:8*1024*1024} as const;

/** One admitted tree's professional bindings, using the application's shared activity service. */
export function createHelarcRunActivityComposition(input:{
  readonly rootRunId:string;readonly store:HelarcExecutionStore;readonly provider:Provider;
  readonly context:HelarcContextRunBinding;readonly host:HelarcActivityHost;
  readonly deliveryMode:"buffered"|"streaming";readonly now:()=>string;
}) {
  const {store,provider,context,rootRunId,host,now}=input;
  validateHelarcContextRunBinding(context);
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
  const scope=createHelarcRunActivityScope({rootRunId,store,host,contextId:context.id,composition:HELARC_RUN_ACTIVITY_COMPOSITION,
    modelPoolId:`helarc-model:${digest({provider:provider.descriptor.id,target:provider.modelContext.target})}`});
  const {scopeId,modelPoolId,localPoolId,permissionBasis,original,authorize,deadline,host:hostPort}=scope;
  let task:ReturnType<typeof createHelarcTaskResponseExecution>|undefined;
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize:reportCaptureAuthorization(store,scope),now});
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,usage:store.inputUsage,materials:store.materialCustody,authorize,now});
  const methods=new RepresentationMethodWork({provider,usage:store.inputUsage,materials:store.materialCustody,representations:store.representations,
    selections:store.contextSelections,activities:store.activityHandoffs,authorize,now,
    productionLifetime:{scope:runActivityLifetime,responsibilities:store.inputSupplies}},registry);
  const reception=bindHelarcMethodInputSupply({store,registry,preparation,methods,authorize,now});
  const supplyPorts={provider,activities:store.activityHandoffs,responsibilities:store.inputSupplies,publications,preparation,
    authorize:async(basis:{consumer:ActivityPathState},signal:AbortSignal)=>{
      signal.throwIfAborted();hostPort.assertAvailable();await original(basis.consumer.intent.runId);
      if(basis.consumer.intent.permissionBasis!==permissionBasis)throw new TypeError("helarc_input_permission_basis_changed");
    },binding:async()=>({context,treeScopeId:scopeId,modelPoolId,localPoolId,deliveryMode:input.deliveryMode}),
    decisions:store.contextPolicy,selections:store.contextSelections,materials:store.materialCustody,methods,
    methodInputs:reception.supply,methodConsumers:reception.consumer};
  const taskSupply=createHelarcTaskPreparation(supplyPorts),stopSupply=createHelarcStopPreparation({...supplyPorts,
    binding:async()=>({context,treeScopeId:scopeId,modelPoolId,localPoolId,deliveryMode:"buffered" as const})});
  const identity=(id:string,runId:string,deadlineAt:string)=>({id,runId,permissionBasis,resourceScope:id,scheduledWorkId:id,
    maximumStages:HELARC_RUN_ACTIVITY_COMPOSITION.maximumResponseStages,maximumAttempts:HELARC_RUN_ACTIVITY_COMPOSITION.maximumResponseAttempts,maximumConcurrent:1,deadlineAt});
  const schedule=(id:string,runId:string,owner:string,reason:ActivitySchedulingIntent["reason"]):ActivitySchedulingIntent=>({
    id:`${id}:schedule`,workId:id,runId,scopeId,owner,reason,allowedPathIds:[id],decisionId:id,policyRevision:HELARC_RUN_ACTIVITY_COMPOSITION.revision,
    delayImpact:"The original consumer is waiting for its requested response",timing:{kind:"unknown"},resources:[{capability:"model-request",poolId:modelPoolId,units:1}]});
  const taskExecution:HelarcTaskExecutionFactory=binding=>{
    if(task)throw new TypeError("helarc_task_purpose_already_bound");
    task=createHelarcTaskResponseExecution({provider,purposes:registry,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,
      selections:store.contextSelections,authorize,now,rediscoveryMs:100,settlementWaitMs:5000,host:hostPort,
      preparations:{resume:async()=>{hostPort.assertAvailable();hostPort.wake();}},
      arrange:async(source,execution)=>{await original(source.runId);const id=`${source.toolExposure.controllerRequestId}:response`;
        return {identity:identity(id,source.runId,execution.retry.deadlineAt),schedule:schedule(id,source.runId,"task-decision","task")};}},binding);
    return task;
  };
  const stopWork=new HelarcStopModelWork(registry,{provider,activities:store.activityHandoffs,selections:store.contextSelections,authorize,now});
  const stopLifecycle=new HelarcStopLifecycle(store.activityHandoffs);
  const stopExecution=new HelarcStopModelExecution({work:stopWork,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,host:hostPort,rediscoveryMs:100,
    arrange:async(source,id)=>({identity:identity(id,source.event.run.id,await deadline(source.event.run.id)),
      schedule:schedule(id,source.event.run.id,HELARC_STOP_MODEL_PURPOSE.acceptanceOwner,"necessary")})});
  const reportHandoff=createHelarcReportMaterialHandoff({store,publications,host:hostPort,rediscoveryMs:100,assertNewDeliveryAllowed:scope.assertNewDeliveryAllowed,
    binding:async result=>({child:await helarcMaterialRecipient(store,result.correlation.child.run.id),
      parent:await helarcMaterialRecipient(store,result.correlation.origin.parent.run.id),permissionBasis,scopeId,localPoolId,
      deadlineAt:await deadline(result.correlation.origin.parent.run.id),maximumSourceBytes:HELARC_RUN_ACTIVITY_COMPOSITION.maximumReportBytes}),
    authorize:async(result,binding,signal)=>{signal.throwIfAborted();hostPort.assertAvailable();
      const child=await original(binding.child.runId);await original(binding.parent.runId);
      const lineage=child.admission!.lineage;
      return result.correlation.origin.root.run.id===rootRunId&&lineage.kind==="descendant"&&lineage.parent.id===binding.parent.runId&&
        lineage.relation.id===result.correlation.relation.ref.id&&binding.permissionBasis===permissionBasis&&
        binding.child.purpose===HELARC_CONTROLLER_CAPABILITY&&binding.parent.purpose===HELARC_CONTROLLER_CAPABILITY;
    }});
  const inputSupply:ActivityReconsiderationHandler={prepare:async(snapshot,signal)=>{
    const binding=snapshot.state.subscription.binding;
    if(binding?.kind!=="input_need")throw new TypeError("helarc_input_need_binding_missing");
    const need=await store.activityHandoffs.command({kind:"read_input_need",id:binding.id}) as ActivityInputNeed|null;
    const consumer=need?await store.activityHandoffs.command({kind:"read_path",pathId:need.stage.pathId}) as ActivityPathState|null:null;
    if(consumer?.intent.purpose.digest===task?.work.purpose.digest)return taskSupply.prepare(snapshot,signal);
    if(consumer?.intent.purpose.digest===stopWork.purpose.digest)return stopSupply.prepare(snapshot,signal);
    throw new TypeError("helarc_input_consumer_unavailable");
  }};
  const independent:ActivityReconsiderationHandler={prepare:async(snapshot,signal)=>{
    const binding=snapshot.state.subscription.binding;
    if(binding?.kind!=="activity_path")throw new TypeError("helarc_independent_binding_missing");
    const path=await store.activityHandoffs.command({kind:"read_path",pathId:binding.id}) as ActivityPathState|null;
    if(path?.intent.purpose.digest===methods.purpose.digest)return methods.lifecycle!.prepare(snapshot,signal);
    return reception.consumer.prepare(snapshot,signal);
  }};
  const registered={originalBindingId:permissionBasis,purposes:registry,
    reconsideration:(owner:string,subscription:Parameters<HelarcActivityBindings["reconsideration"]>[1]):ActivityReconsiderationHandler|null=>
      owner===task?.work.purpose.contract.acceptanceOwner?task.work.lifecycle:
      owner===HELARC_STOP_MODEL_PURPOSE.acceptanceOwner?stopLifecycle:owner===publications.purpose.contract.acceptanceOwner?
        subscription.id===`${subscription.binding?.id}:source-lifecycle`?publications.lifecycle:publications.deliveries:
      subscription.binding?.kind==="input_need"?inputSupply:subscription.binding?.kind==="activity_path"?independent:null};
  return {taskExecution,stopExecution,reportHandoff,contextMaterials:createHelarcMaterialAccess(store),
    async prepareActivation() {
      if(!task)throw new TypeError("helarc_task_purpose_unbound");
      await scope.prepareActivation();
    },
    activate(intent:"settle"|"continue"|"cancel"="continue") {
      scope.activate(registered,intent);
    }};
}
