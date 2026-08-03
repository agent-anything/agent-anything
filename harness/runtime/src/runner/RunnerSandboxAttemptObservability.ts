import type { IdentityRef, RunWorkspace } from "@agent-anything/foundation";
import {
  createAuditRecord,
  createTelemetryRecord,
  type AuditSandboxAttemptResolvedPayload,
  type AuditSandboxAttemptStartedPayload,
  type AuditPort,
  type TelemetryPort,
} from "@agent-anything/observability";
import type { ISODateTimeString } from "@agent-anything/foundation";
import type { SandboxAttempt } from "@agent-anything/action-execution";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { SandboxAttemptResolutionSummary } from "@agent-anything/runtime/run";
import type { RuntimeError } from "@agent-anything/foundation";
import {
  settleRunnerRecordingGate,
  type RunnerRecorder,
} from "./RunnerRecordingGate.js";

interface SandboxAttemptRecordInput {
  readonly attempt: SandboxAttempt;
  readonly taskId: string;
  readonly workspace: RunWorkspace | null;
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
  const recorders: RunnerRecorder[] = [
    {
      owner: "audit",
      requirement: input.auditRequirement,
      execute: () => recordAudit(input, phase, resolution),
    },
    {
      owner: "telemetry",
      requirement: input.telemetryRequirement,
      execute: () => recordTelemetry(input, phase, resolution),
    },
  ];
  return settleRunnerRecordingGate({
    purpose: "runtime",
    signal: input.signal,
    recorders,
  });
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
    await recordWithinSignal(() => input.auditPort!.record(
      createSandboxAttemptAuditRecord(input, phase, resolution),
      Object.freeze({
      purpose: "runtime" as const,
      signal: input.signal,
      deadlineAt: null,
      }),
    ), input.signal);
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
          "telemetry_required_failed",
          `Required sandbox attempt ${phase} TelemetryPort is unavailable.`,
        )
      : null;
  }
  try {
    await recordWithinSignal(() => input.telemetryPort!.record(
      createSandboxAttemptTelemetryRecord(input, phase, resolution),
      Object.freeze({
        purpose: "runtime" as const,
        signal: input.signal,
        deadlineAt: null,
      }),
    ), input.signal);
    return null;
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    return input.telemetryRequirement === "required"
      ? requiredError(
          "telemetry",
          "telemetry_required_failed",
          `Required sandbox attempt ${phase} Telemetry failed.`,
          error,
        )
      : null;
  }
}

function createSandboxAttemptAuditRecord(
  input: SandboxAttemptRecordInput,
  phase: "started" | "resolved",
  resolution: SandboxAttemptResolutionSummary | null,
) {
  const base = {
    id: `${input.attempt.id}:audit:${phase}`,
    runId: input.attempt.runId,
    taskId: input.taskId,
    timestamp: input.timestamp,
    actor: {
      kind: input.identity.kind,
      id: input.identity.id,
    },
    workspaceId: input.workspace?.primary.id ?? null,
    subject: { kind: input.identity.kind, id: input.identity.id },
    target: {
      kind: "sandbox_attempt" as const,
      id: input.attempt.id,
      actionId: input.attempt.actionId,
    },
  };
  if (phase === "started") {
    if (resolution !== null) {
      throw new TypeError("Started Sandbox Audit cannot carry a resolution.");
    }
    return createAuditRecord({
      ...base,
      eventName: "sandbox.attempt.started",
      action: "sandbox.attempt.started",
      outcome: "succeeded",
      payload: safeStartedPayload(input.attempt),
    });
  }
  if (resolution === null) {
    throw new TypeError("Resolved Sandbox Audit requires a resolution.");
  }
  return createAuditRecord({
    ...base,
    eventName: "sandbox.attempt.resolved",
    action: "sandbox.attempt.resolved",
    outcome: resolution.outcome === "executed"
      ? "succeeded"
      : resolution.outcome === "interrupted"
      ? "cancelled"
      : "failed",
    payload: safeResolvedPayload(input.attempt, resolution),
  });
}

function createSandboxAttemptTelemetryRecord(
  input: SandboxAttemptRecordInput,
  phase: "started" | "resolved",
  resolution: SandboxAttemptResolutionSummary | null,
) {
  const base = {
    id: `${input.attempt.id}:telemetry:${phase}`,
    runId: input.attempt.runId,
    taskId: input.taskId,
    timestamp: input.timestamp,
    counters: { ordinal: input.attempt.ordinal },
  };
  if (phase === "started") {
    if (resolution !== null) {
      throw new TypeError("Started Sandbox Telemetry cannot carry a resolution.");
    }
    return createTelemetryRecord({
      ...base,
      eventName: "runner.sandbox.attempt.started",
      durationMs: 0,
      dimensions: {
        phase: "started",
        enforcement: input.attempt.enforcement,
        outcome: "started",
      },
    });
  }
  if (resolution === null) {
    throw new TypeError("Resolved Sandbox Telemetry requires a resolution.");
  }
  return createTelemetryRecord({
    ...base,
    eventName: "runner.sandbox.attempt.resolved",
    durationMs: Math.max(
      0,
      Date.parse(input.timestamp) - Date.parse(input.attempt.startedAt),
    ),
    dimensions: {
      phase: "resolved",
      enforcement: input.attempt.enforcement,
      outcome: resolution.outcome,
    },
  });
}

function safeStartedPayload(
  attempt: SandboxAttempt,
): AuditSandboxAttemptStartedPayload {
  return {
    actionFingerprint: attempt.actionFingerprint,
    ordinal: attempt.ordinal,
    enforcement: attempt.enforcement,
    policyId: attempt.policyId,
    authoritySnapshotId: attempt.authoritySnapshotId,
    dispatchPlanFingerprint: attempt.dispatchPlanFingerprint,
  };
}

function safeResolvedPayload(
  attempt: SandboxAttempt,
  resolution: SandboxAttemptResolutionSummary,
): AuditSandboxAttemptResolvedPayload {
  return {
    ...safeStartedPayload(attempt),
    outcome: resolution.outcome,
    code: resolution.code,
    effectState: resolution.effectState,
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
