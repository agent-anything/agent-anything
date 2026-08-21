import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  InteractionExecution,
  type CapturedInteractionProtocol,
  type InteractionAppliedOutcome,
  type InteractionProtocolRegistrySnapshot,
  type InteractionSubmissionInput,
  type InteractionSubmissionOutcome,
  type PendingInteractionRef,
} from "@agent-anything/interaction/coordination";
import type {
  InteractionProtocolRef,
  InteractionRequest,
  InteractionRequestRef,
  SafeInteractionEnvelope,
  InteractionSubjectRef,
} from "@agent-anything/interaction/protocol";
import { snapshotSafeInteractionEnvelope } from "@agent-anything/interaction/protocol";
import type { InteractionTerminalRecord } from "@agent-anything/interaction/records";
import type { OperationCorrelation } from "@agent-anything/operation-catalog/identity";

export type RuntimeInteractionSettlement =
  | {
      readonly status: "resolved";
      readonly outcome: InteractionAppliedOutcome;
      readonly resolutionValue: unknown;
      readonly applicationValue: unknown;
    }
  | {
      readonly status: "expired" | "cancelled" | "invalidated" | "failed";
      readonly request: InteractionRequestRef;
      readonly owner: string;
      readonly code: string;
    };

export interface OpenRuntimeInteractionInput {
  readonly requestId: string;
  readonly protocol: InteractionProtocolRef;
  readonly subject: unknown;
  readonly subjectRef: InteractionSubjectRef;
  readonly correlation: OperationCorrelation;
  readonly parentRunAction: RunActionRef | null;
  readonly presentation: unknown;
  readonly requestVersion: number;
  readonly expiresAt: string | null;
  readonly blockingScope: PendingInteractionRef["blockingScope"];
  readonly createdAt: string;
}

export type OpenRuntimeInteractionResult =
  | {
      readonly status: "opened";
      readonly pending: PendingInteractionRef;
      readonly envelope: SafeInteractionEnvelope<unknown>;
      readonly completion: Promise<RuntimeInteractionSettlement>;
    }
  | {
      readonly status: "unavailable" | "invalid";
      readonly owner: string;
      readonly code: string;
      readonly message: string;
    };

interface ActiveInteraction {
  readonly protocol: CapturedInteractionProtocol;
  readonly request: InteractionRequest<string, unknown, unknown>;
  readonly execution: InteractionExecution;
  readonly pending: PendingInteractionRef;
  readonly envelope: SafeInteractionEnvelope<unknown>;
  readonly resolveCompletion: (settlement: RuntimeInteractionSettlement) => void;
  readonly completion: Promise<RuntimeInteractionSettlement>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

type NonResolvedInteractionTransition =
  | {
      readonly status: "expired";
      readonly code: "interaction_expired";
      readonly expiredAt: string;
    }
  | {
      readonly status: "cancelled";
      readonly code: "interaction_cancelled";
      readonly cancellationId: string;
    }
  | {
      readonly status: "invalidated";
      readonly code: string;
    };

export interface RunInteractionCoordinatorDependencies {
  readonly runId: string;
  readonly registry: InteractionProtocolRegistrySnapshot;
  readonly localProtocols?: readonly CapturedInteractionProtocol[];
  readonly now: () => string;
  readonly createId: (kind: "interaction_submission_receipt" | "interaction_resolution" | "interaction_application", sequence: number) => string;
  readonly onOpened: (pending: PendingInteractionRef) => void;
  readonly onSettled: (
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ) => void;
}

/** Coordinates common Interaction lifecycle without owning semantic meaning or RunState. */
export class RunInteractionCoordinator {
  private readonly active = new Map<string, ActiveInteraction>();
  private nextReceipt = 1;
  private nextResolution = 1;
  private nextApplication = 1;
  private settled = false;

  constructor(private readonly dependencies: RunInteractionCoordinatorDependencies) {
    const seen = new Set<string>();
    for (const protocol of dependencies.localProtocols ?? []) {
      const key = protocolKey(protocol.ref);
      if (seen.has(key) || dependencies.registry.find(protocol.ref) !== undefined) {
        throw new TypeError(`Interaction protocol '${key}' is registered more than once.`);
      }
      seen.add(key);
    }
  }

