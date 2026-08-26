import type { RunLifecycleStatus } from "@agent-anything/agent-core/run";
import type {
  InteractionSubmissionInput,
  InteractionSubmissionOutcome,
  PendingInteractionRef,
} from "@agent-anything/interaction/coordination";
import type { SafeInteractionEnvelope } from "@agent-anything/interaction/protocol";
import type {
  RunCancellationController,
  RunCancellationReceipt,
  RunCancellationRequestInput,
  RunResult,
  RunSteeringInput,
  RunSteeringSubmissionReceipt,
} from "../run/index.js";
import type { PlanProjection } from "../plan/index.js";
import {
  createInitialRunProgressState,
  projectRunProgress,
  type RunProgressProjection,
} from "../progress/index.js";
import type { RetryEvent } from "../retry/index.js";
import type { ValidationHostProjection } from "@agent-anything/validation/projection";
import type { RunTreeExecutionSnapshot } from "./RunTreeExecution.js";
import type {
  DelegationSteeringReceipt,
  DelegationSteeringRoute,
} from "../delegation/index.js";

export interface RunPendingInteractionProjection {
  readonly envelope: SafeInteractionEnvelope<unknown>;
  readonly blockingScope: PendingInteractionRef["blockingScope"];
}

export interface RunRetryProjection {
  readonly attemptCount: number;
  readonly scheduledCount: number;
  readonly fallbackCount: number;
  readonly exhaustedCount: number;
  readonly cancellationCount: number;
  readonly omittedEventCount: number;
  readonly recentEvents: readonly RetryEvent[];
}

export interface ActiveDelegationProjection {
  readonly request: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly relation: Readonly<{ readonly id: string }>;
  readonly child: Readonly<{ readonly id: string }>;
  readonly childRunRevision: number;
  readonly childStatus: RunLifecycleStatus;
  readonly steerable: true;
}

export interface RunOperationSnapshot<TOutput = unknown> {
  readonly runId: string;
  readonly sequence: number;
  readonly runRevision: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly plan: PlanProjection | null;
  readonly progress: RunProgressProjection;
  readonly retry: RunRetryProjection | null;
  readonly validation: ValidationHostProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
  readonly activeDelegations: readonly ActiveDelegationProjection[];
  readonly runTree: RunTreeExecutionSnapshot;
  readonly result: RunResult<TOutput> | null;
}

export type RunOperationListener<TOutput = unknown> = (
  snapshot: RunOperationSnapshot<TOutput>,
) => void;

export interface RunHandle<TOutput = unknown> {
  readonly runId: string;
  getSnapshot(): RunOperationSnapshot<TOutput>;
  subscribe(listener: RunOperationListener<TOutput>): () => void;
  cancel(input: RunCancellationRequestInput): RunCancellationReceipt;
  steer(input: RunSteeringInput): RunSteeringSubmissionReceipt;
  steerDescendant(input: DelegationSteeringRoute): DelegationSteeringReceipt;
  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome;
  wait(): Promise<RunResult<TOutput>>;
  getResult(): RunResult<TOutput> | null;
}

export interface RunExecutionUpdate<TOutput> {
  readonly runRevision: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly plan: PlanProjection | null;
  readonly progress: RunProgressProjection;
  readonly retry: RunRetryProjection | null;
  readonly validation: ValidationHostProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
  readonly activeDelegations: readonly ActiveDelegationProjection[];
  readonly result: RunResult<TOutput> | null;
}

export class ActiveRunHandle<TOutput> implements RunHandle<TOutput> {
  readonly runId: string;

  private readonly listeners = new Set<RunOperationListener<TOutput>>();
  private readonly completion: Promise<RunResult<TOutput>>;
  private resolveCompletion!: (result: RunResult<TOutput>) => void;
  private snapshot: RunOperationSnapshot<TOutput>;
  private settlementApplied = false;
  private submitInteractionImpl: ((input: InteractionSubmissionInput) => InteractionSubmissionOutcome) | null = null;
  private steerImpl: ((input: RunSteeringInput) => RunSteeringSubmissionReceipt) | null = null;
  private steerDescendantImpl:
    ((input: DelegationSteeringRoute) => DelegationSteeringReceipt) | null = null;

