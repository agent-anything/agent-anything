/** Facts carry references; their professional meaning belongs to the subscribing owner. */
export interface ActivityFactSource {
  readonly id:string;
  readonly runId:string;
  readonly owner:string;
}
/** Deterministic publisher identities are part of the handoff contract, not UI event names. */
export function activityFactSourceId(kind:"progress"|"control"|"scheduling",identity:string):string {
  if(!identity.trim())throw new TypeError("activity_fact_source_identity_invalid");
  return `activity-source:${kind}:${identity}`;
}
export interface ActivityPublishedFact {
  readonly id:string;
  readonly sourceId:string;
  readonly ref:{readonly owner:string;readonly kind:string;readonly id:string;readonly revision:string};
}
export interface ActivityReconsiderationSubscription {
  readonly id:string;
  readonly runId:string;
  readonly owner:string;
  readonly sources:readonly string[];
}
export interface ActivityReconsiderationState {
  readonly subscription:ActivityReconsiderationSubscription;
  readonly revision:number;
  readonly consumedThrough:number;
  readonly closed:boolean;
}
export interface ActivityReconsiderationSnapshot {
  readonly state:ActivityReconsiderationState;
  readonly through:number;
  readonly facts:readonly (ActivityPublishedFact & {readonly sequence:number})[];
  readonly more:boolean;
}
export interface ActivityReconsiderationReceipt {
  readonly id:string;
  readonly subscriptionId:string;
  readonly expectedRevision:number;
  readonly through:number;
  readonly factIds:readonly string[];
  readonly decision:ActivityPublishedFact["ref"];
  readonly close:boolean;
}
export type ActivityReconsiderationCommand =
  | {readonly kind:"register_fact_source";readonly source:ActivityFactSource}
  | {readonly kind:"publish_fact";readonly fact:ActivityPublishedFact}
  | {readonly kind:"subscribe_reconsideration";readonly subscription:ActivityReconsiderationSubscription}
  | {readonly kind:"read_reconsideration";readonly subscriptionId:string;readonly limit:number}
  | {readonly kind:"pending_reconsiderations";readonly runId:string;readonly afterId:string|null;readonly limit:number}
  | {readonly kind:"accept_reconsideration";readonly receipt:ActivityReconsiderationReceipt;
      readonly participants?:readonly import("./SharedAcceptance.js").SharedAcceptancePart[]};
