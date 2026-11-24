import {modelInputValueDigest,type InputMeasurementEvidence,type CapacityReservation} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {INITIAL_CONTEXT_PREPARATION_POLICY,type ContextPolicyEvidence,type ContextPreparationPressure} from "./ContextPreparationPolicy.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {ContextPreparationWorkEvidence} from "./ContextPreparationWorkEvidence.js";
import type {ContextPreparationDecisionStore} from "./ContextPreparationDecisionStore.js";
import type {ActivityHandoffPort} from "../activity/index.js";
import {readContextMethodCostObservation,type ContextMethodCostObservation} from "./ContextMethodCostObservation.js";
import type {ModelInteractionProjection} from "../decision/TaskDecisionActivity.js";
import {validateContextRecipientInputCapacity,type ContextRecipientInputCapacity} from "./ContextRecipientInputCapacity.js";

export interface ContextInputObservation {
  readonly inputId:string;
  readonly sequence:number;
  readonly inputRevision:number;
  readonly observedAt:string;
  readonly representationContinuity:string;
  readonly evidence:ContextPolicyEvidence;
  readonly measurements:readonly InputMeasurementEvidence[];
}
export interface ContextPreparationObservationWindow {
  readonly scope:ContextUseScope;
  readonly settingsRevision:string;
  readonly inputs:readonly ContextInputObservation[];
}
export interface ContextGrowthScenario {
  readonly evidence:ContextPolicyEvidence;
  readonly measurementId:string;
  readonly limitId:string;
  readonly deltas:readonly number[];
  readonly retainedInputIds:readonly string[];
  readonly current:number;
  readonly reserved:number;
  readonly reservationComplete:boolean;
  readonly unknownReservationIds:readonly string[];
  readonly estimatedReservationIds?:readonly string[];
  readonly maximum:number;
  readonly projectedNext:number;
  readonly excluded:readonly {readonly inputId:string;readonly reason:string}[];
}
export interface ContextPreparationCostEvidence {
  readonly pathId:string;
  readonly evidence:ContextPolicyEvidence;
  readonly state:ContextPreparationWorkEvidence["state"];
  readonly confirmedProgress:{readonly stageAdmissions:number;readonly dispatchedAttempts:number;readonly acceptedReadBytes:number|null;readonly acceptedStoredBytes:number|null;readonly modelInputsPrepared:number|null};
  readonly actual:ContextMethodCostObservation|null;
  readonly reserved:Readonly<Record<string,number>>;
  readonly remainingAllowance:ContextPreparationWorkEvidence["remaining"];
  readonly forecast:"unknown";
  readonly limitations:readonly string[];
}
export interface ContextPreparationEvidenceReport {
  readonly window:ContextPreparationObservationWindow;
  readonly growth:readonly ContextGrowthScenario[];
  readonly capacityRisks?:readonly {readonly evidence:ContextPolicyEvidence;readonly measurementId:string;readonly limitId:string;
    readonly current:number;readonly maximum:number;readonly reservedMinimum:number;readonly unknownReservationIds:readonly string[];
    readonly reservedEstimate?:number;readonly estimatedReservationIds?:readonly string[]}[];
  readonly costs:readonly ContextPreparationCostEvidence[];
  readonly limitations:readonly string[];
}

export type {ContextPreparationWorkEvidence} from "./ContextPreparationWorkEvidence.js";

