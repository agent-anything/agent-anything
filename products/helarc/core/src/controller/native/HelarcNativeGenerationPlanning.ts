import {modelInputValueDigest as digest,type CapacityReservation} from "@agent-anything/model-interaction/input";
import type {ProtocolExecutionJournal,ProtocolEvidencePage,ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {decodeNativeWorkIndexEntryMetadata,uniqueNativeWorkEntries} from "@agent-anything/provider-integrations/native";

export interface HelarcNativeGenerationPlanning {
  readonly id:string;
  readonly revision:"1";
  readonly scope:ProtocolModelActivity["scope"];
  readonly maximumSamples:number;
  readonly sampleWindowComplete:boolean;
  readonly samples:readonly {readonly activityId:string;readonly scopeId:string;readonly key:string;readonly revision:number;
    readonly workId:string;readonly usageRevision:string;readonly outputTokens:number}[];
  readonly excluded:readonly {readonly activityId:string;readonly key:string;readonly reason:string}[];
  readonly reservation:CapacityReservation;
}

/** A planning estimate from original usage metadata, never a bound on the next response. */
export async function readHelarcNativeGenerationPlanning(journal:ProtocolExecutionJournal,activity:ProtocolModelActivity):Promise<HelarcNativeGenerationPlanning>{
  const maximumSamples=32,scope=activity.scope;
  const page=await journal.command({kind:"usage_samples",runId:scope.runId,recipientId:scope.recipientId,
    purpose:scope.purpose,compositionDigest:scope.compositionDigest,limit:maximumSamples}) as ProtocolEvidencePage;
  if(!page||!Array.isArray(page.entries)||page.entries.length>maximumSamples)throw new TypeError("native_generation_sample_page_invalid");
  const decoded=page.entries.map(evidence=>{
    const work=decodeNativeWorkIndexEntryMetadata(evidence.metadata,evidence.memberships);
    if(evidence.kind!=="usage"||work.runId!==scope.runId||work.purpose!==scope.purpose.id||
      digest(work.protocol)!==digest(activity.composition.composition.protocol))throw new TypeError("native_generation_sample_scope_changed");
    return {evidence,work};
  });
  const unique=uniqueNativeWorkEntries(decoded.map(v=>v.work)),seen=new Set<string>();
  const samples:HelarcNativeGenerationPlanning["samples"][number][]=[],excluded:HelarcNativeGenerationPlanning["excluded"][number][]=[];
  for(const {evidence,work} of decoded){
    const reason=unique.conflictingWorkIds.includes(work.workId)?"conflicting_work":work.operation!=="generation"?"not_generation":
      work.usageState==="conflicting"?"conflicting_usage":work.finality!=="terminal"?"nonterminal_usage":
      work.outputState!=="known"||work.outputTokens===null?"output_usage_unknown":seen.has(work.workId)?"duplicate_work":null;
    if(reason){excluded.push({activityId:evidence.activityId,key:evidence.key,reason});continue;}
    seen.add(work.workId);
    samples.push({activityId:evidence.activityId,scopeId:evidence.scopeId,key:evidence.key,revision:evidence.revision,
      workId:work.workId,usageRevision:work.usageRevision,outputTokens:work.outputTokens!});
  }
  const basis={revision:"1" as const,scope,maximumSamples,sampleWindowComplete:page.next===null,samples,excluded};
  const id=`native-generation-planning:${digest(basis)}`;
  const reservation:CapacityReservation={id:`${id}:reservation`,purpose:"generation",dimension:"shared_tokens",alreadyIncluded:false,
    quantity:samples.length?{kind:"estimate",value:Math.max(...samples.map(s=>s.outputTokens)),
      limitations:["observed_sample_maximum_is_not_a_future_bound","sampled_usage_publications_not_all_history",
        "generation_task_complexity_can_change","unreported_components_are_not_inferred"]}:
      {kind:"unknown",reason:"no_applicable_terminal_generation_samples"},
    basis:`${id}; same Run, recipient, purpose and original composition; no output cap or new charge`};
  return {...basis,id,reservation};
}
