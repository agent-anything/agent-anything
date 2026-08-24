import type { RunOperationSnapshot, RunRetryProjection } from "@agent-anything/agent-runtime/runner";
import type { RetryEvent } from "@agent-anything/agent-runtime/retry";
import type { ActionExecutionNotification } from "@agent-anything/action-execution/enforcement";
import type { InteractionTransportReceipt } from "@agent-anything/interaction/records";
import { projectRuntimeEventForHost } from "./RuntimeEventHostProjection.js";
import {
  snapshotHostCancellation,
  projectHostRunProgress,
  projectHostRunTree,
  type CreateHostRunProjectionStoreInput,
  type HostActionAttemptProjection,
  type HostEnforcementProjection,
  type HostPendingInteractionProjection,
  type HostRetryEventProjection,
  type HostRetryProjection,
  type HostRunProjection,
  type HostRunProjectionReduction,
  type HostRunProjectionRejectionCode,
  type HostRunProjectionStore,
  type HostRunProjectionUpdate,
} from "./HostRunProjection.js";

export function reduceHostRunProjection(
  current: HostRunProjection,
  update: HostRunProjectionUpdate,
): HostRunProjectionReduction {
  if (!Number.isSafeInteger(update.sequence) || update.sequence <= current.sequence) {
    return rejected(current, "stale_sequence");
  }
  if (update.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }
  if (!isDateTime(update.occurredAt)) {
    return rejected(current, "invalid_update");
  }
  if (isTerminal(current.status)) {
    return rejected(current, "invalid_transition");
  }

  try {
    switch (update.kind) {
      case "runtime_event": {
        const event = projectRuntimeEventForHost(update.event);
        if (event.lineage.root.id !== current.runId) {
          return rejected(current, "run_tree_root_mismatch");
        }
        const isRootEvent = event.runId === current.runId &&
          event.lineage.kind === "root";
        if (isRootEvent && event.taskId !== current.taskId) {
          return rejected(current, "run_identity_mismatch");
        }
        return applied(current, update.sequence, isRootEvent &&
            event.name === "run.started" &&
            current.status === "starting"
          ? { status: "running" }
          : {});
      }
      case "run_operation":
        return applyRunOperation(current, update.sequence, update.snapshot);
      case "action_execution":
        return applyActionExecution(current, update.sequence, update.notification);
      case "interaction_submission_accepted":
        return applyInteractionSubmission(current, update.sequence, update.receipt);
      case "cancellation_accepted":
        if (
          current.status !== "starting" &&
          current.status !== "running" &&
          current.status !== "waiting" &&
          current.status !== "cancelling"
        ) {
          return rejected(current, "invalid_transition");
        }
        return applied(current, update.sequence, {
          status: "cancelling",
          cancellation: snapshotHostCancellation(update.cancellation),
        });
      case "terminal_result":
        if (
          update.terminal.runId !== current.runId ||
          update.terminal.taskId !== current.taskId
        ) {
          return rejected(current, "terminal_projection_mismatch");
        }
        return applied(current, update.sequence, {
          status: update.terminal.status,
          pendingInteractions: Object.freeze([]),
          cancellation: update.terminal.cancellation ?? current.cancellation,
          terminal: update.terminal,
        });
    }
  } catch {
    return rejected(current, "invalid_update");
  }
}

