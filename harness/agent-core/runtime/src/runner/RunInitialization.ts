import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import { createInitialContext } from "@agent-anything/context/context";
import {
  assertRunPermissionStateInvariant,
  createInitialRunPermissionState,
  type RunState,
} from "../run/index.js";
import type { RunObservation } from "../run/RunObservation.js";
import type { ResolvedRunConfig } from "./RunConfig.js";

export interface CreateInitialRunStateInput<TOutput> {
  readonly runId: string;
  readonly agent: Agent<TOutput>;
  readonly input: RunInput;
  readonly config: ResolvedRunConfig;
  readonly startedAt: string;
}

export function createInitialRunState<TOutput>(
  input: CreateInitialRunStateInput<TOutput>,
): RunState<TOutput> {
  const permission = createInitialRunPermissionState(input.config.permissions);
  const state: RunState<TOutput> = {
    runId: input.runId,
    taskId: input.input.task.id,
    startingAgentId: input.agent.id,
    activeAgentId: input.agent.id,
    workspace: input.config.workspace,
    identity: input.config.identity,
    startedAt: input.startedAt,
    status: "initializing",
    code: null,
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]) as readonly [],
    cancellationRequest: null,
    permission,
    context: createInitialContext<RunObservation>(input.input.task),
    plan: null,
    items: Object.freeze([]),
    counters: Object.freeze({
      iterations: 0,
      actions: 0,
      consecutiveActionFailures: 0,
    }),
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    metadata: Object.freeze({
      ...input.config.metadata,
      ...input.input.metadata,
    }),
  };
  assertRunPermissionStateInvariant(state.permission, state.status);
  return Object.freeze(state);
}
