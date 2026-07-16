import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import type { PlanUpdateObservation } from "../plan/index.js";
import type {
  ApprovalCategory,
  ApprovalScope,
} from "@agent-anything/permission";
import type { RuntimeError } from "./RuntimeError.js";

export interface ObservationBase {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface PlanUpdateResultObservation extends ObservationBase {
  readonly kind: "plan_update";
  readonly result: PlanUpdateObservation;
}

export interface ToolResultObservation<TOutput = unknown> extends ObservationBase {
  readonly kind: "tool_result";
  readonly result: ToolResult<TOutput>;
}

export type ActionDeniedOwner = "policy" | "permission" | "sandbox" | "tool";

export interface ActionDeniedObservation extends ObservationBase {
  readonly kind: "action_denied";
  readonly owner: ActionDeniedOwner;
  readonly code: string;
  readonly message: string;
}

export interface ActionFailureObservation extends ObservationBase {
  readonly kind: "action_failure";
  readonly error: RuntimeError;
}

export type ActionRejectedCode =
  | "action_invalid"
  | "action_unsupported"
  | "tool_not_found";

export interface ActionRejectedObservation extends ObservationBase {
  readonly kind: "action_rejected";
  readonly code: ActionRejectedCode;
  readonly message: string;
}

interface ApprovalObservationBase extends ObservationBase {
  readonly requestId: string;
  readonly category: ApprovalCategory;
}

export interface ApprovalDeclinedObservation extends ApprovalObservationBase {
  readonly kind: "approval_declined";
  readonly reason: string | null;
}

export interface ApprovalPolicyRejectedObservation
  extends ApprovalObservationBase {
  readonly kind: "approval_policy_rejected";
  readonly code: string;
  readonly message: string;
}

export interface ApprovalLimitReachedObservation extends ApprovalObservationBase {
  readonly kind: "approval_limit_reached";
  readonly limit:
    | "requests_per_run"
    | "requests_per_action_fingerprint"
    | "consecutive_declines";
  readonly current: number;
  readonly maximum: number;
}

export interface ApprovalReviewFailedObservation extends ApprovalObservationBase {
  readonly kind: "approval_review_failed";
  readonly code:
    | "approval_reviewer_unavailable"
    | "approval_review_timeout"
    | "approval_review_failed"
    | "approval_review_malformed"
    | "approval_review_retry_exhausted";
  readonly message: string;
  readonly retryable: boolean;
}

export interface ApprovalApplicationFailedObservation
  extends ApprovalObservationBase {
  readonly kind: "approval_application_failed";
  readonly scope: ApprovalScope;
  readonly code: string;
  readonly message: string;
}

export interface PermissionsGrantedObservation extends ApprovalObservationBase {
  readonly kind: "permissions_granted";
  readonly scope: Extract<ApprovalScope, "run" | "session">;
  readonly summary: {
    readonly fileSystemReadTargetCount: number;
    readonly fileSystemWriteTargetCount: number;
    readonly networkEnabled: boolean;
    readonly networkDomainCount: number;
  };
}

export type ApprovalObservation =
  | ApprovalDeclinedObservation
  | ApprovalPolicyRejectedObservation
  | ApprovalLimitReachedObservation
  | ApprovalReviewFailedObservation
  | ApprovalApplicationFailedObservation
  | PermissionsGrantedObservation;

export type Observation<TToolOutput = unknown> =
  | PlanUpdateResultObservation
  | ToolResultObservation<TToolOutput>
  | ActionDeniedObservation
  | ActionFailureObservation
  | ActionRejectedObservation
  | ApprovalObservation;
