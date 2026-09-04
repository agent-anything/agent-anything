import type { Agent } from "@agent-anything/agent-core/agent";
import { toAgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import { createEmptyActiveContext } from "@agent-anything/context/active-context";
import {
  createInitialRunPermissionState,
  type RunState,
} from "../run/index.js";
import type { ResolvedRunConfig } from "./RunConfig.js";
import { createInitialRunLifecycleHookState } from "../hooks/index.js";
import {
  assertAgentInstructionBindingMatches,
  snapshotAgentInstructionBindingRef,
  type AgentInstructionBinding,
} from "../instructions/index.js";

export function createInitialRunState<TOutput>(input: {
  readonly runId: string;
  readonly agent: Agent<TOutput>;
  readonly instructionBinding: AgentInstructionBinding;
  readonly input: RunInput;
  readonly config: ResolvedRunConfig;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly activeContextId: string;
}): RunState<TOutput> {
  const permissionState = createInitialRunPermissionState(input.config.permissions);
  const agent = toAgentRevisionRef(input.agent);
  assertAgentInstructionBindingMatches({
    binding: input.instructionBinding,
    run: { id: input.runId },
    agent: input.agent,
  });
  if (input.instructionBinding.effectiveFromRunRevision !== 0) {
    throw new TypeError("Starting AgentInstructionBinding must be effective from Run revision 0.");
  }
  if (input.instructionBinding.supersedes !== null) {
    throw new TypeError("Starting AgentInstructionBinding cannot supersede another binding.");
  }
  const instructionBinding = snapshotAgentInstructionBindingRef(input.instructionBinding.ref);
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
    startingInstructionBinding: instructionBinding,
    activeInstructionBinding: instructionBinding,
    workspace: input.config.workspace,
    identity: input.config.identity,
    startedAt: input.startedAt,
    deadlineAt: input.deadlineAt,
    status: "initializing" as const,
    finalOutput: null,
    settlement: null,
    settlementCause: null,
    settlementCauses: Object.freeze([]),
    suspension: null,
    cancellationRequest: null,
    completedAt: null,
    permission: permissionState,
    verification: Object.freeze({
      snapshot: Object.freeze({ runId: input.runId, revision: 0 }),
      gate: null,
      feedbackRounds: 0,
    }),
    lifecycleHooks: createInitialRunLifecycleHookState(),
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
