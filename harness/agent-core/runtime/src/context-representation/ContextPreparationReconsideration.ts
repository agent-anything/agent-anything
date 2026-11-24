import type {ActivityReconsiderationHandler,ActivityReconsiderationSnapshot,ActivityReconsiderationPreparation,ActivityHandoffPort,ActivitySchedulingAcceptance,SharedAcceptancePart,SharedAcceptanceProposal} from "../activity/index.js";
import {activityFactSourceId} from "../activity/ActivityReconsideration.js";
import {schedulingAdmissionLimitation} from "../activity/ActivityScheduling.js";
import {contextPreparationAcceptance,contextPreparationAcceptanceId,type ContextPreparationExecutionArrangement} from "./ContextPreparationAcceptance.js";
import {contextPreparationAdoption} from "./ContextPreparationAdoption.js";
import {contextPreparationAdmissionKey,contextReceptionAdmissionKey,decideContextPreparation,type ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";
import {readContextPreparationHistory,type ContextPreparationCurrentEvidence} from "./ContextPreparationHistory.js";
import type {ContextPreparationDecisionStore} from "./ContextPreparationDecisionStore.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";
import type {ContextPreparationWorkEvidence} from "./ContextPreparationWorkEvidence.js";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";
import type {ContextPreparationMethodRequest} from "./ProtocolRepresentationMethod.js";
import {confirmNativeInputSupplyReturn,type NativeInputSupplyReturn} from "./NativeInputSupplyReturn.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

/** Professional reconsideration. Input owners supply current evidence; original work comes from durable acceptance. */
export function contextPreparationReconsideration<R extends ContextPreparationMethodRequest=RepresentationMethodRequest>(input:{
  readonly decisions:ContextPreparationDecisionStore;
  readonly activities:ActivityHandoffPort;
  readonly methods:{
    readonly prepareSubmission:(intent:Parameters<RepresentationMethodWork["prepareSubmission"]>[0],request:R)=>ReturnType<RepresentationMethodWork["prepareSubmission"]>;
    readonly describe:(pathId:string)=>Promise<Pick<ContextPreparationWorkEvidence,"state"|"revision">>;
    readonly prepareClosure:RepresentationMethodWork["prepareClosure"];
  };
  readonly resolve:(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal)=>Promise<{
    readonly policy:ContextPreparationCurrentEvidence<R>;
    readonly methodComparisonRevision?:"13"|"14"|"15"|"legacy";
    readonly expectedControlRevision:number;
    readonly execution:(decision:ReturnType<typeof decideContextPreparation>)=>ContextPreparationExecutionArrangement;
    /** Separate recipient work, accepted jointly with this decision; it must not execute or adopt here. */
    readonly prepareInputReception?:(id:string,decision:ReturnType<typeof decideContextPreparation>,signal:AbortSignal)=>Promise<{
      readonly participants:readonly SharedAcceptancePart[];readonly observeSources:readonly string[];
    }>;
    readonly inputObservationSources?:readonly string[];
    readonly prepareInputUnavailability?:(id:string,decision:ReturnType<typeof decideContextPreparation>,signal:AbortSignal)=>Promise<readonly SharedAcceptancePart[]>;
    /** One-shot input supply. Its owner checks the exact input; this policy never assembles or certifies it. */
    readonly prepareInputAcceptance?:(id:string,decision:ReturnType<typeof decideContextPreparation>,signal:AbortSignal)=>Promise<SharedAcceptanceProposal>;
  }>;
}):ActivityReconsiderationHandler {
  return {prepare:async(snapshot,signal)=>{
    const resolved=await input.resolve(snapshot,signal),policy=resolved.policy;
    if(policy.scope.runId!==snapshot.state.subscription.runId)throw new TypeError("context_policy_subscription_mismatch");
    if(resolved.prepareInputAcceptance&&snapshot.state.subscription.binding?.kind!=="input_need")
      throw new TypeError("context_policy_input_supply_subscription_required");
    const {previous,basis,producers}=await readContextPreparationHistory({current:policy,decisions:input.decisions,methods:input.methods,
      includeRevisionBasis:resolved.methodComparisonRevision===undefined||resolved.methodComparisonRevision==="14"||resolved.methodComparisonRevision==="15"},signal);
    const closures:SharedAcceptancePart[]=[];
    for(const {record} of producers) {
      signal.throwIfAborted();const original=record.investment!;
      const unused=policy.unusedProducers?.find(p=>p.workId===original.workId&&p.pathId===original.pathId);
      if(unused)closures.push(...await input.methods.prepareClosure(original.pathId,unused.evidence.id));
    }
    const project=async(basis:ContextPreparationPolicyInput<R>):Promise<ActivityReconsiderationPreparation>=>{
      const decision=decideContextPreparation(basis,resolved.methodComparisonRevision);
      const id=contextPreparationAcceptanceId(basis,previous?.decision.id??null,snapshot);
      if(decision.investment.kind==="prepare_input"&&!resolved.prepareInputReception)throw new TypeError("context_policy_input_reception_unavailable");
      const reception=decision.investment.kind==="prepare_input"?await resolved.prepareInputReception!(id,decision,signal):null;
      let execution=decision.investment.kind==="propose"?resolved.execution(decision):null;
      if(execution&&decision.investment.kind==="propose"&&decision.investment.replaces) {
        const ref=decision.investment.replaces;
        const path=await input.activities.command({kind:"read_path",pathId:ref.pathId}) as import("../activity/index.js").ActivityPathState|null;
        const scheduling=await input.activities.command({kind:"read_schedule",workId:ref.workId}) as ActivitySchedulingAcceptance|null;
        if(!path||!scheduling)throw new TypeError("context_policy_revision_original_unavailable");
        execution={...execution,original:{path,scheduling}};
      }
      const checkedInput=decision.foreground.kind==="continue"&&resolved.prepareInputAcceptance?
        await resolved.prepareInputAcceptance(id,decision,signal):null;
      const unavailable=basis.consumerActive&&decision.foreground.kind==="limited"&&!execution&&!reception&&resolved.prepareInputUnavailability?
        await resolved.prepareInputUnavailability(id,decision,signal):null;
      if(checkedInput) {
        const need=await input.activities.command({kind:"read_input_need",id:snapshot.state.subscription.binding!.id}) as import("../activity/index.js").ActivityInputNeed|null;
        const selected=checkedInput.parts.filter(p=>p.owner==="context_selection"&&p.kind==="selection_input");
        const binding=(selected[0]?.proposal as import("@agent-anything/context/selection").ContextSelectionProposal|undefined)?.input;
        if(!need||need.supplier!==policy.scope.owner||selected.length!==1||!binding)
          throw new TypeError("context_policy_input_need_mismatch");
        if(binding.nativeConsumer) {
          const returns=checkedInput.parts.filter(p=>p.owner==="context_input_supply"&&p.kind==="native_input_return");
          const entries=checkedInput.parts.filter(p=>p.owner==="activity"&&p.kind==="stage_submission");
          if(!need.origin||returns.length!==1||entries.length!==1)throw new TypeError("context_policy_native_input_return_missing");
          const source=await input.activities.command({kind:"read_stage",requestId:need.origin.requestId}) as import("../activity/index.js").ActivityStageState|null;
          const path=await input.activities.command({kind:"read_path",pathId:need.stage.pathId}) as import("../activity/index.js").ActivityPathState|null;
          if(!source||!path)throw new TypeError("context_policy_native_input_origin_missing");
          const {exactInput,...metadata}=binding;
          confirmNativeInputSupplyReturn(returns[0]!.proposal as NativeInputSupplyReturn,{need,source,path,scope:policy.scope,input:{...metadata,exactInputDigest:modelInputValueDigest(exactInput)},
            ready:entries[0]!.proposal as import("../activity/index.js").ActivityStageRequest});
        } else if(binding.stageRequestId!==need.stage.id||binding.activityId!==need.stage.pathId)
          throw new TypeError("context_policy_input_need_mismatch");
      }
      if(unavailable) {
        if(snapshot.state.subscription.binding?.kind!=="input_need")throw new TypeError("context_policy_input_supply_subscription_required");
        const need=await input.activities.command({kind:"read_input_need",id:snapshot.state.subscription.binding.id}) as import("../activity/index.js").ActivityInputNeed|null;
        const stages=unavailable.filter(p=>p.owner==="activity"&&p.kind==="stage_submission");
        const entry=stages[0]?.proposal as import("../activity/index.js").ActivityStageRequest|undefined;
        if(!need||need.supplier!==policy.scope.owner||stages.length!==1||!entry||entry.id!==need.unavailableStage.id||entry.pathId!==need.stage.pathId)
          throw new TypeError("context_policy_input_unavailability_mismatch");
      }
      signal.throwIfAborted();
      const acceptanceBasis={id,input:basis,policyRevision:decision.policy.revision,expectedDecisionId:previous?.decision.id??null,expectedControlRevision:resolved.expectedControlRevision,
        reconsideration:null,execution,methods:input.methods};
      const acceptance=checkedInput?contextPreparationAdoption({policy:acceptanceBasis,checkedInput}):contextPreparationAcceptance(acceptanceBasis).acceptance;
      const parts=[...acceptance.parts,...closures,...reception?.participants??[],...unavailable??[]];
      if((decision.investment.kind==="reuse"||decision.investment.kind==="reuse_input")&&decision.investment.requiredService) {
        const schedule=await input.activities.command({kind:"read_schedule",workId:decision.investment.workId}) as ActivitySchedulingAcceptance|null;
        if(!schedule||schedule.closed)throw new TypeError("context_policy_original_schedule_unavailable");
        const reason=decision.investment.requiredService;
        if(schedule.intent.reason!==reason&&(reason==="necessary"||schedule.service==="spare"))parts.push({owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:schedule.revision,
            intent:{...schedule.intent,id:`${id}:treatment`,decisionId:decision.id,reason,delayImpact:reason==="necessary"?"Current input requires this originally accepted work":"Evidence-backed opportunity now needs guaranteed service"}}});
      }
      const producerSources=(pathId:string)=>[activityFactSourceId("progress",pathId),activityFactSourceId("control",pathId)];
      const previousProducerSources=new Set(producers.flatMap(p=>producerSources(p.record.investment!.pathId)));
      const observedPaths=producers.filter(p=>["accepted","active","unknown"].includes(p.description.state)&&
        !policy.unusedProducers?.some(unused=>unused.pathId===p.record.investment!.pathId)).map(p=>p.record.investment!.pathId);
      if(execution)observedPaths.push(execution.path.id);
      const observeSources=[...new Set([...snapshot.state.observedSources.filter(source=>!previousProducerSources.has(source)),
        ...observedPaths.flatMap(producerSources),...resolved.inputObservationSources??[],...reception?.observeSources??[]])].sort();
      return {acceptanceId:acceptance.id,decision:{owner:"context-representation",kind:"context_preparation_decision",id:decision.id,revision:decision.policy.revision},
        participants:parts,close:!policy.consumerActive||checkedInput!==null||unavailable!==null,observeSources,
        ...(decision.policy.revision==="15"?{rejectionLimit:Math.max(1,Math.min(basis.options.length,decision.policy.maximumOptions)+(basis.receptionOptions?.length??0))}:{}),
        rejected:async receipt=>{
          if(!["propose","prepare_input"].includes(decision.investment.kind)||receipt.rejection?.owner!=="activity"||
            !schedulingAdmissionLimitation(receipt.rejection.code))return null;
          const investment=decision.investment;
          const option=investment.kind==="propose"?basis.options.find(option=>option.id===investment.optionId):null;
          const receiving=investment.kind==="prepare_input"?basis.receptionOptions?.find(option=>option.id===investment.optionId):null;
          if(!option&&!receiving)throw new TypeError("context_policy_rejected_option_unavailable");
          const optionId=(option??receiving)!.id,conditionsDigest=option?contextPreparationAdmissionKey(basis,option):contextReceptionAdmissionKey(basis,receiving!);
          return project({...basis,admissionResponse:receipt.id,admissionLimitations:[...basis.admissionLimitations??[],
            {optionId,conditionsDigest,acceptanceId:receipt.id,code:receipt.rejection.code}]});
        }};
    };
    return project(basis);
  }};
}
