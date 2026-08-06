import type { Controller, ControllerCallContext, ControllerDecision, ControllerInput } from "@agent-anything/agent-runtime/controller";
import type { CancellationContext } from "@agent-anything/agent-runtime/run";
import {
  acceptPatch,
  createPatchProposal,
  materializePatchReview,
  rejectPatch,
  type MaterializedPatchReview,
  type PatchProposalChange,
} from "./PatchWorkflow.js";
import { PatchWorkflowError } from "./PatchWorkflowError.js";
import { createAcceptedPatchFileAction } from "../file-actions/index.js";

import type {
  HelarcAgentOutput,
  HelarcChangeIntent,
} from "../controller/HelarcController.js";

export interface HelarcPatchOutcome {
  readonly status: "completed" | "rejected" | "failed" | "blocked";
  readonly patchStatus: "proposed" | "applied" | "rejected" | "failed";
  readonly appliedPath: string | null;
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

export interface HelarcPatchReviewDecision {
  readonly submissionId: string;
  readonly runId: string;
  readonly proposalId: string;
  readonly reviewId: string;
  readonly pendingVersion: number;
  readonly decision: "accepted" | "rejected";
  readonly reason: string | null;
}

export type HelarcPatchReviewResolution =
  | {
      readonly status: "decided";
      readonly submission: HelarcPatchReviewDecision;
    }
  | {
      readonly status: "interrupted";
      readonly cancellationRequestId: string;
    }
  | {
      readonly status: "failed";
      readonly code: "patch_review_unavailable" | "patch_review_state_invalid";
      readonly message: string;
    };

export interface HelarcPatchReviewPort {
  review(
    review: MaterializedPatchReview,
    cancellation: CancellationContext,
  ): Promise<HelarcPatchReviewResolution>;
}

export type HelarcPatchActionState =
  | { readonly kind: "none" }
  | {
      readonly kind: "reviewing";
      readonly runId: string;
      readonly proposalId: string;
      readonly reviewId: string;
    }
  | {
      readonly kind: "action_submitted";
      readonly runId: string;
      readonly proposalId: string;
      readonly reviewId: string;
      readonly pendingVersion: number;
    };

export interface HelarcPatchActionControllerInput {
  readonly controller: Controller<HelarcAgentOutput>;
  readonly patchReviewPort?: HelarcPatchReviewPort;
  readonly onStateChanged?: (state: HelarcPatchActionState) => void;
  readonly now?: () => string;
}

interface PendingPatchAction {
  readonly actionName: string;
  readonly summary: string;
  readonly path: string;
}

export class HelarcPatchActionController implements Controller<HelarcAgentOutput> {
  private pending: PendingPatchAction | null = null;
  private outcome: HelarcPatchOutcome | null = null;
  private state: HelarcPatchActionState = Object.freeze({ kind: "none" });

  constructor(private readonly input: HelarcPatchActionControllerInput) {}

  getPatchOutcome(): HelarcPatchOutcome | null {
    return this.outcome;
  }

  getPatchState(): HelarcPatchActionState {
    return this.state;
  }

