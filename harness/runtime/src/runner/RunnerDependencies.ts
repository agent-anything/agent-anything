import type { EvidenceBuilderPort } from "@agent-anything/context/evidence";
import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import type {
  AuditPort,
  RunTraceObserver,
  RuntimeEventPublisher,
  TelemetryPort,
} from "@agent-anything/observability";
import type { ISODateTimeString } from "@agent-anything/foundation";
import type {
  ActionEnforcementPipeline,
  SandboxExecutionGateway,
} from "@agent-anything/action-execution";
import type { Controller } from "@agent-anything/runtime/controller";
import type { RetryExecutor } from "../retry/RetryExecutor.js";

export type RunnerIdentityKind =
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

export interface RunnerDependencies {
  readonly controller: Controller<unknown>;
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly runTraceObserver?: RunTraceObserver;
  readonly actionEnforcementPipeline?: ActionEnforcementPipeline;
  readonly sandboxExecutionGateway?: SandboxExecutionGateway;
  readonly evidenceBuilder?: EvidenceBuilderPort;
  readonly evidencePersistence?: EvidencePersistencePort;
  readonly retryExecutor?: RetryExecutor;
  readonly now?: () => ISODateTimeString;
  readonly createId?: CreateRunnerIdentity;
}

export interface RunInvocationOptions {
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
  readonly runTraceObserver?: RunTraceObserver;
}

export type ResolvedRunnerDependencies = Required<
  Pick<RunnerDependencies, "controller" | "now" | "createId" | "retryExecutor">
> & Omit<RunnerDependencies, "controller" | "now" | "createId" | "retryExecutor">;