  open(input: OpenRuntimeInteractionInput): OpenRuntimeInteractionResult {
    if (this.settled) {
      return unavailable("interaction_run_settled", "The Run no longer accepts interactions.");
    }
    const protocol = this.resolveProtocol(input.protocol);
    if (protocol === undefined) {
      return unavailable("interaction_protocol_unavailable", "The Interaction protocol revision is not registered.");
    }
    try {
      const request = protocol.createRequest({
        requestId: input.requestId,
        requestVersion: input.requestVersion,
        subject: input.subject,
        subjectRef: input.subjectRef,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      });
      const key = requestKey(request.ref);
      if (this.active.has(key)) {
        return invalid("interaction_request_duplicate", "The exact Interaction request is already pending.");
      }
      const execution = InteractionExecution.create({
        request: request.ref,
        blockingScope: input.blockingScope,
      });
      let resolveCompletion!: (settlement: RuntimeInteractionSettlement) => void;
      const completion = new Promise<RuntimeInteractionSettlement>((resolve) => {
        resolveCompletion = resolve;
      });
      const pending = execution.getSnapshot().pending;
      const envelope = snapshotSafeInteractionEnvelope({
        request: request.ref,
        presentation: request.presentation,
        disclosureClass: "internal",
        expiresAt: request.expiresAt,
      }, snapshotUnknown);
      const active: ActiveInteraction = {
        protocol,
        request,
        execution,
        pending,
        envelope,
        resolveCompletion,
        completion,
        expiryTimer: null,
      };
      this.active.set(key, active);
      if (input.expiresAt !== null) {
        const delay = Math.max(0, Date.parse(input.expiresAt) - Date.parse(this.dependencies.now()));
        active.expiryTimer = setTimeout(() => {
          this.settleNonResolved(active, {
            status: "expired",
            code: "interaction_expired",
            expiredAt: input.expiresAt!,
          });
        }, Math.min(delay, 2_147_483_647));
      }
      this.dependencies.onOpened(pending);
      return Object.freeze({ status: "opened" as const, pending, envelope, completion });
    } catch (error) {
      return invalid(
        "interaction_request_invalid",
        error instanceof Error ? error.message : "The Interaction request is invalid.",
      );
    }
  }

  submit(input: InteractionSubmissionInput): InteractionSubmissionOutcome {
    if (this.settled) {
      return Object.freeze({ status: "rejected", code: "run_settled", receipt: null });
    }
    const active = this.active.get(requestKey(input.request));
    if (active === undefined) {
      if ([...this.active.values()].some((candidate) =>
        logicalRequestKey(candidate.pending.request) === logicalRequestKey(input.request)
      )) {
        return Object.freeze({ status: "rejected", code: "interaction_version_stale", receipt: null });
      }
      return Object.freeze({ status: "rejected", code: "interaction_not_pending", receipt: null });
    }
    const snapshot = active.execution.getSnapshot();
    const commit = active.execution.recordSubmission({
      expectedRevision: snapshot.revision,
      submissionId: input.submissionId,
      contentDigest: input.contentDigest,
      receiptId: this.dependencies.createId("interaction_submission_receipt", this.nextReceipt++),
      recordedAt: input.receivedAt,
    });
    if (commit.status === "rejected") {
      const code = commit.code === "stale_revision"
        ? "interaction_version_stale"
        : commit.code === "duplicate_conflict"
          ? "interaction_submission_conflict"
          : "interaction_not_pending";
      return Object.freeze({ status: "rejected", code, receipt: commit.receipt });
    }
    if (commit.status === "accepted") {
      queueMicrotask(() => this.resolveSubmission(active, input));
    }
    return Object.freeze({
      status: commit.status === "accepted" ? "accepted_for_resolution" : "duplicate_identical",
      receipt: commit.receipt,
    });
  }

  cancelAll(cancellationId: string): void {
    for (const active of [...this.active.values()]) {
      this.settleNonResolved(active, {
        status: "cancelled",
        code: "interaction_cancelled",
        cancellationId,
      });
    }
  }

  fail(request: InteractionRequestRef, owner: string, failureRef: string): boolean {
    const active = this.active.get(requestKey(request));
    if (active === undefined) return false;
    const settlement: RuntimeInteractionSettlement = Object.freeze({
      status: "failed" as const,
      request,
      owner,
      code: failureRef,
    });
    this.commitTerminal(active, Object.freeze({
      kind: "failed" as const,
      request,
      owner,
      failureRef,
    }), settlement);
    return true;
  }

  invalidate(request: InteractionRequestRef, reasonCode: string): boolean {
    const active = this.active.get(requestKey(request));
    if (active === undefined) return false;
    this.settleNonResolved(active, {
      status: "invalidated",
      code: reasonCode,
    });
    return true;
  }

  invalidateAll(reasonCode: string): void {
    for (const active of [...this.active.values()]) {
      this.settleNonResolved(active, {
        status: "invalidated",
        code: reasonCode,
      });
    }
  }

  getPendingProjections(): readonly {
    readonly envelope: SafeInteractionEnvelope<unknown>;
    readonly blockingScope: PendingInteractionRef["blockingScope"];
  }[] {
    return Object.freeze([...this.active.values()].map((active) => Object.freeze({
      envelope: active.envelope,
      blockingScope: active.pending.blockingScope,
    })));
  }