  async next(
    controllerInput: ControllerInput<HelarcAgentOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<HelarcAgentOutput>> {
    if (this.pending !== null) {
      return this.settlePendingAction(controllerInput);
    }

    const decision = await this.input.controller.next(controllerInput, context);
    if (decision.kind !== "final_output" || decision.output.kind !== "propose") {
      return decision;
    }
    return this.reviewProposal(controllerInput, context, decision);
  }

  private async reviewProposal(
    controllerInput: ControllerInput<HelarcAgentOutput>,
    context: ControllerCallContext,
    decision: Extract<ControllerDecision<HelarcAgentOutput>, { readonly kind: "final_output" }>,
  ): Promise<ControllerDecision<HelarcAgentOutput>> {
    const output = decision.output;
    if (output.kind !== "propose") return decision;
    if (this.input.patchReviewPort === undefined) {
      this.outcome = patchOutcome("blocked", "proposed", null, [{
        code: "patch_review_unavailable",
        message: "Patch review bridge is unavailable.",
      }]);
      return completeDecision(output.summary, decision.modelItems);
    }

    try {
      const proposed = await createPatchProposal({
        runId: controllerInput.runId,
        workspace: controllerInput.workspace,
        change: toPatchProposalChange(output.change),
        summary: output.summary,
        rationale: output.summary,
        metadata: { product: "helarc" },
      }, { now: this.input.now });
      const review = await materializePatchReview({
        patch: proposed,
        workspace: controllerInput.workspace,
      });
      this.setState(Object.freeze({
        kind: "reviewing",
        runId: review.runId,
        proposalId: review.proposalId,
        reviewId: review.reviewId,
      }));
      const reviewOutcome = await this.input.patchReviewPort.review(
        review,
        context.cancellation,
      );
      if (reviewOutcome.status === "interrupted") {
        this.setState(Object.freeze({ kind: "none" }));
        return Object.freeze({
          kind: "stop" as const,
          reason: "Patch review was interrupted by Run cancellation.",
          modelItems: decision.modelItems,
        });
      }
      if (reviewOutcome.status === "failed") {
        this.setState(Object.freeze({ kind: "none" }));
        this.outcome = patchOutcome("failed", "failed", null, [{
          code: reviewOutcome.code,
          message: reviewOutcome.message,
        }]);
        return completeDecision(output.summary, decision.modelItems);
      }

      const reviewDecision = reviewOutcome.submission;
      const decisionInput = {
        runId: reviewDecision.runId,
        proposalId: reviewDecision.proposalId,
        reviewId: reviewDecision.reviewId,
        pendingVersion: reviewDecision.pendingVersion,
        submissionId: reviewDecision.submissionId,
        reason: reviewDecision.reason ?? undefined,
        now: this.input.now,
      };
      if (reviewDecision.decision === "rejected") {
        rejectPatch(proposed, {
          ...decisionInput,
          reason: reviewDecision.reason ?? "Patch proposal rejected.",
        });
        this.setState(Object.freeze({ kind: "none" }));
        this.outcome = patchOutcome("rejected", "rejected", null, []);
        return completeDecision(output.summary, decision.modelItems);
      }

      const accepted = acceptPatch(proposed, decisionInput);
      const action = createAcceptedPatchFileAction(accepted);
      const modelItem = decision.modelItems.at(-1);
      if (modelItem === undefined) {
        throw new TypeError("Accepted patch proposal has no originating model item.");
      }
      this.pending = Object.freeze({
        actionName: action.actionName,
        summary: output.summary,
        path: proposed.proposal.operation.path,
      });
      this.setState(Object.freeze({
        kind: "action_submitted",
        runId: reviewDecision.runId,
        proposalId: reviewDecision.proposalId,
        reviewId: reviewDecision.reviewId,
        pendingVersion: reviewDecision.pendingVersion,
      }));
      return Object.freeze({
        kind: "actions" as const,
        actions: Object.freeze([Object.freeze({
          kind: "tool" as const,
          name: action.actionName,
          input: action.input,
          origin: "workflow" as const,
          modelItemId: modelItem.id,
        })]) as unknown as Extract<
          ControllerDecision<HelarcAgentOutput>,
          { readonly kind: "actions" }
        >["actions"],
        modelItems: decision.modelItems,
      });
    } catch (error) {
      this.outcome = patchOutcome("failed", "failed", null, [{
        code: error instanceof PatchWorkflowError ? error.code : "patch_action_preparation_failed",
        message: error instanceof Error ? error.message : "Patch Action preparation failed.",
      }]);
      return completeDecision(output.summary, decision.modelItems);
    }
  }

  private settlePendingAction(
    input: ControllerInput<HelarcAgentOutput>,
  ): ControllerDecision<HelarcAgentOutput> {
    const pending = this.pending!;
    const observation = [...input.context.observations].reverse().find((candidate) =>
      candidate.metadata.actionName === pending.actionName ||
      candidate.kind === "tool_result" && candidate.result.toolName === pending.actionName,
    );
    this.pending = null;
    this.setState(Object.freeze({ kind: "none" }));
    if (observation?.kind === "tool_result" && observation.result.status === "succeeded") {
      this.outcome = patchOutcome("completed", "applied", pending.path, []);
    } else {
      this.outcome = patchOutcome("failed", "failed", null, [{
        code: observationCode(observation),
        message: observationMessage(observation),
      }]);
    }
    return completeDecision(pending.summary, [Object.freeze({
      id: `${input.runId}:patch:settled:${input.iteration}`,
      kind: "assistant",
      content: Object.freeze({ action: "complete", summary: pending.summary }),
      metadata: Object.freeze({ source: "helarc.patch-action" }),
    })]);
  }

  private setState(state: HelarcPatchActionState): void {
    this.state = state;
    this.input.onStateChanged?.(state);
  }
}

function completeDecision(
  summary: string,
  modelItems: Extract<
    ControllerDecision<HelarcAgentOutput>,
    { readonly kind: "final_output" }
  >["modelItems"],
): ControllerDecision<HelarcAgentOutput> {
  return Object.freeze({
    kind: "final_output" as const,
    output: Object.freeze({ kind: "complete" as const, summary }),
    modelItems,
  });
}

function patchOutcome(
  status: HelarcPatchOutcome["status"],
  patchStatus: HelarcPatchOutcome["patchStatus"],
  appliedPath: string | null,
  errors: readonly { readonly code: string; readonly message: string }[],
): HelarcPatchOutcome {
  return Object.freeze({
    status,
    patchStatus,
    appliedPath,
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  });
}

function toPatchProposalChange(change: HelarcChangeIntent): PatchProposalChange {
  return change.operation === "delete"
    ? { kind: "delete", path: change.path }
    : {
        kind: change.operation,
        path: change.path,
        proposedContent: change.content ?? "",
      };
}

function observationCode(observation: ControllerInput["context"]["observations"][number] | undefined): string {
  if (observation === undefined) return "patch_action_result_missing";
  if (observation.kind === "tool_result" && observation.result.status !== "succeeded") {
    return observation.result.error.code;
  }
  if (observation.kind === "action_failure") {
    return observation.failure.failure.code;
  }
  if (observation.kind === "action_denied" || observation.kind === "action_rejected") return observation.code;
  return "patch_action_failed";
}

function observationMessage(observation: ControllerInput["context"]["observations"][number] | undefined): string {
  if (observation === undefined) return "Patch Action produced no settled result.";
  if (observation.kind === "tool_result" && observation.result.status !== "succeeded") {
    return observation.result.error.message;
  }
  if (observation.kind === "action_failure") {
    return observation.failure.failure.message;
  }
  if (observation.kind === "action_denied" || observation.kind === "action_rejected") return observation.message;
  return "Patch Action failed.";
}
