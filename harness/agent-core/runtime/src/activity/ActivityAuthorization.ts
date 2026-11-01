import type {ActivityHandoffItem} from "./ActivityHandoff.js";
import {activityToken} from "./ActivityPurpose.js";

export type ActivityAuthorizationRefusal =
  | {readonly kind:"temporary";readonly code:string;readonly message:string}
  | {readonly kind:"denied";readonly code:string;readonly message:string;readonly decision:{readonly owner:string;readonly id:string;readonly revision:string}};
export type ActivityAuthorizationResult = {readonly kind:"allowed"} | ActivityAuthorizationRefusal;
export type ActivityAuthorizationRestrictions = Partial<Record<ActivityHandoffItem["kind"],ActivityAuthorizationRefusal>>;

export function validateActivityAuthorizationResult(result:unknown):asserts result is ActivityAuthorizationResult {
  if(!result||typeof result!=="object"||!("kind" in result))throw new TypeError("activity_authorization_result_invalid");
  if(result.kind!=="allowed")validateActivityAuthorizationRefusal(result as ActivityAuthorizationRefusal);
}
export function validateActivityAuthorizationRefusal(refusal:ActivityAuthorizationRefusal):void {
  if(!refusal||!["temporary","denied"].includes(refusal.kind))throw new TypeError("activity_authorization_refusal_invalid");
  [refusal.code,refusal.message].forEach(activityToken);
  if(refusal.kind==="denied") {
    if(!refusal.decision)throw new TypeError("activity_authorization_decision_missing");
    [refusal.decision.owner,refusal.decision.id,refusal.decision.revision].forEach(activityToken);
  }
}
