import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {SourceMaterialPublicationWork,type InputSupplyBinding} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPurposeRegistry,ActivityPurposeHandler,ActivityPathState,ActivityReconsiderationSubscription,ActivityReconsiderationHandler} from "@agent-anything/agent-runtime/activity";
import type {HelarcNativeTaskCompositionPorts} from "@agent-anything/helarc/composition";
import {HelarcNativeInputDemandWork,HelarcNativeOriginalInputWork,HelarcNativeAccountReceptionWork,HelarcNativeResultReceptionWork,HelarcResponsesCompactReceptionWork,
  HelarcNativeInputPreparation,HelarcNativeInputSupply,HelarcNativeTaskInputWait,planHelarcNativeInputPublications,planHelarcNativeResultPublications,
  helarcNativeAccountPreparationSupply,helarcNativeResultPreparationSupply,helarcResponsesCompactPreparationSupply,helarcNativeTaskResultSources,adoptHelarcNativeTaskInput,
  HelarcResponsesInRequestReceptionWork,helarcResponsesInRequestPreparationSupply,HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE,
  type HelarcNativeTaskInputConditions,type HelarcNativeOriginalInputPlan} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {bindHelarcNativeContextMethods} from "./HelarcNativeContextMethods.js";
import type {frozenNativePurposes} from "./HelarcNativeActivityPurposes.js";

type Demand=Extract<Awaited<ReturnType<HelarcNativeInputDemandWork["result"]>>,{kind:"needed"}>;
type WaitingPorts=ConstructorParameters<typeof HelarcNativeTaskInputWait>[0];
interface Ports {
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly purposes:Pick<ReturnType<typeof frozenNativePurposes>,"includes">;
  readonly methods:ReturnType<typeof bindHelarcNativeContextMethods>;
  readonly publications:SourceMaterialPublicationWork;
  readonly measurement?:import("@agent-anything/helarc/controller").HelarcNativeInputMeasurementPort;
  readonly host:WaitingPorts["host"];
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly authorizeDemand:(demand:Demand,signal:AbortSignal)=>Promise<void>;
  /** Resolves the original accepted Run arrangement once, before the demand checkpoint. */
  readonly conditions:(...args:Parameters<HelarcNativeTaskCompositionPorts["inputPreparation"]["select"]>)=>Promise<HelarcNativeTaskInputConditions>;
  readonly now:()=>string;
  readonly rediscoveryMs:number;
  readonly settlementWaitMs:number;
}

