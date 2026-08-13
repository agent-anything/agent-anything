import type {
  RuntimeOperationBindingKind,
  RuntimeOperationCorrelationKind,
  RuntimeOperationStatus,
  RuntimeRunItemKind,
  RuntimeTerminalStatus,
} from "../events/RuntimeEventPayload.js";

export const RUN_TRACE_SCHEMA_VERSION = 1 as const;

export type RunTraceStatus = "active" | "complete" | "incomplete";
export type TraceOwner = "runtime" | "controller" | "operation" | "interaction";
export type TraceSpanStatus = "running" | "succeeded" | "blocked" | "failed" | "cancelled" | "unknown";
export type TraceLinkKind =
  | "runtime_event"
  | "run_item"
  | "run_result"
  | "action"
  | "operation_invocation"
  | "operation_result"
  | "interaction_request"
  | "sandbox_attempt"
  | "retry_operation"
  | "audit_record"
  | "telemetry_record";

export interface TraceLink { readonly kind: TraceLinkKind; readonly id: string }

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

export interface TraceIssue { readonly code: TraceIssueCode; readonly sourceId: string | null; readonly operationId: string | null }

export interface RuntimeRunTraceAttributes {
  readonly activeAgentId: string | null;
  readonly terminalCode: string | null;
  readonly itemCount: number | null;
  readonly evidenceCount: number | null;
  readonly artifactCount: number | null;
  readonly errorCodes: readonly string[];
}

export interface ControllerTurnTraceAttributes {
  readonly turnId: string;
  readonly iteration: number;
  readonly decisionKind: "advance" | "propose_completion" | "propose_stop" | null;
  readonly code: string | null;
}

export interface OperationTraceAttributes {
  readonly namespace: string;
  readonly name: string;
  readonly revision: string;
  readonly semanticOwner: string;
  readonly bindingKind: RuntimeOperationBindingKind;
  readonly correlationKind: RuntimeOperationCorrelationKind;
  readonly resultId: string | null;
  readonly resultStatus: RuntimeOperationStatus | null;
  readonly code: string | null;
}

export interface InteractionTraceAttributes {
  readonly protocolOwner: string;
  readonly protocolKind: string;
  readonly protocolRevision: string;
  readonly subjectKind: string;
  readonly blockingScope: "none" | "branch" | "run";
  readonly pendingVersion: number;
  readonly lifecycle: "resolved" | "expired" | "cancelled" | "invalidated" | "failed" | null;
  readonly terminalRecordId: string | null;
  readonly code: string | null;
}

export interface TraceAttributeMap {
  readonly runtime: { readonly run: RuntimeRunTraceAttributes };
  readonly controller: { readonly turn: ControllerTurnTraceAttributes };
  readonly operation: { readonly operation: OperationTraceAttributes };
  readonly interaction: { readonly interaction: InteractionTraceAttributes };
}

export type TraceOperationFor<TOwner extends TraceOwner> = Extract<keyof TraceAttributeMap[TOwner], string>;
export type TraceAttributesFor<TOwner extends TraceOwner, TOperation extends TraceOperationFor<TOwner>> = TraceAttributeMap[TOwner][TOperation];

export interface TraceSpanEnvelope<TOwner extends TraceOwner, TOperation extends TraceOperationFor<TOwner>> {
  readonly spanId: string;
  readonly sequence: number;
  readonly parentSpanId: string | null;
  readonly operationId: string;
  readonly owner: TOwner;
  readonly operation: TOperation;
  readonly status: TraceSpanStatus;
  readonly code: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly links: readonly TraceLink[];
  readonly attributes: TraceAttributesFor<TOwner, TOperation>;
}

export type TraceSpan =
  | TraceSpanEnvelope<"runtime", "run">
  | TraceSpanEnvelope<"controller", "turn">
  | TraceSpanEnvelope<"operation", "operation">
  | TraceSpanEnvelope<"interaction", "interaction">;

export interface RunTrace {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly status: RunTraceStatus;
  readonly rootSpanId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly spans: readonly TraceSpan[];
  readonly issues: readonly TraceIssue[];
}

export interface CommittedRunItemTraceProjection {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: RuntimeRunItemKind;
  readonly createdAt: string;
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

export interface RunTraceObserver { observe(trace: RunTrace): void | Promise<void> }

export interface RunTraceSpanIdentityInput {
  readonly runId: string;
  readonly sequence: number;
  readonly owner: TraceOwner;
  readonly operation: "run" | "turn" | "operation" | "interaction";
  readonly operationId: string;
}

export type RunTraceSpanIdentityFactory = (input: RunTraceSpanIdentityInput) => string;

export interface CreateRunTraceAssemblerInput {
  readonly traceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly createSpanId: RunTraceSpanIdentityFactory;
  readonly observers?: readonly RunTraceObserver[];
}

export function createControllerTurnTraceOperationId(iteration: number): string {
  if (!Number.isSafeInteger(iteration) || iteration < 1) throw new TypeError("Controller trace iteration must be a positive integer.");
  return `controller-turn:${iteration}`;
}
