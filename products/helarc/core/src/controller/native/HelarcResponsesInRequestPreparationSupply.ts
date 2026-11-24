import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {RESPONSES_IN_REQUEST_COMPACTION} from "@agent-anything/provider-integrations/native";
import {activityFactSourceId,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import type {ContextInputReceptionOption,ContextPreparationCurrentEvidence,ContextPreparationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativePreparationSupply,HelarcNativePreparationReception} from "./HelarcNativeInputPreparation.js";
import type {HelarcNativeOriginalInputWork} from "./HelarcNativeOriginalInputWork.js";
import type {HelarcResponsesInRequestReceptionWork,HelarcResponsesInRequestReceptionPlan} from "./HelarcResponsesInRequestReceptionWork.js";
import {assessHelarcResponsesInRequestUse} from "./HelarcResponsesInRequestEligibility.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";

type Policy=ContextPreparationCurrentEvidence<ContextPreparationMethodRequest>;
type Basis={readonly original:Extract<Awaited<ReturnType<HelarcNativeOriginalInputWork["result"]>>,{kind:"prepared"}>;
  readonly origin:HelarcNativePreparationSupply["origin"];
  readonly plan:Omit<HelarcResponsesInRequestReceptionPlan,"revision"|"binding"|"inputId"|"selectionId">;
  readonly rejectedInputs:NonNullable<Policy["rejectedInputs"]>};

export function helarcResponsesInRequestPreparationSupply(b:Basis,receiver:HelarcResponsesInRequestReceptionWork):HelarcNativePreparationSupply{
  const {plan,original}=b,scope=plan.inputNeed.scope,native=original.value.selected;
  if(original.path.intent.id!==plan.originalInputPathId||digest(original.value.preparation.scope)!==digest(scope)||
    b.origin.inputNeedDigest!==digest(plan.inputNeed)||b.origin.inputSupplyDigest!==digest(plan.inputSupply))throw new TypeError("in_request_supply_origin_changed");
  const eligibility=assessHelarcResponsesInRequestUse({native,use:plan.use,capacity:plan.capacity}),
    id=`${plan.inputNeed.needId}:in-request-reception:${digest({plan,original:original.value.readiness})}`;
  return {id:RESPONSES_IN_REQUEST_COMPACTION.id,origin:b.origin,owns:()=>false,ownsReception:path=>receiver.ownsPurpose(path.intent.purpose.digest),
    collect:async({addresses,producers,receivers},signal)=>{
      signal.throwIfAborted();
      if(producers.length||receivers.some(path=>path.intent.id!==id)||receivers.length>1)throw new TypeError("in_request_supply_original_changed");
      const retained=await receiver.readPlan(id);
      if(receivers.length&&!retained)throw new TypeError("in_request_original_receiver_missing");
      if(retained){
        const {binding,revision:_revision,inputId,selectionId,...retainedPlan}=retained;
        if(digest(retainedPlan)!==digest(plan)||inputId!==`${id}:input`||selectionId!==`${id}:selection`||
          digest(binding.sourceInput)!==digest(original.value.readiness))throw new TypeError("in_request_original_receiver_changed");
      }
      const receptions:HelarcNativePreparationReception[]=[],restored=receivers.map(p=>p.intent.id);
      if(eligibility.allowed||retained){
        const result=retained?await receiver.result(id):null,checked=result?.kind==="checked"?result.value.readiness:null,
          outcome=result&&"outcome" in result?result.outcome:null;
        const evidence={owner:"helarc-native-input",kind:"fact" as const,id:eligibility.id,revision:"1"};
        const option:ContextInputReceptionOption={id,members:[],sourceInput:original.value.readiness,beforeUse:true,addresses,comparisons:[],evidence};
        const observeSources=[activityFactSourceId("progress",id),activityFactSourceId("control",id)];
        const rejection=checked?b.rejectedInputs.find(r=>r.targetRevision===scope.target&&r.bodyDigest===checked.bodyDigest):null;
        receptions.push({option,checked,observeSources,state:result?{optionId:id,pathId:id,workId:result.path.intent.scheduledWorkId!,
          state:result.kind==="pending"?"active":result.kind==="checked"?"checked":"unavailable",reason:result.kind==="cancelled"?"receiver_cancelled":
            outcome?.result.kind==="gap"?outcome.result.gap.reason:null,
          evidence:{owner:scope.owner,kind:"fact" as const,id,revision:`${result.path.progressRevision}:${result.path.controlRevision}`},
          ...checked?{checkedInput:{inputId:checked.inputId,exactInputDigest:checked.exactInputDigest}}:{},
          ...outcome?{outcomeEvidence:{owner:"activity",kind:"fact" as const,id:`${id}:stage:1`,revision:String(result.path.progressRevision)}}:{},
          ...outcome?.result.kind==="gap"?{inputGap:{kind:"gap" as const,gap:outcome.result.gap,
            evidence:{owner:"activity",kind:"fact" as const,id:`${id}:stage:1`,revision:String(result.path.progressRevision)}}}:{},...rejection?{providerRejection:rejection}:{}}:null,
          prepareStart:async(acceptanceId,decision,a,signal)=>{
            signal.throwIfAborted();if(!eligibility.allowed||await receiver.readPlan(id)||a.path.id!==id)throw new TypeError("in_request_reception_start_changed");
            const reception:HelarcResponsesInRequestReceptionPlan={...plan,revision:"1",inputId:`${id}:input`,selectionId:`${id}:selection`,binding:{revision:"2",
              pathId:id,workId:a.workId,scope,boundary:native.manifest.selection.boundary,
              requirementsDigest:digest(helarcNativeInputRequirements(native.workingSources!.groups)),members:[],sourceInput:original.value.readiness}};
            const schedule:SharedAcceptancePart={owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{
              id:`${acceptanceId}:receiver`,workId:a.workId,runId:scope.runId,scopeId:a.schedulingScopeId,owner:scope.owner,allowedPathIds:[id],decisionId:decision.id,
              policyRevision:`${decision.policy.id}:${decision.policy.revision}`,reason:decision.investment.kind==="prepare_input"?decision.investment.reason:"necessary",
              delayImpact:"Receive the unchanged native input with a scoped before-use compaction agreement",resources:a.resources,timing:a.timing}}};
            return {observeSources,participants:[schedule,...receiver.prepareSubmission({...a.path,scheduledWorkId:a.workId},reception)]};
          },prepareAdoption:(input,signal)=>receiver.prepareAdoption(id,input,signal)});
      }
      return {offers:[],reuseOptions:[],receptions,report:{owner:scope.owner,revision:"1",sourceBoundary:native.manifest.selection.boundary,
        enumeration:{complete:true,eligible:0,returned:0},offers:[],unavailable:eligibility.allowed?[]:[{groupId:eligibility.id,reasons:eligibility.reasons}],
        admissionEvidence:[{id:eligibility.id,owner:"helarc-native-input",method:RESPONSES_IN_REQUEST_COMPACTION.id,revision:"1",accepted:eligibility.allowed,value:eligibility}]},
        receptionReport:{complete:true,examined:1,conflicts:0,returned:receptions.map(r=>r.option.id),restored}};
    }};
}
