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
import type { RunCounters } from "../run/RunState.js";
import type { RuntimeError, RuntimeErrorOwner } from "../run/RuntimeError.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";

export interface RecordRunnerLifecycleInput {
  readonly phase: "started" | "succeeded" | "blocked" | "failed" | "cancelled";
  readonly outcome: AuditOutcome;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly startedAtMs: number;
  readonly timestamp: ISODateTimeString;
  readonly counters: RunCounters;
  readonly itemCount: number;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly auditRequirement: RunInfrastructureRequirement;
  readonly telemetryRequirement: RunInfrastructureRequirement;
  readonly context: ObservabilityRecordContext;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly skipOwners?: ReadonlySet<RuntimeErrorOwner>;
}

interface LifecycleRecorder {
  readonly owner: Extract<RuntimeErrorOwner, "audit" | "telemetry">;
  readonly requirement: RunInfrastructureRequirement;
  execute(): Promise<RuntimeError | null>;
}

export async function recordRunnerLifecycle(
  input: RecordRunnerLifecycleInput,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];
  const skipOwners = input.skipOwners ?? new Set<RuntimeErrorOwner>();
  const recorders: LifecycleRecorder[] = [
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
  ];

  if (input.context.purpose === "finalization") {
    recorders.sort((left, right) => requirementRank(left) - requirementRank(right));
  }

  for (const recorder of recorders) {
    if (skipOwners.has(recorder.owner)) {
      continue;
    }
    const error = await recorder.execute();
    if (error !== null) {
      errors.push(error);
    }
    if (input.context.signal.aborted) {
      break;
    }
  }
  return errors;
}

async function recordAudit(
  input: RecordRunnerLifecycleInput,
): Promise<RuntimeError | null> {
  if (!input.auditPort) {
    return input.auditRequirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable.")
      : null;
  }

  try {
    await recordWithinContext(
      () => input.auditPort!.record(createAuditRecord({
        id: `${input.runId}:audit:${input.phase}`,
        taskId: input.taskId,
        eventName: `run.${input.phase}`,
        timestamp: input.timestamp,
        actorRef: input.identity.id,
        workspaceId: input.workspace.id,
        subject: {
          kind: input.identity.kind,
          id: input.identity.id,
          metadata: input.identity.metadata,
        },
        action: `runner.${input.phase}`,
        target: {
          kind: "run",
          id: input.runId,
          metadata: { taskId: input.taskId },
        },
        outcome: input.outcome,
        payload: {
          status: input.phase,
          iterations: input.counters.iterations,
          actions: input.counters.actions,
          itemCount: input.itemCount,
        },
        metadata: { source: "runner" },
      }), input.context),
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
): Promise<RuntimeError | null> {
  if (!input.telemetryPort) {
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required TelemetryPort is unavailable.")
      : null;
  }

  try {
    await recordWithinContext(
      () => input.telemetryPort!.record(createTelemetryRecord({
        id: `${input.runId}:telemetry:${input.phase}`,
        taskId: input.taskId,
        eventName: `runner.run.${input.phase}`,
        timestamp: input.timestamp,
        durationMs: Math.max(0, Date.parse(input.timestamp) - input.startedAtMs),
        counters: {
          iterations: input.counters.iterations,
          actions: input.counters.actions,
          items: input.itemCount,
        },
        dimensions: {
          status: input.phase,
          agentId: input.agentId,
        },
        metadata: { runId: input.runId },
      }), input.context),
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

function requirementRank(recorder: LifecycleRecorder): number {
  return recorder.requirement === "required" ? 0 : 1;
}

function requiredAuditError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError("audit", "audit_required_failed", message, metadata);
}

function auditFinalizationTimeout(deadlineAt: ISODateTimeString | null): RuntimeError {
  return runtimeError(
    "audit",
    "audit_finalization_timeout",
    "Required audit recording exceeded the Run finalization deadline.",
    { deadlineAt },
  );
}

function requiredTelemetryError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError(
    "telemetry",
    "runtime_telemetry_required_failed",
    message,
    metadata,
  );
}

function telemetryFinalizationTimeout(
  deadlineAt: ISODateTimeString | null,
): RuntimeError {
  return runtimeError(
    "telemetry",
    "runtime_telemetry_finalization_timeout",
    "Required telemetry recording exceeded the Run finalization deadline.",
    { deadlineAt },
  );
}

function runtimeError(
  owner: RuntimeErrorOwner,
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

function errorMetadata(error: unknown): Metadata {
  return error instanceof Error ? { causeName: error.name } : {};
}
