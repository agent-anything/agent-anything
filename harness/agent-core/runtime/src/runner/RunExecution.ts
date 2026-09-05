import type { Agent } from "@agent-anything/agent-core/agent";
import { snapshotAgent, toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ControllerTurnRef, InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunActionProvenance, RunActionRef } from "@agent-anything/agent-core/run-action";
import type { DescendantRunRelation } from "@agent-anything/agent-core/run-tree";
import type {
  DescendantContinuationCorrelation,
} from "@agent-anything/agent-core/delegation";
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
  type FailedToolResult,
  type ToolResult,
  type ToolSettlementRef,
} from "@agent-anything/tools/result";
import {
  modelCallRefKey,
  snapshotModelJsonValue,
  snapshotModelMessage,
  snapshotModelToolResult,
  type ModelCallSettlementKind,
  type ModelJsonValue,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolResult,
} from "@agent-anything/model-interaction";
import {
  materializeToolCall,
  type ToolCall,
  type ToolCallAttempt,
} from "@agent-anything/tools/invocation";
import {
  findSelectedTool,
  ToolExposureValidationError,
  type ToolExposureProof,
} from "@agent-anything/tools/selection";
import {
  ControllerError,
  validateControllerDecision,
  projectModelInteraction,
  type ControllerDecision,
  type ModelInteractionProjection,
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
import { RunTranscriptRecorder } from "../transcript/index.js";
import {
  createRunResult,
  createRunFailureCause,
  createRunObservation,
  deriveActiveRunStatus,
  runSettlementCauseCode,
  sameRunSuspensionRef,
  toRunCancellationSummary,
  type PendingRunSubject,
  type ControllerToolExposureRecord,
  type RunCausalLink,
  type RunCauseSourceRef,
  type RunFailureCause,
  type RunItemPayload,
  type RunObservation,
  type RunResumeReceipt,
  type RunResumeRequest,
  type RunResumeRequestInput,
  type RunResult,
  type RunSettlement,
  type RunSettlementCauseRecord,
  type RunState,
  type RunSteeringApplication,
  type RunSteeringCommand,
  type RunSteeringInput,
  type RunSteeringSubmissionReceipt,
  type RunSuspension,
  type RunSuspensionCode,
  type RuntimeRunAction,
  snapshotRunResumeRequestInput,
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
  assertDelegationAuthorityRestrictionWithinCeiling,
  projectDelegationRunAuthority,
  projectDelegationRunLimits,
} from "../delegation/DelegationRunConfiguration.js";
import {
  deriveDelegationAuthority,
  deriveDelegationLimits,
  constructDelegationResult,
  createDescendantProgress,
  createDescendantContinuationTargetProjection,
  materializeDelegationRequest,
  snapshotDelegationSteeringRoute,
  snapshotDelegationResumeRoute,
  snapshotDelegationPreparation,
  snapshotDelegationContextMaterial,
  snapshotDescendantMessageRequest,
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
  type DelegationResumeReceipt,
  type DelegationResumeRoute,
  type DescendantProgress,
  type DescendantContinuationTargetProjection,
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
  createDelegationSelectedContextAdmissionProfile,
  createDelegationSelectedContextContribution,
  createObservationContextAdmissionProfile,
  createObservationContextContribution,
  createControllerFeedbackContextAdmissionProfile,
  createControllerFeedbackContextContribution,
  createSteeringContextAdmissionProfile,
  createSteeringContextContribution,
  createTaskContextAdmissionProfile,
  createTaskContextContribution,
  createVerificationContextAdmissionProfile,
} from "../context-contribution/index.js";
import type {
  DescendantDispatchProvenance,
  DescendantRunReservationFailureCode,
  RunTreeExecutionSnapshot,
} from "./RunTreeExecution.js";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";

export interface RuntimeDescendantRunAdmissionInput {
  readonly relationId: string;
  readonly relationKind: DescendantRunRelation["kind"];
  readonly parentRunAction: RunActionRef;
  readonly agent: Agent;
  readonly request: DelegationRequest;
  readonly contextMaterials: readonly DelegationContextMaterial[];
  readonly authority: DelegationAuthorityDerivation;
  readonly limits: DelegationLimitDerivation;
  readonly modelInteractionSeed: readonly ModelMessage[];
  readonly dispatch: DescendantDispatchProvenance;
}

export type RuntimeDescendantRunLaunchResult =
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
        | "descendant_run_start_cancelled"
        | "descendant_run_start_failed";
      readonly relation: DescendantRunRelation;
      readonly reservedTreeRevision: number;
      readonly treeRevision: number;
    };

export type RuntimeDescendantRunAdmissionResult =
  | {
      readonly status: "admitted";
      readonly relation: DescendantRunRelation;
      readonly reservedTreeRevision: number;
      readonly treeRevision: number;
      readonly launch: () => RuntimeDescendantRunLaunchResult;
      readonly cancelBeforeLaunch: () => RuntimeDescendantRunLaunchResult;
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
      readonly treeRevision: number;
    };

export type RuntimeDescendantRunAdmitter = (
  input: RuntimeDescendantRunAdmissionInput,
) => RuntimeDescendantRunAdmissionResult;

type TerminalCandidate<TOutput> =
  | {
      readonly status: "succeeded";
      readonly output: TOutput;
      readonly source?: RunCauseSourceRef;
    }
  | {
      readonly status: "failed";
      readonly failure: RunFailureCause;
      readonly source?: RunCauseSourceRef;
      readonly underlying?: readonly RunCausalLink[];
      readonly omittedUnderlyingCount?: number;
    }
  | {
      readonly status: "cancelled";
      readonly underlying?: readonly RunCausalLink[];
      readonly omittedUnderlyingCount?: number;
    };

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

type ConcurrentDescendantCandidateEntry =
  | {
      readonly kind: "tool_rejected";
      readonly action: RuntimeRunAction;
      readonly candidate: ToolRequestCandidate;
      readonly attempt: ToolCallAttempt;
      readonly code: string;
      readonly message: string;
      readonly validation: import("@agent-anything/tools/validation").ToolInputValidationFailure | null;
    }
  | {
      readonly kind: "descendant";
      readonly action: RuntimeRunAction;
      readonly call: ToolCall;
      readonly startedAt: string;
      readonly preparation: DescendantPreparationOutcome;
    };

