import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityInputNeed,ActivityPathState,ActivityStageState} from "../activity/index.js";
import {confirmNativeInputNeed,confirmNativeInputSupplyReturn,nativeInputReady,type NativeInputNeedDeclaration,type NativeInputSupplyReturn} from "./NativeInputSupplyReturn.js";

function fixture(){
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",owner:"input-owner",continuity:"conversation",target:"original",authorityBasis:"grant"};
  const declaration:NativeInputNeedDeclaration={kind:"native_input_need",revision:"1",needId:"need",scope,
    consumer:{activityId:"native-task",protocol:{id:"openai-responses",revision:"1"},compositionDigest:"original-composition"}};
  const need:ActivityInputNeed={id:"need",supplier:scope.owner,origin:{requestId:"source",receiptId:"accepted-source"},
    stage:{id:"ready",pathId:"input-organizer",stageKind:"ready",capabilities:[],dependencies:[]},
    unavailableStage:{id:"unavailable",pathId:"input-organizer",stageKind:"unavailable",capabilities:[],dependencies:[]}};
  const path={intent:{id:"input-organizer",runId:scope.runId,purpose:{contract:{acceptanceOwner:"native-input"}}},cancelled:false} as ActivityPathState;
  const source={request:{id:"source",pathId:path.intent.id},status:"accepted",result:{id:"raw",outcome:"returned",completeness:"complete"},
    receipt:{id:"accepted-source",owner:"native-input",requestId:"source",resultId:"raw",progress:{contextInputNeed:declaration}}} as ActivityStageState;
  const value:NativeInputSupplyReturn={needId:need.id,origin:need.origin!,inputId:"selected",inputDigest:digest({native:"original"}),readyStageId:need.stage.id};
  const evidence={need,source,path,scope,ready:{...need.stage,input:nativeInputReady(value)},input:{id:value.inputId,activityId:declaration.consumer.activityId,
    stageRequestId:null,nativeConsumer:{protocol:declaration.consumer.protocol,compositionDigest:declaration.consumer.compositionDigest},scopeId:scope.id,
    selectionId:"selection",target:scope.target,deliveries:[],holds:[],combinationJudgmentId:"judgment",exactInputDigest:value.inputDigest}};
  return {value,evidence,declaration};
}
describe("native input readiness handoff",()=>{
  it("confirms the original need without treating a local return as native dispatch",()=>{
    const {value,evidence,declaration}=fixture();
    expect(confirmNativeInputSupplyReturn(value,evidence)).toEqual(declaration);
    expect(evidence.input.stageRequestId).toBeNull();expect(evidence.ready.pathId).not.toBe(evidence.input.activityId);
    expect(nativeInputReady(value)).not.toHaveProperty("exactInput");
  });
  it.each(["receipt","raw","source-owner","need","child","composition","protocol","native-activity","cancelled","body","return-entry","return-body","scope"])("rejects changed %s",change=>{
    const {value,evidence}=fixture();
    const e=structuredClone(evidence) as any;
    if(change==="receipt")e.source.receipt.id="changed";
    if(change==="raw")e.source.result.completeness="partial";
    if(change==="source-owner")e.source.receipt.owner="another";
    if(change==="need")e.need.origin.requestId="another";
    if(change==="child")e.scope.runId="child";
    if(change==="composition")e.input.nativeConsumer.compositionDigest="changed";
    if(change==="protocol")e.input.nativeConsumer.protocol={...e.input.nativeConsumer.protocol,id:"ollama-chat"};
    if(change==="native-activity")e.input.activityId="other-native-task";
    if(change==="cancelled")e.path.cancelled=true;
    if(change==="body")e.input.exactInputDigest="changed";
    if(change==="return-entry")e.ready.id="unavailable";
    if(change==="return-body")e.ready.input.inputId="another";
    if(change==="scope")e.scope={...e.scope,continuity:"other-conversation"};
    expect(()=>confirmNativeInputSupplyReturn(value,e)).toThrow();
  });
  it("does not interpret native fields to recover a missing declaration",()=>{
    const {evidence}=fixture();
    expect(()=>confirmNativeInputNeed(evidence.need,{...evidence.source,receipt:{...evidence.source.receipt!,progress:{}}},evidence.path)).toThrow("unconfirmed");
  });
});
