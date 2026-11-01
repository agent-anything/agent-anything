import type {ModelInputComposition} from "./ModelInput.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";
import type {ProviderInputAccounting} from "../context/ModelInputAccounting.js";
import type {ModelInputMeasurement} from "../context/ModelContext.js";
import type {ProviderUsage} from "../ProviderUsage.js";

export interface InputAccountingFootprint {
  readonly basisKey:string;
  readonly schemaDigest:string;
  readonly bytes:number;
  readonly inputUsage:"complete"|"unknown";
}
export interface AcceptedInputUsage {
  readonly id:string;
  readonly runId:string;
  readonly purpose:string;
  readonly targetRevision:string;
  readonly encodedInputId:string;
  readonly stageId:string;
  readonly rawResultId:string;
  readonly acceptanceId:string;
  readonly recordedAt:string;
  readonly footprint:InputAccountingFootprint;
  readonly inputTokens:number;
}
export interface InputUsageQuery {
  readonly runId:string;
  readonly purpose:string;
  readonly targetRevision:string;
  readonly basisKey:string;
  readonly schemaDigest:string;
}
export interface InputUsageEvidencePort {
  latest(query:InputUsageQuery):Promise<AcceptedInputUsage|null>;
}
export interface InputMeasurementDerivation {
  readonly kind:"provider"|"accepted_usage"|"unknown";
  readonly observation:AcceptedInputUsage|null;
  readonly limitations:readonly string[];
}

export function inputAccountingFootprint(accounting:ProviderInputAccounting|undefined,composition:ModelInputComposition):InputAccountingFootprint|null {
  if(!accounting)return null;
  const footprint=accounting.project(composition);
  const result={basisKey:modelInputValueDigest({basis:accounting.basis,inputUsage:accounting.inputUsage,revision:"accepted-input-usage.v1"}),
    schemaDigest:footprint.schemaDigest,bytes:footprint.bytes,inputUsage:accounting.inputUsage};
  validateFootprint(result);return result;
}
export function createAcceptedInputUsage(input:Omit<AcceptedInputUsage,"id"|"inputTokens">,usage:ProviderUsage|null):AcceptedInputUsage|null {
  if(input.footprint.inputUsage!=="complete"||!usage||typeof usage.inputTokens!=="number"||!Number.isSafeInteger(usage.inputTokens)||usage.inputTokens<=0||
    usage.metadata.accountingConsistent===false||usage.metadata.inputTruncated===true)return null;
  const body={...input,inputTokens:usage.inputTokens};
  const result={...body,id:modelInputValueDigest(body)};validateAcceptedInputUsage(result);return result;
}
export function validateAcceptedInputUsage(value:AcceptedInputUsage):void {
  if(!value||typeof value!=="object")throw new TypeError("input_usage_invalid");
  const {id,...body}=value;
  if(id!==modelInputValueDigest(body))throw new TypeError("input_usage_identity_changed");
  for(const token of [value.runId,value.purpose,value.targetRevision,value.encodedInputId,value.stageId,value.rawResultId,value.acceptanceId,value.recordedAt])
    if(typeof token!=="string"||!token.length||token.length>4096)throw new TypeError("input_usage_scope_invalid");
  validateFootprint(value.footprint);
  if(value.footprint.inputUsage!=="complete"||!Number.isSafeInteger(value.inputTokens)||value.inputTokens<=0||!Number.isFinite(Date.parse(value.recordedAt)))
    throw new TypeError("input_usage_measurement_invalid");
}

/** An empirical estimate is neither tokenization nor a reliable upper bound. */
export function measureFromAcceptedUsage(input:{measurement:ModelInputMeasurement;footprint:InputAccountingFootprint|null;
  runId:string;purpose:string;targetRevision:string;observation:AcceptedInputUsage|null}):{measurement:ModelInputMeasurement;derivation:InputMeasurementDerivation} {
  if(input.measurement.status!=="unknown")return {measurement:input.measurement,derivation:{kind:"provider",observation:null,limitations:[]}};
  const unknown=(reason:string)=>({measurement:input.measurement,derivation:{kind:"unknown" as const,observation:null,limitations:[reason]}});
  const current=input.footprint,previous=input.observation;
  if(!current||current.inputUsage!=="complete")return unknown("complete_input_accounting_unavailable");
  validateFootprint(current);
  if(!previous)return unknown("accepted_input_usage_unavailable");
  validateAcceptedInputUsage(previous);
  if(previous.runId!==input.runId||previous.purpose!==input.purpose||previous.targetRevision!==input.targetRevision||
    previous.footprint.basisKey!==current.basisKey||previous.footprint.schemaDigest!==current.schemaDigest)
    return unknown("accepted_input_usage_not_comparable");
  const amount=Math.ceil(previous.inputTokens/previous.footprint.bytes*current.bytes);
  if(!Number.isSafeInteger(amount)||amount<=0)return unknown("input_usage_estimate_out_of_range");
  return {measurement:{status:"measured",amount,estimator:{id:"accepted-input-byte-scaling",revision:"1",unit:"tokens",accuracy:"estimated"},
    uncertainty:{kind:"unquantified"},measuredCompositionId:input.measurement.measuredCompositionId,measuredAt:input.measurement.measuredAt},
    derivation:{kind:"accepted_usage",observation:previous,limitations:["unquantified_tokenization_error","reported_usage_is_not_a_capacity_guarantee"]}};
}
function validateFootprint(value:InputAccountingFootprint):void {
  if(!value||typeof value.basisKey!=="string"||!value.basisKey.length||value.basisKey.length>4096||
    typeof value.schemaDigest!=="string"||!value.schemaDigest.length||value.schemaDigest.length>4096||
    !Number.isSafeInteger(value.bytes)||value.bytes<=0||!["complete","unknown"].includes(value.inputUsage))
    throw new TypeError("input_accounting_footprint_invalid");
}
