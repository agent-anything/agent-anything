import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditOutcome,
  type AuditPort,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { RunCounters } from "./RunState.js";
import type { RuntimeError, RuntimeErrorOwner } from "./RuntimeError.js";
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
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly skipOwners?: ReadonlySet<RuntimeErrorOwner>;
}

export async function recordRunnerLifecycle(
  input: RecordRunnerLifecycleInput,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];
  const skipOwners = input.skipOwners ?? new Set<RuntimeErrorOwner>();

  if (!skipOwners.has("audit")) {
    const error = await recordAudit(input);
    if (error !== null) {
      errors.push(error);
    }
  }
  if (!skipOwners.has("telemetry")) {
    const error = await recordTelemetry(input);
    if (error !== null) {
      errors.push(error);
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
    await input.auditPort.record(createAuditRecord({
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
    }));
    return null;
  } catch (error) {
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
    await input.telemetryPort.record(createTelemetryRecord({
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
    }));
    return null;
  } catch (error) {
    return input.telemetryRequirement === "required"
      ? requiredTelemetryError("Required telemetry recording failed.", errorMetadata(error))
      : null;
  }
}

function requiredAuditError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError("audit", "audit_required_failed", message, metadata);
}

function requiredTelemetryError(message: string, metadata: Metadata = {}): RuntimeError {
  return runtimeError(
    "telemetry",
    "runtime_telemetry_required_failed",
    message,
    metadata,
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
