import type { RunLifecycleStatus } from "@agent-anything/agent-core/run";
import type {
  EvaluationCapture,
  EvaluationCapturePort,
  EvaluationCapturePolicy,
} from "../capture/EvaluationCapture.js";
import {
  assertSafeProjectionData,
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";
import {
  assertIsoTime,
  assertPositiveInteger,
  assertText,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  isEvaluationRefEqual,
  snapshotLimitations,
  snapshotRefs,
  type EvaluationFailure,
  type EvaluationLimitation,
  type EvaluationRecordRef,
} from "../contract/EvaluationPrimitives.js";
import {
  runControlledOperation,
  type EvaluationDeadlinePort,
  type EvaluationLateOperationResult,
  type EvaluationOperationControl,
} from "../contract/ControlledOperation.js";
import {
  appendEvaluationRecord,
  commitEvaluationSnapshot,
  type EvaluationExpectedRevisionStore,
  type EvaluationImmutableRecordStore,
} from "../persistence/EvaluationPersistence.js";

export type EvaluationTrialStatus =
  | "registered"
  | "preparing"
  | "running"
  | "capturing"
  | "completed"
  | "partial"
  | "invalid"
  | "infrastructure_failed"
  | "invocation_failed"
  | "capture_failed"
  | "cancelled"
  | "timed_out";

export interface EvaluationTrial {
  readonly ref: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly repetitionOrdinal: number;
  readonly seed: string;
  readonly pairingKey: string | null;
  readonly environmentProtocolRef: EvaluationRecordRef;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationEnvironmentLease {
  readonly ref: EvaluationRecordRef;
  readonly environmentFingerprint: string;
  readonly metadata: EvaluationDataObject;
}

export type EvaluationEnvironmentPreparationResult =
  | { readonly status: "prepared"; readonly lease: EvaluationEnvironmentLease }
  | {
      readonly status: "invalid" | "failed";
      readonly failure: EvaluationFailure;
    };

export type EvaluationCleanupOutcome =
  | { readonly status: "cleaned" }
  | {
      readonly status: "partial" | "failed";
      readonly failure: EvaluationFailure;
    };

export interface EvaluationEnvironmentPort {
  prepare(input: {
    readonly trial: EvaluationTrial;
    readonly signal: AbortSignal;
    readonly deadlineAt: string | null;
  }): Promise<EvaluationEnvironmentPreparationResult>;
  cleanup(input: {
    readonly trial: EvaluationTrial;
    readonly lease: EvaluationEnvironmentLease;
    readonly signal: AbortSignal;
  }): Promise<EvaluationCleanupOutcome>;
}

export interface EvaluationObservedChildRun {
  readonly runId: string;
  readonly status: EvaluationObservedChildRunStatus;
}

export type EvaluationObservedChildRunStatus = Extract<
  RunLifecycleStatus,
  "succeeded" | "failed" | "cancelled"
>;

export interface EvaluationTargetOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly owner: string;
  readonly code: string | null;
  readonly summary: string;
  readonly data: EvaluationDataObject;
}

export interface EvaluationTargetObservation {
  readonly ref: EvaluationRecordRef;
  readonly trialRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly outcome: EvaluationTargetOutcome;
  readonly childRuns: readonly EvaluationObservedChildRun[];
  readonly artifactRefs: readonly EvaluationRecordRef[];
  readonly observedAt: string;
  readonly limitations: readonly EvaluationLimitation[];
  readonly metadata: EvaluationDataObject;
}

export type EvaluationTargetInvocationResult =
  | { readonly status: "observed"; readonly observation: EvaluationTargetObservation }
  | { readonly status: "failed"; readonly failure: EvaluationFailure };

export interface EvaluationTargetPort {
  invoke(input: {
    readonly trial: EvaluationTrial;
    readonly leaseRef: EvaluationRecordRef;
    readonly signal: AbortSignal;
    readonly deadlineAt: string | null;
  }): Promise<EvaluationTargetInvocationResult>;
}

export interface EvaluationTrialTransition {
  readonly from: EvaluationTrialStatus;
  readonly to: EvaluationTrialStatus;
  readonly revision: number;
  readonly occurredAt: string;
  readonly failure: EvaluationFailure | null;
}

export interface EvaluationTrialSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly trial: EvaluationTrial;
  readonly status: EvaluationTrialStatus;
  readonly environmentLease: EvaluationEnvironmentLease | null;
  readonly targetObservationRef: EvaluationRecordRef | null;
  readonly captureRef: EvaluationRecordRef | null;
  readonly cleanup: EvaluationCleanupOutcome | null;
  readonly failures: readonly EvaluationFailure[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastTransition: EvaluationTrialTransition | null;
}

export interface EvaluationTrialProjection {
  readonly trialRef: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly repetitionOrdinal: number;
  readonly status: EvaluationTrialStatus;
  readonly childRunRefs: readonly string[];
  readonly targetObservationRef: EvaluationRecordRef | null;
  readonly captureRef: EvaluationRecordRef | null;
  readonly cleanupStatus: EvaluationCleanupOutcome["status"] | null;
  readonly failureCodes: readonly string[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface EvaluationClock {
  now(): string;
}

export interface EvaluationLateResultObserver {
  observe(input: {
    readonly trialRef: EvaluationRecordRef;
    readonly operation: "environment" | "target" | "capture";
    readonly result: "settled" | "failed";
  }): void;
}

export interface EvaluationTrialExecutionDependencies {
  readonly environment: EvaluationEnvironmentPort;
  readonly target: EvaluationTargetPort;
  readonly capture: EvaluationCapturePort;
  readonly capturePolicy: EvaluationCapturePolicy;
  readonly captureIdentity: EvaluationCaptureIdentityPort;
  readonly stateStore: EvaluationExpectedRevisionStore<EvaluationTrialSnapshot>;
  readonly targetObservationStore: EvaluationImmutableRecordStore<EvaluationTargetObservation>;
  readonly captureStore: EvaluationImmutableRecordStore<EvaluationCapture>;
  readonly clock: EvaluationClock;
  readonly deadline: EvaluationDeadlinePort;
  readonly lateResultObserver?: EvaluationLateResultObserver;
}

export interface EvaluationCaptureIdentityPort {
  createCaptureRef(input: {
    readonly trialRef: EvaluationRecordRef;
    readonly targetSnapshotRef: EvaluationRecordRef;
    readonly caseRef: EvaluationRecordRef;
    readonly capturePolicyRef: EvaluationRecordRef;
  }): EvaluationRecordRef;
}

const TERMINAL_STATUSES = new Set<EvaluationTrialStatus>([
  "completed",
  "partial",
  "invalid",
  "infrastructure_failed",
  "invocation_failed",
  "capture_failed",
  "cancelled",
  "timed_out",
]);

const TRANSITIONS: Readonly<Record<EvaluationTrialStatus, readonly EvaluationTrialStatus[]>> =
  Object.freeze({
    registered: trialStatuses("preparing", "invalid"),
    preparing: trialStatuses(
      "running",
      "invalid",
      "infrastructure_failed",
      "cancelled",
      "timed_out",
    ),
    running: trialStatuses("capturing", "invocation_failed", "cancelled", "timed_out"),
    capturing: trialStatuses("completed", "partial", "capture_failed", "cancelled", "timed_out"),
    completed: trialStatuses(),
    partial: trialStatuses(),
    invalid: trialStatuses(),
    infrastructure_failed: trialStatuses(),
    invocation_failed: trialStatuses(),
    capture_failed: trialStatuses(),
    cancelled: trialStatuses(),
    timed_out: trialStatuses(),
  });

export function createEvaluationTrial(input: EvaluationTrial): EvaluationTrial {
  assertPositiveInteger(input?.repetitionOrdinal, "EvaluationTrial.repetitionOrdinal");
  assertToken(input.seed, "EvaluationTrial.seed");
  if (input.pairingKey !== null) assertToken(input.pairingKey, "EvaluationTrial.pairingKey");
  assertIsoTime(input.createdAt, "EvaluationTrial.createdAt");
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationTrial.ref"),
    campaignRef: createEvaluationRecordRef(input.campaignRef, "EvaluationTrial.campaignRef"),
    targetSnapshotRef: createEvaluationRecordRef(
      input.targetSnapshotRef,
      "EvaluationTrial.targetSnapshotRef",
    ),
    caseRef: createEvaluationRecordRef(input.caseRef, "EvaluationTrial.caseRef"),
    repetitionOrdinal: input.repetitionOrdinal,
    seed: input.seed,
    pairingKey: input.pairingKey,
    environmentProtocolRef: createEvaluationRecordRef(
      input.environmentProtocolRef,
      "EvaluationTrial.environmentProtocolRef",
    ),
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationTrial.metadata"),
  });
}

export function createInitialEvaluationTrialSnapshot(
  trial: EvaluationTrial,
): EvaluationTrialSnapshot {
  const admitted = createEvaluationTrial(trial);
  return Object.freeze({
    id: admitted.ref.id,
    revision: 0,
    trial: admitted,
    status: "registered",
    environmentLease: null,
    targetObservationRef: null,
    captureRef: null,
    cleanup: null,
    failures: Object.freeze([]),
    startedAt: null,
    completedAt: null,
    lastTransition: null,
  });
}

export function createEvaluationTargetObservation(
  input: EvaluationTargetObservation,
): EvaluationTargetObservation {
  assertTargetOutcome(input?.outcome);
  assertIsoTime(input.observedAt, "EvaluationTargetObservation.observedAt");
  const outcomeData = snapshotEvaluationDataObject(
    input.outcome.data,
    "EvaluationTargetOutcome.data",
  );
  assertSafeProjectionData(outcomeData, "EvaluationTargetOutcome.data");
  const metadata = snapshotEvaluationDataObject(
    input.metadata,
    "EvaluationTargetObservation.metadata",
  );
  assertSafeProjectionData(metadata, "EvaluationTargetObservation.metadata");
  const childRunIds = new Set<string>();
  const childRuns = input.childRuns.map((child, index) => {
    assertToken(child?.runId, `EvaluationTargetObservation.childRuns[${index}].runId`);
    assertRunStatus(child.status, `EvaluationTargetObservation.childRuns[${index}].status`);
    if (childRunIds.has(child.runId)) throw new TypeError(`Child Run '${child.runId}' is duplicated.`);
    childRunIds.add(child.runId);
    return Object.freeze({ runId: child.runId, status: child.status });
  });
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationTargetObservation.ref"),
    trialRef: createEvaluationRecordRef(input.trialRef, "EvaluationTargetObservation.trialRef"),
    targetSnapshotRef: createEvaluationRecordRef(
      input.targetSnapshotRef,
      "EvaluationTargetObservation.targetSnapshotRef",
    ),
    caseRef: createEvaluationRecordRef(input.caseRef, "EvaluationTargetObservation.caseRef"),
    outcome: Object.freeze({
      status: input.outcome.status,
      owner: input.outcome.owner,
      code: input.outcome.code,
      summary: input.outcome.summary,
      data: outcomeData,
    }),
    childRuns: Object.freeze(childRuns.sort((left, right) => compareText(left.runId, right.runId))),
    artifactRefs: Object.freeze([
      ...snapshotRefs(input.artifactRefs, "EvaluationTargetObservation.artifactRefs"),
    ].sort((left, right) => compareText(
      `${left.id}@${left.revision}`,
      `${right.id}@${right.revision}`,
    ))),
    observedAt: input.observedAt,
    limitations: snapshotLimitations(
      input.limitations,
      "EvaluationTargetObservation.limitations",
    ),
    metadata,
  });
}

