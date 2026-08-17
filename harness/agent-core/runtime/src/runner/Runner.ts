import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import type {
  RunTraceObserver,
  RuntimeEventPublisher,
} from "@agent-anything/observability";
import {
  createFailedRunResult,
  createRunCancellationController,
  type RunResult,
} from "../run/index.js";
import { createRunFailureCause } from "../run/RunFailure.js";
import { createSystemRetryExecutor } from "../retry/createSystemRetryExecutor.js";
import {
  ActiveRunHandle,
  type RunHandle,
} from "./RunHandle.js";
import { RunExecution } from "./RunExecution.js";
import type {
  ResolvedRunConfig,
  RunConfig,
  ValidatedRunConfig,
} from "./RunConfig.js";
import type {
  CreateRunnerIdentityInput,
  ResolvedRunnerDependencies,
  RunInvocationOptions,
  RunnerDependencies,
} from "./RunnerDependencies.js";
import {
  snapshotContextProjectionRequest,
} from "@agent-anything/context/projection";
import {
  snapshotAgent,
  snapshotRunConfig,
  snapshotRunInput,
} from "./RunnerValidation.js";

export class Runner {
  private readonly dependencies: ResolvedRunnerDependencies;
  private readonly activeRunIds = new Set<string>();

  constructor(dependencies: RunnerDependencies) {
    if (!dependencies.controller || typeof dependencies.controller.next !== "function") {
      throw new TypeError("Runner requires a Controller.");
    }

    const now = dependencies.now ?? (() => new Date().toISOString());
    const contextProjection = snapshotRunnerContextProjection(
      dependencies.contextProjection,
    );
    this.dependencies = Object.freeze({
      ...dependencies,
      contextProjection,
      now,
      createRunId: dependencies.createRunId ?? createDefaultRunIdentity,
      createId: dependencies.createId ?? createDefaultIdentity,
      retryExecutor: dependencies.retryExecutor ?? createSystemRetryExecutor({
        now: () => new Date(now()),
      }),
    });
  }

  start<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
    options: RunInvocationOptions = {},
  ): RunHandle<TOutput> {
    const configuredPublishers = runtimeEventPublishers(
      this.dependencies.runtimeEventPublisher,
      options.runtimeEventPublisher,
    );
    const configuredObservers = runTraceObservers(
      this.dependencies.runTraceObserver,
      options.runTraceObserver,
    );
    const agentSnapshot = snapshotAgent(agent);
    const inputSnapshot = snapshotRunInput(input);
    const configSnapshot = snapshotRunConfig(config);
    if (!configSnapshot.valid) {
      throw new TypeError(configSnapshot.failure.message);
    }
    validateActionComposition(this.dependencies, configSnapshot.config);

    const runId = this.dependencies.createRunId();
    assertNonEmpty(runId, "Runner-created runId");
    if (this.activeRunIds.has(runId)) {
      throw new TypeError(`Runner-created runId '${runId}' is already active.`);
    }
    const cancellation = createRunCancellationController({
      runId,
      now: this.dependencies.now,
      createRequestId: (acceptedRunId) => this.dependencies.createId({
        kind: "run_cancellation_request",
        runId: acceptedRunId,
        sequence: 1,
      }),
    });
    const resolvedConfig: ResolvedRunConfig = Object.freeze({
      ...configSnapshot.config,
      cancellation,
    });
    const emergencyResult = createEmergencyRunResult<TOutput>(
      runId,
      inputSnapshot.task.id,
    );
    const handle = new ActiveRunHandle<TOutput>(
      runId,
      cancellation,
      emergencyResult,
    );
    const execution = new RunExecution<TOutput>(
      runId,
      this.dependencies,
      agentSnapshot,
      inputSnapshot,
      resolvedConfig,
      configuredPublishers,
      configuredObservers,
      options.actionExecutionObserver,
      (update) => handle.publish(update),
    );
    handle.bindInteractionSubmission((submission) =>
      execution.submitInteraction(submission)
    );
    handle.bindSteering((steering) => execution.submitSteering(steering));
    this.activeRunIds.add(runId);
    handle.start(async () => {
      try {
        return await execution.run();
      } finally {
        this.activeRunIds.delete(runId);
      }
    });
    return handle;
  }

  run<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
    options: RunInvocationOptions = {},
  ): Promise<RunResult<TOutput>> {
    return this.start(agent, input, config, options).wait();
  }
}

function snapshotRunnerContextProjection(
  input: RunnerDependencies["contextProjection"],
): RunnerDependencies["contextProjection"] {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Runner requires explicit Context projection configuration.");
  }
  if (typeof input.allocate !== "function") {
    throw new TypeError("Runner requires a Context projection allocation operation.");
  }
  if (
    input.policy === null ||
    typeof input.policy !== "object" ||
    typeof input.policy.decide !== "function"
  ) {
    throw new TypeError("Runner requires a Context projection policy operation.");
  }
  const request = snapshotContextProjectionRequest({
    id: "runner-context-projection-validation",
    activeContext: Object.freeze({
      id: "runner-context-validation",
      runId: "runner-context-validation",
      version: 0,
    }),
    consumer: Object.freeze({
      owner: "agent-core",
      kind: "controller",
      id: "runner-context-validation",
    }),
    purpose: input.purpose,
    profile: input.profile,
    budget: Object.freeze({ unit: "bytes", maximum: 0 }),
    policy: input.policy.ref,
    estimator: Object.freeze({
      id: "runner-context-estimator-validation",
      revision: "1",
      unit: "bytes",
      accuracy: "exact",
    }),
    audiences: input.audiences,
    mandatoryItems: Object.freeze([]),
    requestedAt: "2026-01-01T00:00:00.000Z",
  });
  if (
    !Number.isSafeInteger(input.maxContributionPayloadBytes) ||
    input.maxContributionPayloadBytes < 0
  ) {
    throw new TypeError("Runner Context contribution payload limit is invalid.");
  }
  return Object.freeze({
    purpose: request.purpose,
    profile: request.profile,
    policy: Object.freeze({
      ref: request.policy,
      decide: input.policy.decide.bind(input.policy),
    }),
    audiences: request.audiences,
    maxContributionPayloadBytes: input.maxContributionPayloadBytes,
    allocate: input.allocate.bind(input),
  });
}

function createEmergencyRunResult<TOutput>(
  runId: string,
  taskId: string,
): RunResult<TOutput> {
  const unknownAgent = Object.freeze({ id: "unknown", revision: "unknown" });
  const completedAt = new Date().toISOString();
  const failure = createRunFailureCause("runtime", Object.freeze({
    code: "runtime_execution_failed",
    message: "Agent Core execution could not settle its failure path.",
    retryable: false,
    metadata: Object.freeze({}),
  }));
  return createFailedRunResult<TOutput>(
    {
      runId,
      taskId,
      startingAgent: unknownAgent,
      finalActiveAgent: unknownAgent,
      startedAt: completedAt,
      completedAt,
      items: Object.freeze([]),
      metadata: Object.freeze({ emergencySettlement: true }),
    },
    "runtime_execution_failed",
    failure,
  );
}

function validateActionComposition(
  dependencies: ResolvedRunnerDependencies,
  config: ValidatedRunConfig,
): void {
  if (
    (dependencies.operations.actionExecution === undefined) !==
      (config.actionExecution === null)
  ) {
    throw new TypeError(
      "Runner Operation Action composition and RunConfig.actionExecution must be configured together.",
    );
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

function createDefaultRunIdentity(): string {
  return `run_${globalThis.crypto.randomUUID()}`;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
