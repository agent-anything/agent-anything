export type RuntimeRunItemKind =
  | "controller_turn"
  | "run_action"
  | "observation"
  | "state_transition"
  | "pending_transition"
  | "cancellation_transition"
  | "validation_feedback"
  | "progress_assessment"
  | "progress_correction"
  | "terminal_transition";

export type RuntimeTerminalStatus = "succeeded" | "blocked" | "failed" | "cancelled";

export interface RunStartedRuntimeEventPayload {
  readonly status: "running";
  readonly activeAgentId: string;
}

export interface RunItemAppendedRuntimeEventPayload {
  readonly itemId: string;
  readonly itemKind: RuntimeRunItemKind;
  readonly itemSequence: number;
}

export type RuntimeRunProgressDisposition =
  | "advanced"
  | "unchanged"
  | "repeated"
  | "deferred";

export type RuntimeRunProgressReasonCode =
  | "new_trusted_fact"
  | "equivalent_fact_repeated"
  | "activity_without_structural_change"
  | "plan_declaration_only"
  | "progression_basis_changed"
  | "required_work_pending"
  | "no_committed_facts";

export type RuntimeRunProgressFactKind =
  | "controller_turn"
  | "run_action"
  | "plan_update"
  | "active_agent"
  | "steering"
  | "operation_result"
  | "operation_rejected"
  | "tool_rejected"
  | "interaction_settlement"
  | "descendant_settlement"
  | "validation_feedback"
  | "completion_gate"
  | "evidence_ref"
  | "artifact_ref"
  | "required_pending"
  | "unsupported_committed_fact";

export interface RuntimeRunProgressFactRef {
  readonly kind: RuntimeRunProgressFactKind;
  readonly owner: string;
  readonly subjectId: string | null;
  readonly revision: string | null;
}

export interface RunProgressAssessedRuntimeEventPayload {
  readonly checkpointSequence: number;
  readonly disposition: RuntimeRunProgressDisposition;
  readonly reasonCode: RuntimeRunProgressReasonCode;
  readonly factRefs: readonly RuntimeRunProgressFactRef[];
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
}

export interface RunProgressCorrectionRequestedRuntimeEventPayload {
  readonly checkpointSequence: number;
  readonly correctionRound: number;
  readonly reasonCode: RuntimeRunProgressReasonCode;
  readonly factRefs: readonly RuntimeRunProgressFactRef[];
}

export interface RunDescendantRuntimeEventPayload {
  readonly relationId: string;
  readonly parentRunActionId: string;
  readonly childRunId: string;
  readonly depth: number;
  readonly treeRevision: number;
}

export type RunDescendantReservedRuntimeEventPayload =
  RunDescendantRuntimeEventPayload;
export type RunDescendantStartedRuntimeEventPayload =
  RunDescendantRuntimeEventPayload;

export type RuntimeDescendantRunFailureCode =
  | "descendant_run_start_cancelled"
  | "descendant_run_deadline_exceeded"
  | "descendant_run_depth_limit_exceeded"
  | "descendant_run_total_limit_exceeded"
  | "descendant_run_active_limit_exceeded"
  | "descendant_run_preparation_failed"
  | "descendant_agent_mismatch"
  | "descendant_run_start_failed";

export interface RunDescendantRejectedRuntimeEventPayload {
  readonly relationId: string | null;
  readonly parentRunActionId: string;
  readonly childRunId: string | null;
  readonly depth: number | null;
  readonly code: RuntimeDescendantRunFailureCode;
  readonly treeRevision: number;
}

export interface RunDescendantSettledRuntimeEventPayload
  extends RunDescendantRuntimeEventPayload {
  readonly status: RuntimeTerminalStatus;
  readonly code: string | null;
}

export type RuntimeContextTransitionOperationKind =
  | "add"
  | "replace"
  | "invalidate"
  | "remove";

export interface ContextTransitionCommittedRuntimeEventPayload {
  readonly transitionId: string;
  readonly activeContextId: string;
  readonly baseVersion: number;
  readonly committedVersion: number;
  readonly proposerOwner: string;
  readonly proposerKind: string;
  readonly causeKind: string;
  readonly causeId: string | null;
  readonly correlationId: string | null;
  readonly operationKinds: readonly RuntimeContextTransitionOperationKind[];
}