export class EvaluationTrialExecution {
  readonly #dependencies: EvaluationTrialExecutionDependencies;
  #snapshot: EvaluationTrialSnapshot;
  readonly #cleanupByLease = new Map<string, Promise<EvaluationCleanupOutcome>>();

  constructor(
    trial: EvaluationTrial,
    dependencies: EvaluationTrialExecutionDependencies,
  ) {
    this.#snapshot = createInitialEvaluationTrialSnapshot(trial);
    this.#dependencies = dependencies;
  }

  get snapshot(): EvaluationTrialSnapshot {
    return this.#snapshot;
  }

  async run(control: EvaluationOperationControl): Promise<EvaluationTrialSnapshot> {
    if (this.#snapshot.status !== "registered") {
      throw new TypeError("Evaluation Trial can be run only from registered state.");
    }
    await this.#transition("preparing", null, { startedAt: this.#now() });

    const prepared = await runControlledOperation(
      (signal) => this.#dependencies.environment.prepare({
        trial: this.#snapshot.trial,
        signal,
        deadlineAt: control.deadlineAt,
      }),
      control,
      this.#dependencies.deadline,
      this.#late("environment"),
    );
    if (prepared.status === "cancelled" || prepared.status === "timed_out") {
      return this.#interrupt(prepared.status);
    }
    if (prepared.status === "failed") {
      return this.#terminal(
        "infrastructure_failed",
        environmentFailure("Evaluation environment preparation threw an exception."),
        null,
      );
    }
    if (prepared.value.status !== "prepared") {
      return this.#terminal(
        prepared.value.status === "invalid" ? "invalid" : "infrastructure_failed",
        prepared.value.failure,
        null,
      );
    }

    const lease = snapshotLease(prepared.value.lease);
    try {
      await this.#transition("running", null, { environmentLease: lease });
      const invoked = await runControlledOperation(
        (signal) => this.#dependencies.target.invoke({
          trial: this.#snapshot.trial,
          leaseRef: lease.ref,
          signal,
          deadlineAt: control.deadlineAt,
        }),
        control,
        this.#dependencies.deadline,
        this.#late("target"),
      );
      if (invoked.status === "cancelled" || invoked.status === "timed_out") {
        return this.#interrupt(invoked.status);
      }
      if (invoked.status === "failed") {
        return this.#terminal(
          "invocation_failed",
          invocationFailure("Evaluation target adapter threw before returning an observation."),
          lease,
        );
      }
      if (invoked.value.status === "failed") {
        return this.#terminal("invocation_failed", invoked.value.failure, lease);
      }

      let observation: EvaluationTargetObservation;
      try {
        observation = createEvaluationTargetObservation(invoked.value.observation);
        assertObservationCorrelation(observation, this.#snapshot.trial);
      } catch {
        return this.#terminal(
          "invocation_failed",
          invocationFailure("Evaluation target adapter returned an invalid observation."),
          lease,
        );
      }
      await appendEvaluationRecord(this.#dependencies.targetObservationStore, observation);
      await this.#transition("capturing", null, { targetObservationRef: observation.ref });

      const captureRef = createEvaluationRecordRef(
        this.#dependencies.captureIdentity.createCaptureRef({
          trialRef: this.#snapshot.trial.ref,
          targetSnapshotRef: this.#snapshot.trial.targetSnapshotRef,
          caseRef: this.#snapshot.trial.caseRef,
          capturePolicyRef: this.#dependencies.capturePolicy.ref,
        }),
        "EvaluationCaptureIdentityPort.createCaptureRef",
      );

      const captured = await runControlledOperation(
        (signal) => this.#dependencies.capture.capture({
          captureRef,
          trialRef: this.#snapshot.trial.ref,
          targetSnapshotRef: this.#snapshot.trial.targetSnapshotRef,
          caseRef: this.#snapshot.trial.caseRef,
          policyRef: this.#dependencies.capturePolicy.ref,
          environmentRef: lease.ref,
          targetObservationRef: observation.ref,
          signal,
          deadlineAt: control.deadlineAt,
        }),
        control,
        this.#dependencies.deadline,
        this.#late("capture"),
      );
      if (captured.status === "cancelled" || captured.status === "timed_out") {
        return this.#interrupt(captured.status);
      }
      if (captured.status === "failed") {
        return this.#terminal(
          "capture_failed",
          captureFailure("Evaluation Capture adapter threw an exception."),
          lease,
        );
      }
      const capture = captured.value.capture;
      try {
        assertCaptureCorrelation(
          capture,
          captured.value.status,
          captureRef,
          this.#dependencies.capturePolicy.ref,
          this.#snapshot.trial,
          lease,
        );
      } catch {
        return this.#terminal(
          "capture_failed",
          captureFailure("Evaluation Capture adapter returned an invalid record."),
          lease,
        );
      }
      await appendEvaluationRecord(this.#dependencies.captureStore, capture);
      const terminalStatus: EvaluationTrialStatus = captured.value.status === "failed"
        ? "capture_failed"
        : captured.value.status === "partial"
          ? "partial"
          : "completed";
      const failure = captured.value.status === "failed"
        ? capture.failures[0] ?? captureFailure("Mandatory Capture settlement failed.")
        : null;
      return this.#terminal(terminalStatus, failure, lease, capture.ref);
    } catch (error) {
      await this.#cleanup(lease);
      throw error;
    }
  }

  async #interrupt(status: "cancelled" | "timed_out"): Promise<EvaluationTrialSnapshot> {
    const failure = status === "cancelled"
      ? createEvaluationFailure({
          code: "evaluation_cancelled",
          stage: "cancellation",
          message: "Evaluation Trial was cancelled.",
          retryable: false,
          causeOwner: "evaluation.trial",
          details: {},
        })
      : createEvaluationFailure({
          code: "evaluation_timed_out",
          stage: "timeout",
          message: "Evaluation Trial exceeded its declared deadline.",
          retryable: false,
          causeOwner: "evaluation.trial",
          details: {},
        });
    return this.#terminal(status, failure, this.#snapshot.environmentLease);
  }

  async #terminal(
    status: EvaluationTrialStatus,
    failure: EvaluationFailure | null,
    lease: EvaluationEnvironmentLease | null,
    captureRef: EvaluationRecordRef | null = null,
  ): Promise<EvaluationTrialSnapshot> {
    let cleanup: EvaluationCleanupOutcome | null = null;
    let cleanupFailure: EvaluationFailure | null = null;
    if (lease !== null) {
      cleanup = await this.#cleanup(lease);
      if (cleanup.status !== "cleaned") cleanupFailure = cleanup.failure;
    }
    let terminalStatus = status;
    if (
      cleanupFailure !== null &&
      (status === "completed" || status === "partial")
    ) {
      terminalStatus = "partial";
    }
    const failures = [failure, cleanupFailure].filter(
      (item): item is EvaluationFailure => item !== null,
    );
    return this.#transition(terminalStatus, failures[0] ?? null, {
      cleanup,
      captureRef,
      additionalFailures: failures.slice(1),
      completedAt: this.#now(),
    });
  }

  async #cleanup(lease: EvaluationEnvironmentLease): Promise<EvaluationCleanupOutcome> {
    const key = `${lease.ref.id}@${lease.ref.revision}`;
    const current = this.#cleanupByLease.get(key);
    if (current) return current;
    const operation = this.#performCleanup(lease);
    this.#cleanupByLease.set(key, operation);
    return operation;
  }

  async #performCleanup(lease: EvaluationEnvironmentLease): Promise<EvaluationCleanupOutcome> {
    const controller = new AbortController();
    try {
      const result = await this.#dependencies.environment.cleanup({
        trial: this.#snapshot.trial,
        lease,
        signal: controller.signal,
      });
      if (result.status === "cleaned") return Object.freeze({ status: "cleaned" });
      return Object.freeze({
        status: result.status,
        failure: createEvaluationFailure(result.failure),
      });
    } catch {
      return Object.freeze({
        status: "failed",
        failure: cleanupFailure("Evaluation environment cleanup threw an exception."),
      });
    }
  }

  async #transition(
    to: EvaluationTrialStatus,
    failure: EvaluationFailure | null,
    changes: {
      readonly environmentLease?: EvaluationEnvironmentLease;
      readonly targetObservationRef?: EvaluationRecordRef;
      readonly captureRef?: EvaluationRecordRef | null;
      readonly cleanup?: EvaluationCleanupOutcome | null;
      readonly startedAt?: string;
      readonly completedAt?: string;
      readonly additionalFailures?: readonly EvaluationFailure[];
    } = {},
  ): Promise<EvaluationTrialSnapshot> {
    const from = this.#snapshot.status;
    if (!TRANSITIONS[from].includes(to)) {
      throw new TypeError(`Evaluation Trial transition '${from}' -> '${to}' is not allowed.`);
    }
    const occurredAt = this.#now();
    const revision = this.#snapshot.revision + 1;
    const transitionFailure = failure === null ? null : createEvaluationFailure(failure);
    assertTrialTransitionFailure(to, transitionFailure);
    const failures = [
      ...this.#snapshot.failures,
      ...(transitionFailure === null ? [] : [transitionFailure]),
      ...(changes.additionalFailures ?? []).map(createEvaluationFailure),
    ];
    const next = Object.freeze({
      ...this.#snapshot,
      revision,
      status: to,
      environmentLease: changes.environmentLease ?? this.#snapshot.environmentLease,
      targetObservationRef: changes.targetObservationRef ?? this.#snapshot.targetObservationRef,
      captureRef: changes.captureRef === undefined ? this.#snapshot.captureRef : changes.captureRef,
      cleanup: changes.cleanup === undefined ? this.#snapshot.cleanup : changes.cleanup,
      failures: Object.freeze(failures),
      startedAt: changes.startedAt ?? this.#snapshot.startedAt,
      completedAt: changes.completedAt ?? this.#snapshot.completedAt,
      lastTransition: Object.freeze({
        from,
        to,
        revision,
        occurredAt,
        failure: transitionFailure,
      }),
    }) satisfies EvaluationTrialSnapshot;
    await commitEvaluationSnapshot(this.#dependencies.stateStore, next, this.#snapshot.revision);
    this.#snapshot = next;
    return next;
  }

  #late(operation: "environment" | "target" | "capture") {
    return (result: EvaluationLateOperationResult<unknown>) => {
      this.#dependencies.lateResultObserver?.observe({
        trialRef: this.#snapshot.trial.ref,
        operation,
        result: result.status,
      });
    };
  }

  #now(): string {
    const value = this.#dependencies.clock.now();
    assertIsoTime(value, "EvaluationClock.now");
    return value;
  }
}

