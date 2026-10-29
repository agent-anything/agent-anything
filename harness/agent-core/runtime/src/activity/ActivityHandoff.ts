import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityCount, activityToken, validateActivityPurpose, type ActivityPurposeBinding} from "./ActivityPurpose.js";

export interface ActivityPathIntent {
  readonly id: string;
  readonly runId: string;
  readonly owner: string;
  readonly purpose: ActivityPurposeBinding;
  readonly permissionBasis: string;
  readonly resourceScope: string;
  readonly maximumStages: number;
  readonly maximumAttempts: number;
  readonly maximumConcurrent: number;
  readonly deadlineAt: string;
}
export interface ActivityStageRequest {
  readonly id: string;
  readonly pathId: string;
  readonly stageKind: string;
  readonly input: unknown;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly {readonly requestId: string; readonly condition: "raw_result" | "accepted"}[];
}
export interface ActivityExecutorIdentity {
  readonly hostSession: string;
  readonly worker: string;
  readonly generation: number;
}
export interface ActivityAttempt {
  readonly id: string;
  readonly requestId: string;
  readonly executor: ActivityExecutorIdentity;
  readonly inputDigest: string;
  readonly startedAt: string;
}
export interface ActivityRawResult {
  readonly id: string;
  readonly attemptId: string;
  readonly completeness: "complete" | "partial";
  readonly outcome: "returned" | "failed" | "unknown";
  readonly value: unknown;
  readonly usage: unknown;
  readonly recordedAt: string;
}
export interface ActivityProcessingReceipt {
  readonly interpretationMs?:number;
  readonly id: string;
  readonly requestId: string;
  readonly resultId: string;
  readonly owner: string;
  readonly expectedProgressRevision: number;
  readonly progress: unknown;
  readonly next: readonly ActivityStageRequest[];
}
export interface ActivityProcessingClaim {
  readonly id: string;
  readonly requestId: string;
  readonly previousClaimId: string | null;
  readonly executor: ActivityExecutorIdentity;
}
export interface ActivityPathState {
  readonly intent: ActivityPathIntent;
  readonly controlRevision: number;
  readonly cancelled: boolean;
  readonly progressRevision: number;
  readonly progress: unknown;
  readonly admittedStages: number;
  readonly dispatchedAttempts: number;
  readonly resourceUse: {readonly admittedStages:number;readonly dispatchedAttempts:number};
}
export interface ActivityStageState {
  readonly request: ActivityStageRequest;
  readonly status: "submitted" | "admitted" | "dispatched" | "raw_result" | "accepted";
  readonly attempt: ActivityAttempt | null;
  readonly result: ActivityRawResult | null;
  readonly receipt: ActivityProcessingReceipt | null;
  readonly processing: ActivityProcessingClaim | null;
}
export type ActivityHandoffCommand =
  | {readonly kind: "facts"; readonly runId: string; readonly after: number; readonly limit: number}
  | {readonly kind: "open_path"; readonly intent: ActivityPathIntent}
  | {readonly kind: "submit"; readonly request: ActivityStageRequest}
  | {readonly kind: "admit"; readonly requestId: string; readonly expectedControlRevision: number}
  | {readonly kind: "dispatch"; readonly attempt: ActivityAttempt; readonly expectedControlRevision: number}
  | {readonly kind: "save_raw"; readonly result: ActivityRawResult}
  | {readonly kind: "claim_processing"; readonly claim: ActivityProcessingClaim; readonly expectedControlRevision: number}
  | {readonly kind: "accept"; readonly receipt: ActivityProcessingReceipt; readonly executor: ActivityExecutorIdentity; readonly expectedControlRevision: number; readonly participants?:readonly import("./SharedAcceptance.js").SharedAcceptancePart[]}
  | {readonly kind: "cancel"; readonly pathId: string; readonly expectedControlRevision: number}
  | {readonly kind: "read_path"; readonly pathId: string}
  | {readonly kind: "read_stage"; readonly requestId: string}
  | {readonly kind: "pending"; readonly runId: string; readonly after: number; readonly limit: number};

export interface ActivityHandoffItem {
  readonly sequence: number;
  readonly runId: string;
  readonly pathId: string;
  readonly requestId: string;
  readonly kind: "admission" | "execution" | "reconciliation" | "interpretation";
}
export interface ActivityDispatchReceipt {readonly kind: "dispatch"; readonly stage: ActivityStageState; readonly granted: boolean;}
export interface ActivityHandoffFact {
  readonly sequence: number;
  readonly runId: string;
  readonly pathId: string;
  readonly requestId: string | null;
  readonly kind: "path_opened" | "stage_submitted" | "stage_admitted" | "dispatched" | "raw_saved" | "processing_claimed" | "accepted" | "cancelled";
  readonly occurredAt: string;
  readonly details: Readonly<Record<string, unknown>>;
}
export interface ActivityHandoffObserver {
  observe(fact: ActivityHandoffFact): void;
  /** Durable content, supplementary to facts; projections are never execution authority. */
  observeStage?(runId:string,stage:ActivityStageState):void;
}
export type ActivityHandoffValue = ActivityPathState | ActivityStageState | ActivityDispatchReceipt | readonly ActivityHandoffItem[] | readonly ActivityHandoffFact[] | null;
export interface ActivityHandoffPort {command(command: ActivityHandoffCommand): Promise<ActivityHandoffValue>;}

export function validateActivityPath(intent: ActivityPathIntent): void {
  [intent.id, intent.runId, intent.owner, intent.permissionBasis, intent.resourceScope].forEach(activityToken);
  validateActivityPurpose(intent.purpose.contract);
  if (modelInputValueDigest(intent.purpose.contract) !== intent.purpose.digest || intent.owner !== intent.purpose.contract.acceptanceOwner) throw new TypeError("activity_path_owner_invalid");
  [intent.maximumStages, intent.maximumAttempts, intent.maximumConcurrent].forEach(value => activityCount(value));
  if (intent.maximumConcurrent > intent.maximumAttempts || intent.maximumStages > 10000 || intent.maximumAttempts > 10000 || !Number.isFinite(Date.parse(intent.deadlineAt))) throw new TypeError("activity_path_bound_invalid");
}
export function validateActivityStage(request: ActivityStageRequest, path: ActivityPathIntent): void {
  [request.id, request.pathId, request.stageKind].forEach(activityToken);
  if (request.pathId !== path.id || !path.purpose.contract.stageKinds.includes(request.stageKind) || request.input === undefined) throw new TypeError("activity_stage_scope_invalid");
  if (!Array.isArray(request.capabilities) || new Set(request.capabilities).size !== request.capabilities.length ||
      request.capabilities.some(value => !path.purpose.contract.capabilities.includes(value))) throw new TypeError("activity_capability_not_delegated");
  if (!Array.isArray(request.dependencies) || request.dependencies.length > 128 || new Set(request.dependencies.map(value => value.requestId)).size !== request.dependencies.length) throw new TypeError("activity_dependencies_invalid");
  for (const dependency of request.dependencies) {
    activityToken(dependency.requestId);
    if (dependency.requestId === request.id || !["raw_result", "accepted"].includes(dependency.condition)) throw new TypeError("activity_dependency_invalid");
  }
}
export function validateActivityExecutor(executor: ActivityExecutorIdentity): void {
  activityToken(executor.hostSession); activityToken(executor.worker); activityCount(executor.generation);
}
