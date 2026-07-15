import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditOutcome,
  type AuditPort,
  type ObservabilityRecordContext,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { ApprovalRecordSummary } from "./ApprovalSummary.js";
import type { ApprovalCounters } from "./RunPermissionState.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { RuntimeError, RuntimeErrorOwner } from "./RuntimeError.js";

export interface RecordApprovalResolutionInput {
  readonly runId: string;
  readonly summary: ApprovalRecordSummary;
  readonly taskId: string;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly timestamp: ISODateTimeString;
  readonly counters: ApprovalCounters;
  readonly auditRequirement: RunInfrastructureRequirement;
  readonly telemetryRequirement: RunInfrastructureRequirement;
  readonly context: ObservabilityRecordContext;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly skipOwners?: ReadonlySet<RuntimeErrorOwner>;
}

export async function recordApprovalResolution(
  input: RecordApprovalResolutionInput,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];
  const skipOwners = input.skipOwners ?? new Set<RuntimeErrorOwner>();
  if (!skipOwners.has("audit")) {
    const error = await recordAudit(input);
    if (error !== null) errors.push(error);
  }
  if (!skipOwners.has("telemetry")) {
    const error = await recordTelemetry(input);
    if (error !== null) errors.push(error);
  }
  return errors;
}

async function recordAudit(
  input: RecordApprovalResolutionInput,
): Promise<RuntimeError | null> {
  if (input.auditPort === undefined) {
    return input.auditRequirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable for approval resolution.")
      : null;
  }
  try {
    await recordWithinContext(
      () => input.auditPort!.record(createAuditRecord({
        id: `${input.summary.requestId}:audit:approval:resolved`,
        taskId: input.taskId,
        eventName: "approval.resolved",
        timestamp: input.timestamp,
        actorRef: input.identity.id,
        workspaceId: input.workspace.id,
        subject: {
          kind: input.identity.kind,
          id: input.identity.id,
          metadata: {},
        },
        action: "approval.resolved",
        target: {
          kind: "approval_request",
          id: input.summary.requestId,
          metadata: {
            runId: input.runId,
            actionId: input.summary.actionId,
          },
        },
        outcome: auditOutcome(input.summary),
        payload: safeResolutionPayload(input.summary),
        metadata: { source: "runner" },
      }), input.context),
      input.context,
    );
    return null;
  } catch (error) {
    if (input.auditRequirement !== "required") return null;
    return input.context.signal.aborted
      ? runtimeError(
          "audit",
          "audit_finalization_timeout",
          "Required approval resolution audit exceeded its settlement deadline.",
          { deadlineAt: input.context.deadlineAt },
        )
      : requiredAuditError(
          "Required approval resolution audit failed.",
          error instanceof Error ? { causeName: error.name } : {},
        );
  }
}

async function recordTelemetry(
  input: RecordApprovalResolutionInput,
): Promise<RuntimeError | null> {
  if (input.telemetryPort === undefined) {
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required TelemetryPort is unavailable for approval resolution.")
      : null;
  }
  try {
    await recordWithinContext(
      () => input.telemetryPort!.record(createTelemetryRecord({
        id: `${input.summary.requestId}:telemetry:approval:resolved`,
        taskId: input.taskId,
        eventName: "runner.approval.resolved",
        timestamp: input.timestamp,
        counters: {
          requests: input.counters.totalRequests,
          consecutiveDeclines: input.counters.consecutiveDeclines,
          consecutiveReviewFailures: input.counters.consecutiveReviewFailures,
          authorityRecords: input.summary.authorityRecordIds.length,
        },
        dimensions: {
          reviewer: input.summary.reviewer,
          resolutionKind: input.summary.resolutionKind,
          decisionKind: input.summary.decisionKind,
          applicationKind: input.summary.applicationKind,
          code: input.summary.code,
        },
        metadata: {
          runId: input.runId,
          requestId: input.summary.requestId,
          actionId: input.summary.actionId,
        },
      }), input.context),
      input.context,
    );
    return null;
  } catch (error) {
    if (input.telemetryRequirement !== "required") return null;
    return input.context.signal.aborted
      ? runtimeError(
          "telemetry",
          "runtime_telemetry_finalization_timeout",
          "Required approval resolution telemetry exceeded its settlement deadline.",
          { deadlineAt: input.context.deadlineAt },
        )
      : requiredTelemetryError(
          "Required approval resolution telemetry failed.",
          error instanceof Error ? { causeName: error.name } : {},
        );
  }
}

function recordWithinContext(
  start: () => Promise<void>,
  context: ObservabilityRecordContext,
): Promise<void> {
  if (context.signal.aborted) {
    return Promise.reject(context.signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(context.signal.reason));
    context.signal.addEventListener("abort", onAbort, { once: true });
    let operation: Promise<void>;
    try {
      operation = start();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    operation.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

function auditOutcome(summary: ApprovalRecordSummary): AuditOutcome {
  if (summary.resolutionKind === "run_cancelled") return "cancelled";
  if (summary.resolutionKind === "review_failure" ||
      summary.resolutionKind === "request_failure") return "failed";
  return "succeeded";
}

function safeResolutionPayload(summary: ApprovalRecordSummary): Metadata {
  return {
    pendingVersion: summary.pendingVersion,
    reviewer: summary.reviewer,
    resolutionKind: summary.resolutionKind,
    decisionKind: summary.decisionKind,
    applicationKind: summary.applicationKind,
    code: summary.code,
    authorityRecordIds: [...summary.authorityRecordIds],
  };
}

function requiredAuditError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError("audit", "audit_required_failed", message, metadata);
}

function requiredTelemetryError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError("telemetry", "runtime_telemetry_required_failed", message, metadata);
}

function runtimeError(
  owner: "audit" | "telemetry",
  code: string,
  message: string,
  metadata: Metadata,
): RuntimeError {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  });
}
