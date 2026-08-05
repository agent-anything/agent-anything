import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditFailure,
  type AuditPort,
  type ObservabilityRecordContext,
  type TelemetryFailure,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { IdentityRef, RunWorkspace } from "@agent-anything/agent-core/run";
import type { RunCounters, RunFailureCause, RunFailureKind } from "../run/index.js";
import { createRunFailureCause } from "../run/RunFailure.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import {
  settleRunnerRecordingGate,
  type RunnerRecorder,
} from "./RunnerRecordingGate.js";

export interface RecordRunnerLifecycleInput {
  readonly phase: "started" | "succeeded" | "blocked" | "failed" | "cancelled";
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly startedAtMs: number;
  readonly timestamp: string;
  readonly counters: RunCounters;
  readonly itemCount: number;
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
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

export async function recordRunnerLifecycle(
  input: RecordRunnerLifecycleInput,
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
  input: RecordRunnerLifecycleInput,
): Promise<ObservabilityRunFailure | null> {
  if (!input.auditPort) {
    return input.auditRequirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable.")
      : null;
  }

  try {
    await recordWithinContext(
      () => input.auditPort!.record(
        createRunnerLifecycleAuditRecord(input),
        input.context,
      ),
      input.context,
    );
    return null;
  } catch (error) {
    if (error instanceof FinalizationDeadlineError) {
      return input.auditRequirement === "required"
        ? auditFinalizationTimeout(input.context.deadlineAt)
        : null;
    }
    return input.auditRequirement === "required"
      ? requiredAuditError("Required audit recording failed.", errorMetadata(error))
      : null;
  }
}

async function recordTelemetry(
  input: RecordRunnerLifecycleInput,
): Promise<ObservabilityRunFailure | null> {
  if (!input.telemetryPort) {
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required TelemetryPort is unavailable.")
      : null;
  }

  try {
    await recordWithinContext(
      () => input.telemetryPort!.record(
        createRunnerLifecycleTelemetryRecord(input),
        input.context,
      ),
      input.context,
    );
    return null;
  } catch (error) {
    if (error instanceof FinalizationDeadlineError) {
      return input.telemetryRequirement === "required"
        ? telemetryFinalizationTimeout(input.context.deadlineAt)
        : null;
    }
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required telemetry recording failed.", errorMetadata(error))
      : null;
  }
}

function createRunnerLifecycleAuditRecord(input: RecordRunnerLifecycleInput) {
  const base = {
    id: `${input.runId}:audit:${input.phase}`,
    runId: input.runId,
    taskId: input.taskId,
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
    target: {
      kind: "run" as const,
      id: input.runId,
    },
  };
  const payload = {
    activeAgentId: input.agentId,
    iterations: input.counters.iterations,
    actions: input.counters.actions,
    itemCount: input.itemCount,
  };
  switch (input.phase) {
    case "started":
      return createAuditRecord({
        ...base,
        eventName: "run.started",
        action: "runner.started",
        outcome: "succeeded",
        payload: { ...payload, status: "started" },
      });
    case "succeeded":
      return createAuditRecord({
        ...base,
        eventName: "run.succeeded",
        action: "runner.succeeded",
        outcome: "succeeded",
        payload: { ...payload, status: "succeeded" },
      });
    case "blocked":
      return createAuditRecord({
        ...base,
        eventName: "run.blocked",
        action: "runner.blocked",
        outcome: "blocked",
        payload: { ...payload, status: "blocked" },
      });
    case "failed":
      return createAuditRecord({
        ...base,
        eventName: "run.failed",
        action: "runner.failed",
        outcome: "failed",
        payload: { ...payload, status: "failed" },
      });
    case "cancelled":
      return createAuditRecord({
        ...base,
        eventName: "run.cancelled",
        action: "runner.cancelled",
        outcome: "cancelled",
        payload: { ...payload, status: "cancelled" },
      });
  }
}

function createRunnerLifecycleTelemetryRecord(
  input: RecordRunnerLifecycleInput,
) {
  const base = {
    id: `${input.runId}:telemetry:${input.phase}`,
    runId: input.runId,
    taskId: input.taskId,
    timestamp: input.timestamp,
    durationMs: Math.max(0, Date.parse(input.timestamp) - input.startedAtMs),
    counters: {
      iterations: input.counters.iterations,
      actions: input.counters.actions,
      items: input.itemCount,
    },
  };
  switch (input.phase) {
    case "started":
      return createTelemetryRecord({
        ...base,
        eventName: "runner.run.started",
        dimensions: { status: "started", agentId: input.agentId },
      });
    case "succeeded":
      return createTelemetryRecord({
        ...base,
        eventName: "runner.run.succeeded",
        dimensions: { status: "succeeded", agentId: input.agentId },
      });
    case "blocked":
      return createTelemetryRecord({
        ...base,
        eventName: "runner.run.blocked",
        dimensions: { status: "blocked", agentId: input.agentId },
      });
    case "failed":
      return createTelemetryRecord({
        ...base,
        eventName: "runner.run.failed",
        dimensions: { status: "failed", agentId: input.agentId },
      });
    case "cancelled":
      return createTelemetryRecord({
        ...base,
        eventName: "runner.run.cancelled",
        dimensions: { status: "cancelled", agentId: input.agentId },
      });
  }
}

function recordWithinContext(
  startOperation: () => Promise<void>,
  context: ObservabilityRecordContext,
): Promise<void> {
  if (context.purpose !== "finalization") {
    return startOperation();
  }
  if (context.signal.aborted) {
    return Promise.reject(new FinalizationDeadlineError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new FinalizationDeadlineError()));
    context.signal.addEventListener("abort", onAbort, { once: true });
    let operation: Promise<void>;
    try {
      operation = startOperation();
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

class FinalizationDeadlineError extends Error {
  constructor() {
    super("Runner lifecycle recording exceeded the finalization deadline.");
    this.name = "FinalizationDeadlineError";
  }
}

function requiredAuditError(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ObservabilityRunFailure {
  return auditFailure("audit_required_failed", message, metadata);
}

function auditFinalizationTimeout(
  deadlineAt: string | null,
): ObservabilityRunFailure {
  return auditFailure(
    "audit_finalization_timeout",
    "Required audit recording exceeded the Run finalization deadline.",
    { deadlineAt },
  );
}

function requiredTelemetryError(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ObservabilityRunFailure {
  return telemetryFailure(
    "telemetry_required_failed",
    message,
    metadata,
  );
}

function telemetryFinalizationTimeout(
  deadlineAt: string | null,
): ObservabilityRunFailure {
  return telemetryFailure(
    "telemetry_finalization_timeout",
    "Required telemetry recording exceeded the Run finalization deadline.",
    { deadlineAt },
  );
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

function errorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error ? { causeName: error.name } : {};
}
