import {
  createAuditRecord,
  type AuditPort,
} from "@agent-anything/observability";
import type {
  ApprovalRequest,
  ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { RuntimeError } from "@agent-anything/agent-core/run";

interface ApprovalAuditBaseInput {
  readonly request: ApprovalRequest;
  readonly pendingVersion: number;
  readonly taskId: string;
  readonly workspace: WorkspaceContext;
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
  if (input.port === undefined) {
    return input.requirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable for approval.")
      : null;
  }
  try {
    await recordWithinSignal(
      () => input.port!.record(createAuditRecord({
        id: `${input.request.runId}:audit:approval:${input.request.id}:${phase}`,
        taskId: input.taskId,
        eventName: `approval.${phase}`,
        timestamp: input.timestamp,
        actorRef: input.identity.id,
        workspaceId: input.workspace.id,
        subject: {
          kind: input.identity.kind,
          id: input.identity.id,
          metadata: {},
        },
        action: `approval.${phase}`,
        target: {
          kind: "approval_request",
          id: input.request.id,
          metadata: {
            runId: input.request.runId,
            actionId: input.request.actionId,
            category: input.request.category,
          },
        },
        outcome: "succeeded",
        payload: {
          pendingVersion: input.pendingVersion,
          optionIds: input.request.decisionOptions.map((option) => option.id),
          decisionKind,
        },
        metadata: { source: "runner" },
      }), Object.freeze({
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