/** Bounded owner queries; the retained decision, never Inspector, restores the evidence window. */
export async function readContextPreparationEvidence(input:Omit<ContextPreparationObservationBasis,"previous">&ContextPreparationObservationInput&{
  readonly decisions:ContextPreparationDecisionStore;
  readonly methods:{readonly describe:(pathId:string)=>Promise<ContextPreparationWorkEvidence>};
  readonly activities:ActivityHandoffPort;
},signal:AbortSignal):Promise<ReturnType<typeof observeContextPreparationInput>> {
  signal.throwIfAborted();
  const previous=await input.decisions.query({kind:"latest_observation",scopeId:input.scope.id});
  if(previous&&modelInputValueDigest(previous.input.scope)!==modelInputValueDigest(input.scope))throw new TypeError("context_observation_scope_changed");
  if(previous&&!previous.input.observationReport)throw new TypeError("context_observation_report_missing");
  const observed=observeContextPreparationInput({...input,previous:previous?.input.observationReport?.window??null});
  const records=await input.decisions.investments({scopeId:input.scope.id,afterWorkId:null,limit:INITIAL_CONTEXT_PREPARATION_POLICY.maximumOptions+1});
  const costs:ContextPreparationCostEvidence[]=[];
  for(const record of records.slice(0,INITIAL_CONTEXT_PREPARATION_POLICY.maximumOptions)) {
    signal.throwIfAborted();
    if(!record.investment||modelInputValueDigest(record.input.scope)!==modelInputValueDigest(input.scope))throw new TypeError("context_cost_scope_changed");
    const pathId=record.investment.pathId;
    const actual=await readContextMethodCostObservation({runId:input.scope.runId,pathId,activities:input.activities,
      previous:previous?.input.observationReport?.costs.find(cost=>cost.pathId===pathId)?.actual??null},signal);
    costs.push(contextPreparationCostEvidence(pathId,await input.methods.describe(pathId),actual));
  }
  signal.throwIfAborted();
  return {...observed,report:{...observed.report,costs,limitations:[...observed.report.limitations,
    ...(records.length>INITIAL_CONTEXT_PREPARATION_POLICY.maximumOptions?["method_cost_observation_window_incomplete"]:[])]}};
}

/** Stable across ordinary turns; only accepted presentation changes split comparable baseline measurements. */
export function acceptedConversationRepresentationContinuity(input:Pick<ModelInteractionProjection,"opening"|"historyPresentations"|"workingForms"|"workingAccounts">):string {
  const native=[...(input.opening?.presentations??[]),...(input.historyPresentations??[])].flatMap(({section})=>{
    const presenter=section.provenance?.presenter;
    return presenter?.owner==="agent-runtime"&&presenter.kind==="result_presentation_receipt"?[{sectionId:section.id,presenter}]:[];
  });
  const forms=input.workingForms??[],accounts=input.workingAccounts??[];
  return native.length||forms.length||accounts.length?`accepted-representations:${modelInputValueDigest({native,forms,accounts})}`:"original";
}

interface ContextPreparationObservationBasis {
  readonly scope:ContextUseScope;readonly settingsRevision:string;readonly sequence:number;readonly observedAt:string;readonly inputRevision?:number;
  readonly representationContinuity:string;readonly evidence:ContextPolicyEvidence;
  readonly previous:ContextPreparationObservationWindow|null;
}
type ContextPreparationObservationInput={readonly prepared:PreparedContextInput;readonly recipient?:never}|
  {readonly recipient:ContextRecipientInputCapacity;readonly prepared?:never};

