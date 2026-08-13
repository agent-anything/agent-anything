import type { ApprovalCategory } from "./ApprovalCategory.js";
import type {
  ApprovalRequirement,
  ApprovalRequirementDraft,
} from "./ApprovalContracts.js";
import { createApprovalRequest } from "./createApprovalRequest.js";

export interface SealApprovalRequirementInput<
  TCategory extends ApprovalCategory = ApprovalCategory,
> {
  readonly draft: ApprovalRequirementDraft<TCategory>;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly sealedAt: string;
}

/** Validates, snapshots, and binds owner review meaning to one canonical Action. */
export function sealApprovalRequirement<TCategory extends ApprovalCategory>(
  input: SealApprovalRequirementInput<TCategory>,
): ApprovalRequirement<TCategory> {
  const request = createApprovalRequest({
    id: `seal:${input.actionId}`,
    createdAt: input.sealedAt,
    requirement: {
      category: input.draft.category,
      subject: {
        runId: input.runId,
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        environmentId: input.draft.environmentId,
        applicabilityKeys: input.draft.applicabilityKeys,
      },
      reason: input.draft.reason,
      payload: input.draft.payload,
      decisionOptions: input.draft.decisionOptions,
      trustedProposals: input.draft.trustedProposals,
      deadlineAt: input.draft.deadlineAt,
      metadata: input.draft.metadata,
    },
  });
  return Object.freeze({
    category: request.category,
    subject: request.subject,
    reason: request.reason,
    payload: request.payload,
    decisionOptions: request.decisionOptions,
    trustedProposals: request.trustedProposals,
    deadlineAt: request.deadlineAt,
    metadata: request.metadata,
  });
}
