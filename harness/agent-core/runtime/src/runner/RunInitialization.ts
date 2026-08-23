import type { Agent } from "@agent-anything/agent-core/agent";
import { toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import { createEmptyActiveContext } from "@agent-anything/context/active-context";
import {
  createInitialRunPermissionState,
  type RunState,
} from "../run/index.js";
import type { ResolvedRunConfig } from "./RunConfig.js";

export function createInitialRunState<TOutput>(input: {
  readonly runId: string;
  readonly agent: Agent<TOutput>;
  readonly input: RunInput;
  readonly config: ResolvedRunConfig;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly activeContextId: string;
}): RunState<TOutput> {
  const permissionState = createInitialRunPermissionState(input.config.permissions);
  const agent = toAgentRevisionRef(input.agent);
  const context = createEmptyActiveContext({
    id: input.activeContextId,
    runId: input.runId,
    createdAt: input.startedAt,
  });
  return Object.freeze({
    run: Object.freeze({ id: input.runId }),
    revision: 0,
    taskId: input.input.task.id,
    startingAgent: agent,
    activeAgent: agent,
    workspace: input.config.workspace,
    identity: input.config.identity,
    startedAt: input.startedAt,
    deadlineAt: input.deadlineAt,
    status: "initializing" as const,
    code: null,
    finalOutput: null,
    failure: null,
    relatedFailures: Object.freeze([]) as readonly [],
    cancellationRequest: null,
    completedAt: null,
    permission: permissionState,
    validation: Object.freeze({
      snapshot: Object.freeze({ runId: input.runId, revision: 0 }),
      gate: null,
    }),
    context,
    plan: null,
    items: Object.freeze([]),
    counters: Object.freeze({ controllerTurns: 0, runActions: 0, observations: 0, consecutiveActionFailures: 0 }),
    pending: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    metadata: Object.freeze({ ...input.config.metadata, ...input.input.metadata }),
  });
}
