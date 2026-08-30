import type { Agent } from "@agent-anything/agent-core/agent";
import { snapshotAgent, toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef, InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { AgentTask } from "@agent-anything/agent-core/task";
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
} from "@agent-anything/verification/completion";
import {
  createVerificationFailure,
  materializeVerificationProfile,
  type VerificationFailure,
  type VerificationRequirement,
} from "@agent-anything/verification/definition";
import {
  VerificationExecutionError,
  type CheckResult,
  type VerificationExecutionPort,
  type VerificationOperationCheckInput,
  type VerificationOperationCheckResolverPort,
  type VerificationLowerCheckSettlement,
} from "@agent-anything/verification/execution";
import type { VerificationHostProjection, VerificationRunnerProjection } from "@agent-anything/verification/projection";
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
import {
  modelCallRefKey,
  snapshotModelJsonValue,
  snapshotModelToolResult,
  type ModelCallSettlementKind,
  type ModelJsonValue,
  type ModelToolCall,
  type ModelToolResult,
} from "@agent-anything/model-interaction";
import { materializeToolCall, type ToolCall } from "@agent-anything/tools/invocation";
import {
  ToolExposureValidationError,
  type ToolExposureProof,
} from "@agent-anything/tools/selection";
import {
  ControllerError,
  validateControllerDecision,
  type ControllerDecision,
  type ModelInteractionProjection,
  type InteractionRequestCandidate,
  type OperationRequestCandidate,
  type ProgressionCandidate,
  type SameRunHandoffRequest,
  type ToolRequestCandidate,
} from "../controller/index.js";
import {
  createTaskFulfillmentFailure,
  snapshotTaskFulfillmentAssessment,
  snapshotTaskFulfillmentEvaluationInput,
  type TaskFulfillmentAssessment,
  type TaskFulfillmentEvaluationInput,
  type TaskFulfillmentEvaluationResult,
  type TaskFulfillmentFailure,
} from "../completion/index.js";
import {
  abandonPlan,
  applyPlanUpdate,
  projectPlan,
} from "../plan/index.js";
import { snapshotRetryEvent, type RetryEventSink } from "../retry/index.js";
import {
  projectRunStopReview,
  snapshotRunStopFeedback,
  snapshotRunStopReviewRecord,
  type RunStopCheck,
  type RunStopFeedback,
  type RunStopLimitation,
} from "../stop/index.js";
import { RunTranscriptRecorder } from "../transcript/index.js";
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
import type { ResolvedRunConfig, RunConfig } from "./RunConfig.js";
import type {
  RunnerAutomaticEffectfulVerificationCheckPort,
  RunnerAutomaticEffectfulVerificationCheckRequest,
  RunnerVerificationCheckRequest,
  ResolvedRunnerDependencies,
} from "./RunnerDependencies.js";
import {
  assertDelegationAuthorityRequestWithinCeiling,
  projectDelegationRunAuthority,
  projectDelegationRunLimits,
} from "../delegation/DelegationRunConfiguration.js";
import {
  deriveDelegationAuthority,
  deriveDelegationLimits,
  constructDelegationResult,
  createDelegationContextMaterial,
  materializeDelegationRequest,
  snapshotDelegationSteeringRoute,
  snapshotDelegationPreparation,
  snapshotDelegationContextMaterial,
  type DelegationAuthorityDerivation,
  type DelegationAuthorityDimensionInput,
  type DelegationAuthoritySourceInput,
  type DelegationLimitDerivation,
  type DelegationLimitSourceInput,
  type DelegationLimits,
  type DelegationContextMaterial,
  type DelegationPreparation,
  type DelegationRequest,
  type DelegationResult,
  type DelegationSteeringReceipt,
  type DelegationSteeringRoute,
} from "../delegation/index.js";
import { createDelegationContractIdentity } from "../delegation/DelegationContract.js";
import type {
  RunTreeResourceRecordResult,
  RunTreeResourceSettlement,
} from "./RunTreeResourceAccount.js";
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
  createAgentInstructionBinding,
  projectAgentInstructionBinding,
  type AgentInstructionBinding,
} from "../instructions/index.js";
import {
  OperationSettlementTimeoutError,
  RunInterruptionCoordinator,
} from "./RunInterruptionCoordinator.js";
import { RunInteractionCoordinator, type RuntimeInteractionSettlement } from "./RunInteractionCoordinator.js";
import { evaluateRunDeadline, evaluateRunNumericLimits, type RunLimitViolation } from "./RunLoopLimits.js";
import { recordRunnerLifecycle } from "./RunnerObservability.js";
import { completeRunnerTrace, createRunnerTraceAssembler } from "./RunnerTracing.js";
import { RunStateWriter } from "./RunStateWriter.js";
import {
  createCurrentRunContextAdmissionProfile,
  createCurrentRunContextContributions,
  createDelegationRootPurposeContextAdmissionProfile,
  createDelegationRootPurposeContextContribution,
  createDelegationPredecessorContextAdmissionProfile,
  createDelegationPredecessorContextContribution,
  createObservationContextAdmissionProfile,
  createObservationContextContribution,
  createStopFeedbackContextAdmissionProfile,
  createStopFeedbackContextContribution,
  createSteeringContextAdmissionProfile,
  createSteeringContextContribution,
  createTaskContextAdmissionProfile,
  createTaskContextContribution,
  createVerificationContextAdmissionProfile,
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
  readonly request: DelegationRequest;
  readonly rootPurpose: DelegationContextMaterial;
  readonly predecessor: DelegationContextMaterial | null;
  readonly authority: DelegationAuthorityDerivation;
  readonly limits: DelegationLimitDerivation;
}

export type RuntimeDescendantRunStartResult =
  | {
      readonly status: "started";
      readonly relation: DescendantRunRelation;
      readonly handle: RunHandle;
      readonly resourceSettlement: Promise<RunTreeResourceSettlement>;
      readonly reservedTreeRevision: number;
      readonly treeRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | DescendantRunReservationFailureCode
        | "descendant_run_start_failed"
        | "delegation_request_invalid"
        | "delegation_authority_invalid"
        | "delegation_context_invalid"
        | "delegation_resource_limit_exceeded";
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
  readonly instructionBinding: AgentInstructionBinding;
  readonly projection: ContextProjection;
  readonly exposure: ToolExposureProof;
  readonly exposureOwnerBasisRevision: string;
}

interface OperationExecutionOutcome {
  readonly result: OperationResult;
  readonly toolResult: ToolResult | null;
}

interface CandidateProcessingOutcome<TOutput> {
  readonly invalidatesRemainder: boolean;
  readonly terminal: TerminalCandidate<TOutput> | null;
}

