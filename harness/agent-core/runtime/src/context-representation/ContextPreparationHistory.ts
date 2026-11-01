import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {contextPreparationWorkKey,type ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";
import type {ContextPreparationDecisionRecord,ContextPreparationDecisionStore} from "./ContextPreparationDecisionStore.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";

export type ContextPreparationCurrentEvidence=Omit<ContextPreparationPolicyInput,"inFlight"|"explorationHistory"|"optionalInFlight">;
type ProducerDescription=Pick<Awaited<ReturnType<RepresentationMethodWork["describe"]>>,"state"|"revision">;

/** Reads accepted work for the original recipient. It neither decides nor accepts preparation. */
export async function readContextPreparationHistory(input:{
  readonly current:ContextPreparationCurrentEvidence;
  readonly decisions:ContextPreparationDecisionStore;
  readonly methods:{readonly describe:(pathId:string)=>Promise<ProducerDescription>};
},signal:AbortSignal):Promise<{
  readonly previous:ContextPreparationDecisionRecord|null;
  readonly basis:ContextPreparationPolicyInput;
  readonly producers:readonly {readonly record:ContextPreparationDecisionRecord;readonly description:ProducerDescription}[];
}> {
  signal.throwIfAborted();
  const current=input.current,scopeDigest=modelInputValueDigest(current.scope);
  const checkScope=(record:ContextPreparationDecisionRecord)=>{
    if(modelInputValueDigest(record.input.scope)!==scopeDigest||modelInputValueDigest(record.decision.scope)!==scopeDigest)
      throw new TypeError("context_preparation_history_scope_changed");
  };
  const previous=await input.decisions.query({kind:"latest",scopeId:current.scope.id});
  if(previous)checkScope(previous);
  const inFlight:ContextPreparationPolicyInput["inFlight"][number][]=[];
  const exploration=new Map<string,ContextPreparationPolicyInput["explorationHistory"][number]>();
  for(const entry of previous?.input.explorationHistory??[])exploration.set(modelInputValueDigest(entry),entry);
  const producers:{record:ContextPreparationDecisionRecord;description:ProducerDescription}[]=[],seen=new Set<string>();
  let optionalInFlight=0;
  for(let afterWorkId:string|null=null;;) {
    signal.throwIfAborted();
    const records=await input.decisions.investments({scopeId:current.scope.id,afterWorkId,limit:64});
    if(records.length>64)throw new TypeError("context_preparation_history_page_invalid");
    for(const record of records) {
      signal.throwIfAborted();checkScope(record);
      const original=record.investment;
      if(!original||record.decision.investment.kind!=="propose"||seen.has(original.workId))
        throw new TypeError("context_policy_original_investment_invalid");
      seen.add(original.workId);
      const entries=[...record.input.explorationHistory,...(record.decision.investment.explorationKey?
        [{key:record.decision.investment.explorationKey,decisionId:record.decision.id}]:[])];
      for(const entry of entries)exploration.set(modelInputValueDigest(entry),entry);
      const description=await input.methods.describe(original.pathId);
      signal.throwIfAborted();producers.push({record,description});
      if(record.decision.investment.reason==="optional"&&["accepted","active","unknown"].includes(description.state))optionalInFlight++;
      const optionId=record.decision.investment.optionId,option=record.input.options.find(o=>o.id===optionId);
      if(!option)throw new TypeError("context_policy_original_option_missing");
      inFlight.push({...original,preparationKey:contextPreparationWorkKey(record.input.scope,option.request),producerState:description.state,
        evidence:{owner:"context-representation",kind:"fact",id:original.pathId,revision:String(description.revision)}});
    }
    if(records.length<64)break;
    afterWorkId=records.at(-1)!.investment!.workId;
  }
  signal.throwIfAborted();
  const limitations=new Map<string,NonNullable<ContextPreparationPolicyInput["admissionLimitations"]>[number]>();
  for(const item of [...previous?.input.admissionLimitations??[],...current.admissionLimitations??[]]) {
    const prior=limitations.get(item.acceptanceId);
    if(prior&&modelInputValueDigest(prior)!==modelInputValueDigest(item))throw new TypeError("context_preparation_history_limitation_changed");
    limitations.set(item.acceptanceId,item);
  }
  return {previous,producers,basis:{...current,inFlight,explorationHistory:[...exploration.values()],optionalInFlight,
    admissionLimitations:[...limitations.values()]}};
}
