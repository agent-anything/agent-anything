import {
  createAuditRecord,
  type AuditPort,
} from "@agent-anything/observability";
import type {
  ApprovalRequest,
  ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type {
  IdentityRef,
  ISODateTimeString,
  RunWorkspace,
} from "@agent-anything/foundation";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { RuntimeError } from "@agent-anything/foundation";
import { settleRunnerRecordingGate } from "./RunnerRecordingGate.js";

interface ApprovalAuditBaseInput {
  readonly request: ApprovalRequest;
  readonly pendingVersion: number;
  readonly taskId: string;
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
  readonly timestamp: ISODateTimeString;
  readonly requirement: RunInfrastructureRequirement;
  readonly signal: AbortSignal;
  readonly port?: AuditPort;
}

export function recordApprovalRequestAudit(
  input: ApprovalAuditBaseInput,
): Promise<RuntimeError | null> {
  return recordApprovalAudit(input, "requested", null);
}

export function recordApprovalValidatedDecisionAudit(
  input: ApprovalAuditBaseInput & { readonly decision: ValidatedApprovalDecision },
): Promise<RuntimeError | null> {
  return recordApprovalAudit(input, "decision_validated", input.decision.kind);
}

async function recordApprovalAudit(
  input: ApprovalAuditBaseInput,
  phase: "requested" | "decision_validated",
  decisionKind: ValidatedApprovalDecision["kind"] | null,
): Promise<RuntimeError | null> {
  const errors = await settleRunnerRecordingGate({
    purpose: "runtime",
    signal: input.signal,
    recorders: [{
      owner: "audit",
      requirement: input.requirement,
      execute: () => writeApprovalAudit(input, phase, decisionKind),
    }],
  });
  return errors[0] ?? null;
}

async function writeApprovalAudit(
  input: ApprovalAuditBaseInput,
  phase: "requested" | "decision_validated",
  decisionKind: ValidatedApprovalDecision["kind"] | null,
): Promise<RuntimeError | null> {
  if (input.port === undefined) {
    return input.requirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable for approval.")
      : null;
  }
  try {
    await recordWithinSignal(
      () => input.port!.record(createApprovalAuditRecord(
        input,
        phase,
        decisionKind,
      ), Object.freeze({
        purpose: "runtime" as const,
        signal: input.signal,
        deadlineAt: null,
      })),
      input.signal,
    );
    return null;
  } catch (error) {
    return input.requirement === "required"
      ? requiredAuditError(
          `Required approval ${phase} audit failed.`,
          error instanceof Error ? error.name : null,
        )
      : null;
  }
}

function createApprovalAuditRecord(
  input: ApprovalAuditBaseInput,
  phase: "requested" | "decision_validated",
  decisionKind: ValidatedApprovalDecision["kind"] | null,
) {
  const base = {
    id: `${input.request.runId}:audit:approval:${input.request.id}:${phase}`,
    runId: input.request.runId,
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
      kind: "approval_request" as const,
      id: input.request.id,
      actionId: input.request.actionId,
      category: input.request.category,
    },
    outcome: "succeeded" as const,
  };
  const payload = {
    pendingVersion: input.pendingVersion,
    optionIds: input.request.decisionOptions.map((option) => option.id),
  };
  if (phase === "requested") {
    return createAuditRecord({
      ...base,
      eventName: "approval.requested",
      action: "approval.requested",
      payload,
    });
  }
  if (decisionKind === null) {
    throw new TypeError("Validated approval Audit requires a decision kind.");
  }
  return createAuditRecord({
    ...base,
    eventName: "approval.decision_validated",
    action: "approval.decision_validated",
    payload: {
      ...payload,
      decisionKind,
    },
  });
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

function requiredAuditError(message: string, causeName: string | null = null): RuntimeError {
  return Object.freeze({
    owner: "audit" as const,
    code: "audit_required_failed",
    message,
    retryable: false,
    metadata: Object.freeze(causeName === null ? {} : { causeName }),
  });
}
