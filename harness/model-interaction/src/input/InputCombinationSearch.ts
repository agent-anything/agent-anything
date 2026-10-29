import {inputChoiceGaps,validateInputDemand,type InputChoice,type InputCompositionGap,type InputOrganizationDemand} from "./InputContribution.js";
import type {InputCapacityAssessment} from "./InputCapacityEvidence.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";

export interface InputCombinationProgress {
  readonly demandDigest:string;
  readonly cursor:readonly number[];
  readonly baselineVisited:boolean;
  readonly exhausted:boolean;
  readonly tested:readonly {readonly id:string;readonly choice:InputChoice;readonly gaps:readonly InputCompositionGap[];readonly assessment:InputCapacityAssessment|null}[];
  readonly pending:{readonly id:string;readonly choice:InputChoice}|null;
  readonly externalMeasurements:number;
  readonly readBytes:number;
}
export type InputCombinationStep =
  | {readonly kind:"measure";readonly progress:InputCombinationProgress;readonly id:string;readonly choice:InputChoice}
  | {readonly kind:"ready";readonly progress:InputCombinationProgress;readonly id:string;readonly choice:InputChoice;readonly assessment:InputCapacityAssessment}
  | {readonly kind:"gap";readonly progress:InputCombinationProgress;readonly reason:"options_exhausted"|"search_budget_exhausted";readonly untested:boolean};

export function startInputCombinationSearch(demand:InputOrganizationDemand):InputCombinationProgress {
  validateInputDemand(demand);
  return {demandDigest:modelInputValueDigest(demand),cursor:demand.contributions.map(()=>0),baselineVisited:false,exhausted:false,tested:[],pending:null,externalMeasurements:0,readBytes:0};
}

/** Pure bounded enumeration. Remote work is a returned demand, never a budget callback. */
export function nextInputCombination(demand:InputOrganizationDemand, saved:InputCombinationProgress):InputCombinationStep {
  checkProgress(demand,saved);
  const ready=saved.tested.find(t=>t.assessment?.allowed && !t.gaps.length);
  if(ready)return {kind:"ready",progress:saved,id:ready.id,choice:ready.choice,assessment:ready.assessment!};
  if(saved.pending)return {kind:"measure",progress:saved,...saved.pending};
  let progress=structuredClone(saved);
  const ordered=demand.contributions.map(c=>[...c.options].sort((a,b)=>a.preference-b.preference ||
    Number(b.id===c.currentOptionId)-Number(a.id===c.currentOptionId) || a.id.localeCompare(b.id)));
  while(progress.tested.length < demand.maximumCombinations && !progress.exhausted) {
    const choice:Record<string,string>=Object.create(null) as Record<string,string>;
    if(!progress.baselineVisited) {
      for(const c of demand.contributions)choice[c.id]=c.currentOptionId;
      progress={...progress,baselineVisited:true};
    } else {
      for(let i=0;i<demand.contributions.length;i++)choice[demand.contributions[i]!.id]=ordered[i]![progress.cursor[i]!]!.id;
      const cursor=[...progress.cursor];let index=cursor.length-1;
      while(index>=0){cursor[index]=cursor[index]!+1;if(cursor[index]!<ordered[index]!.length)break;cursor[index]=0;index--;}
      progress={...progress,cursor,exhausted:index<0};
    }
    const id=modelInputValueDigest({demandDigest:progress.demandDigest,choice});
    if(progress.tested.some(t=>t.id===id))continue;
    const gaps=inputChoiceGaps(demand,choice);
    if(gaps.length){progress={...progress,tested:[...progress.tested,{id,choice,gaps,assessment:null}]};continue;}
    progress={...progress,pending:{id,choice}};
    return {kind:"measure",progress,id,choice};
  }
  return {kind:"gap",progress,reason:progress.exhausted?"options_exhausted":"search_budget_exhausted",untested:!progress.exhausted};
}

export function recordInputCombination(demand:InputOrganizationDemand, progress:InputCombinationProgress, id:string, assessment:InputCapacityAssessment):InputCombinationProgress {
  checkProgress(demand,progress);
  if(progress.pending?.id!==id || assessment.targetRevision!==demand.targetRevision || assessment.policy.purpose!==demand.purpose) throw new TypeError("input_search_result_scope_invalid");
  return {...progress,tested:[...progress.tested,{...progress.pending,gaps:[],assessment}],pending:null};
}

/** Reserve before actual external work; unknown dispatch never refunds a charge. */
export function chargeInputCombination(demand:InputOrganizationDemand, progress:InputCombinationProgress, charge:{externalMeasurements:number;readBytes:number}):InputCombinationProgress {
  checkProgress(demand,progress);
  if(!Number.isSafeInteger(charge.externalMeasurements)||charge.externalMeasurements<0||!Number.isSafeInteger(charge.readBytes)||charge.readBytes<0)throw new TypeError("input_search_charge_invalid");
  const next={...progress,externalMeasurements:progress.externalMeasurements+charge.externalMeasurements,readBytes:progress.readBytes+charge.readBytes};
  if(next.externalMeasurements>demand.maximumExternalMeasurements || next.readBytes>demand.maximumReadBytes)throw new TypeError("input_search_resource_exhausted");
  return next;
}

function checkProgress(demand:InputOrganizationDemand, progress:InputCombinationProgress):void {
  validateInputDemand(demand);
  if(progress.demandDigest!==modelInputValueDigest(demand)||progress.cursor.length!==demand.contributions.length ||
      progress.cursor.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>=demand.contributions[i]!.options.length) ||
      progress.tested.length>demand.maximumCombinations || new Set(progress.tested.map(t=>t.id)).size!==progress.tested.length ||
      progress.externalMeasurements>demand.maximumExternalMeasurements||progress.readBytes>demand.maximumReadBytes)throw new TypeError("input_search_binding_invalid");
}
