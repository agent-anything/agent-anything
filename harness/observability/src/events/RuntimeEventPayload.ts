import type { ISODateTimeString } from "@agent-anything/foundation";

export type RuntimeRunItemKind =
  | "model_output"
  | "action"
  | "observation"
  | "plan_created"
  | "plan_updated"
  | "plan_completed"
  | "plan_abandoned"
  | "final_output"
  | "stop"
  | "run_cancellation_requested"
  | "run_blocked"
  | "run_failed"
  | "run_cancelled"
  | "approval_requested"
  | "approval_resolved"
  | "action_prepared"
  | "action_assessed"
  | "action_invalidated"
  | "sandbox_attempt_started"
  | "sandbox_attempt_resolved"
  | "sandbox_escalation_proposed"
  | "retry_attempt_started"
  | "retry_attempt_finished"
  | "retry_scheduled"
  | "retry_fallback_selected"
  | "retry_exhausted"
  | "retry_cancelled";

export type RuntimeTerminalStatus =
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export interface RuntimePlanStepProjection {
  readonly step: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface RuntimePlanProjection {
  readonly id: string;
  readonly version: number;
  readonly status: "active" | "completed" | "abandoned";
  readonly steps: readonly RuntimePlanStepProjection[];
}

export interface RunStartedRuntimeEventPayload {
  readonly status: "running";
  readonly activeAgentId: string;
}

export interface RunItemAppendedRuntimeEventPayload {
  readonly itemId: string;
  readonly itemKind: RuntimeRunItemKind;
  readonly itemSequence: number;
}

interface TerminalRuntimeEventPayload<TStatus extends RuntimeTerminalStatus> {
  readonly status: TStatus;
  readonly code: TStatus extends "succeeded" ? null : string;
  readonly durationMs: number;
  readonly itemCount: number;
  readonly evidenceCount: number;
  readonly artifactCount: number;
  readonly errorCodes: readonly string[];
}

export type RunCompletedRuntimeEventPayload =
  TerminalRuntimeEventPayload<"succeeded">;
export type RunBlockedRuntimeEventPayload =
  TerminalRuntimeEventPayload<"blocked">;
export type RunFailedRuntimeEventPayload =
  TerminalRuntimeEventPayload<"failed">;
export type RunCancelledRuntimeEventPayload =
  TerminalRuntimeEventPayload<"cancelled">;

export interface ControllerStartedRuntimeEventPayload {
  readonly iteration: number;
}

export interface ControllerFinishedRuntimeEventPayload {
  readonly iteration: number;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly code: string | null;
  readonly decisionKind: "final_output" | "actions" | "stop" | null;
}

export interface PlanCreatedRuntimeEventPayload {
  readonly plan: RuntimePlanProjection;
}

export interface PlanUpdatedRuntimeEventPayload {
  readonly plan: RuntimePlanProjection;
  readonly previousVersion: number;
  readonly transition: "updated" | "reactivated";
}

export interface PlanCompletedRuntimeEventPayload {
  readonly plan: RuntimePlanProjection;
}

export interface PlanAbandonedRuntimeEventPayload {
  readonly plan: RuntimePlanProjection;
  readonly terminalStatus: RuntimeTerminalStatus;
  readonly reasonCode: string | null;
}

export interface ActionPreparedRuntimeEventPayload {
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category:
    | "file_system"
    | "process"
    | "network"
    | "remote_tool"
    | "computation";
  readonly effectCount: number;
  readonly targetAssertionCount: number;
}

export interface ActionAssessedRuntimeEventPayload {
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

export interface ActionInvalidatedRuntimeEventPayload {
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly phase: "assessment" | "revalidation" | "dispatch";
  readonly owner: "permission" | "tool";
  readonly code: string;
}

export type RuntimeApprovalCategory =
  | "commandExecution"
  | "fileChange"
  | "permissions"
  | "remoteToolCall"
  | "skill"
  | "networkAccess";

export interface ApprovalRequestedRuntimeEventPayload {
  readonly requestId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category: RuntimeApprovalCategory;
  readonly pendingVersion: number;
  readonly reviewer: "user" | "auto_review";
  readonly phase: "reviewing";
  readonly reviewOperationId: string;
}

export interface ApprovalResolvedRuntimeEventPayload {
  readonly requestId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly pendingVersion: number;
  readonly reviewer: "user" | "auto_review";
  readonly resolutionKind:
    | "decision"
    | "review_failure"
    | "request_failure"
    | "run_cancelled";
  readonly decisionKind:
    | "accept"
    | "acceptForSession"
    | "grantPermissions"
    | "acceptWithExecpolicyAmendment"
    | "applyNetworkPolicyAmendment"
    | "decline"
    | "cancel"
    | null;
  readonly applicationKind:
    | "not_applicable"
    | "applied"
    | "not_applied"
    | "interrupted"
    | "outcome_unknown";
  readonly code: string | null;
  readonly authorityRecordIds: readonly string[];
}

export type RuntimeSandboxEnforcement = "managed" | "external" | "disabled";

export interface SandboxAttemptStartedRuntimeEventPayload {
  readonly actionId: string;
  readonly attemptId: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: RuntimeSandboxEnforcement;
}

export interface SandboxAttemptResolvedRuntimeEventPayload {
  readonly actionId: string;
  readonly attemptId: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: RuntimeSandboxEnforcement;
  readonly outcome:
    | "executed"
    | "sandbox_denied"
    | "sandbox_unavailable"
    | "interrupted"
    | "failed";
  readonly code: string | null;
}

export interface SandboxEscalationProposedRuntimeEventPayload {
  readonly actionId: string;
  readonly previousAttemptId: string;
  readonly previousActionFingerprint: string;
  readonly nextActionFingerprint: string;
  readonly deniedEffectKind: "file_system" | "network";
}

export interface ToolStartedRuntimeEventPayload {
  readonly actionId: string;
  readonly toolName: string;
}

export interface ToolFinishedRuntimeEventPayload {
  readonly actionId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed";
  readonly code: string | null;
  readonly toolResultStatus: "succeeded" | "partial" | "failed" | "timeout";
  readonly durationMs: number;
}

export interface ObservationCreatedRuntimeEventPayload {
  readonly actionId: string;
  readonly observationId: string;
  readonly status:
    | "succeeded"
    | "partial"
    | "failed"
    | "timeout"
    | "denied"
    | "rejected"
    | "declined"
    | "limit_reached"
    | "granted"
    | "updated";
  readonly code: string | null;
}

export interface ContextUpdatedRuntimeEventPayload {
  readonly observationId: string;
}

export interface EvidenceCreatedRuntimeEventPayload {
  readonly actionId: string;
  readonly evidenceId: string;
}

export type RuntimeRetryOwner =
  | "provider_request"
  | "response_stream"
  | "approvals_reviewer"
  | "structured_output";

interface RetryRuntimeEventPayload {
  readonly operationId: string;
  readonly owner: RuntimeRetryOwner;
}

export interface RetryAttemptStartedRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly attemptId: string;
  readonly budgetId: string;
  readonly attemptNumber: number;
  readonly budgetAttemptNumber: number;
  readonly maxBudgetAttempts: number;
}

export interface RetryAttemptFinishedRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly attemptId: string;
  readonly budgetId: string;
  readonly attemptNumber: number;
  readonly budgetAttemptNumber: number;
  readonly durationMs: number;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly failureCategory: string | null;
  readonly failureCode: string | null;
  readonly next:
    | "retry_scheduled"
    | "budget_exhausted"
    | "deadline_exhausted"
    | "return_to_owner"
    | "cancelled";
}

