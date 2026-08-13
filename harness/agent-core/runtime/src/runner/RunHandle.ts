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
} from "../run/index.js";
import type { PlanProjection } from "../plan/index.js";
import type { RetryEvent } from "../retry/index.js";

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

export interface RunOperationSnapshot<TOutput = unknown> {
  readonly runId: string;
  readonly sequence: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly plan: PlanProjection | null;
  readonly retry: RunRetryProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
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
  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome;
  wait(): Promise<RunResult<TOutput>>;
  getResult(): RunResult<TOutput> | null;
}

export interface RunExecutionUpdate<TOutput> {
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly plan: PlanProjection | null;
  readonly retry: RunRetryProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
  readonly result: RunResult<TOutput> | null;
}

export class ActiveRunHandle<TOutput> implements RunHandle<TOutput> {
  readonly runId: string;

  private readonly listeners = new Set<RunOperationListener<TOutput>>();
  private readonly completion: Promise<RunResult<TOutput>>;
  private resolveCompletion!: (result: RunResult<TOutput>) => void;
  private snapshot: RunOperationSnapshot<TOutput>;
  private submitInteractionImpl: ((input: InteractionSubmissionInput) => InteractionSubmissionOutcome) | null = null;

  constructor(
    runId: string,
    private readonly cancellation: RunCancellationController,
    private readonly emergencyResult: RunResult<TOutput>,
  ) {
    this.runId = runId;
    this.snapshot = freezeSnapshot({
      runId,
      sequence: 0,
      status: "initializing",
      lastRunItemSequence: 0,
      plan: null,
      retry: null,
      pendingInteractions: Object.freeze([]),
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
      status: update.status,
      lastRunItemSequence: update.lastRunItemSequence,
      plan: update.plan,
      retry: update.retry,
      pendingInteractions: update.pendingInteractions,
      result: update.result,
    });
    for (const listener of [...this.listeners]) {
      notify(listener, this.snapshot);
    }
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
    if (this.snapshot.result === null) {
      this.publish({
        status: terminalStatus(result),
        lastRunItemSequence: result.items.at(-1)?.ref.sequence ?? 0,
        plan: this.snapshot.plan,
        retry: this.snapshot.retry,
        pendingInteractions: Object.freeze([]),
        result,
      });
    }
    this.resolveCompletion(result);
  }
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
    retry: snapshot.retry === null
      ? null
      : Object.freeze({
          ...snapshot.retry,
          recentEvents: Object.freeze([...snapshot.retry.recentEvents]),
        }),
    pendingInteractions: Object.freeze([...snapshot.pendingInteractions]),
  });
}
