import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type PatchProposalId = string;
export type PatchReviewId = string;
export type PatchDecisionSubmissionId = string;

export interface PatchContentReference {
  algorithm: "sha256";
  digest: string;
  byteLength: number;
}

export interface CreatePatchOperation {
  kind: "create";
  path: string;
  proposedContent: string;
}

export interface UpdatePatchOperation {
  kind: "update";
  path: string;
  originalContent: PatchContentReference;
  proposedContent: string;
}

export interface DeletePatchOperation {
  kind: "delete";
  path: string;
  originalContent: PatchContentReference;
}

export type PatchOperation =
  | CreatePatchOperation
  | UpdatePatchOperation
  | DeletePatchOperation;

export interface PatchProposal {
  id: PatchProposalId;
  runId: string;
  rootName: string;
  workspaceId: string;
  operation: PatchOperation;
  summary: string;
  rationale: string;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}

export interface AcceptedPatchDecision {
  status: "accepted";
  runId: string;
  proposalId: PatchProposalId;
  reviewId: PatchReviewId;
  pendingVersion: number;
  submissionId: PatchDecisionSubmissionId;
  decidedAt: ISODateTimeString;
  reason?: string;
  metadata: Metadata;
}

export interface RejectedPatchDecision {
  status: "rejected";
  runId: string;
  proposalId: PatchProposalId;
  reviewId: PatchReviewId;
  pendingVersion: number;
  submissionId: PatchDecisionSubmissionId;
  decidedAt: ISODateTimeString;
  reason: string;
  metadata: Metadata;
}

export type PatchDecision = AcceptedPatchDecision | RejectedPatchDecision;

export type PatchFailureCode =
  | "patch_stale"
  | "patch_path_unsafe"
  | "patch_state_invalid";

export interface ProposedPatchStatus {
  status: "proposed";
  proposal: PatchProposal;
}

export interface AcceptedPatchStatus {
  status: "accepted";
  proposal: PatchProposal;
  decision: AcceptedPatchDecision;
}

export interface RejectedPatchStatus {
  status: "rejected";
  proposal: PatchProposal;
  decision: RejectedPatchDecision;
}

export type PatchStatus =
  | ProposedPatchStatus
  | AcceptedPatchStatus
  | RejectedPatchStatus;
