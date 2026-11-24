import {responsesMeasurementInvalidation,restoreResponsesCountEvidence,type ResponsesInputTokenCountRequest,
  type ResponsesCountEvidence,type ResponsesMeasurementApplicability} from "@agent-anything/provider-integrations/native";
import type {HelarcResponsesCompactionAgreement} from "./HelarcResponsesCompaction.js";

/** The chooser owns the threshold. Count evidence binds it to the actual complete-input attempt, including gaps. */
export function helarcResponsesCompactionThreshold(input:{readonly request:ResponsesInputTokenCountRequest;readonly result:ResponsesCountEvidence;
  readonly current:ResponsesMeasurementApplicability;readonly tokens:number;readonly window:number;readonly headroom:number;
  readonly basis:string;readonly acceptedUncertainty:string|null}):HelarcResponsesCompactionAgreement["threshold"]{
  const result=restoreResponsesCountEvidence(input.request,input.result),invalid=responsesMeasurementInvalidation(input.request,input.current);
  if(invalid.some(r=>!["target_validity_unknown","dependency_resolution_unstable"].includes(r))||result.status==="refused")
    throw new TypeError("responses_compaction_measurement_not_applicable");
  const unknowns=[...invalid,...(result.status==="measured"?result.uncovered:[`count_unknown:${result.reason}`])];
  const coverage=result.status==="measured"&&!invalid.length?result.coverage:"unknown";
  if(!input.basis||coverage!=="complete"&&!input.acceptedUncertainty||!Number.isSafeInteger(input.tokens)||input.tokens<1000||
    !Number.isSafeInteger(input.window)||!Number.isSafeInteger(input.headroom)||input.headroom<0||input.tokens>input.window-input.headroom)
    throw new TypeError("responses_compaction_threshold_unjustified");
  return {tokens:input.tokens,window:input.window,headroom:input.headroom,basis:input.basis,
    measurement:{id:result.id,requestDigest:input.request.generation.digest,coverage,tokens:result.status==="measured"?result.inputTokens:null,
      unknowns,acceptedUncertainty:input.acceptedUncertainty}};
}