/** Uses complete input evidence, not text length, age or an inferred task horizon. */
export function observeContextPreparationInput(input:ContextPreparationObservationBasis&ContextPreparationObservationInput
):{readonly report:ContextPreparationEvidenceReport;readonly pressure:readonly ContextPreparationPressure[]} {
  const {scope,previous}=input;
  const capacity=input.recipient??{inputId:input.prepared!.encoded.id,measurements:input.prepared!.measurement,
    limits:input.prepared!.limits,assessment:input.prepared!.capacity};
  if(input.recipient)validateContextRecipientInputCapacity(input.recipient,scope);
  const demand=input.prepared?.demand;
  if(previous&&(modelInputValueDigest(previous.scope)!==modelInputValueDigest(scope)||previous.settingsRevision!==input.settingsRevision))
    throw new TypeError("context_observation_scope_changed");
  if(!Number.isSafeInteger(input.sequence)||input.sequence<0||!Number.isFinite(Date.parse(input.observedAt))||!input.settingsRevision||!input.representationContinuity||
    demand&&(demand.runId!==scope.runId||demand.recipient!==scope.recipient||demand.purpose!==scope.purpose||demand.targetRevision!==scope.target))
    throw new TypeError("context_observation_input_invalid");
  const inputRevision=input.inputRevision??0;
  if(!Number.isSafeInteger(inputRevision)||inputRevision<0)throw new TypeError("context_observation_revision_invalid");
  const observation:ContextInputObservation={inputId:capacity.inputId,sequence:input.sequence,inputRevision,observedAt:input.observedAt,
    representationContinuity:input.representationContinuity,evidence:input.evidence,measurements:capacity.measurements};
  const values=[...previous?.inputs??[]];
  if(values.length>INITIAL_CONTEXT_PREPARATION_POLICY.observations)throw new TypeError("context_observation_window_invalid");
  const same=values.find(v=>v.sequence===input.sequence);
  if(same) {
    if(inputRevision===same.inputRevision) {
      if(modelInputValueDigest(same)!==modelInputValueDigest(observation))throw new TypeError("context_observation_identity_changed");
    } else {
      if(inputRevision<same.inputRevision||same!==values.at(-1))throw new TypeError("context_observation_revision_regressed");
      values[values.length-1]=observation;
    }
  } else {
    if(values.length&&values.at(-1)!.sequence>=input.sequence)throw new TypeError("context_observation_sequence_regressed");
    values.push(observation);
  }
  const inputs=values.slice(-INITIAL_CONTEXT_PREPARATION_POLICY.observations),growth:ContextGrowthScenario[]=[];
  const capacityRisks:NonNullable<ContextPreparationEvidenceReport["capacityRisks"]>[number][]=[];
  for(const measurement of capacity.measurements) {
    const current=point(measurement);if(current===null)continue;
    const reservation=reservationPlanning(capacity.assessment.reservations,measurement.dimension),reserved=reservation.planned;
    for(const limit of capacity.limits.filter(l=>l.dimension===measurement.dimension))if(current+reserved>limit.maximum) {
      const basis={measurementId:measurement.id,limitId:limit.id,current,maximum:limit.maximum,reservedMinimum:reservation.lower,unknownReservationIds:reservation.unknownIds,
        ...(reservation.estimatedIds.length?{reservedEstimate:reserved,estimatedReservationIds:reservation.estimatedIds}:{})};
      capacityRisks.push({...basis,evidence:{id:`context-input-risk:${modelInputValueDigest(basis)}`,owner:scope.owner,kind:"estimate",revision:"1"}});
    }
    const comparable=inputs.map(item=>({item,measurement:item.representationContinuity===input.representationContinuity?
      item.measurements.find(m=>m.dimension===measurement.dimension&&m.methodRevision===measurement.methodRevision&&m.targetRevision===measurement.targetRevision):undefined}));
    const deltas:number[]=[],retainedInputIds:string[]=[],excluded:ContextGrowthScenario["excluded"][number][]=[];
    for(let i=1;i<comparable.length;i++) {
      const before=comparable[i-1]!,after=comparable[i]!,a=before.measurement?point(before.measurement):null,b=after.measurement?point(after.measurement):null;
      if(a===null||b===null||after.item.sequence!==before.item.sequence+1) {
        excluded.push({inputId:after.item.inputId,reason:"adjacent_comparable_input_missing"});continue;
      }
      deltas.push(b-a);retainedInputIds.push(before.item.inputId,after.item.inputId);
    }
    if(deltas.length<INITIAL_CONTEXT_PREPARATION_POLICY.minimumObservations)continue;
    const maximumGrowth=Math.max(...deltas);if(maximumGrowth<=0)continue;
    for(const limit of capacity.limits.filter(l=>l.dimension===measurement.dimension)) {
      const projectedNext=current+reserved+maximumGrowth;
      if(current+reserved>limit.maximum||projectedNext<=limit.maximum)continue;
      const basis={scope:scope.id,measurementId:measurement.id,limitId:limit.id,deltas,retainedInputIds:[...new Set(retainedInputIds)],
        current,reserved,reservationComplete:!reservation.unknownIds.length&&!reservation.estimatedIds.length,unknownReservationIds:reservation.unknownIds,
        ...(reservation.estimatedIds.length?{estimatedReservationIds:reservation.estimatedIds}:{}),maximum:limit.maximum,projectedNext,excluded};
      growth.push({...basis,evidence:{id:`context-growth:${modelInputValueDigest(basis)}`,owner:scope.owner,kind:"estimate",revision:"1"}});
    }
  }
  const report:ContextPreparationEvidenceReport={window:{scope,settingsRevision:input.settingsRevision,inputs},growth,capacityRisks,costs:[],
    limitations:["prepared_input_is_not_delivery_or_billed_usage","observed_growth_is_not_a_safety_bound","preparation_and_arrival_timing_unknown",
      ...(growth.length?[]:["no_supported_next_input_capacity_risk"]),
      ...(capacityRisks.some(r=>r.unknownReservationIds.length)||growth.some(g=>g.unknownReservationIds.length)?["unknown_reservations_use_only_nonnegative_lower_bounds"]:[]),
      ...(capacityRisks.some(r=>r.estimatedReservationIds?.length)||growth.some(g=>g.estimatedReservationIds?.length)?["estimated_generation_space_is_not_a_proven_requirement"]:[])]};
  return {report,pressure:[...capacityRisks.map(r=>({kind:"input_capacity_risk" as const,inputId:capacity.inputId,evidence:r.evidence})),
    ...growth.map(g=>({kind:"growth_scenario" as const,inputId:capacity.inputId,evidence:g.evidence,timing:null}))]};
}

