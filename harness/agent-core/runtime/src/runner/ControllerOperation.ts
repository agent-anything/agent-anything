import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import { ContextContractError } from "@agent-anything/context/contract";
import {
  projectActiveContext,
  type ContextProjection,
  type ProjectionManifest,
} from "@agent-anything/context/projection";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import {
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import { projectPlan } from "../plan/index.js";
import {
  projectPendingRunSubject,
  projectPermissionContext,
  type RunState,
} from "../run/index.js";
import type { RetryEventSink } from "../retry/index.js";
import type { ResolvedRunConfig } from "./RunConfig.js";
import type {
  ResolvedRunnerDependencies,
  RunnerContextProjection,
} from "./RunnerDependencies.js";

export interface PreparedControllerOperation<TOutput> {
  readonly input: ControllerInput<TOutput>;
  readonly context: ContextProjection;
  readonly manifest: ProjectionManifest;
  readonly deadlineAt: string;
}

export class ContextProjectionPreparationError extends ContextContractError {
  constructor(
    readonly manifest: ProjectionManifest,
    readonly projectionFailure: {
      readonly code: string;
      readonly message: string;
    },
  ) {
    super(Object.freeze({
      code: "context_projection_contract_invalid",
      message: projectionFailure.message,
      path: projectionFailure.code,
    }));
    this.name = "ContextProjectionPreparationError";
  }
}

export interface PrepareControllerOperationInput<TOutput> {
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly config: ResolvedRunConfig;
  readonly state: RunState<TOutput>;
  readonly iteration: number;
  readonly exposure: ToolExposureProof;
  readonly contextProjection: RunnerContextProjection;
  readonly requestedAt: string;
}

export function prepareControllerOperation<TOutput>(
  input: PrepareControllerOperationInput<TOutput>,
): PreparedControllerOperation<TOutput> {
  const pendingApprovalCount = input.state.pending.filter(
    (candidate) =>
      candidate.kind === "interaction" &&
      candidate.interaction.request.protocol.owner === "permission" &&
      candidate.interaction.request.protocol.kind === "approval",
  ).length;
  const baseInput = Object.freeze({
    runId: input.state.run.id,
    iteration: input.iteration,
    agent: input.agent,
    task: input.runInput.task,
    inputItems: input.runInput.items,
    toolExposure: input.exposure,
    plan: input.state.plan === null ? null : projectPlan(input.state.plan),
    permission: projectPermissionContext(
      input.config.permissions,
      input.state.permission,
      pendingApprovalCount,
    ),
    pending: Object.freeze(input.state.pending.map(projectPendingRunSubject)),
    workspace: input.config.workspace,
    identity: input.config.identity,
    metadata: Object.freeze({ ...input.state.metadata }),
  });
  const projected = createContextProjection(input, baseInput);
  if (projected.status === "blocked") {
    throw new ContextProjectionPreparationError(
      projected.manifest,
      projected.failure,
    );
  }
  const manifest = projected.manifest;
  const context = projected.projection;
  return Object.freeze({
    context,
    manifest,
    deadlineAt: input.state.deadlineAt,
    input: Object.freeze({
      ...baseInput,
      context,
      contextManifest: Object.freeze({
        id: manifest.id,
        projectionId: manifest.projectionId,
        requestId: manifest.requestId,
        activeContext: manifest.activeContext,
        profile: manifest.profile,
        policy: manifest.policy,
        estimator: manifest.estimator,
        budget: manifest.budget,
        accounting: manifest.accounting,
      }),
    }),
  });
}

export function executeControllerOperation<TOutput>(input: {
  readonly dependencies: ResolvedRunnerDependencies;
  readonly prepared: PreparedControllerOperation<TOutput>;
  readonly config: ResolvedRunConfig;
  readonly retryEvents: RetryEventSink;
}): Promise<ControllerDecision<TOutput>> {
  return input.dependencies.controller.next(
    input.prepared.input,
    Object.freeze({
      cancellation: input.config.cancellation.context,
      retry: Object.freeze({
        providerRequest: input.config.retry.providerRequest,
        structuredOutput: input.config.retry.structuredOutput,
        deadlineAt: input.prepared.deadlineAt,
        events: input.retryEvents,
      }),
    }),
  ) as Promise<ControllerDecision<TOutput>>;
}

function createContextProjection<TOutput>(
  input: PrepareControllerOperationInput<TOutput>,
  baseInput: import("../controller/index.js").ControllerPreProjectionInput<TOutput>,
): ReturnType<typeof projectActiveContext> {
  const allocation = input.contextProjection.allocate(baseInput);
  const request = Object.freeze({
    id: `${input.state.run.id}:context-projection:${input.iteration}`,
    activeContext: input.state.context.ref,
    consumer: Object.freeze({ owner: "agent-core", kind: "controller", id: input.agent.id }),
    purpose: input.contextProjection.purpose,
    profile: input.contextProjection.profile,
    budget: allocation.budget,
    policy: input.contextProjection.policy.ref,
    estimator: allocation.estimator.ref,
    audiences: input.contextProjection.audiences,
    mandatoryItems: Object.freeze([]),
    requestedAt: input.requestedAt,
  });
  try {
    return projectActiveContext({
      context: input.state.context,
      request,
      estimator: allocation.estimator,
      policy: input.contextProjection.policy,
      maxContributionPayloadBytes: input.contextProjection.maxContributionPayloadBytes,
    });
  } catch (error) {
    if (error instanceof ContextContractError) throw error;
    throw new ContextContractError(Object.freeze({
      code: "context_projection_contract_invalid",
      message: "Context projection failed.",
      path: error instanceof Error ? error.name : "unknown",
    }));
  }
}
