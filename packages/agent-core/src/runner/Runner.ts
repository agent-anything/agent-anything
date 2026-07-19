import type { AuditPort, TelemetryPort } from "@agent-anything/observability";
import type { EvidenceBuilderPort } from "@agent-anything/evidence";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { StoragePort } from "@agent-anything/storage";
import type { Agent } from "../agent/index.js";
import type {
  ActionEnforcementPipeline,
  SandboxExecutionGateway,
} from "../action-execution/index.js";
import type { Controller } from "../controller/Controller.js";
import type { RuntimeEventPublisher } from "../events/index.js";
import { createSystemRetryExecutor } from "../retry/createSystemRetryExecutor.js";
import type { RetryExecutor } from "../retry/RetryExecutor.js";
import { RunExecution } from "./RunExecution.js";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput } from "../run/RunInput.js";
import type { RunResult } from "../run/RunResult.js";

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
  | "policy_amendment_record";

export interface CreateRunnerIdentityInput {
  readonly kind: RunnerIdentityKind;
  readonly runId: string;
  readonly sequence: number;
}

export type CreateRunnerIdentity = (input: CreateRunnerIdentityInput) => string;

export interface RunnerDependencies {
  readonly controller: Controller<unknown>;
  readonly eventEmitter?: RuntimeEventPublisher;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly actionEnforcementPipeline?: ActionEnforcementPipeline;
  readonly sandboxExecutionGateway?: SandboxExecutionGateway;
  readonly evidenceBuilder?: EvidenceBuilderPort;
  readonly evidenceStorage?: StoragePort;
  readonly retryExecutor?: RetryExecutor;
  readonly now?: () => ISODateTimeString;
  readonly createId?: CreateRunnerIdentity;
}

export interface RunInvocationOptions {
  readonly runtimeEventPublisher?: RuntimeEventPublisher;
}

export class Runner {
  private readonly dependencies: Required<
    Pick<RunnerDependencies, "controller" | "now" | "createId" | "retryExecutor">
  > & Omit<RunnerDependencies, "controller" | "now" | "createId" | "retryExecutor">;

  constructor(dependencies: RunnerDependencies) {
    if (!dependencies.controller || typeof dependencies.controller.next !== "function") {
      throw new TypeError("Runner requires a Controller.");
    }

    const now = dependencies.now ?? (() => new Date().toISOString());
    this.dependencies = Object.freeze({
      ...dependencies,
      now,
      createId: dependencies.createId ?? createDefaultIdentity,
      retryExecutor: dependencies.retryExecutor ?? createSystemRetryExecutor({
        now: () => new Date(now()),
      }),
    });
  }

  run<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
    options: RunInvocationOptions = {},
  ): Promise<RunResult<TOutput>> {
    const eventEmitter = combineRuntimeEventPublishers(
      this.dependencies.eventEmitter,
      options.runtimeEventPublisher,
    );
    return new RunExecution<TOutput>(
      eventEmitter === this.dependencies.eventEmitter
        ? this.dependencies
        : Object.freeze({ ...this.dependencies, eventEmitter }),
      agent,
      input,
      config,
    ).run();
  }
}

function combineRuntimeEventPublishers(
  configured: RuntimeEventPublisher | undefined,
  invocation: RuntimeEventPublisher | undefined,
): RuntimeEventPublisher | undefined {
  if (configured === undefined) return invocation;
  if (invocation === undefined || invocation === configured) return configured;

  return Object.freeze({
    emit(input: Parameters<RuntimeEventPublisher["emit"]>[0]) {
      for (const publisher of [invocation, configured]) {
        try {
          publisher.emit(input);
        } catch {
          // Runtime notifications are non-authoritative and publisher-local.
        }
      }
    },
  });
}

function createDefaultIdentity(input: CreateRunnerIdentityInput): string {
  return `${input.runId}:${input.kind}:${input.sequence}`;
}
