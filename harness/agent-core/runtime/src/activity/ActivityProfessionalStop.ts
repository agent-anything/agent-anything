import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffItem,ActivityStageState} from "./ActivityHandoff.js";
import type {ActivityAuthorizationRefusal} from "./ActivityAuthorization.js";
export type ActivityProfessionalLimitation =
  | {readonly kind:"deadline";readonly deadlineAt:string;readonly observedAt:string}
  | {readonly kind:"authorization";readonly action:ActivityHandoffItem["kind"];readonly refusal:Extract<ActivityAuthorizationRefusal,{kind:"denied"}>};

/** Immutable evidence identities plus mutable service state; no repeated raw payload. */
export function activityStageEvidence(stage:ActivityStageState):string {
  return modelInputValueDigest({requestId:stage.request.id,status:stage.status,attemptId:stage.attempt?.id??null,
    resultId:stage.result?.id??null,receiptId:stage.receipt?.id??null,processingId:stage.processing?.id??null,
    settlementId:stage.settlement?.id??null,stopId:stage.stop?.id??null,rawEvidenceRevision:stage.rawEvidenceRevision??0,
    authorizationRestrictions:stage.authorizationRestrictions??{},dispatchRestriction:stage.dispatchRestriction??null,
    attemptCount:stage.attemptCount??(stage.attempt?1:0),retryId:stage.retry?.id??null});
}
export interface ActivityProfessionalStopReceipt {
  readonly id:string;
  readonly requestId:string;
  readonly owner:string;
  readonly expectedControlRevision:number;
  readonly expectedProgressRevision:number;
  readonly expectedStageEvidence:string;
  readonly limitation:ActivityProfessionalLimitation;
  readonly progress:unknown;
}
