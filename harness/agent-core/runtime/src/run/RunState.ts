import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ArtifactRef, IdentityRef, RunRef } from "@agent-anything/agent-core/run";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { ActiveContext } from "@agent-anything/context/active-context";
import type { RunPermissionState } from "./RunPermissionState.js";
import type { Plan } from "../plan/index.js";
import type { PendingRunSubject } from "./PendingRunSubject.js";
import type { RunObservation } from "./RunObservation.js";
import type { RunCancellationRequest } from "./RunCancellation.js";
import type { RunFailureCause } from "./RunFailure.js";
import type { RunItem } from "./RunItem.js";
import type { RunBlockedCode, RunFailureCode } from "./RunStatus.js";
import type { ValidationCurrentSnapshotRef } from "@agent-anything/validation/assessment";
import type { CompletionGateInvocationRef } from "@agent-anything/validation/completion";
import type { RunProgressState } from "../progress/index.js";

export interface RunCounters {
  readonly controllerTurns: number;
  readonly runActions: number;
  readonly observations: number;
  readonly consecutiveActionFailures: number;
}

export interface RunValidationState {
  readonly snapshot: ValidationCurrentSnapshotRef;
  readonly gate: CompletionGateInvocationRef | null;
}

interface RunStateBase<TOutput> {
  readonly run: RunRef;
  readonly revision: number;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly activeAgent: AgentRevisionRef;
  readonly workspace: WorkspaceSelection | null;
  readonly identity: IdentityRef;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly context: ActiveContext;
  readonly plan: Plan | null;
  readonly items: readonly RunItem<TOutput>[];
  readonly counters: RunCounters;
  readonly pending: readonly PendingRunSubject[];
  readonly permission: RunPermissionState;
  readonly validation: RunValidationState;
  readonly progress: RunProgressState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

type ActiveRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "initializing" | "running" | "waiting";
  readonly code: null;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly completedAt: null;
};

type CancellingRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelling";
  readonly code: null;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
  readonly completedAt: null;
};

type SucceededRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "succeeded";
  readonly code: null;
  readonly finalOutput: TOutput;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly completedAt: string;
};

type BlockedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "blocked";
  readonly code: RunBlockedCode;
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: null;
  readonly completedAt: string;
};

type FailedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "failed";
  readonly code: RunFailureCode;
  readonly finalOutput: null;
  readonly failure: RunFailureCause;
  readonly relatedFailures: readonly RunFailureCause[];
  readonly cancellationRequest: RunCancellationRequest | null;
  readonly completedAt: string;
};

type CancelledRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelled";
  readonly code: "runtime_cancelled";
  readonly finalOutput: null;
  readonly failure: null;
  readonly relatedFailures: readonly [];
  readonly cancellationRequest: RunCancellationRequest;
  readonly completedAt: string;
};

export type RunState<TOutput = unknown> =
  | ActiveRunState<TOutput>
  | CancellingRunState<TOutput>
  | SucceededRunState<TOutput>
  | BlockedRunState<TOutput>
  | FailedRunState<TOutput>
  | CancelledRunState<TOutput>;
