import type { Agent } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
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
import {
  RunExecution,
  type RuntimeDescendantRunStartInput,
  type RuntimeDescendantRunStartResult,
} from "./RunExecution.js";
import type {
  ResolvedRunConfig,
  RootRunConfig,
  RunConfig,
  ValidatedRunConfig,
} from "./RunConfig.js";
import { RunTreeExecution } from "./RunTreeExecution.js";
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
  assessDelegationContextConstruction,
} from "../delegation/DelegationContextConstruction.js";
import {
  deriveDelegatedRunConfig,
  projectDelegationRunAuthority,
  projectDelegationRunLimits,
} from "../delegation/DelegationRunConfiguration.js";
import {
  createDelegationResourceCapacity,
  DelegationResourceLedger,
  type DelegationResourceSettlement,
  type DelegationResourceUsage,
} from "../delegation/DelegationResourceLedger.js";
import {
  snapshotDelegationAuthorityDerivation,
  snapshotDelegationLimitDerivation,
  snapshotDelegationRequest,
  type DelegationContextMaterial,
  type DelegationRequest,
} from "../delegation/index.js";
import { measureDelegationInitialContextBytes } from "../context-contribution/index.js";
import {
  snapshotAgent,
  snapshotRunConfig,
  snapshotRootRunConfig,
  snapshotRunInput,
} from "./RunnerValidation.js";

export class Runner {
  private readonly dependencies: ResolvedRunnerDependencies;
  private readonly activeRunIds = new Set<string>();

