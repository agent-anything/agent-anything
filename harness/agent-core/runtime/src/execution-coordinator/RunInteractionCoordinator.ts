import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { RunCommitError } from "./RunCommitPort.js";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import {
  InteractionExecution,
  type CapturedInteractionProtocol,
  type InteractionAppliedOutcome,
  type InteractionProtocolRegistrySnapshot,
  type InteractionSubmissionInput,
  type InteractionSubmissionOutcome,
  type PendingInteractionRef,
  type InteractionExecutionSnapshot,
} from "@agent-anything/interaction/coordination";
import type {
  InteractionProtocolRef,
  InteractionRequest,
  InteractionRequestRef,
  SafeInteractionEnvelope,
  InteractionSubjectRef,
} from "@agent-anything/interaction/protocol";
import { snapshotSafeInteractionEnvelope, snapshotInteractionRequest } from "@agent-anything/interaction/protocol";
import type { InteractionTerminalRecord } from "@agent-anything/interaction/records";
import type { OperationCorrelation } from "@agent-anything/operation-catalog/identity";
import { ExecutionFlowPath, type ExecutionFlowContext, type ExecutionFlowStep } from "@agent-anything/observability/execution-flow";
import { INTERACTION_EXECUTION_FLOW } from "./InteractionExecutionFlow.js";

export interface RetainedRunInteraction {
  readonly request: InteractionRequest<string, unknown, unknown>;
  readonly execution: InteractionExecutionSnapshot;
  readonly submission: InteractionSubmissionInput | null;
  readonly resolution: null | {
    readonly ref: InteractionAppliedOutcome["resolution"];
    readonly value: unknown;
    readonly resolvedAt: string;
  };
  readonly applicationStarted: boolean;
  readonly application: InteractionAppliedOutcome["application"] | null;
  readonly outcome: InteractionAppliedOutcome | null;
  readonly settlement: RuntimeInteractionSettlement | null;
}

export interface RunInteractionCheckpoint {
  readonly runId: string;
  readonly revision: number;
  readonly nextReceipt: number;
  readonly nextResolution: number;
  readonly nextApplication: number;
  readonly closed: boolean;
  readonly records: readonly RetainedRunInteraction[];
}

export type RuntimeInteractionSettlement =
  | {
      readonly status: "resolved";
      readonly outcome: InteractionAppliedOutcome;
      readonly contentDigest: string;
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
  readonly executionFlow?: ExecutionFlowContext;
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
  readonly flow: ExecutionFlowPath;
  readonly submissionStep: ExecutionFlowStep;
  readonly protocol: CapturedInteractionProtocol;
  readonly request: InteractionRequest<string, unknown, unknown>;
  readonly execution: InteractionExecution;
  readonly pending: PendingInteractionRef;
  readonly envelope: SafeInteractionEnvelope<unknown>;
  readonly resolveCompletion: (settlement: RuntimeInteractionSettlement) => void;
  readonly rejectCompletion: (error: unknown) => void;
  readonly completion: Promise<RuntimeInteractionSettlement>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  submissionObserved: boolean;
  submission: InteractionSubmissionInput | null;
  resolution: RetainedRunInteraction["resolution"];
  applicationStarted: boolean;
  application: InteractionAppliedOutcome["application"] | null;
  outcome: InteractionAppliedOutcome | null;
  settlement: RuntimeInteractionSettlement | null;
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
  readonly onOpened: (pending: PendingInteractionRef, parentRunAction: RunActionRef | null) => void | Promise<void>;
  readonly onSettled: (
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ) => void;
  readonly onChanged?: () => Promise<void>;
  readonly onFailure?: (error: RunCommitError) => void;
}

export interface RunInteractionAvailabilitySnapshot {
  readonly registrySnapshotId: string;
  readonly revision: number;
  readonly activeCount: number;
  readonly maximumPending: number;
  readonly protocolAvailable: boolean;
  readonly hasCapacity: boolean;
  readonly settled: boolean;
}

/** Coordinates common Interaction lifecycle without owning semantic meaning or RunState. */
export class RunInteractionCoordinator {
  private readonly active = new Map<string, ActiveInteraction>();
  private readonly records = new Map<string, ActiveInteraction>();
  private tail: Promise<unknown> = Promise.resolve();
  private failure: RunCommitError | null = null;
  private activated = true;
  private nextReceipt = 1;
  private nextResolution = 1;
  private nextApplication = 1;
  private settled = false;
  private revision = 0;

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