  close(reasonCode = "run_settled"): void {
    if (this.settled) return;
    for (const active of [...this.active.values()]) {
      this.settleNonResolved(active, {
        status: "invalidated",
        code: reasonCode,
      });
    }
    this.settled = true;
  }

  private resolveProtocol(ref: InteractionProtocolRef): CapturedInteractionProtocol | undefined {
    const key = protocolKey(ref);
    return (this.dependencies.localProtocols ?? []).find(
      (protocol) => protocolKey(protocol.ref) === key,
    ) ?? this.dependencies.registry.find(ref);
  }

  private async resolveSubmission(active: ActiveInteraction, input: InteractionSubmissionInput): Promise<void> {
    if (!this.active.has(requestKey(input.request))) return;
    try {
      const submission = active.protocol.validateSubmission(active.request, input.payload);
      const resolutionValue = active.protocol.resolve({
        request: active.request,
        submissionId: input.submissionId,
        submission,
        receivedAt: input.receivedAt,
      });
      const resolvedAt = this.dependencies.now();
      const resolution = Object.freeze({
        request: input.request,
        resolutionId: this.dependencies.createId("interaction_resolution", this.nextResolution++),
        resolutionRevision: String(input.request.requestVersion),
      });
      const applicationValue = await active.protocol.apply({
        request: active.request,
        resolution: resolutionValue,
        resolvedAt,
      });
      const application = Object.freeze({
        resolution,
        owner: input.request.protocol.owner,
        applicationId: this.dependencies.createId("interaction_application", this.nextApplication++),
      });
      const outcome: InteractionAppliedOutcome = Object.freeze({
        request: input.request,
        resolution,
        application,
        value: applicationValue,
      });
      const settlement: RuntimeInteractionSettlement = Object.freeze({
        status: "resolved" as const,
        outcome,
        resolutionValue,
        applicationValue,
      });
      this.commitTerminal(active, Object.freeze({
        kind: "resolved" as const,
        request: input.request,
        resolution,
      }), settlement);
    } catch {
      const failureId = this.dependencies.createId("interaction_resolution", this.nextResolution++);
      const settlement: RuntimeInteractionSettlement = Object.freeze({
        status: "failed" as const,
        request: input.request,
        owner: input.request.protocol.owner,
        code: "interaction_submission_invalid",
      });
      this.commitTerminal(active, Object.freeze({
        kind: "failed" as const,
        request: input.request,
        owner: input.request.protocol.owner,
        failureRef: failureId,
      }), settlement);
    }
  }

  private settleNonResolved(
    active: ActiveInteraction,
    transition: NonResolvedInteractionTransition,
  ): void {
    if (!this.active.has(requestKey(active.pending.request))) return;
    const request = active.pending.request;
    const terminal: InteractionTerminalRecord = transition.status === "expired"
      ? Object.freeze({ kind: "expired", request, expiredAt: transition.expiredAt })
      : transition.status === "cancelled"
        ? Object.freeze({ kind: "cancelled", request, cancellationId: transition.cancellationId })
        : Object.freeze({ kind: "invalidated", request, reasonCode: transition.code });
    this.commitTerminal(active, terminal, Object.freeze({
      status: transition.status,
      request,
      owner: request.protocol.owner,
      code: transition.code,
    }));
  }

  private commitTerminal(
    active: ActiveInteraction,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): void {
    const commit = active.execution.settle({
      expectedRevision: active.execution.getSnapshot().revision,
      terminal,
    });
    if (commit.status === "rejected") return;
    const key = requestKey(active.pending.request);
    this.active.delete(key);
    if (active.expiryTimer !== null) clearTimeout(active.expiryTimer);
    this.dependencies.onSettled(active.pending, terminal, settlement);
    active.resolveCompletion(settlement);
  }
}

function requestKey(input: InteractionRequestRef): string {
  return [
    input.protocol.owner,
    input.protocol.kind,
    input.protocol.revision,
    input.id,
    input.requestVersion,
    input.subject.owner,
    input.subject.kind,
    input.subject.id,
    input.subject.revision,
  ].join(":");
}

function logicalRequestKey(input: InteractionRequestRef): string {
  return [input.protocol.owner, input.protocol.kind, input.protocol.revision,
    input.id, input.subject.owner, input.subject.kind, input.subject.id,
    input.subject.revision].join(":");
}

function protocolKey(input: InteractionProtocolRef): string {
  return `${input.owner}:${input.kind}@${input.revision}`;
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

function unavailable(code: string, message: string): OpenRuntimeInteractionResult {
  return Object.freeze({ status: "unavailable", owner: "interaction", code, message });
}

function invalid(code: string, message: string): OpenRuntimeInteractionResult {
  return Object.freeze({ status: "invalid", owner: "interaction", code, message });
}
