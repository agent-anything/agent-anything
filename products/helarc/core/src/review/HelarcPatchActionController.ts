import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
  ProgressionCandidate,
} from "@agent-anything/agent-runtime/controller";
import type { RunObservation } from "@agent-anything/agent-runtime/run";
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
import type { AcceptedPatchStatus, ProposedPatchStatus } from "./HelarcProposalReview.js";
import { PatchWorkflowError } from "./HelarcProposalWorkflowError.js";
import {
  createHelarcPatchReviewPresentation,
  createHelarcPatchReviewSubjectRef,
  HELARC_PATCH_REVIEW_PROTOCOL,
  type HelarcPatchReviewApplication,
} from "../composition/HelarcPatchReview.js";
import { readHelarcRunObservations } from "../controller/HelarcContextProjection.js";
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

export type HelarcPatchActionState =
  | { readonly kind: "none" }
  | {
      readonly kind: "review_requested";
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
      readonly requestVersion: number;
    };

export interface HelarcPatchActionControllerInput {
  readonly controller: Controller<HelarcAgentOutput>;
  readonly codeSource: CodeSourcePort;
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

interface PendingPatchReview {
  readonly patch: ProposedPatchStatus;
  readonly review: MaterializedPatchReview;
  readonly summary: string;
  readonly priorObservationIds: readonly string[];
}

export class HelarcPatchActionController implements Controller<HelarcAgentOutput> {
  private pending: PendingPatchAction | null = null;
  private pendingReview: PendingPatchReview | null = null;
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
    if (this.pendingReview !== null) return this.settlePendingReview(controllerInput, context);
    const decision = await this.input.controller.next(controllerInput, context);
    if (decision.kind !== "propose_completion" || decision.output.kind !== "propose") {
      return decision;
    }
    return this.reviewProposal(controllerInput, decision);
  }

