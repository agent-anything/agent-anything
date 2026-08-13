import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  ContextProjectionError,
  snapshotContextProjection,
  type ContextProjection,
} from "@agent-anything/context/context";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import {
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import { projectPlan } from "../plan/index.js";
import {
  projectPendingRunSubject,
  projectPermissionContext,
  type RunObservation,
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
  readonly context: ContextProjection<RunObservation>;
  readonly deadlineAt: string;
}

export interface PrepareControllerOperationInput<TOutput> {
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly config: ResolvedRunConfig;
  readonly state: RunState<TOutput>;
  readonly iteration: number;
  readonly exposure: ToolExposureProof;
  readonly contextProjection: RunnerContextProjection;
}

export function prepareControllerOperation<TOutput>(
  input: PrepareControllerOperationInput<TOutput>,
): PreparedControllerOperation<TOutput> {
  const context = createContextProjection(input);
  const pendingApprovalCount = input.state.pending.filter(
    (candidate) =>
      candidate.kind === "interaction" &&
      candidate.interaction.request.protocol.owner === "permission" &&
      candidate.interaction.request.protocol.kind === "approval",
  ).length;
  return Object.freeze({
    context,
    deadlineAt: input.state.deadlineAt,
    input: Object.freeze({
      runId: input.state.run.id,
      iteration: input.iteration,
      agent: input.agent,
      task: input.runInput.task,
      inputItems: input.runInput.items,
      toolExposure: input.exposure,
      context,
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
): ContextProjection<RunObservation> {
  const request = Object.freeze({
    runId: input.state.run.id,
    controllerIteration: input.iteration,
    purpose: input.contextProjection.purpose,
    limits: input.contextProjection.limits,
  });
  let projected: ContextProjection<RunObservation>;
  try {
    projected = input.contextProjection.projector.project({
      context: input.state.context,
      request,
    });
  } catch (error) {
    if (error instanceof ContextProjectionError) throw error;
    throw new ContextProjectionError(Object.freeze({
      code: "context_projection_failed",
      message: "Context projector failed.",
      retryable: false,
      metadata: Object.freeze({
        ...(error instanceof Error ? { causeName: error.name } : {}),
      }),
    }));
  }
  const projection = snapshotContextProjection({ projection: projected, request });
  assertProjectionDerivation(input.state, projection);
  return projection;
}

function assertProjectionDerivation(
  state: RunState,
  projection: ContextProjection<RunObservation>,
): void {
  const observations = new Map(
    state.context.observations.map((observation) => [observation.id, observation]),
  );
  for (const projected of projection.observations) {
    const source = observations.get(projected.id);
    if (
      source === undefined ||
      source.runId !== projected.runId ||
      source.actionId !== projected.actionId ||
      source.kind !== projected.kind ||
      source.createdAt !== projected.createdAt
    ) {
      throw projectionDerivationError(
        "Context projector changed or fabricated Observation correlation.",
      );
    }
  }

  const messages = new Map(
    state.context.messages.map((message) => [message.id, message]),
  );
  for (const projected of projection.messages) {
    const source = messages.get(projected.id);
    if (source === undefined || source.role !== projected.role) {
      throw projectionDerivationError(
        "Context projector changed or fabricated message correlation.",
      );
    }
  }
  const evidenceRefs = new Set(state.context.evidenceRefs);
  if (projection.evidenceRefs.some((reference) => !evidenceRefs.has(reference))) {
    throw projectionDerivationError(
      "Context projector fabricated an Evidence reference.",
    );
  }
}

function projectionDerivationError(message: string): ContextProjectionError {
  return new ContextProjectionError(Object.freeze({
    code: "context_projection_not_derived",
    message,
    retryable: false,
    metadata: Object.freeze({}),
  }));
}
