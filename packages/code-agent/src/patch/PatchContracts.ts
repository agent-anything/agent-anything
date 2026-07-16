import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export type PatchId = string;

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
  id: PatchId;
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
  patchId: PatchId;
  decidedAt: ISODateTimeString;
  reason?: string;
  metadata: Metadata;
}

export interface RejectedPatchDecision {
  status: "rejected";
  patchId: PatchId;
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
