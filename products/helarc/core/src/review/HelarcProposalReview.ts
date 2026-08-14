import type {
  CodeSourceContentRef,
  CodeSourceSnapshot,
} from "@agent-anything/helarc-code-agent/source";

export type PatchProposalId = string;
export type PatchProposalRevision = number;
export type PatchReviewId = string;
export type PatchDecisionSubmissionId = string;
export type PatchContentReference = CodeSourceContentRef;

export interface HelarcProposalRevisionRef {
  readonly proposalId: PatchProposalId;
  readonly revision: PatchProposalRevision;
}

export interface HelarcProposalProducer {
  readonly kind: "controller" | "user" | "product";
  readonly owner: string;
  readonly refId: string;
}

export interface HelarcProposalCreationBasis {
  readonly kind: "controller_output" | "user_input" | "product_workflow";
  readonly refId: string;
}

export type HelarcProposalSensitivity = "public" | "private" | "secret" | "restricted";

export interface CreatePatchOperation {
  readonly kind: "create";
  readonly path: string;
  readonly proposedContent: string;
}

export interface UpdatePatchOperation {
  readonly kind: "update";
  readonly path: string;
  readonly originalContent: PatchContentReference;
  readonly proposedContent: string;
}

export interface DeletePatchOperation {
  readonly kind: "delete";
  readonly path: string;
  readonly originalContent: PatchContentReference;
}

export type PatchOperation =
  | CreatePatchOperation
  | UpdatePatchOperation
  | DeletePatchOperation;

export interface PatchProposal {
  readonly id: PatchProposalId;
  readonly revision: PatchProposalRevision;
  readonly previousRevision: HelarcProposalRevisionRef | null;
  readonly runId: string;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly operation: PatchOperation;
  readonly sourceSnapshot: CodeSourceSnapshot;
  readonly producer: HelarcProposalProducer;
  readonly creationBasis: HelarcProposalCreationBasis;
  readonly sensitivity: HelarcProposalSensitivity;
  readonly summary: string;
  readonly rationale: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AcceptedPatchDecision {
  readonly status: "accepted";
  readonly runId: string;
  readonly proposalId: PatchProposalId;
  readonly proposalRevision: PatchProposalRevision;
  readonly reviewId: PatchReviewId;
  readonly pendingVersion: number;
  readonly submissionId: PatchDecisionSubmissionId;
  readonly decidedAt: string;
  readonly reason?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RejectedPatchDecision {
  readonly status: "rejected";
  readonly runId: string;
  readonly proposalId: PatchProposalId;
  readonly proposalRevision: PatchProposalRevision;
  readonly reviewId: PatchReviewId;
  readonly pendingVersion: number;
  readonly submissionId: PatchDecisionSubmissionId;
  readonly decidedAt: string;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RevisionRequestedPatchDecision {
  readonly status: "revision_requested";
  readonly runId: string;
  readonly proposalId: PatchProposalId;
  readonly proposalRevision: PatchProposalRevision;
  readonly reviewId: PatchReviewId;
  readonly pendingVersion: number;
  readonly submissionId: PatchDecisionSubmissionId;
  readonly decidedAt: string;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type PatchDecision =
  | AcceptedPatchDecision
  | RejectedPatchDecision
  | RevisionRequestedPatchDecision;
export type PatchFailureCode =
  | "patch_stale"
  | "patch_path_unsafe"
  | "patch_state_invalid"
  | "patch_source_unavailable";

export interface ProposedPatchStatus {
  readonly status: "proposed";
  readonly proposal: PatchProposal;
}

export interface AcceptedPatchStatus {
  readonly status: "accepted";
  readonly proposal: PatchProposal;
  readonly decision: AcceptedPatchDecision;
}

export interface RejectedPatchStatus {
  readonly status: "rejected";
  readonly proposal: PatchProposal;
  readonly decision: RejectedPatchDecision;
}

export interface RevisionRequestedPatchStatus {
  readonly status: "revision_requested";
  readonly proposal: PatchProposal;
  readonly decision: RevisionRequestedPatchDecision;
}

export type PatchStatus =
  | ProposedPatchStatus
  | AcceptedPatchStatus
  | RejectedPatchStatus
  | RevisionRequestedPatchStatus;
