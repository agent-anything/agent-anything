import type {ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {restoreResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";
import {helarcNativeInputAcceptance} from "./HelarcNativeInputAcceptance.js";
import {assessHelarcResponsesCompact,type HelarcResponsesCompactSource,type HelarcResponsesCompactAssessment} from "./HelarcResponsesCompaction.js";
import type {ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";

/** The successor input and its new continuity are one selection acceptance, guarded against cancellation. */
export function helarcResponsesCompactAdoption(input:{readonly acceptance:Parameters<typeof helarcNativeInputAcceptance>[0];
  readonly source:HelarcResponsesCompactSource;readonly candidate:ResponsesCompactedWindow;readonly assessment:HelarcResponsesCompactAssessment;
  readonly original:{readonly activityId:string;readonly controlRevision:number;readonly result:ProtocolJournalRecord["ref"];readonly acceptance:ProtocolJournalRecord["ref"]}}){
  const {native}=input.acceptance,{source,candidate,assessment}=input;
  if(!assessment.quality.allowed||digest(assessment)!==digest(assessHelarcResponsesCompact({source,candidate,findings:assessment.findings}))||
    digest(restoreResponsesCompactedWindow(candidate.raw))!==digest(candidate)||native.predecessor!==null||native.prefixGroups!==0||
    native.continuity.kind!=="responses"||!native.continuity.conditions.reestablish||
    digest(native.manifest.groups[0]?.items)!==digest(candidate.items)||
    native.manifest.target.configuration!==source.dependencies.target||native.manifest.target.disclosure!==source.dependencies.authority)
    throw new TypeError("compact_adoption_not_qualified");
  const proposal=helarcNativeInputAcceptance(input.acceptance);
  return {...proposal,parts:[{owner:"protocol_execution",kind:"require_accepted_result",proposal:{activityId:input.original.activityId,
    controlRevision:input.original.controlRevision,record:input.original.result,acceptance:input.original.acceptance}},...proposal.parts]};
}
