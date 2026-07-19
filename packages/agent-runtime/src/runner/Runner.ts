import type { Agent } from "@agent-anything/agent-core/agent";
import type { RuntimeEventPublisher } from "@agent-anything/agent-core/events";
import type { RunInput, RunResult } from "@agent-anything/agent-core/run";
import { createSystemRetryExecutor } from "../retry/createSystemRetryExecutor.js";
import { RunExecution } from "./RunExecution.js";
import type { RunConfig } from "./RunConfig.js";
import type {
  CreateRunnerIdentityInput,
  ResolvedRunnerDependencies,
  RunInvocationOptions,
  RunnerDependencies,
} from "./RunnerDependencies.js";

export class Runner {
  private readonly dependencies: ResolvedRunnerDependencies;

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
