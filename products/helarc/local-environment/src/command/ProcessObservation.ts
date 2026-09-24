import type { CanonicalProcessIdentity } from "@agent-anything/canonical-action/subject";
import type { ProcessBackendDescriptor, ProcessStream } from "./ProcessBackend.js";
import type { ProcessTextProjection } from "./ProcessOutputText.js";

export interface ProcessExecutionRef { readonly runId: string; readonly executionId: string; }
export type ProcessPhase = "starting" | "running" | "stopping" | "draining" | "settled" | "unresolved";
export type ProcessTerminationReason = "model_stop" | "run_cancelled" | "execution_timeout" | "run_deadline" | "run_finalization" | "host_shutdown" | "backend_failure";

export interface ProcessSnapshot {
  readonly ref: ProcessExecutionRef;
  readonly revision: number;
  readonly phase: ProcessPhase;
  readonly backend: ProcessBackendDescriptor;
  readonly process: CanonicalProcessIdentity | null;
  readonly helperProcessId: number | null;
  readonly actionId: string;
  readonly origin: { readonly invocationId: string; readonly runActionId: string; readonly attemptId: string } | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly deadlineAt: string | null;
  readonly initialCwd: string;
  readonly finalCwd: string | null;
  readonly sessionCwd: string | null;
  readonly cwdDisposition: "eligible" | "committed" | "unchanged" | "detached" | "unavailable";
  readonly rootExit: { readonly code: number | null; readonly signal: string | null; readonly observedAt: string } | null;
  readonly termination: { readonly reason: ProcessTerminationReason; readonly requestedAt: string; readonly method: "none" | "graceful" | "forced" } | null;
  readonly containment: { readonly disposition: "active" | "empty" | "unknown"; readonly confirmedAt: string | null };
  readonly output: {
    readonly capture: "open" | "closed" | "incomplete";
    readonly persistence: "pending" | "complete" | "failed";
    readonly retainedBytes: number;
    readonly omittedBytes: number | null;
  };
  readonly outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown" | null;
  readonly limitations: readonly string[];
}

export interface ProcessOutputSlice extends ProcessTextProjection {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly receivedBytes: number;
  readonly omittedBytes: number;
  readonly projectionPending: boolean;
  readonly segments: readonly { readonly byteStart: number; readonly byteEnd: number; readonly decoderInputStart: number; readonly text: string }[];
}

export interface ProcessObservation {
  readonly id: string;
  readonly invocationId: string;
  readonly execution: ProcessExecutionRef;
  readonly snapshot: ProcessSnapshot;
  readonly requestedWaitMs: number;
  readonly effectiveWaitMs: number;
  readonly elapsedWaitMs: number;
  readonly returnReason: "initial_wait_limit" | "observation_wait_limit" | "immediate_snapshot" | "output_available" | "lifecycle_changed" | "process_settled";
  readonly stdout: ProcessOutputSlice;
  readonly stderr: ProcessOutputSlice;
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface ProcessExecutionFact {
  readonly kind: "reserved" | "launching" | "started" | "output" | "root_exit" | "scope_empty" | "output_settled" | "termination_requested" | "settled" | "unresolved" | "observation_started" | "observation_returned" | "observation_cancelled" | "cwd" | "finalized" | "retention_expired";
  readonly sequence: number;
  readonly occurredAt: string;
  readonly snapshot: ProcessSnapshot;
  readonly observation?: ProcessObservation;
  readonly invocationId?: string;
  readonly waitMs?: number;
  readonly requestedWaitMs?: number;
  readonly observationId?: string;
  readonly cursor?: string | null;
  readonly requestId?: string;
  readonly cleanupConfirmed?: boolean;
  readonly outputPositions?: Readonly<Record<ProcessStream, {readonly received: number; readonly retained: number; readonly projected: number; readonly omitted: number; readonly encoding: string | null; readonly integrity: string | null}>>;
}
export type ProcessExecutionObserver = (fact: ProcessExecutionFact) => void;

export interface ProcessCleanupSummary {
  readonly runId: string;
  readonly completed: boolean;
  readonly executions: readonly ProcessSnapshot[];
}
