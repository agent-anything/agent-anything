import type { ISODateTimeString } from "@agent-anything/foundation";
import type {
  RuntimeApprovalCategory,
  RuntimeRetryOwner,
  RuntimeRunItemKind,
  RuntimeSandboxEnforcement,
  RuntimeTerminalStatus,
} from "../events/RuntimeEventPayload.js";

export const RUN_TRACE_SCHEMA_VERSION = 1 as const;

export type RunTraceStatus = "active" | "complete" | "incomplete";

export type TraceOwner =
  | "runtime"
  | "controller"
  | "action"
  | "approval"
  | "sandbox"
  | "tool"
  | "retry";

export interface TraceAttributeMap {
  readonly runtime: {
    readonly run: RuntimeRunTraceAttributes;
  };
  readonly controller: {
    readonly turn: ControllerTurnTraceAttributes;
  };
  readonly action: {
    readonly processing: ActionProcessingTraceAttributes;
  };
  readonly approval: {
    readonly review: ApprovalReviewTraceAttributes;
  };
  readonly sandbox: {
    readonly attempt: SandboxAttemptTraceAttributes;
  };
  readonly tool: {
    readonly execution: ToolExecutionTraceAttributes;
  };
  readonly retry: {
    readonly attempt: RetryAttemptTraceAttributes;
  };
}

export type TraceOperationFor<TOwner extends TraceOwner> =
  Extract<keyof TraceAttributeMap[TOwner], string>;

export type TraceAttributesFor<
  TOwner extends TraceOwner,
  TOperation extends TraceOperationFor<TOwner>,
> = TraceAttributeMap[TOwner][TOperation];

export type TraceSpanStatus =
  | "running"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown";

export type TraceLinkKind =
  | "runtime_event"
  | "run_item"
  | "run_result"
  | "action"
  | "approval_request"
  | "approval_review_operation"
  | "sandbox_attempt"
  | "retry_operation"
  | "audit_record"
  | "telemetry_record";

export interface TraceLink {
  readonly kind: TraceLinkKind;
  readonly id: string;
}

export type TraceIssueCode =
  | "event_sequence_gap"
  | "event_sequence_regression"
  | "run_identity_mismatch"
  | "task_identity_mismatch"
  | "duplicate_operation_start"
  | "duplicate_operation_settlement"
  | "operation_start_missing"
  | "operation_settlement_missing"
  | "parent_operation_missing"
  | "terminal_event_missing"
  | "terminal_result_mismatch"
  | "run_item_event_missing"
  | "run_item_projection_missing"
  | "run_item_mismatch";

export interface TraceIssue {
  readonly code: TraceIssueCode;
  readonly sourceId: string | null;
  readonly operationId: string | null;
}

export interface TraceSpanEnvelope<
  TOwner extends TraceOwner,
  TOperation extends TraceOperationFor<TOwner>,
> {
  readonly spanId: string;
  readonly sequence: number;
  readonly parentSpanId: string | null;
  readonly operationId: string;
  readonly owner: TOwner;
  readonly operation: TOperation;
  readonly status: TraceSpanStatus;
  readonly code: string | null;
  readonly startedAt: ISODateTimeString | null;
  readonly completedAt: ISODateTimeString | null;
  readonly links: readonly TraceLink[];
  readonly attributes: TraceAttributesFor<TOwner, TOperation>;
}

export type TraceSpan = {
  readonly [TOwner in TraceOwner]: {
    readonly [TOperation in TraceOperationFor<TOwner>]:
      TraceSpanEnvelope<TOwner, TOperation>;
  }[TraceOperationFor<TOwner>];
}[TraceOwner];

export interface RunTrace {
  readonly schemaVersion: typeof RUN_TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly status: RunTraceStatus;
  readonly rootSpanId: string;
  readonly startedAt: ISODateTimeString | null;
  readonly completedAt: ISODateTimeString | null;
  readonly spans: readonly TraceSpan[];
  readonly issues: readonly TraceIssue[];
}