export function contextPreparationCostEvidence(pathId:string,description:ContextPreparationWorkEvidence,actual:ContextMethodCostObservation|null=null):ContextPreparationCostEvidence {
  const used=description.used;
  return {pathId,evidence:{id:pathId,owner:"activity",revision:String(description.revision),kind:"fact"},state:description.state,
    confirmedProgress:{stageAdmissions:used.stages,dispatchedAttempts:used.attempts,acceptedReadBytes:used.readBytes,acceptedStoredBytes:used.storedBytes,modelInputsPrepared:used.modelCalls},actual,
    reserved:description.allowance.reserved,remainingAllowance:description.remaining,forecast:"unknown",
    limitations:[...description.limitations,"confirmed_consumption_is_not_remaining_cost","reservations_are_not_billed_usage",
      "prepared_model_inputs_are_not_actual_calls","unaccepted_results_are_not_in_progress_counts",
      "total_elapsed_billing_and_future_detail_cost_not_established"]};
}

function point(measurement:InputMeasurementEvidence):number|null {
  if(measurement.coverage!=="complete"||measurement.uncovered.length)return null;
  const q=measurement.quantity;
  if(q.kind==="exact"||q.kind==="estimate")return q.value;
  return q.kind==="bounds"&&q.upper===q.lower?q.lower:null;
}
function reservationPlanning(reservations:readonly CapacityReservation[],dimension:InputMeasurementEvidence["dimension"]):{
  lower:number;planned:number;unknownIds:readonly string[];estimatedIds:readonly string[]
} {
  let lower=0,planned=0;const unknownIds:string[]=[],estimatedIds:string[]=[];
  for(const r of reservations.filter(r=>r.dimension===dimension&&!r.alreadyIncluded&&r.purpose!=="future_growth")) {
    if(r.quantity.kind==="exact"){lower+=r.quantity.value;planned+=r.quantity.value;}
    else if(r.quantity.kind==="estimate"){planned+=r.quantity.value;estimatedIds.push(r.id);}
    else {unknownIds.push(r.id);if(r.quantity.kind==="bounds"){lower+=r.quantity.lower;planned+=r.quantity.lower;}}
  }
  return {lower,planned,unknownIds,estimatedIds};
}
