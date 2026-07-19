import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { Action } from "../action/Action.js";
import type { ControllerModelItem } from "../controller/Controller.js";
import type { PlanProjection } from "../plan/index.js";
import type { Observation } from "./Observation.js";
import type { RunCancellationSummary } from "./RunCancellation.js";
import type { RunBlockedCode, RunFailureCode } from "./RunStatus.js";
import type { RuntimeError } from "./RuntimeError.js";
import type { ApprovalsReviewer } from "@agent-anything/permission";
import type {
  ApprovalRecordSummary,
  ApprovalRequestSummary,
} from "./ApprovalSummary.js";
import type {
  RetryAttemptFinishedEvent,
  RetryAttemptStartedEvent,
  RetryCancelledEvent,
  RetryExhaustedEvent,
  RetryFallbackSelectedEvent,
  RetryScheduledEvent,
} from "../retry/RetryEvent.js";

export interface RunItemBase {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface ModelOutputRunItem extends RunItemBase {
  readonly kind: "model_output";
  readonly modelItem: ControllerModelItem;
}

export interface ActionRunItem extends RunItemBase {
  readonly kind: "action";
  readonly action: Action;
}

export interface ObservationRunItem extends RunItemBase {
  readonly kind: "observation";
  readonly observation: Observation;
}

export interface PlanCreatedRunItem extends RunItemBase {
  readonly kind: "plan_created";
  readonly plan: PlanProjection;
  readonly explanation: string | null;
}

export interface PlanUpdatedRunItem extends RunItemBase {
  readonly kind: "plan_updated";
  readonly previousVersion: number;
  readonly plan: PlanProjection;
  readonly transition: "updated" | "reactivated";
  readonly explanation: string | null;
}

export interface PlanCompletedRunItem extends RunItemBase {
  readonly kind: "plan_completed";
  readonly plan: PlanProjection;
}

export interface PlanAbandonedRunItem extends RunItemBase {
  readonly kind: "plan_abandoned";
  readonly plan: PlanProjection;
  readonly terminalStatus: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly reasonCode: string | null;
}

export interface FinalOutputRunItem<TOutput = unknown> extends RunItemBase {
  readonly kind: "final_output";
  readonly output: TOutput;
}

export interface StopRunItem extends RunItemBase {
  readonly kind: "stop";
  readonly reason: string;
}

export interface RunCancellationRequestedRunItem extends RunItemBase {
  readonly kind: "run_cancellation_requested";
  readonly request: RunCancellationSummary;
}

export interface RunBlockedRunItem extends RunItemBase {
  readonly kind: "run_blocked";
  readonly code: RunBlockedCode;
}

export interface RunFailedRunItem extends RunItemBase {
  readonly kind: "run_failed";
  readonly code: RunFailureCode;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
}

export interface RunCancelledRunItem extends RunItemBase {
  readonly kind: "run_cancelled";
  readonly cancellation: RunCancellationSummary;
  readonly completedAt: ISODateTimeString;
}

export interface ApprovalRequestedRunItem extends RunItemBase {
  readonly kind: "approval_requested";
  readonly request: ApprovalRequestSummary;
  readonly pendingVersion: number;
  readonly reviewer: ApprovalsReviewer;
  readonly reviewOperationId: string;
}

export interface ApprovalResolvedRunItem extends RunItemBase {
  readonly kind: "approval_resolved";
  readonly record: ApprovalRecordSummary;
}

export interface ActionPreparedSummary {
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category: "file_system" | "process" | "network" | "remote_tool" | "computation";
  readonly effectCount: number;
  readonly targetAssertionCount: number;
}

export interface ActionPreparedRunItem extends RunItemBase {
  readonly kind: "action_prepared";
  readonly prepared: ActionPreparedSummary;
}

export interface ActionAssessedSummary {
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly status:
    | "authorized"
    | "approval_required"
    | "denied"
    | "invalidated"
    | "failed"
    | "interrupted";
  readonly owner: "policy" | "permission" | "tool" | null;
  readonly code: string | null;
}

export interface ActionAssessedRunItem extends RunItemBase {
  readonly kind: "action_assessed";
  readonly assessment: ActionAssessedSummary;
}

export interface ActionInvalidatedSummary {
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly phase: "assessment" | "revalidation" | "dispatch";
  readonly owner: "permission" | "tool";
  readonly code: string;
}

export interface ActionInvalidatedRunItem extends RunItemBase {
  readonly kind: "action_invalidated";
  readonly invalidation: ActionInvalidatedSummary;
}

export interface SandboxAttemptSummary {
  readonly attemptId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: "managed" | "external" | "disabled";
  readonly policyId: string;
  readonly authoritySnapshotId: string;
  readonly dispatchPlanFingerprint: string;
  readonly startedAt: ISODateTimeString;
}

export interface SandboxAttemptStartedRunItem extends RunItemBase {
  readonly kind: "sandbox_attempt_started";
  readonly attempt: SandboxAttemptSummary;
}

export interface SandboxAttemptResolutionSummary {
  readonly attemptId: string;
  readonly actionId: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: "managed" | "external" | "disabled";
  readonly outcome:
    | "executed"
    | "sandbox_denied"
    | "sandbox_unavailable"
    | "interrupted"
    | "failed";
  readonly code: string | null;
  readonly effectState: "none" | "unknown" | null;
  readonly settledAt: ISODateTimeString;
}

export interface SandboxAttemptResolvedRunItem extends RunItemBase {
  readonly kind: "sandbox_attempt_resolved";
  readonly resolution: SandboxAttemptResolutionSummary;
}

export interface SandboxEscalationProposedRunItem extends RunItemBase {
  readonly kind: "sandbox_escalation_proposed";
  readonly previousAttemptId: string;
  readonly actionId: string;
  readonly previousActionFingerprint: string;
  readonly nextActionFingerprint: string;
  readonly deniedEffectKind: "file_system" | "network";
}

type RetryEventRunItem<TEvent extends { readonly type: string }> = RunItemBase & {
  readonly kind: TEvent["type"];
  readonly retry: TEvent;
};

export type RetryAttemptStartedRunItem = RetryEventRunItem<RetryAttemptStartedEvent>;
export type RetryAttemptFinishedRunItem = RetryEventRunItem<RetryAttemptFinishedEvent>;
export type RetryScheduledRunItem = RetryEventRunItem<RetryScheduledEvent>;
export type RetryFallbackSelectedRunItem = RetryEventRunItem<RetryFallbackSelectedEvent>;
export type RetryExhaustedRunItem = RetryEventRunItem<RetryExhaustedEvent>;
export type RetryCancelledRunItem = RetryEventRunItem<RetryCancelledEvent>;

export type RetryRunItem =
  | RetryAttemptStartedRunItem
  | RetryAttemptFinishedRunItem
  | RetryScheduledRunItem
  | RetryFallbackSelectedRunItem
  | RetryExhaustedRunItem
  | RetryCancelledRunItem;

export type RunItem<TOutput = unknown> =
  | ModelOutputRunItem
  | ActionRunItem
  | ObservationRunItem
  | PlanCreatedRunItem
  | PlanUpdatedRunItem
  | PlanCompletedRunItem
  | PlanAbandonedRunItem
  | FinalOutputRunItem<TOutput>
  | StopRunItem
  | RunCancellationRequestedRunItem
  | RunBlockedRunItem
  | RunFailedRunItem
  | RunCancelledRunItem
  | ApprovalRequestedRunItem
  | ApprovalResolvedRunItem
  | ActionPreparedRunItem
  | ActionAssessedRunItem
  | ActionInvalidatedRunItem
  | SandboxAttemptStartedRunItem
  | SandboxAttemptResolvedRunItem
  | SandboxEscalationProposedRunItem
  | RetryRunItem;