export interface RetryScheduledRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly afterAttemptId: string;
  readonly budgetId: string;
  readonly retryNumber: number;
  readonly nextAttemptNumber: number;
  readonly nextBudgetAttemptNumber: number;
  readonly delayMs: number;
  readonly delaySource: "calculated_backoff" | "trusted_server_delay";
  readonly nextAttemptAt: ISODateTimeString;
  readonly failureCategory: string;
  readonly failureCode: string;
}

export interface RetryFallbackSelectedRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly fromLegId: string;
  readonly toLegId: string;
  readonly fromBudgetId: string;
  readonly toBudgetId: string;
  readonly fromTransport: string;
  readonly toTransport: string;
  readonly fallbackNumber: number;
  readonly reasonCode: string;
  readonly nextAttemptNumber: number;
}

export interface RetryExhaustedRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly finalBudgetId: string;
  readonly reason: "retry_budget_exhausted" | "deadline_exceeded";
  readonly totalAttempts: number;
  readonly totalRetryDelayMs: number;
  readonly lastFailureCategory: string | null;
  readonly lastFailureCode: string | null;
}

export interface RuntimeCancellationAttribution {
  readonly requestId: string;
  readonly operation:
    | "controller"
    | "provider"
    | "retry_wait"
    | "approval_reviewer"
    | "authority_commit"
    | "tool"
    | "process";
  readonly observedAt: ISODateTimeString;
}

