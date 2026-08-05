import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditFailure,
  type AuditApprovalResolvedPayload,
  type AuditOutcome,
  type AuditPort,
  type ObservabilityRecordContext,
  type TelemetryFailure,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { IdentityRef, RunWorkspace } from "@agent-anything/agent-core/run";
import type { ApprovalCounters, ApprovalRecordSummary, RunFailureCause, RunFailureKind } from "../run/index.js";
import { createRunFailureCause } from "../run/RunFailure.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import {
  settleRunnerRecordingGate,
  type RunnerRecorder,
} from "./RunnerRecordingGate.js";

export interface RecordApprovalResolutionInput {
  readonly runId: string;
  readonly summary: ApprovalRecordSummary;
  readonly taskId: string;
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
  readonly timestamp: string;
  readonly counters: ApprovalCounters;
  readonly auditRequirement: RunInfrastructureRequirement;
  readonly telemetryRequirement: RunInfrastructureRequirement;
  readonly context: ObservabilityRecordContext;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly skipKinds?: ReadonlySet<RunFailureKind>;
}

type ObservabilityRunFailure = Extract<
  RunFailureCause,
  { readonly kind: "audit" | "telemetry" }
>;

export async function recordApprovalResolution(
  input: RecordApprovalResolutionInput,
): Promise<ObservabilityRunFailure[]> {
  const skipKinds = input.skipKinds ?? new Set<RunFailureKind>();
  const allRecorders = [
    {
      owner: "audit",
      requirement: input.auditRequirement,
      execute: () => recordAudit(input),
    },
    {
      owner: "telemetry",
      requirement: input.telemetryRequirement,
      execute: () => recordTelemetry(input),
    },
  ] satisfies RunnerRecorder[];
  const recorders = allRecorders.filter(
    (recorder) => !skipKinds.has(recorder.owner),
  );
  return [
    ...await settleRunnerRecordingGate({
      purpose: input.context.purpose,
      signal: input.context.signal,
      recorders,
    }),
  ];
}

async function recordAudit(
  input: RecordApprovalResolutionInput,
): Promise<ObservabilityRunFailure | null> {
  if (input.auditPort === undefined) {
    return input.auditRequirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable for approval resolution.")
      : null;
  }
  try {
    await recordWithinContext(
      () => input.auditPort!.record(createAuditRecord({
        id: `${input.summary.requestId}:audit:approval:resolved`,
        runId: input.runId,
        taskId: input.taskId,
        eventName: "approval.resolved",
        timestamp: input.timestamp,
        actor: {
          kind: input.identity.kind,
          id: input.identity.id,
        },
        workspaceId: input.workspace?.primary.id ?? null,
        subject: {
          kind: input.identity.kind,
          id: input.identity.id,
        },
        action: "approval.resolved",
        target: {
          kind: "approval_request",
          id: input.summary.requestId,
          actionId: input.summary.actionId,
          category: null,
        },
        outcome: auditOutcome(input.summary),
        payload: safeResolutionPayload(input.summary),
      }), input.context),
      input.context,
    );
    return null;
  } catch (error) {
    if (input.auditRequirement !== "required") return null;
    return input.context.purpose === "finalization" && input.context.signal.aborted
      ? auditFailure(
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
): Promise<ObservabilityRunFailure | null> {
  if (input.telemetryPort === undefined) {
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required TelemetryPort is unavailable for approval resolution.")
      : null;
  }
  try {
    await recordWithinContext(
      () => input.telemetryPort!.record(createTelemetryRecord({
        id: `${input.summary.requestId}:telemetry:approval:resolved`,
        runId: input.runId,
        taskId: input.taskId,
        eventName: "runner.approval.resolved",
        timestamp: input.timestamp,
        durationMs: null,
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
      }), input.context),
      input.context,
    );
    return null;
  } catch (error) {
    if (input.telemetryRequirement !== "required") return null;
    return input.context.purpose === "finalization" && input.context.signal.aborted
      ? telemetryFailure(
          "telemetry_finalization_timeout",
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

function safeResolutionPayload(
  summary: ApprovalRecordSummary,
): AuditApprovalResolvedPayload {
  return {
    pendingVersion: summary.pendingVersion,
    reviewer: summary.reviewer,
    resolutionKind: summary.resolutionKind,
    decisionKind: summary.decisionKind,
    applicationKind: summary.applicationKind,
    code: summary.code,
    authorityRecordIds: Object.freeze([...summary.authorityRecordIds]),
  };
}

function requiredAuditError(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ObservabilityRunFailure {
  return auditFailure("audit_required_failed", message, metadata);
}

function requiredTelemetryError(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ObservabilityRunFailure {
  return telemetryFailure("telemetry_required_failed", message, metadata);
}

function auditFailure(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>>,
): ObservabilityRunFailure {
  const failure: AuditFailure = Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  });
  return createRunFailureCause("audit", failure);
}

function telemetryFailure(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>>,
): ObservabilityRunFailure {
  const failure: TelemetryFailure = Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  });
  return createRunFailureCause("telemetry", failure);
}
