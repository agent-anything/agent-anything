import type { RunLifecycleStatus } from "@agent-anything/agent-core/run";
import type {
  RunCancellationController,
  RunCancellationReceipt,
  RunCancellationRequestInput,
  RunResult,
} from "../run/index.js";

export interface RunOperationSnapshot<TOutput = unknown> {
  readonly runId: string;
  readonly sequence: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
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
  wait(): Promise<RunResult<TOutput>>;
  getResult(): RunResult<TOutput> | null;
}

export interface RunExecutionUpdate<TOutput> {
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly result: RunResult<TOutput> | null;
}

export class ActiveRunHandle<TOutput> implements RunHandle<TOutput> {
  readonly runId: string;

  private readonly listeners = new Set<RunOperationListener<TOutput>>();
  private readonly completion: Promise<RunResult<TOutput>>;
  private resolveCompletion!: (result: RunResult<TOutput>) => void;
  private snapshot: RunOperationSnapshot<TOutput>;

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
        lastRunItemSequence: result.items.at(-1)?.sequence ?? 0,
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
  return Object.freeze({ ...snapshot });
}
