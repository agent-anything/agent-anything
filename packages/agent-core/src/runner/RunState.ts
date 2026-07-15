import type { ArtifactRef, EvidenceRef, ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { Context } from "../context/Context.js";
import type { Plan } from "../plan/index.js";
import type { RunCancellationRequest } from "./RunCancellation.js";
import type { RunItem } from "./RunItem.js";
import type { RunBlockedCode, RunFailureCode } from "./RunResult.js";
import type { RuntimeError } from "./RuntimeError.js";
import type {
  PendingApproval,
  RunPermissionState,
} from "./RunPermissionState.js";

export type RunLifecycleStatus =
  | "initializing"
  | "running"
  | "waiting_for_approval"
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

type RunPermissionStateWithoutPending = Omit<
  RunPermissionState,
  "pendingApproval"
> & { readonly pendingApproval: null };

type RunPermissionStateWithPending = Omit<
  RunPermissionState,
  "pendingApproval"
> & { readonly pendingApproval: PendingApproval };

type ActiveRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "initializing" | "running";
  readonly code: null;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type WaitingForApprovalRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "waiting_for_approval";
  readonly code: null;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithPending;
};

type CancellingRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelling";
  readonly code: null;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
  readonly permission: RunPermissionStateWithoutPending;
};

type SucceededRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: NonNullable<TOutput>;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type BlockedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type FailedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly errors: readonly [RuntimeError, ...RuntimeError[]];
  readonly cancellationRequest: RunCancellationRequest | null;
  readonly permission: RunPermissionStateWithoutPending;
};

type CancelledRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: "runtime_cancelled";
  readonly finalOutput: null;
  readonly errors: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
  readonly permission: RunPermissionStateWithoutPending;
};

export type RunState<TOutput = unknown> =
  | ActiveRunState<TOutput>
  | WaitingForApprovalRunState<TOutput>
  | CancellingRunState<TOutput>
  | SucceededRunState<TOutput>
  | BlockedRunState<TOutput>
  | FailedRunState<TOutput>
  | CancelledRunState<TOutput>;
