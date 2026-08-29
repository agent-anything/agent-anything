import type { Agent, AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type { AgentTask, TaskRef } from "@agent-anything/agent-core/task";
import type {
  ContextBudgetGrant,
  ContextProjectionEstimator,
  ContextProjectionPolicy,
  ContextProjectionProfile,
} from "@agent-anything/context/projection";
import type { ContextManifestPersistencePort } from "@agent-anything/context/persistence";
import type { ControllerPreProjectionInput } from "../controller/index.js";
import type { AuditPort, RunTraceObserver, RuntimeEventPublisher, TelemetryPort } from "@agent-anything/observability";
import type { ActionExecutionCoordinatorDependencies } from "@agent-anything/action-execution/enforcement";
import type { ActionExecutionObserver } from "@agent-anything/action-execution/enforcement";
import type { InteractionProtocolRegistrySnapshot } from "@agent-anything/interaction/coordination";
import type {
  OperationBindingResolverSnapshot,
  ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import type {
  OperationCatalogSnapshot,
  OperationRequestOrigin,
} from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { CompositeDefinitionRevision } from "@agent-anything/operation-composition/definition";
import type { CompositeExecutionDependencies } from "@agent-anything/operation-composition/execution";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import type { RunResult } from "../run/RunResult.js";
import type { CompletionGatePort } from "@agent-anything/verification/completion";
import type {
  CheckAttemptRef,
  CheckDefinitionRef,
  CheckResult,
  VerificationCheckRequest,
  VerificationExecutionFactory,
  VerificationExecutionPort,
  VerificationLowerCheckSettlement,
} from "@agent-anything/verification/execution";
import type { VerificationOwnerRef, VerificationRequirementRef } from "@agent-anything/verification/definition";
import type { VerificationSubjectSnapshotRef } from "@agent-anything/verification/subject";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunFinalizationContext } from "../run/RunCancellation.js";
import type { RunFailureCause } from "../run/RunFailure.js";
import type {
  ToolBindingUnavailableReason,
  ToolExposureBasisRef,
} from "@agent-anything/tools/selection";
import type { ToolCall } from "@agent-anything/tools/invocation";
import type {
  DelegationAuthorityDimensionInput,
  DelegationContextMaterial,
  DelegationLimits,
  DelegationPreparation,
  DelegationRequest,
  DelegationResult,
} from "../delegation/index.js";
import type { TaskFulfillmentEvaluatorPort } from "../completion/index.js";
import type { RunTranscriptPort } from "../transcript/index.js";

export type RunnerIdentityKind =
  | "run_cancellation_request"
  | "run_item"
  | "run_action"
  | "controller_turn"
  | "operation_invocation"
  | "operation_result"
  | "tool_call"
  | "observation"
  | "plan"
  | "interaction_request"
  | "interaction_submission_receipt"
  | "interaction_resolution"
  | "interaction_application"
  | "action"
  | "descendant_relation"
  | "delegation_request"
  | "delegation_result"
  | "delegation_authority"
  | "delegation_limits"
  | "composite"
  | "runtime_event"
  | "run_trace"
  | "trace_span"
  | "approval_record"
  | "authority_record"
  | "active_context"
  | "context_item"
  | "context_transition"
  | "context_contribution"
  | "context_refresh"
  | "verification_gate"
  | "verification_proposal"
  | "task_fulfillment_assessment"
  | "stop_review";

export interface CreateRunnerIdentityInput {
  readonly kind: RunnerIdentityKind;
  readonly runId: string;
  readonly sequence: number;
}

export type CreateRunnerIdentity = (input: CreateRunnerIdentityInput) => string;
export type CreateRunIdentity = () => string;

export interface RunnerContextProjection {
  readonly purpose: string;
  readonly profile: ContextProjectionProfile;
  readonly policy: ContextProjectionPolicy;
  readonly audiences: readonly string[];
  readonly maxContributionPayloadBytes: number;
  readonly manifestPersistence?: ContextManifestPersistencePort;
  allocate(input: ControllerPreProjectionInput): {
    readonly budget: ContextBudgetGrant;
    readonly estimator: ContextProjectionEstimator;
  };
}

export interface InternalOperationExecutionContext {
  readonly runId: string;
  readonly parentRunAction: RunActionRef;
  readonly binding: Extract<ResolvedOperationBinding, { readonly kind: "internal" }>;
  readonly deadlineAt: string;
  readonly interruption: InvocationInterruptionContext;
}

export interface InternalOperationHandler {
  readonly id: string;
  execute(context: InternalOperationExecutionContext): Promise<OperationResult>;
}

export interface AgentResolution {
  readonly status: "admitted" | "unavailable" | "denied";
  readonly agent: Agent | null;
  readonly admissionEvidenceRef: string | null;
  readonly code: string | null;
}

export interface AgentResolverPort {
  resolve(ref: AgentRevisionRef): Promise<AgentResolution>;
}

export interface DelegationPreparationResult {
  readonly agent: Agent;
  readonly preparation: DelegationPreparation;
  readonly rootPurpose: DelegationContextMaterial;
}

export type DescendantOperationOutcome =
  | { readonly status: "succeeded"; readonly output: unknown; readonly failure: null }
  | { readonly status: "partial"; readonly output: unknown; readonly failure: import("@agent-anything/operation-catalog/result").OperationFailure }
  | {
      readonly status: "failed" | "unavailable" | "denied" | "cancelled" | "timed_out" | "invalid" | "unknown_effect";
      readonly output: null;
      readonly failure: import("@agent-anything/operation-catalog/result").OperationFailure;
    };

export interface DelegationPreparationPort {
  assessAvailability(input: {
    readonly parentRunId: string;
    readonly targetAgent: AgentRevisionRef;
  }): Promise<ToolPathAvailability> | ToolPathAvailability;
  prepare(input: {
    readonly root: {
      readonly run: RunRef;
      readonly task: AgentTask;
    };
    readonly parent: {
      readonly run: RunRef;
      readonly task: TaskRef;
      readonly action: RunActionRef;
      readonly lineage: RunLineage;
    };
    readonly targetAgent: AgentRevisionRef;
    readonly toolCall: ToolCall;
    readonly authorityCeiling: readonly DelegationAuthorityDimensionInput[];
    readonly limitCeiling: DelegationLimits;
  }): Promise<DelegationPreparationResult>;
}

export interface DelegationResultProjectionPort {
  project(result: DelegationResult): DescendantOperationOutcome;
}

export interface DelegationNarrativeProjectionPort {
  project(input: {
    readonly request: DelegationRequest;
    readonly finalOutput: unknown;
  }): string | null;
}

export interface RunnerDelegationComposition {
  readonly preparation: DelegationPreparationPort;
  readonly narrativeProjection: DelegationNarrativeProjectionPort;
  readonly resultProjection: DelegationResultProjectionPort;
}

export interface ToolPathAvailability {
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly disposition: "available" | "unavailable";
  readonly reason: ToolBindingUnavailableReason | null;
}

export interface OperationToolAvailabilityParticipant {
  readonly binding: OperationBindingRevisionRef;
  assess(input: {
    readonly run: RunRef;
  }): Promise<ToolPathAvailability> | ToolPathAvailability;
}

export interface CompositeOperationResolution {
  readonly definition: CompositeDefinitionRevision;
  readonly execution: Omit<CompositeExecutionDependencies, "children">;
}

export interface CompositeOperationResolverPort {
  resolve(definitionRef: string): CompositeOperationResolution | null;
}

export interface RunnerOperationComposition {
  readonly catalog: OperationCatalogSnapshot;
  readonly bindings: OperationBindingResolverSnapshot;
  readonly validateToolInput: (schema: unknown, candidate: unknown) => boolean;
  readonly internalHandlers: readonly InternalOperationHandler[];
  readonly availability: readonly OperationToolAvailabilityParticipant[];
  readonly actionExecution?: Omit<
    ActionExecutionCoordinatorDependencies,
    "approval" | "permission"
  >;
  readonly composite?: CompositeOperationResolverPort;
  readonly delegation?: RunnerDelegationComposition;
}

export interface RunnerVerificationComposition {
  readonly executionFactory: VerificationExecutionFactory;
  readonly completionGate: CompletionGatePort;
  readonly preparation: RunnerVerificationPreparationPort | null;
  readonly settledOperationResults: RunnerVerificationSettledOperationResultProcessorPort | null;
  readonly checkResults: RunnerVerificationCheckResultProcessorPort | null;
}

export interface RunnerCompletionComposition {
  readonly taskFulfillment: TaskFulfillmentEvaluatorPort;
  readonly maximumDurationMs: number;
}

export interface RunnerVerificationPreparationPort {
  prepare(
    input: {
      readonly run: RunRef;
      readonly execution: VerificationExecutionPort;
      readonly automaticEffectfulChecks: RunnerAutomaticEffectfulVerificationCheckPort;
    },
    interruption: InvocationInterruptionContext,
  ): Promise<void>;
}

export type RunnerAutomaticEffectfulVerificationCheckRequest = Omit<
  VerificationCheckRequest,
  "origin" | "runAction" | "expectedRevision"
>;

export interface RunnerAutomaticEffectfulVerificationCheckPort {
  execute(
    request: RunnerAutomaticEffectfulVerificationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult>;
}

export interface RunnerVerificationCheckRequest {
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly definition: CheckDefinitionRef;
  readonly predecessor: CheckAttemptRef | null;
  readonly environment: VerificationOwnerRef | null;
  readonly configuration: VerificationOwnerRef | null;
  readonly coverageTarget: number;
}

export interface RunnerVerificationSettledOperationResultProcessorPort {
  process(input: {
    readonly run: RunRef;
    readonly execution: VerificationExecutionPort;
    readonly runAction: RunActionRef;
    readonly operation: OperationRevisionRef;
    readonly request: unknown;
    readonly requestOrigin: OperationRequestOrigin;
    readonly settlement: VerificationLowerCheckSettlement;
  }, interruption: InvocationInterruptionContext): Promise<boolean>;
}

export interface RunnerVerificationCheckResultProcessorPort {
  process(input: {
    readonly run: RunRef;
    readonly execution: VerificationExecutionPort;
    readonly request: RunnerVerificationCheckRequest;
    readonly result: CheckResult;
  }, interruption: InvocationInterruptionContext): Promise<void>;
}

export interface RunResourceFinalizerPort {
  finalize(context: RunFinalizationContext): Promise<RunFailureCause | null>;
}

export interface RunnerDependencies {
  readonly controller: import("../controller/index.js").Controller<unknown>;
  readonly contextProjection: RunnerContextProjection;
  readonly operations: RunnerOperationComposition;
  readonly completion: RunnerCompletionComposition;
  readonly verification: RunnerVerificationComposition;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly agents?: AgentResolverPort;
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly runTraceObserver?: RunTraceObserver;
  readonly runTranscriptPort?: RunTranscriptPort;
  readonly resourceFinalizers?: readonly RunResourceFinalizerPort[];
  readonly retryExecutor?: RetryExecutor;
  readonly now?: () => string;
  readonly createRunId?: CreateRunIdentity;
  readonly createId?: CreateRunnerIdentity;
}

export interface RunInvocationOptions {
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly runTraceObserver?: RunTraceObserver;
  readonly actionExecutionObserver?: ActionExecutionObserver;
}

export type ResolvedRunnerDependencies = Required<Pick<
  RunnerDependencies,
  "controller" | "contextProjection" | "operations" | "verification" | "interactions" | "now" | "createRunId" | "createId" | "retryExecutor"
>> & Omit<RunnerDependencies, "controller" | "contextProjection" | "operations" | "completion" | "verification" | "interactions" | "now" | "createRunId" | "createId" | "retryExecutor"> & {
  readonly completion: RunnerCompletionComposition;
};
