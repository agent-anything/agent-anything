import type { ActionRejectedCode, ObservationBase } from "@agent-anything/agent-core/action";
import type { ToolResult } from "@agent-anything/tools";
import type {
  ApprovalCategory,
  ApprovalScope,
} from "@agent-anything/permission";

export type PlanUpdateObservation =
  | {
      readonly status: "applied";
      readonly transition: "created" | "updated" | "completed" | "reactivated";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "no_change";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "rejected";
      readonly code: "plan_invalid" | "plan_limit_exceeded";
      readonly message: string;
    };

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
  readonly failure: ActionFailureObservationDetail;
}

export type ActionFailureObservationSource =
  | "action_execution"
  | "policy"
  | "permission"
  | "sandbox"
  | "tool"
  | "context";

export interface ActionFailureObservationDetail {
  readonly source: ActionFailureObservationSource;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

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