export function projectEvaluationTrial(
  snapshot: EvaluationTrialSnapshot,
  observation: EvaluationTargetObservation | null,
): EvaluationTrialProjection {
  return Object.freeze({
    trialRef: snapshot.trial.ref,
    campaignRef: snapshot.trial.campaignRef,
    targetSnapshotRef: snapshot.trial.targetSnapshotRef,
    caseRef: snapshot.trial.caseRef,
    repetitionOrdinal: snapshot.trial.repetitionOrdinal,
    status: snapshot.status,
    childRunRefs: Object.freeze(
      (observation?.childRuns ?? []).map((item) => item.runId).sort(compareText),
    ),
    targetObservationRef: snapshot.targetObservationRef,
    captureRef: snapshot.captureRef,
    cleanupStatus: snapshot.cleanup?.status ?? null,
    failureCodes: Object.freeze(snapshot.failures.map((item) => item.code).sort(compareText)),
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
  });
}

export function isEvaluationTrialTerminal(status: EvaluationTrialStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function snapshotLease(input: EvaluationEnvironmentLease): EvaluationEnvironmentLease {
  assertToken(input?.environmentFingerprint, "EvaluationEnvironmentLease.environmentFingerprint");
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationEnvironmentLease.ref"),
    environmentFingerprint: input.environmentFingerprint,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationEnvironmentLease.metadata"),
  });
}

