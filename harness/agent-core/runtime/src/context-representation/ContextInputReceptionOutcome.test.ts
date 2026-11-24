import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "../activity/index.js";
import type {ContextInputReceptionBinding} from "./ContextInputReceptionBinding.js";
import {readContextInputReceptionOutcome,type ContextInputReceptionOutcome} from "./ContextInputReceptionOutcome.js";

function fixture(){
  const binding:ContextInputReceptionBinding={revision:"1",pathId:"receiver",workId:"work",scope:{id:"scope",runId:"child",recipient:"agent",purpose:"task",
    target:"original-target",continuity:"task",owner:"context-representation",authorityBasis:"host"},boundary:"B",requirementsDigest:"R",
    members:[{workId:"producer-work",pathId:"producer",requestDigest:"original-request"}]};
  const outcome:ContextInputReceptionOutcome={kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(binding),
    result:{kind:"gap",gap:{reason:"capacity",demandId:"native-input",targetRevision:binding.scope.target,information:[],capacity:[],untested:false,responsibility:"request_owner"}}};
  const progress={inputReceptionOutcome:outcome,privateNativeState:{notInterpreted:true}};
  const path={intent:{id:binding.pathId,runId:binding.scope.runId,owner:binding.scope.owner,permissionBasis:binding.scope.authorityBasis,scheduledWorkId:binding.workId},
    progressRevision:3,controlRevision:0,cancelled:false,progress} as unknown as ActivityPathState;
  const stage={request:{id:"assess",pathId:binding.pathId},status:"accepted",result:{id:"raw",completeness:"complete",outcome:"returned"},
    receipt:{requestId:"assess",resultId:"raw",owner:binding.scope.owner,expectedProgressRevision:2,progress}} as unknown as ActivityStageState;
  return {binding,outcome,path,stage};
}
describe("recipient outcome handoff",()=>{
  it("reads accepted outcome without inspecting a private organization or inventing a model request",()=>{
    const f=fixture();expect(readContextInputReceptionOutcome(f.binding,f.path,f.stage)).toEqual(f.outcome);
    expect(readContextInputReceptionOutcome(f.binding,{...f.path,cancelled:true,controlRevision:1},f.stage)).toEqual(f.outcome);
  });
  it.each(["recipient","target","boundary","requirements","producer"])("rejects changed original %s",field=>{
    const f=fixture(),binding={...f.binding,
      ...(field==="recipient"?{scope:{...f.binding.scope,recipient:"other"}}:{}),
      ...(field==="target"?{scope:{...f.binding.scope,target:"other"}}:{}),
      ...(field==="boundary"?{boundary:"later"}:{}),...(field==="requirements"?{requirementsDigest:"other"}:{}),
      ...(field==="producer"?{members:[]}:{}),};
    expect(()=>readContextInputReceptionOutcome(binding,f.path,f.stage)).toThrow("unconfirmed");
  });
  it.each(["not_accepted","missing_result","wrong_result","owner","stale","progress"])("rejects unconfirmed %s",kind=>{
    const f=fixture(),stage={...f.stage,
      ...(kind==="not_accepted"?{status:"returned"}:{}),...(kind==="missing_result"?{result:null}:{}),
      receipt:{...f.stage.receipt!,...(kind==="wrong_result"?{resultId:"other"}:{}),...(kind==="owner"?{owner:"other"}:{}),
        ...(kind==="stale"?{expectedProgressRevision:1}:{}),...(kind==="progress"?{progress:{}}:{})},} as ActivityStageState;
    expect(()=>readContextInputReceptionOutcome(f.binding,f.path,stage)).toThrow("unconfirmed");
  });
  it("rejects an accepted conclusion for a different target",()=>{
    const f=fixture(),outcome={...f.outcome,result:{kind:"gap",gap:{...(f.outcome.result as {gap:object}).gap,targetRevision:"other"}}};
    const progress={inputReceptionOutcome:outcome};
    expect(()=>readContextInputReceptionOutcome(f.binding,{...f.path,progress},{...f.stage,receipt:{...f.stage.receipt!,progress}})).toThrow("scope_changed");
  });
});