  async open(input: OpenRuntimeInteractionInput): Promise<OpenRuntimeInteractionResult> {
    this.assertAvailable();
    if (!this.activated) throw new TypeError("Interaction coordinator must be activated before opening requests.");
    const flow = new ExecutionFlowPath(INTERACTION_EXECUTION_FLOW, input.executionFlow ?? {}, this.dependencies.runId,
      []);
    const step = flow.advance("open", {protocolOwner: input.protocol.owner, protocolKind: input.protocol.kind},
      [flow.material("Interaction opening input", "received", {requestId: input.requestId, protocol: input.protocol, subject: input.subject, subjectRef: input.subjectRef,
        correlation: input.correlation, presentation: input.presentation, requestVersion: input.requestVersion, expiresAt: input.expiresAt, blockingScope: input.blockingScope})]);
    const reject = (result: OpenRuntimeInteractionResult): OpenRuntimeInteractionResult => {
      const settlement = flow.advance("settle", {status: result.status});
      settlement.check("terminal_commit", "not_applicable", {reason: "request_not_opened"});
      settlement.output(flow.material("Interaction opening result", "rejected", result));
      flow.close("returned");
      return result;
    };
    step.check("run_open", this.settled ? "not_satisfied" : "passed");
    if (this.settled) {
      step.check("protocol", "not_evaluated", {reason: "run_settled"});
      step.check("unique_request", "not_evaluated", {reason: "run_settled"});
      return reject(unavailable("interaction_run_settled", "The Run no longer accepts interactions."));
    }
    const protocol = this.resolveProtocol(input.protocol);
    step.check("protocol", protocol === undefined ? "not_satisfied" : "passed");
    if (protocol === undefined) {
      step.check("unique_request", "not_evaluated", {reason: "protocol_unavailable"});
      return reject(unavailable("interaction_protocol_unavailable", "The Interaction protocol revision is not registered."));
    }
    let uniquenessChecked = false;
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
      step.check("unique_request", this.records.has(key) ? "not_satisfied" : "passed");
      uniquenessChecked = true;
      if (this.records.has(key)) {
        return reject(invalid("interaction_request_duplicate", "The exact Interaction request already exists."));
      }
      const execution = InteractionExecution.create({
        request: request.ref,
        blockingScope: input.blockingScope,
      });
      let resolveCompletion!: (settlement: RuntimeInteractionSettlement) => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<RuntimeInteractionSettlement>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => {});
      const pending = execution.getSnapshot().pending;
      const envelope = snapshotSafeInteractionEnvelope({
        request: request.ref,
        presentation: request.presentation,
        disclosureClass: "internal",
        expiresAt: request.expiresAt,
      }, snapshotUnknown);
      const active: ActiveInteraction = {
        flow,
        submissionStep: flow.advance("wait", {blockingScope: input.blockingScope, expiresAt: input.expiresAt}, [flow.material("Opened Interaction request", "opened", request)]),
        protocol,
        request,
        execution,
        pending,
        envelope,
        resolveCompletion,
        rejectCompletion,
        completion,
        expiryTimer: null,
        submissionObserved: false,
        submission: null, resolution: null, applicationStarted: false, application: null, outcome: null, settlement: null,
      };
      this.active.set(key, active);
      this.records.set(key, active);
      this.revision += 1;
      try { await this.dependencies.onOpened(pending, input.parentRunAction); }
      catch (error) { throw this.failPersistence(error); }
      this.armExpiry(active);
      return Object.freeze({ status: "opened" as const, pending, envelope, completion });
    } catch (error) {
      if (error instanceof RunCommitError) throw error;
      if (!uniquenessChecked) step.check("unique_request", "not_evaluated", {reason: "request_creation_failed"});
      return reject(invalid(
        "interaction_request_invalid",
        error instanceof Error ? error.message : "The Interaction request is invalid.",
      ));
    }
  }

  submit(input: InteractionSubmissionInput): Promise<InteractionSubmissionOutcome> {
    return this.serialize(async () => {
      if (!this.activated) throw new TypeError("Interaction coordinator must be activated before accepting submissions.");
      const result = this.acceptSubmission(snapshotUnknown(input));
      if (result.receipt !== null) await this.save();
      if (result.status === "accepted_for_resolution") {
        const active = this.active.get(requestKey(input.request))!;
        queueMicrotask(() => { void this.resolveSubmission(active, active.submission!).catch(error => this.failPersistence(error)); });
      }
      return result;
    });
  }

  private acceptSubmission(input: InteractionSubmissionInput): InteractionSubmissionOutcome {
    if (this.settled) {
      return Object.freeze({ status: "rejected", code: "run_settled", receipt: null });
    }
    const active = this.records.get(requestKey(input.request));
    if (active === undefined) {
      if ([...this.active.values()].some((candidate) =>
        logicalRequestKey(candidate.pending.request) === logicalRequestKey(input.request)
      )) {
        return Object.freeze({ status: "rejected", code: "interaction_version_stale", receipt: null });
      }
      return Object.freeze({ status: "rejected", code: "interaction_not_pending", receipt: null });
    }
    if (active.submission !== null) {
      if (active.submission.submissionId !== input.submissionId) {
        return {status: "rejected", code: "interaction_not_pending", receipt: null};
      }
      const receipt = active.execution.getSnapshot().receipts.find(value => value.submissionId === input.submissionId && value.status === "accepted_for_resolution")!;
      return active.submission.contentDigest === input.contentDigest && samePayload(active.submission.payload, input.payload)
        ? {status: "duplicate_identical", receipt}
        : {status: "rejected", code: "interaction_submission_conflict", receipt};
    }
    if (!this.active.has(requestKey(input.request))) return {status: "rejected", code: "interaction_not_pending", receipt: null};
    const snapshot = active.execution.getSnapshot();
    const commit = active.execution.recordSubmission({
      expectedRevision: snapshot.revision,
      submissionId: input.submissionId,
      contentDigest: input.contentDigest,
      receiptId: this.dependencies.createId("interaction_submission_receipt", this.nextReceipt++),
      recordedAt: input.receivedAt,
    });
    active.submissionStep.check("submission_receipt", commit.status === "rejected" ? "not_satisfied" : "passed",
      {status: commit.status, submissionId: input.submissionId});
    active.submissionObserved = true;
    active.submissionStep.output(active.flow.material("Interaction submission receipt", "recorded", {submission: input, commit}));
    if (commit.status === "rejected") {
      const code = commit.code === "stale_revision"
        ? "interaction_version_stale"
        : commit.code === "duplicate_conflict"
          ? "interaction_submission_conflict"
          : "interaction_not_pending";
      return Object.freeze({ status: "rejected", code, receipt: commit.receipt });
    }
    if (commit.status === "accepted") {
      active.submission = input;
    }
    return Object.freeze({
      status: commit.status === "accepted" ? "accepted_for_resolution" : "duplicate_identical",
      receipt: commit.receipt,
    });
  }

  async cancelAll(cancellationId: string): Promise<void> {
    for (const active of [...this.active.values()]) {
      await this.settleNonResolved(active, {
        status: "cancelled",
        code: "interaction_cancelled",
        cancellationId,
      });
    }
  }

  async fail(request: InteractionRequestRef, owner: string, failureRef: string): Promise<boolean> {
    const active = this.active.get(requestKey(request));
    if (active === undefined) return false;
    const settlement: RuntimeInteractionSettlement = Object.freeze({
      status: "failed" as const,
      request,
      owner,
      code: failureRef,
    });
    await this.commitTerminal(active, Object.freeze({
      kind: "failed" as const,
      request,
      owner,
      failureRef,
    }), settlement);
    return true;
  }

  async invalidate(request: InteractionRequestRef, reasonCode: string): Promise<boolean> {
    const active = this.active.get(requestKey(request));
    if (active === undefined) return false;
    await this.settleNonResolved(active, {
      status: "invalidated",
      code: reasonCode,
    });
    return true;
  }

  async invalidateAll(reasonCode: string): Promise<void> {
    for (const active of [...this.active.values()]) {
      await this.settleNonResolved(active, {
        status: "invalidated",
        code: reasonCode,
      });
    }
  }

  getPendingProjections(): readonly {
    readonly runId: string;
    readonly envelope: SafeInteractionEnvelope<unknown>;
    readonly blockingScope: PendingInteractionRef["blockingScope"];
  }[] {
    return Object.freeze([...this.active.values()].map((active) => Object.freeze({
      runId: this.dependencies.runId,
      envelope: active.envelope,
      blockingScope: active.pending.blockingScope,
    })));
  }

  getAvailabilitySnapshot(
    protocol: InteractionProtocolRef,
    maximumPending: number,
  ): RunInteractionAvailabilitySnapshot {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 0) {
      throw new TypeError("Interaction pending capacity must be a non-negative integer.");
    }
    const protocolAvailable = this.resolveProtocol(protocol) !== undefined;
    return Object.freeze({
      registrySnapshotId: this.dependencies.registry.snapshotId,
      revision: this.revision,
      activeCount: this.active.size,
      maximumPending,
      protocolAvailable,
      hasCapacity: this.active.size < maximumPending,
      settled: this.settled,
    });
  }

  async close(reasonCode = "run_settled"): Promise<void> {
    if (this.settled) return;
    for (const active of [...this.active.values()]) {
      await this.settleNonResolved(active, {
        status: "invalidated",
        code: reasonCode,
      });
    }
    this.settled = true;
    await this.save();
  }

  /** Releases timers only; disposal is not a lifecycle transition. */
  dispose(): void {
    for (const record of this.records.values()) {
      if (record.expiryTimer !== null) clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
    }
  }

  settledRecords(): readonly RetainedRunInteraction[] {
    return this.checkpoint().records.filter(record => record.settlement !== null);
  }

  checkpoint(): RunInteractionCheckpoint {
    return snapshotUnknown({runId: this.dependencies.runId, revision: this.revision,
      nextReceipt: this.nextReceipt, nextResolution: this.nextResolution, nextApplication: this.nextApplication,
      closed: this.settled, records: [...this.records.values()].map(active => ({
        request: active.request, execution: active.execution.getSnapshot(), submission: active.submission,
        resolution: active.resolution, applicationStarted: active.applicationStarted, application: active.application,
        outcome: active.outcome, settlement: active.settlement,
      }))});
  }

  /** Loading reconstructs promises and bindings; activation is an explicit later operation. */
  static restore(dependencies: RunInteractionCoordinatorDependencies, checkpoint: RunInteractionCheckpoint): RunInteractionCoordinator {
    if (checkpoint.runId !== dependencies.runId || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0 ||
        [checkpoint.nextReceipt, checkpoint.nextResolution, checkpoint.nextApplication].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError("Interaction coordinator checkpoint is invalid.");
    }
    const coordinator = new RunInteractionCoordinator(dependencies);
    coordinator.activated = false;
    coordinator.revision = checkpoint.revision;
    coordinator.nextReceipt = checkpoint.nextReceipt;
    coordinator.nextResolution = checkpoint.nextResolution;
    coordinator.nextApplication = checkpoint.nextApplication;
    coordinator.settled = checkpoint.closed;
    for (const saved of checkpoint.records) {
      const request = snapshotInteractionRequest(saved.request, snapshotUnknown, snapshotUnknown);
      const key = requestKey(request.ref);
      const protocol = coordinator.resolveProtocol(request.ref.protocol);
      if (!protocol || coordinator.records.has(key)) throw new TypeError("Retained Interaction protocol or identity is unavailable.");
      const execution = InteractionExecution.restore(saved.execution);
      if (requestKey(saved.execution.pending.request) !== key ||
          (saved.submission !== null && (requestKey(saved.submission.request) !== key ||
            !saved.execution.submissions.some(value => value.submissionId === saved.submission!.submissionId && value.contentDigest === saved.submission!.contentDigest))) ||
          (saved.resolution !== null && (!saved.submission || requestKey(saved.resolution.ref.request) !== key)) ||
          saved.applicationStarted !== (saved.application !== null) ||
          (saved.application !== null && (!saved.resolution || saved.application.resolution.resolutionId !== saved.resolution.ref.resolutionId)) ||
          (saved.outcome !== null && (!saved.application || saved.outcome.application?.applicationId !== saved.application.applicationId)) ||
          (saved.settlement === null) !== (saved.execution.terminal === null) ||
          (checkpoint.closed && saved.execution.terminal === null)) {
        throw new TypeError("Interaction checkpoint relationships are inconsistent.");
      }
      let resolveCompletion!: ActiveInteraction["resolveCompletion"];
      let rejectCompletion!: ActiveInteraction["rejectCompletion"];
      const completion = new Promise<RuntimeInteractionSettlement>((resolve, reject) => {resolveCompletion = resolve; rejectCompletion = reject;});
      void completion.catch(() => {});
      const flow = new ExecutionFlowPath(INTERACTION_EXECUTION_FLOW, {}, dependencies.runId);
      flow.advance("open", {recovered: true, requestId: request.ref.id});
      const active: ActiveInteraction = {
        ...structuredClone(saved), request, execution, protocol, flow,
        submissionStep: flow.advance("wait", {recovered: true}),
        pending: execution.getSnapshot().pending,
        envelope: snapshotSafeInteractionEnvelope({request: request.ref, presentation: request.presentation,
          disclosureClass: "internal", expiresAt: request.expiresAt}, snapshotUnknown),
        resolveCompletion, rejectCompletion, completion, expiryTimer: null, submissionObserved: saved.submission !== null,
      };
      coordinator.records.set(key, active);
      if (saved.settlement === null) coordinator.active.set(key, active);
      else resolveCompletion(saved.settlement);
    }
    return coordinator;
  }

  getRecoveryIssues(): readonly {readonly request: InteractionRequestRef; readonly code: string}[] {
    return [...this.active.values()].flatMap(record => record.applicationStarted && record.outcome === null
      ? [{request: record.request.ref, code: "interaction_application_unconfirmed"}] : []);
  }

  async activateRestored(): Promise<void> {
    this.assertAvailable();
    if (this.activated) throw new TypeError("Interaction coordinator is already activated.");
    if (this.getRecoveryIssues().length) throw new TypeError("Interaction application outcome must be reconciled before activation.");
    this.activated = true;
    for (const active of this.active.values()) {
      this.armExpiry(active);
      if (active.submission !== null) {
        void this.resolveSubmission(active, active.submission).catch(error => this.failPersistence(error));
      }
    }
  }

  completion(request: InteractionRequestRef): Promise<RuntimeInteractionSettlement> | null {
    return this.records.get(requestKey(request))?.completion ?? null;
  }

  private armExpiry(active: ActiveInteraction): void {
    if (active.request.expiresAt === null || active.expiryTimer !== null) return;
    const tick = () => {
      if (!this.active.has(requestKey(active.request.ref))) return;
      const delay = Date.parse(active.request.expiresAt!) - Date.parse(this.dependencies.now());
      if (delay > 0) active.expiryTimer = setTimeout(tick, Math.min(delay, 2_147_483_647));
      else void this.settleNonResolved(active, {status: "expired", code: "interaction_expired", expiredAt: active.request.expiresAt!})
        .catch(error => this.failPersistence(error));
    };
    const delay = Date.parse(active.request.expiresAt) - Date.parse(this.dependencies.now());
    active.expiryTimer = setTimeout(() => {
      if (delay <= 2_147_483_647) {
        void this.settleNonResolved(active, {status: "expired", code: "interaction_expired", expiredAt: active.request.expiresAt!})
          .catch(error => this.failPersistence(error));
      } else tick();
    }, Math.max(0, Math.min(delay, 2_147_483_647)));
  }

  private resolveProtocol(ref: InteractionProtocolRef): CapturedInteractionProtocol | undefined {
    const key = protocolKey(ref);
    return (this.dependencies.localProtocols ?? []).find(
      (protocol) => protocolKey(protocol.ref) === key,
    ) ?? this.dependencies.registry.find(ref);
  }

  private async resolveSubmission(active: ActiveInteraction, input: InteractionSubmissionInput): Promise<void> {
    if (!this.active.has(requestKey(input.request))) return;
    const step = active.flow.advance("resolve", {submissionId: input.submissionId}, [active.flow.material("Accepted Interaction submission", "received", input)]);
    let submissionValidated = false;
    try {
      const submission = active.resolution === null ? active.protocol.validateSubmission(active.request, input.payload) : null;
      step.check("submission_contract", "passed");
      submissionValidated = true;
      const resolutionValue = active.resolution !== null ? active.resolution.value : active.protocol.resolve({
        request: active.request,
        submissionId: input.submissionId,
        submission,
        receivedAt: input.receivedAt,
      });
      const resolvedAt = active.resolution?.resolvedAt ?? this.dependencies.now();
      const resolution = active.resolution?.ref ?? Object.freeze({
        request: input.request,
        resolutionId: this.dependencies.createId("interaction_resolution", this.nextResolution++),
        resolutionRevision: String(input.request.requestVersion),
      });
      const resolutionRef = active.flow.material("Interaction resolution", "resolved", {resolution, value: resolutionValue});
      step.output(resolutionRef);
      active.flow.advance("apply", {resolutionId: resolution.resolutionId}, [resolutionRef]);
      active.resolution = {ref: resolution, value: resolutionValue, resolvedAt};
      await this.save();
      if (!this.active.has(requestKey(input.request))) return;
      if (active.applicationStarted && active.outcome === null) throw new TypeError("Unconfirmed Interaction application cannot be repeated.");
      const application = active.application ?? Object.freeze({
        resolution, owner: input.request.protocol.owner,
        applicationId: this.dependencies.createId("interaction_application", this.nextApplication++),
      });
      if (!active.applicationStarted) {
        active.applicationStarted = true;
        active.application = application;
        await this.save();
      }
      const applicationValue = active.outcome !== null ? active.outcome.value : await active.protocol.apply({
        request: active.request,
        resolution: resolutionValue,
        resolvedAt,
      });
      const outcome: InteractionAppliedOutcome = Object.freeze({
        request: input.request,
        resolution,
        application,
        value: applicationValue,
      });
      active.outcome = outcome;
      await this.save();
      const settlement: RuntimeInteractionSettlement = Object.freeze({
        status: "resolved" as const,
        outcome,
        contentDigest: input.contentDigest,
        resolutionValue,
        applicationValue,
      });
      active.flow.current?.output(active.flow.material("Interaction application", "applied", outcome));
      await this.commitTerminal(active, Object.freeze({
        kind: "resolved" as const,
        request: input.request,
        resolution,
      }), settlement);
    } catch (error) {
      if (error instanceof RunCommitError) throw error;
      if (!submissionValidated) step.check("submission_contract", "error", {reason: "submission_invalid"});
      const failureId = this.dependencies.createId("interaction_resolution", this.nextResolution++);
      const settlement: RuntimeInteractionSettlement = Object.freeze({
        status: "failed" as const,
        request: input.request,
        owner: input.request.protocol.owner,
        code: "interaction_submission_invalid",
      });
      await this.commitTerminal(active, Object.freeze({
        kind: "failed" as const,
        request: input.request,
        owner: input.request.protocol.owner,
        failureRef: failureId,
      }), settlement);
    }
  }

  private async settleNonResolved(
    active: ActiveInteraction,
    transition: NonResolvedInteractionTransition,
  ): Promise<void> {
    if (!this.active.has(requestKey(active.pending.request))) return;
    const request = active.pending.request;
    const terminal: InteractionTerminalRecord = transition.status === "expired"
      ? Object.freeze({ kind: "expired", request, expiredAt: transition.expiredAt })
      : transition.status === "cancelled"
        ? Object.freeze({ kind: "cancelled", request, cancellationId: transition.cancellationId })
        : Object.freeze({ kind: "invalidated", request, reasonCode: transition.code });
    await this.commitTerminal(active, terminal, Object.freeze({
      status: transition.status,
      request,
      owner: request.protocol.owner,
      code: transition.code,
    }));
  }

  private async commitTerminal(
    active: ActiveInteraction,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): Promise<void> {
    return this.serialize(async () => {
    const commit = active.execution.settle({
      expectedRevision: active.execution.getSnapshot().revision,
      terminal,
    });
    if (commit.status === "rejected") return;
    if (commit.status === "duplicate_identical") return;
    active.settlement = settlement;
    this.active.delete(requestKey(active.pending.request));
    this.revision += 1;
    if (active.expiryTimer !== null) clearTimeout(active.expiryTimer);
    await this.save();
    if (!active.submissionObserved) active.submissionStep.check("submission_receipt", "not_evaluated", {reason: settlement.status});
    active.flow.advance("settle", {status: settlement.status, owner: active.request.ref.protocol.owner})
      .check("terminal_commit", "passed");
    active.flow.current?.output(active.flow.material("Interaction settlement", "committed", {terminal, settlement}));
    active.flow.close(settlement.status === "failed" ? "failed" : settlement.status === "cancelled" ? "cancelled" : "returned");
    this.dependencies.onSettled(active.pending, terminal, settlement);
    active.resolveCompletion(settlement);
    });
  }

  private async save(): Promise<void> {
    if (this.failure) throw this.failure;
    try { await this.dependencies.onChanged?.(); }
    catch (error) { throw this.failPersistence(error); }
  }

  private failPersistence(cause: unknown): RunCommitError {
    this.failure ??= cause instanceof RunCommitError ? cause : new RunCommitError(`${this.dependencies.runId}:interaction`, {cause});
    for (const record of this.records.values()) {
      if (record.expiryTimer !== null) clearTimeout(record.expiryTimer);
      record.rejectCompletion(this.failure);
    }
    this.dependencies.onFailure?.(this.failure);
    return this.failure;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      this.assertAvailable();
      return action();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private assertAvailable(): void {
    if (this.failure) throw this.failure;
  }
}

function samePayload(left: unknown, right: unknown): boolean {
  try {
    const a = canonicalEncode("interaction-submission.v1", left);
    const b = canonicalEncode("interaction-submission.v1", right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  } catch { return false; }
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
