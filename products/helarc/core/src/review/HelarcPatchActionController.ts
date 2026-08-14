import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
  ProgressionCandidate,
} from "@agent-anything/agent-runtime/controller";
import type { CancellationContext, RunObservation } from "@agent-anything/agent-runtime/run";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import {
  CODE_AGENT_CREATE_FILE_TOOL,
  CODE_AGENT_DELETE_FILE_TOOL,
  CODE_AGENT_UPDATE_FILE_TOOL,
  operationRefForCodeFileTool,
  type CodeFileToolName,
} from "@agent-anything/helarc-code-agent/file-operation";
import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";
import {
  acceptPatch,
  createPatchProposal,
  materializePatchReview,
  rejectPatch,
  requestPatchRevision,
  type MaterializedPatchReview,
  type PatchProposalChange,
} from "./HelarcProposalWorkflow.js";
import type { AcceptedPatchStatus } from "./HelarcProposalReview.js";
import { PatchWorkflowError } from "./HelarcProposalWorkflowError.js";
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
  readonly proposalRevision: number;
  readonly reviewId: string;
  readonly pendingVersion: number;
  readonly decision: "accepted" | "rejected" | "request_revision";
  readonly reason: string | null;
}

export type HelarcPatchReviewResolution =
  | { readonly status: "decided"; readonly submission: HelarcPatchReviewDecision }
  | { readonly status: "interrupted"; readonly cancellationRequestId: string }
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
      readonly proposalRevision: number;
      readonly reviewId: string;
    }
  | {
      readonly kind: "action_submitted";
      readonly runId: string;
      readonly proposalId: string;
      readonly proposalRevision: number;
      readonly reviewId: string;
      readonly pendingVersion: number;
    };

export interface HelarcPatchActionControllerInput {
  readonly controller: Controller<HelarcAgentOutput>;
  readonly codeSource: CodeSourcePort;
  readonly patchReviewPort?: HelarcPatchReviewPort;
  readonly onStateChanged?: (state: HelarcPatchActionState) => void;
  readonly now?: () => string;
}

interface PendingPatchAction {
  readonly operation: OperationRevisionRef;
  readonly actionName: CodeFileToolName;
  readonly summary: string;
  readonly path: string;
  readonly priorObservationIds: readonly string[];
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
    if (this.pending !== null) return this.settlePendingAction(controllerInput);
    const decision = await this.input.controller.next(controllerInput, context);
    if (decision.kind !== "propose_completion" || decision.output.kind !== "propose") {
      return decision;
    }
    return this.reviewProposal(controllerInput, context, decision);
  }

  private async reviewProposal(
    controllerInput: ControllerInput<HelarcAgentOutput>,
    context: ControllerCallContext,
    decision: Extract<ControllerDecision<HelarcAgentOutput>, { readonly kind: "propose_completion" }>,
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
      const modelItem = decision.modelItems.at(-1);
      if (modelItem === undefined) throw new TypeError("Patch proposal has no originating model item.");
      const proposed = await createPatchProposal({
        runId: controllerInput.runId,
        workspace: controllerInput.workspace,
        source: this.input.codeSource,
        change: toPatchProposalChange(output.change),
        producer: Object.freeze({
          kind: "controller" as const,
          owner: "helarc",
          refId: modelItem.id,
        }),
        creationBasis: Object.freeze({
          kind: "controller_output" as const,
          refId: modelItem.id,
        }),
        sensitivity: "private",
        summary: output.summary,
        rationale: output.summary,
        metadata: { product: "helarc" },
      }, { now: this.input.now });
      const review = await materializePatchReview({
        patch: proposed,
        workspace: controllerInput.workspace,
        source: this.input.codeSource,
      });
      this.setState(Object.freeze({
        kind: "reviewing",
        runId: review.runId,
        proposalId: review.proposalId,
        proposalRevision: review.proposalRevision,
        reviewId: review.reviewId,
      }));
      const reviewed = await this.input.patchReviewPort.review(review, context.cancellation);
      if (reviewed.status === "interrupted") {
        this.setState(Object.freeze({ kind: "none" }));
        return Object.freeze({
          kind: "propose_stop" as const,
          reason: "Patch review was interrupted by Run cancellation.",
          modelItems: decision.modelItems,
        });
      }
      if (reviewed.status === "failed") {
        this.setState(Object.freeze({ kind: "none" }));
        this.outcome = patchOutcome("failed", "failed", null, [{
          code: reviewed.code,
          message: reviewed.message,
        }]);
        return completeDecision(output.summary, decision.modelItems);
      }

      const submission = reviewed.submission;
      const decisionInput = {
        runId: submission.runId,
        proposalId: submission.proposalId,
        proposalRevision: submission.proposalRevision,
        reviewId: submission.reviewId,
        pendingVersion: submission.pendingVersion,
        submissionId: submission.submissionId,
        ...(submission.reason === null ? {} : { reason: submission.reason }),
        now: this.input.now,
      };
      if (submission.decision === "request_revision") {
        requestPatchRevision(proposed, {
          ...decisionInput,
          reason: submission.reason ?? "A new proposal revision was requested.",
        });
        this.setState(Object.freeze({ kind: "none" }));
        this.outcome = patchOutcome("blocked", "proposed", null, [{
          code: "patch_revision_requested",
          message: submission.reason ?? "A new proposal revision was requested.",
        }]);
        return completeDecision(output.summary, decision.modelItems);
      }
      if (submission.decision === "rejected") {
        rejectPatch(proposed, {
          ...decisionInput,
          reason: submission.reason ?? "Patch proposal rejected.",
        });
        this.setState(Object.freeze({ kind: "none" }));
        this.outcome = patchOutcome("rejected", "rejected", null, []);
        return completeDecision(output.summary, decision.modelItems);
      }

      const accepted = acceptPatch(proposed, decisionInput);
      const request = acceptedPatchRequest(accepted);
      this.pending = Object.freeze({
        operation: operationRefForCodeFileTool(request.name),
        actionName: request.name,
        summary: output.summary,
        path: accepted.proposal.operation.path,
        priorObservationIds: Object.freeze(controllerInput.context.observations.map(({ id }) => id)),
      });
      this.setState(Object.freeze({
        kind: "action_submitted",
        runId: submission.runId,
        proposalId: submission.proposalId,
        proposalRevision: submission.proposalRevision,
        reviewId: submission.reviewId,
        pendingVersion: submission.pendingVersion,
      }));
      return Object.freeze({
        kind: "advance" as const,
        candidates: oneCandidate(Object.freeze({
          kind: "operation_request" as const,
          origin: "tool_request" as const,
          tool: Object.freeze({
            name: request.name,
            revision: null,
            input: request.input,
            origin: "workflow" as const,
            controllerRequestId: null,
          }),
          modelItemId: modelItem.id,
        })),
        modelItems: decision.modelItems,
      });
    } catch (error) {
      this.setState(Object.freeze({ kind: "none" }));
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
    const prior = new Set(pending.priorObservationIds);
    const observation = [...input.context.observations].reverse().find((candidate) =>
      !prior.has(candidate.id) && observationMatchesOperation(candidate, pending.operation)
    );
    this.pending = null;
    this.setState(Object.freeze({ kind: "none" }));
    if (observation?.payload.kind === "operation" && observation.payload.result.status === "succeeded") {
      this.outcome = patchOutcome("completed", "applied", pending.path, []);
    } else {
      this.outcome = patchOutcome("failed", "failed", null, [{
        code: observationCode(observation),
        message: observationMessage(observation),
      }]);
    }
    return completeDecision(pending.summary, [Object.freeze({
      id: `${input.runId}:patch:settled:${input.iteration}`,
      kind: "assistant_action",
      content: Object.freeze({ action: "complete", summary: pending.summary }),
      metadata: Object.freeze({ source: "helarc.patch-action" }),
    })]);
  }

  private setState(state: HelarcPatchActionState): void {
    this.state = state;
    this.input.onStateChanged?.(state);
  }
}

