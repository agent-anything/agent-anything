import type { AuditPort, TelemetryPort } from "@agent-anything/observability";
import type { ISODateTimeString } from "@agent-anything/shared";
import type { Agent } from "../agent/index.js";
import type { Controller } from "../controller/index.js";
import type { RuntimeEventEmitter } from "../events/index.js";
import { RunExecution } from "./RunExecution.js";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput } from "./RunInput.js";
import type { RunResult } from "./RunResult.js";
import type { ToolActionBridge } from "./ToolActionBridge.js";

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
  readonly eventEmitter?: RuntimeEventEmitter;
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
  readonly toolActionBridge?: ToolActionBridge;
  readonly now?: () => ISODateTimeString;
  readonly createId?: CreateRunnerIdentity;
}

export class Runner {
  private readonly dependencies: Required<
    Pick<RunnerDependencies, "controller" | "now" | "createId">
  > & Omit<RunnerDependencies, "controller" | "now" | "createId">;

  constructor(dependencies: RunnerDependencies) {
    if (!dependencies.controller || typeof dependencies.controller.next !== "function") {
      throw new TypeError("Runner requires a Controller.");
    }

    this.dependencies = Object.freeze({
      ...dependencies,
      now: dependencies.now ?? (() => new Date().toISOString()),
      createId: dependencies.createId ?? createDefaultIdentity,
    });
  }

  run<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
  ): Promise<RunResult<TOutput>> {
    return new RunExecution<TOutput>(
      this.dependencies,
      agent,
      input,
      config,
    ).run();
  }
}

function createDefaultIdentity(input: CreateRunnerIdentityInput): string {
  return `${input.runId}:${input.kind}:${input.sequence}`;
}
