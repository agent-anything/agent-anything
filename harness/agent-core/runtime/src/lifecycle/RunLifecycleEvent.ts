import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef } from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { VerificationCurrentSnapshotRef } from "@agent-anything/verification/assessment";
import type {
  CompletionGateInvocationRef,
  CompletionProposalRef,
} from "@agent-anything/verification/completion";
import type { ModelInteractionProjection } from "../controller/index.js";
import type { AgentInstructionBindingRef } from "../instructions/index.js";
import type { RunCauseSourceRef } from "../run/RunSettlement.js";
import type { RunFailureCause } from "../run/RunFailure.js";

export type RunLifecycleEventName = "Stop" | "StopFailure";

export interface RunLifecycleEventRef {
  readonly run: RunRef;
  readonly id: string;
  readonly sequence: number;
  readonly revision: string;
}

export interface StopCandidateBasis {
  readonly runRevision: number;
  readonly steeringEpoch: number;
  readonly controllerTurn: ControllerTurnRef;
  readonly completionProposal: CompletionProposalRef;
  readonly activeAgent: AgentRevisionRef;
  readonly instructionBinding: AgentInstructionBindingRef;
  readonly verificationSnapshot: VerificationCurrentSnapshotRef;
  readonly completionGate: CompletionGateInvocationRef;
  readonly planRevision: number | null;
  readonly pendingRevision: string;
}

export interface StopLifecycleEvent<TOutput = unknown> {
  readonly ref: RunLifecycleEventRef;
  readonly name: "Stop";
  readonly run: RunRef;
  readonly task: AgentTask;
  readonly basis: StopCandidateBasis;
  readonly output: TOutput;
  readonly interaction: ModelInteractionProjection;
  readonly emittedAt: string;
}

export interface StopFailureLifecycleEvent {
  readonly ref: RunLifecycleEventRef;
  readonly name: "StopFailure";
  readonly run: RunRef;
  readonly turn: ControllerTurnRef;
  readonly failure: RunFailureCause;
  readonly source: RunCauseSourceRef;
  readonly emittedAt: string;
}

export type RunLifecycleEvent<TOutput = unknown> =
  | StopLifecycleEvent<TOutput>
  | StopFailureLifecycleEvent;

export function snapshotRunLifecycleEventRef(
  input: RunLifecycleEventRef,
): RunLifecycleEventRef {
  record(input, "RunLifecycleEventRef");
  record(input.run, "RunLifecycleEventRef.run");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("RunLifecycleEventRef.sequence must be a positive safe integer.");
  }
  return deepFreeze({
    run: { id: token(input.run.id, "RunLifecycleEventRef.run.id") },
    id: token(input.id, "RunLifecycleEventRef.id"),
    sequence: input.sequence,
    revision: token(input.revision, "RunLifecycleEventRef.revision"),
  });
}

export function snapshotStopLifecycleEvent<TOutput>(
  input: StopLifecycleEvent<TOutput>,
): StopLifecycleEvent<TOutput> {
  record(input, "StopLifecycleEvent");
  if (input.name !== "Stop") throw new TypeError("Stop lifecycle event name is invalid.");
  dateTime(input.emittedAt, "StopLifecycleEvent.emittedAt");
  if (input.ref.run.id !== input.run.id || input.basis.controllerTurn.run.id !== input.run.id) {
    throw new TypeError("Stop lifecycle event correlations must identify one Run.");
  }
  if (!Number.isSafeInteger(input.basis.runRevision) || input.basis.runRevision < 1 ||
      !Number.isSafeInteger(input.basis.steeringEpoch) || input.basis.steeringEpoch < 0) {
    throw new TypeError("Stop candidate lifecycle revisions are invalid.");
  }
  return deepFreeze({ ...input, ref: snapshotRunLifecycleEventRef(input.ref) });
}

export function snapshotStopFailureLifecycleEvent(
  input: StopFailureLifecycleEvent,
): StopFailureLifecycleEvent {
  record(input, "StopFailureLifecycleEvent");
  if (input.name !== "StopFailure") {
    throw new TypeError("StopFailure lifecycle event name is invalid.");
  }
  dateTime(input.emittedAt, "StopFailureLifecycleEvent.emittedAt");
  if (input.ref.run.id !== input.run.id || input.turn.run.id !== input.run.id) {
    throw new TypeError("StopFailure lifecycle event correlations must identify one Run.");
  }
  return deepFreeze({ ...input, ref: snapshotRunLifecycleEventRef(input.ref) });
}

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical non-empty string.`);
  }
  return value;
}

function dateTime(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
