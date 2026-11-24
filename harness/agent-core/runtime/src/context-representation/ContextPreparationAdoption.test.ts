import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {contextPreparationAdoption} from "./ContextPreparationAdoption.js";
import type {ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";
import type {SharedAcceptanceProposal} from "../activity/SharedAcceptance.js";
import type {ContextSelectionProposal} from "@agent-anything/context/selection";

function fixture(){
  const scope={id:"scope",runId:"run",recipient:"agent",purpose:"task",owner:"context-representation",continuity:"native",target:"config:1",authorityBasis:"original"};
  const exactInput={native:{input:[{role:"user",content:"Task"}],store:false},originalScope:"native"};
  const current={kind:"recipient_prepared" as const,scope,inputId:"input",bodyDigest:digest(exactInput.native),exactInputDigest:digest(exactInput),
    judgmentId:"judgment",allowed:true,risks:["capacity_unknown"],evidence:{owner:scope.owner,id:"judgment",revision:"1",kind:"fact" as const}};
  const input:ContextPreparationPolicyInput={scope,boundary:"b",requirementsDigest:"duties",current,currentRejectedInputId:null,
    alternatives:[],pressure:[],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
  const selection:ContextSelectionProposal={id:"accept",scopeId:scope.id,expectedSelectionId:null,expectedControlRevision:0,
    selection:{id:"selection",representations:[],judgmentIds:["judgment"],holds:[]},releaseHolds:[],
    input:{id:"input",activityId:"native-activity",stageRequestId:null,nativeConsumer:{protocol:{id:"openai.responses",revision:"1"},compositionDigest:"composition"},
      scopeId:scope.id,selectionId:"selection",exactInput,target:scope.target,deliveries:[],holds:[],combinationJudgmentId:"judgment"}};
  const checkedInput:SharedAcceptanceProposal={id:"accept",scope:"run",actor:scope.owner,parts:[{owner:"context_selection",kind:"selection_input",proposal:selection}]};
  const policy={id:"accept",input,expectedDecisionId:null,expectedControlRevision:0,reconsideration:null,execution:null,
    methods:{prepareSubmission(){throw new Error("No method investment requested");}}};
  return {policy,checkedInput,selection,current};
}
describe("native context policy adoption",()=>{
  it("accepts exact native input with the professional decision, without a generic request or Stage",()=>{
    const f=fixture(),result=contextPreparationAdoption(f);
    expect(result.parts.map(p=>p.owner)).toEqual(["context_preparation_policy","context_selection"]);
    expect(f.selection.input.stageRequestId).toBeNull();expect(f.selection.input.exactInput).not.toHaveProperty("encoded");
  });
  it.each(["id","combinationJudgmentId","exactInput"] as const)("rejects changed %s",field=>{
    const f=fixture();Object.assign(f.selection.input,{[field]:field==="exactInput"?{changed:true}:"changed"});
    expect(()=>contextPreparationAdoption(f)).toThrow("context_adoption_input_not_evaluated");
  });
  it("does not convert unavailable or rejected readiness into accepted continuation",()=>{
    const f=fixture();Object.assign(f.current,{allowed:false});
    expect(()=>contextPreparationAdoption(f)).toThrow("context_adoption_decision_binding_invalid");
  });
});
