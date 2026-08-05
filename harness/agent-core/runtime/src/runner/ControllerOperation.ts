import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  ContextProjectionError,
  snapshotContextProjection,
  type ContextProjection,
} from "@agent-anything/context/context";
import {
  type Controller,
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import { projectPlan } from "../plan/index.js";
import {
  projectPermissionContext,
  type RunState,
} from "../run/index.js";
import type { RetryEventSink } from "../retry/index.js";
import type { ResolvedRunConfig } from "./RunConfig.js";
import type { RunnerContextProjection } from "./RunnerDependencies.js";
import type { RunObservation } from "../run/RunObservation.js";

export interface ExecuteControllerOperationInput<TOutput> {
  readonly controller: Controller<unknown>;
  readonly agent: Agent<TOutput>;
  readonly input: RunInput;
  readonly config: ResolvedRunConfig;
  readonly state: RunState<TOutput>;
  readonly deadlineAt: string;
  readonly retryEvents: RetryEventSink;
  readonly contextProjection: RunnerContextProjection;
}

export function executeControllerOperation<TOutput>(
  input: ExecuteControllerOperationInput<TOutput>,
): Promise<ControllerDecision<unknown>> {
  return input.controller.next(
    createControllerInput(input),
    Object.freeze({
      cancellation: input.config.cancellation.context,
      retry: Object.freeze({
        providerRequest: input.config.retry.providerRequest,
        structuredOutput: input.config.retry.structuredOutput,
        deadlineAt: input.deadlineAt,
        events: input.retryEvents,
      }),
    }),
  );
}

function createControllerInput<TOutput>(
  input: ExecuteControllerOperationInput<TOutput>,
): ControllerInput<unknown> {
  return Object.freeze({
    runId: input.state.runId,
    iteration: input.state.counters.iterations,
    agent: input.agent,
    task: input.input.task,
    inputItems: input.input.items,
    toolCatalog: input.config.toolBindings.toolCatalog,
    toolSelectionId: input.config.toolBindings.toolSelectionId,
    context: createContextProjection(input),
    plan: input.state.plan === null ? null : projectPlan(input.state.plan),
    permission: projectPermissionContext(
      input.config.permissions,
      input.state.permission,
    ),
    workspace: input.config.workspace,
    identity: input.config.identity,
    metadata: Object.freeze({ ...input.state.metadata }),
  });
}

function createContextProjection<TOutput>(
  input: ExecuteControllerOperationInput<TOutput>,
): ContextProjection<RunObservation> {
  const request = Object.freeze({
    runId: input.state.runId,
    controllerIteration: input.state.counters.iterations,
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
    if (error instanceof ContextProjectionError) {
      throw error;
    }
    throw new ContextProjectionError(Object.freeze({
      code: "context_projection_failed",
      message: "Context projector failed.",
      retryable: false,
      metadata: Object.freeze({
        ...(error instanceof Error ? { causeName: error.name } : {}),
      }),
    }));
  }
  const projection = snapshotContextProjection({
    projection: projected,
    request,
  });
  assertProjectionDerivation(input.state.context, projection);
  return projection;
}

function assertProjectionDerivation(
  context: RunState["context"],
  projection: ContextProjection<RunObservation>,
): void {
  const observations = new Map(
    context.observations.map((observation) => [observation.id, observation]),
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
    context.messages.map((message) => [message.id, message]),
  );
  for (const projected of projection.messages) {
    const source = messages.get(projected.id);
    if (source === undefined || source.role !== projected.role) {
      throw projectionDerivationError(
        "Context projector changed or fabricated message correlation.",
      );
    }
  }

  const evidenceRefs = new Set(context.evidenceRefs);
  if (
    projection.evidenceRefs.some((reference) => !evidenceRefs.has(reference))
  ) {
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