function assertObservationCorrelation(
  observation: EvaluationTargetObservation,
  trial: EvaluationTrial,
): void {
  if (
    observation.trialRef.id !== trial.ref.id ||
    observation.trialRef.revision !== trial.ref.revision ||
    observation.targetSnapshotRef.id !== trial.targetSnapshotRef.id ||
    observation.targetSnapshotRef.revision !== trial.targetSnapshotRef.revision ||
    observation.caseRef.id !== trial.caseRef.id ||
    observation.caseRef.revision !== trial.caseRef.revision
  ) {
    throw new TypeError("Evaluation target observation does not correlate to the Trial.");
  }
}

function assertCaptureCorrelation(
  capture: EvaluationCapture,
  assemblyStatus: "captured" | "partial" | "failed",
  captureRef: EvaluationRecordRef,
  capturePolicyRef: EvaluationRecordRef,
  trial: EvaluationTrial,
  lease: EvaluationEnvironmentLease,
): void {
  if (
    !isEvaluationRefEqual(capture.ref, captureRef) ||
    !isEvaluationRefEqual(capture.trialRef, trial.ref) ||
    !isEvaluationRefEqual(capture.targetSnapshotRef, trial.targetSnapshotRef) ||
    !isEvaluationRefEqual(capture.caseRef, trial.caseRef) ||
    !isEvaluationRefEqual(capture.policyRef, capturePolicyRef) ||
    !isEvaluationRefEqual(capture.environmentRef, lease.ref)
  ) {
    throw new TypeError("Evaluation Capture does not correlate to the Trial.");
  }
  const expectedStatus = assemblyStatus === "captured"
    ? "complete"
    : assemblyStatus === "partial"
      ? "partial"
      : "failed";
  if (capture.status !== expectedStatus) {
    throw new TypeError("Evaluation Capture assembly status contradicts its record status.");
  }
}

