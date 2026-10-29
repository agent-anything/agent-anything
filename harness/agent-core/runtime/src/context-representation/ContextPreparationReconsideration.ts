import type {ActivityReconsiderationHandler,ActivityReconsiderationSnapshot,ActivityReconsiderationPreparation,ActivityHandoffPort,ActivitySchedulingAcceptance,SharedAcceptancePart} from "../activity/index.js";
import {contextPreparationAcceptance,contextPreparationAcceptanceId,type ContextPreparationExecutionArrangement} from "./ContextPreparationAcceptance.js";
import {contextPreparationApplicabilityKey,contextPreparationAdmissionKey,decideContextPreparation,type ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";
import type {ContextPreparationDecisionStore} from "./ContextPreparationDecisionStore.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";

/** Professional reconsideration. Input owners supply current evidence; original work comes from durable acceptance. */
export function contextPreparationReconsideration(input:{
  readonly decisions:ContextPreparationDecisionStore;
  readonly activities:ActivityHandoffPort;
  readonly methods:Pick<RepresentationMethodWork,"prepareSubmission"|"describe"|"prepareClosure">;
  readonly resolve:(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal)=>Promise<{
    readonly policy:Omit<ContextPreparationPolicyInput,"inFlight"|"explorationHistory"|"optionalInFlight">;
    readonly expectedControlRevision:number;
    readonly execution:(decision:ReturnType<typeof decideContextPreparation>)=>ContextPreparationExecutionArrangement;
  }>;
}):ActivityReconsiderationHandler {
  return {prepare:async(snapshot,signal)=>{
    const resolved=await input.resolve(snapshot,signal),policy=resolved.policy;
    if(policy.scope.runId!==snapshot.state.subscription.runId)throw new TypeError("context_policy_subscription_mismatch");
    const previous=await input.decisions.query({kind:"latest",scopeId:policy.scope.id});
    const key=contextPreparationApplicabilityKey(policy),inFlight:ContextPreparationPolicyInput["inFlight"][number][]=[],
      explorationHistory:ContextPreparationPolicyInput["explorationHistory"][number][]=[];
    let optionalInFlight=0;
    const closures:SharedAcceptancePart[]=[];
    for(let afterWorkId:string|null=null;;) {
      signal.throwIfAborted();
      const records=await input.decisions.investments({scopeId:policy.scope.id,afterWorkId,limit:64});
      for(const record of records) {
        const original=record.investment!;
        if(record.decision.investment.kind!=="propose")throw new TypeError("context_policy_original_investment_invalid");
        if(record.decision.investment.explorationKey)explorationHistory.push({key:record.decision.investment.explorationKey,decisionId:record.decision.id});
        explorationHistory.push(...record.input.explorationHistory);
        const method=await input.methods.describe(original.pathId);
        const unused=policy.unusedProducers?.find(p=>p.workId===original.workId&&p.pathId===original.pathId);
        if(unused)closures.push(...await input.methods.prepareClosure(original.pathId,unused.evidence.id));
        if(record.decision.investment.reason==="optional"&&["accepted","active","unknown"].includes(method.state))optionalInFlight++;
        if(record.decision.applicabilityKey===key)inFlight.push({...original,applicabilityKey:key,producerState:method.state,
          evidence:{owner:"context-representation",kind:"fact",id:original.pathId,revision:String(method.revision)}});
      }
      if(records.length<64)break;afterWorkId=records.at(-1)!.investment!.workId;
    }
    const limitations=[...previous?.input.admissionLimitations??[],...policy.admissionLimitations??[]];
    const basis:ContextPreparationPolicyInput={...policy,inFlight,explorationHistory,optionalInFlight,
      admissionLimitations:limitations.filter((item,index)=>limitations.findIndex(other=>other.acceptanceId===item.acceptanceId)===index)};
    const project=async(basis:ContextPreparationPolicyInput):Promise<ActivityReconsiderationPreparation>=>{
      const decision=decideContextPreparation(basis);
      const id=contextPreparationAcceptanceId(basis,previous?.decision.id??null,snapshot);
      let execution=decision.investment.kind==="propose"?resolved.execution(decision):null;
      if(execution&&decision.investment.kind==="propose"&&decision.investment.replaces) {
        const ref=decision.investment.replaces;
        const path=await input.activities.command({kind:"read_path",pathId:ref.pathId}) as import("../activity/index.js").ActivityPathState|null;
        const scheduling=await input.activities.command({kind:"read_schedule",workId:ref.workId}) as ActivitySchedulingAcceptance|null;
        if(!path||!scheduling)throw new TypeError("context_policy_revision_original_unavailable");
        execution={...execution,original:{path,scheduling}};
      }
      const proposed=contextPreparationAcceptance({id,input:basis,expectedDecisionId:previous?.decision.id??null,expectedControlRevision:resolved.expectedControlRevision,
        reconsideration:null,execution,methods:input.methods});
      const parts=[...proposed.acceptance.parts,...closures];
      if(decision.investment.kind==="reuse"&&decision.investment.requiredService) {
        const schedule=await input.activities.command({kind:"read_schedule",workId:decision.investment.workId}) as ActivitySchedulingAcceptance|null;
        if(!schedule||schedule.closed)throw new TypeError("context_policy_original_schedule_unavailable");
        const reason=decision.investment.requiredService;
        if(schedule.intent.reason!==reason&&(reason==="necessary"||schedule.service==="spare"))parts.push({owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:schedule.revision,
          intent:{...schedule.intent,id:`${id}:treatment`,decisionId:decision.id,reason,delayImpact:reason==="necessary"?"Current input requires the original producer":"Evidence-backed opportunity now needs guaranteed service"}}});
      }
      return {decision:{owner:"context-representation",kind:"context_preparation_decision",id:decision.id,revision:decision.policy.revision},
        participants:parts,close:!policy.consumerActive,rejected:async receipt=>{
          if(decision.investment.kind!=="propose"||receipt.rejection?.owner!=="activity"||
            !["activity_schedule_pool_missing","activity_schedule_resource_unavailable"].includes(receipt.rejection.code))return null;
          const optionId=decision.investment.optionId,option=basis.options.find(option=>option.id===optionId)!;
          return project({...basis,admissionResponse:receipt.id,admissionLimitations:[...basis.admissionLimitations??[],
            {optionId,conditionsDigest:contextPreparationAdmissionKey(basis,option),acceptanceId:receipt.id,code:receipt.rejection.code}]});
        }};
    };
    return project(basis);
  }};
}
