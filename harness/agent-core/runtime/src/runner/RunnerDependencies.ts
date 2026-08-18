import type { Agent, AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
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
import type { OperationBindingResolverSnapshot, ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type {
  OperationCatalogSnapshot,
  OperationRequestOrigin,
} from "@agent-anything/operation-catalog/catalog";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { CompositeDefinitionRevision } from "@agent-anything/operation-composition/definition";
import type { CompositeExecutionDependencies } from "@agent-anything/operation-composition/execution";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import type { RunResult } from "../run/RunResult.js";
import type { RunConfig } from "./RunConfig.js";
import type { CompletionGatePort } from "@agent-anything/validation/completion";
import type {
  CheckAttemptRef,
  CheckDefinitionRef,
  CheckResult,
  ValidationCheckRequest,
  ValidationExecutionFactory,
  ValidationExecutionPort,
} from "@agent-anything/validation/execution";
import type { ValidationOwnerRef, ValidationRequirementRef } from "@agent-anything/validation/definition";
import type { ValidationSubjectSnapshotRef } from "@agent-anything/validation/subject";
import type { RunRef } from "@agent-anything/agent-core/run";

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
  | "validation_gate"
  | "validation_proposal";

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

export interface DescendantRunPreparation {
  readonly agent: Agent;
  readonly input: RunInput;
  readonly config: RunConfig;
  readonly contextManifestRef: string;
  readonly visibility: "parent_and_host" | "parent_only";
  mapResult(result: RunResult): DescendantOperationOutcome;
}

export type DescendantOperationOutcome =
  | { readonly status: "succeeded"; readonly output: unknown; readonly failure: null }
  | { readonly status: "partial"; readonly output: unknown; readonly failure: import("@agent-anything/operation-catalog/result").OperationFailure }
  | {
      readonly status: "failed" | "unavailable" | "denied" | "cancelled" | "timed_out" | "invalid" | "unknown_effect";
      readonly output: null;
      readonly failure: import("@agent-anything/operation-catalog/result").OperationFailure;
    };

export interface DescendantRunCompositionPort {
  prepare(input: {
    readonly parentRunId: string;
    readonly parentRunAction: RunActionRef;
    readonly targetAgent: AgentRevisionRef;
    readonly delegatedInput: unknown;
    readonly parentConfig: RunConfig;
  }): Promise<DescendantRunPreparation>;
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
  readonly actionExecution?: Omit<
    ActionExecutionCoordinatorDependencies,
    "approval" | "permission"
  >;
  readonly composite?: CompositeOperationResolverPort;
  readonly descendants?: DescendantRunCompositionPort;
}

export interface RunnerValidationComposition {
  readonly executionFactory: ValidationExecutionFactory;
  readonly completionGate: CompletionGatePort;
  readonly preparation?: RunnerValidationPreparationPort;
  readonly checkRequests?: RunnerValidationCheckRequestResolverPort;
}

export interface RunnerValidationPreparationPort {
  prepare(
    input: {
      readonly run: RunRef;
      readonly execution: ValidationExecutionPort;
      readonly automaticChecks: RunnerAutomaticValidationCheckPort;
    },
    interruption: InvocationInterruptionContext,
  ): Promise<void>;
}

export type RunnerAutomaticValidationCheckRequest = Omit<
  ValidationCheckRequest,
  "origin" | "runAction" | "expectedRevision"
>;

export interface RunnerAutomaticValidationCheckPort {
  execute(
    request: RunnerAutomaticValidationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult>;
}

export interface RunnerValidationCheckRequest {
  readonly requirement: ValidationRequirementRef;
  readonly subject: ValidationSubjectSnapshotRef;
  readonly definition: CheckDefinitionRef;
  readonly predecessor: CheckAttemptRef | null;
  readonly environment: ValidationOwnerRef | null;
  readonly configuration: ValidationOwnerRef | null;
  readonly coverageTarget: number;
}

export interface RunnerValidationCheckRequestResolverPort {
  resolve(input: {
    readonly run: RunRef;
    readonly runAction: RunActionRef;
    readonly operation: OperationRevisionRef;
    readonly request: unknown;
    readonly requestOrigin: OperationRequestOrigin;
  }): Promise<RunnerValidationCheckRequest | null>;
}

export interface RunnerDependencies {
  readonly controller: import("../controller/index.js").Controller<unknown>;
  readonly contextProjection: RunnerContextProjection;
  readonly operations: RunnerOperationComposition;
  readonly validation: RunnerValidationComposition;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly agents?: AgentResolverPort;
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly runTraceObserver?: RunTraceObserver;
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
  "controller" | "contextProjection" | "operations" | "validation" | "interactions" | "now" | "createRunId" | "createId" | "retryExecutor"
>> & Omit<RunnerDependencies, "controller" | "contextProjection" | "operations" | "validation" | "interactions" | "now" | "createRunId" | "createId" | "retryExecutor">;
