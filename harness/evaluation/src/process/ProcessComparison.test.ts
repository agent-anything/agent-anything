import {describe,it,expect} from "vitest";
import {createProcessComparison,assembleProcessComparison,processComparisonBoundaries,processEvidenceGrade} from "./ProcessComparison.js";
import {createEvaluationProcessPlan,processStartingStateFacets} from "./ProcessDefinition.js";
import type {ProcessComparisonTrial} from "./ProcessComparison.js";
const ref=(id:string)=>({id,revision:"1"});
const definition=()=>createProcessComparison({ref:ref("comparison"),kind:"C01",scope:"Fixed candidates only",hypothesis:"Subsequent use preserves declared facts",arms:["a","b"],repetitions:1,
  order:[{arm:"a",repetition:1},{arm:"b",repetition:1}],environmentProtocol:ref("environment"),stopping:{maxTrials:2,trialTimeoutMs:1000,stopOnQuarantine:true},exclusions:["generation"],limitations:[]});
function trial(arm="a"):ProcessComparisonTrial {
  const plan=createEvaluationProcessPlan({trial:{ref:ref(arm),campaignRef:ref("campaign"),targetSnapshotRef:ref("target"),caseRef:ref("case"),repetitionOrdinal:1,seed:"fixed",pairingKey:"pair",environmentProtocolRef:ref("environment"),createdAt:"2026-11-01T00:00:00.000Z",metadata:{}},
    mode:"actual_process",startingState:{ref:ref("start"),construction:ref("constructor"),boundary:"before_adoption",entries:processStartingStateFacets.map(facet=>({facet,owner:"target",disposition:"empty",evidence:[]}))},
    branch:{trialId:arm,branchId:arm,workspaceId:arm,storageId:arm,authorityId:arm,activityNamespace:arm,commonHistory:ref("common")},targetInput:{},variants:[],expectationRefs:[ref("private")],claimRefs:[ref("claim")],captureSources:["execution"],captureBounds:{maxBytesPerSource:1000,maxRecordsPerSource:10},futureStimuli:[],capturePolicyRef:ref("policy"),evidenceLimitations:[]});
  return {arm,repetition:1,plan,report:{trialRef:plan.trial.ref,recordRevision:1,execution:"completed",capture:null,cleanup:{status:"cleaned",resources:[],failures:[]},conclusions:[],failures:[],limitations:[]},grades:[],measurements:[]};
}
describe("process comparisons",()=>{
  it("defines four distinct starting boundaries and fixed independent repetitions",()=>{
    expect(Object.values(processComparisonBoundaries)).toEqual(["before_adoption","before_method","before_investment","task_start"]);
    expect(()=>createProcessComparison({...definition(),order:[{arm:"a",repetition:1},{arm:"a",repetition:1}]})).toThrow(/order/);
    expect(()=>createProcessComparison({...definition(),stopping:{...definition().stopping,maxTrials:3}})).toThrow(/budget/);
  });
  it("keeps missing trials explicit, refuses shifted boundaries and shared mutable branches",()=>{
    expect(assembleProcessComparison(definition(),[trial()]).missingTrials).toEqual([{arm:"b",repetition:1}]);
    expect(()=>assembleProcessComparison(definition(),[trial("b"),trial("a")])).toThrow(/order/);
    const wrong=trial();expect(()=>assembleProcessComparison(definition(),[{...wrong,plan:{...wrong.plan,startingState:{...wrong.plan.startingState,boundary:"task_start"}}}])).toThrow(/boundary/);
    const b=trial("b");expect(()=>assembleProcessComparison(definition(),[trial(),{...b,plan:{...b.plan,branch:{...b.plan.branch,storageId:"a"}}}])).toThrow(/storageId/);
  });
  it("does not silently turn unknown cost into zero or bind another trial grade",()=>{
    const t=trial(),m={name:"cost",role:"target" as const,unit:"currency" as const,value:null,evidence:[],unavailableReason:null};
    expect(()=>assembleProcessComparison(definition(),[{...t,measurements:[m]}])).toThrow(/Measurement/);
    expect(assembleProcessComparison(definition(),[{...t,measurements:[{...m,unavailableReason:"no tariff"}]}]).trials[0]!.measurements[0]!.value).toBeNull();
  });
  it("requires independent evidence for factual grades and explicit model attribution",()=>{
    const g={ref:ref("g"),captureRef:ref("capture"),criterionRef:ref("criterion"),graderRef:ref("grader"),dimension:"subsequent_use" as const,verdict:"conforms" as const,evidence:[],captureSlotIds:["execution"],rationale:"Source fact comparison",gradedAt:"2026-11-01T00:00:00.000Z",method:"deterministic" as const};
    expect(()=>processEvidenceGrade(g)).toThrow(/evidence/);
    expect(()=>processEvidenceGrade({...g,evidence:[ref("fact")],method:"hosted_model"})).toThrow(/attribution/);
    expect(()=>assembleProcessComparison(definition(),[{...trial(),grades:[processEvidenceGrade({...g,evidence:[ref("fact")]})]}])).toThrow(/capture/);
  });
});
