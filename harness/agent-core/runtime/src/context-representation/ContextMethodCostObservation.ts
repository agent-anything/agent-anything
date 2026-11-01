import type {ActivityHandoffPort,ActivityHandoffFact} from "../activity/index.js";

const dimensions=["localMs","providerElapsedMs","preDispatchMs","inputTokens","outputTokens"] as const;
export interface ContextMethodCostObservation {
  readonly runId:string;
  readonly pathId:string;
  readonly through:number;
  readonly caughtUpAtRead:boolean;
  readonly rawResults:number;
  readonly outcomes:Readonly<Record<"returned"|"failed"|"unknown",number>>;
  readonly partialResults:number;
  readonly reported:Readonly<Partial<Record<typeof dimensions[number],{readonly total:number;readonly samples:number}>>>;
  readonly limitations:readonly string[];
}

/** Finite actual-result observations, not billed cost, predicted work or whole-path latency. */
export async function readContextMethodCostObservation(input:{
  readonly runId:string;readonly pathId:string;readonly activities:ActivityHandoffPort;
  readonly previous:ContextMethodCostObservation|null;
},signal:AbortSignal):Promise<ContextMethodCostObservation> {
  signal.throwIfAborted();const {previous}=input;
  if(previous&&(previous.runId!==input.runId||previous.pathId!==input.pathId||!Number.isSafeInteger(previous.through)||previous.through<0))
    throw new TypeError("context_method_cost_scope_changed");
  const facts=await input.activities.command({kind:"facts",runId:input.runId,pathId:input.pathId,after:previous?.through??0,limit:256}) as readonly ActivityHandoffFact[];
  if(facts.length>256)throw new TypeError("context_method_cost_page_invalid");
  const reported:Partial<Record<typeof dimensions[number],{total:number;samples:number}>>=structuredClone(previous?.reported??{});
  const outcomes={...previous?.outcomes??{returned:0,failed:0,unknown:0}};
  let through=previous?.through??0,rawResults=previous?.rawResults??0,partialResults=previous?.partialResults??0;
  for(const fact of facts) {
    signal.throwIfAborted();
    if(fact.runId!==input.runId||fact.pathId!==input.pathId||!Number.isSafeInteger(fact.sequence)||fact.sequence<=through)
      throw new TypeError("context_method_cost_fact_scope_invalid");
    through=fact.sequence;
    if(fact.kind!=="raw_saved")continue;
    rawResults++;
    const outcome=fact.details.outcome;
    if(outcome!=="returned"&&outcome!=="failed"&&outcome!=="unknown")throw new TypeError("context_method_cost_outcome_invalid");
    outcomes[outcome]++;if(fact.details.completeness!=="complete")partialResults++;
    const usage=fact.details.usage;
    if(!usage||typeof usage!=="object"||Array.isArray(usage))continue;
    for(const dimension of dimensions) {
      const amount=(usage as Record<string,unknown>)[dimension];
      if(typeof amount!=="number"||!Number.isFinite(amount)||amount<0)continue;
      const prior=reported[dimension],total=(prior?.total??0)+amount;
      if(!Number.isFinite(total))throw new TypeError("context_method_cost_total_invalid");
      reported[dimension]={total,samples:(prior?.samples??0)+1};
    }
  }
  signal.throwIfAborted();
  return {runId:input.runId,pathId:input.pathId,through,caughtUpAtRead:facts.length<256,rawResults,outcomes,partialResults,reported,
    limitations:["only_recorded_values_are_counted","unreported_usage_remains_unknown","reported_tokens_are_not_billing",
      "phase_times_are_not_whole_path_elapsed_or_remaining_cost",...(facts.length===256?["cost_fact_read_incomplete"]:[])]};
}