  constructor(
    runId: string,
    private readonly cancellation: RunCancellationController,
    private readonly emergencyResult: RunResult<TOutput>,
    initialRunTree: RunTreeExecutionSnapshot,
    private readonly onSettled: (result: RunResult<TOutput>) => void,
  ) {
    this.runId = runId;
    this.snapshot = freezeSnapshot({
      runId,
      sequence: 0,
      runRevision: 0,
      status: "initializing",
      lastRunItemSequence: 0,
      plan: null,
      progress: projectRunProgress(createInitialRunProgressState(), null),
      retry: null,
      validation: null,
      pendingInteractions: Object.freeze([]),
      activeDelegations: Object.freeze([]),
      runTree: initialRunTree,
      result: null,
    });
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  start(execute: () => Promise<RunResult<TOutput>>): void {
    queueMicrotask(() => {
      void Promise.resolve()
        .then(execute)
        .then(
          (result) => this.settle(result),
          () => this.settle(this.emergencyResult),
        );
    });
  }

  publish(update: RunExecutionUpdate<TOutput>): void {
    if (this.snapshot.result !== null) {
      return;
    }
    this.snapshot = freezeSnapshot({
      runId: this.runId,
      sequence: this.snapshot.sequence + 1,
      runRevision: update.runRevision,
      status: update.status,
      lastRunItemSequence: update.lastRunItemSequence,
      plan: update.plan,
      progress: update.progress,
      retry: update.retry,
      validation: update.validation,
      pendingInteractions: update.pendingInteractions,
      activeDelegations: update.activeDelegations,
      runTree: this.snapshot.runTree,
      result: update.result,
    });
    for (const listener of [...this.listeners]) {
      notify(listener, this.snapshot);
    }
  }

  publishRunTree(runTree: RunTreeExecutionSnapshot): void {
    if (runTree.rootRunId !== this.snapshot.runTree.rootRunId) {
      throw new TypeError("RunHandle received a Run Tree for another root.");
    }
    if (runTree.revision < this.snapshot.runTree.revision) {
      throw new TypeError("RunHandle received a stale Run Tree revision.");
    }
    if (runTree.revision === this.snapshot.runTree.revision) return;
    this.snapshot = freezeSnapshot({
      ...this.snapshot,
      sequence: this.snapshot.sequence + 1,
      runTree,
    });
    for (const listener of [...this.listeners]) notify(listener, this.snapshot);
  }

  getSnapshot(): RunOperationSnapshot<TOutput> {
    return this.snapshot;
  }

  subscribe(listener: RunOperationListener<TOutput>): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Run operation listener must be a function.");
    }
    this.listeners.add(listener);
    notify(listener, this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancel(input: RunCancellationRequestInput): RunCancellationReceipt {
    const receipt = this.cancellation.requestCancellation(input);
    if (this.snapshot.result === null) {
      return receipt;
    }
    return Object.freeze({
      accepted: false,
      status: "run_settled" as const,
      request: receipt.request,
    });
  }

  bindSteering(
    steer: (input: RunSteeringInput) => RunSteeringSubmissionReceipt,
  ): void {
    if (this.steerImpl !== null) {
      throw new TypeError("Run steering is already bound.");
    }
    this.steerImpl = steer;
  }

  steer(input: RunSteeringInput): RunSteeringSubmissionReceipt {
    if (this.snapshot.result !== null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "run_settled");
    }
    if (this.steerImpl === null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "steering_invalid");
    }
    return this.steerImpl(input);
  }

  bindDescendantSteering(
    steer: (input: DelegationSteeringRoute) => DelegationSteeringReceipt,
  ): void {
    if (this.steerDescendantImpl !== null) {
      throw new TypeError("Descendant steering is already bound.");
    }
    this.steerDescendantImpl = steer;
  }

  steerDescendant(input: DelegationSteeringRoute): DelegationSteeringReceipt {
    if (this.steerDescendantImpl === null) {
      return Object.freeze({
        status: "rejected" as const,
        code: "delegation_route_invalid" as const,
        relation: null,
        child: null,
      });
    }
    return this.steerDescendantImpl(input);
  }

  bindInteractionSubmission(
    submit: (input: InteractionSubmissionInput) => InteractionSubmissionOutcome,
  ): void {
    if (this.submitInteractionImpl !== null) {
      throw new TypeError("Run interaction submission is already bound.");
    }
    this.submitInteractionImpl = submit;
  }

  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome {
    if (this.snapshot.result !== null) {
      return Object.freeze({ status: "rejected", code: "run_settled", receipt: null });
    }
    if (this.submitInteractionImpl === null) {
      return Object.freeze({ status: "rejected", code: "interaction_not_pending", receipt: null });
    }
    return this.submitInteractionImpl(input);
  }

  wait(): Promise<RunResult<TOutput>> {
    return this.completion;
  }

  getResult(): RunResult<TOutput> | null {
    return this.snapshot.result;
  }

  private settle(result: RunResult<TOutput>): void {
    if (!this.settlementApplied) {
      this.settlementApplied = true;
      this.onSettled(result);
    }
    if (this.snapshot.result === null) {
      this.publish({
        runRevision: this.snapshot.runRevision,
        status: terminalStatus(result),
        lastRunItemSequence: result.items.at(-1)?.ref.sequence ?? 0,
        plan: this.snapshot.plan,
        progress: this.snapshot.progress,
        retry: this.snapshot.retry,
        validation: this.snapshot.validation,
        pendingInteractions: Object.freeze([]),
        activeDelegations: Object.freeze([]),
        result,
      });
    }
    this.resolveCompletion(result);
  }
}

