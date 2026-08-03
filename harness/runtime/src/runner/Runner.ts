import type { Agent, RunInput } from "@agent-anything/foundation";
import type {
  RunTraceObserver,
  RuntimeEventPublisher,
} from "@agent-anything/observability";
import type { RunResult } from "@agent-anything/runtime/run";
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
    return new RunExecution<TOutput>(
      this.dependencies,
      agent,
      input,
      config,
      runtimeEventPublishers(
        this.dependencies.runtimeEventPublisher,
        options.runtimeEventPublisher,
      ),
      runTraceObservers(
        this.dependencies.runTraceObserver,
        options.runTraceObserver,
      ),
    ).run();
  }
}

function runtimeEventPublishers(
  configured: RuntimeEventPublisher | undefined,
  invocation: RuntimeEventPublisher | undefined,
): readonly RuntimeEventPublisher[] {
  return Object.freeze(
    [invocation, configured].filter(
      (publisher, index, publishers): publisher is RuntimeEventPublisher =>
        publisher !== undefined && publishers.indexOf(publisher) === index,
    ),
  );
}

function runTraceObservers(
  configured: RunTraceObserver | undefined,
  invocation: RunTraceObserver | undefined,
): readonly RunTraceObserver[] {
  const observers = [invocation, configured].filter(
    (observer, index, candidates): observer is RunTraceObserver =>
      observer !== undefined && candidates.indexOf(observer) === index,
  );
  for (const observer of observers) {
    if (
      typeof observer !== "object" ||
      observer === null ||
      typeof observer.observe !== "function"
    ) {
      throw new TypeError(
        "RunTrace observer must implement observe(trace).",
      );
    }
  }
  return Object.freeze(observers);
}

function createDefaultIdentity(input: CreateRunnerIdentityInput): string {
  return `${input.runId}:${input.kind}:${input.sequence}`;
}
