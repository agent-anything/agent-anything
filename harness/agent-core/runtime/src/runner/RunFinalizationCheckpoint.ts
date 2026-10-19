import type { RunCauseSourceRef, RunCausalLink, RunFailureCause, RunCancellationSummary } from "../run/index.js";

export type RunTerminalCandidate<TOutput = unknown> =
  | {readonly status: "completed"; readonly output: TOutput; readonly source?: RunCauseSourceRef}
  | {readonly status: "failed"; readonly failure: RunFailureCause; readonly source?: RunCauseSourceRef;
      readonly underlying?: readonly RunCausalLink[]; readonly omittedUnderlyingCount?: number}
  | {readonly status: "cancelled"; readonly underlying?: readonly RunCausalLink[]; readonly omittedUnderlyingCount?: number};

export interface RunFinalizationCheckpoint {
  readonly candidate: RunTerminalCandidate;
  readonly startedAt: string;
  readonly cancellation: RunCancellationSummary | null;
  readonly finalizers: readonly {
    readonly binding: {readonly id: string; readonly revision: string} | null;
    readonly status: "not_started" | "pending" | "settled";
    readonly failure: RunFailureCause | null;
  }[];
}

export interface RunLifecycleRecordingCheckpoint {
  readonly phase: "started" | "completed" | "failed" | "cancelled";
  readonly status: "pending" | "settled" | "interrupted";
  readonly failures: readonly RunFailureCause[];
}
