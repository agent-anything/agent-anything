import type { EvidenceBuilderPort } from "@agent-anything/context/evidence";
import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import type {
  ContextProjectionLimits,
  ContextProjectionPurpose,
  ContextProjectorPort,
} from "@agent-anything/context/context";
import type {
  AuditPort,
  RunTraceObserver,
  RuntimeEventPublisher,
  TelemetryPort,
} from "@agent-anything/observability";

import type {
  ActionEnforcementPipeline,
} from "@agent-anything/action-execution/enforcement";
import type {
  SandboxExecutionGateway,
} from "@agent-anything/action-execution/sandbox";
import type { Controller } from "../controller/index.js";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import type { RunObservation } from "../run/RunObservation.js";

export type RunnerIdentityKind =
  | "run_cancellation_request"
  | "run_item"
  | "action"
  | "observation"
  | "plan"
  | "approval_request"
  | "approval_record"
  | "approval_review_operation"
  | "authority_operation"
  | "action_authority"
  | "run_permission_grant"
  | "session_authority_record"
  | "policy_amendment_record"
  | "runtime_event"
  | "run_trace"
  | "trace_span";

export interface CreateRunnerIdentityInput {
  readonly kind: RunnerIdentityKind;
  readonly runId: string;
  readonly sequence: number;
}

export type CreateRunnerIdentity = (input: CreateRunnerIdentityInput) => string;
export type CreateRunIdentity = () => string;

export interface RunnerContextProjection {
  readonly projector: ContextProjectorPort<RunObservation, RunObservation>;
  readonly purpose: ContextProjectionPurpose;
  readonly limits: ContextProjectionLimits;
}

export interface RunnerDependencies {
  readonly controller: Controller<unknown>;
  readonly contextProjection: RunnerContextProjection;
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly runTraceObserver?: RunTraceObserver;
  readonly actionEnforcementPipeline?: ActionEnforcementPipeline;
  readonly sandboxExecutionGateway?: SandboxExecutionGateway;
  readonly evidenceBuilder?: EvidenceBuilderPort;
  readonly evidencePersistence?: EvidencePersistencePort;
  readonly retryExecutor?: RetryExecutor;
  readonly now?: () => string;
  readonly createRunId?: CreateRunIdentity;
  readonly createId?: CreateRunnerIdentity;
}

export interface RunInvocationOptions {
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly runTraceObserver?: RunTraceObserver;
}

export type ResolvedRunnerDependencies = Required<
  Pick<
    RunnerDependencies,
    "controller" | "now" | "createRunId" | "createId" | "retryExecutor"
  >
> & Omit<
  RunnerDependencies,
  "controller" | "now" | "createRunId" | "createId" | "retryExecutor"
>;