export interface ContextProjectionCompletedRuntimeEventPayload {
  readonly manifestId: string;
  readonly projectionId: string;
  readonly requestId: string;
  readonly activeContextId: string;
  readonly activeContextVersion: number;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly policyId: string;
  readonly policyRevision: string;
  readonly estimatorId: string;
  readonly estimatorRevision: string;
  readonly accountingUnit: "bytes" | "tokens";
  readonly budgetMaximum: number;
  readonly consideredItemCount: number;
  readonly projectedItemCount: number;
  readonly projectedAmount: number;
  readonly includedCount: number;
  readonly transformedCount: number;
  readonly referencedCount: number;
  readonly omittedCount: number;
  readonly rejectedCount: number;
  readonly blockedCount: number;
  readonly outcome: "projected" | "blocked";
  readonly code: string | null;
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

export type RunCompletedRuntimeEventPayload = TerminalRuntimeEventPayload<"succeeded">;
export type RunBlockedRuntimeEventPayload = TerminalRuntimeEventPayload<"blocked">;
export type RunFailedRuntimeEventPayload = TerminalRuntimeEventPayload<"failed">;
export type RunCancelledRuntimeEventPayload = TerminalRuntimeEventPayload<"cancelled">;

export interface ControllerStartedRuntimeEventPayload {
  readonly turnId: string;
  readonly iteration: number;
}

export interface ControllerFinishedRuntimeEventPayload {
  readonly turnId: string;
  readonly iteration: number;
  readonly status: "decided" | "failed" | "interrupted";
  readonly code: string | null;
  readonly decisionKind: "advance" | "propose_completion" | "propose_stop" | null;
}

export type RuntimeOperationBindingKind = "internal" | "direct" | "hosted" | "composite" | "descendant_agent";
export type RuntimeOperationCorrelationKind = "run_action" | "run_request" | "owner_operation" | "evaluation_trial";

export interface OperationStartedRuntimeEventPayload {
  readonly invocationId: string;
  readonly operationNamespace: string;
  readonly operationName: string;
  readonly operationRevision: string;
  readonly semanticOwner: string;
  readonly bindingKind: RuntimeOperationBindingKind;
  readonly correlationKind: RuntimeOperationCorrelationKind;
  readonly parentInvocationId: string | null;
  readonly parentRunActionId: string | null;
}

export type RuntimeOperationStatus = "succeeded" | "partial" | "failed" | "unavailable" | "denied" | "cancelled" | "timed_out" | "invalid" | "unknown_effect";

export interface OperationFinishedRuntimeEventPayload {
  readonly invocationId: string;
  readonly status: RuntimeOperationStatus;
  readonly code: string | null;
  readonly resultId: string;
  readonly lowerResultRefs: readonly string[];
}

export interface InteractionOpenedRuntimeEventPayload {
  readonly requestId: string;
  readonly protocolOwner: string;
  readonly protocolKind: string;
  readonly protocolRevision: string;
  readonly subjectOwner: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly blockingScope: "none" | "branch" | "run";
  readonly pendingVersion: number;
  readonly parentRunActionId: string | null;
}

export interface InteractionSettledRuntimeEventPayload {
  readonly requestId: string;
  readonly pendingVersion: number;
  readonly lifecycle: "resolved" | "expired" | "cancelled" | "invalidated" | "failed";
  readonly code: string | null;
  readonly terminalRecordId: string;
}

export interface ValidationCheckStartedRuntimeEventPayload {
  readonly snapshotRevision: number;
  readonly attemptId: string;
  readonly requirementId: string;
  readonly origin: "controller" | "trusted_automatic" | "trusted_workflow" | "owner_request";
}

export interface ValidationCheckFinishedRuntimeEventPayload {
  readonly snapshotRevision: number;
  readonly attemptId: string;
  readonly status: "invalid" | "unavailable" | "denied" | "cancelled" | "timed_out" | "failed" | "partial" | "completed";
  readonly code: string | null;
  readonly durationMs: number;
  readonly coverageRatio: number;
}

export interface ValidationAssessmentCommittedRuntimeEventPayload {
  readonly snapshotRevision: number;
  readonly requirementId: string;
  readonly assessmentId: string;
  readonly verdict: "satisfied" | "violated" | "inconclusive";
}

export interface ValidationGateEvaluatedRuntimeEventPayload {
  readonly snapshotRevision: number;
  readonly gateId: string;
  readonly status: "completion_eligible" | "blocked_unassessed" | "blocked_pending" | "blocked_stale" | "blocked_violated" | "blocked_inconclusive" | "invalid" | "failed";
  readonly disposition: "continue" | "wait" | "block" | "fail" | null;
  readonly reasonCodes: readonly string[];
}

export interface RuntimeEventPayloadMap {
  readonly "run.started": RunStartedRuntimeEventPayload;
  readonly "run.item.appended": RunItemAppendedRuntimeEventPayload;
  readonly "run.progress.assessed": RunProgressAssessedRuntimeEventPayload;
  readonly "run.progress.correction_requested": RunProgressCorrectionRequestedRuntimeEventPayload;
  readonly "run.descendant.reserved": RunDescendantReservedRuntimeEventPayload;
  readonly "run.descendant.started": RunDescendantStartedRuntimeEventPayload;
  readonly "run.descendant.rejected": RunDescendantRejectedRuntimeEventPayload;
  readonly "run.descendant.settled": RunDescendantSettledRuntimeEventPayload;
  readonly "context.transition.committed": ContextTransitionCommittedRuntimeEventPayload;
  readonly "context.projection.completed": ContextProjectionCompletedRuntimeEventPayload;
  readonly "run.completed": RunCompletedRuntimeEventPayload;
  readonly "run.blocked": RunBlockedRuntimeEventPayload;
  readonly "run.failed": RunFailedRuntimeEventPayload;
  readonly "run.cancelled": RunCancelledRuntimeEventPayload;
  readonly "controller.started": ControllerStartedRuntimeEventPayload;
  readonly "controller.finished": ControllerFinishedRuntimeEventPayload;
  readonly "operation.started": OperationStartedRuntimeEventPayload;
  readonly "operation.finished": OperationFinishedRuntimeEventPayload;
  readonly "interaction.opened": InteractionOpenedRuntimeEventPayload;
  readonly "interaction.settled": InteractionSettledRuntimeEventPayload;
  readonly "validation.check.started": ValidationCheckStartedRuntimeEventPayload;
  readonly "validation.check.finished": ValidationCheckFinishedRuntimeEventPayload;
  readonly "validation.assessment.committed": ValidationAssessmentCommittedRuntimeEventPayload;
  readonly "validation.gate.evaluated": ValidationGateEvaluatedRuntimeEventPayload;
}

export type RuntimeEventName = keyof RuntimeEventPayloadMap;
