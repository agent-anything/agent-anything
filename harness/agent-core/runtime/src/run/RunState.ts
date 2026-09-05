import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ArtifactRef, IdentityRef, RunRef } from "@agent-anything/agent-core/run";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { ActiveContext } from "@agent-anything/context/active-context";
import type { RunPermissionState } from "./RunPermissionState.js";
import type { Plan } from "../plan/index.js";
import type { PendingRunSubject } from "./PendingRunSubject.js";
import type { RunCancellationRequest } from "./RunCancellation.js";
import type { RunItem } from "./RunItem.js";
import type { VerificationCurrentSnapshotRef } from "@agent-anything/verification/assessment";
import type { CompletionGateInvocationRef } from "@agent-anything/verification/completion";
import type { AgentInstructionBindingRef } from "../instructions/index.js";
import type { RunSettlement, RunSettlementCauseRecord } from "./RunSettlement.js";
import type { RunSuspension } from "./RunSuspension.js";

export interface RunCounters {
  readonly controllerTurns: number;
  readonly runActions: number;
  readonly observations: number;
  readonly consecutiveActionFailures: number;
}

export interface RunVerificationState {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly gate: CompletionGateInvocationRef | null;
  readonly feedbackRounds: number;
}

interface RunStateBase<TOutput> {
  readonly run: RunRef;
  readonly revision: number;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly activeAgent: AgentRevisionRef;
  readonly startingInstructionBinding: AgentInstructionBindingRef;
  readonly activeInstructionBinding: AgentInstructionBindingRef;
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
  readonly verification: RunVerificationState;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly settlementCauses: readonly RunSettlementCauseRecord[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

type ActiveRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "initializing" | "running" | "waiting";
  readonly finalOutput: null;
  readonly settlement: null;
  readonly settlementCause: null;
  readonly suspension: null;
  readonly cancellationRequest: null;
  readonly completedAt: null;
};

type SuspendedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "suspended";
  readonly finalOutput: null;
  readonly settlement: null;
  readonly settlementCause: null;
  readonly suspension: RunSuspension;
  readonly cancellationRequest: null;
  readonly completedAt: null;
};

type CancellingRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelling";
  readonly finalOutput: null;
  readonly settlement: null;
  readonly settlementCause: null;
  readonly suspension: null;
  readonly cancellationRequest: RunCancellationRequest;
  readonly completedAt: null;
};

type SucceededRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "succeeded";
  readonly finalOutput: TOutput;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "succeeded" }>;
  readonly settlementCause: Extract<RunSettlementCauseRecord, { readonly kind: "completion" }>;
  readonly suspension: null;
  readonly cancellationRequest: null;
  readonly completedAt: string;
};

type FailedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "failed";
  readonly finalOutput: null;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "failed" }>;
  readonly settlementCause: Extract<RunSettlementCauseRecord, { readonly kind: "failure" }>;
  readonly suspension: null;
  readonly cancellationRequest: RunCancellationRequest | null;
  readonly completedAt: string;
};

type StoppedRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "stopped";
  readonly finalOutput: null;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "stopped" }>;
  readonly settlementCause: Extract<RunSettlementCauseRecord, { readonly kind: "stop" }>;
  readonly suspension: null;
  readonly cancellationRequest: null;
  readonly completedAt: string;
};

type CancelledRunState<TOutput> = RunStateBase<TOutput> & {
  readonly status: "cancelled";
  readonly finalOutput: null;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "cancelled" }>;
  readonly settlementCause: Extract<RunSettlementCauseRecord, { readonly kind: "cancellation" }>;
  readonly suspension: null;
  readonly cancellationRequest: RunCancellationRequest;
  readonly completedAt: string;
};

export type RunState<TOutput = unknown> =
  | ActiveRunState<TOutput>
  | SuspendedRunState<TOutput>
  | CancellingRunState<TOutput>
  | SucceededRunState<TOutput>
  | StoppedRunState<TOutput>
  | FailedRunState<TOutput>
  | CancelledRunState<TOutput>;
