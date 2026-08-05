import type { ArtifactRef, IdentityRef, RunWorkspace } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { Context } from "@agent-anything/context/context";
import type { Plan } from "../plan/index.js";
import type { RunCancellationRequest } from "./RunCancellation.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunItem } from "./RunItem.js";
import type { RunBlockedCode, RunFailureCode } from "./RunStatus.js";
import type {
  PendingApproval,
  RunPermissionState,
} from "./RunPermissionState.js";

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
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
  readonly startedAt: string;
  readonly context: Context;
  readonly plan: Plan | null;
  readonly items: readonly RunItem<TOutput>[];
  readonly counters: RunCounters;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
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
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type WaitingForApprovalRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "waiting_for_approval";
  readonly code: null;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithPending;
};

type CancellingRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelling";
  readonly code: null;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
  readonly permission: RunPermissionStateWithoutPending;
};

type SucceededRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: NonNullable<TOutput>;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type BlockedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly permission: RunPermissionStateWithoutPending;
};

type FailedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly failure: RunFailureCause;
  readonly relatedFailures: readonly RunFailureCause[];
  readonly cancellationRequest: RunCancellationRequest | null;
  readonly permission: RunPermissionStateWithoutPending;
};

type CancelledRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: "runtime_cancelled";
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
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
