import {createProcessComparison, createEvaluationProcessPlan, processStartingStateFacets, processComparisonBoundaries} from "@agent-anything/evaluation/process";
export const ref=(id,revision="1")=>({id,revision});
export const prompt='Using the retained evidence, answer only JSON with image5 (radius), image6 (radius), alpha ("preserved" or "changed"), version ("verified" or "unverified"). Do not perform image processing.';
export function comparisonDefinition(kind,{repetitions=1,live=false}={}){
  const arms=kind==="C01"?["original","candidate"]:kind==="C02"?["preserve","summarize"]:kind==="C03"?["early","deferred"]:["default","retain-original"];
  const order=Array.from({length:repetitions},(_,i)=>(i%2?[...arms].reverse():arms).map(arm=>({arm,repetition:i+1}))).flat();
  return createProcessComparison({ref:ref(`${kind}:${live?"live":"controlled"}`),kind,scope:kind==="C04"?"Complete formal Root task; legal retained-original comparison":"Declared material continuation, not a complete Agent policy",
    hypothesis:{C01:"Fixed candidate supports the same subsequent question without attributing its production cost",C02:"Complete representation production and subsequent use retain the source distinctions",C03:"Declared timing arrangements change actual preparation and foreground overlap without leaking the later question",C04:"Natural policy execution remains truthful; a legal original-input outcome need not transform"}[kind],
    arms,repetitions,order,environmentProtocol:ref("isolated-electron-sqlite-context"),stopping:{maxTrials:arms.length*repetitions,trialTimeoutMs:live?600000:180000,stopOnQuarantine:true},
    exclusions:kind==="C01"?["candidate_generation_before_start"]:[],limitations:["host_cache_not_reset","sequential_order_declared_not_randomized","no_currency_tariff_available",live?"single_local_model_configuration":"controlled_provider_not_model_quality",...(kind==="C03"?["explicit_timing_arrangement_not_default_policy_choice"]:[])]});
}
export function contextTrialPlan(definition,entry,{live=false,heldout=false}={}){
  const id=`${definition.ref.id}:${entry.arm}:${entry.repetition}:${heldout?"heldout":"primary"}`,createdAt=new Date().toISOString();
  const sources=[`User agreement: For images 2 through 10 use method A: radius ${heldout?4:3}; preserve the alpha channel. `+"Read-only observation; no changes. ".repeat(90),
    `User correction: From image 6 onward change radius to ${heldout?7:5}. Earlier images retain the original radius. Alpha must still be preserved. The output version has not been verified. `+"Independent observation; no changes. ".repeat(90)];
  const fixedCandidate=definition.kind==="C01"?(entry.arm==="original"?sources.join("\n"):`Images 2-5: radius ${heldout?4:3}; images 6-10: radius ${heldout?7:5}. Preserve alpha throughout. Output version remains unverified.`):null;
  const present=new Set(["sources","materials","ongoing_requirements","retention_and_access",...(fixedCandidate?["representations"]:[])]);
  return createEvaluationProcessPlan({trial:{ref:ref(id),campaignRef:definition.ref,targetSnapshotRef:ref("helarc-context-continuation"),caseRef:ref(heldout?"scoped-correction-heldout":"scoped-correction"),repetitionOrdinal:entry.repetition,seed:"fixed-source-v1",pairingKey:heldout?"heldout-source":"common-source",environmentProtocolRef:definition.environmentProtocol,createdAt,metadata:{}},
    mode:definition.kind==="C01"?"fixed_continuation":"actual_process",startingState:{ref:ref(`${id}:start`),construction:ref("retained-material-continuation"),boundary:processComparisonBoundaries[definition.kind],
      entries:processStartingStateFacets.map(facet=>({facet,owner:"context-continuation",disposition:present.has(facet)?"reconstructible":"empty",evidence:present.has(facet)?[ref(`case-source:${facet}:${heldout?"heldout":"primary"}`)]:[]}))},
    branch:{trialId:id,branchId:id,workspaceId:`${id}:workspace`,storageId:`${id}:storage`,authorityId:`${id}:authority`,activityNamespace:`${id}:scope`,commonHistory:ref("declared-materials")},
    targetInput:{comparison:definition.kind,arm:entry.arm,model:live?"gemma4:e4b":"controlled-context",createdAt,deadlineAt:new Date(Date.now()+definition.stopping.trialTimeoutMs).toISOString(),sources,fixedCandidate,
      method:entry.arm==="preserve"?"preserve":"summarize",prompt:definition.kind==="C03"?null:prompt,
      objective:"Retain the continuing method, its applicable range, the later correction, and the unverified version for subsequent use.",
      requirements:[{id:"continuing-method",revision:"1",basis:"user agreement and scoped correction",description:"Preserve the original radius before image 6, the later radius from image 6, the alpha constraint and the unverified version."}],
      relationships:[{id:"scoped-correction",sources:["source-0","source-1"],basis:"explicit later correction",description:"Later radius applies only from image 6 onward.",requiresCommonEvidence:true}]},
    variants:[{name:"arm",value:entry.arm}],expectationRefs:[ref(heldout?"private-heldout-facts":"private-source-facts")],claimRefs:[ref("subsequent_use"),ref("private_inputs_withheld")],captureSources:["execution","provider","inspector"],
    captureBounds:{maxBytesPerSource:16777216,maxRecordsPerSource:20000},futureStimuli:definition.kind==="C03"?[{id:"later-question",condition:{owner:"fixed-continuation",fact:"foreground_response_accepted",subject:`${id}:scope`},input:{prompt}}]:[],
    capturePolicyRef:ref("explicit-local-process-evidence"),evidenceLimitations:definition.limitations});
}