export interface RuntimeRunTraceAttributes {
  readonly activeAgentId: string | null;
  readonly terminalCode: string | null;
  readonly itemCount: number | null;
  readonly evidenceCount: number | null;
  readonly artifactCount: number | null;
  readonly errorCodes: readonly string[];
}

export interface ControllerTurnTraceAttributes {
  readonly iteration: number;
  readonly decisionKind: "final_output" | "actions" | "stop" | null;
  readonly code: string | null;
}

export interface ActionProcessingTraceAttributes {
  readonly category:
    | "file_system"
    | "process"
    | "network"
    | "remote_tool"
    | "computation"
    | null;
  readonly effectCount: number | null;
  readonly targetAssertionCount: number | null;
  readonly assessmentStatus:
    | "authorized"
    | "approval_required"
    | "denied"
    | "invalidated"
    | "failed"
    | "interrupted"
    | null;
  readonly assessmentOwner: "policy" | "permission" | "tool" | null;
  readonly outcomeStatus:
    | "succeeded"
    | "partial"
    | "failed"
    | "timeout"
    | "denied"
    | "rejected"
    | "declined"
    | "limit_reached"
    | "granted"
    | "updated"
    | null;
  readonly code: string | null;
}

export interface ApprovalReviewTraceAttributes {
  readonly requestId: string;
  readonly actionId: string;
  readonly category: RuntimeApprovalCategory | null;
  readonly reviewer: "user" | "auto_review" | null;
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
    | "outcome_unknown"
    | null;
  readonly code: string | null;
}

export interface SandboxAttemptTraceAttributes {
  readonly actionId: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: RuntimeSandboxEnforcement;
  readonly outcome:
    | "executed"
    | "sandbox_denied"
    | "sandbox_unavailable"
    | "interrupted"
    | "failed"
    | null;
  readonly code: string | null;
}

export interface ToolExecutionTraceAttributes {
  readonly actionId: string;
  readonly toolName: string;
  readonly resultStatus: "succeeded" | "partial" | "failed" | "timeout" | null;
  readonly reportedDurationMs: number | null;
  readonly code: string | null;
}

export interface RetryAttemptTraceAttributes {
  readonly retryOperationId: string;
  readonly retryOwner: RuntimeRetryOwner;
  readonly attemptNumber: number | null;
  readonly budgetAttemptNumber: number | null;
  readonly maxBudgetAttempts: number | null;
  readonly outcome: "succeeded" | "failed" | "cancelled" | null;
  readonly reportedDurationMs: number | null;
  readonly failureCategory: string | null;
  readonly failureCode: string | null;
}

export interface CommittedRunItemTraceProjection {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: RuntimeRunItemKind;
  readonly createdAt: ISODateTimeString;
}

export interface TerminalRunResultTraceProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly status: RuntimeTerminalStatus;
  readonly code: string | null;
  readonly itemCount: number;
  readonly evidenceCount: number;
  readonly artifactCount: number;
  readonly errorCodes: readonly string[];
}

export interface CompleteRunTraceInput {
  readonly items: readonly CommittedRunItemTraceProjection[];
  readonly result: TerminalRunResultTraceProjection;
}

export interface RunTraceObserver {
  observe(trace: RunTrace): void | Promise<void>;
}

export type RunTraceSpanIdentityInput = {
  readonly [TOwner in TraceOwner]: {
    readonly runId: string;
    readonly sequence: number;
    readonly owner: TOwner;
    readonly operation: TraceOperationFor<TOwner>;
    readonly operationId: string;
  };
}[TraceOwner];

export type RunTraceSpanIdentityFactory = (
  input: RunTraceSpanIdentityInput,
) => string;

export interface CreateRunTraceAssemblerInput {
  readonly traceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly createSpanId: RunTraceSpanIdentityFactory;
  readonly observers?: readonly RunTraceObserver[];
}

export function createControllerTurnTraceOperationId(iteration: number): string {
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new TypeError("Controller trace iteration must be a positive integer.");
  }
  return `controller-turn:${iteration}`;
}
