import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { ActivityCheckpointError } from "../activity/ActivityCheckpoint.js";
import type { TaskDecisionMaker } from "../decision/TaskDecisionMaker.js";
import type { AgentActivityExecutionContext, TaskDecisionActivity, TaskDecisionInputSources, TaskDecisionProposal } from "../decision/TaskDecisionActivity.js";
import { validateTaskDecisionProposal } from "../decision/TaskDecisionValidation.js";
import { createControllerInputDeliveryReceipt } from "../decision/DecisionInputDelivery.js";
/** Coordinates a deterministic decision without inventing a model interaction. */
export class DirectTaskDecisionCoordinator<TOutput = unknown> implements TaskDecisionActivity<TOutput> {
  readonly resourceMetering = { modelInputTokens: "not_applicable", modelOutputTokens: "not_applicable", costUnits: "not_applicable" } as const;
  constructor(private readonly maker: TaskDecisionMaker<TOutput>) { }
  async next(source: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    context.cancellation.signal.throwIfAborted();
    const { output: _validation, ...definition } = source.agent;
    const binding = {
      runId: source.runId, activityId: source.toolExposure.controllerRequestId,
      sourceDigest: modelInputValueDigest({ ...source, agent: definition })
    };
    const key = `direct-task-decision:${binding.activityId}`;
    const records = context.checkpoints;
    const retained = records?.read(key) as {
      binding: typeof binding;
      proposal: TaskDecisionProposal<TOutput>;
    } | null | undefined;
    if (retained) {
      if (modelInputValueDigest(retained.binding) !== modelInputValueDigest(binding))
        throw new ActivityCheckpointError(key);
      const proposal = validateTaskDecisionProposal(retained.proposal, source);
      assertDirectProvenance(proposal);
      return proposal;
    }
    const proposed = await this.maker.decide({ kind: "direct", bindingId: modelInputValueDigest(binding), source }, { signal: context.cancellation.signal, executionFlow: context.executionFlow });
    const proposal = validateTaskDecisionProposal({...proposed, ...(source.inputDelivery ? {
      inputDeliveryReceipt: createControllerInputDeliveryReceipt(source.inputDelivery, source.toolExposure.controllerRequestId)
    } : {})}, source);
    assertDirectProvenance(proposal);
    context.cancellation.signal.throwIfAborted();
    await records?.commit(key, { binding, proposal });
    return proposal;
  }
  recover(source: TaskDecisionInputSources<TOutput>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<TOutput>> {
    return this.next(source, context);
  }
}

function assertDirectProvenance(proposal: TaskDecisionProposal<unknown>): void {
  if (proposal.modelItems.length !== 0 || proposal.kind !== "continue_with_feedback" &&
    (proposal.candidates.some(candidate => candidate.modelCallRef !== null) ||
      proposal.kind === "propose_completion" && proposal.completionSource.kind !== "controller")) {
    throw new TypeError("A direct task decision cannot invent model interaction provenance.");
  }
}
