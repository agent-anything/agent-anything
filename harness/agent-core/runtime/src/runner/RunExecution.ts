import type { Agent } from "@agent-anything/agent-core/agent";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import { toolRevisionKey } from "@agent-anything/tools/identity";
import type { ToolResultPresenter } from "./ToolResultPresenter.js";
import { presentToolResultReferences } from "./ToolResultPresenter.js";
import { deriveRunStatusAfterPendingChange } from "./RunPendingStatus.js";
import { RunExecutionFlow } from "./RunExecutionFlow.js";
import { admitObservedToolCall } from "./ToolCallAdmissionFlow.js";
import { RunInputNotifications } from "./RunInputNotifications.js";
import { sameRunCommitValue } from "./RunCommitValue.js";
import { RUN_CONTROL_EXECUTION_FLOW, RUN_SUSPENSION_WAIT_FLOW } from "./RunControlExecutionFlow.js";
import { DESCENDANT_TRANSFER_EXECUTION_FLOW } from "./DescendantTransferExecutionFlow.js";
import { createExecutionFlowDefinition, ExecutionFlowInvocation, ExecutionFlowPath, type ExecutionFlowContext, type ExecutionFlowOccurrenceRef, type ExecutionFlowStep } from "@agent-anything/observability/execution-flow";
import { CONTROLLER_EXECUTION_FLOW, recordControllerInput, recordControllerPreparation } from "./ControllerExecutionFlow.js";
import { RUN_CALL_EXECUTION_FLOW, OPERATION_EXECUTION_FLOW } from "./RunCallExecutionFlow.js";
import { snapshotRunSuspendRequestInput, type RunSuspendRequestInput, type RunSuspendReceipt } from "../run/RunSuspension.js";
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
import { snapshotResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import { snapshotOperationCorrelation, snapshotOperationInvocationRef, operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type {
  OperationCorrelation,
  OperationInvocationContext,
  OperationInvocationRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import {
  createOperationResult,
  rejectOperationResultOutput,
  type OperationFailure,
  type OperationResult,
} from "@agent-anything/operation-catalog/result";
import { CompositeExecution } from "@agent-anything/operation-composition/execution";
import { createCompositeResultSummary, readCompositeResultSummary, type CompositeResult } from "@agent-anything/operation-composition/result";
import {
  ActionExecutionCoordinator,
  type ActionApprovalResolutionPort,
  type ActionExecutionObserver,
  type ActionExecutionResult,
} from "@agent-anything/action-execution/enforcement";
import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import { readOperationLimitFailureDetail } from "@agent-anything/operation-catalog/result";
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
  snapshotModelToolResultContent,
  type ModelCallSettlementKind,
  type ModelJsonValue,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolResult,
} from "@agent-anything/model-interaction";
import {
  materializeToolCall,
  type ToolCallAdmission,
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
  snapshotControllerFeedback,
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
import { snapshotRetryEvent, RetryInvocationInvalidatedError, type RetryEventSink } from "../retry/index.js";
import { RunDecisionBasis } from "./RunDecisionBasis.js";
import { RunRetryWaitScope } from "./RunRetryWaitScope.js";
import { RunTranscriptRecorder } from "../transcript/index.js";
import {
  createRunResult,
  createRunFailureCause,
  createRunObservation,
  projectPendingRunSubject,
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
import { publishRunTransition } from "./RunObserver.js";
import { publishRunExecutionObservation } from "./RunExecutionObserver.js";
import type { ResolvedRunConfig, RunConfig } from "./RunConfig.js";
import type { ResolvedRunnerDependencies } from "./RunnerDependencies.js";
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
  classifyApprovalSettlement,
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
import { RunCommitError, type RunCommit, type RunControlCheckpoint } from "./RunCommitPort.js";
import { ControllerCheckpointError, type ControllerCheckpointPort } from "../controller/ControllerCheckpoint.js";
import { RetryCheckpointError } from "../retry/RetryCheckpoint.js";
import { RunTreeCommitWriter } from "./RunTreeCommitWriter.js";
import {retainControllerCheckpoint, snapshotRunCommit} from "./RunCommitSnapshot.js";
import { retainRunConfiguration } from "./RunConfigurationCheckpoint.js";
import { projectRunTreeTerminal, RunTreeExecution } from "./RunTreeExecution.js";
import { retainControllerOperation, retainDecisionCallProgress, restoreControllerOperation, validateDecisionCheckpoint } from "./RunDecisionCheckpoint.js";
import { RunRecoveryError } from "./RunRecovery.js";
import { ActionRecordCommitError, ActionRecoveryError, type ActionExecutionRequest } from "@agent-anything/action-execution/enforcement";
import { CompositeCommitError, CompositeRecoveryError } from "@agent-anything/operation-composition/execution";

import { createCurrentRunContextAdmissionProfile, createCurrentRunContextContributions, createDelegationSelectedContextAdmissionProfile, createDelegationSelectedContextContribution, createObservationContextAdmissionProfile, createObservationContextContribution, createTaskContextAdmissionProfile, createTaskContextContribution } from "../context-contribution/index.js";
import type {
  DescendantDispatchProvenance,
  DescendantRunReservationFailureCode,
  RunTreeExecutionSnapshot,
} from "./RunTreeExecution.js";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";

function assertExecutionCommitConfirmed(error: unknown): void {
  if (error instanceof OperationCommitError) throw error;
  if (error instanceof RunCommitError || error instanceof RunRecoveryError || error instanceof ControllerCheckpointError || error instanceof RetryCheckpointError || error instanceof ActionRecordCommitError || error instanceof ActionRecoveryError || error instanceof CompositeCommitError || error instanceof CompositeRecoveryError) throw error;
}

function retryBookkeepingOwner(state: RunState<unknown>, previous: RunState<unknown> | null): string | null {
  const changes = state.items.slice(previous?.items.length ?? 0);
  if (changes.length === 0) return null;
  const first = changes[0]!.payload;
  if ((first.kind !== "pending_transition" && first.kind !== "retry_transition") || first.pending.kind !== "retry_wait") return null;
  const id = first.pending.invocationId;
  return changes.every(({payload}) => (payload.kind === "pending_transition" || payload.kind === "retry_transition") &&
    payload.pending.kind === "retry_wait" && payload.pending.invocationId === id) ? id : null;
}

export interface RuntimeDescendantRunAdmissionInput {
  readonly executionFlow?: ExecutionFlowContext;
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
      readonly getTerminalFlowOccurrence: () => ExecutionFlowOccurrenceRef | null;
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
      readonly cancelBeforeLaunch: () => RuntimeDescendantRunLaunchResult | Promise<RuntimeDescendantRunLaunchResult>;
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
) => RuntimeDescendantRunAdmissionResult | Promise<RuntimeDescendantRunAdmissionResult>;

type TerminalCandidate<TOutput> = import("./RunFinalizationCheckpoint.js").RunTerminalCandidate<TOutput>;

interface CandidateBasis<TOutput> {
  readonly turn: ControllerTurnRef;
  readonly runRevision: number;
  readonly activeAgent: Agent<TOutput>;
  readonly instructionBinding: AgentInstructionBinding;
  readonly projection: ContextProjection;
  readonly admissions: ReadonlyMap<ProgressionCandidate, ToolCallAdmission>;
}

interface OperationExecutionOutcome {
  readonly result: OperationResult;
  readonly toolResult: ToolResult | null;
}

interface CandidateProcessingOutcome<TOutput> {
  readonly dispatchStop: "action_limit" | "handoff" | "steering" | "cancellation" | null;
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

type DescendantPreparationOutcome = DescendantExecutionOutcome | AdmittedDescendantExecution |
  {readonly status: "restored"; readonly outcome: Promise<DescendantExecutionOutcome>};

export interface RestoredDescendantRoute {
  readonly relation: DescendantRunRelation;
  readonly request: DelegationRequest;
  readonly dispatch: DescendantDispatchProvenance;
  readonly action: RuntimeRunAction;
  readonly handle: RunHandle;
  readonly getTerminalFlowOccurrence: () => ExecutionFlowOccurrenceRef | null;
  readonly resourceSettlement: Promise<RunTreeResourceSettlement>;
  readonly modelInteractionSeed: readonly ModelMessage[];
}

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
  readonly getTerminalFlowOccurrence: () => ExecutionFlowOccurrenceRef | null;
  readonly action: RuntimeRunAction;
  readonly composition: NonNullable<ResolvedRunnerDependencies["operations"]["delegation"]>;
  readonly pending: PendingRunSubject;
  readonly resourceSettlement: Promise<RunTreeResourceSettlement>;
  readonly continuationModelInteractionSeed: readonly ModelMessage[];
  readonly initialBoundary: Promise<DescendantExecutionOutcome>;
  resolveInitialBoundary(outcome: DescendantExecutionOutcome): void;
  rejectInitialBoundary(error: unknown): void;
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
  private readonly restoredDescendants: RestoredDescendantRoute[] = [];
  private readonly restoredDescendantOutcomes = new Map<string, Promise<DescendantExecutionOutcome>>();

  restoreDescendant(route: RestoredDescendantRoute): void {
    if (!this.restored || route.relation.parent.id !== this.runId ||
        this.restoredDescendants.some(value => value.relation.ref.id === route.relation.ref.id)) {
      throw new TypeError("Invalid restored descendant route.");
    }
    this.restoredDescendants.push(route);
  }
  getTerminalFlowOccurrence(): ExecutionFlowOccurrenceRef | null {
    return this.terminalResult === null ? null : this.flow.current?.ref ?? null;
  }

  private readonly flow: RunExecutionFlow;
  private readonly actionFlows = new Map<string, ExecutionFlowPath>();
  private readonly executionFailureSettlements = new Map<string, "failure" | "success" | "unchanged" | null>();
  private readonly operationFlows = new Map<string, ExecutionFlowPath>();
  private readonly operationCalls = new Map<string, ToolCall>();
  private readonly resultDeliveries = new Map<string, RunControlCheckpoint["resultDeliveries"][number]>();
  private resultDeliveryTail: Promise<void> = Promise.resolve();
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
  private settling = false;
  private suspendedWaiter: {
    readonly suspension: RunSuspension;
    readonly resolve: () => void;
    readonly resumed: Promise<void>;
  } | null = null;
  private emittedItemCount = 0;
  private nextInteractionRequest = 1;
  private readonly identitySequences = new Map<
    Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"],
    number
  >();
  private readonly childHandles = new Map<string, ManagedActiveDescendant>();
  private readonly descendantSettlementWaits = new Set<Promise<void>>();
  private readonly settledDelegations = new Map<string, {
    readonly result: DelegationResult;
  }>();
  private readonly continuationRecords = new Map<string, RuntimeContinuationRecord>();
  private readonly descendantTransfers = new Map<string, RunControlCheckpoint["descendantTransfers"][number]>();
  private readonly interactionActions = new Map<string, InteractionActionContext>();
  private readonly deliveredInteractions = new Set<string>();
  private readonly interactionSettlements: QueuedInteractionSettlement[] = [];
  private readonly modelCallSettlementWaits = new Set<Promise<void>>();
  private readonly deferredInteractionActions = new Map<string, RuntimeRunAction>();
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
  private readonly decisionBasis = new RunDecisionBasis();
  private readonly inputNotifications: RunInputNotifications;
  private pendingCompletionCall: {
    readonly call: ModelToolCall;
    readonly turn: ControllerTurnRef;
    stateResult: ModelToolResult | null;
  } | null = null;
  private acceptedDecision: RunControlCheckpoint["decision"] = null;
  private controllerInvocation: RunControlCheckpoint["controllerInvocation"] = null;
  private readonly controllerCheckpoints = new Map<string, unknown>();
  private completionNotification: RunControlCheckpoint["completionNotification"] = null;
  private readonly retainedRetryEvents: import("../retry/index.js").RetryEvent[] = [];
  private stagedAgentBinding: {agent: Agent<TOutput>; binding: AgentInstructionBinding} | null = null;
  private persistenceStarted = false;
  private initialized = false;
  private finalizationCheckpoint: RunControlCheckpoint["finalization"] = null;
  private readonly lifecycleRecordings = new Map<string, RunControlCheckpoint["lifecycleRecordings"][number]>();
  private continuingDecision = false;
  private recoveringController = false;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: unknown) => void;
  private readonly started = new Promise<void>((resolve, reject) => {this.resolveStarted = resolve; this.rejectStarted = reject;});
  private readonly operationPreparations = new Map<string, RunControlCheckpoint["operations"][number]>();
  private readonly operationResults = new Map<string, OperationResult>();
  private readonly operationExecutions = new Map<string, RunControlCheckpoint["operationExecutions"][number][1]>();
  private readonly retryScopes = new Map<string, RunRetryWaitScope>();
  private readonly toolExposure: RunToolExposureCoordinator;
  private readonly transcript: RunTranscriptRecorder;
  private accountedResourceItemCount = 0;
  private contextPayloadBytes: number;
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
    private readonly initialContextBytes: number,
    private readonly initialRunTree: RunTreeExecution,
    private readonly onUpdate: (update: RunExecutionUpdate<TOutput>) => void,
    executionFlow?: ExecutionFlowContext,
    private readonly treeCommits?: RunTreeCommitWriter,
    private readonly restored?: RunCommit,
  ) {
    void this.started.catch(() => {});
    this.flow = new RunExecutionFlow(executionFlow ?? dependencies.executionFlow ?? {}, runId);
    this.startedAt = startedAt;
    this.contextPayloadBytes = restored?.control.contextPayloadBytes ?? initialContextBytes;
    this.inputNotifications = restored ? RunInputNotifications.restore(runId, restored.control.inputNotifications) : new RunInputNotifications();
    this.startedAtMs = Date.parse(this.startedAt);
    this.activeAgent = agent;
    this.activeInstructionBinding = restored?.control.instructionBinding ?? createAgentInstructionBinding({
      run: Object.freeze({ id: runId }),
      agent,
      effectiveFromRunRevision: 0,
      supersedes: null,
    });
    this.instructionRevisionByAgentRevision.set(
      agentRevisionKey(agent),
      agent.instructions.ref.revision,
    );
    this.transcript = new RunTranscriptRecorder(dependencies.runTranscriptPort ?? null, dependencies.runTranscriptObserver);
    const activation = restored ? globalThis.crypto.randomUUID() : null;
    const observationIdentity: ResolvedRunnerDependencies["createId"] = value => {
      const id = dependencies.createId(value);
      return activation === null ? id : `${id}:activation:${activation}`;
    };
    this.traceAssembler = createRunnerTraceAssembler({
      runId,
      taskId: input.task.id,
      lineage,
      observers: runTraceObservers,
      createId: observationIdentity,
    });
    this.eventStream = new RuntimeEventStream({
      runId,
      taskId: input.task.id,
      lineage,
      now: dependencies.now,
      createEventId: ({ sequence }) => observationIdentity({
        kind: "runtime_event",
        runId,
        sequence,
      }),
      publishers: Object.freeze([
        ...runtimeEventPublishers,
        ...(this.traceAssembler === null ? [] : [this.traceAssembler]),
      ]),
    });
    const initial = restored ? structuredClone(restored.state) as RunState<TOutput> : createInitialRunState({
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
      (state, previous, owner) => this.onStateCommitted(state, previous, owner),
      (state, previous, accept, owner) => this.persistRunCommit(state, previous, accept, owner),
    );
    this.lastAuthorityPermission = initial.permission;
    if (!restored && !this.treeCommits) this.recordTreeResources({
      contextBytes: Object.freeze({
        status: "measured" as const,
        value: initialContextBytes,
      }),
    });

    const approvalProtocol = createApprovalInteractionProtocol({
      validateDecision: (subject, submission, request) =>
        this.validateApprovalDecision(subject, submission, request.id),
      applyDecision: async (subject, resolution, request) =>
        (await this.applyApprovalDecision(subject, resolution, request.id)),
    }) as unknown as CapturedInteractionProtocol;
    const interactionDependencies: ConstructorParameters<typeof RunInteractionCoordinator>[0] = {
      runId,
      registry: dependencies.interactions,
      localProtocols: Object.freeze([approvalProtocol]),
      now: dependencies.now,
      createId: (kind, sequence) => dependencies.createId({ kind, runId, sequence }),
      onOpened: async (pending, parentRunAction) => (await this.openPendingInteraction(pending, parentRunAction)),
      onSettled: (pending, terminal, settlement) =>
        this.queueInteractionSettlement(pending, terminal, settlement),
      onChanged: async () => { await this.writer.commitState(() => ({})); },
      onFailure: error => this.writer.fail(error),
    };
    this.interactions = restored ? RunInteractionCoordinator.restore(interactionDependencies, restored.control.interactions)
      : new RunInteractionCoordinator(interactionDependencies);
    if (restored) {
      const control = restored.control;
      if (restored.state.run.id !== runId || restored.state.startedAt !== startedAt || restored.state.deadlineAt !== deadlineAt) {
        throw new TypeError("Restored Run identity or original deadline is inconsistent.");
      }
      if (control.decision) validateDecisionCheckpoint(control.decision, restored.state);
      for (const [kind, sequence] of control.identitySequences) this.identitySequences.set(kind as Parameters<ResolvedRunnerDependencies["createId"]>[0]["kind"], sequence);
      this.nextInteractionRequest = control.nextInteractionRequest;
      this.instructionRevisionByAgentRevision.clear();
      for (const entry of control.instructionRevisions) this.instructionRevisionByAgentRevision.set(...entry);
      for (const entry of control.operationCalls) this.operationCalls.set(...entry);
      for (const delivery of control.resultDeliveries) this.resultDeliveries.set(delivery.input.presentation.modelCallRef.id, delivery);
      for (const entry of control.operations) this.operationPreparations.set(entry.binding.invocation.id, entry);
      for (const result of control.operationResults) this.operationResults.set(result.ref.invocation.id, result);
      for (const entry of control.operationExecutions) this.operationExecutions.set(...entry);
      for (const entry of control.executionFailureSettlements) this.executionFailureSettlements.set(...entry);
      for (const entry of control.steering.ledger) this.steeringLedger.set(entry.command.commandId, entry);
      this.steeringQueue.push(...control.steering.pending);
      this.steeringEpoch = control.steering.epoch;
      for (const action of control.deferredInteractionActions) this.deferredInteractionActions.set(action.ref.id, action);
      for (const entry of control.interactionActions) this.interactionActions.set(entry.requestId, {action: entry.action, toolCall: entry.toolCall});
      for (const id of control.deliveredInteractions) this.deliveredInteractions.add(id);
      for (const entry of control.descendantTransfers) {
        this.descendantTransfers.set(entry.childRunId, entry);
        if (entry.result) this.settledDelegations.set(entry.result.ref.id, {result: entry.result});
      }
      for (const entry of control.descendantContinuations) this.continuationRecords.set(entry.correlation.ref.id, {...entry});
      this.acceptedDecision = control.decision;
      this.controllerInvocation = control.controllerInvocation;
      for (const [key, value] of control.controllerCheckpoints) this.controllerCheckpoints.set(key, retainControllerCheckpoint(value));
      this.completionNotification = control.completionNotification;
      this.pendingCompletionCall = control.pendingCompletion === null ? null : {...control.pendingCompletion};
      this.retainedRetryEvents.push(...control.retryEvents);
      this.persistenceStarted = true;
      this.initialized = control.initialized;
      this.finalizationCheckpoint = control.finalization;
      for (const record of control.lifecycleRecordings) this.lifecycleRecordings.set(record.phase, record);
      if (control.finalization) {
        const bound = (dependencies.resourceFinalizers ?? []).map(value => value.binding ?? null);
        if (JSON.stringify(bound) !== JSON.stringify(control.finalization.finalizers.map(value => value.binding))) {
          throw new RunRecoveryError(runId, "resource_finalizer_binding_unavailable", runId);
        }
      }
      this.continuingDecision = control.decision?.status === "active";
      this.recoveringController = control.controllerInvocation?.status === "pending";
      if (this.recoveringController) {
        const id = control.controllerInvocation!.turn.id;
        const revision = control.decisionBases.find(([key]) => key === id)?.[1];
        if (revision === undefined) throw new RunRecoveryError(runId, "controller_basis_unavailable", id);
        this.decisionBasis.capture(id, revision);
      } else if (control.completionNotification) {
        const id = control.completionNotification.turn.id;
        const revision = control.decisionBases.find(([key]) => key === id)?.[1];
        if (revision !== undefined) this.decisionBasis.capture(id, revision);
      }
      this.emittedItemCount = initial.items.length;
      this.accountedResourceItemCount = initial.items.length;
      this.runStartedEventEmitted = this.initialized;
      const issue = this.interactions.getRecoveryIssues()[0];
      if (issue) throw new RunRecoveryError(runId, issue.code, issue.request.id);
      if (control.controllerInvocation?.status === "pending" && !this.dependencies.controller.recover) {
        throw new RunRecoveryError(runId, "controller_invocation_requires_reconciliation", control.controllerInvocation.turn.id);
      }
      if (control.completionNotification?.outcome.status === "pending" && !this.dependencies.controller.recoverBeforeCompletion) {
        throw new RunRecoveryError(runId, "completion_notification_unconfirmed", control.completionNotification.turn.id);
      }
    }
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
      getDecisionRevision: (id) => this.decisionBasis.revision(id, this.writer.getSnapshot().revision),
      getRunTreeSnapshot: () => this.runTree.getSnapshot(),
    });

    this.interruptionCoordinator = new RunInterruptionCoordinator({
      cancellation: config.cancellation.context,
      operationSettlementTimeoutMs: config.cancellationLimits.operationSettlementTimeoutMs,
      now: dependencies.now,
      onCancellationObserved: async (request) => (await this.enterCancelling(request)),
    });

    const actionComposition = dependencies.operations.actionExecution;
    this.actionExecution = actionComposition === undefined
      ? null
      : new ActionExecutionCoordinator({
          ...actionComposition,
          permission: createActionPermissionAssessmentPort({
            now: dependencies.now,
            consumeCoverage: async (coverageId) => (await this.consumeApprovalCoverage(coverageId)),
          }),
          approval: this.createActionApprovalPort(),
          observer: composeActionExecutionObservers(
            actionComposition.observer,
            actionExecutionObserver,
          ),
          now: dependencies.now,
        });
  }

  private get runTree(): RunTreeExecution { return this.treeCommits?.tree ?? this.initialRunTree; }

  prepareAdmission(tree: RunTreeExecution): RunCommit {
    if (this.persistenceStarted) throw new TypeError("Run admission is already committed.");
    const state = this.writer.getSnapshot();
    tree.markStarted(this.runId, this.startedAt);
    tree.recordResources(this.runId, {contextBytes: {status: "measured", value: this.initialContextBytes}});
    return this.createRunCommit(state, null);
  }

  acceptAdmission(): void { this.persistenceStarted = true; }

  async confirmCancellation(): Promise<void> {
    await this.started;
    await this.interruptionCoordinator.flush();
  }

  private async changeTree<T>(change: (tree: RunTreeExecution) => T): Promise<T> {
    if (!this.treeCommits) return change(this.runTree);
    return this.treeCommits.transaction(({tree}) => ({runs: [], value: change(tree)}));
  }

  async submitInteraction(input: InteractionSubmissionInput): Promise<InteractionSubmissionOutcome> {
    const local = await this.interactions.submit(input);
    if (local.status !== "rejected" || local.code !== "interaction_not_pending") {
      return local;
    }
    for (const { handle } of this.childHandles.values()) {
      const outcome = await handle.submitInteraction(input);
      if (outcome.status !== "rejected" || outcome.code !== "interaction_not_pending") {
        return outcome;
      }
    }
    return local;
  }

  async submitResume(input: RunResumeRequestInput): Promise<RunResumeReceipt> {
    const flow = new ExecutionFlowPath(RUN_CONTROL_EXECUTION_FLOW, {...this.flow.context, relationship:"spawn"}, this.runId, []);
    const before = this.writer.getSnapshot();
    flow.advance("receive", {control:"resume",status:before.status,runRevision:before.revision});
    const admission = flow.advance("admit");
    try {
      const receipt = (await this.applyResume(input));
      admission.check("control_admission", receipt.status === "accepted" ? "passed" : "not_satisfied", {status:receipt.status,code:receipt.status === "rejected" ? receipt.code : null});
      flow.advance("receipt", {runStatus:this.writer.getSnapshot().status,runRevision:this.writer.getSnapshot().revision});
      return receipt;
    } finally {flow.close("returned");}
  }

  private async applyResume(input: RunResumeRequestInput): Promise<RunResumeReceipt> {
    const waiter = this.suspendedWaiter;
    const receipt = await this.writer.transaction<RunResumeReceipt>(current => {
    const reject = (code: Parameters<typeof rejectedResume>[0], id: string) => ({value: rejectedResume(code, id, current.revision)});
    const requestId = typeof input?.id === "string" ? input.id : "";
    let candidate: RunResumeRequestInput;
    try {
      candidate = snapshotRunResumeRequestInput(input);
    } catch {
      return reject("resume_invalid", requestId);
    }
    if (current.status === "cancelling") {
      return reject("run_cancelling", candidate.id);
    }
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      return reject("run_settled", candidate.id);
    }
    if (this.settling) return reject("run_settling", candidate.id);
    if (current.status !== "suspended" || this.suspendedWaiter === null) {
      return reject("run_not_suspended", candidate.id);
    }
    if (candidate.expectedRunRevision !== current.revision) {
      return reject("run_revision_stale", candidate.id);
    }
    if (!sameRunSuspensionRef(candidate.suspension, current.suspension.ref)) {
      return reject("suspension_stale", candidate.id);
    }
    const request: RunResumeRequest = Object.freeze({
      ...candidate,
      run: current.run,
      requestedAt: this.now(),
    });
    return {payloads: [{
      kind: "suspension_transition",
      transition: "resumed",
      suspension: current.suspension,
      resume: request,
    }], patch: {
      status: this.statusAfterPendingChange({ ...current, status: "running", suspension: null } as RunState<TOutput>, current.pending),
      suspension: null,
    }, value: {status: "accepted", request, currentRunRevision: current.revision + 1}};
    });
    if (receipt.status === "rejected") return receipt;
    this.suspendedWaiter = null;
    waiter?.resolve();
    return receipt;
  }

  async submitSuspend(input: RunSuspendRequestInput): Promise<RunSuspendReceipt> {
    const flow = new ExecutionFlowPath(RUN_CONTROL_EXECUTION_FLOW, {...this.flow.context, relationship:"spawn"}, this.runId, []);
    const before = this.writer.getSnapshot();
    flow.advance("receive", {control:"suspend",status:before.status,runRevision:before.revision});
    const admission = flow.advance("admit");
    try {
      const receipt = (await this.applySuspend(input));
      admission.check("control_admission", receipt.status === "accepted" ? "passed" : "not_satisfied", {status:receipt.status,code:receipt.status === "rejected" ? receipt.code : null});
      flow.advance("receipt", {runStatus:this.writer.getSnapshot().status,runRevision:this.writer.getSnapshot().revision});
      return receipt;
    } finally {flow.close("returned");}
  }

  private async applySuspend(input: RunSuspendRequestInput): Promise<RunSuspendReceipt> {
    return this.writer.transaction<RunSuspendReceipt>(current => {
    const reject = (code: Extract<RunSuspendReceipt, {status: "rejected"}>["code"]): {value: RunSuspendReceipt} => ({value: {
      status: "rejected", code, requestId: typeof input?.id === "string" ? input.id : "", currentRunRevision: current.revision,
    }});
    let request: RunSuspendRequestInput;
    try { request = snapshotRunSuspendRequestInput(input); } catch { return reject("suspend_invalid"); }
    if (this.terminalResult !== null || ["completed", "failed", "cancelled"].includes(current.status)) return reject("run_settled");
    if (this.config.cancellation.context.request !== null) return reject("run_cancelling");
    if (this.settling) return reject("run_settling");
    if (current.status === "suspended") return reject("run_already_suspended");
    if (current.status === "initializing") return reject("run_not_started");
    if (request.expectedRunRevision !== current.revision) return reject("run_revision_stale");
    const nextRevision = current.revision + 1;
    const suspension: RunSuspension = Object.freeze({
      ref: Object.freeze({
        run: current.run,
        id: this.id("run_suspension"),
        revision: String(nextRevision),
      }),
      code: "run_suspension_requested",
      source: Object.freeze({owner: request.origin, kind: "suspend_request", id: request.id, revision: null, run: current.run}),
      reason: request.reason,
      runRevision: nextRevision,
      suspendedAt: this.now(),
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.suspendedWaiter = Object.freeze({ suspension, resolve: resume, resumed });
    return {payloads: [{
      kind: "suspension_transition",
      transition: "suspended",
      suspension,
      resume: null,
    }], patch: {
      status: "suspended" as const,
      suspension,
    }, value: {status: "accepted", suspension, currentRunRevision: nextRevision}};
    });
  }

  private async awaitSuspension(): Promise<void> {
    const waiter = this.suspendedWaiter;
    if (waiter === null) return;
    const flow = new ExecutionFlowPath(RUN_SUSPENSION_WAIT_FLOW, this.flow.context, this.runId, []);
    flow.advance("wait", {suspensionId:waiter.suspension.ref.id,suspensionRevision:waiter.suspension.ref.revision});
    const deadlineAtMs = Date.parse(this.writer.getSnapshot().deadlineAt);
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlineReached = new Promise<void>((resolve) => {
      const arm = () => {
        const remaining = deadlineAtMs - Date.parse(this.now());
        if (remaining <= 0) resolve();
        else deadlineTimer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    });
    const signal = this.config.cancellation.context.signal;
    let onAbort!: () => void;
    const cancelled = new Promise<void>(resolve => { onAbort = resolve; });
    signal.addEventListener("abort", onAbort, {once: true});
    if (signal.aborted) onAbort();
    try { await Promise.race([waiter.resumed, deadlineReached, cancelled]); }
    finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer); signal.removeEventListener("abort", onAbort);
      const release = signal.aborted ? "cancellation" : this.suspendedWaiter !== waiter ? "accepted_resume" : "deadline";
      flow.advance("released", {status:this.writer.getSnapshot().status,runRevision:this.writer.getSnapshot().revision}).check("release_source","passed",{release});
      flow.close(release === "accepted_resume" ? "returned" : "interrupted");
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

  async submitSteering(input: RunSteeringInput): Promise<RunSteeringSubmissionReceipt> {
    const receipt = await this.writer.transaction(state => {
      const value = this.acceptSteering(input, state);
      return value.status === "accepted_for_application"
        ? {value, payloads: [], patch: {}}
        : {value};
    });
    if (receipt.status === "accepted_for_application") await this.interactions.invalidateAll("run_steering_pending");
    return receipt;
  }

  private acceptSteering(input: RunSteeringInput, state: RunState<TOutput>): RunSteeringSubmissionReceipt {
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
    if (this.settling) return this.rejectSteering(candidate.commandId, "run_settling");
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
      acceptedRunRevision: state.revision + 1,
    });
    this.steeringLedger.set(candidate.commandId, Object.freeze({
      fingerprint,
      command,
    }));
    this.steeringQueue.push(command);
    this.steeringEpoch += 1;
    return Object.freeze({
      status: "accepted_for_application" as const,
      command,
    });
  }

  async submitDescendantSteering(input: DelegationSteeringRoute): Promise<DelegationSteeringReceipt> {
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
        submission: await direct.handle.steer(route.steering),
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
      const nested = await handle.steerDescendant(route);
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

  async submitDescendantResume(input: DelegationResumeRoute): Promise<DelegationResumeReceipt> {
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
        resume: await direct.handle.resume(route.resume),
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
      const nested = await handle.resumeDescendant(route);
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
    publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "run_input", runId: this.runId, occurredAt: this.startedAt, input: this.input,
      configuration: {limits: this.config.limits, cancellationLimits: this.config.cancellationLimits, audit: this.config.audit, telemetry: this.config.telemetry}});
    const configurationRef = {owner: "runtime", kind: "contribution", id: `${this.runId}:configuration`, revision: "1"};
    const initialization = this.flow.enter("initialize", {agentId: this.activeAgent.id, revision: this.writer.getSnapshot().revision}, [
      {owner: "runtime", kind: "contribution", id: `${this.runId}:input`, revision: "1"}, configurationRef,
    ]);
    try {
      if (!this.persistenceStarted) await this.persistRunCommit(this.writer.getSnapshot(), null);
      this.interruptionCoordinator.start();
      this.resolveStarted();
      await this.interruptionCoordinator.flush();
      if (this.restored) {
        await this.interactions.activateRestored();
        for (const route of this.restoredDescendants) {
          const managed = await this.attachDescendant(route, true);
          this.restoredDescendantOutcomes.set(route.action.ref.id, managed.initialBoundary);
        }
        this.publishCurrentState();
      }
      await this.deliverToolResults();
      if (this.finalizationCheckpoint) return await this.settle(this.finalizationCheckpoint.candidate as TerminalCandidate<TOutput>);
      if (!this.initialized) {
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
      (await this.writer.commitState((current) => {
        this.initialized = true;
        return Object.freeze({
        status: current.status === "cancelling" ? "cancelling" as const : "running" as const,
        context: this.applyContextContributions(
          initialContext,
          Object.freeze([taskContribution]),
          createTaskContextAdmissionProfile(),
          "run_initialization",
          this.runId,
        ),
      }); }));
      this.emit("run.started", {
        status: "running",
        activeAgentId: this.activeAgent.id,
        activeAgentRevision: this.activeAgent.revision,
        instructionBindingId: this.activeInstructionBinding.ref.id,
        instructionBindingRevision: this.activeInstructionBinding.ref.revision,
      }, this.startedAt);
      this.runStartedEventEmitted = true;
      initialization.check("initial_context", "passed", {contextId: this.writer.getSnapshot().context.ref.id});
      initialization.output({owner:"context",kind:"context",id:this.writer.getSnapshot().context.ref.id,revision:String(this.writer.getSnapshot().context.ref.version)});
      this.emitCommittedContextTransition(this.writer.getSnapshot().context);
      this.emitCommittedRunItems(this.writer.getSnapshot());
      }
      const startFailures = await this.recordLifecycle("started");
      initialization.check("required_start_records", startFailures.length ? "error" : "passed", {failureCount: startFailures.length});
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
        await this.interruptionCoordinator.flush();
        const controls = this.flow.enter("controls", {status: this.writer.getSnapshot().status, revision: this.writer.getSnapshot().revision});
        await this.awaitSuspension();
        (await this.drainInteractionSettlements());
        controls.check("cancellation", this.config.cancellation.context.request !== null ? "not_satisfied" : "passed");
        if (this.config.cancellation.context.request !== null) {
          for (const check of ["resource_account", "deadline", "numeric_limits"]) controls.check(check, "not_evaluated", {reason: "cancellation_requested"});
          return await this.settle({ status: "cancelled" });
        }
        if (this.resourceFailure !== null) {
          controls.check("resource_account", "not_satisfied", {dimension: this.resourceFailure.dimension});
          for (const check of ["deadline", "numeric_limits"]) controls.check(check, "not_evaluated", {reason: "resource_failure"});
          return await this.settleResourceFailure(this.resourceFailure);
        }
        controls.check("resource_account", "passed", {failurePresent: false});
        (await this.drainSteering("apply"));
        const deadline = evaluateRunDeadline({
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          now: this.now(),
        });
        controls.check("deadline", deadline === null ? "passed" : "not_satisfied", {deadlineAt: this.writer.getSnapshot().deadlineAt}, configurationRef);
        if (deadline !== null) {
          controls.check("numeric_limits", "not_evaluated", {reason: "deadline_exceeded"});
          return await this.settleLimitViolation(deadline);
        }

        const numericLimit = this.continuingDecision || this.recoveringController ? null : evaluateRunNumericLimits({
          counters: this.writer.getSnapshot().counters,
          limits: this.config.limits,
        });
        controls.check("numeric_limits", numericLimit === null ? "passed" : "not_satisfied", {
          code: numericLimit?.code ?? null,
          controllerTurns: this.writer.getSnapshot().counters.controllerTurns, maxIterations: this.config.limits.maxIterations,
          runActions: this.writer.getSnapshot().counters.runActions, maxActions: this.config.limits.maxActions,
          consecutiveActionFailures: this.writer.getSnapshot().counters.consecutiveActionFailures, maxConsecutiveActionFailures: this.config.limits.maxConsecutiveActionFailures,
        }, configurationRef);
        if (numericLimit !== null) return await this.settleLimitViolation(numericLimit);

        const preparationInputs = this.flow.invocation.context.observer ? recordControllerPreparation(this.flow.invocation, {
          agent: this.activeAgent, instructionBinding: this.activeInstructionBinding,
          config: this.config, state: this.writer.getSnapshot(),
          modelInteractionSeed: this.modelInteractionSeed, descendants: this.projectDescendantTargets(),
        }) : [];
        this.flow.enter("controller", {}, preparationInputs);
        const decision = await this.nextDecision();
        if (decision === null) continue;
        if (decision.decision.kind === "propose_completion" && decision.decision.completionSource.kind === "model_call") {
          const call = this.findModelToolCall(decision.decision.completionSource.modelCallRef);
          if (call === null) throw new TypeError("Completion call was not recorded.");
          this.pendingCompletionCall ??= { call, turn: decision.turn, stateResult: null };
        }
        const decisionRef = {owner:"runtime",kind:"contribution",id:`${decision.turn.id}:decision`,revision:String(decision.basisRevision)};
        this.flow.current?.output(decisionRef);
        const decisionStep = this.flow.enter("decision", {kind: decision.decision.kind, turnId: decision.turn.id, basisRevision: decision.basisRevision}, [decisionRef]);
        if (this.resourceFailure !== null) {
          for (const check of ["current_basis", "cancellation"]) decisionStep.check(check, "not_evaluated", {reason: "resource_failure"});
          (await this.settleUnprocessedModelCalls(decision.decision, decision.turn, "invalidated", "run_resource_limit_before_model_calls"));
          return await this.settleResourceFailure(this.resourceFailure);
        }
        const settlementsAfterDecision = (await this.drainInteractionSettlements());
        decisionStep.check("current_basis", settlementsAfterDecision ? "not_satisfied" : "passed", {settlementsAfterDecision});
        decisionStep.check("cancellation", this.config.cancellation.context.request !== null ? "not_satisfied" : "passed");
        if (this.config.cancellation.context.request !== null) {
          (await this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "cancelled",
            "run_cancelled_before_model_calls",
          ));
          return await this.settle({ status: "cancelled" });
        }
        if (settlementsAfterDecision > 0) {
          (await this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "invalidated",
            "run_basis_changed_before_model_calls",
          ));
          await this.retireDecision(decision.turn);
          continue;
        }
        if ((await this.drainSteering("apply")) > 0) {
          (await this.settleUnprocessedModelCalls(
            decision.decision,
            decision.turn,
            "invalidated",
            "run_steering_invalidated_model_calls",
          ));
          await this.retireDecision(decision.turn);
          continue;
        }
        if (decision.decision.kind === "continue_with_feedback") {
          (await this.commitControllerFeedback(decision.decision.feedback, decision.turn));
          continue;
        }
        const admissionStep = this.flow.enter("admission", {turnId: decision.turn.id, calls: decision.decision.candidates.length}, [decisionRef]);
        const basis: CandidateBasis<TOutput> = {
          turn: decision.turn,
          runRevision: decision.basisRevision,
          activeAgent: decision.agent,
          instructionBinding: decision.prepared.input.instructionBinding,
          projection: decision.prepared.context,
          admissions: new Map(decision.decision.candidates.flatMap((candidate) => candidate.kind === "tool_request"
            ? [[candidate, admitObservedToolCall({ candidate: candidate.tool, selection: this.config.tools,
                exposure: decision.prepared.input.toolExposure, modelCall: candidate.modelCallRef,
                semanticValidators: this.dependencies.operations.toolInputSemanticValidators }, admissionStep.context, this.runId)] as const]
            : [])),
        };
        const rejectedAdmissions = [...basis.admissions.values()].filter(value => value.status === "rejected").length;
        admissionStep.check("tool_admission", basis.admissions.size === 0 ? "not_applicable" : rejectedAdmissions > 0 ? "not_satisfied" : "passed", {
          toolCandidates: basis.admissions.size, rejected: rejectedAdmissions,
        });
        admissionStep.output(...decision.decision.candidates.map(candidate => ({owner:"runtime",kind:"call",id:candidate.modelCallRef.id,revision:null})));
        if (this.dependencies.executionObserver) decision.decision.candidates.forEach((candidate, position) => {
          const admission = basis.admissions.get(candidate);
          publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "scheduling", runId: this.runId, occurredAt: null, call: candidate.modelCallRef, position,
            disposition: admission?.status === "rejected" ? "rejected" : "queued", rule: "decision_source_order", groupId: null, reason: admission?.status === "rejected" ? admission.code : null });
        });
        for (let index = 0; index < decision.decision.candidates.length; index += 1) {
          const dispatchStep = this.flow.enter("dispatch", {turnId: decision.turn.id, candidateIndex: index}, [{owner:"runtime",kind:"call",id:decision.decision.candidates[index]!.modelCallRef.id,revision:null}]);
          await this.awaitSuspension();
          dispatchStep.check("cancellation", this.config.cancellation.context.request !== null ? "not_satisfied" : "passed");
          if (this.config.cancellation.context.request !== null) {
            for (const check of ["steering", "action_capacity"]) dispatchStep.check(check, "not_evaluated", {reason: "cancellation_requested"});
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index,
              decision.turn,
              "cancelled",
              "run_cancelled_before_model_call",
            ));
            break;
          }
          (await this.drainInteractionSettlements());
          const steeringChanges = (await this.drainSteering("apply"));
          dispatchStep.check("steering", steeringChanges > 0 ? "not_satisfied" : "passed", {applied:steeringChanges});
          if (steeringChanges > 0) {
            dispatchStep.check("action_capacity", "not_evaluated", {reason: "steering_applied"});
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index,
              decision.turn,
              "invalidated",
              "run_steering_invalidated_model_call",
            ));
            break;
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
              dispatchStep.check("action_capacity", remainingActionCapacity >= siblingCount ? "passed" : "not_satisfied", {
                remaining: remainingActionCapacity, required: siblingCount, maxActions: this.config.limits.maxActions,
              });
              if (remainingActionCapacity < siblingCount) {
                (await this.settleCandidateRange(
                  decision.decision.candidates.slice(index, index + siblingCount),
                  0,
                  decision.turn,
                  "invalidated",
                  "runtime_action_limit_reached",
                ));
                outcome = Object.freeze({
                  dispatchStop: "action_limit",
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
            } else if (this.concurrentToolGroupLength(decision.decision.candidates, index, basis) > 1) {
              const count = Math.min(remainingActionCapacity,
                this.concurrentToolGroupLength(decision.decision.candidates, index, basis));
              dispatchStep.check("action_capacity", "not_evaluated", {
                reason: "individual_call_admission", remaining: remainingActionCapacity, scheduledTogether: count > 1 ? count : 1,
              });
              if (count > 1) {
                outcome = await this.processConcurrentToolCandidates(
                  decision.decision.candidates.slice(index, index + count), index, basis);
                index += count - 1;
              } else {
                outcome = await this.processCandidate(decision.decision.candidates[index]!, index, basis);
              }
            } else {
              dispatchStep.check("action_capacity", "not_evaluated", {reason: "individual_call_admission"});
              outcome = await this.processCandidate(
                decision.decision.candidates[index]!,
                index,
                basis,
              );
            }
          } catch (error) {
            assertExecutionCommitConfirmed(error);
            const cancelled = this.config.cancellation.context.request !== null;
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              cancelled ? "cancelled" : "invalidated",
              cancelled
                ? "run_cancelled_after_model_call_failure"
                : "run_execution_failure_before_model_call",
            ));
            throw error;
          }
          if (outcome.terminal !== null) {
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              "run_terminated_before_model_call",
            ));
            return await this.settle(outcome.terminal);
          }
          if ((await this.drainSteering("apply")) > 0) {
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              "run_steering_invalidated_model_call",
            ));
            break;
          }
          if (outcome.dispatchStop !== null) {
            (await this.settleCandidateRange(
              decision.decision.candidates,
              index + 1,
              decision.turn,
              "invalidated",
              `run_${outcome.dispatchStop}_before_model_call`,
            ));
            break;
          }
        }
        const joinStep = this.flow.enter("join", {}, [decisionRef, ...decision.decision.candidates.map(candidate => ({owner:"runtime",kind:"call",id:candidate.modelCallRef.id,revision:null}))]);
        await this.waitForModelCallSettlements();
        joinStep.check("unsettled_calls", this.modelCallSettlementWaits.size === 0 ? "passed" : "not_satisfied", {
          remaining: this.modelCallSettlementWaits.size,
        });
        joinStep.output(...decision.decision.candidates.map(candidate => ({owner:"runtime",kind:"call",id:candidate.modelCallRef.id,revision:null})));
        if (decision.decision.kind === "propose_completion") {
          const completion = await this.processCompletionCandidate(decision.turn, decision.decision, decision.prepared, decision.basisRevision);
          if (completion !== null) return await this.settle(completion);
        }
        await this.retireDecision(decision.turn);
      }
      return this.terminalResult;
    } catch (error) {
      this.rejectStarted(error);
      assertExecutionCommitConfirmed(error);
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
      this.flow.close(this.terminalResult?.status ?? "failed");
      this.interactions.dispose();
      this.interruptionCoordinator.dispose();
    }
  }

  private async commitControllerFeedback(
    feedback: import("../controller/index.js").ControllerFeedback,
    turn: ControllerTurnRef,
  ): Promise<void> {
    const pending = this.pendingCompletionCall;
    await this.writer.transaction(state => {
      const recorded = state.items.find(item => item.payload.kind === "controller_feedback" && item.payload.turn.id === turn.id);
      if (recorded?.payload.kind === "controller_feedback") {
        const previous = recorded.payload;
        if (previous.turn.run.id !== turn.run.id || previous.turn.sequence !== turn.sequence ||
            previous.feedback.code !== feedback.code || previous.feedback.message !== feedback.message ||
            (["owner", "kind", "id", "revision"] as const).some(key => previous.feedback.source[key] !== feedback.source[key])) {
          throw new TypeError("Retained Controller feedback conflicts with the replayed occurrence.");
        }
        return {value: null};
      }
      const payloads: RunItemPayload<TOutput>[] = [{kind: "controller_feedback", feedback, turn}];
      let entry: import("./RunInputNotifications.js").RunInputNotification | null = null;
      // Call-bound feedback is the Call's result, not an additional user message.
      if (pending !== null && !this.hasModelCallSettlement(pending.call)) {
        payloads.push(this.localModelCallResult(pending.call, "invalidated", {
          status: "invalidated", code: feedback.code, message: feedback.message, source: feedback.source,
          ...(pending.stateResult === null ? {} : {stateUpdate: {
            settlement: pending.stateResult.settlement, content: pending.stateResult.content,
          }}),
        }, [...(pending.stateResult?.sourceRefs ?? []), feedback.source,
          {owner: "agent-runtime", kind: "controller_feedback", id: `${turn.id}:feedback`, revision: String(turn.sequence)}]));
      } else {
        entry = this.inputNotifications.admitOwned(this.runId, {
          source: {owner: "agent-runtime", kind: "controller_feedback", id: `${turn.id}:feedback`, revision: String(turn.sequence)},
          occurredAt: this.now(), data: feedback, interpretation: {kind: "controller_feedback", turn},
        }, this.dependencies.contextProjection.maxContributionPayloadBytes);
        payloads.push({kind: "input_notification", notification: entry});
      }
      this.markDecisionRetired(turn);
      this.pendingCompletionCall = null;
      return {value: entry, payloads, patch: {}};
    });
    if (pending !== null) {
      const actionRef = pending.stateResult?.sourceRefs.find(ref => ref.kind === "run_action");
      if (actionRef !== undefined) this.closeModelCallFlow(actionRef.id, pending.call.modelCallRef.id, "invalidated");
      this.pendingCompletionCall = null;
    }
  }

  private markDecisionRetired(turn: ControllerTurnRef): void {
    if (this.acceptedDecision?.turn.id !== turn.id || turn.run.id !== this.runId) {
      throw new TypeError("Only the current accepted decision can be retired.");
    }
    this.acceptedDecision = {...this.acceptedDecision, status: "retired"};
  }

  private async retireDecision(turn: ControllerTurnRef): Promise<void> {
    if (this.acceptedDecision?.status === "retired") return;
    await this.writer.commitState(() => {this.markDecisionRetired(turn); return {};});
  }

  private async hasUnsettledDescendantObligations(turn: ControllerTurnRef): Promise<boolean> {
    const state = this.writer.getSnapshot();
    if (!state.pending.some((pending) => pending.kind === "descendant_run")) return false;
    (await this.commitControllerFeedback(Object.freeze({
      source: Object.freeze({
        owner: "agent-runtime",
        kind: "active_descendant_completion_obligation",
        id: this.runId,
        revision: String(state.revision),
      }),
      code: "active_descendant_result_pending",
      message: "The Run cannot end while descendant work remains unsettled. Continue other work, steer or resume the exact active Child, or cancel it before stopping.",
    }), turn));
    return true;
  }

  private async processCompletionCandidate(
    turn: ControllerTurnRef,
    decision: Extract<ControllerDecision<TOutput>, { readonly kind: "propose_completion" }>,
    original: PreparedControllerOperation<TOutput>,
    basisRevision: number,
  ): Promise<TerminalCandidate<TOutput> | null> {
    const acceptedBeforeRestart = this.writer.getSnapshot().items.find(item => item.payload.kind === "completion_acceptance" &&
      item.payload.candidateId === turn.id && item.payload.candidateRevision === String(turn.sequence));
    if (acceptedBeforeRestart?.payload.kind === "completion_acceptance") {
      await this.settleCompletionCall("succeeded", "completion_candidate_accepted", acceptedBeforeRestart.payload.source);
      return {status: "completed", output: decision.output, source: acceptedBeforeRestart.payload.source};
    }
    const step = this.flow.enter("completion", {turnId: turn.id}, [
      {owner: "runtime", kind: "contribution", id: `${turn.id}:decision`, revision: String(basisRevision)},
      ...decision.candidates.map(candidate => ({owner: "runtime", kind: "call", id: candidate.modelCallRef.id, revision: null})),
    ]);
    step.check("cancellation", this.config.cancellation.context.request !== null ? "not_satisfied" : "passed");
    if (this.config.cancellation.context.request !== null) {
      return { status: "cancelled" };
    }
    const terminal = this.completionLimitFailure();
    if (terminal !== null) return terminal;
    if ((await this.deferCompletionForNotifications(turn, step))) return null;
    const changed = (await this.drainSteering("apply")) > 0 || this.completionBasisChanged(turn);
    const current = this.writer.getSnapshot();
    step.check("active_state", current.status === "running" || current.status === "waiting" ? "passed" : "not_satisfied", {status: current.status, revision: current.revision});
    step.check("current_basis", changed ? "not_satisfied" : "passed");
    if (changed || (current.status !== "running" && current.status !== "waiting")) {
      (await this.declineCompletion(turn, "completion_basis_invalidated", "The ending proposal is no longer current. Use the updated Run state before proposing another final response."));
      return null;
    }
    const keys = new Set(decision.candidates.map(candidate => modelCallRefKey(candidate.modelCallRef)));
    const includesCompletionUpdate = decision.completionSource.kind === "model_call" &&
      keys.delete(modelCallRefKey(decision.completionSource.modelCallRef));
    const stateResult = this.pendingCompletionCall?.stateResult ?? null;
    const settlements = current.items.flatMap(item => item.payload.kind === "model_call_settlement" && keys.has(modelCallRefKey(item.payload.result.modelCallRef)) ? [item.payload.result] : []);
    const failed = settlements.length !== keys.size || settlements.some(result => result.settlement !== "succeeded") ||
      (includesCompletionUpdate && stateResult?.settlement !== "succeeded");
    step.check("call_settlements", failed ? "not_satisfied" : "passed", {expected: keys.size, settled: settlements.length,
      completionStateUpdate: includesCompletionUpdate ? stateResult?.settlement ?? "missing" : null});
    if (failed) {
      if (includesCompletionUpdate && stateResult?.settlement !== "succeeded") {
        (await this.declineCompletion(turn, "completion_state_update_failed", "The state update submitted with this ending proposal was not accepted. Read stateUpdate in this call's returned result for its rejection reason and correct that input before proposing completion again. Other successful calls remain settled; do not repeat them unnecessarily."));
      } else {
        (await this.declineCompletion(turn, "completion_calls_not_successful", "One or more requests accompanying this final response did not succeed. Read their returned results before choosing a new action or final response; do not repeat successful calls unnecessarily."));
      }
      return null;
    }
    const outstanding = (await this.hasUnsettledDescendantObligations(turn));
    step.check("descendant_obligations", outstanding ? "not_satisfied" : "passed", {pendingDescendants: current.pending.filter(pending => pending.kind === "descendant_run").length});
    if (outstanding) {
      return null;
    }
    const controller = this.dependencies.controller;
    const retainedNotification = this.restored?.control.completionNotification?.turn.id === turn.id
      ? this.restored.control.completionNotification : null;
    if (retainedNotification) {
      if (this.decisionBasis.revision(turn.id, current.revision) !== retainedNotification.basisRevision) {
        await this.declineCompletion(turn, "completion_basis_invalidated", "The Run changed after the retained ending notification. Use its current state before proposing completion again.");
        this.decisionBasis.release(turn.id);
        return null;
      }
      if (retainedNotification.outcome.status === "failed") {
        const outcome = retainedNotification.outcome;
        throw new ControllerError(outcome.failure, outcome.operationSettlement, outcome.deadline);
      }
      if (retainedNotification.outcome.status === "interrupted") {
        await this.declineCompletion(turn, "completion_basis_invalidated", "The ending notification was interrupted by a Run change. Use the current state before proposing another final response.");
        this.decisionBasis.release(turn.id);
        return null;
      }
      const disposition = retainedNotification.outcome.status === "returned" ? retainedNotification.outcome.disposition : null;
      if (disposition?.kind === "continue_with_feedback") {
        await this.commitControllerFeedback(disposition.feedback, turn);
        this.decisionBasis.release(turn.id);
        return null;
      }
    }
    if (controller.beforeCompletion !== undefined && retainedNotification?.outcome.status !== "returned") {
      if (!retainedNotification) (await this.synchronizeCurrentContext());
      const state = this.writer.getSnapshot();
      const notificationRevision = retainedNotification?.basisRevision ?? state.revision;
      const prepared = retainedNotification ? restoreControllerOperation(retainedNotification.prepared, this.activeAgent) : prepareControllerOperation({
        agent: this.activeAgent, instructionBinding: this.activeInstructionBinding,
        runInput: this.input, config: this.config, state, iteration: turn.sequence,
        exposure: original.input.toolExposure, contextProjection: this.dependencies.contextProjection,
        requestedAt: this.now(), modelInteractionSeed: this.modelInteractionSeed,
        descendants: this.projectDescendantTargets(), projectionRequestId: `${turn.id}:completion-context:${state.revision}`,
      });
      const notification = Object.freeze({turn, stateRevision: notificationRevision,
        current: prepared.input, output: decision.output, completionSource: decision.completionSource,
        settlements: Object.freeze(settlements)});
      const notificationStep = this.flow.enter("before_completion", {turnId: turn.id, stateRevision: state.revision}, [
        this.flow.invocation.material("Completion notification", "post_settlement", notification),
      ]);
      if (!retainedNotification) this.decisionBasis.capture(turn.id, notificationRevision);
      const retry = this.createRetryScope(turn.id, notificationRevision);
      try {
        if (!retainedNotification) await this.writer.commitState(() => {
          this.completionNotification = {turn, basisRevision: notificationRevision,
            prepared: retainControllerOperation(prepared), output: decision.output,
            completionSource: decision.completionSource, settlements,
            outcome: {status: "pending"}};
          return {};
        }, turn.id);
        const invoke = retainedNotification ? controller.recoverBeforeCompletion : controller.beforeCompletion;
        if (!invoke) throw new RunRecoveryError(this.runId, "completion_notification_unconfirmed", turn.id);
        const disposition = await this.interruptionCoordinator.execute("controller", () => invoke.call(controller, notification, {
          checkpoints: this.controllerCheckpointPort(turn.id, "completion"),
          runCheckpoints: this.controllerCheckpointPort(turn.id, "run"),
          executionFlow: this.flow.context, cancellation: this.config.cancellation.context,
          retry: {waitControl: retry, providerRequest: this.config.retry.providerRequest, structuredOutput: this.config.retry.structuredOutput,
            deadlineAt: state.deadlineAt, events: this.retryEvents(turn.id)},
        }), state.deadlineAt);
        const retainedDisposition = disposition?.kind === "continue_with_feedback"
          ? {kind: "continue_with_feedback" as const, feedback: snapshotControllerFeedback(disposition.feedback)}
          : disposition?.kind === "allow" ? {kind: "allow" as const} : null;
        if (retainedDisposition === null) throw new TypeError("Controller completion disposition is invalid.");
        await this.writer.commitState(() => {
          this.completionNotification = {...this.completionNotification!,
            outcome: {status: "returned", disposition: retainedDisposition}};
          return {};
        }, turn.id);
        notificationStep.output(this.flow.invocation.material("Completion disposition", "returned", disposition));
        const cancelled = this.config.cancellation.context.request !== null;
        const invalidated = this.decisionBasis.revision(turn.id, this.writer.getSnapshot().revision) !== notificationRevision ||
          this.steeringQueue.length > 0 || this.interactionSettlements.length > 0;
        const limitFailure = this.completionLimitFailure();
        notificationStep.check("current_basis", invalidated ? "not_satisfied" : "passed");
        notificationStep.check("cancellation", cancelled ? "not_satisfied" : "passed");
        if (cancelled) return {status: "cancelled"};
        if (limitFailure !== null) return limitFailure;
        if (invalidated) {
          (await this.declineCompletion(turn, "completion_basis_invalidated", "The Run changed while processing its ending proposal. Use the current state before proposing another final response."));
          return null;
        }
        if (disposition?.kind === "continue_with_feedback") {
          const feedback = snapshotControllerFeedback(disposition.feedback);
          (await this.commitControllerFeedback(feedback, turn));
          return null;
        }
        if (disposition?.kind !== "allow") throw new TypeError("Controller completion disposition is invalid.");
      } catch (error) {
        assertExecutionCommitConfirmed(error);
        const failure = error instanceof ControllerError ? error : new ControllerError({kind: "model", failure: {
          code: "model_output_invalid", retryable: false, message: "Controller completion notification failed.",
          metadata: {error: error instanceof Error ? error.name : "unknown"}}});
        if (this.completionNotification?.outcome.status === "pending") {
          await this.writer.commitState(() => {
            this.completionNotification = {...this.completionNotification!, outcome: error instanceof RetryInvocationInvalidatedError
              ? {status: "interrupted"} : {status: "failed", errorName: failure.name, failure: failure.failure,
                operationSettlement: failure.operationSettlement, deadline: failure.deadline}};
            return {};
          }, turn.id);
        }
        if (error instanceof RetryInvocationInvalidatedError) {
          (await this.declineCompletion(turn, "completion_basis_invalidated", "The ending notification was interrupted by a Run change. Use the current state before proposing another final response."));
          return null;
        }
        if (error instanceof ControllerError || this.config.cancellation.context.request !== null) throw error;
        throw failure;
      } finally {
        retry.dispose();
        this.retryScopes.delete(turn.id);
        this.decisionBasis.release(turn.id);
      }
    }
    this.decisionBasis.release(turn.id);
    const acceptance = this.flow.enter("acceptance", {turnId: turn.id, revision: this.writer.getSnapshot().revision});
    if ((await this.deferCompletionForNotifications(turn, acceptance))) return null;
    const accepted = (await this.acceptRunCompletion({ id: turn.id, revision: String(turn.sequence) }, decision.completionSource));
    (await this.settleCompletionCall("succeeded", "completion_candidate_accepted", accepted.source));
    return {status: "completed", output: decision.output, source: accepted.source};
  }

  private completionLimitFailure(): Extract<TerminalCandidate<TOutput>, {readonly status: "failed"}> | null {
    if (this.resourceFailure !== null) return this.resourceFailureCandidate(this.resourceFailure);
    const deadline = evaluateRunDeadline({deadlineAt: this.writer.getSnapshot().deadlineAt, now: this.now()});
    return deadline === null ? null : {status: "failed", failure: runtimeFailure(deadline.code, deadline.message, deadline.metadata)};
  }

  private async collectInputNotifications(): Promise<void> {
    const facts = this.inputNotifications.collect(this.runId, this.dependencies.inputNotifications,
      this.dependencies.contextProjection.maxContributionPayloadBytes);
    for (const notification of facts) {
      (await this.writer.commitItems([{kind: "input_notification", notification}]));
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "context_source", runId: this.runId,
        occurredAt: notification.occurredAt, source: {...notification.source, observedAt: notification.occurredAt}, value: notification});
    }
  }

  private async deferCompletionForNotifications(turn: ControllerTurnRef, step: ExecutionFlowStep): Promise<boolean> {
    (await this.collectInputNotifications());
    const pending = this.inputNotifications.undelivered;
    step.check("input_notifications", pending > 0 ? "not_satisfied" : "passed", {undelivered: pending});
    if (pending === 0) return false;
    (await this.declineCompletion(turn, "completion_input_pending",
      "New execution facts remain to be accepted as host notifications. Read those facts before deciding whether to continue or submit a new final response. Do not repeat successful calls merely because this proposal was deferred."));
    return true;
  }

  private completionBasisChanged(turn: ControllerTurnRef): boolean {
    const items = this.writer.getSnapshot().items;
    const position = items.findIndex(item => item.payload.kind === "controller_turn" && item.payload.turn.id === turn.id);
    return items.slice(position + 1).some(item => item.payload.kind === "state_transition" &&
      (item.payload.transition === "steering" || item.payload.transition === "active_agent"));
  }

  private async declineCompletion(turn: ControllerTurnRef, code: string, message: string): Promise<void> {
    (await this.commitControllerFeedback({source: {owner: "agent-runtime", kind: "completion", id: turn.id, revision: String(turn.sequence)}, code, message}, turn));
  }

  private async settleCompletionCall(settlement: ModelCallSettlementKind, code: string, source?: ModelToolResult["sourceRefs"][number]): Promise<void> {
    const pending = this.pendingCompletionCall;
    if (pending === null) return;
    if (!this.hasModelCallSettlement(pending.call)) {
      (await this.commitLocalModelCallResult(pending.call, settlement, {
        status: settlement, code,
        ...(pending.stateResult === null ? {} : {stateUpdate: {
          settlement: pending.stateResult.settlement, content: pending.stateResult.content,
        }}),
      }, [...(pending.stateResult?.sourceRefs ?? []), source ? {
        owner: source.owner, kind: source.kind, id: source.id, revision: source.revision,
      } : {
        owner: "agent-runtime", kind: "controller_turn", id: pending.turn.id, revision: String(pending.turn.sequence),
      }]));
    }
    const actionRef = pending.stateResult?.sourceRefs.find(ref => ref.kind === "run_action");
    if (actionRef !== undefined) this.closeModelCallFlow(actionRef.id, pending.call.modelCallRef.id, settlement);
    this.pendingCompletionCall = null;
  }

  private async acceptRunCompletion(
    proposal: Readonly<{ readonly id: string; readonly revision: string }>,
    completionSource: import("../controller/index.js").CompletionSource,
  ): Promise<{ readonly kind: "completed"; readonly source: RunCauseSourceRef }> {
    const state = this.writer.getSnapshot();
    const source: RunCauseSourceRef = Object.freeze({
      owner: "agent-runtime",
      kind: "run_completion_acceptance",
      id: this.id("run_completion_acceptance"),
      revision: proposal.revision,
      run: state.run,
    });
    (await this.writer.commitItems(Object.freeze([Object.freeze({
      kind: "completion_acceptance" as const,
      source,
      candidateId: proposal.id,
      candidateRevision: proposal.revision,
      completionSource,
      basisRevision: state.revision,
      acceptedAt: this.now(),
    })])));
    return Object.freeze({ kind: "completed" as const, source });
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

  private async commitModelCallSettlement(
    action: RuntimeRunAction,
    fallback: ModelCallSettlementKind | null,
  ): Promise<void> {
    if (action.provenance.kind !== "controller") return;
    const call = this.findModelToolCall(action.provenance.modelCallRef);
    if (call === null) {
      throw new TypeError("Controller RunAction model-call provenance is not recorded.");
    }
    if (this.hasModelCallSettlement(call)) {
      throw new TypeError("A Model Tool Call cannot settle more than once.");
    }
    const completing = this.pendingCompletionCall !== null &&
      modelCallRefKey(this.pendingCompletionCall.call.modelCallRef) === modelCallRefKey(call.modelCallRef)
      ? this.pendingCompletionCall : null;
    if (completing !== null && completing.stateResult !== null) {
      throw new TypeError("A completion call cannot apply more than one state transition.");
    }
    const observation = this.findRunActionObservation(action.ref);
    if (observation === null && fallback === null) {
      return;
    }
    const toolCall = this.operationCalls.get(action.ref.id);
    const presenter = toolCall === undefined ? undefined : this.dependencies.operations.resultPresenters
      ?.find(binding => toolRevisionKey(binding.tool) === toolRevisionKey(toolCall.toolRevision));
    const projected: ReturnType<typeof projectObservationSettlement> = observation === null
      ? Object.freeze({
          settlement: fallback!,
          presentation: resultPresentation("complete"),
          content: Object.freeze({
            status: fallback!,
            code: fallback === "cancelled"
              ? "model_call_cancelled"
              : "model_call_failed",
          }) as ModelJsonValue,
        })
      : projectObservationSettlement(observation, presenter);
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
          ...(observation.payload.kind === "operation" ? [Object.freeze({
            owner: "operation-catalog", kind: "operation_result", id: observation.payload.result.ref.id,
            revision: observation.payload.result.binding.operation.revision,
          })] : []),
        ]);
    const result = snapshotModelToolResult({
      modelCallRef: call.modelCallRef,
      providerCallRef: call.providerCallRef,
      name: call.name,
      settlement: projected.settlement,
      presentation: projected.presentation,
      content: projected.content,
      sourceRefs: [...sourceRefs, ...(projected.references ?? []), {owner: "agent-runtime", kind: "model_call", id: call.modelCallRef.id,
        revision: null, runId: this.runId}],
    });
    // A state-maintaining ending call receives one result after its ending disposition.
    if (completing !== null) {
      await this.writer.commitState(() => {completing.stateResult = result; return {};});
      return;
    }
    (await this.writer.commit({
      kind: "model_call_settlement",
      result,
    }, current => {
      this.operationCalls.delete(action.ref.id);
      if (presenter?.committed !== undefined && toolCall !== undefined && observation?.payload.kind === "operation") {
        this.resultDeliveries.set(result.modelCallRef.id, {presenter: presenter.ref,
          input: {runId: this.runId, call: toolCall, correlation: this.runActionCorrelation(action),
            resultRevision: findRegisteredOperation(this.dependencies.operations.catalog,
              observation.payload.result.ref.invocation.operation)!.operation.resultSchemaRevision,
            result: observation.payload.result, presentation: result}});
      }
      return {
      status: this.statusAfterPendingChange(current, current.pending, action.ref.id),
      counters: {
        ...current.counters,
        consecutiveActionFailures: this.countExecutionSettlement(
          current.counters.consecutiveActionFailures, action, observation, result.settlement,
        ),
      },
    }; }));
    this.closeModelCallFlow(action.ref.id, call.modelCallRef.id, result.settlement);
    await this.deliverToolResults();
  }

  private deliverToolResults(): Promise<void> {
    this.resultDeliveryTail = this.resultDeliveryTail.then(() => this.drainToolResultDeliveries());
    return this.resultDeliveryTail;
  }

  private async drainToolResultDeliveries(): Promise<void> {
    for (const [id, delivery] of this.resultDeliveries) {
      const presenter = this.dependencies.operations.resultPresenters?.find(item =>
        toolRevisionKey(item.tool) === toolRevisionKey(delivery.input.call.toolRevision) &&
        item.ref.id === delivery.presenter.id && item.ref.revision === delivery.presenter.revision);
      if (!presenter?.committed) throw new RunRecoveryError(this.runId, "result_delivery_owner_unavailable", id);
      try { await presenter.committed(delivery.input); }
      catch (cause) { throw new RunCommitError(`${this.runId}:result-delivery:${id}`, {cause}); }
      await this.writer.commitState(() => {this.resultDeliveries.delete(id); return {};});
    }
  }

  private countExecutionSettlement(
    current: number,
    action: RuntimeRunAction,
    observation: RunObservation | null,
    settlement: ModelCallSettlementKind,
  ): number {
    if (!this.executionFailureSettlements.has(action.ref.id)) return current;
    this.executionFailureSettlements.set(action.ref.id, this.executionFailureAdjustment(observation, settlement));
    // Settlement arrival is concurrent; recovery accounting follows dispatch order.
    for (const [id, adjustment] of this.executionFailureSettlements) {
      if (adjustment === null) break;
      if (adjustment === "failure") current += 1;
      else if (adjustment === "success") current = 0;
      this.executionFailureSettlements.delete(id);
    }
    return current;
  }

  private executionFailureAdjustment(
    observation: RunObservation | null,
    settlement: ModelCallSettlementKind,
  ): "failure" | "success" | "unchanged" {
    const payload = observation?.payload;
    if (payload?.kind === "interaction" || payload?.kind === "descendant_progress" ||
        payload?.kind === "descendant_result_transfer") return "unchanged";
    if (payload?.kind === "tool_rejected" && payload.attempt.selectedTool !== null &&
        findSelectedTool(this.config.tools, payload.attempt.selectedTool, payload.attempt.origin)
          ?.registration.descriptor.binding.kind === "interaction") return "unchanged";
    if (payload?.kind === "operation" && payload.result.status === "unknown_effect") return "unchanged";
    switch (settlement) {
      case "succeeded": return "success";
      case "failed":
      case "denied":
      case "invalid": return "failure";
      case "cancelled":
      case "invalidated": return "unchanged";
    }
  }

  private closeModelCallFlow(actionId: string, callId: string, settlement: ModelCallSettlementKind): void {
    const flow = this.actionFlows.get(actionId);
    flow?.advance("settlement", {settlement, callId}, [{owner:"runtime",kind:"call",id:callId,revision:null}]).check("single_settlement", "passed");
    flow?.current?.output({owner:"runtime",kind:"call",id:callId,revision:null});
    flow?.close(settlement === "cancelled" ? "cancelled" : settlement === "failed" ? "failed" : "returned");
    this.actionFlows.delete(actionId);
  }

  private async settleUnprocessedModelCalls(
    decision: ControllerDecision<TOutput>,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): Promise<void> {
    if (decision.kind === "continue_with_feedback") return;
    (await this.settleCandidateRange(decision.candidates, 0, turn, settlement, code));
    (await this.settleCompletionCall(settlement, code));
  }

  private async settleCandidateRange(
    candidates: readonly ProgressionCandidate[],
    startIndex: number,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): Promise<void> {
    for (let index = startIndex; index < candidates.length; index += 1) {
      (await this.commitUnadmittedModelCallSettlement(
        candidates[index]!,
        turn,
        settlement,
        code,
      ));
    }
  }

  private async commitUnadmittedModelCallSettlement(
    candidate: ProgressionCandidate,
    turn: ControllerTurnRef,
    settlement: "invalidated" | "cancelled",
    code: string,
  ): Promise<void> {
    const call = this.findModelToolCall(candidate.modelCallRef);
    if (call === null || this.hasModelCallSettlement(call)) return;
    if (this.pendingCompletionCall !== null &&
      modelCallRefKey(this.pendingCompletionCall.call.modelCallRef) === modelCallRefKey(call.modelCallRef)) {
      (await this.settleCompletionCall(settlement, code));
      return;
    }
    (await this.commitLocalModelCallResult(call, settlement, {
      status: settlement,
      code,
    }, Object.freeze([Object.freeze({
      owner: "agent-runtime",
      kind: "controller_turn",
      id: turn.id,
      revision: String(turn.sequence),
    })])));
  }

  private async commitLocalModelCallResult(
    call: ModelToolCall,
    settlement: ModelCallSettlementKind,
    content: unknown,
    sourceRefs: ModelToolResult["sourceRefs"],
  ): Promise<void> {
    await this.writer.commit(this.localModelCallResult(call, settlement, content, sourceRefs));
  }

  private localModelCallResult(
    call: ModelToolCall,
    settlement: ModelCallSettlementKind,
    content: unknown,
    sourceRefs: ModelToolResult["sourceRefs"],
  ): RunItemPayload<TOutput> {
    const projected = modelSettlement(settlement, content);
    return {
      kind: "model_call_settlement",
      result: snapshotModelToolResult({
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement,
        content: projected.content,
        presentation: projected.presentation,
        sourceRefs: sourceRefs.some(ref => ref.owner === "agent-runtime" && ref.kind === "model_call" &&
          ref.id === call.modelCallRef.id && ref.runId === this.runId) ? sourceRefs :
          [...sourceRefs, {owner: "agent-runtime", kind: "model_call", id: call.modelCallRef.id,
            revision: null, runId: this.runId}],
      }),
    };
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

  private async nextDecision(): Promise<{
    readonly decision: ControllerDecision<TOutput>;
    readonly turn: ControllerTurnRef;
    readonly basisRevision: number;
    readonly agent: Agent<TOutput>;
    readonly prepared: PreparedControllerOperation<TOutput>;
  } | null> {
    if (this.continuingDecision) {
      const retained = this.acceptedDecision!;
      let agent = this.activeAgent;
      if (!sameAgentRef(agent, retained.prepared.input.agent)) {
        const binding = await this.dependencies.agents?.resolve(retained.prepared.input.agent);
        if (binding?.status !== "admitted" || binding.agent === null) {
          throw new RunRecoveryError(this.runId, "decision_agent_unavailable", retained.turn.id);
        }
        agent = snapshotAgent(binding.agent as Agent<TOutput>);
      }
      const prepared = restoreControllerOperation(retained.prepared, agent);
      this.continuingDecision = false;
      return {decision: retained.value as ControllerDecision<TOutput>, turn: retained.turn,
        basisRevision: retained.basisRevision, agent, prepared};
    }
    const flow = new ExecutionFlowPath(CONTROLLER_EXECUTION_FLOW, this.flow.context, this.runId, []);
    let flowDisposition: "returned" | "failed" | "interrupted" = "interrupted";
    try {
    const resuming = this.recoveringController ? this.controllerInvocation : null;
    this.recoveringController = false;
    if (!resuming) {
      (await this.collectInputNotifications());
      (await this.synchronizeCurrentContext());
    }
    const state = this.writer.getSnapshot();
    const basisRevision = resuming?.basisRevision ?? state.revision;
    const iteration = resuming?.turn.sequence ?? state.counters.controllerTurns + 1;
    const turn: ControllerTurnRef = resuming?.turn ?? Object.freeze({
      run: state.run,
      id: this.id("controller_turn", iteration),
      sequence: iteration,
    });
    const inputDelivery = resuming ? resuming.prepared.input.inputDelivery : this.inputNotifications.prepare(this.runId, turn.id);
    if (inputDelivery) publishRunExecutionObservation(this.dependencies.executionObserver, {
      kind: "input_delivery_prepared", runId: this.runId, occurredAt: this.now(), turnId: turn.id, batch: inputDelivery,
    });
    let prepared: PreparedControllerOperation<TOutput>;
    let exposure: import("@agent-anything/tools/selection").ToolExposureProof;
    let contextStep;
    if (resuming) {
      prepared = restoreControllerOperation(resuming.prepared, this.activeAgent);
      exposure = prepared.input.toolExposure;
      contextStep = flow.advance("context", {restored: true, turnId: turn.id});
    } else {
    let resolvedExposure;
    const exposureStep = flow.advance("exposure", {turnId: turn.id, revision: state.revision});
    try {
      resolvedExposure = await this.toolExposure.resolve(turn.id);
    } catch (error) {
      if (error instanceof ToolExposureBasisChangedError) return null;
      throw error;
    }
    exposureStep.check("basis_revision", resolvedExposure.runRevision === state.revision ? "passed" : "not_satisfied");
    if (resolvedExposure.runRevision !== state.revision) return null;
    exposure = resolvedExposure.proof;
    if (this.dependencies.executionObserver) publishRunExecutionObservation(this.dependencies.executionObserver, {
      kind: "tool_exposure", runId: this.runId, occurredAt: null, turnId: turn.id,
      exposure: resolvedExposure.exposure, proof: exposure,
      selected: Object.freeze(this.config.tools.tools.filter((tool) => tool.origins.includes("model")).map((tool) => tool.registration.descriptor.ref)),
    });
    const exposureRef = {owner: "runtime", kind: "turn", id: turn.id, revision: null};
    exposureStep.output(exposureRef);
    contextStep = flow.advance("context", {}, [exposureRef,
      {owner:"context",kind:"context",id:state.context.ref.id,revision:String(state.context.ref.version)},
      {owner:"runtime",kind:"contribution",id:`${this.runId}:input`,revision:"1"},
    ]);
    try {
      prepared = prepareControllerOperation({
        inputDelivery,
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
      publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "context_projection", runId: this.runId, occurredAt: prepared.manifest.createdAt, manifest: prepared.manifest, projection: prepared.context });
      this.emitContextProjectionCompleted(prepared.manifest, "projected", null);
      contextStep.check("projection_contract", "passed", {manifestId: prepared.manifest.id, contextId: prepared.context.id});
      contextStep.output({owner:"context",kind:"contribution",id:prepared.manifest.projectionId,revision:String(prepared.manifest.activeContext.version)}, {owner:"context",kind:"context",id:prepared.manifest.id,revision:null});
    } catch (error) {
      if (error instanceof ContextProjectionPreparationError) {
        publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "context_projection", runId: this.runId, occurredAt: error.manifest.createdAt, manifest: error.manifest, projection: null });
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
    this.decisionBasis.capture(turn.id, state.revision);
    await this.writer.commitState(() => {
      this.controllerInvocation = {turn, basisRevision: state.revision,
        prepared: retainControllerOperation(prepared), status: "pending"};
      return {};
    }, turn.id);
    }
    const controllerInputRef = recordControllerInput(flow, prepared.input);
    contextStep.output(controllerInputRef);
    const controlsRef = flow.material("Controller invocation controls", "before_invocation", {
      cancellationRequest: this.config.cancellation.context.request,
      retry: {providerRequest: this.config.retry.providerRequest, structuredOutput: this.config.retry.structuredOutput, deadlineAt: prepared.deadlineAt},
      excludedExecutableFields: ["cancellation.signal", "retry.waitControl", "retry.events", "executionFlow.observer"],
    });
    flow.advance("controller", {turnId: turn.id}, [controllerInputRef, controlsRef]);
    const retryScope = this.createRetryScope(turn.id, basisRevision, flow.callContext);
    this.emit("controller.started", { turnId: turn.id, iteration });
    try {
      if (resuming && (this.decisionBasis.revision(turn.id, state.revision) !== basisRevision ||
          this.steeringQueue.length > 0 || this.interactionSettlements.length > 0)) {
        throw new RetryInvocationInvalidatedError();
      }
      const candidate = await this.interruptionCoordinator.execute(
        "controller",
        () => executeControllerOperation({
          dependencies: this.dependencies,
          prepared,
          config: this.config,
          retryEvents: this.retryEvents(turn.id),
          retryWaitControl: retryScope,
          executionFlow: flow.callContext,
          checkpoints: this.controllerCheckpointPort(turn.id),
          runCheckpoints: this.controllerCheckpointPort(turn.id, "run"),
          recovering: resuming !== null,
        }),
        state.deadlineAt,
      );
      const validityStep = flow.advance("validity");
      // Exposure is request provenance. Live availability is checked on each
      // selected binding before materialization, not on unrelated catalog paths.
      const stale = this.decisionBasis.revision(turn.id, this.writer.getSnapshot().revision) !== basisRevision ||
        this.interactionSettlements.length > 0 ||
        this.steeringQueue.length > 0 ||
        this.config.cancellation.context.request !== null;
      validityStep.check("freshness", stale ? "not_satisfied" : "passed", {capturedRevision: state.revision, currentRevision: this.writer.getSnapshot().revision, relevantRevision: this.decisionBasis.revision(turn.id, this.writer.getSnapshot().revision)});
      if (stale) {
        this.controllerInvocation = {...this.controllerInvocation!, status: "interrupted"};
        (await this.writer.commit({
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
        })));
        this.emit("controller.finished", {
          turnId: turn.id,
          iteration,
          status: "interrupted",
          code: "controller_decision_basis_stale",
          decisionKind: null,
        });
        return null;
      }
      const decisionStep = flow.advance("decision");
      let decision: ControllerDecision<TOutput>;
      try {
        decision = validateControllerDecision(candidate, prepared.input);
        decisionStep.check("decision_contract", "passed", {kind: decision.kind});
      } catch (error) {
        decisionStep.check("decision_contract", "error", {reason: "invalid_controller_decision"});
        throw error;
      }
      const decisionRef = {owner:"runtime",kind:"contribution",id:`${turn.id}:decision`,revision:String(state.revision)};
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind:"controller_decision",runId:this.runId,occurredAt:new Date().toISOString(),turnId:turn.id,basisRevision:state.revision,decision});
      decisionStep.output(decisionRef);
      (await this.writer.commitItems([
        ...(inputDelivery && decision.inputDeliveryReceipt ? [{kind: "input_delivery" as const,
          batch: inputDelivery, receipt: decision.inputDeliveryReceipt, turn}] : []), {
        kind: "controller_turn",
        turn,
        status: "decided",
        decisionKind: decision.kind,
        instructionBinding: prepared.input.instructionBinding.ref,
        toolExposure: controllerToolExposureRecord(exposure, prepared.manifest.id),
        modelItems: decision.modelItems,
        failure: null,
      }], (current) => {
        if (inputDelivery && decision.inputDeliveryReceipt) {
          this.inputNotifications.accepted(inputDelivery, decision.inputDeliveryReceipt);
        }
        this.acceptedDecision = {status: "active", turn, basisRevision, value: decision,
          prepared: retainControllerOperation(prepared), calls: []};
        this.controllerInvocation = {...this.controllerInvocation!, status: "returned"};
        if (decision.kind === "propose_completion" && decision.completionSource.kind === "model_call") {
          const key = modelCallRefKey(decision.completionSource.modelCallRef);
          const item = decision.modelItems.find(item => item.kind === "model_tool_call" && modelCallRefKey(item.call.modelCallRef) === key);
          if (!item || item.kind !== "model_tool_call") throw new TypeError("Completion call is missing from accepted Turn.");
          this.pendingCompletionCall = {call: item.call, turn, stateResult: null};
        }
        return Object.freeze({
        counters: Object.freeze({
          ...current.counters,
          controllerTurns: iteration,
        }),
      }); }));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "decided",
        code: null,
        decisionKind: decision.kind,
      });
      flowDisposition = "returned";
      return Object.freeze({
        decision,
        turn,
        basisRevision,
        agent: this.activeAgent,
        prepared,
      });
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      if (error instanceof RetryInvocationInvalidatedError) {
        this.controllerInvocation = {...this.controllerInvocation!, status: "interrupted"};
        (await this.writer.commit({kind: "controller_turn", turn, status: "interrupted", decisionKind: null, instructionBinding: prepared.input.instructionBinding.ref, toolExposure: controllerToolExposureRecord(exposure, prepared.manifest.id), modelItems: Object.freeze([]), failure: null}, current => ({counters: {...current.counters, controllerTurns: iteration}})));
        this.emit("controller.finished", {turnId: turn.id, iteration, status: "interrupted", code: "retry_invocation_invalidated", decisionKind: null});
        return null;
      }
      if (this.config.cancellation.context.request !== null) throw error;
      const terminal = this.failureFromError(error);
      this.controllerInvocation = {...this.controllerInvocation!, status: "failed"};
      (await this.writer.commit({
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
      })));
      this.emit("controller.finished", {
        turnId: turn.id,
        iteration,
        status: "failed",
        code: terminal.failure.failure.code,
        decisionKind: null,
      });
      throw error;
    } finally {
      retryScope.dispose();
      this.retryScopes.delete(turn.id);
      this.decisionBasis.release(turn.id);
    }
    } catch (error) { flowDisposition = "failed"; throw error; }
    finally { flow.close(flowDisposition); }
  }

  private createRetryScope(invocationId: string, revision: number, executionFlow = this.flow.context): RunRetryWaitScope {
    const state = this.writer.getSnapshot();
    const waits = state.items.flatMap(({payload}) => payload.kind === "pending_transition" &&
      payload.pending.kind === "retry_wait" && payload.pending.invocationId === invocationId ? [payload.pending] : []);
    const pending = state.pending.find((value): value is Extract<PendingRunSubject, {kind: "retry_wait"}> =>
      value.kind === "retry_wait" && value.invocationId === invocationId) ?? null;
    const scope = new RunRetryWaitScope({
      runId: this.runId, invocationId, branchId: invocationId,
      executionFlow,
      retained: {generation: Math.max(0, ...waits.map(value => value.generation)), pending},
      deadlineAt: this.writer.getSnapshot().deadlineAt,
      cancellation: this.config.cancellation.context, now: () => this.now(),
      snapshot: () => this.writer.getSnapshot(),
      isCurrent: () => this.decisionBasis.revision(invocationId, this.writer.getSnapshot().revision) === revision &&
        this.steeringQueue.length === 0 && this.interactionSettlements.length === 0,
      open: async pending => (await this.addPending(pending)),
      ready: async pending => (await this.writer.commit({ kind: "retry_transition", transition: "ready", pending })),
      close: async (pending, outcome) => (await this.removePending(pending, outcome === "elapsed" ? "resolved" : "invalidated", pending.waitId)),
    });
    this.retryScopes.set(invocationId, scope);
    return scope;
  }

  private controllerCheckpointPort(invocationId: string, scope = "decision"): ControllerCheckpointPort {
    const identity = (key: string) => JSON.stringify([scope === "run" ? this.runId : invocationId, scope, key]);
    return {
      read: key => structuredClone(this.controllerCheckpoints.get(identity(key)) ?? null),
      commit: async (key, value) => {
        const snapshot = retainControllerCheckpoint(value);
        try {
          await this.writer.commitState(() => {
            this.controllerCheckpoints.set(identity(key), snapshot);
            return {};
          }, invocationId);
        } catch (cause) { throw new ControllerCheckpointError(key, {cause}); }
      },
    };
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

  private async synchronizeCurrentContext(): Promise<void> {
    const state = this.writer.getSnapshot();
    const runStateId = this.currentContextContributionId(state.context, "agent-runtime", "run_state")
      ?? this.id("context_contribution");
    const planId = this.currentContextContributionId(state.context, "agent-runtime", "run_plan")
      ?? this.id("context_contribution");
    const revision = String(state.revision + 1);
    const plan = state.plan === null ? null : projectPlan(state.plan);
    const currentContributions = createCurrentRunContextContributions({
      runStateId,
      planId,
      revision,
      state,
      plan,
      createdAt: this.now(),
    });
    const contributions = currentContributions;
    for (const contribution of contributions) {
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "context_source", runId: this.runId,
        occurredAt: contribution.source.observedAt, source: contribution.source,
        ...(contribution.source.kind === "run_plan" && plan !== null
            ? {inputs: [{owner: "runtime", kind: "plan", id: plan.id, revision: String(plan.version)}]} : {}),
        value: contribution.source.kind === "run_state" ? {revision: state.revision, status: state.status, activeAgent: state.activeAgent, pending: state.pending}
          : contribution.source.kind === "run_plan" ? plan : contribution.payload});
    }
    (await this.writer.commitState((current) => Object.freeze({
      context: this.applyContextContributions(
        current.context,
        contributions,
        createCurrentRunContextAdmissionProfile(),
        "controller_context_prepared",
        null,
      ),
    })));
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

  private concurrentToolGroupLength(
    candidates: readonly ProgressionCandidate[], start: number, basis: CandidateBasis<TOutput>,
  ): number {
    const first = basis.admissions.get(candidates[start]!);
    if (first?.status !== "trusted") return 1;
    const policy = this.toolExposure.scheduling(first.binding);
    if (policy === undefined) return 1;
    let count = 1;
    let maximum = policy.maxParallel;
    for (let index = start + 1; index < candidates.length && count < maximum; index += 1) {
      const admission = basis.admissions.get(candidates[index]!);
      if (admission?.status !== "trusted") break;
      const next = this.toolExposure.scheduling(admission.binding);
      if (next === undefined || next.group !== policy.group) break;
      maximum = Math.min(maximum, next.maxParallel);
      if (count >= maximum) break;
      count += 1;
    }
    return count;
  }

  private async processConcurrentToolCandidates(
    candidates: readonly ProgressionCandidate[], start: number, basis: CandidateBasis<TOutput>,
  ): Promise<CandidateProcessingOutcome<TOutput>> {
    if (this.dependencies.executionObserver) candidates.forEach((candidate, index) => publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "scheduling", runId: this.runId, occurredAt: null, call: candidate.modelCallRef, position: start + index, disposition: "admitted", rule: "registered_concurrency_group", groupId: `${basis.turn.id}:${start}`, reason: null }));
    // Reserve RunAction identities in source order, then drain every started call.
    const results = await Promise.allSettled(candidates.map(async (candidate, index) =>
      (await this.processCandidate(candidate, start + index, basis))));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const outcomes = results.map((result) => (result as PromiseFulfilledResult<CandidateProcessingOutcome<TOutput>>).value);
    return outcomes.find((outcome) => outcome.terminal !== null || outcome.dispatchStop !== null)
      ?? Object.freeze({ dispatchStop: null, terminal: null });
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
    if (this.dependencies.executionObserver) candidates.forEach((candidate, index) => publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "scheduling", runId: this.runId, occurredAt: null, call: candidate.modelCallRef, position: startIndex + index, disposition: "admitted", rule: "concurrent_sibling_admission", groupId: `${basis.turn.id}:${startIndex}`, reason: null }));
    const entries: ConcurrentDescendantCandidateEntry[] = [];
    for (let siblingIndex = 0; siblingIndex < candidates.length; siblingIndex += 1) {
      const candidate = candidates[siblingIndex]!;
      const candidateIndex = startIndex + siblingIndex;
      const existing = this.writer.getSnapshot().items.flatMap(item => item.payload.kind === "run_action" &&
        item.payload.action.provenance.kind === "controller" && item.payload.action.provenance.turn.id === basis.turn.id &&
        item.payload.action.provenance.candidateIndex === candidateIndex ? [item.payload.action] : [])[0];
      const recorded = this.findModelToolCall(candidate.modelCallRef);
      if ((recorded && this.hasModelCallSettlement(recorded)) || (existing && this.findRunActionObservation(existing.ref))) {
        if (existing && recorded && !this.hasModelCallSettlement(recorded)) await this.commitModelCallSettlement(existing, null);
        continue;
      }
      const toolCallId = existing?.subject.kind === "tool" ? existing.subject.toolCallId : this.id("tool_call");
      if (toolCallId === null) throw new TypeError("Retained descendant Tool Call identity is missing.");
      const action = existing ?? (await this.materializeControllerRunAction(
        candidate,
        candidateIndex,
        basis,
        toolCallId,
      ));
      const savedCall = this.operationCalls.get(action.ref.id);
      const materialized = savedCall ? {status: "materialized" as const, call: savedCall} : materializeToolCall({
        admission: await this.revalidateToolAdmission(basis.admissions.get(candidate)!),
        parentRunAction: action.ref, toolCallId, createdAt: this.now(),
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
      if (!savedCall) await this.writer.commitState(() => {this.operationCalls.set(action.ref.id, materialized.call); return {};});
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

    (await this.drainInteractionSettlements());
    const steered = (await this.drainSteering("apply")) > 0;
    const invalidatedBeforeLaunch = this.config.cancellation.context.request !== null || steered;
    const dispatchStop = this.config.cancellation.context.request !== null
      ? "cancellation" : steered ? "steering" : null;
    const outcomes = await Promise.allSettled(entries.map(async (
      entry,
    ): Promise<DescendantExecutionOutcome | null> => {
      if (entry.kind !== "descendant") return null;
      const preparation = entry.preparation;
      return preparation.status === "admitted"
        ? (await this.launchAdmittedDescendant(preparation, invalidatedBeforeLaunch))
        : preparation.status === "restored" ? preparation.outcome : preparation;
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
        (await this.commitObservation(entry.action, {
          kind: "tool_rejected",
          attempt: entry.attempt,
          code: entry.code,
          message: entry.message,
          toolResult,
        }, [toolResultLowerRef(toolResult)], "tools"));
        this.emit("tool.input.rejected", {
          attemptId: entry.attempt.ref.id,
          requestedName: entry.attempt.requestedName,
          selectedToolRevision: entry.attempt.selectedTool?.revision ?? null,
          code: entry.code,
          issueCount: entry.validation?.issues.length ?? 0,
          omittedIssueCount: entry.validation?.omittedIssueCount ?? 0,
          modelCallId: entry.attempt.ref.modelCall?.id ?? null,
        });
        (await this.commitModelCallSettlement(entry.action, null));
        continue;
      }
      if (settled.status === "rejected") {
        (await this.commitModelCallSettlement(
          entry.action,
          this.config.cancellation.context.request === null ? "failed" : "cancelled",
        ));
        firstFailure ??= settled.reason;
        continue;
      }
      (await this.commitDescendantExecutionOutcome(
        entry.action,
        entry.call,
        settled.value!,
        entry.startedAt,
      ));
      (await this.commitModelCallSettlement(entry.action, null));
    }
    if (firstFailure !== null) throw firstFailure;
    return Object.freeze({
      dispatchStop,
      terminal: null,
    });
  }

  private async processCandidate(
    candidate: ProgressionCandidate,
    index: number,
    basis: CandidateBasis<TOutput>,
  ): Promise<CandidateProcessingOutcome<TOutput>> {
    const state = this.writer.getSnapshot();
    const recordedCall = this.findModelToolCall(candidate.modelCallRef);
    const existing = state.items.flatMap(item => item.payload.kind === "run_action" &&
      item.payload.action.provenance.kind === "controller" &&
      item.payload.action.provenance.turn.id === basis.turn.id &&
      item.payload.action.provenance.candidateIndex === index ? [item.payload.action] : [])[0];
    const settled = recordedCall !== null && this.hasModelCallSettlement(recordedCall);
    const observation = existing ? this.findRunActionObservation(existing.ref) : null;
    if (settled || observation) {
      if (!settled && existing && !(this.pendingCompletionCall?.stateResult && recordedCall &&
          modelCallRefKey(this.pendingCompletionCall.call.modelCallRef) === modelCallRefKey(recordedCall.modelCallRef))) {
        await this.commitModelCallSettlement(existing!, null);
      }
      return {dispatchStop: observation?.payload.kind === "handoff" ? "handoff" : null,
        terminal: observation?.payload.kind === "operation" && observation.payload.result.status === "unknown_effect"
          ? {status: "failed", failure: createRunFailureCause("operation", observation.payload.result.failure)} : null};
    }
    if (!existing && state.counters.runActions >= this.config.limits.maxActions) {
      (await this.commitUnadmittedModelCallSettlement(
        candidate,
        basis.turn,
        "invalidated",
        "runtime_action_limit_reached",
      ));
      return Object.freeze({ dispatchStop: "action_limit", terminal: null });
    }
    const reservedId = existing ? existing.subject.kind === "operation" ? existing.subject.invocationId
      : existing.subject.kind === "tool" ? existing.subject.toolCallId
      : existing.subject.kind === "interaction" ? existing.subject.request?.id ?? null : null
      : candidate.kind === "operation_request"
      ? this.id("operation_invocation")
      : candidate.kind === "interaction_request"
        ? this.id("interaction_request", this.nextInteractionRequest++)
        : candidate.kind === "tool_request"
          ? this.id("tool_call")
          : null;
    const action = existing ?? (await this.materializeControllerRunAction(
      candidate,
      index,
      basis,
      reservedId,
    ));

    let dispatchStop: CandidateProcessingOutcome<TOutput>["dispatchStop"] = null;
    let terminal: TerminalCandidate<TOutput> | null = null;
    try {
      switch (candidate.kind) {
        case "state_transition":
          if (candidate.transition === "plan_update") await this.applyPlanCandidate(action, candidate.input);
          else if (await this.applyHandoffCandidate(action, candidate.input, basis)) dispatchStop = "handoff";
          break;
        case "interaction_request":
          await this.applyInteractionCandidate(
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
            basis.admissions.get(candidate)!,
          );
          dispatchStop = outcome.dispatchStop;
          terminal = outcome.terminal;
          break;
        }
        case "model_call_rejection":
          (await this.commitObservation(action, {
            kind: "model_call_rejected",
            code: candidate.code,
            message: candidate.message,
          }, [], "agent-runtime"));
          break;
        case "operation_request": {
          const outcome = await this.executeOperationCandidate(
            action,
            candidate,
            reservedId!,
          );
          if (outcome !== null) {
            (await this.commitOperationObservation(action, outcome));
            if (outcome.result.status === "unknown_effect") {
              terminal = {
                status: "failed",
                failure: createRunFailureCause("operation", outcome.result.failure),
              };
              dispatchStop = null;
            }
          }
          break;
        }
      }
      (await this.commitModelCallSettlement(action, null));
      return Object.freeze({ dispatchStop, terminal });
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      (await this.commitModelCallSettlement(
        action,
        this.config.cancellation.context.request === null ? "failed" : "cancelled",
      ));
      throw error;
    }
  }

  private async materializeControllerRunAction(
    candidate: ProgressionCandidate,
    candidateIndex: number,
    basis: CandidateBasis<TOutput>,
    reservedId: string | null,
  ): Promise<RuntimeRunAction> {
    const action = await this.writer.transaction(state => {
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
    return {payloads: [{kind: "run_action", action}], value: action, patch: {
      status: state.status === "waiting" ? "running" : state.status,
      counters: Object.freeze({
        ...state.counters,
        runActions: sequence,
      }),
    }};
    });
    const flow = new ExecutionFlowPath(RUN_CALL_EXECUTION_FLOW, this.flow.context, this.runId, [{owner:"runtime",kind:"call",id:candidate.modelCallRef.id,revision:null}]);
    const admission = basis.admissions.get(candidate);
    const binding = admission?.status === "trusted" ? admission.binding
      : admission?.selectedTool ? findSelectedTool(this.config.tools, admission.selectedTool, admission.candidate.origin)?.registration.descriptor.binding
        : undefined;
    if (candidate.kind === "operation_request" ||
        (candidate.kind === "tool_request" && binding?.kind !== "interaction")) {
      this.executionFailureSettlements.set(action.ref.id, null);
    }
    flow.advance("admission", {candidateIndex, kind:candidate.kind, runActionId:action.ref.id}).check("admission", admission?.status === "rejected" ? "not_satisfied" : admission ? "passed" : "not_applicable", {status:admission?.status ?? null});
    flow.advance("execute", {runActionId:action.ref.id});
    this.actionFlows.set(action.ref.id, flow);
    publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "scheduling", runId: this.runId, occurredAt: action.materializedAt, call: candidate.modelCallRef, position: candidateIndex, disposition: "dispatched", rule: "candidate_processing_started", groupId: null, reason: null });
    return action;
  }

  private async materializeWorkflowRunAction(input: {
    readonly operation: OperationRevisionRef;
    readonly invocationId: string;
    readonly compositeId: string;
    readonly nodeId: string;
  }): Promise<RuntimeRunAction> {
    return this.writer.transaction(state => {
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
    return {payloads: [{kind: "run_action", action}], value: action, patch: {
      status: state.status === "waiting" ? "running" : state.status,
      counters: Object.freeze({ ...state.counters, runActions: sequence }),
    }};
    });
  }

  private async applyPlanCandidate(action: RuntimeRunAction, candidate: unknown): Promise<void> {
    const committed = await this.writer.transaction(state => {
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
    const observation = createRunObservation({
      id: this.id("observation", state.counters.observations + 1), runId: this.runId,
      actionId: action.ref.id, kind: "plan_update", createdAt: this.now(), metadata: {},
      owner: "runtime", runAction: action.ref, lowerRefs: [], payload: {kind: "plan_update", result: result.observation},
    });
    const contribution = createObservationContextContribution({id: this.id("context_contribution"), observation});
    const context = this.applyContextContributions(state.context, [contribution],
      createObservationContextAdmissionProfile(observation.owner), "observation_committed", observation.id);
    return {value: {observation, context}, payloads: [
      ...(result.status === "applied" ? [{
        kind: "state_transition",
        transition: "plan",
        previousRevision: state.plan?.version ?? null,
        plan: projectPlan(result.plan),
      } as const] : []), {kind: "observation", observation},
    ], patch: {
      context,
      plan: result.status === "applied" ? result.plan : state.plan,
      counters: {...state.counters, observations: state.counters.observations + 1},
    }};
    });
    this.publishObservationFlow(action, committed.observation, committed.context);
  }

  private async applyHandoffCandidate(
    action: RuntimeRunAction,
    request: SameRunHandoffRequest,
    basis: CandidateBasis<TOutput>,
  ): Promise<boolean> {
    const state = this.writer.getSnapshot();
    const rejected = async (code: string): Promise<boolean> => {
      (await this.commitObservation(action, {
        kind: "handoff",
        status: "rejected",
        code,
      }, [], "agent-runtime"));
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
    const committed = await this.writer.transaction(current => {
    const nextInstructionBinding = createAgentInstructionBinding({
      run: current.run,
      agent: nextAgent,
      effectiveFromRunRevision: current.revision + 1,
      supersedes: current.activeInstructionBinding,
    });
    const nextContext = this.handoffContext(
      request.transferPolicy,
      current.context,
      basis.projection,
    );
    const observation = createRunObservation({
      id: this.id("observation", current.counters.observations + 1), runId: this.runId,
      actionId: action.ref.id, kind: "handoff", createdAt: this.now(), metadata: {},
      owner: "agent-runtime", runAction: action.ref, lowerRefs: [{owner: "agent-runtime",
        kind: "agent_admission_evidence", id: request.admissionEvidenceRef, revision: request.targetAgent.revision}],
      payload: {kind: "handoff", status: "applied", code: null},
    });
    const contribution = createObservationContextContribution({id: this.id("context_contribution"), observation});
    const context = this.applyContextContributions(nextContext, [contribution],
      createObservationContextAdmissionProfile(observation.owner), "observation_committed", observation.id);
    this.stagedAgentBinding = {agent: nextAgent, binding: nextInstructionBinding};
    return {value: {observation, context}, payloads: [{
      kind: "state_transition",
      transition: "active_agent",
      previousAgent: current.activeAgent,
      activeAgent: toAgentRevisionRef(nextAgent),
      previousInstructionBinding: current.activeInstructionBinding,
      activeInstructionBinding: nextInstructionBinding.ref,
      reason: request.reason,
    }, {kind: "observation", observation}], patch: {
      activeAgent: toAgentRevisionRef(nextAgent),
      activeInstructionBinding: nextInstructionBinding.ref,
      context,
      counters: {...current.counters, observations: current.counters.observations + 1},
    }};
    });
    this.publishObservationFlow(action, committed.observation, committed.context);
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
    if (await this.continueRetainedInteraction(action, candidate.blockingScope)) return candidate.blockingScope !== "none";
    this.interactionActions.set(requestId, Object.freeze({action, toolCall: null}));
    if (candidate.blockingScope === "none") this.deferredInteractionActions.set(action.ref.id, action);
    const opened = await this.interactions.open({
      requestId,
      protocol: candidate.protocol,
      executionFlow: this.actionFlows.get(action.ref.id)?.callContext,
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
      this.interactionActions.delete(requestId);
      this.deferredInteractionActions.delete(action.ref.id);
      (await this.commitObservation(action, {
        kind: "interaction",
        owner: opened.owner,
        status: "failed",
        contentDigest: null,
        value: Object.freeze({ code: opened.code }),
        toolResult: null,
      }, [], opened.owner));
      return candidate.blockingScope !== "none";
    }
    if (candidate.blockingScope === "none") {
      this.trackModelCallSettlement(opened.completion, action);
      return false;
    }
    await opened.completion;
    (await this.drainInteractionSettlements());
    return true;
  }

  private async revalidateToolAdmission(admission: ToolCallAdmission): Promise<ToolCallAdmission> {
    if (admission.status === "rejected") return admission;
    const current = await this.toolExposure.assessCurrent(admission.binding);
    if (current.disposition === "available") return admission;
    return Object.freeze({ ...admission, status: "rejected" as const,
      code: "tool_execution_unavailable", message: current.reason ?? "The selected execution path is unavailable.",
      validation: null });
  }

  private async executeToolCandidate(
    action: RuntimeRunAction,
    candidate: ToolRequestCandidate,
    toolCallId: string,
    admission: ToolCallAdmission,
  ): Promise<CandidateProcessingOutcome<TOutput>> {
    const retainedCall = this.operationCalls.get(action.ref.id);
    const materialized = retainedCall ? {status: "trusted" as const, call: retainedCall} : materializeToolCall({
      admission: await this.revalidateToolAdmission(admission),
      parentRunAction: action.ref, toolCallId, createdAt: this.now(),
    });
    if (materialized.status === "rejected") {
      const toolResult = failedToolAttemptResult(
        materialized.attempt,
        materialized.code,
        materialized.message,
        materialized.validation,
        this.now(),
      );
      (await this.commitObservation(action, {
        kind: "tool_rejected",
        attempt: materialized.attempt,
        code: materialized.code,
        message: materialized.message,
        toolResult,
      }, [toolResultLowerRef(toolResult)], "tools"));
      this.emit("tool.input.rejected", {
        attemptId: materialized.attempt.ref.id,
        requestedName: materialized.attempt.requestedName,
        selectedToolRevision: materialized.attempt.selectedTool?.revision ?? null,
        code: materialized.code,
        issueCount: materialized.validation?.issues.length ?? 0,
        omittedIssueCount: materialized.validation?.omittedIssueCount ?? 0,
        modelCallId: materialized.attempt.ref.modelCall?.id ?? null,
      });
      return Object.freeze({ dispatchStop: null, terminal: null });
    }
    const call = materialized.call;
    if (!retainedCall) {
      await this.writer.commitState(() => {this.operationCalls.set(action.ref.id, call); return {};});
    }
    switch (call.binding.kind) {
      case "operation": {
        const retained = [...this.operationPreparations.values()].find(value => value.action.ref.id === action.ref.id);
        const result = await this.executeOperation({
          action,
          operation: call.binding.operation,
          request: call.input,
          requestOrigin: call.origin === "model" ? "tool_request" : "trusted_workflow",
          invocationId: retained?.binding.invocation.id ?? this.id("operation_invocation"),
          parentInvocation: null,
          basis: call,
        });
        if (result !== null) {
          (await this.commitOperationObservation(action, {
            result,
            toolResult: adaptToolResult(call, result),
          }));
          if (result.status === "unknown_effect") {
            return Object.freeze({
              dispatchStop: null,
              terminal: {
                status: "failed" as const,
                code: "unknown_effect" as const,
                failure: createRunFailureCause("operation", result.failure),
              },
            });
          }
        }
        return Object.freeze({ dispatchStop: null, terminal: null });
      }
      case "interaction":
        await this.executeToolInteraction(action, call);
        return Object.freeze({ dispatchStop: null, terminal: null });
      case "descendant_agent":
        await this.executeToolDescendant(action, call);
        return Object.freeze({ dispatchStop: null, terminal: null });
      case "descendant_message":
        await this.executeToolDescendantMessage(action, call);
        return Object.freeze({ dispatchStop: null, terminal: null });
    }
    return Object.freeze({ dispatchStop: null, terminal: null });
  }

  private async executeToolInteraction(
    action: RuntimeRunAction,
    call: ToolCall,
  ): Promise<boolean> {
    if (call.binding.kind !== "interaction") return false;
    if (await this.continueRetainedInteraction(action, call.binding.blockingScope)) return call.binding.blockingScope !== "none";
    const requestId = this.id("interaction_request", this.nextInteractionRequest++);
    this.interactionActions.set(requestId, Object.freeze({action, toolCall: call}));
    if (call.binding.blockingScope === "none") this.deferredInteractionActions.set(action.ref.id, action);
    const opened = await this.interactions.open({
      requestId,
      protocol: call.binding.protocol,
      executionFlow: this.actionFlows.get(action.ref.id)?.callContext,
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
      this.interactionActions.delete(requestId);
      this.deferredInteractionActions.delete(action.ref.id);
      const result = failedToolResult(
        call,
        Object.freeze({ owner: opened.owner, kind: "interaction_request", id: requestId, revision: "1" }),
        opened.code,
        opened.message,
        call.createdAt,
        this.now(),
      );
      (await this.commitObservation(action, {
        kind: "interaction",
        owner: opened.owner,
        status: "failed",
        contentDigest: null,
        value: Object.freeze({ code: opened.code }),
        toolResult: result,
      }, [toolResultLowerRef(result)], opened.owner));
      return call.binding.blockingScope !== "none";
    }
    if (call.binding.blockingScope === "none") {
      this.trackModelCallSettlement(opened.completion, action);
      return false;
    }
    await opened.completion;
    (await this.drainInteractionSettlements());
    return true;
  }

  private async continueRetainedInteraction(action: RuntimeRunAction, scope: PendingInteractionRef["blockingScope"]): Promise<boolean> {
    const saved = this.interactions.checkpoint().records.find(record => record.request.parentRunAction?.id === action.ref.id);
    if (!saved) return false;
    const completion = this.interactions.completion(saved.request.ref)!;
    if (scope === "none") this.trackModelCallSettlement(completion, action);
    else {
      await completion;
      await this.drainInteractionSettlements();
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

  private async executeOperation(input: {
    readonly action: RuntimeRunAction;
    readonly operation: OperationRevisionRef;
    readonly request: unknown;
    readonly requestOrigin: OperationRequestOrigin;
    readonly invocationId: string;
    readonly parentInvocation: OperationInvocationRef | null;
    readonly basis: unknown;
    readonly allowedBindings?: readonly ResolvedOperationBinding["kind"][];
    readonly executionFlow?: ExecutionFlowContext;
  }): Promise<OperationResult | null> {
    const flow = new ExecutionFlowPath(OPERATION_EXECUTION_FLOW, input.executionFlow ?? (input.parentInvocation ? this.operationFlows.get(input.parentInvocation.id)?.callContext : undefined) ?? this.actionFlows.get(input.action.ref.id)?.callContext ?? this.flow.context, this.runId, [{owner:"operations",kind:"operation",id:input.invocationId,revision:null}]);
    this.operationFlows.set(input.invocationId, flow);
    let flowDisposition: "returned" | "failed" = "failed";
    const requestRef = {owner: "operations", kind: "contribution", id: `${input.invocationId}:request`, revision: "1"};
    publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "operation_request", runId: this.runId, occurredAt: new Date().toISOString(),
      invocationId: input.invocationId, parentRunActionId: input.action.ref.id, operation: input.operation, request: input.request, requestOrigin: input.requestOrigin});
    const observeResult = async (result: OperationResult): Promise<OperationResult> => {
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "operation_result", runId: this.runId, occurredAt: result.finishedAt, invocationId: input.invocationId, result});
      const registration = findRegisteredOperation(this.dependencies.operations.catalog, input.operation)!;
      const validation = this.dependencies.operations.resultContracts.validate(registration,
        {id: input.invocationId, operation: input.operation}, result);
      const accepted = validation.status === "valid" ? result : rejectOperationResultOutput(result, validation);
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "operation_result_validation", runId: this.runId,
        occurredAt: result.finishedAt, invocationId: input.invocationId, validation, acceptedResult: accepted.ref});
      if (accepted !== result) publishRunExecutionObservation(this.dependencies.executionObserver,
        {kind: "operation_result", runId: this.runId, occurredAt: accepted.finishedAt, invocationId: input.invocationId, result: accepted});
      flow.current?.output({owner: "operations", kind: "contribution", id: accepted.ref.id, revision: null});
      await this.writer.commitState(() => {this.operationResults.set(input.invocationId, accepted); return {};});
      return accepted;
    };
    try {
    const saved = this.operationResults.get(input.invocationId);
    if (saved) {
      if (saved.ref.invocation.operation.revision !== input.operation.revision) throw new TypeError("Retained Operation revision mismatch.");
      flowDisposition = "returned";
      return saved;
    }
    const registrationStep = flow.advance("registration", {invocationId:input.invocationId, origin:input.requestOrigin}, [requestRef]);
    const registration = findRegisteredOperation(
      this.dependencies.operations.catalog,
      input.operation,
    );
    registrationStep.check("registration", registration && !registration.retirement ? "passed" : "not_satisfied");
    if (registration === undefined) {
      registrationStep.check("origin", "not_evaluated", {reason: "operation_not_registered"});
      (await this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_not_registered",
        "The requested Operation revision is not registered.",
      ));
      return null;
    }
    if (registration.retirement !== null) {
      registrationStep.check("origin", "not_evaluated", {reason: "operation_retired"});
      (await this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_retired",
        "The requested Operation revision is retired.",
      ));
      return null;
    }
    registrationStep.check("origin", registration.allowedRequestOrigins.includes(input.requestOrigin) ? "passed" : "not_satisfied");
    if (!registration.allowedRequestOrigins.includes(input.requestOrigin)) {
      (await this.commitRejectedOperation(
        input.action,
        "operation-catalog",
        "operation_request_origin_denied",
        "The requested origin is not admitted for this Operation revision.",
      ));
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
    const bindingStep = flow.advance("binding", {}, [requestRef]);
    const retainedPreparation = this.operationPreparations.get(input.invocationId);
    const resolution = retainedPreparation ? {status: "resolved" as const, binding: retainedPreparation.binding} : await this.dependencies.operations.bindings.resolve({
      operation: registration,
      context,
      request: input.request,
      basis: input.basis,
    });
    const bindingRef = {owner: "operations", kind: "contribution", id: `${input.invocationId}:binding`, revision: "1"};
    publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "operation_binding", runId: this.runId, occurredAt: new Date().toISOString(), invocationId: input.invocationId, resolution});
    bindingStep.output(bindingRef);
    if (resolution.status !== "resolved") {
      bindingStep.check("binding", "not_satisfied", {status: resolution.status, code: resolution.code});
      const failure = this.operationFailureResult(
        registration,
        invocation,
        resolution.status === "invalid" ? "invalid" : "unavailable",
        resolution.status === "invalid" ? resolution.owner : "operation-catalog",
        resolution.code,
        this.now(),
        this.now(),
      );
      const result = resolution.status === "invalid" ? createOperationResult({...failure, status: "invalid",
        failure: {...failure.failure!, message: resolution.message},
        metadata: {effectCertainty: "none", completionExtent: "none"}}) : failure;
      this.emitOperation(registration, resolutionBindingKind(registration), context, result);
      return observeResult(result);
    }
    const binding = resolution.binding;
    bindingStep.check("binding", bindingMatchesResolution(registration, context, binding) ? "passed" : "not_satisfied", {kind:binding.kind});
    if (input.allowedBindings !== undefined && !input.allowedBindings.includes(binding.kind)) {
      return observeResult(this.operationFailureResult(registration, invocation, "invalid", "operation-composition",
        "composite_child_binding_not_allowed", this.now(), this.now()));
    }
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
      return observeResult(result);
    }

    const startedAt = retainedPreparation?.startedAt ?? this.now();
    if (!retainedPreparation) await this.writer.commitState(() => {
      this.operationPreparations.set(invocation.id, {action: input.action, binding, startedAt});
      return {};
    });
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
    flow.advance("execute", {bindingKind:binding.kind, invocationId:invocation.id}, [bindingRef]);
    try {
      const execute = async () => (await this.executeResolvedBinding(
        registration,
        input.action,
        binding,
        context,
        startedAt,
      ));
      result = input.parentInvocation === null
        ? await this.interruptionCoordinator.execute(
            "tool",
            execute,
            this.writer.getSnapshot().deadlineAt,
          )
        : await execute();
    } catch (error) {
      assertExecutionCommitConfirmed(error);
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
    result = await observeResult(result);
    const resultRef = {owner: "operations", kind: "contribution", id: result.ref.id, revision: null};
    flow.advance("result", {status:result.status, resultId:result.ref.id, code:result.failure?.code ?? null}, [resultRef]).output(resultRef);
    flowDisposition = result.status === "failed" ? "failed" : "returned";
    return result;
    } finally { flow.close(flowDisposition); this.operationFlows.delete(input.invocationId); }
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
        const retainedExecution = this.operationExecutions.get(binding.invocation.id);
        if (retainedExecution && retainedExecution.kind !== "internal") throw new TypeError("Operation execution kind changed.");
        if (!retainedExecution) await this.writer.commitState(() => {
          this.operationExecutions.set(binding.invocation.id, {kind: "internal"}); return {};
        });
        const invocation = {
          runId: this.runId,
          parentRunAction: action.ref,
          binding,
          deadlineAt: this.writer.getSnapshot().deadlineAt,
          interruption: context.interruption,
        };
        const result = retainedExecution ? await handler.reconcile?.(invocation) : await handler.execute(invocation);
        if (!result) throw new RunRecoveryError(this.runId, "internal_operation_outcome_unconfirmed", binding.invocation.id);
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
        return (await this.executeComposite(registration, action, binding, context, startedAt));
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
    const retainedExecution = this.operationExecutions.get(binding.invocation.id);
    if (retainedExecution && retainedExecution.kind !== "action") throw new TypeError("Operation execution kind changed.");
    const actionId = retainedExecution?.kind === "action" ? retainedExecution.id : this.id("action");
    if (!retainedExecution) await this.writer.commitState(() => {
      this.operationExecutions.set(binding.invocation.id, {kind: "action", id: actionId}); return {};
    });
    const executionRequest: ActionExecutionRequest = {
      executionFlow: this.operationFlows.get(context.invocation.id)?.callContext ?? this.actionFlows.get(action.ref.id)?.callContext,
      action: Object.freeze({ id: actionId }),
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
    };
    const recovery = this.dependencies.operations.actionRecovery;
    if (retainedExecution && !recovery) throw new RunRecoveryError(this.runId, "action_recovery_owner_unavailable", actionId);
    const recovered = retainedExecution ? await this.actionExecution.recover(executionRequest, recovery!) : null;
    const outcome = !recovered || recovered.status === "no_dispatch_record"
      ? await this.actionExecution.execute(executionRequest) : recovered;
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
    const retainedExecution = this.operationExecutions.get(binding.invocation.id);
    if (retainedExecution && retainedExecution.kind !== "composite") throw new TypeError("Retained Composite execution kind mismatch.");
    const compositeId = retainedExecution?.id ?? this.id("composite");
    let checkpoint: import("@agent-anything/operation-composition/execution").CompositeCommit | null = null;
    if (retainedExecution) {
      if (!this.dependencies.compositeRecovery || !this.dependencies.compositeCommits) {
        throw new RunRecoveryError(this.runId, "composite_reconciliation_unavailable", compositeId);
      }
      checkpoint = await this.dependencies.compositeRecovery.readLatestComposite(compositeId);
      if (checkpoint && checkpoint.runId !== this.runId) throw new TypeError("Retained Composite Run mismatch.");
    } else {
      await this.writer.commitState(() => {
        this.operationExecutions.set(binding.invocation.id, {kind: "composite", id: compositeId});
        return {};
      });
    }
    const pending: PendingRunSubject = this.writer.getSnapshot().pending.find(value => value.kind === "composite" &&
      value.compositeId === compositeId && value.nodeId === "aggregate") ?? Object.freeze({
      kind: "composite",
      compositeId,
      nodeId: "aggregate",
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    if (!this.writer.getSnapshot().pending.some(value => value.kind === "composite" && value.compositeId === compositeId)) {
      await this.addPending(pending);
    }
    const executeChild: import("@agent-anything/operation-composition/execution").CompositeChildExecutionPort["start"] = async child => {
      try {
        const retained = this.writer.getSnapshot().items.flatMap(item => item.payload.kind === "run_action" &&
          item.payload.action.provenance.kind === "trusted_workflow" &&
          item.payload.action.provenance.workflow.invocationId === compositeId &&
          item.payload.action.provenance.nodeRef === child.node.id ? [item.payload.action] : []);
        if (retained.length > 1 || child.instance !== 1) throw new CompositeRecoveryError(compositeId, "child_identity_ambiguous");
        if (!retained[0] && this.writer.getSnapshot().counters.runActions >= this.config.limits.maxActions) {
          return {runAction: null, result: null, failure: {code: "runtime_action_limit_reached",
            message: "Composite child exceeds remaining RunAction capacity.", retryable: false, metadata: {nodeId: child.node.id}}};
        }
        const saved = retained[0];
        if (saved && saved.subject.kind !== "operation") throw new TypeError("Retained Composite child kind mismatch.");
        const invocationId = saved?.subject.kind === "operation" ? saved.subject.invocationId : this.id("operation_invocation");
        if (invocationId === null) throw new CompositeRecoveryError(compositeId, "child_invocation_missing");
        // Materialization is acknowledged before any child preparation or dispatch.
        // Its absence proves that the owner has not started this admitted node.
        const childAction = saved ?? await this.materializeWorkflowRunAction({
          operation: child.node.operation, invocationId, compositeId, nodeId: child.node.id,
        });
        const observation = this.findRunActionObservation(childAction.ref);
        if (observation?.payload.kind === "operation") return {runAction: childAction.ref, result: observation.payload.result};
        const result = observation ? null : await this.executeOperation({
          action: childAction, operation: child.node.operation, request: child.request, requestOrigin: "trusted_workflow",
          invocationId, parentInvocation: binding.invocation, basis: child, allowedBindings: child.node.allowedBindings,
          executionFlow: child.executionFlow,
        });
        if (result === null) {
          const rejected = this.findRunActionObservation(childAction.ref)?.payload;
          return {runAction: childAction.ref, result: null, failure: {
            code: rejected?.kind === "operation_rejected" ? rejected.code : "composite_child_rejected",
            message: rejected?.kind === "operation_rejected" ? rejected.message : "Composite child was rejected before execution.",
            retryable: false, metadata: {nodeId: child.node.id},
          }};
        }
        await this.commitOperationObservation(childAction, {result, toolResult: null});
        return {runAction: childAction.ref, result};
      } catch (cause) {
        if (cause instanceof RunCommitError || cause instanceof ActionRecordCommitError || cause instanceof OperationCommitError) {
          throw new CompositeCommitError(`${compositeId}:child:${child.node.id}`, {cause});
        }
        if (cause instanceof RunRecoveryError || cause instanceof ActionRecoveryError) {
          throw new CompositeRecoveryError(compositeId, cause.code);
        }
        throw cause;
      }
    };
    try {
      const execution = new CompositeExecution(
        compositeId,
        resolved.definition,
        {
          ...resolved.execution,
          ...(this.dependencies.compositeCommits ? {commits: {runId: this.runId, port: this.dependencies.compositeCommits}} : {}),
          ...(checkpoint ? {recovery: {checkpoint, reconcile: async child => {
            const outcome = await executeChild({...child, definition: resolved.definition.ref, instance: child.state.instance});
            return {nodeId: child.node.id, instance: child.state.instance, runAction: outcome.runAction,
              status: outcome.result?.status ?? "invalid", result: outcome.result,
              failure: outcome.result ? outcome.result.failure : outcome.failure};
          }}} : {}),
          executionFlow: {...this.operationFlows.get(context.invocation.id)?.callContext,runId:this.runId},
          now: this.dependencies.now,
          observer: (definition, snapshot) => {
            try { void Promise.resolve(resolved.execution.observer?.(definition, snapshot)).catch(() => {}); } catch {}
            publishRunExecutionObservation(this.dependencies.executionObserver, {
              kind: "composite", runId: this.runId, occurredAt: snapshot.terminal?.finishedAt ?? null,
              parentRunActionId: action.ref.id, definition, snapshot,
            });
          },
          children: {start: executeChild},
        },
      );
      const result = await execution.run(binding.request, context.interruption);
      const output = operationResultFromComposite(
        registration,
        binding,
        result,
        startedAt,
        this.now(),
        this.id("operation_result"),
      );
      await this.removePending(pending, "resolved", null);
      return output;
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      await this.removePending(pending, "failed", null);
      throw error;
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
    (await this.commitDescendantExecutionOutcome(action, call, descendant, startedAt));
  }

  private async commitDescendantExecutionOutcome(
    action: RuntimeRunAction,
    call: ToolCall,
    descendant: DescendantExecutionOutcome,
    startedAt: string,
  ): Promise<void> {
    if (descendant.status === "rejected") {
      (await this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        descendant.operationStatus,
        null,
        operationFailure("agent-runtime", descendant.code),
        startedAt,
        null,
      ));
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
        (await this.commitDescendantProgressObservation(
          action,
          call,
          descendant.progress,
          mapped,
          startedAt,
        ));
      } finally {
        // Terminal transfer cannot remain blocked if Parent-side projection fails.
        managed?.markInitialDelivered();
      }
      return;
    }
    let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      mapped = await this.dependencies.operations.delegation!.resultProjection.project(
        Object.freeze({
          result: descendant.result,
          continuation: descendant.continuation,
        }),
      );
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      (await this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        "failed",
        null,
        operationFailure("agent-runtime", "delegation_result_projection_failed"),
        startedAt,
        descendant.result,
      ));
      return;
    }
    (await this.commitDescendantToolObservation(
      action,
      call,
      descendant.relationId,
      descendant.childRunId,
      mapped.status,
      mapped.output,
      mapped.failure,
      startedAt,
      descendant.result,
    ));
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
      (await this.commitDescendantToolObservation(
        action,
        call,
        null,
        null,
        "invalid",
        null,
        operationFailure("agent-runtime", "descendant_message_invalid"),
        startedAt,
        null,
      ));
      return;
    }
    const active = [...this.childHandles.values()].find(
      (candidate) => candidate.childRunId === request.agent_id,
    );
    if (active !== undefined) {
      if (!sameAgentRef(active.request.childAgent, targetAgent)) {
        (await this.commitDescendantToolObservation(
          action, call, active.relationId, active.childRunId, "invalid", null,
          operationFailure("agent-runtime", "agent_target_incompatible"),
          startedAt, null,
        ));
        return;
      }
      const before = active.handle.getSnapshot();
      const steering = await active.handle.steer({
        commandId: `${call.toolCallId}:steer`,
        expectedRunRevision: before.runRevision,
        instruction: request.prompt,
        attribution: Object.freeze({ origin: "model", actorId: this.activeAgent.id }),
        submittedAt: this.now(),
      });
      if (steering.status === "rejected") {
        (await this.commitDescendantToolObservation(
          action, call, active.relationId, active.childRunId, "unavailable", null,
          operationFailure("agent-runtime", steering.code),
          startedAt, null,
        ));
        return;
      }
      let resumed = false;
      if (before.status === "suspended" && before.suspension !== null) {
        const afterSteering = active.handle.getSnapshot();
        const receipt = await active.handle.resume({
          id: `${call.toolCallId}:resume`,
          expectedRunRevision: afterSteering.runRevision,
          suspension: before.suspension.ref,
          origin: "model",
          reason: "The Parent Agent supplied new steering for this suspended Child Run.",
        });
        if (receipt.status === "rejected") {
          (await this.commitDescendantToolObservation(
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
          ));
          return;
        }
        resumed = true;
      }
      const after = active.handle.getSnapshot();
      (await this.commitDescendantToolObservation(
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
      ));
      return;
    }

    const target = this.continuationRecords.get(request.agent_id);
    if (target === undefined) {
      (await this.commitDescendantToolObservation(
        action, call, null, null, "unavailable", null,
        operationFailure("agent-runtime", "agent_target_unknown"),
        startedAt, null,
      ));
      return;
    }
    if (target.status !== "available") {
      (await this.commitDescendantToolObservation(
        action, call, null, target.correlation.sourceChild.id, "unavailable", null,
        operationFailure("agent-runtime", "agent_target_stale"),
        startedAt, null,
      ));
      return;
    }
    if (
      target.correlation.root.id !== this.lineage.root.id ||
      target.correlation.parent.id !== this.runId ||
      !sameAgentRef(target.correlation.agent, targetAgent)
    ) {
      (await this.commitDescendantToolObservation(
        action, call, null, null, "invalid", null,
        operationFailure("agent-runtime", "agent_target_incompatible"),
        startedAt, null,
      ));
      return;
    }
    const descendant = await this.executeDescendantRun(action, call);
    if (descendant.status === "rejected") {
      const code = isContinuationNotResumableCode(descendant.code)
        ? "agent_target_not_resumable"
        : descendant.code;
      (await this.commitDescendantToolObservation(
        action,
        call,
        descendant.relationId,
        descendant.childRunId,
        descendant.operationStatus,
        null,
        operationFailure("agent-runtime", code),
        startedAt,
        null,
      ));
      return;
    }
    if (descendant.status === "suspended") {
      (await this.commitDescendantExecutionOutcome(action, call, descendant, startedAt));
      return;
    }
    let mapped: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      mapped = await this.dependencies.operations.delegation!.resultProjection.project(
        Object.freeze({
          result: descendant.result,
          continuation: descendant.continuation,
        }),
      );
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      mapped = Object.freeze({
        status: "failed" as const,
        output: null,
        failure: operationFailure(
          "agent-runtime",
          "delegation_result_projection_failed",
        ),
      });
    }
    (await this.commitDescendantToolObservation(
      action,
      call,
      descendant.relationId,
      descendant.childRunId,
      mapped.status,
      mapped.output,
      mapped.failure,
      startedAt,
      descendant.result,
    ));
  }

  private async executeDescendantRun(
    action: RuntimeRunAction,
    call: ToolCall,
    dispatch = this.singleDescendantDispatch(action),
  ): Promise<DescendantExecutionOutcome> {
    const prepared = await this.prepareDescendantRun(action, call, dispatch);
    return prepared.status === "admitted"
      ? (await this.launchAdmittedDescendant(prepared))
      : prepared.status === "restored" ? prepared.outcome : prepared;
  }

  private async prepareDescendantRun(
    action: RuntimeRunAction,
    call: ToolCall,
    dispatch: DescendantDispatchProvenance,
  ): Promise<DescendantPreparationOutcome> {
    const restored = this.restoredDescendantOutcomes.get(action.ref.id);
    if (restored) return {status: "restored", outcome: restored};
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

    const admission = await this.admitDescendantRun({
      executionFlow: {...this.actionFlows.get(action.ref.id)?.callContext, relationship:"spawn"},
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
      : await admission.cancelBeforeLaunch();
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

    const managed = await this.attachDescendant({relation: started.relation, request, dispatch, action,
      handle: started.handle, getTerminalFlowOccurrence: started.getTerminalFlowOccurrence,
      resourceSettlement: started.resourceSettlement, modelInteractionSeed: continuationModelInteractionSeed}, false);
    return managed.initialBoundary;
  }

  private async attachDescendant(route: RestoredDescendantRoute, restored: boolean): Promise<ManagedActiveDescendant> {
    const {relation, request, dispatch, action, handle: child} = route;
    const relationId = relation.ref.id;
    const composition = this.dependencies.operations.delegation;
    if (!composition) throw new RunRecoveryError(this.runId, "delegation_binding_unavailable", relationId);
    const pending: PendingRunSubject = this.writer.getSnapshot().pending.find(value => value.kind === "descendant_run" &&
      value.relationId === relationId && value.childRunId === child.runId) ?? Object.freeze({
      kind: "descendant_run",
      relationId,
      childRunId: child.runId,
      branchId: action.ref.id,
      required: true,
      openedInRunRevision: this.writer.getSnapshot().revision,
    });

    let resolveInitialBoundary!: (outcome: DescendantExecutionOutcome) => void;
    let rejectInitialBoundary!: (error: unknown) => void;
    let initialBoundaryResolved = false;
    const initialBoundary = new Promise<DescendantExecutionOutcome>((resolve, reject) => {
      resolveInitialBoundary = resolve;
      rejectInitialBoundary = reject;
    });
    void initialBoundary.catch(() => {});
    let resolveInitialDelivery!: () => void;
    let initialDeliveryResolved = false;
    const initialDelivery = new Promise<void>((resolve) => {
      resolveInitialDelivery = resolve;
    });
    const managed: ManagedActiveDescendant = {
      relationId,
      relation,
      request,
      childRunId: child.runId,
      handle: child,
      getTerminalFlowOccurrence: route.getTerminalFlowOccurrence,
      action,
      composition,
      pending,
      resourceSettlement: route.resourceSettlement,
      continuationModelInteractionSeed: route.modelInteractionSeed,
      initialBoundary,
      resolveInitialBoundary(outcome) {
        if (initialBoundaryResolved) return;
        initialBoundaryResolved = true;
        resolveInitialBoundary(outcome);
      },
      rejectInitialBoundary(error) {
        if (initialBoundaryResolved) return;
        initialBoundaryResolved = true;
        rejectInitialBoundary(error);
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
    if (restored) {
      const observations = this.writer.getSnapshot().items.flatMap(item => item.payload.kind === "observation" &&
        item.payload.observation.runAction.id === action.ref.id ? [item.payload.observation] : []);
      for (const observation of observations) {
        if (observation.payload.kind !== "descendant_progress") continue;
        const progress = observation.payload.progress;
        managed.reportedSuspensions.add(`${progress.suspension.ref.id}@${progress.suspension.ref.revision}:${progress.childRunRevision}`);
      }
      const initial = observations.find(observation => observation.payload.kind === "descendant_run" ||
        (observation.payload.kind === "descendant_progress" && observation.payload.toolResult !== null));
      if (initial) {
        managed.initialBoundaryKind = initial.payload.kind === "descendant_progress" ? "suspended" : "terminal";
        managed.markInitialDelivered();
      }
    }
    this.childHandles.set(relationId, managed);
    if (!this.writer.getSnapshot().pending.some(value => value.kind === "descendant_run" && value.relationId === relationId)) {
      await this.addPending(pending);
    }
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
    const settlement = child.wait().then(
      async (result) => (await this.finalizeManagedDescendant(managed, result, dispatch)),
      async (error) => {
        assertExecutionCommitConfirmed(error);
        await this.failManagedDescendant(managed, "delegation_result_invalid");
      },
    );
    this.descendantSettlementWaits.add(settlement);
    void settlement.then(
      () => { this.descendantSettlementWaits.delete(settlement); },
      error => {
        this.descendantSettlementWaits.delete(settlement);
        this.failDescendantDelivery(managed, error);
      },
    );
    return managed;
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
    void managed.initialDelivery.then(async () => {
      if (
        managed.transferState !== "pending" ||
        managed.handle.getResult() !== null ||
        this.terminalResult !== null
      ) return;
      (await this.commitAsyncDescendantProgress(managed, progress));
    }).catch(error => this.failDescendantDelivery(managed, error));
  }

  private failDescendantDelivery(managed: ManagedActiveDescendant, cause: unknown): void {
    const error = cause instanceof RunCommitError || cause instanceof ActionRecordCommitError || cause instanceof CompositeCommitError
      ? cause : new RunCommitError(`${this.runId}:descendant:${managed.relationId}`, {cause});
    managed.rejectInitialBoundary(error);
    this.writer.fail(error);
    this.interruptionCoordinator.fail(error);
    this.suspendedWaiter?.resolve();
    managed.unsubscribe();
  }

  private async finalizeManagedDescendant(
    managed: ManagedActiveDescendant,
    result: RunResult,
    dispatch: DescendantDispatchProvenance,
  ): Promise<void> {
    const flow = new ExecutionFlowPath(DESCENDANT_TRANSFER_EXECUTION_FLOW, {observer:this.flow.invocation.context.observer}, this.runId, [
      {owner:"runtime",kind:"run",id:managed.childRunId,runId:managed.childRunId,revision:null},
      {owner:"runtime",kind:"action",id:managed.action.ref.id,revision:null},
    ]);
    const received = flow.advance("receive", {childRunId:managed.childRunId,childStatus:result.status,relationId:managed.relationId});
    const childTerminal = managed.getTerminalFlowOccurrence();
    if (childTerminal !== null) {
      flow.link(childTerminal, received.ref, "join", null, {
        owner: "runtime", kind: "descendant_relation", id: managed.relationId, revision: null,
      });
    }
    try {
    let resourceSettlement: RunTreeResourceSettlement;
    let delegationResult: DelegationResult;
    const retained = this.descendantTransfers.get(managed.childRunId);
    if (retained?.status === "failed") {
      await this.failManagedDescendant(managed, retained.code!);
      flow.close("failed");
      return;
    }
    try {
      flow.advance("account");
      resourceSettlement = await managed.resourceSettlement;
      flow.advance("project");
      const narrative = retained?.result ? null : managed.composition.narrativeProjection.project({
        request: managed.request,
        childResult: result,
      });
      delegationResult = retained?.result ?? constructDelegationResult({
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
      publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "descendant_result", runId: this.runId, occurredAt: delegationResult.createdAt, parentRunActionId: managed.action.ref.id, raw: result, projected: delegationResult });
      flow.current?.check("result_projection","passed",{resultId:delegationResult.ref.id});
      flow.current?.output({owner:"agent-runtime",kind:"contribution",id:delegationResult.ref.id,revision:delegationResult.ref.revision});
    } catch {
      if (flow.current) flow.current.end("failed");
      flow.close("failed");
      (await this.failManagedDescendant(managed, "delegation_result_invalid"));
      return;
    }

    flow.advance("retain", {}, [{owner:"agent-runtime",kind:"contribution",id:delegationResult.ref.id,revision:delegationResult.ref.revision}]);
    this.settledDelegations.set(delegationResult.ref.id, Object.freeze({
      result: delegationResult,
    }));
    const continuation = retained ? [...this.continuationRecords.values()].find(value =>
      value.sourceResult.ref.id === delegationResult.ref.id)?.correlation ?? null : this.retainDescendantContinuation(
      managed.request,
      delegationResult,
      result,
      managed.continuationModelInteractionSeed,
    );
    if (!retained) {
      this.descendantTransfers.set(managed.childRunId, {childRunId: managed.childRunId,
        relationId: managed.relationId, action: managed.action, result: delegationResult, status: "settled", code: null});
      if (this.treeCommits) await this.writer.commitState(() => ({}));
      else this.runTree.settleDescendantTransfer(managed.childRunId, "settled");
    }
    managed.transferState = "settled";
    this.emitDescendantSettled(managed, delegationResult, dispatch);
    const outcome: DescendantExecutionOutcome = Object.freeze({
      status: "settled" as const,
      relationId: managed.relationId,
      childRunId: managed.childRunId,
      result: delegationResult,
      continuation: continuation?.ref ?? null,
      resourceSettlement,
    });
    flow.advance("deliver", {initialDelivery:managed.initialBoundaryKind === "pending"});
    if (managed.initialBoundaryKind === "pending") {
      managed.initialBoundaryKind = "terminal";
      managed.resolveInitialBoundary(outcome);
    } else if (managed.initialBoundaryKind === "suspended") {
      await managed.initialDelivery;
      if (this.terminalResult === null) {
        (await this.commitDescendantResultTransfer(managed, delegationResult, continuation?.ref ?? null));
      }
    }
    (await this.cleanupManagedDescendant(managed, "resolved", delegationResult.ref.id));
    flow.advance("settle", {resultId:delegationResult.ref.id});
    flow.close("returned", undefined, [{owner:"agent-runtime",kind:"contribution",id:delegationResult.ref.id,revision:delegationResult.ref.revision}]);
    } catch (error) {flow.close("failed");throw error;}
  }

  private async failManagedDescendant(
    managed: ManagedActiveDescendant,
    code: "delegation_result_invalid",
  ): Promise<void> {
    if (managed.transferState !== "pending") return;
    const childNode = this.runTree.getSnapshot().nodes.find(
      (node) => node.runId === managed.childRunId,
    );
    if (childNode?.resultTransfer === "pending") {
      this.descendantTransfers.set(managed.childRunId, {childRunId: managed.childRunId,
        relationId: managed.relationId, action: managed.action, result: null, status: "failed", code});
      if (this.treeCommits) await this.writer.commitState(() => ({}));
      else this.runTree.settleDescendantTransfer(managed.childRunId, "failed");
    }
    managed.transferState = "failed";
    if (managed.initialBoundaryKind === "pending") {
      managed.initialBoundaryKind = "terminal";
      managed.resolveInitialBoundary(rejectedDescendant(
        managed.relationId,
        code,
        managed.childRunId,
        "failed",
      ));
    } else {
      await managed.initialDelivery;
      if (this.terminalResult === null) {
        await this.commitDescendantNotification(managed.action, {
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
      }
    }
    (await this.cleanupManagedDescendant(managed, "failed", null));
  }

  private async cleanupManagedDescendant(
    managed: ManagedActiveDescendant,
    transition: "resolved" | "failed",
    recordRef: string | null,
  ): Promise<void> {
    managed.unsubscribe();
    (await this.removePending(managed.pending, transition, recordRef));
    if (this.childHandles.get(managed.relationId) === managed) {
      this.childHandles.delete(managed.relationId);
    }
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

  private async commitDescendantProgressObservation(
    action: RuntimeRunAction,
    call: ToolCall,
    progress: DescendantProgress,
    projected: import("./RunnerDependencies.js").DescendantOperationOutcome,
    startedAt: string,
  ): Promise<void> {
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
    (await this.commitObservation(action, {
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
    ], "agent-runtime"));
  }

  private async commitAsyncDescendantProgress(
    managed: ManagedActiveDescendant,
    progress: DescendantProgress,
  ): Promise<void> {
    let output: unknown = null;
    try {
      output = managed.composition.progressProjection.project(
        Object.freeze({ progress }),
      ).output;
    } catch {
      // The Core progress record remains authoritative even if Product projection fails.
    }
    (await this.commitDescendantNotification(managed.action, {
      kind: "descendant_progress",
      progress,
      output,
      toolResult: null,
    }, [{
      owner: "agent-runtime",
      kind: "descendant_progress",
      id: progress.childRun.id,
      revision: String(progress.childRunRevision),
    }], "agent-runtime"));
  }

  private async commitDescendantResultTransfer(
    managed: ManagedActiveDescendant,
    result: DelegationResult,
    continuation: Readonly<{ readonly id: string; readonly revision: string }> | null,
  ): Promise<void> {
    if (this.writer.getSnapshot().items.some(item => item.payload.kind === "observation" &&
        item.payload.observation.payload.kind === "descendant_result_transfer" &&
        item.payload.observation.payload.childRunId === managed.childRunId)) return;
    let projected: import("./RunnerDependencies.js").DescendantOperationOutcome;
    try {
      projected = await managed.composition.resultProjection.project({ result, continuation });
    } catch (error) {
      assertExecutionCommitConfirmed(error);
      projected = Object.freeze({
        status: "failed" as const,
        output: null,
        failure: operationFailure(
          "agent-runtime",
          "delegation_result_projection_failed",
        ),
      });
    }
    (await this.commitDescendantNotification(managed.action, {
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
    }], "agent-runtime"));
  }

  private async commitDescendantNotification(
    action: RuntimeRunAction,
    payload: Extract<RunObservation["payload"], {kind: "descendant_progress" | "descendant_result_transfer"}>,
    lowerRefs: RunObservation["lowerRefs"],
    owner: string,
  ): Promise<void> {
    await this.commitObservation(action, payload, lowerRefs, owner, true);
  }

  private async commitDescendantToolObservation(
    action: RuntimeRunAction,
    call: ToolCall,
    relationId: string | null,
    childRunId: string | null,
    status: import("./RunnerDependencies.js").DescendantOperationOutcome["status"],
    output: unknown,
    failure: OperationFailure | null,
    startedAt: string,
    delegationResult: DelegationResult | null,
  ): Promise<void> {
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
    (await this.commitObservation(action, {
      kind: "descendant_run",
      childRunId,
      status,
      output,
      failure,
      toolResult,
      result: delegationResult,
    }, [
      {
        owner: "agent-runtime",
        kind: delegationResult === null ? "descendant_run_result" : "delegation_result",
        id: delegationResult?.ref.id ?? childRunId ?? relationId ?? call.toolCallId,
        revision: delegationResult?.ref.revision ?? settlement.revision,
      },
      toolResultLowerRef(toolResult),
    ], "agent-runtime"));
  }

  private async commitOperationObservation(
    action: RuntimeRunAction,
    outcome: OperationExecutionOutcome,
  ): Promise<void> {
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
    (await this.commitObservation(action, {
      kind: "operation",
      result: outcome.result,
      toolResult: outcome.toolResult,
    }, lowerRefs, outcome.result.semanticOwner));
  }

  private async commitRejectedOperation(
    action: RuntimeRunAction,
    owner: string,
    code: string,
    message: string,
  ): Promise<void> {
    (await this.commitObservation(action, {
      kind: "operation_rejected",
      owner,
      code,
      message,
    }, [], owner));
  }

  private async commitInteractionObservation(
    action: RuntimeRunAction,
    settlement: RuntimeInteractionSettlement,
    call: ToolCall | null,
  ): Promise<void> {
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
      (await this.commitObservation(action, {
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
      ], settlement.outcome.request.protocol.owner));
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
    (await this.commitObservation(action, {
      kind: "interaction",
      owner: settlement.owner,
      status: settlement.status,
      contentDigest: null,
      value: Object.freeze({ code: settlement.code }),
      toolResult,
    }, toolResult === null ? [] : [toolResultLowerRef(toolResult)], settlement.owner));
  }

  private async commitObservation(
    action: RuntimeRunAction,
    payload: RunObservation["payload"],
    lowerRefs: RunObservation["lowerRefs"],
    owner: string,
    notifyModel = false,
  ): Promise<RunObservation> {
    return this.writer.transaction(state => {
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
    const contribution = createObservationContextContribution({
      id: this.id("context_contribution"),
      observation,
    });
    const context = this.applyContextContributions(
        state.context,
        Object.freeze([contribution]),
        createObservationContextAdmissionProfile(observation.owner),
        "observation_committed",
        observation.id,
      );
    const notifications: import("../run/RunItem.js").RunItemPayload<TOutput>[] = [];
    if (notifyModel) {
      if (payload.kind !== "descendant_progress" && payload.kind !== "descendant_result_transfer") {
        throw new TypeError("This observation has no descendant notification contract.");
      }
      const projected = projectObservationSettlement(observation);
      const notification = this.inputNotifications.admitOwned(this.runId, {
        source: {owner, kind: payload.kind, id: observation.id, revision: "1"}, occurredAt: observation.createdAt,
        data: {settlement: projected.settlement, presentation: projected.presentation, content: projected.content},
      }, this.dependencies.contextProjection.maxContributionPayloadBytes,
      modelSettlement(projected.settlement, undefined, descendantDeliveryFacts(payload)));
      notifications.push({kind: "input_notification", notification});
    }
    return {payloads: [{kind: "observation", observation}, ...notifications], value: {observation, context}, patch: {
      context,
      counters: Object.freeze({
        ...state.counters,
        observations: sequence,
      }),
    }};
    }).then(({observation, context}) => {
      this.publishObservationFlow(action, observation, context);
      return observation;
    });
  }

  private publishObservationFlow(action: RuntimeRunAction, observation: RunObservation, context: ActiveContext): void {
    const reference = {owner: observation.owner, kind: "contribution", id: observation.id, revision: "1"};
    const flow = this.actionFlows.get(action.ref.id);
    flow?.current?.output(reference);
    flow?.advance("observation", {kind: observation.kind, owner: observation.owner}, [reference]).output(
      reference, {owner: "context", kind: "context", id: context.ref.id, revision: String(context.ref.version)});
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
      this.contextPayloadBytes += admittedPayloadBytes;
      if (!this.treeCommits) this.recordTreeResources({
        contextBytes: Object.freeze({
          status: "measured" as const,
          value: admittedPayloadBytes,
        }),
      });
    }
    this.pendingContextTransitions.set(transition.id, transition);
    return next;
  }

  private async openPendingInteraction(pending: PendingInteractionRef, parentRunAction: RunActionRef | null): Promise<void> {
    const value: PendingRunSubject = Object.freeze({
      kind: "interaction",
      interaction: pending,
      branchId: parentRunAction?.id ?? pending.request.id,
      required: pending.blockingScope !== "none",
      openedInRunRevision: this.writer.getSnapshot().revision,
    });
    (await this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending: value,
      recordRef: pending.request.id,
    }, (current) => {
      const nextPending = Object.freeze([...current.pending, value]);
      return Object.freeze({
        pending: nextPending,
        status: this.statusAfterPendingChange(current, nextPending),
      });
    }));
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

  private async settlePendingInteraction(
    pending: PendingInteractionRef,
    terminal: InteractionTerminalRecord,
    settlement: RuntimeInteractionSettlement,
  ): Promise<void> {
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
    (await this.writer.commit({
      kind: "pending_transition",
      transition,
      pending: current,
      recordRef,
    }, (snapshot) => {
      const nextPending = Object.freeze(snapshot.pending.filter((candidate) => candidate !== current));
      return Object.freeze({
        pending: nextPending,
        status: this.statusAfterPendingChange(snapshot, nextPending),
      });
    }));
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
    const key = pending.request.id;
    if (this.deliveredInteractions.has(key) || this.interactionSettlements.some(item => item.pending.request.id === key)) return;
    const context = this.interactionActions.get(key) ?? null;
    this.interactionSettlements.push(Object.freeze({
      pending,
      terminal,
      settlement,
      action: context?.action ?? null,
      toolCall: context?.toolCall ?? null,
    }));
  }

  private async drainInteractionSettlements(): Promise<number> {
    // The queue is a wakeup optimization. The acknowledged owner record is the source.
    for (const record of this.interactions.settledRecords()) {
      this.queueInteractionSettlement(record.execution.pending, record.execution.terminal!, record.settlement!);
    }
    let count = 0;
    while (this.interactionSettlements.length > 0) {
      const queued = this.interactionSettlements[0]!;
      if (queued.pending.request.protocol.owner === "permission" && queued.pending.request.protocol.kind === "approval") {
        const requestId = queued.pending.request.id;
        if (this.runTree.isApprovalActive(requestId)) await this.changeTree(tree => {
          if (tree.isApprovalActive(requestId)) tree.settleApproval(requestId,
            classifyApprovalSettlement(queued.settlement, this.config.permissions.reviewer?.kind === "auto_review"));
        });
      }
      (await this.settlePendingInteraction(queued.pending, queued.terminal, queued.settlement));
      const alreadyObserved = queued.action !== null && this.writer.getSnapshot().items.some(item =>
        item.payload.kind === "observation" && item.payload.observation.runAction.id === queued.action!.ref.id &&
        item.payload.observation.payload.kind === "interaction");
      if (queued.action !== null && !alreadyObserved) {
        (await this.commitInteractionObservation(
          queued.action,
          queued.settlement,
          queued.toolCall,
        ));
      }
      this.deliveredInteractions.add(queued.pending.request.id);
      this.interactionActions.delete(queued.pending.request.id);
      await this.writer.commitState(() => ({}));
      this.interactionSettlements.shift();
      count += 1;
    }
    return count;
  }

  private trackModelCallSettlement(
    completion: Promise<RuntimeInteractionSettlement>,
    action: RuntimeRunAction,
  ): void {
    this.deferredInteractionActions.set(action.ref.id, action);
    let wait!: Promise<void>;
    wait = completion.then(() => undefined).finally(() => {
      this.modelCallSettlementWaits.delete(wait);
    });
    this.modelCallSettlementWaits.add(wait);
  }

  private async waitForModelCallSettlements(): Promise<void> {
    await Promise.all([...this.modelCallSettlementWaits]);
    (await this.drainInteractionSettlements());
    for (const action of this.deferredInteractionActions.values()) {
      if (action.provenance.kind !== "controller") continue;
      const call = this.findModelToolCall(action.provenance.modelCallRef);
      if (call !== null && !this.hasModelCallSettlement(call)) (await this.commitModelCallSettlement(action, null));
    }
    this.deferredInteractionActions.clear();
  }

  private async drainSteering(
    disposition: "apply" | "cancelled" | "run_settled",
  ): Promise<number> {
    if (this.steeringQueue.length === 0) return 0;
    const queued = [...this.steeringQueue];
    const latest = queued.at(-1)!;
    for (const command of queued) {
      const status: RunSteeringApplication["status"] = disposition === "apply"
        ? command === latest ? "applied" : "superseded"
        : disposition;
      const application: Omit<RunSteeringApplication, "appliedInRunRevision"> = Object.freeze({
        command,
        status,
        supersededByCommandId: status === "superseded" ? latest.commandId : null,
        reasonCode: status === "cancelled"
          ? "run_cancellation_requested"
          : status === "run_settled"
            ? "run_settled_before_application"
            : null,
      });
      await this.writer.transaction(state => {
      const position = this.steeringQueue.findIndex(item => item.commandId === command.commandId);
      if (position < 0) return {value: null};
      const entry = status === "applied" ? this.inputNotifications.admitOwned(this.runId, {
        source: {owner: "agent-runtime", kind: "steering", id: `${this.runId}:steering:${command.commandId}`, revision: String(command.acceptedRunRevision)},
        occurredAt: command.submittedAt, data: command,
        interpretation: {kind: "steering", commandId: command.commandId},
      }, this.dependencies.contextProjection.maxContributionPayloadBytes) : null;
      this.steeringQueue.splice(position, 1);
      return {value: entry, payloads: [{
        kind: "state_transition",
        transition: "steering",
        steering: {...application, appliedInRunRevision: state.revision + 1},
      }, ...(entry === null ? [] : [{kind: "input_notification" as const, notification: entry}])], patch: status === "applied"
        ? Object.freeze({plan: null})
        : Object.freeze({})};
      });
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

  private async addPending(pending: PendingRunSubject): Promise<void> {
    (await this.writer.commit({
      kind: "pending_transition",
      transition: "opened",
      pending,
      recordRef: null,
    }, (current) => {
      const next = Object.freeze([...current.pending, pending]);
      return Object.freeze({ pending: next, status: this.statusAfterPendingChange(current, next) });
    }));
  }

  private async removePending(
    pending: PendingRunSubject,
    transition: "resolved" | "cancelled" | "failed" | "invalidated" | "expired",
    recordRef: string | null,
  ): Promise<void> {
    const expected = projectPendingRunSubject(pending);
    await this.writer.transaction(state => {
      const recorded = state.pending.find(candidate => {
        const actual = projectPendingRunSubject(candidate);
        return actual.kind === expected.kind && actual.owner === expected.owner && actual.subjectId === expected.subjectId &&
          actual.revision === expected.revision && actual.branchId === expected.branchId;
      });
      if (!recorded) return {value: undefined};
      const next = Object.freeze(state.pending.filter(candidate => candidate !== recorded));
      return {value: undefined, payloads: [{kind: "pending_transition", transition, pending: recorded, recordRef}],
        patch: {pending: next, status: this.statusAfterPendingChange(state, next)}};
    });
  }

  private statusAfterPendingChange(state: RunState<TOutput>, pending: readonly PendingRunSubject[], settledAction?: string): RunState["status"] {
    const blocked = new Set(pending.filter(item => item.required).map(item => item.branchId));
    const settled = new Set(state.items.flatMap(item => item.payload.kind === "observation"
      ? [item.payload.observation.runAction.id] : []));
    if (settledAction !== undefined) settled.add(settledAction);
    const completedCalls = new Set(state.items.flatMap(item => item.payload.kind === "model_call_settlement"
      ? [modelCallRefKey(item.payload.result.modelCallRef)] : []));
    const progressable = state.items.flatMap(item => {
      if (item.payload.kind !== "run_action") return [];
      const action = item.payload.action;
      if (settled.has(action.ref.id) || blocked.has(action.ref.id)) return [];
      if (action.provenance.kind === "controller" && completedCalls.has(modelCallRefKey(action.provenance.modelCallRef))) return [];
      return [action.ref.id];
    });
    for (const [id, scope] of this.retryScopes) if (!scope.isWaiting) progressable.push(id);
    const runBlocked = pending.some(item => item.kind === "interaction" && item.interaction.blockingScope === "run");
    return deriveRunStatusAfterPendingChange(state.status, pending, runBlocked ? [] : progressable);
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
        const actionFingerprint = input.assessment.requirement.subject.actionFingerprint;
        const retainedRequests = this.interactions.checkpoint().records.filter(record =>
          record.request.ref.protocol.owner === "permission" && record.request.ref.protocol.kind === "approval" &&
          record.request.ref.subject.id === input.action.id &&
          record.request.parentRunAction?.id === input.parentRunAction!.id &&
          !this.writer.getSnapshot().permission.actionCoverage.some(coverage =>
            coverage.sourceRequestId === record.request.ref.id && coverage.status === "consumed"));
        if (retainedRequests.length > 1 || retainedRequests.some(record => record.request.ref.subject.revision !== actionFingerprint)) {
          throw new RunRecoveryError(this.runId, "approval_preparation_mismatch", input.action.id);
        }
        const retained = retainedRequests[0];
        const requestId = retained?.request.ref.id ?? this.id("interaction_request", this.nextInteractionRequest++);
        const operationFingerprint = await approvalOperationFingerprint({
          requirement: input.assessment.requirement,
          workspace: this.config.workspace,
          permissions: this.config.permissions,
        });
        const authorityBasis = this.runTree.captureAuthorityBasis(this.runId);
        const admission = retained ? {status: "accepted" as const} : await this.changeTree(tree => tree.admitApproval({
          requestId,
          runId: this.runId,
          actionId: input.action.id,
          authorityRevision: authorityBasis.authorityRevision,
          workspaceId: this.config.workspace?.primary.id ?? null,
          environmentId: this.config.permissions.permissionProfile.environmentId,
          operationFingerprint,
        }));
        if (admission.status === "limit_exceeded") {
          return Object.freeze({
            status: "limit_exceeded" as const,
            code: admission.code,
            detail: admission.detail,
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
        const settleApproval = async (
          kind: import("./RunTreeApprovalAccount.js").RunTreeApprovalSettlementKind,
        ): Promise<void> => {
          if (settled) return;
          settled = true;
          if (this.runTree.isApprovalActive(requestId)) await this.changeTree(tree => {
            if (tree.isApprovalActive(requestId)) tree.settleApproval(requestId, kind);
          });
        };
        try {
        const pendingVersion = 1;
        const createdAt = this.now();
        const opened = retained ? {status: "opened" as const, pending: retained.execution.pending,
          envelope: {presentation: retained.request.presentation},
          completion: this.interactions.completion(retained.request.ref)!} : await this.interactions.open({
          requestId,
          protocol: APPROVAL_INTERACTION_PROTOCOL,
          executionFlow: input.parentRunAction === null ? undefined : this.actionFlows.get(input.parentRunAction.id)?.callContext,
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
        if (reviewer.kind === "auto_review" && (!retained || retained.submission === null && retained.settlement === null)) {
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
            await this.interactions.fail(opened.pending.request, "permission", reviewResult.failure.code);
            reviewerFailed = true;
          } else if (reviewResult.kind === "cancelled") {
            settlementKind = "interrupted";
            await this.interactions.invalidate(opened.pending.request, "approval_review_cancelled");
          } else {
            await this.interactions.submit({
              request: opened.pending.request,
              submissionId: reviewResult.outcome.submission.submissionId,
              contentDigest: await approvalSubmissionDigest(reviewResult.outcome.submission),
              payload: reviewResult.outcome.submission,
              receivedAt: this.now(),
            });
          }
        }
        const settlement = await opened.completion;
        (await this.drainInteractionSettlements());
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
          await settleApproval(settlementKind);
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
    const immediate = await this.writer.transaction<ReturnType<typeof applyImmediateApprovalAuthority>>(state => {
      const value = applyImmediateApprovalAuthority({permission: state.permission, decision: resolution.decision});
      return value.status === "applied" ? {value, payloads: [], patch: {permission: value.permission}} : {value};
    });
    if (immediate.status === "applied") {
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
      await this.writer.commitState(state => {
      const permission = result.owner === "permission"
        ? applyCommittedSessionAuthority({
            permission: state.permission,
            record: result.record as import("@agent-anything/permission").SessionAuthorityRecord,
          })
        : applyCommittedPolicyAmendment({
            permission: state.permission,
            record: result.record as import("@agent-anything/governance").AppliedPolicyAmendmentRecord,
          });
      return {permission};
      });
    }
    return result.application;
  }

  private async consumeApprovalCoverage(coverageId: string): Promise<boolean> {
    return this.writer.transaction(state => {
    const current = state.permission;
    const coverage = current.actionCoverage.find((candidate) => candidate.id === coverageId);
    if (coverage === undefined) return {value: false};
    const result = consumeActionApprovalCoverage({
      permission: current,
      coverageId,
      runId: coverage.runId,
      actionId: coverage.actionId,
      actionFingerprint: coverage.actionFingerprint,
    });
    if (result.status !== "consumed") return {value: false};
    return {value: true, payloads: [], patch: {permission: result.permission}};
    });
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

  private async enterCancelling(request: import("../run/index.js").RunCancellationRequest): Promise<void> {
    const state = this.writer.getSnapshot();
    if (!isActiveStatus(state.status)) return;
    const summary = toRunCancellationSummary(request);
    (await this.writer.commit({
      kind: "cancellation_transition",
      transition: "requested",
      cancellation: summary,
    }, () => Object.freeze({
      status: "cancelling" as const,
      cancellationRequest: request,
    })));
    await this.interactions.cancelAll(request.id);
    const waiter = this.suspendedWaiter;
    this.suspendedWaiter = null;
    waiter?.resolve();
  }

  private async settle(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    if (this.terminalResult !== null) return this.terminalResult;
    if (this.settlementPromise !== null) return this.settlementPromise;
    this.settling = true;
    this.settlementPromise = Promise.resolve().then(async () => (await this.performSettlement(candidate)));
    return this.settlementPromise;
  }

  private async settleCancelledDescendants(): Promise<void> {
    // Recovery cancellation bypasses decision execution, but not admitted Child delivery.
    await Promise.all(this.restoredDescendants.map(async route => {
      const call = this.operationCalls.get(route.action.ref.id);
      if (!call) return;
      if (this.findRunActionObservation(route.action.ref) === null) {
        const outcome = await this.restoredDescendantOutcomes.get(route.action.ref.id)!;
        await this.commitDescendantExecutionOutcome(route.action, call, outcome, call.createdAt);
      }
      await this.commitModelCallSettlement(route.action, null);
    }));
    // Child terminal state alone does not include its Parent-owned transfer and cleanup.
    await Promise.all([...this.descendantSettlementWaits]);
    await this.waitForModelCallSettlements();
  }

  private async performSettlement(candidate: TerminalCandidate<TOutput>): Promise<RunResult<TOutput>> {
    if (!this.finalizationCheckpoint) await this.writer.commitState(() => {
      this.finalizationCheckpoint = {candidate, startedAt: this.now(),
        cancellation: this.config.cancellation.context.request ? toRunCancellationSummary(this.config.cancellation.context.request) : null,
        finalizers: (this.dependencies.resourceFinalizers ?? []).map(finalizer => ({binding: finalizer.binding ?? null, status: "not_started", failure: null}))};
      return {};
    });
    await this.interruptionCoordinator.flush();
    const finalizerStep = this.flow.enter("finalizers", {candidate: candidate.status});
    (await this.drainSteering(candidate.status === "cancelled" ? "cancelled" : "run_settled"));
    await this.interactions.close();
    (await this.drainInteractionSettlements());
    (await this.settleCompletionCall(candidate.status === "cancelled" ? "cancelled" : "invalidated",
      candidate.status === "failed" ? candidate.failure.failure.code : "run_terminated_before_completion_acceptance"));
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
        (await this.writer.commit({
          kind: "state_transition",
          transition: "plan",
          previousRevision: stateBeforeFinalization.plan.version,
          plan: projectPlan(abandoned.plan),
        }, () => Object.freeze({ plan: abandoned.plan })));
      }
    }

    const finalization = createRunFinalizationContext({
      runId: this.runId,
      cancellation: this.finalizationCheckpoint!.cancellation,
      timeoutMs: this.config.cancellationLimits.finalizationTimeoutMs,
      startedAt: this.finalizationCheckpoint!.startedAt,
      currentAt: this.now(),
    });
    try {
      const resourceFailures = await Promise.all(
        (this.dependencies.resourceFinalizers ?? []).map(async (finalizer, index) => {
          const retained = this.finalizationCheckpoint!.finalizers[index]!;
          if (retained.status === "settled") return retained.failure;
          const recovering = retained.status === "pending";
          if (this.restored && retained.binding === null) throw new RunRecoveryError(this.runId, "resource_finalizer_binding_unavailable", String(index));
          if (!recovering) await this.updateFinalizer(index, {status: "pending", failure: null});
          let failure: RunFailureCause | null;
          try {
            failure = recovering ? finalizer.reconcile
              ? await finalizer.reconcile(finalization.context)
              : runtimeFailure("runtime_resource_finalization_unconfirmed", "Interrupted resource cleanup has no reconciliation implementation.", {finalizer: retained.binding?.id ?? index})
              : await finalizer.finalize(finalization.context);
          } catch (error) {
            assertExecutionCommitConfirmed(error);
            failure = runtimeFailure(
              "runtime_resource_finalization_failed",
              "A required Run resource finalizer failed.",
              {},
            );
          }
          await this.updateFinalizer(index, {status: "settled", failure});
          return failure;
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
      finalizerStep.check("required_finalizers", failures.length ? "error" : "passed", {failureCount: failures.length, finalizerCount: this.dependencies.resourceFinalizers?.length ?? 0});
      if (failures.length > 0) {
        terminal = terminal.status === "completed"
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

    if (this.config.cancellation.context.request !== null) {
      try {
        await this.settleCancelledDescendants();
        finalizerStep.check("descendant_settlement", "passed", {pendingTransfers: this.descendantSettlementWaits.size});
      } catch (error) {
        finalizerStep.check("descendant_settlement", "error", {settlementConfirmed: false});
        throw error;
      }
    } else {
      finalizerStep.check("descendant_settlement", "not_evaluated", {reason: "not_cancellation"});
    }

    if (this.resourceFailure !== null) {
      const resource = this.resourceFailureCandidate(this.resourceFailure);
      terminal = terminal.status === "completed"
        ? resource
        : this.appendTerminalFailures(
            terminal,
            Object.freeze([resource.failure]),
            "terminalization_failure",
          );
    }
    const stateBeforeTerminal = this.writer.getSnapshot();
    const resultAccountingTree = this.treeCommits ? RunTreeExecution.restore(this.runTree.checkpoint(), () => this.now()) : this.runTree;
    const resultUsage = {
      resultBytes: Object.freeze({
        status: "measured" as const,
        value: measureTerminalResultBytes(
          terminal,
          stateBeforeTerminal.evidenceRefs,
          stateBeforeTerminal.artifactRefs,
        ),
      }),
    };
    const resultResource = resultAccountingTree.recordResources(this.runId, resultUsage);
    if (this.treeCommits) this.terminalResourceUsage = resultUsage;
    if (resultResource.status !== "recorded") {
      const resource = this.resourceFailureCandidate(resultResource);
      terminal = terminal.status === "completed"
        ? resource
        : this.appendTerminalFailures(
            terminal,
            Object.freeze([resource.failure]),
            "terminalization_failure",
          );
    }
    if (!this.treeCommits) this.runTree.settleResources(this.runId);
    finalizerStep.check("resource_account", this.resourceFailure !== null || resultResource.status !== "recorded" ? "not_satisfied" : "passed", {
      failurePresent: this.resourceFailure !== null, resultAccounting: resultResource.status,
    });

    const completedAt = this.now();
    const cancellationRequest = this.config.cancellation.context.request;
    finalizerStep.check("cancellation", cancellationRequest !== null ? "not_satisfied" : "passed", {
      requestPresent: cancellationRequest !== null, candidate: terminal.status,
    });
    if (cancellationRequest !== null && (terminal.status === "completed")) {
      terminal = { status: "cancelled" };
    }
    this.config.cancellation.close();
    const cause = this.createSettlementCause(terminal, cancellationRequest, completedAt);
    const terminalStep = this.flow.enter("terminal", {status: terminal.status, causeId: cause.ref.id});
    terminalStep.check("terminal_barrier", "passed", {alreadyTerminal: this.terminalResult !== null});
    const settlement: RunSettlement<TOutput> = terminal.status === "completed"
      ? Object.freeze({
          status: "completed" as const,
          completedAt,
          cause: cause.ref,
          output: terminal.output,
        })
      : terminal.status === "failed"
        ? Object.freeze({
            status: terminal.status,
            completedAt,
            cause: cause.ref,
          })
        : Object.freeze({
            status: "cancelled" as const,
            completedAt,
            cause: cause.ref,
          });
    (await this.writer.commitItems(Object.freeze([
      Object.freeze({ kind: "settlement_cause" as const, cause }),
      ...(this.inputNotifications.undelivered > 0 ? [Object.freeze({kind: "input_delivery_closed" as const,
        reason: settlement.status, entries: this.inputNotifications.pendingEntries})] : []),
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
    )));
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
    terminalStep.output({owner: "runtime", kind: "run", id: this.runId, revision: null});
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
    const underlyingCandidates = terminal.status === "completed"
      ? Object.freeze([])
      : terminal.underlying ?? Object.freeze([]);
    const underlying = Object.freeze([...underlyingCandidates].slice(0, 8));
    const omittedUnderlyingCount = terminal.status === "completed"
      ? 0
      : (terminal.omittedUnderlyingCount ?? 0) +
        Math.max(0, underlyingCandidates.length - 8);
    if (terminal.status === "completed") {
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
    if (terminal.status === "completed") {
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
    assertExecutionCommitConfirmed(error);
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
      const deadline = error.deadline;
      if (deadline !== null && deadline.deadlineAt === this.writer.getSnapshot().deadlineAt &&
        Date.parse(deadline.exhaustedAt) >= Date.parse(deadline.deadlineAt)) {
        const scope = deadline.deadlineAt === this.runTree.getSnapshot().deadlineAt ? "run_tree" : "run";
        return {
          status: "failed",
          failure: runtimeFailure("runtime_deadline_exceeded", "Run deadline elapsed.", {
            deadlineAt: deadline.deadlineAt, scope,
            interruptedOperation: deadline,
            interruptedFailure: error.failure,
          }),
          source: {owner: "runtime", kind: "run_deadline", id: this.runId, revision: null, run: {id: this.runId}},
          underlying: [{relation: "caused_by", source: {
            owner: deadline.owner, kind: "retry_operation", id: deadline.operationId, revision: null, run: {id: this.runId},
          }}],
        };
      }
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

  private retryEvents(bookkeepingInvocationId: string | null = null): RetryEventSink {
    return Object.freeze({
      emit: async (candidate: import("../retry/index.js").RetryEvent) => {
        const event = snapshotRetryEvent(candidate, this.runId);
        const recorded = await this.writer.transaction(() => {
          if (this.retainedRetryEvents.some(previous => JSON.stringify(previous) === JSON.stringify(event))) return {value: false};
          this.retainedRetryEvents.push(event);
          return {payloads: [], patch: {}, value: true, bookkeepingInvocationId};
        });
        if (!recorded) return;
        this.recordRetry(event);
        this.publishCurrentState();
      },
    });
  }

  private recordRetry(event: import("../retry/index.js").RetryEvent): void {
    publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "retry_event", runId: this.runId, occurredAt: event.occurredAt, event});
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

  private onStateCommitted(state: RunState<TOutput>, previous: RunState<TOutput>, bookkeepingInvocationId: string | null): void {
    if (this.stagedAgentBinding && sameInstructionBindingRef(this.stagedAgentBinding.binding.ref, state.activeInstructionBinding)) {
      this.activeAgent = this.stagedAgentBinding.agent;
      this.activeInstructionBinding = this.stagedAgentBinding.binding;
      this.instructionRevisionByAgentRevision.set(agentRevisionKey(this.activeAgent), this.activeAgent.instructions.ref.revision);
      this.stagedAgentBinding = null;
    }
    this.decisionBasis.committed(state.revision, bookkeepingInvocationId ?? retryBookkeepingOwner(state, previous));
    for (const scope of this.retryScopes.values()) scope.notifyStateChanged();
    if (!this.treeCommits && state.permission !== this.lastAuthorityPermission) {
      this.lastAuthorityPermission = state.permission;
      this.runTree.advanceAuthorityRevision(this.runId);
    }
    if (!this.treeCommits) this.accountCommittedResources(state);
    this.transcript.record(state.items);
    if (previous.context !== state.context) publishRunExecutionObservation(this.dependencies.executionObserver, { kind: "context_committed", runId: this.runId, occurredAt: state.context.createdAt, context: state.context });
    if (state.status !== previous.status) {
      const causes = state.items.slice(previous.items.length);
      publishRunTransition(this.dependencies.runObserver, {
        runId: this.runId, previousStatus: previous.status, status: state.status,
        previousRevision: previous.revision, revision: state.revision,
        occurredAt: causes.at(-1)?.createdAt ?? null,
        causes: Object.freeze(causes.map((item) => item.ref)),
      });
    }
    if (this.runStartedEventEmitted) {
      this.emitCommittedContextTransition(state.context);
      this.emitCommittedRunItems(state);
    }
    this.publishCurrentState();
  }

  private terminalResourceUsage: Parameters<RunTreeExecution["recordResources"]>[1] | null = null;

  private async persistRunCommit(state: RunState<TOutput>, previous: RunState<TOutput> | null, accept?: () => void, bookkeepingInvocationId: string | null = null): Promise<void> {
    const port = this.dependencies.runCommits;
    if (!port && !this.treeCommits) return;
    const commitId = `${this.runId}:commit:${state.revision}`;
    try {
      const commit = this.createRunCommit(state, previous, bookkeepingInvocationId);
      if (this.treeCommits) {
        let failure: typeof this.resourceFailure = null;
        await this.treeCommits.transaction(({tree, members}) => {
          const record = (usage: Parameters<RunTreeExecution["recordResources"]>[1]) => {
            const result = tree.recordResources(this.runId, usage);
            if (result.status !== "recorded") failure ??= result;
          };
          if (previous === null) {
            tree.markStarted(this.runId, state.startedAt);
          } else if (state.permission !== previous.permission) tree.advanceAuthorityRevision(this.runId);
          const retainedContextBytes = members.find(member => member.head.state.run.id === this.runId)
            ?.head.control.contextPayloadBytes ?? 0;
          const contextDelta = commit.control.contextPayloadBytes - retainedContextBytes;
          if (!Number.isSafeInteger(contextDelta) || contextDelta < 0) throw new TypeError("Run Context resource account moved backwards.");
          if (contextDelta > 0) record({contextBytes: {status: "measured", value: contextDelta}});
          this.accountResourceItems(state, previous?.items.length ?? 0, record);
          const cancellation = this.config.cancellation.context.request;
          if (cancellation !== null) tree.recordCancellation(this.runId, cancellation);
          for (const transfer of commit.control.descendantTransfers) {
            if (tree.getSnapshot().nodes.find(node => node.runId === transfer.childRunId)?.resultTransfer === "pending") {
              tree.settleDescendantTransfer(transfer.childRunId, transfer.status);
            }
          }
          if (state.settlementCause !== null && state.completedAt !== null &&
              (state.status === "completed" || state.status === "failed" || state.status === "cancelled")) {
            if (this.terminalResourceUsage !== null) record(this.terminalResourceUsage);
            tree.settleResources(this.runId);
            tree.settleRun(this.runId, state.status, projectRunTreeTerminal(state.settlementCause), state.completedAt);
          } else tree.updateLifecycle(this.runId, state.status);
          return {runs: [commit], value: undefined};
        }, () => {
          this.persistenceStarted = true;
          this.resourceFailure ??= failure;
          accept?.();
        });
      } else {
        const receipt = await port!.commitRun(snapshotRunCommit(commit));
        if (receipt.recordId !== commit.id || receipt.revision !== state.revision) throw new TypeError("Run commit receipt mismatch.");
        this.persistenceStarted = true;
      }
    } catch (cause) {
      throw new RunCommitError(commitId, {cause});
    }
  }

  private createRunCommit(state: RunState<TOutput>, previous: RunState<TOutput> | null, bookkeepingInvocationId: string | null = null): RunCommit {
    const notifications = new Map<number, import("./RunInputNotifications.js").RunInputNotification>();
    let cursor = 0;
    let admissionSequence = 0;
    for (const {payload} of state.items) {
      if (payload.kind === "input_notification") {
        notifications.set(payload.notification.sequence, payload.notification);
        cursor = Math.max(cursor, payload.notification.sourceSequence ?? 0);
        admissionSequence = Math.max(admissionSequence, payload.notification.sequence);
      } else if (payload.kind === "input_delivery") {
        for (const entry of payload.batch.entries) notifications.delete(entry.sequence);
      } else if (payload.kind === "input_delivery_closed") {
        for (const entry of payload.entries) notifications.delete(entry.sequence);
      }
    }
    const {cancellation: _cancellation, ...config} = this.config;
    const staged = this.stagedAgentBinding && sameInstructionBindingRef(this.stagedAgentBinding.binding.ref, state.activeInstructionBinding)
      ? this.stagedAgentBinding : null;
    const instructionRevisions = new Map(this.instructionRevisionByAgentRevision);
    if (staged) instructionRevisions.set(agentRevisionKey(staged.agent), staged.agent.instructions.ref.revision);
    const commit: RunCommit = {
      id: `${this.runId}:commit:${state.revision}`,
      expectedRevision: previous?.revision ?? null,
      state,
      control: {
        initialized: this.initialized,
        finalization: this.finalizationCheckpoint,
        lifecycleRecordings: [...this.lifecycleRecordings.values()],
        controllerCheckpoints: [...this.controllerCheckpoints],
        identitySequences: [...this.identitySequences], nextInteractionRequest: this.nextInteractionRequest, activeAgent: state.activeAgent,
        instructionBinding: staged?.binding ?? this.activeInstructionBinding,
        instructionRevisions: [...instructionRevisions],
        instructions: (staged?.agent ?? this.activeAgent).instructions,
        agentDefinition: (() => {const {output: _output, ...definition} = staged?.agent ?? this.activeAgent; return definition;})(),
        contextPayloadBytes: this.contextPayloadBytes,
        operationCalls: [...this.operationCalls], operations: [...this.operationPreparations.values()],
        resultDeliveries: [...this.resultDeliveries.values()],
        operationResults: [...this.operationResults.values()],
        operationExecutions: [...this.operationExecutions],
        executionFailureSettlements: [...this.executionFailureSettlements],
        steering: {epoch: this.steeringEpoch, pending: [...this.steeringQueue], ledger: [...this.steeringLedger.values()]},
        decisionBases: this.decisionBasis.snapshot(state.revision, bookkeepingInvocationId ?? retryBookkeepingOwner(state, previous)), deferredInteractionActions: [...this.deferredInteractionActions.values()],
        inputNotifications: {cursor, admissionSequence, pending: [...notifications.values()]},
        decision: this.acceptedDecision === null ? null : {...this.acceptedDecision,
          calls: retainDecisionCallProgress(this.acceptedDecision, state)},
        pendingCompletion: this.pendingCompletionCall,
        descendantTransfers: [...this.descendantTransfers.values()],
        descendantContinuations: [...this.continuationRecords.values()],
        cancellation: this.config.cancellation.context.request,
        controllerInvocation: this.controllerInvocation,
        retryEvents: [...this.retainedRetryEvents],
        completionNotification: this.completionNotification,
        interactions: this.interactions.checkpoint(),
        interactionActions: [...this.interactionActions].map(([requestId, context]) => ({requestId, ...context})),
        deliveredInteractions: [...this.deliveredInteractions],
      },
      admission: this.persistenceStarted ? null : {input: this.input, config: retainRunConfiguration(config), modelInteractionSeed: this.modelInteractionSeed,
        lineage: this.lineage, rootTask: this.rootTask, rootConfig: retainRunConfiguration(this.rootConfig),
        delegationRequest: this.delegationRequest, delegationContextMaterials: this.delegationContextMaterials},
    };
    return snapshotRunCommit(commit);
  }

  private accountCommittedResources(state: RunState<TOutput>): void {
    this.accountResourceItems(state, this.accountedResourceItemCount, usage => this.recordTreeResources(usage));
    this.accountedResourceItemCount = state.items.length;
  }

  private accountResourceItems(state: RunState<TOutput>, from: number,
    record: (usage: Parameters<RunTreeExecution["recordResources"]>[1]) => void): void {
    for (const item of state.items.slice(from)) {
      if (item.payload.kind === "run_action") {
        record({
          actions: Object.freeze({ status: "measured" as const, value: 1 }),
        });
        continue;
      }
      if (item.payload.kind !== "controller_turn") continue;
      record({
        controllerTurns: Object.freeze({ status: "measured" as const, value: 1 }),
      });
      let responseCorrelationCount = 0;
      for (const modelItem of item.payload.modelItems) {
        if (modelItem.kind !== "model_response_correlation") continue;
        responseCorrelationCount += 1;
        const usage = modelItem.usage;
        const metering = this.dependencies.controller.resourceMetering;
        record({
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
        record({
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
    if (result.status === "completed") this.emit("run.completed", { ...payload, status: "completed", code: null });
    else if (result.status === "cancelled") this.emit("run.cancelled", { ...payload, status: "cancelled", code });
    else this.emit("run.failed", { ...payload, status: "failed", code });
  }

  private async recordLifecycle(
    phase: "started" | "completed" | "failed" | "cancelled",
    skipKinds = new Set<import("../run/index.js").RunFailureKind>(),
    context: ObservabilityRecordContext = this.runtimeObservabilityContext(),
  ): Promise<RunFailureCause[]> {
    const retained = this.lifecycleRecordings.get(phase);
    if (retained && retained.status !== "pending") return [...retained.failures];
    if (retained) {
      const failures: RunFailureCause[] = [];
      for (const kind of ["audit", "telemetry"] as const) {
        if (this.config[kind] === "required") failures.push(createRunFailureCause(kind, {
          code: `${kind}_recording_unconfirmed`, message: "Required lifecycle recording was interrupted and cannot be replayed safely.", retryable: false, metadata: {phase}}));
      }
      await this.writer.commitState(() => {this.lifecycleRecordings.set(phase, {phase, status: "interrupted", failures}); return {};});
      return failures;
    }
    await this.writer.commitState(() => {this.lifecycleRecordings.set(phase, {phase, status: "pending", failures: []}); return {};});
    const state = this.writer.getSnapshot();
    const failures = await recordRunnerLifecycle({
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
    await this.writer.commitState(() => {this.lifecycleRecordings.set(phase, {phase, status: "settled", failures}); return {};});
    return failures;
  }

  private async updateFinalizer(index: number, outcome: Pick<NonNullable<RunControlCheckpoint["finalization"]>["finalizers"][number], "status" | "failure">): Promise<void> {
    await this.writer.commitState(() => {
      const checkpoint = this.finalizationCheckpoint!;
      this.finalizationCheckpoint = {...checkpoint, finalizers: checkpoint.finalizers.map((entry, position) => position === index ? {...entry, ...outcome} : entry)};
      return {};
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
): import("./RunStateWriter.js").RunStatePatch<TOutput> {
  if (terminal.status === "completed") return Object.freeze({
    status: "completed",
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
    status: terminal.status,
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
    : {...operationFailure(semantic.failure.owner, semantic.failure.code, semantic.failure.message),
        ...(semantic.failure.detail === undefined ? {} : {detail: semantic.failure.detail})};
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
      : { ...operationFailure("operation-composition", result.failure.code, result.failure.message), metadata: result.failure.metadata },
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
      compositeSettlement: createCompositeResultSummary(result),
      resultConstruction: result.reduction,
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
            ...(result.failure.detail === undefined ? {} : {detail: result.failure.detail}),
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
      ...(failure.detail === undefined ? {} : {detail: failure.detail}),
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

function bindingMatchesResolution(
  registration: RegisteredOperation,
  context: OperationInvocationContext,
  binding: ResolvedOperationBinding,
): boolean {
  try {
    const checked = snapshotResolvedOperationBinding(binding, value => value);
    return checked.kind === registration.binding.kind &&
      sameRunCommitValue(checked.invocation, snapshotOperationInvocationRef(context.invocation)) &&
      operationRevisionKey(checked.binding.operation) === operationRevisionKey(registration.binding.ref.operation) &&
      checked.binding.revision === registration.binding.ref.revision &&
      checked.resolverRevision === registration.binding.resolverRevision &&
      sameRunCommitValue(checked.correlation, snapshotOperationCorrelation(context.correlation)) &&
      sameRunCommitValue(checked.parentInvocation, context.parentInvocation === null ? null : snapshotOperationInvocationRef(context.parentInvocation));
  } catch { return false; }
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
  return deriveRunStatusAfterPendingChange(status, pending);
}

function projectObservationSettlement(observation: RunObservation, presenter?: ToolResultPresenter): {
  readonly settlement: ModelCallSettlementKind;
  readonly content: ModelJsonValue;
  readonly presentation: import("@agent-anything/model-interaction").ModelResultPresentation;
  readonly references?: readonly import("@agent-anything/operation-catalog/result").OperationLowerResultRef[];
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
    case "operation": {
      const composite = readCompositeResultSummary(payload.result.metadata.compositeSettlement);
      const detail = readOperationLimitFailureDetail(payload.result.failure?.detail);
      let output = payload.result.output;
      let disposition: "complete" | "bounded" = "complete";
      let presentationFailed = false;
      let references: readonly import("@agent-anything/operation-catalog/result").OperationLowerResultRef[] = [];
      try { references = presentToolResultReferences(presenter, payload.result); }
      catch { presentationFailed = true; }
      if (presenter !== undefined) {
        try {
          const presented = presenter.present(payload.result);
          if (presented.disposition !== "complete" && presented.disposition !== "bounded") throw new TypeError("Invalid presentation disposition.");
          output = presented.output;
          disposition = presented.disposition;
        } catch { presentationFailed = true; }
      }
      return {...modelSettlement(
        operationModelSettlement(payload.result.status),
        presentationFailed ? undefined : {
          kind: payload.kind,
          status: payload.result.status,
          output,
          ...(references.length ? {references: references.map(ref => ({...ref}))} : {}),
          ...projectActionEffectFacts(payload.result),
          ...(composite === null ? {} : {composite}),
          failure: payload.result.failure === null
            ? null
            : {
                owner: payload.result.failure.owner,
                code: payload.result.failure.code,
                message: payload.result.failure.message,
                ...(detail === null ? {} : {detail}),
              },
        },
        {kind: payload.kind, status: payload.result.status, ...projectActionEffectFacts(payload.result),
          ...(references.length ? {references: references.map(ref => ({...ref}))} : {}),
          failure: payload.result.failure === null ? null : {
            owner: payload.result.failure.owner.slice(0, 256), code: payload.result.failure.code.slice(0, 256),
            message: payload.result.failure.message.slice(0, 1_000),
            messageTruncated: payload.result.failure.message.length > 1_000,
          }},
        presenter === undefined ? undefined : {presenter: presenter.ref, disposition, failureCode: null},
      ), references};
    }
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
          ...descendantDeliveryFacts(payload),
          output: payload.output,
          failure: payload.failure === null
            ? null
            : {
                owner: payload.failure.owner,
                code: payload.failure.code,
                message: payload.failure.message,
              },
        }, descendantDeliveryFacts(payload),
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
      }, descendantDeliveryFacts(payload));
    case "descendant_result_transfer":
      return modelSettlement(
        operationModelSettlement(payload.status),
        {
          kind: payload.kind,
          status: payload.status,
          childRunId: payload.childRunId,
          ...descendantDeliveryFacts(payload),
          output: payload.output,
          failure: payload.failure === null
            ? null
            : {
                owner: payload.failure.owner,
                code: payload.failure.code,
                message: payload.failure.message,
              },
        }, descendantDeliveryFacts(payload),
      );
  }
}

function descendantDeliveryFacts(payload: Extract<RunObservation["payload"],
  {kind: "descendant_run" | "descendant_result_transfer" | "descendant_progress"}>): Readonly<Record<string, ModelJsonValue>> {
  if (payload.kind === "descendant_progress") return {
    kind: payload.kind, status: "suspended", childRunId: payload.progress.childRun.id,
    childRunRevision: payload.progress.childRunRevision, suspension: snapshotModelJsonValue(payload.progress.suspension, "suspension"),
    admittedControls: snapshotModelJsonValue(payload.progress.admittedControls, "admittedControls"),
  };
  const result = payload.result;
  return {kind: payload.kind, status: payload.status, childRunId: payload.childRunId,
    ...(result === null ? {} : {childTerminalStatus: result.terminal.status, childTerminalCode: result.terminal.code,
      resultRef: snapshotModelJsonValue(result.ref, "resultRef"), effects: {status: result.effects.status,
        attempted: result.effects.attempted, settled: result.effects.settled, uncertain: result.effects.uncertain}}),
    failureCode: payload.failure?.code ?? null};
}

function projectActionEffectFacts(result: OperationResult): Readonly<Record<string, ModelJsonValue>> {
  if (!result.lowerRefs.some(ref => ref.owner === "canonical-action" && ref.kind === "action_settlement")) {
    return {};
  }
  const { effectCertainty, completionExtent } = result.metadata;
  return {
    ...(isActionEffectCertainty(effectCertainty) ? { effectCertainty } : {}),
    ...(completionExtent === "none" || completionExtent === "partial" ||
        completionExtent === "complete" || completionExtent === "unknown"
      ? { completionExtent } : {}),
  };
}

function modelSettlement(
  settlement: ModelCallSettlementKind,
  content: unknown,
  knownOutcome: Readonly<Record<string, ModelJsonValue>> = {},
  presentation?: import("@agent-anything/model-interaction").ModelResultPresentation,
): { readonly settlement: ModelCallSettlementKind; readonly content: ModelJsonValue;
  readonly presentation: import("@agent-anything/model-interaction").ModelResultPresentation } {
  let snapshot: ModelJsonValue;
  let failureCode: string | null = null;
  try {
    snapshot = snapshotModelToolResultContent(content);
  } catch {
    failureCode = "model_result_projection_unavailable";
    snapshot = snapshotModelToolResultContent({
      status: settlement,
      ...knownOutcome,
      code: "model_result_projection_unavailable",
      message: "The call settled, but its result content could not be presented. This is not evidence that execution failed or had no effects; do not repeat an effect solely to obtain missing output.",
    });
  }
  return Object.freeze({ settlement, content: snapshot,
    presentation: presentation === undefined
      ? resultPresentation(failureCode === null ? "complete" : "unavailable", failureCode)
      : Object.freeze({...presentation, ...(failureCode === null ? {} : {disposition: "unavailable" as const, failureCode})}) });
}

function resultPresentation(
  disposition: "complete" | "unavailable", failureCode: string | null = null,
): import("@agent-anything/model-interaction").ModelResultPresentation {
  return Object.freeze({presenter: Object.freeze({id: "agent-runtime.observation", revision: "1"}), disposition, failureCode});
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
    code: terminal.status === "completed" ? null : terminal.status === "cancelled"
      ? "runtime_cancelled"
      : terminal.failure.failure.code,
    finalOutput: terminal.status === "completed" ? terminal.output : null,
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
