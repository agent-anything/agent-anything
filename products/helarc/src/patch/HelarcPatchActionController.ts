import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import {
  acceptPatch,
  createPatchProposal,
  materializePatchReview,
  PatchWorkflowError,
  rejectPatch,
  type MaterializedPatchReview,
  type PatchProposalChange,
} from "@agent-anything/code-agent/patch";
import { createAcceptedPatchFileAction } from "@agent-anything/code-agent/filesystem";
import type { ISODateTimeString } from "@agent-anything/shared";
import type {
  HelarcAgentOutput,
  HelarcChangeIntent,
} from "../controller/HelarcController.js";
import type {
  HelarcPatchReviewBridge,
  HelarcPatchReviewRequest,
  HelarcProductPhase,
} from "../composition/HelarcPatchReview.js";

export interface HelarcPatchOutcome {
  readonly productStatus: "completed" | "rejected" | "failed" | "blocked";
  readonly patchStatus: "proposed" | "applied" | "rejected" | "failed";
  readonly appliedPath: string | null;
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

export interface HelarcPatchActionControllerInput {
  readonly controller: Controller<HelarcAgentOutput>;
  readonly patchReviewBridge?: HelarcPatchReviewBridge;
  readonly onPhaseChanged?: (phase: HelarcProductPhase) => void;
  readonly now?: () => ISODateTimeString;
}

interface PendingPatchAction {
  readonly actionName: string;
  readonly summary: string;
  readonly path: string;
}

export class HelarcPatchActionController implements Controller<HelarcAgentOutput> {
  private pending: PendingPatchAction | null = null;
  private outcome: HelarcPatchOutcome | null = null;
  private phase: HelarcProductPhase = Object.freeze({ kind: "none" });

  constructor(private readonly input: HelarcPatchActionControllerInput) {}

  getPatchOutcome(): HelarcPatchOutcome | null {
    return this.outcome;
  }

  getProductPhase(): HelarcProductPhase {
    const pendingReview = this.input.patchReviewBridge?.getPendingProjection() ?? null;
    return pendingReview === null
      ? this.phase
      : Object.freeze({ kind: "waiting_for_patch_review", review: pendingReview });
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
    if (this.input.patchReviewBridge === undefined) {
      this.outcome = patchOutcome("blocked", "proposed", null, [{
        code: "patch_review_unavailable",
        message: "Patch review bridge is unavailable.",
      }]);
      return completeDecision(output.summary, decision.modelItems);
    }

    try {
      const proposed = await createPatchProposal({
        runId: controllerInput.runId,
        workspaceScope: controllerInput.task.workspaceScope,
        change: toPatchProposalChange(output.change),
        summary: output.summary,
        rationale: output.summary,
        metadata: { product: "helarc" },
      }, { now: this.input.now });
      const review = toReviewRequest(await materializePatchReview({
        patch: proposed,
        workspaceScope: controllerInput.task.workspaceScope,
      }));
      const reviewOutcome = await this.input.patchReviewBridge.review(
        review,
        context.cancellation,
      );
      if (reviewOutcome.status === "interrupted") {
        this.setPhase(Object.freeze({ kind: "none" }));
        return Object.freeze({
          kind: "stop" as const,
          reason: "Patch review was interrupted by Run cancellation.",
          modelItems: decision.modelItems,
        });
      }
      if (reviewOutcome.status === "failed") {
        this.setPhase(Object.freeze({ kind: "none" }));
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
        this.setPhase(Object.freeze({ kind: "none" }));
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
      this.setPhase(Object.freeze({
        kind: "patch_action_submitted",
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
    this.setPhase(Object.freeze({ kind: "none" }));
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

  private setPhase(phase: HelarcProductPhase): void {
    this.phase = phase;
    this.input.onPhaseChanged?.(phase);
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
  productStatus: HelarcPatchOutcome["productStatus"],
  patchStatus: HelarcPatchOutcome["patchStatus"],
  appliedPath: string | null,
  errors: readonly { readonly code: string; readonly message: string }[],
): HelarcPatchOutcome {
  return Object.freeze({
    productStatus,
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

function toReviewRequest(review: MaterializedPatchReview): HelarcPatchReviewRequest {
  return {
    runId: review.runId,
    proposalId: review.proposalId,
    reviewId: review.reviewId,
    rootName: review.rootName,
    workspaceId: review.workspaceId,
    path: review.path,
    operation: review.operation,
    summary: review.summary,
    rationale: review.rationale,
    originalContent: review.originalContent,
    proposedContent: review.proposedContent,
    originalContentBytes: review.originalContentBytes,
    proposedContentBytes: review.proposedContentBytes,
  };
}

function observationCode(observation: ControllerInput["context"]["observations"][number] | undefined): string {
  if (observation === undefined) return "patch_action_result_missing";
  if (observation.kind === "tool_result") return observation.result.error?.code ?? "patch_action_failed";
  if (observation.kind === "action_failure") return observation.error.code;
  if (observation.kind === "action_denied" || observation.kind === "action_rejected") return observation.code;
  return "patch_action_failed";
}

function observationMessage(observation: ControllerInput["context"]["observations"][number] | undefined): string {
  if (observation === undefined) return "Patch Action produced no settled result.";
  if (observation.kind === "tool_result") return observation.result.error?.message ?? "Patch Action failed.";
  if (observation.kind === "action_failure") return observation.error.message;
  if (observation.kind === "action_denied" || observation.kind === "action_rejected") return observation.message;
  return "Patch Action failed.";
}
