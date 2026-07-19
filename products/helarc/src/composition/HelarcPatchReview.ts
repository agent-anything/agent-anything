import type { CancellationContext } from "@agent-anything/agent-core/run";
import type { MaterializedPatchReview } from "@agent-anything/code-agent/patch";

export interface HelarcPatchReviewRequest {
  readonly runId: string;
  readonly proposalId: string;
  readonly reviewId: string;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly operation: MaterializedPatchReview["operation"];
  readonly summary: string;
  readonly rationale: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
  readonly originalContentBytes: number | null;
  readonly proposedContentBytes: number | null;
}

export interface HelarcPendingPatchReviewProjection extends HelarcPatchReviewRequest {
  readonly pendingVersion: number;
  readonly phase: "reviewing" | "submitted_for_resolution";
}

export interface HelarcPatchReviewDecisionSubmission {
  readonly submissionId: string;
  readonly runId: string;
  readonly proposalId: string;
  readonly reviewId: string;
  readonly pendingVersion: number;
  readonly decision: "accepted" | "rejected";
  readonly reason: string | null;
}

export type HelarcPatchReviewSubmissionReceipt =
  | {
      readonly status: "accepted_for_resolution";
      readonly submissionId: string;
      readonly runId: string;
      readonly proposalId: string;
      readonly reviewId: string;
      readonly pendingVersion: number;
    }
  | {
      readonly status: "rejected";
      readonly submissionId: string;
      readonly code:
        | "patch_review_submission_invalid"
        | "patch_review_not_pending"
        | "patch_review_version_mismatch"
        | "patch_review_already_resolved";
    };

export type HelarcPatchReviewOutcome =
  | {
      readonly status: "decided";
      readonly submission: HelarcPatchReviewDecisionSubmission;
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

export type HelarcPatchReviewProjectionListener = (
  projection: HelarcPendingPatchReviewProjection | null,
) => void | Promise<void>;

export interface HelarcPatchReviewBridge {
  readonly runId: string;
  getPendingProjection(): HelarcPendingPatchReviewProjection | null;
  subscribe(listener: HelarcPatchReviewProjectionListener): () => void;
  review(
    request: HelarcPatchReviewRequest,
    cancellation: CancellationContext,
  ): Promise<HelarcPatchReviewOutcome>;
  submitDecision(
    input: HelarcPatchReviewDecisionSubmission,
  ): HelarcPatchReviewSubmissionReceipt;
}

export type HelarcProductPhase =
  | { readonly kind: "none" }
  | {
      readonly kind: "waiting_for_patch_review";
      readonly review: HelarcPendingPatchReviewProjection;
    }
  | {
      readonly kind: "patch_action_submitted";
      readonly runId: string;
      readonly proposalId: string;
      readonly reviewId: string;
      readonly pendingVersion: number;
    };