function rejectedSteering(
  runId: string,
  input: RunSteeringInput,
  currentRunRevision: number,
  code: "run_settled" | "steering_invalid",
): RunSteeringSubmissionReceipt {
  return Object.freeze({
    status: "rejected" as const,
    code,
    run: Object.freeze({ id: runId }),
    commandId: typeof input?.commandId === "string" ? input.commandId : "",
    currentRunRevision,
  });
}

function terminalStatus<TOutput>(
  result: RunResult<TOutput>,
): Extract<RunLifecycleStatus, "succeeded" | "blocked" | "failed" | "cancelled"> {
  return result.status;
}

function notify<TOutput>(
  listener: RunOperationListener<TOutput>,
  snapshot: RunOperationSnapshot<TOutput>,
): void {
  try {
    listener(snapshot);
  } catch {
    // A consumer cannot affect execution or delivery to other listeners.
  }
}

function freezeSnapshot<TOutput>(
  snapshot: RunOperationSnapshot<TOutput>,
): RunOperationSnapshot<TOutput> {
  return Object.freeze({
    ...snapshot,
    progress: Object.freeze({
      ...snapshot.progress,
      latestAssessment: snapshot.progress.latestAssessment === null
        ? null
        : Object.freeze({ ...snapshot.progress.latestAssessment }),
      latestAdvancement: snapshot.progress.latestAdvancement === null
        ? null
        : Object.freeze({ ...snapshot.progress.latestAdvancement }),
      factRefs: Object.freeze(snapshot.progress.factRefs.map((ref) => Object.freeze({ ...ref }))),
    }),
    retry: snapshot.retry === null
      ? null
      : Object.freeze({
          ...snapshot.retry,
          recentEvents: Object.freeze([...snapshot.retry.recentEvents]),
        }),
    pendingInteractions: Object.freeze([...snapshot.pendingInteractions]),
    activeDelegations: Object.freeze(snapshot.activeDelegations.map((delegation) =>
      Object.freeze({
        ...delegation,
        request: Object.freeze({ ...delegation.request }),
        relation: Object.freeze({ ...delegation.relation }),
        child: Object.freeze({ ...delegation.child }),
      })
    )),
    runTree: snapshot.runTree,
  });
}
