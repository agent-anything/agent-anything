export type RuntimeRunItemKind =
  | "controller_turn"
  | "run_action"
  | "observation"
  | "state_transition"
  | "pending_transition"
  | "cancellation_transition"
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

export interface RuntimeEventPayloadMap {
  readonly "run.started": RunStartedRuntimeEventPayload;
  readonly "run.item.appended": RunItemAppendedRuntimeEventPayload;
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
}

export type RuntimeEventName = keyof RuntimeEventPayloadMap;