export function createHostRunProjectionStore(
  input: CreateHostRunProjectionStoreInput,
): HostRunProjectionStore {
  let projection = input.initial;
  const listeners = new Set<(projection: HostRunProjection) => void>();
  return Object.freeze({
    getProjection: () => projection,
    apply(update: HostRunProjectionUpdate) {
      const result = reduceHostRunProjection(projection, update);
      if (result.status === "rejected") return result;
      projection = result.projection;
      for (const listener of listeners) {
        try {
          listener(projection);
        } catch (error) {
          try {
            input.onListenerFailure?.({
              runId: projection.runId,
              sequence: projection.sequence,
              error,
            });
          } catch {
            // Listener-failure reporting cannot affect projection delivery.
          }
        }
      }
      return result;
    },
    subscribe(listener: (projection: HostRunProjection) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("Host Run projection listener must be a function.");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function applyRunOperation(
  current: HostRunProjection,
  sequence: number,
  snapshot: RunOperationSnapshot,
): HostRunProjectionReduction {
  if (snapshot.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }
  if (snapshot.sequence < current.runOperationSequence) {
    return rejected(current, "run_operation_sequence_regression");
  }
  if (snapshot.runTree.rootRunId !== current.runId) {
    return rejected(current, "run_tree_root_mismatch");
  }
  if (snapshot.runTree.revision < current.runTree.revision) {
    return rejected(current, "run_tree_revision_regression");
  }
  if (snapshot.progress.checkpointSequence < current.progress.checkpointSequence) {
    return rejected(current, "run_progress_checkpoint_regression");
  }
  const pendingInteractions = snapshot.pendingInteractions.map((pending) => {
    const prior = current.pendingInteractions.find((candidate) =>
      sameRequest(candidate.request, pending.envelope.request)
    );
    return Object.freeze({
      request: pending.envelope.request,
      presentation: snapshotUnknown(pending.envelope.presentation),
      disclosureClass: pending.envelope.disclosureClass,
      expiresAt: pending.envelope.expiresAt,
      blockingScope: pending.blockingScope,
      phase: prior?.phase ?? "pending",
    }) satisfies HostPendingInteractionProjection;
  });
  const status = activeStatus(current.status, snapshot.status);
  return applied(current, sequence, {
    runOperationSequence: snapshot.sequence,
    runRevision: snapshot.runRevision,
    runTree: projectHostRunTree(snapshot.runTree),
    status,
    plan: snapshot.plan,
    progress: projectHostRunProgress(snapshot.progress),
    pendingInteractions: Object.freeze(pendingInteractions),
    retry: projectRetry(snapshot.retry),
    validation: snapshot.validation,
  });
}

function applyInteractionSubmission(
  current: HostRunProjection,
  sequence: number,
  receipt: InteractionTransportReceipt,
): HostRunProjectionReduction {
  const index = current.pendingInteractions.findIndex((pending) =>
    sameRequest(pending.request, receipt.request)
  );
  if (index < 0) return rejected(current, "interaction_correlation_mismatch");
  const pendingInteractions = current.pendingInteractions.map((pending, candidateIndex) =>
    candidateIndex === index
      ? Object.freeze({ ...pending, phase: "submitted_for_resolution" as const })
      : pending
  );
  return applied(current, sequence, {
    pendingInteractions: Object.freeze(pendingInteractions),
  });
}

function applyActionExecution(
  current: HostRunProjection,
  sequence: number,
  notification: ActionExecutionNotification,
): HostRunProjectionReduction {
  if (notification.runId !== current.runId) {
    return rejected(current, "run_identity_mismatch");
  }
  if (notification.kind === "attempt_started") {
    const attempt: HostActionAttemptProjection = Object.freeze({
      attemptId: notification.attemptId,
      actionId: notification.actionId,
      ordinal: notification.ordinal,
      enforcement: notification.enforcement,
      outcome: "running",
      code: null,
    });
    return applied(current, sequence, {
      enforcement: Object.freeze({
        ...current.enforcement,
        status: "running",
        attemptCount: current.enforcement.attemptCount + 1,
        latestAttempt: attempt,
      }),
    });
  }
  const latest = current.enforcement.latestAttempt;
  const settledLatest = latest === null || latest.actionId !== notification.actionId
    ? latest
    : Object.freeze({
        ...latest,
        outcome: notification.status,
        code: notification.causeRef,
      });
  return applied(current, sequence, {
    enforcement: Object.freeze({
      ...current.enforcement,
      status: enforcementStatus(notification, current.enforcement),
      latestAttempt: settledLatest,
    }),
  });
}

function enforcementStatus(
  notification: Extract<ActionExecutionNotification, { readonly kind: "settled" }>,
  current: HostEnforcementProjection,
): HostEnforcementProjection["status"] {
  if (notification.status === "unknown_effect") return "unknown_effect";
  if (notification.status === "denied") return "denied";
  if (notification.status === "cancelled" || notification.status === "timed_out") {
    return "interrupted";
  }
  if (
    notification.attemptCount === 0 &&
    notification.causeOwner === "sandbox" &&
    notification.causeRef?.includes("unavailable")
  ) return "unavailable";
  if (notification.status === "succeeded" || notification.status === "partial") {
    return notification.enforcement === "disabled" ? "unisolated" : "enforced";
  }
  return current.status === "not_exercised" && notification.attemptCount === 0
    ? "not_exercised"
    : "failed";
}

function projectRetry(input: RunRetryProjection | null): HostRetryProjection | null {
  if (input === null) return null;
  return Object.freeze({
    attemptCount: input.attemptCount,
    scheduledCount: input.scheduledCount,
    fallbackCount: input.fallbackCount,
    exhaustedCount: input.exhaustedCount,
    cancellationCount: input.cancellationCount,
    omittedEventCount: input.omittedEventCount,
    recentEvents: Object.freeze(input.recentEvents.map(projectRetryEvent)),
  });
}

function projectRetryEvent(event: RetryEvent): HostRetryEventProjection {
  const base = {
    event: event.type,
    operationId: event.operationId,
    owner: event.owner,
    occurredAt: event.occurredAt,
  } as const;
  switch (event.type) {
    case "retry_scheduled":
      return Object.freeze({
        ...base,
        attemptNumber: event.nextAttemptNumber,
        delayMs: event.delayMs,
        outcome: "retry_scheduled",
        code: event.failureCode,
      });
    case "retry_attempt_started":
      return Object.freeze({
        ...base,
        attemptNumber: event.attemptNumber,
        delayMs: null,
        outcome: null,
        code: null,
      });
    case "retry_attempt_finished":
      return Object.freeze({
        ...base,
        attemptNumber: event.attemptNumber,
        delayMs: null,
        outcome: event.outcome,
        code: event.failureCode ?? null,
      });
    case "retry_fallback_selected":
      return Object.freeze({
        ...base,
        attemptNumber: event.nextAttemptNumber,
        delayMs: null,
        outcome: "fallback_selected",
        code: event.reasonCode,
      });
    case "retry_exhausted":
      return Object.freeze({
        ...base,
        attemptNumber: event.totalAttempts,
        delayMs: event.totalRetryDelayMs,
        outcome: event.reason,
        code: event.lastFailureCode,
      });
    case "retry_cancelled":
      return Object.freeze({
        ...base,
        attemptNumber: event.attemptNumber,
        delayMs: null,
        outcome: event.phase,
        code: "cancelled",
      });
  }
}

function activeStatus(
  current: HostRunProjection["status"],
  runtime: RunOperationSnapshot["status"],
): HostRunProjection["status"] {
  if (current === "cancelling") return current;
  switch (runtime) {
    case "initializing": return current;
    case "running": return "running";
    case "waiting": return "waiting";
    case "cancelling": return "cancelling";
    case "succeeded":
    case "blocked":
    case "failed":
    case "cancelled":
      return current;
  }
}

function applied(
  current: HostRunProjection,
  sequence: number,
  changes: Partial<HostRunProjection>,
): HostRunProjectionReduction {
  return Object.freeze({
    status: "applied" as const,
    projection: Object.freeze({ ...current, ...changes, sequence }),
  });
}

function rejected(
  current: HostRunProjection,
  code: HostRunProjectionRejectionCode,
): HostRunProjectionReduction {
  return Object.freeze({ status: "rejected" as const, code, projection: current });
}

function sameRequest(
  left: HostPendingInteractionProjection["request"],
  right: HostPendingInteractionProjection["request"],
): boolean {
  return left.id === right.id &&
    left.requestVersion === right.requestVersion &&
    left.protocol.owner === right.protocol.owner &&
    left.protocol.kind === right.protocol.kind &&
    left.protocol.revision === right.protocol.revision &&
    left.subject.owner === right.subject.owner &&
    left.subject.kind === right.subject.kind &&
    left.subject.id === right.subject.id &&
    left.subject.revision === right.subject.revision;
}

function snapshotUnknown<T>(input: T): T {
  return deepFreeze(structuredClone(input));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isTerminal(status: HostRunProjection["status"]): boolean {
  return status === "completed" || status === "blocked" ||
    status === "failed" || status === "cancelled";
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