type DescendantExecutionOutcome =
  | {
      readonly status: "settled";
      readonly relationId: string;
      readonly childRunId: string;
      readonly result: DelegationResult;
      readonly resourceSettlement: RunTreeResourceSettlement;
    }
  | {
      readonly status: "rejected";
      readonly relationId: string | null;
      readonly childRunId: string | null;
      readonly code:
        | DescendantRunReservationFailureCode
        | "delegation_preparation_failed"
        | "delegation_request_invalid"
        | "delegation_authority_invalid"
        | "delegation_context_invalid"
        | "delegation_resource_limit_exceeded"
        | "delegation_result_invalid"
        | "delegation_result_projection_failed"
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
  private activeInstructionBinding: AgentInstructionBinding;
  private readonly instructionRevisionByAgentRevision = new Map<string, string>();
  private terminalResult: RunResult<TOutput> | null = null;
  private emittedItemCount = 0;
  private nextInteractionRequest = 1;
  private readonly identitySequences = new Map<
    Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"],
    number
  >();
  private readonly childHandles = new Map<string, {
    readonly request: DelegationRequest;
    readonly childRunId: string;
    readonly handle: import("./RunHandle.js").RunHandle;
  }>();
  private readonly settledDelegations = new Map<string, {
    readonly result: DelegationResult;
    readonly material: DelegationContextMaterial;
  }>();
  private readonly interactionActions = new Map<string, InteractionActionContext>();
  private readonly interactionSettlements: QueuedInteractionSettlement[] = [];
  private readonly modelCallSettlementWaits = new Set<Promise<void>>();
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
  private verificationExecution: VerificationExecutionPort | null = null;
  private verificationRequirements: readonly VerificationRequirement[] = Object.freeze([]);
  private verificationClosed = false;
  private verificationHostProjection: VerificationHostProjection | null = null;
  private readonly emittedVerificationRecordKeys = new Set<string>();
  private readonly toolExposure: RunToolExposureCoordinator;
  private readonly transcript: RunTranscriptRecorder;
  private accountedResourceItemCount = 0;
  private resourceFailure: Extract<
    RunTreeResourceRecordResult,
    { readonly status: "limit_exceeded" | "measurement_unavailable" }
  > | null = null;
  private lastAuthorityPermission: RunState<TOutput>["permission"];

  constructor(
    private readonly runId: string,
    private readonly dependencies: ResolvedRunnerDependencies,
    agent: Agent<TOutput>,
    private readonly input: RunInput,
    private readonly config: ResolvedRunConfig,
    private readonly rootTask: AgentTask,
    private readonly rootConfig: RunConfig,
    private readonly delegationRequest: DelegationRequest | null,
    private readonly delegationRootPurpose: DelegationContextMaterial | null,
    private readonly delegationPredecessor: DelegationContextMaterial | null,
    private readonly lineage: RunLineage,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: ActionExecutionObserver | undefined,
    startedAt: string,
    deadlineAt: string,
    private readonly startDescendantRun: RuntimeDescendantRunStarter,
    initialContextBytes: number,
    private readonly runTree: import("./RunTreeExecution.js").RunTreeExecution,
    private readonly onUpdate: (update: RunExecutionUpdate<TOutput>) => void,
  ) {
    this.startedAt = startedAt;
    this.startedAtMs = Date.parse(this.startedAt);
    this.activeAgent = agent;
    this.activeInstructionBinding = createAgentInstructionBinding({
      run: Object.freeze({ id: runId }),
      agent,
      effectiveFromRunRevision: 0,
      supersedes: null,
    });
    this.instructionRevisionByAgentRevision.set(
      agentRevisionKey(agent),
      agent.instructions.ref.revision,
    );
    this.transcript = new RunTranscriptRecorder(dependencies.runTranscriptPort ?? null);
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
      instructionBinding: this.activeInstructionBinding,
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
    this.lastAuthorityPermission = initial.permission;
    this.recordTreeResources({
      contextBytes: Object.freeze({
        status: "measured" as const,
        value: initialContextBytes,
      }),
    });

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
      delegation: dependencies.operations.delegation?.preparation,
      getRunRevision: () => this.writer.getSnapshot().revision,
      getRunTreeSnapshot: () => this.runTree.getSnapshot(),
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
    for (const { handle } of this.childHandles.values()) {
      const outcome = handle.submitInteraction(input);
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

  submitDescendantSteering(input: DelegationSteeringRoute): DelegationSteeringReceipt {
    let route: DelegationSteeringRoute;
    try {
      route = snapshotDelegationSteeringRoute(input);
    } catch {
      return rejectedDelegationSteering("delegation_route_invalid", null, null);
    }
    const direct = this.childHandles.get(route.relation.id);
    if (direct !== undefined) {
      if (
        direct.request.ref.id !== route.request.id ||
        direct.request.ref.revision !== route.request.revision ||
        direct.childRunId !== route.child.id
      ) {
        return rejectedDelegationSteering(
          "delegation_route_mismatch",
          route.relation,
          route.child,
        );
      }
      if (direct.handle.getResult() !== null) {
        return rejectedDelegationSteering(
          "delegation_child_settled",
          route.relation,
          route.child,
        );
      }
      return Object.freeze({
        status: "routed" as const,
        relation: route.relation,
        child: route.child,
        submission: direct.handle.steer(route.steering),
      });
    }
    const settled = [...this.settledDelegations.values()].find(({ result }) =>
      result.correlation.relation.ref.id === route.relation.id
    );
    if (settled !== undefined) {
      return rejectedDelegationSteering(
        settled.result.request.id === route.request.id &&
          settled.result.request.revision === route.request.revision &&
          settled.result.correlation.child.run.id === route.child.id
          ? "delegation_child_settled"
          : "delegation_route_mismatch",
        route.relation,
        route.child,
      );
    }
    for (const { handle } of this.childHandles.values()) {
      const nested = handle.steerDescendant(route);
      if (
        nested.status !== "rejected" ||
        nested.code !== "delegation_relation_unknown"
      ) {
        return nested;
      }
    }
    return rejectedDelegationSteering(
      "delegation_relation_unknown",
      route.relation,
      route.child,
    );
  }

  async run(): Promise<RunResult<TOutput>> {
    this.interruptionCoordinator.start();
    try {
      const initialContext = this.delegationRequest === null
        ? this.writer.getSnapshot().context
        : this.applyContextContributions(
            this.writer.getSnapshot().context,
            Object.freeze([createDelegationRootPurposeContextContribution({
              id: this.id("context_contribution"),
              runId: this.runId,
              material: this.delegationRootPurpose!,
              createdAt: this.startedAt,
            })]),
            createDelegationRootPurposeContextAdmissionProfile(
              this.delegationRootPurpose!,
            ),
            "delegation_initialization",
            this.delegationRequest.ref.id,
          );
      const contextWithPredecessor = this.delegationPredecessor === null
        ? initialContext
        : this.applyContextContributions(
            initialContext,
            Object.freeze([createDelegationPredecessorContextContribution({
              id: this.id("context_contribution"),
              runId: this.runId,
              material: this.delegationPredecessor,
              createdAt: this.startedAt,
            })]),
            createDelegationPredecessorContextAdmissionProfile(
              this.delegationPredecessor,
            ),
            "delegation_continuation_initialization",
            this.delegationRequest!.ref.id,
          );
      const taskContribution = createTaskContextContribution({
        id: this.id("context_contribution"),
        runId: this.runId,
        task: this.input.task,
      });
      this.writer.commitState((current) => Object.freeze({
        status: "running" as const,
        context: this.applyContextContributions(
          contextWithPredecessor,
          Object.freeze([taskContribution]),
          createTaskContextAdmissionProfile(),
          "run_initialization",
          this.runId,
        ),
      }));
      this.emit("run.started", {
        status: "running",
        activeAgentId: this.activeAgent.id,
        activeAgentRevision: this.activeAgent.revision,
        instructionBindingId: this.activeInstructionBinding.ref.id,
        instructionBindingRevision: this.activeInstructionBinding.ref.revision,
      }, this.startedAt);
      this.runStartedEventEmitted = true;
      this.emitCommittedContextTransition(this.writer.getSnapshot().context);
      this.emitCommittedRunItems(this.writer.getSnapshot());
      await this.initializeVerification();
      const startFailures = await this.recordLifecycle("started");
      if (startFailures.length > 0) {
        return await this.settle({
          status: "failed",
          code: "required_finalization_failed",
          failure: startFailures[0]!,
          relatedFailures: startFailures.slice(1),
        });
      }

      while (this.terminalResult === null) {
        this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          return await this.settle({ status: "cancelled" });
        }
        if (this.resourceFailure !== null) {
          return await this.settleResourceFailure(this.resourceFailure);
        }
        this.drainSteering("apply");
        const deadline = evaluateRunDeadline({
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          now: this.now(),
        });
        if (deadline !== null) return await this.settleLimitViolation(deadline);

        const numericLimit = evaluateRunNumericLimits({
          counters: this.writer.getSnapshot().counters,
          limits: this.config.limits,
        });
        if (numericLimit !== null) return await this.settleLimitViolation(numericLimit);

        const decision = await this.nextDecision();
        if (decision === null) continue;
        if (this.resourceFailure !== null) {
          return await this.settleResourceFailure(this.resourceFailure);
        }
        const settlementsAfterDecision = this.drainInteractionSettlements();
        if (this.config.cancellation.context.request !== null) {
          this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "cancelled",
            "run_cancelled_before_model_calls",
          );
          return await this.settle({ status: "cancelled" });
        }
        if (settlementsAfterDecision > 0) {
          this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "invalidated",
            "run_basis_changed_before_model_calls",
          );
          continue;
        }
        if (this.drainSteering("apply") > 0) {
          this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "invalidated",
            "run_steering_invalidated_model_calls",
          );
          continue;
        }
        if (decision.decision.kind === "propose_completion") {
          const completion = await this.evaluateRunStop(
            decision.turn,
            decision.decision.output,
            decision.prepared.input.interaction,
          );
          if (completion.kind === "succeeded") {
            return await this.settle({ status: "succeeded", output: decision.decision.output });
          }
          if (completion.kind === "blocked") {
            return await this.settle({ status: "blocked", code: completion.code });
          }
          if (completion.kind === "failed") {
            return await this.settle({
              status: "failed",
              code: completion.owner === "verification"
                ? "verification_failed"
                : "task_fulfillment_failed",
              failure: completion.owner === "verification"
                ? createRunFailureCause("verification", completion.failure)
                : createRunFailureCause("task_fulfillment", completion.failure),
            });
          }
          if (completion.kind === "cancelled") {
            return await this.settle({ status: "cancelled" });
          }
          if (completion.kind === "wait") {
            await this.waitForMandatoryVerification(completion);
          }
          continue;
        }
        if (decision.decision.kind === "propose_stop") {
          this.settleTerminalControllerCall(decision.decision, decision.turn);
          return await this.settle({
            status: "blocked",
            code: "runtime_no_safe_path",
          });
        }

        const basis: CandidateBasis<TOutput> = {
          turn: decision.turn,
          runRevision: decision.basisRevision,
          activeAgent: decision.agent,
          instructionBinding: decision.prepared.input.instructionBinding,
          projection: decision.prepared.context,
          exposure: decision.prepared.input.toolExposure,
          exposureOwnerBasisRevision: decision.exposureOwnerBasisRevision,
        };
        for (let index = 0; index < decision.decision.candidates.length; index += 1) {
          if (this.config.cancellation.context.request !== null) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index,
              decision.turn,
              "cancelled",
              "run_cancelled_before_model_call",
            );
            break;
          }
          if (this.drainInteractionSettlements() > 0) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index,
              decision.turn,
              "invalidated",
              "run_basis_changed_before_model_call",
            );
            break;
          }
          if (this.drainSteering("apply") > 0) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index,
              decision.turn,
              "invalidated",
              "run_steering_invalidated_model_call",
            );
            break;
          }
          if (index > 0) {
            const currentExposure = await this.toolExposure.resolve(decision.turn.id);
            if (currentExposure.ownerBasisRevision !== basis.exposureOwnerBasisRevision) {
              this.settleCandidateRange(
                decision.decision.candidates,
                index,
                decision.turn,
                "invalidated",
                "tool_exposure_basis_changed",
              );
              break;
            }
          }
          let outcome: CandidateProcessingOutcome<TOutput>;
          try {
            outcome = await this.processCandidate(
              decision.decision.candidates[index]!,
              index,
              basis,
            );
          } catch (error) {
            const cancelled = this.config.cancellation.context.request !== null;
            this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              cancelled ? "cancelled" : "invalidated",
              cancelled
                ? "run_cancelled_after_model_call_failure"
                : "model_call_failure_invalidated_remainder",
            );
            throw error;
          }
          if (outcome.terminal !== null) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              "run_terminated_before_model_call",
            );
            return await this.settle(outcome.terminal);
          }
          if (this.drainSteering("apply") > 0) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              "run_steering_invalidated_model_call",
            );
            break;
          }
          if (outcome.invalidatesRemainder) {
            this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              "earlier_model_call_invalidated_remainder",
            );
            break;
          }
        }
        await this.waitForModelCallSettlements();
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

  private async initializeVerification(): Promise<void> {
    const execution = await this.dependencies.verification.executionFactory.create({
      run: Object.freeze({ id: this.runId }),
      operationChecks: this.createVerificationOperationCheckResolver(),
    });
    if (!execution || typeof execution.admitSpecification !== "function") {
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_execution_unavailable",
        stage: "admission",
        message: "Verification execution factory did not create a valid Run-scoped execution.",
        retryable: false,
        cause: this.config.verification.profile.ref,
      }), 0);
    }
    this.verificationExecution = execution;
    const materialized = materializeVerificationProfile({
      profile: this.config.verification.profile,
      run: { id: this.runId },
      createdAt: this.startedAt,
    });
    this.verificationRequirements = materialized.requirements;
    await execution.admitSpecification({
      specification: materialized.specification,
      requirements: materialized.requirements,
      expectedRevision: 0,
    }, this.invocationInterruption());
    try {
      if (this.dependencies.verification.preparation !== null) {
        await this.dependencies.verification.preparation.prepare({
          run: Object.freeze({ id: this.runId }),
          execution,
          automaticEffectfulChecks: this.createAutomaticEffectfulVerificationCheckPort(),
        }, this.invocationInterruption());
      }
    } catch (error) {
      if (error instanceof VerificationExecutionError) throw error;
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_preparation_failed",
        stage: "admission",
        message: error instanceof Error ? error.message : "Verification preparation failed.",
        retryable: false,
        cause: this.config.verification.profile.ref,
      }), (await execution.readCurrentSnapshot()).ref.revision);
    }
    await this.commitVerificationFeedback(null);
  }

  private async evaluateRunStop(
    turn: ControllerTurnRef,
    output: TOutput,
    interaction: ModelInteractionProjection,
  ): Promise<
    | { readonly kind: "succeeded" | "continue" | "cancelled" }
    | { readonly kind: "blocked"; readonly code: "verification_blocked" | "runtime_stop_feedback_exhausted" }
    | {
        readonly kind: "wait";
        readonly snapshotRevision: number;
        readonly pending: readonly {
          readonly attemptId: string;
          readonly attemptOrdinal: number;
          readonly requirementId: string;
          readonly requirementRevision: string;
        }[];
      }
    | { readonly kind: "failed"; readonly owner: "verification"; readonly failure: VerificationFailure }
    | { readonly kind: "failed"; readonly owner: "task_fulfillment"; readonly failure: TaskFulfillmentFailure }
  > {
    const execution = this.requireVerificationExecution();
    let runState = this.writer.getSnapshot();
    if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
    if (runState.status !== "running" && runState.status !== "waiting") {
      return { kind: "continue" };
    }
    const current = await execution.readCurrentSnapshot();
    const gateSteeringEpoch = this.steeringEpoch;
    const outputDigest = await createCanonicalSha256Digest(
      "agent-anything.verification.completion-output.v1",
      output,
    );
    const proposal = Object.freeze({
      id: this.id("verification_proposal"),
      revision: outputDigest,
    });
    const objectiveRevision = await createCanonicalSha256Digest(
      "agent-anything.task-objective.v1",
      this.input.task,
    );
    const fulfillmentRequestedAt = this.now();
    const fulfillmentConfiguredDeadline = Date.parse(fulfillmentRequestedAt) +
      this.dependencies.completion.maximumDurationMs;
    const fulfillmentDeadlineAt = new Date(Math.min(
      Date.parse(runState.deadlineAt),
      fulfillmentConfiguredDeadline,
    )).toISOString();
    const fulfillmentInput = snapshotTaskFulfillmentEvaluationInput({
      assessment: Object.freeze({
        id: this.id("task_fulfillment_assessment"),
        revision: "1",
      }),
      run: runState.run,
      turn,
      objective: Object.freeze({
        id: this.input.task.id,
        kind: this.input.task.kind,
        revision: objectiveRevision,
      }),
      task: this.input.task,
      proposal,
      output,
      interaction,
      verification: Object.freeze({
        snapshot: current.ref,
        gate: runState.verification.gate,
      }),
      requestedAt: fulfillmentRequestedAt,
      deadlineAt: fulfillmentDeadlineAt,
    });
    const fulfillmentBasisRevision = runState.revision;
    const fulfillmentSteeringEpoch = this.steeringEpoch;
    const fulfillmentResult = await this.invokeTaskFulfillment(fulfillmentInput);
    if (this.config.cancellation.context.request !== null) {
      return { kind: "cancelled" };
    }
    if (fulfillmentResult.kind === "cancelled") {
      return this.recordTaskFulfillmentStopFailure({
        turn,
        proposal,
        failure: createTaskFulfillmentFailure({
          code: "task_fulfillment_cancellation_unattributed",
          message: "Task Fulfillment evaluation returned cancellation without an accepted Run cancellation.",
          retryable: false,
          metadata: Object.freeze({
            evaluatorId: this.dependencies.completion.taskFulfillment.ref.id,
            cancellationRequestId: fulfillmentResult.cancellation.requestId,
            cancellationRunId: fulfillmentResult.cancellation.runId,
          }),
        }),
      });
    }
    if (fulfillmentResult.kind === "failed") {
      return this.recordTaskFulfillmentStopFailure({
        turn,
        proposal,
        failure: fulfillmentResult.failure,
      });
    }
    let fulfillment: TaskFulfillmentAssessment;
    try {
      fulfillment = snapshotTaskFulfillmentAssessment(fulfillmentResult.assessment);
      this.assertCurrentTaskFulfillmentAssessment(fulfillmentInput, fulfillment);
    } catch (error) {
      return this.recordTaskFulfillmentStopFailure({
        turn,
        proposal,
        failure: createTaskFulfillmentFailure({
          code: "task_fulfillment_assessment_invalid",
          message: error instanceof Error ? error.message : "Task Fulfillment Assessment is invalid.",
          retryable: false,
          metadata: Object.freeze({ evaluatorId: this.dependencies.completion.taskFulfillment.ref.id }),
        }),
      });
    }
    const currentAfterFulfillment = await execution.readCurrentSnapshot();
    if (this.writer.getSnapshot().revision !== fulfillmentBasisRevision ||
        this.steeringEpoch !== fulfillmentSteeringEpoch ||
        currentAfterFulfillment.ref.revision !== current.ref.revision) {
      return { kind: "continue" };
    }
    this.writer.commit({
      kind: "task_fulfillment_assessment",
      assessment: fulfillment,
    });
    runState = this.writer.getSnapshot();
    if (runState.status !== "running" && runState.status !== "waiting") {
      return { kind: "continue" };
    }
    const gateRequestedAt = this.now();
    const gateConfiguredDeadline = Date.parse(gateRequestedAt) +
      this.config.verification.completion.maximumDurationMs;
    const gateDeadlineAt = new Date(Math.min(
      Date.parse(runState.deadlineAt),
      gateConfiguredDeadline,
    )).toISOString();
    const invocation = Object.freeze({
      id: this.id("verification_gate"),
      revision: "1",
    });
    const mandatoryStates = current.requirementStates.flatMap((state) => {
      const requirement = this.verificationRequirements.find((candidate) =>
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
    const gateInput = snapshotCompletionGateInput({
      invocation,
      run: runState.run,
      turn,
      proposal,
      proposalOutputDigest: outputDigest,
      outputContract: this.config.verification.completion.outputContract,
      specification: current.specification,
      verificationSnapshot: current.ref,
      mandatoryStates,
      pendingWork: mandatoryStates.flatMap((item) =>
        item.current.pendingAttempts.map((attempt) => Object.freeze({
          owner: "verification",
          kind: "check_attempt",
          id: attempt.id,
          revision: String(attempt.ordinal),
        }))),
      conditions: this.config.verification.completion.conditions,
      lifecycle: {
        runRevision: runState.revision,
        status: runState.status,
        cancellationRevision: this.config.cancellation.context.request === null ? 0 : 1,
        deadlineAt: gateDeadlineAt,
      },
      policy: this.config.verification.completion.policy,
      correlation: this.config.verification.profile.ref,
      requestedAt: gateRequestedAt,
    });

    let decision: CompletionGateDecision;
    try {
      decision = snapshotCompletionGateDecision(await this.invokeCompletionGate(gateInput));
    } catch (error) {
      if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
      return this.recordVerificationStopFailure({
        turn,
        proposal,
        fulfillment,
        revision: String(current.ref.revision),
        failure: error instanceof VerificationExecutionError
          ? error.failure
          : createVerificationFailure({
              code: "verification_gate_failed",
              stage: "completion_gate",
              message: error instanceof Error ? error.message : "Completion Gate evaluation failed.",
              retryable: false,
              cause: this.config.verification.completion.policy,
            }),
      });
    }
    const afterGate = this.writer.getSnapshot();
    const currentAfterGate = await execution.readCurrentSnapshot();
    if (currentAfterGate.ref.revision !== current.ref.revision ||
        decision.invocation.id !== invocation.id ||
        decision.invocation.revision !== invocation.revision ||
        decision.verificationSnapshot.runId !== current.ref.runId ||
        decision.verificationSnapshot.revision !== current.ref.revision) {
      return { kind: "continue" };
    }
    const runBasisCurrent = afterGate.revision === runState.revision &&
      this.steeringEpoch === gateSteeringEpoch &&
      this.config.cancellation.context.request === null;
    const inputRevision = await createCanonicalSha256Digest(
      "agent-anything.verification.completion-gate-input.v1",
      gateInput,
    );
    const recorded = await execution.recordCompletionGate({
      record: { ref: invocation, inputRevision, decision },
      expectedRevision: current.ref.revision,
    }, this.invocationInterruption());
    if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
    if (!runBasisCurrent || this.writer.getSnapshot().revision !== runState.revision) {
      return { kind: "continue" };
    }
    await this.commitVerificationFeedback(decision);

    if (decision.status === "completion_eligible") {
      return this.resolveStopReview({
        turn,
        proposal,
        fulfillment,
        verification: Object.freeze({
          status: "passed" as const,
          code: "verification_completion_eligible",
          message: "Configured mandatory Verification permits completion.",
          revision: String(recorded.current.ref.revision),
        }),
      });
    }
    if (decision.status === "invalid" || decision.status === "failed") {
      return this.recordVerificationStopFailure({
        turn,
        proposal,
        fulfillment,
        revision: String(recorded.current.ref.revision),
        failure: decision.failure,
      });
    }
    if (decision.disposition === "fail") {
      return this.recordVerificationStopFailure({
        turn,
        proposal,
        fulfillment,
        revision: String(recorded.current.ref.revision),
        failure: createVerificationFailure({
          code: "verification_completion_policy_failed",
          stage: "completion_gate",
          message: decision.reasons[0].message,
          retryable: false,
          cause: this.config.verification.completion.policy,
        }),
      });
    }
    if (decision.disposition === "block") {
      this.commitStopReviewRecord({
        turn,
        proposal,
        decision: "failed",
        checks: this.stopChecks(fulfillment, Object.freeze({
          status: "failed",
          code: decision.reasons[0]?.code ?? "verification_blocked",
          message: decision.reasons[0]?.message ?? "Verification blocked completion.",
          revision: String(recorded.current.ref.revision),
        })),
      });
      return { kind: "blocked", code: "verification_blocked" };
    }
    if (decision.disposition === "wait" && gateInput.pendingWork.length === 0) {
      return this.recordVerificationStopFailure({
        turn,
        proposal,
        fulfillment,
        revision: String(recorded.current.ref.revision),
        failure: createVerificationFailure({
          code: "verification_gate_wait_without_pending_work",
          stage: "completion_gate",
          message: "Completion Gate requested waiting without exact active pending work.",
          retryable: false,
          cause: this.config.verification.completion.policy,
        }),
      });
    }
    if (decision.disposition === "wait") {
      this.commitStopReviewRecord({
        turn,
        proposal,
        decision: "wait",
        checks: this.stopChecks(fulfillment, Object.freeze({
          status: "wait",
          code: decision.reasons[0]?.code ?? "verification_waiting",
          message: decision.reasons[0]?.message ?? "Verification is waiting for exact active mandatory work.",
          revision: String(recorded.current.ref.revision),
        })),
      });
      return {
        kind: "wait",
        snapshotRevision: recorded.current.ref.revision,
        pending: mandatoryStates.flatMap((item) =>
          item.current.status === "pending"
            ? item.current.pendingAttempts.map((attempt) => Object.freeze({
                attemptId: attempt.id,
                attemptOrdinal: attempt.ordinal,
                requirementId: item.current.requirement.id,
                requirementRevision: item.current.requirement.revision,
              }))
            : []),
      };
    }
    return this.resolveStopReview({
      turn,
      proposal,
      fulfillment,
      verification: Object.freeze({
        status: "continue" as const,
        code: decision.reasons[0]?.code ?? "verification_continue_required",
        message: decision.reasons[0]?.message ?? "Verification requires more work before completion.",
        revision: String(recorded.current.ref.revision),
      }),
    });
  }

  private async waitForMandatoryVerification(input: {
    readonly snapshotRevision: number;
    readonly pending: readonly {
      readonly attemptId: string;
      readonly attemptOrdinal: number;
      readonly requirementId: string;
      readonly requirementRevision: string;
    }[];
  }): Promise<void> {
    if (input.pending.length === 0) {
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_gate_wait_without_pending_work",
        stage: "completion_gate",
        message: "Completion Gate waiting requires exact active mandatory work.",
        retryable: false,
        cause: this.config.verification.completion.policy,
      }), input.snapshotRevision);
    }
    const pendingSubjects = input.pending.map((item): PendingRunSubject => Object.freeze({
      kind: "verification_check",
      attemptId: item.attemptId,
      attemptOrdinal: item.attemptOrdinal,
      requirementId: item.requirementId,
      requirementRevision: item.requirementRevision,
      branchId: `verification:${item.attemptId}#${item.attemptOrdinal}`,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    }));
    for (const pending of pendingSubjects) this.addPending(pending);
    this.publishCurrentState();

    const deadlineAt = this.writer.getSnapshot().deadlineAt;
    const waitController = new AbortController();
    const runSignal = this.invocationInterruption().signal;
    const abortForRun = () => waitController.abort();
    runSignal.addEventListener("abort", abortForRun, { once: true });
    let deadlineExpired = false;
    const timeout = setTimeout(() => {
      deadlineExpired = true;
      waitController.abort();
    }, Math.max(1, Date.parse(deadlineAt) - Date.parse(this.now())));
    try {
      await this.requireVerificationExecution().waitForCurrentSnapshotChange(
        input.snapshotRevision,
        Object.freeze({ signal: waitController.signal, interruption: null }),
      );
    } catch (error) {
      if (!deadlineExpired && this.config.cancellation.context.request === null) throw error;
    } finally {
      clearTimeout(timeout);
      runSignal.removeEventListener("abort", abortForRun);
      const transition = this.config.cancellation.context.request !== null
        ? "cancelled" as const
        : deadlineExpired
          ? "expired" as const
          : "resolved" as const;
      for (const pending of pendingSubjects) this.removePending(pending, transition, null);
      this.publishCurrentState();
    }
  }

  private async invokeTaskFulfillment(
    input: TaskFulfillmentEvaluationInput,
  ): Promise<TaskFulfillmentEvaluationResult> {
    const delay = Math.max(
      1,
      Math.min(
        this.dependencies.completion.maximumDurationMs,
        Date.parse(input.deadlineAt) - Date.parse(input.requestedAt),
      ),
    );
    const runInterruption = this.invocationInterruption();
    const local = new AbortController();
    const abortForRun = () => local.abort();
    if (runInterruption.signal.aborted) local.abort();
    else runInterruption.signal.addEventListener("abort", abortForRun, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TaskFulfillmentEvaluationResult>((resolve) => {
      timeout = setTimeout(() => {
        local.abort();
        resolve(Object.freeze({
          kind: "failed" as const,
          failure: createTaskFulfillmentFailure({
            code: "task_fulfillment_evaluation_timed_out",
            message: "Task Fulfillment evaluation exceeded its deadline.",
            retryable: true,
            metadata: Object.freeze({ evaluatorId: this.dependencies.completion.taskFulfillment.ref.id }),
          }),
        }));
      }, delay);
    });
    try {
      return await Promise.race([
        this.dependencies.completion.taskFulfillment.evaluate(
          input,
          Object.freeze({
            signal: local.signal,
            interruption: runInterruption.interruption,
          }),
        ),
        timedOut,
      ]);
    } catch (error) {
      return Object.freeze({
        kind: "failed" as const,
        failure: createTaskFulfillmentFailure({
          code: "task_fulfillment_evaluation_failed",
          message: error instanceof Error ? error.message : "Task Fulfillment evaluation failed.",
          retryable: false,
          metadata: Object.freeze({ evaluatorId: this.dependencies.completion.taskFulfillment.ref.id }),
        }),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      runInterruption.signal.removeEventListener("abort", abortForRun);
    }
  }

  private assertCurrentTaskFulfillmentAssessment(
    input: TaskFulfillmentEvaluationInput,
    assessment: TaskFulfillmentAssessment,
  ): void {
    const evaluator = this.dependencies.completion.taskFulfillment.ref;
    if (
      assessment.ref.id !== input.assessment.id ||
      assessment.ref.revision !== input.assessment.revision ||
      assessment.evaluator.owner !== evaluator.owner ||
      assessment.evaluator.id !== evaluator.id ||
      assessment.evaluator.revision !== evaluator.revision ||
      assessment.run.id !== input.run.id ||
      assessment.turn.id !== input.turn.id ||
      assessment.turn.sequence !== input.turn.sequence ||
      assessment.objective.id !== input.objective.id ||
      assessment.objective.kind !== input.objective.kind ||
      assessment.objective.revision !== input.objective.revision ||
      assessment.proposal.id !== input.proposal.id ||
      assessment.proposal.revision !== input.proposal.revision
    ) {
      throw new TypeError("Task Fulfillment Assessment does not match its exact evaluation input.");
    }
  }

  private resolveStopReview(input: {
    readonly turn: ControllerTurnRef;
    readonly proposal: Readonly<{ readonly id: string; readonly revision: string }>;
    readonly fulfillment: TaskFulfillmentAssessment;
    readonly verification: Readonly<{
      readonly status: "passed" | "continue";
      readonly code: string;
      readonly message: string;
      readonly revision: string;
    }>;
  }): { readonly kind: "succeeded" | "continue" } |
      { readonly kind: "blocked"; readonly code: "runtime_stop_feedback_exhausted" } {
    const checks = [...this.stopChecks(input.fulfillment, input.verification)];
    const required = checks.find((check) =>
      check.severity === "required" && check.status === "continue"
    );
    if (required !== undefined) {
      const state = this.writer.getSnapshot().stopReview;
      if (
        state.requiredFeedbackRounds >=
          this.config.limits.stopReview.maxRequiredFeedbackRounds
      ) {
        this.commitStopReviewRecord({
          turn: input.turn,
          proposal: input.proposal,
          decision: "failed",
          checks,
          limitations: Object.freeze([Object.freeze({
            owner: required.owner,
            code: "required_stop_feedback_exhausted",
            message: "Required Stop Review feedback was exhausted before completion became eligible.",
          })]),
        });
        return { kind: "blocked", code: "runtime_stop_feedback_exhausted" };
      }
      this.commitStopReviewRecord({
        turn: input.turn,
        proposal: input.proposal,
        decision: "continue_run",
        checks,
        feedback: Object.freeze({
          owner: required.owner,
          severity: "required",
          code: required.code,
          message: required.message,
        }),
      });
      return { kind: "continue" };
    }

    const plan = this.writer.getSnapshot().plan;
    if (plan !== null && plan.status === "active") {
      const planCheck: RunStopCheck = Object.freeze({
        owner: "plan",
        severity: "advisory",
        status: "continue",
        code: "plan_reconciliation_requested",
        message: "The active Plan has not been reconciled with the proposed completion. Update or complete the Plan, continue work, or explain why its remaining state no longer applies.",
        subjectId: plan.id,
        revision: String(plan.version),
      });
      checks.push(planCheck);
      const state = this.writer.getSnapshot().stopReview;
      if (
        state.advisoryFeedbackRounds <
          this.config.limits.stopReview.maxAdvisoryFeedbackRounds
      ) {
        this.commitStopReviewRecord({
          turn: input.turn,
          proposal: input.proposal,
          decision: "continue_run",
          checks,
          feedback: Object.freeze({
            owner: "plan",
            severity: "advisory",
            code: planCheck.code,
            message: planCheck.message,
          }),
        });
        return { kind: "continue" };
      }
      const limitation: RunStopLimitation = Object.freeze({
        owner: "plan",
        code: "plan_reconciliation_feedback_exhausted",
        message: "The Run stopped after exhausting advisory Plan reconciliation feedback.",
      });
      this.commitStopReviewRecord({
        turn: input.turn,
        proposal: input.proposal,
        decision: "allow_stop",
        checks,
        limitations: Object.freeze([limitation]),
      });
      return { kind: "succeeded" };
    }

    this.commitStopReviewRecord({
      turn: input.turn,
      proposal: input.proposal,
      decision: "allow_stop",
      checks,
    });
    return { kind: "succeeded" };
  }

  private stopChecks(
    fulfillment: TaskFulfillmentAssessment,
    verification: Readonly<{
      readonly status: RunStopCheck["status"];
      readonly code: string;
      readonly message: string;
      readonly revision: string;
    }>,
  ): readonly RunStopCheck[] {
    const fulfillmentPassed = fulfillment.status === "fulfilled";
    return Object.freeze([
      Object.freeze({
        owner: "task_fulfillment" as const,
        severity: "required" as const,
        status: fulfillmentPassed ? "passed" as const : "continue" as const,
        code: fulfillmentPassed
          ? "task_fulfillment_satisfied"
          : fulfillment.status === "incomplete"
            ? "task_fulfillment_incomplete"
            : "task_fulfillment_uncertain",
        message: fulfillmentPassed
          ? "The Product Task Fulfillment assessment permits completion."
          : fulfillment.feedback!,
        subjectId: fulfillment.ref.id,
        revision: fulfillment.ref.revision,
      }),
      Object.freeze({
        owner: "verification" as const,
        severity: "required" as const,
        status: verification.status,
        code: verification.code,
        message: verification.message,
        subjectId: this.config.verification.profile.ref.id,
        revision: verification.revision,
      }),
    ]);
  }

  private recordTaskFulfillmentStopFailure(input: {
    readonly turn: ControllerTurnRef;
    readonly proposal: Readonly<{ readonly id: string; readonly revision: string }>;
    readonly failure: TaskFulfillmentFailure;
  }): { readonly kind: "failed"; readonly owner: "task_fulfillment"; readonly failure: TaskFulfillmentFailure } {
    const evaluator = this.dependencies.completion.taskFulfillment.ref;
    this.commitStopReviewRecord({
      turn: input.turn,
      proposal: input.proposal,
      decision: "failed",
      checks: Object.freeze([Object.freeze({
        owner: "task_fulfillment" as const,
        severity: "required" as const,
        status: "failed" as const,
        code: input.failure.code,
        message: input.failure.message,
        subjectId: evaluator.id,
        revision: evaluator.revision,
      })]),
    });
    return Object.freeze({
      kind: "failed" as const,
      owner: "task_fulfillment" as const,
      failure: input.failure,
    });
  }

  private recordVerificationStopFailure(input: {
    readonly turn: ControllerTurnRef;
    readonly proposal: Readonly<{ readonly id: string; readonly revision: string }>;
    readonly fulfillment: TaskFulfillmentAssessment;
    readonly revision: string;
    readonly failure: VerificationFailure;
  }): { readonly kind: "failed"; readonly owner: "verification"; readonly failure: VerificationFailure } {
    this.commitStopReviewRecord({
      turn: input.turn,
      proposal: input.proposal,
      decision: "failed",
      checks: this.stopChecks(input.fulfillment, Object.freeze({
        status: "failed",
        code: input.failure.code,
        message: input.failure.message,
        revision: input.revision,
      })),
    });
    return Object.freeze({
      kind: "failed" as const,
      owner: "verification" as const,
      failure: input.failure,
    });
  }

  private commitStopReviewRecord(input: {
    readonly turn: ControllerTurnRef;
    readonly proposal: Readonly<{ readonly id: string; readonly revision: string }>;
    readonly decision: "allow_stop" | "continue_run" | "wait" | "failed";
    readonly checks: readonly RunStopCheck[];
    readonly feedback?: Readonly<{
      readonly owner: RunStopFeedback["owner"];
      readonly severity: RunStopFeedback["severity"];
      readonly code: string;
      readonly message: string;
    }>;
    readonly limitations?: readonly RunStopLimitation[];
  }): void {
    const before = this.writer.getSnapshot();
    const ref = Object.freeze({
      runId: this.runId,
      sequence: before.stopReview.reviewSequence + 1,
    });
    const requiredFeedbackRounds = before.stopReview.requiredFeedbackRounds +
      (input.feedback?.severity === "required" ? 1 : 0);
    const advisoryFeedbackRounds = before.stopReview.advisoryFeedbackRounds +
      (input.feedback?.severity === "advisory" ? 1 : 0);
    const limitations = Object.freeze([
      ...before.stopReview.limitations,
      ...(input.limitations ?? []),
    ]);
    const review = snapshotRunStopReviewRecord({
      ref,
      run: before.run,
      turn: input.turn,
      proposal: input.proposal,
      decision: input.decision,
      checks: input.checks,
      limitations,
      requiredFeedbackRounds,
      advisoryFeedbackRounds,
      reviewedAt: this.now(),
    });
    const feedback = input.feedback === undefined
      ? null
      : snapshotRunStopFeedback({
          review: ref,
          owner: input.feedback.owner,
          severity: input.feedback.severity,
          round: input.feedback.severity === "required"
            ? requiredFeedbackRounds
            : advisoryFeedbackRounds,
          code: input.feedback.code,
          message: input.feedback.message,
        });
    const nextStopReview = Object.freeze({
      reviewSequence: ref.sequence,
      requiredFeedbackRounds,
      advisoryFeedbackRounds,
      latestReview: ref,
      limitations,
    });
    if (feedback === null) {
      this.writer.commit({ kind: "stop_review", review }, () => Object.freeze({
        stopReview: nextStopReview,
      }));
      return;
    }
    const contribution = createStopFeedbackContextContribution({
      id: this.currentContextContributionId(
        before.context,
        "agent-runtime",
        "run_stop_feedback",
      ) ?? this.id("context_contribution"),
      revision: `${ref.sequence}:${feedback.round}`,
      runId: this.runId,
      feedback,
      createdAt: this.now(),
    });
    this.writer.commitItems(Object.freeze([
      { kind: "stop_review", review },
      { kind: "stop_feedback", feedback },
    ]), (current) => Object.freeze({
      stopReview: nextStopReview,
      context: this.applyContextContributions(
        current.context,
        Object.freeze([contribution]),
        createStopFeedbackContextAdmissionProfile(),
        "run_stop_feedback",
        `${this.runId}:${ref.sequence}`,
      ),
    }));
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
      timeout = setTimeout(() => reject(new VerificationExecutionError(
        createVerificationFailure({
          code: "verification_gate_timed_out",
          stage: "completion_gate",
          message: "Completion Gate evaluation exceeded its deadline.",
          retryable: true,
          cause: this.config.verification.completion.policy,
        }),
        input.verificationSnapshot.revision,
      )), delay);
    });
    const cancelled = new Promise<CompletionGateDecision>((_resolve, reject) => {
      const onAbort = () => reject(new VerificationExecutionError(
        createVerificationFailure({
          code: "verification_gate_cancelled",
          stage: "completion_gate",
          message: "Completion Gate evaluation was cancelled.",
          retryable: false,
          cause: this.config.verification.completion.policy,
        }),
        input.verificationSnapshot.revision,
      ));
      if (interruption.signal.aborted) onAbort();
      else {
        interruption.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => interruption.signal.removeEventListener("abort", onAbort);
      }
    });
    try {
      return await Promise.race([
        this.dependencies.verification.completionGate.evaluate(
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

  private async commitVerificationFeedback(
    decision: CompletionGateDecision | null,
  ): Promise<void> {
    const runState = this.writer.getSnapshot();
    if (this.config.cancellation.context.request !== null ||
        this.terminalResult !== null ||
        (runState.status !== "running" && runState.status !== "waiting")) {
      return;
    }
    const execution = this.requireVerificationExecution();
    await this.emitVerificationRecords(execution);
    const contextProjection = await execution.projectContext({
      maxPayloadBytes: this.dependencies.contextProjection.maxContributionPayloadBytes,
    });
    const projection = await execution.projectRunner({
      contextContribution: contextProjection.contribution?.ref ?? null,
    });
    const hostProjection = await execution.projectHost();
    if (projection.snapshot.runId !== this.runId ||
        contextProjection.snapshot.runId !== this.runId ||
        contextProjection.snapshot.revision !== projection.snapshot.revision ||
        !sameOptionalRevisionRef(
          projection.contextContribution,
          contextProjection.contribution?.ref ?? null,
        )) {
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_projection_mismatch",
        stage: "projection",
        message: "Verification projections do not describe the current Run snapshot.",
        retryable: false,
        cause: null,
      }), projection.snapshot.revision);
    }
    if (hostProjection.snapshot.runId !== this.runId ||
        hostProjection.snapshot.revision !== projection.snapshot.revision) {
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_host_projection_mismatch",
        stage: "projection",
        message: "Verification Host projection does not match the current Run snapshot.",
        retryable: false,
        cause: null,
      }), projection.snapshot.revision);
    }
    this.verificationHostProjection = hostProjection;
    this.writer.commit({
      kind: "verification_feedback",
      verification: projection,
    }, (current) => Object.freeze({
      status: decision?.disposition === "wait"
        ? "waiting" as const
        : current.status === "waiting"
          ? "running" as const
          : current.status,
      verification: Object.freeze({
        snapshot: projection.snapshot,
        gate: projection.gate?.ref ?? null,
      }),
      context: contextProjection.contribution === null
        ? current.context
        : this.applyContextContributions(
            current.context,
            Object.freeze([contextProjection.contribution]),
            createVerificationContextAdmissionProfile(),
            "verification_feedback",
            projection.gate?.ref.id ?? null,
          ),
    }));
  }

  private async emitVerificationRecords(execution: VerificationExecutionPort): Promise<void> {
    const history = await execution.readHistory();
    const snapshotRevision = (await execution.readCurrentSnapshot()).ref.revision;
    for (const item of history) {
      if (item.kind === "check_attempt") {
        const key = `check_attempt:${item.record.ref.id}:${item.record.ref.ordinal}`;
        if (this.emittedVerificationRecordKeys.has(key) || item.record.startedAt === null) continue;
        this.emittedVerificationRecordKeys.add(key);
        this.emit("verification.check.started", {
          snapshotRevision,
          attemptId: item.record.ref.id,
          requirementId: item.record.requirement.id,
          origin: item.record.origin,
        }, item.record.startedAt);
      } else if (item.kind === "check_result") {
        const key = `check_result:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedVerificationRecordKeys.has(key)) continue;
        this.emittedVerificationRecordKeys.add(key);
        this.emit("verification.check.finished", {
          snapshotRevision,
          attemptId: item.record.attempt.id,
          status: item.record.status,
          code: item.record.failure?.code ?? null,
          durationMs: Date.parse(item.record.finishedAt) - Date.parse(item.record.startedAt),
          coverageRatio: item.record.coverage.ratio,
        }, item.record.finishedAt);
      } else if (item.kind === "assessment") {
        const key = `assessment:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedVerificationRecordKeys.has(key)) continue;
        this.emittedVerificationRecordKeys.add(key);
        this.emit("verification.assessment.committed", {
          snapshotRevision,
          requirementId: item.record.requirement.id,
          assessmentId: item.record.ref.id,
          verdict: item.record.verdict,
        }, item.record.assessedAt);
      } else if (item.kind === "completion_gate") {
        const key = `completion_gate:${item.record.ref.id}@${item.record.ref.revision}`;
        if (this.emittedVerificationRecordKeys.has(key)) continue;
        this.emittedVerificationRecordKeys.add(key);
        this.emit("verification.gate.evaluated", {
          snapshotRevision,
          gateId: item.record.ref.id,
          status: item.record.decision.status,
          disposition: item.record.decision.disposition,
          reasonCodes: Object.freeze(item.record.decision.reasons.map((reason) => reason.code)),
        }, item.record.decision.decidedAt);
      }
    }
  }

  private requireVerificationExecution(): VerificationExecutionPort {
    if (this.verificationExecution === null) {
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_execution_unavailable",
        stage: "admission",
        message: "Run-scoped Verification execution is not initialized.",
        retryable: false,
        cause: this.config.verification.profile.ref,
      }), 0);
    }
    return this.verificationExecution;
  }

  private createVerificationOperationCheckResolver(): VerificationOperationCheckResolverPort {
    return Object.freeze({
      resolve: (definition: import("@agent-anything/verification/execution").CheckDefinition) => definition.effect.kind === "effectful"
        ? Object.freeze({
            requestSettlement: (
              input: VerificationOperationCheckInput,
              interruption: InvocationInterruptionContext,
            ) => this.executeVerificationOperationCheck(input, interruption),
          })
        : null,
    });
  }

  private createAutomaticEffectfulVerificationCheckPort(): RunnerAutomaticEffectfulVerificationCheckPort {
    return Object.freeze({
      execute: async (
        request: RunnerAutomaticEffectfulVerificationCheckRequest,
        interruption: InvocationInterruptionContext,
      ) => {
        const execution = this.requireVerificationExecution();
        const current = await execution.readCurrentSnapshot();
        const invocationId = this.id("operation_invocation");
        const action = this.materializeAutomaticVerificationRunAction(
          request.definition.id,
          invocationId,
        );
        const result = await execution.executeCheck({
          ...request,
          origin: "trusted_automatic",
          runAction: action.ref,
          expectedRevision: current.ref.revision,
        }, interruption);
        await this.processVerificationCheckResult(request, result, interruption);
        return result;
      },
    });
  }

  private async executeVerificationOperationCheck(
    input: VerificationOperationCheckInput,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLowerCheckSettlement> {
    if (input.definition.effect.kind !== "effectful") {
      return this.rejectVerificationOperationCheck(
        "verification_operation_check_binding_invalid",
        "An operation-backed Verification Check requires an effectful definition.",
      );
    }
    if (interruption.signal.aborted || this.config.cancellation.context.request !== null) {
      return this.rejectVerificationOperationCheck(
        "verification_operation_check_cancelled",
        "Verification operation Check was cancelled before dispatch.",
      );
    }
    if (input.attempt.runAction === null) {
      return this.rejectVerificationOperationCheck(
        "verification_effectful_check_action_required",
        "An effectful Verification Check requires a Runner-materialized RunAction.",
      );
    }
    const action = this.findRunAction(input.attempt.runAction);
    if (action === null) {
      return this.rejectVerificationOperationCheck(
        "verification_run_action_missing",
        "Verification Check references a RunAction that is not committed in this Run.",
      );
    }
    if (action.subject.kind !== "operation" || action.subject.invocationId === null) {
      return this.rejectVerificationOperationCheck(
        "verification_run_action_subject_invalid",
        "An operation-backed Verification Check requires an Operation RunAction.",
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
        owner: "verification",
        kind: "check_attempt",
        id: input.attempt.ref.id,
        revision: String(input.attempt.ref.ordinal),
      }),
    });
    if (result === null) {
      return this.rejectVerificationOperationCheck(
        "verification_operation_check_unavailable",
        "Verification Check Operation could not be dispatched.",
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

  private materializeAutomaticVerificationRunAction(
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
        trigger: Object.freeze({ owner: "verification", operationId: checkAttemptId }),
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

  private commitModelCallSettlement(
    action: RuntimeRunAction,
    fallback: ModelCallSettlementKind | null,
  ): void {
    if (action.provenance.kind !== "controller") return;
    const call = this.findModelToolCall(action.provenance.modelCallRef);
    if (call === null) {
      throw new TypeError("Controller RunAction model-call provenance is not recorded.");
    }
    if (this.hasModelCallSettlement(call)) {
      throw new TypeError("A Model Tool Call cannot settle more than once.");
    }
    const observation = this.findRunActionObservation(action.ref);
    if (observation === null && fallback === null) {
      return;
    }
    const projected = observation === null
      ? Object.freeze({
          settlement: fallback!,
          content: Object.freeze({
            status: fallback!,
            code: fallback === "cancelled"
              ? "model_call_cancelled"
              : "model_call_failed",
          }) as ModelJsonValue,
        })
      : projectObservationSettlement(observation);
    const sourceRefs = observation === null
      ? Object.freeze([Object.freeze({
          owner: "agent-runtime",
          kind: "run_action",
          id: action.ref.id,
          revision: String(action.ref.sequence),
        })])
      : Object.freeze([
          Object.freeze({
            owner: "agent-runtime",
            kind: "run_action",
            id: action.ref.id,
            revision: String(action.ref.sequence),
          }),
          Object.freeze({
            owner: observation.owner,
            kind: "run_observation",
            id: observation.id,
            revision: null,
          }),
        ]);
    let result: ModelToolResult;
    try {
      result = snapshotModelToolResult({
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement: projected.settlement,
        content: projected.content,
        sourceRefs,
      });
    } catch {
      result = snapshotModelToolResult({
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement: projected.settlement,
        content: Object.freeze({
          status: projected.settlement,
          code: "model_result_projection_bounded",
        }),
        sourceRefs,
      });
    }
    this.writer.commit({
      kind: "model_call_settlement",
      result,
    });
  }

  private settleUnprocessedModelCalls(
    decision: ControllerDecision<TOutput>,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): void {
    if (decision.kind !== "advance") return;
    this.settleCandidateRange(decision.candidates, 0, turn, settlement, code);
  }

  private settleCandidateRange(
    candidates: readonly ProgressionCandidate[],
    startIndex: number,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): void {
    for (let index = startIndex; index < candidates.length; index += 1) {
      this.commitUnadmittedModelCallSettlement(
        candidates[index]!,
        turn,
        settlement,
        code,
      );
    }
  }

  private commitUnadmittedModelCallSettlement(
    candidate: ProgressionCandidate,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): void {
    const call = this.findModelToolCall(candidate.modelCallRef);
    if (call === null || this.hasModelCallSettlement(call)) return;
    this.commitLocalModelCallResult(call, settlement, {
      status: settlement,
      code,
    }, Object.freeze([Object.freeze({
      owner: "agent-runtime",
      kind: "controller_turn",
      id: turn.id,
      revision: String(turn.sequence),
    })]));
  }

  private settleTerminalControllerCall(
    decision: Extract<ControllerDecision<TOutput>, { readonly kind: "propose_stop" }>,
    turn: ControllerTurnRef,
  ): void {
    const calls = decision.modelItems.flatMap((item) =>
      item.kind === "model_tool_call" ? [item.call] : []
    );
    if (calls.length === 0) return;
    if (calls.length !== 1 || this.hasModelCallSettlement(calls[0]!)) {
      throw new TypeError("A terminal Controller stop must contain at most one unsettled model call.");
    }
    this.commitLocalModelCallResult(calls[0]!, "succeeded", {
      status: "succeeded",
      control: "stop",
    }, Object.freeze([Object.freeze({
      owner: "agent-runtime",
      kind: "controller_turn",
      id: turn.id,
      revision: String(turn.sequence),
    })]));
  }

  private commitLocalModelCallResult(
    call: ModelToolCall,
    settlement: ModelCallSettlementKind,
    content: unknown,
    sourceRefs: ModelToolResult["sourceRefs"],
  ): void {
    const projected = modelSettlement(settlement, content);
    this.writer.commit({
      kind: "model_call_settlement",
      result: snapshotModelToolResult({
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement,
        content: projected.content,
        sourceRefs,
      }),
    });
  }

  private findModelToolCall(ref: import("@agent-anything/model-interaction").ModelCallRef): ModelToolCall | null {
    const key = modelCallRefKey(ref);
    for (const item of this.writer.getSnapshot().items) {
      if (item.payload.kind !== "controller_turn") continue;
      for (const modelItem of item.payload.modelItems) {
        if (
          modelItem.kind === "model_tool_call" &&
          modelCallRefKey(modelItem.call.modelCallRef) === key
        ) return modelItem.call;
      }
    }
    return null;
  }

  private hasModelCallSettlement(call: ModelToolCall): boolean {
    const key = modelCallRefKey(call.modelCallRef);
    return this.writer.getSnapshot().items.some((item) =>
      item.payload.kind === "model_call_settlement" &&
      modelCallRefKey(item.payload.result.modelCallRef) === key
    );
  }

  private findRunActionObservation(ref: RunActionRef): RunObservation | null {
    const items = this.writer.getSnapshot().items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const payload = items[index]!.payload;
      if (
        payload.kind === "observation" &&
        payload.observation.runAction.id === ref.id &&
        payload.observation.runAction.sequence === ref.sequence
      ) return payload.observation;
    }
    return null;
  }

  private async rejectVerificationOperationCheck(
    code: `verification_${string}`,
    message: string,
  ): Promise<never> {
    const revision = this.verificationExecution === null
      ? 0
      : (await this.verificationExecution.readCurrentSnapshot()).ref.revision;
    throw new VerificationExecutionError(createVerificationFailure({
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
        instructionBinding: this.activeInstructionBinding,
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
          instructionBinding: prepared.input.instructionBinding.ref,
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
        instructionBinding: prepared.input.instructionBinding.ref,
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
        instructionBinding: prepared.input.instructionBinding.ref,
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

  private async settleLimitViolation(
    violation: RunLimitViolation,
  ): Promise<RunResult<TOutput>> {
    return this.settle({
      status: "failed",
      code: violation.code,
      failure: runtimeFailure(violation.code, violation.message, violation.metadata),
    });
  }

  private async settleResourceFailure(
    failure: Extract<
      RunTreeResourceRecordResult,
      { readonly status: "limit_exceeded" | "measurement_unavailable" }
    >,
  ): Promise<RunResult<TOutput>> {
    return this.settle(this.resourceFailureCandidate(failure));
  }

  private resourceFailureCandidate(
    failure: Extract<
      RunTreeResourceRecordResult,
      { readonly status: "limit_exceeded" | "measurement_unavailable" }
    >,
  ): Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }> {
    return {
      status: "failed",
      code: "runtime_limit_exceeded",
      failure: runtimeFailure(
        failure.status === "limit_exceeded"
          ? "runtime_tree_resource_limit_exceeded"
          : "runtime_tree_resource_measurement_unavailable",
        failure.status === "limit_exceeded"
          ? "The Run Tree resource envelope was exceeded."
          : "A hard Run Tree resource measurement was unavailable.",
        Object.freeze({ dimension: failure.dimension }),
      ),
    };
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

  private async processCandidate(
    candidate: ProgressionCandidate,
    index: number,
    basis: CandidateBasis<TOutput>,
  ): Promise<CandidateProcessingOutcome<TOutput>> {
    const state = this.writer.getSnapshot();
    if (state.counters.runActions >= this.config.limits.maxActions) {
      this.commitUnadmittedModelCallSettlement(
        candidate,
        basis.turn,
        "invalidated",
        "runtime_action_limit_reached",
      );
      return Object.freeze({ invalidatesRemainder: true, terminal: null });
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

    let invalidatesRemainder = false;
    let terminal: TerminalCandidate<TOutput> | null = null;
    try {
      switch (candidate.kind) {
        case "state_transition":
          invalidatesRemainder = candidate.transition === "plan_update"
            ? (await this.applyPlanCandidate(action, candidate.input), false)
            : await this.applyHandoffCandidate(action, candidate.input, basis);
          break;
        case "interaction_request":
          invalidatesRemainder = await this.applyInteractionCandidate(
            action,
            candidate,
            reservedId!,
          );
          break;
        case "tool_request": {
          const outcome = await this.executeToolCandidate(
            action,
            candidate,
            reservedId!,
            basis.exposure,
          );
          invalidatesRemainder = outcome.invalidatesRemainder;
          terminal = outcome.terminal;
          break;
        }
        case "model_call_rejection":
          this.commitObservation(action, {
            kind: "model_call_rejected",
            code: candidate.code,
            message: candidate.message,
          }, [], "agent-runtime");
          break;
        case "operation_request": {
          const outcome = await this.executeOperationCandidate(
            action,
            candidate,
            reservedId!,
          );
          if (outcome !== null) {
            this.commitOperationObservation(action, outcome);
            await this.processSettledOperationVerification(
              action,
              candidate.operation,
              candidate.request,
              "controller_protocol",
              outcome.result,
            );
            if (outcome.result.status === "unknown_effect") {
              terminal = {
                status: "failed",
                code: "unknown_effect",
                failure: createRunFailureCause("operation", outcome.result.failure),
              };
              invalidatesRemainder = true;
            }
          }
          break;
        }
      }
      this.commitModelCallSettlement(action, null);
      return Object.freeze({ invalidatesRemainder, terminal });
    } catch (error) {
      this.commitModelCallSettlement(
        action,
        this.config.cancellation.context.request === null ? "failed" : "cancelled",
      );
      throw error;
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
        : candidate.kind === "model_call_rejection"
          ? Object.freeze({
              kind: "model_call_rejection" as const,
              modelCallRef: candidate.modelCallRef,
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
        modelCallRef: candidate.modelCallRef,
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
      !sameAgentRef(request.currentAgent, state.activeAgent) ||
      !sameInstructionBindingRef(basis.instructionBinding.ref, state.activeInstructionBinding) ||
      !sameInstructionBindingRef(this.activeInstructionBinding.ref, state.activeInstructionBinding)
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
    const previousInstructionBinding = state.activeInstructionBinding;
    const nextAgent = snapshotAgent(resolution.agent as Agent<TOutput>);
    const knownInstructionRevision = this.instructionRevisionByAgentRevision.get(
      agentRevisionKey(nextAgent),
    );
    if (
      knownInstructionRevision !== undefined &&
      knownInstructionRevision !== nextAgent.instructions.ref.revision
    ) {
      return rejected("handoff_agent_revision_conflict");
    }
    const nextInstructionBinding = createAgentInstructionBinding({
      run: state.run,
      agent: nextAgent,
      effectiveFromRunRevision: state.revision + 1,
      supersedes: previousInstructionBinding,
    });
    const nextContext = this.handoffContext(
      request.transferPolicy,
      state.context,
      basis.projection,
    );
    this.writer.commit({
      kind: "state_transition",
      transition: "active_agent",
      previousAgent: previous,
      activeAgent: toAgentRevisionRef(nextAgent),
      previousInstructionBinding,
      activeInstructionBinding: nextInstructionBinding.ref,
      reason: request.reason,
    }, () => Object.freeze({
      activeAgent: toAgentRevisionRef(nextAgent),
      activeInstructionBinding: nextInstructionBinding.ref,
      context: nextContext,
    }));
    this.activeAgent = nextAgent;
    this.activeInstructionBinding = nextInstructionBinding;
    this.instructionRevisionByAgentRevision.set(
      agentRevisionKey(nextAgent),
      nextAgent.instructions.ref.revision,
    );
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
    if (candidate.blockingScope === "none") {
      this.trackModelCallSettlement(opened.completion);
      return false;
    }
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
  ): Promise<CandidateProcessingOutcome<TOutput>> {
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
      return Object.freeze({ invalidatesRemainder: false, terminal: null });
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
          await this.processSettledOperationVerification(
            action,
            call.binding.operation,
            call.input,
            call.origin === "model" ? "tool_request" : "trusted_workflow",
            result,
          );
          if (result.status === "unknown_effect") {
            return Object.freeze({
              invalidatesRemainder: true,
              terminal: {
                status: "failed" as const,
                code: "unknown_effect" as const,
                failure: createRunFailureCause("operation", result.failure),
              },
            });
          }
        }
        return Object.freeze({ invalidatesRemainder: false, terminal: null });
      }
      case "interaction":
        return Object.freeze({
          invalidatesRemainder: await this.executeToolInteraction(action, call),
          terminal: null,
        });
      case "descendant_agent":
        await this.executeToolDescendant(action, call);
        return Object.freeze({ invalidatesRemainder: false, terminal: null });
    }
    return Object.freeze({ invalidatesRemainder: false, terminal: null });
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
    if (call.binding.blockingScope === "none") {
      this.trackModelCallSettlement(opened.completion);
      return false;
    }
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

  private async processSettledOperationVerification(
    action: RuntimeRunAction,
    operation: OperationRevisionRef,
    request: unknown,
    requestOrigin: OperationRequestOrigin,
    result: OperationResult,
  ): Promise<void> {
    const processor = this.dependencies.verification.settledOperationResults;
    if (processor === null) return;
    try {
      const changed = await processor.process({
        run: Object.freeze({ id: this.runId }),
        execution: this.requireVerificationExecution(),
        runAction: action.ref,
        operation,
        request,
        requestOrigin,
        settlement: this.verificationLowerSettlement(result),
      }, this.invocationInterruption());
      if (!changed) return;
    } catch (error) {
      if (error instanceof VerificationExecutionError) throw error;
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_settled_operation_processing_failed",
        stage: "check",
        message: error instanceof Error
          ? error.message
          : "Settled Operation Verification processing failed.",
        retryable: false,
        cause: null,
      }), (await this.requireVerificationExecution().readCurrentSnapshot()).ref.revision);
    }
    await this.commitVerificationFeedback(null);
  }

  private verificationLowerSettlement(
    result: OperationResult,
  ): VerificationLowerCheckSettlement {
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

  private async processVerificationCheckResult(
    request: RunnerVerificationCheckRequest,
    result: CheckResult,
    interruption: InvocationInterruptionContext,
  ): Promise<void> {
    const processor = this.dependencies.verification.checkResults;
    if (processor === null) return;
    try {
      await processor.process({
        run: Object.freeze({ id: this.runId }),
        execution: this.requireVerificationExecution(),
        request,
        result,
      }, interruption);
    } catch (error) {
      if (error instanceof VerificationExecutionError) throw error;
      throw new VerificationExecutionError(createVerificationFailure({
        code: "verification_check_result_processing_failed",
        stage: "assessment",
        message: error instanceof Error
          ? error.message
          : "Verification Check Result processing failed.",
        retryable: false,
        cause: null,
      }), (await this.requireVerificationExecution().readCurrentSnapshot()).ref.revision);
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
      authority: Object.freeze({
        captureBasis: () => this.runTree.captureAuthorityBasis(this.runId),
        isBasisCurrent: (basis) => this.runTree.isAuthorityBasisCurrent(
          this.runId,
          basis,
        ),
      }),
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
    return this.operationFailureResult(
      registration,
      binding.invocation,
      "invalid",
      "agent-runtime",
      "delegation_requires_agent_tool",
      startedAt,
      this.now(),
    );
  }

  private async executeToolDescendant(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<void> {
    if (call.binding.kind !== "descendant_agent") return;
    const startedAt = this.now();
    const descendant = await this.executeDescendantRun(
      action,
      call,
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
        null,
      );
      return;
    }
    let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      mapped = this.dependencies.operations.delegation!.resultProjection.project(
        descendant.result,
      );
    } catch {
      this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        "failed",
        null,
        operationFailure("agent-runtime", "delegation_result_projection_failed"),
        startedAt,
        descendant.result,
      );
      return;
    }
    this.commitDescendantToolObservation(
      action,
      call,
      descendant.relationId,
      descendant.childRunId,
      mapped.status,
      mapped.output,
      mapped.failure,
      startedAt,
      descendant.result,
    );
  }

  private async executeDescendantRun(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<DescendantExecutionOutcome> {
    if (call.binding.kind !== "descendant_agent") {
      throw new TypeError("Delegation requires a descendant-Agent Tool binding.");
    }
    const composition = this.dependencies.operations.delegation;
    if (composition === undefined) {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_preparation_failed",
      );
      return rejectedDescendant(
        null,
        "delegation_preparation_failed",
        null,
        "failed",
      );
    }

    const authorityCeiling = projectDelegationRunAuthority(this.config);
    const treeResourceRemaining = this.runTree.getSnapshot().nodes.find(
      (node) => node.runId === this.runId,
    )?.resources.remaining;
    if (treeResourceRemaining === undefined) {
      throw new TypeError("Current Run Tree resource allocation is unavailable.");
    }
    const limitCeiling = projectDelegationRunLimits({
      config: this.config,
      maxContextBytes: delegationPayloadCeiling(
        this.dependencies.contextProjection.maxContributionPayloadBytes,
        4,
      ),
      maxResultBytes: delegationPayloadCeiling(
        this.dependencies.contextProjection.maxContributionPayloadBytes,
        1,
      ),
      maxModelInputTokens: treeResourceRemaining.modelInputTokens,
      maxModelOutputTokens: treeResourceRemaining.modelOutputTokens,
      maxCostUnits: treeResourceRemaining.costUnits,
    });
    let prepared: Awaited<ReturnType<typeof composition.preparation.prepare>>;
    try {
      prepared = await composition.preparation.prepare({
        root: Object.freeze({
          run: this.lineage.root,
          task: this.rootTask,
        }),
        parent: Object.freeze({
          run: Object.freeze({ id: this.runId }),
          task: Object.freeze({ id: this.input.task.id }),
          action: action.ref,
          lineage: this.lineage,
        }),
        targetAgent: call.binding.agent,
        toolCall: call,
        authorityCeiling,
        limitCeiling,
      });
      prepared = Object.freeze({
        agent: prepared.agent,
        preparation: snapshotDelegationPreparation(prepared.preparation),
        rootPurpose: snapshotDelegationContextMaterial(prepared.rootPurpose),
      });
    } catch {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_preparation_failed",
      );
      return rejectedDescendant(
        null,
        "delegation_preparation_failed",
        null,
        "failed",
      );
    }
    if (!sameAgentRef(prepared.agent, call.binding.agent) ||
        !sameAgentRef(prepared.preparation.childAgent, call.binding.agent)) {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_request_invalid",
      );
      return rejectedDescendant(
        null,
        "delegation_request_invalid",
        null,
        "invalid",
      );
    }

    let request: DelegationRequest;
    let authority: DelegationAuthorityDerivation;
    let limits: DelegationLimitDerivation;
    let predecessorMaterial: DelegationContextMaterial | null;
    try {
      assertDelegationAuthorityRequestWithinCeiling({
        requested: prepared.preparation.requestedAuthority,
        ceiling: authorityCeiling,
      });
      const createdAt = this.now();
      const rootAuthority = projectDelegationRunAuthority(this.rootConfig);
      const parentAuthority = projectDelegationRunAuthority(this.config);
      const requestDeadlineAt = minimumDeadline(
        this.writer.getSnapshot().deadlineAt,
        localDelegationDeadline(createdAt, prepared.preparation.limits.maxDurationMs),
      );
      authority = deriveDelegationAuthority({
        derivationId: this.id("delegation_authority"),
        sources: delegationAuthoritySources({
          rootRunId: this.lineage.root.id,
          parentRunId: this.runId,
          root: rootAuthority,
          parent: parentAuthority,
          childAgent: authorityCeiling,
          request: prepared.preparation.requestedAuthority,
          currentPolicy: parentAuthority,
          agent: prepared.agent,
          preparation: prepared.preparation,
          rootDeadlineAt: this.runTree.getSnapshot().deadlineAt,
          parentDeadlineAt: this.writer.getSnapshot().deadlineAt,
          requestDeadlineAt,
        }),
      });
      const rootLimits = projectDelegationRunLimits({
        config: this.rootConfig,
        maxContextBytes: limitCeiling.maxContextBytes,
        maxResultBytes: limitCeiling.maxResultBytes,
        maxModelInputTokens: limitCeiling.maxModelInputTokens,
        maxModelOutputTokens: limitCeiling.maxModelOutputTokens,
        maxCostUnits: limitCeiling.maxCostUnits,
      });
      const parentLimits = projectDelegationRunLimits({
        config: this.config,
        maxContextBytes: limitCeiling.maxContextBytes,
        maxResultBytes: limitCeiling.maxResultBytes,
        maxModelInputTokens: limitCeiling.maxModelInputTokens,
        maxModelOutputTokens: limitCeiling.maxModelOutputTokens,
        maxCostUnits: limitCeiling.maxCostUnits,
      });
      limits = deriveDelegationLimits({
        derivationId: this.id("delegation_limits"),
        sources: delegationLimitSources({
          rootRunId: this.lineage.root.id,
          parentRunId: this.runId,
          root: rootLimits,
          parent: parentLimits,
          childAgent: parentLimits,
          request: prepared.preparation.limits,
          currentPolicy: parentLimits,
          agent: prepared.agent,
          preparation: prepared.preparation,
        }),
      });
      const predecessor = prepared.preparation.predecessor === null
        ? null
        : this.resolveDelegationPredecessor(prepared.preparation.predecessor);
      predecessorMaterial = predecessor?.material ?? null;
      request = materializeDelegationRequest({
        requestId: this.id("delegation_request"),
        origin: Object.freeze({
          root: Object.freeze({
            run: this.lineage.root,
            task: Object.freeze({ id: this.rootTask.id }),
          }),
          parent: Object.freeze({
            run: Object.freeze({ id: this.runId }),
            task: Object.freeze({ id: this.input.task.id }),
            action: action.ref,
            lineage: this.lineage,
          }),
        }),
        toolCall: call,
        preparation: prepared.preparation,
        authorityDerivation: authority,
        limitDerivation: limits,
        predecessor: predecessor === null
          ? null
          : Object.freeze({
              correlation: Object.freeze({
                request: predecessor.result.request,
                result: predecessor.result.ref,
                root: predecessor.result.correlation.origin.root.run,
                child: predecessor.result.correlation.child,
              }),
              material: predecessor.material,
            }),
        createdAt,
      });
    } catch (error) {
      const code = delegationMaterializationFailureCode(error);
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        code,
      );
      return rejectedDescendant(null, code, null, "invalid");
    }

    const relationId = this.id("descendant_relation");

    const started = this.startDescendantRun({
      relationId,
      parentRunAction: action.ref,
      agent: prepared.agent,
      request,
      rootPurpose: prepared.rootPurpose,
      predecessor: predecessorMaterial,
      authority,
      limits,
    });
    if (started.status === "rejected") {
      if (started.relation !== null && started.reservedTreeRevision !== null) {
        this.emitDescendantLifecycle(
          "run.descendant.reserved",
          started.relation,
          request,
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
      request,
      started.reservedTreeRevision,
    );
    this.emitDescendantLifecycle(
      "run.descendant.started",
      started.relation,
      request,
      started.treeRevision,
    );

    const child = started.handle;
    this.childHandles.set(relationId, Object.freeze({
      request,
      childRunId: child.runId,
      handle: child,
    }));
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
    let transferStatus: "settled" | "failed" | "unknown" = "unknown";
    try {
      const result = await child.wait();
      const resourceSettlement = await started.resourceSettlement;
      let delegationResult: DelegationResult;
      try {
        const narrative = result.status === "succeeded"
          ? composition.narrativeProjection.project({
              request,
              finalOutput: result.finalOutput,
            })
          : null;
        delegationResult = constructDelegationResult({
          resultId: this.id("delegation_result"),
          request,
          correlation: Object.freeze({
            request: request.ref,
            origin: request.origin,
            relation: started.relation,
            child: Object.freeze({
              run: started.relation.child,
              task: Object.freeze({ id: result.taskId }),
              agent: request.childAgent,
            }),
          }),
          childResult: result,
          narrative,
          resourceSettlement,
          createdAt: this.now(),
        });
      } catch {
        transferStatus = "failed";
        return rejectedDescendant(
          relationId,
          "delegation_result_invalid",
          child.runId,
          "failed",
        );
      }
      const resultMaterial = createDelegationResultContextMaterial(delegationResult);
      this.settledDelegations.set(delegationResult.ref.id, Object.freeze({
        result: delegationResult,
        material: resultMaterial,
      }));
      transferStatus = "settled";
      this.runTree.settleDescendantTransfer(child.runId, transferStatus);
      this.eventStream.emit("run.descendant.settled", {
        relationId: started.relation.ref.id,
        parentRunActionId: started.relation.parentRunAction.id,
        childRunId: started.relation.child.id,
        childAgentId: request.childAgent.id,
        childAgentRevision: request.childAgent.revision,
        requestId: request.ref.id,
        requestRevision: request.ref.revision,
        predecessorResultId: request.predecessor?.result.id ?? null,
        contextSourceCount: request.contextPlan.entries.length,
        authorityDerivationId: request.authorityDerivation.id,
        limitDerivationId: request.limitDerivation.id,
        depth: started.relation.depth,
        status: delegationResult.terminal.status,
        code: delegationResult.terminal.code,
        resultId: delegationResult.ref.id,
        resultRevision: delegationResult.ref.revision,
        expectationPresentCount: delegationResult.expectationCoverage.filter(
          ({ disposition }) => disposition === "present",
        ).length,
        expectationUnmetCount: delegationResult.expectationCoverage.filter(
          ({ disposition }) => disposition !== "present",
        ).length,
        evidenceCount: delegationResult.evidence.totalCount,
        artifactCount: delegationResult.artifacts.totalCount,
        verificationStatus: delegationResult.verification.status,
        effectStatus: delegationResult.effects.status,
        uncertaintyCount: delegationResult.uncertainty.length,
        controllerTurns: delegationResult.usage.controllerTurns.status === "measured"
          ? delegationResult.usage.controllerTurns.value
          : 0,
        actions: delegationResult.usage.actions.status === "measured"
          ? delegationResult.usage.actions.value
          : 0,
        modelUsageStatus: delegationModelUsageStatus(delegationResult),
        limitStatus: delegationResult.limitDisposition.status,
        exhaustedLimit: delegationResult.limitDisposition.exhaustedLimit,
        treeRevision: this.runTree.getSnapshot().revision,
      });
      return Object.freeze({
        status: "settled" as const,
        relationId,
        childRunId: child.runId,
        result: delegationResult,
        resourceSettlement,
      });
    } finally {
      const childNode = this.runTree.getSnapshot().nodes.find(
        (node) => node.runId === child.runId,
      );
      if (childNode?.resultTransfer === "pending") {
        this.runTree.settleDescendantTransfer(child.runId, transferStatus);
      }
      unsubscribe();
      this.childHandles.delete(relationId);
      this.removePending(pending, "resolved", null);
    }
  }

  private emitDescendantLifecycle(
    name: "run.descendant.reserved" | "run.descendant.started",
    relation: DescendantRunRelation,
    request: DelegationRequest,
    treeRevision: number,
  ): void {
    this.eventStream.emit(name, {
      relationId: relation.ref.id,
      parentRunActionId: relation.parentRunAction.id,
      childRunId: relation.child.id,
      childAgentId: request.childAgent.id,
      childAgentRevision: request.childAgent.revision,
      requestId: request.ref.id,
      requestRevision: request.ref.revision,
      predecessorResultId: request.predecessor?.result.id ?? null,
      contextSourceCount: request.contextPlan.entries.length,
      authorityDerivationId: request.authorityDerivation.id,
      limitDerivationId: request.limitDerivation.id,
      depth: relation.depth,
      treeRevision,
    });
  }

  private resolveDelegationPredecessor(
    ref: import("@agent-anything/agent-core/delegation").DelegationResultRef,
  ): { readonly result: DelegationResult; readonly material: DelegationContextMaterial } {
    const predecessor = this.settledDelegations.get(ref.id);
    if (predecessor === undefined || predecessor.result.ref.revision !== ref.revision) {
      throw new TypeError("Delegation predecessor is unknown, stale, or not settled.");
    }
    if (predecessor.result.correlation.origin.root.run.id !== this.lineage.root.id) {
      throw new TypeError("Delegation predecessor belongs to another root Run.");
    }
    return predecessor;
  }

  private emitDescendantRejected(
    relationId: string | null,
    parentRunAction: RunActionRef,
    childRunId: string | null,
    depth: number | null,
    code: import("@agent-anything/observability/events").RuntimeDescendantRunFailureCode,
    treeRevision: number = this.runTree.getSnapshot().revision,
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
    relationId: string | null,
    childRunId: string | null,
    status: import("./RunnerDependencies.js").DescendantOperationOutcome["status"],
    output: unknown,
    failure: OperationFailure | null,
    startedAt: string,
    delegationResult: DelegationResult | null,
  ): void {
    const finishedAt = this.now();
    const settlement = Object.freeze({
      owner: "agent-runtime",
      kind: "descendant_run",
      id: childRunId ?? relationId ?? call.toolCallId,
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
        kind: delegationResult === null ? "descendant_run_result" : "delegation_result",
        id: delegationResult?.ref.id ?? childRunId ?? relationId ?? call.toolCallId,
        revision: delegationResult?.ref.revision ?? settlement.revision,
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
    const admittedPayloadBytes = transition.operations.reduce(
      (total, operation) =>
        total + ("contribution" in operation
          ? operation.contribution.accounting.payloadBytes
          : 0),
      0,
    );
    if (admittedPayloadBytes > 0) {
      this.recordTreeResources({
        contextBytes: Object.freeze({
          status: "measured" as const,
          value: admittedPayloadBytes,
        }),
      });
    }
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

  private trackModelCallSettlement(
    completion: Promise<RuntimeInteractionSettlement>,
  ): void {
    let wait!: Promise<void>;
    wait = completion.then(() => undefined).finally(() => {
      this.modelCallSettlementWaits.delete(wait);
    });
    this.modelCallSettlementWaits.add(wait);
  }

  private async waitForModelCallSettlements(): Promise<void> {
    if (this.modelCallSettlementWaits.size === 0) return;
    await Promise.all([...this.modelCallSettlementWaits]);
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
        if (input.parentRunAction === null) {
          return Object.freeze({ status: "failed" as const, code: "approval_parent_action_missing" });
        }
        const requestId = this.id("interaction_request", this.nextInteractionRequest++);
        const actionFingerprint = input.assessment.requirement.subject.actionFingerprint;
        const operationFingerprint = await approvalOperationFingerprint({
          requirement: input.assessment.requirement,
          workspace: this.config.workspace,
          permissions: this.config.permissions,
        });
        const authorityBasis = this.runTree.captureAuthorityBasis(this.runId);
        const admission = this.runTree.admitApproval({
          requestId,
          runId: this.runId,
          actionId: input.action.id,
          authorityRevision: authorityBasis.authorityRevision,
          workspaceId: this.config.workspace?.primary.id ?? null,
          environmentId: this.config.permissions.permissionProfile.environmentId,
          operationFingerprint,
        });
        if (admission.status === "limit_exceeded") {
          return Object.freeze({
            status: "limit_exceeded" as const,
            code: admission.code,
          });
        }
        if (admission.status === "rejected") {
          return Object.freeze({
            status: admission.code === "approval_tree_cancelled"
              ? "cancelled" as const
              : "invalidated" as const,
            code: admission.code,
          });
        }
        let settlementKind: import("./RunTreeApprovalAccount.js").RunTreeApprovalSettlementKind =
          "request_failure";
        let settled = false;
        const settleApproval = (
          kind: import("./RunTreeApprovalAccount.js").RunTreeApprovalSettlementKind,
        ): void => {
          if (settled) return;
          settled = true;
          this.runTree.settleApproval(requestId, kind);
        };
        try {
        const pendingVersion = 1;
        const createdAt = this.now();
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
            revision: actionFingerprint,
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
          settlementKind = "request_failure";
          return Object.freeze({ status: "failed" as const, code: opened.code });
        }

        let reviewerFailed = false;
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
            reviewerFailed = true;
          } else if (reviewResult.kind === "cancelled") {
            settlementKind = "interrupted";
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
          settlementKind = reviewerFailed
            ? "reviewer_failure"
            : settlement.status === "expired"
              ? "expired"
              : settlement.status === "cancelled"
                ? "cancelled"
                : settlement.status === "invalidated"
                  ? settlementKind === "interrupted" ? "interrupted" : "invalidated"
                  : "request_failure";
          return Object.freeze({
            status: settlement.status === "expired" || settlement.status === "invalidated" || settlement.status === "cancelled"
              ? settlement.status
              : "failed",
            code: settlement.code,
          }) as Awaited<ReturnType<ActionApprovalResolutionPort["resolve"]>>;
        }
        const resolution = settlement.resolutionValue as ApprovalInteractionResolution;
        if (resolution.decision.kind === "decline") {
          settlementKind = "declined";
          return Object.freeze({ status: "denied" as const, code: "approval_declined" });
        }
        if (resolution.decision.kind === "cancel") {
          settlementKind = "cancelled";
          this.config.cancellation.requestCancellation({
            origin: "approval",
            reasonCode: "approval_cancelled",
            approvalRequestId: requestId,
          });
          return Object.freeze({ status: "cancelled" as const, code: "approval_cancelled" });
        }
        const application = settlement.applicationValue as ApprovalApplicationOutcome;
        if (application.kind !== "applied") {
          settlementKind = application.kind === "interrupted"
            ? "interrupted"
            : application.kind === "outcome_unknown"
              ? "outcome_unknown"
              : "request_failure";
          return Object.freeze({
            status: application.kind === "interrupted" ? "interrupted" :
              application.kind === "outcome_unknown" ? "unknown_effect" : "failed",
            code: "code" in application ? application.code : "approval_authority_not_applied",
          });
        }
        settlementKind = "approved";
        return Object.freeze({
          status: "applied" as const,
          approvalRecordId: settlement.outcome.resolution.resolutionId,
          authoritySnapshotId: `run-permission:${this.writer.getSnapshot().revision}`,
        });
        } finally {
          settleApproval(settlementKind);
        }
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

    if (this.resourceFailure !== null) {
      terminal = this.resourceFailureCandidate(this.resourceFailure);
    }
    const stateBeforeTerminal = this.writer.getSnapshot();
    const resultResource = this.runTree.recordResources(this.runId, {
      resultBytes: Object.freeze({
        status: "measured" as const,
        value: measureTerminalResultBytes(
          terminal,
          stateBeforeTerminal.evidenceRefs,
          stateBeforeTerminal.artifactRefs,
        ),
      }),
    });
    if (resultResource.status !== "recorded") {
      terminal = this.resourceFailureCandidate(resultResource);
    }
    this.runTree.settleResources(this.runId);

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
    await this.closeVerification(completedAt);
    await this.transcript.flush();
    const state = this.writer.getSnapshot();
    const base = {
      runId: this.runId,
      taskId: state.taskId,
      startingAgent: state.startingAgent,
      finalActiveAgent: state.activeAgent,
      startingInstructionBinding: state.startingInstructionBinding,
      finalInstructionBinding: state.activeInstructionBinding,
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
    this.emitCommittedRunItems(state);
    this.emitTerminal(result);
    completeRunnerTrace(this.traceAssembler, result);
    this.publishCurrentState();
    return result;
  }

  private failureFromError(error: unknown): Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }> {
    if (error instanceof VerificationExecutionError) {
      return {
        status: "failed",
        code: "verification_failed",
        failure: createRunFailureCause("verification", error.failure),
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

  private async closeVerification(closedAt: string): Promise<void> {
    if (this.verificationExecution === null || this.verificationClosed) return;
    this.verificationClosed = true;
    const current = await this.verificationExecution.readCurrentSnapshot();
    try {
      await this.verificationExecution.closeCurrentState({
        expectedRevision: current.ref.revision,
        closedAt,
      });
    } catch {
      // Terminal Run truth is already committed; late Verification close failure is diagnostic only.
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
      provenance: action.provenance.kind === "controller"
        ? Object.freeze({
            kind: "controller" as const,
            turn: action.provenance.turn,
            candidateIndex: action.provenance.candidateIndex,
          })
        : action.provenance,
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
    if (state.permission !== this.lastAuthorityPermission) {
      this.lastAuthorityPermission = state.permission;
      this.runTree.advanceAuthorityRevision(this.runId);
    }
    this.accountCommittedResources(state);
    this.transcript.record(state.items);
    if (this.runStartedEventEmitted) {
      this.emitCommittedContextTransition(state.context);
      this.emitCommittedRunItems(state);
    }
    this.publishCurrentState();
  }

  private accountCommittedResources(state: RunState<TOutput>): void {
    while (this.accountedResourceItemCount < state.items.length) {
      const item = state.items[this.accountedResourceItemCount++]!;
      if (item.payload.kind === "run_action") {
        this.recordTreeResources({
          actions: Object.freeze({ status: "measured" as const, value: 1 }),
        });
        continue;
      }
      if (item.payload.kind !== "controller_turn") continue;
      this.recordTreeResources({
        controllerTurns: Object.freeze({ status: "measured" as const, value: 1 }),
      });
      let responseCorrelationCount = 0;
      for (const modelItem of item.payload.modelItems) {
        if (modelItem.kind !== "model_response_correlation") continue;
        responseCorrelationCount += 1;
        const usage = modelItem.usage;
        const metering = this.dependencies.controller.resourceMetering;
        this.recordTreeResources({
          modelInputTokens: providerUsageMeasurement(
            usage?.inputTokens ?? null,
            metering.modelInputTokens,
          ),
          modelOutputTokens: providerUsageMeasurement(
            usage?.outputTokens ?? null,
            metering.modelOutputTokens,
          ),
          costUnits: providerUsageMeasurement(
            usage?.costUnits ?? null,
            metering.costUnits,
          ),
        });
      }
      if (responseCorrelationCount === 0) {
        const metering = this.dependencies.controller.resourceMetering;
        this.recordTreeResources({
          modelInputTokens: absentProviderUsageMeasurement(metering.modelInputTokens),
          modelOutputTokens: absentProviderUsageMeasurement(metering.modelOutputTokens),
          costUnits: absentProviderUsageMeasurement(metering.costUnits),
        });
      }
    }
  }

  private recordTreeResources(
    usage: Parameters<import("./RunTreeExecution.js").RunTreeExecution["recordResources"]>[1],
  ): void {
    const result = this.runTree.recordResources(this.runId, usage);
    if (result.status !== "recorded" && this.resourceFailure === null) {
      this.resourceFailure = result;
    }
  }

  private emitCommittedRunItems(state: RunState<TOutput>): void {
    while (this.emittedItemCount < state.items.length) {
      const item = state.items[this.emittedItemCount++]!;
      this.emit("run.item.appended", {
        itemId: item.ref.id,
        itemKind: item.payload.kind,
        itemSequence: item.ref.sequence,
      }, item.createdAt);
      if (item.payload.kind === "stop_review") {
        const review = item.payload.review;
        this.emit("run.stop.reviewed", {
          reviewSequence: review.ref.sequence,
          decision: review.decision,
          checkCount: review.checks.length,
          limitationCount: review.limitations.length,
          requiredFeedbackRounds: review.requiredFeedbackRounds,
          advisoryFeedbackRounds: review.advisoryFeedbackRounds,
        }, item.createdAt);
      } else if (item.payload.kind === "stop_feedback") {
        const feedback = item.payload.feedback;
        this.emit("run.stop.feedback_requested", {
          reviewSequence: feedback.review.sequence,
          owner: feedback.owner,
          severity: feedback.severity,
          round: feedback.round,
          code: feedback.code,
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
    const childPending = [...this.childHandles.values()].flatMap(({ handle }) =>
      handle.getSnapshot().pendingInteractions
    );
    this.onUpdate({
      runRevision: state.revision,
      status: state.status,
      lastRunItemSequence: state.items.at(-1)?.ref.sequence ?? 0,
      instructionBinding: projectAgentInstructionBinding({
        binding: this.activeInstructionBinding,
        run: state.run,
        agent: this.activeAgent,
      }),
      plan: state.plan === null ? null : projectPlan(state.plan),
      stopReview: projectRunStopReview(state.stopReview),
      retry: this.retryProjection,
      verification: this.verificationHostProjection,
      pendingInteractions: Object.freeze([
        ...this.interactions.getPendingProjections(),
        ...childPending,
      ]),
      activeDelegations: Object.freeze(
        [...this.childHandles.entries()].flatMap(([relationId, child]) => {
          const snapshot = child.handle.getSnapshot();
          return snapshot.result === null
            ? [Object.freeze({
                request: child.request.ref,
                relation: Object.freeze({ id: relationId }),
                child: Object.freeze({ id: child.childRunId }),
                childRunRevision: snapshot.runRevision,
                childStatus: snapshot.status,
                steerable: true as const,
              })]
            : [];
        }),
      ),
      result: this.terminalResult,
    });
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

function agentRevisionKey(agent: Pick<Agent, "id" | "revision">): string {
  return `${agent.id}\0${agent.revision}`;
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
    case "model_call_rejected":
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
  relationId: string | null,
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

function rejectedDelegationSteering(
  code: Extract<DelegationSteeringReceipt, { readonly status: "rejected" }>["code"],
  relation: Extract<DelegationSteeringReceipt, { readonly status: "rejected" }>["relation"],
  child: Extract<DelegationSteeringReceipt, { readonly status: "rejected" }>["child"],
): DelegationSteeringReceipt {
  return Object.freeze({ status: "rejected" as const, code, relation, child });
}

function createDelegationResultContextMaterial(
  result: DelegationResult,
): DelegationContextMaterial {
  return createDelegationContextMaterial({
    owner: "agent-runtime",
    kind: "delegation_result",
    id: result.ref.id,
    payload: Object.freeze({
      kind: "delegation_result",
      result: result.ref,
      child: result.correlation.child,
      terminal: result.terminal,
      narrative: result.narrative,
      evidence: result.evidence,
      artifacts: result.artifacts,
      verification: result.verification,
      effects: result.effects,
      expectationCoverage: result.expectationCoverage,
      uncertainty: result.uncertainty,
    }),
  });
}

function delegationAuthoritySources(input: {
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly root: readonly DelegationAuthorityDimensionInput[];
  readonly parent: readonly DelegationAuthorityDimensionInput[];
  readonly childAgent: readonly DelegationAuthorityDimensionInput[];
  readonly request: readonly DelegationAuthorityDimensionInput[];
  readonly currentPolicy: readonly DelegationAuthorityDimensionInput[];
  readonly agent: Agent;
  readonly preparation: DelegationPreparation;
  readonly rootDeadlineAt: string;
  readonly parentDeadlineAt: string;
  readonly requestDeadlineAt: string;
}): readonly DelegationAuthoritySourceInput[] {
  const preparationRevision = createDelegationContractIdentity(
    "agent-anything.delegation-preparation.v1",
    input.preparation,
  );
  return Object.freeze([
    authoritySource("root", "agent-runtime", "root_run_configuration", input.rootRunId, input.root, input.rootDeadlineAt),
    authoritySource("parent", "agent-runtime", "parent_run_configuration", input.parentRunId, input.parent, input.parentDeadlineAt),
    Object.freeze({
      role: "child_agent" as const,
      ref: Object.freeze({
        owner: "agent",
        kind: "agent_revision",
        id: input.agent.id,
        revision: input.agent.revision,
      }),
      dimensions: input.childAgent,
      deadlineAt: input.parentDeadlineAt,
    }),
    Object.freeze({
      role: "request" as const,
      ref: Object.freeze({
        owner: "product",
        kind: "delegation_preparation",
        id: input.parentRunId,
        revision: preparationRevision,
      }),
      dimensions: input.request,
      deadlineAt: input.requestDeadlineAt,
    }),
    authoritySource("current_policy", "agent-runtime", "current_run_policy", input.parentRunId, input.currentPolicy, input.parentDeadlineAt),
  ]);
}

function authoritySource(
  role: "root" | "parent" | "current_policy",
  owner: string,
  kind: string,
  id: string,
  dimensions: readonly DelegationAuthorityDimensionInput[],
  deadlineAt: string,
): DelegationAuthoritySourceInput {
  return Object.freeze({
    role,
    ref: Object.freeze({
      owner,
      kind,
      id,
      revision: createDelegationContractIdentity(
        "agent-anything.delegation-authority-source-input.v1",
        dimensions,
      ),
    }),
    dimensions,
    deadlineAt,
  });
}

function delegationLimitSources(input: {
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly root: DelegationLimits;
  readonly parent: DelegationLimits;
  readonly childAgent: DelegationLimits;
  readonly request: DelegationLimits;
  readonly currentPolicy: DelegationLimits;
  readonly agent: Agent;
  readonly preparation: DelegationPreparation;
}): readonly DelegationLimitSourceInput[] {
  const preparationRevision = createDelegationContractIdentity(
    "agent-anything.delegation-preparation.v1",
    input.preparation,
  );
  return Object.freeze([
    limitSource("root", "agent-runtime", "root_run_configuration", input.rootRunId, input.root),
    limitSource("parent", "agent-runtime", "parent_run_configuration", input.parentRunId, input.parent),
    Object.freeze({
      role: "child_agent" as const,
      ref: Object.freeze({
        owner: "agent",
        kind: "agent_revision",
        id: input.agent.id,
        revision: input.agent.revision,
      }),
      ceiling: input.childAgent,
    }),
    Object.freeze({
      role: "request" as const,
      ref: Object.freeze({
        owner: "product",
        kind: "delegation_preparation",
        id: input.parentRunId,
        revision: preparationRevision,
      }),
      ceiling: input.request,
    }),
    limitSource("current_policy", "agent-runtime", "current_run_policy", input.parentRunId, input.currentPolicy),
  ]);
}

function limitSource(
  role: "root" | "parent" | "current_policy",
  owner: string,
  kind: string,
  id: string,
  ceiling: DelegationLimits,
): DelegationLimitSourceInput {
  return Object.freeze({
    role,
    ref: Object.freeze({ owner, kind, id, revision: ceiling.revision }),
    ceiling,
  });
}

function delegationPayloadCeiling(value: number, multiplier: number): number {
  const ceiling = value * multiplier;
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new TypeError("Delegation payload ceiling must be a positive safe integer.");
  }
  return ceiling;
}

function localDelegationDeadline(startedAt: string, maxDurationMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new TypeError("Delegation start time is invalid.");
  }
  return new Date(startedAtMs + maxDurationMs).toISOString();
}

function minimumDeadline(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function delegationMaterializationFailureCode(
  error: unknown,
): "delegation_request_invalid" | "delegation_authority_invalid" {
  return error instanceof Error && /authority/i.test(error.message)
    ? "delegation_authority_invalid"
    : "delegation_request_invalid";
}

function descendantRejectionStatus(
  code: Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["code"],
): Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["operationStatus"] {
  switch (code) {
    case "descendant_run_start_cancelled":
      return "cancelled";
    case "descendant_run_deadline_exceeded":
      return "timed_out";
    case "descendant_run_start_failed":
    case "delegation_preparation_failed":
    case "delegation_result_projection_failed":
      return "failed";
    case "delegation_request_invalid":
    case "delegation_authority_invalid":
    case "delegation_context_invalid":
    case "delegation_result_invalid":
      return "invalid";
    case "delegation_resource_limit_exceeded":
      return "unavailable";
    case "descendant_run_depth_limit_exceeded":
    case "descendant_run_total_limit_exceeded":
    case "descendant_run_active_limit_exceeded":
    case "descendant_run_resource_limit_exceeded":
      return "unavailable";
  }
}

function delegationModelUsageStatus(
  result: DelegationResult,
): "measured" | "partial" | "unavailable" {
  const statuses = [
    result.usage.modelInputTokens.status,
    result.usage.modelOutputTokens.status,
    result.usage.costUnits.status,
  ];
  if (statuses.every((status) => status === "measured")) return "measured";
  if (statuses.some((status) => status === "measured")) return "partial";
  return "unavailable";
}

function sameAgentRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameInstructionBindingRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameOptionalRevisionRef(
  left: { readonly id: string; readonly revision: string } | null,
  right: { readonly id: string; readonly revision: string } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.revision === right.revision;
}

function deriveActiveStatus(
  status: RunState["status"],
  pending: readonly PendingRunSubject[],
): RunState["status"] {
  if (!isActiveStatus(status)) return status;
  return deriveActiveRunStatus({ pending, progressableBranchIds: Object.freeze([]) });
}

function projectObservationSettlement(observation: RunObservation): {
  readonly settlement: ModelCallSettlementKind;
  readonly content: ModelJsonValue;
} {
  const payload = observation.payload;
  switch (payload.kind) {
    case "plan_update":
      return modelSettlement(
        payload.result.status === "rejected" ? "invalid" : "succeeded",
        { kind: payload.kind, result: payload.result },
      );
    case "handoff":
      return modelSettlement(
        payload.status === "applied" ? "succeeded" : "invalid",
        { kind: payload.kind, status: payload.status, code: payload.code },
      );
    case "operation":
      return modelSettlement(
        operationModelSettlement(payload.result.status),
        {
          kind: payload.kind,
          status: payload.result.status,
          output: payload.result.output,
          failure: payload.result.failure === null
            ? null
            : {
                owner: payload.result.failure.owner,
                code: payload.result.failure.code,
                message: payload.result.failure.message,
              },
        },
      );
    case "operation_rejected":
    case "tool_rejected":
    case "model_call_rejected":
      return modelSettlement("invalid", {
        kind: payload.kind,
        code: payload.code,
        message: payload.message,
      });
    case "interaction":
      return modelSettlement(
        payload.status === "resolved"
          ? "succeeded"
          : payload.status === "cancelled"
            ? "cancelled"
            : payload.status === "invalidated"
              ? "invalidated"
              : payload.status === "failed"
                ? "failed"
                : "invalid",
        {
          kind: payload.kind,
          owner: payload.owner,
          status: payload.status,
          value: payload.value,
        },
      );
    case "descendant_run":
      return modelSettlement(
        operationModelSettlement(payload.status),
        {
          kind: payload.kind,
          status: payload.status,
          childRunId: payload.childRunId,
          output: payload.output,
          failure: payload.failure === null
            ? null
            : {
                owner: payload.failure.owner,
                code: payload.failure.code,
                message: payload.failure.message,
              },
        },
      );
  }
}

function modelSettlement(
  settlement: ModelCallSettlementKind,
  content: unknown,
): { readonly settlement: ModelCallSettlementKind; readonly content: ModelJsonValue } {
  let snapshot: ModelJsonValue;
  try {
    snapshot = snapshotModelJsonValue(content, "ModelToolResult.content");
  } catch {
    snapshot = Object.freeze({
      status: settlement,
      code: "model_result_projection_unavailable",
    });
  }
  return Object.freeze({ settlement, content: snapshot });
}

function operationModelSettlement(
  status: "succeeded" | "partial" | "failed" | "unavailable" | "denied" |
    "cancelled" | "timed_out" | "invalid" | "unknown_effect",
): ModelCallSettlementKind {
  switch (status) {
    case "succeeded":
    case "partial":
      return "succeeded";
    case "denied":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "invalid":
      return "invalid";
    case "failed":
    case "unavailable":
    case "timed_out":
    case "unknown_effect":
      return "failed";
  }
}

function providerUsageMeasurement(
  value: number | null,
  qualification: import("@agent-anything/model-interaction").ProviderUsageMeteringQualification,
): import("./RunTreeResourceAccount.js").RunTreeResourceMeasurement {
  if (value !== null) {
    return Object.freeze({ status: "measured", value });
  }
  return qualification === "not_applicable"
    ? Object.freeze({ status: "not_applicable" })
    : Object.freeze({ status: "unavailable" });
}

function absentProviderUsageMeasurement(
  qualification: import("@agent-anything/model-interaction").ProviderUsageMeteringQualification,
): import("./RunTreeResourceAccount.js").RunTreeResourceMeasurement {
  return qualification === "not_applicable"
    ? Object.freeze({ status: "not_applicable" })
    : Object.freeze({ status: "unknown" });
}

function measureTerminalResultBytes<TOutput>(
  terminal: TerminalCandidate<TOutput>,
  evidenceRefs: readonly string[],
  artifactRefs: readonly string[],
): number {
  const encoded = JSON.stringify({
    status: terminal.status,
    code: terminal.status === "succeeded" ? null : terminal.status === "cancelled"
      ? "runtime_cancelled"
      : terminal.code,
    finalOutput: terminal.status === "succeeded" ? terminal.output : null,
    evidenceRefs,
    artifactRefs,
  });
  if (encoded === undefined) {
    throw new TypeError("Run result resource material is not JSON-serializable.");
  }
  return new TextEncoder().encode(encoded).byteLength;
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

function approvalOperationFingerprint(input: {
  readonly requirement: import("@agent-anything/permission/approval").ApprovalRequirement;
  readonly workspace: import("@agent-anything/workspace/selection").WorkspaceSelection | null;
  readonly permissions: import("../run/index.js").ResolvedRunPermissionConfig;
}): Promise<string> {
  const requirement = input.requirement;
  return createCanonicalSha256Digest(
    "agent-anything.run-tree-approval-operation.v1",
    Object.freeze({
      category: requirement.category,
      environmentId: requirement.subject.environmentId,
      applicabilityKeys: requirement.subject.applicabilityKeys,
      payload: stripApprovalPresentation(requirement.payload),
      decisions: requirement.decisionOptions.map(({ kind, scope }) => ({ kind, scope })),
      proposals: requirement.trustedProposals.map((proposal) =>
        stripApprovalPresentation(proposal)
      ),
      workspace: input.workspace === null
        ? null
        : Object.freeze({
            primary: approvalWorkspaceIdentity(input.workspace.primary),
            additional: input.workspace.additional.map(approvalWorkspaceIdentity),
          }),
      policyBasis: Object.freeze({
        profileId: input.permissions.permissionProfile.id,
        approvalPolicy: input.permissions.approvalPolicy,
        managedConstraintSetId:
          input.permissions.permissionProfile.managedConstraintSetId,
        rules: input.permissions.rules.map(({ id }) => id),
        networkRules: input.permissions.networkRules.map(({ id }) => id),
      }),
    }),
  );
}

function approvalWorkspaceIdentity(
  workspace: import("@agent-anything/workspace/identity").WorkspaceIdentity,
) {
  return Object.freeze({
    id: workspace.id,
    rootRef: workspace.rootRef,
    trustState: workspace.trustState,
    source: workspace.source,
    policyRefs: workspace.policyRefs,
  });
}

function stripApprovalPresentation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripApprovalPresentation);
  if (value === null || typeof value !== "object") return value;
  const omitted = new Set([
    "id",
    "ref",
    "label",
    "description",
    "displayName",
    "displayPath",
    "destinationDisplayPath",
    "safeCommandDisplay",
    "cwdDisplay",
    "reason",
    "deadlineAt",
    "metadata",
  ]);
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !omitted.has(key))
      .map(([key, child]) => [key, stripApprovalPresentation(child)]),
  ));
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