  private async reviewProposal(
    controllerInput: ControllerInput<HelarcAgentOutput>,
    decision: Extract<ControllerDecision<HelarcAgentOutput>, { readonly kind: "propose_completion" }>,
  ): Promise<ControllerDecision<HelarcAgentOutput>> {
    const output = decision.output;
    if (output.kind !== "propose") return decision;

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
      const presentation = createHelarcPatchReviewPresentation(review);
      this.pendingReview = Object.freeze({
        patch: proposed,
        review,
        summary: output.summary,
        priorObservationIds: Object.freeze(
          readHelarcRunObservations(controllerInput.context).map(({ id }) => id),
        ),
      });
      this.setState(Object.freeze({
        kind: "review_requested",
        runId: review.runId,
        proposalId: review.proposalId,
        proposalRevision: review.proposalRevision,
        reviewId: review.reviewId,
      }));
      return Object.freeze({
        kind: "advance" as const,
        candidates: oneCandidate(Object.freeze({
          kind: "interaction_request" as const,
          protocol: HELARC_PATCH_REVIEW_PROTOCOL,
          subject: presentation,
          subjectRef: createHelarcPatchReviewSubjectRef(review),
          presentation,
          requestVersion: review.proposalRevision,
          expiresAt: null,
          blockingScope: "run" as const,
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

  private async settlePendingReview(
    input: ControllerInput<HelarcAgentOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<HelarcAgentOutput>> {
    const pending = this.pendingReview!;
    const prior = new Set(pending.priorObservationIds);
    const observations = readHelarcRunObservations(input.context);
    const observation = [...observations].reverse().find((candidate) =>
      !prior.has(candidate.id) &&
      candidate.payload.kind === "interaction" &&
      candidate.payload.owner === HELARC_PATCH_REVIEW_PROTOCOL.owner
    );
    this.pendingReview = null;

    if (
      observation?.payload.kind === "interaction" &&
      observation.payload.status === "invalidated" &&
      isCode(observation.payload.value, "run_steering_pending")
    ) {
      this.setState(Object.freeze({ kind: "none" }));
      return this.input.controller.next(input, context);
    }

    if (
      observation?.payload.kind !== "interaction" ||
      observation.payload.status !== "resolved" ||
      !isPatchReviewApplication(observation.payload.value, pending.review)
    ) {
      this.setState(Object.freeze({ kind: "none" }));
      const code = interactionObservationCode(observation);
      this.outcome = patchOutcome("blocked", "proposed", null, [{
        code,
        message: "Patch review did not resolve to a valid Product decision.",
      }]);
      return completeDecision(pending.summary, [reviewDecisionModelItem(
        input,
        pending.review,
        "unavailable",
      )]);
    }

    const application = observation.payload.value;
    const decisionItem = reviewDecisionModelItem(
      input,
      pending.review,
      application.decision,
    );
    const decisionInput = {
      runId: pending.review.runId,
      proposalId: pending.review.proposalId,
      proposalRevision: pending.review.proposalRevision,
      reviewId: pending.review.reviewId,
      requestVersion: application.request.requestVersion,
      submissionId: application.submissionId,
      ...(application.reason === null ? {} : { reason: application.reason }),
      now: this.input.now,
    };
    if (application.decision === "request_revision") {
      requestPatchRevision(pending.patch, {
        ...decisionInput,
        reason: application.reason ?? "A new proposal revision was requested.",
      });
      this.setState(Object.freeze({ kind: "none" }));
      this.outcome = patchOutcome("blocked", "proposed", null, [{
        code: "patch_revision_requested",
        message: application.reason ?? "A new proposal revision was requested.",
      }]);
      return completeDecision(pending.summary, [decisionItem]);
    }
    if (application.decision === "rejected") {
      rejectPatch(pending.patch, {
        ...decisionInput,
        reason: application.reason ?? "Patch proposal rejected.",
      });
      this.setState(Object.freeze({ kind: "none" }));
      this.outcome = patchOutcome("rejected", "rejected", null, []);
      return completeDecision(pending.summary, [decisionItem]);
    }

    const accepted = acceptPatch(pending.patch, decisionInput);
    const request = acceptedPatchRequest(accepted);
    this.pending = Object.freeze({
      operation: operationRefForCodeFileTool(request.name),
      actionName: request.name,
      summary: pending.summary,
      path: accepted.proposal.operation.path,
      priorObservationIds: Object.freeze(observations.map(({ id }) => id)),
    });
    this.setState(Object.freeze({
      kind: "action_submitted",
      runId: pending.review.runId,
      proposalId: pending.review.proposalId,
      proposalRevision: pending.review.proposalRevision,
      reviewId: pending.review.reviewId,
      requestVersion: application.request.requestVersion,
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
        modelItemId: decisionItem.id,
      })),
      modelItems: Object.freeze([decisionItem]),
    });
  }

  private settlePendingAction(
    input: ControllerInput<HelarcAgentOutput>,
  ): ControllerDecision<HelarcAgentOutput> {
    const pending = this.pending!;
    const prior = new Set(pending.priorObservationIds);
    const observation = [...readHelarcRunObservations(input.context)].reverse().find((candidate) =>
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

function reviewDecisionModelItem(
  input: ControllerInput<HelarcAgentOutput>,
  review: MaterializedPatchReview,
  decision: HelarcPatchReviewApplication["decision"] | "unavailable",
): ControllerModelItem {
  return Object.freeze({
    id: `${input.runId}:patch-review:${review.reviewId}:${input.iteration}`,
    kind: "assistant_action" as const,
    content: Object.freeze({ action: "patch_review_decision", decision }),
    metadata: Object.freeze({ source: "helarc.patch-review" }),
  });
}

function isPatchReviewApplication(
  value: unknown,
  review: MaterializedPatchReview,
): value is HelarcPatchReviewApplication {
  if (!isRecord(value) || value.kind !== "helarc_patch_review_decision") return false;
  if (
    typeof value.submissionId !== "string" ||
    value.submissionId.length === 0 ||
    /\s/.test(value.submissionId) ||
    (value.decision !== "accepted" &&
      value.decision !== "rejected" &&
      value.decision !== "request_revision") ||
    (value.reason !== null && typeof value.reason !== "string")
  ) return false;
  const request = value.request;
  return isRecord(request) &&
    request.requestVersion === review.proposalRevision &&
    isRecord(request.protocol) &&
    request.protocol.owner === HELARC_PATCH_REVIEW_PROTOCOL.owner &&
    request.protocol.kind === HELARC_PATCH_REVIEW_PROTOCOL.kind &&
    request.protocol.revision === HELARC_PATCH_REVIEW_PROTOCOL.revision &&
    isRecord(request.subject) &&
    request.subject.owner === "helarc" &&
    request.subject.kind === "patch_proposal" &&
    request.subject.id === review.reviewId &&
    request.subject.revision === String(review.proposalRevision);
}

function interactionObservationCode(observation: RunObservation | undefined): string {
  if (observation?.payload.kind !== "interaction") return "patch_review_result_missing";
  return isRecord(observation.payload.value) && typeof observation.payload.value.code === "string"
    ? observation.payload.value.code
    : `patch_review_${observation.payload.status}`;
}

function isCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
