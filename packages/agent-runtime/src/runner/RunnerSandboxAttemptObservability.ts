import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditPort,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { SandboxAttempt } from "@agent-anything/action-execution";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { SandboxAttemptResolutionSummary } from "@agent-anything/agent-core/run";
import type { RuntimeError } from "@agent-anything/agent-core/run";

interface SandboxAttemptRecordInput {
  readonly attempt: SandboxAttempt;
  readonly taskId: string;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly timestamp: ISODateTimeString;
  readonly auditRequirement: RunInfrastructureRequirement;
  readonly telemetryRequirement: RunInfrastructureRequirement;
  readonly signal: AbortSignal;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
}

export async function recordSandboxAttemptStarted(
  input: SandboxAttemptRecordInput,
): Promise<readonly RuntimeError[]> {
  return recordAttempt(input, "started", null);
}

export async function recordSandboxAttemptResolved(
  input: SandboxAttemptRecordInput & {
    readonly resolution: SandboxAttemptResolutionSummary;
  },
): Promise<readonly RuntimeError[]> {
  return recordAttempt(input, "resolved", input.resolution);
}

async function recordAttempt(
  input: SandboxAttemptRecordInput,
  phase: "started" | "resolved",
  resolution: SandboxAttemptResolutionSummary | null,
): Promise<readonly RuntimeError[]> {
  if (input.signal.aborted) throw input.signal.reason;
  const errors: RuntimeError[] = [];
  const auditError = await recordAudit(input, phase, resolution);
  if (auditError !== null) errors.push(auditError);
  if (input.signal.aborted) throw input.signal.reason;
  const telemetryError = await recordTelemetry(input, phase, resolution);
  if (telemetryError !== null) errors.push(telemetryError);
  return Object.freeze(errors);
}

async function recordAudit(
  input: SandboxAttemptRecordInput,
  phase: "started" | "resolved",
  resolution: SandboxAttemptResolutionSummary | null,
): Promise<RuntimeError | null> {
  if (input.auditPort === undefined) {
    return input.auditRequirement === "required"
      ? requiredError("audit", "audit_required_failed", `Required sandbox attempt ${phase} AuditPort is unavailable.`)
      : null;
  }
  try {
    await recordWithinSignal(() => input.auditPort!.record(createAuditRecord({
      id: `${input.attempt.id}:audit:${phase}`,
      taskId: input.taskId,
      eventName: `sandbox.attempt.${phase}`,
      timestamp: input.timestamp,
      actorRef: input.identity.id,
      workspaceId: input.workspace.id,
      subject: { kind: input.identity.kind, id: input.identity.id, metadata: {} },
      action: `sandbox.attempt.${phase}`,
      target: {
        kind: "sandbox_attempt",
        id: input.attempt.id,
        metadata: {
          runId: input.attempt.runId,
          actionId: input.attempt.actionId,
        },
      },
      outcome: resolution === null
        ? "succeeded"
        : resolution.outcome === "executed"
        ? "succeeded"
        : "failed",
      payload: safePayload(input.attempt, resolution),
      metadata: { source: "runner" },
    }), Object.freeze({
      purpose: "runtime" as const,
      signal: input.signal,
      deadlineAt: null,
    })), input.signal);
    return null;
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    return input.auditRequirement === "required"
      ? requiredError(
          "audit",
          "audit_required_failed",
          `Required sandbox attempt ${phase} Audit failed.`,
          error,
        )
      : null;
  }
}

async function recordTelemetry(
  input: SandboxAttemptRecordInput,
  phase: "started" | "resolved",
  resolution: SandboxAttemptResolutionSummary | null,
): Promise<RuntimeError | null> {
  if (input.telemetryPort === undefined) {
    return input.telemetryRequirement === "required"
      ? requiredError(
          "telemetry",
          "runtime_telemetry_required_failed",
          `Required sandbox attempt ${phase} TelemetryPort is unavailable.`,
        )
      : null;
  }
  try {
    await recordWithinSignal(() => input.telemetryPort!.record(createTelemetryRecord({
      id: `${input.attempt.id}:telemetry:${phase}`,
      taskId: input.taskId,
      eventName: `runner.sandbox.attempt.${phase}`,
      timestamp: input.timestamp,
      durationMs: phase === "started"
        ? 0
        : Math.max(0, Date.parse(input.timestamp) - Date.parse(input.attempt.startedAt)),
      counters: {
        ordinal: input.attempt.ordinal,
      },
      dimensions: {
        phase,
        enforcement: input.attempt.enforcement,
        outcome: resolution?.outcome ?? "started",
      },
      metadata: {
        runId: input.attempt.runId,
        actionId: input.attempt.actionId,
        attemptId: input.attempt.id,
      },
    }), Object.freeze({
      purpose: "runtime" as const,
      signal: input.signal,
      deadlineAt: null,
    })), input.signal);
    return null;
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    return input.telemetryRequirement === "required"
      ? requiredError(
          "telemetry",
          "runtime_telemetry_required_failed",
          `Required sandbox attempt ${phase} Telemetry failed.`,
          error,
        )
      : null;
  }
}

function safePayload(
  attempt: SandboxAttempt,
  resolution: SandboxAttemptResolutionSummary | null,
) {
  return {
    actionFingerprint: attempt.actionFingerprint,
    ordinal: attempt.ordinal,
    enforcement: attempt.enforcement,
    policyId: attempt.policyId,
    authoritySnapshotId: attempt.authoritySnapshotId,
    dispatchPlanFingerprint: attempt.dispatchPlanFingerprint,
    ...(resolution === null
      ? {}
      : {
          outcome: resolution.outcome,
          code: resolution.code,
          effectState: resolution.effectState,
        }),
  };
}

function recordWithinSignal(
  start: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
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

function requiredError(
  owner: "audit" | "telemetry",
  code: string,
  message: string,
  cause?: unknown,
): RuntimeError {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: Object.freeze(cause instanceof Error ? { causeName: cause.name } : {}),
  });
}