function assertTargetOutcome(input: EvaluationTargetOutcome): void {
  if (!(["succeeded", "failed", "cancelled"] as const).includes(input?.status)) {
    throw new TypeError("EvaluationTargetOutcome.status is unsupported.");
  }
  assertToken(input.owner, "EvaluationTargetOutcome.owner");
  if (input.code !== null) assertToken(input.code, "EvaluationTargetOutcome.code");
  assertText(input.summary, "EvaluationTargetOutcome.summary", 2_048);
  if (input.status === "succeeded" && input.code !== null) {
    throw new TypeError("Succeeded Evaluation target outcome must not carry a failure code.");
  }
  if (input.status !== "succeeded" && input.code === null) {
    throw new TypeError("Unsuccessful Evaluation target outcome must carry its owner code.");
  }
}

function assertRunStatus(
  value: RunLifecycleStatus,
  path: string,
): asserts value is EvaluationObservedChildRunStatus {
  if (!(TERMINAL_RUN_STATUSES as readonly RunLifecycleStatus[]).includes(value)) {
    throw new TypeError(`${path} is unsupported.`);
  }
}

const TERMINAL_RUN_STATUSES: readonly EvaluationObservedChildRunStatus[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
]);

function assertTrialTransitionFailure(
  status: EvaluationTrialStatus,
  failure: EvaluationFailure | null,
): void {
  if (!TERMINAL_STATUSES.has(status)) {
    if (failure !== null) {
      throw new TypeError("A non-terminal Evaluation Trial transition cannot carry a failure.");
    }
    return;
  }

  if (status === "completed") {
    if (failure !== null) {
      throw new TypeError("A completed Evaluation Trial cannot carry a failure.");
    }
    return;
  }
  if (status === "partial") {
    if (failure !== null && failure.stage !== "capture" && failure.stage !== "cleanup") {
      throw new TypeError("A partial Evaluation Trial can carry only capture or cleanup failure.");
    }
    return;
  }

  if (failure === null) {
    throw new TypeError(`Evaluation Trial status '${status}' requires a classified failure.`);
  }
  const valid = status === "invalid"
    ? failure.stage === "definition"
    : status === "infrastructure_failed"
      ? failure.stage === "environment"
      : status === "invocation_failed"
        ? failure.stage === "invocation"
        : status === "capture_failed"
          ? failure.stage === "capture"
          : status === "cancelled"
            ? failure.stage === "cancellation"
            : failure.stage === "timeout";
  if (!valid) {
    throw new TypeError(`Evaluation Trial status '${status}' contradicts failure stage '${failure.stage}'.`);
  }
}

function environmentFailure(message: string): EvaluationFailure {
  return createEvaluationFailure({
    code: "evaluation_environment_failed",
    stage: "environment",
    message,
    retryable: false,
    causeOwner: "evaluation.environment",
    details: {},
  });
}

function invocationFailure(message: string): EvaluationFailure {
  return createEvaluationFailure({
    code: "evaluation_invocation_failed",
    stage: "invocation",
    message,
    retryable: false,
    causeOwner: "evaluation.target",
    details: {},
  });
}

function captureFailure(message: string): EvaluationFailure {
  return createEvaluationFailure({
    code: "evaluation_capture_failed",
    stage: "capture",
    message,
    retryable: false,
    causeOwner: "evaluation.capture",
    details: {},
  });
}

function cleanupFailure(message: string): EvaluationFailure {
  return createEvaluationFailure({
    code: "evaluation_cleanup_failed",
    stage: "cleanup",
    message,
    retryable: false,
    causeOwner: "evaluation.environment",
    details: {},
  });
}

function trialStatuses(
  ...statuses: EvaluationTrialStatus[]
): readonly EvaluationTrialStatus[] {
  return Object.freeze(statuses);
}