type DescendantExecutionOutcome =
  | {
      readonly status: "settled";
      readonly relationId: string;
      readonly childRunId: string;
      readonly result: DelegationResult;
      readonly continuation: import("@agent-anything/agent-core/delegation").DescendantContinuationRef | null;
      readonly resourceSettlement: RunTreeResourceSettlement;
    }
  | {
      readonly status: "suspended";
      readonly relationId: string;
      readonly childRunId: string;
      readonly progress: DescendantProgress;
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

interface AdmittedDescendantExecution {
  readonly status: "admitted";
  readonly relationId: string;
  readonly action: RuntimeRunAction;
  readonly dispatch: DescendantDispatchProvenance;
  readonly request: DelegationRequest;
  readonly continuationRecord: RuntimeContinuationRecord | null;
  readonly continuationModelInteractionSeed: readonly ModelMessage[];
  readonly composition: NonNullable<ResolvedRunnerDependencies["operations"]["delegation"]>;
  readonly admission: Extract<
    RuntimeDescendantRunAdmissionResult,
    { readonly status: "admitted" }
  >;
}

type DescendantPreparationOutcome = DescendantExecutionOutcome | AdmittedDescendantExecution;

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

interface RuntimeContinuationRecord {
  readonly correlation: DescendantContinuationCorrelation;
  readonly projection: DescendantContinuationTargetProjection;
  readonly sourceRequest: DelegationRequest;
  readonly sourceResult: DelegationResult;
  readonly modelInteractionSeed: readonly ModelMessage[];
  status: "available" | "starting" | "consumed";
}

interface ManagedActiveDescendant {
  readonly relationId: string;
  readonly relation: DescendantRunRelation;
  readonly request: DelegationRequest;
  readonly childRunId: string;
  readonly handle: RunHandle;
  readonly action: RuntimeRunAction;
  readonly composition: NonNullable<ResolvedRunnerDependencies["operations"]["delegation"]>;
  readonly pending: PendingRunSubject;
  readonly resourceSettlement: Promise<RunTreeResourceSettlement>;
  readonly continuationModelInteractionSeed: readonly ModelMessage[];
  readonly initialBoundary: Promise<DescendantExecutionOutcome>;
  resolveInitialBoundary(outcome: DescendantExecutionOutcome): void;
  readonly initialDelivery: Promise<void>;
  markInitialDelivered(): void;
  initialBoundaryKind: "pending" | "suspended" | "terminal";
  readonly reportedSuspensions: Set<string>;
  transferState: "pending" | "settled" | "failed";
  unsubscribe: () => void;
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
  private settlementPromise: Promise<RunResult<TOutput>> | null = null;
  private suspendedWaiter: {
    readonly suspension: RunSuspension;
    readonly resolve: () => void;
  } | null = null;
  private emittedItemCount = 0;
  private nextInteractionRequest = 1;
  private readonly identitySequences = new Map<
    Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"],
    number
  >();
  private readonly childHandles = new Map<string, ManagedActiveDescendant>();
  private readonly settledDelegations = new Map<string, {
    readonly result: DelegationResult;
  }>();
  private readonly continuationRecords = new Map<string, RuntimeContinuationRecord>();
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
    private readonly delegationContextMaterials: readonly DelegationContextMaterial[],
    private readonly modelInteractionSeed: readonly ModelMessage[],
    private readonly lineage: RunLineage,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: ActionExecutionObserver | undefined,
    startedAt: string,
    deadlineAt: string,
    private readonly admitDescendantRun: RuntimeDescendantRunAdmitter,
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
      getDescendantMessageAvailability: (targetAgent) =>
        this.descendantMessageAvailability(targetAgent),
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

  submitResume(input: RunResumeRequestInput): RunResumeReceipt {
    const current = this.writer.getSnapshot();
    const requestId = typeof input?.id === "string" ? input.id : "";
    let candidate: RunResumeRequestInput;
    try {
      candidate = snapshotRunResumeRequestInput(input);
    } catch {
      return rejectedResume("resume_invalid", requestId, current.revision);
    }
    if (current.status === "cancelling") {
      return rejectedResume("run_cancelling", candidate.id, current.revision);
    }
    if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
      return rejectedResume("run_settled", candidate.id, current.revision);
    }
    if (current.status !== "suspended" || this.suspendedWaiter === null) {
      return rejectedResume("run_not_suspended", candidate.id, current.revision);
    }
    if (candidate.expectedRunRevision !== current.revision) {
      return rejectedResume("run_revision_stale", candidate.id, current.revision);
    }
    if (!sameRunSuspensionRef(candidate.suspension, current.suspension.ref)) {
      return rejectedResume("suspension_stale", candidate.id, current.revision);
    }
    const request: RunResumeRequest = Object.freeze({
      ...candidate,
      run: current.run,
      requestedAt: this.now(),
    });
    const waiter = this.suspendedWaiter;
    const next = this.writer.commit({
      kind: "suspension_transition",
      transition: "resumed",
      suspension: current.suspension,
      resume: request,
    }, () => Object.freeze({
      status: "running" as const,
      suspension: null,
    }));
    this.suspendedWaiter = null;
    waiter.resolve();
    return Object.freeze({
      status: "accepted" as const,
      request,
      currentRunRevision: next.revision,
    });
  }

  private async suspendRun(
    code: RunSuspensionCode,
    source: RunCauseSourceRef,
    reason: string,
  ): Promise<void> {
    const current = this.writer.getSnapshot();
    if (this.terminalResult !== null || current.status === "cancelling") return;
    if (current.status === "suspended") {
      if (this.suspendedWaiter === null) {
        throw new TypeError("Suspended Run is missing its invocation-local resume waiter.");
      }
      return;
    }
    const nextRevision = current.revision + 1;
    const suspension: RunSuspension = Object.freeze({
      ref: Object.freeze({
        run: current.run,
        id: this.id("run_suspension"),
        revision: String(nextRevision),
      }),
      code,
      source,
      reason: boundedReason(reason),
      runRevision: nextRevision,
      suspendedAt: this.now(),
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.suspendedWaiter = Object.freeze({ suspension, resolve: resume });
    this.writer.commit({
      kind: "suspension_transition",
      transition: "suspended",
      suspension,
      resume: null,
    }, () => Object.freeze({
      status: "suspended" as const,
      suspension,
    }));

    const deadlineAtMs = Date.parse(current.deadlineAt);
    const remainingMs = Math.max(0, deadlineAtMs - Date.parse(this.now()));
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlineReached = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, remainingMs);
    });
    const cancelled = new Promise<void>((resolve) => {
      const signal = this.config.cancellation.context.signal;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([resumed, deadlineReached, cancelled]);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (this.suspendedWaiter?.suspension.ref.id === suspension.ref.id) {
      this.suspendedWaiter = null;
    }
  }

  private descendantMessageAvailability(
    targetAgent: Readonly<{ readonly id: string; readonly revision: string }>,
  ): import("./RunnerDependencies.js").ToolPathAvailability {
    const activeTargets = [...this.childHandles.values()]
      .filter(({ request, handle }) =>
        sameAgentRef(request.childAgent, targetAgent) && handle.getResult() === null
      )
      .map(({ childRunId }) => childRunId)
      .sort();
    const continuationTargets = [...this.continuationRecords.values()]
      .filter((record) =>
        record.status === "available" && sameAgentRef(record.correlation.agent, targetAgent)
      )
      .map(({ correlation }) => Object.freeze({
        id: correlation.ref.id,
        revision: correlation.ref.revision,
      }))
      .sort((left, right) =>
        `${left.id}@${left.revision}`.localeCompare(`${right.id}@${right.revision}`)
      );
    const available = activeTargets.length + continuationTargets.length > 0;
    return Object.freeze({
      basisRefs: Object.freeze([Object.freeze({
        owner: "agent-runtime",
        kind: "descendant_message_targets",
        id: `${this.runId}:${targetAgent.id}@${targetAgent.revision}`,
        revision: JSON.stringify({
          active: activeTargets,
          continuations: continuationTargets,
        }),
      })]),
      disposition: available ? "available" as const : "unavailable" as const,
      reason: available ? null : "no_eligible_subject" as const,
    });
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

  submitDescendantResume(input: DelegationResumeRoute): DelegationResumeReceipt {
    let route: DelegationResumeRoute;
    try {
      route = snapshotDelegationResumeRoute(input);
    } catch {
      return rejectedDelegationResume("delegation_route_invalid", null, null);
    }
    const direct = this.childHandles.get(route.relation.id);
    if (direct !== undefined) {
      if (
        direct.request.ref.id !== route.request.id ||
        direct.request.ref.revision !== route.request.revision ||
        direct.childRunId !== route.child.id
      ) {
        return rejectedDelegationResume(
          "delegation_route_mismatch",
          route.relation,
          route.child,
        );
      }
      if (direct.handle.getResult() !== null) {
        return rejectedDelegationResume(
          "delegation_child_settled",
          route.relation,
          route.child,
        );
      }
      return Object.freeze({
        status: "routed" as const,
        relation: route.relation,
        child: route.child,
        resume: direct.handle.resume(route.resume),
      });
    }
    const settled = [...this.settledDelegations.values()].find(({ result }) =>
      result.correlation.relation.ref.id === route.relation.id
    );
    if (settled !== undefined) {
      return rejectedDelegationResume(
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
      const nested = handle.resumeDescendant(route);
      if (
        nested.status !== "rejected" ||
        nested.code !== "delegation_relation_unknown"
      ) return nested;
    }
    return rejectedDelegationResume(
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
        : this.delegationContextMaterials.reduce((context, material) => {
            const entry = this.delegationRequest!.contextPlan.entries.find(
              (candidate) => sameDelegationMaterialRef(candidate.material, material.ref),
            );
            if (entry === undefined) {
              throw new TypeError("Delegation Context material is not selected by the request.");
            }
            return this.applyContextContributions(
              context,
              Object.freeze([createDelegationSelectedContextContribution({
                id: this.id("context_contribution"),
                runId: this.runId,
                material,
                role: entry.role,
                necessity: entry.necessity,
                createdAt: this.startedAt,
              })]),
              createDelegationSelectedContextAdmissionProfile(
                material,
                entry.role,
                entry.necessity,
              ),
              "delegation_initialization",
              this.delegationRequest!.ref.id,
            );
          }, this.writer.getSnapshot().context);
      const taskContribution = createTaskContextContribution({
        id: this.id("context_contribution"),
        runId: this.runId,
        task: this.input.task,
      });
      this.writer.commitState((current) => Object.freeze({
        status: "running" as const,
        context: this.applyContextContributions(
          initialContext,
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
          failure: startFailures[0]!,
          underlying: startFailures.slice(1).map((failure) => this.failureCausalLink(
            failure,
            "caused_by",
          )),
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
        if (decision.decision.kind === "continue_with_feedback") {
          this.commitControllerFeedback(decision.decision.feedback);
          continue;
        }
        if (decision.decision.kind === "propose_completion") {
          const completion = await this.evaluateRunStop(
            decision.turn,
            decision.decision.output,
          );
          if (completion.kind === "succeeded") {
            return await this.settle({
              status: "succeeded",
              output: decision.decision.output,
              source: completion.source,
            });
          }
          if (completion.kind === "suspend") {
            await this.suspendRun(
              completion.code,
              controllerTurnSource(decision.turn),
              completion.code,
            );
            continue;
          }
          if (completion.kind === "failed") {
            return await this.settle({
              status: "failed",
              failure: createRunFailureCause("verification", completion.failure),
              source: controllerTurnSource(decision.turn),
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
          await this.suspendRun(
            "controller_stop_requested",
            controllerTurnSource(decision.turn),
            decision.decision.reason,
          );
          continue;
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
            const siblingCount = this.descendantSiblingGroupLength(
              decision.decision.candidates,
              index,
            );
            const remainingActionCapacity = this.config.limits.maxActions -
              this.writer.getSnapshot().counters.runActions;
            if (siblingCount > 1) {
              if (remainingActionCapacity < siblingCount) {
                this.settleCandidateRange(
                  decision.decision.candidates.slice(index, index + siblingCount),
                  0,
                  decision.turn,
                  "invalidated",
                  "runtime_action_limit_reached",
                );
                outcome = Object.freeze({
                  invalidatesRemainder: true,
                  terminal: null,
                });
              } else {
                outcome = await this.processConcurrentDescendantCandidates(
                  decision.decision.candidates.slice(index, index + siblingCount) as readonly ToolRequestCandidate[],
                  index,
                  basis,
                );
              }
              index += siblingCount - 1;
            } else {
              outcome = await this.processCandidate(
                decision.decision.candidates[index]!,
                index,
                basis,
              );
            }
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
      const failure = this.failureFromError(error);
      if (error instanceof ControllerError) {
        const source = failure.source ?? this.failureSource(failure.failure, "controller_failure");
        return await this.settle(Object.freeze({ ...failure, source }));
      }
      return await this.settle(failure);
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
  ): Promise<
    | { readonly kind: "succeeded"; readonly source: RunCauseSourceRef }
    | { readonly kind: "continue" | "cancelled" }
    | {
        readonly kind: "suspend";
        readonly code: "completion_gate_feedback_exhausted";
      }
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
  > {
    const execution = this.requireVerificationExecution();
    const runState = this.writer.getSnapshot();
    if (this.config.cancellation.context.request !== null) return { kind: "cancelled" };
    if (runState.status !== "running" && runState.status !== "waiting") {
      return { kind: "continue" };
    }
    const activeRequiredDescendants = runState.pending.filter(
      (pending) => pending.kind === "descendant_run" && pending.required,
    );
    if (activeRequiredDescendants.length > 0) {
      this.commitControllerFeedback(Object.freeze({
        source: Object.freeze({
          owner: "agent-runtime",
          kind: "active_descendant_completion_obligation",
          id: this.runId,
          revision: String(runState.revision),
        }),
        code: "active_descendant_result_pending",
        message: "The Run cannot complete while required descendant work remains active. Continue other work, steer or resume the exact active Child, or cancel it before stopping.",
      }));
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
      return Object.freeze({
        kind: "failed" as const,
        owner: "verification" as const,
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
      return this.acceptRunCompletion(proposal);
    }
    if (decision.status === "invalid" || decision.status === "failed") {
      return Object.freeze({ kind: "failed" as const, owner: "verification" as const, failure: decision.failure });
    }
    if (decision.disposition === "fail") {
      return Object.freeze({
        kind: "failed" as const,
        owner: "verification" as const,
        failure: createVerificationFailure({
          code: "verification_completion_policy_failed",
          stage: "completion_gate",
          message: decision.reasons[0].message,
          retryable: false,
          cause: this.config.verification.completion.policy,
        }),
      });
    }
    if (decision.disposition === "wait" && gateInput.pendingWork.length === 0) {
      return Object.freeze({
        kind: "failed" as const,
        owner: "verification" as const,
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
    const feedbackRounds = this.writer.getSnapshot().verification.feedbackRounds + 1;
    this.writer.commitState((state) => Object.freeze({
      verification: Object.freeze({ ...state.verification, feedbackRounds }),
    }));
    return feedbackRounds > this.config.limits.completionGate.maxFeedbackRounds
      ? Object.freeze({ kind: "suspend" as const, code: "completion_gate_feedback_exhausted" as const })
      : Object.freeze({ kind: "continue" as const });
  }

  private commitControllerFeedback(
    feedback: import("../controller/index.js").ControllerFeedback,
  ): void {
    const current = this.writer.getSnapshot();
    const contribution = createControllerFeedbackContextContribution({
      id: this.currentContextContributionId(
        current.context,
        feedback.source.owner,
        "controller_feedback",
      ) ?? this.id("context_contribution"),
      revision: feedback.source.revision,
      runId: this.runId,
      feedback,
      createdAt: this.now(),
    });
    this.writer.commit(
      { kind: "controller_feedback", feedback },
      (state) => Object.freeze({
        context: this.applyContextContributions(
          state.context,
          Object.freeze([contribution]),
          createControllerFeedbackContextAdmissionProfile(feedback.source.owner),
          "controller_feedback",
          feedback.source.id,
        ),
      }),
    );
  }

  private acceptRunCompletion(
    proposal: Readonly<{ readonly id: string; readonly revision: string }>,
  ): { readonly kind: "succeeded"; readonly source: RunCauseSourceRef } {
    const state = this.writer.getSnapshot();
    const source: RunCauseSourceRef = Object.freeze({
      owner: "agent-runtime",
      kind: "run_completion_acceptance",
      id: this.id("run_completion_acceptance"),
      revision: proposal.revision,
      run: state.run,
    });
    this.writer.commitItems(Object.freeze([Object.freeze({
      kind: "completion_acceptance" as const,
      source,
      candidateId: proposal.id,
      candidateRevision: proposal.revision,
      acceptedAt: this.now(),
    })]));
    return Object.freeze({ kind: "succeeded" as const, source });
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
        feedbackRounds: current.verification.feedbackRounds,
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
        modelInteractionSeed: this.modelInteractionSeed,
        descendants: this.projectDescendantTargets(),
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

  private descendantSiblingGroupLength(
    candidates: readonly ProgressionCandidate[],
    startIndex: number,
  ): number {
    const first = candidates[startIndex];
    if (!this.isModelDescendantAgentCandidate(first)) return 0;
    let length = 1;
    for (let index = startIndex + 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (
        !this.isModelDescendantAgentCandidate(candidate) ||
        candidate.modelCallRef.controllerRequestId !== first.modelCallRef.controllerRequestId ||
        candidate.modelCallRef.turnId !== first.modelCallRef.turnId
      ) {
        break;
      }
      length += 1;
    }
    return length;
  }

  private isModelDescendantAgentCandidate(
    candidate: ProgressionCandidate | undefined,
  ): candidate is ToolRequestCandidate {
    if (candidate?.kind !== "tool_request" || candidate.tool.origin !== "model") {
      return false;
    }
    return findSelectedTool(
      this.config.tools,
      candidate.tool.name,
      candidate.tool.origin,
    )?.registration.descriptor.binding.kind === "descendant_agent";
  }

  private async processConcurrentDescendantCandidates(
    candidates: readonly ToolRequestCandidate[],
    startIndex: number,
    basis: CandidateBasis<TOutput>,
  ): Promise<CandidateProcessingOutcome<TOutput>> {
    const entries: ConcurrentDescendantCandidateEntry[] = [];
    for (let siblingIndex = 0; siblingIndex < candidates.length; siblingIndex += 1) {
      const candidate = candidates[siblingIndex]!;
      const candidateIndex = startIndex + siblingIndex;
      const toolCallId = this.id("tool_call");
      const action = this.materializeControllerRunAction(
        candidate,
        candidateIndex,
        basis,
        toolCallId,
      );
      const materialized = materializeToolCall({
        candidate: candidate.tool,
        selection: this.config.tools,
        exposure: basis.exposure,
        parentRunAction: action.ref,
        toolCallId,
        modelCall: candidate.modelCallRef,
        createdAt: this.now(),
        semanticValidators: this.dependencies.operations.toolInputSemanticValidators,
      });
      if (materialized.status === "rejected") {
        entries.push(Object.freeze({
          kind: "tool_rejected" as const,
          action,
          candidate,
          attempt: materialized.attempt,
          code: materialized.code,
          message: materialized.message,
          validation: materialized.validation,
        }));
        continue;
      }
      if (materialized.call.binding.kind !== "descendant_agent") {
        throw new TypeError("Concurrent descendant grouping resolved a non-Agent Tool binding.");
      }
      const dispatch: DescendantDispatchProvenance = Object.freeze({
        schemaVersion: 1 as const,
        requestedForm: "concurrent_sibling" as const,
        controllerRequestId: candidate.modelCallRef.controllerRequestId,
        controllerTurnId: basis.turn.id,
        candidateIndex,
        siblingIndex,
        siblingCount: candidates.length,
      });
      entries.push(Object.freeze({
        kind: "descendant" as const,
        action,
        call: materialized.call,
        startedAt: this.now(),
        preparation: await this.prepareDescendantRun(
          action,
          materialized.call,
          dispatch,
        ),
      }));
    }

    const invalidatedBeforeLaunch = this.config.cancellation.context.request !== null ||
      this.drainInteractionSettlements() > 0 ||
      this.drainSteering("apply") > 0;
    const invalidatesRemainder = invalidatedBeforeLaunch || entries.some((entry) =>
      entry.kind === "descendant" && entry.preparation.status === "admitted"
    );
    const outcomes = await Promise.allSettled(entries.map(async (
      entry,
    ): Promise<DescendantExecutionOutcome | null> => {
      if (entry.kind !== "descendant") return null;
      const preparation = entry.preparation;
      return preparation.status === "admitted"
        ? this.launchAdmittedDescendant(preparation, invalidatedBeforeLaunch)
        : preparation;
    }));

    let firstFailure: unknown = null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const settled = outcomes[index]!;
      if (entry.kind === "tool_rejected") {
        const toolResult = failedToolAttemptResult(
          entry.attempt,
          entry.code,
          entry.message,
          entry.validation,
          this.now(),
        );
        this.commitObservation(entry.action, {
          kind: "tool_rejected",
          attempt: entry.attempt,
          code: entry.code,
          message: entry.message,
          toolResult,
        }, [toolResultLowerRef(toolResult)], "tools");
        this.emit("tool.input.rejected", {
          attemptId: entry.attempt.ref.id,
          requestedName: entry.attempt.requestedName,
          selectedToolRevision: entry.attempt.selectedTool?.revision ?? null,
          code: entry.code,
          issueCount: entry.validation?.issues.length ?? 0,
          omittedIssueCount: entry.validation?.omittedIssueCount ?? 0,
          modelCallId: entry.attempt.ref.modelCall?.id ?? null,
        });
        this.commitModelCallSettlement(entry.action, null);
        continue;
      }
      if (settled.status === "rejected") {
        this.commitModelCallSettlement(
          entry.action,
          this.config.cancellation.context.request === null ? "failed" : "cancelled",
        );
        firstFailure ??= settled.reason;
        continue;
      }
      this.commitDescendantExecutionOutcome(
        entry.action,
        entry.call,
        settled.value!,
        entry.startedAt,
      );
      this.commitModelCallSettlement(entry.action, null);
    }
    if (firstFailure !== null) throw firstFailure;
    return Object.freeze({
      invalidatesRemainder,
      terminal: null,
    });
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
      modelCall: candidate.modelCallRef,
      createdAt: this.now(),
      semanticValidators: this.dependencies.operations.toolInputSemanticValidators,
    });
    if (materialized.status === "rejected") {
      const toolResult = failedToolAttemptResult(
        materialized.attempt,
        materialized.code,
        materialized.message,
        materialized.validation,
        this.now(),
      );
      this.commitObservation(action, {
        kind: "tool_rejected",
        attempt: materialized.attempt,
        code: materialized.code,
        message: materialized.message,
        toolResult,
      }, [toolResultLowerRef(toolResult)], "tools");
      this.emit("tool.input.rejected", {
        attemptId: materialized.attempt.ref.id,
        requestedName: materialized.attempt.requestedName,
        selectedToolRevision: materialized.attempt.selectedTool?.revision ?? null,
        code: materialized.code,
        issueCount: materialized.validation?.issues.length ?? 0,
        omittedIssueCount: materialized.validation?.omittedIssueCount ?? 0,
        modelCallId: materialized.attempt.ref.modelCall?.id ?? null,
      });
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
      case "descendant_message":
        await this.executeToolDescendantMessage(action, call);
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
    this.commitDescendantExecutionOutcome(action, call, descendant, startedAt);
  }

  private commitDescendantExecutionOutcome(
    action: RuntimeRunAction,
    call: ToolCall,
    descendant: DescendantExecutionOutcome,
    startedAt: string,
  ): void {
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
    if (descendant.status === "suspended") {
      const managed = this.childHandles.get(descendant.relationId);
      try {
        let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
        try {
          mapped = this.dependencies.operations.delegation!.progressProjection.project(
            Object.freeze({ progress: descendant.progress }),
          );
        } catch {
          mapped = Object.freeze({
            status: "failed" as const,
            output: null,
            failure: operationFailure(
              "agent-runtime",
              "delegation_progress_projection_failed",
            ),
          });
        }
        this.commitDescendantProgressObservation(
          action,
          call,
          descendant.progress,
          mapped,
          startedAt,
        );
      } finally {
        // Terminal transfer cannot remain blocked if Parent-side projection fails.
        managed?.markInitialDelivered();
      }
      return;
    }
    let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      mapped = this.dependencies.operations.delegation!.resultProjection.project(
        Object.freeze({
          result: descendant.result,
          continuation: descendant.continuation,
        }),
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

  private async executeToolDescendantMessage(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<void> {
    if (call.binding.kind !== "descendant_message") return;
    const targetAgent = call.binding.agent;
    const startedAt = this.now();
    let request: ReturnType<typeof snapshotDescendantMessageRequest>;
    try {
      request = snapshotDescendantMessageRequest(
        call.input as Parameters<typeof snapshotDescendantMessageRequest>[0],
      );
    } catch {
      this.commitDescendantToolObservation(
        action,
        call,
        null,
        null,
        "invalid",
        null,
        operationFailure("agent-runtime", "descendant_message_invalid"),
        startedAt,
        null,
      );
      return;
    }
    const active = [...this.childHandles.values()].find(
      (candidate) => candidate.childRunId === request.agent_id,
    );
    if (active !== undefined) {
      if (!sameAgentRef(active.request.childAgent, targetAgent)) {
        this.commitDescendantToolObservation(
          action, call, active.relationId, active.childRunId, "invalid", null,
          operationFailure("agent-runtime", "agent_target_incompatible"),
          startedAt, null,
        );
        return;
      }
      const before = active.handle.getSnapshot();
      const steering = active.handle.steer({
        commandId: `${call.toolCallId}:steer`,
        expectedRunRevision: before.runRevision,
        instruction: request.prompt,
        attribution: Object.freeze({ origin: "model", actorId: this.activeAgent.id }),
        submittedAt: this.now(),
      });
      if (steering.status === "rejected") {
        this.commitDescendantToolObservation(
          action, call, active.relationId, active.childRunId, "unavailable", null,
          operationFailure("agent-runtime", steering.code),
          startedAt, null,
        );
        return;
      }
      let resumed = false;
      if (before.status === "suspended" && before.suspension !== null) {
        const receipt = active.handle.resume({
          id: `${call.toolCallId}:resume`,
          expectedRunRevision: before.runRevision,
          suspension: before.suspension.ref,
          origin: "model",
          reason: "The Parent Agent supplied new steering for this suspended Child Run.",
        });
        if (receipt.status === "rejected") {
          this.commitDescendantToolObservation(
            action, call, active.relationId, active.childRunId, "partial",
            Object.freeze({
              agent_id: active.childRunId,
              status: "suspended",
              child_run_revision: receipt.currentRunRevision,
              summary: "Steering was accepted, but the exact Child suspension could not be resumed.",
              admitted_controls: Object.freeze(["steer", "resume", "cancel"]),
              steering_status: steering.status,
              resume_status: receipt.code,
            }),
            operationFailure("agent-runtime", receipt.code),
            startedAt, null,
          );
          return;
        }
        resumed = true;
      }
      const after = active.handle.getSnapshot();
      this.commitDescendantToolObservation(
        action,
        call,
        active.relationId,
        active.childRunId,
        "succeeded",
        Object.freeze({
          agent_id: active.childRunId,
          status: after.status === "suspended" && !resumed ? "suspended" : "running",
          child_run_revision: after.runRevision,
          summary: resumed
            ? "The existing Child Run accepted steering and resumed."
            : "The existing Child Run accepted steering.",
          admitted_controls: Object.freeze(["steer", "resume", "cancel"]),
          steering_status: steering.status,
          resume_status: resumed ? "accepted" : "not_required",
        }),
        null,
        startedAt,
        null,
      );
      return;
    }

    const target = this.continuationRecords.get(request.agent_id);
    if (target === undefined) {
      this.commitDescendantToolObservation(
        action, call, null, null, "unavailable", null,
        operationFailure("agent-runtime", "agent_target_unknown"),
        startedAt, null,
      );
      return;
    }
    if (target.status !== "available") {
      this.commitDescendantToolObservation(
        action, call, null, target.correlation.sourceChild.id, "unavailable", null,
        operationFailure("agent-runtime", "agent_target_stale"),
        startedAt, null,
      );
      return;
    }
    if (
      target.correlation.root.id !== this.lineage.root.id ||
      target.correlation.parent.id !== this.runId ||
      !sameAgentRef(target.correlation.agent, targetAgent)
    ) {
      this.commitDescendantToolObservation(
        action, call, null, null, "invalid", null,
        operationFailure("agent-runtime", "agent_target_incompatible"),
        startedAt, null,
      );
      return;
    }
    const descendant = await this.executeDescendantRun(action, call);
    if (descendant.status === "rejected") {
      const code = isContinuationNotResumableCode(descendant.code)
        ? "agent_target_not_resumable"
        : descendant.code;
      this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        descendant.operationStatus,
        null,
        operationFailure("agent-runtime", code),
        startedAt,
        null,
      );
      return;
    }
    if (descendant.status === "suspended") {
      this.commitDescendantExecutionOutcome(action, call, descendant, startedAt);
      return;
    }
    let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      mapped = this.dependencies.operations.delegation!.resultProjection.project(
        Object.freeze({
          result: descendant.result,
          continuation: descendant.continuation,
        }),
      );
    } catch {
      mapped = Object.freeze({
        status: "failed" as const,
        output: null,
        failure: operationFailure(
          "agent-runtime",
          "delegation_result_projection_failed",
        ),
      });
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
    dispatch = this.singleDescendantDispatch(action),
  ): Promise<DescendantExecutionOutcome> {
    const prepared = await this.prepareDescendantRun(action, call, dispatch);
    return prepared.status === "admitted"
      ? this.launchAdmittedDescendant(prepared)
      : prepared;
  }

  private async prepareDescendantRun(
    action: RuntimeRunAction,
    call: ToolCall,
    dispatch: DescendantDispatchProvenance,
  ): Promise<DescendantPreparationOutcome> {
    if (
      call.binding.kind !== "descendant_agent" &&
      call.binding.kind !== "descendant_message"
    ) {
      throw new TypeError("Descendant execution requires a descendant Tool binding.");
    }
    const composition = this.dependencies.operations.delegation;
    if (composition === undefined) {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_preparation_failed",
        this.runTree.getSnapshot().revision,
        dispatch,
      );
      return rejectedDescendant(
        null,
        "delegation_preparation_failed",
        null,
        "failed",
      );
    }

    const authorityCeiling = projectDelegationRunAuthority(this.config);
    const treeResourceCeiling = this.runTree.getSnapshot().nodes.find(
      (node) => node.runId === this.runId,
    )?.resources.delegationCeiling;
    if (treeResourceCeiling === undefined) {
      throw new TypeError("Current Run Tree resource allocation is unavailable.");
    }
    let limitCeiling: DelegationLimits;
    try {
      const distributable = descendantAllocationCeiling(
        treeResourceCeiling,
        dispatch,
      );
      limitCeiling = projectDelegationRunLimits({
        config: this.config,
        maxControllerTurns: distributable.controllerTurns,
        maxActions: distributable.actions,
        maxContextBytes: Math.min(
          distributable.contextBytes,
          delegationPayloadCeiling(
            this.dependencies.contextProjection.maxContributionPayloadBytes,
            4,
          ),
        ),
        maxResultBytes: Math.min(
          distributable.resultBytes,
          delegationPayloadCeiling(
            this.dependencies.contextProjection.maxContributionPayloadBytes,
            1,
          ),
        ),
        maxModelInputTokens: distributable.modelInputTokens,
        maxModelOutputTokens: distributable.modelOutputTokens,
        maxCostUnits: distributable.costUnits,
      });
    } catch {
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_resource_limit_exceeded",
        this.runTree.getSnapshot().revision,
        dispatch,
      );
      return rejectedDescendant(
        null,
        "delegation_resource_limit_exceeded",
        null,
        "unavailable",
      );
    }
    const targetAgent = call.binding.agent;
    let continuationRecord: RuntimeContinuationRecord | null = null;
    let continuationModelInteractionSeed: readonly ModelMessage[] = Object.freeze([]);
    let prepared: Awaited<ReturnType<typeof composition.preparation.prepare>>;
    try {
      if (call.binding.kind === "descendant_message") {
        const message = snapshotDescendantMessageRequest(
          call.input as Parameters<typeof snapshotDescendantMessageRequest>[0],
        );
        const candidate = this.continuationRecords.get(message.agent_id);
        if (
          candidate === undefined ||
          candidate.status !== "available" ||
          candidate.correlation.ref.id !== message.agent_id ||
          candidate.correlation.root.id !== this.lineage.root.id ||
          candidate.correlation.parent.id !== this.runId ||
          !sameAgentRef(candidate.correlation.agent, targetAgent)
        ) {
          throw new TypeError("Descendant continuation is unavailable or stale.");
        }
        candidate.status = "starting";
        continuationRecord = candidate;
        continuationModelInteractionSeed = Object.freeze([
          ...candidate.modelInteractionSeed,
          snapshotModelMessage({
            role: "user",
            content: Object.freeze([Object.freeze({
              kind: "text" as const,
              text: message.prompt,
            })]),
          }),
        ]);
        prepared = await composition.continuation.prepare({
          parentRunId: this.runId,
          targetAgent,
          sourceRequest: candidate.sourceRequest,
          sourceResult: candidate.sourceResult,
          message: message.prompt,
          authorityCeiling,
          limitCeiling,
        });
      } else {
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
          targetAgent,
          toolCall: call,
          authorityCeiling,
          limitCeiling,
        });
      }
      prepared = Object.freeze({
        agent: prepared.agent,
        preparation: snapshotDelegationPreparation(prepared.preparation),
        contextMaterials: Object.freeze(
          prepared.contextMaterials.map(snapshotDelegationContextMaterial),
        ),
      });
    } catch {
      if (continuationRecord?.status === "starting") {
        continuationRecord.status = "available";
      }
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_preparation_failed",
        this.runTree.getSnapshot().revision,
        dispatch,
      );
      return rejectedDescendant(
        null,
        "delegation_preparation_failed",
        null,
        "failed",
      );
    }
    if (!sameAgentRef(prepared.agent, targetAgent) ||
        !sameAgentRef(prepared.preparation.childAgent, targetAgent)) {
      if (continuationRecord?.status === "starting") {
        continuationRecord.status = "available";
      }
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        "delegation_request_invalid",
        this.runTree.getSnapshot().revision,
        dispatch,
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
    let selectedContextMaterials: readonly DelegationContextMaterial[];
    try {
      if (prepared.preparation.authorityRestriction !== null) {
        assertDelegationAuthorityRestrictionWithinCeiling({
          restriction: prepared.preparation.authorityRestriction,
          ceiling: authorityCeiling,
        });
      }
      const createdAt = this.now();
      const rootAuthority = projectDelegationRunAuthority(this.rootConfig);
      const parentAuthority = projectDelegationRunAuthority(this.config);
      const requestDeadlineAt = minimumDeadline(
        this.writer.getSnapshot().deadlineAt,
        localDelegationDeadline(
          createdAt,
          prepared.preparation.allocationRequest.maxDurationMs,
        ),
      );
      authority = deriveDelegationAuthority({
        derivationId: this.id("delegation_authority"),
        sources: delegationAuthoritySources({
          rootRunId: this.lineage.root.id,
          parentRunId: this.runId,
          root: rootAuthority,
          parent: parentAuthority,
          restriction: prepared.preparation.authorityRestriction,
          currentPolicy: parentAuthority,
          preparation: prepared.preparation,
          rootDeadlineAt: this.runTree.getSnapshot().deadlineAt,
          parentDeadlineAt: this.writer.getSnapshot().deadlineAt,
          requestDeadlineAt,
        }),
      });
      const rootLimits = projectDelegationRunLimits({
        config: this.rootConfig,
        maxControllerTurns: limitCeiling.maxControllerTurns,
        maxActions: limitCeiling.maxActions,
        maxContextBytes: limitCeiling.maxContextBytes,
        maxResultBytes: limitCeiling.maxResultBytes,
        maxModelInputTokens: limitCeiling.maxModelInputTokens,
        maxModelOutputTokens: limitCeiling.maxModelOutputTokens,
        maxCostUnits: limitCeiling.maxCostUnits,
      });
      const parentLimits = projectDelegationRunLimits({
        config: this.config,
        maxControllerTurns: limitCeiling.maxControllerTurns,
        maxActions: limitCeiling.maxActions,
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
          allocationRequest: prepared.preparation.allocationRequest,
          currentPolicy: parentLimits,
          preparation: prepared.preparation,
        }),
      });
      selectedContextMaterials = Object.freeze([...prepared.contextMaterials]);
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
        continuation: continuationRecord?.correlation ?? null,
        createdAt,
      });
    } catch (error) {
      if (continuationRecord?.status === "starting") {
        continuationRecord.status = "available";
      }
      const code = delegationMaterializationFailureCode(error);
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        code,
        this.runTree.getSnapshot().revision,
        dispatch,
      );
      return rejectedDescendant(null, code, null, "invalid");
    }

    const relationId = this.id("descendant_relation");

    const admission = this.admitDescendantRun({
      relationId,
      relationKind: request.continuation !== null ? "continuation" : "delegation",
      parentRunAction: action.ref,
      agent: prepared.agent,
      request,
      contextMaterials: selectedContextMaterials,
      authority,
      limits,
      modelInteractionSeed: continuationRecord === null
        ? Object.freeze([])
        : continuationModelInteractionSeed,
      dispatch,
    });
    if (admission.status === "rejected") {
      if (continuationRecord?.status === "starting") {
        continuationRecord.status = "available";
      }
      this.emitDescendantRejected(
        null,
        action.ref,
        null,
        this.lineage.depth + 1,
        admission.code,
        admission.treeRevision,
        dispatch,
      );
      return rejectedDescendant(
        null,
        admission.code,
        null,
        descendantRejectionStatus(admission.code),
      );
    }
    this.emitDescendantLifecycle(
      "run.descendant.reserved",
      admission.relation,
      request,
      admission.reservedTreeRevision,
      dispatch,
    );
    return Object.freeze({
      status: "admitted" as const,
      relationId,
      action,
      dispatch,
      request,
      continuationRecord,
      continuationModelInteractionSeed,
      composition,
      admission,
    });
  }

  private async launchAdmittedDescendant(
    prepared: AdmittedDescendantExecution,
    cancelBeforeLaunch = false,
  ): Promise<DescendantExecutionOutcome> {
    const {
      relationId,
      action,
      dispatch,
      request,
      continuationRecord,
      continuationModelInteractionSeed,
      composition,
      admission,
    } = prepared;
    const started = !cancelBeforeLaunch && this.config.cancellation.context.request === null
      ? admission.launch()
      : admission.cancelBeforeLaunch();
    if (started.status === "rejected") {
      if (continuationRecord?.status === "starting") {
        continuationRecord.status = "available";
      }
      this.emitDescendantRejected(
        started.relation.ref.id,
        action.ref,
        started.relation.child.id,
        started.relation.depth,
        started.code,
        started.treeRevision,
        dispatch,
      );
      return rejectedDescendant(
        relationId,
        started.code,
        started.relation.child.id,
        descendantRejectionStatus(started.code),
      );
    }

    if (continuationRecord !== null) {
      continuationRecord.status = "consumed";
    }

    this.emitDescendantLifecycle(
      "run.descendant.started",
      started.relation,
      request,
      started.treeRevision,
      dispatch,
    );

    const child = started.handle;
    const pending: PendingRunSubject = Object.freeze({
      kind: "descendant_run",
      relationId,
      childRunId: child.runId,
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });

    let resolveInitialBoundary!: (outcome: DescendantExecutionOutcome) => void;
    let initialBoundaryResolved = false;
    const initialBoundary = new Promise<DescendantExecutionOutcome>((resolve) => {
      resolveInitialBoundary = resolve;
    });
    let resolveInitialDelivery!: () => void;
    let initialDeliveryResolved = false;
    const initialDelivery = new Promise<void>((resolve) => {
      resolveInitialDelivery = resolve;
    });
    const managed: ManagedActiveDescendant = {
      relationId,
      relation: started.relation,
      request,
      childRunId: child.runId,
      handle: child,
      action,
      composition,
      pending,
      resourceSettlement: started.resourceSettlement,
      continuationModelInteractionSeed,
      initialBoundary,
      resolveInitialBoundary(outcome) {
        if (initialBoundaryResolved) return;
        initialBoundaryResolved = true;
        resolveInitialBoundary(outcome);
      },
      initialDelivery,
      markInitialDelivered() {
        if (initialDeliveryResolved) return;
        initialDeliveryResolved = true;
        resolveInitialDelivery();
      },
      initialBoundaryKind: "pending",
      reportedSuspensions: new Set<string>(),
      transferState: "pending",
      unsubscribe: () => {},
    };
    this.childHandles.set(relationId, managed);
    this.addPending(pending);
    managed.unsubscribe = child.subscribe((snapshot) => {
      this.publishCurrentState();
      if (
        snapshot.result === null &&
        snapshot.status === "suspended" &&
        snapshot.suspension !== null
      ) {
        this.observeManagedDescendantSuspension(managed, snapshot);
      }
    });
    void child.wait().then(
      (result) => this.finalizeManagedDescendant(managed, result, dispatch),
      () => this.failManagedDescendant(managed, "delegation_result_invalid"),
    );
    return initialBoundary;
  }

  private observeManagedDescendantSuspension(
    managed: ManagedActiveDescendant,
    snapshot: ReturnType<RunHandle["getSnapshot"]>,
  ): void {
    const suspension = snapshot.suspension;
    if (suspension === null || managed.transferState !== "pending") return;
    const key = `${suspension.ref.id}@${suspension.ref.revision}:${snapshot.runRevision}`;
    if (managed.reportedSuspensions.has(key)) return;
    managed.reportedSuspensions.add(key);
    const progress = createDescendantProgress({
      relation: managed.relation.ref,
      request: managed.request.ref,
      childRun: managed.relation.child,
      childRunRevision: snapshot.runRevision,
      suspension,
      admittedControls: Object.freeze(["steer", "resume", "cancel"]),
      observedAt: this.now(),
    });
    if (managed.initialBoundaryKind === "pending") {
      managed.initialBoundaryKind = "suspended";
      managed.resolveInitialBoundary(Object.freeze({
        status: "suspended" as const,
        relationId: managed.relationId,
        childRunId: managed.childRunId,
        progress,
      }));
      return;
    }
    void managed.initialDelivery.then(() => {
      if (
        managed.transferState !== "pending" ||
        managed.handle.getResult() !== null ||
        this.terminalResult !== null
      ) return;
      this.commitAsyncDescendantProgress(managed, progress);
    });
  }

  private async finalizeManagedDescendant(
    managed: ManagedActiveDescendant,
    result: RunResult,
    dispatch: DescendantDispatchProvenance,
  ): Promise<void> {
    let resourceSettlement: RunTreeResourceSettlement;
    let delegationResult: DelegationResult;
    try {
      resourceSettlement = await managed.resourceSettlement;
      const narrative = managed.composition.narrativeProjection.project({
        request: managed.request,
        childResult: result,
      });
      delegationResult = constructDelegationResult({
        resultId: this.id("delegation_result"),
        request: managed.request,
        correlation: Object.freeze({
          request: managed.request.ref,
          origin: managed.request.origin,
          relation: managed.relation,
          child: Object.freeze({
            run: managed.relation.child,
            task: Object.freeze({ id: result.taskId }),
            agent: managed.request.childAgent,
          }),
        }),
        childResult: result,
        narrative,
        resourceSettlement,
        createdAt: this.now(),
      });
    } catch {
      this.failManagedDescendant(managed, "delegation_result_invalid");
      return;
    }

    this.settledDelegations.set(delegationResult.ref.id, Object.freeze({
      result: delegationResult,
    }));
    const continuation = this.retainDescendantContinuation(
      managed.request,
      delegationResult,
      result,
      managed.continuationModelInteractionSeed,
    );
    managed.transferState = "settled";
    this.runTree.settleDescendantTransfer(managed.childRunId, "settled");
    this.emitDescendantSettled(managed, delegationResult, dispatch);
    const outcome: DescendantExecutionOutcome = Object.freeze({
      status: "settled" as const,
      relationId: managed.relationId,
      childRunId: managed.childRunId,
      result: delegationResult,
      continuation: continuation?.ref ?? null,
      resourceSettlement,
    });
    if (managed.initialBoundaryKind === "pending") {
      managed.initialBoundaryKind = "terminal";
      managed.resolveInitialBoundary(outcome);
    } else {
      await managed.initialDelivery;
      if (this.terminalResult === null) {
        this.commitDescendantResultTransfer(managed, delegationResult, continuation?.ref ?? null);
      }
    }
    this.cleanupManagedDescendant(managed, "resolved", delegationResult.ref.id);
  }

  private failManagedDescendant(
    managed: ManagedActiveDescendant,
    code: "delegation_result_invalid",
  ): void {
    if (managed.transferState !== "pending") return;
    managed.transferState = "failed";
    const childNode = this.runTree.getSnapshot().nodes.find(
      (node) => node.runId === managed.childRunId,
    );
    if (childNode?.resultTransfer === "pending") {
      this.runTree.settleDescendantTransfer(managed.childRunId, "failed");
    }
    if (managed.initialBoundaryKind === "pending") {
      managed.initialBoundaryKind = "terminal";
      managed.resolveInitialBoundary(rejectedDescendant(
        managed.relationId,
        code,
        managed.childRunId,
        "failed",
      ));
    } else {
      void managed.initialDelivery.then(() => {
        if (this.terminalResult !== null) return;
        this.commitObservation(managed.action, {
          kind: "descendant_result_transfer",
          childRunId: managed.childRunId,
          result: null,
          status: "failed",
          output: null,
          failure: operationFailure("agent-runtime", code),
        }, [{
          owner: "agent-runtime",
          kind: "descendant_result_transfer",
          id: managed.childRunId,
          revision: "failed",
        }], "agent-runtime");
      });
    }
    this.cleanupManagedDescendant(managed, "failed", null);
  }

  private cleanupManagedDescendant(
    managed: ManagedActiveDescendant,
    transition: "resolved" | "failed",
    recordRef: string | null,
  ): void {
    managed.unsubscribe();
    if (this.childHandles.get(managed.relationId) === managed) {
      this.childHandles.delete(managed.relationId);
    }
    this.removePending(managed.pending, transition, recordRef);
    this.publishCurrentState();
  }

  private emitDescendantSettled(
    managed: ManagedActiveDescendant,
    result: DelegationResult,
    dispatch: DescendantDispatchProvenance,
  ): void {
    this.eventStream.emit("run.descendant.settled", {
      ...descendantDispatchEventPayload(dispatch),
      relationId: managed.relation.ref.id,
      relationKind: managed.relation.kind,
      parentRunActionId: managed.relation.parentRunAction.id,
      childRunId: managed.relation.child.id,
      childAgentId: managed.request.childAgent.id,
      childAgentRevision: managed.request.childAgent.revision,
      requestId: managed.request.ref.id,
      requestRevision: managed.request.ref.revision,
      contextSourceCount: managed.request.contextPlan.entries.length,
      authorityDerivationId: managed.request.authorityDerivation.id,
      limitDerivationId: managed.request.limitDerivation.id,
      depth: managed.relation.depth,
      status: result.terminal.status,
      code: result.terminal.code,
      resultId: result.ref.id,
      resultRevision: result.ref.revision,
      expectationPresentCount: result.expectationCoverage.filter(
        ({ disposition }) => disposition === "present",
      ).length,
      expectationUnmetCount: result.expectationCoverage.filter(
        ({ required, disposition }) => required && disposition !== "present",
      ).length,
      evidenceCount: result.evidence.totalCount,
      artifactCount: result.artifacts.totalCount,
      verificationStatus: result.verification.status,
      effectStatus: result.effects.status,
      uncertaintyCount: result.uncertainty.length,
      controllerTurns: result.usage.controllerTurns.status === "measured"
        ? result.usage.controllerTurns.value
        : 0,
      actions: result.usage.actions.status === "measured"
        ? result.usage.actions.value
        : 0,
      modelUsageStatus: delegationModelUsageStatus(result),
      limitStatus: result.limitDisposition.status,
      exhaustedLimit: result.limitDisposition.exhaustedLimit,
      treeRevision: this.runTree.getSnapshot().revision,
    });
  }

  private emitDescendantLifecycle(
    name: "run.descendant.reserved" | "run.descendant.started",
    relation: DescendantRunRelation,
    request: DelegationRequest,
    treeRevision: number,
    dispatch: DescendantDispatchProvenance,
  ): void {
    this.eventStream.emit(name, {
      ...descendantDispatchEventPayload(dispatch),
      relationId: relation.ref.id,
      relationKind: relation.kind,
      parentRunActionId: relation.parentRunAction.id,
      childRunId: relation.child.id,
      childAgentId: request.childAgent.id,
      childAgentRevision: request.childAgent.revision,
      requestId: request.ref.id,
      requestRevision: request.ref.revision,
      contextSourceCount: request.contextPlan.entries.length,
      authorityDerivationId: request.authorityDerivation.id,
      limitDerivationId: request.limitDerivation.id,
      depth: relation.depth,
      treeRevision,
    });
  }

  private singleDescendantDispatch(
    action: RuntimeRunAction,
  ): DescendantDispatchProvenance {
    if (action.provenance.kind !== "controller") {
      throw new TypeError("Descendant Tool dispatch requires Controller provenance.");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      requestedForm: "single" as const,
      controllerRequestId: action.provenance.modelCallRef.controllerRequestId,
      controllerTurnId: action.provenance.turn.id,
      candidateIndex: action.provenance.candidateIndex,
      siblingIndex: 0,
      siblingCount: 1,
    });
  }

  private retainDescendantContinuation(
    request: DelegationRequest,
    result: DelegationResult,
    childResult: RunResult,
    childModelInteractionSeed: readonly ModelMessage[],
  ): DescendantContinuationCorrelation | null {
    if (
      result.terminal.status === "cancelled" ||
      result.effects.status === "unknown"
    ) {
      return null;
    }
    let interaction: ModelInteractionProjection;
    try {
      interaction = projectModelInteraction({
        runId: childResult.runId,
        runRevision: childResult.items.at(-1)?.ref.sequence ?? 0,
        items: childResult.items,
        seedMessages: childModelInteractionSeed,
      });
    } catch {
      return null;
    }
    if (interaction.unsettledCalls.length > 0 || interaction.messages.length === 0) {
      return null;
    }
    const material = Object.freeze({
      sourceRequest: request.ref,
      sourceResult: result.ref,
      root: result.correlation.origin.root.run,
      parent: result.correlation.origin.parent.run,
      sourceChild: result.correlation.child.run,
      agent: result.correlation.child.agent,
    });
    const correlation: DescendantContinuationCorrelation = Object.freeze({
      ref: Object.freeze({
        id: this.id("descendant_continuation"),
        revision: createDelegationContractIdentity(
          "agent-anything.descendant-continuation.v1",
          material,
        ),
      }),
      ...material,
    });
    const limitations = Object.freeze([
      result.terminal.code,
      ...result.uncertainty,
      ...(result.limitDisposition.exhaustedLimit === null
        ? []
        : [`limit_${result.limitDisposition.exhaustedLimit}_exhausted`]),
    ].filter((value, index, values) => values.indexOf(value) === index));
    const record: RuntimeContinuationRecord = {
      correlation,
      projection: createDescendantContinuationTargetProjection({
        correlation,
        limitations,
      }),
      sourceRequest: request,
      sourceResult: result,
      modelInteractionSeed: interaction.messages,
      status: "available",
    };
    this.continuationRecords.set(correlation.ref.id, record);
    this.publishCurrentState();
    return correlation;
  }

  private projectDescendantTargets(): import("../delegation/index.js").DescendantTargetsProjection {
    return Object.freeze({
      active: Object.freeze([...this.childHandles.entries()].flatMap(
        ([relationId, child]) => {
          const snapshot = child.handle.getSnapshot();
          return snapshot.result === null
            ? [Object.freeze({
                target: Object.freeze({
                  kind: "active" as const,
                  id: child.childRunId,
                }),
                relation: Object.freeze({ id: relationId }),
                relationKind: child.request.continuation !== null
                  ? "continuation" as const
                  : "delegation" as const,
                agent: child.request.childAgent,
                runRevision: snapshot.runRevision,
                status: snapshot.status as
                  | "initializing"
                  | "running"
                  | "waiting"
                  | "suspended"
                  | "cancelling",
              })]
            : [];
        },
      )),
      continuations: Object.freeze(
        [...this.continuationRecords.values()]
          .filter(({ status }) => status === "available")
          .map(({ projection }) => projection),
      ),
    });
  }

  private emitDescendantRejected(
    relationId: string | null,
    parentRunAction: RunActionRef,
    childRunId: string | null,
    depth: number | null,
    code: import("@agent-anything/observability/events").RuntimeDescendantRunFailureCode,
    treeRevision: number,
    dispatch: DescendantDispatchProvenance,
  ): void {
    this.eventStream.emit("run.descendant.rejected", {
      ...descendantDispatchEventPayload(dispatch),
      relationId,
      parentRunActionId: parentRunAction.id,
      childRunId,
      depth,
      code,
      treeRevision,
    });
  }

  private commitDescendantProgressObservation(
    action: RuntimeRunAction,
    call: ToolCall,
    progress: DescendantProgress,
    projected: import("./RunnerDependencies.js").DescendantOperationOutcome,
    startedAt: string,
  ): void {
    const finishedAt = this.now();
    const settlement = Object.freeze({
      owner: "agent-runtime",
      kind: "descendant_progress",
      id: progress.childRun.id,
      revision: String(progress.childRunRevision),
    });
    const toolResult = projected.status === "succeeded"
      ? succeededToolResult(call, settlement, projected.output, startedAt, finishedAt)
      : projected.status === "partial"
        ? partialToolResult(
            call,
            settlement,
            projected.output,
            projected.failure,
            startedAt,
            finishedAt,
          )
        : failedToolResult(
            call,
            settlement,
            projected.failure.code,
            projected.failure.message,
            startedAt,
            finishedAt,
            projected.status === "timed_out" ? "timeout" : "failed",
          );
    this.commitObservation(action, {
      kind: "descendant_progress",
      progress,
      output: projected.output,
      toolResult,
    }, [
      {
        owner: "agent-runtime",
        kind: "descendant_progress",
        id: progress.childRun.id,
        revision: String(progress.childRunRevision),
      },
      toolResultLowerRef(toolResult),
    ], "agent-runtime");
  }

  private commitAsyncDescendantProgress(
    managed: ManagedActiveDescendant,
    progress: DescendantProgress,
  ): void {
    let output: unknown = null;
    try {
      output = managed.composition.progressProjection.project(
        Object.freeze({ progress }),
      ).output;
    } catch {
      // The Core progress record remains authoritative even if Product projection fails.
    }
    this.commitObservation(managed.action, {
      kind: "descendant_progress",
      progress,
      output,
      toolResult: null,
    }, [{
      owner: "agent-runtime",
      kind: "descendant_progress",
      id: progress.childRun.id,
      revision: String(progress.childRunRevision),
    }], "agent-runtime");
  }

  private commitDescendantResultTransfer(
    managed: ManagedActiveDescendant,
    result: DelegationResult,
    continuation: Readonly<{ readonly id: string; readonly revision: string }> | null,
  ): void {
    let projected: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      projected = managed.composition.resultProjection.project({ result, continuation });
    } catch {
      projected = Object.freeze({
        status: "failed" as const,
        output: null,
        failure: operationFailure(
          "agent-runtime",
          "delegation_result_projection_failed",
        ),
      });
    }
    this.commitObservation(managed.action, {
      kind: "descendant_result_transfer",
      childRunId: managed.childRunId,
      result,
      status: projected.status,
      output: projected.output,
      failure: projected.failure,
    }, [{
      owner: "agent-runtime",
      kind: "delegation_result",
      id: result.ref.id,
      revision: result.ref.revision,
    }], "agent-runtime");
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
        : [toolResultLowerRef(outcome.toolResult)]),
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
    const waiter = this.suspendedWaiter;
    this.suspendedWaiter = null;
    waiter?.resolve();
  }

  private async settle(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    if (this.terminalResult !== null) return this.terminalResult;
    if (this.settlementPromise !== null) return this.settlementPromise;
    this.settlementPromise = this.performSettlement(candidate);
    return this.settlementPromise;
  }

  private async performSettlement(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    this.drainSteering(candidate.status === "cancelled" ? "cancelled" : "run_settled");
    this.interactions.close();
    this.drainInteractionSettlements();
    let terminal = candidate;
    const stateBeforeFinalization = this.writer.getSnapshot();
    if (stateBeforeFinalization.plan?.status === "active") {
      const abandoned = abandonPlan({
        plan: stateBeforeFinalization.plan,
        terminalStatus: terminal.status,
        reasonCode: terminal.status === "failed"
          ? terminal.failure.failure.code
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
        terminal = terminal.status === "succeeded"
          ? {
              status: "failed",
              failure: failures[0]!,
              source: this.failureSource(failures[0]!, "required_finalization"),
              underlying: failures.slice(1).map((failure) =>
                this.failureCausalLink(failure, "terminalization_failure")
              ),
            }
          : this.appendTerminalFailures(terminal, failures, "terminalization_failure");
      }
    } finally {
      finalization.dispose();
    }

    if (this.resourceFailure !== null) {
      const resource = this.resourceFailureCandidate(this.resourceFailure);
      terminal = terminal.status === "succeeded"
        ? resource
        : this.appendTerminalFailures(
            terminal,
            Object.freeze([resource.failure]),
            "terminalization_failure",
          );
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
      const resource = this.resourceFailureCandidate(resultResource);
      terminal = terminal.status === "succeeded"
        ? resource
        : this.appendTerminalFailures(
            terminal,
            Object.freeze([resource.failure]),
            "terminalization_failure",
          );
    }
    this.runTree.settleResources(this.runId);

    const completedAt = this.now();
    const cancellationRequest = this.config.cancellation.context.request;
    const cause = this.createSettlementCause(terminal, cancellationRequest, completedAt);
    const settlement: RunSettlement<TOutput> = terminal.status === "succeeded"
      ? Object.freeze({
          status: "succeeded" as const,
          completedAt,
          cause: cause.ref,
          output: terminal.output,
        })
      : terminal.status === "failed"
        ? Object.freeze({
            status: "failed" as const,
            completedAt,
            cause: cause.ref,
          })
        : Object.freeze({
            status: "cancelled" as const,
            completedAt,
            cause: cause.ref,
          });
    this.writer.commitItems(Object.freeze([
      Object.freeze({ kind: "settlement_cause" as const, cause }),
      Object.freeze({
        kind: "terminal_transition" as const,
        status: settlement.status,
        settlement,
        cause,
      }),
    ]), (current) => terminalStatePatch(
      terminal,
      settlement,
      cause,
      cancellationRequest,
      completedAt,
      Object.freeze([...current.settlementCauses, cause]),
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
      settlement,
      cause,
      settlementCauses: state.settlementCauses,
      items: state.items,
      evidenceRefs: state.evidenceRefs,
      artifactRefs: state.artifactRefs,
      metadata: state.metadata,
    };
    const result = createRunResult(base);
    this.terminalResult = result;
    this.emitCommittedRunItems(state);
    this.emitTerminal(result);
    completeRunnerTrace(this.traceAssembler, result);
    this.publishCurrentState();
    return result;
  }

  private createSettlementCause(
    terminal: TerminalCandidate<TOutput>,
    cancellationRequest: import("../run/index.js").RunCancellationRequest | null,
    recordedAt: string,
  ): RunSettlementCauseRecord {
    const state = this.writer.getSnapshot();
    const ref = Object.freeze({
      run: state.run,
      id: this.id("run_settlement_cause"),
      revision: String(state.revision + 1),
    });
    const underlyingCandidates = terminal.status === "succeeded"
      ? Object.freeze([])
      : terminal.underlying ?? Object.freeze([]);
    const underlying = Object.freeze([...underlyingCandidates].slice(0, 8));
    const omittedUnderlyingCount = terminal.status === "succeeded"
      ? 0
      : (terminal.omittedUnderlyingCount ?? 0) +
        Math.max(0, underlyingCandidates.length - 8);
    if (terminal.status === "succeeded") {
      return Object.freeze({
        ref,
        kind: "completion" as const,
        code: "completion_accepted" as const,
        source: terminal.source ?? this.runSource("completion_acceptance", "run_completion_acceptance"),
        underlying,
        omittedUnderlyingCount,
        recordedAt,
      });
    }
    if (terminal.status === "cancelled") {
      const request = requireCancellation(cancellationRequest);
      return Object.freeze({
        ref,
        kind: "cancellation" as const,
        code: "runtime_cancelled" as const,
        cancellation: toRunCancellationSummary(request),
        source: Object.freeze({
          owner: "agent-runtime",
          kind: "cancellation_request",
          id: request.id,
          revision: null,
          run: state.run,
        }),
        underlying: Object.freeze([]),
        omittedUnderlyingCount: 0,
        recordedAt,
      });
    }
    return Object.freeze({
      ref,
      kind: "failure" as const,
      failure: terminal.failure,
      source: terminal.source ?? this.failureSource(terminal.failure),
      underlying,
      omittedUnderlyingCount,
      recordedAt,
    });
  }

  private appendTerminalFailures(
    terminal: TerminalCandidate<TOutput>,
    failures: readonly RunFailureCause[],
    relation: RunCausalLink["relation"],
  ): TerminalCandidate<TOutput> {
    if (failures.length === 0) return terminal;
    if (terminal.status === "succeeded") {
      return Object.freeze({
        status: "failed" as const,
        failure: failures[0]!,
        source: this.failureSource(failures[0]!),
        underlying: Object.freeze(failures.slice(1).map((failure) =>
          this.failureCausalLink(failure, relation)
        )),
      });
    }
    const links = [
      ...(terminal.underlying ?? []),
      ...failures.map((failure) => this.failureCausalLink(failure, relation)),
    ];
    return Object.freeze({
      ...terminal,
      underlying: Object.freeze(links.slice(0, 8)),
      omittedUnderlyingCount: (terminal.omittedUnderlyingCount ?? 0) + Math.max(0, links.length - 8),
    });
  }

  private failureCausalLink(
    failure: RunFailureCause,
    relation: RunCausalLink["relation"],
  ): RunCausalLink {
    return Object.freeze({ relation, source: this.failureSource(failure) });
  }

  private failureSource(failure: RunFailureCause, kind = "failure_fact"): RunCauseSourceRef {
    return Object.freeze({
      owner: failure.kind,
      kind,
      id: this.id("run_failure_fact"),
      revision: null,
      run: Object.freeze({ id: this.runId }),
    });
  }

  private runSource(kind: string, identityKind: "run_completion_acceptance"): RunCauseSourceRef {
    return Object.freeze({
      owner: "agent-runtime",
      kind,
      id: this.id(identityKind),
      revision: null,
      run: Object.freeze({ id: this.runId }),
    });
  }

  private failureFromError(error: unknown): Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }> {
    if (error instanceof VerificationExecutionError) {
      return {
        status: "failed",
        failure: createRunFailureCause("verification", error.failure),
      };
    }
    if (error instanceof ContextContractError) {
      return {
        status: "failed",
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
        failure: createRunFailureCause(error.failure.kind, error.failure.failure),
      } as Extract<TerminalCandidate<TOutput>, { readonly status: "failed" }>;
    }
    if (
      error instanceof ToolExposureCoordinationError ||
      error instanceof ToolExposureValidationError
    ) {
      return {
        status: "failed",
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
        failure: runtimeFailure(
          "runtime_operation_settlement_unconfirmed",
          error.message,
          { operation: error.operation, interruptionKind: error.interruptionKind },
        ),
      };
    }
    return {
      status: "failed",
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
      if (item.payload.kind === "controller_turn") {
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
      suspension: state.suspension,
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
                relation: Object.freeze({
                  id: relationId,
                }),
                relationKind: child.request.continuation !== null
                  ? "continuation" as const
                  : "delegation" as const,
                child: Object.freeze({ id: child.childRunId }),
                childRunRevision: snapshot.runRevision,
                childStatus: snapshot.status,
                suspension: snapshot.suspension,
                admittedControls: Object.freeze([
                  "steer" as const,
                  "resume" as const,
                  "cancel" as const,
                ]),
                resultTransfer: "pending" as const,
                steerable: true as const,
              })]
            : [];
        }),
      ),
      continuationTargets: Object.freeze(
        [...this.continuationRecords.values()]
          .filter(({ status }) => status === "available")
          .map(({ projection }) => projection),
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
    const code = runSettlementCauseCode(result.cause);
    const payload = {
      status: result.status,
      code,
      durationMs: Math.max(0, Date.parse(result.completedAt) - this.startedAtMs),
      itemCount: result.items.length,
      evidenceCount: result.evidenceRefs.length,
      artifactCount: result.artifactRefs.length,
      errorCodes: Object.freeze(result.cause.kind === "failure"
        ? [result.cause.failure.failure.code]
        : []),
    };
    if (result.status === "succeeded") this.emit("run.completed", { ...payload, status: "succeeded", code: null });
    else if (result.status === "cancelled") this.emit("run.cancelled", { ...payload, status: "cancelled", code });
    else this.emit("run.failed", { ...payload, status: "failed", code });
  }

  private async recordLifecycle(
    phase: "started" | "succeeded" | "failed" | "cancelled",
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
  settlement: RunSettlement<TOutput>,
  cause: RunSettlementCauseRecord,
  cancellationRequest: import("../run/index.js").RunCancellationRequest | null,
  completedAt: string,
  settlementCauses: readonly RunSettlementCauseRecord[],
): Readonly<Record<string, unknown>> {
  if (terminal.status === "succeeded") return Object.freeze({
    status: "succeeded",
    finalOutput: terminal.output,
    settlement,
    settlementCause: cause,
    settlementCauses,
    suspension: null,
    cancellationRequest: null,
    completedAt,
    pending: Object.freeze([]),
  });
  if (terminal.status === "cancelled") return Object.freeze({
    status: "cancelled",
    finalOutput: null,
    settlement,
    settlementCause: cause,
    settlementCauses,
    suspension: null,
    cancellationRequest: requireCancellation(cancellationRequest),
    completedAt,
    pending: Object.freeze([]),
  });
  return Object.freeze({
    status: "failed",
    finalOutput: null,
    settlement,
    settlementCause: cause,
    settlementCauses,
    suspension: null,
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

function failedToolAttemptResult(
  attempt: ToolCallAttempt,
  code: string,
  message: string,
  validation: import("@agent-anything/tools/validation").ToolInputValidationFailure | null,
  finishedAt: string,
): FailedToolResult {
  return Object.freeze({
    toolCall: attempt.ref,
    settlement: Object.freeze({
      owner: "tools",
      kind: validation === null ? "tool_call_attempt_rejection" : "tool_input_validation",
      id: attempt.ref.id,
      revision: attempt.selectedTool?.revision ?? null,
    }),
    status: "failed" as const,
    error: Object.freeze({
      code,
      message,
      ...(validation === null
        ? {}
        : { metadata: Object.freeze({
            issues: validation.issues,
            omittedIssueCount: validation.omittedIssueCount,
          }) }),
    }),
    startedAt: attempt.createdAt,
    finishedAt,
    metadata: Object.freeze({
      requestedName: attempt.requestedName,
      selectedToolRevision: attempt.selectedTool?.revision ?? null,
    }),
  });
}

function toolResultLowerRef(result: ToolResult): RunObservation["lowerRefs"][number] {
  if ("toolCallId" in result.toolCall) {
    return Object.freeze({
      owner: "tools",
      kind: "tool_result",
      id: result.toolCall.toolCallId,
      revision: result.toolCall.toolRevision.revision,
    });
  }
  return Object.freeze({
    owner: "tools",
    kind: "tool_result",
    id: result.toolCall.id,
    revision: null,
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
    case "descendant_progress":
      return false;
    case "descendant_result_transfer":
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

function rejectedDelegationResume(
  code: Extract<DelegationResumeReceipt, { readonly status: "rejected" }>["code"],
  relation: Extract<DelegationResumeReceipt, { readonly status: "rejected" }>["relation"],
  child: Extract<DelegationResumeReceipt, { readonly status: "rejected" }>["child"],
): DelegationResumeReceipt {
  return Object.freeze({ status: "rejected" as const, code, relation, child });
}

function delegationAuthoritySources(input: {
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly root: readonly DelegationAuthorityDimensionInput[];
  readonly parent: readonly DelegationAuthorityDimensionInput[];
  readonly restriction: readonly DelegationAuthorityDimensionInput[] | null;
  readonly currentPolicy: readonly DelegationAuthorityDimensionInput[];
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
    authoritySource("current_policy", "agent-runtime", "current_run_policy", input.parentRunId, input.currentPolicy, input.parentDeadlineAt),
    ...(input.restriction === null ? [] : [Object.freeze({
      role: "delegation_restriction" as const,
      ref: Object.freeze({
        owner: "product",
        kind: "delegation_authority_restriction",
        id: input.parentRunId,
        revision: preparationRevision,
      }),
      dimensions: input.restriction,
      deadlineAt: input.requestDeadlineAt,
    })]),
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
  readonly allocationRequest: DelegationLimits;
  readonly currentPolicy: DelegationLimits;
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
      role: "allocation_request" as const,
      ref: Object.freeze({
        owner: "product",
        kind: "delegation_limit_allocation_request",
        id: input.parentRunId,
        revision: preparationRevision,
      }),
      ceiling: input.allocationRequest,
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

function isContinuationNotResumableCode(
  code: Extract<DescendantExecutionOutcome, { readonly status: "rejected" }>["code"],
): boolean {
  return code === "delegation_resource_limit_exceeded" ||
    code === "descendant_run_depth_limit_exceeded" ||
    code === "descendant_run_total_limit_exceeded" ||
    code === "descendant_run_active_limit_exceeded" ||
    code === "descendant_run_resource_limit_exceeded" ||
    code === "descendant_run_deadline_exceeded";
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
  if (status === "suspended" || !isActiveStatus(status)) return status;
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
    case "model_call_rejected":
      return modelSettlement("invalid", {
        kind: payload.kind,
        code: payload.code,
        message: payload.message,
      });
    case "tool_rejected":
      return modelSettlement("invalid", {
        kind: payload.kind,
        code: payload.code,
        message: payload.message,
        issues: payload.toolResult.error.metadata?.issues ?? [],
        omittedIssueCount: payload.toolResult.error.metadata?.omittedIssueCount ?? 0,
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
    case "descendant_progress":
      return modelSettlement("succeeded", {
        kind: payload.kind,
        status: "suspended",
        childRunId: payload.progress.childRun.id,
        childRunRevision: payload.progress.childRunRevision,
        suspension: payload.progress.suspension,
        admittedControls: payload.progress.admittedControls,
        output: payload.output,
      });
    case "descendant_result_transfer":
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
      : terminal.failure.failure.code,
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
  return status === "initializing" || status === "running" || status === "waiting" || status === "suspended";
}

function controllerTurnSource(turn: ControllerTurnRef): RunCauseSourceRef {
  return Object.freeze({
    owner: "controller",
    kind: "controller_turn",
    id: turn.id,
    revision: String(turn.sequence),
    run: Object.freeze({ ...turn.run }),
  });
}

function boundedReason(value: string): string {
  const normalized = value.trim();
  return (normalized.length === 0 ? "Run progression requires explicit resume." : normalized).slice(0, 2_048);
}

function rejectedResume(
  code: Extract<RunResumeReceipt, { readonly status: "rejected" }>["code"],
  requestId: string,
  currentRunRevision: number,
): RunResumeReceipt {
  return Object.freeze({
    status: "rejected" as const,
    code,
    requestId,
    currentRunRevision,
  });
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

function sameDelegationMaterialRef(
  left: import("../delegation/index.js").DelegationContextMaterialRef,
  right: import("../delegation/index.js").DelegationContextMaterialRef,
): boolean {
  return left.owner === right.owner &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision;
}

function descendantDispatchEventPayload(
  dispatch: DescendantDispatchProvenance,
): import("@agent-anything/observability/events").RunDescendantDispatchRuntimeEventPayload {
  return Object.freeze({
    requestedDispatchForm: dispatch.requestedForm,
    controllerRequestId: dispatch.controllerRequestId,
    controllerTurnId: dispatch.controllerTurnId,
    candidateIndex: dispatch.candidateIndex,
    siblingIndex: dispatch.siblingIndex,
    siblingCount: dispatch.siblingCount,
  });
}

function descendantAllocationCeiling(
  available: import("./RunTreeResourceAccount.js").RunTreeResourceAmounts,
  dispatch: DescendantDispatchProvenance,
): import("./RunTreeResourceAccount.js").RunTreeResourceAmounts {
  const remainingSiblings = dispatch.requestedForm === "concurrent_sibling"
    ? dispatch.siblingCount - dispatch.siblingIndex
    : 1;
  const share = (value: number): number => Math.floor(value / remainingSiblings);
  const ceiling = Object.freeze({
    controllerTurns: share(available.controllerTurns),
    actions: share(available.actions),
    modelInputTokens: share(available.modelInputTokens),
    modelOutputTokens: share(available.modelOutputTokens),
    costUnits: share(available.costUnits),
    contextBytes: share(available.contextBytes),
    resultBytes: share(available.resultBytes),
  });
  if (Object.values(ceiling).some((value) => value < 1)) {
    throw new TypeError("Concurrent descendant allocation cannot satisfy a positive grant.");
  }
  return ceiling;
}
