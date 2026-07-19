import {
  createAuditRecord,
  type AuditPort,
} from "@agent-anything/observability";
import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { ActionDispatchPlan } from "../action-execution/index.js";
import type { RunInfrastructureRequirement } from "./RunConfig.js";
import type { RuntimeError } from "../run/RuntimeError.js";

export async function recordActionDispatchAuthorizationAudit(input: {
  readonly plan: ActionDispatchPlan;
  readonly taskId: string;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly timestamp: ISODateTimeString;
  readonly requirement: RunInfrastructureRequirement;
  readonly signal: AbortSignal;
  readonly port?: AuditPort;
}): Promise<RuntimeError | null> {
  if (input.signal.aborted) throw input.signal.reason;
  if (input.port === undefined) {
    return input.requirement === "required"
      ? requiredAuditError("Required AuditPort is unavailable before Action dispatch.")
      : null;
  }
  try {
    await recordWithinSignal(
      () => input.port!.record(createAuditRecord({
        id: `${input.plan.runId}:audit:action:${input.plan.actionId}:${input.plan.attemptOrdinal}:authorized`,
        taskId: input.taskId,
        eventName: "action.dispatch_authorized",
        timestamp: input.timestamp,
        actorRef: input.identity.id,
        workspaceId: input.workspace.id,
        subject: {
          kind: input.identity.kind,
          id: input.identity.id,
          metadata: {},
        },
        action: "action.dispatch_authorized",
        target: {
          kind: "action",
          id: input.plan.actionId,
          metadata: {
            runId: input.plan.runId,
            actionName: input.plan.actionName,
            actionFingerprint: input.plan.actionFingerprint,
          },
        },
        outcome: "succeeded",
        payload: {
          authoritySnapshotId: input.plan.authoritySnapshotId,
          actionCoverageId: input.plan.actionCoverageIdToConsume,
          enforcement: input.plan.enforcement,
          attemptOrdinal: input.plan.attemptOrdinal,
          dispatchPlanFingerprint: input.plan.dispatchPlanFingerprint,
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
    if (input.signal.aborted) throw input.signal.reason;
    return input.requirement === "required"
      ? requiredAuditError(
          "Required Action dispatch authorization Audit failed.",
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

function requiredAuditError(
  message: string,
  causeName: string | null = null,
): RuntimeError {
  return Object.freeze({
    owner: "audit" as const,
    code: "audit_required_failed",
    message,
    retryable: false,
    metadata: Object.freeze(causeName === null ? {} : { causeName }),
  });
}
