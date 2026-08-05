import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import { projectContext } from "@agent-anything/context/context";
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

export interface ExecuteControllerOperationInput<TOutput> {
  readonly controller: Controller<unknown>;
  readonly agent: Agent<TOutput>;
  readonly input: RunInput;
  readonly config: ResolvedRunConfig;
  readonly state: RunState<TOutput>;
  readonly deadlineAt: string;
  readonly retryEvents: RetryEventSink;
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
    context: projectContext(input.state.context),
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
