import type { RunLifecycleStatus } from "@agent-anything/agent-core/run";
import { RunCommitError } from "./RunCommitPort.js";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import { ControllerCheckpointError } from "../controller/ControllerCheckpoint.js";
import { RetryCheckpointError } from "../retry/RetryCheckpoint.js";
import { RunRecoveryError } from "./RunRecovery.js";
import { ActionRecoveryError } from "@agent-anything/action-execution/enforcement";
import { CompositeRecoveryError } from "@agent-anything/operation-composition/execution";
import { ActionRecordCommitError } from "@agent-anything/action-execution/enforcement";
import { CompositeCommitError } from "@agent-anything/operation-composition/execution";
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
import type { RunSuspendRequestInput, RunSuspendReceipt } from "../run/RunSuspension.js";
import type { PlanProjection } from "../plan/index.js";
import type { RetryEvent } from "../retry/index.js";
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
  readonly runId: string;
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
  cancel(input: RunCancellationRequestInput): Promise<RunCancellationReceipt>;
  suspend(input: RunSuspendRequestInput): Promise<RunSuspendReceipt>;
  resume(input: RunResumeRequestInput): Promise<RunResumeReceipt>;
  steer(input: RunSteeringInput): Promise<RunSteeringSubmissionReceipt>;
  steerDescendant(input: DelegationSteeringRoute): Promise<DelegationSteeringReceipt>;
  resumeDescendant(input: DelegationResumeRoute): Promise<DelegationResumeReceipt>;
  submitInteraction(input: InteractionSubmissionInput): Promise<InteractionSubmissionOutcome>;
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
  private rejectCompletion!: (error: unknown) => void;
  private snapshot: RunOperationSnapshot<TOutput>;
  private settlementApplied = false;
  private confirmCancellation: (() => Promise<void>) | null = null;
  private submitInteractionImpl: ((input: InteractionSubmissionInput) => Promise<InteractionSubmissionOutcome>) | null = null;
  private steerImpl: ((input: RunSteeringInput) => Promise<RunSteeringSubmissionReceipt>) | null = null;
  private resumeImpl: ((input: RunResumeRequestInput) => Promise<RunResumeReceipt>) | null = null;
  private suspendImpl: ((input: RunSuspendRequestInput) => Promise<RunSuspendReceipt>) | null = null;
  private steerDescendantImpl:
    ((input: DelegationSteeringRoute) => Promise<DelegationSteeringReceipt>) | null = null;
  private resumeDescendantImpl:
    ((input: DelegationResumeRoute) => Promise<DelegationResumeReceipt>) | null = null;

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
      pendingInteractions: Object.freeze([]),
      activeDelegations: Object.freeze([]),
      continuationTargets: Object.freeze([]),
      runTree: initialRunTree,
      result: null,
    });
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => {});
  }

  start(execute: () => Promise<RunResult<TOutput>>): void {
    queueMicrotask(() => {
      void Promise.resolve()
        .then(execute)
        .then(
          (result) => this.settle(result),
          error => {
            if (error instanceof OperationCommitError || error instanceof RunCommitError || error instanceof RunRecoveryError || error instanceof ControllerCheckpointError || error instanceof RetryCheckpointError || error instanceof ActionRecordCommitError || error instanceof ActionRecoveryError || error instanceof CompositeCommitError || error instanceof CompositeRecoveryError) this.rejectCompletion(error);
            else this.settle(this.emergencyResult);
          },
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

  bindCancellationAcceptance(confirm: () => Promise<void>): void {
    if (this.confirmCancellation !== null) throw new TypeError("Cancellation acceptance is already bound.");
    this.confirmCancellation = confirm;
  }

  async cancel(input: RunCancellationRequestInput): Promise<RunCancellationReceipt> {
    const receipt = this.cancellation.requestCancellation(input);
    if (receipt.status !== "run_settled") {
      await this.confirmCancellation?.();
      return receipt;
    }
    return Object.freeze({
      accepted: false,
      status: "run_settled" as const,
      request: receipt.request,
    });
  }

  bindSuspend(suspend: (input: RunSuspendRequestInput) => Promise<RunSuspendReceipt>): void {
    if (this.suspendImpl !== null) throw new TypeError("Run suspension is already bound.");
    this.suspendImpl = suspend;
  }

  async suspend(input: RunSuspendRequestInput): Promise<RunSuspendReceipt> {
    if (this.snapshot.result !== null || this.suspendImpl === null) return Object.freeze({
      status: "rejected", code: this.snapshot.result !== null ? "run_settled" : "run_not_started",
      requestId: typeof input?.id === "string" ? input.id : "", currentRunRevision: this.snapshot.runRevision,
    });
    return this.suspendImpl(input);
  }

  bindResume(resume: (input: RunResumeRequestInput) => Promise<RunResumeReceipt>): void {
    if (this.resumeImpl !== null) throw new TypeError("Run resume is already bound.");
    this.resumeImpl = resume;
  }

  async resume(input: RunResumeRequestInput): Promise<RunResumeReceipt> {
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
    steer: (input: RunSteeringInput) => Promise<RunSteeringSubmissionReceipt>,
  ): void {
    if (this.steerImpl !== null) {
      throw new TypeError("Run steering is already bound.");
    }
    this.steerImpl = steer;
  }

  async steer(input: RunSteeringInput): Promise<RunSteeringSubmissionReceipt> {
    if (this.snapshot.result !== null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "run_settled");
    }
    if (this.steerImpl === null) {
      return rejectedSteering(this.runId, input, this.snapshot.runRevision, "steering_invalid");
    }
    return this.steerImpl(input);
  }

  bindDescendantSteering(
    steer: (input: DelegationSteeringRoute) => Promise<DelegationSteeringReceipt>,
  ): void {
    if (this.steerDescendantImpl !== null) {
      throw new TypeError("Descendant steering is already bound.");
    }
    this.steerDescendantImpl = steer;
  }

  async steerDescendant(input: DelegationSteeringRoute): Promise<DelegationSteeringReceipt> {
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
    resume: (input: DelegationResumeRoute) => Promise<DelegationResumeReceipt>,
  ): void {
    if (this.resumeDescendantImpl !== null) {
      throw new TypeError("Descendant resume is already bound.");
    }
    this.resumeDescendantImpl = resume;
  }

  async resumeDescendant(input: DelegationResumeRoute): Promise<DelegationResumeReceipt> {
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
    submit: (input: InteractionSubmissionInput) => Promise<InteractionSubmissionOutcome>,
  ): void {
    if (this.submitInteractionImpl !== null) {
      throw new TypeError("Run interaction submission is already bound.");
    }
    this.submitInteractionImpl = submit;
  }

  async submitInteraction(input: InteractionSubmissionInput): Promise<InteractionSubmissionOutcome> {
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
): Extract<RunLifecycleStatus, "completed" | "failed" | "cancelled"> {
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