function acceptedPatchRequest(accepted: AcceptedPatchStatus): {
  readonly name: CodeFileToolName;
  readonly input: Readonly<Record<string, unknown>>;
} {
  const { proposal } = accepted;
  const common = { rootName: proposal.rootName, path: proposal.operation.path };
  if (proposal.operation.kind === "create") {
    return Object.freeze({
      name: CODE_AGENT_CREATE_FILE_TOOL,
      input: Object.freeze({ ...common, content: proposal.operation.proposedContent }),
    });
  }
  if (proposal.operation.kind === "update") {
    return Object.freeze({
      name: CODE_AGENT_UPDATE_FILE_TOOL,
      input: Object.freeze({
        ...common,
        content: proposal.operation.proposedContent,
        expectedContentDigest: proposal.operation.originalContent.digest,
      }),
    });
  }
  return Object.freeze({
    name: CODE_AGENT_DELETE_FILE_TOOL,
    input: Object.freeze({
      ...common,
      expectedContentDigest: proposal.operation.originalContent.digest,
    }),
  });
}

function completeDecision(
  summary: string,
  modelItems: readonly ControllerModelItem[],
): ControllerDecision<HelarcAgentOutput> {
  return Object.freeze({
    kind: "propose_completion" as const,
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
    : { kind: change.operation, path: change.path, proposedContent: change.content ?? "" };
}

function observationMatchesOperation(
  observation: RunObservation,
  operation: OperationRevisionRef,
): boolean {
  if (observation.payload.kind === "operation") {
    return sameOperation(observation.payload.result.ref.invocation.operation, operation);
  }
  return observation.payload.kind === "operation_rejected";
}

function sameOperation(left: OperationRevisionRef, right: OperationRevisionRef): boolean {
  return left.operation.namespace === right.operation.namespace &&
    left.operation.name === right.operation.name &&
    left.revision === right.revision;
}

function observationCode(observation: RunObservation | undefined): string {
  if (observation === undefined) return "patch_action_result_missing";
  if (observation.payload.kind === "operation_rejected") return observation.payload.code;
  if (observation.payload.kind === "operation" && observation.payload.result.failure !== null) {
    return observation.payload.result.failure.code;
  }
  return "patch_action_failed";
}

function observationMessage(observation: RunObservation | undefined): string {
  if (observation === undefined) return "Patch Action produced no settled Operation result.";
  if (observation.payload.kind === "operation_rejected") return observation.payload.message;
  if (observation.payload.kind === "operation" && observation.payload.result.failure !== null) {
    return observation.payload.result.failure.message;
  }
  return "Patch Action did not settle successfully.";
}

function oneCandidate<T extends ProgressionCandidate>(candidate: T): readonly [T] {
  return Object.freeze([candidate]) as readonly [T];
}
