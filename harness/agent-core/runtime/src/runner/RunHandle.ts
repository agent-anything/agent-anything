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
  RunResumeReceipt,
  RunResumeRequestInput,
  RunSteeringInput,
  RunSteeringSubmissionReceipt,
} from "../run/index.js";
import type { RunSuspension } from "../run/index.js";
import type { PlanProjection } from "../plan/index.js";
import type { RetryEvent } from "../retry/index.js";
import type { VerificationHostProjection } from "@agent-anything/verification/projection";
import type { RunTreeExecutionSnapshot } from "./RunTreeExecution.js";
import type {
  DelegationResumeReceipt,
  DelegationResumeRoute,
  DelegationSteeringReceipt,
  DelegationSteeringRoute,
} from "../delegation/index.js";
import type { AgentInstructionBindingProjection } from "../instructions/index.js";
import type { DescendantContinuationTargetProjection } from "../delegation/index.js";

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

export interface ActiveDelegationProjection {
  readonly request: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly relation: Readonly<{ readonly id: string }>;
  readonly relationKind: "delegation" | "continuation";
  readonly child: Readonly<{ readonly id: string }>;
  readonly childRunRevision: number;
  readonly childStatus: RunLifecycleStatus;
  readonly suspension: RunSuspension | null;
  readonly admittedControls: readonly ("steer" | "resume" | "cancel")[];
  readonly resultTransfer: "pending";
  readonly steerable: true;
}

export interface RunOperationSnapshot<TOutput = unknown> {
  readonly runId: string;
  readonly sequence: number;
  readonly runRevision: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly instructionBinding: AgentInstructionBindingProjection | null;
  readonly plan: PlanProjection | null;
  readonly suspension: RunSuspension | null;
  readonly retry: RunRetryProjection | null;
  readonly verification: VerificationHostProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
  readonly activeDelegations: readonly ActiveDelegationProjection[];
  readonly continuationTargets: readonly DescendantContinuationTargetProjection[];
  readonly runTree: RunTreeExecutionSnapshot;
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
  resume(input: RunResumeRequestInput): RunResumeReceipt;
  steer(input: RunSteeringInput): RunSteeringSubmissionReceipt;
  steerDescendant(input: DelegationSteeringRoute): DelegationSteeringReceipt;
  resumeDescendant(input: DelegationResumeRoute): DelegationResumeReceipt;
  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome;
  wait(): Promise<RunResult<TOutput>>;
  getResult(): RunResult<TOutput> | null;
}

export interface RunExecutionUpdate<TOutput> {
  readonly runRevision: number;
  readonly status: RunLifecycleStatus;
  readonly lastRunItemSequence: number;
  readonly instructionBinding: AgentInstructionBindingProjection | null;
  readonly plan: PlanProjection | null;
  readonly suspension: RunSuspension | null;
  readonly retry: RunRetryProjection | null;
  readonly verification: VerificationHostProjection | null;
  readonly pendingInteractions: readonly RunPendingInteractionProjection[];
  readonly activeDelegations: readonly ActiveDelegationProjection[];
  readonly continuationTargets: readonly DescendantContinuationTargetProjection[];
  readonly result: RunResult<TOutput> | null;
}

export class ActiveRunHandle<TOutput> implements RunHandle<TOutput> {
  readonly runId: string;

  private readonly listeners = new Set<RunOperationListener<TOutput>>();
  private readonly completion: Promise<RunResult<TOutput>>;
  private resolveCompletion!: (result: RunResult<TOutput>) => void;
  private snapshot: RunOperationSnapshot<TOutput>;
  private settlementApplied = false;
  private submitInteractionImpl: ((input: InteractionSubmissionInput) => InteractionSubmissionOutcome) | null = null;
  private steerImpl: ((input: RunSteeringInput) => RunSteeringSubmissionReceipt) | null = null;
  private resumeImpl: ((input: RunResumeRequestInput) => RunResumeReceipt) | null = null;
  private steerDescendantImpl:
    ((input: DelegationSteeringRoute) => DelegationSteeringReceipt) | null = null;
  private resumeDescendantImpl:
    ((input: DelegationResumeRoute) => DelegationResumeReceipt) | null = null;

