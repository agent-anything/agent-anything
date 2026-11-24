import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextInputBinding,ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityInputNeed,ActivityPathState,ActivityStageRequest,ActivityStageState,SharedAcceptancePart} from "../activity/index.js";
import {activityToken} from "../activity/index.js";

/** Accepted by the input-organizing owner. Readiness and native consumption have different identities. */
export interface NativeInputNeedDeclaration {
  readonly kind:"native_input_need";
  readonly revision:"1";
  readonly needId:string;
  readonly scope:ContextUseScope;
  readonly consumer:{readonly activityId:string;readonly protocol:{readonly id:string;readonly revision:string};readonly compositionDigest:string};
}
export interface NativeInputSupplyReturn {
  readonly needId:string;
  readonly origin:{readonly requestId:string;readonly receiptId:string};
  readonly inputId:string;
  readonly inputDigest:string;
  readonly readyStageId:string;
}
export interface NativeInputReady {
  readonly kind:"native_input_ready";
  readonly revision:"1";
  readonly needId:string;
  readonly inputId:string;
  readonly inputDigest:string;
}
export interface NativeInputSupplySelection {
  readonly acceptanceId:string;
  readonly scope:ContextUseScope;
  readonly input:Omit<ContextInputBinding,"exactInput">&{readonly exactInputDigest:string};
}

export function nativeInputReady(value:NativeInputSupplyReturn):NativeInputReady {
  validateNativeInputSupplyReturn(value);
  return {kind:"native_input_ready",revision:"1",needId:value.needId,inputId:value.inputId,inputDigest:value.inputDigest};
}
export function nativeInputSupplyReturnPart(value:NativeInputSupplyReturn):SharedAcceptancePart {
  validateNativeInputSupplyReturn(value);
  return {owner:"context_input_supply",kind:"native_input_return",proposal:value};
}
export function validateNativeInputSupplyReturn(value:NativeInputSupplyReturn):void {
  [value.needId,value.origin.requestId,value.origin.receiptId,value.inputId,value.inputDigest,value.readyStageId].forEach(activityToken);
}
export function confirmNativeInputNeed(need:ActivityInputNeed,source:ActivityStageState,path:ActivityPathState):NativeInputNeedDeclaration {
  const receipt=source.receipt;
  const declaration=(receipt?.progress as {contextInputNeed?:NativeInputNeedDeclaration}|null)?.contextInputNeed;
  if(!declaration||declaration.kind!=="native_input_need"||declaration.revision!=="1"||declaration.needId!==need.id||
    !need.origin||need.origin.requestId!==source.request.id||need.origin.receiptId!==receipt?.id||
    source.request.pathId!==path.intent.id||need.stage.pathId!==path.intent.id||need.unavailableStage.pathId!==path.intent.id||
    source.status!=="accepted"||source.result?.outcome!=="returned"||source.result.completeness!=="complete"||
    receipt.requestId!==source.request.id||receipt.resultId!==source.result.id||receipt.owner!==path.intent.purpose.contract.acceptanceOwner||
    declaration.scope.runId!==path.intent.runId||declaration.scope.owner!==need.supplier||!declaration.consumer)
    throw new TypeError("native_input_need_unconfirmed");
  const {scope,consumer}=declaration;
  [scope.id,scope.runId,scope.recipient,scope.purpose,scope.continuity,scope.owner,scope.target,scope.authorityBasis,
    consumer.activityId,consumer.protocol.id,consumer.protocol.revision,consumer.compositionDigest].forEach(activityToken);
  return declaration;
}
export function confirmNativeInputSupplyReturn(value:NativeInputSupplyReturn,evidence:{
  readonly need:ActivityInputNeed;readonly source:ActivityStageState;readonly path:ActivityPathState;
  readonly scope:ContextUseScope;readonly input:NativeInputSupplySelection["input"];readonly ready:ActivityStageRequest;
}):NativeInputNeedDeclaration {
  validateNativeInputSupplyReturn(value);
  const {need,source,path,scope,input,ready}=evidence,declaration=confirmNativeInputNeed(need,source,path);
  const {input:readyInput,...readyEntry}=ready;
  if(path.cancelled||value.needId!==need.id||digest(value.origin)!==digest(need.origin)||value.readyStageId!==need.stage.id||
    digest(readyEntry)!==digest(need.stage)||digest(readyInput)!==digest(nativeInputReady(value))||
    digest(scope)!==digest(declaration.scope)||input.scopeId!==scope.id||input.target!==scope.target||
    value.inputId!==input.id||value.inputDigest!==input.exactInputDigest||input.stageRequestId!==null||
    input.activityId!==declaration.consumer.activityId||
    digest(input.nativeConsumer??null)!==digest({protocol:declaration.consumer.protocol,compositionDigest:declaration.consumer.compositionDigest}))
    throw new TypeError("native_input_supply_return_mismatch");
  return declaration;
}
