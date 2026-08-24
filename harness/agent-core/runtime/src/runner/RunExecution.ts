import type { Agent } from "@agent-anything/agent-core/agent";
import { toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef, InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunActionProvenance, RunActionRef } from "@agent-anything/agent-core/run-action";
import type { DescendantRunRelation } from "@agent-anything/agent-core/run-tree";
import {
  applyContextTransition,
  deriveContextRefreshOperation,
  type ActiveContext,
  type ContextAdmissionProfile,
  type ContextTransition,
  type ContextTransitionOperation,
} from "@agent-anything/context/active-context";
import { ContextContractError } from "@agent-anything/context/contract";
import type { ContextContribution } from "@agent-anything/context/contribution";
import {
  createSafeProjectionManifest,
  type ContextProjection,
  type ProjectionManifest,
} from "@agent-anything/context/projection";
import {
  RuntimeEventStream,
  type ObservabilityRecordContext,
  type RunTraceAssembler,
  type RunTraceObserver,
  type RuntimeEventName,
  type RuntimeEventPayloadMap,
  type RuntimeEventPublisher,
} from "@agent-anything/observability";
import {
  findRegisteredOperation,
  type OperationRequestOrigin,
  type RegisteredOperation,
} from "@agent-anything/operation-catalog/catalog";
import type {
  ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import type {
  OperationCorrelation,
  OperationInvocationContext,
  OperationInvocationRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import {
  createOperationResult,
  type OperationFailure,
  type OperationResult,
} from "@agent-anything/operation-catalog/result";
import { CompositeExecution } from "@agent-anything/operation-composition/execution";
import type { CompositeResult } from "@agent-anything/operation-composition/result";
import {
  ActionExecutionCoordinator,
  type ActionApprovalResolutionPort,
  type ActionExecutionObserver,
  type ActionExecutionResult,
} from "@agent-anything/action-execution/enforcement";
import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import {
  snapshotCompletionGateDecision,
  snapshotCompletionGateInput,
  type CompletionGateDecision,
  type CompletionGateInput,
} from "@agent-anything/validation/completion";
import {
  createValidationFailure,
  materializeValidationProfile,
  type ValidationFailure,
  type ValidationRequirement,
} from "@agent-anything/validation/definition";
import {
  ValidationExecutionError,
  type CheckResult,
  type ValidationExecutionPort,
  type ValidationOperationCheckInput,
  type ValidationOperationCheckResolverPort,
  type ValidationLowerCheckSettlement,
} from "@agent-anything/validation/execution";
import type { ValidationHostProjection, ValidationRunnerProjection } from "@agent-anything/validation/projection";
import { createActionPermissionAssessmentPort } from "@agent-anything/permission/authority";
import {
  APPROVAL_INTERACTION_PROTOCOL,
  createApprovalInteractionPresentation,
  createApprovalInteractionProtocol,
  createApprovalRequest,
  validateApprovalDecision,
  type ApprovalApplicationOutcome,
  type ApprovalInteractionResolution,
  type ApprovalInteractionSubject,
  type ApprovalReviewInput,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission/approval";
import type {
  CapturedInteractionProtocol,
  InteractionSubmissionInput,
  InteractionSubmissionOutcome,
  PendingInteractionRef,
} from "@agent-anything/interaction/coordination";
import type { InteractionTerminalRecord } from "@agent-anything/interaction/records";
import {
  adaptToolSemanticResult,
  type ToolResult,
  type ToolSettlementRef,
} from "@agent-anything/tools/result";
import { materializeToolCall, type ToolCall } from "@agent-anything/tools/invocation";
import {
  ToolExposureValidationError,
  type ToolExposureProof,
} from "@agent-anything/tools/selection";
import {
  ControllerError,
  validateControllerDecision,
  type ControllerDecision,
  type InteractionRequestCandidate,
  type OperationRequestCandidate,
  type ProgressionCandidate,
  type SameRunHandoffRequest,
  type ToolRequestCandidate,
} from "../controller/index.js";
import {
  abandonPlan,
  applyPlanUpdate,
  projectPlan,
} from "../plan/index.js";
import { snapshotRetryEvent, type RetryEventSink } from "../retry/index.js";
import {
  projectRunProgress,
  type RunProgressAssessment,
  type RunProgressCorrectionFeedback,
  type RunProgressState,
} from "../progress/index.js";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createRunFailureCause,
  createRunObservation,
  createSucceededRunResult,
  deriveActiveRunStatus,
  toRunCancellationSummary,
  type PendingRunSubject,
  type ControllerToolExposureRecord,
  type RunFailureCause,
  type RunFailureCode,
  type RunItemPayload,
  type RunObservation,
  type RunResult,
  type RunState,
  type RunSteeringApplication,
  type RunSteeringCommand,
  type RunSteeringInput,
  type RunSteeringSubmissionReceipt,
  type RuntimeRunAction,
  snapshotRunSteeringInput,
} from "../run/index.js";
import type { RunExecutionUpdate, RunHandle } from "./RunHandle.js";
import type { ResolvedRunConfig } from "./RunConfig.js";
import type {
  RunnerAutomaticEffectfulValidationCheckPort,
  RunnerAutomaticEffectfulValidationCheckRequest,
  DescendantRunPreparation,
  RunnerValidationCheckRequest,
  ResolvedRunnerDependencies,
} from "./RunnerDependencies.js";
import {
  RunToolExposureCoordinator,
  ToolExposureBasisChangedError,
  ToolExposureCoordinationError,
} from "./RunToolExposureCoordinator.js";
import {
  ContextProjectionPreparationError,
  executeControllerOperation,
  prepareControllerOperation,
  type PreparedControllerOperation,
} from "./ControllerOperation.js";
import {
  applyCommittedPolicyAmendment,
  applyCommittedSessionAuthority,
  applyImmediateApprovalAuthority,
  consumeActionApprovalCoverage,
} from "./RunApprovalAuthority.js";
import {
  deriveApprovalReviewDeadline,
  deriveAuthorityCommitDeadline,
} from "../run/index.js";
import {
  executeAuthorityCommit,
  isDurableAuthorityDecision,
} from "./AuthorityCommitExecution.js";
import { executeApprovalReviewer } from "./ApprovalReviewerExecution.js";
import { createInitialRunState } from "./RunInitialization.js";
import { createRunFinalizationContext } from "./RunFinalization.js";
import {
  OperationSettlementTimeoutError,
  RunInterruptionCoordinator,
} from "./RunInterruptionCoordinator.js";
import { RunInteractionCoordinator, type RuntimeInteractionSettlement } from "./RunInteractionCoordinator.js";
import { evaluateRunDeadline, evaluateRunNumericLimits, type RunLimitViolation } from "./RunLoopLimits.js";
import { assessCommittedRunProgress } from "./RunProgressCheckpoint.js";
import { recordRunnerLifecycle } from "./RunnerObservability.js";
import { completeRunnerTrace, createRunnerTraceAssembler } from "./RunnerTracing.js";
import { RunStateWriter } from "./RunStateWriter.js";
import {
  createCurrentRunContextAdmissionProfile,
  createCurrentRunContextContributions,
  createObservationContextAdmissionProfile,
  createObservationContextContribution,
  createProgressCorrectionContextAdmissionProfile,
  createProgressCorrectionContextContribution,
  createSteeringContextAdmissionProfile,
  createSteeringContextContribution,
  createTaskContextAdmissionProfile,
  createTaskContextContribution,
  createValidationContextAdmissionProfile,
} from "../context-contribution/index.js";
import type {
  DescendantRunReservationFailureCode,
  RunTreeExecutionSnapshot,
} from "./RunTreeExecution.js";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";

export interface RuntimeDescendantRunStartInput {
  readonly relationId: string;
  readonly parentRunAction: RunActionRef;
  readonly agent: Agent;
  readonly input: RunInput;
  readonly config: import("./RunConfig.js").RunConfig;
}

export type RuntimeDescendantRunStartResult =
  | {
      readonly status: "started";
      readonly relation: DescendantRunRelation;
      readonly handle: RunHandle;
      readonly reservedTreeRevision: number;
      readonly treeRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | DescendantRunReservationFailureCode
        | "descendant_run_start_failed";
      readonly relation: DescendantRunRelation | null;
      readonly reservedTreeRevision: number | null;
      readonly treeRevision: number;
    };

export type RuntimeDescendantRunStarter = (
  input: RuntimeDescendantRunStartInput,
) => RuntimeDescendantRunStartResult;

type TerminalCandidate<TOutput> =
  | { readonly status: "succeeded"; readonly output: TOutput }
  | { readonly status: "blocked"; readonly code: import("../run/index.js").RunBlockedCode }
  | {
      readonly status: "failed";
      readonly code: RunFailureCode;
      readonly failure: RunFailureCause;
      readonly relatedFailures?: readonly RunFailureCause[];
    }
  | { readonly status: "cancelled" };

interface CandidateBasis<TOutput> {
  readonly turn: ControllerTurnRef;
  readonly runRevision: number;
  readonly activeAgent: Agent<TOutput>;
  readonly projection: ContextProjection;
  readonly exposure: ToolExposureProof;
  readonly exposureOwnerBasisRevision: string;
}

interface OperationExecutionOutcome {
  readonly result: OperationResult;
  readonly toolResult: ToolResult | null;
}

type DescendantExecutionOutcome =
  | {
      readonly status: "settled";
      readonly relationId: string;
      readonly childRunId: string;
      readonly prepared: DescendantRunPreparation;
      readonly result: RunResult;
    }
  | {
      readonly status: "rejected";
      readonly relationId: string;
      readonly childRunId: string | null;
      readonly code:
        | DescendantRunReservationFailureCode
        | "descendant_run_preparation_failed"
        | "descendant_agent_mismatch"
        | "descendant_run_start_failed";
      readonly operationStatus: DescendantRejectionOperationStatus;
    };

type DescendantRejectionOperationStatus = Exclude<
  import("./RunnerDependencies.js").DescendantOperationOutcome["status"],
  "succeeded" | "partial"
>;

interface QueuedInteractionSettlement {
  readonly pending: PendingInteractionRef;
  readonly terminal: InteractionTerminalRecord;
  readonly settlement: RuntimeInteractionSettlement;
  readonly action: RuntimeRunAction | null;
  readonly toolCall: ToolCall | null;
}

interface InteractionActionContext {
  readonly action: RuntimeRunAction;
  readonly toolCall: ToolCall | null;
}

export class RunExecution<TOutput> {
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly writer: RunStateWriter<TOutput>;
  private readonly interactions: RunInteractionCoordinator;
  private readonly eventStream: RuntimeEventStream;
  private readonly traceAssembler: RunTraceAssembler | null;
  private readonly interruptionCoordinator: RunInterruptionCoordinator;
  private readonly actionExecution: ActionExecutionCoordinator | null;
  private activeAgent: Agent<TOutput>;
  private terminalResult: RunResult<TOutput> | null = null;
  private emittedItemCount = 0;
  private nextInteractionRequest = 1;
  private readonly identitySequences = new Map<
    Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"],
    number
  >();
  private readonly childHandles = new Set<import("./RunHandle.js").RunHandle>();
  private readonly interactionActions = new Map<string, InteractionActionContext>();
  private readonly interactionSettlements: QueuedInteractionSettlement[] = [];
  private readonly steeringQueue: RunSteeringCommand[] = [];
  private readonly steeringLedger = new Map<string, {
    readonly fingerprint: string;
    readonly command: RunSteeringCommand;
  }>();
  private readonly pendingContextTransitions = new Map<string, ContextTransition>();
  private emittedContextTransitionId: string | null = null;
  private runStartedEventEmitted = false;
  private steeringEpoch = 0;
  private retryProjection: import("./RunHandle.js").RunRetryProjection | null = null;
  private validationExecution: ValidationExecutionPort | null = null;
  private validationRequirements: readonly ValidationRequirement[] = Object.freeze([]);
  private validationClosed = false;
  private validationHostProjection: ValidationHostProjection | null = null;
  private readonly emittedValidationRecordKeys = new Set<string>();
  private readonly toolExposure: RunToolExposureCoordinator;

  constructor(
    private readonly runId: string,
    private readonly dependencies: ResolvedRunnerDependencies,
    agent: Agent<TOutput>,
    private readonly input: RunInput,
    private readonly config: ResolvedRunConfig,
    private readonly lineage: RunLineage,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: ActionExecutionObserver | undefined,
    startedAt: string,
    deadlineAt: string,
    private readonly startDescendantRun: RuntimeDescendantRunStarter,
    private readonly getRunTreeSnapshot: () => RunTreeExecutionSnapshot,
    private readonly onUpdate: (update: RunExecutionUpdate<TOutput>) => void,
  ) {
    this.startedAt = startedAt;
    this.startedAtMs = Date.parse(this.startedAt);
    this.activeAgent = agent;
    this.traceAssembler = createRunnerTraceAssembler({
      runId,
      taskId: input.task.id,
      lineage,
      observers: runTraceObservers,
      createId: dependencies.createId,
    });
    this.eventStream = new RuntimeEventStream({
      runId,
      taskId: input.task.id,
      lineage,
      now: dependencies.now,
      createEventId: ({ sequence }) => dependencies.createId({
        kind: "runtime_event",
        runId,
        sequence,
      }),
      publishers: Object.freeze([
        ...runtimeEventPublishers,
        ...(this.traceAssembler === null ? [] : [this.traceAssembler]),
      ]),
    });
    const initial = createInitialRunState({
      runId,
      agent,
      input,
      config,
      startedAt: this.startedAt,
      deadlineAt,
      activeContextId: this.id("active_context"),
    });
    this.writer = new RunStateWriter(
      initial,
      dependencies.now,
      dependencies.createId,
      (state) => this.onStateCommitted(state),
    );

    const approvalProtocol = createApprovalInteractionProtocol({
      validateDecision: (subject, submission, request) =>
        this.validateApprovalDecision(subject, submission, request.id),
      applyDecision: (subject, resolution, request) =>
        this.applyApprovalDecision(subject, resolution, request.id),
    }) as unknown as CapturedInteractionProtocol;
    this.interactions = new RunInteractionCoordinator({
      runId,
      registry: dependencies.interactions,
      localProtocols: Object.freeze([approvalProtocol]),
      now: dependencies.now,
      createId: (kind, sequence) => dependencies.createId({ kind, runId, sequence }),
      onOpened: (pending) => this.openPendingInteraction(pending),
      onSettled: (pending, terminal, settlement) =>
        this.queueInteractionSettlement(pending, terminal, settlement),
    });
    this.toolExposure = new RunToolExposureCoordinator({
      run: initial.run,
      lineage,
      selection: config.tools,
      operationParticipants: dependencies.operations.availability,
      interactions: this.interactions,
      maxPendingInteractions: config.limits.maxPendingInteractions,
      descendants: dependencies.operations.descendants,
      getRunRevision: () => this.writer.getSnapshot().revision,
      getRunTreeSnapshot,
    });

    this.interruptionCoordinator = new RunInterruptionCoordinator({
      cancellation: config.cancellation.context,
      operationSettlementTimeoutMs: config.cancellationLimits.operationSettlementTimeoutMs,
      now: dependencies.now,
      onCancellationObserved: (request) => this.enterCancelling(request),
    });

    const actionComposition = dependencies.operations.actionExecution;
    this.actionExecution = actionComposition === undefined
      ? null
      : new ActionExecutionCoordinator({
          ...actionComposition,
          permission: createActionPermissionAssessmentPort({
            now: dependencies.now,
            consumeCoverage: (coverageId) => this.consumeApprovalCoverage(coverageId),
          }),
          approval: this.createActionApprovalPort(),
          observer: composeActionExecutionObservers(
            actionComposition.observer,
            actionExecutionObserver,
          ),
          now: dependencies.now,
          createId: (kind) => `${this.id("action")}:${kind}`,
        });
  }

  submitInteraction(input: InteractionSubmissionInput): InteractionSubmissionOutcome {
    const local = this.interactions.submit(input);
    if (local.status !== "rejected" || local.code !== "interaction_not_pending") {
      return local;
    }
    for (const child of this.childHandles) {
      const outcome = child.submitInteraction(input);
      if (outcome.status !== "rejected" || outcome.code !== "interaction_not_pending") {
        return outcome;
      }
    }
    return local;
  }

  submitSteering(input: RunSteeringInput): RunSteeringSubmissionReceipt {
    const state = this.writer.getSnapshot();
    let candidate: RunSteeringInput;
    try {
      candidate = snapshotRunSteeringInput(input);
    } catch {
      return this.rejectSteering(
        typeof input?.commandId === "string" ? input.commandId : "",
        "steering_invalid",
      );
    }
    const fingerprint = JSON.stringify(candidate);
    const previous = this.steeringLedger.get(candidate.commandId);
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? Object.freeze({
            status: "duplicate_identical" as const,
            command: previous.command,
          })
        : this.rejectSteering(candidate.commandId, "steering_command_conflict");
    }
    if (!isActiveStatus(state.status)) {
      return this.rejectSteering(
        candidate.commandId,
        state.status === "cancelling" ? "run_cancelling" : "run_settled",
      );
    }
    if (candidate.expectedRunRevision !== state.revision) {
      return this.rejectSteering(candidate.commandId, "steering_revision_stale");
    }
    if (this.steeringQueue.length >= 64) {
      return this.rejectSteering(candidate.commandId, "steering_queue_full");
    }
    const command: RunSteeringCommand = Object.freeze({
      ...candidate,
      ref: Object.freeze({
        run: state.run,
        commandId: candidate.commandId,
      }),
      acceptedRunRevision: state.revision,
    });
    this.steeringLedger.set(candidate.commandId, Object.freeze({
      fingerprint,
      command,
    }));
    this.steeringQueue.push(command);
    this.steeringEpoch += 1;
    this.interactions.invalidateAll("run_steering_pending");
    return Object.freeze({
      status: "accepted_for_application" as const,
      command,
    });
  }

  async run(): Promise<RunResult<TOutput>> {
    this.interruptionCoordinator.start();
    try {
      const taskContribution = createTaskContextContribution({
        id: this.id("context_contribution"),
        runId: this.runId,
        task: this.input.task,
      });
      this.writer.commitState((current) => Object.freeze({
        status: "running" as const,
        context: this.applyContextContributions(
          current.context,
          Object.freeze([taskContribution]),
          createTaskContextAdmissionProfile(),
          "run_initialization",
          this.runId,
        ),
      }));
      this.emit("run.started", {
        status: "running",
        activeAgentId: this.activeAgent.id,
      }, this.startedAt);
      this.runStartedEventEmitted = true;
      this.emitCommittedContextTransition(this.writer.getSnapshot().context);
      this.emitCommittedRunItems(this.writer.getSnapshot());
      await this.initializeValidation();
      const startFailures = await this.recordLifecycle("started");
      if (startFailures.length > 0) {
        return await this.settle({
          status: "failed",
          code: "required_finalization_failed",
          failure: startFailures[0]!,
          relatedFailures: startFailures.slice(1),
        });
      }

      let controllerTurnCompleted = false;
      while (this.terminalResult === null) {
        this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          return await this.settle({ status: "cancelled" });
        }
        this.drainSteering("apply");
        const deadline = evaluateRunDeadline({
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          now: this.now(),
        });
        if (deadline !== null) return await this.settleLimitViolation(deadline);

        if (controllerTurnCompleted) {
          const progressTerminal = await this.commitProgressCheckpoint();
          controllerTurnCompleted = false;
          if (progressTerminal !== null) return progressTerminal;
        }

        const numericLimit = evaluateRunNumericLimits({
          counters: this.writer.getSnapshot().counters,
          limits: this.config.limits,
        });
        if (numericLimit !== null) return await this.settleLimitViolation(numericLimit);

        const decision = await this.nextDecision();
        if (decision === null) continue;
        controllerTurnCompleted = true;
        const settlementsAfterDecision = this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          return await this.settle({ status: "cancelled" });
        }
        if (settlementsAfterDecision > 0) {
          continue;
        }
        if (this.drainSteering("apply") > 0) {
          continue;
        }
        if (decision.decision.kind === "propose_completion") {
          const completion = await this.evaluateCompletionGate(
            decision.turn,
            decision.decision.output,
          );
          if (completion.kind === "succeeded") {
            return await this.settle({ status: "succeeded", output: decision.decision.output });
          }
          if (completion.kind === "blocked") {
            return await this.settle({ status: "blocked", code: "validation_blocked" });
          }
          if (completion.kind === "failed") {
            return await this.settle({
              status: "failed",
              code: "validation_failed",
              failure: createRunFailureCause("validation", completion.failure),
            });
          }
          if (completion.kind === "cancelled") {
            return await this.settle({ status: "cancelled" });
          }
          continue;
        }
        if (decision.decision.kind === "propose_stop") {
          return await this.settle({
            status: "blocked",
            code: "runtime_no_safe_path",
          });
        }

        const basis: CandidateBasis<TOutput> = {
          turn: decision.turn,
          runRevision: decision.basisRevision,
          activeAgent: decision.agent,
          projection: decision.prepared.context,
          exposure: decision.prepared.input.toolExposure,
          exposureOwnerBasisRevision: decision.exposureOwnerBasisRevision,
        };
        for (let index = 0; index < decision.decision.candidates.length; index += 1) {
          if (this.config.cancellation.context.request !== null) break;
          if (this.drainInteractionSettlements() > 0) break;
          if (this.drainSteering("apply") > 0) break;
          if (index > 0) {
            const currentExposure = await this.toolExposure.resolve(decision.turn.id);
            if (currentExposure.ownerBasisRevision !== basis.exposureOwnerBasisRevision) {
              break;
            }
          }
          const invalidatesRemainder = await this.processCandidate(
            decision.decision.candidates[index]!,
            index,
            basis,
          );
          if (this.terminalResult !== null) return this.terminalResult;
          if (this.drainSteering("apply") > 0) break;
          if (invalidatesRemainder) break;
        }
      }
      return this.terminalResult;
    } catch (error) {
      if (this.terminalResult !== null) return this.terminalResult;
      if (this.config.cancellation.context.request !== null &&
          !(error instanceof OperationSettlementTimeoutError)) {
        return await this.settle({ status: "cancelled" });
      }
      return await this.settle(this.failureFromError(error));
    } finally {
      this.interactions.close();
      this.interruptionCoordinator.dispose();
    }
  }

  private async initializeValidation(): Promise<void> {
    const execution = await this.dependencies.validation.executionFactory.create({
      run: Object.freeze({ id: this.runId }),
      operationChecks: this.createValidationOperationCheckResolver(),
    });
    if (!execution || typeof execution.admitSpecification !== "function") {
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_execution_unavailable",
        stage: "admission",
        message: "Validation execution factory did not create a valid Run-scoped execution.",
        retryable: false,
        cause: this.config.validation.profile.ref,
      }), 0);
    }
    this.validationExecution = execution;
    const materialized = materializeValidationProfile({
      profile: this.config.validation.profile,
      run: { id: this.runId },
      createdAt: this.startedAt,
    });
    this.validationRequirements = materialized.requirements;
    await execution.admitSpecification({
      specification: materialized.specification,
      requirements: materialized.requirements,
      expectedRevision: 0,
    }, this.invocationInterruption());
    try {
      if (this.dependencies.validation.preparation !== null) {
        await this.dependencies.validation.preparation.prepare({
          run: Object.freeze({ id: this.runId }),
          execution,
          automaticEffectfulChecks: this.createAutomaticEffectfulValidationCheckPort(),
        }, this.invocationInterruption());
      }
    } catch (error) {
      if (error instanceof ValidationExecutionError) throw error;
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_preparation_failed",
        stage: "admission",
        message: error instanceof Error ? error.message : "Validation preparation failed.",
        retryable: false,
        cause: this.config.validation.profile.ref,
      }), (await execution.readCurrentSnapshot()).ref.revision);
    }
    await this.commitValidationFeedback(null);
  }

  private async evaluateCompletionGate(
    turn: ControllerTurnRef,
    output: TOutput,
  ): Promise<
    | { readonly kind: "succeeded" | "continue" | "cancelled" | "blocked" }
    | { readonly kind: "failed"; readonly failure: ValidationFailure }
  > {
    const execution = this.requireValidationExecution();
    const runState = this.writer.getSnapshot();
    if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
    if (runState.status !== "running" && runState.status !== "waiting") {
      return { kind: "continue" };
    }
    const current = await execution.readCurrentSnapshot();
    const gateSteeringEpoch = this.steeringEpoch;
    const outputDigest = await createCanonicalSha256Digest(
      "agent-anything.validation.completion-output.v1",
      output,
    );
    const proposal = Object.freeze({
      id: this.id("validation_proposal"),
      revision: outputDigest,
    });
    const invocation = Object.freeze({
      id: this.id("validation_gate"),
      revision: "1",
    });
    const mandatoryStates = current.requirementStates.flatMap((state) => {
      const requirement = this.validationRequirements.find((candidate) =>
        candidate.ref.id === state.requirement.id &&
        candidate.ref.revision === state.requirement.revision);
      if (requirement?.necessity !== "mandatory") return [];
      return [Object.freeze({
        current: state,
        disposition: state.status === "satisfied"
          ? null
          : requirement.completionHandling[state.status],
      })];
    });
    const requestedAt = this.now();
    const configuredDeadline = Date.parse(requestedAt) +
      this.config.validation.completion.maximumDurationMs;
    const deadlineAt = new Date(Math.min(
      Date.parse(runState.deadlineAt),
      configuredDeadline,
    )).toISOString();
    const gateInput = snapshotCompletionGateInput({
      invocation,
      run: runState.run,
      turn,
      proposal,
      proposalOutputDigest: outputDigest,
      outputContract: this.config.validation.completion.outputContract,
      specification: current.specification,
      validationSnapshot: current.ref,
      mandatoryStates,
      pendingWork: mandatoryStates.flatMap((item) =>
        item.current.pendingAttempts.map((attempt) => Object.freeze({
          owner: "validation",
          kind: "check_attempt",
          id: attempt.id,
          revision: String(attempt.ordinal),
        }))),
      conditions: this.config.validation.completion.conditions,
      lifecycle: {
        runRevision: runState.revision,
        status: runState.status,
        cancellationRevision: this.config.cancellation.context.request === null ? 0 : 1,
        deadlineAt,
      },
      policy: this.config.validation.completion.policy,
      correlation: this.config.validation.profile.ref,
      requestedAt,
    });

    let decision: CompletionGateDecision;
    try {
      decision = snapshotCompletionGateDecision(await this.invokeCompletionGate(gateInput));
    } catch (error) {
      if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
      return {
        kind: "failed",
        failure: error instanceof ValidationExecutionError
          ? error.failure
          : createValidationFailure({
              code: "validation_gate_failed",
              stage: "completion_gate",
              message: error instanceof Error ? error.message : "Completion Gate evaluation failed.",
              retryable: false,
              cause: this.config.validation.completion.policy,
            }),
      };
    }
    const afterGate = this.writer.getSnapshot();
    const currentAfterGate = await execution.readCurrentSnapshot();
    if (currentAfterGate.ref.revision !== current.ref.revision ||
        decision.invocation.id !== invocation.id ||
        decision.invocation.revision !== invocation.revision ||
        decision.validationSnapshot.runId !== current.ref.runId ||
        decision.validationSnapshot.revision !== current.ref.revision) {
      return { kind: "continue" };
    }
    const runBasisCurrent = afterGate.revision === runState.revision &&
      this.steeringEpoch === gateSteeringEpoch &&
      this.config.cancellation.context.request === null;
    const inputRevision = await createCanonicalSha256Digest(
      "agent-anything.validation.completion-gate-input.v1",
      gateInput,
    );
    await execution.recordCompletionGate({
      record: { ref: invocation, inputRevision, decision },
      expectedRevision: current.ref.revision,
    }, this.invocationInterruption());
    if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
    if (!runBasisCurrent || this.writer.getSnapshot().revision !== runState.revision) {
      return { kind: "continue" };
    }
    await this.commitValidationFeedback(decision);

    if (decision.status === "completion_eligible") return { kind: "succeeded" };
    if (decision.status === "invalid" || decision.status === "failed") {
      return { kind: "failed", failure: decision.failure };
    }
    if (decision.disposition === "fail") {
      return {
        kind: "failed",
        failure: createValidationFailure({
          code: "validation_completion_policy_failed",
          stage: "completion_gate",
          message: decision.reasons[0].message,
          retryable: false,
          cause: this.config.validation.completion.policy,
        }),
      };
    }
    if (decision.disposition === "block") return { kind: "blocked" };
    if (decision.disposition === "wait" && gateInput.pendingWork.length === 0) {
      return {
        kind: "failed",
        failure: createValidationFailure({
          code: "validation_gate_wait_without_pending_work",
          stage: "completion_gate",
          message: "Completion Gate requested waiting without exact active pending work.",
          retryable: false,
          cause: this.config.validation.completion.policy,
        }),
      };
    }
    return { kind: "continue" };
  }

  private async invokeCompletionGate(input: CompletionGateInput): Promise<CompletionGateDecision> {
    const delay = Math.max(
      1,
      Date.parse(input.lifecycle.deadlineAt!) - Date.parse(input.requestedAt),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const interruption = this.invocationInterruption();
    let removeAbortListener: (() => void) | undefined;
    const timedOut = new Promise<CompletionGateDecision>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ValidationExecutionError(
        createValidationFailure({
          code: "validation_gate_timed_out",
          stage: "completion_gate",
          message: "Completion Gate evaluation exceeded its deadline.",
          retryable: true,
          cause: this.config.validation.completion.policy,
        }),
        input.validationSnapshot.revision,
      )), delay);
    });
    const cancelled = new Promise<CompletionGateDecision>((_resolve, reject) => {
      const onAbort = () => reject(new ValidationExecutionError(
        createValidationFailure({
          code: "validation_gate_cancelled",
          stage: "completion_gate",
          message: "Completion Gate evaluation was cancelled.",
          retryable: false,
          cause: this.config.validation.completion.policy,
        }),
        input.validationSnapshot.revision,
      ));
      if (interruption.signal.aborted) onAbort();
      else {
        interruption.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => interruption.signal.removeEventListener("abort", onAbort);
      }
    });
    try {
      return await Promise.race([
        this.dependencies.validation.completionGate.evaluate(
          input,
          interruption,
        ),
        timedOut,
        cancelled,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeAbortListener?.();
    }
  }

  private async commitValidationFeedback(
    decision: CompletionGateDecision | null,
  ): Promise<void> {
    const runState = this.writer.getSnapshot();
    if (this.config.cancellation.context.request !== null ||
        this.terminalResult !== null ||
        (runState.status !== "running" && runState.status !== "waiting")) {
      return;
    }
    const execution = this.requireValidationExecution();
    await this.emitValidationRecords(execution);
    const projection = await execution.projectRunner();
    const contextProjection = await execution.projectContext({
      maxPayloadBytes: this.dependencies.contextProjection.maxContributionPayloadBytes,
    });
    const hostProjection = await execution.projectHost();
    if (projection.snapshot.runId !== this.runId ||
        contextProjection.snapshot.runId !== this.runId ||
        contextProjection.snapshot.revision !== projection.snapshot.revision) {
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_projection_mismatch",
        stage: "projection",
        message: "Validation projections do not describe the current Run snapshot.",
        retryable: false,
        cause: null,
      }), projection.snapshot.revision);
    }
    if (hostProjection.snapshot.runId !== this.runId ||
        hostProjection.snapshot.revision !== projection.snapshot.revision) {
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_host_projection_mismatch",
        stage: "projection",
        message: "Validation Host projection does not match the current Run snapshot.",
        retryable: false,
        cause: null,
      }), projection.snapshot.revision);
    }
    this.validationHostProjection = hostProjection;
    this.writer.commit({
      kind: "validation_feedback",
      validation: projection,
    }, (current) => Object.freeze({
      status: decision?.disposition === "wait"
        ? "waiting" as const
        : current.status === "waiting"
          ? "running" as const
          : current.status,
      validation: Object.freeze({
        snapshot: projection.snapshot,
        gate: projection.gate,
      }),
      context: contextProjection.contribution === null
        ? current.context
        : this.applyContextContributions(
            current.context,
            Object.freeze([contextProjection.contribution]),
            createValidationContextAdmissionProfile(),
            "validation_feedback",
            projection.gate?.id ?? null,
          ),
    }));
  }

  private async emitValidationRecords(execution: ValidationExecutionPort): Promise<void> {
    const history = await execution.readHistory();
    const snapshotRevision = (await execution.readCurrentSnapshot()).ref.revision;
    for (const item of history) {
      if (item.kind === "check_attempt") {
        const key = `check_attempt:${item.record.ref.id}:${item.record.ref.ordinal}`;
        if (this.emittedValidationRecordKeys.has(key) || item.record.startedAt === null) continue;
        this.emittedValidationRecordKeys.add(key);
        this.emit("validation.check.started", {
          snapshotRevision,
          attemptId: item.record.ref.id,
          requirementId: item.record.requirement.id,
          origin: item.record.origin,
        }, item.record.startedAt);
      } else if (item.kind === "check_result") {
        const key = `check_result:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedValidationRecordKeys.has(key)) continue;
        this.emittedValidationRecordKeys.add(key);
        this.emit("validation.check.finished", {
          snapshotRevision,
          attemptId: item.record.attempt.id,
          status: item.record.status,
          code: item.record.failure?.code ?? null,
          durationMs: Date.parse(item.record.finishedAt) - Date.parse(item.record.startedAt),
          coverageRatio: item.record.coverage.ratio,
        }, item.record.finishedAt);
      } else if (item.kind === "assessment") {
        const key = `assessment:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedValidationRecordKeys.has(key)) continue;
        this.emittedValidationRecordKeys.add(key);
        this.emit("validation.assessment.committed", {
          snapshotRevision,
          requirementId: item.record.requirement.id,
          assessmentId: item.record.ref.id,
          verdict: item.record.verdict,
        }, item.record.assessedAt);
      } else if (item.kind === "completion_gate") {
        const key = `completion_gate:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedValidationRecordKeys.has(key)) continue;
        this.emittedValidationRecordKeys.add(key);
        this.emit("validation.gate.evaluated", {
          snapshotRevision,
          gateId: item.record.ref.id,
          status: item.record.decision.status,
          disposition: item.record.decision.disposition,
          reasonCodes: Object.freeze(item.record.decision.reasons.map((reason) => reason.code)),
        }, item.record.decision.decidedAt);
      }
    }
  }

  private requireValidationExecution(): ValidationExecutionPort {
    if (this.validationExecution === null) {
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_execution_unavailable",
        stage: "admission",
        message: "Run-scoped Validation execution is not initialized.",
        retryable: false,
        cause: this.config.validation.profile.ref,
      }), 0);
    }
    return this.validationExecution;
  }

  private createValidationOperationCheckResolver(): ValidationOperationCheckResolverPort {
    return Object.freeze({
      resolve: (definition: import("@agent-anything/validation/execution").CheckDefinition) => definition.effect.kind === "effectful"
        ? Object.freeze({
            requestSettlement: (
              input: ValidationOperationCheckInput,
              interruption: InvocationInterruptionContext,
            ) => this.executeValidationOperationCheck(input, interruption),
          })
        : null,
    });
  }

  private createAutomaticEffectfulValidationCheckPort(): RunnerAutomaticEffectfulValidationCheckPort {
    return Object.freeze({
      execute: async (
        request: RunnerAutomaticEffectfulValidationCheckRequest,
        interruption: InvocationInterruptionContext,
      ) => {
        const execution = this.requireValidationExecution();
        const current = await execution.readCurrentSnapshot();
        const invocationId = this.id("operation_invocation");
        const action = this.materializeAutomaticValidationRunAction(
          request.definition.id,
          invocationId,
        );
        const result = await execution.executeCheck({
          ...request,
          origin: "trusted_automatic",
          runAction: action.ref,
          expectedRevision: current.ref.revision,
        }, interruption);
        await this.processValidationCheckResult(request, result, interruption);
        return result;
      },
    });
  }

  private async executeValidationOperationCheck(
    input: ValidationOperationCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ValidationLowerCheckSettlement> {
    if (input.definition.effect.kind !== "effectful") {
      return this.rejectValidationOperationCheck(
        "validation_operation_check_binding_invalid",
        "An operation-backed Validation Check requires an effectful definition.",
      );
    }
    if (interruption.signal.aborted || this.config.cancellation.context.request !== null) {
      return this.rejectValidationOperationCheck(
        "validation_operation_check_cancelled",
        "Validation operation Check was cancelled before dispatch.",
      );
    }
    if (input.attempt.runAction === null) {
      return this.rejectValidationOperationCheck(
        "validation_effectful_check_action_required",
        "An effectful Validation Check requires a Runner-materialized RunAction.",
      );
    }
    const action = this.findRunAction(input.attempt.runAction);
    if (action === null) {
      return this.rejectValidationOperationCheck(
        "validation_run_action_missing",
        "Validation Check references a RunAction that is not committed in this Run.",
      );
    }
    if (action.subject.kind !== "operation" || action.subject.invocationId === null) {
      return this.rejectValidationOperationCheck(
        "validation_run_action_subject_invalid",
        "An operation-backed Validation Check requires an Operation RunAction.",
      );
    }
    const invocationId = action.subject.invocationId;
    const automatic = action.provenance.kind === "automatic";

    const result = await this.executeOperation({
      action,
      operation: input.definition.effect.operationBinding.operation,
      request: Object.freeze({
        requirement: input.requirement.ref,
        subject: input.subject.ref,
        checkDefinition: input.definition.ref,
        attempt: input.attempt.ref,
        configuration: input.attempt.configuration,
      }),
      requestOrigin: automatic ? "automatic_stage" : "controller_protocol",
      invocationId,
      parentInvocation: null,
      basis: Object.freeze({
        owner: "validation",
        kind: "check_attempt",
        id: input.attempt.ref.id,
        revision: String(input.attempt.ref.ordinal),
      }),
    });
    if (result === null) {
      return this.rejectValidationOperationCheck(
        "validation_operation_check_unavailable",
        "Validation Check Operation could not be dispatched.",
      );
    }
    this.commitOperationObservation(action, Object.freeze({ result, toolResult: null }));
    const settlementRef = result.lowerRefs.find((reference) =>
      reference.owner === "canonical-action" && reference.kind === "action_settlement");
    const actionId = typeof result.metadata.actionId === "string"
      ? result.metadata.actionId
      : null;
    const effectCertainty = isActionEffectCertainty(result.metadata.effectCertainty)
      ? result.metadata.effectCertainty
      : result.status === "succeeded"
        ? "confirmed"
        : result.status === "partial"
          ? "partial"
          : result.status === "unknown_effect"
            ? "unknown"
            : "none";
    return Object.freeze({
      operationInvocation: result.ref.invocation,
      operationResult: result,
      actionSettlement: settlementRef === undefined || actionId === null
        ? null
        : Object.freeze({ action: Object.freeze({ id: actionId }), id: settlementRef.id }),
      effectCertainty,
      costUnits: typeof result.metadata.costUnits === "number" &&
          Number.isFinite(result.metadata.costUnits) && result.metadata.costUnits >= 0
        ? result.metadata.costUnits
        : null,
    });
  }

  private materializeAutomaticValidationRunAction(
    checkAttemptId: string,
    invocationId: string,
  ): RuntimeRunAction {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.runActions + 1;
    const action: RuntimeRunAction = Object.freeze({
      ref: Object.freeze({
        run: state.run,
        id: this.id("run_action", sequence),
        sequence,
      }),
      provenance: Object.freeze({
        kind: "automatic" as const,
        trigger: Object.freeze({ owner: "validation", operationId: checkAttemptId }),
      }),
      subject: Object.freeze({
        kind: "operation" as const,
        invocationId,
        requestOrigin: "automatic_stage" as const,
      }),
      basis: Object.freeze({
        runRevision: state.revision,
        activeAgentId: state.activeAgent.id,
        controllerProjectionRevision: null,
      }),
      materializedAt: this.now(),
    });
    this.writer.commit({ kind: "run_action", action }, (current) => Object.freeze({
      counters: Object.freeze({ ...current.counters, runActions: sequence }),
    }));
    return action;
  }

  private findRunAction(ref: RunActionRef): RuntimeRunAction | null {
    if (ref.run.id !== this.runId) return null;
    for (const item of this.writer.getSnapshot().items) {
      if (item.payload.kind !== "run_action") continue;
      const candidate = item.payload.action;
      if (candidate.ref.id === ref.id && candidate.ref.sequence === ref.sequence) {
        return candidate;
      }
    }
    return null;
  }

  private async rejectValidationOperationCheck(
    code: `validation_${string}`,
    message: string,
  ): Promise<never> {
    const revision = this.validationExecution === null
      ? 0
      : (await this.validationExecution.readCurrentSnapshot()).ref.revision;
    throw new ValidationExecutionError(createValidationFailure({
      code,
      stage: "check",
      message,
      retryable: false,
      cause: null,
    }), revision);
  }

  private async nextDecision(): Promise<{
    readonly decision: ControllerDecision<TOutput>;
    readonly turn: ControllerTurnRef;
    readonly basisRevision: number;
    readonly agent: Agent<TOutput>;
    readonly prepared: PreparedControllerOperation<TOutput>;
    readonly exposureOwnerBasisRevision: string;
  } | null> {
    this.synchronizeCurrentContext();
    const state = this.writer.getSnapshot();
    const iteration = state.counters.controllerTurns + 1;
    const turn: ControllerTurnRef = Object.freeze({
      run: state.run,
      id: this.id("controller_turn", iteration),
      sequence: iteration,
    });
    let resolvedExposure;
    try {
      resolvedExposure = await this.toolExposure.resolve(turn.id);
    } catch (error) {
      if (error instanceof ToolExposureBasisChangedError) return null;
      throw error;
    }
    if (resolvedExposure.runRevision !== state.revision) return null;
    const exposure = resolvedExposure.proof;
    let prepared: PreparedControllerOperation<TOutput>;
    try {
      prepared = prepareControllerOperation({
        agent: this.activeAgent,
        runInput: this.input,
        config: this.config,
        state,
        iteration,
        exposure,
        contextProjection: this.dependencies.contextProjection,
        requestedAt: this.now(),
      });
      await this.persistSafeContextManifest(prepared.manifest, "projected", null);
      this.emitContextProjectionCompleted(prepared.manifest, "projected", null);
    } catch (error) {
      if (error instanceof ContextProjectionPreparationError) {
        await this.persistSafeContextManifest(
          error.manifest,
          "blocked",
          error.projectionFailure.code,
        );
        this.emitContextProjectionCompleted(
          error.manifest,
          "blocked",
          error.projectionFailure.code,
        );
      }
      throw error;
    }
    this.emit("controller.started", { turnId: turn.id, iteration });
    try {
      const candidate = await this.interruptionCoordinator.execute(
        "controller",
        () => executeControllerOperation({
          dependencies: this.dependencies,
          prepared,
          config: this.config,
          retryEvents: this.retryEvents(),
        }),
        state.deadlineAt,
      );
      let currentExposure;
      try {
        currentExposure = await this.toolExposure.resolve(turn.id);
      } catch (error) {
        if (!(error instanceof ToolExposureBasisChangedError)) throw error;
        currentExposure = null;
      }
      const stale = currentExposure === null ||
        this.writer.getSnapshot().revision !== state.revision ||
        currentExposure.exposure.basis.revision !== resolvedExposure.exposure.basis.revision ||
        this.interactionSettlements.length > 0 ||
        this.steeringQueue.length > 0 ||
        this.config.cancellation.context.request !== null;
      if (stale) {
        this.writer.commit({
          kind: "controller_turn",
          turn,
          status: "interrupted",
          decisionKind: null,
          toolExposure: controllerToolExposureRecord(exposure, prepared.manifest.id),
          modelItems: Object.freeze([]),
          failure: null,
        }, (current) => Object.freeze({
          counters: Object.freeze({
            ...current.counters,
            controllerTurns: iteration,
          }),
        }));
        this.emit("controller.finished", {
          turnId: turn.id,
          iteration,
          status: "interrupted",
          code: "tool_exposure_basis_stale",
          decisionKind: null,
        });
        return null;
      }
      const decision = validateControllerDecision(candidate, prepared.input);
      this.writer.commit({
        kind: "controller_turn",
        turn,
        status: "decided",
        decisionKind: decision.kind,
        toolExposure: controllerToolExposureRecord(exposure, prepared.manifest.id),
        modelItems: decision.modelItems,
        failure: null,
      }, (current) => Object.freeze({
        counters: Object.freeze({
          ...current.counters,
          controllerTurns: iteration,
        }),
      }));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "decided",
        code: null,
        decisionKind: decision.kind,
      });
      return Object.freeze({
        decision,
        turn,
        basisRevision: state.revision,
        agent: this.activeAgent,
        prepared,
        exposureOwnerBasisRevision: resolvedExposure.ownerBasisRevision,
      });
    } catch (error) {
      if (this.config.cancellation.context.request !== null) throw error;
      const terminal = this.failureFromError(error);
      this.writer.commit({
        kind: "controller_turn",
        turn,
        status: "failed",
        decisionKind: null,
        toolExposure: controllerToolExposureRecord(exposure, prepared.manifest.id),
        modelItems: Object.freeze([]),
        failure: terminal.failure,
      }, (current) => Object.freeze({
        counters: Object.freeze({
          ...current.counters,
          controllerTurns: iteration,
        }),
      }));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "failed",
        code: terminal.failure.failure.code,
        decisionKind: null,
      });
      throw error;
    }
  }

  private async commitProgressCheckpoint(): Promise<RunResult<TOutput> | null> {
    const before = this.writer.getSnapshot();
    const proposed = await assessCommittedRunProgress({
      state: before,
      config: this.config,
    });
    if (this.config.cancellation.context.request !== null) {
      return this.settle({ status: "cancelled" });
    }
    const deadline = evaluateRunDeadline({
      deadlineAt: before.deadlineAt,
      now: this.now(),
    });
    if (deadline !== null) return this.settleLimitViolation(deadline);

    const nonAdvancing = proposed.assessment.disposition === "unchanged" ||
      proposed.assessment.disposition === "repeated";
    const thresholdReached = nonAdvancing && (
      proposed.state.activeCorrectionRound !== null ||
      proposed.state.consecutiveNonAdvancingCheckpoints >=
        this.config.limits.progress.nonAdvancingCheckpointThreshold
    );
    if (!thresholdReached) {
      this.writer.commit({
        kind: "progress_assessment",
        assessment: proposed.assessment,
      }, (current) => Object.freeze({
        progress: proposed.state,
        context: before.progress.activeCorrectionRound !== null &&
            proposed.state.activeCorrectionRound === null
          ? this.clearProgressCorrectionContext(current.context)
          : current.context,
      }));
      return null;
    }

    if (proposed.state.correctionRounds >= this.config.limits.progress.maxCorrectionRounds) {
      this.writer.commit({
        kind: "progress_assessment",
        assessment: proposed.assessment,
      }, () => Object.freeze({ progress: proposed.state }));
      return this.settle({ status: "blocked", code: "runtime_no_progress" });
    }

    const correctionRound = proposed.state.correctionRounds + 1;
    const feedback: RunProgressCorrectionFeedback = Object.freeze({
      assessment: proposed.assessment.ref,
      correctionRound,
      reasonCode: proposed.assessment.reasonCode,
      factRefs: proposed.assessment.factRefs,
    });
    const progress: RunProgressState = Object.freeze({
      ...proposed.state,
      correctionRounds: correctionRound,
      activeCorrectionRound: correctionRound,
    });
    const assessment = Object.freeze({
      ...proposed.assessment,
      correctionRounds: correctionRound,
      activeCorrectionRound: correctionRound,
    });
    const contribution = createProgressCorrectionContextContribution({
      id: this.currentContextContributionId(
        before.context,
        "agent-runtime",
        "run_progress_correction",
      ) ?? this.id("context_contribution"),
      revision: String(correctionRound),
      runId: this.runId,
      feedback,
      createdAt: this.now(),
    });
    this.writer.commitItems(Object.freeze([
      { kind: "progress_assessment", assessment },
      { kind: "progress_correction", feedback },
    ]), (current) => Object.freeze({
      progress,
      context: this.applyContextContributions(
        current.context,
        Object.freeze([contribution]),
        createProgressCorrectionContextAdmissionProfile(),
        "run_progress_correction",
        `${this.runId}:${correctionRound}`,
      ),
    }));
    return null;
  }

  private async settleLimitViolation(
    violation: RunLimitViolation,
  ): Promise<RunResult<TOutput>> {
    return this.settle({
      status: "failed",
      code: violation.code,
      failure: runtimeFailure(violation.code, violation.message, violation.metadata),
    });
  }

  private synchronizeCurrentContext(): void {
    const state = this.writer.getSnapshot();
    const runStateId = this.currentContextContributionId(state.context, "agent-runtime", "run_state")
      ?? this.id("context_contribution");
    const planId = this.currentContextContributionId(state.context, "agent-runtime", "run_plan")
      ?? this.id("context_contribution");
    const revision = String(state.revision + 1);
    const contributions = createCurrentRunContextContributions({
      runStateId,
      planId,
      revision,
      state,
      plan: state.plan === null ? null : projectPlan(state.plan),
      createdAt: this.now(),
    });
    this.writer.commitState((current) => Object.freeze({
      context: this.applyContextContributions(
        current.context,
        contributions,
        createCurrentRunContextAdmissionProfile(),
        "controller_context_prepared",
        null,
      ),
    }));
  }

  private currentContextContributionId(
    context: ActiveContext,
    owner: string,
    replacementKey: string,
  ): string | null {
    const item = context.items.find((candidate) =>
      "contribution" in candidate &&
      candidate.lifecycle.kind === "active" &&
      candidate.contribution.source.owner === owner &&
      candidate.contribution.handling.replacementKey === replacementKey
    );
    return item !== undefined && "contribution" in item
      ? item.contribution.ref.id
      : null;
  }

  private clearProgressCorrectionContext(context: ActiveContext): ActiveContext {
    const current = context.items.find((item) =>
      "contribution" in item &&
      item.lifecycle.kind === "active" &&
      item.contribution.source.owner === "agent-runtime" &&
      item.contribution.handling.replacementKey === "run_progress_correction"
    );
    if (current === undefined || !("contribution" in current)) return context;
    return this.applyContextOperations(
      context,
      Object.freeze([Object.freeze({
        kind: "invalidate" as const,
        item: current.ref,
        expectedContribution: current.contribution.ref,
        reason: "run_progress_recovered",
      })]),
      createProgressCorrectionContextAdmissionProfile(),
      "run_progress_recovered",
      this.runId,
    );
  }

  private async processCandidate(
    candidate: ProgressionCandidate,
    index: number,
    basis: CandidateBasis<TOutput>,
  ): Promise<boolean> {
    const state = this.writer.getSnapshot();
    if (state.counters.runActions >= this.config.limits.maxActions) {
      return true;
    }
    const reservedId = candidate.kind === "operation_request"
      ? this.id("operation_invocation")
      : candidate.kind === "interaction_request"
        ? this.id("interaction_request", this.nextInteractionRequest++)
        : candidate.kind === "tool_request"
          ? this.id("tool_call")
        : null;
    const action = this.materializeControllerRunAction(
      candidate,
      index,
      basis,
      reservedId,
    );

    switch (candidate.kind) {
      case "state_transition":
        return candidate.transition === "plan_update"
          ? (await this.applyPlanCandidate(action, candidate.input), false)
          : this.applyHandoffCandidate(action, candidate.input, basis);
      case "interaction_request":
        return this.applyInteractionCandidate(action, candidate, reservedId!);
      case "tool_request":
        return this.executeToolCandidate(action, candidate, reservedId!, basis.exposure);
      case "operation_request": {
        const outcome = await this.executeOperationCandidate(
          action,
          candidate,
          reservedId!,
        );
        if (outcome !== null) {
          this.commitOperationObservation(action, outcome);
          await this.processSettledOperationValidation(
            action,
            candidate.operation,
            candidate.request,
            "controller_protocol",
            outcome.result,
          );
          if (outcome.result.status === "unknown_effect") {
            await this.settle({
              status: "failed",
              code: "unknown_effect",
              failure: createRunFailureCause("operation", outcome.result.failure),
            });
            return true;
          }
        }
        return false;
      }
    }
  }

  private materializeControllerRunAction(
    candidate: ProgressionCandidate,
    candidateIndex: number,
    basis: CandidateBasis<TOutput>,
    reservedId: string | null,
  ): RuntimeRunAction {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.runActions + 1;
    const ref = Object.freeze({
      run: state.run,
      id: this.id("run_action", sequence),
      sequence,
    });
    const subject = candidate.kind === "state_transition"
      ? Object.freeze({
          kind: "state_transition" as const,
          transition: candidate.transition,
        })
      : candidate.kind === "operation_request"
        ? Object.freeze({
            kind: "operation" as const,
            invocationId: reservedId,
            requestOrigin: candidate.origin,
          })
        : candidate.kind === "tool_request"
          ? Object.freeze({
              kind: "tool" as const,
              toolCallId: reservedId!,
            })
        : Object.freeze({
            kind: "interaction" as const,
            request: Object.freeze({
              id: reservedId!,
              protocol: candidate.protocol,
              requestVersion: candidate.requestVersion,
              subject: candidate.subjectRef,
            }),
          });
    const action: RuntimeRunAction = Object.freeze({
      ref,
      provenance: Object.freeze({
        kind: "controller" as const,
        turn: basis.turn,
        candidateIndex,
      }),
      subject,
      basis: Object.freeze({
        runRevision: basis.runRevision,
        activeAgentId: basis.activeAgent.id,
        controllerProjectionRevision: String(basis.runRevision),
      }),
      materializedAt: this.now(),
    });
    this.writer.commit({ kind: "run_action", action }, (current) => Object.freeze({
      counters: Object.freeze({
        ...current.counters,
        runActions: sequence,
      }),
    }));
    return action;
  }

  private materializeWorkflowRunAction(input: {
    readonly operation: OperationRevisionRef;
    readonly invocationId: string;
    readonly compositeId: string;
    readonly nodeId: string;
  }): RuntimeRunAction {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.runActions + 1;
    const ref = Object.freeze({
      run: state.run,
      id: this.id("run_action", sequence),
      sequence,
    });
    const provenance: RunActionProvenance = Object.freeze({
      kind: "trusted_workflow",
      workflow: Object.freeze({ owner: "operation-composition", invocationId: input.compositeId }),
      nodeRef: input.nodeId,
    });
    const action: RuntimeRunAction = Object.freeze({
      ref,
      provenance,
      subject: Object.freeze({
        kind: "operation",
        invocationId: input.invocationId,
        requestOrigin: "composite",
      }),
      basis: Object.freeze({
        runRevision: state.revision,
        activeAgentId: state.activeAgent.id,
        controllerProjectionRevision: null,
      }),
      materializedAt: this.now(),
    });
    this.writer.commit({ kind: "run_action", action }, (current) => Object.freeze({
      counters: Object.freeze({ ...current.counters, runActions: sequence }),
    }));
    return action;
  }

  private async applyPlanCandidate(action: RuntimeRunAction, candidate: unknown): Promise<void> {
    const state = this.writer.getSnapshot();
    const result = state.plan === null
      ? applyPlanUpdate({
          currentPlan: null,
          newPlanId: this.id("plan"),
          candidate,
          limits: this.config.limits.plan,
          now: this.now(),
        })
      : applyPlanUpdate({
          currentPlan: state.plan,
          candidate,
          limits: this.config.limits.plan,
          now: this.now(),
        });
    if (result.status === "applied") {
      this.writer.commit({
        kind: "state_transition",
        transition: "plan",
        previousRevision: state.plan?.version ?? null,
        plan: projectPlan(result.plan),
      }, () => Object.freeze({ plan: result.plan }));
    }
    this.commitObservation(action, {
      kind: "plan_update",
      result: result.observation,
    }, [], "runtime");
  }

  private async applyHandoffCandidate(
    action: RuntimeRunAction,
    request: SameRunHandoffRequest,
    basis: CandidateBasis<TOutput>,
  ): Promise<boolean> {
    const state = this.writer.getSnapshot();
    const rejected = (code: string): boolean => {
      this.commitObservation(action, {
        kind: "handoff",
        status: "rejected",
        code,
      }, [], "agent-runtime");
      return true;
    };
    if (
      request.expectedRunRevision !== basis.runRevision ||
      !sameAgentRef(request.currentAgent, basis.activeAgent) ||
      !sameAgentRef(request.currentAgent, state.activeAgent)
    ) return rejected("handoff_basis_stale");
    if (sameAgentRef(request.currentAgent, request.targetAgent)) {
      return rejected("handoff_target_unchanged");
    }
    if (this.dependencies.agents === undefined) {
      return rejected("handoff_agent_resolver_unavailable");
    }
    const resolution = await this.dependencies.agents.resolve(request.targetAgent);
    if (
      resolution.status !== "admitted" ||
      resolution.agent === null ||
      resolution.admissionEvidenceRef !== request.admissionEvidenceRef ||
      !sameAgentRef(resolution.agent, request.targetAgent)
    ) return rejected(resolution.code ?? "handoff_agent_not_admitted");

    const previous = state.activeAgent;
    const nextAgent = resolution.agent as Agent<TOutput>;
    const nextContext = this.handoffContext(
      request.transferPolicy,
      state.context,
      basis.projection,
    );
    this.activeAgent = nextAgent;
    this.writer.commit({
      kind: "state_transition",
      transition: "active_agent",
      previousAgent: previous,
      activeAgent: toAgentRevisionRef(nextAgent),
      reason: request.reason,
    }, () => Object.freeze({
      activeAgent: toAgentRevisionRef(nextAgent),
      context: nextContext,
    }));
    this.commitObservation(action, {
      kind: "handoff",
      status: "applied",
      code: null,
    }, [{
      owner: "agent-runtime",
      kind: "agent_admission_evidence",
      id: request.admissionEvidenceRef,
      revision: request.targetAgent.revision,
    }], "agent-runtime");
    return true;
  }

  private handoffContext(
    policy: SameRunHandoffRequest["transferPolicy"],
    context: ActiveContext,
    projection: ContextProjection,
  ): ActiveContext {
    if (policy === "all_context") return context;
    const retained = policy === "bounded_context"
      ? new Set(projection.blocks.map((block) => block.item.id))
      : new Set<string>();
    const operations: ContextTransitionOperation[] = context.items.flatMap((item) =>
      "contribution" in item && item.lifecycle.kind === "active" && !retained.has(item.ref.id)
        ? [Object.freeze({
            kind: "invalidate" as const,
            item: item.ref,
            expectedContribution: item.contribution.ref,
            reason: policy === "fresh_context" ? "handoff_fresh_context" : "handoff_bounded_context",
          })]
        : []
    );
    const admission: ContextAdmissionProfile = Object.freeze({
      ref: Object.freeze({ id: "agent-runtime:handoff-context", revision: "1" }),
      owner: "agent-runtime",
      sourceKinds: Object.freeze(["handoff"]),
      disclosure: Object.freeze({ sensitivity: "public", audiences: Object.freeze([]) }),
      retention: Object.freeze(["history" as const]),
      instructionRoles: Object.freeze(["data" as const]),
      necessities: Object.freeze(["optional" as const]),
      maximumPrecedence: 0,
      transformations: Object.freeze([]),
    });
    return this.applyContextOperations(
      context,
      operations,
      admission,
      "handoff_context_transfer",
      null,
    );
  }

  private async applyInteractionCandidate(
    action: RuntimeRunAction,
    candidate: InteractionRequestCandidate,
    requestId: string,
  ): Promise<boolean> {
    const opened = this.interactions.open({
      requestId,
      protocol: candidate.protocol,
      subject: candidate.subject,
      subjectRef: candidate.subjectRef,
      correlation: this.runActionCorrelation(action),
      parentRunAction: action.ref,
      presentation: candidate.presentation,
      requestVersion: candidate.requestVersion,
      expiresAt: candidate.expiresAt,
      blockingScope: candidate.blockingScope,
      createdAt: this.now(),
    });
    if (opened.status !== "opened") {
      this.commitObservation(action, {
        kind: "interaction",
        owner: opened.owner,
        status: "failed",
        contentDigest: null,
        value: Object.freeze({ code: opened.code }),
        toolResult: null,
      }, [], opened.owner);
      return candidate.blockingScope !== "none";
    }
    this.interactionActions.set(
      interactionRequestKey(opened.pending.request),
      Object.freeze({ action, toolCall: null }),
    );
    if (candidate.blockingScope === "none") return false;
    const settlement = await opened.completion;
    this.drainInteractionSettlements();
    if (this.interactionActions.delete(interactionRequestKey(opened.pending.request))) {
      this.commitInteractionObservation(action, settlement, null);
    }
    return true;
  }

  private async executeToolCandidate(
    action: RuntimeRunAction,
    candidate: ToolRequestCandidate,
    toolCallId: string,
    exposure: ToolExposureProof,
  ): Promise<boolean> {
    const materialized = materializeToolCall({
      candidate: candidate.tool,
      selection: this.config.tools,
      exposure,
      parentRunAction: action.ref,
      toolCallId,
      createdAt: this.now(),
      validateInput: this.dependencies.operations.validateToolInput,
    });
    if (materialized.status === "rejected") {
      this.commitObservation(action, {
        kind: "tool_rejected",
        code: materialized.code,
        message: materialized.message,
      }, [], "tools");
      return false;
    }
    const call = materialized.call;
    switch (call.binding.kind) {
      case "operation": {
        const result = await this.executeOperation({
          action,
          operation: call.binding.operation,
          request: call.input,
          requestOrigin: call.origin === "model" ? "tool_request" : "trusted_workflow",
          invocationId: this.id("operation_invocation"),
          parentInvocation: null,
          basis: call,
        });
        if (result !== null) {
          this.commitOperationObservation(action, {
            result,
            toolResult: adaptToolResult(call, result),
          });
          await this.processSettledOperationValidation(
            action,
            call.binding.operation,
            call.input,
            call.origin === "model" ? "tool_request" : "trusted_workflow",
            result,
          );
          if (result.status === "unknown_effect") {
            await this.settle({
              status: "failed",
              code: "unknown_effect",
              failure: createRunFailureCause("operation", result.failure),
            });
            return true;
          }
        }
        return false;
      }
      case "interaction":
        return this.executeToolInteraction(action, call);
      case "descendant_agent":
        await this.executeToolDescendant(action, call);
        return false;
    }
    return false;
  }

  private async executeToolInteraction(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<boolean> {
    if (call.binding.kind !== "interaction") return false;
    const requestId = this.id("interaction_request", this.nextInteractionRequest++);
    const opened = this.interactions.open({
      requestId,
      protocol: call.binding.protocol,
      subject: call.input,
      subjectRef: Object.freeze({
        owner: call.binding.protocol.owner,
        kind: `${call.binding.protocol.kind}_tool_call`,
        id: call.toolCallId,
        revision: call.toolRevision.revision,
      }),
      correlation: this.runActionCorrelation(action),
      parentRunAction: action.ref,
      presentation: call.input,
      requestVersion: 1,
      expiresAt: null,
      blockingScope: call.binding.blockingScope,
      createdAt: call.createdAt,
    });
    if (opened.status !== "opened") {
      const result = failedToolResult(
        call,
        Object.freeze({ owner: opened.owner, kind: "interaction_request", id: requestId, revision: "1" }),
        opened.code,
        opened.message,
        call.createdAt,
        this.now(),
      );
      this.commitObservation(action, {
        kind: "interaction",
        owner: opened.owner,
        status: "failed",
        contentDigest: null,
        value: Object.freeze({ code: opened.code }),
        toolResult: result,
      }, [toolResultLowerRef(result)], opened.owner);
      return call.binding.blockingScope !== "none";
    }
    this.interactionActions.set(
      interactionRequestKey(opened.pending.request),
      Object.freeze({ action, toolCall: call }),
    );
    if (call.binding.blockingScope === "none") return false;
    const settlement = await opened.completion;
    this.drainInteractionSettlements();
    if (this.interactionActions.delete(interactionRequestKey(opened.pending.request))) {
      this.commitInteractionObservation(action, settlement, call);
    }
    return true;
  }

  private async executeOperationCandidate(
    action: RuntimeRunAction,
    candidate: OperationRequestCandidate,
    invocationId: string,
  ): Promise<OperationExecutionOutcome | null> {
    const operation = candidate.operation;
    const request = candidate.request;
    const requestOrigin: OperationRequestOrigin = "controller_protocol";
    const executed = await this.executeOperation({
      action,
      operation: operation!,
      request,
      requestOrigin,
      invocationId,
      parentInvocation: null,
      basis: candidate,
    });
    if (executed === null) return null;
    return Object.freeze({ result: executed, toolResult: null });
  }

  private async processSettledOperationValidation(
    action: RuntimeRunAction,
    operation: OperationRevisionRef,
    request: unknown,
    requestOrigin: OperationRequestOrigin,
    result: OperationResult,
  ): Promise<void> {
    const processor = this.dependencies.validation.settledOperationResults;
    if (processor === null) return;
    try {
      const changed = await processor.process({
        run: Object.freeze({ id: this.runId }),
        execution: this.requireValidationExecution(),
        runAction: action.ref,
        operation,
        request,
        requestOrigin,
        settlement: this.validationLowerSettlement(result),
      }, this.invocationInterruption());
      if (!changed) return;
    } catch (error) {
      if (error instanceof ValidationExecutionError) throw error;
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_settled_operation_processing_failed",
        stage: "check",
        message: error instanceof Error
          ? error.message
          : "Settled Operation Validation processing failed.",
        retryable: false,
        cause: null,
      }), (await this.requireValidationExecution().readCurrentSnapshot()).ref.revision);
    }
    await this.commitValidationFeedback(null);
  }

  private validationLowerSettlement(
    result: OperationResult,
  ): ValidationLowerCheckSettlement {
    const settlementRef = result.lowerRefs.find((reference) =>
      reference.owner === "canonical-action" &&
      reference.kind === "action_settlement");
    const actionId = typeof result.metadata.actionId === "string"
      ? result.metadata.actionId
      : null;
    const effectCertainty = isActionEffectCertainty(result.metadata.effectCertainty)
      ? result.metadata.effectCertainty
      : result.status === "succeeded"
        ? "confirmed"
        : result.status === "partial"
          ? "partial"
          : result.status === "unknown_effect"
            ? "unknown"
            : "none";
    return Object.freeze({
      operationInvocation: result.ref.invocation,
      operationResult: result,
      actionSettlement: settlementRef === undefined || actionId === null
        ? null
        : Object.freeze({
            action: Object.freeze({ id: actionId }),
            id: settlementRef.id,
          }),
      effectCertainty,
      costUnits: typeof result.metadata.costUnits === "number" &&
          Number.isFinite(result.metadata.costUnits) &&
          result.metadata.costUnits >= 0
        ? result.metadata.costUnits
        : null,
    });
  }

  private async processValidationCheckResult(
    request: RunnerValidationCheckRequest,
    result: CheckResult,
    interruption: InvocationInterruptionContext,
  ): Promise<void> {
    const processor = this.dependencies.validation.checkResults;
    if (processor === null) return;
    try {
      await processor.process({
        run: Object.freeze({ id: this.runId }),
        execution: this.requireValidationExecution(),
        request,
        result,
      }, interruption);
    } catch (error) {
      if (error instanceof ValidationExecutionError) throw error;
      throw new ValidationExecutionError(createValidationFailure({
        code: "validation_check_result_processing_failed",
        stage: "assessment",
        message: error instanceof Error
          ? error.message
          : "Validation Check Result processing failed.",
        retryable: false,
        cause: null,
      }), (await this.requireValidationExecution().readCurrentSnapshot()).ref.revision);
    }
  }

  private async executeOperation(input: {
    readonly action: RuntimeRunAction;
    readonly operation: OperationRevisionRef;
    readonly request: unknown;
    readonly requestOrigin: OperationRequestOrigin;
    readonly invocationId: string;
    readonly parentInvocation: OperationInvocationRef | null;
    readonly basis: unknown;
  }): Promise<OperationResult | null> {
    const registration = findRegisteredOperation(
      this.dependencies.operations.catalog,
      input.operation,
    );
    if (registration === undefined) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_not_registered",
        "The requested Operation revision is not registered.",
      );
      return null;
    }
    if (registration.retirement !== null) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_retired",
        "The requested Operation revision is retired.",
      );
      return null;
    }
    if (!registration.allowedRequestOrigins.includes(input.requestOrigin)) {
      this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_request_origin_denied",
        "The requested origin is not admitted for this Operation revision.",
      );
      return null;
    }
    const invocation: OperationInvocationRef = Object.freeze({
      id: input.invocationId,
      operation: registration.operation.ref,
    });
    const context: OperationInvocationContext = Object.freeze({
      invocation,
      correlation: this.runActionCorrelation(input.action),
      parentInvocation: input.parentInvocation,
      interruption: this.invocationInterruption(),
    });
    const resolution = await this.dependencies.operations.bindings.resolve({
      operation: registration,
      context,
      request: input.request,
      basis: input.basis,
    });
    if (resolution.status !== "resolved") {
      const result = this.operationFailureResult(
        registration,
        invocation,
        "unavailable",
        "operation-catalog",
        resolution.code,
        this.now(),
        this.now(),
      );
      this.emitOperation(registration, resolutionBindingKind(registration), context, result);
      return result;
    }
    const binding = resolution.binding;
    if (!bindingMatchesResolution(registration, context, binding)) {
      const result = this.operationFailureResult(
        registration,
        invocation,
        "invalid",
        "operation-catalog",
        "operation_binding_mismatch",
        this.now(),
        this.now(),
      );
      this.emitOperation(registration, binding.kind, context, result);
      return result;
    }

    const startedAt = this.now();
    this.emit("operation.started", {
      invocationId: invocation.id,
      operationNamespace: invocation.operation.operation.namespace,
      operationName: invocation.operation.operation.name,
      operationRevision: invocation.operation.revision,
      semanticOwner: registration.operation.semanticOwner,
      bindingKind: binding.kind,
      correlationKind: context.correlation.kind,
      parentInvocationId: context.parentInvocation?.id ?? null,
      parentRunActionId: input.action.ref.id,
    }, startedAt);
    let result: OperationResult;
    try {
      const execute = () => this.executeResolvedBinding(
        registration,
        input.action,
        binding,
        context,
        startedAt,
      );
      result = input.parentInvocation === null
        ? await this.interruptionCoordinator.execute(
            "tool",
            execute,
            this.writer.getSnapshot().deadlineAt,
          )
        : await execute();
    } catch (error) {
      if (error instanceof OperationSettlementTimeoutError) throw error;
      result = this.operationFailureResult(
        registration,
        invocation,
        this.config.cancellation.context.request === null ? "failed" : "cancelled",
        "agent-runtime",
        this.config.cancellation.context.request === null
          ? "operation_execution_failed"
          : "operation_cancelled",
        startedAt,
        this.now(),
      );
    }
    this.emit("operation.finished", {
      invocationId: invocation.id,
      status: result.status,
      code: result.failure?.code ?? null,
      resultId: result.ref.id,
      lowerResultRefs: Object.freeze(result.lowerRefs.map((reference) => reference.id)),
    }, result.finishedAt);
    return result;
  }

  private async executeResolvedBinding(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: ResolvedOperationBinding,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    switch (binding.kind) {
      case "internal": {
        const handler = this.dependencies.operations.internalHandlers.find(
          (candidate) => candidate.id === binding.handlerId,
        );
        if (handler === undefined) {
          return this.operationFailureResult(
            registration,
            binding.invocation,
            "unavailable",
            "agent-runtime",
            "internal_operation_handler_unavailable",
            startedAt,
            this.now(),
          );
        }
        const result = await handler.execute({
          runId: this.runId,
          parentRunAction: action.ref,
          binding,
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          interruption: context.interruption,
        });
        if (
          result.ref.invocation.id !== binding.invocation.id ||
          result.binding.revision !== binding.binding.revision ||
          result.semanticOwner !== registration.operation.semanticOwner
        ) {
          return this.operationFailureResult(
            registration,
            binding.invocation,
            "invalid",
            "agent-runtime",
            "internal_operation_result_mismatch",
            startedAt,
            this.now(),
          );
        }
        return result;
      }
      case "direct":
      case "hosted":
        return this.executeCanonicalAction(registration, action, binding, context, startedAt);
      case "composite":
        return this.executeComposite(registration, action, binding, context, startedAt);
      case "descendant_agent":
        return this.executeDescendant(registration, action, binding, context, startedAt);
    }
  }

  private async executeCanonicalAction(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "direct" | "hosted" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    if (this.actionExecution === null || this.config.actionExecution === null) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "unavailable",
        "action-execution",
        "action_execution_unavailable",
        startedAt,
        this.now(),
      );
    }
    const dispatchSteeringEpoch = this.steeringEpoch;
    const outcome = await this.actionExecution.execute({
      action: Object.freeze({ id: this.id("action") }),
      parentRunAction: action.ref,
      runId: this.runId,
      binding,
      securityContext: this.config.actionExecution.securityContext,
      policyContext: Object.freeze({
        policySnapshotId: this.config.actionExecution.policySnapshotId,
        workspaceTrustState: this.config.actionExecution.securityContext.workspace?.trustState ?? null,
        identityId: this.config.identity.id,
        environmentId: this.config.actionExecution.securityContext.environment.environmentId,
        metadata: this.config.actionExecution.metadata,
      }),
      permissionContext: () => this.actionPermissionContext(),
      enforcement: this.config.actionExecution.enforcement,
      interruption: context.interruption,
      deadlineAt: this.writer.getSnapshot().deadlineAt,
      maxAttempts: this.config.retry.action.maxAttempts,
      isProgressionBasisCurrent: () => this.steeringEpoch === dispatchSteeringEpoch,
    });
    if (outcome.status === "pending_interaction") {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "failed",
        "action-execution",
        "action_approval_not_coordinated",
        startedAt,
        this.now(),
      );
    }
    return operationResultFromAction(
      registration,
      binding,
      outcome,
      startedAt,
      this.now(),
      this.id("operation_result"),
    );
  }

  private async executeComposite(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "composite" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    const resolved = this.dependencies.operations.composite?.resolve(
      binding.compositeDefinitionRef,
    ) ?? null;
    if (resolved === null || resolved.definition.retiredAt !== null) {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        "unavailable",
        "operation-composition",
        "composite_definition_unavailable",
        startedAt,
        this.now(),
      );
    }
    const compositeId = this.id("composite");
    const pending: PendingRunSubject = Object.freeze({
      kind: "composite",
      compositeId,
      nodeId: "aggregate",
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.addPending(pending);
    try {
      const execution = new CompositeExecution(
        compositeId,
        resolved.definition,
        {
          ...resolved.execution,
          now: this.dependencies.now,
          children: {
            start: async (child) => {
              const invocationId = this.id("operation_invocation");
              const childAction = this.materializeWorkflowRunAction({
                operation: child.node.operation,
                invocationId,
                compositeId,
                nodeId: child.node.id,
              });
              const result = await this.executeOperation({
                action: childAction,
                operation: child.node.operation,
                request: child.request,
                requestOrigin: "trusted_workflow",
                invocationId,
                parentInvocation: binding.invocation,
                basis: child,
              });
              if (result === null) {
                throw new Error("Composite child Operation was rejected before materialization.");
              }
              this.commitOperationObservation(childAction, { result, toolResult: null });
              return Object.freeze({ runAction: childAction.ref, result });
            },
          },
        },
      );
      const result = await execution.run(binding.request, context.interruption);
      return operationResultFromComposite(
        registration,
        binding,
        result,
        startedAt,
        this.now(),
        this.id("operation_result"),
      );
    } finally {
      this.removePending(pending, "resolved", null);
    }
  }

  private async executeDescendant(
    registration: RegisteredOperation,
    action: RuntimeRunAction,
    binding: Extract<ResolvedOperationBinding, { readonly kind: "descendant_agent" }>,
    context: OperationInvocationContext,
    startedAt: string,
  ): Promise<OperationResult> {
    const descendant = await this.executeDescendantRun(
      action,
      binding.agentRef,
      binding.request,
    );
    if (descendant.status === "rejected") {
      return this.operationFailureResult(
        registration,
        binding.invocation,
        descendant.operationStatus,
        "agent-runtime",
        descendant.code,
        startedAt,
        this.now(),
      );
    }
    const mapped = descendant.prepared.mapResult(descendant.result);
    return createOperationResult({
      ref: Object.freeze({ invocation: binding.invocation, id: this.id("operation_result") }),
      binding: binding.binding,
      semanticOwner: registration.operation.semanticOwner,
      status: mapped.status,
      output: mapped.output,
      failure: mapped.failure,
      startedAt,
      finishedAt: this.now(),
      lowerRefs: Object.freeze([{
        owner: "agent-runtime",
        kind: "descendant_run_result",
        id: descendant.result.runId,
        revision: String(descendant.result.items.at(-1)?.committedInRevision ?? 0),
      }]),
      metadata: Object.freeze({
        relationId: descendant.relationId,
        contextManifestRef: descendant.prepared.contextManifestRef,
        visibility: descendant.prepared.visibility,
      }),
    } as OperationResult);
  }

  private async executeToolDescendant(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<void> {
    if (call.binding.kind !== "descendant_agent") return;
    const startedAt = this.now();
    const descendant = await this.executeDescendantRun(
      action,
      call.binding.agent,
      call.input,
    );
    if (descendant.status === "rejected") {
      this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        descendant.operationStatus,
        null,
        operationFailure("agent-runtime", descendant.code),
        startedAt,
      );
      return;
    }
    const mapped = descendant.prepared.mapResult(descendant.result);
    this.commitDescendantToolObservation(
      action,
      call,
      descendant.relationId,
      descendant.childRunId,
      mapped.status,
      mapped.output,
      mapped.failure,
      startedAt,
    );
  }

  private async executeDescendantRun(
    action: RuntimeRunAction,
    targetAgent: import("@agent-anything/agent-core/agent").AgentRevisionRef,
    delegatedInput: unknown,
  ): Promise<DescendantExecutionOutcome> {
    const relationId = this.id("descendant_relation");
    const composition = this.dependencies.operations.descendants;
    if (composition === undefined) {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "descendant_run_preparation_failed",
      );
      return rejectedDescendant(
        relationId,
        "descendant_run_preparation_failed",
        null,
        "failed",
      );
    }

    let prepared: DescendantRunPreparation;
    try {
      prepared = await composition.prepare({
        parentRunId: this.runId,
        parentRunAction: action.ref,
        targetAgent,
        delegatedInput,
        parentConfig: this.config,
      });
    } catch {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "descendant_run_preparation_failed",
      );
      return rejectedDescendant(
        relationId,
        "descendant_run_preparation_failed",
        null,
        "failed",
      );
    }
    if (!sameAgentRef(prepared.agent, targetAgent)) {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "descendant_agent_mismatch",
      );
      return rejectedDescendant(
        relationId,
        "descendant_agent_mismatch",
        null,
        "invalid",
      );
    }

    const started = this.startDescendantRun({
      relationId,
      parentRunAction: action.ref,
      agent: prepared.agent,
      input: prepared.input,
      config: prepared.config,
    });
    if (started.status === "rejected") {
      if (started.relation !== null && started.reservedTreeRevision !== null) {
        this.emitDescendantLifecycle(
          "run.descendant.reserved",
          started.relation,
          started.reservedTreeRevision,
        );
      }
      this.emitDescendantRejected(
        started.relation?.ref.id ?? null,
        action.ref,
        started.relation?.child.id ?? null,
        started.relation?.depth ?? this.lineage.depth + 1,
        started.code,
        started.treeRevision,
      );
      return rejectedDescendant(
        relationId,
        started.code,
        started.relation?.child.id ?? null,
        descendantRejectionStatus(started.code),
      );
    }

    this.emitDescendantLifecycle(
      "run.descendant.reserved",
      started.relation,
      started.reservedTreeRevision,
    );
    this.emitDescendantLifecycle(
      "run.descendant.started",
      started.relation,
      started.treeRevision,
    );

    const child = started.handle;
    this.childHandles.add(child);
    const pending: PendingRunSubject = Object.freeze({
      kind: "descendant_run",
      relationId,
      childRunId: child.runId,
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.addPending(pending);
    const unsubscribe = child.subscribe(() => this.publishCurrentState());
    try {
      const result = await child.wait();
      this.eventStream.emit("run.descendant.settled", {
        relationId: started.relation.ref.id,
        parentRunActionId: started.relation.parentRunAction.id,
        childRunId: started.relation.child.id,
        depth: started.relation.depth,
        status: result.status,
        code: result.code,
        treeRevision: this.getRunTreeSnapshot().revision,
      });
      return Object.freeze({
        status: "settled" as const,
        relationId,
        childRunId: child.runId,
        prepared,
        result,
      });
    } finally {
      unsubscribe();
      this.childHandles.delete(child);
      this.removePending(pending, "resolved", null);
    }
  }

  private emitDescendantLifecycle(
    name: "run.descendant.reserved" | "run.descendant.started",
    relation: DescendantRunRelation,
    treeRevision: number,
  ): void {
    this.eventStream.emit(name, {
      relationId: relation.ref.id,
      parentRunActionId: relation.parentRunAction.id,
      childRunId: relation.child.id,
      depth: relation.depth,
      treeRevision,
    });
  }

  private emitDescendantRejected(
    relationId: string | null,
    parentRunAction: RunActionRef,
    childRunId: string | null,
    depth: number | null,
    code: import("@agent-anything/observability/events").RuntimeDescendantRunFailureCode,
    treeRevision: number = this.getRunTreeSnapshot().revision,
  ): void {
    this.eventStream.emit("run.descendant.rejected", {
      relationId,
      parentRunActionId: parentRunAction.id,
      childRunId,
      depth,
      code,
      treeRevision,
    });
  }

  private commitDescendantToolObservation(
    action: RuntimeRunAction,
    call: ToolCall,
    relationId: string,
    childRunId: string | null,
    status: import("./RunnerDependencies.js").DescendantOperationOutcome["status"],
    output: unknown,
    failure: OperationFailure | null,
    startedAt: string,
  ): void {
    const finishedAt = this.now();
    const settlement = Object.freeze({
      owner: "agent-runtime",
      kind: "descendant_run",
      id: childRunId ?? relationId,
      revision: childRunId === null ? null : "terminal",
    });
    const toolResult = status === "succeeded"
      ? succeededToolResult(call, settlement, output ?? Object.freeze({ childRunId }), startedAt, finishedAt)
      : status === "partial"
        ? partialToolResult(
            call,
            settlement,
            output ?? Object.freeze({ childRunId }),
            failure ?? operationFailure("agent-runtime", "descendant_run_partial"),
            startedAt,
            finishedAt,
          )
        : failedToolResult(
            call,
            settlement,
            failure?.code ?? `descendant_run_${status}`,
            failure?.message ?? `Descendant Run settled as ${status}.`,
            startedAt,
            finishedAt,
            status === "timed_out" ? "timeout" : "failed",
          );
    this.commitObservation(action, {
      kind: "descendant_run",
      childRunId,
      status,
      output,
      failure,
      toolResult,
    }, [
      {
        owner: "agent-runtime",
        kind: "descendant_run_result",
        id: childRunId ?? relationId,
        revision: settlement.revision,
      },
      toolResultLowerRef(toolResult),
    ], "agent-runtime");
  }

  private commitOperationObservation(
    action: RuntimeRunAction,
    outcome: OperationExecutionOutcome,
  ): void {
    const lowerRefs = [
      {
        owner: outcome.result.semanticOwner,
        kind: "operation_result",
        id: outcome.result.ref.id,
        revision: outcome.result.binding.revision,
      },
      ...(outcome.toolResult === null
        ? []
        : [{
            owner: "tools",
            kind: "tool_result",
            id: outcome.toolResult.toolCall.toolCallId,
            revision: outcome.toolResult.toolCall.toolRevision.revision,
          }]),
    ];
    this.commitObservation(action, {
      kind: "operation",
      result: outcome.result,
      toolResult: outcome.toolResult,
    }, lowerRefs, outcome.result.semanticOwner);
  }

  private commitRejectedOperation(
    action: RuntimeRunAction,
    owner: string,
    code: string,
    message: string,
  ): void {
    this.commitObservation(action, {
      kind: "operation_rejected",
      owner,
      code,
      message,
    }, [], owner);
  }

  private commitInteractionObservation(
    action: RuntimeRunAction,
    settlement: RuntimeInteractionSettlement,
    call: ToolCall | null,
  ): void {
    if (settlement.status === "resolved") {
      const toolResult = call === null
        ? null
        : succeededToolResult(
            call,
            Object.freeze({
              owner: settlement.outcome.request.protocol.owner,
              kind: "interaction_request",
              id: settlement.outcome.request.id,
              revision: String(settlement.outcome.request.requestVersion),
            }),
            settlement.applicationValue ?? Object.freeze({ request: settlement.outcome.request }),
            call.createdAt,
            this.now(),
          );
      this.commitObservation(action, {
        kind: "interaction",
        owner: settlement.outcome.request.protocol.owner,
        status: "resolved",
        contentDigest: settlement.contentDigest,
        value: settlement.applicationValue,
        toolResult,
      }, [
        {
          owner: settlement.outcome.request.protocol.owner,
          kind: "interaction_resolution",
          id: settlement.outcome.resolution.resolutionId,
          revision: settlement.outcome.resolution.resolutionRevision,
        },
        ...(toolResult === null ? [] : [toolResultLowerRef(toolResult)]),
      ], settlement.outcome.request.protocol.owner);
      return;
    }
    const toolResult = call === null
      ? null
      : failedToolResult(
          call,
          Object.freeze({
            owner: settlement.owner,
            kind: "interaction_request",
            id: settlement.request.id,
            revision: String(settlement.request.requestVersion),
          }),
          settlement.code,
          `Interaction settled as ${settlement.status}.`,
          call.createdAt,
          this.now(),
        );
    this.commitObservation(action, {
      kind: "interaction",
      owner: settlement.owner,
      status: settlement.status,
      contentDigest: null,
      value: Object.freeze({ code: settlement.code }),
      toolResult,
    }, toolResult === null ? [] : [toolResultLowerRef(toolResult)], settlement.owner);
  }

  private commitObservation(
    action: RuntimeRunAction,
    payload: RunObservation["payload"],
    lowerRefs: RunObservation["lowerRefs"],
    owner: string,
  ): void {
    const state = this.writer.getSnapshot();
    const sequence = state.counters.observations + 1;
    const observation = createRunObservation({
      id: this.id("observation", sequence),
      runId: this.runId,
      actionId: action.ref.id,
      kind: payload.kind,
      createdAt: this.now(),
      metadata: Object.freeze({}),
      owner,
      runAction: action.ref,
      lowerRefs: Object.freeze([...lowerRefs]),
      payload,
    });
    const failed = observationFailed(observation);
    const contribution = createObservationContextContribution({
      id: this.id("context_contribution"),
      observation,
    });
    this.writer.commit({ kind: "observation", observation }, (current) => Object.freeze({
      context: this.applyContextContributions(
        current.context,
        Object.freeze([contribution]),
        createObservationContextAdmissionProfile(observation.owner),
        "observation_committed",
        observation.id,
      ),
      counters: Object.freeze({
        ...current.counters,
        observations: sequence,
        consecutiveActionFailures: failed
          ? current.counters.consecutiveActionFailures + 1
          : 0,
      }),
    }));
  }

  private applyContextContributions(
    context: ActiveContext,
    contributions: readonly ContextContribution[],
    admission: ContextAdmissionProfile,
    causeKind: string,
    correlationId: string | null,
  ): ActiveContext {
    const operations: ContextTransitionOperation[] = contributions.map((contribution) => {
      if (contribution.handling.retention === "current") {
        const current = context.items.find((item) =>
          "contribution" in item &&
          item.lifecycle.kind === "active" &&
          item.contribution.source.owner === contribution.source.owner &&
          item.contribution.handling.replacementKey === contribution.handling.replacementKey
        );
        if (current !== undefined && "contribution" in current) {
          return deriveContextRefreshOperation({
            context,
            proposal: Object.freeze({
              id: this.id("context_refresh"),
              kind: "replace" as const,
              owner: contribution.source.owner,
              target: Object.freeze({
                context: context.ref,
                item: current.ref,
                contribution: current.contribution.ref,
                source: Object.freeze({
                  owner: current.contribution.source.owner,
                  kind: current.contribution.source.kind,
                  id: current.contribution.source.id,
                  revision: current.contribution.source.revision,
                }),
              }),
              cause: causeKind,
              correlationId,
              contribution,
              createdAt: contribution.createdAt,
            }),
            maxContributionPayloadBytes:
              this.dependencies.contextProjection.maxContributionPayloadBytes,
          });
        }
      }
      return Object.freeze({
        kind: "add" as const,
        item: Object.freeze({ id: this.id("context_item") }),
        contribution,
      });
    });
    return this.applyContextOperations(
      context,
      operations,
      admission,
      causeKind,
      correlationId,
    );
  }

  private applyContextOperations(
    context: ActiveContext,
    operations: readonly ContextTransitionOperation[],
    admission: ContextAdmissionProfile,
    causeKind: string,
    correlationId: string | null,
  ): ActiveContext {
    if (operations.length === 0) return context;
    const createdAt = this.now();
    const transition: ContextTransition = Object.freeze({
      id: this.id("context_transition"),
      base: context.ref,
      proposer: Object.freeze({
        owner: admission.owner,
        kind: "run_execution",
        id: this.runId,
      }),
      cause: Object.freeze({ kind: causeKind, id: correlationId }),
      correlationId,
      operations: Object.freeze([...operations]),
      createdAt,
    });
    const next = applyContextTransition({
      context,
      transition,
      admission,
      maxContributionPayloadBytes:
        this.dependencies.contextProjection.maxContributionPayloadBytes,
    });
    this.pendingContextTransitions.set(transition.id, transition);
    return next;
  }

  private openPendingInteraction(pending: PendingInteractionRef): void {
    const value: PendingRunSubject = Object.freeze({
      kind: "interaction",
      interaction: pending,
      branchId: pending.request.id,
      required: pending.blockingScope !== "none",
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending: value,
      recordRef: pending.request.id,
    }, (current) => {
      const nextPending = Object.freeze([...current.pending, value]);
      return Object.freeze({
        pending: nextPending,
        status: deriveActiveStatus(current.status, nextPending),
      });
    });
    this.emit("interaction.opened", {
      requestId: pending.request.id,
      protocolOwner: pending.request.protocol.owner,
      protocolKind: pending.request.protocol.kind,
      protocolRevision: pending.request.protocol.revision,
      subjectOwner: pending.request.subject.owner,
      subjectKind: pending.request.subject.kind,
      subjectId: pending.request.subject.id,
      subjectRevision: pending.request.subject.revision,
      blockingScope: pending.blockingScope,
      pendingVersion: pending.request.requestVersion,
      parentRunActionId: findParentRunActionId(this.writer.getSnapshot(), pending.request.id),
    });
  }

  private settlePendingInteraction(
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): void {
    const state = this.writer.getSnapshot();
    const current = state.pending.find((candidate) =>
      candidate.kind === "interaction" && sameInteractionRequest(
        candidate.interaction.request,
        pending.request,
      )
    );
    if (current === undefined) return;
    const transition = terminal.kind;
    const recordRef = terminalRecordRef(terminal);
    this.writer.commit({
      kind: "pending_transition",
      transition,
      pending: current,
      recordRef,
    }, (snapshot) => {
      const nextPending = Object.freeze(snapshot.pending.filter((candidate) => candidate !== current));
      return Object.freeze({
        pending: nextPending,
        status: deriveActiveStatus(snapshot.status, nextPending),
      });
    });
    this.emit("interaction.settled", {
      requestId: pending.request.id,
      pendingVersion: pending.request.requestVersion,
      lifecycle: settlement.status,
      code: settlement.status === "resolved" ? null : settlement.code,
      terminalRecordId: recordRef,
    });
  }

  private queueInteractionSettlement(
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): void {
    const key = interactionRequestKey(pending.request);
    const context = this.interactionActions.get(key) ?? null;
    this.interactionSettlements.push(Object.freeze({
      pending,
      terminal,
      settlement,
      action: context?.action ?? null,
      toolCall: context?.toolCall ?? null,
    }));
    this.interactionActions.delete(key);
  }

  private drainInteractionSettlements(): number {
    let count = 0;
    while (this.interactionSettlements.length > 0) {
      const queued = this.interactionSettlements.shift()!;
      this.settlePendingInteraction(queued.pending, queued.terminal, queued.settlement);
      if (queued.action !== null) {
        this.commitInteractionObservation(
          queued.action,
          queued.settlement,
          queued.toolCall,
        );
      }
      count += 1;
    }
    return count;
  }

  private drainSteering(
    disposition: "apply" | "cancelled" | "run_settled",
  ): number {
    if (this.steeringQueue.length === 0) return 0;
    const queued = this.steeringQueue.splice(0);
    const latest = queued.at(-1)!;
    for (const command of queued) {
      const status: RunSteeringApplication["status"] = disposition === "apply"
        ? command === latest ? "applied" : "superseded"
        : disposition;
      const current = this.writer.getSnapshot();
      const application: RunSteeringApplication = Object.freeze({
        command,
        status,
        appliedInRunRevision: current.revision + 1,
        supersededByCommandId: status === "superseded" ? latest.commandId : null,
        reasonCode: status === "cancelled"
          ? "run_cancellation_requested"
          : status === "run_settled"
            ? "run_settled_before_application"
            : null,
      });
      const contribution = status === "applied"
        ? createSteeringContextContribution({
            id: this.id("context_contribution"),
            revision: String(command.acceptedRunRevision),
            runId: this.runId,
            commandId: command.commandId,
            instruction: command.instruction,
            createdAt: command.submittedAt,
          })
        : null;
      this.writer.commit({
        kind: "state_transition",
        transition: "steering",
        steering: application,
      }, (state) => status === "applied"
        ? Object.freeze({
            context: this.applyContextContributions(
              state.context,
              Object.freeze([contribution!]),
              createSteeringContextAdmissionProfile(),
              "steering_applied",
              command.commandId,
            ),
            plan: null,
          })
        : Object.freeze({}));
    }
    return queued.length;
  }

  private rejectSteering(
    commandId: string,
    code: Extract<RunSteeringSubmissionReceipt, { status: "rejected" }>["code"],
  ): RunSteeringSubmissionReceipt {
    const state = this.writer.getSnapshot();
    return Object.freeze({
      status: "rejected" as const,
      code,
      run: state.run,
      commandId,
      currentRunRevision: state.revision,
    });
  }

  private addPending(pending: PendingRunSubject): void {
    this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending,
      recordRef: null,
    }, (current) => {
      const next = Object.freeze([...current.pending, pending]);
      return Object.freeze({ pending: next, status: deriveActiveStatus(current.status, next) });
    });
  }

  private removePending(
    pending: PendingRunSubject,
    transition: "resolved" | "cancelled" | "failed" | "invalidated" | "expired",
    recordRef: string | null,
  ): void {
    const current = this.writer.getSnapshot();
    if (!current.pending.includes(pending)) return;
    this.writer.commit({
      kind: "pending_transition",
      transition,
      pending,
      recordRef,
    }, (state) => {
      const next = Object.freeze(state.pending.filter((candidate) => candidate !== pending));
      return Object.freeze({ pending: next, status: deriveActiveStatus(state.status, next) });
    });
  }

  private createActionApprovalPort(): ActionApprovalResolutionPort {
    return Object.freeze({
      resolve: async (
        input: Parameters<ActionApprovalResolutionPort["resolve"]>[0],
      ) => {
        const reviewer = this.config.permissions.reviewer;
        if (reviewer === null) {
          return Object.freeze({
            status: "failed" as const,
            code: "approval_reviewer_unavailable",
          });
        }
        const activity = this.writer.getSnapshot().permission.approvalActivity;
        const fingerprint = input.assessment.requirement.subject.actionFingerprint;
        const byFingerprint = activity.requestsByActionFingerprint[fingerprint] ?? 0;
        const limits = this.config.permissions.approvalLimits;
        if (
          activity.requestCount >= limits.maxRequestsPerRun ||
          byFingerprint >= limits.maxRequestsPerActionFingerprint ||
          activity.consecutiveDeclines >= limits.maxConsecutiveDeclines ||
          activity.consecutiveReviewFailures >= limits.maxConsecutiveReviewFailures
        ) {
          return Object.freeze({ status: "denied" as const, code: "approval_limit_reached" });
        }
        if (input.parentRunAction === null) {
          return Object.freeze({ status: "failed" as const, code: "approval_parent_action_missing" });
        }
        const requestId = this.id("interaction_request", this.nextInteractionRequest++);
        const pendingVersion = 1;
        const createdAt = this.now();
        this.updateApprovalActivity((current) => ({
          ...current,
          requestCount: current.requestCount + 1,
          requestsByActionFingerprint: Object.freeze({
            ...current.requestsByActionFingerprint,
            [fingerprint]: byFingerprint + 1,
          }),
        }));
        const opened = this.interactions.open({
          requestId,
          protocol: APPROVAL_INTERACTION_PROTOCOL,
          subject: Object.freeze({
            requirement: input.assessment.requirement,
            pendingVersion,
            createdAt,
          } satisfies ApprovalInteractionSubject),
          subjectRef: Object.freeze({
            owner: "permission",
            kind: "approval",
            id: input.action.id,
            revision: fingerprint,
          }),
          correlation: this.runActionCorrelationByRef(input.parentRunAction),
          parentRunAction: input.parentRunAction,
          presentation: createApprovalInteractionPresentation({
            requestId,
            requirement: input.assessment.requirement,
            createdAt,
          }),
          requestVersion: pendingVersion,
          expiresAt: input.assessment.requirement.deadlineAt,
          blockingScope: "run",
          createdAt,
        });
        if (opened.status !== "opened") {
          this.updateApprovalActivity((current) => ({
            ...current,
            consecutiveReviewFailures: current.consecutiveReviewFailures + 1,
          }));
          return Object.freeze({ status: "failed" as const, code: opened.code });
        }

        if (reviewer.kind === "auto_review") {
          const review: ApprovalReviewInput = Object.freeze({
            request: opened.envelope.presentation as ApprovalReviewInput["request"],
            pendingVersion,
            context: Object.freeze({
              workspaceTrustState: this.config.workspace?.primary.trustState ?? null,
              ruleOutcome: "none",
              currentAuthority: Object.freeze({
                fileSystemRead: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
                fileSystemWrite: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
                network: this.writer.getSnapshot().permission.runPermissionGrants.length > 0,
              }),
              annotations: Object.freeze({}),
            }),
          });
          const reviewStartedAt = this.now();
          const reviewResult = await executeApprovalReviewer({
            reviewer,
            review,
            operationId: `${requestId}:review`,
            startedAt: reviewStartedAt,
            deadlineAt: deriveApprovalReviewDeadline({
              runDeadlineAt: this.writer.getSnapshot().deadlineAt,
              reviewStartedAt,
              reviewTimeoutMs: reviewer.reviewTimeoutMs,
            }),
            retryPolicy: this.config.retry.providerRequest,
            retryExecutor: this.dependencies.retryExecutor,
            cancellation: this.config.cancellation.context,
            events: this.retryEvents(),
            now: this.dependencies.now,
          });
          if (reviewResult.kind === "failed") {
            this.interactions.fail(opened.pending.request, "permission", reviewResult.failure.code);
            this.updateApprovalActivity((current) => ({
              ...current,
              consecutiveReviewFailures: current.consecutiveReviewFailures + 1,
            }));
          } else if (reviewResult.kind === "cancelled") {
            this.interactions.invalidate(opened.pending.request, "approval_review_cancelled");
          } else {
            this.interactions.submit({
              request: opened.pending.request,
              submissionId: reviewResult.outcome.submission.submissionId,
              contentDigest: await approvalSubmissionDigest(reviewResult.outcome.submission),
              payload: reviewResult.outcome.submission,
              receivedAt: this.now(),
            });
          }
        }
        const settlement = await opened.completion;
        this.drainInteractionSettlements();
        if (settlement.status !== "resolved") {
          return Object.freeze({
            status: settlement.status === "expired" || settlement.status === "invalidated" || settlement.status === "cancelled"
              ? settlement.status
              : "failed",
            code: settlement.code,
          }) as Awaited<ReturnType<ActionApprovalResolutionPort["resolve"]>>;
        }
        const resolution = settlement.resolutionValue as ApprovalInteractionResolution;
        if (resolution.decision.kind === "decline") {
          this.updateApprovalActivity((current) => ({
            ...current,
            consecutiveDeclines: current.consecutiveDeclines + 1,
            consecutiveReviewFailures: 0,
          }));
          return Object.freeze({ status: "denied" as const, code: "approval_declined" });
        }
        if (resolution.decision.kind === "cancel") {
          this.config.cancellation.requestCancellation({
            origin: "approval",
            reasonCode: "approval_cancelled",
            approvalRequestId: requestId,
          });
          return Object.freeze({ status: "cancelled" as const, code: "approval_cancelled" });
        }
        const application = settlement.applicationValue as ApprovalApplicationOutcome;
        if (application.kind !== "applied") {
          return Object.freeze({
            status: application.kind === "interrupted" ? "interrupted" :
              application.kind === "outcome_unknown" ? "unknown_effect" : "failed",
            code: "code" in application ? application.code : "approval_authority_not_applied",
          });
        }
        this.updateApprovalActivity((current) => ({
          ...current,
          consecutiveDeclines: 0,
          consecutiveReviewFailures: 0,
        }));
        return Object.freeze({
          status: "applied" as const,
          approvalRecordId: settlement.outcome.resolution.resolutionId,
          authoritySnapshotId: `run-permission:${this.writer.getSnapshot().revision}`,
        });
      },
    });
  }

  private validateApprovalDecision(
    subject: ApprovalInteractionSubject,
    submission: import("@agent-anything/permission/approval").ApprovalDecisionSubmission,
    requestId: string,
  ): ValidatedApprovalDecision {
    const request = createApprovalRequest({
      id: requestId,
      requirement: subject.requirement,
      createdAt: subject.createdAt,
    });
    const profile = this.config.permissions.permissionProfile;
    const cwd = profile.workspaceRoots[0]?.canonicalPath ??
      (profile.platform === "win32" ? "C:/" : "/");
    const result = validateApprovalDecision({
      request: request as import("@agent-anything/permission/approval").ApprovalRequest,
      pendingVersion: subject.pendingVersion,
      submission,
      cwd,
      environment: Object.freeze({
        environmentId: profile.environmentId,
        platform: profile.platform,
        workspaceRoots: Object.freeze(profile.workspaceRoots.map((root) => Object.freeze({
          rootId: root.rootId,
          path: root.canonicalPath,
        }))),
      }),
      managedConstraints: this.config.permissions.managedConstraints,
      identities: Object.freeze({
        actionAuthorityId: this.id("authority_record"),
        runPermissionGrantId: this.id("authority_record"),
        sessionAuthorityRecordId: this.id("authority_record"),
      }),
      validatedAt: this.now(),
    });
    if (result.status !== "valid") throw new TypeError(result.message);
    return result.decision;
  }

  private async applyApprovalDecision(
    subject: ApprovalInteractionSubject,
    resolution: ApprovalInteractionResolution,
    requestId: string,
  ): Promise<ApprovalApplicationOutcome> {
    const immediate = applyImmediateApprovalAuthority({
      permission: this.writer.getSnapshot().permission,
      decision: resolution.decision,
    });
    if (immediate.status === "applied") {
      this.writer.commitState(() => Object.freeze({ permission: immediate.permission }));
      return immediate.application;
    }
    if (immediate.status === "not_applicable") return immediate.application;
    if (!isDurableAuthorityDecision(resolution.decision)) {
      return Object.freeze({ kind: "not_applied", code: "approval_authority_invalid" });
    }
    const startedAt = this.now();
    const result = await executeAuthorityCommit({
      decision: resolution.decision,
      pending: Object.freeze({
        requestId,
        actionFingerprint: subject.requirement.subject.actionFingerprint,
        authorityOperationId: resolution.resolutionId,
      }),
      config: this.config.permissions,
      cancellation: this.config.cancellation.context,
      startedAt,
      deadlineAt: deriveAuthorityCommitDeadline({
        runDeadlineAt: this.writer.getSnapshot().deadlineAt,
        commitStartedAt: startedAt,
        commitTimeoutMs: this.config.permissions.authorityApplicationLimits.commitTimeoutMs,
      }),
      policyAmendmentRecordId: this.id("authority_record"),
      now: this.dependencies.now,
    });
    if (result.kind === "applied") {
      const permission = result.owner === "permission"
        ? applyCommittedSessionAuthority({
            permission: this.writer.getSnapshot().permission,
            record: result.record as import("@agent-anything/permission").SessionAuthorityRecord,
          })
        : applyCommittedPolicyAmendment({
            permission: this.writer.getSnapshot().permission,
            record: result.record as import("@agent-anything/governance").AppliedPolicyAmendmentRecord,
          });
      this.writer.commitState(() => Object.freeze({ permission }));
    }
    return result.application;
  }

  private consumeApprovalCoverage(coverageId: string): boolean {
    const current = this.writer.getSnapshot().permission;
    const coverage = current.actionCoverage.find((candidate) => candidate.id === coverageId);
    if (coverage === undefined) return false;
    const result = consumeActionApprovalCoverage({
      permission: current,
      coverageId,
      runId: coverage.runId,
      actionId: coverage.actionId,
      actionFingerprint: coverage.actionFingerprint,
    });
    if (result.status !== "consumed") return false;
    this.writer.commitState(() => Object.freeze({ permission: result.permission }));
    return true;
  }

  private actionPermissionContext() {
    const state = this.writer.getSnapshot();
    return Object.freeze({
      authoritySnapshotId: `run-permission:${state.revision}`,
      profile: this.config.permissions.permissionProfile,
      approvalPolicy: this.config.permissions.approvalPolicy,
      actionCoverage: state.permission.actionCoverage,
      runGrants: state.permission.runPermissionGrants,
      sessionAuthority: state.permission.sessionAuthorityRecords,
      sessionAuthorityContext: this.config.permissions.sessionAuthority?.context ?? null,
    });
  }

  private updateApprovalActivity(
    update: (current: RunState["permission"]["approvalActivity"]) =>
      RunState["permission"]["approvalActivity"],
  ): void {
    this.writer.commitState((state) => Object.freeze({
      permission: Object.freeze({
        ...state.permission,
        approvalActivity: Object.freeze(update(state.permission.approvalActivity)),
      }),
    }));
  }

  private enterCancelling(request: import("../run/index.js").RunCancellationRequest): void {
    const state = this.writer.getSnapshot();
    if (!isActiveStatus(state.status)) return;
    const summary = toRunCancellationSummary(request);
    this.writer.commit({
      kind: "cancellation_transition",
      transition: "requested",
      cancellation: summary,
    }, () => Object.freeze({
      status: "cancelling" as const,
      cancellationRequest: request,
    }));
    this.interactions.cancelAll(request.id);
  }

  private async settle(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    if (this.terminalResult !== null) return this.terminalResult;
    this.drainSteering(candidate.status === "cancelled" ? "cancelled" : "run_settled");
    this.interactions.close();
    this.drainInteractionSettlements();
    let terminal = candidate;
    const stateBeforeFinalization = this.writer.getSnapshot();
    if (stateBeforeFinalization.plan?.status === "active") {
      const abandoned = abandonPlan({
        plan: stateBeforeFinalization.plan,
        terminalStatus: terminal.status,
        reasonCode: terminal.status === "failed" || terminal.status === "blocked"
          ? terminal.code
          : terminal.status === "cancelled"
            ? "runtime_cancelled"
            : null,
        now: this.now(),
      });
      if (abandoned.status === "abandoned") {
        this.writer.commit({
          kind: "state_transition",
          transition: "plan",
          previousRevision: stateBeforeFinalization.plan.version,
          plan: projectPlan(abandoned.plan),
        }, () => Object.freeze({ plan: abandoned.plan }));
      }
    }

    const finalization = createRunFinalizationContext({
      runId: this.runId,
      cancellation: this.config.cancellation.context.request === null
        ? null
        : toRunCancellationSummary(this.config.cancellation.context.request),
      timeoutMs: this.config.cancellationLimits.finalizationTimeoutMs,
      startedAt: this.now(),
    });
    try {
      const resourceFailures = await Promise.all(
        (this.dependencies.resourceFinalizers ?? []).map(async (finalizer) => {
          try {
            return await finalizer.finalize(finalization.context);
          } catch {
            return runtimeFailure(
              "runtime_resource_finalization_failed",
              "A required Run resource finalizer failed.",
              {},
            );
          }
        }),
      );
      const failures = [
        ...resourceFailures.filter((failure): failure is RunFailureCause => failure !== null),
        ...await this.recordLifecycle(
          terminal.status,
          new Set(),
          finalizationObservabilityContext(finalization.context),
        ),
      ];
      if (failures.length > 0) {
        terminal = {
          status: "failed",
          code: "required_finalization_failed",
          failure: failures[0]!,
          relatedFailures: failures.slice(1),
        };
      }
    } finally {
      finalization.dispose();
    }

    if (terminal.status === "succeeded" &&
        this.config.cancellation.context.request !== null) {
      terminal = { status: "cancelled" };
    }

    const completedAt = this.now();
    const cancellationRequest = this.config.cancellation.context.request;
    const payload: RunItemPayload<TOutput> = terminal.status === "succeeded"
      ? {
          kind: "terminal_transition",
          status: "succeeded",
          code: null,
          output: terminal.output,
          failure: null,
        }
      : terminal.status === "blocked"
        ? {
            kind: "terminal_transition",
            status: "blocked",
            code: terminal.code,
            output: null,
            failure: null,
          }
        : terminal.status === "cancelled"
          ? {
              kind: "terminal_transition",
              status: "cancelled",
              code: "runtime_cancelled",
              output: null,
              failure: null,
            }
          : {
              kind: "terminal_transition",
              status: "failed",
              code: terminal.code,
              output: null,
              failure: terminal.failure,
            };
    this.writer.commit(payload, () => terminalStatePatch(
      terminal,
      cancellationRequest,
      completedAt,
    ));
    await this.closeValidation(completedAt);
    const state = this.writer.getSnapshot();
    const base = {
      runId: this.runId,
      taskId: state.taskId,
      startingAgent: state.startingAgent,
      finalActiveAgent: state.activeAgent,
      startedAt: state.startedAt,
      completedAt,
      items: state.items,
      evidenceRefs: state.evidenceRefs,
      artifactRefs: state.artifactRefs,
      metadata: state.metadata,
    };
    const result = terminal.status === "succeeded"
      ? createSucceededRunResult(base, terminal.output)
      : terminal.status === "blocked"
        ? createBlockedRunResult<TOutput>(base, terminal.code)
        : terminal.status === "cancelled"
          ? createCancelledRunResult<TOutput>(
              base,
              toRunCancellationSummary(requireCancellation(cancellationRequest)),
            )
          : createFailedRunResult<TOutput>(
              base,
              terminal.code,
              terminal.failure,
              terminal.relatedFailures ?? [],
              cancellationRequest === null ? null : toRunCancellationSummary(cancellationRequest),
            );
    this.terminalResult = result;
    this.emitTerminal(result);
    completeRunnerTrace(this.traceAssembler, result);
    this.publishCurrentState();
    return result;
  }

  private failureFromError(error: unknown): Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }> {
    if (error instanceof ValidationExecutionError) {
      return {
        status: "failed",
        code: "validation_failed",
        failure: createRunFailureCause("validation", error.failure),
      };
    }
    if (error instanceof ContextContractError) {
      return {
        status: "failed",
        code: "context_projection_failed",
        failure: createRunFailureCause("context", Object.freeze({
          code: error.failure.code,
          message: error.failure.message,
          retryable: false,
          path: error.failure.path,
          metadata: Object.freeze({ path: error.failure.path }),
        })),
      };
    }
    if (error instanceof ControllerError) {
      return {
        status: "failed",
        code: "controller_failed",
        failure: createRunFailureCause(error.failure.kind, error.failure.failure),
      } as Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }>;
    }
    if (
      error instanceof ToolExposureCoordinationError ||
      error instanceof ToolExposureValidationError
    ) {
      return {
        status: "failed",
        code: "tool_exposure_failed",
        failure: createRunFailureCause("tool", Object.freeze({
          code: error.code,
          message: error.message,
          retryable: false,
          metadata: Object.freeze({ source: error.name }),
        })),
      };
    }
    if (error instanceof OperationSettlementTimeoutError) {
      return {
        status: "failed",
        code: "unknown_effect",
        failure: runtimeFailure(
          "runtime_operation_settlement_unconfirmed",
          error.message,
          { operation: error.operation, interruptionKind: error.interruptionKind },
        ),
      };
    }
    return {
      status: "failed",
      code: "runtime_execution_failed",
      failure: runtimeFailure(
        "runtime_execution_failed",
        error instanceof Error ? error.message : "Agent Runtime execution failed.",
        error instanceof Error ? { causeName: error.name } : {},
      ),
    };
  }

  private async closeValidation(closedAt: string): Promise<void> {
    if (this.validationExecution === null || this.validationClosed) return;
    this.validationClosed = true;
    const current = await this.validationExecution.readCurrentSnapshot();
    try {
      await this.validationExecution.closeCurrentState({
        expectedRevision: current.ref.revision,
        closedAt,
      });
    } catch {
      // Terminal Run truth is already committed; late Validation close failure is diagnostic only.
    }
  }

  private operationFailureResult(
    registration: RegisteredOperation,
    invocation: OperationInvocationRef,
    status: Exclude<OperationResult["status"], "succeeded" | "partial">,
    owner: string,
    code: string,
    startedAt: string,
    finishedAt: string,
  ): OperationResult {
    return createOperationResult({
      ref: Object.freeze({ invocation, id: this.id("operation_result") }),
      binding: registration.binding.ref,
      semanticOwner: registration.operation.semanticOwner,
      status,
      output: null,
      failure: operationFailure(owner, code),
      startedAt,
      finishedAt,
      lowerRefs: Object.freeze([]),
      metadata: Object.freeze({}),
    });
  }

  private emitOperation(
    registration: RegisteredOperation,
    bindingKind: ResolvedOperationBinding["kind"],
    context: OperationInvocationContext,
    result: OperationResult,
  ): void {
    this.emit("operation.started", {
      invocationId: context.invocation.id,
      operationNamespace: context.invocation.operation.operation.namespace,
      operationName: context.invocation.operation.operation.name,
      operationRevision: context.invocation.operation.revision,
      semanticOwner: registration.operation.semanticOwner,
      bindingKind,
      correlationKind: context.correlation.kind,
      parentInvocationId: context.parentInvocation?.id ?? null,
      parentRunActionId: context.correlation.kind === "run_action"
        ? context.correlation.runAction.id
        : null,
    }, result.startedAt);
    this.emit("operation.finished", {
      invocationId: context.invocation.id,
      status: result.status,
      code: result.failure?.code ?? null,
      resultId: result.ref.id,
      lowerResultRefs: Object.freeze([]),
    }, result.finishedAt);
  }

  private runActionCorrelation(action: RuntimeRunAction): OperationCorrelation {
    return Object.freeze({
      kind: "run_action",
      run: action.ref.run,
      runAction: action.ref,
      provenance: action.provenance,
      materializationRevision: action.basis.runRevision,
    });
  }

  private runActionCorrelationByRef(ref: RunActionRef): OperationCorrelation {
    const item = this.writer.getSnapshot().items.find(
      (candidate) => candidate.payload.kind === "run_action" &&
        candidate.payload.action.ref.id === ref.id,
    );
    if (item?.payload.kind !== "run_action") {
      throw new TypeError("Approval parent RunAction is not committed in this Run.");
    }
    return this.runActionCorrelation(item.payload.action);
  }

  private invocationInterruption(): InvocationInterruptionContext {
    const context = this.config.cancellation.context;
    return Object.freeze({
      signal: context.signal,
      get interruption() {
        const request = context.request;
        return request === null || !context.signal.aborted
          ? null
          : Object.freeze({
              kind: "run_cancellation" as const,
              cancellation: Object.freeze({
                runId: request.runId,
                requestId: request.id,
              }),
            });
      },
    });
  }

  private retryEvents(): RetryEventSink {
    return Object.freeze({
      emit: (candidate: import("../retry/index.js").RetryEvent) => {
        this.recordRetry(snapshotRetryEvent(candidate, this.runId));
        this.publishCurrentState();
      },
    });
  }

  private recordRetry(event: import("../retry/index.js").RetryEvent): void {
    const current = this.retryProjection ?? Object.freeze({
      attemptCount: 0,
      scheduledCount: 0,
      fallbackCount: 0,
      exhaustedCount: 0,
      cancellationCount: 0,
      omittedEventCount: 0,
      recentEvents: Object.freeze([]),
    });
    const events = [...current.recentEvents, event];
    const omitted = Math.max(0, events.length - 16);
    this.retryProjection = Object.freeze({
      attemptCount: current.attemptCount + (event.type === "retry_attempt_started" ? 1 : 0),
      scheduledCount: current.scheduledCount + (event.type === "retry_scheduled" ? 1 : 0),
      fallbackCount: current.fallbackCount + (event.type === "retry_fallback_selected" ? 1 : 0),
      exhaustedCount: current.exhaustedCount + (event.type === "retry_exhausted" ? 1 : 0),
      cancellationCount: current.cancellationCount + (event.type === "retry_cancelled" ? 1 : 0),
      omittedEventCount: current.omittedEventCount + omitted,
      recentEvents: Object.freeze(events.slice(omitted)),
    });
  }

  private onStateCommitted(state: RunState<TOutput>): void {
    if (this.runStartedEventEmitted) {
      this.emitCommittedContextTransition(state.context);
      this.emitCommittedRunItems(state);
    }
    this.publishCurrentState();
  }

  private emitCommittedRunItems(state: RunState<TOutput>): void {
    while (this.emittedItemCount < state.items.length) {
      const item = state.items[this.emittedItemCount++]!;
      this.emit("run.item.appended", {
        itemId: item.ref.id,
        itemKind: item.payload.kind,
        itemSequence: item.ref.sequence,
      }, item.createdAt);
      if (item.payload.kind === "progress_assessment") {
        const assessment = item.payload.assessment;
        this.emit("run.progress.assessed", {
          checkpointSequence: assessment.ref.checkpointSequence,
          disposition: assessment.disposition,
          reasonCode: assessment.reasonCode,
          factRefs: assessment.factRefs,
          consecutiveNonAdvancingCheckpoints:
            assessment.consecutiveNonAdvancingCheckpoints,
          correctionRounds: assessment.correctionRounds,
          activeCorrectionRound: assessment.activeCorrectionRound,
        }, item.createdAt);
      } else if (item.payload.kind === "progress_correction") {
        const feedback = item.payload.feedback;
        this.emit("run.progress.correction_requested", {
          checkpointSequence: feedback.assessment.checkpointSequence,
          correctionRound: feedback.correctionRound,
          reasonCode: feedback.reasonCode,
          factRefs: feedback.factRefs,
        }, item.createdAt);
      } else if (item.payload.kind === "controller_turn") {
        const exposure = item.payload.toolExposure;
        this.emit("controller.tool_exposure.resolved", {
          turnId: item.payload.turn.id,
          iteration: item.payload.turn.sequence,
          controllerRequestId: exposure.controllerRequestId,
          manifestId: exposure.manifestId,
          selectionRevision: exposure.selectionRevision,
          contentRevision: exposure.contentRevision,
          basisRevision: exposure.basisRevision,
          proofId: exposure.proofId,
          catalogRevision: exposure.catalogRevision,
          exposedToolCount: exposure.exposedToolCount,
          omittedToolCount: exposure.omittedToolCount,
          omissionReasons: exposure.omissionReasons,
        }, item.createdAt);
      }
    }
  }

  private emitCommittedContextTransition(context: ActiveContext): void {
    const transitionId = context.appliedTransitionId;
    if (transitionId === null || transitionId === this.emittedContextTransitionId) return;
    const transition = this.pendingContextTransitions.get(transitionId);
    if (transition === undefined) return;
    this.emit("context.transition.committed", {
      transitionId,
      activeContextId: context.ref.id,
      baseVersion: transition.base.version,
      committedVersion: context.ref.version,
      proposerOwner: transition.proposer.owner,
      proposerKind: transition.proposer.kind,
      causeKind: transition.cause.kind,
      causeId: transition.cause.id,
      correlationId: transition.correlationId,
      operationKinds: Object.freeze(
        transition.operations.map((operation) => operation.kind),
      ),
    }, transition.createdAt);
    this.emittedContextTransitionId = transitionId;
    this.pendingContextTransitions.delete(transitionId);
  }

  private publishCurrentState(): void {
    const state = this.writer.getSnapshot();
    const childPending = [...this.childHandles].flatMap((handle) =>
      handle.getSnapshot().pendingInteractions
    );
    this.onUpdate({
      runRevision: state.revision,
      status: state.status,
      lastRunItemSequence: state.items.at(-1)?.ref.sequence ?? 0,
      plan: state.plan === null ? null : projectPlan(state.plan),
      progress: projectRunProgress(
        state.progress,
        this.latestProgressAssessment(state),
      ),
      retry: this.retryProjection,
      validation: this.validationHostProjection,
      pendingInteractions: Object.freeze([
        ...this.interactions.getPendingProjections(),
        ...childPending,
      ]),
      result: this.terminalResult,
    });
  }

  private latestProgressAssessment(
    state: RunState<TOutput>,
  ): RunProgressAssessment | null {
    if (state.progress.latestAssessment === null) return null;
    for (let index = state.items.length - 1; index >= 0; index -= 1) {
      const payload = state.items[index]!.payload;
      if (
        payload.kind === "progress_assessment" &&
        payload.assessment.ref.checkpointSequence ===
          state.progress.latestAssessment.checkpointSequence
      ) {
        return payload.assessment;
      }
    }
    throw new TypeError("Run Progress state references a missing assessment RunItem.");
  }

  private emit<TName extends RuntimeEventName>(
    name: TName,
    payload: RuntimeEventPayloadMap[TName],
    occurredAt = this.now(),
  ): void {
    try {
      this.eventStream.emit(name, payload, occurredAt);
    } catch {
      // Notifications remain non-authoritative.
    }
  }

  private emitContextProjectionCompleted(
    manifest: ProjectionManifest,
    outcome: "projected" | "blocked",
    code: string | null,
  ): void {
    const counts = {
      included: 0,
      transformed: 0,
      referenced: 0,
      omitted: 0,
      rejected: 0,
      blocked: 0,
    };
    for (const record of manifest.records) counts[record.disposition] += 1;
    this.emit("context.projection.completed", {
      manifestId: manifest.id,
      projectionId: manifest.projectionId,
      requestId: manifest.requestId,
      activeContextId: manifest.activeContext.id,
      activeContextVersion: manifest.activeContext.version,
      profileId: manifest.profile.id,
      profileRevision: manifest.profile.revision,
      policyId: manifest.policy.id,
      policyRevision: manifest.policy.revision,
      estimatorId: manifest.estimator.id,
      estimatorRevision: manifest.estimator.revision,
      accountingUnit: manifest.accounting.unit,
      budgetMaximum: manifest.budget.maximum,
      consideredItemCount: manifest.accounting.consideredItems,
      projectedItemCount: manifest.accounting.projectedItems,
      projectedAmount: manifest.accounting.projectedAmount,
      includedCount: counts.included,
      transformedCount: counts.transformed,
      referencedCount: counts.referenced,
      omittedCount: counts.omitted,
      rejectedCount: counts.rejected,
      blockedCount: counts.blocked,
      outcome,
      code,
    });
  }

  private async persistSafeContextManifest(
    manifest: ProjectionManifest,
    outcome: "projected" | "blocked",
    code: string | null,
  ): Promise<void> {
    const persistence = this.dependencies.contextProjection.manifestPersistence;
    if (persistence === undefined) return;
    try {
      await persistence.persistManifest(createSafeProjectionManifest({
        manifest,
        outcome,
        code,
      }));
    } catch {
      // Optional safe Manifest persistence cannot advance or fail the Run.
    }
  }

  private emitTerminal(result: RunResult<TOutput>): void {
    const payload = {
      status: result.status,
      code: result.code,
      durationMs: Math.max(0, Date.parse(result.completedAt) - this.startedAtMs),
      itemCount: result.items.length,
      evidenceCount: result.evidenceRefs.length,
      artifactCount: result.artifactRefs.length,
      errorCodes: Object.freeze(result.failure === null
        ? []
        : [result.failure.failure.code, ...result.relatedFailures.map((failure) => failure.failure.code)]),
    };
    if (result.status === "succeeded") this.emit("run.completed", { ...payload, status: "succeeded", code: null });
    else if (result.status === "blocked") this.emit("run.blocked", { ...payload, status: "blocked", code: result.code });
    else if (result.status === "cancelled") this.emit("run.cancelled", { ...payload, status: "cancelled", code: result.code });
    else this.emit("run.failed", { ...payload, status: "failed", code: result.code });
  }

  private async recordLifecycle(
    phase: "started" | "succeeded" | "blocked" | "failed" | "cancelled",
    skipKinds = new Set<import("../run/index.js").RunFailureKind>(),
    context: ObservabilityRecordContext = this.runtimeObservabilityContext(),
  ): Promise<RunFailureCause[]> {
    const state = this.writer.getSnapshot();
    return recordRunnerLifecycle({
      phase,
      runId: this.runId,
      taskId: state.taskId,
      agentId: state.activeAgent.id,
      startedAtMs: this.startedAtMs,
      timestamp: this.now(),
      counters: state.counters,
      itemCount: state.items.length,
      workspace: this.config.workspace,
      identity: this.config.identity,
      auditRequirement: this.config.audit,
      telemetryRequirement: this.config.telemetry,
      context,
      auditPort: this.dependencies.auditPort,
      telemetryPort: this.dependencies.telemetryPort,
      skipKinds,
    });
  }

  private runtimeObservabilityContext(): ObservabilityRecordContext {
    return Object.freeze({
      purpose: "runtime",
      signal: this.config.cancellation.context.signal,
      deadlineAt: null,
    });
  }

  private id(kind: Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"], sequence?: number): string {
    const current = this.identitySequences.get(kind) ?? 0;
    const next = sequence ?? current + 1;
    this.identitySequences.set(kind, Math.max(current, next));
    return this.dependencies.createId({
      kind,
      runId: this.runId,
      sequence: next,
    });
  }

  private now(): string {
    const value = this.dependencies.now();
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      !Number.isFinite(Date.parse(value))
    ) throw new TypeError("Runner clock must return an ISO date-time.");
    return value;
  }
}

function terminalStatePatch<TOutput>(
  terminal: TerminalCandidate<TOutput>,
  cancellationRequest: import("../run/index.js").RunCancellationRequest | null,
  completedAt: string,
): Readonly<Record<string, unknown>> {
  if (terminal.status === "succeeded") return Object.freeze({
    status: "succeeded",
    code: null,
    finalOutput: terminal.output,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: null,
    completedAt,
    pending: Object.freeze([]),
  });
  if (terminal.status === "blocked") return Object.freeze({
    status: "blocked",
    code: terminal.code,
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: null,
    completedAt,
    pending: Object.freeze([]),
  });
  if (terminal.status === "cancelled") return Object.freeze({
    status: "cancelled",
    code: "runtime_cancelled",
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]),
    cancellationRequest: requireCancellation(cancellationRequest),
    completedAt,
    pending: Object.freeze([]),
  });
  return Object.freeze({
    status: "failed",
    code: terminal.code,
    finalOutput: null,
    failure: terminal.failure,
    relatedFailures: Object.freeze([...(terminal.relatedFailures ?? [])]),
    cancellationRequest,
    completedAt,
    pending: Object.freeze([]),
  });
}

function runtimeFailure(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Extract<RunFailureCause, { readonly kind: "runtime" }> {
  return createRunFailureCause("runtime", Object.freeze({
    code,
    message,
    retryable: false,
    metadata: Object.freeze({ ...metadata }),
  }));
}

function operationFailure(owner: string, code: string, message = code): OperationFailure {
  return Object.freeze({
    owner,
    code,
    message,
    retryable: false,
    metadata: Object.freeze({}),
  });
}

function isActionEffectCertainty(
  value: unknown,
): value is import("@agent-anything/canonical-action/settlement").ActionEffectCertainty {
  return value === "none" || value === "confirmed" ||
    value === "partial" || value === "unknown";
}

function operationResultFromAction(
  registration: RegisteredOperation,
  binding: Extract<ResolvedOperationBinding, { readonly kind: "direct" | "hosted" }>,
  outcome: Extract<ActionExecutionResult, { readonly status: "settled" }>,
  startedAt: string,
  finishedAt: string,
  resultId: string,
): OperationResult {
  const semantic = outcome.semanticResult;
  const failure = semantic.failure === null
    ? null
    : operationFailure(semantic.failure.owner, semantic.failure.code, semantic.failure.message);
  return createOperationResult({
    ref: Object.freeze({ invocation: binding.invocation, id: resultId }),
    binding: binding.binding,
    semanticOwner: registration.operation.semanticOwner,
    status: semantic.status,
    output: semantic.output,
    failure,
    startedAt,
    finishedAt,
    lowerRefs: Object.freeze([{
      owner: "canonical-action",
      kind: "action_settlement",
      id: outcome.settlement.ref.id,
      revision: outcome.settlement.subject === null
        ? null
        : String(outcome.settlement.subject.revision),
    }]),
    metadata: Object.freeze({
      actionId: outcome.settlement.action.id,
      effectCertainty: outcome.settlement.effectCertainty,
      completionExtent: outcome.settlement.completionExtent,
    }),
  } as OperationResult);
}

function operationResultFromComposite(
  registration: RegisteredOperation,
  binding: Extract<ResolvedOperationBinding, { readonly kind: "composite" }>,
  result: CompositeResult,
  startedAt: string,
  finishedAt: string,
  resultId: string,
): OperationResult {
  const status = result.status;
  return createOperationResult({
    ref: Object.freeze({ invocation: binding.invocation, id: resultId }),
    binding: binding.binding,
    semanticOwner: registration.operation.semanticOwner,
    status,
    output: result.output,
    failure: result.failure === null
      ? null
      : operationFailure("operation-composition", result.failure.code, result.failure.message),
    startedAt,
    finishedAt,
    lowerRefs: Object.freeze(result.children.flatMap((child) =>
      child.result === null ? [] : [{
        owner: child.result.semanticOwner,
        kind: "operation_result",
        id: child.result.ref.id,
        revision: child.result.binding.revision,
      }]
    )),
    metadata: Object.freeze({
      compositeId: result.compositeId,
      childCount: result.children.length,
    }),
  } as OperationResult);
}

function adaptToolResult(call: ToolCall, result: OperationResult): ToolResult | null {
  try {
    return adaptToolSemanticResult(call, {
      operationInvocation: result.ref.invocation,
      status: result.status === "timed_out" ? "timeout" : result.status,
      output: result.output,
      error: result.failure === null
        ? null
        : Object.freeze({
            code: result.failure.code,
            message: result.failure.message,
            metadata: result.failure.metadata,
          }),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      metadata: result.metadata,
    });
  } catch {
    return null;
  }
}

function succeededToolResult(
  call: ToolCall,
  settlement: ToolSettlementRef,
  output: unknown,
  startedAt: string,
  finishedAt: string,
): ToolResult {
  if (output === null || output === undefined) {
    throw new TypeError("Succeeded Tool result requires output.");
  }
  return Object.freeze({
    toolCall: Object.freeze({ toolCallId: call.toolCallId, toolRevision: call.toolRevision }),
    settlement,
    status: "succeeded" as const,
    output,
    startedAt,
    finishedAt,
    metadata: Object.freeze({ bindingKind: call.binding.kind }),
  });
}

function partialToolResult(
  call: ToolCall,
  settlement: ToolSettlementRef,
  output: unknown,
  failure: OperationFailure,
  startedAt: string,
  finishedAt: string,
): ToolResult {
  if (output === null || output === undefined) {
    throw new TypeError("Partial Tool result requires usable output.");
  }
  return Object.freeze({
    toolCall: Object.freeze({ toolCallId: call.toolCallId, toolRevision: call.toolRevision }),
    settlement,
    status: "partial" as const,
    output,
    outputUsability: "validated" as const,
    error: Object.freeze({
      code: failure.code,
      message: failure.message,
      metadata: failure.metadata,
    }),
    startedAt,
    finishedAt,
    metadata: Object.freeze({ bindingKind: call.binding.kind }),
  });
}

function failedToolResult(
  call: ToolCall,
  settlement: ToolSettlementRef,
  code: string,
  message: string,
  startedAt: string,
  finishedAt: string,
  status: "failed" | "timeout" = "failed",
): ToolResult {
  return Object.freeze({
    toolCall: Object.freeze({ toolCallId: call.toolCallId, toolRevision: call.toolRevision }),
    settlement,
    status,
    error: Object.freeze({ code, message }),
    startedAt,
    finishedAt,
    metadata: Object.freeze({ bindingKind: call.binding.kind }),
  });
}

function toolResultLowerRef(result: ToolResult): RunObservation["lowerRefs"][number] {
  return Object.freeze({
    owner: "tools",
    kind: "tool_result",
    id: result.toolCall.toolCallId,
    revision: result.toolCall.toolRevision.revision,
  });
}

function observationFailed(observation: RunObservation): boolean {
  switch (observation.payload.kind) {
    case "operation":
      return observation.payload.result.status !== "succeeded" &&
        observation.payload.result.status !== "partial";
    case "operation_rejected":
    case "tool_rejected":
      return true;
    case "handoff":
      return observation.payload.status !== "applied";
    case "interaction":
      return observation.payload.status !== "resolved";
    case "descendant_run":
      return observation.payload.status !== "succeeded" &&
        observation.payload.status !== "partial";
    case "plan_update":
      return observation.payload.result.status === "rejected";
  }
}

function bindingMatchesResolution(
  registration: RegisteredOperation,
  context: OperationInvocationContext,
  binding: ResolvedOperationBinding,
): boolean {
  return binding.kind === registration.binding.kind &&
    binding.invocation.id === context.invocation.id &&
    binding.invocation.operation.revision === context.invocation.operation.revision &&
    binding.binding.revision === registration.binding.ref.revision &&
    binding.resolverRevision === registration.binding.resolverRevision &&
    binding.correlation.kind === context.correlation.kind;
}

function resolutionBindingKind(registration: RegisteredOperation): ResolvedOperationBinding["kind"] {
  return registration.binding.kind;
}

function rejectedDescendant(
  relationId: string,
  code: Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["code"],
  childRunId: string | null,
  operationStatus: Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["operationStatus"],
): Extract<DescendantExecutionOutcome, { readonly status: "rejected" }> {
  return Object.freeze({
    status: "rejected" as const,
    relationId,
    childRunId,
    code,
    operationStatus,
  });
}

function descendantRejectionStatus(
  code: DescendantRunReservationFailureCode | "descendant_run_start_failed",
): Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["operationStatus"] {
  switch (code) {
    case "descendant_run_start_cancelled":
      return "cancelled";
    case "descendant_run_deadline_exceeded":
      return "timed_out";
    case "descendant_run_start_failed":
      return "failed";
    case "descendant_run_depth_limit_exceeded":
    case "descendant_run_total_limit_exceeded":
    case "descendant_run_active_limit_exceeded":
      return "unavailable";
  }
}

function sameAgentRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function deriveActiveStatus(
  status: RunState["status"],
  pending: readonly PendingRunSubject[],
): RunState["status"] {
  if (!isActiveStatus(status)) return status;
  return deriveActiveRunStatus({ pending, progressableBranchIds: Object.freeze([]) });
}

function isActiveStatus(status: RunState["status"]): boolean {
  return status === "initializing" || status === "running" || status === "waiting";
}

function sameInteractionRequest(
  left: import("@agent-anything/interaction/protocol").InteractionRequestRef,
  right: import("@agent-anything/interaction/protocol").InteractionRequestRef,
): boolean {
  return left.id === right.id &&
    left.requestVersion === right.requestVersion &&
    left.protocol.owner === right.protocol.owner &&
    left.protocol.kind === right.protocol.kind &&
    left.protocol.revision === right.protocol.revision &&
    left.subject.owner === right.subject.owner &&
    left.subject.kind === right.subject.kind &&
    left.subject.id === right.subject.id &&
    left.subject.revision === right.subject.revision;
}

function interactionRequestKey(
  request: import("@agent-anything/interaction/protocol").InteractionRequestRef,
): string {
  return [
    request.protocol.owner,
    request.protocol.kind,
    request.protocol.revision,
    request.id,
    request.requestVersion,
    request.subject.owner,
    request.subject.kind,
    request.subject.id,
    request.subject.revision,
  ].join(":");
}

function terminalRecordRef(record: InteractionTerminalRecord): string {
  return record.kind === "resolved"
    ? record.resolution.resolutionId
    : record.kind === "failed"
      ? record.failureRef
      : `${record.request.id}:${record.kind}`;
}

function findParentRunActionId(
  state: RunState,
  interactionRequestId: string,
): string | null {
  for (const item of state.items) {
    if (
      item.payload.kind === "run_action" &&
      item.payload.action.subject.kind === "interaction" &&
      item.payload.action.subject.request?.id === interactionRequestId
    ) return item.payload.action.ref.id;
  }
  return null;
}

function requireCancellation(
  request: import("../run/index.js").RunCancellationRequest | null,
): import("../run/index.js").RunCancellationRequest {
  if (request === null) throw new TypeError("Cancelled Run requires a cancellation request.");
  return request;
}

function approvalSubmissionDigest(
  submission: import("@agent-anything/permission/approval").ApprovalDecisionSubmission,
): Promise<string> {
  return createCanonicalSha256Digest(
    "agent-anything.approval-interaction-submission.v1",
    submission,
  );
}

function finalizationObservabilityContext(
  context: import("../run/index.js").RunFinalizationContext,
): ObservabilityRecordContext {
  return Object.freeze({
    purpose: "finalization",
    signal: context.signal,
    deadlineAt: context.deadlineAt,
  });
}

function controllerToolExposureRecord(
  proof: ToolExposureProof,
  manifestId: string,
): ControllerToolExposureRecord {
  return Object.freeze({
    proofId: proof.id,
    controllerRequestId: proof.controllerRequestId,
    manifestId,
    selectionRevision: proof.selectionRevision,
    contentRevision: proof.contentRevision,
    basisRevision: proof.basisRevision,
    catalogRevision: proof.catalog.revision,
    exposedTools: proof.exposedTools,
    exposedToolCount: proof.exposedTools.length,
    omittedToolCount: proof.omittedToolCount,
    omissionReasons: proof.omissionReasons,
  });
}

function composeActionExecutionObservers(
  configured: ActionExecutionObserver | undefined,
  invocation: ActionExecutionObserver | undefined,
): ActionExecutionObserver | undefined {
  const observers = [invocation, configured].filter(
    (observer, index, values): observer is ActionExecutionObserver =>
      observer !== undefined && values.indexOf(observer) === index,
  );
  return observers.length === 0
    ? undefined
    : Object.freeze({
        observe(notification: Parameters<ActionExecutionObserver["observe"]>[0]) {
          for (const observer of observers) {
            try {
              void Promise.resolve(observer.observe(notification)).catch(
                () => undefined,
              );
            } catch {
              // One observer cannot affect execution or another observer.
            }
          }
        },
      });
}
