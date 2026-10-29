import type {MaterialGrant, MaterialHold, MaterialRange, MaterialRecipient} from "../custody/MaterialCustody.js";
import type {RepresentationRef, RepresentationRecord, RepresentationJudgment} from "../representation/RepresentationRecord.js";

export interface ContextUseScope extends MaterialRecipient {
  readonly id:string;
  readonly continuity:string;
  readonly owner:string;
  readonly target:string;
  readonly authorityBasis:string;
}
export interface ContextUseControl {
  readonly scopeId:string;
  readonly revision:number;
  readonly allowed:boolean;
  readonly basis:string;
}
export interface ContextDelivery {
  readonly id:string;
  readonly sourceRunId:string;
  readonly sourceId:string;
  readonly recipient:MaterialRecipient;
  readonly material:MaterialRange;
  readonly instanceId:string;
  readonly holdId:string;
  readonly detailHoldId:string|null;
}
export interface ContextInputBinding {
  readonly id:string;
  readonly activityId:string;
  readonly stageRequestId:string;
  readonly scopeId:string;
  readonly selectionId:string;
  readonly exactInput:unknown;
  readonly target:string;
  readonly deliveries:readonly {readonly id:string;readonly position:string}[];
  readonly holds:readonly MaterialHold[];
  readonly combinationJudgmentId:string;
}
export interface ContextSelectionProposal {
  readonly id:string;
  readonly scopeId:string;
  readonly expectedSelectionId:string|null;
  readonly expectedControlRevision:number;
  readonly selection:{readonly id:string;readonly representations:readonly RepresentationRef[];readonly judgmentIds:readonly string[];readonly holds:readonly MaterialHold[]}|null;
  readonly input:ContextInputBinding;
  readonly releaseHolds:readonly string[];
}
export interface ContextSelectionSnapshot {
  readonly acceptanceId:string;
  readonly scope:ContextUseScope;
  readonly selection:{readonly id:string;readonly representations:readonly RepresentationRef[];readonly judgmentIds:readonly string[];readonly holds:readonly MaterialHold[]};
  readonly input:ContextInputBinding;
  readonly deliveries:readonly ContextDelivery[];
}
/** Participant bodies for the existing shared acceptance boundary. */
export type ContextAcceptancePart =
  | {readonly owner:"representation";readonly kind:"record";readonly proposal:RepresentationRecord}
  | {readonly owner:"representation";readonly kind:"judge";readonly proposal:RepresentationJudgment}
  | {readonly owner:"material_custody";readonly kind:"publish";readonly proposal:{readonly intentId:string;readonly holds:readonly MaterialHold[];readonly grants:readonly MaterialGrant[]}}
  | {readonly owner:"material_custody";readonly kind:"holds";readonly proposal:{readonly acquire:readonly MaterialHold[];readonly release:readonly string[];readonly basis:string}}
  | {readonly owner:"context_selection";readonly kind:"selection_input";readonly proposal:ContextSelectionProposal}
  | {readonly owner:"context_delivery";readonly kind:"publish";readonly proposal:ContextDelivery}
  | {readonly owner:"context_delivery";readonly kind:"select";readonly proposal:{readonly inputId:string;readonly scopeId:string;readonly deliveryIds:readonly string[]}}
  | {readonly owner:"context_delivery";readonly kind:"accept";readonly proposal:{readonly inputId:string;readonly responseId:string;readonly detailHolds:readonly string[]}}
  | {readonly owner:"context_delivery";readonly kind:"dispose";readonly proposal:{readonly deliveryId:string;readonly recipient:MaterialRecipient;readonly reason:"cancelled"|"withdrawn"|"unavailable";readonly basis:string}};
export type ContextSelectionCommand =
  | {readonly kind:"scope";readonly scope:ContextUseScope}
  | {readonly kind:"control";readonly control:ContextUseControl;readonly expectedRevision:number}
  | {readonly kind:"current";readonly scopeId:string}
  | {readonly kind:"current_control";readonly scopeId:string}
  | {readonly kind:"binding";readonly inputId:string;readonly checkCurrentControl:boolean}
  | {readonly kind:"sent";readonly inputId:string;readonly attemptId:string}
  | {readonly kind:"retire_input";readonly inputId:string;readonly basis:string}
  | {readonly kind:"withdraw";readonly scopeId:string;readonly expectedSelectionId:string;readonly expectedControlRevision:number;readonly basis:string}
  | {readonly kind:"delivery";readonly id:string};
export type ContextSelectionValue = ContextSelectionSnapshot | ContextUseScope | ContextUseControl | ContextDelivery | null |
  {readonly id:string;readonly representations:readonly RepresentationRef[];readonly judgmentIds:readonly string[];readonly holds:readonly MaterialHold[]};
export interface ContextSelectionPort {command(command:ContextSelectionCommand):Promise<ContextSelectionValue>;}
