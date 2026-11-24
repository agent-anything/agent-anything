import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityStageState} from "../activity/index.js";
import {validateContextRecipientInputCapacity,type ContextRecipientInputCapacity} from "./ContextRecipientInputCapacity.js";

/** The recipient owns native legality and projection. Shared consumers verify its accepted evidence. */
export interface NativeInputPreparationValue {
  readonly kind:"native_input_preparation";
  readonly revision:"1";
  readonly scope:ContextUseScope;
  readonly inputId:string;
  readonly exactInput:unknown;
  readonly projection:{readonly owner:string;readonly revision:string};
  readonly encoded:{readonly mediaType:string;readonly body:string;readonly bodyDigest:string};
  readonly capacity:ContextRecipientInputCapacity;
}
export interface NativeInputPreparationEvidence {
  readonly value:NativeInputPreparationValue;
  readonly origin:{readonly pathId:string;readonly stageId:string;readonly rawResultId:string;readonly receiptId:string};
}
export function nativeInputBodyDigest(body:string):string {
  return `sha256:${createHash("sha256").update(body,"utf8").digest("hex")}`;
}
export function validateNativeInputPreparation(value:NativeInputPreparationValue):void {
  if(value?.kind!=="native_input_preparation"||value.revision!=="1"||!value.inputId||value.exactInput==null||
    !value.projection?.owner||!value.projection.revision||!value.encoded?.mediaType||typeof value.encoded.body!=="string"||
    value.encoded.bodyDigest!==nativeInputBodyDigest(value.encoded.body)||value.capacity.inputId!==value.inputId)
    throw new TypeError("native_input_preparation_invalid");
  validateContextRecipientInputCapacity(value.capacity,value.scope);
}
export function confirmNativeInputPreparation(evidence:NativeInputPreparationEvidence,stage:ActivityStageState):void {
  validateNativeInputPreparation(evidence.value);
  const {origin,value}=evidence,r=stage.receipt;
  if(stage.request.id!==origin.stageId||stage.request.pathId!==origin.pathId||stage.status!=="accepted"||
    stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||stage.result.id!==origin.rawResultId||
    !r||r.id!==origin.receiptId||r.requestId!==origin.stageId||r.resultId!==origin.rawResultId||r.owner!==value.scope.owner||
    digest((r.progress as {nativeInputPreparation?:NativeInputPreparationValue}|null)?.nativeInputPreparation??null)!==digest(value))
    throw new TypeError("native_input_preparation_unconfirmed");
}