  constructor(dependencies: RunnerDependencies) {
    if (!dependencies.controller || typeof dependencies.controller.next !== "function") {
      throw new TypeError("Runner requires a Controller.");
    }
    if (!dependencies.validation ||
        typeof dependencies.validation.executionFactory?.create !== "function" ||
        typeof dependencies.validation.completionGate?.evaluate !== "function") {
      throw new TypeError("Runner requires explicit Validation execution and Completion Gate dependencies.");
    }

    const now = dependencies.now ?? (() => new Date().toISOString());
    const contextProjection = snapshotRunnerContextProjection(
      dependencies.contextProjection,
    );
    const operations = snapshotRunnerOperationComposition(dependencies.operations);
    this.dependencies = Object.freeze({
      ...dependencies,
      contextProjection,
      operations,
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
    config: RootRunConfig,
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
    const configSnapshot = snapshotRootRunConfig(config);
    if (!configSnapshot.valid) {
      throw new TypeError(configSnapshot.failure.message);
    }
    validateActionComposition(this.dependencies, configSnapshot.config);

    const runId = this.dependencies.createRunId();
    assertNonEmpty(runId, "Runner-created runId");
    if (this.activeRunIds.has(runId)) {
      throw new TypeError(`Runner-created runId '${runId}' is already active.`);
    }
    const startedAt = this.dependencies.now();
    const deadlineAt = localDeadline(startedAt, configSnapshot.config.limits.maxDurationMs);
    const tree = new RunTreeExecution({
      rootRunId: runId,
      startedAt,
      deadlineAt,
      limits: configSnapshot.config.runTreeLimits,
      now: this.dependencies.now,
    });
    const ordinaryConfig = snapshotRunConfig(configSnapshot.config);
    if (!ordinaryConfig.valid) {
      throw new TypeError(ordinaryConfig.failure.message);
    }
    const rootDelegationLimits = projectDelegationRunLimits({
      config: ordinaryConfig.config,
      maxContextBytes: delegationPayloadCeiling(
        this.dependencies.contextProjection.maxContributionPayloadBytes,
        4,
      ),
      maxResultBytes: delegationPayloadCeiling(
        this.dependencies.contextProjection.maxContributionPayloadBytes,
        1,
      ),
    });
    const delegationResources = new DelegationResourceLedger(
      createDelegationResourceCapacity({
        perDescendant: rootDelegationLimits,
        maxTotalDescendants:
          configSnapshot.config.runTreeLimits.maxTotalDescendantRuns,
      }),
    );
    return this.startPreparedRun(
      runId,
      agentSnapshot,
      inputSnapshot,
      ordinaryConfig.config,
      inputSnapshot.task,
      ordinaryConfig.config,
      null,
      null,
      tree.rootLineage,
      tree,
      delegationResources,
      startedAt,
      deadlineAt,
      configuredPublishers,
      configuredObservers,
      options.actionExecutionObserver,
    );
  }

  run<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RootRunConfig,
    options: RunInvocationOptions = {},
  ): Promise<RunResult<TOutput>> {
    return this.start(agent, input, config, options).wait();
  }

  private startDescendant(
    input: RuntimeDescendantRunStartInput,
    parentRunId: string,
    parentLineage: RunLineage,
    parentDeadlineAt: string,
    parentTask: AgentTask,
    parentConfig: RunConfig,
    rootTask: AgentTask,
    rootConfig: RunConfig,
    tree: RunTreeExecution,
    delegationResources: DelegationResourceLedger,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: RunInvocationOptions["actionExecutionObserver"],
  ): RuntimeDescendantRunStartResult {
    let request: DelegationRequest;
    let agent: Agent;
    let config: ValidatedRunConfig;
    let rootPurpose: DelegationContextMaterial;
    let contextBytes: number;
    let rejectionCode:
      | "delegation_request_invalid"
      | "delegation_authority_invalid"
      | "delegation_context_invalid" = "delegation_request_invalid";
    try {
      request = snapshotDelegationRequest(input.request);
      agent = snapshotAgent(input.agent);
      if (!sameAgentRevision(agent, request.childAgent)) {
        throw new TypeError("Delegation child Agent does not match the trusted request.");
      }
      if (
        request.origin.root.run.id !== tree.rootLineage.root.id ||
        request.origin.root.task.id !== rootTask.id ||
        request.origin.parent.run.id !== parentRunId ||
        request.origin.parent.task.id !== parentTask.id ||
        request.origin.parent.action.id !== input.parentRunAction.id ||
        request.origin.parent.action.sequence !== input.parentRunAction.sequence ||
        request.origin.parent.lineage.root.id !== parentLineage.root.id ||
        request.origin.parent.lineage.depth !== parentLineage.depth
      ) {
        throw new TypeError("Delegation origin does not match the authoritative Run Tree edge.");
      }
      rejectionCode = "delegation_authority_invalid";
      const authority = snapshotDelegationAuthorityDerivation(input.authority);
      const limits = snapshotDelegationLimitDerivation(input.limits);
      if (
        request.authorityDerivation.id !== authority.ref.id ||
        request.authorityDerivation.revision !== authority.ref.revision ||
        request.limitDerivation.id !== limits.ref.id ||
        request.limitDerivation.revision !== limits.ref.revision ||
        request.limits.revision !== limits.effective.revision
      ) {
        throw new TypeError("Delegation request does not match its trusted derivations.");
      }
      const derivedConfig = deriveDelegatedRunConfig({
        parent: parentConfig,
        request,
        authority,
      });
      rejectionCode = "delegation_context_invalid";
      const contextAssessment = assessDelegationContextConstruction({
        request,
        rootTask,
        rootPurpose: input.rootPurpose,
      });
      rootPurpose = contextAssessment.rootPurpose;
      contextBytes = measureDelegationInitialContextBytes({
        rootPurpose: contextAssessment.rootPurpose,
        childTask: request.task,
      });
      if (contextBytes > request.limits.maxContextBytes) {
        throw new TypeError("Delegation initial Context exceeds its effective limit.");
      }
      rejectionCode = "delegation_authority_invalid";
      const configSnapshot = snapshotRunConfig(Object.freeze({
        ...derivedConfig,
        metadata: Object.freeze({
          ...derivedConfig.metadata,
          omittedContextMaterials: contextAssessment.omitted.map((material) =>
            Object.freeze({ ...material })),
        }),
      }));
      if (!configSnapshot.valid) {
        throw new TypeError(configSnapshot.failure.message);
      }
      config = configSnapshot.config;
      validateActionComposition(this.dependencies, config);
    } catch {
      return Object.freeze({
        status: "rejected" as const,
        code: rejectionCode,
        relation: null,
        reservedTreeRevision: null,
        treeRevision: tree.getSnapshot().revision,
      });
    }

    const resourceReservation = delegationResources.reserve(
      request.ref.id,
      request.limits,
    );
    if (resourceReservation.status === "rejected") {
      return Object.freeze({
        status: "rejected" as const,
        code: resourceReservation.code,
        relation: null,
        reservedTreeRevision: null,
        treeRevision: tree.getSnapshot().revision,
      });
    }

    const startedAt = this.dependencies.now();
    let reservation: ReturnType<RunTreeExecution["reserveDescendant"]>;
    try {
      reservation = tree.reserveDescendant({
        relationId: input.relationId,
        createChildRunId: () => {
          const childRunId = this.dependencies.createRunId();
          assertNonEmpty(childRunId, "Runner-created descendant runId");
          if (this.activeRunIds.has(childRunId)) {
            throw new TypeError("Runner-created descendant runId is already active.");
          }
          return childRunId;
        },
        parentRunId,
        parentLineage,
        parentRunAction: input.parentRunAction,
        parentDeadlineAt,
        childLocalDeadlineAt: localDeadline(
          startedAt,
          config.limits.maxDurationMs,
        ),
      });
    } catch {
      delegationResources.release(request.ref.id);
      return Object.freeze({
        status: "rejected" as const,
        code: "descendant_run_start_failed" as const,
        relation: null,
        reservedTreeRevision: null,
        treeRevision: tree.getSnapshot().revision,
      });
    }
    if (reservation.status === "rejected") {
      delegationResources.release(request.ref.id);
      return Object.freeze({
        ...reservation,
        relation: null,
        reservedTreeRevision: null,
      });
    }

    try {
      const childRunId = reservation.relation.child.id;
      const runInput = snapshotRunInput(createDelegatedRunInput({
        request,
        childRunId,
        startedAt,
      }));
      const handle = this.startPreparedRun(
        childRunId,
        agent,
        runInput,
        config,
        rootTask,
        rootConfig,
        request,
        rootPurpose,
        reservation.lineage,
        tree,
        delegationResources,
        startedAt,
        reservation.deadlineAt,
        runtimeEventPublishers,
        runTraceObservers,
        actionExecutionObserver,
      );
      const resourceSettlement = handle.wait().then((result) =>
        delegationResources.settle(
          request.ref.id,
          measureDelegationResourceUsage(
            result,
            contextBytes,
            request.limits.maxResultBytes,
          ),
        ));
      return Object.freeze({
        status: "started" as const,
        relation: reservation.relation,
        handle,
        resourceSettlement,
        reservedTreeRevision: reservation.treeRevision,
        treeRevision: tree.getSnapshot().revision,
      });
    } catch {
      delegationResources.release(request.ref.id);
      tree.failStart(reservation.relation.child.id, this.dependencies.now());
      return Object.freeze({
        status: "rejected" as const,
        code: "descendant_run_start_failed" as const,
        relation: reservation.relation,
        reservedTreeRevision: reservation.treeRevision,
        treeRevision: tree.getSnapshot().revision,
      });
    }
  }

  private startPreparedRun<TOutput>(
    runId: string,
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
    rootTask: AgentTask,
    rootConfig: RunConfig,
    delegationRequest: DelegationRequest | null,
    delegationRootPurpose: DelegationContextMaterial | null,
    lineage: RunLineage,
    tree: RunTreeExecution,
    delegationResources: DelegationResourceLedger,
    startedAt: string,
    deadlineAt: string,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: RunInvocationOptions["actionExecutionObserver"],
  ): RunHandle<TOutput> {
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
      ...config,
      cancellation,
    });
    const emergencyResult = createEmergencyRunResult<TOutput>(runId, input.task.id);
    let unsubscribeTree = (): void => undefined;
    const handle = new ActiveRunHandle<TOutput>(
      runId,
      cancellation,
      emergencyResult,
      tree.getSnapshot(),
      (result) => {
        try {
          tree.settleRun(runId, result.status, result.code, result.completedAt);
        } finally {
          this.activeRunIds.delete(runId);
          unsubscribeTree();
        }
      },
    );
    const execution = new RunExecution<TOutput>(
      runId,
      this.dependencies,
      agent,
      input,
      resolvedConfig,
      rootTask,
      rootConfig,
      delegationRequest,
      delegationRootPurpose,
      lineage,
      runtimeEventPublishers,
      runTraceObservers,
      actionExecutionObserver,
      startedAt,
      deadlineAt,
      (descendant) => this.startDescendant(
        descendant,
        runId,
        lineage,
        deadlineAt,
        input.task,
        config,
        rootTask,
        rootConfig,
        tree,
        delegationResources,
        runtimeEventPublishers,
        runTraceObservers,
        actionExecutionObserver,
      ),
      () => tree.getSnapshot(),
      (update) => {
        tree.updateLifecycle(runId, update.status);
        handle.publishRunTree(tree.getSnapshot());
        handle.publish(update);
      },
    );
    handle.bindInteractionSubmission((submission) =>
      execution.submitInteraction(submission)
    );
    handle.bindSteering((steering) => execution.submitSteering(steering));
    this.activeRunIds.add(runId);
    tree.registerCancellation(runId, cancellation);
    tree.markStarted(runId, startedAt);
    if (lineage.kind === "root") {
      unsubscribeTree = tree.subscribe((snapshot) => handle.publishRunTree(snapshot));
    }
    handle.start(() => execution.run());
    return handle;
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
  if (
    input.manifestPersistence !== undefined &&
    typeof input.manifestPersistence.persistManifest !== "function"
  ) {
    throw new TypeError("Runner Context Manifest persistence port is invalid.");
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
    ...(input.manifestPersistence === undefined
      ? {}
      : {
          manifestPersistence: Object.freeze({
            persistManifest:
              input.manifestPersistence.persistManifest.bind(
                input.manifestPersistence,
              ),
          }),
        }),
  });
}