  constructor(
    runId: string,
    private readonly cancellation: RunCancellationController,
    private readonly emergencyResult: RunResult<TOutput>,
    initialRunTree: RunTreeExecutionSnapshot,
    private readonly onSettled: (result: RunResult<TOutput>) => void,
  ) {
    this.runId = runId;
    this.snapshot = freezeSnapshot({
      runId,
      sequence: 0,
      runRevision: 0,
      status: "initializing",
      lastRunItemSequence: 0,
      instructionBinding: null,
      plan: null,
      suspension: null,
      retry: null,
      verification: null,
      pendingInteractions: Object.freeze([]),
      activeDelegations: Object.freeze([]),
      continuationTargets: Object.freeze([]),
      runTree: initialRunTree,
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

  publish(
    update: RunExecutionUpdate<TOutput>,
    runTree: RunTreeExecutionSnapshot = this.snapshot.runTree,
  ): void {
    if (this.snapshot.result !== null) {
      return;
    }
    this.assertRunTreeRevision(runTree);
    this.snapshot = freezeSnapshot({
      runId: this.runId,
      sequence: this.snapshot.sequence + 1,
      runRevision: update.runRevision,
      status: update.status,
      lastRunItemSequence: update.lastRunItemSequence,
      instructionBinding: update.instructionBinding,
      plan: update.plan,
      suspension: update.suspension,
      retry: update.retry,
      verification: update.verification,
      pendingInteractions: update.pendingInteractions,
      activeDelegations: update.activeDelegations,
      continuationTargets: update.continuationTargets,
      runTree,
      result: update.result,
    });
    for (const listener of [...this.listeners]) {
      notify(listener, this.snapshot);
    }
  }

  publishRunTree(runTree: RunTreeExecutionSnapshot): void {
    this.assertRunTreeRevision(runTree);
    if (runTree.revision === this.snapshot.runTree.revision) return;
    this.snapshot = freezeSnapshot({
      ...this.snapshot,
      sequence: this.snapshot.sequence + 1,
      runTree,
    });
    for (const listener of [...this.listeners]) notify(listener, this.snapshot);
  }

  private assertRunTreeRevision(runTree: RunTreeExecutionSnapshot): void {
    if (runTree.rootRunId !== this.snapshot.runTree.rootRunId) {
      throw new TypeError("RunHandle received a Run Tree for another root.");
    }
    if (runTree.revision < this.snapshot.runTree.revision) {
      throw new TypeError("RunHandle received a stale Run Tree revision.");
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

  bindResume(resume: (input: RunResumeRequestInput) => RunResumeReceipt): void {
    if (this.resumeImpl !== null) throw new TypeError("Run resume is already bound.");
    this.resumeImpl = resume;
  }

  resume(input: RunResumeRequestInput): RunResumeReceipt {
    if (this.snapshot.result !== null) {
      return Object.freeze({
        status: "rejected" as const,
        code: "run_settled" as const,
        requestId: typeof input?.id === "string" ? input.id : "",
        currentRunRevision: this.snapshot.runRevision,
      });
    }
    if (this.resumeImpl === null) {
      return Object.freeze({
        status: "rejected" as const,
        code: "run_not_suspended" as const,
        requestId: typeof input?.id === "string" ? input.id : "",
        currentRunRevision: this.snapshot.runRevision,
      });
    }
    return this.resumeImpl(input);
  }

  bindSteering(
    steer: (input: RunSteeringInput) => RunSteeringSubmissionReceipt,
  ): void {
    if (this.steerImpl !== null) {
      throw new TypeError("Run steering is already bound.");
    }
    this.steerImpl = steer;
  }

  steer(input: RunSteeringInput): RunSteeringSubmissionReceipt {
    if (this.snapshot.result !== null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "run_settled");
    }
    if (this.steerImpl === null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "steering_invalid");
    }
    return this.steerImpl(input);
  }

  bindDescendantSteering(
    steer: (input: DelegationSteeringRoute) => DelegationSteeringReceipt,
  ): void {
    if (this.steerDescendantImpl !== null) {
      throw new TypeError("Descendant steering is already bound.");
    }
    this.steerDescendantImpl = steer;
  }

  steerDescendant(input: DelegationSteeringRoute): DelegationSteeringReceipt {
    if (this.steerDescendantImpl === null) {
      return Object.freeze({
        status: "rejected" as const,
        code: "delegation_route_invalid" as const,
        relation: null,
        child: null,
      });
    }
    return this.steerDescendantImpl(input);
  }

  bindDescendantResume(
    resume: (input: DelegationResumeRoute) => DelegationResumeReceipt,
  ): void {
    if (this.resumeDescendantImpl !== null) {
      throw new TypeError("Descendant resume is already bound.");
    }
    this.resumeDescendantImpl = resume;
  }

  resumeDescendant(input: DelegationResumeRoute): DelegationResumeReceipt {
    if (this.resumeDescendantImpl === null) {
      return Object.freeze({
        status: "rejected" as const,
        code: "delegation_route_invalid" as const,
        relation: null,
        child: null,
      });
    }
    return this.resumeDescendantImpl(input);
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
    if (!this.settlementApplied) {
      this.settlementApplied = true;
      this.onSettled(result);
    }
    if (this.snapshot.result === null) {
      this.publish({
        runRevision: this.snapshot.runRevision,
        status: terminalStatus(result),
        lastRunItemSequence: result.items.at(-1)?.ref.sequence ?? 0,
        instructionBinding: this.snapshot.instructionBinding,
        plan: this.snapshot.plan,
        suspension: null,
        retry: this.snapshot.retry,
        verification: this.snapshot.verification,
        pendingInteractions: Object.freeze([]),
        activeDelegations: Object.freeze([]),
        continuationTargets: this.snapshot.continuationTargets,
        result,
      });
    }
    this.resolveCompletion(result);
  }
}

function rejectedSteering(
  runId: string,
  input: RunSteeringInput,
  currentRunRevision: number,
  code: "run_settled" | "steering_invalid",
): RunSteeringSubmissionReceipt {
  return Object.freeze({
    status: "rejected" as const,
    code,
    run: Object.freeze({ id: runId }),
    commandId: typeof input?.commandId === "string" ? input.commandId : "",
    currentRunRevision,
  });
}

function terminalStatus<TOutput>(
  result: RunResult<TOutput>,
): Extract<RunLifecycleStatus, "succeeded" | "stopped" | "failed" | "cancelled"> {
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
    suspension: snapshot.suspension === null
      ? null
      : Object.freeze({
          ...snapshot.suspension,
          ref: Object.freeze({
            ...snapshot.suspension.ref,
            run: Object.freeze({ ...snapshot.suspension.ref.run }),
          }),
          source: Object.freeze({
            ...snapshot.suspension.source,
            run: snapshot.suspension.source.run === null
              ? null
              : Object.freeze({ ...snapshot.suspension.source.run }),
          }),
        }),
    retry: snapshot.retry === null
      ? null
      : Object.freeze({
          ...snapshot.retry,
          recentEvents: Object.freeze([...snapshot.retry.recentEvents]),
        }),
    pendingInteractions: Object.freeze([...snapshot.pendingInteractions]),
    activeDelegations: Object.freeze(snapshot.activeDelegations.map((delegation) =>
      Object.freeze({
        ...delegation,
        request: Object.freeze({ ...delegation.request }),
        relation: Object.freeze({ ...delegation.relation }),
        relationKind: delegation.relationKind,
        child: Object.freeze({ ...delegation.child }),
        suspension: delegation.suspension === null
          ? null
          : Object.freeze({
              ...delegation.suspension,
              ref: Object.freeze({
                ...delegation.suspension.ref,
                run: Object.freeze({ ...delegation.suspension.ref.run }),
              }),
              source: Object.freeze({
                ...delegation.suspension.source,
                run: delegation.suspension.source.run === null
                  ? null
                  : Object.freeze({ ...delegation.suspension.source.run }),
              }),
            }),
        admittedControls: Object.freeze([...delegation.admittedControls]),
      })
    )),
    continuationTargets: Object.freeze(snapshot.continuationTargets.map((target) =>
      Object.freeze({
        ...target,
        ref: Object.freeze({ ...target.ref }),
        sourceChild: Object.freeze({ ...target.sourceChild }),
        sourceResult: Object.freeze({ ...target.sourceResult }),
        agent: Object.freeze({ ...target.agent }),
        limitations: Object.freeze([...target.limitations]),
      })
    )),
    runTree: snapshot.runTree,
  });
}
