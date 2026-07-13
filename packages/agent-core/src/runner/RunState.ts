import type { ArtifactRef, EvidenceRef, ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { Context } from "../context/Context.js";
import type { Plan } from "../plan/index.js";
import type { RunCancellationRequest } from "./RunCancellation.js";
import type { RunItem } from "./RunItem.js";
import type { RunBlockedCode, RunFailureCode } from "./RunResult.js";
import type { RuntimeError } from "./RuntimeError.js";

export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "cancelling"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export interface RunCounters {
  readonly iterations: number;
  readonly actions: number;
  readonly consecutiveActionFailures: number;
}

interface RunStateBase<TOutput> {
  readonly runId: string;
  readonly taskId: string;
  readonly startingAgentId: string;
  readonly activeAgentId: string;
  readonly startedAt: ISODateTimeString;
  readonly context: Context;
  readonly plan: Plan | null;
  readonly items: readonly RunItem<TOutput>[];
  readonly counters: RunCounters;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Metadata;
}

type ActiveRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "initializing" | "running";
  readonly code: null;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
};

type CancellingRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelling";
  readonly code: null;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
};

type SucceededRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: NonNullable<TOutput>;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
};

type BlockedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
};

type FailedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
  readonly cancellationRequest: RunCancellationRequest | null;
};

type CancelledRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: "runtime_cancelled";
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
};

export type RunState<TOutput = unknown> =
  | ActiveRunState<TOutput>
  | CancellingRunState<TOutput>
  | SucceededRunState<TOutput>
  | BlockedRunState<TOutput>
  | FailedRunState<TOutput>
  | CancelledRunState<TOutput>;