function snapshotRunnerOperationComposition(
  input: RunnerDependencies["operations"],
): RunnerDependencies["operations"] {
  if (input === null || typeof input !== "object" || !Array.isArray(input.availability)) {
    throw new TypeError("Runner requires explicit Operation Tool availability participants.");
  }
  const availability = input.availability.map((participant) => {
    if (
      participant === null ||
      typeof participant !== "object" ||
      typeof participant.assess !== "function"
    ) {
      throw new TypeError("Runner Operation Tool availability participant is invalid.");
    }
    return Object.freeze({
      binding: participant.binding,
      assess: participant.assess.bind(participant),
    });
  });
  const delegation = input.delegation === undefined
    ? undefined
    : snapshotRunnerDelegationComposition(input.delegation);
  return Object.freeze({
    ...input,
    internalHandlers: Object.freeze([...input.internalHandlers]),
    availability: Object.freeze(availability),
    ...(delegation === undefined ? {} : { delegation }),
  });
}

function snapshotRunnerDelegationComposition(
  input: NonNullable<RunnerDependencies["operations"]["delegation"]>,
): NonNullable<RunnerDependencies["operations"]["delegation"]> {
  if (
    input === null ||
    typeof input !== "object" ||
    input.preparation === null ||
    typeof input.preparation !== "object" ||
    typeof input.preparation.assessAvailability !== "function" ||
    typeof input.preparation.prepare !== "function" ||
    input.resultProjection === null ||
    typeof input.resultProjection !== "object" ||
    typeof input.resultProjection.project !== "function"
  ) {
    throw new TypeError("Runner delegation composition is invalid.");
  }
  return Object.freeze({
    preparation: Object.freeze({
      assessAvailability:
        input.preparation.assessAvailability.bind(input.preparation),
      prepare: input.preparation.prepare.bind(input.preparation),
    }),
    resultProjection: Object.freeze({
      project: input.resultProjection.project.bind(input.resultProjection),
    }),
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

function createDelegatedRunInput(input: {
  readonly request: DelegationRequest;
  readonly childRunId: string;
  readonly startedAt: string;
}): RunInput {
  const taskId = `${input.request.ref.id}:task`;
  return Object.freeze({
    task: Object.freeze({
      id: taskId,
      kind: input.request.task.kind,
      input: input.request.task.input,
      createdAt: input.startedAt,
      metadata: Object.freeze({
        ...input.request.task.metadata,
        delegationRequestId: input.request.ref.id,
        delegationRequestRevision: input.request.ref.revision,
        rootTaskId: input.request.origin.root.task.id,
        parentTaskId: input.request.origin.parent.task.id,
      }),
    }),
    items: Object.freeze([Object.freeze({
      id: `${input.request.ref.id}:objective`,
      kind: "message" as const,
      role: "user" as const,
      content: input.request.objective.text,
      createdAt: input.startedAt,
      metadata: Object.freeze({
        source: "delegation_objective",
        delegationRequestId: input.request.ref.id,
      }),
    })]),
    metadata: Object.freeze({
      delegationRequestId: input.request.ref.id,
      delegationRequestRevision: input.request.ref.revision,
      childRunId: input.childRunId,
    }),
  });
}

function measureDelegationResourceUsage(
  result: RunResult,
  contextBytes: number,
  maxResultBytes: number,
): DelegationResourceUsage {
  let controllerTurns = 0;
  let actions = 0;
  for (const item of result.items) {
    if (item.payload.kind === "controller_turn") controllerTurns += 1;
    if (item.payload.kind === "run_action") actions += 1;
  }
  let resultBytes: number;
  try {
    resultBytes = new TextEncoder().encode(JSON.stringify({
      status: result.status,
      code: result.code,
      finalOutput: result.finalOutput,
      evidenceRefs: result.evidenceRefs,
      artifactRefs: result.artifactRefs,
    })).byteLength;
  } catch {
    resultBytes = maxResultBytes + 1;
  }
  return Object.freeze({
    controllerTurns,
    actions,
    contextBytes,
    resultBytes,
  });
}

function sameAgentRevision(
  left: Pick<Agent, "id" | "revision">,
  right: Pick<Agent, "id" | "revision">,
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function delegationPayloadCeiling(value: number, multiplier: number): number {
  const ceiling = value * multiplier;
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new TypeError("Delegation payload ceiling must be a positive safe integer.");
  }
  return ceiling;
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

function localDeadline(startedAt: string, maxDurationMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new TypeError("Runner time source returned an invalid date-time.");
  }
  return new Date(startedAtMs + maxDurationMs).toISOString();
}