export interface RetryCancelledRuntimeEventPayload
  extends RetryRuntimeEventPayload {
  readonly phase: "before_attempt" | "attempt" | "backoff";
  readonly budgetId: string;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly attribution: RuntimeCancellationAttribution;
}

export interface RuntimeEventPayloadMap {
  readonly "run.started": RunStartedRuntimeEventPayload;
  readonly "run.item.appended": RunItemAppendedRuntimeEventPayload;
  readonly "run.completed": RunCompletedRuntimeEventPayload;
  readonly "run.blocked": RunBlockedRuntimeEventPayload;
  readonly "run.failed": RunFailedRuntimeEventPayload;
  readonly "run.cancelled": RunCancelledRuntimeEventPayload;
  readonly "controller.started": ControllerStartedRuntimeEventPayload;
  readonly "controller.finished": ControllerFinishedRuntimeEventPayload;
  readonly "plan.created": PlanCreatedRuntimeEventPayload;
  readonly "plan.updated": PlanUpdatedRuntimeEventPayload;
  readonly "plan.completed": PlanCompletedRuntimeEventPayload;
  readonly "plan.abandoned": PlanAbandonedRuntimeEventPayload;
  readonly "action.prepared": ActionPreparedRuntimeEventPayload;
  readonly "action.assessed": ActionAssessedRuntimeEventPayload;
  readonly "action.invalidated": ActionInvalidatedRuntimeEventPayload;
  readonly "approval.requested": ApprovalRequestedRuntimeEventPayload;
  readonly "approval.resolved": ApprovalResolvedRuntimeEventPayload;
  readonly "sandbox.attempt.started": SandboxAttemptStartedRuntimeEventPayload;
  readonly "sandbox.attempt.resolved": SandboxAttemptResolvedRuntimeEventPayload;
  readonly "sandbox.escalation.proposed": SandboxEscalationProposedRuntimeEventPayload;
  readonly "tool.started": ToolStartedRuntimeEventPayload;
  readonly "tool.finished": ToolFinishedRuntimeEventPayload;
  readonly "observation.created": ObservationCreatedRuntimeEventPayload;
  readonly "context.updated": ContextUpdatedRuntimeEventPayload;
  readonly "evidence.created": EvidenceCreatedRuntimeEventPayload;
  readonly "retry.attempt.started": RetryAttemptStartedRuntimeEventPayload;
  readonly "retry.attempt.finished": RetryAttemptFinishedRuntimeEventPayload;
  readonly "retry.scheduled": RetryScheduledRuntimeEventPayload;
  readonly "retry.fallback.selected": RetryFallbackSelectedRuntimeEventPayload;
  readonly "retry.exhausted": RetryExhaustedRuntimeEventPayload;
  readonly "retry.cancelled": RetryCancelledRuntimeEventPayload;
}

export type RuntimeEventName = keyof RuntimeEventPayloadMap;