/** Native task consumers and normal supplies share the Host; neither owns its pump. */
export function bindHelarcNativeTaskInputs(p:Ports){
  const {store,registry,authorize,now}=p,activities=store.activityHandoffs;
  const demand=new HelarcNativeInputDemandWork({activities,selections:store.contextSelections,authorize,now},registry);
  const publications=p.publications;
  const receptionPorts={activities,methods:p.methods.methods,materials:store.materialCustody,representations:store.representations,authorize,now,measurement:p.measurement};
  const original=new HelarcNativeOriginalInputWork(receptionPorts,registry),accounts=new HelarcNativeAccountReceptionWork(receptionPorts,registry),
    bodies=new HelarcNativeResultReceptionWork(receptionPorts,registry);
  const compact=p.methods.compact?new HelarcResponsesCompactReceptionWork({...receptionPorts,methods:p.methods.compact,original,
    journal:store.protocolJournal},registry):null;
  const inRequest=p.purposes.includes(HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE)?new HelarcResponsesInRequestReceptionWork({...receptionPorts,original},registry):null;
  const policy=new HelarcNativeInputPreparation({activities,decisions:store.contextPolicy,selections:store.contextSelections,
    responsibilities:store.inputSupplies,methods:p.methods.preparationMethods,original});
  const owner=async(pathId:string)=>{
    const path=await activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    const selected=path?[accounts,bodies,compact,inRequest].find(w=>w?.ownsPurpose(path.intent.purpose.digest)):undefined;
    if(!selected)throw new TypeError("native_task_input_receiver_owner_unavailable");return selected;
  };
  const resolve=async(current:Demand,origin:InputSupplyBinding,signal:AbortSignal)=>{
    const c=conditions(current),scope=current.plan.inputNeed.scope;
    const planned=await planHelarcNativeInputPublications({demand:current,activities,maximumSourceBytes:c.maximumSourceBytes,signal});
    const results=await planHelarcNativeResultPublications({demand:current,activities,materials:store.materialCustody,maximumSourceBytes:c.maximumSourceBytes,signal});
    const id=`${current.path.intent.id}:original-input`,workId=`${current.path.intent.id}:supply-work`;
    const scheduling={id:`${workId}:schedule`,workId,runId:scope.runId,scopeId:c.schedulingScopeId,owner:scope.owner,delegatedPathOwners:["material-source"],
      decisionId:current.need.id,policyRevision:c.settingsRevision,reason:"necessary" as const,delayImpact:"Supply the original native task input",
      timing:{kind:"unknown" as const},resources:c.resources};
    let preparation:{intent:Parameters<typeof original.prepareSubmission>[0];plan:HelarcNativeOriginalInputPlan}|null=null;
    if(planned.history.published&&planned.groups.every(group=>group.state==="published")){
      const published=planned.history.published,description=await store.materialCustody.command({kind:"describe",holdId:published.access.holdId,recipient:published.access.recipient}) as import("@agent-anything/context/custody").MaterialAccessDescription;
      preparation={intent:{id,runId:scope.runId,permissionBasis:scope.authorityBasis,resourceScope:id,scheduledWorkId:workId,...c.limits,
        maximumConcurrent:1,deadlineAt:current.path.intent.deadlineAt},plan:{revision:"1",scope,inputSupply:origin,
        history:{record:published.representation,hold:description.hold},publications:planned.groups,
        inputId:`${id}:input`,selectionId:`${id}:selection`,continuity:c.continuity,maximumReadBytes:c.maximumReadBytes,
        ...(c.measurement?{measurement:c.measurement}:{})}};
    }
    return {...planned,results,scheduling,preparation,publications:[...planned.publications,...results.publications]};
  };
  const supplier=new HelarcNativeInputSupply({activities,responsibilities:store.inputSupplies,demand,publications,original,
    receivers:{prepareClosure:async(pathId,basis,signal)=>(await owner(pathId)).prepareClosure(pathId,basis,signal)},
    authorize:p.authorizeDemand,resolve,decide:async(current,arranged,snapshot,signal)=>{
      // Resolve returns this composition's original plan, not another supplier's shape.
      const a=arranged as Awaited<ReturnType<typeof resolve>>,c=conditions(current),{activity,prepared,inputNeed}=current.plan,scope=inputNeed.scope;
      if(!a.preparation||!prepared.workingSources)throw new TypeError("native_task_input_original_preparation_missing");
      const inputSupply=a.preparation.plan.inputSupply,history=a.preparation.plan.history;
      const receptionInput={activity,prepared,scope,history,publications:a.groups,continuity:c.continuity,capacity:c.capacity,maximumReadBytes:c.maximumReadBytes,
        ...(c.measurement?{measurement:c.measurement}:{})};
      const supplies=[helarcNativeAccountPreparationSupply({
        supply:{items:a.items,sources:prepared.workingSources,publications:a.groups,sourceRecipient:{runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose},
          target:scope.target,authorizationBasis:scope.authorityBasis,composition:activity.composition,
          backgroundGroupIds:prepared.workingSources.groups.filter(g=>g.duties.includes("objective")).map(g=>g.id),
          capacity:c.methodCapacity,bounds:c.bounds,limits:c.limits,addresses:[]},
        reception:{input:{...receptionInput,publications:a.groups},inputNeed,inputSupply,
          checkConditions:{capacity:c.methodCapacity,bounds:c.bounds}},rejectedInputs:current.plan.rejectedInputs??[]},{activities,methods:p.methods.methods,receiver:accounts}),
        helarcNativeResultPreparationSupply({methods:{activity,authorizationBasis:scope.authorityBasis,capacity:c.methodCapacity,bounds:c.bounds,limits:c.limits},
          sources:a.results.sources,exclusions:a.results.exclusions,reception:{input:{...receptionInput,input:current.plan.resultSources!},inputNeed,inputSupply},
          rejectedInputs:current.plan.rejectedInputs??[]},{activities,methods:p.methods.methods,receiver:bodies})];
      if(c.responsesInRequest&&inRequest&&p.purposes.includes((c.measurement?inRequest.measuredPurpose:inRequest.purpose).contract)){
        const retained=await original.result(a.preparation.intent.id);
        if(retained.kind!=="prepared")throw new TypeError("native_task_in_request_original_input_unavailable");
        supplies.push(helarcResponsesInRequestPreparationSupply({original:retained,origin:{activityDigest:digest(activity),preparedDigest:digest(prepared),
          inputNeedDigest:digest(inputNeed),inputSupplyDigest:digest(inputSupply),historyDigest:digest(history)},
          plan:{originalInputPathId:a.preparation.intent.id,inputNeed,inputSupply,use:c.responsesInRequest,capacity:c.capacity,
            ...(c.measurement?{measurement:c.measurement}:{})},rejectedInputs:current.plan.rejectedInputs??[]},inRequest));
      }
      if(c.responsesCompact){
        if(!compact||!p.methods.compact||activity.composition.composition.protocol.id!=="openai.responses")
          throw new TypeError("native_task_compact_arrangement_unavailable");
        const retained=await original.result(a.preparation.intent.id);
        if(retained.kind!=="prepared")throw new TypeError("native_task_compact_original_input_unavailable");
        supplies.push(helarcResponsesCompactPreparationSupply({methods:{native:retained.value.selected,publications:a.groups,
          composition:activity.composition,purpose:c.responsesCompact.purpose,authorityBasis:scope.authorityBasis,probeRequired:c.responsesCompact.probeRequired,
          assessmentModelCalls:c.responsesCompact.assessmentModelCalls,
          assessmentInput:c.responsesCompact.assessmentInput,
          bounds:c.bounds,limits:c.limits},origin:{activityDigest:digest(activity),preparedDigest:digest(prepared),inputNeedDigest:digest(inputNeed),
          inputSupplyDigest:digest(inputSupply),historyDigest:digest(history)},reception:{input:{original:retained.value.selected,publications:a.groups,
            scope,activityId:activity.scope.activityId,capacity:c.capacity,maximumReadBytes:c.maximumReadBytes,
            ...(c.measurement?{measurement:c.measurement}:{})},originalInputPathId:a.preparation.intent.id,inputNeed,inputSupply},
          rejectedInputs:current.plan.rejectedInputs??[]},{activities,methods:p.methods.compact,receiver:compact}));
      }
      return policy.prepare({demand:current,originalPathId:a.preparation.intent.id,inputSupply,supplies,autoPrepare:c.autoPrepare,methodComparisonRevision:c.methodComparisonRevision??"legacy",rejectedInputs:current.plan.rejectedInputs??[],
        observation:{settingsRevision:c.settingsRevision,sequence:c.sequence,inputRevision:c.inputRevision,
          representationContinuity:c.observationContinuity??c.representationContinuity},
        execution:(id,limits)=>({path:{id,runId:scope.runId,permissionBasis:scope.authorityBasis,resourceScope:id,...limits,maximumConcurrent:1,deadlineAt:current.path.intent.deadlineAt},
          workId:`${id}:work`,schedulingScopeId:c.schedulingScopeId,resources:c.resources,timing:{kind:"unknown"}})},snapshot,signal);
    }});
  const waiting=new HelarcNativeTaskInputWait({activities,acceptance:store.sharedAcceptance,responsibilities:store.inputSupplies,demand,host:p.host,
    rediscoveryMs:p.rediscoveryMs,settlementWaitMs:p.settlementWaitMs,arrange:async(arranged,input,context,replacement)=>{
      if(replacement&&!replacement.basis.supplyConditions)throw new TypeError("native_replacement_original_conditions_missing");
      const original=replacement?.basis.supplyConditions??await p.conditions(arranged,input,context),
        {activity,prepared}=arranged,n=activity.scope,id=`${n.activityId}:input-demand`,
        c=replacement?{...original,inputRevision:original.inputRevision+replacement.progress.rejections.length}:
          {...original,...(original.measurement?{measurement:{...original.measurement,budget:{pathId:id,maximumCalls:original.capacity.maximumMeasurements}}}:{})};
      const scope={id:`${n.runId}:native-input-scope:${digest([n.recipientId,n.purpose.id,c.representationContinuity])}`,runId:n.runId,recipient:n.recipientId,purpose:n.purpose.id,target:`${activity.composition.composition.configuration.configuration.id}:${activity.composition.composition.configuration.configuration.revision}`,
        owner:"context-representation",continuity:c.representationContinuity,authorityBasis:activity.conditions.authority.id};
      const plan={revision:"1" as const,activity,prepared,inputNeed:{kind:"native_input_need" as const,revision:"1" as const,needId:`${id}:need`,scope,
        consumer:{activityId:n.activityId,protocol:activity.composition.composition.protocol,compositionDigest:activity.composition.digest}},
        capacity:c.capacity,resultSources:replacement?replacement.basis.resultSources:helarcNativeTaskResultSources(input),supplyConditions:c,
        ...(replacement?{rejectedInputs:replacement.progress.rejections}:{})};
      return {identity:{id,runId:input.runId,permissionBasis:scope.authorityBasis,resourceScope:id,scheduledWorkId:id,maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:context.retry.deadlineAt,
        ...(c.measurement?.budget?{resourceLimits:{measurementCalls:c.measurement.budget.maximumCalls},
          ...(c.measurement.budget.pathId!==id?{resourceBudgetSources:{measurementCalls:c.measurement.budget.pathId}}:{})}:{})},plan,
        schedule:{id:`${id}:schedule`,workId:id,runId:input.runId,scopeId:c.schedulingScopeId,owner:scope.owner,decisionId:id,policyRevision:c.settingsRevision,
          reason:"task",delayImpact:"Await the original native input",timing:{kind:"unknown"},resources:c.resources}};
    },adopt:async(original,input,inputId,plan)=>{
      if(!plan.supplyConditions)throw new TypeError("native_task_input_original_conditions_missing");
      return {...original,prepared:await adoptHelarcNativeTaskInput(original.prepared,input,inputId,store.contextSelections,
        {materials:store.materialCustody,representations:store.representations,maximumReadBytes:plan.supplyConditions.maximumReadBytes})};
    }});
  return {waiting,demand,
    reconsideration:(ownerId:string,subscription:ActivityReconsiderationSubscription):ActivityReconsiderationHandler|null=>{
      if(ownerId!=="context-representation")return null;
      if(subscription.binding?.kind==="input_need")return supplier;
      if(subscription.binding?.kind==="activity_path"&&subscription.id===`${subscription.binding.id}:reception`)
        return {prepare:async(snapshot,signal)=>(await owner(subscription.binding!.id)).prepare(snapshot,signal)};
      return null;
    }};
}
function conditions(current:Demand):HelarcNativeTaskInputConditions {
  const c=current.plan.supplyConditions;
  if(!c||c.revision!=="1"||!c.settingsRevision||typeof c.autoPrepare!=="boolean"||!c.schedulingScopeId||
    !c.representationContinuity||c.observationContinuity!==undefined&&!c.observationContinuity||!c.resources?.length||digest(c.capacity)!==digest(current.plan.capacity)||
    [c.maximumReadBytes,c.maximumSourceBytes,c.limits?.maximumStages,c.limits?.maximumAttempts].some(v=>!Number.isSafeInteger(v)||v<1)||
    c.responsesCompact&&(!c.responsesCompact.purpose.id||!c.responsesCompact.purpose.revision||typeof c.responsesCompact.probeRequired!=="boolean"))
    throw new TypeError("native_task_input_conditions_unavailable");
  return c;
}
