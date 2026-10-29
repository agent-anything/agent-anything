import {activityCount, activityToken} from "./ActivityPurpose.js";

export type ActivityServiceClass = "guaranteed" | "spare";
export interface ActivityResourcePool {
  readonly id: string;
  readonly revision: string;
  readonly authority: string;
  readonly capacity: number;
}
export interface ActivityResourceClaim {
  readonly poolId: string;
  readonly units: number;
}
/** A trusted execution arrangement, not a model-created priority or a path budget. */
export interface ActivitySchedulingIntent {
  readonly id: string;
  readonly workId: string;
  readonly runId: string;
  readonly scopeId: string;
  readonly owner: string;
  readonly delegatedPathOwners?:readonly string[];
  readonly decisionId: string;
  readonly policyRevision: string;
  readonly reason: "task" | "necessary" | "opportunity" | "optional";
  readonly delayImpact: string;
  readonly timing: {readonly kind: "unknown"} | {readonly kind: "review_at"; readonly at: string; readonly basis: string};
  readonly resources: readonly (ActivityResourceClaim & {readonly capability: string})[];
}
export interface ActivitySchedulingAcceptance {
  readonly intent: ActivitySchedulingIntent;
  readonly revision: number;
  readonly service: ActivityServiceClass;
  readonly eligibilitySequence: number;
  readonly acceptedAt: string;
  readonly closed: boolean;
}
export interface ActivitySchedulingDispatch {
  readonly workId: string;
  readonly acceptanceId: string;
  readonly round: number;
  readonly ticket: number | null;
  readonly scopeRound:number|null;
  readonly scopeTicket:number|null;
  readonly claims: readonly ActivityResourceClaim[];
}
export interface ActivitySchedulingCandidate {
  readonly requestId: string;
  readonly pathId: string;
  readonly runId: string;
  readonly workId: string;
}
export interface ActivitySchedulingReview {
  readonly observedAt:string;
  readonly due:readonly string[];
  readonly nextReviewAt:string|null;
}
export type ActivitySchedulingCommand =
  | {readonly kind: "bind_resource_pool"; readonly pool: ActivityResourcePool}
  | {readonly kind: "schedule_work"; readonly intent: ActivitySchedulingIntent; readonly expectedRevision: number}
  | {readonly kind: "read_schedule"; readonly workId: string}
  | {readonly kind: "review_scheduling"}
  | {readonly kind: "close_scheduled_work"; readonly workId: string; readonly expectedRevision: number; readonly basis: string}
  | {readonly kind: "scheduling_candidates"; readonly limit: number};

export function validateActivitySchedulingIntent(intent: ActivitySchedulingIntent): void {
  [intent.id,intent.workId,intent.runId,intent.scopeId,intent.owner,intent.decisionId,intent.policyRevision,intent.delayImpact].forEach(activityToken);
  if (!["task","necessary","opportunity","optional"].includes(intent.reason)) throw new TypeError("activity_schedule_reason_invalid");
  if(intent.delegatedPathOwners){if(intent.delegatedPathOwners.length>32||new Set(intent.delegatedPathOwners).size!==intent.delegatedPathOwners.length)throw new TypeError("activity_schedule_owners_invalid");intent.delegatedPathOwners.forEach(activityToken);}
  if (!intent.timing || !["unknown","review_at"].includes(intent.timing.kind)) throw new TypeError("activity_schedule_timing_invalid");
  if (intent.timing.kind === "review_at") {
    activityToken(intent.timing.basis);
    if (!Number.isFinite(Date.parse(intent.timing.at))) throw new TypeError("activity_schedule_timing_invalid");
  }
  if (!Array.isArray(intent.resources) || !intent.resources.length || intent.resources.length > 32) throw new TypeError("activity_schedule_resources_invalid");
  const keys = new Set<string>();
  for (const claim of intent.resources) {
    activityToken(claim.capability);activityToken(claim.poolId);activityCount(claim.units);
    const key=JSON.stringify([claim.capability,claim.poolId]);
    if(keys.has(key))throw new TypeError("activity_schedule_resources_duplicate");keys.add(key);
  }
}
