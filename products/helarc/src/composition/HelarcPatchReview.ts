import type { MaterializedPatchReview } from "@agent-anything/code-agent";

export interface HelarcPatchReviewViewModel {
  readonly patchId: string;
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
  readonly decisionState: "pending";
}

export type HelarcPatchReviewDecision =
  | { readonly decision: "accepted"; readonly reason?: string }
  | { readonly decision: "rejected"; readonly reason: string };

export type HelarcPatchReviewBridge = (
  review: HelarcPatchReviewViewModel,
) => Promise<HelarcPatchReviewDecision>;
